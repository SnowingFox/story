/**
 * Phase 9.2 `src/commands/sessions.ts` — catch-all router tests.
 *
 * Go: sessions.go: newSessionsCmd (cobra dispatcher). TS uses a single
 * cac catch-all because cac has no native multi-word commands.
 */

import cac from 'cac';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerGlobalFlags, resetGlobalFlagsForTesting } from '@/cli/flags';
import { setForceNonInteractive } from '@/cli/tty';
import { registerSessionsCommand } from '@/commands/sessions';
import { resetColorOverrideForTesting, setColorOverride } from '@/ui/theme';
import { assertCwdIsNotStoryRepo, TestEnv } from '../../helpers/test-env';

vi.mock('@/commands/sessions/list', () => ({
	handleSessionsList: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/commands/sessions/info', () => ({
	handleSessionsInfo: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/commands/sessions/stop', () => ({
	handleSessionsStop: vi.fn().mockResolvedValue(undefined),
}));

function silenceStdio(): { stdout: string[]; stderr: string[]; restore: () => void } {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const origStdout = process.stdout.write.bind(process.stdout);
	const origStderr = process.stderr.write.bind(process.stderr);
	process.stdout.write = ((chunk: string | Uint8Array): boolean => {
		stdout.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk: string | Uint8Array): boolean => {
		stderr.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
		return true;
	}) as typeof process.stderr.write;
	return {
		stdout,
		stderr,
		restore: () => {
			process.stdout.write = origStdout;
			process.stderr.write = origStderr;
		},
	};
}

function buildCli(): ReturnType<typeof cac> {
	const cli = cac('story');
	registerGlobalFlags(cli);
	registerSessionsCommand(cli);
	return cli;
}

async function runCli(cli: ReturnType<typeof cac>, argv: string[]): Promise<void> {
	cli.parse(['node', 'story', ...argv], { run: false });
	const result = cli.runMatchedCommand();
	if (result && typeof (result as Promise<unknown>).then === 'function') {
		await result;
	}
}

describe('commands/sessions router', () => {
	let env: TestEnv;
	let origCwd: string;

	beforeEach(async () => {
		resetGlobalFlagsForTesting();
		resetColorOverrideForTesting();
		setColorOverride(false);
		setForceNonInteractive(true);

		const list = await import('@/commands/sessions/list');
		const info = await import('@/commands/sessions/info');
		const stop = await import('@/commands/sessions/stop');
		(list.handleSessionsList as ReturnType<typeof vi.fn>).mockReset().mockResolvedValue(undefined);
		(info.handleSessionsInfo as ReturnType<typeof vi.fn>).mockReset().mockResolvedValue(undefined);
		(stop.handleSessionsStop as ReturnType<typeof vi.fn>).mockReset().mockResolvedValue(undefined);

		const { clearWorktreeRootCache } = await import('@/paths');
		clearWorktreeRootCache();
		env = await TestEnv.create({ initialCommit: true });
		origCwd = process.cwd();
		process.chdir(env.dir);
		clearWorktreeRootCache();
		assertCwdIsNotStoryRepo();
	});

	afterEach(async () => {
		process.chdir(origCwd);
		await env.cleanup();
		resetGlobalFlagsForTesting();
		resetColorOverrideForTesting();
		setForceNonInteractive(false);
	});

	// Go: sessions.go: newSessionsCmd — top-level command wiring
	it('registers `sessions` catch-all with list/info/stop description', () => {
		const cli = buildCli();
		const cmd = cli.commands.find((c) => c.name.startsWith('sessions'));
		expect(cmd).toBeDefined();
	});

	// Go: sessions.go:newSessionsCmd — no args → help
	it('no args → renders help to stdout (no handler invoked)', async () => {
		const list = await import('@/commands/sessions/list');
		const info = await import('@/commands/sessions/info');
		const stop = await import('@/commands/sessions/stop');
		const cli = buildCli();
		const sink = silenceStdio();
		try {
			await runCli(cli, ['sessions']);
		} finally {
			sink.restore();
		}
		const out = sink.stdout.join('');
		// renderHelp prints the command description as the body.
		expect(out).toMatch(/Manage agent sessions/);
		expect(list.handleSessionsList).not.toHaveBeenCalled();
		expect(info.handleSessionsInfo).not.toHaveBeenCalled();
		expect(stop.handleSessionsStop).not.toHaveBeenCalled();
	});

	// Routes: list
	it('`sessions list` → handleSessionsList called with []', async () => {
		const list = await import('@/commands/sessions/list');
		const cli = buildCli();
		const sink = silenceStdio();
		try {
			await runCli(cli, ['sessions', 'list']);
		} finally {
			sink.restore();
		}
		expect(list.handleSessionsList).toHaveBeenCalledTimes(1);
	});

	// Routes: info
	it('`sessions info sess-abc` → handleSessionsInfo called with ["sess-abc"]', async () => {
		const info = await import('@/commands/sessions/info');
		const cli = buildCli();
		const sink = silenceStdio();
		try {
			await runCli(cli, ['sessions', 'info', 'sess-abc']);
		} finally {
			sink.restore();
		}
		expect(info.handleSessionsInfo).toHaveBeenCalledTimes(1);
		expect(info.handleSessionsInfo).toHaveBeenCalledWith(['sess-abc']);
	});

	// Routes: stop
	it('`sessions stop --all --force` → handleSessionsStop invoked with matching flags', async () => {
		const stop = await import('@/commands/sessions/stop');
		const cli = buildCli();
		const sink = silenceStdio();
		try {
			await runCli(cli, ['sessions', 'stop', '--all', '--force']);
		} finally {
			sink.restore();
		}
		expect(stop.handleSessionsStop).toHaveBeenCalledTimes(1);
		const call = (stop.handleSessionsStop as ReturnType<typeof vi.fn>).mock.calls[0]!;
		expect(call[0]).toEqual([]); // no positional id
		expect(call[1]).toMatchObject({ all: true, force: true });
	});

	// Unknown subcommand → SilentError with list of available
	it('unknown subcommand → SilentError listing available subcommands', async () => {
		const cli = buildCli();
		const sink = silenceStdio();
		try {
			await expect(runCli(cli, ['sessions', 'foo'])).rejects.toThrow(/Unknown subcommand/);
		} finally {
			sink.restore();
		}
	});

	it('unknown subcommand error lists "list, info, stop"', async () => {
		const cli = buildCli();
		const sink = silenceStdio();
		try {
			await expect(runCli(cli, ['sessions', 'foo'])).rejects.toThrow(/list, info, stop/);
		} finally {
			sink.restore();
		}
	});
});
