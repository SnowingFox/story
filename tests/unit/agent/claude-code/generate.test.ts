/**
 * Tests for `src/agent/claude-code/generate.ts` — Mirrors Go
 * `entire-cli/cmd/entire/cli/agent/claudecode/claude_test.go: TestGenerateText_ArrayResponse`
 * (1 happy case) + Story 5 fault-injection cases for `generate.go: GenerateText`
 * error classification.
 */

import os from 'node:os';
import { EventEmitter, Readable, Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import {
	type CommandRunner,
	generateText,
	type SpawnedProcess,
	setCommandRunnerForTesting,
	stripGitEnv,
} from '@/agent/claude-code/generate';

/** Build a fake child process that emits given stdout and exit behavior. */
function fakeChild(opts: {
	stdoutText?: string;
	stderrText?: string;
	exitCode?: number | null;
	emitError?: NodeJS.ErrnoException;
	deferClose?: boolean;
}): SpawnedProcess {
	const stdout = Readable.from(opts.stdoutText !== undefined ? [opts.stdoutText] : []);
	const stderr = Readable.from(opts.stderrText !== undefined ? [opts.stderrText] : []);
	const stdinChunks: Buffer[] = [];
	const stdin = new Writable({
		write(chunk, _enc, cb) {
			stdinChunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
			cb();
		},
	});
	const events = new EventEmitter();
	const proc = {
		stdin,
		stdout,
		stderr,
		on(this: SpawnedProcess, ev: string, cb: (...args: unknown[]) => void): SpawnedProcess {
			events.on(ev, cb);
			return this;
		},
	} as unknown as SpawnedProcess & { _stdinChunks: Buffer[] };
	proc._stdinChunks = stdinChunks;

	if (opts.emitError !== undefined) {
		setImmediate(() => events.emit('error', opts.emitError));
	} else if (!opts.deferClose) {
		setImmediate(() => events.emit('close', opts.exitCode ?? 0, null));
	}
	return proc;
}

describe('agent/claude-code/generate — Go: generate.go + claude_test.go', () => {
	afterEach(() => {
		// testing-discipline §2 #6: reset injected runner to avoid leakage.
		setCommandRunnerForTesting(null);
	});

	// Go: claude_test.go:28-44 (TestGenerateText_ArrayResponse) — happy path,
	// Story expands by also asserting args / cwd / env / default model.
	it('with array response returns final result text + uses default model haiku', async () => {
		const arrayResponse = JSON.stringify([
			{ type: 'system', subtype: 'init' },
			{ type: 'assistant', message: 'Working on it' },
			{ type: 'result', result: 'final generated text' },
		]);
		let capturedCmd = '';
		let capturedArgs: string[] = [];
		let capturedCwd = '';
		let capturedEnv: NodeJS.ProcessEnv = {};
		const runner: CommandRunner = (cmd, args, opts) => {
			capturedCmd = cmd;
			capturedArgs = args;
			capturedCwd = opts.cwd;
			capturedEnv = opts.env;
			return fakeChild({ stdoutText: arrayResponse, exitCode: 0 });
		};
		setCommandRunnerForTesting(runner);

		// Pollute env with GIT_* vars to verify they get stripped.
		const restore = process.env.GIT_AUTHOR_NAME;
		process.env.GIT_AUTHOR_NAME = 'should be stripped';
		try {
			const result = await generateText('do thing', '');
			expect(result).toBe('final generated text');
			expect(capturedCmd).toBe('claude');
			// Go: generate.go:28-30 — exact arg order.
			expect(capturedArgs).toEqual([
				'--print',
				'--output-format',
				'json',
				'--model',
				'haiku', // Go: generate.go:19-21 — default model
				'--setting-sources',
				'',
			]);
			// Go: generate.go:34 — cwd is os.TempDir().
			expect(capturedCwd).toBe(os.tmpdir());
			// Go: generate.go:35 — stripGitEnv applied.
			for (const k of Object.keys(capturedEnv)) {
				expect(k.startsWith('GIT_')).toBe(false);
			}
		} finally {
			if (restore === undefined) {
				delete process.env.GIT_AUTHOR_NAME;
			} else {
				process.env.GIT_AUTHOR_NAME = restore;
			}
		}
	});

	// Go: generate.go:71-78 — stripGitEnv standalone.
	it('stripGitEnv removes all GIT_* keys, preserves others', () => {
		const out = stripGitEnv({
			GIT_DIR: '/x',
			GIT_AUTHOR_NAME: 'a',
			GIT_FOOBAR: 'q',
			PATH: '/p',
			HOME: '/h',
			LANG: 'C',
		});
		expect(out).toEqual({ PATH: '/p', HOME: '/h', LANG: 'C' });
	});

	// Go: generate.go:49-52 — `var execErr *exec.Error; if errors.As(err, &execErr)`
	// → "claude CLI not found: ...". TS analog: spawn emits 'error' with code ENOENT.
	it('throws "claude CLI not found" when spawn emits ENOENT', async () => {
		setCommandRunnerForTesting(() => {
			const err: NodeJS.ErrnoException = Object.assign(new Error('spawn claude ENOENT'), {
				code: 'ENOENT',
			});
			return fakeChild({ emitError: err });
		});
		await expect(generateText('hi', '')).rejects.toThrow(/claude CLI not found/);
	});

	// Go: generate.go:53-56 — `var exitErr *exec.ExitError`
	// → "claude CLI failed (exit %d): %s". TS: exit code != 0.
	it('throws "claude CLI failed (exit N): <stderr>" on non-zero exit', async () => {
		setCommandRunnerForTesting(() =>
			fakeChild({ stdoutText: '', stderrText: 'auth failed', exitCode: 1 }),
		);
		await expect(generateText('hi', '')).rejects.toThrow(
			/claude CLI failed \(exit 1\): auth failed/,
		);
	});

	// Go: generate.go:43-48 — `errors.Is(ctx.Err(), DeadlineExceeded / Canceled)` propagates.
	// TS analog: AbortSignal aborted before/during call → throw.
	it('respects AbortSignal — pre-aborted signal throws immediately without spawning', async () => {
		let spawned = false;
		setCommandRunnerForTesting(() => {
			spawned = true;
			return fakeChild({ deferClose: true });
		});
		const ac = new AbortController();
		ac.abort(new Error('user aborted'));
		await expect(generateText('hi', '', ac.signal)).rejects.toThrow(/user aborted/);
		expect(spawned).toBe(false);
	});

	// Story 补充 (TS 特性): post-exit signal recheck — when child closes after
	// the signal aborts, the post-await `signal.aborted` check throws (Go
	// equivalent: `if errors.Is(ctx.Err(), Canceled)` after cmd.Run).
	it('respects AbortSignal — abort after spawn (close fired) throws abort reason', async () => {
		const ac = new AbortController();
		// Build a runner whose child closes successfully but only AFTER the
		// signal aborts. We inject the abort right after the runner is invoked.
		setCommandRunnerForTesting(() => {
			ac.abort(new Error('cancelled mid-flight'));
			return fakeChild({ stdoutText: '{"result":"ok"}', exitCode: 0 });
		});
		await expect(generateText('hi', '', ac.signal)).rejects.toThrow(/cancelled mid-flight/);
	});

	// Go: generate.go:60-63 — `parseGenerateTextResponse` failure wraps as
	// "failed to parse claude CLI response: %w".
	it('throws "failed to parse claude CLI response" on garbage stdout', async () => {
		setCommandRunnerForTesting(() => fakeChild({ stdoutText: 'garbage', exitCode: 0 }));
		await expect(generateText('hi', '')).rejects.toThrow(/failed to parse claude CLI response/);
	});

	// Story 补充：custom model passed through.
	it('uses caller-supplied model when non-empty', async () => {
		let captured: string[] = [];
		setCommandRunnerForTesting((_cmd, args) => {
			captured = args;
			return fakeChild({ stdoutText: '{"result":"ok"}', exitCode: 0 });
		});
		await generateText('hi', 'sonnet');
		const idx = captured.indexOf('--model');
		expect(idx).toBeGreaterThanOrEqual(0);
		expect(captured[idx + 1]).toBe('sonnet');
	});

	// Story 补充：stdin receives the prompt.
	it('writes prompt to child stdin', async () => {
		let captured: { _stdinChunks?: Buffer[] } = {};
		setCommandRunnerForTesting(() => {
			const proc = fakeChild({ stdoutText: '{"result":"ok"}', exitCode: 0 });
			captured = proc as unknown as { _stdinChunks: Buffer[] };
			return proc;
		});
		await generateText('the prompt', '');
		const buf = Buffer.concat(captured._stdinChunks ?? []);
		expect(buf.toString('utf8')).toBe('the prompt');
	});

	// Story 补充：non-ENOENT spawn error → "failed to run claude CLI".
	it('non-ENOENT spawn error → "failed to run claude CLI"', async () => {
		setCommandRunnerForTesting(() => {
			const err: NodeJS.ErrnoException = Object.assign(new Error('permission denied'), {
				code: 'EACCES',
			});
			return fakeChild({ emitError: err });
		});
		await expect(generateText('hi', '')).rejects.toThrow(/failed to run claude CLI/);
	});

	// Story 覆盖率补盲：exercise the default `node:child_process.spawn` runner
	// (no injected stub) — invoking against a non-existent binary triggers
	// ENOENT, exercising the defaultRunner lambda + the not-found error path.
	it('default runner uses node:child_process.spawn and surfaces ENOENT', async () => {
		setCommandRunnerForTesting(null); // reset to default
		// Override the binary path indirectly: the function always spawns 'claude'
		// — if that's not on PATH in the test env, ENOENT fires; if it IS on PATH,
		// we'll get a different result. The CI env doesn't have `claude` in PATH,
		// so this expects `claude CLI not found`.
		const tempPath = process.env.PATH;
		process.env.PATH = '/nonexistent-dir-for-test';
		try {
			await expect(generateText('hi', '')).rejects.toThrow(/claude CLI not found/);
		} finally {
			process.env.PATH = tempPath;
		}
	});
});
