/**
 * Phase 9.1 `src/commands/configure.ts` unit tests.
 *
 * Mocks `setup-flow` to isolate cac wiring + flag dispatch. Real
 * orchestration (agent install, settings write) is already covered by
 * setup-flow.test.ts.
 *
 * Go: setup.go: newSetupCmd + runManageAgents + runRemoveAgent +
 * updateStrategyOptions.
 */

import cac from 'cac';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerGlobalFlags, resetGlobalFlagsForTesting } from '@/cli/flags';
import { setForceNonInteractive } from '@/cli/tty';
import { registerConfigureCommand } from '@/commands/configure';
import { SilentError } from '@/errors';
import { resetColorOverrideForTesting, setColorOverride } from '@/ui/theme';
import { assertCwdIsNotStoryRepo, TestEnv } from '../../helpers/test-env';

const {
	runInteractiveConfigure,
	runNonInteractiveConfigureAdd,
	runUpdateStrategyOptions,
	uninstallAgentHooks,
} = vi.hoisted(() => ({
	runInteractiveConfigure: vi.fn().mockResolvedValue(undefined),
	runNonInteractiveConfigureAdd: vi.fn().mockResolvedValue(undefined),
	runUpdateStrategyOptions: vi.fn().mockResolvedValue(undefined),
	uninstallAgentHooks: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/commands/setup-flow', () => ({
	runInteractiveConfigure,
	runNonInteractiveConfigureAdd,
	runUpdateStrategyOptions,
	uninstallAgentHooks,
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

function buildCli(): ReturnType<typeof cac> {
	const cli = cac('story');
	registerGlobalFlags(cli);
	registerConfigureCommand(cli);
	return cli;
}

async function runCli(cli: ReturnType<typeof cac>, argv: string[]): Promise<void> {
	cli.parse(['node', 'story', ...argv], { run: false });
	const result = cli.runMatchedCommand();
	if (result && typeof (result as Promise<unknown>).then === 'function') {
		await result;
	}
}

describe('commands/configure', () => {
	let env: TestEnv;
	let origCwd: string;

	beforeEach(async () => {
		resetGlobalFlagsForTesting();
		resetColorOverrideForTesting();
		setColorOverride(false);
		setForceNonInteractive(true);
		runInteractiveConfigure.mockReset().mockResolvedValue(undefined);
		runNonInteractiveConfigureAdd.mockReset().mockResolvedValue(undefined);
		runUpdateStrategyOptions.mockReset().mockResolvedValue(undefined);
		uninstallAgentHooks.mockReset().mockResolvedValue(undefined);

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

	// Go: setup.go: newSetupCmd — `setup` alias recognised
	it('registers `configure` with `setup` alias', () => {
		const cli = buildCli();
		const cmd = cli.commands.find((c) => c.name === 'configure');
		expect(cmd).toBeDefined();
		expect(cmd!.aliasNames).toContain('setup');
	});

	// Go: setup.go: runRemoveAgent — --remove routes to uninstallAgentHooks
	it('--remove <name> dispatches to uninstallAgentHooks', async () => {
		const cli = buildCli();
		const restore = silenceStdio();
		try {
			await runCli(cli, ['configure', '--remove', 'cursor']);
		} finally {
			restore();
		}
		expect(uninstallAgentHooks).toHaveBeenCalledTimes(1);
		expect(uninstallAgentHooks).toHaveBeenCalledWith(env.dir, 'cursor');
		expect(runInteractiveConfigure).not.toHaveBeenCalled();
		expect(runNonInteractiveConfigureAdd).not.toHaveBeenCalled();
	});

	// Go: setup.go: newSetupCmd — --agent routes to non-interactive add
	it('--agent <name> dispatches to runNonInteractiveConfigureAdd', async () => {
		const cli = buildCli();
		const restore = silenceStdio();
		try {
			await runCli(cli, ['configure', '--agent', 'cursor', '--local']);
		} finally {
			restore();
		}
		expect(runNonInteractiveConfigureAdd).toHaveBeenCalledTimes(1);
		expect(runNonInteractiveConfigureAdd.mock.calls[0]![0]).toMatchObject({
			agentName: 'cursor',
			scope: 'local',
		});
	});

	// Go: setup.go: newSetupCmd — --agent + --remove conflict
	it('--agent <a> + --remove <b> → SilentError', async () => {
		const cli = buildCli();
		const restore = silenceStdio();
		try {
			await expect(
				runCli(cli, ['configure', '--agent', 'cursor', '--remove', 'claude-code']),
			).rejects.toThrow(/--agent and --remove cannot be used together/);
		} finally {
			restore();
		}
	});

	// Go: setup.go: updateStrategyOptions — --skip-push-sessions alone
	it('--skip-push-sessions (no agent flag) → runUpdateStrategyOptions', async () => {
		const cli = buildCli();
		const restore = silenceStdio();
		try {
			await runCli(cli, ['configure', '--skip-push-sessions']);
		} finally {
			restore();
		}
		expect(runUpdateStrategyOptions).toHaveBeenCalledTimes(1);
		expect(runUpdateStrategyOptions.mock.calls[0]![0]).toMatchObject({
			skipPushSessions: true,
		});
	});

	// Go: setup.go: runManageAgents — bare configure → interactive path
	it('bare configure → runInteractiveConfigure', async () => {
		const cli = buildCli();
		const restore = silenceStdio();
		try {
			await runCli(cli, ['configure']);
		} finally {
			restore();
		}
		expect(runInteractiveConfigure).toHaveBeenCalledTimes(1);
	});

	// Mutually-exclusive flags: --local + --project
	it('--local + --project → SilentError', async () => {
		const cli = buildCli();
		const restore = silenceStdio();
		try {
			await expect(
				runCli(cli, ['configure', '--agent', 'cursor', '--local', '--project']),
			).rejects.toThrow(/cannot specify both --project and --local/);
		} finally {
			restore();
		}
	});

	// Unknown --agent → printWrongAgentError fires; propagates SilentError
	it('--agent <unknown> → propagates SilentError from setup-flow', async () => {
		runNonInteractiveConfigureAdd.mockRejectedValueOnce(
			new SilentError(new Error('unknown agent "typo"')),
		);
		const cli = buildCli();
		const restore = silenceStdio();
		try {
			await expect(runCli(cli, ['configure', '--agent', 'typo'])).rejects.toThrow(
				/unknown agent "typo"/,
			);
		} finally {
			restore();
		}
	});

	// Unknown --remove → printWrongAgentError fires; propagates SilentError
	it('--remove <unknown> → propagates SilentError from setup-flow', async () => {
		uninstallAgentHooks.mockRejectedValueOnce(new SilentError(new Error('unknown agent "typo"')));
		const cli = buildCli();
		const restore = silenceStdio();
		try {
			await expect(runCli(cli, ['configure', '--remove', 'typo'])).rejects.toThrow(
				/unknown agent "typo"/,
			);
		} finally {
			restore();
		}
	});

	// Setup alias works identically
	it('`setup` alias runs the configure action', async () => {
		const cli = buildCli();
		const restore = silenceStdio();
		try {
			await runCli(cli, ['setup', '--agent', 'cursor']);
		} finally {
			restore();
		}
		expect(runNonInteractiveConfigureAdd).toHaveBeenCalledTimes(1);
	});

	// --checkpoint-remote alone → strategy-only path
	it('--checkpoint-remote alone routes to runUpdateStrategyOptions', async () => {
		const cli = buildCli();
		const restore = silenceStdio();
		try {
			await runCli(cli, ['configure', '--checkpoint-remote', 'github:acme/cp']);
		} finally {
			restore();
		}
		expect(runUpdateStrategyOptions).toHaveBeenCalledTimes(1);
		expect(runUpdateStrategyOptions.mock.calls[0]![0]).toMatchObject({
			checkpointRemote: 'github:acme/cp',
		});
	});

	// Not a git repo
	it('outside a git repo → SilentError("Not a git repository")', async () => {
		const { default: fs } = await import('node:fs/promises');
		const { default: os } = await import('node:os');
		const { default: path } = await import('node:path');
		const notGit = await fs.mkdtemp(path.join(os.tmpdir(), 'story-nogit-'));
		const { clearWorktreeRootCache } = await import('@/paths');
		clearWorktreeRootCache();
		process.chdir(notGit);
		try {
			const cli = buildCli();
			const restore = silenceStdio();
			try {
				await expect(runCli(cli, ['configure'])).rejects.toThrow(/Not a git repository/);
			} finally {
				restore();
			}
		} finally {
			process.chdir(env.dir);
			clearWorktreeRootCache();
			await fs.rm(notGit, { recursive: true, force: true });
		}
	});
});
