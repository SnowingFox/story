/**
 * Per-turn pre-prompt state snapshot — captured at `TurnStart`, consumed at
 * `TurnEnd` to compute the set of files changed during the turn and to
 * resolve transcript offsets for per-turn token-usage windows.
 *
 * Mirrors Go `cmd/entire/cli/state.go`: `PrePromptState` struct +
 * `PreUntrackedFiles` + `normalizePrePromptState` + `CapturePrePromptState`
 * + `LoadPrePromptState` + `CleanupPrePromptState`.
 *
 * **File layout**: `<tmpDir>/pre-prompt-<sessionId>.json` (mode `0o600`).
 *
 * **On-disk JSON schema** (matches Go `PrePromptState` for round-trip
 * compatibility):
 *
 * ```json
 * {
 *   "session_id": "sid-1",
 *   "timestamp": "2026-04-21T08:30:00Z",
 *   "untracked_files": ["a.log"],
 *   "transcript_offset": 42
 * }
 * ```
 *
 * `transcript_offset` is omitted when 0 (Go `omitempty`), as is
 * `last_transcript_identifier` when absent. Three deprecated Go fields
 * (`start_message_index`, `step_transcript_start`,
 * `last_transcript_line_count`) are auto-migrated to the canonical
 * `transcript_offset` on load; migration picks the most-specific value if
 * multiple are non-zero.
 *
 * **Timestamp format**: RFC3339 without fractional seconds
 * (`2026-04-21T08:30:00Z`), matching Go's
 * `time.Now().UTC().Format(time.RFC3339)`. We strip the millisecond suffix
 * that Node's `toISOString()` adds so the written bytes are byte-identical
 * to Go's output.
 *
 * **TOCTOU note**: Node.js lacks `openat` / `O_RESOLVE_BENEATH`, so there is
 * a theoretical window between `fs.mkdir` and `fs.rename` where the tmp dir
 * could be replaced by a symlink. Mirrors Go's single-threaded lifecycle —
 * the handler that owns this file has no concurrent writer.
 *
 * @packageDocumentation
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { asTranscriptAnalyzer } from '@/agent/capabilities';
import type { Agent } from '@/agent/interfaces';
import * as log from '@/log';
import { validateSessionId } from '@/validation';
import { UNKNOWN_SESSION_ID } from './dispatch-helpers';
import { resolveTmpDir } from './tmp-dir';

/**
 * In-memory pre-prompt snapshot.
 *
 * - `sessionId` — session that owns this snapshot. Populated on capture and
 *   round-tripped from the `session_id` JSON field on load (Go side writes
 *   it; Story side needs it to reattach the snapshot to the active session
 *   on warm-resume).
 * - `untrackedFiles` — files present in worktree but not tracked by git at
 *   `TurnStart`. `TurnEnd` needs these to distinguish "new file" (created
 *   during turn) from "pre-existing untracked" (untouched).
 * - `transcriptOffset` — number of transcript lines present at `TurnStart`.
 *   `TurnEnd` slices `[transcriptOffset .. currentLineCount)` to extract
 *   files-modified + token-usage for this turn alone.
 * - `startTime` — ISO-8601 timestamp (for debug / log correlation only).
 *   Populated from the `timestamp` JSON field.
 * - `lastTranscriptIdentifier` — agent-specific transcript id (UUID for
 *   Claude Code, message id for Gemini). Optional; Part 2 `TurnEnd` uses
 *   it to line up transcript slicing across resumed sessions.
 *
 * The three deprecated fields are only populated when loading legacy files;
 * `normalizePrePromptState` folds them into `transcriptOffset` and clears
 * them, so the in-memory state returned by `loadPrePromptState` never has
 * them set.
 */
export interface PrePromptState {
	sessionId: string;
	untrackedFiles: string[];
	transcriptOffset: number;
	startTime: Date;
	lastTranscriptIdentifier?: string;
	/** @deprecated Legacy Go field; `normalizePrePromptState` migrates it into `transcriptOffset`. */
	startMessageIndex?: number;
	/** @deprecated Legacy Go field; `normalizePrePromptState` migrates it into `transcriptOffset`. */
	stepTranscriptStart?: number;
	/** @deprecated Legacy Go field; `normalizePrePromptState` migrates it into `transcriptOffset`. */
	lastTranscriptLineCount?: number;
}

/**
 * Non-null accessor: returns the `untrackedFiles` array (or `[]` if `state`
 * is null). Mirrors Go `(*PrePromptState).PreUntrackedFiles()` which treats
 * a nil receiver as an empty slice.
 *
 * @example
 * preUntrackedFiles(null); // → []
 * preUntrackedFiles({ sessionId: 's', untrackedFiles: ['a'], transcriptOffset: 0, startTime: new Date() }); // → ['a']
 */
export function preUntrackedFiles(state: PrePromptState | null | undefined): string[] {
	return state?.untrackedFiles ?? [];
}

/**
 * Normalize a loaded {@link PrePromptState} by folding the 3 deprecated
 * transcript-offset fields into `transcriptOffset` when `transcriptOffset`
 * is still 0. Priority (highest wins):
 *
 * 1. `transcriptOffset` — canonical; if non-zero, leave alone
 * 2. `stepTranscriptStart` — Go intermediate, used when turn started mid-step
 * 3. `lastTranscriptLineCount` — Go legacy, equivalent to `transcriptOffset` in the simple case
 * 4. `startMessageIndex` — Go oldest; may be a count of messages rather than
 *    lines (lossy for streaming assistants but best available)
 *
 * After normalization the 3 deprecated fields are cleared so subsequent
 * saves don't preserve stale data. `lastTranscriptIdentifier` is
 * passed through unchanged.
 *
 * Mirrors Go `normalizePrePromptState`.
 */
export function normalizePrePromptState(state: PrePromptState): PrePromptState {
	let offset = state.transcriptOffset;
	if (offset === 0) {
		if (state.stepTranscriptStart && state.stepTranscriptStart > 0) {
			offset = state.stepTranscriptStart;
		} else if (state.lastTranscriptLineCount && state.lastTranscriptLineCount > 0) {
			offset = state.lastTranscriptLineCount;
		} else if (state.startMessageIndex && state.startMessageIndex > 0) {
			offset = state.startMessageIndex;
		}
	}
	return {
		sessionId: state.sessionId,
		untrackedFiles: state.untrackedFiles ?? [],
		transcriptOffset: offset,
		startTime: state.startTime,
		lastTranscriptIdentifier: state.lastTranscriptIdentifier,
	};
}

/**
 * Capture the pre-prompt state for a new turn. Writes
 * `<tmpDir>/pre-prompt-<sessionId>.json` (mode `0o600`) atomically
 * (write-to-temp + rename).
 *
 * Pre-flight validation mirrors Go `CapturePrePromptState`:
 *
 * 1. Empty `sessionID` → fall back to {@link UNKNOWN_SESSION_ID}
 *    (handler-level TS-divergence established in Part 1: session-end and
 *    session-start also fall back rather than erroring out).
 * 2. {@link validateSessionId} — reject path separators and other unsafe
 *    characters before they become part of a filename. Fails with
 *    `"invalid session ID for pre-prompt state: <reason>"` to match Go's
 *    wrapped `fmt.Errorf` output.
 *
 * If the agent implements `TranscriptAnalyzer` (via
 * {@link asTranscriptAnalyzer}), queries `getTranscriptPosition(sessionRef)`
 * to seed `transcriptOffset`; otherwise leaves it 0.
 *
 * Untracked file list is captured via `getUntrackedFilesForState`
 * (fail-safe → empty list on error). Imported dynamically to keep the
 * module graph clean between `pre-prompt-state.ts` and `file-changes.ts`.
 *
 * @example
 * await capturePrePromptState(agent, 'sid-1', '/Users/me/.claude/projects/foo/abc.jsonl');
 * // Side effects:
 * //   <repoRoot>/.story/tmp/                     ← created if missing (mode 0o750)
 * //   <repoRoot>/.story/tmp/pre-prompt-sid-1.json ← new JSON file (mode 0o600)
 * //   Worktree / index / HEAD: unchanged
 */
export async function capturePrePromptState(
	ag: Agent,
	sessionID: string,
	sessionRef: string,
): Promise<void> {
	const effectiveSessionId = sessionID === '' ? UNKNOWN_SESSION_ID : sessionID;
	const validationErr = validateSessionId(effectiveSessionId);
	if (validationErr !== null) {
		throw new Error(`invalid session ID for pre-prompt state: ${validationErr.message}`);
	}

	const tmp = await resolveTmpDir();
	// mode 0o750 mirrors Go `os.MkdirAll(tmp, 0o750)` (`state.go`).
	// Owner rwx + group rx: lets the worktree owner read+write snapshot
	// files while the group (developer machines / CI runners) can at
	// least `ls` the dir for debugging without elevated permissions.
	await fs.mkdir(tmp, { recursive: true, mode: 0o750 });

	let transcriptOffset = 0;
	const [ta, ok] = asTranscriptAnalyzer(ag);
	if (ok && ta && sessionRef !== '') {
		try {
			transcriptOffset = await ta.getTranscriptPosition(sessionRef);
		} catch (err) {
			log.warn({ component: 'lifecycle' }, 'failed to get transcript position', {
				error: (err as Error).message,
			});
			transcriptOffset = 0;
		}
	}

	const { getUntrackedFilesForState } = await import('./file-changes');
	const untracked = await getUntrackedFilesForState();

	// Go `time.Now().UTC().Format(time.RFC3339)` produces second-precision
	// `2026-04-21T08:30:00Z`. Node's `toISOString()` adds a `.000` millisecond
	// suffix we strip so the bytes round-trip byte-identical to Go's writer.
	const startTime = new Date();
	const timestampRfc3339 = startTime.toISOString().replace(/\.\d{3}Z$/, 'Z');

	// Build the JSON payload explicitly in Go's field order so the emitted
	// bytes match Go (`session_id`, `timestamp`, `untracked_files`,
	// `transcript_offset`). `transcript_offset` is omitted when 0 to match
	// Go's `json:"transcript_offset,omitempty"`.
	const payload: Record<string, unknown> = {
		session_id: effectiveSessionId,
		timestamp: timestampRfc3339,
		untracked_files: untracked,
	};
	if (transcriptOffset !== 0) {
		payload.transcript_offset = transcriptOffset;
	}

	const json = `${JSON.stringify(payload, null, 2)}\n`;

	const filePath = path.join(tmp, `pre-prompt-${effectiveSessionId}.json`);
	const tmpPath = `${filePath}.tmp`;
	await fs.writeFile(tmpPath, json, { mode: 0o600 });
	await fs.rename(tmpPath, filePath);
}

/**
 * Load the pre-prompt snapshot for `sessionID`. Returns `null` on missing
 * file (no error — `TurnEnd` may run without a prior `TurnStart` in
 * rewind-reset cases). Throws on parse failure so corruption surfaces
 * clearly.
 *
 * Pre-flight {@link validateSessionId} mirrors Go `LoadPrePromptState`
 * (`state.go`): session IDs with path separators throw
 * `"invalid session ID for pre-prompt state: <reason>"` before any
 * filesystem access, preventing path traversal via a crafted ID.
 *
 * Runs {@link normalizePrePromptState} on load to fold deprecated fields.
 *
 * **Backward-compat**: accepts both the canonical `timestamp` field (Go
 * current) and the legacy `start_time` field (older TS-only snapshots
 * written before the Go-alignment fix). The canonical field wins when
 * both are present.
 *
 * @example
 * await loadPrePromptState('sid-1');
 * // File exists → { sessionId: 'sid-1', untrackedFiles: [...], transcriptOffset: 42, startTime: Date }
 * // File missing → null
 * // File corrupt → throws 'failed to parse pre-prompt state: <parse error>'
 * // Path-separator ID → throws 'invalid session ID for pre-prompt state: ...'
 */
export async function loadPrePromptState(sessionID: string): Promise<PrePromptState | null> {
	const validationErr = validateSessionId(sessionID);
	if (validationErr !== null) {
		throw new Error(`invalid session ID for pre-prompt state: ${validationErr.message}`);
	}

	const tmp = await resolveTmpDir();
	const filePath = path.join(tmp, `pre-prompt-${sessionID}.json`);
	let raw: string;
	try {
		raw = await fs.readFile(filePath, 'utf-8');
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			return null;
		}
		throw err;
	}
	let parsed: {
		session_id?: string;
		timestamp?: string;
		start_time?: string;
		untracked_files?: string[];
		transcript_offset?: number;
		last_transcript_identifier?: string;
		start_message_index?: number;
		step_transcript_start?: number;
		last_transcript_line_count?: number;
	};
	try {
		parsed = JSON.parse(raw) as typeof parsed;
	} catch (err) {
		throw new Error(`failed to parse pre-prompt state: ${(err as Error).message}`, {
			cause: err,
		});
	}
	const timestamp = parsed.timestamp ?? parsed.start_time;
	const state: PrePromptState = {
		sessionId: parsed.session_id ?? sessionID,
		untrackedFiles: parsed.untracked_files ?? [],
		transcriptOffset: parsed.transcript_offset ?? 0,
		startTime: timestamp ? new Date(timestamp) : new Date(0),
		lastTranscriptIdentifier: parsed.last_transcript_identifier,
		startMessageIndex: parsed.start_message_index,
		stepTranscriptStart: parsed.step_transcript_start,
		lastTranscriptLineCount: parsed.last_transcript_line_count,
	};
	return normalizePrePromptState(state);
}

/**
 * Delete the pre-prompt snapshot for `sessionID`. Missing file is treated
 * as success (idempotent cleanup).
 *
 * Pre-flight {@link validateSessionId} mirrors Go `CleanupPrePromptState`
 * (`state.go`): path-separator IDs throw
 * `"invalid session ID for pre-prompt state cleanup: <reason>"` before
 * `fs.rm` touches disk.
 *
 * @example
 * await cleanupPrePromptState('sid-1');
 * // Side effects: <repoRoot>/.story/tmp/pre-prompt-sid-1.json ← deleted (or no-op).
 */
export async function cleanupPrePromptState(sessionID: string): Promise<void> {
	const validationErr = validateSessionId(sessionID);
	if (validationErr !== null) {
		throw new Error(`invalid session ID for pre-prompt state cleanup: ${validationErr.message}`);
	}

	const tmp = await resolveTmpDir();
	const filePath = path.join(tmp, `pre-prompt-${sessionID}.json`);
	await fs.rm(filePath, { force: true });
}
