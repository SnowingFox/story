/**
 * Phase 9.2 `src/commands/sessions/info.ts` unit tests.
 *
 * Go: sessions.go: newInfoCmd / runSessionInfo + resolveSessionIDPrefix.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetGlobalFlagsForTesting } from '@/cli/flags';
import { setForceNonInteractive } from '@/cli/tty';
import type { EnrichedSession } from '@/commands/_shared/session-list';
import { handleSessionsInfo } from '@/commands/sessions/info';
import { SilentError } from '@/errors';
import { resetColorOverrideForTesting, setColorOverride } from '@/ui/theme';
import { assertCwdIsNotStoryRepo, TestEnv } from '../../helpers/test-env';

vi.mock('@/commands/_shared/session-list', () => ({
	getSession: vi.fn(),
	resolveSessionIdPrefix: vi.fn(),
}));
vi.mock('@/strategy/metadata-branch', () => ({
	listCheckpoints: vi.fn().mockResolvedValue([]),
}));

function makeEnriched(overrides: Partial<EnrichedSession> = {}): EnrichedSession {
	return {
		id: 'sess-abc123',
		agentType: 'Claude Code',
		agentDescription: '',
		agentIsPreview: false,
		model: 'claude-sonnet-4-5',
		status: 'active',
		startedAt: '2026-04-22T14:08:31.000Z',
		endedAt: undefined,
		lastPrompt: undefined,
		lastInteractionTime: undefined,
		isStuckActive: false,
		worktree: '/repo',
		branch: undefined,
		tokens: { input: 18423, output: 3214, turns: 7 },
		checkpointCount: 3,
		filesChanged: 4,
		lastCheckpointId: 'cp_9f3a1d2b',
		lastCheckpointAt: '2026-04-22T14:30:12.000Z',
		...overrides,
	};
}

async function setResolvePrefix(fn: (p: string) => Promise<string>): Promise<void> {
	const mod = await import('@/commands/_shared/session-list');
	(mod.resolveSessionIdPrefix as ReturnType<typeof vi.fn>).mockImplementation(fn);
}

async function setGetSession(fn: (id: string) => Promise<EnrichedSession>): Promise<void> {
	const mod = await import('@/commands/_shared/session-list');
	(mod.getSession as ReturnType<typeof vi.fn>).mockImplementation(fn);
}

async function setCheckpoints(
	items: Array<{
		checkpointId: string;
		sessionId: string;
		createdAt: Date;
		checkpointsCount: number;
		filesTouched: string[];
	}>,
): Promise<void> {
	const mod = await import('@/strategy/metadata-branch');
	(mod.listCheckpoints as ReturnType<typeof vi.fn>).mockResolvedValue(items);
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

describe('commands/sessions/info', () => {
	let env: TestEnv;
	let origCwd: string;

	beforeEach(async () => {
		resetGlobalFlagsForTesting();
		resetColorOverrideForTesting();
		setColorOverride(false);
		setForceNonInteractive(true);

		const mod = await import('@/commands/_shared/session-list');
		(mod.getSession as ReturnType<typeof vi.fn>).mockReset();
		(mod.resolveSessionIdPrefix as ReturnType<typeof vi.fn>).mockReset();
		const meta = await import('@/strategy/metadata-branch');
		(meta.listCheckpoints as ReturnType<typeof vi.fn>).mockReset().mockResolvedValue([]);

		const { clearWorktreeRootCache } = await import('@/paths');
		clearWorktreeRootCache();
		env = await TestEnv.create({ initialCommit: true });
		origCwd = process.cwd();
		process.chdir(env.dir);
		clearWorktreeRootCache();
		assertCwdIsNotStoryRepo();
		// Settings present so "enabled" check passes.
		await env.writeFile('.story/settings.json', '{"enabled": true}');
	});

	afterEach(async () => {
		process.chdir(origCwd);
		await env.cleanup();
		resetGlobalFlagsForTesting();
		resetColorOverrideForTesting();
		setForceNonInteractive(false);
	});

	// Go: sessions.go:newInfoCmd — missing argument
	it('missing <session-id> → SilentError "Missing argument: <session-id>"', async () => {
		const sink = silenceStdio();
		try {
			await expect(handleSessionsInfo([])).rejects.toThrow(/Missing argument/);
		} finally {
			sink.restore();
		}
	});

	// Go: sessions.go:resolveSessionIDPrefix + strategy/session.go:findSessionByID
	// Happy path: unique prefix → full card
	it('unique prefix → renders Session / Tokens / Checkpoints / Files blocks', async () => {
		await setResolvePrefix(async () => 'sess-abc123');
		await setGetSession(async () =>
			makeEnriched({ id: 'sess-abc123', checkpointCount: 2, filesChanged: 2 }),
		);
		await setCheckpoints([
			{
				checkpointId: 'cp_9f3a1d2b',
				sessionId: 'sess-abc123',
				createdAt: new Date('2026-04-22T14:30:12Z'),
				checkpointsCount: 1,
				filesTouched: ['src/auth/login.ts', 'src/auth/token.ts'],
			},
			{
				checkpointId: 'cp_6e22f1a4',
				sessionId: 'sess-abc123',
				createdAt: new Date('2026-04-22T14:20:45Z'),
				checkpointsCount: 1,
				filesTouched: ['src/auth/login.ts'],
			},
		]);

		const sink = silenceStdio();
		try {
			await handleSessionsInfo(['abc']);
		} finally {
			sink.restore();
		}
		const out = sink.stdout.join('');
		expect(out).toMatch(/Session/);
		expect(out).toMatch(/sess-abc123/);
		expect(out).toMatch(/Tokens/);
		expect(out).toMatch(/Checkpoints \(2\)/);
		expect(out).toMatch(/Files touched \(2\)/);
		expect(out).toMatch(/src\/auth\/login\.ts/);
	});

	// Go: resolveSessionIDPrefix — ambiguous
	it('ambiguous prefix → SilentError "Ambiguous session id"', async () => {
		await setResolvePrefix(async (p) => {
			throw new SilentError(
				new Error(`Ambiguous session id: ${p} | Matches 2 sessions: sess-ab001, sess-ab002`),
			);
		});
		const sink = silenceStdio();
		try {
			await expect(handleSessionsInfo(['sess-ab'])).rejects.toThrow(/Ambiguous session id/);
		} finally {
			sink.restore();
		}
	});

	// Go: resolveSessionIDPrefix — not found
	it('prefix matches no session → SilentError "Session not found"', async () => {
		await setResolvePrefix(async () => {
			throw new SilentError(new Error('Session not found: sess-zzz999'));
		});
		const sink = silenceStdio();
		try {
			await expect(handleSessionsInfo(['sess-zzz999'])).rejects.toThrow(/Session not found/);
		} finally {
			sink.restore();
		}
	});

	// Exact id match (no prefix disambiguation needed)
	it('exact id → renders card', async () => {
		await setResolvePrefix(async () => 'sess-abc123');
		await setGetSession(async () => makeEnriched({ id: 'sess-abc123' }));
		const sink = silenceStdio();
		try {
			await handleSessionsInfo(['sess-abc123']);
		} finally {
			sink.restore();
		}
		expect(sink.stdout.join('')).toMatch(/sess-abc123/);
	});

	// Active session: status=active, ended=—
	it('active session → status: active + ended: —', async () => {
		await setResolvePrefix(async () => 'sess-active');
		await setGetSession(async () => makeEnriched({ id: 'sess-active', status: 'active' }));
		const sink = silenceStdio();
		try {
			await handleSessionsInfo(['sess-active']);
		} finally {
			sink.restore();
		}
		const out = sink.stdout.join('');
		expect(out).toMatch(/status:\s+active/);
		expect(out).toMatch(/ended:\s+—/);
	});

	// Ended session: duration
	it('ended session → duration shown next to ended time', async () => {
		const startedAt = '2026-04-22T10:14:22.000Z';
		const endedAt = '2026-04-22T11:02:40.000Z'; // 48m 18s later
		await setResolvePrefix(async () => 'sess-4d2c11');
		await setGetSession(async () =>
			makeEnriched({
				id: 'sess-4d2c11',
				status: 'ended',
				startedAt,
				endedAt,
			}),
		);
		const sink = silenceStdio();
		try {
			await handleSessionsInfo(['sess-4d2c11']);
		} finally {
			sink.restore();
		}
		const out = sink.stdout.join('');
		expect(out).toMatch(/status:\s+ended/);
		expect(out).toMatch(/48m duration/);
	});

	// Truncation: many checkpoints → "... (N more, run with --json for full list)"
	it('checkpoints >3 → truncated with "... (N more, run with --json for full list)"', async () => {
		await setResolvePrefix(async () => 'sess-many');
		await setGetSession(async () => makeEnriched({ id: 'sess-many', checkpointCount: 5 }));
		await setCheckpoints(
			Array.from({ length: 5 }, (_, i) => ({
				checkpointId: `cp_${i}`,
				sessionId: 'sess-many',
				createdAt: new Date(`2026-04-22T14:${String(30 - i).padStart(2, '0')}:00Z`),
				checkpointsCount: 1,
				filesTouched: [`f${i}.ts`],
			})),
		);
		const sink = silenceStdio();
		try {
			await handleSessionsInfo(['sess-many']);
		} finally {
			sink.restore();
		}
		expect(sink.stdout.join('')).toMatch(/\(2 more, run with --json for full list\)/);
	});

	// Files touched truncation
	it('files >N → truncated with "... (N more)"', async () => {
		await setResolvePrefix(async () => 'sess-many-files');
		await setGetSession(async () => makeEnriched({ id: 'sess-many-files', filesChanged: 12 }));
		await setCheckpoints([
			{
				checkpointId: 'cp_1',
				sessionId: 'sess-many-files',
				createdAt: new Date('2026-04-22T14:30:00Z'),
				checkpointsCount: 1,
				filesTouched: Array.from({ length: 12 }, (_, i) => `src/file-${i}.ts`),
			},
		]);
		const sink = silenceStdio();
		try {
			await handleSessionsInfo(['sess-many-files']);
		} finally {
			sink.restore();
		}
		expect(sink.stdout.join('')).toMatch(/\.\.\. \(\d+ more\)/);
	});

	// `--json` → full dump on stdout one-line
	it('--json → JSON on stdout with all fields including full lists', async () => {
		await setResolvePrefix(async () => 'sess-json');
		await setGetSession(async () => makeEnriched({ id: 'sess-json', checkpointCount: 2 }));
		await setCheckpoints([
			{
				checkpointId: 'cp_1',
				sessionId: 'sess-json',
				createdAt: new Date('2026-04-22T14:30:00Z'),
				checkpointsCount: 1,
				filesTouched: ['a.ts', 'b.ts'],
			},
			{
				checkpointId: 'cp_2',
				sessionId: 'sess-json',
				createdAt: new Date('2026-04-22T14:20:00Z'),
				checkpointsCount: 1,
				filesTouched: ['a.ts'],
			},
		]);

		const { applyGlobalFlags } = await import('@/cli/flags');
		applyGlobalFlags({ json: true });
		const sink = silenceStdio();
		try {
			await handleSessionsInfo(['sess-json']);
		} finally {
			sink.restore();
		}
		const out = sink.stdout.join('').trim();
		const parsed = JSON.parse(out);
		expect(parsed.id).toBe('sess-json');
		expect(parsed.status).toBe('active');
		expect(parsed.checkpoints).toHaveLength(2);
		expect(parsed.filesTouched).toEqual(['a.ts', 'b.ts']);
	});

	// `--json` + ambiguous prefix → stderr emits `{"error":"..."}`
	it('--json + ambiguous prefix → rejects with SilentError; error surfaces via top-level catch', async () => {
		await setResolvePrefix(async () => {
			throw new SilentError(
				new Error('Ambiguous session id: sess-ab | Matches 2 sessions: sess-ab001, sess-ab002'),
			);
		});
		const { applyGlobalFlags } = await import('@/cli/flags');
		applyGlobalFlags({ json: true });
		const sink = silenceStdio();
		try {
			await expect(handleSessionsInfo(['sess-ab'])).rejects.toThrow(/Ambiguous/);
		} finally {
			sink.restore();
		}
	});

	// Token block rendering
	it('tokens: input/output/turns printed in Tokens block', async () => {
		await setResolvePrefix(async () => 'sess-tok');
		await setGetSession(async () =>
			makeEnriched({
				id: 'sess-tok',
				tokens: { input: 18423, output: 3214, turns: 7 },
			}),
		);
		const sink = silenceStdio();
		try {
			await handleSessionsInfo(['sess-tok']);
		} finally {
			sink.restore();
		}
		const out = sink.stdout.join('');
		expect(out).toMatch(/Tokens/);
		expect(out).toMatch(/input:[^\n]*18/);
		expect(out).toMatch(/output:[^\n]*3/);
		expect(out).toMatch(/turns:[^\n]*7/);
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
				await expect(handleSessionsInfo(['sess-any'])).rejects.toThrow(SilentError);
			} finally {
				sink.restore();
			}
		} finally {
			process.chdir(env.dir);
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	// Footer hint varies by status
	it('footer for active session points to `explain --session`', async () => {
		await setResolvePrefix(async () => 'sess-active');
		await setGetSession(async () => makeEnriched({ id: 'sess-active', status: 'active' }));
		const sink = silenceStdio();
		try {
			await handleSessionsInfo(['sess-active']);
		} finally {
			sink.restore();
		}
		expect(sink.stdout.join('')).toMatch(/explain --session sess-active/);
	});

	it('footer for ended session points to `resume`', async () => {
		await setResolvePrefix(async () => 'sess-ended');
		await setGetSession(async () =>
			makeEnriched({
				id: 'sess-ended',
				status: 'ended',
				endedAt: '2026-04-22T11:00:00.000Z',
			}),
		);
		const sink = silenceStdio();
		try {
			await handleSessionsInfo(['sess-ended']);
		} finally {
			sink.restore();
		}
		expect(sink.stdout.join('')).toMatch(/story resume/);
	});

	// Orphaned session state — defensive rendering
	it('orphaned session → renders "orphaned" status label', async () => {
		await setResolvePrefix(async () => 'sess-orphan');
		await setGetSession(async () => makeEnriched({ id: 'sess-orphan', status: 'orphaned' }));
		const sink = silenceStdio();
		try {
			await handleSessionsInfo(['sess-orphan']);
		} finally {
			sink.restore();
		}
		expect(sink.stdout.join('')).toMatch(/status:\s+orphaned/);
	});
});
