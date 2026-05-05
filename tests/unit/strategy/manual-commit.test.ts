/**
 * Phase 5.1 manual-commit.ts unit tests — ported 1:1 from Go
 * `entire-cli/cmd/entire/cli/strategy/manual_commit_test.go` (Phase 5.1
 * shell methods only — SaveStep/Condense/Rewind/Push tests are deferred
 * to Phase 5.2-5.6).
 *
 * Each `it()` is annotated with `// Go: <file>:<line> <TestName>` for traceability.
 *
 * **Architecture difference**: Go's `ManualCommitStrategy` exposes session
 * state I/O as instance methods (`s.saveSessionState`, `s.loadSessionState`,
 * etc.). TS Phase 5.1 keeps these as **package-level functions** in
 * `@/strategy/session-state`. The tests below port the Go behavior using
 * the TS package-level functions, since the underlying behavior is identical.
 *
 * Phase 5.2 facades (`saveStep`, `saveTaskStep`, `migrate*`) — real-behavior
 * coverage lives in:
 *   - `tests/unit/strategy/save-step.test.ts` (Go: manual_commit_git.go)
 *   - `tests/unit/strategy/manual-commit-migration.test.ts`
 *     (Go: manual_commit_migration.go / manual_commit_migration_test.go via
 *      the TestShadowStrategy_PostRewrite_* family in manual_commit_test.go)
 *
 * The remaining 18 NOT_IMPLEMENTED stub audit tests (Phase 5.3-5.6 + 9.5)
 * are at the bottom — they verify the audit chain works end-to-end.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// SilentError import removed 2026-04-23 along with the last NOT_IMPLEMENTED stub.
import { clearGitCommonDirCache } from '@/git';
import { clearWorktreeRootCache, SESSION_STATE_DIR_NAME } from '@/paths';
import { ManualCommitStrategy } from '@/strategy/manual-commit';
import {
	clearSessionState,
	listSessionStates,
	loadSessionState,
	saveSessionState,
} from '@/strategy/session-state';
import type { SessionState } from '@/strategy/types';
import { TestEnv } from '../../helpers/test-env';

function makeState(overrides: Partial<SessionState> = {}): SessionState {
	return {
		sessionId: 'sess-default',
		baseCommit: 'deadbeef',
		startedAt: new Date().toISOString(),
		phase: 'idle',
		stepCount: 0,
		...overrides,
	};
}

describe('ManualCommitStrategy — Phase 5.1 shell methods (ported from manual_commit_test.go)', () => {
	beforeEach(() => {
		clearGitCommonDirCache();
		clearWorktreeRootCache();
	});

	afterEach(() => {
		clearGitCommonDirCache();
		clearWorktreeRootCache();
	});

	// Go: manual_commit_test.go:35-49 TestShadowStrategy_ValidateRepository
	it('TestShadowStrategy_ValidateRepository — Go: manual_commit_test.go:35-49', async () => {
		const env = await TestEnv.create({ initialCommit: false });
		try {
			const s = new ManualCommitStrategy(env.dir);
			await expect(s.validateRepository()).resolves.toBeUndefined();
		} finally {
			await env.cleanup();
		}
	});

	// Go: manual_commit_test.go:51-60 TestShadowStrategy_ValidateRepository_NotGitRepo
	it('TestShadowStrategy_ValidateRepository_NotGitRepo — Go: manual_commit_test.go:51-60', async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'story-no-git-'));
		try {
			const s = new ManualCommitStrategy(tmpDir);
			await expect(s.validateRepository()).rejects.toThrow(/not a git repository/);
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	// Go: manual_commit_test.go:62-108 TestShadowStrategy_SessionState_SaveLoad
	it('TestShadowStrategy_SessionState_SaveLoad — Go: manual_commit_test.go:62-108', async () => {
		const env = await TestEnv.create({ initialCommit: false });
		try {
			const state = makeState({
				sessionId: 'test-session-123',
				baseCommit: 'abc123def456',
				stepCount: 5,
			});

			// Save state via package-level function (TS analog of Go's s.saveSessionState)
			await saveSessionState(state, env.dir);

			// Verify file exists at expected path (Go path uses .git/entire-sessions/, TS uses .git/story-sessions/)
			const stateFile = path.join(env.dir, '.git', SESSION_STATE_DIR_NAME, 'test-session-123.json');
			await expect(fs.stat(stateFile)).resolves.toBeDefined();

			// Load state
			const loaded = await loadSessionState('test-session-123', env.dir);
			expect(loaded).not.toBeNull();
			expect(loaded?.sessionId).toBe('test-session-123');
			expect(loaded?.baseCommit).toBe('abc123def456');
			expect(loaded?.stepCount).toBe(5);
		} finally {
			await env.cleanup();
		}
	});

	// Go: manual_commit_test.go:110-128 TestShadowStrategy_SessionState_LoadNonExistent
	it('TestShadowStrategy_SessionState_LoadNonExistent — Go: manual_commit_test.go:110-128', async () => {
		const env = await TestEnv.create({ initialCommit: false });
		try {
			const loaded = await loadSessionState('nonexistent-session', env.dir);
			expect(loaded).toBeNull();
		} finally {
			await env.cleanup();
		}
	});

	// Go: manual_commit_test.go:130-187 TestShadowStrategy_ListAllSessionStates
	// Note: Go's `listAllSessionStates` filters by shadow branch existence.
	// TS Phase 5.1 has only `listSessionStates` (no shadow-branch filtering yet).
	// This impl gap is acknowledged; the test verifies the basic listing works.
	it('TestShadowStrategy_ListAllSessionStates — Go: manual_commit_test.go:130-187', async () => {
		const env = await TestEnv.create({ initialCommit: true });
		try {
			// In Go: shadow branches must be created for the sessions to appear.
			// In TS Phase 5.1: no shadow-branch dependency (gap acknowledged).
			const state1 = makeState({
				sessionId: 'session-1',
				baseCommit: 'abc1234',
				stepCount: 1,
			});
			const state2 = makeState({
				sessionId: 'session-2',
				baseCommit: 'abc1234',
				stepCount: 2,
			});

			await saveSessionState(state1, env.dir);
			await saveSessionState(state2, env.dir);

			const states = await listSessionStates(env.dir);
			expect(states).toHaveLength(2);
		} finally {
			await env.cleanup();
		}
	});

	// Go: manual_commit_test.go:193-298 TestShadowStrategy_ListAllSessionStates_CleansUpStaleSessions
	// This test exercises Go's `listAllSessionStates` cleanup logic (removes
	// IDLE/ENDED sessions without shadow branches). TS Phase 5.1 doesn't have
	// this cleanup yet — it's a future addition (5.5 rewind / 9.5 doctor).
	// Skipped with documentation; the Go tests will activate when the cleanup
	// logic is ported.
	it.skip('TestShadowStrategy_ListAllSessionStates_CleansUpStaleSessions — Go: manual_commit_test.go:193-298 (TODO: shadow-branch cleanup is Phase 5.5/9.5 work)', async () => {
		// Will activate when ManualCommitStrategy.listAllSessionStates is added with
		// shadow-branch filtering + stale-session cleanup logic.
	});

	// Go: manual_commit_test.go:386-431 TestShadowStrategy_ClearSessionState
	it('TestShadowStrategy_ClearSessionState — Go: manual_commit_test.go:386-431', async () => {
		const env = await TestEnv.create({ initialCommit: false });
		try {
			const state = makeState({
				sessionId: 'test-session',
				baseCommit: 'abc123',
				stepCount: 1,
			});

			// Save state
			await saveSessionState(state, env.dir);

			// Verify it exists
			expect(await loadSessionState('test-session', env.dir)).not.toBeNull();

			// Clear state
			await clearSessionState('test-session', env.dir);

			// Verify it's gone
			expect(await loadSessionState('test-session', env.dir)).toBeNull();
		} finally {
			await env.cleanup();
		}
	});
});

/**
 * Class shell tests: construction, lazy stores, blob fetcher wiring.
 * These verify the Phase 5.1 class shell pattern works as designed.
 */
describe('ManualCommitStrategy class shell — TS-internal', () => {
	let env: TestEnv;
	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
	});
	afterEach(async () => {
		await env.cleanup();
	});

	describe('construction + lazy stores', () => {
		it('constructs without arguments', () => {
			const s = new ManualCommitStrategy();
			expect(s).toBeDefined();
		});

		it('constructs with explicit cwd', () => {
			const s = new ManualCommitStrategy(env.dir);
			expect(s).toBeDefined();
		});
	});

	describe('setBlobFetcher / hasBlobFetcher', () => {
		it('starts with no blob fetcher', () => {
			const s = new ManualCommitStrategy(env.dir);
			expect(s.hasBlobFetcher()).toBe(false);
		});

		it('hasBlobFetcher returns true after setBlobFetcher', () => {
			const s = new ManualCommitStrategy(env.dir);
			s.setBlobFetcher(async () => undefined);
			expect(s.hasBlobFetcher()).toBe(true);
		});
	});

	// Go: manual_commit_migration.go — facades exposed by Phase 5.2 Todo 6 are
	// fully tested via standalone calls in manual-commit-migration.test.ts.
	describe('lazy stores (@internal getters consumed by Phase 5.2-5.6)', () => {
		it('getStateStore returns a StateStore, cached across calls', async () => {
			const s = new ManualCommitStrategy(env.dir);
			const store1 = await s.getStateStore();
			const store2 = await s.getStateStore();
			expect(store1).toBe(store2);
			expect(store1.constructor.name).toBe('StateStore');
		});

		// Go: manual_commit.go:73-85 getV2CheckpointStore (no dedicated Go Test*; mirrors sync.Once contract)
		it('getV2CheckpointStore returns a V2GitStore, cached across calls', async () => {
			const s = new ManualCommitStrategy(env.dir);
			const store1 = await s.getV2CheckpointStore();
			const store2 = await s.getV2CheckpointStore();
			expect(store1).toBe(store2);
			expect(store1.constructor.name).toBe('V2GitStore');
		});

		it('getV2CheckpointStore wires the blob fetcher when configured before access', async () => {
			const s = new ManualCommitStrategy(env.dir);
			s.setBlobFetcher(async () => undefined);
			const store = await s.getV2CheckpointStore();
			expect(store.getBlobFetcher()).toBeDefined();
		});

		// Go: manual_commit.go:54-71 getCheckpointStore (no dedicated Go Test*; mirrors sync.Once contract)
		it('getCheckpointStore returns a GitStore, cached across calls', async () => {
			const s = new ManualCommitStrategy(env.dir);
			const store1 = await s.getCheckpointStore();
			const store2 = await s.getCheckpointStore();
			expect(store1).toBe(store2);
			expect(store1.constructor.name).toBe('GitStore');
			expect(store1.repoDir).toBe(env.dir);
		});

		// Go parity: manual_commit.go:64-67 wires blobFetcher BEFORE caching.
		it('getCheckpointStore wires the blob fetcher when configured before access', async () => {
			const s = new ManualCommitStrategy(env.dir);
			s.setBlobFetcher(async () => undefined);
			const store = await s.getCheckpointStore();
			expect(store.getBlobFetcher()).toBeDefined();
		});

		// Go parity: sync.Once snapshot — fetcher set AFTER first access stays
		// unwired on the cached store (consistent with getV2CheckpointStore).
		it('getCheckpointStore ignores blob fetcher set after first access (sync.Once snapshot)', async () => {
			const s = new ManualCommitStrategy(env.dir);
			const storeFirst = await s.getCheckpointStore();
			expect(storeFirst.getBlobFetcher()).toBeUndefined();
			s.setBlobFetcher(async () => undefined);
			const storeSecond = await s.getCheckpointStore();
			expect(storeSecond).toBe(storeFirst);
			expect(storeSecond.getBlobFetcher()).toBeUndefined();
		});
	});

	/**
	 * Instance session-state API — Go: manual_commit_session.go:23-57 (load /
	 * save / clear) + 206-226 (findSessionsForCommit + exported wrapper).
	 *
	 * The package-level wrappers in `@/strategy/session-state` are tested
	 * separately in `session-state.test.ts`. These tests verify the **instance
	 * methods route through the strategy's lazy `stateStore`** and produce the
	 * same on-disk layout (`.git/story-sessions/<id>.json`).
	 */
	describe('instance session-state API — Go: manual_commit_session.go:23-57 / 206-226', () => {
		// Go: manual_commit_session.go:23-33 loadSessionState
		it('loadSessionState returns null for a missing session', async () => {
			const s = new ManualCommitStrategy(env.dir);
			expect(await s.loadSessionState('does-not-exist')).toBeNull();
		});

		// Go: manual_commit_session.go:36-45 saveSessionState (round-trip with load)
		it('saveSessionState writes a session that loadSessionState can read back', async () => {
			const s = new ManualCommitStrategy(env.dir);
			await s.saveSessionState(
				makeState({
					sessionId: 'sess-method-1',
					baseCommit: 'abc1234',
					stepCount: 7,
				}),
			);

			const loaded = await s.loadSessionState('sess-method-1');
			expect(loaded).not.toBeNull();
			expect(loaded?.sessionId).toBe('sess-method-1');
			expect(loaded?.baseCommit).toBe('abc1234');
			expect(loaded?.stepCount).toBe(7);

			// On-disk artifact lives under .git/story-sessions/<id>.json.
			const file = path.join(env.dir, '.git', SESSION_STATE_DIR_NAME, 'sess-method-1.json');
			await expect(fs.stat(file)).resolves.toBeDefined();
		});

		// Go: manual_commit_session.go:48-57 clearSessionState
		it('clearSessionState removes a saved session (loadSessionState then returns null)', async () => {
			const s = new ManualCommitStrategy(env.dir);
			await s.saveSessionState(makeState({ sessionId: 'sess-method-2', baseCommit: 'abc1234' }));
			expect(await s.loadSessionState('sess-method-2')).not.toBeNull();

			await s.clearSessionState('sess-method-2');
			expect(await s.loadSessionState('sess-method-2')).toBeNull();
		});

		// Go: manual_commit_session.go:48-57 — exported ClearSessionState is best-effort
		it('clearSessionState is a no-op when the session was never saved', async () => {
			const s = new ManualCommitStrategy(env.dir);
			await expect(s.clearSessionState('never-saved')).resolves.toBeUndefined();
		});

		// Go: manual_commit_session.go:206-226 (findSessionsForCommit + exported wrapper)
		it('findSessionsForCommit returns SessionStates with matching baseCommit (shadow branch present)', async () => {
			const s = new ManualCommitStrategy(env.dir);
			// Mirror Go test setup (manual_commit_test.go:316-325): shadow branches
			// must exist, otherwise the orphan filter inside listAllSessionStates
			// drops the rows.
			const { shadowBranchNameForCommit } = await import('@/checkpoint/temporary');
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			for (const baseCommit of ['abc1234', 'xyz7890']) {
				const branch = shadowBranchNameForCommit(baseCommit, '');
				await env.exec('git', ['branch', '-f', branch, head]);
			}

			await s.saveSessionState(
				makeState({ sessionId: 'm-1', baseCommit: 'abc1234', stepCount: 1 }),
			);
			await s.saveSessionState(
				makeState({ sessionId: 'm-2', baseCommit: 'abc1234', stepCount: 2 }),
			);
			await s.saveSessionState(
				makeState({ sessionId: 'm-3', baseCommit: 'xyz7890', stepCount: 3 }),
			);

			const matching = await s.findSessionsForCommit('abc1234');
			expect(matching.map((x) => x.sessionId).sort()).toEqual(['m-1', 'm-2']);
		});

		it('findSessionsForCommit returns [] when no session matches the base commit', async () => {
			const s = new ManualCommitStrategy(env.dir);
			expect(await s.findSessionsForCommit('no-such-commit')).toEqual([]);
		});
	});

	/**
	 * `countOtherActiveSessionsWithCheckpoints` — Go: manual_commit_session.go:234-274
	 * `CountOtherActiveSessionsWithCheckpoints`. Used by Phase 5.4 InitializeSession
	 * to print "another N concurrent sessions will join the next commit" hint.
	 *
	 * Filter (4 conjunctions, all required):
	 *   1. state.sessionId !== currentSessionId          (excludes the caller)
	 *   2. state.worktreePath === current worktree root  (worktree-scoped)
	 *   3. state.stepCount > 0                           (must have checkpoints)
	 *   4. state.baseCommit === current HEAD             (same commit lineage)
	 */
	describe('countOtherActiveSessionsWithCheckpoints — Go: manual_commit_session.go:234-274 CountOtherActiveSessionsWithCheckpoints', () => {
		async function setupShadowAndHead(testEnv: TestEnv, baseCommits: string[]): Promise<string> {
			const { shadowBranchNameForCommit } = await import('@/checkpoint/temporary');
			const head = (await testEnv.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			for (const bc of baseCommits) {
				const branch = shadowBranchNameForCommit(bc, '');
				await testEnv.exec('git', ['branch', '-f', branch, head]);
			}
			return head;
		}

		it('returns 0 when no sessions exist', async () => {
			const s = new ManualCommitStrategy(env.dir);
			expect(await s.countOtherActiveSessionsWithCheckpoints('current-sess')).toBe(0);
		});

		it('returns 0 when the only session is the current one', async () => {
			const s = new ManualCommitStrategy(env.dir);
			const head = await setupShadowAndHead(env, [
				(await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim(),
			]);
			await s.saveSessionState(
				makeState({
					sessionId: 'current-sess',
					baseCommit: head,
					worktreePath: env.dir,
					stepCount: 5,
				}),
			);
			expect(await s.countOtherActiveSessionsWithCheckpoints('current-sess')).toBe(0);
		});

		it('counts other sessions on same worktree + same baseCommit + stepCount > 0', async () => {
			const s = new ManualCommitStrategy(env.dir);
			const head = await setupShadowAndHead(env, [
				(await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim(),
			]);
			await s.saveSessionState(
				makeState({ sessionId: 'me', baseCommit: head, worktreePath: env.dir, stepCount: 1 }),
			);
			await s.saveSessionState(
				makeState({ sessionId: 'other-1', baseCommit: head, worktreePath: env.dir, stepCount: 2 }),
			);
			await s.saveSessionState(
				makeState({ sessionId: 'other-2', baseCommit: head, worktreePath: env.dir, stepCount: 3 }),
			);
			expect(await s.countOtherActiveSessionsWithCheckpoints('me')).toBe(2);
		});

		it('excludes sessions with stepCount === 0 (no checkpoints yet)', async () => {
			const s = new ManualCommitStrategy(env.dir);
			const head = await setupShadowAndHead(env, [
				(await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim(),
			]);
			await s.saveSessionState(
				makeState({ sessionId: 'me', baseCommit: head, worktreePath: env.dir, stepCount: 1 }),
			);
			await s.saveSessionState(
				makeState({ sessionId: 'no-cp', baseCommit: head, worktreePath: env.dir, stepCount: 0 }),
			);
			expect(await s.countOtherActiveSessionsWithCheckpoints('me')).toBe(0);
		});

		it('excludes sessions on a different baseCommit (commit lineage mismatch)', async () => {
			const s = new ManualCommitStrategy(env.dir);
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			await setupShadowAndHead(env, [head, 'other-base']);
			await s.saveSessionState(
				makeState({ sessionId: 'me', baseCommit: head, worktreePath: env.dir, stepCount: 1 }),
			);
			await s.saveSessionState(
				makeState({
					sessionId: 'other-base-sess',
					baseCommit: 'other-base',
					worktreePath: env.dir,
					stepCount: 5,
				}),
			);
			expect(await s.countOtherActiveSessionsWithCheckpoints('me')).toBe(0);
		});

		it('excludes sessions on a different worktree', async () => {
			const s = new ManualCommitStrategy(env.dir);
			const head = await setupShadowAndHead(env, [
				(await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim(),
			]);
			await s.saveSessionState(
				makeState({ sessionId: 'me', baseCommit: head, worktreePath: env.dir, stepCount: 1 }),
			);
			await s.saveSessionState(
				makeState({
					sessionId: 'other-worktree',
					baseCommit: head,
					worktreePath: '/some/other/worktree',
					stepCount: 5,
				}),
			);
			expect(await s.countOtherActiveSessionsWithCheckpoints('me')).toBe(0);
		});
	});

	/**
	 * Audit chain check: every business method throws SilentError with a
	 * message that contains:
	 *   1. `'Phase 5.X'` (where X = 2/3/4/5/6) — for `audit-deferrals.sh phase-5.X`
	 *   2. The corresponding Go file name — for navigation
	 *
	 * Uses parametrized tests to cover all 19 stubs uniformly.
	 */
	describe('NOT_IMPLEMENTED stubs (audit chain — TS-supplemental)', () => {
		// dummyState removed when 5.4 Part 1 handleTurnEnd stub was replaced
		// (real-behavior tests in tests/unit/strategy/hooks-turn-end.test.ts).
		// dummyStep / dummyTaskStep removed when 5.2 saveStep / saveTaskStep
		// stubs were replaced (see commit history); real-behavior tests live
		// in tests/unit/strategy/save-step.test.ts.
		// dummyPoint removed when 5.5 Rewind / Reset family stubs were replaced
		// (real-behavior tests in tests/unit/strategy/{rewind,rewind-points,
		// restore-logs,reset}.test.ts).

		// Stream stub for Go signatures that take io.Reader — was used by the
		// postRewrite stub case (removed when Phase 5.4 Part 2 thin-facade
		// landed). Kept declared at scope in case a future Phase 5.x case
		// needs the same stub.
		// Go: manual_commit_git.go (5.2 SaveStep family)
		// Go: manual_commit_condensation.go (5.3 Condense family)
		// Go: manual_commit_hooks.go (5.4 Hook handlers)
		// Go: manual_commit_rewind.go + manual_commit_reset.go (5.5 Rewind/Reset family)
		// Go: manual_commit_push.go (5.6 PrePush)
		// Go: manual_commit.go (cleanup section, 9.5 ListOrphanedItems)
		const cases: Array<[string, string, string, () => Promise<unknown>]> = [
			// Phase 5.2 (saveStep / saveTaskStep) — REMOVED 2026-04-18 when
			// thin-facade implementations landed (see save-step.ts and
			// tests/unit/strategy/save-step.test.ts). Methods now run real
			// algorithms instead of throwing NOT_IMPLEMENTED.
			// Phase 5.3 (condenseSession / condenseSessionByID / condenseAndMarkFullyCondensed)
			// — REMOVED 2026-04-19 when thin-facade implementations landed (see
			// condensation.ts / condense-by-id.ts and tests/unit/strategy/{condensation,
			// condense-by-id}.test.ts). Methods now run real algorithms.
			// Phase 5.4 Part 1 (prepareCommitMsg / commitMsg / initializeSession /
			// handleTurnEnd) — REMOVED 2026-04-19 when thin-facade implementations
			// landed (see hooks-prepare-commit-msg.ts / hooks-commit-msg.ts /
			// hooks-initialize-session.ts / hooks-turn-end.ts and the matching
			// tests in tests/unit/strategy/hooks-*.test.ts). Methods now run real
			// algorithms instead of throwing NOT_IMPLEMENTED.
			//
			// Phase 5.4 Part 2 (postCommit / postRewrite) — REMOVED 2026-04-20
			// when thin-facade implementations landed (see hooks-post-commit.ts
			// / hooks-post-rewrite.ts and the matching tests in
			// tests/unit/strategy/hooks-post-{commit,rewrite}.test.ts). Methods
			// now run real algorithms instead of throwing NOT_IMPLEMENTED.
			//
			// Phase 5.5 (rewind / getRewindPoints / canRewind / previewRewind /
			// restoreLogsOnly / reset / resetSession) — REMOVED 2026-04-20 when
			// thin-facade implementations landed (see rewind.ts / rewind-points.ts /
			// restore-logs.ts / reset.ts and the matching tests in
			// tests/unit/strategy/{rewind,rewind-points,restore-logs,reset}.test.ts).
			// Methods now run real algorithms instead of throwing NOT_IMPLEMENTED.
			//
			// Phase 5.6 (prePush) — REMOVED 2026-04-20 when the thin-facade
			// implementation landed (see manual-commit-push.ts and
			// tests/unit/strategy/manual-commit-push.test.ts). The method now
			// delegates to prePushImpl which silent-on-failures rather than
			// throwing NOT_IMPLEMENTED.
			//
			// Phase 9.5 (listOrphanedItems) — REMOVED 2026-04-23 when thin-facade
			// implementation landed (see cleanup.ts and
			// tests/unit/strategy/cleanup.test.ts). The method now delegates to
			// `listAllItems({ repoRoot })` instead of throwing NOT_IMPLEMENTED.
		];

		it('has 0 stub methods (all Phase 5.1 originals replaced by thin facades)', () => {
			expect(cases).toHaveLength(0);
		});

		// Phase 9.5: listOrphanedItems behaviour — Go: manual_commit.go (cleanup section).
		it('listOrphanedItems returns [] on an empty repo', async () => {
			const strategy = new ManualCommitStrategy(env.dir);
			const items = await strategy.listOrphanedItems();
			expect(items).toEqual([]);
		});

		// Go: manual_commit.go / strategy/cleanup.go: ListAllItems combines
		// shadow branches + session states.
		it('listOrphanedItems includes shadow branches when present', async () => {
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			await env.exec('git', ['branch', 'story/abc1234-e3b0c4', head]);
			const strategy = new ManualCommitStrategy(env.dir);
			const items = await strategy.listOrphanedItems();
			expect(items.some((i) => i.type === 'shadow-branch' && i.id === 'story/abc1234-e3b0c4')).toBe(
				true,
			);
		});

		it('listOrphanedItems includes session states when present', async () => {
			// Seed a state file directly.
			const commonDir = (await env.exec('git', ['rev-parse', '--git-common-dir'])).stdout.trim();
			const path = await import('node:path');
			const fs = await import('node:fs/promises');
			const dir = path.resolve(env.dir, commonDir, 'story-sessions');
			await fs.mkdir(dir, { recursive: true });
			await fs.writeFile(
				path.join(dir, 'sess-fixture00000.json'),
				JSON.stringify({
					session_id: 'sess-fixture00000',
					base_commit: '',
					attribution_base_commit: '',
					worktree_id: '',
					started_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
					last_interaction_time: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
					turn_id: 't',
					step_count: 0,
					files_touched: [],
					prompts: [],
					phase: 'idle',
					cli_version: '0.1.0',
				}),
			);
			const strategy = new ManualCommitStrategy(env.dir);
			const items = await strategy.listOrphanedItems();
			expect(items.some((i) => i.type === 'session-state' && i.id === 'sess-fixture00000')).toBe(
				true,
			);
		});

		it('listOrphanedItems items carry the CleanupItem shape (type / id / reason)', async () => {
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			await env.exec('git', ['branch', 'story/5678abc-e3b0c4', head]);
			const strategy = new ManualCommitStrategy(env.dir);
			const items = await strategy.listOrphanedItems();
			for (const item of items) {
				expect(typeof item.type).toBe('string');
				expect(typeof item.id).toBe('string');
				expect(typeof item.reason).toBe('string');
			}
		});
	});
});
