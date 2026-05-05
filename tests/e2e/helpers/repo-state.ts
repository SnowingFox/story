/**
 * `RepoState` — per-test isolated git repo + Story enabled + Vogon
 * registered.
 *
 * Mirrors Go `entire-cli/e2e/testutil/repo.go` (~720 lines): `RepoState`
 * struct + `SetupRepo` / `RunPrompt` / `Git` / `PatchSettings` /
 * `SetupBareRemote` / `ForEachAgent` / `consoleLog` logging.
 *
 * Story-side naming:
 *  - Writes `.story/settings.local.json` (NOT `.story/settings.json`) per
 *    Phase 9.1 enable convention
 *  - Reads `refs/heads/story/checkpoints/v1` (NOT `entire/checkpoints/v1`)
 *
 * @packageDocumentation
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { type ExecaError, execa } from 'execa';
import { getArtifactRoot, testArtifactDir } from './artifacts';
import { isolatedSpawnEnv } from './env';
import { runStory, storyEnable } from './story';
import { runVogon as runVogonBin, type VogonRunResult } from './vogon-runner';

/**
 * Per-test state for one e2e scenario. Instances are created by
 * {@link setupRepo} and disposed by {@link teardownRepo}. Carries the
 * temp repo path, initial checkpoint / HEAD refs, artifact dir, and
 * console-log file handle.
 */
export interface RepoState {
	/** Absolute path to the temp repo (symlink-resolved, under `os.tmpdir()`). */
	readonly dir: string;
	/** Absolute path to this test's artifact dir (under the run-wide root). */
	readonly artifactDir: string;
	/** Captured at setupRepo time via `git rev-parse HEAD`. */
	readonly headBefore: string;
	/**
	 * Captured at setupRepo time via `git rev-parse --verify
	 * story/checkpoints/v1`; empty string when the branch doesn't yet
	 * exist (fresh repo after `story enable`).
	 */
	readonly checkpointBefore: string;
	/** Absolute path to the per-test console.log file. */
	readonly consoleLogPath: string;

	/**
	 * Spawn Vogon with `-p <prompt>` inside the repo. Appends the full
	 * command / stdout / stderr to `consoleLogPath`.
	 */
	runPrompt(prompt: string, opts?: { timeoutMs?: number }): Promise<VogonRunResult>;

	/** Run `git <args>`; throws on non-zero exit; logs to consoleLogPath. */
	git(...args: string[]): Promise<void>;

	/** Run `git <args>` and return trimmed stdout; throws on non-zero exit. */
	gitOutput(...args: string[]): Promise<string>;

	/**
	 * Deep-merge `extras` into `.story/settings.local.json` (Phase 9.1
	 * convention). Mirrors Go `testutil.PatchSettings`.
	 */
	patchSettings(extras: Record<string, unknown>): Promise<void>;

	/**
	 * Create a bare git remote in a sibling tmp dir, register as `origin`,
	 * push HEAD. Returns the absolute bare-repo path.
	 */
	setupBareRemote(): Promise<string>;

	/** Close the console log file. Invoked by `teardownRepo`; idempotent. */
	closeConsoleLog(): Promise<void>;
}

/**
 * Create a fresh temp git repo, `git init` + initial empty commit, run
 * `story enable --agent vogon --local`, patch settings with
 * `{ log_level: "debug", commit_linking: "always" }` (Go parity — the
 * `commit_linking: always` setting forces the prepare-commit-msg hook to
 * add the `Story-Checkpoint:` trailer unconditionally, bypassing the
 * TTY / content-detection fast path that interactive tests can't trigger
 * deterministically).
 *
 * Hard guard: throws when `process.cwd() === STORY_REPO_ROOT`, preventing
 * accidental pollution of the development repo's `.git/hooks/*` or
 * `.story/*`.
 *
 * @example
 * const s = await setupRepo('my-test');
 * await s.runPrompt('create a markdown file at docs/red.md');
 * await s.git('add', '.');
 * await s.git('commit', '-m', 'Add red.md');
 * // On test exit (test responsible for calling teardownRepo):
 * //   - STORY_E2E_KEEP_REPOS=1 → repo preserved, symlink in artifactDir
 * //   - otherwise → fs.rm(s.dir, { recursive, force: true })
 */
export async function setupRepo(testName = 'anonymous-test'): Promise<RepoState> {
	// No `assertCwdIsNotStoryRepo()` guard here — E2E always passes an
	// explicit tmpdir to every command / helper, so the dev repo cannot
	// leak regardless of `process.cwd()`. The unit-style guard in
	// `repo-state.test.ts` documents the invariant; at e2e runtime vitest
	// naturally invokes from the repo root.
	const raw = await fs.mkdtemp(path.join(os.tmpdir(), 'story-e2e-repo-'));
	const dir = await fs.realpath(raw);

	const env = isolatedSpawnEnv();

	// git init + deterministic author + empty initial commit
	await execa('git', ['init', dir], { env });
	await execa('git', ['config', 'user.name', 'E2E Test'], { cwd: dir, env });
	await execa('git', ['config', 'user.email', 'e2e@test.local'], { cwd: dir, env });
	await execa('git', ['config', 'core.pager', 'cat'], { cwd: dir, env });
	await execa('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir, env });
	await execa('git', ['commit', '--allow-empty', '-m', 'initial commit'], { cwd: dir, env });

	// Story enable + patchSettings (mirrors Go testutil/repo.go:86-101)
	await storyEnable(dir, 'vogon');

	// Artifact dir eagerly created so console.log streams land on disk
	// incrementally (mirrors Go testutil/repo.go:128-135).
	const artifactDir = path.join(getArtifactRoot(), testArtifactDir(testName));
	await fs.mkdir(artifactDir, { recursive: true, mode: 0o755 });
	const consoleLogPath = path.join(artifactDir, 'console.log');
	const handle = await fs.open(consoleLogPath, 'a', 0o644);

	// Capture initial refs (Go: testutil/repo.go:141-143)
	const headBefore = await gitRevParse(dir, 'HEAD');
	const checkpointBefore = await gitRevParseOrEmpty(dir, 'story/checkpoints/v1');

	const state: RepoState = {
		dir,
		artifactDir,
		headBefore,
		checkpointBefore,
		consoleLogPath,

		async runPrompt(prompt, opts): Promise<VogonRunResult> {
			const res = await runVogonBin(dir, prompt, opts);
			await handle.appendFile(`> ${res.command}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}\n`);
			return res;
		},

		async git(...args: string[]): Promise<void> {
			await handle.appendFile(`> git ${args.join(' ')}\n`);
			try {
				const res = await execa('git', args, { cwd: dir, env: isolatedSpawnEnv() });
				if (res.stdout) {
					await handle.appendFile(`${res.stdout}\n`);
				}
			} catch (e) {
				const err = e as ExecaError;
				await handle.appendFile(`ERROR: ${err.stderr}\n`);
				throw new Error(`git ${args.join(' ')} failed: ${err.stderr}\n${err.stdout}`);
			}
		},

		async gitOutput(...args: string[]): Promise<string> {
			const res = await execa('git', args, {
				cwd: dir,
				env: isolatedSpawnEnv(),
			});
			return (res.stdout?.toString() ?? '').trim();
		},

		async patchSettings(extras: Record<string, unknown>): Promise<void> {
			// Always patches the project-scope `.story/settings.json` — the
			// file the hook path gates on (see `storyEnable` comment).
			const p = path.join(dir, '.story', 'settings.json');
			const raw = await fs.readFile(p, 'utf-8');
			const parsed = JSON.parse(raw) as Record<string, unknown>;
			const merged = { ...parsed, ...extras };
			await fs.writeFile(p, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o644 });
		},

		async setupBareRemote(): Promise<string> {
			const bareRaw = await fs.mkdtemp(path.join(os.tmpdir(), 'story-e2e-bare-'));
			const bareDir = await fs.realpath(bareRaw);
			const bareEnv = isolatedSpawnEnv();
			await execa('git', ['init', '--bare', bareDir], { env: bareEnv });
			await execa('git', ['remote', 'add', 'origin', bareDir], { cwd: dir, env: bareEnv });
			await execa('git', ['push', '-u', 'origin', 'HEAD'], { cwd: dir, env: bareEnv });
			return bareDir;
		},

		async closeConsoleLog(): Promise<void> {
			try {
				await handle.close();
			} catch {
				// Already closed — idempotent.
			}
		},
	};

	// PatchSettings AFTER state is built so if patch fails we still return a
	// usable state for teardown. `absolute_git_hook_path` + `enable git-hook`
	// reinstall shims so hooks invoke `node <dist/cli.js>` — git hooks often
	// run without a shell `PATH` that contains a `story` binary (CI / GUI).
	await state.patchSettings({
		log_level: 'debug',
		commit_linking: 'always',
		absolute_git_hook_path: true,
	});
	const hookRes = await runStory(dir, ['enable', 'git-hook']);
	if (hookRes.exitCode !== 0) {
		throw new Error(
			`story enable git-hook failed (exit ${hookRes.exitCode}): ${hookRes.stderr}\n${hookRes.stdout}`,
		);
	}

	return state;
}

/**
 * Like {@link setupRepo} but **without** the `--allow-empty` initial commit
 * and **without** the `commit_linking: "always"` patch. Used to reproduce
 * user-realistic "fresh repo, I just ran `story enable` before I ever
 * committed" scenarios that the default `setupRepo` helper skips over.
 *
 * Pass `{ commitLinking: 'always' }` to opt into the fast-path (same as the
 * main `setupRepo`); otherwise settings stay at their `story enable` defaults
 * (`commit_linking` unset → `getCommitLinking` returns `'prompt'`).
 *
 * Returned state has `headBefore = ''` (no HEAD yet) and `checkpointBefore =
 * ''`. Callers that need a HEAD must do the initial commit themselves via
 * `s.git('commit', '--allow-empty', ...)` as part of the scenario.
 *
 * @example
 * const s = await setupRepoEmpty('fresh-repo-test');
 * // Side effects:
 * //   <tmp>/.git/                         ← fresh git init, no commits
 * //   <tmp>/.story/settings.json          ← `{ enabled: true, log_level: "debug" }`
 * //   <tmp>/.git/hooks/*                  ← story hooks installed
 * //   <tmp>/.git/refs/heads/story/checkpoints/v1   ← orphan metadata branch
 * // Unchanged: nothing outside <tmp>, no default branch, no HEAD.
 */
export async function setupRepoEmpty(
	testName = 'anonymous-test',
	opts?: { commitLinking?: 'always' | 'prompt' },
): Promise<RepoState> {
	const raw = await fs.mkdtemp(path.join(os.tmpdir(), 'story-e2e-empty-'));
	const dir = await fs.realpath(raw);

	const env = isolatedSpawnEnv();
	await execa('git', ['init', dir], { env });
	await execa('git', ['config', 'user.name', 'E2E Test'], { cwd: dir, env });
	await execa('git', ['config', 'user.email', 'e2e@test.local'], { cwd: dir, env });
	await execa('git', ['config', 'core.pager', 'cat'], { cwd: dir, env });
	await execa('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir, env });
	// NOTE: no `git commit --allow-empty` — empty HEAD is the whole point.

	await storyEnable(dir, 'vogon');

	const artifactDir = path.join(getArtifactRoot(), testArtifactDir(testName));
	await fs.mkdir(artifactDir, { recursive: true, mode: 0o755 });
	const consoleLogPath = path.join(artifactDir, 'console.log');
	const handle = await fs.open(consoleLogPath, 'a', 0o644);

	// headBefore intentionally empty — no HEAD yet. Tests that need one
	// must call `s.git('commit', '--allow-empty', ...)` themselves.
	const headBefore = '';
	const checkpointBefore = await gitRevParseOrEmpty(dir, 'story/checkpoints/v1');

	const state: RepoState = {
		dir,
		artifactDir,
		headBefore,
		checkpointBefore,
		consoleLogPath,

		async runPrompt(prompt, rpOpts): Promise<VogonRunResult> {
			const res = await runVogonBin(dir, prompt, rpOpts);
			await handle.appendFile(`> ${res.command}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}\n`);
			return res;
		},

		async git(...args: string[]): Promise<void> {
			await handle.appendFile(`> git ${args.join(' ')}\n`);
			try {
				const res = await execa('git', args, { cwd: dir, env: isolatedSpawnEnv() });
				if (res.stdout) {
					await handle.appendFile(`${res.stdout}\n`);
				}
			} catch (e) {
				const err = e as ExecaError;
				await handle.appendFile(`ERROR: ${err.stderr}\n`);
				throw new Error(`git ${args.join(' ')} failed: ${err.stderr}\n${err.stdout}`);
			}
		},

		async gitOutput(...args: string[]): Promise<string> {
			const res = await execa('git', args, {
				cwd: dir,
				env: isolatedSpawnEnv(),
			});
			return (res.stdout?.toString() ?? '').trim();
		},

		async patchSettings(extras: Record<string, unknown>): Promise<void> {
			const p = path.join(dir, '.story', 'settings.json');
			const raw = await fs.readFile(p, 'utf-8');
			const parsed = JSON.parse(raw) as Record<string, unknown>;
			const merged = { ...parsed, ...extras };
			await fs.writeFile(p, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o644 });
		},

		async setupBareRemote(): Promise<string> {
			const bareRaw = await fs.mkdtemp(path.join(os.tmpdir(), 'story-e2e-bare-'));
			const bareDir = await fs.realpath(bareRaw);
			const bareEnv = isolatedSpawnEnv();
			await execa('git', ['init', '--bare', bareDir], { env: bareEnv });
			await execa('git', ['remote', 'add', 'origin', bareDir], { cwd: dir, env: bareEnv });
			await execa('git', ['push', '-u', 'origin', 'HEAD'], { cwd: dir, env: bareEnv });
			return bareDir;
		},

		async closeConsoleLog(): Promise<void> {
			try {
				await handle.close();
			} catch {
				// idempotent
			}
		},
	};

	// Only patch log_level by default so scenarios see debug-level logs
	// (without that no `.story/logs/story.log` file would be written for
	// the assertions to grep). Leave `commit_linking` unset unless the
	// caller explicitly wants the fast path.
	const extras: Record<string, unknown> = {
		log_level: 'debug',
		absolute_git_hook_path: true,
	};
	if (opts?.commitLinking !== undefined) {
		extras.commit_linking = opts.commitLinking;
	}
	await state.patchSettings(extras);
	const hookRes = await runStory(dir, ['enable', 'git-hook']);
	if (hookRes.exitCode !== 0) {
		throw new Error(
			`story enable git-hook failed (exit ${hookRes.exitCode}): ${hookRes.stderr}\n${hookRes.stdout}`,
		);
	}

	return state;
}

/**
 * Tear down a repo state: close console log, remove temp dir (unless
 * `STORY_E2E_KEEP_REPOS=1`). Idempotent; safe to call after
 * `captureArtifacts` in a test-failure hook.
 */
export async function teardownRepo(s: RepoState): Promise<void> {
	await s.closeConsoleLog();
	const keep =
		(process.env.STORY_E2E_KEEP_REPOS !== undefined && process.env.STORY_E2E_KEEP_REPOS !== '') ||
		(process.env.ENTIRE_E2E_KEEP_REPOS !== undefined && process.env.ENTIRE_E2E_KEEP_REPOS !== '');
	if (keep) {
		return;
	}
	try {
		await fs.rm(s.dir, { recursive: true, force: true });
	} catch {
		// Already gone, or permission error — nothing useful to do.
	}
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function gitRevParse(dir: string, ref: string): Promise<string> {
	const res = await execa('git', ['rev-parse', ref], {
		cwd: dir,
		env: isolatedSpawnEnv(),
	});
	return (res.stdout?.toString() ?? '').trim();
}

async function gitRevParseOrEmpty(dir: string, ref: string): Promise<string> {
	try {
		const res = await execa('git', ['rev-parse', '--verify', ref], {
			cwd: dir,
			env: isolatedSpawnEnv(),
		});
		return (res.stdout?.toString() ?? '').trim();
	} catch {
		return '';
	}
}
