/**
 * E2E environment-variable helpers.
 *
 * Collects all `STORY_E2E_*` env knobs in one place. Each helper reads the
 * Story-prefixed var first, then falls back to `ENTIRE_E2E_*` for
 * back-compat with the Go harness. Keeps the Story side callable from the
 * same smoke/CI scripts that drive the Go version.
 *
 * Mirrors the env reads spread throughout Go
 * `entire-cli/e2e/testutil/repo.go` + `agents/vogon.go`.
 *
 * @packageDocumentation
 */

/**
 * `STORY_E2E_KEEP_REPOS` (or `ENTIRE_E2E_KEEP_REPOS`). Any non-empty
 * value counts as true. Go: `testutil/repo.go:45` `os.Getenv("E2E_KEEP_REPOS")`.
 */
export function keepReposEnabled(): boolean {
	const story = process.env.STORY_E2E_KEEP_REPOS;
	if (story !== undefined && story !== '') {
		return true;
	}
	const entire = process.env.ENTIRE_E2E_KEEP_REPOS;
	if (entire !== undefined && entire !== '') {
		return true;
	}
	return false;
}

/**
 * Per-prompt timeout in milliseconds. Default `120000` (2 min), matches
 * Go `E2E_TIMEOUT=2m`. Reads `STORY_E2E_TIMEOUT_MS` then
 * `ENTIRE_E2E_TIMEOUT_MS`. Non-numeric values fall back to the default.
 */
export function promptTimeoutMs(): number {
	const raw = process.env.STORY_E2E_TIMEOUT_MS ?? process.env.ENTIRE_E2E_TIMEOUT_MS;
	if (raw === undefined || raw === '') {
		return 120_000;
	}
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? n : 120_000;
}

/**
 * Override for the run-wide artifact root. Reads `STORY_E2E_ARTIFACT_DIR`
 * then `ENTIRE_E2E_ARTIFACT_DIR`. Returns `undefined` when unset (caller
 * uses the `tests/e2e/artifacts/<ISO-timestamp>/` default).
 */
export function artifactDirOverride(): string | undefined {
	const v = process.env.STORY_E2E_ARTIFACT_DIR ?? process.env.ENTIRE_E2E_ARTIFACT_DIR;
	if (v === undefined || v === '') {
		return undefined;
	}
	return v;
}

/**
 * Copy of `process.env` with isolation tweaks: `GIT_CONFIG_GLOBAL` /
 * `GIT_CONFIG_SYSTEM` pointed at `/dev/null` (so host git config cannot
 * leak into tests), plus `ENTIRE_TEST_TTY=0` + `GIT_TERMINAL_PROMPT=0`.
 * Callers using `execa` spread this into the `env` option and override as
 * needed.
 *
 * Mirrors Go `testutil/repo.go::SetupRepo` env setup
 * (`GIT_CONFIG_GLOBAL=<empty>` written by `TestMain`).
 */
/**
 * Whether `expect(1)` is on PATH (set once by `tests/e2e/setup.ts` globalSetup).
 * Interactive PTY E2E skips when `0` or unset.
 */
export function isExpectAvailableFromSetup(): boolean {
	return process.env.STORY_E2E_EXPECT_OK === '1';
}

export function isolatedSpawnEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (k === 'GIT_CONFIG_GLOBAL' || k === 'GIT_CONFIG_SYSTEM') {
			continue;
		}
		if (v !== undefined) {
			env[k] = v;
		}
	}
	env.GIT_CONFIG_GLOBAL = '/dev/null';
	env.GIT_CONFIG_SYSTEM = '/dev/null';
	env.ENTIRE_TEST_TTY = '0';
	env.GIT_TERMINAL_PROMPT = '0';
	return env;
}
