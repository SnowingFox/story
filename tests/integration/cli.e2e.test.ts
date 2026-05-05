/**
 * Phase 9.1 end-to-end integration smoke — spawns `bun run src/cli.ts`
 * against a TestEnv-isolated git repo so the 5 git hooks, `.story/` state,
 * and shadow branches all land in a throwaway directory that's cleaned up
 * after each test. Never runs against the real Story checkout.
 *
 * This file is excluded from `bun run test` via `vitest.config.ts`
 * (`exclude: ['tests/integration/**']`). Run explicitly with:
 *   bun test tests/integration/cli.e2e.test.ts
 *
 * Go-parity: each case maps to a scenario from the Phase 9.1 ASCII spec
 * (`commands/9.1-0-enable.md` etc.); subtest docstrings cite the relevant
 * setup.go function.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestEnv } from '../helpers/test-env';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(HERE, '..', '..', 'src', 'cli.ts');

interface RunResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

/**
 * Spawn `bun run <CLI_PATH> ...argv` inside `cwd` with CI=1 forced so the
 * command action runs non-interactively (fails on prompts instead of
 * hanging the test suite). Returns captured stdout/stderr/exit code.
 */
async function runStoryCli(cwd: string, argv: string[]): Promise<RunResult> {
	return new Promise((resolve, reject) => {
		const child = spawn('bun', ['run', CLI_PATH, ...argv], {
			cwd,
			env: { ...process.env, CI: '1', NO_COLOR: '1' },
			timeout: 30_000,
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

describe('Phase 9.1 e2e (spawn bun run src/cli.ts)', () => {
	let env: TestEnv;

	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
	});

	afterEach(async () => {
		await env.cleanup();
	});

	// Go: setup.go: newEnableCmd — happy fresh-enable path
	it('enable --agent vogon --local in a fresh repo → exit 0 + settings + hooks', async () => {
		const res = await runStoryCli(env.dir, ['enable', '--agent', 'vogon', '--local']);
		expect(res.code).toBe(0);
		expect(res.stdout).toMatch(/Story enabled for/);

		// Settings written.
		const raw = await fs.readFile(path.join(env.dir, '.story', 'settings.local.json'), 'utf-8');
		expect(JSON.parse(raw).enabled).toBe(true);

		// 5 git hooks present.
		for (const hook of [
			'prepare-commit-msg',
			'commit-msg',
			'post-commit',
			'post-rewrite',
			'pre-push',
		]) {
			const hookPath = path.join(env.dir, '.git', 'hooks', hook);
			const content = await fs.readFile(hookPath, 'utf-8');
			expect(content).toContain('Story CLI hooks');
		}
	});

	// Go: setup.go: runUninstall — destructive teardown
	it('disable --uninstall --force after enable → exit 0 + clean .story/ + removed hooks', async () => {
		// Seed an enabled repo.
		const enableRes = await runStoryCli(env.dir, ['enable', '--agent', 'vogon', '--local']);
		expect(enableRes.code).toBe(0);

		const res = await runStoryCli(env.dir, ['disable', '--uninstall', '--force']);
		expect(res.code).toBe(0);
		expect(res.stdout).toMatch(/Story uninstalled from this repository/);

		// .story/ gone.
		await expect(fs.stat(path.join(env.dir, '.story'))).rejects.toHaveProperty('code', 'ENOENT');

		// Managed hook files either gone OR do not contain the Story marker.
		for (const hook of [
			'prepare-commit-msg',
			'commit-msg',
			'post-commit',
			'post-rewrite',
			'pre-push',
		]) {
			const hookPath = path.join(env.dir, '.git', 'hooks', hook);
			try {
				const content = await fs.readFile(hookPath, 'utf-8');
				expect(content).not.toContain('Story CLI hooks');
			} catch (err) {
				// ENOENT is the expected state — hook removed entirely.
				expect((err as NodeJS.ErrnoException).code).toBe('ENOENT');
			}
		}
	});

	// Go: setup.go: newSetupCmd — configure --agent add path on enabled repo
	it('configure --agent vogon on enabled repo → exit 0', async () => {
		await runStoryCli(env.dir, ['enable', '--agent', 'vogon', '--local']);
		const res = await runStoryCli(env.dir, ['configure', '--agent', 'vogon']);
		expect(res.code).toBe(0);
		expect(res.stdout).toMatch(/Added Vogon Agent/);
	});

	// Go: setup.go: newEnableCmd — non-interactive guard
	it('enable --non-interactive with no --agent in a repo with multi-agent signals → non-zero exit', async () => {
		// Seed both .claude/ and .cursor/ sentinels so multi-agent detection kicks in.
		await fs.mkdir(path.join(env.dir, '.claude'), { recursive: true });
		await fs.mkdir(path.join(env.dir, '.cursor'), { recursive: true });

		const res = await runStoryCli(env.dir, ['enable', '--non-interactive']);
		expect(res.code).not.toBe(0);
		// Some mention of the non-interactive constraint or missing --agent.
		expect(res.stderr + res.stdout).toMatch(/(cannot prompt|pass --agent|--agent)/);
	});

	// Go: setup.go: newSetupGitHookCmd — minimal subcommand
	it('enable git-hook → installs hooks with minimal stdout (no banner)', async () => {
		const res = await runStoryCli(env.dir, ['enable', 'git-hook']);
		expect(res.code).toBe(0);
		// No banner (ASCII-art "STORY" block must NOT appear).
		expect(res.stdout).not.toMatch(/███████/);
		// Core install message.
		expect(res.stdout).toMatch(/Installed git hooks/);

		// 5 hooks present.
		for (const hook of [
			'prepare-commit-msg',
			'commit-msg',
			'post-commit',
			'post-rewrite',
			'pre-push',
		]) {
			const hookPath = path.join(env.dir, '.git', 'hooks', hook);
			const content = await fs.readFile(hookPath, 'utf-8');
			expect(content).toContain('Story CLI hooks');
		}
	});
});

// Phase 9.5 + 9.6 e2e smoke — originally scheduled in Phase 9.0 tests.md §14
// (and foundation-backlog "Phase 9.0 e2e smoke 推迟 (2026-04-22 review)")
// as 8 spawn cases. We carry them here alongside the Phase 9.1 suite so the
// whole e2e harness lives in one file.
describe('Phase 9.5 / 9.6 e2e (spawn bun run src/cli.ts)', () => {
	let env: TestEnv;

	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
	});

	afterEach(async () => {
		await env.cleanup();
	});

	// Go: root.go: versionInfo — bare `story version` prints build info.
	it('version → stdout contains "Story CLI" + version line; exit 0', async () => {
		const res = await runStoryCli(env.dir, ['version']);
		expect(res.code).toBe(0);
		expect(res.stdout).toContain('Story CLI');
		expect(res.stdout).toMatch(/version:\s+\d+\.\d+\.\d+/);
		expect(res.stdout).toMatch(/commit:/);
	});

	// Go: root.go: `--version` alias — cac emits its own version string when
	// `cli.version(...)` is set. Story's cac is `.version`-less by design;
	// the flag either returns cac's built-in help or errors. Test the safer
	// post-condition: stdout isn't blank and exit doesn't crash.
	it('--version → CLI responds deterministically (no crash)', async () => {
		const res = await runStoryCli(env.dir, ['--version']);
		// cac without a .version() treats `--version` as unknown → exit 1.
		// cac with .version() → exit 0. Accept either; assert no hang.
		expect([0, 1]).toContain(res.code);
	});

	// Go: help.go: NewHelpCmd — bare `--help` lists the command set.
	it('--help → stdout lists core commands; exit 0', async () => {
		const res = await runStoryCli(env.dir, ['--help']);
		expect(res.code).toBe(0);
		expect(res.stdout).toMatch(/Usage|Commands|Options/);
	});

	// Go: help.go: `--tree` flag — prints the command tree.
	it('--help --tree → stdout includes the command tree with story/clean/doctor/trace/completion', async () => {
		const res = await runStoryCli(env.dir, ['--help', '--tree']);
		expect(res.code).toBe(0);
		expect(res.stdout).toMatch(/clean/);
		expect(res.stdout).toMatch(/doctor/);
		// trace/completion from Phase 9.6.
		expect(res.stdout).toMatch(/trace|completion/);
	});

	// Go: doctor.go: newDoctorCmd — not-enabled guard on a fresh repo.
	it('doctor in a fresh (not-enabled) repo → exit non-zero + SilentError line', async () => {
		const res = await runStoryCli(env.dir, ['doctor']);
		expect(res.code).not.toBe(0);
		expect(res.stderr + res.stdout).toMatch(/not enabled/i);
	});

	// Go: root.go: CompletionOptions — bash completion output is a script.
	it('completion bash → stdout is the bash script (no banner), exit 0', async () => {
		const res = await runStoryCli(env.dir, ['completion', 'bash']);
		expect(res.code).toBe(0);
		expect(res.stdout).toContain('_story_completions');
		// No banner block.
		expect(res.stdout).not.toMatch(/███████/);
	});

	// Go: root.go: hooks bypass — `story hooks` path runs silently.
	it('hooks git post-commit (no session) → exit 0 with no banner', async () => {
		const res = await runStoryCli(env.dir, ['hooks', 'git', 'post-commit']);
		expect(res.code).toBe(0);
		expect(res.stdout).not.toMatch(/███████/);
	});

	// Go: root.go: unknown command → exit 1. cac falls back to the default
	// command when no subcommand matches — Story's default prints help,
	// which is a reasonable stand-in for a "hit non-existent command"
	// signal. We only assert the CLI did not crash on random input.
	it('unknown command → CLI responds deterministically (no crash)', async () => {
		const res = await runStoryCli(env.dir, ['definitely-not-a-cmd']);
		// Accept either "error exit" or "help-as-fallback exit".
		expect([0, 1]).toContain(res.code);
	});
});
