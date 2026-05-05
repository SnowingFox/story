/**
 * Shadow-branch migration: move the session's shadow ref when HEAD changes
 * mid-session (e.g. user pulls or rebases while the agent is paused).
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/strategy/manual_commit_migration.go`
 * (3 instance methods on `*ManualCommitStrategy`, lifted here to standalone
 * functions that take `s` explicitly — Go receiver equivalent — to fit the
 * thin-facade architecture set by Phase 5.1 `findSessionsForCommit`).
 *
 * Key invariant: `state.attributionBaseCommit` is **intentionally NOT
 * touched** during migration. Migration renames the shadow ref but the
 * underlying checkpoint trees were built relative to the original base —
 * attribution still has to diff from that original base to correctly measure
 * agent work captured in those checkpoints. See Go `manual_commit_migration.go:97-100`.
 *
 * @packageDocumentation
 */

import fsCallback from 'node:fs';
import git from 'isomorphic-git';
import { shadowBranchNameForCommit } from '../checkpoint/temporary';
import { execGit } from '../git';
import * as log from '../log';
import { deleteBranchCli } from './branches';
import type { ManualCommitStrategy } from './manual-commit';
import type { SessionState } from './types';

/**
 * Check whether HEAD has changed since the session started; if so, migrate
 * the shadow branch to the new base commit. Returns `true` if migration
 * occurred.
 *
 * Skips when `state == null || state.baseCommit === ''`. Uses `git rev-parse
 * HEAD` (Phase 1.3 `execGit`) to read the current commit. On
 * `state.baseCommit === currentHead` returns `false` immediately.
 *
 * The `s` parameter is currently unused inside this function (the chained
 * call to {@link migrateShadowBranchToBaseCommit} doesn't need strategy
 * access), but is kept to preserve Go receiver symmetry across the
 * `migrate*` family — Phase 5.4 may need to thread `s` through here when
 * InitializeSession integrates.
 *
 * Mirrors Go `manual_commit_migration.go:23-39`.
 *
 * @example
 * const migrated = await migrateShadowBranchIfNeeded(strategy, repoDir, state);
 * // returns: true if HEAD changed, false otherwise
 *
 * // Side effects: see migrateShadowBranchToBaseCommit when migration runs.
 * // When HEAD already matches state.baseCommit: zero side effects.
 */
export async function migrateShadowBranchIfNeeded(
	_s: ManualCommitStrategy,
	repoDir: string,
	state: SessionState,
): Promise<boolean> {
	if (state == null || state.baseCommit === '') {
		return false;
	}
	let head: string;
	try {
		head = (await execGit(['rev-parse', 'HEAD'], { cwd: repoDir })).trim();
	} catch (err) {
		throw new Error(`failed to get HEAD: ${err instanceof Error ? err.message : String(err)}`, {
			cause: err as Error,
		});
	}
	if (state.baseCommit === head) {
		return false;
	}
	return migrateShadowBranchToBaseCommit(repoDir, state, head);
}

/**
 * Move the current session's shadow branch ref to a new base-commit-derived
 * name and update `state.baseCommit`. Returns `true` when something was
 * persisted (ref moved or `state.baseCommit` updated), `false` on no-op.
 *
 * Three guard branches mirror Go (`migration.go:45-50` / `:56-61` / `:64-72`):
 * - empty `newBaseCommit` or same-base → no-op `false`
 * - hash short-prefix collision (`oldShadowBranch === newShadowBranch`)
 *   → only update `state.baseCommit`, **no** ref rename
 * - old shadow ref absent → only update `state.baseCommit`, log info
 *
 * `state.attributionBaseCommit` is **intentionally** preserved (Go
 * `migration.go:97-100`) — migration renames the ref but checkpoint trees
 * still anchor attribution at the original base.
 *
 * Mirrors Go `manual_commit_migration.go:42-103`.
 *
 * @example
 * const moved = await migrateShadowBranchToBaseCommit(repoDir, state, 'def5678new');
 * // returns: true
 *
 * // Side effects (when old ref existed and prefixes differ):
 * //   .git/refs/heads/story/def5678-<6hex> ← created (pointing at old shadow's commit)
 * //   .git/refs/heads/story/abc1234-<6hex> ← removed via git CLI (idempotent on miss)
 * //   state.baseCommit                     ← 'def5678new' (mutated)
 * //   state.attributionBaseCommit          ← UNCHANGED (intentional)
 * //
 * // Side effects (when old ref absent): only state.baseCommit mutated; logged
 * //   with component=migration.
 *
 * // Disk worktree / index / HEAD: unchanged.
 */
export async function migrateShadowBranchToBaseCommit(
	repoDir: string,
	state: SessionState,
	newBaseCommit: string,
): Promise<boolean> {
	if (state == null || state.baseCommit === '' || newBaseCommit === '') {
		return false;
	}
	if (state.baseCommit === newBaseCommit) {
		return false;
	}
	const worktreeId = state.worktreeId ?? '';
	const oldShadowBranch = shadowBranchNameForCommit(state.baseCommit, worktreeId);
	const newShadowBranch = shadowBranchNameForCommit(newBaseCommit, worktreeId);

	// Hash short-prefix collision guard: same name → just update state.
	if (oldShadowBranch === newShadowBranch) {
		state.baseCommit = newBaseCommit;
		return true;
	}

	// Try to read the old shadow ref. Missing → just update state.baseCommit.
	let oldRefHash: string;
	try {
		oldRefHash = await git.resolveRef({
			fs: fsCallback,
			dir: repoDir,
			ref: `refs/heads/${oldShadowBranch}`,
		});
	} catch {
		state.baseCommit = newBaseCommit;
		log.info(
			{ component: 'migration', sessionId: state.sessionId },
			'updated session base commit',
			{ new_base: newBaseCommit.slice(0, 7) },
		);
		return true;
	}

	// Old shadow exists — create new ref pointing at the same commit.
	// Go: `Storer.SetReference` unconditionally overwrites
	// (manual_commit_migration.go:75-80). Required for crash-recovery
	// idempotency: a previous migration may have created the new ref and then
	// crashed before deleting the old one; on retry we must overwrite, not
	// error out with isomorphic-git's `AlreadyExistsError`.
	try {
		await git.writeRef({
			fs: fsCallback,
			dir: repoDir,
			ref: `refs/heads/${newShadowBranch}`,
			value: oldRefHash,
			force: true,
		});
	} catch (err) {
		throw new Error(
			`failed to create new shadow branch ${newShadowBranch}: ${err instanceof Error ? err.message : String(err)}`,
			{ cause: err as Error },
		);
	}

	// Best-effort delete of the old ref via CLI (isomorphic-git ref delete is
	// unreliable with packed refs / linked worktrees — Go uses the same fallback).
	const migCtx = { component: 'migration', sessionId: state.sessionId };
	try {
		await deleteBranchCli(oldShadowBranch, repoDir);
	} catch (err) {
		log.warn(migCtx, 'failed to remove old shadow branch', {
			shadow_branch: oldShadowBranch,
			error: err instanceof Error ? err.message : String(err),
		});
	}

	log.info(migCtx, 'moved shadow branch (HEAD changed during session)', {
		from: oldShadowBranch,
		to: newShadowBranch,
	});

	// Intentionally NOT updating attributionBaseCommit — checkpoint trees are
	// still anchored at the original base. See Go migration.go:97-100.
	state.baseCommit = newBaseCommit;
	return true;
}

/**
 * Combined helper: {@link migrateShadowBranchIfNeeded} followed by
 * `s.saveSessionState(state)` only when migration occurred. Used by SaveStep
 * / SaveTaskStep / Phase 5.4 InitializeSession to keep the migrate-then-save
 * sequence atomic-looking.
 *
 * Wraps errors with the exact Go phrases so callers can grep:
 * - `failed to check/migrate shadow branch: <inner>` (from `migrateShadowBranchIfNeeded`)
 * - `failed to save session state after migration: <inner>` (from `saveSessionState`)
 *
 * Mirrors Go `manual_commit_migration.go:106-118`.
 */
export async function migrateAndPersistIfNeeded(
	s: ManualCommitStrategy,
	repoDir: string,
	state: SessionState,
): Promise<void> {
	let migrated: boolean;
	try {
		migrated = await migrateShadowBranchIfNeeded(s, repoDir, state);
	} catch (err) {
		throw new Error(
			`failed to check/migrate shadow branch: ${err instanceof Error ? err.message : String(err)}`,
			{ cause: err as Error },
		);
	}
	if (migrated) {
		try {
			await s.saveSessionState(state);
		} catch (err) {
			throw new Error(
				`failed to save session state after migration: ${err instanceof Error ? err.message : String(err)}`,
				{ cause: err as Error },
			);
		}
	}
}
