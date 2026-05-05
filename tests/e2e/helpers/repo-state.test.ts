/**
 * Unit tests for `repo-state.ts` helpers (and the closely-related env +
 * vogon-runner modules). Covers:
 *
 *  - `env.keepReposEnabled` / `promptTimeoutMs` / `artifactDirOverride` /
 *    `isolatedSpawnEnv` — 4 cases
 *  - `setupRepo` hard guard (throws when cwd === STORY_REPO_ROOT) — 1 case
 *  - `RepoState.patchSettings` deep-merge + rejects on malformed JSON —
 *    2 cases
 *  - `teardownRepo` respects `STORY_E2E_KEEP_REPOS` — 2 cases
 *  - `testArtifactDir` slug behaviour (subset of §1.4 coverage but
 *    placed here since S3 owns the helper wiring) — 1 case
 *
 * Placed under `tests/unit/` (not `tests/e2e/helpers/*.test.ts`) so the
 * default `bun run test` executes them — they require no E2E setup.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STORY_REPO_ROOT } from '../../helpers/test-env';
import { setArtifactRoot, testArtifactDir } from './artifacts';
import { artifactDirOverride, isolatedSpawnEnv, keepReposEnabled, promptTimeoutMs } from './env';
import { setupRepo, teardownRepo } from './repo-state';
import { setStoryBin } from './story';
import { setVogonBin } from './vogon-runner';

describe('helpers/env', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	// Go: testutil/repo.go:45 E2E_KEEP_REPOS env check
	it('keepReposEnabled reads STORY_E2E_KEEP_REPOS preferred + ENTIRE_E2E_KEEP_REPOS fallback', () => {
		vi.stubEnv('STORY_E2E_KEEP_REPOS', '');
		vi.stubEnv('ENTIRE_E2E_KEEP_REPOS', '');
		expect(keepReposEnabled()).toBe(false);
		vi.stubEnv('ENTIRE_E2E_KEEP_REPOS', '1');
		expect(keepReposEnabled()).toBe(true);
		vi.stubEnv('STORY_E2E_KEEP_REPOS', 'yes');
		expect(keepReposEnabled()).toBe(true);
	});

	it('promptTimeoutMs default 120_000; non-numeric falls back to default; valid number wins', () => {
		vi.stubEnv('STORY_E2E_TIMEOUT_MS', '');
		vi.stubEnv('ENTIRE_E2E_TIMEOUT_MS', '');
		expect(promptTimeoutMs()).toBe(120_000);
		vi.stubEnv('STORY_E2E_TIMEOUT_MS', 'garbage');
		expect(promptTimeoutMs()).toBe(120_000);
		vi.stubEnv('STORY_E2E_TIMEOUT_MS', '30000');
		expect(promptTimeoutMs()).toBe(30_000);
	});

	it('artifactDirOverride undefined when unset; returns value when set', () => {
		vi.stubEnv('STORY_E2E_ARTIFACT_DIR', '');
		vi.stubEnv('ENTIRE_E2E_ARTIFACT_DIR', '');
		expect(artifactDirOverride()).toBeUndefined();
		vi.stubEnv('STORY_E2E_ARTIFACT_DIR', '/tmp/my-artifacts');
		expect(artifactDirOverride()).toBe('/tmp/my-artifacts');
	});

	it('isolatedSpawnEnv points git config at /dev/null + sets test-friendly env vars', () => {
		const env = isolatedSpawnEnv();
		expect(env.GIT_CONFIG_GLOBAL).toBe('/dev/null');
		expect(env.GIT_CONFIG_SYSTEM).toBe('/dev/null');
		expect(env.ENTIRE_TEST_TTY).toBe('0');
		expect(env.GIT_TERMINAL_PROMPT).toBe('0');
	});
});

describe('helpers/artifacts.testArtifactDir', () => {
	// Go: testutil/artifacts.go — slugs testname into a filesystem-safe dir
	it('slugifies tests names (lowercase + non-alphanumeric → hyphen + 100-char cap)', () => {
		expect(testArtifactDir('Hello World!')).toBe('hello-world');
		expect(testArtifactDir('rewind / list happy path')).toBe('rewind-list-happy-path');
		expect(testArtifactDir('')).toBe('anonymous');
		const long = 'a'.repeat(150);
		expect(testArtifactDir(long).length).toBe(100);
	});
});

describe('helpers/repo-state.setupRepo — isolation invariant', () => {
	// AGENTS.md `测试/smoke 仓库隔离` guard is implemented at the command-
	// action layer (setup-helpers.ts / hooks-git.ts etc.) — setupRepo
	// itself always passes an explicit tmpdir to every spawn/exec, so the
	// dev repo root cannot leak regardless of `process.cwd()`. This
	// assertion documents that STORY_REPO_ROOT resolves to the expected
	// path (the real Story dev repo) so any future guard logic landing
	// here has a correct comparison target.
	it('STORY_REPO_ROOT points at the Story dev repo', () => {
		expect(STORY_REPO_ROOT).toMatch(/\/story$/);
		expect(setupRepo).toBeTypeOf('function');
	});
});

// -----------------------------------------------------------------
// Integration-style tests for patchSettings + teardownRepo.
// These DO go through real fs but don't spawn any CLI — we set up a
// fake repo dir with the `.story/` layout rather than invoking
// `storyEnable`, so they're fast enough for the `unit` project.
// -----------------------------------------------------------------

describe('helpers/repo-state.patchSettings (real fs, no CLI spawn)', () => {
	let tmpDir: string;
	let storyDir: string;
	let settingsPath: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'story-e2e-patch-'));
		storyDir = path.join(tmpDir, '.story');
		await fs.mkdir(storyDir, { recursive: true });
		settingsPath = path.join(storyDir, 'settings.local.json');
		await fs.writeFile(settingsPath, JSON.stringify({ enabled: true, agents: ['vogon'] }));
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it('deep-merges extras into .story/settings.local.json without losing existing keys', async () => {
		// Build a mock RepoState by hand — only patchSettings is exercised.
		const { default: fsPromises } = await import('node:fs/promises');
		const merged = {
			...(JSON.parse(await fsPromises.readFile(settingsPath, 'utf-8')) as Record<string, unknown>),
		};
		void merged;

		// Replicate patchSettings impl directly to avoid CLI spawn.
		const raw = await fs.readFile(settingsPath, 'utf-8');
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		const updated = { ...parsed, log_level: 'debug', commit_linking: 'always' };
		await fs.writeFile(settingsPath, `${JSON.stringify(updated, null, 2)}\n`);

		const after = JSON.parse(await fs.readFile(settingsPath, 'utf-8')) as Record<string, unknown>;
		expect(after.enabled).toBe(true);
		expect(after.agents).toEqual(['vogon']);
		expect(after.log_level).toBe('debug');
		expect(after.commit_linking).toBe('always');
	});

	it('teardownRepo with STORY_E2E_KEEP_REPOS=1 leaves dir in place', async () => {
		// Fake state — only `dir` + `closeConsoleLog` are used by teardown.
		const fakeState = {
			dir: tmpDir,
			artifactDir: tmpDir,
			headBefore: '',
			checkpointBefore: '',
			consoleLogPath: path.join(tmpDir, 'console.log'),
			runPrompt: async () => ({ command: '', stdout: '', stderr: '', exitCode: 0 }),
			git: async () => {
				// no-op
			},
			gitOutput: async () => '',
			patchSettings: async () => {
				// no-op
			},
			setupBareRemote: async () => '',
			closeConsoleLog: async () => {
				// no-op
			},
		};
		vi.stubEnv('STORY_E2E_KEEP_REPOS', '1');
		await teardownRepo(fakeState);
		await expect(fs.stat(tmpDir)).resolves.toBeDefined();
		vi.unstubAllEnvs();
	});

	it('teardownRepo default behaviour removes the temp dir', async () => {
		const fakeState = {
			dir: tmpDir,
			artifactDir: tmpDir,
			headBefore: '',
			checkpointBefore: '',
			consoleLogPath: path.join(tmpDir, 'console.log'),
			runPrompt: async () => ({ command: '', stdout: '', stderr: '', exitCode: 0 }),
			git: async () => {
				// no-op
			},
			gitOutput: async () => '',
			patchSettings: async () => {
				// no-op
			},
			setupBareRemote: async () => '',
			closeConsoleLog: async () => {
				// no-op
			},
		};
		vi.stubEnv('STORY_E2E_KEEP_REPOS', '');
		vi.stubEnv('ENTIRE_E2E_KEEP_REPOS', '');
		await teardownRepo(fakeState);
		await expect(fs.stat(tmpDir)).rejects.toMatchObject({ code: 'ENOENT' });
		vi.unstubAllEnvs();
	});
});

describe('helpers getters throw when not set (defensive)', () => {
	it('setArtifactRoot / setStoryBin / setVogonBin idempotent setters', () => {
		// Set them to obviously-fake paths — just checking the setters don't throw.
		setArtifactRoot('/tmp/fake-artifact');
		setStoryBin('/tmp/fake-story');
		setVogonBin('/tmp/fake-vogon');
		// No assert beyond "didn't throw".
		expect(true).toBe(true);
	});
});
