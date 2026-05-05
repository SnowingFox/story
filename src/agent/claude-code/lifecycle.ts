/**
 * Hook event parsing + transcript flush wait + hook response writing for
 * the Claude Code agent.
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/agent/claudecode/lifecycle.go`.
 *
 * Implements:
 * - {@link import('@/agent/interfaces').HookSupport.hookNames} +
 *   {@link import('@/agent/interfaces').HookSupport.parseHookEvent}
 *   (event routing) — methods are mixed into `ClaudeCodeAgent.prototype`
 *   in `index.ts`
 * - {@link import('@/agent/interfaces').HookResponseWriter.writeHookResponse}
 *   (`{"systemMessage":...}` JSON to stdout)
 * - {@link import('@/agent/interfaces').TranscriptPreparer.prepareTranscript}
 *   ({@link waitForTranscriptFlush})
 * - {@link import('@/agent/interfaces').TokenCalculator.calculateTokenUsage}
 *   (delegates to `transcript.calculateTotalTokenUsage(data, fromOffset, '')`)
 *
 * @packageDocumentation
 */

import fs from 'node:fs/promises';
import { match } from 'ts-pattern';
import {
	EVENT_TYPE_SESSION_END,
	EVENT_TYPE_SESSION_START,
	EVENT_TYPE_SUBAGENT_END,
	EVENT_TYPE_SUBAGENT_START,
	EVENT_TYPE_TURN_END,
	EVENT_TYPE_TURN_START,
	type Event,
	type EventType,
	readAndParseHookInput,
} from '@/agent/event';
import type { TokenUsage } from '@/agent/session';
import * as log from '@/log';
import { calculateTotalTokenUsage } from './transcript';
import {
	HOOK_NAME_POST_TASK,
	HOOK_NAME_POST_TODO,
	HOOK_NAME_PRE_TASK,
	HOOK_NAME_SESSION_END,
	HOOK_NAME_SESSION_START,
	HOOK_NAME_STOP,
	HOOK_NAME_USER_PROMPT_SUBMIT,
	type PostToolHookInputRaw,
	type SessionInfoRaw,
	type TaskHookInputRaw,
	type UserPromptSubmitRaw,
} from './types';

/**
 * The 7 hook verbs Claude Code supports. These become subcommands under
 * `story hooks claude-code <verb>`. Order matches Go `hookNames` exactly.
 */
export function hookNames(): string[] {
	return [
		HOOK_NAME_SESSION_START,
		HOOK_NAME_SESSION_END,
		HOOK_NAME_STOP,
		HOOK_NAME_USER_PROMPT_SUBMIT,
		HOOK_NAME_PRE_TASK,
		HOOK_NAME_POST_TASK,
		HOOK_NAME_POST_TODO,
	];
}

/**
 * Translate a Claude Code hook into a normalized lifecycle {@link Event}.
 *
 * Returns `null` for `post-todo` (Claude-specific; handled by
 * `src/commands/hooks/claude-code/post-todo.ts` directly, not by the
 * generic dispatcher) and any unknown verb.
 *
 * Throws on empty stdin or unparseable JSON (delegates to
 * {@link readAndParseHookInput}).
 *
 * @example
 * await parseHookEvent('stop', stdin);
 * // returns: { type: 'TurnEnd', sessionId, sessionRef, model, timestamp: now, ... }
 *
 * await parseHookEvent('post-todo', stdin);
 * // returns: null   (no lifecycle action; handled out-of-band)
 *
 * await parseHookEvent('unknown', stdin);
 * // returns: null
 */
export async function parseHookEvent(
	verb: string,
	stdin: NodeJS.ReadableStream,
): Promise<Event | null> {
	return match(verb)
		.with(HOOK_NAME_SESSION_START, () => parseSessionStart(stdin))
		.with(HOOK_NAME_USER_PROMPT_SUBMIT, () => parseTurnStart(stdin))
		.with(HOOK_NAME_STOP, () => parseTurnEnd(stdin))
		.with(HOOK_NAME_SESSION_END, () => parseSessionEnd(stdin))
		.with(HOOK_NAME_PRE_TASK, () => parseSubagentStart(stdin))
		.with(HOOK_NAME_POST_TASK, () => parseSubagentEnd(stdin))
		.with(HOOK_NAME_POST_TODO, async () => null)
		.otherwise(async () => null);
}

/**
 * Write a structured hook response (`{"systemMessage": "<message>"}`) to
 * stdout with a trailing newline. Claude Code reads this JSON and renders
 * the systemMessage in the chat UI.
 *
 * **Empty-message parity** (Go: `lifecycle.go:30` uses
 * `json:"systemMessage,omitempty"` tag): empty string `''` produces `'{}\n'`
 * (NOT `'{"systemMessage":""}\n'`). Without the explicit guard, JS
 * `JSON.stringify` emits the field unconditionally; Claude Code likely
 * tolerates either form, but strict spec parity matters for cross-CLI
 * fixture comparisons.
 */
export async function writeHookResponse(message: string): Promise<void> {
	// Mirror Go `omitempty`: empty message → `{}` (no field at all).
	const json = message === '' ? '{}' : JSON.stringify({ systemMessage: message });
	await new Promise<void>((resolve, reject) => {
		process.stdout.write(`${json}\n`, (err) => {
			if (err) {
				reject(new Error(`failed to encode hook response: ${err.message}`, { cause: err }));
			} else {
				resolve();
			}
		});
	});
}

/**
 * Prepare transcript for reading by waiting for Claude's async flush sentinel.
 * Always returns; never throws (errors are logged at debug/warn).
 *
 * @example
 * await prepareTranscript('/Users/me/.claude/projects/foo/abc.jsonl');
 *
 * // Side effects: read-only fs.stat + repeated fs.open/read on the transcript file
 * //               (max 3 seconds of polling at 50ms intervals).
 */
export async function prepareTranscript(sessionRef: string): Promise<void> {
	await waitForTranscriptFlush(sessionRef, new Date());
}

/**
 * Compute token usage for a turn (no subagent dir; subagent stats omitted).
 *
 * Delegates to {@link calculateTotalTokenUsage}` (data, fromOffset, '')`.
 * Callers needing subagent merge should call `calculateTotalTokenUsage`
 * directly with non-empty `subagentsDir`.
 */
export async function calculateTokenUsage(
	data: Uint8Array,
	fromOffset: number,
): Promise<TokenUsage | null> {
	return calculateTotalTokenUsage(data, fromOffset, '');
}

/** Build a base Event with all required fields zero-initialized. */
function baseEvent(type: EventType): Event {
	return {
		type,
		sessionId: '',
		previousSessionId: '',
		sessionRef: '',
		prompt: '',
		model: '',
		timestamp: new Date(),
		toolUseId: '',
		subagentId: '',
		toolInput: null,
		subagentType: '',
		taskDescription: '',
		modifiedFiles: [],
		responseMessage: '',
		durationMs: 0,
		turnCount: 0,
		contextTokens: 0,
		contextWindowSize: 0,
		metadata: {},
	};
}

/**
 * Re-serialize a parsed `tool_input` JSON value to bytes for storage in
 * `Event.toolInput`. The JSON **value** is preserved 1:1; **byte-level
 * formatting may differ** from Go's `json.RawMessage` carry-through
 * (Go preserves the original input bytes verbatim — incl. whitespace and
 * escape choices — while TS re-encodes via `JSON.stringify`).
 *
 * For canonical Claude transcripts (compact JSON) the two are byte-identical;
 * downstream consumers parse `toolInput` by JSON.parse and only see the
 * value, so this divergence is invisible at the application layer.
 */
function serializeToolInput(value: unknown): Uint8Array | null {
	if (value === undefined || value === null) {
		return null;
	}
	try {
		return new TextEncoder().encode(JSON.stringify(value));
	} catch {
		return null;
	}
}

/** Coerce a possibly-missing JSON string field to '' (matches Go zero value). */
function asString(v: unknown): string {
	return typeof v === 'string' ? v : '';
}

async function parseSessionStart(stdin: NodeJS.ReadableStream): Promise<Event> {
	const raw = await readAndParseHookInput<SessionInfoRaw>(stdin);
	const ev = baseEvent(EVENT_TYPE_SESSION_START);
	ev.sessionId = asString(raw.session_id);
	ev.sessionRef = asString(raw.transcript_path);
	ev.model = asString(raw.model);
	return ev;
}

async function parseTurnStart(stdin: NodeJS.ReadableStream): Promise<Event> {
	const raw = await readAndParseHookInput<UserPromptSubmitRaw>(stdin);
	const ev = baseEvent(EVENT_TYPE_TURN_START);
	ev.sessionId = asString(raw.session_id);
	ev.sessionRef = asString(raw.transcript_path);
	ev.prompt = asString(raw.prompt);
	return ev;
}

async function parseTurnEnd(stdin: NodeJS.ReadableStream): Promise<Event> {
	const raw = await readAndParseHookInput<SessionInfoRaw>(stdin);
	const ev = baseEvent(EVENT_TYPE_TURN_END);
	ev.sessionId = asString(raw.session_id);
	ev.sessionRef = asString(raw.transcript_path);
	ev.model = asString(raw.model);
	return ev;
}

async function parseSessionEnd(stdin: NodeJS.ReadableStream): Promise<Event> {
	const raw = await readAndParseHookInput<SessionInfoRaw>(stdin);
	const ev = baseEvent(EVENT_TYPE_SESSION_END);
	ev.sessionId = asString(raw.session_id);
	ev.sessionRef = asString(raw.transcript_path);
	ev.model = asString(raw.model);
	return ev;
}

async function parseSubagentStart(stdin: NodeJS.ReadableStream): Promise<Event> {
	const raw = await readAndParseHookInput<TaskHookInputRaw>(stdin);
	const ev = baseEvent(EVENT_TYPE_SUBAGENT_START);
	ev.sessionId = asString(raw.session_id);
	ev.sessionRef = asString(raw.transcript_path);
	ev.toolUseId = asString(raw.tool_use_id);
	ev.toolInput = serializeToolInput(raw.tool_input);
	return ev;
}

async function parseSubagentEnd(stdin: NodeJS.ReadableStream): Promise<Event> {
	const raw = await readAndParseHookInput<PostToolHookInputRaw>(stdin);
	const ev = baseEvent(EVENT_TYPE_SUBAGENT_END);
	ev.sessionId = asString(raw.session_id);
	ev.sessionRef = asString(raw.transcript_path);
	ev.toolUseId = asString(raw.tool_use_id);
	ev.toolInput = serializeToolInput(raw.tool_input);
	const agentId = raw.tool_response?.agentId;
	if (typeof agentId === 'string' && agentId !== '') {
		ev.subagentId = agentId;
	}
	return ev;
}

/** Substring searched in transcript JSONL lines to detect flush completion. */
const STOP_HOOK_SENTINEL = 'hooks claude-code stop';
/** Maximum total wait for the sentinel. */
const MAX_WAIT_MS = 3000;
/** Polling interval. */
const POLL_INTERVAL_MS = 50;
/** Bytes to read from the tail of the transcript per poll. */
const TAIL_BYTES = 4096;
/** Acceptable timestamp skew (±) when validating the sentinel timestamp. */
const MAX_SKEW_MS = 2000;
/** mtime-age threshold above which we skip polling entirely. */
const STALE_THRESHOLD_MS = 2 * 60 * 1000;

/** Log context tag (matches Go `logging.WithComponent(ctx, "agent.claudecode")`). */
const LOG_CTX = { component: 'agent.claudecode' } as const;

/**
 * Poll the transcript file for the stop-hook sentinel.
 *
 * Fast paths:
 * - missing file → return immediately
 * - mtime older than 2 min → return immediately (agent isn't running)
 *
 * Otherwise polls every {@link POLL_INTERVAL_MS} for up to {@link MAX_WAIT_MS}.
 * On timeout: warn-log and return. Never throws.
 *
 * **TS-specific contract (matches Go)**: there is **no** AbortSignal /
 * cancellation hookup — the poll loop runs to completion or timeout. Callers
 * cannot abort. This 1:1 mirrors Go `lifecycle.go: waitForTranscriptFlush`
 * which ignores `ctx` cancellation in the loop body.
 */
export async function waitForTranscriptFlush(
	transcriptPath: string,
	hookStartTime: Date,
): Promise<void> {
	let stat: { mtime: Date };
	try {
		stat = await fs.stat(transcriptPath);
	} catch {
		return;
	}
	const fileAge = Date.now() - stat.mtime.getTime();
	if (fileAge > STALE_THRESHOLD_MS) {
		log.debug(LOG_CTX, 'transcript file is stale, skipping sentinel wait', { fileAge });
		return;
	}

	const deadline = Date.now() + MAX_WAIT_MS;
	while (Date.now() < deadline) {
		if (await checkStopSentinel(transcriptPath, TAIL_BYTES, hookStartTime, MAX_SKEW_MS)) {
			log.debug(LOG_CTX, 'transcript flush sentinel found', {
				wait: Date.now() - hookStartTime.getTime(),
			});
			return;
		}
		await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
	}
	log.warn(LOG_CTX, 'transcript flush sentinel not found within timeout, proceeding', {
		timeoutMs: MAX_WAIT_MS,
	});
}

/**
 * Read the tail of `path` and look for {@link STOP_HOOK_SENTINEL} with a
 * timestamp inside `(hookStartTime - maxSkewMs, hookStartTime + maxSkewMs)`
 * (strict inequalities, matching Go `ts.After(lower) && ts.Before(upper)`).
 *
 * Returns `false` on any open / read / parse failure.
 */
export async function checkStopSentinel(
	p: string,
	tailBytes: number,
	hookStartTime: Date,
	maxSkewMs: number,
): Promise<boolean> {
	let fh: fs.FileHandle | undefined;
	try {
		fh = await fs.open(p, 'r');
	} catch {
		return false;
	}
	try {
		const stat = await fh.stat();
		const offset = Math.max(0, stat.size - tailBytes);
		const buf = Buffer.alloc(stat.size - offset);
		if (buf.length === 0) {
			return false;
		}
		await fh.read(buf, 0, buf.length, offset);
		const text = buf.toString('utf-8');
		for (const line of text.split('\n')) {
			const trimmed = line.trim();
			if (trimmed === '' || !trimmed.includes(STOP_HOOK_SENTINEL)) {
				continue;
			}
			let entry: { timestamp?: unknown };
			try {
				entry = JSON.parse(trimmed) as { timestamp?: unknown };
			} catch {
				continue;
			}
			if (typeof entry.timestamp !== 'string') {
				continue;
			}
			const ts = new Date(entry.timestamp);
			if (Number.isNaN(ts.getTime())) {
				continue;
			}
			const lower = hookStartTime.getTime() - maxSkewMs;
			const upper = hookStartTime.getTime() + maxSkewMs;
			const t = ts.getTime();
			if (t > lower && t < upper) {
				return true;
			}
		}
		return false;
	} finally {
		await fh.close();
	}
}
