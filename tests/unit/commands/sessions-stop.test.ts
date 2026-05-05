/**
 * Phase 9.2 `src/commands/sessions/stop.ts` unit tests.
 *
 * Go: sessions.go: newStopCmd / runStop / runStopSession / runStopAll +
 *     lifecycle.go: markSessionEnded.
 *
 * Mocks the shared session-list helpers + @/ui/prompts so the 8 stop paths
 * can be exercised without clack TUI prompts actually running.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetGlobalFlagsForTesting } from '@/cli/flags';
import { setForceNonInteractive } from '@/cli/tty';
import type { EnrichedSession } from '@/commands/_shared/session-list';
import { handleSessionsStop } from '@/commands/sessions/stop';
import { SilentError } from '@/errors';
import { resetColorOverrideForTesting, setColorOverride } from '@/ui/theme';
import { assertCwdIsNotStoryRepo, TestEnv } from '../../helpers/test-env';

vi.mock('@/commands/_shared/session-list', () => ({
	findActiveSessions: vi.fn().mockResolvedValue([] as EnrichedSession[]),
	getSession: vi.fn(),
	markSessionEnded: vi.fn().mockResolvedValue(undefined),
	resolveSessionIdPrefix: vi.fn(),
}));
vi.mock('@/ui/prompts', () => ({
	confirm: vi.fn(),
	select: vi.fn(),
}));

function makeEnriched(overrides: Partial<EnrichedSession> = {}): EnrichedSession {
	return {
		id: 'sess-default',
		agentType: 'Claude Code',
		agentDescription: '',
		agentIsPreview: false,
		model: 'claude-sonnet-4-5',
		status: 'active',
		startedAt: new Date(Date.now() - 60_000).toISOString(),
		endedAt: undefined,
		lastPrompt: undefined,
		lastInteractionTime: undefined,
		isStuckActive: false,
		worktree: '',
		branch: undefined,
		tokens: { input: 0, output: 0, turns: 0 },
		checkpointCount: 0,
		filesChanged: 0,
		lastCheckpointId: undefined,
		lastCheckpointAt: undefined,
		...overrides,
	};
}

async function setActive(sessions: EnrichedSession[]): Promise<void> {
	const mod = await import('@/commands/_shared/session-list');
	(mod.findActiveSessions as ReturnType<typeof vi.fn>).mockResolvedValue(sessions);
}

async function setResolvePrefix(fn: (p: string) => Promise<string>): Promise<void> {
	const mod = await import('@/commands/_shared/session-list');
	(mod.resolveSessionIdPrefix as ReturnType<typeof vi.fn>).mockImplementation(fn);
}

async function setGetSession(fn: (id: string) => Promise<EnrichedSession>): Promise<void> {
	const mod = await import('@/commands/_shared/session-list');
	(mod.getSession as ReturnType<typeof vi.fn>).mockImplementation(fn);
}

async function setMark(
	fn: (id: string) => Promise<void> = async () => {},
): Promise<ReturnType<typeof vi.fn>> {
	const mod = await import('@/commands/_shared/session-list');
	const m = mod.markSessionEnded as ReturnType<typeof vi.fn>;
	m.mockReset().mockImplementation(fn);
	return m;
}

async function setConfirm(fn: () => Promise<boolean>): Promise<void> {
	const mod = await import('@/ui/prompts');
	(mod.confirm as ReturnType<typeof vi.fn>).mockImplementation(fn);
}

async function setSelect(fn: () => Promise<string>): Promise<void> {
	const mod = await import('@/ui/prompts');
	(mod.select as ReturnType<typeof vi.fn>).mockImplementation(fn);
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

describe('commands/sessions/stop', () => {
	let env: TestEnv;
	let origCwd: string;
	let savedExitCode: string | number | undefined;

	beforeEach(async () => {
		resetGlobalFlagsForTesting();
		resetColorOverrideForTesting();
		setColorOverride(false);
		setForceNonInteractive(true);

		const mod = await import('@/commands/_shared/session-list');
		(mod.findActiveSessions as ReturnType<typeof vi.fn>).mockReset().mockResolvedValue([]);
		(mod.getSession as ReturnType<typeof vi.fn>).mockReset();
		(mod.resolveSessionIdPrefix as ReturnType<typeof vi.fn>).mockReset();
		(mod.markSessionEnded as ReturnType<typeof vi.fn>).mockReset().mockResolvedValue(undefined);

		const prompts = await import('@/ui/prompts');
		(prompts.confirm as ReturnType<typeof vi.fn>).mockReset().mockResolvedValue(true);
		(prompts.select as ReturnType<typeof vi.fn>).mockReset();

		const { clearWorktreeRootCache } = await import('@/paths');
		clearWorktreeRootCache();
		env = await TestEnv.create({ initialCommit: true });
		origCwd = process.cwd();
		process.chdir(env.dir);
		clearWorktreeRootCache();
		assertCwdIsNotStoryRepo();
		await env.writeFile('.story/settings.json', '{"enabled": true}');

		savedExitCode = process.exitCode ?? undefined;
		process.exitCode = 0;
	});

	afterEach(async () => {
		process.chdir(origCwd);
		await env.cleanup();
		resetGlobalFlagsForTesting();
		resetColorOverrideForTesting();
		setForceNonInteractive(false);
		process.exitCode = savedExitCode ?? 0;
	});

	// Go: sessions.go: newStopCmd mutex check
	it('<id> + --all → SilentError (mutually exclusive)', async () => {
		const sink = silenceStdio();
		try {
			await expect(handleSessionsStop(['sess-abc'], { all: true })).rejects.toThrow(
				/--all.*cannot be used together/,
			);
		} finally {
			sink.restore();
		}
	});

	// Go: runStop — no id + zero active → "No active sessions" exit 0
	it('no <id> + 0 active → prints empty state and returns', async () => {
		await setActive([]);
		const mark = await setMark();
		const sink = silenceStdio();
		try {
			await handleSessionsStop([], {});
		} finally {
			sink.restore();
		}
		expect(mark).not.toHaveBeenCalled();
		expect(sink.stdout.join('')).toMatch(/No active sessions/);
	});

	// Go: runStop — 1 active session, confirm Y → markSessionEnded
	it('no <id> + 1 active → confirm → markSessionEnded called once', async () => {
		await setActive([makeEnriched({ id: 'sess-1' })]);
		await setConfirm(async () => true);
		const mark = await setMark();

		const sink = silenceStdio();
		try {
			await handleSessionsStop([], {});
		} finally {
			sink.restore();
		}
		expect(mark).toHaveBeenCalledTimes(1);
		expect(mark).toHaveBeenCalledWith('sess-1', env.dir);
	});

	// Go: runStopMultiSelect — select → confirm → mark
	it('no <id> + 2+ active → select one → confirm → markSessionEnded', async () => {
		await setActive([makeEnriched({ id: 'sess-a' }), makeEnriched({ id: 'sess-b' })]);
		await setSelect(async () => 'sess-b');
		await setConfirm(async () => true);
		const mark = await setMark();
		const sink = silenceStdio();
		try {
			await handleSessionsStop([], {});
		} finally {
			sink.restore();
		}
		expect(mark).toHaveBeenCalledWith('sess-b', env.dir);
	});

	// Go: runStopMultiSelect — cancel propagates as SilentError
	it('no <id> + select cancelled → SilentError "Cancelled"', async () => {
		await setActive([makeEnriched({ id: 'sess-a' }), makeEnriched({ id: 'sess-b' })]);
		await setSelect(async () => {
			throw new SilentError(new Error('cancelled'));
		});
		const mark = await setMark();
		const sink = silenceStdio();
		try {
			await expect(handleSessionsStop([], {})).rejects.toThrow(/cancelled/);
		} finally {
			sink.restore();
		}
		expect(mark).not.toHaveBeenCalled();
	});

	// Go: runStopSession — <id> + confirm Y
	it('<id> unique prefix + confirm Y → markSessionEnded', async () => {
		await setResolvePrefix(async () => 'sess-abc123');
		await setGetSession(async () => makeEnriched({ id: 'sess-abc123', status: 'active' }));
		await setConfirm(async () => true);
		const mark = await setMark();
		const sink = silenceStdio();
		try {
			await handleSessionsStop(['abc'], {});
		} finally {
			sink.restore();
		}
		expect(mark).toHaveBeenCalledWith('sess-abc123', env.dir);
	});

	// Go: runStopSession — confirm N prints "Cancelled"
	it('<id> + confirm N → SilentError "Cancelled"', async () => {
		await setResolvePrefix(async () => 'sess-abc123');
		await setGetSession(async () => makeEnriched({ id: 'sess-abc123' }));
		await setConfirm(async () => false);
		const mark = await setMark();
		const sink = silenceStdio();
		try {
			await expect(handleSessionsStop(['abc'], {})).rejects.toThrow(/[Cc]ancel/);
		} finally {
			sink.restore();
		}
		expect(mark).not.toHaveBeenCalled();
	});

	// Go: resolveSessionIDPrefix — ambiguous
	it('<id> prefix ambiguous → SilentError "Ambiguous"', async () => {
		await setResolvePrefix(async (p) => {
			throw new SilentError(
				new Error(`Ambiguous session id: ${p} | Matches 2 sessions: sess-ab001, sess-ab002`),
			);
		});
		const sink = silenceStdio();
		try {
			await expect(handleSessionsStop(['sess-ab'], {})).rejects.toThrow(/Ambiguous/);
		} finally {
			sink.restore();
		}
	});

	// Go: resolveSessionIDPrefix — not found
	it('<id> prefix → Session not found', async () => {
		await setResolvePrefix(async () => {
			throw new SilentError(new Error('Session not found: sess-zzz'));
		});
		const sink = silenceStdio();
		try {
			await expect(handleSessionsStop(['sess-zzz'], {})).rejects.toThrow(/Session not found/);
		} finally {
			sink.restore();
		}
	});

	// Go: runStopSession — refuse to stop a non-active session
	it('<id> already ended → SilentError "is not active"', async () => {
		await setResolvePrefix(async () => 'sess-ended');
		await setGetSession(async () =>
			makeEnriched({
				id: 'sess-ended',
				status: 'ended',
				endedAt: new Date().toISOString(),
			}),
		);
		const mark = await setMark();
		const sink = silenceStdio();
		try {
			await expect(handleSessionsStop(['sess-ended'], {})).rejects.toThrow(/is not active/);
		} finally {
			sink.restore();
		}
		expect(mark).not.toHaveBeenCalled();
	});

	// Go: runStopSession — --force skips confirm
	it('<id> + --force → skips confirm', async () => {
		await setResolvePrefix(async () => 'sess-force');
		await setGetSession(async () => makeEnriched({ id: 'sess-force' }));
		const confirmMod = await import('@/ui/prompts');
		const confirmSpy = confirmMod.confirm as ReturnType<typeof vi.fn>;
		const mark = await setMark();
		const sink = silenceStdio();
		try {
			await handleSessionsStop(['sess-force'], { force: true });
		} finally {
			sink.restore();
		}
		expect(confirmSpy).not.toHaveBeenCalled();
		expect(mark).toHaveBeenCalledWith('sess-force', env.dir);
	});

	// Go: runStopAll — 0 active
	it('--all + 0 active → "No active sessions" no mark calls', async () => {
		await setActive([]);
		const mark = await setMark();
		const sink = silenceStdio();
		try {
			await handleSessionsStop([], { all: true });
		} finally {
			sink.restore();
		}
		expect(mark).not.toHaveBeenCalled();
		expect(sink.stdout.join('')).toMatch(/No active sessions/);
	});

	// Go: runStopAll — confirm (default N), accept
	it('--all + 2 active + confirm Y → loops markSessionEnded', async () => {
		await setActive([makeEnriched({ id: 'sess-1' }), makeEnriched({ id: 'sess-2' })]);
		await setConfirm(async () => true);
		const mark = await setMark();
		const sink = silenceStdio();
		try {
			await handleSessionsStop([], { all: true });
		} finally {
			sink.restore();
		}
		expect(mark).toHaveBeenCalledTimes(2);
		expect(mark.mock.calls.map((c) => c[0])).toEqual(['sess-1', 'sess-2']);
	});

	// Go: runStopAll — confirm N
	it('--all + confirm N → SilentError "Cancelled"; no mark', async () => {
		await setActive([makeEnriched({ id: 'sess-1' }), makeEnriched({ id: 'sess-2' })]);
		await setConfirm(async () => false);
		const mark = await setMark();
		const sink = silenceStdio();
		try {
			await expect(handleSessionsStop([], { all: true })).rejects.toThrow(/[Cc]ancel/);
		} finally {
			sink.restore();
		}
		expect(mark).not.toHaveBeenCalled();
	});

	// Go: runStopAll + --force
	it('--all --force + 3 active → markSessionEnded all 3, no confirm', async () => {
		await setActive([
			makeEnriched({ id: 'sess-1' }),
			makeEnriched({ id: 'sess-2' }),
			makeEnriched({ id: 'sess-3' }),
		]);
		const confirmMod = await import('@/ui/prompts');
		const confirmSpy = confirmMod.confirm as ReturnType<typeof vi.fn>;
		const mark = await setMark();
		const sink = silenceStdio();
		try {
			await handleSessionsStop([], { all: true, force: true });
		} finally {
			sink.restore();
		}
		expect(confirmSpy).not.toHaveBeenCalled();
		expect(mark).toHaveBeenCalledTimes(3);
	});

	// Go: stopSelectedSessions — continue on single failure + exit 1 at end
	it('--all --force + partial failure → continues rest, exit code 1, summary', async () => {
		await setActive([
			makeEnriched({ id: 'sess-1' }),
			makeEnriched({ id: 'sess-2' }),
			makeEnriched({ id: 'sess-3' }),
		]);
		await setMark(async (id) => {
			if (id === 'sess-2') {
				throw new Error('boom');
			}
		});
		const sink = silenceStdio();
		try {
			await handleSessionsStop([], { all: true, force: true });
		} finally {
			sink.restore();
		}
		const combined = sink.stdout.join('') + sink.stderr.join('');
		expect(combined).toMatch(/Stopped 2 \/ 3/);
		expect(combined).toMatch(/1 failed/);
		expect(process.exitCode).toBe(1);
	});

	// `--json` output schema for batch stop
	it('--json + --all --force → JSON {stopped, failed}', async () => {
		await setActive([makeEnriched({ id: 'sess-1' }), makeEnriched({ id: 'sess-2' })]);
		const { applyGlobalFlags } = await import('@/cli/flags');
		applyGlobalFlags({ json: true });
		await setMark(async (id) => {
			if (id === 'sess-2') {
				throw new Error('fail');
			}
		});
		const sink = silenceStdio();
		try {
			await handleSessionsStop([], { all: true, force: true });
		} finally {
			sink.restore();
		}
		const lines = sink.stdout.join('').split('\n').filter(Boolean);
		const parsed = JSON.parse(lines[lines.length - 1]!);
		expect(parsed.stopped).toEqual(['sess-1']);
		expect(parsed.failed).toHaveLength(1);
		expect(parsed.failed[0].id).toBe('sess-2');
	});

	// Footer hint
	it('footer hint references `sessions list`', async () => {
		await setActive([makeEnriched({ id: 'sess-1' })]);
		await setConfirm(async () => true);
		await setMark();
		const sink = silenceStdio();
		try {
			await handleSessionsStop([], {});
		} finally {
			sink.restore();
		}
		expect(sink.stdout.join('')).toMatch(/sessions list/);
	});

	// Not a git repo
	it('outside a git repo → SilentError', async () => {
		const fs = await import('node:fs/promises');
		const os = await import('node:os');
		const path = await import('node:path');
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'story-notgit-'));
		try {
			process.chdir(tmp);
			const { clearWorktreeRootCache } = await import('@/paths');
			clearWorktreeRootCache();
			const sink = silenceStdio();
			try {
				await expect(handleSessionsStop([], {})).rejects.toThrow(SilentError);
			} finally {
				sink.restore();
			}
		} finally {
			process.chdir(env.dir);
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	// Ctrl-C on select → SilentError with "cancelled" / 130
	it('Ctrl-C in select → SilentError (propagates upward)', async () => {
		await setActive([makeEnriched({ id: 'sess-a' }), makeEnriched({ id: 'sess-b' })]);
		await setSelect(async () => {
			throw new SilentError(new Error('cancelled'));
		});
		const sink = silenceStdio();
		try {
			await expect(handleSessionsStop([], {})).rejects.toThrow(SilentError);
		} finally {
			sink.restore();
		}
	});

	// `--json` single-session stop → JSON
	it('--json + single-id stop → JSON with stopped array containing that id', async () => {
		await setResolvePrefix(async () => 'sess-json-one');
		await setGetSession(async () => makeEnriched({ id: 'sess-json-one' }));
		const { applyGlobalFlags } = await import('@/cli/flags');
		applyGlobalFlags({ json: true });
		await setMark();
		const sink = silenceStdio();
		try {
			await handleSessionsStop(['sess-json-one'], { force: true });
		} finally {
			sink.restore();
		}
		const lines = sink.stdout.join('').split('\n').filter(Boolean);
		const parsed = JSON.parse(lines[lines.length - 1]!);
		expect(parsed.stopped).toEqual(['sess-json-one']);
		expect(parsed.failed).toEqual([]);
	});
});
