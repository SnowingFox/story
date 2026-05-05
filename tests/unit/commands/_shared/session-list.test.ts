/**
 * Phase 9.2 `src/commands/_shared/session-list.ts` — unit tests.
 *
 * This shared helper is the primary data source for the 4 user-facing
 * sessions commands (`status` / `sessions list|info|stop`). It layers
 * checkpoint-metadata enrichment + registry-sourced agent display info on
 * top of the raw {@link listSessionStates}.
 *
 * Go:
 * - strategy/session.go: ListSessions / GetSession / findSessionByID
 * - sessions.go: sessionPhaseLabel / filterActiveSessions
 * - lifecycle.go: markSessionEnded
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	findActiveSessions,
	getSession,
	listSessions,
	markSessionEnded,
	resolveSessionIdPrefix,
} from '@/commands/_shared/session-list';
import { SilentError } from '@/errors';
import { clearGitCommonDirCache } from '@/git';
import { clearWorktreeRootCache } from '@/paths';
import { loadSessionState, saveSessionState } from '@/strategy/session-state';
import type { SessionState } from '@/strategy/types';
import { TestEnv } from '../../../helpers/test-env';

function makeState(overrides: Partial<SessionState> = {}): SessionState {
	return {
		sessionId: overrides.sessionId ?? 'sess-default',
		baseCommit: 'deadbeefcafe',
		startedAt: new Date().toISOString(),
		phase: 'idle',
		stepCount: 0,
		...overrides,
	};
}

// vi.mock for metadata-branch enrichment + registry lookup — keeps the
// test laser-focused on the enrichment semantics (we already have
// metadata-branch + registry covered by dedicated tests).
vi.mock('@/strategy/metadata-branch', () => ({
	listCheckpoints: vi.fn().mockResolvedValue([]),
}));
vi.mock('@/agent/registry', () => ({
	getByAgentType: vi.fn().mockReturnValue(null),
}));

async function setListCheckpoints(
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

async function setAgentLookup(
	fn: (t: string) => { description: () => string; isPreview: () => boolean } | null,
): Promise<void> {
	const mod = await import('@/agent/registry');
	(mod.getByAgentType as ReturnType<typeof vi.fn>).mockImplementation(fn);
}

describe('commands/_shared/session-list', () => {
	let env: TestEnv;

	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: false });
		clearGitCommonDirCache();
		clearWorktreeRootCache();
		await setListCheckpoints([]);
		await setAgentLookup(() => null);
	});

	afterEach(async () => {
		await env.cleanup();
		clearGitCommonDirCache();
		clearWorktreeRootCache();
		vi.clearAllMocks();
	});

	// Go: strategy/session.go:ListSessions — empty repo → []
	it('listSessions — empty repo returns []', async () => {
		const sessions = await listSessions(env.dir);
		expect(sessions).toEqual([]);
	});

	// Go: strategy/session.go:ListSessions — sorts by startedAt desc
	it('listSessions — 2 active + 2 ended → 4 items sorted by startedAt desc', async () => {
		const now = Date.now();
		await saveSessionState(
			makeState({ sessionId: 'sess-old', startedAt: new Date(now - 30_000).toISOString() }),
			env.dir,
		);
		await saveSessionState(
			makeState({ sessionId: 'sess-new', startedAt: new Date(now).toISOString() }),
			env.dir,
		);
		await saveSessionState(
			makeState({
				sessionId: 'sess-ended',
				phase: 'ended',
				startedAt: new Date(now - 20_000).toISOString(),
				endedAt: new Date(now - 5_000).toISOString(),
			}),
			env.dir,
		);
		await saveSessionState(
			makeState({
				sessionId: 'sess-mid',
				startedAt: new Date(now - 10_000).toISOString(),
			}),
			env.dir,
		);

		const sessions = await listSessions(env.dir);
		expect(sessions.map((s) => s.id)).toEqual(['sess-new', 'sess-mid', 'sess-ended', 'sess-old']);
		expect(sessions.filter((s) => s.status === 'active')).toHaveLength(3);
		expect(sessions.filter((s) => s.status === 'ended')).toHaveLength(1);
	});

	// Enrichment contract: registry.getByAgentType → agentDescription / agentIsPreview
	it('listSessions — enriches agent description + isPreview from registry', async () => {
		await setAgentLookup((t) =>
			t === 'Claude Code'
				? { description: () => 'Anthropic Claude Code', isPreview: () => false }
				: null,
		);
		await saveSessionState(makeState({ sessionId: 'sess-1', agentType: 'Claude Code' }), env.dir);
		await saveSessionState(makeState({ sessionId: 'sess-2', agentType: 'Other' }), env.dir);

		const sessions = await listSessions(env.dir);
		const byId = new Map(sessions.map((s) => [s.id, s]));
		expect(byId.get('sess-1')?.agentDescription).toBe('Anthropic Claude Code');
		expect(byId.get('sess-1')?.agentIsPreview).toBe(false);
		// Unknown agent → empty description
		expect(byId.get('sess-2')?.agentDescription).toBe('');
		expect(byId.get('sess-2')?.agentIsPreview).toBe(false);
	});

	// Go: strategy/session.go:ListSessions — checkpoint count + filesTouched via metadata branch
	it('listSessions — checkpointCount + filesChanged derived from metadata branch', async () => {
		await saveSessionState(makeState({ sessionId: 'sess-1' }), env.dir);
		await setListCheckpoints([
			{
				checkpointId: 'aa112233cc00',
				sessionId: 'sess-1',
				createdAt: new Date('2026-04-22T10:00:00Z'),
				checkpointsCount: 1,
				filesTouched: ['a.ts', 'b.ts'],
			},
			{
				checkpointId: 'bb112233cc00',
				sessionId: 'sess-1',
				createdAt: new Date('2026-04-22T12:00:00Z'),
				checkpointsCount: 1,
				filesTouched: ['b.ts', 'c.ts'],
			},
			{
				checkpointId: 'zz112233cc00',
				sessionId: 'other-session',
				createdAt: new Date('2026-04-22T13:00:00Z'),
				checkpointsCount: 1,
				filesTouched: ['x.ts'],
			},
		]);

		const [session] = await listSessions(env.dir);
		expect(session?.checkpointCount).toBe(2);
		expect(session?.filesChanged).toBe(3); // unique: a.ts, b.ts, c.ts
		expect(session?.lastCheckpointId).toBe('bb112233cc00');
		expect(session?.lastCheckpointAt).toBe('2026-04-22T12:00:00.000Z');
	});

	it('listSessions — exposes prompt and stuck-active display fields', async () => {
		const staleInteraction = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
		await saveSessionState(
			makeState({
				sessionId: 'sess-stale',
				phase: 'active',
				lastPrompt: 'Implement status pagination',
				lastInteractionTime: staleInteraction,
			}),
			env.dir,
		);

		const [session] = await listSessions(env.dir);
		expect(session?.lastPrompt).toBe('Implement status pagination');
		expect(session?.lastInteractionTime).toBe(staleInteraction);
		expect(session?.isStuckActive).toBe(true);
	});

	// Go: strategy/session.go:GetSession — exact match
	it('getSession — exact id match → full EnrichedSession', async () => {
		await saveSessionState(
			makeState({ sessionId: 'sess-abc123', agentType: 'Claude Code' }),
			env.dir,
		);
		const got = await getSession('sess-abc123', env.dir);
		expect(got.id).toBe('sess-abc123');
		expect(got.agentType).toBe('Claude Code');
		expect(got.status).toBe('active');
	});

	// Go: strategy/session.go:GetSession → ErrNoSession
	it('getSession — unknown id → SilentError "Session not found"', async () => {
		await expect(getSession('unknown', env.dir)).rejects.toThrow(SilentError);
		await expect(getSession('unknown', env.dir)).rejects.toThrow(/Session not found/);
	});

	// Go: sessions.go:resolveSessionIDPrefix + strategy/session.go:findSessionByID
	// Prefix semantics are strict `strings.HasPrefix` — matching Go exactly.
	it('resolveSessionIdPrefix — unique prefix returns full id', async () => {
		await saveSessionState(makeState({ sessionId: 'sess-abc123' }), env.dir);
		await saveSessionState(makeState({ sessionId: 'sess-xyz789' }), env.dir);

		const got = await resolveSessionIdPrefix('sess-abc', env.dir);
		expect(got).toBe('sess-abc123');
		const got2 = await resolveSessionIdPrefix('sess-a', env.dir);
		expect(got2).toBe('sess-abc123');
	});

	// Exact match beats any other prefix candidate (Go `session.ID == sessionID` branch first).
	it('resolveSessionIdPrefix — exact match wins even if it is a prefix of another id', async () => {
		await saveSessionState(makeState({ sessionId: 'sess-a' }), env.dir);
		await saveSessionState(makeState({ sessionId: 'sess-a-extended' }), env.dir);

		// 'sess-a' exact-matches the first session even though it's also a prefix of 'sess-a-extended'.
		const got = await resolveSessionIdPrefix('sess-a', env.dir);
		expect(got).toBe('sess-a');
	});

	it('resolveSessionIdPrefix — ambiguous prefix → SilentError "Ambiguous"', async () => {
		await saveSessionState(makeState({ sessionId: 'sess-ab001' }), env.dir);
		await saveSessionState(makeState({ sessionId: 'sess-ab002' }), env.dir);

		await expect(resolveSessionIdPrefix('sess-ab', env.dir)).rejects.toThrow(/Ambiguous/);
		await expect(resolveSessionIdPrefix('sess-ab', env.dir)).rejects.toThrow(/sess-ab001/);
		await expect(resolveSessionIdPrefix('sess-ab', env.dir)).rejects.toThrow(/sess-ab002/);
	});

	it('resolveSessionIdPrefix — no match → SilentError "Session not found"', async () => {
		await saveSessionState(makeState({ sessionId: 'sess-abc' }), env.dir);
		await expect(resolveSessionIdPrefix('zzz', env.dir)).rejects.toThrow(/Session not found/);
	});

	it('resolveSessionIdPrefix — empty prefix → SilentError "Missing argument"', async () => {
		await expect(resolveSessionIdPrefix('', env.dir)).rejects.toThrow(/Missing argument/);
	});

	// Go: sessions.go:filterActiveSessions
	it('findActiveSessions — returns only status==="active" sessions', async () => {
		expect(await findActiveSessions(env.dir)).toEqual([]);

		await saveSessionState(makeState({ sessionId: 'sess-active-1', phase: 'active' }), env.dir);
		const one = await findActiveSessions(env.dir);
		expect(one.map((s) => s.id)).toEqual(['sess-active-1']);

		await saveSessionState(makeState({ sessionId: 'sess-idle-1', phase: 'idle' }), env.dir);
		await saveSessionState(
			makeState({
				sessionId: 'sess-ended-1',
				phase: 'ended',
				endedAt: new Date().toISOString(),
			}),
			env.dir,
		);
		const twoActive = await findActiveSessions(env.dir);
		expect(twoActive.map((s) => s.id).sort()).toEqual(['sess-active-1', 'sess-idle-1']);
	});

	it('findActiveSessions — filters out ended sessions even with phase==="active"', async () => {
		await saveSessionState(
			makeState({
				sessionId: 'sess-tombstoned',
				phase: 'active',
				endedAt: new Date().toISOString(),
			}),
			env.dir,
		);
		const active = await findActiveSessions(env.dir);
		expect(active).toEqual([]);
	});

	// Go: lifecycle.go:markSessionEnded — session transitions to ended + endedAt set
	it('markSessionEnded — sets phase to ended + stamps endedAt', async () => {
		await saveSessionState(makeState({ sessionId: 'sess-to-end', phase: 'active' }), env.dir);

		await markSessionEnded('sess-to-end', env.dir);

		const after = await loadSessionState('sess-to-end', env.dir);
		expect(after?.phase).toBe('ended');
		expect(after?.endedAt).toBeTruthy();
		expect(new Date(after!.endedAt as string).getTime()).toBeGreaterThan(0);
	});

	// Go: lifecycle.go:markSessionEnded — idempotent on already-ended session
	it('markSessionEnded — idempotent on already-ended session', async () => {
		const firstEndedAt = new Date(Date.now() - 60_000).toISOString();
		await saveSessionState(
			makeState({
				sessionId: 'sess-ended-already',
				phase: 'ended',
				endedAt: firstEndedAt,
			}),
			env.dir,
		);

		await markSessionEnded('sess-ended-already', env.dir);

		const after = await loadSessionState('sess-ended-already', env.dir);
		expect(after?.phase).toBe('ended');
		// endedAt should be refreshed (state machine re-fired SessionStop)
		expect(after?.endedAt).toBeTruthy();
	});

	// Go: lifecycle.go:markSessionEnded — no state file = silent no-op
	it('markSessionEnded — non-existent session is a no-op (no throw)', async () => {
		await expect(markSessionEnded('sess-never-existed', env.dir)).resolves.toBeUndefined();
	});
});
