/**
 * Temp-ref promotion + safe-advance helpers for fetch flows.
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/strategy/common.go:104-192`
 * (`PromoteTmpRefSafely` / `SafelyAdvanceLocalRef` / `IsAncestorOf` /
 * `MaxCommitTraversalDepth`).
 *
 * Why this exists separately from Phase 5.6's push-side ref dance:
 * Phase 5.6 (`push-v2.ts` / `push-common.ts`) has ad-hoc local tmp-ref
 * handling via `tryRemoveRef` + `standardTreeMerge`, which is tuned for
 * pushing (one tmp ref per branch, caller owns fetch spec). The fetch
 * side (foundation #21) wants the **Go-aligned** pattern: fetch refspec
 * lands the incoming hash on a shared tmp ref, then we atomically
 * promote to the final ref via `SafelyAdvanceLocalRef` so
 * locally-ahead work isn't rewound. These helpers will also be reused
 * by Phase 9.5 doctor.
 *
 * Naming note: Go uses `refs/entire-fetch-tmp/`; Story uses
 * `refs/story-fetch-tmp/` (documented in
 * [`references/story-vs-entire.md`](docs/ts-rewrite/impl/references/story-vs-entire.md)).
 *
 * @packageDocumentation
 */

import fsCallback from 'node:fs';
import git from 'isomorphic-git';

/** Story counterpart of Go `FetchTmpRefPrefix` (Go: `refs/entire-fetch-tmp/`). */
export const FETCH_TMP_REF_PREFIX = 'refs/story-fetch-tmp/';

/** Staging ref for fetches targeting {@link V2_MAIN_REF_NAME}. Mirrors Go `V2MainFetchTmpRef`. */
export const V2_MAIN_FETCH_TMP_REF = `${FETCH_TMP_REF_PREFIX}v2-main`;

/** Max commits walked by {@link isAncestorOf}. Mirrors Go `MaxCommitTraversalDepth`. */
export const MAX_COMMIT_TRAVERSAL_DEPTH = 1000;

/**
 * Return `true` when `commit` is reachable from `target` by walking parent
 * links (or when `commit === target`). Bounded at
 * {@link MAX_COMMIT_TRAVERSAL_DEPTH} commits to avoid runaway traversal.
 *
 * Mirrors Go `strategy/common.go: IsAncestorOf`. Silently returns `false`
 * on any git read error (missing commit, unreadable ref).
 *
 * @example
 * ```ts
 * await isAncestorOf(repo, 'abc1234', 'def5678');
 * // returns: true   (abc1234 reachable from def5678 via parents)
 * // returns: false  (diverged / unreachable / missing commit)
 *
 * // Side effects: read-only — walks up to 1000 commits via git.log.
 * ```
 */
export async function isAncestorOf(
	repoDir: string,
	commit: string,
	target: string,
): Promise<boolean> {
	if (commit === target) {
		return true;
	}
	try {
		const entries = await git.log({
			fs: fsCallback,
			dir: repoDir,
			ref: target,
			depth: MAX_COMMIT_TRAVERSAL_DEPTH,
		});
		for (const e of entries) {
			if (e.oid === commit) {
				return true;
			}
		}
		return false;
	} catch {
		return false;
	}
}

/**
 * Update `localRefName` to `targetHash`, unless the existing local ref is
 * already equal to or ahead of `targetHash`. "Ahead" means `targetHash`
 * is an ancestor of the existing ref — in that case we must NOT rewind
 * locally-ahead work, so leave the ref alone.
 *
 * Other cases (local missing, local behind, diverged history) all result
 * in the ref being set to `targetHash`.
 *
 * Mirrors Go `strategy/common.go: SafelyAdvanceLocalRef`.
 *
 * @example
 * ```ts
 * await safelyAdvanceLocalRef(repo, 'refs/heads/story/checkpoints/v1', 'abc1234');
 *
 * // Side effects (4 cases):
 * //   1. ref missing         → ref created at abc1234
 * //   2. ref === abc1234     → no-op (same hash)
 * //   3. ref behind abc1234  → ref fast-forwarded to abc1234
 * //   4. ref ahead of abc1234 → no-op (don't rewind local)
 * //   5. diverged            → ref overwritten to abc1234
 * //
 * // Unchanged: worktree, index, HEAD.
 * ```
 */
export async function safelyAdvanceLocalRef(
	repoDir: string,
	localRefName: string,
	targetHash: string,
): Promise<void> {
	let currentLocal: string | null = null;
	try {
		currentLocal = await git.resolveRef({ fs: fsCallback, dir: repoDir, ref: localRefName });
	} catch {
		currentLocal = null;
	}
	if (currentLocal !== null) {
		if (currentLocal === targetHash) {
			return;
		}
		// Local is "ahead" iff target is an ancestor of local. In that case
		// leave the local ref alone to avoid rewinding locally-ahead work.
		if (await isAncestorOf(repoDir, targetHash, currentLocal)) {
			return;
		}
	}
	// Missing / behind / diverged: set to target.
	await git.writeRef({
		fs: fsCallback,
		dir: repoDir,
		ref: localRefName,
		value: targetHash,
		force: true,
	});
}

/**
 * Promote a just-fetched tmp ref to a final destination ref, then delete
 * the tmp. Used after a fetch lands on a staging ref so local
 * write-ahead isn't rewound.
 *
 * Mirrors Go `strategy/common.go: PromoteTmpRefSafely`. Cleanup of the
 * tmp ref is best-effort (mirrors Go's `defer` semantics — happens even
 * on advance failure).
 *
 * @example
 * ```ts
 * // typical call site (after `git fetch ... +<src>:<V2_MAIN_FETCH_TMP_REF>`):
 * await promoteTmpRefSafely(
 *   repoDir,
 *   V2_MAIN_FETCH_TMP_REF,
 *   V2_MAIN_REF_NAME,
 *   'v2 /main',
 * );
 *
 * // Side effects:
 * //   refs/story/checkpoints/v2/main  ← advanced to tmp ref's hash
 * //   refs/story-fetch-tmp/v2-main    ← deleted (best-effort)
 * //
 * // Unchanged: worktree, other refs, HEAD.
 * //
 * // Throws when:
 * //   - tmp ref doesn't exist (fetch never landed)
 * //   - safelyAdvanceLocalRef fails (in that case tmp ref is STILL deleted)
 * ```
 */
export async function promoteTmpRefSafely(
	repoDir: string,
	tmpRefName: string,
	destRefName: string,
	label: string,
): Promise<void> {
	let tmpHash: string;
	try {
		tmpHash = await git.resolveRef({ fs: fsCallback, dir: repoDir, ref: tmpRefName });
	} catch (e) {
		throw new Error(
			`${label} not found after fetch (tmp ref ${tmpRefName} missing): ${(e as Error).message}`,
			{ cause: e as Error },
		);
	}

	let advanceErr: unknown = null;
	try {
		await safelyAdvanceLocalRef(repoDir, destRefName, tmpHash);
	} catch (e) {
		advanceErr = e;
	}

	// Best-effort tmp-ref cleanup — mirrors Go `defer`.
	try {
		await git.deleteRef({ fs: fsCallback, dir: repoDir, ref: tmpRefName });
	} catch {
		// ignore
	}

	if (advanceErr !== null) {
		throw new Error(`failed to advance local ${label}: ${(advanceErr as Error).message}`, {
			cause: advanceErr as Error,
		});
	}
}
