/**
 * Codex agent — `parseHookEvent` 4-verb dispatch + 3 lifecycle parser +
 * `writeHookResponse` (Codex `{systemMessage}` JSON to stdout).
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/agent/codex/lifecycle.go`.
 *
 * **4 hook verbs**, 3 produce events + 1 pass-through:
 *
 * | Verb | Event | Notes |
 * | --- | --- | --- |
 * | `session-start` | `SessionStart` | sessionRef from nullable `transcript_path` via `derefString` |
 * | `user-prompt-submit` | `TurnStart` | adds `prompt` field |
 * | `stop` | `TurnEnd` | reads but ignores `last_assistant_message` (round-trip preserve) |
 * | `pre-tool-use` | `null` | Pass-through; does NOT read stdin |
 *
 * Unknown verbs return `null` (no lifecycle action). Empty stdin /
 * malformed JSON throw via {@link readAndParseHookInput} (Phase 6.1 ship).
 *
 * @packageDocumentation
 */

import { match } from 'ts-pattern';
import {
	EVENT_TYPE_SESSION_START,
	EVENT_TYPE_TURN_END,
	EVENT_TYPE_TURN_START,
	type Event,
	type EventType,
	readAndParseHookInput,
} from '@/agent/event';
import {
	derefString,
	HOOK_NAME_PRE_TOOL_USE,
	HOOK_NAME_SESSION_START,
	HOOK_NAME_STOP,
	HOOK_NAME_USER_PROMPT_SUBMIT,
	type SessionStartRaw,
	type StopRaw,
	type UserPromptSubmitRaw,
} from './types';

/** The 4 hook verbs Codex supports. Order matches Go `lifecycle.go: HookNames`. */
export function hookNames(): string[] {
	return [
		HOOK_NAME_SESSION_START,
		HOOK_NAME_USER_PROMPT_SUBMIT,
		HOOK_NAME_STOP,
		HOOK_NAME_PRE_TOOL_USE,
	];
}

/**
 * Translate a Codex hook verb + stdin payload into a framework lifecycle
 * {@link Event}. Returns `null` for `pre-tool-use` (pass-through, does
 * NOT read stdin) and unknown verbs.
 *
 * **Go arm order** (`lifecycle.go:38-50`):
 *
 *   1. `session-start`        → parseSessionStart   → `SessionStart` Event
 *   2. `user-prompt-submit`   → parseTurnStart      → `TurnStart` Event
 *   3. `stop`                 → parseTurnEnd        → `TurnEnd` Event
 *   4. `pre-tool-use`         → null (no lifecycle action; stdin not read)
 *   5. (default unknown)      → null
 *
 * @example
 * await parseHookEvent('stop', stdin);
 * // returns: { type: 'TurnEnd', sessionId, sessionRef, model, timestamp: now, ... }
 *
 * await parseHookEvent('pre-tool-use', anyStdin);
 * // returns: null (stdin NOT consumed)
 *
 * await parseHookEvent('session-start', emptyStdin);
 * // throws: Error('empty hook input')
 */
export async function parseHookEvent(
	hookName: string,
	stdin: NodeJS.ReadableStream,
	_ctx?: AbortSignal,
): Promise<Event | null> {
	return match(hookName)
		.with(HOOK_NAME_SESSION_START, () => parseSessionStart(stdin))
		.with(HOOK_NAME_USER_PROMPT_SUBMIT, () => parseTurnStart(stdin))
		.with(HOOK_NAME_STOP, () => parseTurnEnd(stdin))
		.with(HOOK_NAME_PRE_TOOL_USE, async (): Promise<Event | null> => null)
		.otherwise(async (): Promise<Event | null> => null);
}

/**
 * Output a Codex hook response to stdout. Format: `{"systemMessage":"<msg>"}\n`.
 * When `message === ''`, emits `{}\n` (matches Go `json:"systemMessage,omitempty"`).
 *
 * @example
 * await writeHookResponse('Story stopped 1 checkpoint at abc123');
 * // Side effects:
 * //   stdout ← '{"systemMessage":"Story stopped 1 checkpoint at abc123"}\n'
 * //   stderr / files / git: unchanged
 */
export async function writeHookResponse(message: string): Promise<void> {
	// Mirror Go encoding/json `omitempty` — empty string drops the field.
	const obj = message === '' ? {} : { systemMessage: message };
	const payload = `${JSON.stringify(obj)}\n`;
	await new Promise<void>((resolve, reject) => {
		process.stdout.write(payload, (err) => (err ? reject(err) : resolve()));
	});
}

/** Build a base Event with all required fields zero-initialized. Same shape as
 *  Phase 6.2 Claude Code's / Phase 6.3 Cursor's `baseEvent`. */
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
	ev.sessionId = raw.session_id ?? '';
	ev.sessionRef = derefString(raw.transcript_path);
	ev.model = raw.model ?? '';
	return ev;
}

async function parseTurnStart(stdin: NodeJS.ReadableStream): Promise<Event> {
	const raw = await readAndParseHookInput<UserPromptSubmitRaw>(stdin);
	const ev = baseEvent(EVENT_TYPE_TURN_START);
	ev.sessionId = raw.session_id ?? '';
	ev.sessionRef = derefString(raw.transcript_path);
	ev.prompt = raw.prompt ?? '';
	ev.model = raw.model ?? '';
	return ev;
}

async function parseTurnEnd(stdin: NodeJS.ReadableStream): Promise<Event> {
	const raw = await readAndParseHookInput<StopRaw>(stdin);
	const ev = baseEvent(EVENT_TYPE_TURN_END);
	ev.sessionId = raw.session_id ?? '';
	ev.sessionRef = derefString(raw.transcript_path);
	ev.model = raw.model ?? '';
	return ev;
}
