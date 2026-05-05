/**
 * Normalized lifecycle event produced by `HookSupport.parseHookEvent`. The
 * framework dispatcher (Phase 7) routes these events to strategy methods.
 *
 * Mirrors Go `cmd/entire/cli/agent/event.go`.
 *
 * @packageDocumentation
 */

import { match } from 'ts-pattern';

/**
 * Lifecycle event kind. Mirrors Go `agent.EventType` (iota+1 const block;
 * TS uses string-valued enum for stable serialization + better debug output).
 */
export const EVENT_TYPE_SESSION_START = 'SessionStart' as const;
export const EVENT_TYPE_TURN_START = 'TurnStart' as const;
export const EVENT_TYPE_TURN_END = 'TurnEnd' as const;
export const EVENT_TYPE_COMPACTION = 'Compaction' as const;
export const EVENT_TYPE_SESSION_END = 'SessionEnd' as const;
export const EVENT_TYPE_SUBAGENT_START = 'SubagentStart' as const;
export const EVENT_TYPE_SUBAGENT_END = 'SubagentEnd' as const;
export const EVENT_TYPE_MODEL_UPDATE = 'ModelUpdate' as const;

export type EventType =
	| typeof EVENT_TYPE_SESSION_START
	| typeof EVENT_TYPE_TURN_START
	| typeof EVENT_TYPE_TURN_END
	| typeof EVENT_TYPE_COMPACTION
	| typeof EVENT_TYPE_SESSION_END
	| typeof EVENT_TYPE_SUBAGENT_START
	| typeof EVENT_TYPE_SUBAGENT_END
	| typeof EVENT_TYPE_MODEL_UPDATE;

/**
 * Human-readable label for an event type. **Note**: Go's `String()` returns
 * `"Unknown"` for unrecognized values; TS narrows via {@link EventType} so
 * unknown is unreachable — and `match().exhaustive()` enforces that any
 * future addition gates compilation.
 *
 * Mirrors Go `agent.EventType.String`.
 */
export function eventTypeToString(t: EventType): string {
	return match(t)
		.with(EVENT_TYPE_SESSION_START, () => 'SessionStart')
		.with(EVENT_TYPE_TURN_START, () => 'TurnStart')
		.with(EVENT_TYPE_TURN_END, () => 'TurnEnd')
		.with(EVENT_TYPE_COMPACTION, () => 'Compaction')
		.with(EVENT_TYPE_SESSION_END, () => 'SessionEnd')
		.with(EVENT_TYPE_SUBAGENT_START, () => 'SubagentStart')
		.with(EVENT_TYPE_SUBAGENT_END, () => 'SubagentEnd')
		.with(EVENT_TYPE_MODEL_UPDATE, () => 'ModelUpdate')
		.exhaustive();
}

/**
 * Normalized lifecycle event. Mirrors Go `agent.Event` struct.
 *
 * Each field's nullability matches Go (zero-value string for absent string,
 * `null` Date for absent timestamp, `null` for absent JSON.RawMessage).
 */
export interface Event {
	type: EventType;
	sessionId: string;
	/** Non-empty when this event continues / hands off from a previous session
	 *  (e.g. Claude Code starting a new session ID after exiting plan mode). */
	previousSessionId: string;
	/** Agent-specific transcript reference (typically a file path). */
	sessionRef: string;
	/** User prompt text — populated on `TurnStart`. */
	prompt: string;
	/** LLM model identifier — populated on `SessionStart` / `ModelUpdate` /
	 *  `TurnStart` / `TurnEnd`. */
	model: string;
	/** When the event occurred. */
	timestamp: Date;
	/** Tool invocation ID — populated on `SubagentStart` / `SubagentEnd`. */
	toolUseId: string;
	/** Subagent instance ID — populated on `SubagentEnd`. */
	subagentId: string;
	/** Raw `tool_input` JSON — used when `subagentType` + `taskDescription`
	 *  are both empty (some agents don't provide them directly). */
	toolInput: Uint8Array | null;
	subagentType: string;
	taskDescription: string;
	/** File paths modified by a subagent — populated on `SubagentEnd` when
	 *  the agent provides the data via hook payload (e.g. Cursor `subagentStop`). */
	modifiedFiles: string[];
	/** Optional message to display to user via the agent. */
	responseMessage: string;
	/** Hook-provided session metrics. */
	durationMs: number;
	turnCount: number;
	contextTokens: number;
	contextWindowSize: number;
	/** Agent-specific metadata that the framework stores for subsequent events. */
	metadata: Record<string, string>;
}

/**
 * Read all bytes from `stdin` and parse as JSON of type `T`. Shared helper
 * for agent `parseHookEvent` implementations.
 *
 * Mirrors Go `agent.ReadAndParseHookInput[T any]`.
 *
 * **Errors**:
 * - empty input → `Error('empty hook input')`
 * - non-JSON → `Error('failed to parse hook input: ...')`
 * - read I/O failure → `Error('failed to read hook input: ...')`
 *
 * @example
 * ```ts
 * const raw = await readAndParseHookInput<{ session_id: string; prompt: string }>(stdin);
 * // returns: { session_id: '...', prompt: '...' }
 *
 * await readAndParseHookInput(stdin);   // empty stdin
 * // throws: Error('empty hook input')
 *
 * // Side effects: drains the stdin stream (single readToEnd).
 * ```
 */
export async function readAndParseHookInput<T>(stdin: NodeJS.ReadableStream): Promise<T> {
	let raw: string;
	try {
		const chunks: Buffer[] = [];
		for await (const chunk of stdin) {
			chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
		}
		raw = Buffer.concat(chunks).toString('utf8');
	} catch (e) {
		throw new Error(`failed to read hook input: ${(e as Error).message}`, {
			cause: e as Error,
		});
	}
	if (raw.length === 0) {
		throw new Error('empty hook input');
	}
	try {
		return JSON.parse(raw) as T;
	} catch (e) {
		throw new Error(`failed to parse hook input: ${(e as Error).message}`, {
			cause: e as Error,
		});
	}
}
