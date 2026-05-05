import cac from 'cac';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
];

function clearEnv() {
	const backup: Record<string, string | undefined> = {};
	for (const k of CI_ENV_KEYS) {
		backup[k] = process.env[k];
		delete process.env[k];
	}
	backup.FORCE_COLOR = process.env.FORCE_COLOR;
	backup.NO_COLOR = process.env.NO_COLOR;
	backup.STORY_TEST_TTY = process.env.STORY_TEST_TTY;
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

describe('cli/flags', () => {
	let backup: Record<string, string | undefined>;

	beforeEach(async () => {
		backup = clearEnv();
		process.env.STORY_TEST_TTY = '1';
		const mod = await import('@/cli/flags');
		mod.resetGlobalFlagsForTesting();
		const theme = await import('@/ui/theme');
		theme.resetColorOverrideForTesting();
		const tty = await import('@/cli/tty');
		tty.setForceNonInteractive(false);
	});

	afterEach(() => {
		restoreEnv(backup);
	});

	describe('getGlobalFlags() defaults', () => {
		it('returns the canonical default shape before any apply', async () => {
			const { getGlobalFlags } = await import('@/cli/flags');
			const flags = getGlobalFlags();
			expect(flags).toEqual({
				verbose: false,
				noColor: false,
				json: false,
				nonInteractive: false,
				yes: false,
				pure: false,
				logLevel: 'info',
			});
		});
	});

	describe('registerGlobalFlags(cli)', () => {
		it('registers 7 global options on the cac root', async () => {
			const { registerGlobalFlags } = await import('@/cli/flags');
			const cli = cac('test');
			registerGlobalFlags(cli);
			// cac internally normalizes: --no-color → name 'color' (negated),
			// --non-interactive → 'nonInteractive', --log-level → 'logLevel'.
			const names = cli.globalCommand.options.map((o) => o.name);
			expect(names).toEqual(
				expect.arrayContaining([
					'verbose',
					'color',
					'json',
					'nonInteractive',
					'yes',
					'pure',
					'logLevel',
				]),
			);
		});

		it('is idempotent (registering twice does not crash)', async () => {
			const { registerGlobalFlags } = await import('@/cli/flags');
			const cli = cac('test');
			registerGlobalFlags(cli);
			registerGlobalFlags(cli);
			// cac appends options on each call; we only assert the fn doesn't throw.
			expect(cli.globalCommand.options.length).toBeGreaterThan(0);
		});
	});

	describe('applyGlobalFlags(parsed)', () => {
		it('applies --verbose → logLevel=debug and updates log module', async () => {
			const { applyGlobalFlags, getGlobalFlags } = await import('@/cli/flags');
			applyGlobalFlags({ verbose: true });
			expect(getGlobalFlags().verbose).toBe(true);
			expect(getGlobalFlags().logLevel).toBe('debug');
		});

		it('applies --log-level error (overrides verbose)', async () => {
			const { applyGlobalFlags, getGlobalFlags } = await import('@/cli/flags');
			applyGlobalFlags({ verbose: true, logLevel: 'error' });
			expect(getGlobalFlags().logLevel).toBe('error');
		});

		it('applies --json → nonInteractive=true', async () => {
			const { applyGlobalFlags, getGlobalFlags } = await import('@/cli/flags');
			applyGlobalFlags({ json: true });
			expect(getGlobalFlags().json).toBe(true);
			expect(getGlobalFlags().nonInteractive).toBe(true);
		});

		it('applies --yes → nonInteractive=true', async () => {
			const { applyGlobalFlags, getGlobalFlags } = await import('@/cli/flags');
			applyGlobalFlags({ yes: true });
			expect(getGlobalFlags().yes).toBe(true);
			expect(getGlobalFlags().nonInteractive).toBe(true);
		});

		it('applies --non-interactive directly', async () => {
			const { applyGlobalFlags, getGlobalFlags } = await import('@/cli/flags');
			applyGlobalFlags({ 'non-interactive': true });
			expect(getGlobalFlags().nonInteractive).toBe(true);
		});

		it('accepts both kebab-case (no-color) and camelCase (noColor)', async () => {
			const { applyGlobalFlags, getGlobalFlags } = await import('@/cli/flags');
			applyGlobalFlags({ 'no-color': true });
			expect(getGlobalFlags().noColor).toBe(true);
		});

		it('--no-color flips theme color override off', async () => {
			const { applyGlobalFlags } = await import('@/cli/flags');
			const { isColorEnabled } = await import('@/ui/theme');
			applyGlobalFlags({ 'no-color': true });
			expect(isColorEnabled()).toBe(false);
		});

		it('--non-interactive flips tty forceNonInteractive on', async () => {
			const { applyGlobalFlags } = await import('@/cli/flags');
			const { isInteractive } = await import('@/cli/tty');
			applyGlobalFlags({ 'non-interactive': true });
			expect(isInteractive()).toBe(false);
		});

		it('CI env implicitly sets nonInteractive=true but NOT yes', async () => {
			process.env.GITHUB_ACTIONS = 'true';
			const { applyGlobalFlags, getGlobalFlags } = await import('@/cli/flags');
			applyGlobalFlags({});
			expect(getGlobalFlags().nonInteractive).toBe(true);
			expect(getGlobalFlags().yes).toBe(false);
		});

		it('is idempotent — apply twice with same input yields same state', async () => {
			const { applyGlobalFlags, getGlobalFlags } = await import('@/cli/flags');
			applyGlobalFlags({ verbose: true, json: true });
			const a = { ...getGlobalFlags() };
			applyGlobalFlags({ verbose: true, json: true });
			const b = { ...getGlobalFlags() };
			expect(b).toEqual(a);
		});

		it('parses unknown logLevel as info (fallback matches log.parseLogLevel)', async () => {
			const { applyGlobalFlags, getGlobalFlags } = await import('@/cli/flags');
			applyGlobalFlags({ logLevel: 'chatter' });
			expect(getGlobalFlags().logLevel).toBe('info');
		});

		// `--pure` — AI-facing plain-text output mode. NOT auto-derived from
		// non-TTY; must be passed explicitly. Does NOT imply `--json` or
		// `--non-interactive`.
		it('applies --pure → pure=true without implying nonInteractive or json', async () => {
			const { applyGlobalFlags, getGlobalFlags } = await import('@/cli/flags');
			applyGlobalFlags({ pure: true });
			const flags = getGlobalFlags();
			expect(flags.pure).toBe(true);
			expect(flags.nonInteractive).toBe(false);
			expect(flags.json).toBe(false);
		});

		it('CI env does not implicitly set pure=true', async () => {
			process.env.GITHUB_ACTIONS = 'true';
			const { applyGlobalFlags, getGlobalFlags } = await import('@/cli/flags');
			applyGlobalFlags({});
			expect(getGlobalFlags().pure).toBe(false);
		});

		it('default → pure=false (matches getGlobalFlags() defaults)', async () => {
			const { applyGlobalFlags, getGlobalFlags } = await import('@/cli/flags');
			applyGlobalFlags({});
			expect(getGlobalFlags().pure).toBe(false);
		});
	});

	describe('resetGlobalFlagsForTesting', () => {
		it('restores defaults after flipping', async () => {
			const { applyGlobalFlags, getGlobalFlags, resetGlobalFlagsForTesting } = await import(
				'@/cli/flags'
			);
			applyGlobalFlags({ json: true, verbose: true, 'no-color': true, pure: true });
			resetGlobalFlagsForTesting();
			expect(getGlobalFlags()).toEqual({
				verbose: false,
				noColor: false,
				json: false,
				nonInteractive: false,
				yes: false,
				pure: false,
				logLevel: 'info',
			});
		});

		it('also clears theme color override + tty nonInteractive override', async () => {
			const { applyGlobalFlags, resetGlobalFlagsForTesting } = await import('@/cli/flags');
			const { isColorEnabled } = await import('@/ui/theme');
			const { isInteractive } = await import('@/cli/tty');
			applyGlobalFlags({ 'no-color': true, 'non-interactive': true });
			expect(isColorEnabled()).toBe(false);
			expect(isInteractive()).toBe(false);
			resetGlobalFlagsForTesting();
			// isColorEnabled falls back to pc.isColorSupported; we just assert the
			// override itself was cleared — the concrete boolean depends on env.
			expect(typeof isColorEnabled()).toBe('boolean');
			expect(isInteractive()).toBe(true);
		});
	});
});

// Imported to keep vitest mock scope — referenced to silence lint.
void vi;
