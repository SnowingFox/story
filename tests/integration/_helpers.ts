/**
 * Shared `runStoryCli` helper for `tests/integration/**.integration.test.ts`
 * files. Extracted from `tests/integration/cli.e2e.test.ts` so Phase 10's
 * new `enable-disable` / `status-sessions` / `rewind-explain-resume`
 * smoke files don't duplicate the spawn plumbing.
 *
 * Every spawn hits `bun run src/cli.ts` — the raw TS entry, no build
 * step, so changes to `src/commands/*.ts` are reflected instantly.
 * `CI=1` + `NO_COLOR=1` prevent cac / clack from prompting or emitting
 * ANSI; `timeout: 30_000` caps runaway hangs.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to `src/cli.ts` — Story's raw-TS entry point. */
export const CLI_PATH = path.resolve(HERE, '..', '..', 'src', 'cli.ts');

/** Captured output from one Story CLI invocation. */
export interface RunResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

/**
 * Spawn `bun run <CLI_PATH> ...argv` in `cwd`. Wraps `child_process.spawn`
 * in a promise + collects stdout/stderr. CI-friendly defaults:
 *
 *  - `CI=1` → forces `--non-interactive` semantics (cac fails instead of
 *    prompting); Phase 9.0 `runtime.ts::forceNonInteractive` respects
 *    this.
 *  - `NO_COLOR=1` → strips picocolors output so assertions match plain
 *    text.
 *  - `timeout: 30_000` → guardrails against hangs; any stuck prompt
 *    kills the subprocess at 30s.
 */
export async function runStoryCli(
	cwd: string,
	argv: readonly string[],
	opts?: { timeoutMs?: number; extraEnv?: Record<string, string> },
): Promise<RunResult> {
	return new Promise((resolve, reject) => {
		const child = spawn('bun', ['run', CLI_PATH, ...argv], {
			cwd,
			env: { ...process.env, CI: '1', NO_COLOR: '1', ...(opts?.extraEnv ?? {}) },
			timeout: opts?.timeoutMs ?? 30_000,
		});
		const out: string[] = [];
		const err: string[] = [];
		child.stdout?.on('data', (c) => out.push(String(c)));
		child.stderr?.on('data', (c) => err.push(String(c)));
		child.on('error', reject);
		child.on('close', (code) => {
			resolve({ code, stdout: out.join(''), stderr: err.join('') });
		});
	});
}
