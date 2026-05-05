/**
 * Cursor agent — `parseHookEvent` 7-verb dispatch + 7 internal parsers +
 * `intFromJSON` + `resolveTranscriptRef` (CLI-no-transcript-path fallback).
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/agent/cursor/lifecycle.go`.
 *
 * Translates 7 Cursor hook verbs into framework {@link Event} objects.
 * Empty stdin / malformed JSON throw via {@link readAndParseHookInput}
 * (Phase 6.1 ship); unknown verbs return `null` (no lifecycle action);
 * `subagent-start/stop` with empty `task` field fast-skip to `null`
 * (spurious IDE event).
 *
 * @packageDocumentation
 */

import { match } from 'ts-pattern';
import {
	EVENT_TYPE_COMPACTION,
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
import * as log from '@/log';
import { worktreeRoot } from '@/paths';
import type { CursorAgent } from './index';
import {
	type BeforeSubmitPromptInputRaw,
	HOOK_NAME_BEFORE_SUBMIT_PROMPT,
	HOOK_NAME_PRE_COMPACT,
	HOOK_NAME_SESSION_END,
	HOOK_NAME_SESSION_START,
	HOOK_NAME_STOP,
	HOOK_NAME_SUBAGENT_START,
	HOOK_NAME_SUBAGENT_STOP,
	type PreCompactHookInputRaw,
	type SessionEndRaw,
	type SessionStartRaw,
	type StopHookInputRaw,
	type SubagentStartHookInputRaw,
	type SubagentStopHookInputRaw,
} from './types';

const LOG_CTX = { component: 'agent.cursor' } as const;

/**
 * Safely convert an unknown JSON value (`json.Number` from Go, decoded as
 * `string | number` in TS) to a number. Returns `0` for `null` / `undefined` /
 * empty string / non-numeric / non-finite values.
 *
 * Mirrors Go `lifecycle.go: intFromJSON` (which returns `0` on
 * `json.Number.Int64()` failure).
 *
 * @example
 * intFromJSON(null);     // 0
 * intFromJSON('');       // 0
 * intFromJSON('123');    // 123
 * intFromJSON('abc');    // 0    (parseInt fail)
 * intFromJSON(123);      // 123
 * intFromJSON(123.7);    // 123  (truncated)
 */
export function intFromJSON(n: unknown): number {
	if (n === null || n === undefined) {
		return 0;
	}
	if (typeof n === 'number') {
		return Number.isFinite(n) ? Math.trunc(n) : 0;
	}
	if (typeof n === 'string') {
		if (n === '') {
			return 0;
		}
		const v = Number.parseInt(n, 10);
		return Number.isNaN(v) ? 0 : v;
	}
	return 0;
}

/**
 * Translate a Cursor hook verb + stdin payload into a framework lifecycle
 * {@link Event}. Returns `null` for unknown verbs (no lifecycle action).
 *
 * **Bind context**: this function uses `this` to call back into
 * `resolveTranscriptRef` which needs `agent.getSessionDir` /
 * `agent.resolveSessionFile`. Call as `parseHookEvent.call(agent, ...)` or
 * via the class method on `CursorAgent.prototype`.
 *
 * @example
 * await parseHookEvent.call(cursor, 'stop', stdin);
 * // returns: { type: 'TurnEnd', sessionId, sessionRef, model, turnCount, timestamp: now, ... }
 *
 * await parseHookEvent.call(cursor, 'unknown-verb', stdin);
 * // returns: null
 *
 * await parseHookEvent.call(cursor, 'session-start', emptyStdin);
 * // throws: Error('empty hook input')
 */
export async function parseHookEvent(
	this: CursorAgent,
	hookName: string,
	stdin: NodeJS.ReadableStream,
	ctx?: AbortSignal,
): Promise<Event | null> {
	return match(hookName)
		.with(HOOK_NAME_SESSION_START, () => parseSessionStart(stdin))
		.with(HOOK_NAME_BEFORE_SUBMIT_PROMPT, () => parseTurnStart.call(this, stdin, ctx))
		.with(HOOK_NAME_STOP, () => parseTurnEnd.call(this, stdin, ctx))
		.with(HOOK_NAME_SESSION_END, () => parseSessionEnd.call(this, stdin, ctx))
		.with(HOOK_NAME_PRE_COMPACT, () => parsePreCompact(stdin))
		.with(HOOK_NAME_SUBAGENT_START, () => parseSubagentStart(stdin))
		.with(HOOK_NAME_SUBAGENT_STOP, () => parseSubagentStop(stdin))
		.otherwise(async () => null);
}

/**
 * Compute a transcript path when the hook payload omits `transcript_path`
 * (Cursor CLI mode for `stop` / `session-end` / `before-submit-prompt`).
 * IDE always populates it → fast-path returns the raw value.
 *
 * Mirrors Go `lifecycle.go: resolveTranscriptRef`. Returns `''` (not throw)
 * on any worktree / sessionDir lookup failure (fail-open — caller proceeds
 * with empty sessionRef rather than aborting the hook).
 */
async function resolveTranscriptRef(
	this: CursorAgent,
	conversationId: string,
	rawPath: string,
): Promise<string> {
	if (rawPath !== '') {
		return rawPath;
	}
	let repoRoot: string;
	try {
		repoRoot = await worktreeRoot();
	} catch (err) {
		log.warn(LOG_CTX, 'cursor: failed to get worktree root for transcript resolution', {
			err: String(err),
		});
		return '';
	}
	let sessionDir: string;
	try {
		sessionDir = await this.getSessionDir(repoRoot);
	} catch (err) {
		log.warn(LOG_CTX, 'cursor: failed to get session dir for transcript resolution', {
			err: String(err),
		});
		return '';
	}
	return this.resolveSessionFile(sessionDir, conversationId);
}

/** Build a base Event with all required fields zero-initialized. Same shape
 *  as Phase 6.2 Claude Code's `baseEvent`. */
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

async function parseSessionStart(stdin: NodeJS.ReadableStream): Promise<Event> {
	const raw = await readAndParseHookInput<SessionStartRaw>(stdin);
	const ev = baseEvent(EVENT_TYPE_SESSION_START);
	ev.sessionId = raw.conversation_id ?? '';
	ev.sessionRef = raw.transcript_path ?? '';
	ev.model = raw.model ?? '';
	return ev;
}

async function parseTurnStart(
	this: CursorAgent,
	stdin: NodeJS.ReadableStream,
	_ctx?: AbortSignal,
): Promise<Event> {
	const raw = await readAndParseHookInput<BeforeSubmitPromptInputRaw>(stdin);
	const ev = baseEvent(EVENT_TYPE_TURN_START);
	ev.sessionId = raw.conversation_id ?? '';
	ev.sessionRef = await resolveTranscriptRef.call(
		this,
		raw.conversation_id ?? '',
		raw.transcript_path ?? '',
	);
	ev.prompt = raw.prompt ?? '';
	ev.model = raw.model ?? '';
	return ev;
}

async function parseTurnEnd(
	this: CursorAgent,
	stdin: NodeJS.ReadableStream,
	_ctx?: AbortSignal,
): Promise<Event> {
	const raw = await readAndParseHookInput<StopHookInputRaw>(stdin);
	const ev = baseEvent(EVENT_TYPE_TURN_END);
	ev.sessionId = raw.conversation_id ?? '';
	ev.sessionRef = await resolveTranscriptRef.call(
		this,
		raw.conversation_id ?? '',
		raw.transcript_path ?? '',
	);
	ev.model = raw.model ?? '';
	ev.turnCount = intFromJSON(raw.loop_count);
	return ev;
}

async function parseSessionEnd(
	this: CursorAgent,
	stdin: NodeJS.ReadableStream,
	_ctx?: AbortSignal,
): Promise<Event> {
	const raw = await readAndParseHookInput<SessionEndRaw>(stdin);
	const ev = baseEvent(EVENT_TYPE_SESSION_END);
	ev.sessionId = raw.conversation_id ?? '';
	ev.sessionRef = await resolveTranscriptRef.call(
		this,
		raw.conversation_id ?? '',
		raw.transcript_path ?? '',
	);
	ev.model = raw.model ?? '';
	ev.durationMs = intFromJSON(raw.duration_ms);
	return ev;
}

async function parsePreCompact(stdin: NodeJS.ReadableStream): Promise<Event> {
	const raw = await readAndParseHookInput<PreCompactHookInputRaw>(stdin);
	const ev = baseEvent(EVENT_TYPE_COMPACTION);
	ev.sessionId = raw.conversation_id ?? '';
	ev.sessionRef = raw.transcript_path ?? '';
	ev.contextTokens = intFromJSON(raw.context_tokens);
	ev.contextWindowSize = intFromJSON(raw.context_window_size);
	return ev;
}

async function parseSubagentStart(stdin: NodeJS.ReadableStream): Promise<Event | null> {
	const raw = await readAndParseHookInput<SubagentStartHookInputRaw>(stdin);
	if (raw.task === '' || raw.task === undefined) {
		// Spurious IDE event (background agent firing subagent hook without a
		// real task). Mirrors Go fast-skip.
		return null;
	}
	const ev = baseEvent(EVENT_TYPE_SUBAGENT_START);
	ev.sessionId = raw.conversation_id ?? '';
	ev.sessionRef = raw.transcript_path ?? '';
	ev.subagentId = raw.subagent_id ?? '';
	ev.toolUseId = raw.subagent_id ?? '';
	ev.subagentType = raw.subagent_type ?? '';
	ev.taskDescription = raw.task;
	return ev;
}

async function parseSubagentStop(stdin: NodeJS.ReadableStream): Promise<Event | null> {
	const raw = await readAndParseHookInput<SubagentStopHookInputRaw>(stdin);
	if (raw.task === '' || raw.task === undefined) {
		return null;
	}
	const ev = baseEvent(EVENT_TYPE_SUBAGENT_END);
	ev.sessionId = raw.conversation_id ?? '';
	ev.sessionRef = raw.transcript_path ?? '';
	ev.toolUseId = raw.subagent_id ?? '';
	ev.subagentType = raw.subagent_type ?? '';
	ev.taskDescription = raw.task;
	ev.subagentId = raw.subagent_id ?? '';
	ev.modifiedFiles = raw.modified_files ?? [];
	return ev;
}
