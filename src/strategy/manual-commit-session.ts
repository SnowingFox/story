/**
 * Session-discovery helpers for the manual-commit strategy.
 *
 * Three functions, each with **different** semantics — keep them straight:
 *
 * - {@link listAllSessionStates} — Go-aligned, mirrors
 *   `entire-cli/cmd/entire/cli/strategy/manual_commit_session.go:59-103`.
 *   Lists every persisted SessionState **and** filters out orphaned sessions
 *   whose shadow branch is gone (best-effort `store.clear` cleanup for the
 *   pure-orphan case). Used by every Go consumer that wants "live" sessions.
 *
 * - {@link findSessionsForCommit} — Go-aligned, mirrors
 *   `entire-cli/cmd/entire/cli/strategy/manual_commit_session.go:206-220`.
 *   **Filters local SessionState records by `state.baseCommit === commitSha`**.
 *   Returns `SessionState[]`. Used by Phase 5.4 hooks (PostCommit, PostRewrite)
 *   to find which active sessions are based on a given commit so they can be
 *   condensed.
 *
 * - {@link findSessionsByTrailerWalk} — TS-introduced helper that walks commit
 *   ancestry scanning `Story-Session:` trailers. Returns `SessionInfo[]` (with
 *   reference + commitHash). Used by future logs-only / explain codepaths
 *   that need to discover sessions purely from commit history without depending
 *   on local state files.
 *
 * @packageDocumentation
 */

import fsCallback from 'node:fs';
import git from 'isomorphic-git';
import { shadowBranchNameForCommit } from '../checkpoint/temporary';
import { isEmpty as isEmptyCheckpointId } from '../id';
import * as log from '../log';
import { SESSION_STATE_DIR_NAME } from '../paths';
import { StateStore } from '../session/state-store';
import { LOGS_ONLY_SCAN_LIMIT } from './constants';
import { extractSessionIdFromCommit } from './extract-session';
import type { ManualCommitStrategy } from './manual-commit';
import { getGitCommonDir, type Repository } from './repo';
import type { SessionInfo, SessionState } from './types';

/**
 * Test whether the local ref `refs/heads/<branch>` resolves. Returns `false`
 * for missing refs (the common signal for "shadow branch was deleted") and
 * for any other resolution error (treated the same as "missing").
 */
async function localBranchExists(repoDir: string, branch: string): Promise<boolean> {
	try {
		await git.resolveRef({ fs: fsCallback, dir: repoDir, ref: `refs/heads/${branch}` });
		return true;
	} catch {
		return false;
	}
}

/**
 * List all persisted SessionState records, dropping orphaned rows whose
 * shadow branch is gone **and** that no longer have any reason to exist
 * (inactive phase, no `lastCheckpointId`). The pure-orphan rows are also
 * cleared from disk on a best-effort basis.
 *
 * Mirrors Go `manual_commit_session.go:59-103` (`listAllSessionStates`).
 *
 * **Keep semantics** (rows that survive even when the shadow branch is gone):
 * - Phase is `active` — session is mid-turn; the branch may not exist yet.
 * - Non-empty `lastCheckpointId` — the SHA is needed for checkpoint-id reuse
 *   on subsequent commits.
 *
 * **Drop + cleanup** — pure orphans (`!active && empty lastCheckpointId`):
 * stale pre-state-machine sessions, IDLE / ENDED sessions that were never
 * condensed, etc. The `store.clear(...)` is best-effort; failures are logged
 * at debug level and never propagate.
 *
 * @example
 * ```ts
 * // 4 sessions on disk; one has been condensed (shadow branch deleted) and
 * // is in the IDLE phase with no lastCheckpointId — pure orphan:
 * const live = await listAllSessionStates(repoDir);
 * // returns: 3 SessionStates  (the orphan is filtered out)
 *
 * // Side effects (only when a pure-orphan row is encountered):
 * //   <repoDir>/.git/story-sessions/<orphan-id>.json    ← removed
 * //   <repoDir>/.git/story-sessions/<orphan-id>.model   ← removed (if present)
 * //
 * // Disk for kept sessions / git refs / HEAD: unchanged.
 * ```
 */
export async function listAllSessionStates(repoDir?: string): Promise<SessionState[]> {
	const commonDir = await getGitCommonDir(repoDir);
	const store = new StateStore(`${commonDir}/${SESSION_STATE_DIR_NAME}`);

	const all = await store.list();
	if (all.length === 0) {
		return [];
	}

	const live: SessionState[] = [];
	for (const state of all) {
		const branch = shadowBranchNameForCommit(state.baseCommit, state.worktreeId ?? '');
		const refExists = await localBranchExists(repoDir ?? process.cwd(), branch);
		if (!refExists) {
			const phaseInactive = state.phase !== 'active';
			const noLastCheckpoint =
				state.lastCheckpointId === undefined || isEmptyCheckpointId(state.lastCheckpointId);
			if (phaseInactive && noLastCheckpoint) {
				try {
					await store.clear(state.sessionId);
				} catch (err) {
					log.debug(
						{ component: 'session', sessionId: state.sessionId },
						'best-effort orphan cleanup failed',
						{ error: (err as Error).message },
					);
				}
				continue;
			}
		}
		live.push(state);
	}
	return live;
}

/**
 * Find all SessionState records whose `worktreePath` exactly equals
 * `worktreePath`. Built on top of {@link listAllSessionStates}, so the orphan
 * filter applies first.
 *
 * Mirrors Go `manual_commit_session.go: findSessionsForWorktree`. Used by
 * Phase 5.4 hooks (`prepareCommitMsg` / `postCommit` / `postRewrite` /
 * `handleAmendCommitMsg`) to scope session lookup to the current worktree —
 * critical for repos with multiple linked worktrees that must not bleed into
 * each other.
 *
 * **Exact string equality** — no normalization, no symlink resolution. Caller
 * is responsible for passing the same `worktreePath` representation that was
 * stored in `state.worktreePath`.
 *
 * @example
 * await findSessionsForWorktree(repoDir, '/Users/me/proj');
 * // returns: SessionState[]   (only those whose worktreePath === '/Users/me/proj')
 *
 * // Side effects: same as listAllSessionStates (best-effort orphan cleanup).
 * // Git refs / HEAD: unchanged.
 */
export async function findSessionsForWorktree(
	repoDir: string,
	worktreePath: string,
): Promise<SessionState[]> {
	const allStates = await listAllSessionStates(repoDir);
	return allStates.filter((s) => s.worktreePath === worktreePath);
}

/**
 * Reports whether an ENDED session is still both expensive in PostCommit AND
 * actionable via `story doctor`. 4 conditions all required:
 *
 *   1. `state.phase === 'ended'`
 *   2. `!state.fullyCondensed`
 *   3. `state.stepCount > 0`
 *   4. shadow branch ref still exists — re-checked here even though
 *      {@link listAllSessionStates} already filtered orphans, because PostCommit
 *      may have just deleted the branch during condensation. Without this
 *      re-check we would warn about sessions that this commit just cleaned up.
 *
 * Mirrors Go `manual_commit_session.go: isWarnableStaleEndedSession`.
 *
 * @example
 * await isWarnableStaleEndedSession(repoDir, state);
 * // returns: true | false
 *
 * // Side effects: read-only — git ref lookup. No writes.
 */
export async function isWarnableStaleEndedSession(
	repoDir: string,
	state: SessionState,
): Promise<boolean> {
	if (state.phase !== 'ended' || state.fullyCondensed === true || state.stepCount <= 0) {
		return false;
	}
	const branch = shadowBranchNameForCommit(state.baseCommit, state.worktreeId ?? '');
	return localBranchExists(repoDir, branch);
}

/**
 * Counts how many of the input sessions pass {@link isWarnableStaleEndedSession}.
 * Used by Phase 5.4 PostCommit to decide whether to print "N stale ENDED
 * sessions are slowing down commits — run `story doctor`" warning.
 *
 * Mirrors Go `manual_commit_session.go: countWarnableStaleEndedSessions`.
 *
 * @example
 * await countWarnableStaleEndedSessions(repoDir, sessions);
 * // returns: 0 | N (number of warnable stale ENDED sessions)
 *
 * // Side effects: read-only — N git ref lookups.
 */
export async function countWarnableStaleEndedSessions(
	repoDir: string,
	sessions: readonly SessionState[],
): Promise<number> {
	let n = 0;
	for (const state of sessions) {
		if (await isWarnableStaleEndedSession(repoDir, state)) {
			n++;
		}
	}
	return n;
}

/**
 * Find all SessionState records whose `baseCommit` equals `baseCommitSha`.
 *
 * Mirrors Go `manual_commit_session.go:206-220`:
 * ```go
 * func (s *ManualCommitStrategy) findSessionsForCommit(ctx, baseCommitSHA) ([]*SessionState, error) {
 *   allStates, _ := s.listAllSessionStates(ctx)
 *   var matching []*SessionState
 *   for _, state := range allStates {
 *     if state.BaseCommit == baseCommitSHA { matching = append(matching, state) }
 *   }
 *   return matching, nil
 * }
 * ```
 *
 * **Exact string equality** — no short-SHA prefix matching, no normalization.
 * Caller is responsible for passing the same SHA representation that was
 * stored in `state.baseCommit`.
 *
 * **Orphan filtering**: builds on {@link listAllSessionStates}, so rows whose
 * shadow branch is gone *and* who have no `lastCheckpointId` are dropped (and
 * cleaned from disk best-effort) **before** the BaseCommit filter applies.
 *
 * @example
 * // 3 sessions saved with baseCommit "abc1234" (×2) and "xyz7890" (×1):
 * await findSessionsForCommit(repoDir, 'abc1234')   // => 2 SessionStates
 * await findSessionsForCommit(repoDir, 'xyz7890')   // => 1 SessionState
 * await findSessionsForCommit(repoDir, 'nope')      // => []
 */
export async function findSessionsForCommit(
	repoDir: string,
	baseCommitSha: string,
): Promise<SessionState[]> {
	const allStates = await listAllSessionStates(repoDir);
	return allStates.filter((s) => s.baseCommit === baseCommitSha);
}

/**
 * Single old→new SHA pair from `git post-rewrite` stdin. Mirrors Go struct
 * `manual_commit_session.go: rewritePair` (`{OldSHA, NewSHA string}`).
 */
export interface RewritePair {
	readonly oldSha: string;
	readonly newSha: string;
}

/**
 * Look up `sha` in `rewrites` and return the new SHA when matched.
 *
 * Returns `[newSha, true]` on the first match (Go for-loop semantics — earlier
 * pairs win); otherwise `[sha, false]` so the caller can use the result
 * directly without an extra branch.
 *
 * Mirrors Go `manual_commit_session.go: remapRewriteSHA`.
 *
 * @example
 * remapRewriteSHA('old', [{ oldSha: 'old', newSha: 'new' }])
 * // => ['new', true]
 *
 * remapRewriteSHA('other', [{ oldSha: 'old', newSha: 'new' }])
 * // => ['other', false]
 *
 * // Side effects: none — pure function.
 */
export function remapRewriteSHA(sha: string, rewrites: readonly RewritePair[]): [string, boolean] {
	for (const pair of rewrites) {
		if (sha === pair.oldSha) {
			return [pair.newSha, true];
		}
	}
	return [sha, false];
}

/**
 * Returns `true` when the shadow branch ref `refs/heads/<shadowBranchName>`
 * for the given `(baseCommit, worktreeId)` resolves. Returns `false` for
 * empty `baseCommit` or any resolution failure.
 *
 * Used by Phase 5.4 Part 2 `remapSessionForRewrite` to decide whether to
 * preserve `attributionBaseCommit` across a rewrite (see the
 * `hadShadowBranch` invariant in [`./manual-commit-session.ts:remapSessionForRewrite`](./manual-commit-session.ts)
 * — captured BEFORE migration mutates state).
 *
 * Mirrors Go `manual_commit_session.go: shadowBranchExistsForBaseCommit`.
 *
 * @example
 * await shadowBranchExistsForBaseCommit('/repo', 'abc1234', 'wt1');
 * // returns: true | false
 *
 * await shadowBranchExistsForBaseCommit('/repo', '', 'wt1');
 * // returns: false (empty baseCommit short-circuit)
 *
 * // Side effects: read-only — single git ref lookup.
 */
export async function shadowBranchExistsForBaseCommit(
	repoDir: string,
	baseCommit: string,
	worktreeId: string,
): Promise<boolean> {
	if (baseCommit === '') {
		return false;
	}
	const branch = shadowBranchNameForCommit(baseCommit, worktreeId);
	return localBranchExists(repoDir, branch);
}

/**
 * Per-session remap for `post-rewrite` git hook. Tries to remap **both**
 * `state.baseCommit` AND `state.attributionBaseCommit` via {@link remapRewriteSHA}.
 * Returns `true` when either changed (caller saves).
 *
 * **Critical invariant** (`hadShadowBranch` capture): Capture the existence of
 * the OLD shadow branch **BEFORE** {@link ManualCommitStrategy.migrateShadowBranchToBaseCommit}
 * mutates state. When `attributionBaseCommit` was in the mapping AND the
 * shadow branch existed, **do NOT** update `state.attributionBaseCommit` —
 * preserves attribution lineage so future attribution still diffs against
 * the original checkpoint base captured on that branch. Only when no shadow
 * branch existed do we keep `attributionBaseCommit` in sync with the rewritten
 * commit.
 *
 * Mirrors Go `manual_commit_session.go: remapSessionForRewrite`.
 *
 * @example
 * await remapSessionForRewrite(strategy, repo, state, [{ oldSha: 'abc', newSha: 'def' }]);
 * // returns: true if state.baseCommit OR state.attributionBaseCommit changed
 *
 * // Side effects (when baseCommit matches mapping):
 * //   refs/heads/story/<oldBase>-<wt6>  ← renamed to story/<newBase>-<wt6>
 * //   state.baseCommit                   ← set to newBase
 * //   state.attributionBaseCommit        ← preserved if hadShadowBranch=true,
 * //                                         else updated (when attrChanged)
 * //
 * // HEAD / index / worktree / state.json on disk (caller saves): unchanged.
 */
export async function remapSessionForRewrite(
	s: ManualCommitStrategy,
	repo: Repository,
	state: SessionState,
	rewrites: readonly RewritePair[],
): Promise<boolean> {
	const [newBaseCommit, baseChangedRaw] = remapRewriteSHA(state.baseCommit, rewrites);
	const [newAttrBaseCommit, attrChanged] = remapRewriteSHA(
		state.attributionBaseCommit ?? '',
		rewrites,
	);
	if (!baseChangedRaw && !attrChanged) {
		return false;
	}

	// **CRITICAL** — capture hadShadowBranch BEFORE migration mutates state.
	const hadShadowBranch = await shadowBranchExistsForBaseCommit(
		repo.root,
		state.baseCommit,
		state.worktreeId ?? '',
	);

	let baseChanged = baseChangedRaw;
	if (baseChangedRaw) {
		try {
			baseChanged = await s.migrateShadowBranchToBaseCommit(repo.root, state, newBaseCommit);
		} catch (err) {
			throw new Error(
				`failed to migrate rewritten shadow branch: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	// **INVARIANT**: only update attributionBaseCommit when shadow branch did
	// NOT exist. When shadow branch existed, the checkpoint trees on it were
	// diffed against the original base; re-attributing against the new SHA
	// would inflate human_added with unrelated lines.
	if (attrChanged && !hadShadowBranch) {
		state.attributionBaseCommit = newAttrBaseCommit;
	}

	return baseChanged || attrChanged;
}

/**
 * Walk commit ancestry from `commitHash` (bounded by {@link LOGS_ONLY_SCAN_LIMIT}),
 * returning a deduplicated list of {@link SessionInfo} for every commit that
 * carries a `Story-Session:` trailer.
 *
 * **Note**: This is **NOT** the same as Go's `findSessionsForCommit`. Go's
 * version filters local SessionState records by `baseCommit`; this function
 * derives sessions purely from git commit history. Used by codepaths that
 * need session discovery without local state (e.g., logs-only resume).
 *
 * Returns `[]` when the commit has no session trailer in its ancestry within
 * the scan limit.
 *
 * @example
 * ```ts
 * // History: HEAD = "feat: c\n\nStory-Session: sess-1"
 * //         ^- "feat: b\n\nStory-Session: sess-2"
 * //         ^- "feat: a\n\nStory-Session: sess-1"
 * await findSessionsByTrailerWalk(repoDir, headSha);
 * // returns: [
 * //   { sessionId: 'sess-1', reference: 'story/<head[:7]>', commitHash: <headSha> },
 * //   { sessionId: 'sess-2', reference: 'story/<parent[:7]>', commitHash: <parentSha> },
 * // ]   (newest first; "sess-1" deduplicated)
 *
 * // History with no Story-Session trailers in the scan window:
 * await findSessionsByTrailerWalk(repoDir, headSha);
 * // returns: []
 *
 * // Side effects: none — read-only commit-graph walk via isomorphic-git.
 * //
 * // Disk / git refs / HEAD: unchanged.
 * ```
 */
export async function findSessionsByTrailerWalk(
	repoDir: string,
	commitHash: string,
): Promise<SessionInfo[]> {
	const seen = new Set<string>();
	const result: SessionInfo[] = [];
	let current: string | null = commitHash;

	for (let i = 0; i < LOGS_ONLY_SCAN_LIMIT && current !== null; i++) {
		let commit: Awaited<ReturnType<typeof git.readCommit>>;
		try {
			commit = await git.readCommit({ fs: fsCallback, dir: repoDir, oid: current });
		} catch {
			break;
		}

		const sessionId = extractSessionIdFromCommit(commit.commit.message);
		if (sessionId !== '' && !seen.has(sessionId)) {
			seen.add(sessionId);
			result.push({
				sessionId,
				// Strategy-package convention: shadow branch name `story/<short-hash>`
				// for manual-commit. Empty for `commit` strategy (deprecated).
				reference: `story/${commit.oid.slice(0, 7)}`,
				commitHash: commit.oid,
			});
		}

		current = commit.commit.parent[0] ?? null;
	}

	return result;
}
