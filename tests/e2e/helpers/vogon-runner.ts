/**
 * Vogon runner — resolves the path to the built Vogon binary and wraps
 * `execa` for test harness use.
 *
 * Mirrors Go `entire-cli/e2e/agents/vogon.go::Vogon.RunPrompt`. The
 * binary path is set exactly once by `tests/e2e/setup.ts::beforeAll` after
 * running `bun run build`, then consumed by `RepoState.runPrompt`.
 *
 * @packageDocumentation
 */

import { type ExecaError, execa } from 'execa';
import { isolatedSpawnEnv, promptTimeoutMs } from './env';

let vogonBinPath: string | null = null;

/** Captured output from a Vogon invocation. Mirrors Go `agents.Output`. */
export interface VogonRunResult {
	command: string;
	stdout: string;
	stderr: string;
	exitCode: number;
}

/** Call once from setup.ts::beforeAll once `bun run build` produces `tests/e2e/bin/vogon.mjs`. */
export function setVogonBin(absPath: string): void {
	vogonBinPath = absPath;
}

/**
 * Read the Vogon binary path. Returns in-process cache if `setVogonBin`
 * was called; otherwise falls back to `process.env.VOGON_BIN` (set by
 * `tests/e2e/setup.ts` globalSetup, which runs in a separate process
 * context from test workers).
 */
export function getVogonBin(): string {
	if (vogonBinPath !== null) {
		return vogonBinPath;
	}
	const fromEnv = process.env.VOGON_BIN;
	if (fromEnv !== undefined && fromEnv !== '') {
		vogonBinPath = fromEnv;
		return fromEnv;
	}
	throw new Error(
		'Vogon binary path not set — tests/e2e/setup.ts globalSetup must run first (exports VOGON_BIN env var)',
	);
}

export interface RunVogonOptions {
	/** Per-prompt timeout override; default = `promptTimeoutMs()` from `env.ts`. */
	timeoutMs?: number;
	/** Extra env vars layered on top of `isolatedSpawnEnv()`. */
	env?: Record<string, string>;
}

/**
 * Spawn the Vogon binary with `-p <prompt>` inside `dir`. Mirrors Go
 * `agents.Vogon.RunPrompt`. Captured command / stdout / stderr / exit
 * code are returned to the caller (usually `RepoState.runPrompt`) which
 * is responsible for tee-ing to the per-test console.log.
 *
 * Non-zero exit codes are **not** thrown — downstream assertions decide
 * whether an exit code is an error. `execa` timeouts produce exit code
 * `null` in the result (no process signal info preserved).
 *
 * @example
 * const res = await runVogon('/tmp/story-e2e-abc', 'create a markdown file at docs/red.md');
 * // Side effects inside /tmp/story-e2e-abc:
 * //   docs/red.md                        ← new file written
 * //   .git/...                           ← advanced by git + post-commit hook
 * //   refs/heads/story/checkpoints/v1    ← advanced by post-commit hook
 * //   ~/.vogon/sessions/<uuid>.jsonl     ← transcript appended
 * //   .story/logs/story.log              ← hook invocations recorded
 * // Unchanged: nothing outside dir + transcript dir.
 */
export async function runVogon(
	dir: string,
	prompt: string,
	opts?: RunVogonOptions,
): Promise<VogonRunResult> {
	const bin = getVogonBin();
	const args = ['-p', prompt];
	const command = `${bin} -p ${JSON.stringify(prompt)}`;
	try {
		const res = await execa(bin, args, {
			cwd: dir,
			env: { ...isolatedSpawnEnv(), ...(opts?.env ?? {}) },
			timeout: opts?.timeoutMs ?? promptTimeoutMs(),
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		return {
			command,
			stdout: res.stdout?.toString() ?? '',
			stderr: res.stderr?.toString() ?? '',
			exitCode: res.exitCode ?? 0,
		};
	} catch (e) {
		// execa throws on non-zero exit — capture as normal result.
		const err = e as ExecaError;
		return {
			command,
			stdout: err.stdout?.toString() ?? '',
			stderr: err.stderr?.toString() ?? '',
			exitCode: err.exitCode ?? -1,
		};
	}
}

/**
 * Run Vogon in **interactive stdin mode**: launch the binary with no
 * `-p` flag (so it enters the `readline`-driven multi-turn loop in
 * `src/bin/vogon.ts::runVogon`), then pipe each prompt followed by a
 * newline into stdin and finally `exit\n` to close the loop cleanly.
 *
 * Mirrors Go `agents.Vogon.StartSession` / `Session.Send` pattern from
 * `entire-cli/e2e/agents/vogon.go:73-88` but without tmux — Vogon's
 * own stdin loop handles line-by-line dispatch. Each prompt triggers a
 * fresh `user-prompt-submit` / `stop` hook pair, keeping session phase
 * in ACTIVE → IDLE per turn.
 *
 * @example
 * await runVogonInteractive(repo.dir, [
 *   'create a markdown file at docs/red.md',
 *   'now commit it',
 * ]);
 * // Side effects: same as runVogon x2 (2 turn-end hooks fire).
 */
export async function runVogonInteractive(
	dir: string,
	prompts: readonly string[],
	opts?: RunVogonOptions,
): Promise<VogonRunResult> {
	const bin = getVogonBin();
	// Vogon's interactive loop exits on `exit` / `quit` / empty line.
	const stdinPayload = `${prompts.join('\n')}\nexit\n`;
	const command = `${bin} (interactive, ${prompts.length} prompts)`;
	try {
		const res = await execa(bin, [], {
			cwd: dir,
			env: { ...isolatedSpawnEnv(), ...(opts?.env ?? {}) },
			// Interactive mode does multiple hook firings + 700ms sleeps
			// per turn — be generous with timeout (3x per-prompt budget).
			timeout: opts?.timeoutMs ?? promptTimeoutMs() * prompts.length,
			input: stdinPayload,
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		return {
			command,
			stdout: res.stdout?.toString() ?? '',
			stderr: res.stderr?.toString() ?? '',
			exitCode: res.exitCode ?? 0,
		};
	} catch (e) {
		const err = e as ExecaError;
		return {
			command,
			stdout: err.stdout?.toString() ?? '',
			stderr: err.stderr?.toString() ?? '',
			exitCode: err.exitCode ?? -1,
		};
	}
}
