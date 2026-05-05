/**
 * Shared lifecycle helpers kept outside {@link dispatchLifecycleEvent} so
 * handlers can consume them without re-importing the dispatcher itself
 * (which, after Part 2, imports every handler — importing it from a
 * handler would create a module-level cycle).
 *
 * Re-exported from `dispatch.ts` for backward compat with Part 1 callers.
 *
 * Mirrors Go `cmd/entire/cli/lifecycle.go` helper section
 * (`resolveTranscriptOffset`, `parseTranscriptForCheckpointUUID`,
 * `logFileChanges`, `persistEventMetadataToState`, plus the Go package-
 * level `unknownSessionID` constant which actually lives in `rewind.go`
 * but is conceptually lifecycle-shared).
 *
 * @packageDocumentation
 */

import { EVENT_TYPE_TURN_END, type Event } from '@/agent/event';
import * as log from '@/log';
import type { SessionState } from '@/session/state-store';
import { loadSessionState } from '@/strategy/session-state';
import { parseFromFileAtLine } from '@/transcript';
import type { PrePromptState } from './pre-prompt-state';

/**
 * Constant session-id used when none can be derived from an event.
 * Mirrors Go `unknownSessionID = "unknown"` defined in
 * `cmd/entire/cli/rewind.go`.
 */
export const UNKNOWN_SESSION_ID = 'unknown' as const;

/**
 * Resolve the transcript-line offset for a session.
 *
 * Order of precedence (mirrors Go `lifecycle.go`):
 *
 * 1. `preState.transcriptOffset` when positive — pre-prompt capture is the
 *    authoritative source (set on `TurnStart`).
 * 2. `sessionState.checkpointTranscriptStart` when positive — the last
 *    committed checkpoint's transcript line count, used when
 *    `capturePrePromptState` was skipped (e.g., warm-resume without a
 *    prior `TurnStart` in this process lifetime).
 * 3. `0` — no offset; parse the full transcript.
 *
 * Session-state load failures are swallowed (fail-open; caller always
 * receives a number).
 *
 * @example
 * await resolveTranscriptOffset(
 *   { sessionId: 's', untrackedFiles: [], transcriptOffset: 42, startTime: new Date() },
 *   'sid-1',
 * );
 * // → 42 (pre-state wins)
 *
 * await resolveTranscriptOffset(null, 'sid-1');
 * // → session-state fallback or 0
 */
export async function resolveTranscriptOffset(
	preState: PrePromptState | null,
	sessionID: string,
): Promise<number> {
	if (preState && preState.transcriptOffset > 0) {
		return preState.transcriptOffset;
	}
	try {
		const state = await loadSessionState(sessionID);
		if (state && (state.checkpointTranscriptStart ?? 0) > 0) {
			return state.checkpointTranscriptStart as number;
		}
	} catch (err) {
		log.warn(
			{ component: 'lifecycle', sessionId: sessionID },
			'failed to load session state for transcript offset',
			{ error: (err as Error).message },
		);
	}
	return 0;
}

/**
 * Parse a transcript file and return its lines. Delegates to
 * {@link parseFromFileAtLine} with `startLine = 0` (whole file).
 *
 * Returns `null` on any read / parse failure — Go parity with
 * `lifecycle.go` swallows the wrapped error and the caller
 * (`handleSubagentEnd`) uses `null` as "skip UUID lookup".
 *
 * @example
 * await parseTranscriptForCheckpointUUID('/tmp/transcript.jsonl');
 * // → TranscriptLine[] on success, `null` on missing / malformed file.
 */
export async function parseTranscriptForCheckpointUUID(
	transcriptPath: string,
): Promise<unknown[] | null> {
	try {
		return await parseFromFileAtLine(transcriptPath, 0);
	} catch {
		return null;
	}
}

/**
 * Log the per-turn file-change summary at DEBUG level. Small helper used
 * by both the Part 1 session-end handler (no changes; idempotent) AND the
 * Part 2 `turn-end` / `subagent-end` handlers.
 *
 * Mirrors Go `logFileChanges`.
 */
export function logFileChanges(
	logCtx: Record<string, unknown>,
	modified: string[],
	newFiles: string[],
	deleted: string[],
): void {
	log.debug(logCtx, 'files changed during session', {
		modified: modified.length,
		new: newFiles.length,
		deleted: deleted.length,
	});
}

/**
 * Copy metadata from an {@link Event} onto a {@link SessionState} so
 * subsequent events (and checkpoint trailers) carry consistent values.
 *
 * Field mapping (Go → TS):
 *
 * | Event (Go)           | SessionState (Go)     | SessionState (TS)        |
 * | -------------------- | --------------------- | ------------------------ |
 * | `Model`              | `ModelName`           | `modelName`              |
 * | `DurationMs`         | `SessionDurationMs`   | `sessionDurationMs`      |
 * | `TurnCount` (max)    | `SessionTurnCount`    | `sessionTurnCount`       |
 * | `ContextTokens`      | `ContextTokens`       | `contextTokens`          |
 * | `ContextWindowSize`  | `ContextWindowSize`   | `contextWindowSize`      |
 *
 * **TurnCount special case**: when `event.turnCount > 0` the state field
 * takes `max(event.turnCount, state.sessionTurnCount)`; when hook provides
 * `0` but event is `TurnEnd`, state increments by 1 (Story counts turns
 * itself for agents like Claude Code that don't supply turnCount).
 *
 * Mirrors Go `persistEventMetadataToState` (lifecycle.go).
 */
export function persistEventMetadataToState(event: Event, state: SessionState): void {
	if (event.model) {
		state.modelName = event.model;
	}
	if (event.durationMs > 0) {
		state.sessionDurationMs = event.durationMs;
	}
	if (event.turnCount > 0) {
		if (event.turnCount > (state.sessionTurnCount ?? 0)) {
			state.sessionTurnCount = event.turnCount;
		}
	} else if (event.type === EVENT_TYPE_TURN_END) {
		state.sessionTurnCount = (state.sessionTurnCount ?? 0) + 1;
	}
	if (event.contextTokens > 0) {
		state.contextTokens = event.contextTokens;
	}
	if (event.contextWindowSize > 0) {
		state.contextWindowSize = event.contextWindowSize;
	}
}
