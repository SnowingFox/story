/**
 * OpenCode CLI subprocess invocations: `opencode export`, `opencode session
 * delete`, `opencode import`. Used by `./lifecycle.ts: prepareTranscript` and
 * `./index.ts: writeSession` (Phase 5.5 RestoreLogsOnly path).
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/agent/opencode/cli_commands.go`.
 *
 * **Strategy** (cross-runtime via `execa`):
 * - Use `execa` (already used by `src/git.ts`) — works under both Bun and
 *   Node (vitest runs under Node).
 * - Each command honors `OPENCODE_COMMAND_TIMEOUT_MS = 30s` via `execa`'s
 *   `timeout` option.
 * - {@link AbortSignal} propagates via `execa`'s `cancelSignal` option.
 *
 * **Error contract** (Go-aligned):
 * - Non-zero exit → `Error('opencode <verb> failed: ... (output: ...)')`
 * - Timeout → `Error('opencode <verb> timed out after 30s')`
 * - {@link runOpenCodeSessionDelete} swallows `'session not found'` output as
 *   success (idempotent — the session may not exist on first import).
 *
 * @packageDocumentation
 */

import fs from 'node:fs/promises';
import { execa } from 'execa';

/** Maximum wall-time for any single OpenCode CLI invocation. Mirrors Go
 *  `cli_commands.go: openCodeCommandTimeout = 30 * time.Second`. */
export const OPENCODE_COMMAND_TIMEOUT_MS = 30_000;

/**
 * Mutable copy of {@link OPENCODE_COMMAND_TIMEOUT_MS} used by {@link exec}.
 * Swapped only via {@link __setCommandTimeoutForTest} so production stays at
 * 30s. Error messages continue to report the 30s constant, matching Go's
 * hard-coded `%s` format of `openCodeCommandTimeout`.
 */
let commandTimeoutMs = OPENCODE_COMMAND_TIMEOUT_MS;

/**
 * Test-only: lower `commandTimeoutMs` to force `execa` into its timeout arm
 * within a unit-test timescale. Returns a restore function.
 *
 * Mirrors Go's `runOpenCodeExportToFileFn` function-variable swap pattern
 * ([lifecycle_test.go:372-381]) — a minimal seam that keeps the production
 * constant untouched while letting tests exercise the timeout branch.
 *
 * Do NOT call from non-test code. The `__` prefix is the project convention
 * for test-only surface.
 */
export function __setCommandTimeoutForTest(ms: number): () => void {
	const prev = commandTimeoutMs;
	commandTimeoutMs = ms;
	return () => {
		commandTimeoutMs = prev;
	};
}

interface ExecResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

/**
 * Run a subprocess via `execa` with timeout + AbortSignal handling. Returns
 * `{ exitCode, stdout, stderr, timedOut }` rather than throwing on non-zero
 * exit so caller can implement Go-aligned error message formatting.
 *
 * With `reject: false`, execa surfaces spawn failures (missing binary,
 * permission denied) as `exitCode: undefined` / `stderr: <os message>`
 * rather than throwing — callers then format a Go-aligned
 * `opencode <verb> failed: exit -1` message via the non-zero-exit arm.
 * `cancelSignal` still rejects the promise; that rejection propagates to
 * the caller (each `runOpenCode*` wrapper removes any side-effect files it
 * created, then rethrows).
 */
async function exec(
	signal: AbortSignal | undefined,
	argv0: string,
	args: string[],
): Promise<ExecResult> {
	const result = await execa(argv0, args, {
		timeout: commandTimeoutMs,
		cancelSignal: signal,
		reject: false,
		stdin: 'ignore',
		all: false,
	});
	return {
		exitCode: typeof result.exitCode === 'number' ? result.exitCode : -1,
		stdout: typeof result.stdout === 'string' ? result.stdout : '',
		stderr: typeof result.stderr === 'string' ? result.stderr : '',
		timedOut: result.timedOut === true,
	};
}

/**
 * Run `opencode export <sessionId>` and write stdout to {@link outputPath}.
 *
 * **Why write to file (not stdout pipe)**: Go `cli_commands.go` comment notes
 * "avoids pipe/stdout capture truncation bugs in some opencode versions".
 * Story matches by capturing stdout to JS buffer then writing to disk in one
 * `fs.writeFile` (mode `0o600`).
 *
 * On failure: removes `outputPath` (best-effort) before throwing.
 *
 * Mirrors Go `runOpenCodeExportToFile`.
 *
 * @example
 * await runOpenCodeExportToFile(ctrl.signal, 'ses_abc', '/tmp/.../ses_abc.json');
 *
 * // Side effects:
 * //   <outputPath> ← stdout of `opencode export ses_abc` (mode 0o600)
 * //
 * // Failure modes:
 * //   - non-zero exit (incl. missing binary and mid-flight abort, which
 * //     execa surfaces as a non-zero/signal exit under `reject: false`)
 * //       → throw 'opencode export failed: exit <n> (stderr: ...)' + remove <outputPath>
 * //   - timeout (>30s) → throw 'opencode export timed out after 30s'
 */
export async function runOpenCodeExportToFile(
	signal: AbortSignal,
	sessionId: string,
	outputPath: string,
): Promise<void> {
	const result = await exec(signal, 'opencode', ['export', sessionId]);
	if (result.timedOut) {
		await fs.rm(outputPath, { force: true });
		throw new Error(`opencode export timed out after ${OPENCODE_COMMAND_TIMEOUT_MS / 1000}s`);
	}
	if (result.exitCode !== 0) {
		await fs.rm(outputPath, { force: true });
		throw new Error(
			`opencode export failed: exit ${result.exitCode} (stderr: ${result.stderr.trim()})`,
		);
	}
	await fs.writeFile(outputPath, result.stdout, { mode: 0o600 });
}

/**
 * Run `opencode session delete <sessionId>` to remove a session from
 * OpenCode's database.
 *
 * **Idempotent**: returns successfully when the session doesn't exist
 * (combined output contains `'session not found'`, case-insensitive).
 * Mirrors Go's `strings.Contains(strings.ToLower(...), "session not found")`
 * swallow.
 *
 * Used by `./index.ts: writeSession` before `runOpenCodeImport` so import
 * can replace existing messages cleanly (OpenCode's `import` uses
 * `ON CONFLICT DO NOTHING` which would skip existing messages otherwise).
 *
 * Mirrors Go `runOpenCodeSessionDelete`.
 */
export async function runOpenCodeSessionDelete(
	signal: AbortSignal,
	sessionId: string,
): Promise<void> {
	const result = await exec(signal, 'opencode', ['session', 'delete', sessionId]);
	if (result.timedOut) {
		throw new Error(
			`opencode session delete timed out after ${OPENCODE_COMMAND_TIMEOUT_MS / 1000}s`,
		);
	}
	if (result.exitCode === 0) {
		return;
	}
	const combinedLower = `${result.stdout}\n${result.stderr}`.toLowerCase();
	if (combinedLower.includes('session not found')) {
		return;
	}
	throw new Error(
		`opencode session delete failed: exit ${result.exitCode} (output: ${result.stdout}${result.stderr})`,
	);
}

/**
 * Run `opencode import <exportFilePath>` to restore a session into OpenCode's
 * database.
 *
 * Preserves the original session ID from the export file (OpenCode's import
 * is ID-stable). Combined stdout+stderr is included in the error message on
 * non-zero exit.
 *
 * Mirrors Go `runOpenCodeImport`.
 */
export async function runOpenCodeImport(
	signal: AbortSignal,
	exportFilePath: string,
): Promise<void> {
	const result = await exec(signal, 'opencode', ['import', exportFilePath]);
	if (result.timedOut) {
		throw new Error(`opencode import timed out after ${OPENCODE_COMMAND_TIMEOUT_MS / 1000}s`);
	}
	if (result.exitCode !== 0) {
		throw new Error(
			`opencode import failed: exit ${result.exitCode} (output: ${result.stdout}${result.stderr})`,
		);
	}
}
