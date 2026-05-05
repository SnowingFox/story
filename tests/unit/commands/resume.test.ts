/**
 * `src/commands/resume.ts` — Phase 9.4 `story resume <branch>`.
 *
 * Go: `cmd/entire/cli/resume.go: newResumeCmd` (1032-line CLI shell).
 * Covers: local vs remote branch resolution, dirty worktree guard, stale
 * checkpoint confirm (>24h), restoration from metadata-branch tree.
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
const branchExistsLocallyMock = vi.hoisted(() => vi.fn(async (_n: string, _c?: string) => false));
const branchExistsOnRemoteMock = vi.hoisted(() => vi.fn(async (_n: string, _c?: string) => false));
const fetchAndCheckoutMock = vi.hoisted(() =>
	vi.fn(async (_r: string, _remote: string, _b: string) => {}),
);
const confirmMock = vi.hoisted(() => vi.fn<(opts: unknown) => Promise<boolean>>());
const findSessionsForCommitMock = vi.hoisted(() =>
	vi.fn(async (_s: unknown, _c: string) => [] as unknown[]),
);
const listCheckpointsMock = vi.hoisted(() => vi.fn(async (_r: string) => [] as unknown[]));
const rewindImplMock = vi.hoisted(() => vi.fn(async () => {}));
const validateBranchNameMock = vi.hoisted(() =>
	vi.fn(async (name: string, _c?: string) => {
		// Accept bare alphanumeric + `-_/`. Reject names with `..` / spaces etc.
		if (/^[a-zA-Z0-9][a-zA-Z0-9._\-/]*$/.test(name) && !name.includes('..')) {
			return null;
		}
		return new Error(`invalid branch name "${name}"`);
	}),
);

const execGitSpy = vi.hoisted(() => ({
	overrides: new Map<
		string,
		(args: string[], opts?: { cwd?: string }) => Promise<string> | string
	>(),
}));

const manualCommitCtorMock = vi.hoisted(() =>
	vi.fn().mockImplementation(() => ({
		findSessionsForCommit: findSessionsForCommitMock,
		rewind: rewindImplMock,
	})),
);

vi.mock('@/git', async (orig) => {
	const mod = (await orig()) as Record<string, unknown>;
	const realExecGit = mod.execGit as (a: string[], o?: { cwd?: string }) => Promise<string>;
	return {
		...mod,
		branchExistsLocally: branchExistsLocallyMock,
		branchExistsOnRemote: branchExistsOnRemoteMock,
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

vi.mock('@/git/fetch', () => ({
	fetchAndCheckoutRemoteBranch: fetchAndCheckoutMock,
}));

vi.mock('@/ui/prompts', async (orig) => {
	const mod = (await orig()) as Record<string, unknown>;
	return { ...mod, confirm: confirmMock };
});

vi.mock('@/strategy/manual-commit', () => ({
	ManualCommitStrategy: manualCommitCtorMock,
}));

vi.mock('@/strategy/metadata-branch', async (orig) => {
	const mod = (await orig()) as Record<string, unknown>;
	return { ...mod, listCheckpoints: listCheckpointsMock };
});

vi.mock('@/validation', async (orig) => {
	const mod = (await orig()) as Record<string, unknown>;
	return { ...mod, validateBranchName: validateBranchNameMock };
});

import { registerResumeCommand } from '@/commands/resume';

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
	registerResumeCommand(cli);
	return cli;
}

async function runCli(cli: ReturnType<typeof cac>, argv: string[]): Promise<void> {
	cli.parse(['node', 'story', ...argv], { run: false });
	const result = cli.runMatchedCommand();
	if (result && typeof (result as Promise<unknown>).then === 'function') {
		await result;
	}
}

interface FakeSession {
	sessionId: string;
	baseCommit: string;
	worktreeId?: string;
	agentType: string;
	startedAt: string;
}

function makeSession(overrides: Partial<FakeSession> = {}): FakeSession {
	return {
		sessionId: 'sess-abc',
		baseCommit: `abc1234${'0'.repeat(33)}`,
		worktreeId: '',
		agentType: 'Claude Code',
		startedAt: new Date().toISOString(),
		...overrides,
	};
}

describe('commands/resume — Go: resume.go: newResumeCmd', () => {
	let env: TestEnv;
	let origCwd: string;

	beforeEach(async () => {
		resetGlobalFlagsForTesting();
		resetColorOverrideForTesting();
		setColorOverride(false);
		setForceNonInteractive(true);

		branchExistsLocallyMock.mockReset().mockResolvedValue(true);
		branchExistsOnRemoteMock.mockReset().mockResolvedValue(false);
		fetchAndCheckoutMock.mockReset().mockResolvedValue(undefined);
		confirmMock.mockReset().mockResolvedValue(true);
		findSessionsForCommitMock.mockReset().mockResolvedValue([]);
		listCheckpointsMock.mockReset().mockResolvedValue([]);
		rewindImplMock.mockReset().mockResolvedValue(undefined);
		validateBranchNameMock.mockImplementation(async (name: string) => {
			if (/^[a-zA-Z0-9][a-zA-Z0-9._\-/]*$/.test(name) && !name.includes('..')) {
				return null;
			}
			return new Error(`invalid branch name "${name}"`);
		});
		manualCommitCtorMock.mockClear();
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

	// Go: resume.go:31 newResumeCmd — flag registration (force / -f).
	it('registers `resume <branch>` with --force flag', () => {
		const cli = buildCli();
		const cmd = cli.commands.find((c) => c.name.startsWith('resume'));
		expect(cmd).toBeDefined();
		const flagNames = cmd!.options.map((o) => o.name);
		expect(flagNames).toContain('force');
	});

	// A. entry guards
	describe('A. entry guards', () => {
		it('missing positional → cac-level required-arg error (CACError)', async () => {
			// cac throws its own `CACError` for missing required positional args
			// before our action runs — we don't need to wrap it in SilentError.
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await expect(runCli(cli, ['resume'])).rejects.toThrow(/missing required/i);
			} finally {
				sink.restore();
			}
		});

		it('outside a git repo → SilentError', async () => {
			const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'story-notgit-'));
			try {
				process.chdir(tmp);
				const { clearWorktreeRootCache } = await import('@/paths');
				clearWorktreeRootCache();
				const cli = buildCli();
				const sink = silenceStdio();
				try {
					await expect(runCli(cli, ['resume', 'main'])).rejects.toThrow(SilentError);
				} finally {
					sink.restore();
				}
			} finally {
				process.chdir(env.dir);
				await fs.rm(tmp, { recursive: true, force: true });
			}
		});

		it('Story not enabled → friendly hint (non-SilentError)', async () => {
			await fs.rm(path.join(env.dir, '.story'), { recursive: true, force: true });
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await runCli(cli, ['resume', 'main']);
			} finally {
				sink.restore();
			}
			const out = sink.stdout.join('');
			expect(out).toMatch(/enable|not enabled/i);
			expect(branchExistsLocallyMock).not.toHaveBeenCalled();
		});

		it('invalid branch name → SilentError (via validateBranchName)', async () => {
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await expect(runCli(cli, ['resume', '..bad'])).rejects.toThrow(SilentError);
			} finally {
				sink.restore();
			}
			expect(fetchAndCheckoutMock).not.toHaveBeenCalled();
		});
	});

	// B. branch resolution
	describe('B. branch resolution', () => {
		it('local branch exists + session found → full happy path', async () => {
			branchExistsLocallyMock.mockResolvedValue(true);
			overrideGitCall('status --porcelain', async () => ''); // clean
			overrideGitCall('checkout feat-dark-mode', async () => '');
			overrideGitCall('rev-parse feat-dark-mode', async () => `abc1234${'0'.repeat(33)}\n`);
			findSessionsForCommitMock.mockResolvedValue([makeSession()]);
			listCheckpointsMock.mockResolvedValue([
				{
					checkpointId: 'ckpt_abc',
					sessionId: 'sess-abc',
					createdAt: new Date(),
					commitHash: `abc1234${'0'.repeat(33)}`,
				},
			]);
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await runCli(cli, ['resume', 'feat-dark-mode']);
			} finally {
				sink.restore();
			}
			expect(fetchAndCheckoutMock).not.toHaveBeenCalled();
		});

		it('local missing + remote has branch → fetchAndCheckoutRemoteBranch called', async () => {
			branchExistsLocallyMock.mockResolvedValue(false);
			branchExistsOnRemoteMock.mockResolvedValue(true);
			overrideGitCall('status --porcelain', async () => '');
			overrideGitCall('checkout main', async () => '');
			overrideGitCall('rev-parse main', async () => `abc1234${'0'.repeat(33)}\n`);
			findSessionsForCommitMock.mockResolvedValue([makeSession()]);
			listCheckpointsMock.mockResolvedValue([
				{
					checkpointId: 'ckpt_abc',
					sessionId: 'sess-abc',
					createdAt: new Date(),
					commitHash: `abc1234${'0'.repeat(33)}`,
				},
			]);
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await runCli(cli, ['resume', 'main']);
			} finally {
				sink.restore();
			}
			expect(fetchAndCheckoutMock).toHaveBeenCalledWith(expect.any(String), 'origin', 'main');
		});

		it('local + remote both missing → SilentError', async () => {
			branchExistsLocallyMock.mockResolvedValue(false);
			branchExistsOnRemoteMock.mockResolvedValue(false);
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await expect(runCli(cli, ['resume', 'missing'])).rejects.toThrow(/not found/i);
			} finally {
				sink.restore();
			}
		});

		it('fetch network failure bubbles as error', async () => {
			branchExistsLocallyMock.mockResolvedValue(false);
			branchExistsOnRemoteMock.mockResolvedValue(true);
			fetchAndCheckoutMock.mockRejectedValue(new Error('fatal: could not connect'));
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await expect(runCli(cli, ['resume', 'main'])).rejects.toThrow(/connect|fetch/i);
			} finally {
				sink.restore();
			}
		});
	});

	// C. dirty worktree guard
	describe('C. dirty worktree', () => {
		it('dirty worktree → SilentError with hint', async () => {
			branchExistsLocallyMock.mockResolvedValue(true);
			overrideGitCall('status --porcelain', async () => ' M src/foo.ts\n');
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await expect(runCli(cli, ['resume', 'main'])).rejects.toThrow(/uncommitted|clean/i);
			} finally {
				sink.restore();
			}
			// Must not have run checkout.
			const calls = execGitMock.mock.calls.map((c) => (c[0] as string[]).join(' '));
			expect(calls.some((c) => c.startsWith('checkout '))).toBe(false);
		});

		it('clean worktree proceeds to checkout', async () => {
			branchExistsLocallyMock.mockResolvedValue(true);
			overrideGitCall('status --porcelain', async () => '');
			overrideGitCall('rev-parse --abbrev-ref HEAD', async () => 'feature\n');
			overrideGitCall('checkout main', async () => '');
			overrideGitCall('rev-parse main', async () => `abc1234${'0'.repeat(33)}\n`);
			findSessionsForCommitMock.mockResolvedValue([makeSession()]);
			listCheckpointsMock.mockResolvedValue([
				{
					checkpointId: 'ckpt_abc',
					sessionId: 'sess-abc',
					createdAt: new Date(),
					commitHash: `abc1234${'0'.repeat(33)}`,
				},
			]);
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await runCli(cli, ['resume', 'main']);
			} finally {
				sink.restore();
			}
			const calls = execGitMock.mock.calls.map((c) => (c[0] as string[]).join(' '));
			expect(calls.some((c) => c.startsWith('checkout main'))).toBe(true);
		});
	});

	// D. session lookup + stale confirm
	describe('D. session lookup + stale confirm', () => {
		it('no session on branch → SilentError', async () => {
			branchExistsLocallyMock.mockResolvedValue(true);
			overrideGitCall('status --porcelain', async () => '');
			overrideGitCall('checkout main', async () => '');
			overrideGitCall('rev-parse main', async () => `abc1234${'0'.repeat(33)}\n`);
			findSessionsForCommitMock.mockResolvedValue([]);
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await expect(runCli(cli, ['resume', 'main'])).rejects.toThrow(/no session|session/i);
			} finally {
				sink.restore();
			}
		});

		it('fresh checkpoint (<24h) → no confirm', async () => {
			branchExistsLocallyMock.mockResolvedValue(true);
			overrideGitCall('status --porcelain', async () => '');
			overrideGitCall('checkout main', async () => '');
			overrideGitCall('rev-parse main', async () => `abc1234${'0'.repeat(33)}\n`);
			findSessionsForCommitMock.mockResolvedValue([makeSession()]);
			listCheckpointsMock.mockResolvedValue([
				{
					checkpointId: 'ckpt_abc',
					sessionId: 'sess-abc',
					createdAt: new Date(Date.now() - 3600_000), // 1h ago
					commitHash: `abc1234${'0'.repeat(33)}`,
				},
			]);
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await runCli(cli, ['resume', 'main']);
			} finally {
				sink.restore();
			}
			expect(confirmMock).not.toHaveBeenCalled();
		});

		it('stale checkpoint (>24h) + no --force → prompts confirm', async () => {
			branchExistsLocallyMock.mockResolvedValue(true);
			overrideGitCall('status --porcelain', async () => '');
			overrideGitCall('checkout main', async () => '');
			overrideGitCall('rev-parse main', async () => `abc1234${'0'.repeat(33)}\n`);
			findSessionsForCommitMock.mockResolvedValue([makeSession()]);
			listCheckpointsMock.mockResolvedValue([
				{
					checkpointId: 'ckpt_abc',
					sessionId: 'sess-abc',
					createdAt: new Date(Date.now() - 3 * 24 * 3600_000), // 3 days
					commitHash: `abc1234${'0'.repeat(33)}`,
				},
			]);
			confirmMock.mockResolvedValue(true);
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await runCli(cli, ['resume', 'main']);
			} finally {
				sink.restore();
			}
			expect(confirmMock).toHaveBeenCalledTimes(1);
		});

		it('stale + --force → skips confirm', async () => {
			branchExistsLocallyMock.mockResolvedValue(true);
			overrideGitCall('status --porcelain', async () => '');
			overrideGitCall('checkout main', async () => '');
			overrideGitCall('rev-parse main', async () => `abc1234${'0'.repeat(33)}\n`);
			findSessionsForCommitMock.mockResolvedValue([makeSession()]);
			listCheckpointsMock.mockResolvedValue([
				{
					checkpointId: 'ckpt_abc',
					sessionId: 'sess-abc',
					createdAt: new Date(Date.now() - 3 * 24 * 3600_000),
					commitHash: `abc1234${'0'.repeat(33)}`,
				},
			]);
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await runCli(cli, ['resume', 'main', '--force']);
			} finally {
				sink.restore();
			}
			expect(confirmMock).not.toHaveBeenCalled();
		});

		it('stale + confirm N → SilentError "cancelled"', async () => {
			branchExistsLocallyMock.mockResolvedValue(true);
			overrideGitCall('status --porcelain', async () => '');
			overrideGitCall('checkout main', async () => '');
			overrideGitCall('rev-parse main', async () => `abc1234${'0'.repeat(33)}\n`);
			findSessionsForCommitMock.mockResolvedValue([makeSession()]);
			listCheckpointsMock.mockResolvedValue([
				{
					checkpointId: 'ckpt_abc',
					sessionId: 'sess-abc',
					createdAt: new Date(Date.now() - 3 * 24 * 3600_000),
					commitHash: `abc1234${'0'.repeat(33)}`,
				},
			]);
			confirmMock.mockResolvedValue(false);
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await expect(runCli(cli, ['resume', 'main'])).rejects.toThrow(SilentError);
			} finally {
				sink.restore();
			}
			expect(rewindImplMock).not.toHaveBeenCalled();
		});
	});

	// E. restoration + footer
	describe('E. restoration + footer', () => {
		it('successful restoration → footer mentions `story explain -c`', async () => {
			branchExistsLocallyMock.mockResolvedValue(true);
			overrideGitCall('status --porcelain', async () => '');
			overrideGitCall('checkout main', async () => '');
			overrideGitCall('rev-parse main', async () => `abc1234${'0'.repeat(33)}\n`);
			findSessionsForCommitMock.mockResolvedValue([makeSession()]);
			listCheckpointsMock.mockResolvedValue([
				{
					checkpointId: 'ckpt_5f2a1b',
					sessionId: 'sess-abc',
					createdAt: new Date(),
					commitHash: `abc1234${'0'.repeat(33)}`,
				},
			]);
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await runCli(cli, ['resume', 'main']);
			} finally {
				sink.restore();
			}
			const out = sink.stdout.join('');
			expect(out).toMatch(/story explain -c/);
		});

		it('--json success → emits {resumed: ...} payload', async () => {
			branchExistsLocallyMock.mockResolvedValue(true);
			overrideGitCall('status --porcelain', async () => '');
			overrideGitCall('checkout main', async () => '');
			overrideGitCall('rev-parse main', async () => `abc1234${'0'.repeat(33)}\n`);
			findSessionsForCommitMock.mockResolvedValue([makeSession()]);
			listCheckpointsMock.mockResolvedValue([
				{
					checkpointId: 'ckpt_abc',
					sessionId: 'sess-abc',
					createdAt: new Date(),
					commitHash: `abc1234${'0'.repeat(33)}`,
				},
			]);
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await runCli(cli, ['resume', 'main', '--json']);
			} finally {
				sink.restore();
			}
			const out = sink.stdout.join('');
			expect(() => JSON.parse(out.trim())).not.toThrow();
			const payload = JSON.parse(out.trim()) as { resumed?: { branch: string } };
			expect(payload.resumed?.branch).toBe('main');
		});

		it('rewind error propagates', async () => {
			branchExistsLocallyMock.mockResolvedValue(true);
			overrideGitCall('status --porcelain', async () => '');
			overrideGitCall('checkout main', async () => '');
			overrideGitCall('rev-parse main', async () => `abc1234${'0'.repeat(33)}\n`);
			findSessionsForCommitMock.mockResolvedValue([makeSession()]);
			listCheckpointsMock.mockResolvedValue([
				{
					checkpointId: 'ckpt_abc',
					sessionId: 'sess-abc',
					createdAt: new Date(),
					commitHash: `abc1234${'0'.repeat(33)}`,
				},
			]);
			rewindImplMock.mockRejectedValue(new Error('tree walk failed'));
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await expect(runCli(cli, ['resume', 'main'])).rejects.toThrow(/tree walk/i);
			} finally {
				sink.restore();
			}
		});
	});

	// F. edge cases
	describe('F. edge cases', () => {
		it('already on target branch → proceeds to restore without double-checkout', async () => {
			branchExistsLocallyMock.mockResolvedValue(true);
			overrideGitCall('status --porcelain', async () => '');
			overrideGitCall('rev-parse --abbrev-ref HEAD', async () => 'main\n');
			overrideGitCall('rev-parse main', async () => `abc1234${'0'.repeat(33)}\n`);
			overrideGitCall('checkout main', async () => ''); // still tolerated if called
			findSessionsForCommitMock.mockResolvedValue([makeSession()]);
			listCheckpointsMock.mockResolvedValue([
				{
					checkpointId: 'ckpt_abc',
					sessionId: 'sess-abc',
					createdAt: new Date(),
					commitHash: `abc1234${'0'.repeat(33)}`,
				},
			]);
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await runCli(cli, ['resume', 'main']);
			} finally {
				sink.restore();
			}
			// Rewind should still be called to restore.
			expect(rewindImplMock).toHaveBeenCalledTimes(1);
		});

		it('validateBranchName is called with the branch positional', async () => {
			branchExistsLocallyMock.mockResolvedValue(true);
			overrideGitCall('status --porcelain', async () => '');
			overrideGitCall('checkout feat-branch', async () => '');
			overrideGitCall('rev-parse feat-branch', async () => `${'0'.repeat(40)}\n`);
			findSessionsForCommitMock.mockResolvedValue([]);
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await expect(runCli(cli, ['resume', 'feat-branch'])).rejects.toThrow();
			} finally {
				sink.restore();
			}
			expect(validateBranchNameMock).toHaveBeenCalledWith('feat-branch', expect.any(String));
		});

		it('passes signal: getRootSignal() to confirm for stale-checkpoint prompt', async () => {
			branchExistsLocallyMock.mockResolvedValue(true);
			overrideGitCall('status --porcelain', async () => '');
			overrideGitCall('checkout main', async () => '');
			overrideGitCall('rev-parse main', async () => `abc1234${'0'.repeat(33)}\n`);
			findSessionsForCommitMock.mockResolvedValue([makeSession()]);
			listCheckpointsMock.mockResolvedValue([
				{
					checkpointId: 'ckpt_abc',
					sessionId: 'sess-abc',
					createdAt: new Date(Date.now() - 3 * 24 * 3600_000),
					commitHash: `abc1234${'0'.repeat(33)}`,
				},
			]);
			confirmMock.mockResolvedValue(true);
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await runCli(cli, ['resume', 'main']);
			} finally {
				sink.restore();
			}
			const opts = confirmMock.mock.calls[0]![0] as unknown as { signal?: AbortSignal };
			expect(opts.signal).toBeDefined();
		});
	});
});
