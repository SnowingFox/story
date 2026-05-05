/**
 * Phase 5.5 reset / resetSession implementations.
 *
 * `Reset` clears the shadow branch and ALL session state files for the
 * current HEAD commit (worktree files untouched). `ResetSession` clears
 * a single session by ID and removes the shadow branch only when no
 * other sessions reference it.
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/strategy/manual_commit_reset.go`
 * (`Reset` / `ResetSession` / `isAccessibleMode`).
 *
 * @packageDocumentation
 */

import { shadowBranchNameForCommit } from '../checkpoint/temporary';
import { execGit } from '../git';
import { getWorktreeID, worktreeRoot } from '../paths';
import { deleteBranchCli } from './branches';
import { cleanupShadowBranchIfUnused } from './condense-helpers';
import type { ManualCommitStrategy } from './manual-commit';
import type { SessionState } from './types';

/**
 * Implements the `reset` action: probe for shadow branch + sessions for
 * the current HEAD; clear all matching session state files; delete the
 * shadow branch when present. Worktree files are not touched.
 *
 * Mirrors Go `manual_commit_reset.go: Reset`.
 *
 * Pipeline:
 *   1. open repo + read HEAD
 *   2. {@link shadowBranchNameForCommit}(headHash, worktreeID)
 *   3. probe ref via `git show-ref --verify --quiet`
 *   4. {@link ManualCommitStrategy.findSessionsForCommit} (best-effort — swallow errors)
 *   5. nothing-to-clean → print "Nothing to clean for <branch>" + return
 *   6. for each session: {@link ManualCommitStrategy.clearSessionState}; warn-and-continue on failure
 *      print "✓ Cleared session state for <id>" per success
 *   7. delete shadow branch when present → print "✓ Deleted shadow branch <name>"
 *
 * @example
 * ```ts
 * await resetImpl(strategy, process.stdout, process.stderr);
 *
 * // Side effects:
 * //   <repoDir>/.git/refs/heads/story/<base>-<6hex>      ← removed (when present)
 * //   <repoDir>/.git/story-sessions/<sessionId>.json     ← removed per session
 * //   <repoDir>/.git/story-sessions/<sessionId>.model    ← removed (if present)
 * //   stdout                                              ← per-session "✓ Cleared session state for <id>"
 * //                                                          + "✓ Deleted shadow branch <name>"
 * //                                                          OR "Nothing to clean for <name>"
 * //   stderr                                              ← warn lines on partial failures
 * //
 * // HEAD / worktree files / index: unchanged. Other shadow branches: unchanged.
 * ```
 */
export async function resetImpl(
	s: ManualCommitStrategy,
	out: NodeJS.WritableStream,
	err: NodeJS.WritableStream,
): Promise<void> {
	const repo = await s.getRepo();
	let headHash: string;
	try {
		headHash = (await execGit(['rev-parse', 'HEAD'], { cwd: repo.root })).trim();
	} catch (e) {
		throw new Error(`failed to get HEAD: ${(e as Error).message}`, { cause: e as Error });
	}

	const worktreePath = await worktreeRoot(repo.root);
	const worktreeId = getWorktreeID(worktreePath) ?? '';
	const shadowBranch = shadowBranchNameForCommit(headHash, worktreeId);

	let hasShadowBranch = true;
	try {
		await execGit(['show-ref', '--verify', '--quiet', `refs/heads/${shadowBranch}`], {
			cwd: repo.root,
		});
	} catch {
		hasShadowBranch = false;
	}

	let sessions: SessionState[];
	try {
		sessions = await s.findSessionsForCommit(headHash);
	} catch {
		sessions = [];
	}

	if (!hasShadowBranch && sessions.length === 0) {
		out.write(`Nothing to clean for ${shadowBranch}\n`);
		return;
	}

	const cleared: string[] = [];
	for (const state of sessions) {
		try {
			await s.clearSessionState(state.sessionId);
			cleared.push(state.sessionId);
		} catch (e) {
			err.write(
				`Warning: failed to clear session state for ${state.sessionId}: ${(e as Error).message}\n`,
			);
		}
	}
	for (const sid of cleared) {
		out.write(`✓ Cleared session state for ${sid}\n`);
	}

	if (hasShadowBranch) {
		try {
			await deleteBranchCli(shadowBranch, repo.root);
			out.write(`✓ Deleted shadow branch ${shadowBranch}\n`);
		} catch (e) {
			throw new Error(`failed to delete shadow branch: ${(e as Error).message}`, {
				cause: e as Error,
			});
		}
	}
}

/**
 * Implements the `reset --session <id>` action: clear a single session's
 * state file and remove the shadow branch only when no other live
 * session references it. Worktree files unchanged.
 *
 * Mirrors Go `manual_commit_reset.go: ResetSession`.
 *
 * Pipeline:
 *   1. {@link ManualCommitStrategy.loadSessionState} → throw `'session not found: <id>'` when null
 *   2. {@link ManualCommitStrategy.clearSessionState} (rethrow on failure)
 *      print "✓ Cleared session state for <id>"
 *   3. {@link shadowBranchNameForCommit}(state.baseCommit, state.worktreeId)
 *   4. {@link cleanupShadowBranchIfUnused} — silent skip when other session uses it,
 *      `ErrBranchNotFound` swallowed; other errors warn-and-continue (don't propagate)
 *   5. post-check via `git show-ref` to print deletion message only when the
 *      branch is actually gone
 *
 * @example
 * ```ts
 * await resetSessionImpl(strategy, process.stdout, process.stderr, 'sess-1');
 *
 * // Side effects (when session existed):
 * //   <repoDir>/.git/story-sessions/sess-1.json      ← removed
 * //   <repoDir>/.git/story-sessions/sess-1.model     ← removed (if present)
 * //   <repoDir>/.git/refs/heads/story/<base>-<6hex>  ← removed (only if no other session uses it)
 * //   stdout                                          ← '✓ Cleared session state for sess-1'
 * //                                                     '✓ Deleted shadow branch <name>' (when cleanup actually deleted)
 * //   stderr                                          ← warn lines on partial failures
 * //
 * // Other sessions / HEAD / worktree files / index: unchanged.
 * ```
 */
export async function resetSessionImpl(
	s: ManualCommitStrategy,
	out: NodeJS.WritableStream,
	err: NodeJS.WritableStream,
	sessionId: string,
): Promise<void> {
	let state: SessionState | null;
	try {
		state = await s.loadSessionState(sessionId);
	} catch (e) {
		throw new Error(`failed to load session state: ${(e as Error).message}`, {
			cause: e as Error,
		});
	}
	if (state === null) {
		throw new Error(`session not found: ${sessionId}`);
	}

	try {
		await s.clearSessionState(sessionId);
	} catch (e) {
		throw new Error(`failed to clear session state: ${(e as Error).message}`, {
			cause: e as Error,
		});
	}
	out.write(`✓ Cleared session state for ${sessionId}\n`);

	const repo = await s.getRepo();
	const shadowBranch = shadowBranchNameForCommit(state.baseCommit, state.worktreeId ?? '');

	try {
		await cleanupShadowBranchIfUnused(s, repo.root, shadowBranch, sessionId);
	} catch (e) {
		err.write(
			`Warning: failed to clean up shadow branch ${shadowBranch}: ${(e as Error).message}\n`,
		);
		return;
	}

	// Post-check: cleanupShadowBranchIfUnused may have silently skipped (other
	// session active) or actually deleted. Probe the ref to know which.
	let stillExists = true;
	try {
		await execGit(['show-ref', '--verify', '--quiet', `refs/heads/${shadowBranch}`], {
			cwd: repo.root,
		});
	} catch {
		stillExists = false;
	}
	if (!stillExists) {
		out.write(`✓ Deleted shadow branch ${shadowBranch}\n`);
	}
}

/**
 * Reports whether the `ACCESSIBLE` env var is set (any non-empty value
 * triggers accessibility-friendly TTY rendering).
 *
 * Mirrors Go `manual_commit_reset.go: isAccessibleMode`. Story TS uses
 * `hooks-tty.askConfirmTTY` for confirmation prompts which doesn't yet
 * consume an "accessible" flag — Go's `huh` library has a Go-only
 * accessibility mode. Ported for completeness; Phase 5.5 callers don't
 * branch on the result.
 *
 * @example
 * ```ts
 * // ACCESSIBLE='1'   → isAccessibleMode() === true
 * // ACCESSIBLE=''    → isAccessibleMode() === false
 * // ACCESSIBLE unset → isAccessibleMode() === false
 * ```
 */
export function isAccessibleMode(): boolean {
	const v = process.env.ACCESSIBLE;
	return v !== undefined && v !== '';
}
