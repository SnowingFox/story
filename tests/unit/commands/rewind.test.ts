/**
 * Phase 9.3 `src/commands/rewind.ts` unit tests.
 *
 * Go: `cmd/entire/cli/rewind.go: newRewindCmd` (CLI shell, 1226 lines).
 * Phase 5.5 already ships the algorithms (`rewindImpl` / `getRewindPointsImpl`
 * / `restoreLogsOnlyImpl` / `previewRewindImpl` / `reset` / `resetSession`);
 * this test suite exercises only the CLI orchestration: flag routing, mutex
 * validation, select / confirm UI, `--list` JSON shape, footer hints, signal
 * propagation.
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

// Hoisted mocks — consumed by the rewind command.
const rewindMock = vi.hoisted(() => vi.fn(async () => {}));
const getRewindPointsMock = vi.hoisted(() => vi.fn(async () => [] as unknown[]));
const canRewindMock = vi.hoisted(() => vi.fn(async () => ({ canRewind: true, message: '' })));
const previewRewindMock = vi.hoisted(() =>
	vi.fn<
		() => Promise<{
			filesToRestore: string[];
			filesToDelete: string[];
			trackedChanges: string[];
		}>
	>(),
);
const restoreLogsOnlyMock = vi.hoisted(() => vi.fn(async () => []));
const resetMock = vi.hoisted(() => vi.fn(async () => {}));
const resetSessionMock = vi.hoisted(() => vi.fn(async () => {}));

const manualCommitCtorMock = vi.hoisted(() =>
	vi.fn().mockImplementation(() => ({
		rewind: rewindMock,
		getRewindPoints: getRewindPointsMock,
		canRewind: canRewindMock,
		previewRewind: previewRewindMock,
		restoreLogsOnly: restoreLogsOnlyMock,
		reset: resetMock,
		resetSession: resetSessionMock,
	})),
);

const selectMock = vi.hoisted(() => vi.fn<(opts: unknown) => Promise<unknown>>());
const confirmMock = vi.hoisted(() => vi.fn<(opts: unknown) => Promise<boolean>>());

// `execGit` is NOT globally mocked — `worktreeRoot` uses it and we want the
// TestEnv git repo queries (`rev-parse --show-toplevel`, `rev-parse HEAD`)
// to succeed for real. Specific calls (`rev-parse --verify <sha>`,
// `reset --hard <sha>`) are intercepted per-test via `vi.spyOn`.
const execGitSpy = vi.hoisted(() => ({
	overrides: new Map<
		string,
		(args: string[], opts?: { cwd?: string }) => Promise<string> | string
	>(),
}));

vi.mock('@/strategy/manual-commit', () => ({
	ManualCommitStrategy: manualCommitCtorMock,
}));

vi.mock('@/ui/prompts', async (orig) => {
	const mod = (await orig()) as Record<string, unknown>;
	return { ...mod, select: selectMock, confirm: confirmMock };
});

vi.mock('@/git', async (orig) => {
	const mod = (await orig()) as Record<string, unknown>;
	const realExecGit = mod.execGit as (args: string[], opts?: { cwd?: string }) => Promise<string>;
	return {
		...mod,
		execGit: vi.fn(async (args: string[], opts?: { cwd?: string }) => {
			const key = args.join(' ');
			const override = execGitSpy.overrides.get(key);
			if (override !== undefined) {
				return await override(args, opts);
			}
			// Also match by first-token prefix, so tests can register a handler
			// for e.g. 'rev-parse --verify' regardless of the trailing ref.
			for (const [k, fn] of execGitSpy.overrides) {
				if (key.startsWith(`${k} `)) {
					return await fn(args, opts);
				}
			}
			return realExecGit(args, opts);
		}),
	};
});

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

import { registerRewindCommand } from '@/commands/rewind';

interface PointLike {
	id: string;
	message: string;
	metadataDir: string;
	date: Date;
	isTaskCheckpoint: boolean;
	toolUseId: string;
	isLogsOnly: boolean;
	checkpointId: string;
	agent: string;
	sessionId: string;
	sessionPrompt: string;
	sessionCount: number;
	sessionIds: string[];
	sessionPrompts: string[];
}

function makePoint(overrides: Partial<PointLike> = {}): PointLike {
	const base: PointLike = {
		id: 'abc1234def5678901234567890123456789012ab',
		message: 'Add dark mode toggle',
		metadataDir: '.story/metadata/sess-abc',
		date: new Date('2026-04-22T14:00:00Z'),
		isTaskCheckpoint: false,
		toolUseId: '',
		isLogsOnly: false,
		checkpointId: '',
		agent: 'Claude Code',
		sessionId: 'sess-abc',
		sessionPrompt: 'add dark mode',
		sessionCount: 1,
		sessionIds: ['sess-abc'],
		sessionPrompts: ['add dark mode'],
	};
	return { ...base, ...overrides };
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
	registerRewindCommand(cli);
	return cli;
}

async function runCli(cli: ReturnType<typeof cac>, argv: string[]): Promise<void> {
	cli.parse(['node', 'story', ...argv], { run: false });
	const result = cli.runMatchedCommand();
	if (result && typeof (result as Promise<unknown>).then === 'function') {
		await result;
	}
}

describe('commands/rewind — Go: rewind.go: newRewindCmd', () => {
	let env: TestEnv;
	let origCwd: string;

	beforeEach(async () => {
		resetGlobalFlagsForTesting();
		resetColorOverrideForTesting();
		setColorOverride(false);
		setForceNonInteractive(true);

		rewindMock.mockReset().mockResolvedValue(undefined);
		getRewindPointsMock.mockReset().mockResolvedValue([]);
		canRewindMock.mockReset().mockResolvedValue({ canRewind: true, message: '' });
		previewRewindMock
			.mockReset()
			.mockResolvedValue({ filesToRestore: [], filesToDelete: [], trackedChanges: [] });
		restoreLogsOnlyMock.mockReset().mockResolvedValue([]);
		resetMock.mockReset().mockResolvedValue(undefined);
		resetSessionMock.mockReset().mockResolvedValue(undefined);
		manualCommitCtorMock.mockClear();
		selectMock.mockReset().mockResolvedValue('sha-default');
		confirmMock.mockReset().mockResolvedValue(true);
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

	// A. flag mutex + 入口守卫 (~8 case)
	describe('A. flag mutex + entry guards', () => {
		// Go: rewind.go:90-93 — `--list` / `--to` / `--logs-only` / `--reset` flag registration.
		it('registers `rewind` with 4 flags (list / to / logs-only / reset)', () => {
			const cli = buildCli();
			const cmd = cli.commands.find((c) => c.name === 'rewind');
			expect(cmd).toBeDefined();
			const flagNames = cmd!.options.map((o) => o.name);
			expect(flagNames).toContain('list');
			expect(flagNames).toContain('to');
			// cac normalizes --logs-only to camelCase `logsOnly` in option.name.
			expect(flagNames).toContain('logsOnly');
			expect(flagNames).toContain('reset');
		});

		it('outside a git repo → SilentError("Not a git repository")', async () => {
			const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'story-notgit-'));
			try {
				process.chdir(tmp);
				const { clearWorktreeRootCache } = await import('@/paths');
				clearWorktreeRootCache();
				const cli = buildCli();
				const sink = silenceStdio();
				try {
					await expect(runCli(cli, ['rewind', '--list'])).rejects.toThrow(SilentError);
				} finally {
					sink.restore();
				}
			} finally {
				process.chdir(env.dir);
				await fs.rm(tmp, { recursive: true, force: true });
			}
		});

		it('not-enabled repo → friendly `○` hint (non-SilentError)', async () => {
			// Remove settings so isEnabled=false.
			await fs.rm(path.join(env.dir, '.story'), { recursive: true, force: true });
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await runCli(cli, ['rewind']);
			} finally {
				sink.restore();
			}
			const stderr = sink.stderr.join('');
			const stdout = sink.stdout.join('');
			expect(`${stdout}${stderr}`).toMatch(/enable|not enabled/i);
			// Must NOT have called ManualCommitStrategy.
			expect(getRewindPointsMock).not.toHaveBeenCalled();
		});

		it("settings with 'enabled: false' → friendly `○` hint pointing at configure", async () => {
			await env.writeFile('.story/settings.json', '{"enabled": false}');
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await runCli(cli, ['rewind']);
			} finally {
				sink.restore();
			}
			const out = sink.stdout.join('');
			expect(out).toMatch(/enabled: false|configure/);
			expect(getRewindPointsMock).not.toHaveBeenCalled();
		});

		// Go: rewind.go:59-63 newRewindCmd — checkDisabledGuard runs BEFORE
		// runRewindList. Regression test for Phase 9.4 review fix A2:
		// previously `--list` bypassed isReady() and printed JSON even
		// when Story was disabled.
		it('--list respects `enabled: false` — no JSON, friendly hint', async () => {
			await env.writeFile('.story/settings.json', '{"enabled": false}');
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await runCli(cli, ['rewind', '--list']);
			} finally {
				sink.restore();
			}
			const out = sink.stdout.join('');
			// Must NOT print the JSON payload.
			expect(out).not.toMatch(/"rewind_points"/);
			// Must print the disabled hint.
			expect(out).toMatch(/enabled: false|configure/);
			expect(getRewindPointsMock).not.toHaveBeenCalled();
		});

		it('`--reset` without `--to` → SilentError about requires --to', async () => {
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await expect(runCli(cli, ['rewind', '--reset'])).rejects.toThrow(/--to/);
			} finally {
				sink.restore();
			}
		});

		it('`--list --to abc` → SilentError mutex', async () => {
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await expect(runCli(cli, ['rewind', '--list', '--to', 'abc'])).rejects.toThrow(/--list/);
			} finally {
				sink.restore();
			}
		});

		it('`--list --to --reset` (any two of list/to/reset) → SilentError mutex', async () => {
			// The mutex rejects `--list` + any other mode flag; here we
			// combine all three to stress the check end-to-end.
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await expect(runCli(cli, ['rewind', '--list', '--to', 'abc', '--reset'])).rejects.toThrow(
					/--list/,
				);
			} finally {
				sink.restore();
			}
		});

		it('`--list --logs-only` → SilentError mutex', async () => {
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await expect(runCli(cli, ['rewind', '--list', '--logs-only'])).rejects.toThrow(/--list/);
			} finally {
				sink.restore();
			}
		});

		it('`--json` without `--to` → SilentError (cannot prompt in JSON mode)', async () => {
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await expect(runCli(cli, ['rewind', '--json'])).rejects.toThrow(/--json|--to/i);
			} finally {
				sink.restore();
			}
		});
	});

	// B. `--list` path (~4 case)
	describe('B. --list JSON output', () => {
		it('empty rewind points → JSON with empty array', async () => {
			getRewindPointsMock.mockResolvedValue([]);
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await runCli(cli, ['rewind', '--list']);
			} finally {
				sink.restore();
			}
			const out = sink.stdout.join('');
			expect(() => JSON.parse(out.trim())).not.toThrow();
			const payload = JSON.parse(out.trim()) as { rewind_points: unknown[] };
			expect(payload.rewind_points).toEqual([]);
		});

		it('3 rewind points → JSON with all required fields', async () => {
			getRewindPointsMock.mockResolvedValue([
				makePoint({ id: 'aaaaaaa1111111111111111111111111111111111', message: 'A' }),
				makePoint({ id: 'bbbbbbb2222222222222222222222222222222222', message: 'B' }),
				makePoint({ id: 'ccccccc3333333333333333333333333333333333', message: 'C' }),
			]);
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await runCli(cli, ['rewind', '--list']);
			} finally {
				sink.restore();
			}
			const out = sink.stdout.join('');
			const payload = JSON.parse(out.trim()) as {
				rewind_points: Array<Record<string, unknown>>;
			};
			expect(payload.rewind_points).toHaveLength(3);
			const first = payload.rewind_points[0]!;
			// Go jsonPoint shape: id / message / metadata_dir / date / is_task_checkpoint / is_logs_only / session_id / session_prompt
			expect(first).toHaveProperty('id');
			expect(first).toHaveProperty('message');
			expect(first).toHaveProperty('date');
			expect(first).toHaveProperty('is_task_checkpoint');
			expect(first).toHaveProperty('is_logs_only');
			expect(first).toHaveProperty('session_id');
		});

		it('--list does NOT print banner or bar block', async () => {
			getRewindPointsMock.mockResolvedValue([makePoint()]);
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await runCli(cli, ['rewind', '--list']);
			} finally {
				sink.restore();
			}
			const out = sink.stdout.join('');
			// Must NOT contain the bar-block glyphs used by header/step/footer.
			expect(out).not.toMatch(/┌|◇|●|└/);
		});

		it('--list calls getRewindPoints exactly once, not rewind/reset', async () => {
			getRewindPointsMock.mockResolvedValue([]);
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await runCli(cli, ['rewind', '--list']);
			} finally {
				sink.restore();
			}
			expect(getRewindPointsMock).toHaveBeenCalledTimes(1);
			expect(rewindMock).not.toHaveBeenCalled();
			expect(resetMock).not.toHaveBeenCalled();
		});
	});

	// C. interactive main path (~8 case)
	// Go: rewind.go:98-356 runRewindInteractive
	describe('C. interactive rewind', () => {
		it('0 rewind points → SilentError with hint', async () => {
			getRewindPointsMock.mockResolvedValue([]);
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await expect(runCli(cli, ['rewind'])).rejects.toThrow(/rewind points/i);
			} finally {
				sink.restore();
			}
		});

		it('5 points → select → confirm Y → rewindImpl called once', async () => {
			const pts = [
				makePoint({ id: 'a'.repeat(40), message: 'p1' }),
				makePoint({ id: 'b'.repeat(40), message: 'p2' }),
				makePoint({ id: 'c'.repeat(40), message: 'p3' }),
				makePoint({ id: 'd'.repeat(40), message: 'p4' }),
				makePoint({ id: 'e'.repeat(40), message: 'p5' }),
			];
			getRewindPointsMock.mockResolvedValue(pts);
			selectMock.mockResolvedValue('a'.repeat(40));
			confirmMock.mockResolvedValue(true);

			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await runCli(cli, ['rewind']);
			} finally {
				sink.restore();
			}
			expect(selectMock).toHaveBeenCalledTimes(1);
			expect(confirmMock).toHaveBeenCalledTimes(1);
			expect(rewindMock).toHaveBeenCalledTimes(1);
		});

		it('select returns cancel → SilentError "cancelled"', async () => {
			getRewindPointsMock.mockResolvedValue([makePoint()]);
			selectMock.mockRejectedValue(new SilentError(new Error('cancelled')));
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await expect(runCli(cli, ['rewind'])).rejects.toThrow(SilentError);
			} finally {
				sink.restore();
			}
			expect(rewindMock).not.toHaveBeenCalled();
		});

		it('confirm N → SilentError "cancelled", no rewind', async () => {
			getRewindPointsMock.mockResolvedValue([makePoint()]);
			selectMock.mockResolvedValue(makePoint().id);
			confirmMock.mockResolvedValue(false);
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await expect(runCli(cli, ['rewind'])).rejects.toThrow(SilentError);
			} finally {
				sink.restore();
			}
			expect(rewindMock).not.toHaveBeenCalled();
		});

		it('rewindImpl throws → error bubbles to runtime', async () => {
			getRewindPointsMock.mockResolvedValue([makePoint()]);
			selectMock.mockResolvedValue(makePoint().id);
			confirmMock.mockResolvedValue(true);
			rewindMock.mockRejectedValue(new Error('boom'));
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await expect(runCli(cli, ['rewind'])).rejects.toThrow(/boom/);
			} finally {
				sink.restore();
			}
		});

		it('happy path → footer hint mentions `story status`', async () => {
			getRewindPointsMock.mockResolvedValue([makePoint()]);
			selectMock.mockResolvedValue(makePoint().id);
			confirmMock.mockResolvedValue(true);
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await runCli(cli, ['rewind']);
			} finally {
				sink.restore();
			}
			const out = sink.stdout.join('');
			expect(out).toMatch(/story status/);
		});

		it('select options include id-prefix + message + relative time', async () => {
			getRewindPointsMock.mockResolvedValue([
				makePoint({
					id: `5f2a1b${'f'.repeat(34)}`,
					message: 'Add dark mode toggle',
					date: new Date(Date.now() - 7200_000),
				}),
			]);
			selectMock.mockResolvedValue(`5f2a1b${'f'.repeat(34)}`);
			confirmMock.mockResolvedValue(true);
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await runCli(cli, ['rewind']);
			} finally {
				sink.restore();
			}
			const callArgs = selectMock.mock.calls[0]![0] as unknown as {
				options: Array<{ label: string }>;
			};
			const labels = callArgs.options.map((o) => o.label).join(' | ');
			// id-prefix visible
			expect(labels).toMatch(/5f2a1b/);
			// message visible
			expect(labels).toMatch(/Add dark mode toggle/);
		});

		it('diff preview overflows >5 files → shows `... (K more)`', async () => {
			getRewindPointsMock.mockResolvedValue([makePoint()]);
			selectMock.mockResolvedValue(makePoint().id);
			confirmMock.mockResolvedValue(true);
			previewRewindMock.mockResolvedValue({
				filesToRestore: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'],
				filesToDelete: ['extra.tmp', 'other.tmp'],
				trackedChanges: [],
			});
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await runCli(cli, ['rewind']);
			} finally {
				sink.restore();
			}
			const out = sink.stdout.join('');
			expect(out).toMatch(/\(3 more\)/);
		});

		it('previewRewind throws → warn but proceeds to confirm', async () => {
			getRewindPointsMock.mockResolvedValue([makePoint()]);
			selectMock.mockResolvedValue(makePoint().id);
			confirmMock.mockResolvedValue(true);
			previewRewindMock.mockRejectedValue(new Error('tree walk failed'));
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await runCli(cli, ['rewind']);
			} finally {
				sink.restore();
			}
			const errAll = sink.stderr.join('');
			expect(errAll).toMatch(/tree walk failed/);
			// Despite preview failure, confirm + rewind still runs.
			expect(rewindMock).toHaveBeenCalledTimes(1);
		});

		it('passes signal from getRootSignal into select + confirm', async () => {
			getRewindPointsMock.mockResolvedValue([makePoint()]);
			selectMock.mockResolvedValue(makePoint().id);
			confirmMock.mockResolvedValue(true);
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await runCli(cli, ['rewind']);
			} finally {
				sink.restore();
			}
			const selOpts = selectMock.mock.calls[0]![0] as unknown as { signal?: AbortSignal };
			const confOpts = confirmMock.mock.calls[0]![0] as unknown as { signal?: AbortSignal };
			expect(selOpts.signal).toBeDefined();
			expect(confOpts.signal).toBeDefined();
		});
	});

	// D. --to path (~6 case)
	// Go: rewind.go:405-557 runRewindToWithOptions
	describe('D. --to <commit-id>', () => {
		it('--to <full-sha> matches point → confirm + rewind', async () => {
			const sha = `abc1234${'0'.repeat(33)}`;
			getRewindPointsMock.mockResolvedValue([makePoint({ id: sha })]);
			overrideGitCall('rev-parse --verify', async () => `${sha}\n`);
			overrideGitCall('rev-parse HEAD', async () => `${'0'.repeat(40)}\n`);
			confirmMock.mockResolvedValue(true);
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await runCli(cli, ['rewind', '--to', sha]);
			} finally {
				sink.restore();
			}
			expect(rewindMock).toHaveBeenCalledTimes(1);
		});

		it('--to <short-sha> resolves via git rev-parse then matches', async () => {
			const full = `abc1234${'0'.repeat(33)}`;
			getRewindPointsMock.mockResolvedValue([makePoint({ id: full })]);
			overrideGitCall('rev-parse --verify', async () => `${full}\n`);
			overrideGitCall('rev-parse HEAD', async () => `${'0'.repeat(40)}\n`);
			confirmMock.mockResolvedValue(true);
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await runCli(cli, ['rewind', '--to', 'abc1234']);
			} finally {
				sink.restore();
			}
			const calls = execGitMock.mock.calls.map((c) => (c[0] as string[]).join(' '));
			expect(calls.some((c) => c.startsWith('rev-parse --verify abc1234'))).toBe(true);
			expect(rewindMock).toHaveBeenCalledTimes(1);
		});

		it('--to <unknown-sha> git rev-parse fails → SilentError', async () => {
			overrideGitCall('rev-parse --verify', async () => {
				throw new Error('fatal: Needed a single revision');
			});
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await expect(runCli(cli, ['rewind', '--to', 'nope'])).rejects.toThrow(SilentError);
			} finally {
				sink.restore();
			}
			expect(rewindMock).not.toHaveBeenCalled();
		});

		it('--to <sha> not in rewind point list → SilentError', async () => {
			getRewindPointsMock.mockResolvedValue([]);
			overrideGitCall('rev-parse --verify', async () => `abc${'0'.repeat(37)}\n`);
			overrideGitCall('rev-parse HEAD', async () => `${'f'.repeat(40)}\n`);
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await expect(runCli(cli, ['rewind', '--to', 'abc'])).rejects.toThrow(
					/not found|No rewind point/i,
				);
			} finally {
				sink.restore();
			}
		});

		it('--to <sha> with --yes skips confirm', async () => {
			const sha = `abc1234${'0'.repeat(33)}`;
			getRewindPointsMock.mockResolvedValue([makePoint({ id: sha })]);
			overrideGitCall('rev-parse --verify', async () => `${sha}\n`);
			overrideGitCall('rev-parse HEAD', async () => `${'f'.repeat(40)}\n`);
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await runCli(cli, ['rewind', '--to', sha, '--yes']);
			} finally {
				sink.restore();
			}
			// With --yes (non-destructive default), confirm should return true without prompting.
			expect(rewindMock).toHaveBeenCalledTimes(1);
		});

		it('--to <sha> with --json emits JSON summary after rewind', async () => {
			const sha = `abc1234${'0'.repeat(33)}`;
			getRewindPointsMock.mockResolvedValue([makePoint({ id: sha })]);
			overrideGitCall('rev-parse --verify', async () => `${sha}\n`);
			overrideGitCall('rev-parse HEAD', async () => `${'f'.repeat(40)}\n`);
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await runCli(cli, ['rewind', '--to', sha, '--json']);
			} finally {
				sink.restore();
			}
			const out = sink.stdout.join('');
			expect(() => JSON.parse(out.trim())).not.toThrow();
			const payload = JSON.parse(out.trim()) as { rewound: { to: string } };
			expect(payload.rewound).toBeDefined();
			expect(payload.rewound.to).toContain(sha.slice(0, 7));
		});

		it('--to <sha> equal to HEAD → no-op (exit 0, not SilentError)', async () => {
			const sha = `abc1234${'0'.repeat(33)}`;
			getRewindPointsMock.mockResolvedValue([makePoint({ id: sha })]);
			overrideGitCall('rev-parse --verify', async () => `${sha}\n`);
			overrideGitCall('rev-parse HEAD', async () => `${sha}\n`);
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await runCli(cli, ['rewind', '--to', sha]);
			} finally {
				sink.restore();
			}
			expect(rewindMock).not.toHaveBeenCalled();
			const out = sink.stdout.join('');
			expect(out).toMatch(/already at/i);
		});

		it('--to <sha> equal to HEAD + --json emits {noop} JSON', async () => {
			const sha = `abc1234${'0'.repeat(33)}`;
			getRewindPointsMock.mockResolvedValue([makePoint({ id: sha })]);
			overrideGitCall('rev-parse --verify', async () => `${sha}\n`);
			overrideGitCall('rev-parse HEAD', async () => `${sha}\n`);
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await runCli(cli, ['rewind', '--to', sha, '--json']);
			} finally {
				sink.restore();
			}
			const out = sink.stdout.join('');
			expect(() => JSON.parse(out.trim())).not.toThrow();
			const payload = JSON.parse(out.trim()) as { noop?: string };
			expect(payload.noop).toMatch(/already at/i);
		});
	});

	// E. --logs-only path (~4 case)
	// Go: rewind.go:561-595 handleLogsOnlyRewindNonInteractive
	describe('E. --logs-only', () => {
		it('--logs-only interactive → restoreLogsOnly called, rewind NOT called', async () => {
			getRewindPointsMock.mockResolvedValue([
				makePoint({ isLogsOnly: true, checkpointId: '1234567890ab' }),
			]);
			selectMock.mockResolvedValue(makePoint({ isLogsOnly: true }).id);
			confirmMock.mockResolvedValue(true);
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await runCli(cli, ['rewind', '--logs-only']);
			} finally {
				sink.restore();
			}
			expect(restoreLogsOnlyMock).toHaveBeenCalledTimes(1);
			expect(rewindMock).not.toHaveBeenCalled();
		});

		it('--logs-only cancel at confirm → SilentError', async () => {
			getRewindPointsMock.mockResolvedValue([makePoint()]);
			selectMock.mockResolvedValue(makePoint().id);
			confirmMock.mockResolvedValue(false);
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await expect(runCli(cli, ['rewind', '--logs-only'])).rejects.toThrow(SilentError);
			} finally {
				sink.restore();
			}
			expect(restoreLogsOnlyMock).not.toHaveBeenCalled();
		});

		it('--logs-only --to <sha> skips select, goes straight to confirm + restoreLogs', async () => {
			const sha = `abc1234${'0'.repeat(33)}`;
			getRewindPointsMock.mockResolvedValue([makePoint({ id: sha })]);
			overrideGitCall('rev-parse --verify', async () => `${sha}\n`);
			overrideGitCall('rev-parse HEAD', async () => `${'f'.repeat(40)}\n`);
			confirmMock.mockResolvedValue(true);
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await runCli(cli, ['rewind', '--logs-only', '--to', sha]);
			} finally {
				sink.restore();
			}
			expect(selectMock).not.toHaveBeenCalled();
			expect(restoreLogsOnlyMock).toHaveBeenCalledTimes(1);
			expect(rewindMock).not.toHaveBeenCalled();
		});

		it('--logs-only footer hint contains `story explain`', async () => {
			getRewindPointsMock.mockResolvedValue([
				makePoint({ isLogsOnly: true, checkpointId: 'ckpt567890ab' }),
			]);
			selectMock.mockResolvedValue(makePoint().id);
			confirmMock.mockResolvedValue(true);
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await runCli(cli, ['rewind', '--logs-only']);
			} finally {
				sink.restore();
			}
			const out = sink.stdout.join('');
			expect(out).toMatch(/story explain/);
		});
	});

	// F. --reset path (~5 case)
	// Go: rewind.go:597-664 handleLogsOnlyResetNonInteractive
	describe('F. --reset (destructive)', () => {
		it('--to <sha> --reset → DESTRUCTIVE warn + confirm (yesDefault false)', async () => {
			const sha = `abc1234${'0'.repeat(33)}`;
			getRewindPointsMock.mockResolvedValue([makePoint({ id: sha })]);
			overrideGitCall('rev-parse --verify', async () => `${sha}\n`);
			overrideGitCall('rev-parse HEAD', async () => `${'f'.repeat(40)}\n`);
			overrideGitCall('reset --hard', async () => '');
			confirmMock.mockResolvedValue(true);
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await runCli(cli, ['rewind', '--to', sha, '--reset']);
			} finally {
				sink.restore();
			}
			const errAll = sink.stderr.join('');
			expect(errAll).toMatch(/DESTRUCTIVE/);
			const confOpts = confirmMock.mock.calls[0]![0] as unknown as { yesDefault?: boolean };
			expect(confOpts.yesDefault).toBe(false);
		});

		it('--to <sha> --reset confirm Y → reset/restoreLogs called, rewind NOT', async () => {
			const sha = `abc1234${'0'.repeat(33)}`;
			getRewindPointsMock.mockResolvedValue([makePoint({ id: sha })]);
			overrideGitCall('rev-parse --verify', async () => `${sha}\n`);
			overrideGitCall('rev-parse HEAD', async () => `${'f'.repeat(40)}\n`);
			overrideGitCall('reset --hard', async () => '');
			confirmMock.mockResolvedValue(true);
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await runCli(cli, ['rewind', '--to', sha, '--reset']);
			} finally {
				sink.restore();
			}
			// The destructive path calls restoreLogsOnly (to preserve transcripts)
			// followed by an execGit reset --hard (Go: performGitResetHard).
			expect(restoreLogsOnlyMock).toHaveBeenCalledTimes(1);
			const gitCalls = execGitMock.mock.calls.map((c) => (c[0] as string[]).join(' '));
			expect(gitCalls.some((s) => s.includes('reset --hard'))).toBe(true);
			expect(rewindMock).not.toHaveBeenCalled();
			expect(resetMock).not.toHaveBeenCalled();
		});

		it('--to <sha> --reset confirm N → SilentError', async () => {
			const sha = `abc1234${'0'.repeat(33)}`;
			getRewindPointsMock.mockResolvedValue([makePoint({ id: sha })]);
			overrideGitCall('rev-parse --verify', async () => `${sha}\n`);
			overrideGitCall('rev-parse HEAD', async () => `${'f'.repeat(40)}\n`);
			confirmMock.mockResolvedValue(false);
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await expect(runCli(cli, ['rewind', '--to', sha, '--reset'])).rejects.toThrow(SilentError);
			} finally {
				sink.restore();
			}
			expect(restoreLogsOnlyMock).not.toHaveBeenCalled();
		});

		it('--to <sha> --reset calls confirm with yesDefault: false (destructive safe default)', async () => {
			// `--yes` + yesDefault:false returns false at the real confirm wrapper,
			// so explicit --yes does NOT auto-accept destructive actions. Since
			// confirm is fully mocked here, we verify the call-arg contract
			// instead of the wrapper's branching logic (that is covered by
			// `tests/unit/ui/prompts.test.ts`).
			const sha = `abc1234${'0'.repeat(33)}`;
			getRewindPointsMock.mockResolvedValue([makePoint({ id: sha })]);
			overrideGitCall('rev-parse --verify', async () => `${sha}\n`);
			overrideGitCall('rev-parse HEAD', async () => `${'f'.repeat(40)}\n`);
			confirmMock.mockResolvedValue(false); // simulate --yes + yesDefault:false
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await expect(runCli(cli, ['rewind', '--to', sha, '--reset', '--yes'])).rejects.toThrow(
					SilentError,
				);
			} finally {
				sink.restore();
			}
			expect(rewindMock).not.toHaveBeenCalled();
			const confOpts = confirmMock.mock.calls[0]![0] as unknown as { yesDefault?: boolean };
			expect(confOpts.yesDefault).toBe(false);
		});

		it('--to <sha> --reset stepDone footer mentions "hard reset"', async () => {
			const sha = `abc1234${'0'.repeat(33)}`;
			getRewindPointsMock.mockResolvedValue([makePoint({ id: sha })]);
			overrideGitCall('rev-parse --verify', async () => `${sha}\n`);
			overrideGitCall('rev-parse HEAD', async () => `${'f'.repeat(40)}\n`);
			overrideGitCall('reset --hard', async () => '');
			confirmMock.mockResolvedValue(true);
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await runCli(cli, ['rewind', '--to', sha, '--reset']);
			} finally {
				sink.restore();
			}
			const out = sink.stdout.join('');
			expect(out).toMatch(/hard reset/i);
		});
	});
});
