// Go: cmd/entire/cli/paths/tty.go: HasTTY — detectTTY() in src/cli/tty.ts
// delegates to @/git::hasTTY (the TS port shipped in Phase 1.3). The
// CI-env detection and force-override guards below are Story-side
// extensions; cobra dispatches handled them ad-hoc in Go.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SilentError } from '@/errors';

const CI_ENV_KEYS = [
	'CI',
	'GITHUB_ACTIONS',
	'BUILDKITE',
	'CIRCLECI',
	'GITLAB_CI',
	'TF_BUILD',
	'JENKINS_URL',
	'TEAMCITY_VERSION',
	'DRONE',
	'APPVEYOR',
	'BITBUCKET_BUILD_NUMBER',
] as const;

/**
 * Save + restore all CI-related env vars plus the TTY override so each test
 * runs in isolation. `detectCI` / `detectTTY` are pure reads over
 * process.env / hasTTY() — no shared module state of their own — so env + the
 * tty.ts module-level `forceNonInteractive` flag are everything to reset.
 */
function snapshotEnv() {
	const backup: Record<string, string | undefined> = {};
	for (const key of CI_ENV_KEYS) {
		backup[key] = process.env[key];
		delete process.env[key];
	}
	backup.STORY_TEST_TTY = process.env.STORY_TEST_TTY;
	backup.ENTIRE_TEST_TTY = process.env.ENTIRE_TEST_TTY;
	backup.GEMINI_CLI = process.env.GEMINI_CLI;
	backup.COPILOT_CLI = process.env.COPILOT_CLI;
	backup.PI_CODING_AGENT = process.env.PI_CODING_AGENT;
	backup.GIT_TERMINAL_PROMPT = process.env.GIT_TERMINAL_PROMPT;
	return backup;
}

function restoreEnv(backup: Record<string, string | undefined>) {
	for (const [k, v] of Object.entries(backup)) {
		if (v === undefined) {
			delete process.env[k];
		} else {
			process.env[k] = v;
		}
	}
}

describe('cli/tty', () => {
	let backup: Record<string, string | undefined>;

	beforeEach(async () => {
		backup = snapshotEnv();
		process.env.STORY_TEST_TTY = '1';
		const tty = await import('@/cli/tty');
		tty.setForceNonInteractive(false);
	});

	afterEach(() => {
		restoreEnv(backup);
	});

	describe('detectTTY', () => {
		it('delegates to hasTTY() from @/git — true when STORY_TEST_TTY=1', async () => {
			process.env.STORY_TEST_TTY = '1';
			const { detectTTY } = await import('@/cli/tty');
			expect(detectTTY()).toBe(true);
		});

		it('delegates to hasTTY() — false when STORY_TEST_TTY=0', async () => {
			process.env.STORY_TEST_TTY = '0';
			const { detectTTY } = await import('@/cli/tty');
			expect(detectTTY()).toBe(false);
		});
	});

	describe('detectCI', () => {
		it('returns false when none of the 11 CI env vars are set', async () => {
			const { detectCI } = await import('@/cli/tty');
			expect(detectCI()).toBe(false);
		});

		for (const key of CI_ENV_KEYS) {
			it(`returns true when ${key} is set`, async () => {
				process.env[key] = '1';
				const { detectCI } = await import('@/cli/tty');
				expect(detectCI()).toBe(true);
			});
		}

		it('treats empty-string env values as not set', async () => {
			process.env.CI = '';
			const { detectCI } = await import('@/cli/tty');
			expect(detectCI()).toBe(false);
		});
	});

	describe('isInteractive', () => {
		it('TTY + no CI → true', async () => {
			process.env.STORY_TEST_TTY = '1';
			const { isInteractive } = await import('@/cli/tty');
			expect(isInteractive()).toBe(true);
		});

		it('TTY + CI → false', async () => {
			process.env.STORY_TEST_TTY = '1';
			process.env.GITHUB_ACTIONS = 'true';
			const { isInteractive } = await import('@/cli/tty');
			expect(isInteractive()).toBe(false);
		});

		it('no TTY → false regardless of CI', async () => {
			process.env.STORY_TEST_TTY = '0';
			const { isInteractive } = await import('@/cli/tty');
			expect(isInteractive()).toBe(false);
		});

		it('force-non-interactive override → false', async () => {
			process.env.STORY_TEST_TTY = '1';
			const { isInteractive, setForceNonInteractive } = await import('@/cli/tty');
			setForceNonInteractive(true);
			expect(isInteractive()).toBe(false);
			setForceNonInteractive(false);
			expect(isInteractive()).toBe(true);
		});
	});

	describe('requireInteractive', () => {
		it('returns silently when interactive', async () => {
			process.env.STORY_TEST_TTY = '1';
			const { requireInteractive } = await import('@/cli/tty');
			expect(() => requireInteractive('pass --yes')).not.toThrow();
		});

		it('throws SilentError with hint when not interactive (no TTY)', async () => {
			process.env.STORY_TEST_TTY = '0';
			const { requireInteractive } = await import('@/cli/tty');
			expect(() => requireInteractive('pass --yes')).toThrow(SilentError);
			try {
				requireInteractive('pass --yes or --agent <name>');
			} catch (err) {
				expect(err).toBeInstanceOf(SilentError);
				expect((err as SilentError).message).toMatch(/non-interactive/i);
				expect((err as SilentError).message).toMatch(/pass --yes or --agent/);
			}
		});

		it('throws when force-non-interactive is set even if TTY on', async () => {
			process.env.STORY_TEST_TTY = '1';
			const { requireInteractive, setForceNonInteractive } = await import('@/cli/tty');
			setForceNonInteractive(true);
			expect(() => requireInteractive('pass --yes')).toThrow(SilentError);
			setForceNonInteractive(false);
		});

		it('throws when CI env is set', async () => {
			process.env.STORY_TEST_TTY = '1';
			process.env.CI = 'true';
			const { requireInteractive } = await import('@/cli/tty');
			expect(() => requireInteractive('pass --yes')).toThrow(SilentError);
		});
	});
});

// vi is used implicitly by import resolution; explicit reference silences lint.
void vi;
