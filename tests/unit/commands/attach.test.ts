/**
 * `src/commands/attach.ts` — Phase 9.4 `story attach <session-id>`.
 *
 * Go: `cmd/entire/cli/attach.go: newAttachCmd` (453-line CLI shell).
 *
 * **Scope**: This MVP port focuses on the git-plumbing side (amend HEAD
 * with Story-* trailers) + session-state update. The transcript →
 * metadata-branch write path is shared with Phase 4.3/4.4 writers and
 * exercised by Phase 5.3/5.4 tests; here we mock it out so the CLI
 * orchestration tests stay focused.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import cac from 'cac';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerGlobalFlags, resetGlobalFlagsForTesting } from '@/cli/flags';
import { setForceNonInteractive } from '@/cli/tty';
import { SilentError } from '@/errors';
import { resetColorOverrideForTesting, setColorOverride } from '@/ui/theme';
import { assertCwdIsNotStoryRepo, TestEnv } from '../../helpers/test-env';

// Hoisted mocks
const resolveSessionIdPrefixMock = vi.hoisted(() =>
	vi.fn(async (prefix: string, _c?: string) => prefix),
);
const loadSessionStateMock = vi.hoisted(() =>
	vi.fn(async (_r: string, _id: string) => null as unknown),
);
const confirmMock = vi.hoisted(() => vi.fn<(opts: unknown) => Promise<boolean>>());
// detectAll returns Agent[] objects; test mocks use a minimal shape where
// `.name()` returns the agent's type string (matches real Agent contract).
type MockAgent = { name: () => string };
const detectAllMock = vi.hoisted(() => vi.fn<() => Promise<MockAgent[]>>());

const execGitSpy = vi.hoisted(() => ({
	overrides: new Map<
		string,
		(args: string[], opts?: { cwd?: string }) => Promise<string> | string
	>(),
}));

vi.mock('@/commands/_shared/session-list', () => ({
	resolveSessionIdPrefix: resolveSessionIdPrefixMock,
}));

vi.mock('@/strategy/session-state', async (orig) => {
	const mod = (await orig()) as Record<string, unknown>;
	return { ...mod, loadSessionState: loadSessionStateMock };
});

vi.mock('@/agent/registry', async (orig) => {
	const mod = (await orig()) as Record<string, unknown>;
	return {
		...mod,
		detectAll: detectAllMock,
		// Retain real getByAgentType for session-list's enrichment path.
	};
});

vi.mock('@/ui/prompts', async (orig) => {
	const mod = (await orig()) as Record<string, unknown>;
	return { ...mod, confirm: confirmMock };
});

vi.mock('@/git', async (orig) => {
	const mod = (await orig()) as Record<string, unknown>;
	const realExecGit = mod.execGit as (args: string[], opts?: { cwd?: string }) => Promise<string>;
	return {
		...mod,
		execGit: vi.fn(async (args: string[], opts?: { cwd?: string }) => {
			const key = args.join(' ');
			for (const [k, fn] of execGitSpy.overrides) {
				if (key === k || key.startsWith(`${k} `)) {
					return await fn(args, opts);
				}
			}
			return realExecGit(args, opts);
		}),
	};
});

import { registerAttachCommand } from '@/commands/attach';

import { execGit } from '@/git';

const execGitMock = execGit as unknown as ReturnType<typeof vi.fn>;

function overrideGitCall(
	key: string,
	fn: (args: string[], opts?: { cwd?: string }) => Promise<string> | string,
): void {
	execGitSpy.overrides.set(key, fn);
}

function clearGitOverrides(): void {
	execGitSpy.overrides.clear();
}

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
	registerAttachCommand(cli);
	return cli;
}

async function runCli(cli: ReturnType<typeof cac>, argv: string[]): Promise<void> {
	cli.parse(['node', 'story', ...argv], { run: false });
	const result = cli.runMatchedCommand();
	if (result && typeof (result as Promise<unknown>).then === 'function') {
		await result;
	}
}

describe('commands/attach — Go: attach.go: newAttachCmd', () => {
	let env: TestEnv;
	let origCwd: string;

	beforeEach(async () => {
		resetGlobalFlagsForTesting();
		resetColorOverrideForTesting();
		setColorOverride(false);
		setForceNonInteractive(true);

		resolveSessionIdPrefixMock.mockReset().mockImplementation(async (p: string) => p);
		loadSessionStateMock.mockReset().mockResolvedValue(null);
		confirmMock.mockReset().mockResolvedValue(true);
		detectAllMock.mockReset().mockResolvedValue([{ name: () => 'Claude Code' }]);
		clearGitOverrides();
		execGitMock.mockClear();

		const { clearWorktreeRootCache } = await import('@/paths');
		clearWorktreeRootCache();
		env = await TestEnv.create({ initialCommit: true });
		origCwd = process.cwd();
		process.chdir(env.dir);
		clearWorktreeRootCache();
		assertCwdIsNotStoryRepo();
		await env.writeFile('.story/settings.json', '{"enabled": true}');
	});

	afterEach(async () => {
		process.chdir(origCwd);
		await env.cleanup();
		resetGlobalFlagsForTesting();
		resetColorOverrideForTesting();
		setForceNonInteractive(false);
	});

	// Go: attach.go:38-73 newAttachCmd — flag + positional arg registration.
	it('registers `attach <session-id>` with --force + --agent flags', () => {
		const cli = buildCli();
		const cmd = cli.commands.find((c) => c.name.startsWith('attach'));
		expect(cmd).toBeDefined();
		const flagNames = cmd!.options.map((o) => o.name);
		expect(flagNames).toContain('force');
		expect(flagNames).toContain('agent');
	});

	// A. entry guards
	describe('A. entry guards', () => {
		it('outside git repo → SilentError', async () => {
			const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'story-notgit-'));
			try {
				process.chdir(tmp);
				const { clearWorktreeRootCache } = await import('@/paths');
				clearWorktreeRootCache();
				const cli = buildCli();
				const sink = silenceStdio();
				try {
					await expect(runCli(cli, ['attach', 'sess-abc'])).rejects.toThrow(SilentError);
				} finally {
					sink.restore();
				}
			} finally {
				process.chdir(env.dir);
				await fs.rm(tmp, { recursive: true, force: true });
			}
		});

		it('session prefix not found → SilentError', async () => {
			resolveSessionIdPrefixMock.mockRejectedValue(
				new SilentError(new Error("session 'nope' not found")),
			);
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await expect(runCli(cli, ['attach', 'nope'])).rejects.toThrow(SilentError);
			} finally {
				sink.restore();
			}
		});

		it('ambiguous prefix → SilentError (surfaces resolver error)', async () => {
			resolveSessionIdPrefixMock.mockRejectedValue(
				new SilentError(new Error('ambiguous session id: matches 3 sessions')),
			);
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await expect(runCli(cli, ['attach', 'sess-'])).rejects.toThrow(/ambiguous/i);
			} finally {
				sink.restore();
			}
		});
	});

	// B. HEAD state
	describe('B. HEAD state', () => {
		it('dirty worktree → SilentError (not overridden by --force)', async () => {
			loadSessionStateMock.mockResolvedValue({
				sessionId: 'sess-abc',
				agentType: 'Claude Code',
			});
			overrideGitCall('status --porcelain', async () => ' M foo.ts\n');
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await expect(runCli(cli, ['attach', 'sess-abc', '--force'])).rejects.toThrow(
					/uncommitted|clean/i,
				);
			} finally {
				sink.restore();
			}
			// Must not have run amend.
			const calls = execGitMock.mock.calls.map((c) => (c[0] as string[]).join(' '));
			expect(calls.some((c) => c.startsWith('commit --amend'))).toBe(false);
		});

		it('HEAD already has Story-Checkpoint trailer + no --force → SilentError', async () => {
			loadSessionStateMock.mockResolvedValue({
				sessionId: 'sess-abc',
				agentType: 'Claude Code',
			});
			overrideGitCall('status --porcelain', async () => '');
			overrideGitCall(
				'log -1 --format=%B HEAD',
				async () => 'feat: prior work\n\nStory-Checkpoint: abcdefabcdef\nStory-Session: sess-old\n',
			);
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await expect(runCli(cli, ['attach', 'sess-abc'])).rejects.toThrow(/already has|trailer/i);
			} finally {
				sink.restore();
			}
		});

		it('HEAD has trailer + --force → allows overwrite (amend runs)', async () => {
			loadSessionStateMock.mockResolvedValue({
				sessionId: 'sess-abc',
				agentType: 'Claude Code',
			});
			overrideGitCall('status --porcelain', async () => '');
			overrideGitCall(
				'log -1 --format=%B HEAD',
				async () => 'feat: prior work\n\nStory-Checkpoint: abcdefabcdef\nStory-Session: sess-old\n',
			);
			overrideGitCall('commit --amend', async () => '');
			overrideGitCall('rev-parse HEAD', async () => `${'0'.repeat(40)}\n`);
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await runCli(cli, ['attach', 'sess-abc', '--force']);
			} finally {
				sink.restore();
			}
			const calls = execGitMock.mock.calls.map((c) => (c[0] as string[]).join(' '));
			expect(calls.some((c) => c.startsWith('commit --amend'))).toBe(true);
		});
	});

	// C. confirm flow
	describe('C. confirm flow', () => {
		// Go: attach.go:183-214 runAttach final steps — 3 Story-* trailers via amend.
		it('happy path: confirm Y → amend with 3 trailers', async () => {
			loadSessionStateMock.mockResolvedValue({
				sessionId: 'sess-abc',
				agentType: 'Claude Code',
			});
			overrideGitCall('status --porcelain', async () => '');
			overrideGitCall('log -1 --format=%B HEAD', async () => 'feat: prior work\n');
			overrideGitCall('commit --amend', async () => '');
			overrideGitCall('rev-parse HEAD', async () => `${'0'.repeat(40)}\n`);
			confirmMock.mockResolvedValue(true);
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await runCli(cli, ['attach', 'sess-abc']);
			} finally {
				sink.restore();
			}
			expect(confirmMock).toHaveBeenCalledTimes(1);
			const amendCalls = execGitMock.mock.calls
				.map((c) => c[0] as string[])
				.filter((a) => a[0] === 'commit');
			const trailerFlags = amendCalls.flat().filter((s) => s.includes('Story-'));
			expect(trailerFlags.some((s) => s.startsWith('Story-Checkpoint'))).toBe(true);
			expect(trailerFlags.some((s) => s.startsWith('Story-Session'))).toBe(true);
			expect(trailerFlags.some((s) => s.startsWith('Story-Agent'))).toBe(true);
		});

		it('confirm N → SilentError "cancelled"', async () => {
			loadSessionStateMock.mockResolvedValue({
				sessionId: 'sess-abc',
				agentType: 'Claude Code',
			});
			overrideGitCall('status --porcelain', async () => '');
			overrideGitCall('log -1 --format=%B HEAD', async () => 'feat: prior work\n');
			confirmMock.mockResolvedValue(false);
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await expect(runCli(cli, ['attach', 'sess-abc'])).rejects.toThrow(SilentError);
			} finally {
				sink.restore();
			}
			const calls = execGitMock.mock.calls.map((c) => (c[0] as string[]).join(' '));
			expect(calls.some((c) => c.startsWith('commit --amend'))).toBe(false);
		});

		it('--force skips confirm', async () => {
			loadSessionStateMock.mockResolvedValue({
				sessionId: 'sess-abc',
				agentType: 'Claude Code',
			});
			overrideGitCall('status --porcelain', async () => '');
			overrideGitCall('log -1 --format=%B HEAD', async () => 'feat: prior work\n');
			overrideGitCall('commit --amend', async () => '');
			overrideGitCall('rev-parse HEAD', async () => `${'0'.repeat(40)}\n`);
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await runCli(cli, ['attach', 'sess-abc', '--force']);
			} finally {
				sink.restore();
			}
			expect(confirmMock).not.toHaveBeenCalled();
			const calls = execGitMock.mock.calls.map((c) => (c[0] as string[]).join(' '));
			expect(calls.some((c) => c.startsWith('commit --amend'))).toBe(true);
		});
	});

	// D. agent resolution
	describe('D. agent resolution', () => {
		// Go: attach.go:67 agentFlag precedence — explicit --agent wins over auto-detect.
		it('--agent explicit → uses it, no auto-detect', async () => {
			loadSessionStateMock.mockResolvedValue({
				sessionId: 'sess-abc',
				agentType: 'Claude Code', // state has a type but --agent overrides
			});
			overrideGitCall('status --porcelain', async () => '');
			overrideGitCall('log -1 --format=%B HEAD', async () => 'feat: work\n');
			overrideGitCall('commit --amend', async () => '');
			overrideGitCall('rev-parse HEAD', async () => `${'0'.repeat(40)}\n`);
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await runCli(cli, ['attach', 'sess-abc', '--force', '--agent', 'Cursor']);
			} finally {
				sink.restore();
			}
			expect(detectAllMock).not.toHaveBeenCalled();
			const amendArgs = execGitMock.mock.calls
				.map((c) => c[0] as string[])
				.find((a) => a[0] === 'commit');
			const trailers = (amendArgs ?? []).filter((s) => s.startsWith('Story-'));
			expect(trailers.some((s) => s === 'Story-Agent: Cursor')).toBe(true);
		});

		it('session state provides agentType → use it (no detect call)', async () => {
			loadSessionStateMock.mockResolvedValue({
				sessionId: 'sess-abc',
				agentType: 'Claude Code',
			});
			overrideGitCall('status --porcelain', async () => '');
			overrideGitCall('log -1 --format=%B HEAD', async () => 'feat: work\n');
			overrideGitCall('commit --amend', async () => '');
			overrideGitCall('rev-parse HEAD', async () => `${'0'.repeat(40)}\n`);
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await runCli(cli, ['attach', 'sess-abc', '--force']);
			} finally {
				sink.restore();
			}
			expect(detectAllMock).not.toHaveBeenCalled();
		});

		it('no state + no --agent → auto-detect; single match wins', async () => {
			loadSessionStateMock.mockResolvedValue(null);
			detectAllMock.mockResolvedValue([{ name: () => 'Cursor' }]);
			overrideGitCall('status --porcelain', async () => '');
			overrideGitCall('log -1 --format=%B HEAD', async () => 'feat: work\n');
			overrideGitCall('commit --amend', async () => '');
			overrideGitCall('rev-parse HEAD', async () => `${'0'.repeat(40)}\n`);
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await runCli(cli, ['attach', 'sess-abc', '--force']);
			} finally {
				sink.restore();
			}
			expect(detectAllMock).toHaveBeenCalled();
		});

		it('no state + detectAll returns 0 → SilentError', async () => {
			loadSessionStateMock.mockResolvedValue(null);
			detectAllMock.mockResolvedValue([]);
			overrideGitCall('status --porcelain', async () => '');
			overrideGitCall('log -1 --format=%B HEAD', async () => 'feat: work\n');
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await expect(runCli(cli, ['attach', 'sess-abc'])).rejects.toThrow(/agent|--agent/i);
			} finally {
				sink.restore();
			}
		});

		it('no state + detectAll returns >1 → SilentError (ambiguous)', async () => {
			loadSessionStateMock.mockResolvedValue(null);
			detectAllMock.mockResolvedValue([{ name: () => 'Claude Code' }, { name: () => 'Cursor' }]);
			overrideGitCall('status --porcelain', async () => '');
			overrideGitCall('log -1 --format=%B HEAD', async () => 'feat: work\n');
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await expect(runCli(cli, ['attach', 'sess-abc'])).rejects.toThrow(/ambiguous|--agent/i);
			} finally {
				sink.restore();
			}
		});
	});

	// E. output contract
	describe('E. output contract', () => {
		it('footer hint contains `story explain -c`', async () => {
			loadSessionStateMock.mockResolvedValue({
				sessionId: 'sess-abc',
				agentType: 'Claude Code',
			});
			overrideGitCall('status --porcelain', async () => '');
			overrideGitCall('log -1 --format=%B HEAD', async () => 'feat: work\n');
			overrideGitCall('commit --amend', async () => '');
			overrideGitCall('rev-parse HEAD', async () => `${'0'.repeat(40)}\n`);
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await runCli(cli, ['attach', 'sess-abc', '--force']);
			} finally {
				sink.restore();
			}
			const out = sink.stdout.join('');
			expect(out).toMatch(/story explain -c/);
		});

		it('--json success → {attached: ...} payload', async () => {
			loadSessionStateMock.mockResolvedValue({
				sessionId: 'sess-abc',
				agentType: 'Claude Code',
			});
			overrideGitCall('status --porcelain', async () => '');
			overrideGitCall('log -1 --format=%B HEAD', async () => 'feat: work\n');
			overrideGitCall('commit --amend', async () => '');
			overrideGitCall('rev-parse HEAD', async () => `deadbeef${'0'.repeat(32)}\n`);
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await runCli(cli, ['attach', 'sess-abc', '--force', '--json']);
			} finally {
				sink.restore();
			}
			const out = sink.stdout.join('');
			expect(() => JSON.parse(out.trim())).not.toThrow();
			const payload = JSON.parse(out.trim()) as {
				attached?: { sessionId: string; checkpoint: string };
			};
			expect(payload.attached?.sessionId).toBe('sess-abc');
			expect(payload.attached?.checkpoint).toMatch(/^[0-9a-f]{12}$/);
		});

		it('passes signal: getRootSignal() to confirm', async () => {
			loadSessionStateMock.mockResolvedValue({
				sessionId: 'sess-abc',
				agentType: 'Claude Code',
			});
			overrideGitCall('status --porcelain', async () => '');
			overrideGitCall('log -1 --format=%B HEAD', async () => 'feat: work\n');
			overrideGitCall('commit --amend', async () => '');
			overrideGitCall('rev-parse HEAD', async () => `${'0'.repeat(40)}\n`);
			confirmMock.mockResolvedValue(true);
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await runCli(cli, ['attach', 'sess-abc']);
			} finally {
				sink.restore();
			}
			const opts = confirmMock.mock.calls[0]![0] as unknown as { signal?: AbortSignal };
			expect(opts.signal).toBeDefined();
		});

		it('amend failure propagates', async () => {
			loadSessionStateMock.mockResolvedValue({
				sessionId: 'sess-abc',
				agentType: 'Claude Code',
			});
			overrideGitCall('status --porcelain', async () => '');
			overrideGitCall('log -1 --format=%B HEAD', async () => 'feat: work\n');
			overrideGitCall('commit --amend', async () => {
				throw new Error('fatal: no changes to amend');
			});
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await expect(runCli(cli, ['attach', 'sess-abc', '--force'])).rejects.toThrow(/amend/i);
			} finally {
				sink.restore();
			}
		});
	});
});
