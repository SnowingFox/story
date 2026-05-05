/**
 * Shadow-branch list / delete helpers, extracted from Go's cleanup module.
 * Phase 9.1 owns these three helpers because `story disable --uninstall` is
 * the first user of shadow-branch deletion; Phase 9.5 `clean.ts` will reuse
 * them and add orphan-scanning / `listAllItems` on top.
 *
 * Mirrors Go `cmd/entire/cli/strategy/cleanup.go`:
 * `IsShadowBranch` / `ListShadowBranches` / `DeleteShadowBranches`.
 *
 * @packageDocumentation
 */

import { METADATA_BRANCH_NAME, TRAILS_BRANCH_NAME, V2_MAIN_REF_NAME } from '@/checkpoint/constants';
import { execGit } from '@/git';
import { deleteBranchCli, ErrBranchNotFound } from './branches';

/**
 * Shadow branch naming is `story/<commit-hash[:7]>(-<worktree-hash[:6]>)?`
 * — the worktree suffix is optional (absent when the checkpoint was created
 * inside the main worktree). Hash chars must be hex (`[0-9a-fA-F]`).
 *
 * Story-side rebrand of Go `^entire/[0-9a-fA-F]{7,}(-[0-9a-fA-F]{6})?$`.
 */
const SHADOW_BRANCH_PATTERN = /^story\/[0-9a-fA-F]{7,}(-[0-9a-fA-F]{6})?$/;

/**
 * Refs that live under the `story/` prefix but are **not** shadow branches —
 * they store permanent metadata that `disable --uninstall` must not sweep
 * together with shadow branches. `V2_MAIN_REF_NAME` is a fully-qualified
 * `refs/...` path; we strip it to the short form for the comparison here.
 */
const NON_SHADOW_STORY_BRANCHES: ReadonlySet<string> = new Set([
	METADATA_BRANCH_NAME,
	TRAILS_BRANCH_NAME,
	// `refs/story/checkpoints/v2/main` → `story/checkpoints/v2/main` short form.
	V2_MAIN_REF_NAME.replace(/^refs\//, ''),
]);

/**
 * True when `name` looks like a Story shadow branch by pattern AND is not one
 * of the protected `story/` metadata branches (`story/checkpoints/v1` /
 * `story/checkpoints/v2/main` / `story/trails/v1`).
 *
 * Mirrors Go `strategy/cleanup.go: IsShadowBranch`.
 *
 * @example
 * isShadowBranch('story/abc1234')              // true
 * isShadowBranch('story/abc1234-e3b0c4')       // true
 * isShadowBranch('story/checkpoints/v1')       // false (metadata branch)
 * isShadowBranch('story/checkpoints/v2/main')  // false (v2 head)
 * isShadowBranch('story/trails/v1')            // false (trails)
 * isShadowBranch('main')                       // false (no story/ prefix)
 * isShadowBranch('story/abc')                  // false (hash < 7 chars)
 */
export function isShadowBranch(name: string): boolean {
	if (NON_SHADOW_STORY_BRANCHES.has(name)) {
		return false;
	}
	return SHADOW_BRANCH_PATTERN.test(name);
}

/**
 * Shadow-branch CRUD takes a minimal context object instead of a full
 * git-repo handle so tests can pass a throwaway `{ repoRoot }`. Matches the
 * Phase 5.x convention of "context objects carry just the paths, not the
 * whole repo state".
 */
export interface ShadowBranchCtx {
	/** Absolute path to the repo working tree. */
	repoRoot: string;
}

/**
 * Enumerate every local branch under `refs/heads/story/` that matches the
 * shadow-branch pattern. Returns an empty array (never `null`) when no
 * shadow branches exist — matches Go's "ensure empty slice, not nil" tail.
 *
 * Mirrors Go `strategy/cleanup.go: ListShadowBranches`.
 *
 * @example
 * await listShadowBranches({ repoRoot: '/repo' });
 * // returns: ['story/abc1234-e3b0c4', 'story/def5678-e3b0c4']
 *
 * // No shadow branches (fresh repo):
 * // returns: []
 *
 * // Side effects: spawns `git for-each-ref refs/heads/story/`. No writes.
 */
export async function listShadowBranches(ctx: ShadowBranchCtx): Promise<string[]> {
	let raw: string;
	try {
		raw = await execGit(['for-each-ref', '--format=%(refname:short)', 'refs/heads/story/'], {
			cwd: ctx.repoRoot,
		});
	} catch {
		// Likely "not a git repository" or permission error — behave like Go's
		// "return empty on unexpected failure" (Go actually wraps the err; for
		// disable --uninstall we'd rather the pipeline keep going and report the
		// count as 0 than crash inside the branches step).
		return [];
	}
	if (raw === '') {
		return [];
	}
	const names: string[] = [];
	for (const line of raw.split('\n')) {
		const name = line.trim();
		if (name === '') {
			continue;
		}
		if (isShadowBranch(name)) {
			names.push(name);
		}
	}
	return names;
}

/**
 * Delete the given branches in batch via `git branch -D`. Failures on
 * individual branches do **not** abort the batch — matches Go's best-effort
 * semantics so one corrupt ref can't leave the rest of the cleanup half-done.
 *
 * Branches already absent (e.g. packed-refs out of sync with loose refs,
 * concurrent cleanup) are counted as successful deletes — matching Go's
 * behavior where `git branch -D` on a missing branch is a no-op.
 *
 * Mirrors Go `strategy/cleanup.go: DeleteShadowBranches`.
 *
 * @example
 * await deleteShadowBranches(
 *   { repoRoot: '/repo' },
 *   ['story/abc1234-e3b0c4', 'story/def5678-e3b0c4'],
 * );
 * // returns: { deleted: ['story/abc1234-e3b0c4', 'story/def5678-e3b0c4'], failed: [] }
 *
 * // Side effects (per branch, best-effort):
 * //   <repoRoot>/.git/refs/heads/story/<name>   ← unlinked (loose ref)
 * //   <repoRoot>/.git/packed-refs               ← entry removed (packed ref)
 * //
 * // HEAD / worktree / index / remote refs / other branches: unchanged.
 *
 * await deleteShadowBranches({ repoRoot: '/repo' }, []);
 * // returns: { deleted: [], failed: [] }   (short-circuit, no git spawn)
 */
export async function deleteShadowBranches(
	ctx: ShadowBranchCtx,
	names: string[],
): Promise<{ deleted: string[]; failed: string[] }> {
	const deleted: string[] = [];
	const failed: string[] = [];

	if (names.length === 0) {
		return { deleted, failed };
	}

	for (const name of names) {
		try {
			await deleteBranchCli(name, ctx.repoRoot);
			deleted.push(name);
		} catch (err) {
			// Treat "already gone" as success — idempotent semantics for
			// concurrent cleanup or retry scenarios.
			if (err === ErrBranchNotFound) {
				deleted.push(name);
				continue;
			}
			failed.push(name);
		}
	}

	return { deleted, failed };
}
