/**
 * `src/commands/explain.ts` — Phase 9.4 `story explain`.
 *
 * Go: `cmd/entire/cli/explain.go: newExplainCmd` (1903-line CLI shell
 * with pager management + Unicode rendering + diff formatting). The TS
 * port collapses the pager logic (Story ships `--no-pager` on by default,
 * TS-divergence #8) and reuses Phase 5.1 / 5.5 helpers for metadata +
 * transcript reads.
 *
 * Tests cover the 5 flag-routing surfaces:
 *   A. flag registration + mutex guards
 *   B. locator routing (--commit / --checkpoint / --session / default)
 *   C. density routing (--short / --full / --raw-transcript / default)
 *   D. --generate path (surfaces Phase 5.3 stub = null → SilentError)
 *   E. rendering correctness (card fields, footer hints, JSON payload)
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
const listCheckpointsMock = vi.hoisted(() =>
	vi.fn(
		async (_r: string) =>
			[] as Array<{
				checkpointId: string;
				sessionId: string;
				createdAt: Date;
				commitHash?: string;
				agent?: string;
			}>,
	),
);
const getSessionLogMock = vi.hoisted(() =>
	vi.fn(async (_r: string, _c: string) => null as unknown),
);
const getAssociatedCommitsMock = vi.hoisted(() =>
	vi.fn(async (_r: string, _cp: string, _all: boolean) => [] as unknown[]),
);
const selectMock = vi.hoisted(() => vi.fn<(opts: unknown) => Promise<unknown>>());
const generateSummaryMock = vi.hoisted(() => vi.fn(async () => null as unknown));

const execGitSpy = vi.hoisted(() => ({
	overrides: new Map<
		string,
		(args: string[], opts?: { cwd?: string }) => Promise<string> | string
	>(),
}));

vi.mock('@/strategy/metadata-branch', async (orig) => {
	const mod = (await orig()) as Record<string, unknown>;
	return { ...mod, listCheckpoints: listCheckpointsMock };
});

vi.mock('@/commands/_shared/session-log', async (orig) => {
	const mod = (await orig()) as Record<string, unknown>;
	return { ...mod, getSessionLog: getSessionLogMock };
});

vi.mock('@/commands/_shared/associated-commits', async (orig) => {
	const mod = (await orig()) as Record<string, unknown>;
	return { ...mod, getAssociatedCommits: getAssociatedCommitsMock };
});

vi.mock('@/ui/prompts', async (orig) => {
	const mod = (await orig()) as Record<string, unknown>;
	return { ...mod, select: selectMock };
});

vi.mock('@/strategy/summary-stub', () => ({
	generateSummary: generateSummaryMock,
}));

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

import { registerExplainCommand, truncateDisplay } from '@/commands/explain';

function _overrideGitCall(
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
	registerExplainCommand(cli);
	return cli;
}

async function runCli(cli: ReturnType<typeof cac>, argv: string[]): Promise<void> {
	cli.parse(['node', 'story', ...argv], { run: false });
	const result = cli.runMatchedCommand();
	if (result && typeof (result as Promise<unknown>).then === 'function') {
		await result;
	}
}

function makeCheckpoint(
	overrides: Partial<{
		checkpointId: string;
		sessionId: string;
		createdAt: Date;
		commitHash: string;
		agent: string;
	}> = {},
) {
	return {
		checkpointId: 'ckpt_default123',
		sessionId: 'sess-default',
		createdAt: new Date('2026-04-22T14:00:00Z'),
		commitHash: `${'a'.repeat(40)}`,
		agent: 'Claude Code',
		...overrides,
	};
}

describe('commands/explain — Go: explain.go: newExplainCmd', () => {
	let env: TestEnv;
	let origCwd: string;

	beforeEach(async () => {
		resetGlobalFlagsForTesting();
		resetColorOverrideForTesting();
		setColorOverride(false);
		setForceNonInteractive(true);

		listCheckpointsMock.mockReset().mockResolvedValue([]);
		getSessionLogMock.mockReset().mockResolvedValue(null);
		getAssociatedCommitsMock.mockReset().mockResolvedValue([]);
		selectMock.mockReset();
		generateSummaryMock.mockReset().mockResolvedValue(null);
		clearGitOverrides();

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

	// A. flag registration + mutex guards (~9 case)
	// Go: explain.go:200 newExplainCmd cmd.Flags() + explain.go:321 runExplain early validation.
	describe('A. flag registration + mutex', () => {
		// Go: explain.go:296-309 newExplainCmd — registers 9 flags total
		// (session / commit / checkpoint / no-pager / short / full /
		// raw-transcript / generate / force / search-all). Story mirrors
		// all 9 after Phase 9.4 review A1 restore.
		it('registers explain with 9 flags including search-all', () => {
			const cli = buildCli();
			const cmd = cli.commands.find((c) => c.name === 'explain');
			expect(cmd).toBeDefined();
			const flagNames = cmd!.options.map((o) => o.name);
			expect(flagNames).toContain('session');
			expect(flagNames).toContain('commit');
			expect(flagNames).toContain('checkpoint');
			expect(flagNames).toContain('short');
			expect(flagNames).toContain('full');
			expect(flagNames).toContain('rawTranscript');
			expect(flagNames).toContain('generate');
			expect(flagNames).toContain('force');
			expect(flagNames).toContain('searchAll');
		});

		it('--short + --full → SilentError "mutually exclusive"', async () => {
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await expect(runCli(cli, ['explain', '--short', '--full'])).rejects.toThrow(
					/mutually exclusive|density/i,
				);
			} finally {
				sink.restore();
			}
		});

		it('--short + --raw-transcript → SilentError', async () => {
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await expect(runCli(cli, ['explain', '--short', '--raw-transcript'])).rejects.toThrow(
					/mutually exclusive|density/i,
				);
			} finally {
				sink.restore();
			}
		});

		it('--full + --raw-transcript → SilentError', async () => {
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await expect(runCli(cli, ['explain', '--full', '--raw-transcript'])).rejects.toThrow(
					/mutually exclusive|density/i,
				);
			} finally {
				sink.restore();
			}
		});

		it('--generate without --checkpoint → SilentError', async () => {
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await expect(runCli(cli, ['explain', '--generate'])).rejects.toThrow(/--checkpoint/i);
			} finally {
				sink.restore();
			}
		});

		it('--force without --generate → SilentError', async () => {
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await expect(runCli(cli, ['explain', '--force', '-c', 'ckpt_abc'])).rejects.toThrow(
					/--generate/i,
				);
			} finally {
				sink.restore();
			}
		});

		it('--generate + --raw-transcript → SilentError', async () => {
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await expect(
					runCli(cli, ['explain', '--generate', '-c', 'ckpt_abc', '--raw-transcript']),
				).rejects.toThrow(/mutually exclusive|--generate/i);
			} finally {
				sink.restore();
			}
		});

		it('outside git repo → SilentError', async () => {
			const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'story-notgit-'));
			try {
				process.chdir(tmp);
				const { clearWorktreeRootCache } = await import('@/paths');
				clearWorktreeRootCache();
				const cli = buildCli();
				const sink = silenceStdio();
				try {
					await expect(runCli(cli, ['explain'])).rejects.toThrow(SilentError);
				} finally {
					sink.restore();
				}
			} finally {
				process.chdir(env.dir);
				await fs.rm(tmp, { recursive: true, force: true });
			}
		});

		it('not enabled → friendly hint (non-SilentError)', async () => {
			await fs.rm(path.join(env.dir, '.story'), { recursive: true, force: true });
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await runCli(cli, ['explain']);
			} finally {
				sink.restore();
			}
			const out = sink.stdout.join('');
			expect(out).toMatch(/enable|not enabled/i);
		});

		it("settings 'enabled: false' → configure hint (non-SilentError)", async () => {
			await env.writeFile('.story/settings.json', '{"enabled": false}');
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await runCli(cli, ['explain']);
			} finally {
				sink.restore();
			}
			const out = sink.stdout.join('');
			expect(out).toMatch(/configure|enabled: false/i);
		});
	});

	// B. locator routing (~6 case)
	describe('B. locator routing', () => {
		it('no checkpoints on branch → SilentError', async () => {
			listCheckpointsMock.mockResolvedValue([]);
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await expect(runCli(cli, ['explain'])).rejects.toThrow(/no checkpoint/i);
			} finally {
				sink.restore();
			}
		});

		it('-c <id> exact match → direct render (no select)', async () => {
			listCheckpointsMock.mockResolvedValue([makeCheckpoint({ checkpointId: 'ckpt_abc123' })]);
			getSessionLogMock.mockResolvedValue({
				transcript: new TextEncoder().encode('hello'),
				sessionId: 'sess-default',
			});
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await runCli(cli, ['explain', '-c', 'ckpt_abc123']);
			} finally {
				sink.restore();
			}
			expect(selectMock).not.toHaveBeenCalled();
			expect(getSessionLogMock).toHaveBeenCalledWith(expect.any(String), 'ckpt_abc123');
		});

		it('-c <prefix> unique match → resolves to full id', async () => {
			listCheckpointsMock.mockResolvedValue([makeCheckpoint({ checkpointId: 'ckpt_abcd12345' })]);
			getSessionLogMock.mockResolvedValue({
				transcript: new TextEncoder().encode('x'),
				sessionId: 'sess-default',
			});
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await runCli(cli, ['explain', '-c', 'ckpt_abcd']);
			} finally {
				sink.restore();
			}
			expect(getSessionLogMock).toHaveBeenCalledWith(expect.any(String), 'ckpt_abcd12345');
		});

		it('-c <prefix> ambiguous (multi match) → SilentError', async () => {
			listCheckpointsMock.mockResolvedValue([
				makeCheckpoint({ checkpointId: 'ckpt_abc111' }),
				makeCheckpoint({ checkpointId: 'ckpt_abc222' }),
			]);
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await expect(runCli(cli, ['explain', '-c', 'ckpt_abc'])).rejects.toThrow(/ambiguous/i);
			} finally {
				sink.restore();
			}
		});

		it('-c <unknown> → SilentError', async () => {
			listCheckpointsMock.mockResolvedValue([makeCheckpoint()]);
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await expect(runCli(cli, ['explain', '-c', 'ckpt_nope'])).rejects.toThrow(/not found/i);
			} finally {
				sink.restore();
			}
		});

		it('--session <id> filters to that session + uses select', async () => {
			listCheckpointsMock.mockResolvedValue([
				makeCheckpoint({ checkpointId: 'ckpt_a', sessionId: 'sess-1' }),
				makeCheckpoint({ checkpointId: 'ckpt_b', sessionId: 'sess-2' }),
			]);
			selectMock.mockResolvedValue('ckpt_a');
			getSessionLogMock.mockResolvedValue({
				transcript: new TextEncoder().encode('x'),
				sessionId: 'sess-1',
			});
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await runCli(cli, ['explain', '--session', 'sess-1']);
			} finally {
				sink.restore();
			}
			expect(selectMock).toHaveBeenCalledTimes(1);
			const opts = selectMock.mock.calls[0]![0] as unknown as {
				options: Array<{ value: string }>;
			};
			// Only sess-1 checkpoints shown
			expect(opts.options).toHaveLength(1);
			expect(opts.options[0]?.value).toBe('ckpt_a');
		});
	});

	// C. density routing (~4 case)
	describe('C. density routing', () => {
		beforeEach(() => {
			listCheckpointsMock.mockResolvedValue([makeCheckpoint({ checkpointId: 'ckpt_abc' })]);
			getSessionLogMock.mockResolvedValue({
				transcript: new TextEncoder().encode(
					'{"type":"user","content":"what time is it"}\n{"type":"assistant","content":"it is 3pm"}\n',
				),
				sessionId: 'sess-default',
			});
		});

		it('default density → renders checkpoint info card', async () => {
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await runCli(cli, ['explain', '-c', 'ckpt_abc']);
			} finally {
				sink.restore();
			}
			const out = sink.stdout.join('');
			expect(out).toMatch(/ckpt_abc/);
		});

		it('--short → 2-3 line summary only', async () => {
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await runCli(cli, ['explain', '-c', 'ckpt_abc', '--short']);
			} finally {
				sink.restore();
			}
			const out = sink.stdout.join('');
			expect(out).toMatch(/ckpt_abc/);
		});

		it('--full → handles corrupt JSON lines gracefully (skip continue)', async () => {
			getSessionLogMock.mockResolvedValue({
				transcript: new TextEncoder().encode(
					'{"type":"user","content":"q"}\nNOT_JSON_CORRUPT\n{"type":"assistant","content":"a"}\n',
				),
				sessionId: 'sess-default',
			});
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await runCli(cli, ['explain', '-c', 'ckpt_abc', '--full']);
			} finally {
				sink.restore();
			}
			const out = sink.stdout.join('');
			// Should still have Turn divider + assistant render.
			expect(out).toMatch(/assistant/);
		});

		it('default density truncates very long first prompts', async () => {
			// First prompt that's >300 chars — truncate should kick in.
			const longPrompt = 'x'.repeat(600);
			getSessionLogMock.mockResolvedValue({
				transcript: new TextEncoder().encode(`{"type":"user","content":"${longPrompt}"}\n`),
				sessionId: 'sess-default',
			});
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await runCli(cli, ['explain', '-c', 'ckpt_abc']);
			} finally {
				sink.restore();
			}
			const out = sink.stdout.join('');
			// Output should contain ellipsis marking truncation.
			expect(out).toMatch(/…/);
		});

		it('--full → Turn divider in output', async () => {
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await runCli(cli, ['explain', '-c', 'ckpt_abc', '--full']);
			} finally {
				sink.restore();
			}
			const out = sink.stdout.join('');
			// `── Turn N ──` divider per impl.md rendering
			expect(out).toMatch(/Turn \d/);
		});

		it('--raw-transcript → JSONL to stdout, NO banner/bar', async () => {
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await runCli(cli, ['explain', '-c', 'ckpt_abc', '--raw-transcript']);
			} finally {
				sink.restore();
			}
			const out = sink.stdout.join('');
			expect(out).toMatch(/assistant/);
			// Must not print bar-block glyphs
			expect(out).not.toMatch(/┌|◇|●/);
		});
	});

	// D. --generate (Phase 5.3 stub returns null → SilentError)
	describe('D. --generate (Phase 11 not shipped)', () => {
		it('--generate -c <ckpt> when generateSummary returns null → SilentError hint Phase 11', async () => {
			listCheckpointsMock.mockResolvedValue([makeCheckpoint({ checkpointId: 'ckpt_abc' })]);
			getSessionLogMock.mockResolvedValue({
				transcript: new TextEncoder().encode('some transcript'),
				sessionId: 'sess-default',
			});
			generateSummaryMock.mockResolvedValue(null); // Phase 5.3 default
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await expect(runCli(cli, ['explain', '--generate', '-c', 'ckpt_abc'])).rejects.toThrow(
					/Phase 11|not yet implemented|generateSummary/i,
				);
			} finally {
				sink.restore();
			}
		});

		it('--generate + NOT_IMPLEMENTED throw propagates (production stub case)', async () => {
			listCheckpointsMock.mockResolvedValue([makeCheckpoint({ checkpointId: 'ckpt_abc' })]);
			getSessionLogMock.mockResolvedValue({
				transcript: new TextEncoder().encode('x'),
				sessionId: 'sess-default',
			});
			generateSummaryMock.mockRejectedValue(new Error('NOT_IMPLEMENTED: Phase 11'));
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await expect(runCli(cli, ['explain', '--generate', '-c', 'ckpt_abc'])).rejects.toThrow(
					/Phase 11|NOT_IMPLEMENTED/,
				);
			} finally {
				sink.restore();
			}
		});
	});

	// F. --search-all flag (Phase 9.4 review A1 restore)
	// Go: explain.go:1088-1163 getAssociatedCommits; --search-all toggles
	// commitScanLimit=500 depth vs unbounded DAG walk.
	describe('F. --search-all (associated commits scan)', () => {
		beforeEach(() => {
			listCheckpointsMock.mockResolvedValue([makeCheckpoint({ checkpointId: 'ckpt_abc' })]);
			getSessionLogMock.mockResolvedValue({
				transcript: new TextEncoder().encode('hello'),
				sessionId: 'sess-default',
			});
		});

		it('default (no flag) → getAssociatedCommits called with searchAll=false', async () => {
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await runCli(cli, ['explain', '-c', 'ckpt_abc']);
			} finally {
				sink.restore();
			}
			expect(getAssociatedCommitsMock).toHaveBeenCalledWith(expect.any(String), 'ckpt_abc', false);
		});

		it('--search-all → getAssociatedCommits called with searchAll=true', async () => {
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await runCli(cli, ['explain', '-c', 'ckpt_abc', '--search-all']);
			} finally {
				sink.restore();
			}
			expect(getAssociatedCommitsMock).toHaveBeenCalledWith(expect.any(String), 'ckpt_abc', true);
		});

		it('associated commits rendered as Associated commits block when matches found', async () => {
			getAssociatedCommitsMock.mockResolvedValue([
				{
					sha: 'a'.repeat(40),
					shortSha: 'aaaaaaa',
					message: 'feat: login',
					author: 'Alice',
					email: 'alice@example.com',
					date: new Date('2026-04-22'),
				},
				{
					sha: 'b'.repeat(40),
					shortSha: 'bbbbbbb',
					message: 'fix: redirect',
					author: 'Bob',
					email: 'bob@example.com',
					date: new Date('2026-04-22'),
				},
			]);
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await runCli(cli, ['explain', '-c', 'ckpt_abc']);
			} finally {
				sink.restore();
			}
			const out = sink.stdout.join('');
			expect(out).toMatch(/Associated commits \(2\)/);
			expect(out).toContain('aaaaaaa');
			expect(out).toContain('feat: login');
			expect(out).toContain('Alice');
		});

		it('0 matches → block hidden in default mode', async () => {
			getAssociatedCommitsMock.mockResolvedValue([]);
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await runCli(cli, ['explain', '-c', 'ckpt_abc']);
			} finally {
				sink.restore();
			}
			const out = sink.stdout.join('');
			expect(out).not.toMatch(/Associated commits/);
		});

		it('0 matches + --search-all → explicit "none found" hint shown', async () => {
			getAssociatedCommitsMock.mockResolvedValue([]);
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await runCli(cli, ['explain', '-c', 'ckpt_abc', '--search-all']);
			} finally {
				sink.restore();
			}
			const out = sink.stdout.join('');
			expect(out).toMatch(/Associated commits/);
			expect(out).toMatch(/none found/);
		});

		it('--search-all --json → associatedCommits array in JSON payload', async () => {
			getAssociatedCommitsMock.mockResolvedValue([
				{
					sha: 'a'.repeat(40),
					shortSha: 'aaaaaaa',
					message: 'feat: x',
					author: 'A',
					email: 'a@a',
					date: new Date('2026-04-22T00:00:00Z'),
				},
			]);
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await runCli(cli, ['explain', '-c', 'ckpt_abc', '--search-all', '--json']);
			} finally {
				sink.restore();
			}
			const out = sink.stdout.join('');
			const payload = JSON.parse(out.trim()) as {
				associatedCommits?: Array<{ sha: string; shortSha: string }>;
			};
			expect(payload.associatedCommits).toHaveLength(1);
			expect(payload.associatedCommits?.[0]?.shortSha).toBe('aaaaaaa');
		});

		it('overflow > 10 matches → shows "... (K more)" indicator', async () => {
			const matches = Array.from({ length: 15 }, (_, i) => ({
				sha: String(i).padStart(40, '0'),
				shortSha: String(i).padStart(7, '0'),
				message: `commit ${i}`,
				author: 'Test',
				email: 't@t',
				date: new Date('2026-04-22'),
			}));
			getAssociatedCommitsMock.mockResolvedValue(matches);
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await runCli(cli, ['explain', '-c', 'ckpt_abc']);
			} finally {
				sink.restore();
			}
			const out = sink.stdout.join('');
			expect(out).toMatch(/Associated commits \(15\)/);
			expect(out).toMatch(/\(5 more\)/);
		});
	});

	// E. output contract (~4 case)
	describe('E. output contract', () => {
		it('--json success → one-line JSON payload', async () => {
			listCheckpointsMock.mockResolvedValue([makeCheckpoint({ checkpointId: 'ckpt_abc' })]);
			getSessionLogMock.mockResolvedValue({
				transcript: new TextEncoder().encode('hello'),
				sessionId: 'sess-default',
			});
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await runCli(cli, ['explain', '-c', 'ckpt_abc', '--json']);
			} finally {
				sink.restore();
			}
			const out = sink.stdout.join('');
			expect(() => JSON.parse(out.trim())).not.toThrow();
			const payload = JSON.parse(out.trim()) as {
				checkpoint?: string;
				transcript?: string;
			};
			expect(payload.checkpoint).toBe('ckpt_abc');
		});

		it('footer hint mentions `story rewind` when default density', async () => {
			listCheckpointsMock.mockResolvedValue([makeCheckpoint({ checkpointId: 'ckpt_abc' })]);
			getSessionLogMock.mockResolvedValue({
				transcript: new TextEncoder().encode('x'),
				sessionId: 'sess-default',
			});
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await runCli(cli, ['explain', '-c', 'ckpt_abc']);
			} finally {
				sink.restore();
			}
			const out = sink.stdout.join('');
			expect(out).toMatch(/story rewind|--full/);
		});

		it('non-Latin prompt (中文) renders without crash', async () => {
			listCheckpointsMock.mockResolvedValue([makeCheckpoint({ checkpointId: 'ckpt_abc' })]);
			getSessionLogMock.mockResolvedValue({
				transcript: new TextEncoder().encode('{"type":"user","content":"你好 world"}\n'),
				sessionId: 'sess-default',
			});
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await runCli(cli, ['explain', '-c', 'ckpt_abc', '--full']);
			} finally {
				sink.restore();
			}
			const out = sink.stdout.join('');
			expect(out).toContain('你好');
		});

		it('default density — Claude flat user transcript shows first prompt', async () => {
			listCheckpointsMock.mockResolvedValue([makeCheckpoint({ checkpointId: 'ckpt_flat' })]);
			getSessionLogMock.mockResolvedValue({
				transcript: new TextEncoder().encode(
					'{"type":"user","content":"flat-prompt-hi"}\n{"type":"assistant","content":"ok"}\n',
				),
				sessionId: 'sess-default',
			});
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await runCli(cli, ['explain', '-c', 'ckpt_flat']);
			} finally {
				sink.restore();
			}
			const out = sink.stdout.join('');
			expect(out).toContain('flat-prompt-hi');
			expect(out).not.toContain('[object Object]');
		});

		it('default density — Claude multimodal user message shows text (no slice crash)', async () => {
			const line = JSON.stringify({
				type: 'user',
				message: { content: [{ type: 'text', text: 'mm-claude-line' }] },
			});
			listCheckpointsMock.mockResolvedValue([makeCheckpoint({ checkpointId: 'ckpt_mm_c' })]);
			getSessionLogMock.mockResolvedValue({
				transcript: new TextEncoder().encode(`${line}\n`),
				sessionId: 'sess-default',
			});
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await runCli(cli, ['explain', '-c', 'ckpt_mm_c']);
			} finally {
				sink.restore();
			}
			const out = sink.stdout.join('');
			expect(out).toContain('mm-claude-line');
			expect(out).not.toContain('[object Object]');
		});

		it('default density — Cursor role + multimodal content (regression: slice on object)', async () => {
			const line = JSON.stringify({
				role: 'user',
				message: { content: [{ type: 'text', text: '改一行文字' }] },
			});
			listCheckpointsMock.mockResolvedValue([makeCheckpoint({ checkpointId: 'ckpt_cursor' })]);
			getSessionLogMock.mockResolvedValue({
				transcript: new TextEncoder().encode(`${line}\n`),
				sessionId: 'sess-default',
			});
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await runCli(cli, ['explain', '-c', 'ckpt_cursor']);
			} finally {
				sink.restore();
			}
			const out = sink.stdout.join('');
			expect(out).toContain('改一行文字');
			expect(out).not.toContain('[object Object]');
		});

		it('default density — Vogon-style string message field', async () => {
			const line = JSON.stringify({ type: 'user', message: 'vogon-string-chat' });
			listCheckpointsMock.mockResolvedValue([makeCheckpoint({ checkpointId: 'ckpt_vogon' })]);
			getSessionLogMock.mockResolvedValue({
				transcript: new TextEncoder().encode(`${line}\n`),
				sessionId: 'sess-default',
			});
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await runCli(cli, ['explain', '-c', 'ckpt_vogon']);
			} finally {
				sink.restore();
			}
			const out = sink.stdout.join('');
			expect(out).toContain('vogon-string-chat');
		});

		it('--full — Cursor multimodal user + assistant renders text (no object Object)', async () => {
			const u = JSON.stringify({
				role: 'user',
				message: { content: [{ type: 'text', text: 'cursor-user' }] },
			});
			const a = JSON.stringify({
				role: 'assistant',
				message: { content: [{ type: 'text', text: 'cursor-assistant-reply' }] },
			});
			listCheckpointsMock.mockResolvedValue([makeCheckpoint({ checkpointId: 'ckpt_cur_full' })]);
			getSessionLogMock.mockResolvedValue({
				transcript: new TextEncoder().encode(`${u}\n${a}\n`),
				sessionId: 'sess-default',
			});
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await runCli(cli, ['explain', '-c', 'ckpt_cur_full', '--full']);
			} finally {
				sink.restore();
			}
			const out = sink.stdout.join('');
			expect(out).toMatch(/Turn \d/);
			expect(out).toContain('cursor-user');
			expect(out).toContain('cursor-assistant-reply');
			expect(out).not.toContain('[object Object]');
		});

		it('--full — corrupt line + binary-ish JSON string still renders other turns', async () => {
			const goodUser = JSON.stringify({ type: 'user', content: 'kept-prompt' });
			const goodAsst = JSON.stringify({ type: 'assistant', content: 'kept-asst' });
			const weird = JSON.stringify({
				type: 'user',
				content: `x${'\u0000'.repeat(2)}y`,
			});
			const transcript = `${goodUser}\nNOT_JSON\n${weird}\n${goodAsst}\n`;
			listCheckpointsMock.mockResolvedValue([makeCheckpoint({ checkpointId: 'ckpt_messy' })]);
			getSessionLogMock.mockResolvedValue({
				transcript: new TextEncoder().encode(transcript),
				sessionId: 'sess-default',
			});
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await runCli(cli, ['explain', '-c', 'ckpt_messy', '--full']);
			} finally {
				sink.restore();
			}
			const out = sink.stdout.join('');
			expect(out).toContain('kept-prompt');
			expect(out).toContain('kept-asst');
		});

		it('select in interactive mode (no locator) uses getRootSignal for signal', async () => {
			listCheckpointsMock.mockResolvedValue([
				makeCheckpoint({ checkpointId: 'ckpt_aaa' }),
				makeCheckpoint({ checkpointId: 'ckpt_bbb' }),
			]);
			selectMock.mockResolvedValue('ckpt_aaa');
			getSessionLogMock.mockResolvedValue({
				transcript: new TextEncoder().encode('x'),
				sessionId: 'sess-default',
			});
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await runCli(cli, ['explain']);
			} finally {
				sink.restore();
			}
			const opts = selectMock.mock.calls[0]![0] as unknown as { signal?: AbortSignal };
			expect(opts.signal).toBeDefined();
		});
	});

	// F. --page + --pure (Story-side AI plain-text mode).
	//
	// Rules under test (calibrated against plan 2026-04-28 brainstorming):
	//   - `--page <n>` and `--pure` only take effect together. Either flag
	//     alone is a no-op and falls back to default-density output.
	//   - `--pure --full` switches to plain-text full transcript.
	//   - `--pure --page <n>` paginates aggregated turns at 2 turns/page,
	//     and the trailer hints the next-page command (or omits it on the
	//     last page).
	//   - `--pure --short` / `--pure --raw-transcript` are mutually
	//     exclusive (clear error).
	//   - Invalid `--page` values surface a SilentError.
	describe('F. --pure + --page (AI plain text)', () => {
		const SAMPLE_THREE_TURNS = [
			'{"type":"user","content":"q1-needle"}',
			'{"type":"assistant","content":"a1-step1"}',
			'{"type":"assistant","content":"a1-step2"}',
			'{"type":"user","content":"q2-needle"}',
			'{"type":"assistant","content":"a2-only"}',
			'{"type":"user","content":"q3-needle"}',
			'{"type":"assistant","content":"a3-only"}',
		].join('\n');

		const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

		function stripAnsi(s: string): string {
			return s.replace(ANSI_RE, '');
		}

		beforeEach(() => {
			listCheckpointsMock.mockResolvedValue([makeCheckpoint({ checkpointId: 'ckpt_pure' })]);
			getSessionLogMock.mockResolvedValue({
				transcript: new TextEncoder().encode(`${SAMPLE_THREE_TURNS}\n`),
				sessionId: 'sess-default',
			});
		});

		it('--page registered as a number option with `<n>` placeholder', () => {
			const cli = buildCli();
			const cmd = cli.commands.find((c) => c.name === 'explain');
			expect(cmd).toBeDefined();
			expect(cmd!.options.map((o) => o.name)).toContain('page');
		});

		it('lone --page (no --pure) is a no-op (matches default-density output)', async () => {
			const cli = buildCli();
			const sinkA = silenceStdio();
			try {
				await runCli(cli, ['explain', '-c', 'ckpt_pure']);
			} finally {
				sinkA.restore();
			}
			const baseline = sinkA.stdout.join('');
			const sinkB = silenceStdio();
			try {
				await runCli(cli, ['explain', '-c', 'ckpt_pure', '--page', '1']);
			} finally {
				sinkB.restore();
			}
			const withPage = sinkB.stdout.join('');
			expect(withPage).toBe(baseline);
		});

		it('lone --pure (no --page / --full) is a no-op (matches default-density output)', async () => {
			const cli = buildCli();
			const sinkA = silenceStdio();
			try {
				await runCli(cli, ['explain', '-c', 'ckpt_pure']);
			} finally {
				sinkA.restore();
			}
			const baseline = sinkA.stdout.join('');
			const sinkB = silenceStdio();
			try {
				await runCli(cli, ['explain', '-c', 'ckpt_pure', '--pure']);
			} finally {
				sinkB.restore();
			}
			expect(sinkB.stdout.join('')).toBe(baseline);
		});

		it('--pure --short → SilentError (mutually exclusive)', async () => {
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await expect(
					runCli(cli, ['explain', '-c', 'ckpt_pure', '--pure', '--short']),
				).rejects.toThrow(/mutually exclusive|--pure/i);
			} finally {
				sink.restore();
			}
		});

		it('--pure --raw-transcript → SilentError (mutually exclusive)', async () => {
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await expect(
					runCli(cli, ['explain', '-c', 'ckpt_pure', '--pure', '--raw-transcript']),
				).rejects.toThrow(/mutually exclusive|--pure/i);
			} finally {
				sink.restore();
			}
		});

		it('--pure --full → plain text with no STORY banner / no bar / no ANSI', async () => {
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await runCli(cli, ['explain', '-c', 'ckpt_pure', '--pure', '--full']);
			} finally {
				sink.restore();
			}
			const out = sink.stdout.join('');
			expect(out).toContain('q1-needle');
			expect(out).toContain('q2-needle');
			expect(out).toContain('q3-needle');
			// Pure mode must not emit any ANSI escapes or bar/banner glyphs.
			expect(out).toBe(stripAnsi(out));
			expect(out).not.toMatch(/┌|│|└|◇|●|■|○/);
			expect(out).not.toMatch(/STORY|██████/);
		});

		it('--pure --page 1 (3 turns / pageSize 2) → first 2 turns + next-page hint', async () => {
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await runCli(cli, ['explain', '-c', 'ckpt_pure', '--pure', '--page', '1']);
			} finally {
				sink.restore();
			}
			const out = sink.stdout.join('');
			expect(out).toContain('q1-needle');
			expect(out).toContain('q2-needle');
			expect(out).not.toContain('q3-needle');
			// Trailer must point at the next page command for AI tooling.
			expect(out).toMatch(/--page\s*2/);
			expect(out).toBe(stripAnsi(out));
			expect(out).not.toMatch(/┌|│|└|◇|●|■|○/);
		});

		it('--pure --page 2 (3 turns / pageSize 2) → only Turn 3, no next-page hint', async () => {
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await runCli(cli, ['explain', '-c', 'ckpt_pure', '--pure', '--page', '2']);
			} finally {
				sink.restore();
			}
			const out = sink.stdout.join('');
			expect(out).toContain('q3-needle');
			expect(out).not.toContain('q1-needle');
			expect(out).not.toContain('q2-needle');
			expect(out).not.toMatch(/--page\s*3/);
		});

		it('--pure --page invalid (0 / non-integer / negative / float) → SilentError', async () => {
			const cli = buildCli();
			// cac strips the `-` of bare `-1` into a separate short flag, so we
			// pass the negative form via `=` to keep the value attached to the
			// flag.
			for (const value of ['0', 'abc', '1.5', '=-1']) {
				const argvValue = value.startsWith('=') ? `--page${value}` : `--page=${value}`;
				const sink = silenceStdio();
				try {
					await expect(
						runCli(cli, ['explain', '-c', 'ckpt_pure', '--pure', argvValue]),
					).rejects.toThrow(/--page|positive integer/i);
				} finally {
					sink.restore();
				}
			}
		});

		it('--pure --full aggregates multiple assistant entries into ONE assistant block per Turn', async () => {
			// Two assistant lines under one user prompt should not produce two
			// separate `assistant:` blocks (regression target for the
			// pre-pagination renderer that emitted one line per JSONL entry).
			getSessionLogMock.mockResolvedValue({
				transcript: new TextEncoder().encode(
					[
						'{"type":"user","content":"prompt"}',
						'{"type":"assistant","content":"thinking"}',
						'{"type":"assistant","content":"final"}',
					].join('\n'),
				),
				sessionId: 'sess-default',
			});
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await runCli(cli, ['explain', '-c', 'ckpt_pure', '--pure', '--full']);
			} finally {
				sink.restore();
			}
			const out = sink.stdout.join('');
			// `assistant:` label appears exactly once for this Turn.
			const assistantMatches = out.match(/^assistant:/gm) ?? [];
			expect(assistantMatches).toHaveLength(1);
			// Both entries' text are preserved.
			expect(out).toContain('thinking');
			expect(out).toContain('final');
		});

		it('--pure --full surfaces tool_use input (name + input only, no result)', async () => {
			getSessionLogMock.mockResolvedValue({
				transcript: new TextEncoder().encode(
					[
						'{"type":"user","content":"go"}',
						JSON.stringify({
							type: 'assistant',
							message: {
								content: [
									{ type: 'text', text: 'calling Edit' },
									{
										type: 'tool_use',
										id: 'toolu_1',
										name: 'Edit',
										input: { file_path: 'a.ts', old_string: 'x', new_string: 'y' },
									},
								],
							},
						}),
						JSON.stringify({
							type: 'user',
							message: {
								content: [
									{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'SECRET-RESULT-PAYLOAD' },
								],
							},
						}),
						'{"type":"assistant","content":"done"}',
					].join('\n'),
				),
				sessionId: 'sess-default',
			});
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await runCli(cli, ['explain', '-c', 'ckpt_pure', '--pure', '--full']);
			} finally {
				sink.restore();
			}
			const out = sink.stdout.join('');
			expect(out).toContain('Edit');
			expect(out).toContain('a.ts');
			// Tool result content must NOT be rendered.
			expect(out).not.toContain('SECRET-RESULT-PAYLOAD');
			// User-only-tool_result envelope must not produce a new Turn.
			expect(out.match(/Turn\s+\d+/g) ?? []).toHaveLength(1);
		});
	});

	describe('truncateDisplay defensive', () => {
		it('coerces array / object / undefined without throwing', () => {
			expect(() => truncateDisplay(['a', 'b'] as unknown as string, 10)).not.toThrow();
			expect(truncateDisplay(['a', 'b'] as unknown as string, 10)).toContain('a');

			expect(() => truncateDisplay({ x: 1 } as unknown as string, 20)).not.toThrow();
			expect(truncateDisplay({ x: 1 } as unknown as string, 20)).toContain('object');

			expect(truncateDisplay(undefined, 12)).toBe('undefined');
			expect(truncateDisplay(null, 8)).toBe('null');
		});

		it('string path unchanged for short + long inputs', () => {
			expect(truncateDisplay('hi', 10)).toBe('hi');
			expect(truncateDisplay('abcdefghij', 5).endsWith('…')).toBe(true);
		});
	});
});
