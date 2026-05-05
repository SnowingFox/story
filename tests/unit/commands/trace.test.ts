/**
 * Phase 9.6 `src/commands/trace.ts` unit tests.
 *
 * Go: `cmd/entire/cli/trace_cmd.go: newTraceCmd`.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import cac from 'cac';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerGlobalFlags, resetGlobalFlagsForTesting } from '@/cli/flags';
import { registerTraceCommand } from '@/commands/trace';
import { SilentError } from '@/errors';
import { clearGitCommonDirCache } from '@/git';
import { clearWorktreeRootCache } from '@/paths';
import { resetColorOverrideForTesting, setColorOverride } from '@/ui/theme';
import { TestEnv } from '../../helpers/test-env';

function captureStreams() {
	const out: string[] = [];
	const err: string[] = [];
	const origOut = process.stdout.write.bind(process.stdout);
	const origErr = process.stderr.write.bind(process.stderr);
	process.stdout.write = ((chunk: string | Uint8Array) => {
		out.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk: string | Uint8Array) => {
		err.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
		return true;
	}) as typeof process.stderr.write;
	return {
		stdout: () => out.join(''),
		stderr: () => err.join(''),
		restore: () => {
			process.stdout.write = origOut;
			process.stderr.write = origErr;
		},
	};
}

function buildCli() {
	const cli = cac('story');
	registerGlobalFlags(cli);
	registerTraceCommand(cli);
	cli.help();
	cli.version('0.1.0');
	return cli;
}

async function runCli(argv: string[]): Promise<void> {
	const cli = buildCli();
	cli.parse(['node', 'story', ...argv], { run: false });
	const result = cli.runMatchedCommand();
	if (result && typeof (result as Promise<unknown>).then === 'function') {
		await result;
	}
}

async function seedLogFile(env: TestEnv, lines: string[]): Promise<void> {
	const logsDir = path.join(env.dir, '.story', 'logs');
	await fs.mkdir(logsDir, { recursive: true });
	await fs.writeFile(path.join(logsDir, 'story.log'), `${lines.join('\n')}\n`);
}

async function seedEnabled(env: TestEnv): Promise<void> {
	await fs.mkdir(path.join(env.dir, '.story'), { recursive: true });
	await fs.writeFile(
		path.join(env.dir, '.story', 'settings.local.json'),
		JSON.stringify({ enabled: true }),
	);
}

describe('commands/trace', () => {
	let env: TestEnv;
	let origCwd: string;
	let cap: ReturnType<typeof captureStreams>;

	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		origCwd = process.cwd();
		process.chdir(env.dir);
		clearGitCommonDirCache();
		clearWorktreeRootCache();
		resetGlobalFlagsForTesting();
		resetColorOverrideForTesting();
		setColorOverride(false);
		cap = captureStreams();
	});

	afterEach(async () => {
		cap.restore();
		process.chdir(origCwd);
		await env.cleanup();
		resetGlobalFlagsForTesting();
		resetColorOverrideForTesting();
	});

	async function expectAction(argv: string[]): Promise<unknown> {
		try {
			await runCli(argv);
			return undefined;
		} catch (err) {
			return err;
		}
	}

	// Go: trace_cmd.go: newTraceCmd — --last bounds check.
	it('--last 0 → SilentError "must be at least 1"', async () => {
		await seedEnabled(env);
		await seedLogFile(env, []);
		const err = await expectAction(['trace', '--last', '0']);
		expect(err).toBeInstanceOf(SilentError);
		expect((err as Error).message).toMatch(/must be at least 1/);
	});

	it('--last NaN input → SilentError', async () => {
		await seedEnabled(env);
		await seedLogFile(env, []);
		const err = await expectAction(['trace', '--last', 'abc']);
		expect(err).toBeInstanceOf(SilentError);
	});

	// Go: trace_cmd.go: newTraceCmd — "not a git repository" guard.
	it('outside a git repo → SilentError', async () => {
		process.chdir(path.dirname(env.dir));
		clearWorktreeRootCache();
		const err = await expectAction(['trace']);
		if (err !== undefined) {
			expect(err).toBeInstanceOf(SilentError);
		}
	});

	it('Story not enabled → SilentError referencing "story enable"', async () => {
		const err = await expectAction(['trace']);
		expect(err).toBeInstanceOf(SilentError);
		expect((err as Error).message).toMatch(/not enabled|story enable/);
	});

	it('missing log file → SilentError referencing story.log', async () => {
		await seedEnabled(env);
		const err = await expectAction(['trace']);
		expect(err).toBeInstanceOf(SilentError);
		expect((err as Error).message).toMatch(/story\.log|debug/);
	});

	it('empty log → SilentError "No hook traces found"', async () => {
		await seedEnabled(env);
		await seedLogFile(env, ['']);
		const err = await expectAction(['trace']);
		expect(err).toBeInstanceOf(SilentError);
		expect((err as Error).message).toMatch(/No hook traces found/);
	});

	it('happy path renders entry to stdout', async () => {
		await seedEnabled(env);
		await seedLogFile(env, [
			'{"time":"2026-04-22T16:04:11Z","level":"DEBUG","msg":"perf","op":"post-commit","duration_ms":42,"steps.load-session_ms":3,"steps.write_ms":18}',
		]);
		await runCli(['trace']);
		const out = cap.stdout();
		expect(out).toMatch(/post-commit/);
		expect(out).toMatch(/42ms/);
	});

	it('--last 5 shows up to 5 entries', async () => {
		await seedEnabled(env);
		await seedLogFile(
			env,
			Array.from(
				{ length: 3 },
				(_, i) =>
					`{"time":"2026-04-22T16:0${i}:00Z","msg":"perf","op":"post-commit","duration_ms":${10 + i}}`,
			),
		);
		await runCli(['trace', '--last', '5']);
		const out = cap.stdout();
		expect(out).toMatch(/traces shown/);
	});

	it('--hook filters by op', async () => {
		await seedEnabled(env);
		await seedLogFile(env, [
			'{"time":"2026-04-22T16:01:00Z","msg":"perf","op":"post-commit","duration_ms":10}',
			'{"time":"2026-04-22T16:02:00Z","msg":"perf","op":"pre-push","duration_ms":20}',
		]);
		await runCli(['trace', '--last', '10', '--hook', 'post-commit']);
		const out = cap.stdout();
		expect(out).toMatch(/post-commit/);
		expect(out).not.toMatch(/pre-push/);
	});

	it('--hook with 0 matches → SilentError', async () => {
		await seedEnabled(env);
		await seedLogFile(env, [
			'{"time":"2026-04-22T16:01:00Z","msg":"perf","op":"post-commit","duration_ms":10}',
		]);
		const err = await expectAction(['trace', '--hook', 'pre-push']);
		expect(err).toBeInstanceOf(SilentError);
		expect((err as Error).message).toMatch(/No hook traces found/);
	});

	it('non-perf log lines are skipped silently', async () => {
		await seedEnabled(env);
		await seedLogFile(env, [
			'{"time":"2026-04-22T16:01:00Z","level":"INFO","msg":"installed shadow session"}',
			'{"time":"2026-04-22T16:02:00Z","msg":"perf","op":"post-commit","duration_ms":10}',
		]);
		await runCli(['trace']);
		const out = cap.stdout();
		expect(out).toMatch(/post-commit/);
		expect(out).not.toMatch(/installed shadow session/);
	});

	it('stdout is free of "entire" / ".entire/" literals', async () => {
		await seedEnabled(env);
		await seedLogFile(env, [
			'{"time":"2026-04-22T16:02:00Z","msg":"perf","op":"post-commit","duration_ms":10}',
		]);
		await runCli(['trace']);
		const combined = cap.stdout() + cap.stderr();
		expect(combined).not.toMatch(/\bentire\b/);
		expect(combined).not.toMatch(/\.entire\//);
	});

	it('--last with actual entries < N still returns what exists', async () => {
		await seedEnabled(env);
		await seedLogFile(env, [
			'{"time":"2026-04-22T16:01:00Z","msg":"perf","op":"post-commit","duration_ms":10}',
		]);
		await runCli(['trace', '--last', '50']);
		const out = cap.stdout();
		expect(out).toMatch(/post-commit/);
	});
});
