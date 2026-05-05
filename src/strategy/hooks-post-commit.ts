/**
 * `post-commit` git hook entry, per-session sub-pipeline,
 * state-machine `ActionHandler`, and the leaf helpers needed by both.
 *
 * Go reference: `entire-cli/cmd/entire/cli/strategy/manual_commit_hooks.go`
 * (`PostCommit` 11-step pipeline, `postCommitActionHandler` struct +
 * `shouldCondenseWithOverlapCheck`, `postCommitProcessSession`,
 * `condenseAndUpdateState`, `updateBaseCommitIfChanged`,
 * `postCommitUpdateBaseCommitOnly`, `filesChangedInCommit` (+ fallback),
 * `subtractFiles`, `truncateHash`, `isRecentInteraction`).
 *
 * @packageDocumentation
 */

import fsCallback from 'node:fs';
import git from 'isomorphic-git';
import { match } from 'ts-pattern';
import { shadowBranchNameForCommit } from '@/checkpoint/temporary';
import { execGit, isGitSequenceOperation } from '@/git';
import type { CheckpointID } from '@/id';
import * as log from '@/log';
import { worktreeRoot } from '@/paths';
import { type ActionHandler, Event } from '@/session/phase';
import { parseCheckpoint } from '@/trailers';
import { getAllChangedFiles } from './attribution';
import type { CondenseOpts } from './condensation';
import { filesOverlapWithContent, filesWithRemainingAgentChanges } from './content-overlap';
import { resolveFilesTouched, sessionHasNewContent } from './hooks-content-detection';
import { updateCombinedAttributionForCheckpoint } from './hooks-post-commit-attribution';
import { carryForwardToNewShadowBranch } from './hooks-post-commit-carry-forward';
import {
	ACTIVE_SESSION_INTERACTION_THRESHOLD_MS,
	STALE_ENDED_SESSION_WARN_THRESHOLD,
	warnStaleEndedSessions,
} from './hooks-post-commit-warn';
import type { ManualCommitStrategy } from './manual-commit';
import { countWarnableStaleEndedSessions, findSessionsForWorktree } from './manual-commit-session';
import type { Repository } from './repo';
import { deleteShadowBranch } from './save-step-helpers';
import { transitionAndLog } from './session-state';
import { clearFilesystemPrompt } from './transcript-prompts';
import type { SessionState } from './types';

// Lightweight TS shape used by the handler — equivalent to Go *object.Commit
// fields we actually read.
type CommitShape = Awaited<ReturnType<typeof git.readCommit>>['commit'];

/**
 * Truncate a git hash to 7 characters for log output. Mirrors Go
 * `manual_commit_hooks.go: truncateHash`. Short hashes are returned unchanged.
 *
 * @example
 * truncateHash('abc1234567890') // 'abc1234'
 * truncateHash('abc')           // 'abc'
 */
export function truncateHash(h: string): string {
	return h.length > 7 ? h.slice(0, 7) : h;
}

/**
 * Returns `true` when `lastInteraction` is non-null and within
 * {@link ACTIVE_SESSION_INTERACTION_THRESHOLD_MS} (24 h) of now.
 *
 * Used by `shouldCondenseWithOverlapCheck` to distinguish a genuinely-active
 * session from a stale ACTIVE row (agent crashed without `Stop`).
 *
 * Mirrors Go `manual_commit_hooks.go: isRecentInteraction`.
 *
 * @example
 * isRecentInteraction(null)                                 // false
 * isRecentInteraction('not-an-iso-date')                    // false (parse fail)
 * isRecentInteraction(new Date().toISOString())             // true
 * isRecentInteraction(new Date(Date.now() - 25*3600e3).toISOString()) // false
 */
export function isRecentInteraction(lastInteraction: string | null | undefined): boolean {
	if (lastInteraction === null || lastInteraction === undefined) {
		return false;
	}
	const t = Date.parse(lastInteraction);
	if (Number.isNaN(t)) {
		return false;
	}
	return Date.now() - t < ACTIVE_SESSION_INTERACTION_THRESHOLD_MS;
}

/**
 * Filter `files`, dropping any entry that appears in `exclude`. Preserves
 * input order. Mirrors Go `manual_commit_hooks.go: subtractFiles`.
 *
 * @example
 * subtractFiles(['a', 'b', 'c'], new Set(['b']))   // ['a', 'c']
 *
 * // Side effects: none — pure function.
 */
export function subtractFiles(files: readonly string[], exclude: ReadonlySet<string>): string[] {
	return files.filter((f) => !exclude.has(f));
}

/**
 * Compute the set of files changed by `commitHash` relative to its first
 * parent. Fast path uses `git diff-tree --name-only -r -z`. On failure,
 * falls back to `getAllChangedFiles` (Phase 5.3 attribution helper) walking
 * `parentTreeOid → headTreeOid`. Both failures return an empty set with a
 * `warn` log entry.
 *
 * Initial commits (no parent) use the `--root` flag for the fast path.
 *
 * Mirrors Go `manual_commit_hooks.go: filesChangedInCommit` +
 * `filesChangedInCommitFallback`.
 *
 * @example
 * await filesChangedInCommit('/repo', headSha, parentSha, headTreeOid, parentTreeOid);
 * // returns: Set { 'src/a.ts', 'src/b.ts' }
 *
 * await filesChangedInCommit('/repo', initialCommit, '', null, null);
 * // returns: Set { '.gitkeep' }   (uses --root flag)
 *
 * // Side effects: read-only — `git diff-tree` invocation; falls back to
 * // isomorphic-git tree walk via getAllChangedFiles.
 */
export async function filesChangedInCommit(
	repoDir: string,
	commitHash: string,
	parentHash: string,
	headTreeOid: string | null,
	parentTreeOid: string | null,
): Promise<Set<string>> {
	const result = new Set<string>();

	const args = parentHash
		? ['diff-tree', '--name-only', '-r', '-z', parentHash, commitHash]
		: ['diff-tree', '--name-only', '-r', '-z', '--root', commitHash];
	try {
		const out = await execGit(args, { cwd: repoDir });
		for (const f of out.split('\0')) {
			if (f !== '') {
				result.add(f);
			}
		}
		return result;
	} catch (err) {
		log.warn(
			{ component: 'checkpoint' },
			'post-commit: git diff-tree failed, falling back to tree walk',
			{ commit: commitHash, error: err instanceof Error ? err.message : String(err) },
		);
	}

	// Fallback: tree-walk via Phase 5.3 attribution helper. Pass empty commit
	// hashes (Go: filesChangedInCommitFallback uses "", "") to force the slow
	// path that compares trees directly — bogus commit hashes that triggered
	// the fast-path failure must NOT be re-tried inside getAllChangedFiles.
	try {
		const files = await getAllChangedFiles(repoDir, parentTreeOid, headTreeOid, repoDir, '', '');
		return new Set(files);
	} catch (err) {
		log.warn(
			{ component: 'checkpoint' },
			'post-commit: tree walk fallback also failed; condensation and carry-forward may be affected',
			{ error: err instanceof Error ? err.message : String(err) },
		);
		return new Set<string>();
	}
}

/**
 * Update `state.baseCommit` and `state.attributionBaseCommit` to `newHead`
 * **only when** the session is in `'active'` phase AND `newHead` differs from
 * the current `baseCommit`. Caller is responsible for batching the save —
 * this helper does NOT persist.
 *
 * IDLE / ENDED sessions intentionally keep their old `baseCommit` so the
 * stored `lastCheckpointId` can be reused on a future amend.
 *
 * Mirrors Go `manual_commit_hooks.go: updateBaseCommitIfChanged`.
 *
 * @example
 * const state = { ..., phase: 'active', baseCommit: 'old', attributionBaseCommit: 'old' };
 * updateBaseCommitIfChanged(state, 'new');
 * // state.baseCommit            === 'new'
 * // state.attributionBaseCommit === 'new'
 *
 * // Side effects: in-memory mutation only — caller saves in a batch.
 */
export function updateBaseCommitIfChanged(state: SessionState, newHead: string): void {
	if (state.phase !== 'active') {
		log.debug(
			{ component: 'checkpoint', sessionId: state.sessionId },
			'post-commit: updateBaseCommitIfChanged skipped non-active session',
			{ phase: state.phase },
		);
		return;
	}
	if (state.baseCommit !== newHead) {
		state.baseCommit = newHead;
		// Keep AttributionBaseCommit in sync to prevent stale base drift
		// (mirrors Go invariant — the two SHAs travel together for ACTIVE).
		state.attributionBaseCommit = newHead;
		log.debug(
			{ component: 'checkpoint', sessionId: state.sessionId },
			'post-commit: updated BaseCommit and AttributionBaseCommit',
			{ newHead: truncateHash(newHead) },
		);
	}
}

/**
 * Outermost helper invoked when the new commit has **no** `Story-Checkpoint:`
 * trailer. Loops every active session for the worktree, advances `baseCommit`
 * + `attributionBaseCommit` to `newHead`, and **saves each session
 * immediately** (no outer batch — this code path is itself the batch).
 *
 * Best-effort: load failures and save failures are logged but never thrown.
 *
 * Mirrors Go `manual_commit_hooks.go: postCommitUpdateBaseCommitOnly`.
 *
 * @example
 * await postCommitUpdateBaseCommitOnly(strategy, 'newHeadSha');
 *
 * // Side effects (per ACTIVE session whose baseCommit differs):
 * //   <repoDir>/.git/story-sessions/<sessionId>.json   ← rewritten with newHead
 * //
 * // HEAD / index / worktree / git refs: unchanged.
 */
export async function postCommitUpdateBaseCommitOnly(
	s: ManualCommitStrategy,
	newHead: string,
): Promise<void> {
	let repoRoot: string;
	let worktreePath: string;
	try {
		const repo = await s.getRepo();
		repoRoot = repo.root;
		worktreePath = await worktreeRoot(repoRoot);
	} catch {
		return;
	}

	let sessions: SessionState[];
	try {
		sessions = await findSessionsForWorktree(repoRoot, worktreePath);
	} catch {
		return;
	}
	if (sessions.length === 0) {
		return;
	}

	for (const state of sessions) {
		if (state.phase !== 'active') {
			continue;
		}
		if (state.baseCommit === newHead) {
			continue;
		}
		log.debug(
			{ component: 'checkpoint', sessionId: state.sessionId },
			'post-commit (no trailer): updating BaseCommit and AttributionBaseCommit',
			{ oldBase: truncateHash(state.baseCommit), newHead: truncateHash(newHead) },
		);
		state.baseCommit = newHead;
		state.attributionBaseCommit = newHead;
		try {
			await s.saveSessionState(state);
		} catch (err) {
			log.warn(
				{ component: 'checkpoint', sessionId: state.sessionId },
				'failed to update session state',
				{ error: err instanceof Error ? err.message : String(err) },
			);
		}
	}
}

/** Per-session context for {@link PostCommitActionHandler}. Mirrors Go struct
 *  `postCommitActionHandler` field-for-field. `commit` carries the inner
 *  `ReadCommitResult['commit']` shape (TS-vs-Go: `{ message, parent: string[],
 *  tree, ... }`); `commitOid` is HEAD's hash kept separate for log clarity. */
export interface PostCommitHandlerOpts {
	s: ManualCommitStrategy;
	repo: Repository;
	checkpointId: CheckpointID;
	commit: CommitShape;
	commitOid: string;
	newHead: string;
	repoDir: string;
	shadowBranchName: string;
	shadowBranchesToDelete: Set<string>;
	committedFileSet: ReadonlySet<string>;
	hasNew: boolean;
	filesTouchedBefore: readonly string[];
	sessionsWithCommittedFiles: number;
	headTreeOid: string | null;
	parentTreeOid: string | null;
	shadowRefOid: string | null;
	shadowTreeOid: string | null;
	allAgentFiles: ReadonlySet<string>;
}

/**
 * Per-session ActionHandler implementing Phase 3's {@link ActionHandler}
 * interface. Each session in the PostCommit loop gets its own handler instance
 * with per-session context. Handler methods receive the same `state` object
 * being transitioned by `transitionAndLog`.
 *
 * `condensed` field is the **output**: `true` only when `condenseSession`
 * actually wrote data to the metadata branch. Failures and skips both leave
 * it `false`, which correctly preserves shadow branches and defers
 * `FullyCondensed` marking.
 *
 * Mirrors Go `manual_commit_hooks.go: postCommitActionHandler`.
 */
export class PostCommitActionHandler implements ActionHandler {
	public condensed = false;

	constructor(public readonly opts: PostCommitHandlerOpts) {}

	parentCommitHash(): string {
		return this.opts.commit.parent[0] ?? '';
	}

	async handleCondense(state: SessionState): Promise<void> {
		const should = await this.shouldCondenseWithOverlapCheck(
			state.phase === 'active',
			state.lastInteractionTime ?? null,
		);
		log.debug(
			{ component: 'checkpoint', sessionId: state.sessionId },
			'post-commit: HandleCondense decision',
			{
				phase: state.phase,
				hasNew: this.opts.hasNew,
				shouldCondense: should,
				shadowBranch: this.opts.shadowBranchName,
			},
		);
		if (should) {
			this.condensed = await condenseAndUpdateState(
				this.opts.s,
				this.opts.checkpointId,
				state,
				this.opts.shadowBranchName,
				this.opts.shadowBranchesToDelete,
				this.opts.committedFileSet,
				this.buildCondenseOpts(),
			);
		} else {
			updateBaseCommitIfChanged(state, this.opts.newHead);
		}
	}

	async handleCondenseIfFilesTouched(state: SessionState): Promise<void> {
		const hasFiles = (state.filesTouched ?? []).length > 0;
		const should =
			hasFiles &&
			(await this.shouldCondenseWithOverlapCheck(
				state.phase === 'active',
				state.lastInteractionTime ?? null,
			));
		log.debug(
			{ component: 'checkpoint', sessionId: state.sessionId },
			'post-commit: HandleCondenseIfFilesTouched decision',
			{
				phase: state.phase,
				hasNew: this.opts.hasNew,
				filesTouched: (state.filesTouched ?? []).length,
				shouldCondense: should,
				shadowBranch: this.opts.shadowBranchName,
			},
		);
		if (should) {
			this.condensed = await condenseAndUpdateState(
				this.opts.s,
				this.opts.checkpointId,
				state,
				this.opts.shadowBranchName,
				this.opts.shadowBranchesToDelete,
				this.opts.committedFileSet,
				this.buildCondenseOpts(),
			);
		} else {
			updateBaseCommitIfChanged(state, this.opts.newHead);
		}
	}

	async handleDiscardIfNoFiles(state: SessionState): Promise<void> {
		if ((state.filesTouched ?? []).length === 0) {
			log.debug(
				{ component: 'checkpoint', sessionId: state.sessionId },
				'post-commit: skipping empty ended session (no files to condense)',
			);
		}
		updateBaseCommitIfChanged(state, this.opts.newHead);
	}

	handleWarnStaleSession(_state: SessionState): void {
		// Not produced by EventGitCommit (only ACTIVE + SessionStart emits it).
		// No-op for ActionHandler interface completeness.
	}

	/**
	 * 6-branch decision tree implemented via `ts-pattern.match()` per
	 * [impl-2.md](docs/ts-rewrite/impl/phase-5-strategy/phase-5.4-hooks-handler/impl-2.md):
	 *
	 *  1. `!hasNew` → false
	 *  2. ACTIVE + recent interaction + read-only guard
	 *     (`sessionsWithCommittedFiles>0 && filesTouchedBefore===[]`) → false
	 *  3. ACTIVE + recent interaction (other) → true
	 *  4. stale + filesTouchedBefore===[] → false
	 *  5. stale + filesTouchedBefore × committedFileSet === ∅ → false
	 *  6. stale + overlap → defer to `filesOverlapWithContent`
	 */
	private async shouldCondenseWithOverlapCheck(
		isActive: boolean,
		lastInteraction: string | null,
	): Promise<boolean> {
		if (!this.opts.hasNew) {
			return false;
		}
		const recent = isRecentInteraction(lastInteraction);
		const readOnlyGuardTripped =
			isActive &&
			recent &&
			this.opts.sessionsWithCommittedFiles > 0 &&
			this.opts.filesTouchedBefore.length === 0;

		const branch = match({
			isActive,
			recent,
			readOnlyGuardTripped,
			filesEmpty: this.opts.filesTouchedBefore.length === 0,
		})
			.with({ readOnlyGuardTripped: true }, () => 'readOnlyGuard' as const)
			.with({ isActive: true, recent: true }, () => 'activeRecent' as const)
			.with({ filesEmpty: true }, () => 'staleNoFiles' as const)
			.otherwise(() => 'staleWithFiles' as const);

		if (branch === 'readOnlyGuard') {
			log.debug(
				{ component: 'checkpoint' },
				'post-commit: skipping read-only ACTIVE session (no tracked files, other sessions claim committed files)',
				{ sessionsWithCommittedFiles: this.opts.sessionsWithCommittedFiles },
			);
			return false;
		}
		if (branch === 'activeRecent') {
			return true;
		}
		if (branch === 'staleNoFiles') {
			return false;
		}

		// staleWithFiles: intersect filesTouchedBefore with committedFileSet —
		// only files actually changed in THIS commit qualify as overlap evidence.
		const committedTouchedFiles: string[] = [];
		for (const f of this.opts.filesTouchedBefore) {
			if (this.opts.committedFileSet.has(f)) {
				committedTouchedFiles.push(f);
			}
		}
		if (committedTouchedFiles.length === 0) {
			return false;
		}

		return filesOverlapWithContent(
			this.opts.repo.root,
			this.opts.shadowBranchName,
			this.opts.commitOid,
			committedTouchedFiles,
			{
				headTree: this.opts.headTreeOid,
				shadowTree: this.opts.shadowTreeOid,
				parentTree: this.opts.parentTreeOid,
				// Go-parity: postCommitProcessSession Step 5 already pre-resolved
				// parentTree (or determined it's null because of an initial commit),
				// so this caller always asserts `hasParentTree: true` to skip the
				// lazy re-fetch inside filesOverlapWithContent. An earlier TS
				// version used a conditional that silently allowed a fallback
				// re-resolve when pre-resolution failed — that diverged from Go
				// which treats resolution failure as "no parent" semantics.
				hasParentTree: true,
			},
		);
	}

	private buildCondenseOpts(): CondenseOpts {
		return {
			shadowRefOid: this.opts.shadowRefOid,
			headTreeOid: this.opts.headTreeOid,
			parentTreeOid: this.opts.parentTreeOid,
			// Same Go-parity reasoning as `shouldCondenseWithOverlapCheck` —
			// always assert true (caller pre-resolved parentTree at Step 5).
			hasParentTree: true,
			repoDir: this.opts.repoDir,
			parentCommitHash: this.parentCommitHash(),
			headCommitHash: this.opts.newHead,
			allAgentFiles: this.opts.allAgentFiles,
		};
	}
}

/**
 * Run condensation for one session and update state on success. Returns
 * `true` only when `condenseSession` actually wrote data (`!result.skipped`).
 *
 * On `condenseSession` throw OR `result.skipped`: returns `false`, **state is
 * not touched**, and the shadow branch is **not** added to
 * `shadowBranchesToDelete`.
 *
 * On success: adds shadow branch to delete set, updates state with new
 * `baseCommit` / `attributionBaseCommit` / `stepCount=0` /
 * `checkpointTranscriptStart` / `compactTranscriptStart` (cumulative) /
 * `checkpointTranscriptSize` / clears `promptAttributions` /
 * `pendingPromptAttribution` / `filesTouched`, sets `lastCheckpointId`.
 *
 * Mirrors Go `manual_commit_hooks.go: condenseAndUpdateState`.
 *
 * @example
 * await condenseAndUpdateState(strategy, ckptId, state, branchName, toDelete, committed, opts);
 *
 * // Side effects (success):
 * //   refs/heads/story/checkpoints/v1   ← bumped (condenseSession writes)
 * //   .git/objects/...                  ← metadata + transcript blobs
 * //   state                             ← reset for next condense cycle
 * //   shadowBranchesToDelete            ← branchName added (caller cleans later)
 * //
 * // Side effects (skip / failure): none — state untouched.
 */
export async function condenseAndUpdateState(
	s: ManualCommitStrategy,
	checkpointId: CheckpointID,
	state: SessionState,
	shadowBranchName: string,
	shadowBranchesToDelete: Set<string>,
	committedFiles: ReadonlySet<string>,
	opts: CondenseOpts,
): Promise<boolean> {
	let result: Awaited<ReturnType<typeof s.condenseSession>>;
	try {
		result = await s.condenseSession(checkpointId, state, committedFiles, opts);
	} catch (err) {
		log.warn({ component: 'checkpoint', sessionId: state.sessionId }, 'condensation failed', {
			error: err instanceof Error ? err.message : String(err),
		});
		return false;
	}

	if (result.skipped) {
		log.debug(
			{ component: 'checkpoint', sessionId: state.sessionId },
			'condensation skipped, session state unchanged',
			{ checkpointId: checkpointId.toString() },
		);
		return false;
	}

	// Track shadow branch for cleanup.
	shadowBranchesToDelete.add(shadowBranchName);

	// Update session state for the new base commit.
	const newHead = opts.headCommitHash ?? '';
	state.baseCommit = newHead;
	state.attributionBaseCommit = newHead;
	state.stepCount = 0;
	state.checkpointTranscriptStart = result.totalTranscriptLines;
	state.compactTranscriptStart =
		(state.compactTranscriptStart ?? 0) + (result.compactTranscriptLines ?? 0);
	state.checkpointTranscriptSize = result.transcript?.length ?? 0;

	// Clear attribution tracking — condensation already used these.
	state.promptAttributions = [];
	state.pendingPromptAttribution = null;
	state.filesTouched = [];

	// NOTE: filesystem prompt.txt is NOT cleared here. Caller decides.

	// Save checkpoint ID for amend reuse.
	state.lastCheckpointId = checkpointId.toString();

	log.info({ component: 'checkpoint', sessionId: state.sessionId }, 'session condensed', {
		checkpointId: result.checkpointId.toString(),
		checkpointsCondensed: result.checkpointsCount,
		transcriptLines: result.totalTranscriptLines,
	});
	return true;
}

/**
 * Per-session sub-pipeline (10 steps). Drives the state machine via
 * {@link transitionAndLog}, runs condense via the action handler, snapshots
 * filesTouched **before** the handler clears it, optionally carry-forwards
 * remaining files, marks ENDED + empty as `fullyCondensed`, and saves state.
 *
 * Mirrors Go `manual_commit_hooks.go: postCommitProcessSession`.
 */
async function postCommitProcessSession(
	s: ManualCommitStrategy,
	repo: Repository,
	state: SessionState,
	transitionCtx: { hasFilesTouched: boolean; isRebaseInProgress: boolean },
	checkpointId: CheckpointID,
	commit: CommitShape,
	newHead: string,
	headTreeOid: string | null,
	parentTreeOid: string | null,
	committedFileSet: ReadonlySet<string>,
	shadowBranchesToDelete: Set<string>,
	uncondensedActiveOnBranch: Set<string>,
	allAgentFiles: ReadonlySet<string>,
	sessionsWithCommittedFiles: number,
): Promise<void> {
	// (1) Resolve shadow branch ref + tree. Three nested try blocks (Go-parity)
	// so that `shadowRefOid` survives even when the commit / tree read fails —
	// downstream callers thread `shadowRefOid` separately from `shadowTreeOid`.
	const shadowBranchName = shadowBranchNameForCommit(state.baseCommit, state.worktreeId ?? '');
	let shadowRefOid: string | null = null;
	let shadowTreeOid: string | null = null;
	try {
		shadowRefOid = await git.resolveRef({
			fs: fsCallback,
			dir: repo.root,
			ref: `refs/heads/${shadowBranchName}`,
		});
		try {
			const sc = await git.readCommit({ fs: fsCallback, dir: repo.root, oid: shadowRefOid });
			shadowTreeOid = sc.commit.tree;
		} catch {
			// Shadow ref existed but commit/tree read failed — keep ref non-null.
		}
	} catch {
		// Ref doesn't exist — both stay null.
	}

	// (2) hasNew check. ACTIVE: trust trailer (PrepareCommitMsg already validated).
	// Non-ACTIVE: call sessionHasNewContent (fail-open: hasNew=true on err).
	let hasNew = true;
	if (state.phase !== 'active') {
		try {
			hasNew = await sessionHasNewContent(repo.root, state, { shadowTreeOid });
		} catch (err) {
			hasNew = true;
			// Go-parity: manual_commit_hooks.go: postCommitProcessSession logs
			// the underlying error so ops can triage stale shadow / corrupt
			// transcript without losing the fail-open behavior.
			log.debug(
				{ component: 'checkpoint', sessionId: state.sessionId },
				'post-commit: error checking session content, assuming new content',
				{ error: err instanceof Error ? err.message : String(err) },
			);
		}
	}

	// (3) Critical — set transitionCtx.hasFilesTouched (state machine reads
	//     this for ENDED + GitCommit decision: HasFilesTouched true →
	//     CondenseIfFilesTouched, false → DiscardIfNoFiles).
	transitionCtx.hasFilesTouched = (state.filesTouched ?? []).length > 0;

	// (4) Snapshot filesTouched BEFORE TransitionAndLog (which clears it via
	//     condense action). ACTIVE may have empty state.filesTouched if
	//     SaveStep hasn't run yet — fall through to live transcript.
	let filesTouchedBefore: string[];
	if (state.phase === 'active') {
		filesTouchedBefore = await resolveFilesTouched(state);
	} else if ((state.filesTouched ?? []).length > 0) {
		filesTouchedBefore = (state.filesTouched ?? []).slice();
	} else {
		filesTouchedBefore = [];
	}

	// (5) Build handler + run state-machine transition.
	const handler = new PostCommitActionHandler({
		s,
		repo,
		checkpointId,
		commit,
		commitOid: newHead,
		newHead,
		repoDir: repo.root,
		shadowBranchName,
		shadowBranchesToDelete,
		committedFileSet,
		hasNew,
		filesTouchedBefore,
		sessionsWithCommittedFiles,
		headTreeOid,
		parentTreeOid,
		shadowRefOid,
		shadowTreeOid,
		allAgentFiles,
	});
	try {
		await transitionAndLog(state, Event.GitCommit, transitionCtx, handler);
	} catch (err) {
		log.warn(
			{ component: 'checkpoint', sessionId: state.sessionId },
			'post-commit action handler error',
			{ error: err instanceof Error ? err.message : String(err) },
		);
	}

	// (6) Append checkpointID to TurnCheckpointIDs ONLY for ACTIVE + condensed.
	//     IDLE/ENDED already have complete transcripts — no finalize needed.
	if (handler.condensed && state.phase === 'active') {
		const ckpts = state.turnCheckpointIds ?? [];
		ckpts.push(checkpointId.toString());
		state.turnCheckpointIds = ckpts;
	}

	// (7) Carry-forward when condensed.
	if (handler.condensed) {
		const remainingFiles = await filesWithRemainingAgentChanges(
			repo.root,
			shadowBranchName,
			newHead,
			filesTouchedBefore,
			committedFileSet,
			{ headTree: headTreeOid, shadowTree: shadowTreeOid },
		);
		state.filesTouched = remainingFiles;
		log.debug(
			{ component: 'checkpoint', sessionId: state.sessionId },
			'post-commit: carry-forward decision (content-aware)',
			{
				filesTouchedBefore: filesTouchedBefore.length,
				committedFiles: committedFileSet.size,
				remainingFiles: remainingFiles.length,
			},
		);
		if (remainingFiles.length > 0) {
			await carryForwardToNewShadowBranch(s, state, remainingFiles);
		}
		// Clear filesystem prompt.txt only when ALL files are committed.
		if ((state.filesTouched ?? []).length === 0) {
			try {
				await clearFilesystemPrompt(state.sessionId, repo.root);
			} catch {
				/* best-effort */
			}
		}
	}

	// (8) Mark FullyCondensed for ENDED with nothing left.
	if (
		state.phase === 'ended' &&
		(state.filesTouched ?? []).length === 0 &&
		(handler.condensed || !hasNew)
	) {
		state.fullyCondensed = true;
	}

	// (9) Save state.
	try {
		await s.saveSessionState(state);
	} catch (err) {
		log.warn(
			{ component: 'checkpoint', sessionId: state.sessionId },
			'failed to update session state',
			{ error: err instanceof Error ? err.message : String(err) },
		);
	}

	// (10) Preserve shadow branch for ACTIVE not condensed.
	if (state.phase === 'active' && !handler.condensed) {
		uncondensedActiveOnBranch.add(shadowBranchName);
	}
}

/**
 * `post-commit` git hook entry. 11-step main pipeline:
 *
 *   1. open repo + read HEAD commit
 *   2. parse `Story-Checkpoint:` trailer; no trailer → updateBaseCommitOnly
 *   3. find sessions for worktree (warn + return if none despite trailer)
 *   4. build TransitionContext (`isRebaseInProgress`)
 *   5. pre-resolve HEAD tree + parent tree once (perf invariant)
 *   6. resolve `committedFileSet` via `filesChangedInCommit`
 *   7. compute `allAgentFiles` (cross-session union) +
 *      `sessionsWithCommittedFiles` count
 *   8. per-session loop → `postCommitProcessSession`
 *   9. cross-session attribution merge → `updateCombinedAttributionForCheckpoint`
 *  10. shadow branch cleanup (skip uncondensed-ACTIVE branches)
 *  11. stale ENDED warning (rate-limited via sentinel mtime)
 *
 * Hook contract: silent on every error (returns void without throwing).
 *
 * Mirrors Go `manual_commit_hooks.go: PostCommit`.
 *
 * @example
 * await postCommitImpl(strategy);
 *
 * // Side effects (when commit has Story-Checkpoint trailer + active sessions):
 * //   refs/heads/story/checkpoints/v1                  ← bumped per condensed session
 * //   refs/heads/story/<base>-<6hex>                   ← shadow branch deleted (when ALL active gone)
 * //   refs/heads/story/<newHead>-<6hex>                ← new shadow branch (carry-forward)
 * //   .git/objects/...                                 ← metadata + transcript + prompts blobs
 * //   <repoDir>/.git/story-sessions/<sessionId>.json   ← per-session overwritten
 * //   <repoDir>/.git/story-sessions/.warn-stale-ended  ← may be touched (sentinel)
 * //   stderr                                            ← may write "story: N ended session(s)..." warn
 * //
 * // HEAD / index / worktree: unchanged.
 */
export async function postCommitImpl(s: ManualCommitStrategy): Promise<void> {
	// === Step 1: open repo + read HEAD + read commit ===
	let repo: Repository;
	let head: string;
	let commit: CommitShape;
	try {
		repo = await s.getRepo();
		head = (await execGit(['rev-parse', 'HEAD'], { cwd: repo.root })).trim();
		const c = await git.readCommit({ fs: fsCallback, dir: repo.root, oid: head });
		commit = c.commit;
	} catch {
		return; // silent
	}

	// === Step 2: parse trailer ===
	const checkpointId = parseCheckpoint(commit.message);
	if (checkpointId === null) {
		// No trailer: still update BaseCommit for active sessions.
		await postCommitUpdateBaseCommitOnly(s, head);
		return;
	}

	// === Step 3: find sessions ===
	let worktreePath: string;
	try {
		worktreePath = await worktreeRoot(repo.root);
	} catch {
		return;
	}
	let sessions: SessionState[];
	try {
		sessions = await findSessionsForWorktree(repo.root, worktreePath);
	} catch {
		log.warn({ component: 'checkpoint' }, 'post-commit: no active sessions despite trailer', {
			strategy: 'manual-commit',
			checkpointId: checkpointId.toString(),
		});
		return;
	}
	if (sessions.length === 0) {
		log.warn({ component: 'checkpoint' }, 'post-commit: no active sessions despite trailer', {
			strategy: 'manual-commit',
			checkpointId: checkpointId.toString(),
		});
		return;
	}

	// === Step 4: build TransitionContext ===
	const isRebase = await isGitSequenceOperation(repo.root);
	const transitionCtx = { isRebaseInProgress: isRebase, hasFilesTouched: false };
	if (isRebase) {
		log.debug(
			{ component: 'checkpoint' },
			'post-commit: rebase/sequence in progress, skipping phase transitions',
		);
	}

	// === Step 5: pre-resolve trees once (shared across sessions) ===
	let headTreeOid: string | null = null;
	let parentTreeOid: string | null = null;
	try {
		headTreeOid = (await execGit(['rev-parse', `${head}^{tree}`], { cwd: repo.root })).trim();
	} catch {
		/* keep null */
	}
	let parentHash = '';
	if (commit.parent.length > 0) {
		parentHash = commit.parent[0] ?? '';
		try {
			parentTreeOid = (
				await execGit(['rev-parse', `${parentHash}^{tree}`], { cwd: repo.root })
			).trim();
		} catch {
			/* keep null */
		}
	}

	// === Step 6: resolve committed file set ===
	const committedFileSet = await filesChangedInCommit(
		repo.root,
		head,
		parentHash,
		headTreeOid,
		parentTreeOid,
	);

	// === Step 7: compute allAgentFiles + sessionsWithCommittedFiles ===
	// **Story-side divergence from Go**: Go uses `break` after the first
	// committed-file match to count the session at most once, but the break
	// also exits the loop early — files in `state.filesTouched` AFTER the
	// matching one are never added to `allAgentFiles`. This drops cross-
	// session attribution coverage. Story uses a `counted` flag instead so
	// the union is complete (every tracked file always added) and the
	// session is still counted at most once.
	const allAgentFiles = new Set<string>();
	let sessionsWithCommittedFiles = 0;
	for (const state of sessions) {
		if (state.fullyCondensed && state.phase === 'ended') {
			continue;
		}
		let counted = false;
		for (const f of state.filesTouched ?? []) {
			allAgentFiles.add(f);
			if (committedFileSet.has(f) && !counted) {
				sessionsWithCommittedFiles++;
				counted = true;
			}
		}
	}

	// === Step 8: per-session loop ===
	const shadowBranchesToDelete = new Set<string>();
	const uncondensedActiveOnBranch = new Set<string>();
	for (const state of sessions) {
		if (state.fullyCondensed && state.phase === 'ended') {
			continue;
		}
		await postCommitProcessSession(
			s,
			repo,
			state,
			transitionCtx,
			checkpointId,
			commit,
			head,
			headTreeOid,
			parentTreeOid,
			committedFileSet,
			shadowBranchesToDelete,
			uncondensedActiveOnBranch,
			allAgentFiles,
			sessionsWithCommittedFiles,
		);
	}

	// === Step 9: cross-session attribution merge ===
	try {
		await updateCombinedAttributionForCheckpoint(
			s,
			checkpointId,
			headTreeOid,
			parentTreeOid,
			repo.root,
		);
	} catch (err) {
		log.warn({ component: 'checkpoint' }, 'failed to update combined checkpoint attribution', {
			checkpointId: checkpointId.toString(),
			error: err instanceof Error ? err.message : String(err),
		});
	}

	// === Step 10: shadow branch cleanup ===
	for (const shadowBranchName of shadowBranchesToDelete) {
		if (uncondensedActiveOnBranch.has(shadowBranchName)) {
			log.debug(
				{ component: 'checkpoint' },
				'post-commit: preserving shadow branch (active session exists)',
				{ shadowBranch: shadowBranchName },
			);
			continue;
		}
		try {
			await deleteShadowBranch(shadowBranchName, repo.root);
			log.info({ component: 'checkpoint' }, 'shadow branch deleted', {
				strategy: 'manual-commit',
				shadowBranch: shadowBranchName,
			});
		} catch (err) {
			log.warn({ component: 'checkpoint' }, 'failed to clean up shadow branch', {
				shadowBranch: shadowBranchName,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	// === Step 11: stale ENDED warning (rate-limited) ===
	const stale = await countWarnableStaleEndedSessions(repo.root, sessions);
	if (stale >= STALE_ENDED_SESSION_WARN_THRESHOLD) {
		await warnStaleEndedSessions(repo.gitCommonDir, stale);
	}
}
