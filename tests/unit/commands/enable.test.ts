/**
 * Phase 9.1 `src/commands/enable.ts` unit tests.
 *
 * Keeps the cac wiring honest: registration → flag parsing → dispatch into
 * the right `setup-flow` entry. `setup-flow` itself is mocked so these tests
 * run fast and don't double-up on the branch coverage already owned by
 * `setup-flow.test.ts`.
 *
 * Go: setup.go: newEnableCmd / newSetupGitHookCmd + flag validation.
 */

import cac from 'cac';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { register, withTestRegistry } from '@/agent/registry';
import type { AgentName, AgentType } from '@/agent/types';
import { registerGlobalFlags, resetGlobalFlagsForTesting } from '@/cli/flags';
import { setForceNonInteractive } from '@/cli/tty';
import { registerEnableCommand } from '@/commands/enable';
import { SilentError } from '@/errors';
import { resetColorOverrideForTesting, setColorOverride } from '@/ui/theme';
import { assertCwdIsNotStoryRepo, TestEnv } from '../../helpers/test-env';
import { mockHookSupport } from '../agent/_helpers';

// Hoisted mocks for setup-flow + hooks/install so we can spy on dispatch.
// vitest's `vi.mock()` is hoisted above imports; we use `vi.hoisted()` to
// create the fakes in the same hoist pass so the mock factory sees real
// function references instead of `undefined`.
const { runInteractiveEnable, runNonInteractiveEnable, installGitHooks, hookSettingsFromConfig } =
	vi.hoisted(() => ({
		runInteractiveEnable: vi.fn().mockResolvedValue(undefined),
		runNonInteractiveEnable: vi.fn().mockResolvedValue(undefined),
		installGitHooks: vi.fn().mockResolvedValue(5),
		hookSettingsFromConfig: vi.fn().mockResolvedValue({ localDev: false, absoluteHookPath: false }),
	}));

vi.mock('@/commands/setup-flow', () => ({
	runInteractiveEnable,
	runNonInteractiveEnable,
}));
vi.mock('@/hooks/install', () => ({
	installGitHooks,
	hookSettingsFromConfig,
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

function buildCliWithEnable(): ReturnType<typeof cac> {
	const cli = cac('story');
	registerGlobalFlags(cli);
	registerEnableCommand(cli);
	return cli;
}

/**
 * Parse + await the matched async action. cac's `parse()` by default fires
 * the action but doesn't return the promise; `{ run: false }` + manual
 * `runMatchedCommand()` gives us the awaitable handle we need to catch
 * rejections in tests.
 */
async function runCli(cli: ReturnType<typeof cac>, argv: string[]): Promise<void> {
	cli.parse(['node', 'story', ...argv], { run: false });
	const result = cli.runMatchedCommand();
	if (result && typeof (result as Promise<unknown>).then === 'function') {
		await result;
	}
}

describe('commands/enable', () => {
	let env: TestEnv;
	let origCwd: string;

	beforeEach(async () => {
		resetGlobalFlagsForTesting();
		resetColorOverrideForTesting();
		setColorOverride(false);
		setForceNonInteractive(true);
		// Reset call history AND re-install default resolved values —
		// mockClear alone drops the resolvedValue on Bun's test runner.
		runInteractiveEnable.mockReset().mockResolvedValue(undefined);
		runNonInteractiveEnable.mockReset().mockResolvedValue(undefined);
		installGitHooks.mockReset().mockResolvedValue(5);
		hookSettingsFromConfig
			.mockReset()
			.mockResolvedValue({ localDev: false, absoluteHookPath: false });

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
		// Do NOT call `vi.restoreAllMocks()` — it would wipe the hoisted
		// fakes' resolved values. `beforeEach` re-seeds per-test history.
	});

	// Go: setup.go: newEnableCmd — basic wiring check
	it('registers `enable` with 10 flags', () => {
		const cli = buildCliWithEnable();
		const enable = cli.commands.find((c) => c.name === 'enable');
		expect(enable).toBeDefined();
		const flagNames = enable!.options.map((o) => o.name);
		// cac normalizes kebab-case → camelCase on the option name.
		for (const flag of [
			'agent',
			'local',
			'project',
			'force',
			'skipPushSessions',
			'checkpointRemote',
			'telemetry',
			'absoluteGitHookPath',
			'ignoreUntracked',
			'localDev',
		]) {
			expect(flagNames).toContain(flag);
		}
	});

	// Go: setup.go: newEnableCmd — routes --agent to the non-interactive path
	it('--agent <name> dispatches to runNonInteractiveEnable', async () => {
		await withTestRegistry(async () => {
			register('claude-code' as AgentName, () =>
				mockHookSupport({
					name: () => 'claude-code' as AgentName,
					type: () => 'Claude Code' as AgentType,
				}),
			);
			const cli = buildCliWithEnable();
			const restore = silenceStdio();
			try {
				await runCli(cli, ['enable', '--agent', 'claude-code', '--local']);
			} finally {
				restore();
			}
			expect(runNonInteractiveEnable).toHaveBeenCalledTimes(1);
			const opts = runNonInteractiveEnable.mock.calls[0]![0];
			expect(opts).toMatchObject({
				agentName: 'claude-code',
				scope: 'local',
				force: false,
			});
		});
	});

	// Go: setup.go: newEnableCmd — bad --agent (cac-level error for missing value).
	// cac enforces `--agent <name>` takes a value, so `--agent=` with empty string
	// fails at cac parse time with `option `--agent <name>` value is missing`.
	// This case validates we don't swallow that CACError by accident.
	it('--agent with missing value → CAC error surfaces (not silenced)', async () => {
		const cli = buildCliWithEnable();
		const restore = silenceStdio();
		try {
			await expect(runCli(cli, ['enable', '--agent='])).rejects.toThrow(/value is missing/);
		} finally {
			restore();
		}
	});

	// Go: setup.go: validateSetupFlags — --local + --project conflict
	it('--local + --project → SilentError ("cannot specify both --project and --local")', async () => {
		const cli = buildCliWithEnable();
		const restore = silenceStdio();
		try {
			await expect(
				runCli(cli, ['enable', '--agent', 'claude-code', '--local', '--project']),
			).rejects.toThrow(/cannot specify both --project and --local/);
		} finally {
			restore();
		}
	});

	// Go: setup.go: newEnableCmd — unknown --agent → printWrongAgentError
	it('--agent <unknown> → SilentError that printWrongAgentError fired', async () => {
		await withTestRegistry(async () => {
			register('claude-code' as AgentName, () =>
				mockHookSupport({
					name: () => 'claude-code' as AgentName,
					type: () => 'Claude Code' as AgentType,
				}),
			);
			runNonInteractiveEnable.mockRejectedValueOnce(
				new SilentError(new Error('unknown agent "no-such-agent"')),
			);

			const cli = buildCliWithEnable();
			const restore = silenceStdio();
			try {
				await expect(runCli(cli, ['enable', '--agent', 'no-such-agent'])).rejects.toThrow(
					/unknown agent "no-such-agent"/,
				);
			} finally {
				restore();
			}
		});
	});

	// Go: setup.go: newEnableCmd + runEnable — already-setup + bare enable
	// short-circuits to "already enabled" message.
	it('already setup + bare enable → prints friendly "already enabled" message', async () => {
		await env.writeFile('.story/settings.json', '{"enabled": true}');
		const cli = buildCliWithEnable();
		const restore = silenceStdio();
		try {
			await runCli(cli, ['enable']);
		} finally {
			restore();
		}
		expect(runInteractiveEnable).not.toHaveBeenCalled();
		expect(runNonInteractiveEnable).not.toHaveBeenCalled();
	});

	// Already setup + --force still triggers the interactive manage path
	it('already setup + --force → runInteractiveEnable is called', async () => {
		await env.writeFile('.story/settings.json', '{"enabled": true}');
		const cli = buildCliWithEnable();
		const restore = silenceStdio();
		try {
			await runCli(cli, ['enable', '--force']);
		} finally {
			restore();
		}
		expect(runInteractiveEnable).toHaveBeenCalledTimes(1);
	});

	// Go: setup.go: newEnableCmd — fresh repo → interactive flow
	it('fresh repo + bare enable → runInteractiveEnable', async () => {
		const cli = buildCliWithEnable();
		const restore = silenceStdio();
		try {
			await runCli(cli, ['enable']);
		} finally {
			restore();
		}
		expect(runInteractiveEnable).toHaveBeenCalledTimes(1);
	});

	// Not a git repo path
	it('outside a git repo → SilentError("Not a git repository")', async () => {
		const { default: fs } = await import('node:fs/promises');
		const { default: os } = await import('node:os');
		const { default: path } = await import('node:path');
		const notGit = await fs.mkdtemp(path.join(os.tmpdir(), 'story-nogit-'));
		// Clear the cached worktreeRoot from beforeEach().
		const { clearWorktreeRootCache } = await import('@/paths');
		clearWorktreeRootCache();
		process.chdir(notGit);
		try {
			const cli = buildCliWithEnable();
			const restore = silenceStdio();
			try {
				await expect(runCli(cli, ['enable'])).rejects.toThrow(/Not a git repository/);
			} finally {
				restore();
			}
		} finally {
			process.chdir(env.dir);
			clearWorktreeRootCache();
			await fs.rm(notGit, { recursive: true, force: true });
		}
	});

	// Go: setup.go: newSetupGitHookCmd — minimal-output helper
	it('`enable git-hook` installs hooks via installGitHooks + hookSettingsFromConfig', async () => {
		const cli = buildCliWithEnable();
		const restore = silenceStdio();
		try {
			await runCli(cli, ['enable', 'git-hook']);
		} finally {
			restore();
		}
		expect(hookSettingsFromConfig).toHaveBeenCalledTimes(1);
		expect(installGitHooks).toHaveBeenCalledTimes(1);
		const opts = installGitHooks.mock.calls[0]![1] as Record<string, unknown>;
		expect(opts).toMatchObject({ silent: false, localDev: false, absolutePath: false });
		expect(runInteractiveEnable).not.toHaveBeenCalled();
		expect(runNonInteractiveEnable).not.toHaveBeenCalled();
	});

	// --json + already-enabled → JSON output
	it('--json + already-enabled → single JSON line on stdout', async () => {
		await env.writeFile('.story/settings.json', '{"enabled": true}');
		const cli = buildCliWithEnable();

		const chunks: string[] = [];
		const orig = process.stdout.write.bind(process.stdout);
		process.stdout.write = ((c: string | Uint8Array) => {
			chunks.push(typeof c === 'string' ? c : Buffer.from(c).toString('utf8'));
			return true;
		}) as typeof process.stdout.write;
		const origErr = process.stderr.write.bind(process.stderr);
		process.stderr.write = (() => true) as typeof process.stderr.write;
		try {
			await runCli(cli, ['enable', '--json']);
		} finally {
			process.stdout.write = orig;
			process.stderr.write = origErr;
		}

		const combined = chunks.join('');
		const match = combined.match(/\{[^\n}]*"enabled":\s*true[^\n}]*\}/);
		expect(match).not.toBeNull();
	});

	// Agent-specific flags propagate through to runNonInteractiveEnable
	it('--skip-push-sessions / --checkpoint-remote / --telemetry flags propagate to the flow', async () => {
		await withTestRegistry(async () => {
			register('claude-code' as AgentName, () =>
				mockHookSupport({
					name: () => 'claude-code' as AgentName,
					type: () => 'Claude Code' as AgentType,
				}),
			);
			const cli = buildCliWithEnable();
			const restore = silenceStdio();
			try {
				await runCli(cli, [
					'enable',
					'--agent',
					'claude-code',
					'--skip-push-sessions',
					'--checkpoint-remote',
					'github:acme/cp',
					'--no-telemetry',
				]);
			} finally {
				restore();
			}
			const opts = runNonInteractiveEnable.mock.calls[0]![0];
			expect(opts).toMatchObject({
				agentName: 'claude-code',
				skipPushSessions: true,
				checkpointRemote: 'github:acme/cp',
				telemetry: false,
			});
		});
	});
});
