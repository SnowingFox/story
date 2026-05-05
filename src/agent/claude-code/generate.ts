/**
 * Non-interactive text generation via `claude --print` CLI.
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/agent/claudecode/generate.go`.
 *
 * Implements `TextGenerator.generateText` for the Claude Code agent. Spawns
 * the `claude` binary with stdout / stderr capture; parses JSON output via
 * {@link parseGenerateTextResponse}.
 *
 * Key behaviors (preserved from Go):
 * - Default model `'haiku'` when caller passes `''`
 * - cwd = `os.tmpdir()` (NOT the repo) so Claude doesn't pick up `.claude/`
 *   config or trigger recursive hooks
 * - env strips all `GIT_*` vars (so the claude subprocess doesn't see git
 *   overrides like `GIT_DIR` / `GIT_AUTHOR_*`)
 * - args include `--setting-sources ""` (empty string arg) to disable
 *   settings layering — must NOT be omitted
 * - Error classification: notFound → 'claude CLI not found'; non-zero exit →
 *   'claude CLI failed (exit N): <stderr>'; abort signal → propagate as
 *   `AbortError` (TS analog of Go ctx.Cancel / DeadlineExceeded); parse →
 *   'failed to parse claude CLI response: <inner>'
 *
 * @packageDocumentation
 */

import { spawn } from 'node:child_process';
import os from 'node:os';
import { parseGenerateTextResponse } from './response';

/**
 * Test seam: replace the spawn function for stubbing in unit tests.
 * Mirrors Go `(*ClaudeCodeAgent).CommandRunner` field.
 */
export type CommandRunner = (
	command: string,
	args: string[],
	options: { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal },
) => SpawnedProcess;

/** Minimal subset of Node `ChildProcess` used by {@link generateText}. */
export interface SpawnedProcess {
	stdin: NodeJS.WritableStream | null;
	stdout: NodeJS.ReadableStream | null;
	stderr: NodeJS.ReadableStream | null;
	on(event: 'error', cb: (err: NodeJS.ErrnoException) => void): SpawnedProcess;
	on(
		event: 'close',
		cb: (code: number | null, signal: NodeJS.Signals | null) => void,
	): SpawnedProcess;
}

const defaultRunner: CommandRunner = (command, args, options) =>
	spawn(command, args, {
		...options,
		stdio: ['pipe', 'pipe', 'pipe'],
	}) as unknown as SpawnedProcess;

let activeRunner: CommandRunner = defaultRunner;

/**
 * Inject a custom {@link CommandRunner} for tests. Call with `null` to reset
 * to the default `node:child_process.spawn` runner.
 *
 * **Lifecycle discipline**: tests MUST reset to `null` in `afterEach`
 * (testing-discipline §2 #6: "测试 lock 违规" — leftover stubs leak across
 * tests).
 *
 * @example
 * setCommandRunnerForTesting((cmd, args, opts) => fakeProcess);
 * // ... test body ...
 * setCommandRunnerForTesting(null);  // restore in afterEach
 */
export function setCommandRunnerForTesting(runner: CommandRunner | null): void {
	activeRunner = runner ?? defaultRunner;
}

/**
 * Generate text by invoking `claude --print --output-format json --model <m> --setting-sources ""`.
 *
 * @example
 * await generateText('write a haiku', '');
 * // → '<the haiku>'   (default model 'haiku' when empty)
 *
 * await generateText('summarize', 'sonnet', new AbortController().signal);
 * // → '<summary>'
 *
 * // Side effects:
 * //   - spawns child process `claude` in `os.tmpdir()` with GIT_* env stripped
 * //   - reads child stdout (JSON), child stderr (for error messages)
 * //   - no fs / git mutation
 * //
 * // Failure modes (throw):
 * //   - claude binary not found → Error('claude CLI not found: ENOENT ...')
 * //   - signal aborted before completion → propagated AbortError
 * //   - non-zero exit → Error('claude CLI failed (exit N): <stderr>')
 * //   - parse failure → Error('failed to parse claude CLI response: <inner>')
 */
export async function generateText(
	prompt: string,
	model: string,
	signal?: AbortSignal,
): Promise<string> {
	if (signal?.aborted) {
		const reason = signal.reason ?? new Error('aborted');
		throw reason instanceof Error ? reason : new Error(String(reason));
	}
	const m = model === '' ? 'haiku' : model;
	const args = ['--print', '--output-format', 'json', '--model', m, '--setting-sources', ''];
	const env = stripGitEnv(process.env);
	const child = activeRunner('claude', args, { cwd: os.tmpdir(), env, signal });

	const stdoutChunks: Buffer[] = [];
	const stderrChunks: Buffer[] = [];

	child.stdout?.on('data', (chunk: Buffer | string) => {
		stdoutChunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
	});
	child.stderr?.on('data', (chunk: Buffer | string) => {
		stderrChunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
	});

	if (child.stdin !== null) {
		child.stdin.write(prompt);
		child.stdin.end();
	}

	let spawnError: NodeJS.ErrnoException | null = null;
	const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
		(resolve) => {
			let resolved = false;
			child.on('error', (err) => {
				spawnError = err;
				if (!resolved) {
					resolved = true;
					resolve({ code: null, signal: null });
				}
			});
			child.on('close', (code, sig) => {
				if (!resolved) {
					resolved = true;
					resolve({ code, signal: sig });
				}
			});
		},
	);

	if (signal?.aborted) {
		const reason = signal.reason ?? new Error('aborted');
		throw reason instanceof Error ? reason : new Error(String(reason));
	}

	if (spawnError !== null) {
		const err = spawnError as NodeJS.ErrnoException;
		if (err.code === 'ENOENT') {
			throw new Error(`claude CLI not found: ${err.message}`, { cause: err });
		}
		throw new Error(`failed to run claude CLI: ${err.message}`, { cause: err });
	}

	if (exit.code !== 0) {
		const stderrText = Buffer.concat(stderrChunks).toString('utf8');
		throw new Error(`claude CLI failed (exit ${exit.code ?? 'null'}): ${stderrText}`);
	}

	const stdoutText = Buffer.concat(stdoutChunks).toString('utf8');
	try {
		return parseGenerateTextResponse(stdoutText);
	} catch (err) {
		throw new Error(`failed to parse claude CLI response: ${(err as Error).message}`, {
			cause: err as Error,
		});
	}
}

/**
 * Strip all `GIT_*` env vars from a copy of the env. Mirrors Go `stripGitEnv`.
 *
 * Keeps env vars that don't start with `GIT_`. Used for the `claude` subprocess
 * so git overrides (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_AUTHOR_*`, etc.) don't
 * leak into Claude's own subprocess management.
 *
 * @example
 * stripGitEnv({ GIT_DIR: '/x', GIT_AUTHOR_NAME: 'a', PATH: '/p', HOME: '/h' });
 * // → { PATH: '/p', HOME: '/h' }
 */
export function stripGitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = {};
	for (const [k, v] of Object.entries(env)) {
		if (!k.startsWith('GIT_')) {
			out[k] = v;
		}
	}
	return out;
}
