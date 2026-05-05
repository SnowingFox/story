/**
 * Unit tests for `tests/e2e/helpers/env.ts` env-reading helpers.
 *
 * Companion to `repo-state.test.ts`, which used to house these cases
 * inline. Split out so `audit-test-go-parity.sh` can pair
 * `env.ts`'s "Mirrors Go ..." JSDoc with a dedicated test file.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	artifactDirOverride,
	isExpectAvailableFromSetup,
	isolatedSpawnEnv,
	keepReposEnabled,
	promptTimeoutMs,
} from './env';

describe('helpers/env — Go: testutil/repo.go + agents/vogon.go env reads', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	// Go: testutil/repo.go:45 `os.Getenv("E2E_KEEP_REPOS")`
	it('keepReposEnabled reads STORY_E2E_KEEP_REPOS preferred + ENTIRE_E2E_KEEP_REPOS fallback', () => {
		vi.stubEnv('STORY_E2E_KEEP_REPOS', '');
		vi.stubEnv('ENTIRE_E2E_KEEP_REPOS', '');
		expect(keepReposEnabled()).toBe(false);

		vi.stubEnv('ENTIRE_E2E_KEEP_REPOS', '1');
		expect(keepReposEnabled()).toBe(true);

		vi.stubEnv('STORY_E2E_KEEP_REPOS', 'yes');
		expect(keepReposEnabled()).toBe(true);
	});

	// Go: testutil/repo.go reads E2E_TIMEOUT (default 2m). We mirror as ms.
	it('promptTimeoutMs default 120000; non-numeric → default; valid → parsed', () => {
		vi.stubEnv('STORY_E2E_TIMEOUT_MS', '');
		vi.stubEnv('ENTIRE_E2E_TIMEOUT_MS', '');
		expect(promptTimeoutMs()).toBe(120_000);

		vi.stubEnv('STORY_E2E_TIMEOUT_MS', 'garbage');
		expect(promptTimeoutMs()).toBe(120_000);

		vi.stubEnv('STORY_E2E_TIMEOUT_MS', '30000');
		expect(promptTimeoutMs()).toBe(30_000);
	});

	// Go: testutil/repo.go E2E_ARTIFACT_DIR override (main_test.go:18-23).
	it('artifactDirOverride unset → undefined; set → literal path', () => {
		vi.stubEnv('STORY_E2E_ARTIFACT_DIR', '');
		vi.stubEnv('ENTIRE_E2E_ARTIFACT_DIR', '');
		expect(artifactDirOverride()).toBeUndefined();

		vi.stubEnv('STORY_E2E_ARTIFACT_DIR', '/tmp/my-artifacts');
		expect(artifactDirOverride()).toBe('/tmp/my-artifacts');
	});

	// Go: testutil/repo.go:548 `cmd.Env = append(os.Environ(), "ENTIRE_TEST_TTY=0")`
	// plus agents/vogon.go:46 `filterEnv(os.Environ(), "ENTIRE_TEST_TTY")`. The
	// TS isolatedSpawnEnv collects both flows — strip host git config, inject
	// test-friendly env vars.
	it('isolatedSpawnEnv strips host git config + injects test-friendly flags', () => {
		const env = isolatedSpawnEnv();
		expect(env.GIT_CONFIG_GLOBAL).toBe('/dev/null');
		expect(env.GIT_CONFIG_SYSTEM).toBe('/dev/null');
		expect(env.ENTIRE_TEST_TTY).toBe('0');
		expect(env.GIT_TERMINAL_PROMPT).toBe('0');
	});

	it('isExpectAvailableFromSetup mirrors STORY_E2E_EXPECT_OK from globalSetup', () => {
		vi.stubEnv('STORY_E2E_EXPECT_OK', '');
		expect(isExpectAvailableFromSetup()).toBe(false);
		vi.stubEnv('STORY_E2E_EXPECT_OK', '1');
		expect(isExpectAvailableFromSetup()).toBe(true);
	});
});
