/**
 * Phase 9.1 `src/commands/disable.ts` unit tests.
 *
 * Mocks `setup-flow` to isolate the cac wiring + flag-to-options
 * translation; full pipeline coverage lives in setup-flow.test.ts and the
 * integration e2e.
 *
 * Go: setup.go: newDisableCmd / runDisable / runUninstall.
 */

import cac from 'cac';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerGlobalFlags, resetGlobalFlagsForTesting } from '@/cli/flags';
import { setForceNonInteractive } from '@/cli/tty';
import { registerDisableCommand } from '@/commands/disable';
import { resetColorOverrideForTesting, setColorOverride } from '@/ui/theme';
import { assertCwdIsNotStoryRepo, TestEnv } from '../../helpers/test-env';

const { runDisable, runUninstall } = vi.hoisted(() => ({
	runDisable: vi.fn().mockResolvedValue(undefined),
	runUninstall: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/commands/setup-flow', () => ({
	runDisable,
	runUninstall,
}));

function silenceStdio() {
	const origStdout = process.stdout.write.bind(process.stdout);
	const origStderr = process.stderr.write.bind(process.stderr);
	process.stdout.write = (() => true) as typeof process.stdout.write;
	process.stderr.write = (() => true) as typeof process.stderr.write;
	return () => {
		process.stdout.write = origStdout;
		process.stderr.write = origStderr;
	};
}

function buildCliWithDisable(): ReturnType<typeof cac> {
	const cli = cac('story');
	registerGlobalFlags(cli);
	registerDisableCommand(cli);
	return cli;
}

async function runCli(cli: ReturnType<typeof cac>, argv: string[]): Promise<void> {
	cli.parse(['node', 'story', ...argv], { run: false });
	const result = cli.runMatchedCommand();
	if (result && typeof (result as Promise<unknown>).then === 'function') {
		await result;
	}
}

describe('commands/disable', () => {
	let env: TestEnv;
	let origCwd: string;

	beforeEach(async () => {
		resetGlobalFlagsForTesting();
		resetColorOverrideForTesting();
		setColorOverride(false);
		setForceNonInteractive(true);
		runDisable.mockReset().mockResolvedValue(undefined);
		runUninstall.mockReset().mockResolvedValue(undefined);

		const { clearWorktreeRootCache } = await import('@/paths');
		clearWorktreeRootCache();
		env = await TestEnv.create({ initialCommit: true });
		origCwd = process.cwd();
		process.chdir(env.dir);
		clearWorktreeRootCache();
		// Hard leak guard — see `AGENTS.md` §测试/smoke 仓库隔离.
		assertCwdIsNotStoryRepo();
	});

	afterEach(async () => {
		process.chdir(origCwd);
		await env.cleanup();
		resetGlobalFlagsForTesting();
		resetColorOverrideForTesting();
		setForceNonInteractive(false);
	});

	// Go: setup.go: newDisableCmd — flag wiring
	it('registers `disable` with --project / --uninstall / --force flags', () => {
		const cli = buildCliWithDisable();
		const disable = cli.commands.find((c) => c.name === 'disable');
		expect(disable).toBeDefined();
		const flagNames = disable!.options.map((o) => o.name);
		for (const flag of ['project', 'uninstall', 'force']) {
			expect(flagNames).toContain(flag);
		}
	});

	// Go: setup.go: runDisable — bare disable dispatches to runDisable
	it('bare `disable` → runDisable (not runUninstall)', async () => {
		const cli = buildCliWithDisable();
		const restore = silenceStdio();
		try {
			await runCli(cli, ['disable']);
		} finally {
			restore();
		}
		expect(runDisable).toHaveBeenCalledTimes(1);
		expect(runUninstall).not.toHaveBeenCalled();
		expect(runDisable.mock.calls[0]![0]).toMatchObject({
			repoRoot: env.dir,
			uninstall: false,
			force: false,
			useProjectSettings: false,
		});
	});

	// Go: setup.go: runUninstall — --uninstall dispatches to runUninstall
	it('--uninstall → runUninstall (not runDisable)', async () => {
		const cli = buildCliWithDisable();
		const restore = silenceStdio();
		try {
			await runCli(cli, ['disable', '--uninstall']);
		} finally {
			restore();
		}
		expect(runUninstall).toHaveBeenCalledTimes(1);
		expect(runDisable).not.toHaveBeenCalled();
	});

	// --uninstall --force propagates
	it('--uninstall --force sets { uninstall: true, force: true }', async () => {
		const cli = buildCliWithDisable();
		const restore = silenceStdio();
		try {
			await runCli(cli, ['disable', '--uninstall', '--force']);
		} finally {
			restore();
		}
		expect(runUninstall.mock.calls[0]![0]).toMatchObject({
			uninstall: true,
			force: true,
			useProjectSettings: false,
		});
	});

	// --project propagates (bare disable branch)
	it('--project sets useProjectSettings: true', async () => {
		const cli = buildCliWithDisable();
		const restore = silenceStdio();
		try {
			await runCli(cli, ['disable', '--project']);
		} finally {
			restore();
		}
		expect(runDisable.mock.calls[0]![0]).toMatchObject({
			useProjectSettings: true,
			uninstall: false,
		});
	});

	// Not-a-git-repo guard
	it('outside a git repo → SilentError', async () => {
		const { default: fs } = await import('node:fs/promises');
		const { default: os } = await import('node:os');
		const { default: path } = await import('node:path');
		const notGit = await fs.mkdtemp(path.join(os.tmpdir(), 'story-nogit-'));
		const { clearWorktreeRootCache } = await import('@/paths');
		clearWorktreeRootCache();
		process.chdir(notGit);
		try {
			const cli = buildCliWithDisable();
			const restore = silenceStdio();
			try {
				await expect(runCli(cli, ['disable'])).rejects.toThrow(/Not a git repository/);
			} finally {
				restore();
			}
		} finally {
			process.chdir(env.dir);
			clearWorktreeRootCache();
			await fs.rm(notGit, { recursive: true, force: true });
		}
	});

	// runUninstall errors propagate (non-interactive missing --force)
	it('setup-flow error propagates through cac action (runUninstall rejection)', async () => {
		const { SilentError } = await import('@/errors');
		runUninstall.mockRejectedValueOnce(
			new SilentError(new Error('pass --force to confirm uninstall in non-interactive mode')),
		);
		const cli = buildCliWithDisable();
		const restore = silenceStdio();
		try {
			await expect(runCli(cli, ['disable', '--uninstall'])).rejects.toThrow(
				/pass --force to confirm uninstall/,
			);
		} finally {
			restore();
		}
	});

	// Default repo root detection
	it('opts.repoRoot is the resolved worktree root, not the cwd sub-path', async () => {
		const { default: fs } = await import('node:fs/promises');
		const { default: path } = await import('node:path');
		await fs.mkdir(path.join(env.dir, 'sub'), { recursive: true });
		process.chdir(path.join(env.dir, 'sub'));

		const cli = buildCliWithDisable();
		const restore = silenceStdio();
		try {
			await runCli(cli, ['disable']);
		} finally {
			restore();
		}
		expect(runDisable.mock.calls[0]![0].repoRoot).toBe(env.dir);
	});
});
