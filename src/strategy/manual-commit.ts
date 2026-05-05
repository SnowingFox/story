/**
 * `ManualCommitStrategy` class shell — the public API surface for the
 * manual-commit strategy. Phase 5.1 ships the constructor + lazy stores +
 * `validateRepository` / `setBlobFetcher` / `hasBlobFetcher`; the 19 business
 * methods (`saveStep`, `condenseSession`, `prepareCommitMsg`, ...) are
 * intentional stubs that throw {@link NOT_IMPLEMENTED}, to be filled by
 * Phases 5.2-5.6.
 *
 * **Audit chain**: every stub message contains `'Phase 5.X: <method> — see <go-file>:<line>'`,
 * which [`scripts/audit-deferrals.sh`](scripts/audit-deferrals.sh) finds via
 * `git grep "throw NOT_IMPLEMENTED('Phase 5.X')"`. Each downstream phase
 * `legacy.md` §1 lists the matching stubs as `[ ]` items.
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/strategy/manual_commit.go`.
 *
 * @packageDocumentation
 */

import path from 'node:path';
import type { BlobFetchFunc } from '../checkpoint/fetching-tree';
import { GitStore } from '../checkpoint/types';
import { V2GitStore } from '../checkpoint/v2-store';
import { execGit } from '../git';
import type { CheckpointID } from '../id';
import { SESSION_STATE_DIR_NAME, worktreeRoot } from '../paths';
import { StateStore } from '../session/state-store';
import { listAllItems } from './cleanup';
import {
	type CondenseOpts as CondensationOpts,
	condenseSession as condenseSessionImpl,
} from './condensation';
import {
	condenseAndMarkFullyCondensed as condenseAndMarkFullyCondensedImpl,
	condenseSessionByID as condenseSessionByIDImpl,
} from './condense-by-id';
import { commitMsgImpl } from './hooks-commit-msg';
import { initializeSessionImpl } from './hooks-initialize-session';
import { postCommitImpl } from './hooks-post-commit';
import { postRewriteImpl } from './hooks-post-rewrite';
import { prepareCommitMsgImpl } from './hooks-prepare-commit-msg';
import { handleTurnEndImpl } from './hooks-turn-end';
import {
	migrateAndPersistIfNeeded as migrateAndPersistIfNeededImpl,
	migrateShadowBranchIfNeeded as migrateShadowBranchIfNeededImpl,
	migrateShadowBranchToBaseCommit as migrateShadowBranchToBaseCommitImpl,
} from './manual-commit-migration';
import { prePushImpl } from './manual-commit-push';
import {
	findSessionsForCommit as findSessionsForCommitImpl,
	listAllSessionStates,
} from './manual-commit-session';
import { warnIfMetadataDisconnected } from './metadata-reconcile';
import { openRepository, type Repository } from './repo';
import { resetImpl, resetSessionImpl } from './reset';
import { restoreLogsOnlyImpl } from './restore-logs';
import { canRewindImpl, previewRewindImpl, rewindImpl } from './rewind';
import { getRewindPointsImpl } from './rewind-points';
import { saveStep as saveStepImpl, saveTaskStep as saveTaskStepImpl } from './save-step';
import type {
	AgentType,
	CleanupItem,
	CondenseResult,
	RestoredSession,
	RewindPoint,
	RewindPreview,
	SessionState,
	StepContext,
	TaskStepContext,
} from './types';

/**
 * Optional condense settings — re-exported from
 * [`./condensation.ts`](./condensation.ts) (Phase 5.3 Part 1 implementation
 * landing). Mirrors Go variadic `condenseOpts` from
 * `manual_commit_condensation.go`.
 */
export type CondenseOpts = CondensationOpts;

/**
 * Manual-commit strategy implementation. Stores checkpoints on shadow
 * branches (Phase 4.2), condenses them to the metadata branch on commit
 * (Phase 4.3 + 5.3), and supports rewind to any prior checkpoint (5.5).
 *
 * **Lazy initialization**: `stateStore` / `checkpointStore` / `v2CheckpointStore`
 * are built on first access via cached promises (TS analog of Go `sync.Once`).
 * This keeps construction cheap while guaranteeing identity across
 * concurrent access.
 *
 * @example
 * const strategy = new ManualCommitStrategy();
 * await strategy.validateRepository();
 * strategy.setBlobFetcher(async (hashes) => {
 *   await execGit(['fetch', 'origin', '--no-tags', ...hashes]);
 * });
 * // Phase 5.2-5.6 will fill in the 19 business methods.
 */
export class ManualCommitStrategy {
	private readonly cwd: string | undefined;
	private blobFetcher: BlobFetchFunc | undefined;

	private repoPromise: Promise<Repository> | undefined;
	private stateStorePromise: Promise<StateStore> | undefined;
	private checkpointStorePromise: Promise<GitStore> | undefined;
	private v2CheckpointStorePromise: Promise<V2GitStore> | undefined;

	/**
	 * Construct a new strategy instance bound to the repository containing
	 * `cwd` (defaults to `process.cwd()`).
	 *
	 * Mirrors Go `manual_commit.go:88-90` (`NewManualCommitStrategy`).
	 */
	constructor(cwd?: string) {
		this.cwd = cwd;
	}

	/**
	 * Validate that the bound repository is a usable git worktree. Throws on
	 * a non-git directory or a repo without a worktree (bare repo). Public
	 * API — lifecycle / configuration entry point.
	 *
	 * Mirrors Go `manual_commit.go:104-117` (`ValidateRepository`).
	 *
	 * @example
	 * ```ts
	 * const strategy = new ManualCommitStrategy('/repo');
	 * await strategy.validateRepository();
	 * // returns: undefined (resolves on success)
	 *
	 * const bad = new ManualCommitStrategy('/tmp/not-a-repo');
	 * await bad.validateRepository();
	 * // throws: Error('not a git repository: ...')
	 *
	 * // Side effects: none — read-only `git rev-parse` invocations only.
	 * //
	 * // Disk / git refs / HEAD: unchanged.
	 * ```
	 */
	async validateRepository(): Promise<void> {
		try {
			await this.getRepo();
		} catch (err) {
			throw new Error(`not a git repository: ${err instanceof Error ? err.message : String(err)}`, {
				cause: err as Error,
			});
		}
	}

	/**
	 * Configure on-demand blob fetching for the v2 checkpoint store.
	 * Must be called before the first checkpoint store access if treeless
	 * fetch support is needed (e.g., for `story explain` reading remote-only
	 * raw transcripts).
	 *
	 * Mirrors Go `manual_commit.go:94-96` (`SetBlobFetcher`).
	 */
	setBlobFetcher(fetcher: BlobFetchFunc): void {
		this.blobFetcher = fetcher;
	}

	/**
	 * Reports whether a blob fetcher is configured. Used by tests to verify
	 * the strategy is properly wired for treeless-fetch support.
	 *
	 * Mirrors Go `manual_commit.go:100-102` (`HasBlobFetcher`).
	 */
	hasBlobFetcher(): boolean {
		return this.blobFetcher !== undefined;
	}

	/**
	 * Lazy {@link Repository} bundle, scoped to the cwd this strategy was
	 * constructed with. Memoized like the other lazy stores. Surfaced as
	 * `@internal` so Phase 5.2 standalone helpers (`save-step.ts`,
	 * `manual-commit-migration.ts`) can resolve the repo root without
	 * defaulting to `process.cwd()` (which can point at a deleted directory
	 * during tests).
	 *
	 * @internal
	 */
	getRepo(): Promise<Repository> {
		if (!this.repoPromise) {
			this.repoPromise = openRepository(this.cwd);
		}
		return this.repoPromise;
	}

	/**
	 * Lazy session-state store, scoped to this repo's `.git/story-sessions/`.
	 * Phase 5.1 lazy plumbing — Phase 5.4 hooks consume this via the public
	 * methods; surfaced for tests via TS-private access.
	 *
	 * Mirrors Go `manual_commit.go:40-52` (`getStateStore`).
	 *
	 * @example
	 * ```ts
	 * const strategy = new ManualCommitStrategy('/repo');
	 * const store = await strategy.getStateStore();
	 * // returns: StateStore { dir: '/repo/.git/story-sessions' }
	 *
	 * // Subsequent calls return the same instance (sync.Once analog).
	 * const store2 = await strategy.getStateStore();
	 * // store2 === store  (identity preserved)
	 *
	 * // Side effects: none on first access — the StateStore object is constructed
	 * // in memory; no directory is created until store.save(...) writes a file.
	 * //
	 * // Disk / git refs / HEAD: unchanged.
	 * ```
	 *
	 * @internal
	 */
	getStateStore(): Promise<StateStore> {
		if (!this.stateStorePromise) {
			this.stateStorePromise = (async () => {
				const repo = await this.getRepo();
				return new StateStore(path.join(repo.gitCommonDir, SESSION_STATE_DIR_NAME));
			})();
		}
		return this.stateStorePromise;
	}

	/**
	 * Lazy v1 checkpoint store (shadow branches + metadata branch), with
	 * optional blob fetcher injected. Phase 5.2 (`saveStep`) and Phase 5.3
	 * (condensation) read/write through this store.
	 *
	 * Mirrors Go `manual_commit.go: getCheckpointStore`. Like Go, this also
	 * fires a one-time stderr `[story] Warning` if the local v1 metadata
	 * branch is disconnected from `refs/remotes/origin/story/checkpoints/v1`
	 * (the empty-orphan bug scenario; see [`./metadata-reconcile.ts`](./metadata-reconcile.ts)).
	 * The warning is fire-and-forget — failures inside it are swallowed so
	 * lazy-store initialization stays cheap and total.
	 *
	 * @example
	 * ```ts
	 * const strategy = new ManualCommitStrategy('/repo');
	 * const store = await strategy.getCheckpointStore();
	 * // returns: GitStore { repoDir: '/repo' } (blobFetcher: undefined)
	 *
	 * // Subsequent calls return the same instance (sync.Once analog).
	 * const store2 = await strategy.getCheckpointStore();
	 * // store2 === store  (identity preserved)
	 *
	 * // With blob fetcher (must be wired BEFORE first access):
	 * strategy.setBlobFetcher(async (hashes) => { ... });
	 * const fetchingStore = await strategy.getCheckpointStore();
	 * // fetchingStore.getBlobFetcher() !== undefined
	 *
	 * // Side effects on first call:
	 * //   - May write a one-time `[story] Warning: Local and remote session
	 * //     metadata branches are disconnected.` line to stderr (fire-and-forget).
	 * //   - No files, no refs, no network I/O otherwise.
	 * //
	 * // Disk / git refs / HEAD: unchanged.
	 * ```
	 *
	 * @internal
	 */
	getCheckpointStore(): Promise<GitStore> {
		if (!this.checkpointStorePromise) {
			this.checkpointStorePromise = (async () => {
				const repo = await this.getRepo();
				// Fire-and-forget disconnect warning, mirroring Go's
				// `WarnIfMetadataDisconnected()` call inside `getCheckpointStore`.
				// Errors inside the helper are already swallowed (sync.Once gate
				// + try/catch); we still wrap the call site to absolutely
				// guarantee lazy init never throws.
				try {
					await warnIfMetadataDisconnected({ cwd: repo.root });
				} catch {
					// best-effort advisory; never block store init
				}
				const store = new GitStore(repo.root);
				if (this.blobFetcher) {
					store.setBlobFetcher(this.blobFetcher);
				}
				return store;
			})();
		}
		return this.checkpointStorePromise;
	}

	/**
	 * Lazy v2 checkpoint store, with optional blob fetcher injected.
	 * Phase 5.1 lazy plumbing — Phase 5.3 / 5.6 consume this; surfaced for
	 * tests via TS-private access.
	 *
	 * Mirrors Go `manual_commit.go:73-85` (`getV2CheckpointStore`).
	 *
	 * @example
	 * ```ts
	 * const strategy = new ManualCommitStrategy('/repo');
	 * const store = await strategy.getV2CheckpointStore();
	 * // returns: V2GitStore { repoDir: '/repo', fetchRemote: 'origin' }
	 *
	 * // Subsequent calls return the same instance (sync.Once analog).
	 * const store2 = await strategy.getV2CheckpointStore();
	 * // store2 === store  (identity preserved)
	 *
	 * // Side effects: none on first access; v2 ref reads happen later.
	 * //
	 * // Disk / git refs / HEAD: unchanged.
	 * ```
	 *
	 * @internal
	 */
	getV2CheckpointStore(): Promise<V2GitStore> {
		if (!this.v2CheckpointStorePromise) {
			this.v2CheckpointStorePromise = (async () => {
				const repo = await this.getRepo();
				const store = new V2GitStore(repo.root);
				if (this.blobFetcher) {
					store.setBlobFetcher(this.blobFetcher);
				}
				return store;
			})();
		}
		return this.v2CheckpointStorePromise;
	}

	/**
	 * Load session state via the lazy {@link getStateStore}. Returns `null`
	 * for missing files, missing directory, or stale sessions (auto-deleted
	 * by the underlying `StateStore.load`).
	 *
	 * Mirrors Go `manual_commit_session.go:23-33` (`loadSessionState`).
	 *
	 * @example
	 * ```ts
	 * const strategy = new ManualCommitStrategy('/repo');
	 * const state = await strategy.loadSessionState('sess-1');
	 * // returns: SessionState { sessionId: 'sess-1', ... }  | null
	 *
	 * // Side effects: none — read-only file access. May trigger background
	 * // delete of stale .json files (delegated to StateStore.load).
	 * //
	 * // Git refs / HEAD: unchanged.
	 * ```
	 */
	async loadSessionState(sessionId: string): Promise<SessionState | null> {
		const store = await this.getStateStore();
		try {
			return await store.load(sessionId);
		} catch (err) {
			// Go: manual_commit_session.go:28-31 wraps every load error with this
			// exact phrase so callers / grep / tests can match a stable prefix.
			throw new Error(
				`failed to load session state: ${err instanceof Error ? err.message : String(err)}`,
				{ cause: err as Error },
			);
		}
	}

	/**
	 * Atomically save session state via the lazy {@link getStateStore}
	 * (temp file + rename — never leaves a half-written file on disk).
	 *
	 * Mirrors Go `manual_commit_session.go:36-45` (`saveSessionState`).
	 *
	 * @example
	 * ```ts
	 * const strategy = new ManualCommitStrategy('/repo');
	 * await strategy.saveSessionState({
	 *   sessionId: 'sess-1',
	 *   baseCommit: 'abc1234',
	 *   startedAt: new Date().toISOString(),
	 *   phase: 'idle',
	 *   stepCount: 0,
	 * });
	 * // returns: undefined (resolves on success)
	 *
	 * // Side effects:
	 * //   <repoDir>/.git/story-sessions/sess-1.json.<rand> ← temp file (transient)
	 * //   <repoDir>/.git/story-sessions/sess-1.json        ← atomic rename target
	 * //
	 * // Git refs / HEAD / worktree: unchanged.
	 * ```
	 */
	async saveSessionState(state: SessionState): Promise<void> {
		const store = await this.getStateStore();
		await store.save(state);
	}

	/**
	 * Remove all files for a session — `<id>.json` plus any `<id>.<sidecar>`
	 * (e.g. `<id>.model`). No-op when the session was never persisted.
	 *
	 * Mirrors Go `manual_commit_session.go:48-57` (`clearSessionState`) and the
	 * exported wrapper at `:228-232` (`ClearSessionState`).
	 *
	 * @example
	 * ```ts
	 * const strategy = new ManualCommitStrategy('/repo');
	 * await strategy.clearSessionState('sess-1');
	 * // returns: undefined
	 *
	 * // Side effects (only when the session existed on disk):
	 * //   <repoDir>/.git/story-sessions/sess-1.json   ← removed
	 * //   <repoDir>/.git/story-sessions/sess-1.model  ← removed (if present)
	 * //
	 * // Git refs / HEAD / worktree: unchanged.
	 * ```
	 */
	async clearSessionState(sessionId: string): Promise<void> {
		const store = await this.getStateStore();
		await store.clear(sessionId);
	}

	/**
	 * Find every live SessionState whose `baseCommit` equals `baseCommitSha`.
	 * Delegates to the package-level {@link findSessionsForCommitImpl}, which
	 * applies the {@link listAllSessionStates} orphan filter (drops + cleans
	 * sessions whose shadow branch is gone *and* who are inactive *and* who
	 * have no `lastCheckpointId`) before the BaseCommit equality match.
	 *
	 * Mirrors Go `manual_commit_session.go:206-220` (`findSessionsForCommit`)
	 * and exported wrapper `:222-226` (`FindSessionsForCommit`). Used by the
	 * Phase 5.5 reset command + Phase 5.4 hooks (PostCommit / PostRewrite).
	 *
	 * @example
	 * ```ts
	 * const strategy = new ManualCommitStrategy('/repo');
	 * const live = await strategy.findSessionsForCommit('abc1234');
	 * // returns: SessionState[]  (all live sessions with baseCommit === 'abc1234')
	 *
	 * // Side effects (only when an orphan row is encountered):
	 * //   <repoDir>/.git/story-sessions/<orphan-id>.json   ← removed
	 * //   <repoDir>/.git/story-sessions/<orphan-id>.model  ← removed (if present)
	 * //
	 * // Git refs / HEAD: unchanged.
	 * ```
	 */
	async findSessionsForCommit(baseCommitSha: string): Promise<SessionState[]> {
		const repo = await this.getRepo();
		return findSessionsForCommitImpl(repo.root, baseCommitSha);
	}

	/**
	 * Count other active sessions in the **same worktree** that already have at
	 * least one checkpoint and are based on the **current HEAD**. Used by
	 * Phase 5.4 InitializeSession to print a "another N concurrent sessions
	 * will join the next commit" hint.
	 *
	 * Filter (4 conjunctions, all required for a session to be counted):
	 *   1. `state.sessionId !== currentSessionId`            (excludes the caller)
	 *   2. `state.worktreePath === current worktree root`    (worktree-scoped)
	 *   3. `state.stepCount > 0`                             (must have checkpoints)
	 *   4. `state.baseCommit === current HEAD`               (same commit lineage)
	 *
	 * Mirrors Go `manual_commit_session.go:234-274`
	 * (`CountOtherActiveSessionsWithCheckpoints`).
	 *
	 * @example
	 * ```ts
	 * const strategy = new ManualCommitStrategy('/repo');
	 * await strategy.countOtherActiveSessionsWithCheckpoints('current-sess');
	 * // returns: 0   when no other matching session exists
	 * // returns: N   when N other sessions in the same worktree have stepCount > 0
	 * //              and are based on current HEAD
	 *
	 * // Side effects: read-only — runs `git rev-parse HEAD` + delegates to
	 * // `listAllSessionStates`, which best-effort cleans pure-orphan rows.
	 * //
	 * // Disk for non-orphan sessions / git refs / HEAD: unchanged.
	 * ```
	 */
	async countOtherActiveSessionsWithCheckpoints(currentSessionId: string): Promise<number> {
		const repo = await this.getRepo();
		const currentWorktree = await worktreeRoot(repo.root);
		const head = (await execGit(['rev-parse', 'HEAD'], { cwd: repo.root })).trim();
		const allStates = await listAllSessionStates(repo.root);
		let count = 0;
		for (const state of allStates) {
			if (
				state.sessionId !== currentSessionId &&
				state.worktreePath === currentWorktree &&
				state.stepCount > 0 &&
				state.baseCommit === head
			) {
				count++;
			}
		}
		return count;
	}

	// SaveStep family (Phase 5.2). Thin facades over standalone
	// implementations in `save-step.ts` and `manual-commit-migration.ts`
	// (mirrors the Phase 5.1 pattern used by `findSessionsForCommit`).

	/**
	 * Save a session-level checkpoint to the shadow branch.
	 * Mirrors Go `manual_commit_git.go:24-186` (`SaveStep`).
	 */
	saveStep(step: StepContext): Promise<void> {
		return saveStepImpl(this, step);
	}

	/**
	 * Save a subagent task checkpoint to the shadow branch.
	 * Mirrors Go `manual_commit_git.go:190-315` (`SaveTaskStep`).
	 */
	saveTaskStep(step: TaskStepContext): Promise<void> {
		return saveTaskStepImpl(this, step);
	}

	/**
	 * Move the session's shadow branch to the current HEAD when HEAD has
	 * changed mid-session. Returns `true` when migration occurred.
	 * Mirrors Go `manual_commit_migration.go:23-39`.
	 */
	migrateShadowBranchIfNeeded(repoDir: string, state: SessionState): Promise<boolean> {
		return migrateShadowBranchIfNeededImpl(this, repoDir, state);
	}

	/**
	 * Rename the session's shadow ref to a name derived from `newBaseCommit`
	 * and update `state.baseCommit`. Returns `true` when state changed.
	 * Mirrors Go `manual_commit_migration.go:42-103`.
	 */
	migrateShadowBranchToBaseCommit(
		repoDir: string,
		state: SessionState,
		newBaseCommit: string,
	): Promise<boolean> {
		return migrateShadowBranchToBaseCommitImpl(repoDir, state, newBaseCommit);
	}

	/**
	 * `migrateShadowBranchIfNeeded` + `saveSessionState` when migration occurred.
	 * Mirrors Go `manual_commit_migration.go:106-118`.
	 */
	migrateAndPersistIfNeeded(repoDir: string, state: SessionState): Promise<void> {
		return migrateAndPersistIfNeededImpl(this, repoDir, state);
	}

	// Condensation family (Phase 5.3). Thin facades over standalone
	// implementations in `condensation.ts` and `condense-by-id.ts` (mirrors
	// the Phase 5.1 / 5.2 facade pattern used by `findSessionsForCommit` /
	// `saveStep`).

	/**
	 * Primary condense path (PostCommit / PostRewrite). Returns `{ skipped:
	 * true, ... }` early when there's no transcript AND no filesTouched.
	 * Mirrors Go `manual_commit_condensation.go: CondenseSession`.
	 */
	condenseSession(
		checkpointId: CheckpointID,
		state: SessionState,
		committedFiles: ReadonlySet<string> | null,
		opts?: CondenseOpts,
	): Promise<CondenseResult> {
		return condenseSessionImpl(this, checkpointId, state, committedFiles, opts);
	}

	/**
	 * `story doctor` entry — condense + reset state to IDLE. Throws if state
	 * file missing; deletes state file when shadow branch missing.
	 * Mirrors Go `manual_commit_condensation.go: CondenseSessionByID`.
	 */
	condenseSessionByID(sessionId: string): Promise<void> {
		return condenseSessionByIDImpl(this, sessionId);
	}

	/**
	 * SessionStop hook eager path — condense + mark FullyCondensed; preserves
	 * phase=ENDED; never deletes state file; fail-open on any error.
	 * Mirrors Go `manual_commit_condensation.go: CondenseAndMarkFullyCondensed`.
	 */
	condenseAndMarkFullyCondensed(sessionId: string): Promise<void> {
		return condenseAndMarkFullyCondensedImpl(this, sessionId);
	}

	// Phase 5.4 hook handlers (Part 1 — agent + git-msg hooks). Thin facades
	// over standalone implementations in `hooks-*.ts` (mirrors the Phase 5.1
	// / 5.2 / 5.3 pattern). PostCommit + PostRewrite stubs remain here
	// pending Phase 5.4 Part 2.

	/**
	 * `prepare-commit-msg` git hook entry. Adds a `Story-Checkpoint:` trailer
	 * to the commit message when an active session has new content.
	 * Mirrors Go `manual_commit_hooks.go: PrepareCommitMsg`.
	 */
	prepareCommitMsg(msgFile: string, source: string): Promise<void> {
		return prepareCommitMsgImpl(this, msgFile, source);
	}

	/**
	 * `commit-msg` git hook entry. Strips a trailer-only message so git aborts.
	 * Mirrors Go `manual_commit_hooks.go: CommitMsg`.
	 */
	commitMsg(msgFile: string): Promise<void> {
		return commitMsgImpl(this, msgFile);
	}

	/**
	 * `post-commit` git hook entry. 11-step pipeline: parse trailer, find
	 * sessions, drive state machine, condense + carry-forward, cross-session
	 * attribution, shadow branch cleanup, stale ENDED warn.
	 * Mirrors Go `manual_commit_hooks.go: PostCommit`.
	 */
	postCommit(): Promise<void> {
		return postCommitImpl(this);
	}

	/**
	 * `post-rewrite` git hook entry (rebase / amend). Reads `<oldSha> <newSha>`
	 * lines from stdin; remaps each active session's `baseCommit` /
	 * `attributionBaseCommit` + migrates the matching shadow branch ref.
	 * Mirrors Go `manual_commit_hooks.go: PostRewrite`. Go signature:
	 * `(ctx, rewriteType, r io.Reader) error`; TS uses
	 * `NodeJS.ReadableStream` for the mappings input.
	 */
	postRewrite(rewriteType: string, mappingsStream: NodeJS.ReadableStream): Promise<void> {
		return postRewriteImpl(this, rewriteType, mappingsStream);
	}

	/**
	 * `UserPromptSubmit` agent hook entry. New-session bootstrap or existing-
	 * session TurnStart transition + baseline attribution + shadow migration.
	 * Mirrors Go `manual_commit_hooks.go: InitializeSession`.
	 */
	initializeSession(
		sessionId: string,
		agentType: AgentType,
		transcriptPath: string,
		userPrompt: string,
		model: string,
	): Promise<void> {
		return initializeSessionImpl(this, sessionId, agentType, transcriptPath, userPrompt, model);
	}

	/**
	 * `Stop` agent hook entry. Finalizes per-turn checkpoints with the full
	 * transcript and conditionally advances `checkpointTranscriptStart`.
	 * Mirrors Go `manual_commit_hooks.go: HandleTurnEnd`.
	 */
	handleTurnEnd(state: SessionState): Promise<void> {
		return handleTurnEndImpl(this, state);
	}

	// Phase 5.5 — Rewind / Reset family. Thin facades over standalone
	// implementations in `rewind.ts` / `rewind-points.ts` / `restore-logs.ts`
	// / `reset.ts` (mirrors the Phase 5.1 / 5.2 / 5.3 / 5.4 facade pattern).

	/**
	 * Restore worktree files from a checkpoint commit's tree + reset shadow
	 * branch HEAD to that commit. Mirrors Go `manual_commit_rewind.go: Rewind`.
	 */
	rewind(
		out: NodeJS.WritableStream,
		err: NodeJS.WritableStream,
		point: RewindPoint,
	): Promise<void> {
		return rewindImpl(this, out, err, point);
	}

	/**
	 * List rewind candidates: shadow checkpoints (uncommitted) merged with
	 * logs-only commits (committed via `Story-Checkpoint:` trailer).
	 * Mirrors Go `manual_commit_rewind.go: GetRewindPoints`.
	 */
	getRewindPoints(limit: number): Promise<RewindPoint[]> {
		return getRewindPointsImpl(this, limit);
	}

	/**
	 * Pre-flight check: always returns `canRewind: true`. The `message` is a
	 * Go-rich diff-stats summary of uncommitted changes that would be reverted.
	 * Mirrors Go `manual_commit_rewind.go: CanRewind`.
	 *
	 * **Phase 5.5 signature change**: 5.1 stub returned `{ canRewind, warnings:
	 * string[] }`; 5.5 returns `{ canRewind, message: string }` to match Go.
	 */
	canRewind(): Promise<{ canRewind: boolean; message: string }> {
		return canRewindImpl(this);
	}

	/**
	 * Compute what {@link rewind} would do without writing anything. Mirrors
	 * Go `manual_commit_rewind.go: PreviewRewind`.
	 */
	previewRewind(point: RewindPoint): Promise<RewindPreview> {
		return previewRewindImpl(this, point);
	}

	/**
	 * Read transcripts from the metadata branch and write back to each
	 * agent's session directory (no worktree changes). Mirrors Go
	 * `manual_commit_rewind.go: RestoreLogsOnly`.
	 */
	restoreLogsOnly(
		out: NodeJS.WritableStream,
		err: NodeJS.WritableStream,
		point: RewindPoint,
		force: boolean,
	): Promise<RestoredSession[]> {
		return restoreLogsOnlyImpl(this, out, err, point, force);
	}

	/**
	 * Clear shadow branch + all session state files for the current HEAD.
	 * Mirrors Go `manual_commit_reset.go: Reset`.
	 */
	reset(out: NodeJS.WritableStream, err: NodeJS.WritableStream): Promise<void> {
		return resetImpl(this, out, err);
	}

	/**
	 * Clear a single session's state and remove its shadow branch when no
	 * other session uses it. Mirrors Go `manual_commit_reset.go: ResetSession`.
	 */
	resetSession(
		out: NodeJS.WritableStream,
		err: NodeJS.WritableStream,
		sessionId: string,
	): Promise<void> {
		return resetSessionImpl(this, out, err, sessionId);
	}

	/**
	 * List every Story-owned cleanable item (shadow branches + session
	 * states) in the repo. Used by `story clean --all` to build its
	 * deletion plan; `story doctor` reaches for it when repairing a
	 * stuck lifecycle.
	 *
	 * Delegates to [`./cleanup.ts::listAllItems`](./cleanup.ts) so the
	 * rules stay in one place. The deletion half of the contract is
	 * owned by `deleteAllCleanupItems` — this method only surfaces the
	 * candidates.
	 *
	 * Mirrors Go `manual_commit.go` (`ListOrphanedItems` facade;
	 * implementation lives in `strategy/cleanup.go`).
	 *
	 * @example
	 * await strategy.listOrphanedItems();
	 * // returns: [
	 * //   { type: 'shadow-branch', id: 'story/abc1234-e3b0c4', reason: 'clean all' },
	 * //   { type: 'session-state', id: 'sess-abc123',          reason: 'clean all' },
	 * // ]
	 *
	 * // Side effects: none — reads `refs/heads/story/` + `.git/story-sessions/`.
	 */
	async listOrphanedItems(): Promise<CleanupItem[]> {
		const repo = await this.getRepo();
		return listAllItems({ repoRoot: repo.root });
	}

	/**
	 * Push v1 metadata branch + v2 refs to a remote at git pre-push time.
	 *
	 * Configured via `strategy_options.push_sessions` (default `true`),
	 * `checkpoint_remote` (route to a dedicated repo), and `push_v2_refs`
	 * (requires `checkpoints_v2`). Hook contract: this function NEVER
	 * fails the user's `git push` — all errors are written to stderr as
	 * `[story] Warning` lines and swallowed.
	 *
	 * Implementation lives in [`./manual-commit-push.ts`](./manual-commit-push.ts).
	 */
	prePush(remote: string): Promise<void> {
		return prePushImpl(this, remote);
	}
}
