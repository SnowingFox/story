/**
 * Phase 5.1 manual-commit-session.ts unit tests — ported 1:1 from Go
 * `entire-cli/cmd/entire/cli/strategy/manual_commit_test.go`
 * (TestShadowStrategy_FindSessionsForCommit).
 *
 * Each `it()` is annotated with `// Go: <file>:<line> <TestName>` for traceability.
 *
 * **Architecture note**: TS Phase 5.1 ships `findSessionsForCommit` as a
 * package-level free function (not an instance method); the underlying behavior
 * — `listAllSessionStates` orphan filter + BaseCommit-equality match — is
 * Go-aligned end-to-end (Go: manual_commit_session.go:59-220).
 *
 * The legacy "ancestry-walk" helper that pre-Phase-5.1 lived behind the same
 * name is preserved as {@link findSessionsByTrailerWalk} for TS-only logs-only /
 * explain codepaths.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { shadowBranchNameForCommit } from '@/checkpoint/temporary';
import { clearGitCommonDirCache } from '@/git';
import { clearWorktreeRootCache } from '@/paths';
import { ManualCommitStrategy } from '@/strategy/manual-commit';
import {
	countWarnableStaleEndedSessions,
	findSessionsByTrailerWalk,
	findSessionsForCommit,
	findSessionsForWorktree,
	isWarnableStaleEndedSession,
	listAllSessionStates,
	type RewritePair,
	remapRewriteSHA,
	remapSessionForRewrite,
	shadowBranchExistsForBaseCommit,
} from '@/strategy/manual-commit-session';
import { loadSessionState, saveSessionState } from '@/strategy/session-state';
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

/**
 * Mirror Go test setup (manual_commit_test.go:316-325): create a shadow branch
 * for each `(baseCommit, worktreeID)` pair pointing at the current HEAD so the
 * orphan filter in `listAllSessionStates` keeps the corresponding SessionStates.
 */
async function createShadowBranches(env: TestEnv, baseCommits: string[]): Promise<void> {
	const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
	for (const bc of baseCommits) {
		const branch = shadowBranchNameForCommit(bc, '');
		await env.exec('git', ['branch', '-f', branch, head]);
	}
}

// Go: manual_commit_session.go — listAllSessionStates / findSessionsForCommit
describe('strategy/manual-commit-session — Go: manual_commit_session.go + manual_commit_session_test.go', () => {
	let env: TestEnv;
	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		clearGitCommonDirCache();
		clearWorktreeRootCache();
	});
	afterEach(async () => {
		await env.cleanup();
		clearGitCommonDirCache();
		clearWorktreeRootCache();
	});

	// Go: manual_commit_test.go:300-384 TestShadowStrategy_FindSessionsForCommit
	describe('TestShadowStrategy_FindSessionsForCommit — Go: manual_commit_test.go:300-384', () => {
		it('returns 2 sessions matching BaseCommit "abc1234" (Go assertions: lines 355-363)', async () => {
			// Mirror Go: create shadow branches for both BaseCommits FIRST so the
			// listAllSessionStates orphan filter keeps the SessionStates.
			await createShadowBranches(env, ['abc1234', 'xyz7890']);

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
			const state3 = makeState({
				sessionId: 'session-3',
				baseCommit: 'xyz7890',
				stepCount: 3,
			});
			await saveSessionState(state1, env.dir);
			await saveSessionState(state2, env.dir);
			await saveSessionState(state3, env.dir);

			const matching = await findSessionsForCommit(env.dir, 'abc1234');
			expect(matching).toHaveLength(2);
			const ids = matching.map((s) => s.sessionId).sort();
			expect(ids).toEqual(['session-1', 'session-2']);
		});

		it('returns 1 session matching BaseCommit "xyz7890" (Go assertions: lines 365-373)', async () => {
			await createShadowBranches(env, ['abc1234', 'xyz7890']);

			const state1 = makeState({ sessionId: 'session-1', baseCommit: 'abc1234' });
			const state2 = makeState({ sessionId: 'session-2', baseCommit: 'abc1234' });
			const state3 = makeState({ sessionId: 'session-3', baseCommit: 'xyz7890' });
			await saveSessionState(state1, env.dir);
			await saveSessionState(state2, env.dir);
			await saveSessionState(state3, env.dir);

			const matching = await findSessionsForCommit(env.dir, 'xyz7890');
			expect(matching).toHaveLength(1);
			expect(matching[0]?.sessionId).toBe('session-3');
		});

		it('returns 0 sessions for nonexistent base commit (Go assertions: lines 375-382)', async () => {
			await createShadowBranches(env, ['abc1234']);

			const state1 = makeState({ sessionId: 'session-1', baseCommit: 'abc1234' });
			await saveSessionState(state1, env.dir);

			const matching = await findSessionsForCommit(env.dir, 'nonexistent');
			expect(matching).toHaveLength(0);
		});
	});

	// Go: manual_commit_test.go:193-298 TestShadowStrategy_ListAllSessionStates_CleansUpStaleSessions
	// (4 cases ported in this `describe`)
	describe('listAllSessionStates orphan filter — Go: manual_commit_session.go:59-103', () => {
		it('keeps every row when shadow branches exist for each session', async () => {
			await createShadowBranches(env, ['abc1234', 'xyz7890']);
			await saveSessionState(
				makeState({ sessionId: 's1', baseCommit: 'abc1234', stepCount: 1 }),
				env.dir,
			);
			await saveSessionState(
				makeState({ sessionId: 's2', baseCommit: 'xyz7890', stepCount: 1 }),
				env.dir,
			);

			const live = await listAllSessionStates(env.dir);
			expect(live.map((s) => s.sessionId).sort()).toEqual(['s1', 's2']);
		});

		it('keeps an active-phase row even when its shadow branch is missing', async () => {
			// Active session that hasn't created a shadow branch yet — must NOT be culled.
			await saveSessionState(
				makeState({
					sessionId: 'sess-active',
					baseCommit: 'no-branch-yet',
					phase: 'active',
				}),
				env.dir,
			);

			const live = await listAllSessionStates(env.dir);
			expect(live.map((s) => s.sessionId)).toEqual(['sess-active']);
			// And the row is still on disk (NOT cleaned).
			expect(await loadSessionState('sess-active', env.dir)).not.toBeNull();
		});

		it('keeps an inactive row that still has a non-empty lastCheckpointId (id reuse needed)', async () => {
			await saveSessionState(
				makeState({
					sessionId: 'sess-keepid',
					baseCommit: 'no-branch',
					phase: 'idle',
					lastCheckpointId: 'a3b2c4d5e6f7',
				}),
				env.dir,
			);

			const live = await listAllSessionStates(env.dir);
			expect(live.map((s) => s.sessionId)).toEqual(['sess-keepid']);
			expect(await loadSessionState('sess-keepid', env.dir)).not.toBeNull();
		});

		it('drops + cleans pure orphans (idle + no shadow branch + empty lastCheckpointId)', async () => {
			await saveSessionState(
				makeState({
					sessionId: 'sess-orphan',
					baseCommit: 'gone',
					phase: 'idle',
				}),
				env.dir,
			);

			const live = await listAllSessionStates(env.dir);
			expect(live).toEqual([]);
			// Best-effort cleanup removed the row from disk.
			expect(await loadSessionState('sess-orphan', env.dir)).toBeNull();
		});
	});
});

/**
 * findSessionsByTrailerWalk — TS-introduced helper that walks commit ancestry
 * scanning `Story-Session:` trailers. **Different semantics** from
 * `findSessionsForCommit` above; both kept for different downstream needs.
 */
describe('findSessionsByTrailerWalk (TS commit-ancestry helper)', () => {
	let env: TestEnv;
	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
	});
	afterEach(async () => {
		await env.cleanup();
	});

	it('returns empty array when commit has no Story-Session trailer in ancestry', async () => {
		const headSha = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		expect(await findSessionsByTrailerWalk(env.dir, headSha)).toEqual([]);
	});

	it('finds a single Story-Session trailer on the head commit', async () => {
		await env.writeFile('a.txt', 'a');
		await env.gitAdd('a.txt');
		const sha = await env.gitCommit('feat: add a\n\nStory-Session: sess-abc');
		const sessions = await findSessionsByTrailerWalk(env.dir, sha);
		expect(sessions).toHaveLength(1);
		expect(sessions[0]?.sessionId).toBe('sess-abc');
	});

	it('walks ancestors up to LOGS_ONLY_SCAN_LIMIT and dedupes', async () => {
		await env.writeFile('a.txt', 'a');
		await env.gitAdd('a.txt');
		await env.gitCommit('feat: a\n\nStory-Session: sess-1');

		await env.writeFile('b.txt', 'b');
		await env.gitAdd('b.txt');
		await env.gitCommit('feat: b\n\nStory-Session: sess-2');

		await env.writeFile('c.txt', 'c');
		await env.gitAdd('c.txt');
		const head = await env.gitCommit('feat: c\n\nStory-Session: sess-1');

		const sessions = await findSessionsByTrailerWalk(env.dir, head);
		expect(sessions.map((s) => s.sessionId)).toEqual(['sess-1', 'sess-2']);
	});
});

/**
 * Phase 5.4 Part 1 — three new helpers added to manual-commit-session.ts:
 *   - findSessionsForWorktree
 *   - isWarnableStaleEndedSession
 *   - countWarnableStaleEndedSessions
 *
 * Mirrors Go `manual_commit_session.go: findSessionsForWorktree /
 * isWarnableStaleEndedSession / countWarnableStaleEndedSessions`.
 */
describe('Phase 5.4 helpers — Go: manual_commit_session.go (findSessionsForWorktree + isWarnableStaleEndedSession + countWarnableStaleEndedSessions)', () => {
	let env: TestEnv;
	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		clearGitCommonDirCache();
		clearWorktreeRootCache();
	});
	afterEach(async () => {
		await env.cleanup();
		clearGitCommonDirCache();
		clearWorktreeRootCache();
	});

	// Go: manual_commit_session.go: findSessionsForWorktree
	describe('findSessionsForWorktree', () => {
		it('returns sessions whose worktreePath strictly equals the input', async () => {
			await createShadowBranches(env, ['abc', 'xyz']);
			await saveSessionState(
				makeState({ sessionId: 's1', baseCommit: 'abc', worktreePath: '/repo/A', stepCount: 1 }),
				env.dir,
			);
			await saveSessionState(
				makeState({ sessionId: 's2', baseCommit: 'xyz', worktreePath: '/repo/B', stepCount: 1 }),
				env.dir,
			);
			await saveSessionState(
				makeState({ sessionId: 's3', baseCommit: 'abc', worktreePath: '/repo/A', stepCount: 1 }),
				env.dir,
			);

			const matches = await findSessionsForWorktree(env.dir, '/repo/A');
			expect(matches.map((s) => s.sessionId).sort()).toEqual(['s1', 's3']);
		});

		it('returns [] when no session matches the worktreePath', async () => {
			await createShadowBranches(env, ['abc']);
			await saveSessionState(
				makeState({ sessionId: 's1', baseCommit: 'abc', worktreePath: '/repo/A' }),
				env.dir,
			);
			const matches = await findSessionsForWorktree(env.dir, '/repo/none');
			expect(matches).toHaveLength(0);
		});
	});

	// Go: manual_commit_session.go: isWarnableStaleEndedSession
	describe('isWarnableStaleEndedSession', () => {
		it('returns false for non-ENDED phase (gate 1)', async () => {
			await createShadowBranches(env, ['abc']);
			expect(
				await isWarnableStaleEndedSession(
					env.dir,
					makeState({ phase: 'active', baseCommit: 'abc', stepCount: 1 }),
				),
			).toBe(false);
			expect(
				await isWarnableStaleEndedSession(
					env.dir,
					makeState({ phase: 'idle', baseCommit: 'abc', stepCount: 1 }),
				),
			).toBe(false);
		});

		it('returns false when fullyCondensed=true (gate 2)', async () => {
			await createShadowBranches(env, ['abc']);
			expect(
				await isWarnableStaleEndedSession(
					env.dir,
					makeState({ phase: 'ended', baseCommit: 'abc', stepCount: 1, fullyCondensed: true }),
				),
			).toBe(false);
		});

		it('returns false when stepCount===0 (gate 3)', async () => {
			await createShadowBranches(env, ['abc']);
			expect(
				await isWarnableStaleEndedSession(
					env.dir,
					makeState({ phase: 'ended', baseCommit: 'abc', stepCount: 0 }),
				),
			).toBe(false);
		});

		it('returns false when shadow branch ref does not exist (gate 4 — re-check after PostCommit cleanup)', async () => {
			// No shadow branch created → ref missing.
			expect(
				await isWarnableStaleEndedSession(
					env.dir,
					makeState({ phase: 'ended', baseCommit: 'no-branch', stepCount: 5 }),
				),
			).toBe(false);
		});

		it('returns true when all 4 conditions met', async () => {
			await createShadowBranches(env, ['abc']);
			expect(
				await isWarnableStaleEndedSession(
					env.dir,
					makeState({
						phase: 'ended',
						baseCommit: 'abc',
						stepCount: 5,
						fullyCondensed: false,
					}),
				),
			).toBe(true);
		});
	});

	// Go: manual_commit_session.go: countWarnableStaleEndedSessions
	describe('countWarnableStaleEndedSessions', () => {
		it('counts sessions passing the 4-condition gate (table-driven)', async () => {
			await createShadowBranches(env, ['abc', 'xyz']);
			const sessions: SessionState[] = [
				makeState({ sessionId: 'warn1', phase: 'ended', baseCommit: 'abc', stepCount: 5 }), // YES
				makeState({
					sessionId: 'fc',
					phase: 'ended',
					baseCommit: 'abc',
					stepCount: 5,
					fullyCondensed: true,
				}), // NO (gate 2)
				makeState({ sessionId: 'zero', phase: 'ended', baseCommit: 'abc', stepCount: 0 }), // NO (gate 3)
				makeState({ sessionId: 'idle', phase: 'idle', baseCommit: 'abc', stepCount: 1 }), // NO (gate 1)
				makeState({ sessionId: 'warn2', phase: 'ended', baseCommit: 'xyz', stepCount: 1 }), // YES
				makeState({ sessionId: 'orph', phase: 'ended', baseCommit: 'no-branch', stepCount: 5 }), // NO (gate 4)
			];
			expect(await countWarnableStaleEndedSessions(env.dir, sessions)).toBe(2);
		});

		it('returns 0 for empty input', async () => {
			expect(await countWarnableStaleEndedSessions(env.dir, [])).toBe(0);
		});
	});
});

/**
 * Phase 5.4 Part 2 — PostRewrite cluster (rewritePair / remapRewriteSHA /
 * shadowBranchExistsForBaseCommit).
 *
 * Mirrors Go `manual_commit_session.go: rewritePair / remapRewriteSHA /
 * shadowBranchExistsForBaseCommit`.
 */
describe('Phase 5.4 Part 2 PostRewrite helpers — Go: manual_commit_session.go (remapRewriteSHA + shadowBranchExistsForBaseCommit)', () => {
	let env: TestEnv;
	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		clearGitCommonDirCache();
		clearWorktreeRootCache();
	});
	afterEach(async () => {
		await env.cleanup();
		clearGitCommonDirCache();
		clearWorktreeRootCache();
	});

	// Go: manual_commit_session.go:156-163 — remapRewriteSHA
	describe('remapRewriteSHA', () => {
		it('returns [newSha, true] when sha matches an oldSha in mapping', () => {
			const rewrites: RewritePair[] = [
				{ oldSha: 'old1', newSha: 'new1' },
				{ oldSha: 'old2', newSha: 'new2' },
			];
			expect(remapRewriteSHA('old2', rewrites)).toEqual(['new2', true]);
		});

		it('returns [sha, false] when sha does not match any oldSha', () => {
			const rewrites: RewritePair[] = [{ oldSha: 'old1', newSha: 'new1' }];
			expect(remapRewriteSHA('other', rewrites)).toEqual(['other', false]);
		});

		it('returns [sha, false] for empty rewrites', () => {
			expect(remapRewriteSHA('any', [])).toEqual(['any', false]);
		});

		it('returns the FIRST matching pair when multiple oldShas match (Go for-loop semantics)', () => {
			const rewrites: RewritePair[] = [
				{ oldSha: 'dup', newSha: 'first' },
				{ oldSha: 'dup', newSha: 'second' },
			];
			expect(remapRewriteSHA('dup', rewrites)).toEqual(['first', true]);
		});
	});

	// Go: manual_commit_session.go:165-173 — shadowBranchExistsForBaseCommit
	describe('shadowBranchExistsForBaseCommit', () => {
		it('returns false for empty baseCommit', async () => {
			expect(await shadowBranchExistsForBaseCommit(env.dir, '', 'wt1')).toBe(false);
		});

		it('returns true when refs/heads/<shadow> resolves', async () => {
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			const branch = shadowBranchNameForCommit('basecommit', 'wt1');
			await env.exec('git', ['branch', '-f', branch, head]);
			expect(await shadowBranchExistsForBaseCommit(env.dir, 'basecommit', 'wt1')).toBe(true);
		});

		it('returns false when ref does not exist', async () => {
			expect(await shadowBranchExistsForBaseCommit(env.dir, 'nonexistent', 'wt1')).toBe(false);
		});
	});

	// Go: manual_commit_session.go:175-204 — remapSessionForRewrite
	describe('remapSessionForRewrite — hadShadowBranch invariant', () => {
		it('returns false when neither baseCommit nor attributionBaseCommit matches mapping', async () => {
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			const strategy = new ManualCommitStrategy(env.dir);
			const repo = await strategy.getRepo();
			const state = makeState({
				sessionId: 'sess-noop',
				baseCommit: 'X',
				attributionBaseCommit: 'Y',
				worktreeId: '',
				worktreePath: env.dir,
			});
			// Plant shadow ref so listAllSessionStates would keep it (not used here).
			void head;
			const rewrites: RewritePair[] = [{ oldSha: 'Z', newSha: 'Z2' }];
			expect(await remapSessionForRewrite(strategy, repo, state, rewrites)).toBe(false);
			expect(state.baseCommit).toBe('X');
			expect(state.attributionBaseCommit).toBe('Y');
		});

		it('updates state.baseCommit + calls migrateShadowBranchToBaseCommit when baseCommit matches', async () => {
			// Plant shadow branch at oldBase.
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			const oldBase = 'oldbase00000000000000000000000000000000';
			const newBase = 'newbase11111111111111111111111111111111';
			const oldBranch = shadowBranchNameForCommit(oldBase, '');
			await env.exec('git', ['branch', '-f', oldBranch, head]);

			const strategy = new ManualCommitStrategy(env.dir);
			const repo = await strategy.getRepo();
			const state = makeState({
				sessionId: 'sess-base',
				baseCommit: oldBase,
				attributionBaseCommit: oldBase,
				worktreeId: '',
				worktreePath: env.dir,
			});
			const changed = await remapSessionForRewrite(strategy, repo, state, [
				{ oldSha: oldBase, newSha: newBase },
			]);
			expect(changed).toBe(true);
			expect(state.baseCommit).toBe(newBase);
			// hadShadowBranch=true → attributionBaseCommit PRESERVED (still oldBase).
			expect(state.attributionBaseCommit).toBe(oldBase);
		});

		it('PRESERVES attributionBaseCommit when hadShadowBranch=true (CRITICAL invariant)', async () => {
			// Both baseCommit AND attributionBaseCommit match mapping; shadow exists.
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			const oldSha = 'old22222222222222222222222222222222222';
			const newSha = 'new33333333333333333333333333333333333';
			const branch = shadowBranchNameForCommit(oldSha, '');
			await env.exec('git', ['branch', '-f', branch, head]);

			const strategy = new ManualCommitStrategy(env.dir);
			const repo = await strategy.getRepo();
			const state = makeState({
				sessionId: 'sess-pres',
				baseCommit: oldSha,
				attributionBaseCommit: oldSha,
				worktreeId: '',
				worktreePath: env.dir,
			});
			await remapSessionForRewrite(strategy, repo, state, [{ oldSha, newSha }]);
			// baseCommit advanced; attributionBaseCommit kept at oldSha (lineage preserved).
			expect(state.baseCommit).toBe(newSha);
			expect(state.attributionBaseCommit).toBe(oldSha);
		});

		it('UPDATES attributionBaseCommit when !hadShadowBranch + attrChanged', async () => {
			// Only attributionBaseCommit matches — shadow branch never existed
			// (no shadow planted), so attributionBaseCommit IS updated.
			const oldAttr = 'oldattr44444444444444444444444444444444';
			const newAttr = 'newattr55555555555555555555555555555555';
			const strategy = new ManualCommitStrategy(env.dir);
			const repo = await strategy.getRepo();
			const state = makeState({
				sessionId: 'sess-noattr',
				baseCommit: 'unrelated00',
				attributionBaseCommit: oldAttr,
				worktreeId: '',
				worktreePath: env.dir,
			});
			await remapSessionForRewrite(strategy, repo, state, [{ oldSha: oldAttr, newSha: newAttr }]);
			expect(state.attributionBaseCommit).toBe(newAttr);
		});

		it('throws "failed to migrate rewritten shadow branch" when migration errors', async () => {
			// Plant the shadow branch BUT trigger a migration failure: pass invalid
			// `worktreeId` semantics — actually easiest is to corrupt the migration
			// path by setting baseCommit to a real branch but newBase to one that
			// already has a conflicting shadow. We can do this by planting BOTH
			// oldBranch and newBranch refs pointing at different commits, then
			// migrate fails because the destination branch already exists with
			// a conflicting SHA.
			//
			// Simpler approach: monkey-patch s.migrateShadowBranchToBaseCommit
			// to throw via the strategy instance method.
			const strategy = new ManualCommitStrategy(env.dir);
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			const oldBase = 'oldbase66666666666666666666666666666666';
			const newBase = 'newbase77777777777777777777777777777777';
			const oldBranch = shadowBranchNameForCommit(oldBase, '');
			await env.exec('git', ['branch', '-f', oldBranch, head]);

			// Override the strategy's migrate method to force a throw.
			(
				strategy as unknown as { migrateShadowBranchToBaseCommit: () => never }
			).migrateShadowBranchToBaseCommit = () => {
				throw new Error('simulated git ref write failure');
			};

			const repo = await strategy.getRepo();
			const state = makeState({
				sessionId: 'sess-migerr',
				baseCommit: oldBase,
				attributionBaseCommit: oldBase,
				worktreeId: '',
				worktreePath: env.dir,
			});
			await expect(
				remapSessionForRewrite(strategy, repo, state, [{ oldSha: oldBase, newSha: newBase }]),
			).rejects.toThrow(/failed to migrate rewritten shadow branch/);
		});
	});
});
