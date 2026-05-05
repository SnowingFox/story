import fsCallback from 'node:fs';
import path from 'node:path';
import git from 'isomorphic-git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AGENT_TYPE_CLAUDE_CODE, AGENT_TYPE_CURSOR } from '@/agent/types';
import { shadowBranchNameForCommit } from '@/checkpoint/temporary';
import type { TokenUsage } from '@/session/state-store';
import { StateStore } from '@/session/state-store';
import {
	buildSessionMetrics,
	cleanupShadowBranchIfUnused,
	committedFilesExcludingMetadata,
	filterFilesTouched,
	marshalPromptAttributionsIncludingPending,
	redactSessionTranscript,
	resolveShadowRef,
	sessionStateBackfillTokenUsage,
} from '@/strategy/condense-helpers';
import { ManualCommitStrategy } from '@/strategy/manual-commit';
import type { ExtractedSessionData, PromptAttribution, SessionState } from '@/strategy/types';
import { TestEnv } from '../../helpers/test-env';

// Minimal ExtractedSessionData factory.
function emptyData(filesTouched: string[] = []): ExtractedSessionData {
	return {
		transcript: new Uint8Array(),
		fullTranscriptLines: 0,
		prompts: [],
		filesTouched,
		tokenUsage: null,
	};
}

function baseState(overrides: Partial<SessionState> = {}): SessionState {
	return {
		sessionId: 'sess-test',
		baseCommit: 'abc1234',
		// Use "now" so isStale doesn't auto-clear during list().
		startedAt: new Date().toISOString(),
		phase: 'idle',
		stepCount: 0,
		...overrides,
	};
}

// ──────── filterFilesTouched (3) ────────
// Go: cmd/entire/cli/strategy/manual_commit_condensation.go filterFilesTouched
describe('condense-helpers.filterFilesTouched', () => {
	it('intersects filesTouched with committedFiles', () => {
		const data = emptyData(['a', 'b', 'c']);
		filterFilesTouched(data, new Set(['b', 'c', 'd']));
		expect(data.filesTouched).toEqual(['b', 'c']);
	});

	it('falls back to committedFiles minus metadata when filesTouched empty', () => {
		const data = emptyData([]);
		filterFilesTouched(data, new Set(['a', '.story/x', '.entire/y']));
		expect(data.filesTouched).toEqual(['a']);
	});

	it('is a no-op when committedFiles is null or empty', () => {
		const data = emptyData(['x', 'y']);
		filterFilesTouched(data, null);
		expect(data.filesTouched).toEqual(['x', 'y']);
		filterFilesTouched(data, new Set());
		expect(data.filesTouched).toEqual(['x', 'y']);
	});
});

// ──────── committedFilesExcludingMetadata (2) ────────
// Go: cmd/entire/cli/strategy/manual_commit_condensation.go committedFilesExcludingMetadata
describe('condense-helpers.committedFilesExcludingMetadata', () => {
	it('filters .story/ and .entire/ paths', () => {
		const out = committedFilesExcludingMetadata(
			new Set(['a', '.story/state.json', 'b', '.entire/log']),
		);
		expect(out).toEqual(['a', 'b']);
	});

	it('sorts lexicographically', () => {
		const out = committedFilesExcludingMetadata(new Set(['c', 'a', 'b']));
		expect(out).toEqual(['a', 'b', 'c']);
	});
});

// ──────── marshalPromptAttributionsIncludingPending (2) ────────
// Go: cmd/entire/cli/strategy/manual_commit_condensation.go marshalPromptAttributionsIncludingPending
describe('condense-helpers.marshalPromptAttributionsIncludingPending', () => {
	it('returns null when no PAs and no pending', () => {
		const out = marshalPromptAttributionsIncludingPending(baseState());
		expect(out).toBeNull();
	});

	it('appends pending to PA list', () => {
		const pa1: PromptAttribution = {
			checkpointNumber: 1,
			userLinesAdded: 1,
			userLinesRemoved: 0,
			agentLinesAdded: 0,
			agentLinesRemoved: 0,
		};
		const pa2: PromptAttribution = {
			checkpointNumber: 2,
			userLinesAdded: 2,
			userLinesRemoved: 0,
			agentLinesAdded: 0,
			agentLinesRemoved: 0,
		};
		const pending: PromptAttribution = {
			checkpointNumber: 3,
			userLinesAdded: 3,
			userLinesRemoved: 0,
			agentLinesAdded: 0,
			agentLinesRemoved: 0,
		};
		const out = marshalPromptAttributionsIncludingPending(
			baseState({ promptAttributions: [pa1, pa2], pendingPromptAttribution: pending }),
		);
		expect(Array.isArray(out)).toBe(true);
		const arr = out as PromptAttribution[];
		expect(arr).toHaveLength(3);
		expect(arr[2]?.checkpointNumber).toBe(3);
		expect(arr[2]?.userLinesAdded).toBe(3);
	});
});

// ──────── buildSessionMetrics (2) ────────
// Go: cmd/entire/cli/strategy/manual_commit_condensation.go buildSessionMetrics
describe('condense-helpers.buildSessionMetrics', () => {
	it('returns null when all 4 fields are 0', () => {
		expect(buildSessionMetrics(baseState())).toBeNull();
	});

	it('builds full SessionMetrics when any field is non-zero', () => {
		const out = buildSessionMetrics(
			baseState({
				sessionDurationMs: 5000,
				sessionTurnCount: 3,
				contextTokens: 1234,
				contextWindowSize: 200000,
			}),
		);
		expect(out).toEqual({
			durationMs: 5000,
			turnCount: 3,
			contextTokens: 1234,
			contextWindowSize: 200000,
		});
	});

	it('includes Story turn metrics and active agent duration', () => {
		const turnMetrics = [
			{
				turnId: 'turn-1',
				startedAt: '2026-04-27T10:00:00.000Z',
				endedAt: '2026-04-27T10:00:30.000Z',
				durationMs: 30_000,
			},
			{
				turnId: 'turn-2',
				startedAt: '2026-04-27T10:01:00.000Z',
				endedAt: '2026-04-27T10:01:15.000Z',
				durationMs: 15_000,
			},
		];

		const out = buildSessionMetrics(
			baseState({
				sessionDurationMs: 120_000,
				activeDurationMs: 45_000,
				turnMetrics,
			}),
		);

		expect(out).toEqual({
			durationMs: 120_000,
			activeDurationMs: 45_000,
			turnMetrics,
			turnCount: 0,
			contextTokens: 0,
			contextWindowSize: 0,
		});
	});
});

// ──────── sessionStateBackfillTokenUsage (3) ────────
// Go: cmd/entire/cli/strategy/manual_commit_condensation.go sessionStateBackfillTokenUsage
// Go: cmd/entire/cli/strategy/manual_commit_condensation_test.go TestSessionStateBackfillTokenUsage_CopilotUsesZeroInputSessionAggregate
describe('condense-helpers.sessionStateBackfillTokenUsage', () => {
	const logCtx = { component: 'checkpoint', sessionId: 'sess-test' };

	// Go: condensation.go:519-545 sessionStateBackfillTokenUsage
	// 4-arm dispatch (1:1 with TS); arm 1 (Copilot fullSessionUsage) is
	// Phase 6.5 stub — falls through, NOT short-circuit return null.

	// Arm 3 happy path: any agent with a fully-populated checkpoint.
	it('arm 3: returns checkpointUsage for non-Copilot agents when hasTokenUsageData(checkpoint)', () => {
		const checkpoint: TokenUsage = {
			inputTokens: 50,
			cacheCreationTokens: 0,
			cacheReadTokens: 0,
			outputTokens: 100,
			apiCallCount: 1,
		};
		expect(
			sessionStateBackfillTokenUsage(logCtx, AGENT_TYPE_CLAUDE_CODE, new Uint8Array(), checkpoint),
		).toBe(checkpoint);
	});

	// Arm 3 critical: checkpoint with ONLY outputTokens > 0 must still pass through.
	// Bug 1 (audit-4): pre-fix TS used `inputTokens > 0` here and returned null —
	// silent data loss for output-only responses (some Anthropic streaming partials).
	// Go: hasTokenUsageData (condense.go:505-515) returns true on ANY non-zero counter.
	it('arm 3: returns checkpointUsage when only outputTokens > 0 (Bug 1 audit-4 regression guard)', () => {
		const checkpoint: TokenUsage = {
			inputTokens: 0,
			cacheCreationTokens: 0,
			cacheReadTokens: 0,
			outputTokens: 100,
			apiCallCount: 0,
		};
		expect(
			sessionStateBackfillTokenUsage(logCtx, AGENT_TYPE_CURSOR, new Uint8Array(), checkpoint),
		).toBe(checkpoint);
	});

	// Arm 3 critical: cached-only request (cacheReadTokens > 0, all else 0).
	// Real scenario: subsequent turn within same Claude prompt cache window.
	it('arm 3: returns checkpointUsage when only cacheReadTokens > 0 (cached request)', () => {
		const cached: TokenUsage = {
			inputTokens: 0,
			cacheCreationTokens: 0,
			cacheReadTokens: 200,
			outputTokens: 0,
			apiCallCount: 1,
		};
		expect(
			sessionStateBackfillTokenUsage(logCtx, AGENT_TYPE_CURSOR, new Uint8Array(), cached),
		).toBe(cached);
	});

	// Arm 3 critical: checkpoint with only subagent token data (recursive check).
	// Go: hasTokenUsageData recurses into subagentTokens; TS hasTokenUsageData mirrors.
	it('arm 3: returns checkpointUsage when only subagentTokens has data (recursive)', () => {
		const sub: TokenUsage = {
			inputTokens: 0,
			cacheCreationTokens: 0,
			cacheReadTokens: 0,
			outputTokens: 0,
			apiCallCount: 0,
			subagentTokens: {
				inputTokens: 50,
				cacheCreationTokens: 0,
				cacheReadTokens: 0,
				outputTokens: 75,
				apiCallCount: 2,
			},
		};
		expect(sessionStateBackfillTokenUsage(logCtx, AGENT_TYPE_CURSOR, new Uint8Array(), sub)).toBe(
			sub,
		);
	});

	// Arm 4: ALL counters zero AND no subagent → null. This is the only case
	// where Go returns nil for a non-Copilot agent with non-null checkpoint.
	it('arm 4: returns null when ALL counters AND subagentTokens are 0', () => {
		const empty: TokenUsage = {
			inputTokens: 0,
			cacheCreationTokens: 0,
			cacheReadTokens: 0,
			outputTokens: 0,
			apiCallCount: 0,
		};
		expect(
			sessionStateBackfillTokenUsage(logCtx, AGENT_TYPE_CURSOR, new Uint8Array(), empty),
		).toBeNull();
	});

	// Note: Copilot CLI dropped from the roadmap — see references/dropped-agents.md.
	// The Copilot-specific arm 1 (full-session reparse) and arm 2 (Copilot
	// checkpoint passthrough) were removed; arm 1 (any-agent passthrough) covers
	// all remaining cases.
});

// ──────── cleanupShadowBranchIfUnused (3) ────────
// Go: cmd/entire/cli/strategy/manual_commit_condensation.go cleanupShadowBranchIfUnused
describe('condense-helpers.cleanupShadowBranchIfUnused', () => {
	let env: TestEnv;
	let strategy: ManualCommitStrategy;
	let baseCommitOid: string;
	const SESSIONS_DIR_NAME = 'story-sessions';

	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		strategy = new ManualCommitStrategy(env.dir);
		baseCommitOid = await git.resolveRef({ fs: fsCallback, dir: env.dir, ref: 'HEAD' });
	});

	afterEach(async () => {
		await env.cleanup();
	});

	async function writeSessionStateFile(state: SessionState): Promise<void> {
		const dir = path.join(env.gitDir, SESSIONS_DIR_NAME);
		await fsCallback.promises.mkdir(dir, { recursive: true });
		const store = new StateStore(dir);
		await store.save(state);
	}

	async function createBranch(name: string): Promise<void> {
		await git.branch({ fs: fsCallback, dir: env.dir, ref: name, object: baseCommitOid });
	}

	async function branchExists(name: string): Promise<boolean> {
		try {
			await git.resolveRef({ fs: fsCallback, dir: env.dir, ref: `refs/heads/${name}` });
			return true;
		} catch {
			return false;
		}
	}

	it('deletes shadow branch when no other sessions reference it', async () => {
		const branch = shadowBranchNameForCommit(baseCommitOid, '');
		await createBranch(branch);
		await writeSessionStateFile(
			baseState({ sessionId: 'sess-1', baseCommit: baseCommitOid, stepCount: 1 }),
		);
		await cleanupShadowBranchIfUnused(strategy, env.dir, branch, 'sess-1');
		expect(await branchExists(branch)).toBe(false);
	});

	it('does NOT delete when another session has stepCount > 0', async () => {
		const branch = shadowBranchNameForCommit(baseCommitOid, '');
		await createBranch(branch);
		// Same baseCommit / worktreeId → same shadow branch name. Other session active.
		await writeSessionStateFile(
			baseState({ sessionId: 'sess-1', baseCommit: baseCommitOid, stepCount: 1 }),
		);
		await writeSessionStateFile(
			baseState({ sessionId: 'sess-2', baseCommit: baseCommitOid, stepCount: 2 }),
		);
		await cleanupShadowBranchIfUnused(strategy, env.dir, branch, 'sess-1');
		expect(await branchExists(branch)).toBe(true);
	});

	it('silently absorbs missing shadow branch (ErrBranchNotFound)', async () => {
		const branch = shadowBranchNameForCommit(baseCommitOid, '');
		// Branch never created.
		await writeSessionStateFile(
			baseState({ sessionId: 'sess-1', baseCommit: baseCommitOid, stepCount: 1 }),
		);
		await expect(
			cleanupShadowBranchIfUnused(strategy, env.dir, branch, 'sess-1'),
		).resolves.toBeUndefined();
	});
});

// ──────── resolveShadowRef (2) ────────
// Go: cmd/entire/cli/strategy/manual_commit_condensation.go resolveShadowRef
describe('condense-helpers.resolveShadowRef', () => {
	let env: TestEnv;

	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
	});

	afterEach(async () => {
		await env.cleanup();
	});

	it('uses preResolvedOid when provided', async () => {
		const out = await resolveShadowRef(env.dir, 'irrelevant', 'abc123');
		expect(out).toEqual({ refOid: 'abc123', exists: true });
	});

	it('returns { refOid: null, exists: false } when ref is missing', async () => {
		const out = await resolveShadowRef(env.dir, 'story/no-such-branch');
		expect(out).toEqual({ refOid: null, exists: false });
	});
});

// ──────── redactSessionTranscript (3) ────────
// Go: cmd/entire/cli/strategy/manual_commit_condensation.go redactSessionTranscript
describe('condense-helpers.redactSessionTranscript', () => {
	it('returns empty bytes for empty transcript', async () => {
		const out = await redactSessionTranscript(new Uint8Array());
		expect(out.redactedTranscript).toEqual(new Uint8Array());
		expect(out.durationMs).toBeGreaterThanOrEqual(0);
	});

	it('redacts secrets and reports duration', async () => {
		const lines = [JSON.stringify({ type: 'user', content: 'AKIAIOSFODNN7EXAMPLE in plaintext' })];
		const transcript = new TextEncoder().encode(`${lines.join('\n')}\n`);
		const out = await redactSessionTranscript(transcript);
		const decoded = new TextDecoder().decode(out.redactedTranscript);
		expect(decoded).toContain('REDACTED');
		expect(decoded).not.toContain('AKIAIOSFODNN7EXAMPLE');
		expect(out.durationMs).toBeGreaterThanOrEqual(0);
	});

	it('returns transcript unchanged when no secrets present', async () => {
		const transcript = new TextEncoder().encode('plain prose with no secrets\n');
		const out = await redactSessionTranscript(transcript);
		expect(new TextDecoder().decode(out.redactedTranscript)).toBe('plain prose with no secrets\n');
	});
});
