/**
 * Per-subagent-task pre-task state snapshot — captured at `SubagentStart`,
 * consumed at `SubagentEnd` (or by the Claude post-todo incremental-checkpoint
 * trigger) to compute the set of files changed during the task.
 *
 * Mirrors Go `cmd/entire/cli/state.go`: `PreTaskState` struct +
 * `PreUntrackedFiles` + `CapturePreTaskState` + `LoadPreTaskState` +
 * `CleanupPreTaskState` + `FindActivePreTaskFile` + `preTaskFilePrefix`.
 *
 * **File layout**: `<tmpDir>/pre-task-<toolUseId>.json` (mode `0o600`).
 * Multiple subagent tasks can coexist — each has a unique `toolUseId`.
 *
 * **On-disk JSON schema** (matches Go `PreTaskState` for round-trip
 * compatibility):
 *
 * ```json
 * {
 *   "tool_use_id": "toolu_abc123",
 *   "timestamp": "2026-04-21T08:30:00Z",
 *   "untracked_files": ["a.log"]
 * }
 * ```
 *
 * **Timestamp format**: RFC3339 without fractional seconds
 * (`2026-04-21T08:30:00Z`), matching Go's
 * `time.Now().UTC().Format(time.RFC3339)`. Node's `toISOString()` emits a
 * `.000` millisecond suffix we strip so the bytes written match Go.
 *
 * @packageDocumentation
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { validateToolUseID } from '@/validation';
import { resolveTmpDir } from './tmp-dir';

/**
 * Filename prefix used for active pre-task state files. Mirrors Go
 * `preTaskFilePrefix` literal — shared on-disk format with the Go CLI.
 */
export const PRE_TASK_FILE_PREFIX = 'pre-task-' as const;

/**
 * Pre-task state captured at `SubagentStart`. Similar shape to
 * {@link ./pre-prompt-state.PrePromptState} but keyed by `toolUseId` (which
 * uniquely identifies a running subagent task).
 */
export interface PreTaskState {
	toolUseId: string;
	untrackedFiles: string[];
	startTime: Date;
}

/**
 * Non-null accessor: returns the `untrackedFiles` array (or `[]` if `state`
 * is null). Mirrors Go `(*PreTaskState).PreUntrackedFiles()`.
 */
export function preTaskUntrackedFiles(state: PreTaskState | null | undefined): string[] {
	return state?.untrackedFiles ?? [];
}

/**
 * Capture state before a subagent task begins. Writes
 * `<tmpDir>/pre-task-<toolUseId>.json` atomically (write-to-temp + rename)
 * with mode `0o600`. Mirrors Go `CapturePreTaskState`.
 *
 * Pre-flight validation mirrors Go `CapturePreTaskState`:
 *
 * 1. Empty `toolUseID` → throws `Error('tool_use_id is required')`
 *    (Go hard-errors with the same string; no fallback).
 * 2. {@link validateToolUseID} — reject path separators and other unsafe
 *    characters before they become part of a filename. Fails with
 *    `"invalid tool use ID for pre-task state: <reason>"` to match Go's
 *    wrapped `fmt.Errorf` output.
 *
 * Dynamic `import('./file-changes')` keeps the module graph clean between
 * `pre-task-state.ts` and `file-changes.ts` (both are sibling helpers).
 *
 * @example
 * await capturePreTaskState('toolu_abc123');
 * // Side effects: <repoRoot>/.story/tmp/pre-task-toolu_abc123.json ← written.
 */
export async function capturePreTaskState(toolUseID: string): Promise<void> {
	if (toolUseID === '') {
		throw new Error('tool_use_id is required');
	}
	const validationErr = validateToolUseID(toolUseID);
	if (validationErr !== null) {
		throw new Error(`invalid tool use ID for pre-task state: ${validationErr.message}`);
	}

	const tmp = await resolveTmpDir();
	// mode 0o750 mirrors Go `os.MkdirAll(tmp, 0o750)` (`state.go`).
	await fs.mkdir(tmp, { recursive: true, mode: 0o750 });

	const { getUntrackedFilesForState } = await import('./file-changes');
	const untracked = await getUntrackedFilesForState();

	// Go `time.Now().UTC().Format(time.RFC3339)` produces second-precision
	// `2026-04-21T08:30:00Z`. Node's `toISOString()` adds a `.000` millisecond
	// suffix we strip so the bytes round-trip byte-identical to Go's writer.
	const startTime = new Date();
	const timestampRfc3339 = startTime.toISOString().replace(/\.\d{3}Z$/, 'Z');

	// Field order matches Go (`tool_use_id`, `timestamp`, `untracked_files`).
	const json = `${JSON.stringify(
		{
			tool_use_id: toolUseID,
			timestamp: timestampRfc3339,
			untracked_files: untracked,
		},
		null,
		2,
	)}\n`;

	const filePath = path.join(tmp, `${PRE_TASK_FILE_PREFIX}${toolUseID}.json`);
	const tmpPath = `${filePath}.tmp`;
	await fs.writeFile(tmpPath, json, { mode: 0o600 });
	await fs.rename(tmpPath, filePath);
}

/**
 * Load pre-task state by `toolUseId`. Returns `null` on missing file; throws
 * on parse failure. Mirrors Go `LoadPreTaskState` (`state.go`).
 *
 * Pre-flight {@link validateToolUseID} rejects invalid-format IDs with
 * `"invalid tool use ID for pre-task state: <reason>"` before any
 * filesystem access, preventing path traversal via a crafted ID.
 *
 * **Backward-compat**: accepts both the canonical `timestamp` field (Go
 * current) and the legacy `start_time` field (older TS-only snapshots
 * written before the Go-alignment fix). The canonical field wins when
 * both are present.
 */
export async function loadPreTaskState(toolUseID: string): Promise<PreTaskState | null> {
	const validationErr = validateToolUseID(toolUseID);
	if (validationErr !== null) {
		throw new Error(`invalid tool use ID for pre-task state: ${validationErr.message}`);
	}

	const tmp = await resolveTmpDir();
	const filePath = path.join(tmp, `${PRE_TASK_FILE_PREFIX}${toolUseID}.json`);
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
		tool_use_id?: string;
		timestamp?: string;
		start_time?: string;
		untracked_files?: string[];
	};
	try {
		parsed = JSON.parse(raw) as typeof parsed;
	} catch (err) {
		throw new Error(`failed to parse pre-task state: ${(err as Error).message}`, {
			cause: err,
		});
	}
	const timestamp = parsed.timestamp ?? parsed.start_time;
	return {
		toolUseId: parsed.tool_use_id ?? toolUseID,
		untrackedFiles: parsed.untracked_files ?? [],
		startTime: timestamp ? new Date(timestamp) : new Date(0),
	};
}

/**
 * Idempotent delete of the pre-task snapshot for `toolUseId`. Missing file is
 * treated as success. Mirrors Go `CleanupPreTaskState` (`state.go`).
 *
 * Pre-flight {@link validateToolUseID} rejects invalid-format IDs with
 * `"invalid tool use ID for pre-task state cleanup: <reason>"` before
 * `fs.rm` touches disk.
 */
export async function cleanupPreTaskState(toolUseID: string): Promise<void> {
	const validationErr = validateToolUseID(toolUseID);
	if (validationErr !== null) {
		throw new Error(`invalid tool use ID for pre-task state cleanup: ${validationErr.message}`);
	}

	const tmp = await resolveTmpDir();
	const filePath = path.join(tmp, `${PRE_TASK_FILE_PREFIX}${toolUseID}.json`);
	await fs.rm(filePath, { force: true });
}

/**
 * Find the currently-active subagent task by scanning `<tmpDir>/` for
 * `pre-task-*.json`. If multiple exist (nested subagents shouldn't happen,
 * but we defensively handle it), returns the file with the most recent
 * mtime — matches Go: "active" means most recently captured.
 *
 * Returns `{ found: false, toolUseId: '' }` when:
 *
 * - The tmp dir does not exist (`ENOENT`) — main-agent context never has a
 *   pre-task file; this is the silent-skip signal.
 * - No file matches the `pre-task-*.json` pattern.
 * - Any other `readdir` error (EACCES, EMFILE, …) — silently return the
 *   same empty result. Mirrors Go `FindActivePreTaskFile` (`state.go`)
 *   which swallows all `os.ReadDir` failures unconditionally. Subagent-context
 *   detection is a lookup heuristic, not a fault signal, so we do not log.
 *
 * Mirrors Go `FindActivePreTaskFile`.
 *
 * @example
 * await findActivePreTaskFile();
 * // In subagent context: { found: true, toolUseId: 'toolu_abc123' }
 * // In main-agent context (or no tmp dir): { found: false, toolUseId: '' }
 *
 * // Side effects: read-only fs.readdir + fs.stat on <tmpDir>.
 */
export async function findActivePreTaskFile(): Promise<{
	found: boolean;
	toolUseId: string;
}> {
	const tmp = await resolveTmpDir();
	let names: string[];
	try {
		names = await fs.readdir(tmp);
	} catch {
		// Mirrors Go `FindActivePreTaskFile` (`state.go`): any
		// readdir failure — ENOENT, EACCES, EMFILE, etc. — is treated as
		// "no active pre-task file" without logging. Subagent-context
		// detection is a lookup heuristic, not a fault signal, so noisy
		// warnings here would be counterproductive.
		return { found: false, toolUseId: '' };
	}

	const suffix = '.json';
	let latestMtime = Number.NEGATIVE_INFINITY;
	let latestToolUseId = '';
	for (const name of names) {
		if (!name.startsWith(PRE_TASK_FILE_PREFIX) || !name.endsWith(suffix)) {
			continue;
		}
		const toolUseId = name.slice(PRE_TASK_FILE_PREFIX.length, name.length - suffix.length);
		if (toolUseId === '') {
			continue;
		}
		let stat: { mtimeMs: number };
		try {
			stat = await fs.stat(path.join(tmp, name));
		} catch {
			continue;
		}
		if (stat.mtimeMs > latestMtime) {
			latestMtime = stat.mtimeMs;
			latestToolUseId = toolUseId;
		}
	}

	if (latestToolUseId === '') {
		return { found: false, toolUseId: '' };
	}
	return { found: true, toolUseId: latestToolUseId };
}
