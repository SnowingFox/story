/**
 * Orphan scanning + batch-delete helpers for `story clean` / `story doctor`.
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/strategy/cleanup.go`:
 *   - `ListOrphanedSessionStates` (cleanup.go:153)
 *   - `ListAllItems`              (cleanup.go:433)
 *   - `DeleteAllCleanupItems`     (cleanup.go:474)
 *
 * The shadow-branch primitives (`isShadowBranch`, `listShadowBranches`,
 * `deleteShadowBranches`) were shipped in Phase 9.1 and live in
 * [`./shadow-branches.ts`](./shadow-branches.ts) — this module composes them
 * with session-state I/O + the metadata branch scan to provide a full
 * cleanup surface area.
 *
 * @packageDocumentation
 */

import path from 'node:path';
import { match } from 'ts-pattern';
import { shadowBranchNameForCommit } from '@/checkpoint/temporary';
import * as log from '@/log';
import { SESSION_STATE_DIR_NAME } from '@/paths';
import { StateStore } from '@/session/state-store';
import { listCheckpoints } from './metadata-branch';
import { getGitCommonDir } from './repo';
import { deleteShadowBranches, listShadowBranches } from './shadow-branches';

/**
 * Sessions started within this window are considered "too new to clean" —
 * they might not have written their first checkpoint yet. Mirrors Go
 * `cleanup.go:26 sessionGracePeriod = 10 * time.Minute`.
 */
const SESSION_GRACE_PERIOD_MS = 10 * 60 * 1000;

/** Item categories surfaced by {@link listAllItems}. Mirrors Go `CleanupType`. */
export type CleanupType = 'shadow-branch' | 'session-state' | 'checkpoint';

// Re-export the shared shape from `types.ts` so downstream callers can pull
// the type either from `@/strategy/cleanup` (feature-nearest) or
// `@/strategy/types` (package barrel) without diverging.
export type { CleanupItem } from './types';

import type { CleanupItem } from './types';

/**
 * Grouped outcome of {@link deleteAllCleanupItems}. Each list is
 * populated by its corresponding delete codepath; failures are routed
 * to `failed*` rather than aborting the batch.
 */
export interface CleanupResult {
	shadowBranches: string[];
	sessionStates: string[];
	checkpoints: string[];
	failedBranches: string[];
	failedStates: string[];
	failedCheckpoints: string[];
}

/** Context passed to every helper so tests can point at a throwaway repo. */
export interface CleanupCtx {
	repoRoot: string;
}

/**
 * Construct a one-shot {@link StateStore} scoped to `repoRoot`'s git
 * common dir. Matches the convention in
 * [`./session-state.ts: makeStateStore`](./session-state.ts) — the
 * strategy package intentionally does not cache `StateStore` instances
 * since cleanup code paths run once per CLI invocation.
 *
 * @internal
 */
async function makeStateStore(repoRoot: string): Promise<StateStore> {
	const commonDir = await getGitCommonDir(repoRoot);
	return new StateStore(path.join(commonDir, SESSION_STATE_DIR_NAME));
}

/**
 * List session states that look abandoned — no checkpoints on the v1
 * metadata branch AND no matching shadow branch. Subject to a 10-minute
 * grace period since `startedAt` (fresh sessions that haven't written
 * their first checkpoint yet are not orphans).
 *
 * Mirrors Go `cleanup.go: ListOrphanedSessionStates` (153-222).
 *
 * @example
 * await listOrphanedSessionStates({ repoRoot: '/repo' });
 * // returns: [{ type: 'session-state', id: 'sess-…', reason: 'no checkpoints or shadow branch found' }]
 *
 * // Side effects: none — reads `.git/story-sessions/*.json` + walks
 * // `story/checkpoints/v1` + `git for-each-ref refs/heads/story/`.
 */
export async function listOrphanedSessionStates(ctx: CleanupCtx): Promise<CleanupItem[]> {
	const store = await makeStateStore(ctx.repoRoot);
	const states = await store.list();
	if (states.length === 0) {
		return [];
	}

	// Best-effort: metadata branch may not exist on a fresh repo.
	const sessionsWithCheckpoints = new Set<string>();
	try {
		const checkpoints = await listCheckpoints(ctx.repoRoot);
		for (const cp of checkpoints) {
			sessionsWithCheckpoints.add(cp.sessionId);
		}
	} catch (err) {
		log.debug(
			{ component: 'cleanup' },
			'listCheckpoints failed; treating repo as no-metadata-branch',
			{ error: err instanceof Error ? err.message : String(err) },
		);
	}

	const shadowBranchSet = new Set<string>(
		await listShadowBranches({ repoRoot: ctx.repoRoot }).catch(() => []),
	);

	const now = Date.now();
	const orphaned: CleanupItem[] = [];
	for (const state of states) {
		const startedAt = new Date(state.startedAt).getTime();
		if (!Number.isNaN(startedAt) && now - startedAt < SESSION_GRACE_PERIOD_MS) {
			continue;
		}
		const hasCheckpoints = sessionsWithCheckpoints.has(state.sessionId);
		const expectedBranch = shadowBranchNameForCommit(state.baseCommit, state.worktreeId ?? '');
		const hasShadowBranch = shadowBranchSet.has(expectedBranch);
		if (!hasCheckpoints && !hasShadowBranch) {
			orphaned.push({
				type: 'session-state',
				id: state.sessionId,
				reason: 'no checkpoints or shadow branch found',
			});
		}
	}
	return orphaned;
}

/**
 * Enumerate every cleanable Story item in the repo — **all** shadow
 * branches + **all** session states, regardless of orphan status. Used
 * by `story clean --all` for the whole-repo sweep path.
 *
 * Mirrors Go `cleanup.go: ListAllItems` (433-470).
 *
 * @example
 * await listAllItems({ repoRoot: '/repo' });
 * // returns: [
 * //   { type: 'shadow-branch', id: 'story/abc1234-e3b0c4', reason: 'clean all' },
 * //   { type: 'session-state', id: 'sess-abc123',          reason: 'clean all' },
 * // ]
 *
 * // Side effects: read-only — lists shadow refs + session state files.
 */
export async function listAllItems(ctx: CleanupCtx): Promise<CleanupItem[]> {
	const items: CleanupItem[] = [];

	const branches = await listShadowBranches({ repoRoot: ctx.repoRoot });
	for (const branch of branches) {
		items.push({ type: 'shadow-branch', id: branch, reason: 'clean all' });
	}

	const store = await makeStateStore(ctx.repoRoot);
	const states = await store.list();
	for (const state of states) {
		items.push({ type: 'session-state', id: state.sessionId, reason: 'clean all' });
	}

	return items;
}

/**
 * Delete a batch of cleanup items grouped by {@link CleanupType}.
 * Shadow branches go through [`deleteShadowBranches`](./shadow-branches.ts)
 * (idempotent — missing branches count as deleted). Session states go
 * through `StateStore.clear(id)` (also idempotent). `'checkpoint'`-type
 * items are recorded but not yet deleted — Story defers committed
 * checkpoint pruning to [`metadata-reconcile.ts`](./metadata-reconcile.ts)
 * so both `story doctor` + `story clean --all` share one codepath.
 *
 * Mirrors Go `cleanup.go: DeleteAllCleanupItems` (474-611). Story diverges
 * by not implementing DeleteOrphanedCheckpoints here — that whole
 * subsystem lives in metadata-reconcile, reached through `story doctor`.
 *
 * @example
 * await deleteAllCleanupItems({ repoRoot: '/repo' }, [
 *   { type: 'shadow-branch', id: 'story/abc1234-e3b0c4', reason: '…' },
 *   { type: 'session-state', id: 'sess-abc123',          reason: '…' },
 * ]);
 * // returns: {
 * //   shadowBranches:    ['story/abc1234-e3b0c4'],
 * //   sessionStates:     ['sess-abc123'],
 * //   checkpoints:       [],
 * //   failedBranches:    [],
 * //   failedStates:      [],
 * //   failedCheckpoints: [],
 * // }
 *
 * // Side effects per type:
 * //   shadow-branch → <repoDir>/.git/refs/heads/story/<name>   ← unlinked
 * //   session-state → <gitCommonDir>/story-sessions/<id>.json  ← removed
 * //                   + <id>.* sidecars (model / etc.)
 * //   checkpoint    → no-op (placeholder — metadata-reconcile owns this)
 * //
 * // HEAD / worktree / index / metadata branches: unchanged.
 */
export async function deleteAllCleanupItems(
	ctx: CleanupCtx,
	items: CleanupItem[],
): Promise<CleanupResult> {
	const result: CleanupResult = {
		shadowBranches: [],
		sessionStates: [],
		checkpoints: [],
		failedBranches: [],
		failedStates: [],
		failedCheckpoints: [],
	};
	if (items.length === 0) {
		return result;
	}

	const branches: string[] = [];
	const states: string[] = [];
	const checkpoints: string[] = [];
	for (const item of items) {
		match(item.type)
			.with('shadow-branch', () => {
				branches.push(item.id);
			})
			.with('session-state', () => {
				states.push(item.id);
			})
			.with('checkpoint', () => {
				checkpoints.push(item.id);
			})
			.exhaustive();
	}

	if (branches.length > 0) {
		const { deleted, failed } = await deleteShadowBranches({ repoRoot: ctx.repoRoot }, branches);
		result.shadowBranches = deleted;
		result.failedBranches = failed;
		for (const id of deleted) {
			log.info({ component: 'cleanup' }, 'deleted shadow branch', {
				type: 'shadow-branch',
				id,
			});
		}
		for (const id of failed) {
			log.warn({ component: 'cleanup' }, 'failed to delete shadow branch', {
				type: 'shadow-branch',
				id,
			});
		}
	}

	if (states.length > 0) {
		const store = await makeStateStore(ctx.repoRoot);
		for (const id of states) {
			try {
				await store.clear(id);
				result.sessionStates.push(id);
				log.info({ component: 'cleanup' }, 'deleted session state', {
					type: 'session-state',
					id,
				});
			} catch (err) {
				result.failedStates.push(id);
				log.warn({ component: 'cleanup' }, 'failed to delete session state', {
					type: 'session-state',
					id,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
	}

	if (checkpoints.length > 0) {
		// Story defers committed-checkpoint pruning to `metadata-reconcile.ts`
		// (Phase 5.6 ship). Until that pipe is wired, surface these as
		// successful so callers don't mark the whole batch as failed, but
		// keep the list so doctor can observe and route accordingly.
		result.checkpoints = [...checkpoints];
		for (const id of checkpoints) {
			log.debug({ component: 'cleanup' }, 'checkpoint cleanup deferred to metadata-reconcile', {
				type: 'checkpoint',
				id,
			});
		}
	}

	return result;
}
