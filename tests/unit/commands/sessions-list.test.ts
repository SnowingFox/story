/**
 * Phase 9.2 `src/commands/sessions/list.ts` unit tests.
 *
 * Go: sessions.go: newSessionsListCmd / runSessionList.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetGlobalFlagsForTesting } from '@/cli/flags';
import { setForceNonInteractive } from '@/cli/tty';
import type { EnrichedSession } from '@/commands/_shared/session-list';
import { handleSessionsList } from '@/commands/sessions/list';
import { SilentError } from '@/errors';
import { resetColorOverrideForTesting, setColorOverride } from '@/ui/theme';
import { assertCwdIsNotStoryRepo, TestEnv } from '../../helpers/test-env';

vi.mock('@/commands/_shared/session-list', () => ({
	listSessions: vi.fn().mockResolvedValue([] as EnrichedSession[]),
}));

function makeEnriched(overrides: Partial<EnrichedSession> = {}): EnrichedSession {
	const base: EnrichedSession = {
		id: 'sess-default',
		agentType: 'Claude Code',
		agentDescription: '',
		agentIsPreview: false,
		model: undefined,
		status: 'active',
		startedAt: new Date().toISOString(),
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
	};
	return { ...base, ...overrides };
}

async function setSessions(sessions: EnrichedSession[]): Promise<void> {
	const mod = await import('@/commands/_shared/session-list');
	(mod.listSessions as ReturnType<typeof vi.fn>).mockResolvedValue(sessions);
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

describe('commands/sessions/list', () => {
	let env: TestEnv;
	let origCwd: string;

	beforeEach(async () => {
		resetGlobalFlagsForTesting();
		resetColorOverrideForTesting();
		setColorOverride(false);
		setForceNonInteractive(true);

		const sl = await import('@/commands/_shared/session-list');
		(sl.listSessions as ReturnType<typeof vi.fn>).mockReset().mockResolvedValue([]);

		const { clearWorktreeRootCache } = await import('@/paths');
		clearWorktreeRootCache();
		env = await TestEnv.create({ initialCommit: true });
		origCwd = process.cwd();
		process.chdir(env.dir);
		clearWorktreeRootCache();
		assertCwdIsNotStoryRepo();
		// Install a settings file so the "enabled" check passes.
		await env.writeFile('.story/settings.json', '{"enabled": true}');
	});

	afterEach(async () => {
		process.chdir(origCwd);
		await env.cleanup();
		resetGlobalFlagsForTesting();
		resetColorOverrideForTesting();
		setForceNonInteractive(false);
	});

	// Go: sessions.go:runSessionList — empty → "No sessions yet"
	it('empty repo → Sessions (0) + "No sessions yet"', async () => {
		const sink = silenceStdio();
		try {
			await handleSessionsList([]);
		} finally {
			sink.restore();
		}
		const out = sink.stdout.join('');
		expect(out).toMatch(/Sessions \(0\)/);
		expect(out).toMatch(/No sessions yet/);
	});

	// Happy path: 4 sessions, newest first, each line has the expected fields
	it('4 sessions (2 active + 2 ended) → bar-block rendering, sorted newest first', async () => {
		const now = Date.now();
		await setSessions([
			makeEnriched({
				id: 'sess-new-active',
				startedAt: new Date(now).toISOString(),
				status: 'active',
				filesChanged: 4,
				checkpointCount: 3,
			}),
			makeEnriched({
				id: 'sess-older-active',
				startedAt: new Date(now - 10_000).toISOString(),
				status: 'active',
				filesChanged: 1,
				checkpointCount: 1,
			}),
			makeEnriched({
				id: 'sess-ended-recent',
				status: 'ended',
				startedAt: new Date(now - 60_000).toISOString(),
				endedAt: new Date(now - 30_000).toISOString(),
				filesChanged: 11,
				checkpointCount: 18,
			}),
			makeEnriched({
				id: 'sess-ended-old',
				status: 'ended',
				startedAt: new Date(now - 120_000).toISOString(),
				endedAt: new Date(now - 90_000).toISOString(),
				filesChanged: 3,
				checkpointCount: 5,
			}),
		]);

		const sink = silenceStdio();
		try {
			await handleSessionsList([]);
		} finally {
			sink.restore();
		}
		const out = sink.stdout.join('');
		expect(out).toMatch(/Sessions \(4\)/);
		// Order check: newest listed first
		const idxNew = out.indexOf('sess-new-active');
		const idxOldActive = out.indexOf('sess-older-active');
		const idxEndedOld = out.indexOf('sess-ended-old');
		expect(idxNew).toBeGreaterThan(-1);
		expect(idxOldActive).toBeGreaterThan(idxNew);
		expect(idxEndedOld).toBeGreaterThan(idxOldActive);
	});

	// Active glyph `●` vs ended `○`
	it('active session rendered with "active" label, ended with "ended"', async () => {
		await setSessions([
			makeEnriched({ id: 'sess-a', status: 'active' }),
			makeEnriched({
				id: 'sess-b',
				status: 'ended',
				endedAt: new Date().toISOString(),
			}),
		]);
		const sink = silenceStdio();
		try {
			await handleSessionsList([]);
		} finally {
			sink.restore();
		}
		const out = sink.stdout.join('');
		expect(out).toMatch(/sess-a\s+active/);
		expect(out).toMatch(/sess-b\s+ended/);
	});

	// Footer hint → sessions info <id>
	it('footer contains "Run \'story sessions info <id>\' for details."', async () => {
		await setSessions([makeEnriched({ id: 'sess-1' })]);
		const sink = silenceStdio();
		try {
			await handleSessionsList([]);
		} finally {
			sink.restore();
		}
		expect(sink.stdout.join('')).toMatch(/Run 'story sessions info <id>' for details\./);
	});

	// `--json` → one-line JSON array
	it('--json → JSON array on stdout, no bar block', async () => {
		await setSessions([
			makeEnriched({
				id: 'sess-1',
				startedAt: '2026-04-22T14:08:31.000Z',
				filesChanged: 4,
				checkpointCount: 3,
			}),
		]);
		const { applyGlobalFlags } = await import('@/cli/flags');
		applyGlobalFlags({ json: true });
		const sink = silenceStdio();
		try {
			await handleSessionsList([]);
		} finally {
			sink.restore();
		}
		const out = sink.stdout.join('').trim();
		const parsed = JSON.parse(out);
		expect(parsed).toHaveLength(1);
		expect(parsed[0]).toMatchObject({
			id: 'sess-1',
			status: 'active',
			filesChanged: 4,
			checkpointCount: 3,
		});
	});

	// `--json` empty → []
	it('--json empty repo → []', async () => {
		const { applyGlobalFlags } = await import('@/cli/flags');
		applyGlobalFlags({ json: true });
		const sink = silenceStdio();
		try {
			await handleSessionsList([]);
		} finally {
			sink.restore();
		}
		expect(sink.stdout.join('').trim()).toBe('[]');
	});

	// Not enabled → friendly "not enabled" → SilentError
	it('Story not enabled → SilentError directing to `story enable`', async () => {
		// Delete settings
		const fs = await import('node:fs/promises');
		const path = await import('node:path');
		await fs.rm(path.join(env.dir, '.story', 'settings.json'));
		await fs.rmdir(path.join(env.dir, '.story'));

		const sink = silenceStdio();
		try {
			await expect(handleSessionsList([])).rejects.toThrow(/not enabled/);
		} finally {
			sink.restore();
		}
	});

	// Not a git repo → SilentError
	it('not a git repo → SilentError', async () => {
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
				await expect(handleSessionsList([])).rejects.toThrow(SilentError);
			} finally {
				sink.restore();
			}
		} finally {
			process.chdir(env.dir);
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	// Summary footer with 2 active + 2 ended counts
	it('footer summary shows "N sessions (X active, Y ended)"', async () => {
		await setSessions([
			makeEnriched({ id: 'a', status: 'active' }),
			makeEnriched({ id: 'b', status: 'active' }),
			makeEnriched({ id: 'c', status: 'ended', endedAt: new Date().toISOString() }),
			makeEnriched({ id: 'd', status: 'ended', endedAt: new Date().toISOString() }),
		]);
		const sink = silenceStdio();
		try {
			await handleSessionsList([]);
		} finally {
			sink.restore();
		}
		expect(sink.stdout.join('')).toMatch(/4 sessions\s*\(2 active, 2 ended\)/);
	});

	// Stable ordering: list preserves the order that listSessions produces
	// (listSessions itself sorts by startedAt desc with id tie-break; the
	// handler just renders in the order it's given).
	it('preserves the order produced by listSessions (no client-side re-sort)', async () => {
		await setSessions([
			makeEnriched({ id: 'sess-first', startedAt: '2026-04-22T14:00:00.000Z' }),
			makeEnriched({ id: 'sess-second', startedAt: '2026-04-22T14:00:00.000Z' }),
		]);
		const sink = silenceStdio();
		try {
			await handleSessionsList([]);
		} finally {
			sink.restore();
		}
		const out = sink.stdout.join('');
		expect(out.indexOf('sess-first')).toBeLessThan(out.indexOf('sess-second'));
	});

	// Agent description surfacing — preview flag renders a "(preview)" suffix.
	it('preview agent renders "(preview)" suffix', async () => {
		await setSessions([
			makeEnriched({
				id: 'sess-preview',
				agentType: 'Codex',
				agentDescription: 'OpenAI Codex',
				agentIsPreview: true,
			}),
		]);
		const sink = silenceStdio();
		try {
			await handleSessionsList([]);
		} finally {
			sink.restore();
		}
		expect(sink.stdout.join('')).toMatch(/\(preview\)/);
	});

	// Banner suppressed under `--json`; appears on non-json TTY is handled by
	// runtime.ts, not here. Just confirm non-json mode emits the header label.
	it('non-json: renders header label "story sessions list"', async () => {
		const sink = silenceStdio();
		try {
			await handleSessionsList([]);
		} finally {
			sink.restore();
		}
		expect(sink.stdout.join('')).toMatch(/story sessions list/);
	});
});
