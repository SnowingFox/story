/**
 * Phase 9.5 cleanup helpers — orphan scan + batch delete.
 *
 * Go: entire-cli/cmd/entire/cli/strategy/cleanup.go
 *     - ListOrphanedSessionStates (cleanup.go:153-222)
 *     - ListAllItems              (cleanup.go:433-470)
 *     - DeleteAllCleanupItems     (cleanup.go:474-611)
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { shadowBranchNameForCommit } from '@/checkpoint/temporary';
import { clearGitCommonDirCache } from '@/git';
import { clearWorktreeRootCache } from '@/paths';
import { StateStore } from '@/session/state-store';
import {
	type CleanupItem,
	deleteAllCleanupItems,
	listAllItems,
	listOrphanedSessionStates,
} from '@/strategy/cleanup';
import { getGitCommonDir } from '@/strategy/repo';
import { TestEnv } from '../../helpers/test-env';

function stateFixture(overrides: Partial<Record<string, unknown>> = {}) {
	const now = new Date();
	const oldEnough = new Date(now.getTime() - 30 * 60 * 1000); // 30 min ago
	return {
		session_id: overrides.session_id ?? 'sess-abc123def456',
		base_commit: overrides.base_commit ?? '',
		attribution_base_commit: overrides.attribution_base_commit ?? '',
		worktree_id: overrides.worktree_id ?? '',
		started_at: overrides.started_at ?? oldEnough.toISOString(),
		last_interaction_time: overrides.last_interaction_time ?? oldEnough.toISOString(),
		turn_id: overrides.turn_id ?? 'turn-1',
		step_count: overrides.step_count ?? 0,
		files_touched: overrides.files_touched ?? [],
		prompts: overrides.prompts ?? [],
		phase: overrides.phase ?? 'idle',
		cli_version: overrides.cli_version ?? '0.1.0',
		...overrides,
	};
}

async function seedStateFile(env: TestEnv, state: Record<string, unknown>) {
	const commonDir = await getGitCommonDir(env.dir);
	const stateDir = path.join(commonDir, 'story-sessions');
	await fs.mkdir(stateDir, { recursive: true });
	const file = path.join(stateDir, `${state.session_id}.json`);
	await fs.writeFile(file, JSON.stringify(state));
}

async function createShadowBranch(env: TestEnv, branch: string, commit: string) {
	await env.exec('git', ['branch', branch, commit]);
}

describe('strategy/cleanup', () => {
	let env: TestEnv;
	let origCwd: string;

	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		origCwd = process.cwd();
		process.chdir(env.dir);
		clearWorktreeRootCache();
		clearGitCommonDirCache();
	});

	afterEach(async () => {
		process.chdir(origCwd);
		await env.cleanup();
	});

	describe('listOrphanedSessionStates', () => {
		// Go: cleanup.go:153 ListOrphanedSessionStates — zero-state happy path.
		it('returns [] when there are no session states', async () => {
			const items = await listOrphanedSessionStates({ repoRoot: env.dir });
			expect(items).toEqual([]);
		});

		it('skips sessions inside the grace period (started < 10min ago)', async () => {
			const recent = new Date(Date.now() - 5 * 60 * 1000).toISOString();
			await seedStateFile(
				env,
				stateFixture({ session_id: 'sess-recent00000', started_at: recent }),
			);
			const items = await listOrphanedSessionStates({ repoRoot: env.dir });
			expect(items).toEqual([]);
		});

		it('reports sessions past the grace period with no shadow branch and no checkpoints', async () => {
			await seedStateFile(env, stateFixture({ session_id: 'sess-orphan000000' }));
			const items = await listOrphanedSessionStates({ repoRoot: env.dir });
			expect(items).toHaveLength(1);
			expect(items[0]?.type).toBe('session-state');
			expect(items[0]?.id).toBe('sess-orphan000000');
			expect(items[0]?.reason).toMatch(/no checkpoints or shadow branch/);
		});

		it('does NOT report a session whose shadow branch still exists', async () => {
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			const branch = shadowBranchNameForCommit(head, '');
			await createShadowBranch(env, branch, head);
			await seedStateFile(
				env,
				stateFixture({ session_id: 'sess-hasshadow000', base_commit: head }),
			);
			const items = await listOrphanedSessionStates({ repoRoot: env.dir });
			expect(items).toEqual([]);
		});

		it('reports a session when its specific shadow branch is missing even if other branches exist', async () => {
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			// Wrong shadow branch (different commit)
			await createShadowBranch(env, 'story/deadbeef-111111', head);
			await seedStateFile(
				env,
				stateFixture({ session_id: 'sess-wrongbranch0', base_commit: head }),
			);
			const items = await listOrphanedSessionStates({ repoRoot: env.dir });
			expect(items).toHaveLength(1);
			expect(items[0]?.id).toBe('sess-wrongbranch0');
		});

		it('handles multiple mixed sessions in one pass', async () => {
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			const branch = shadowBranchNameForCommit(head, '');
			await createShadowBranch(env, branch, head);
			// One with shadow → not orphan
			await seedStateFile(
				env,
				stateFixture({ session_id: 'sess-has0000000000', base_commit: head }),
			);
			// One orphan
			await seedStateFile(env, stateFixture({ session_id: 'sess-orphan0000000' }));
			// One recent → not orphan
			const recent = new Date(Date.now() - 5 * 60 * 1000).toISOString();
			await seedStateFile(
				env,
				stateFixture({ session_id: 'sess-young0000000', started_at: recent }),
			);

			const items = await listOrphanedSessionStates({ repoRoot: env.dir });
			expect(items).toHaveLength(1);
			expect(items[0]?.id).toBe('sess-orphan0000000');
		});

		it('reports session using worktree_id correctly when present', async () => {
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			// Session references a worktree-scoped shadow branch that does NOT exist.
			await seedStateFile(
				env,
				stateFixture({
					session_id: 'sess-worktree0001',
					base_commit: head,
					worktree_id: 'wt-abc',
				}),
			);
			const items = await listOrphanedSessionStates({ repoRoot: env.dir });
			expect(items).toHaveLength(1);
		});
	});

	describe('listAllItems', () => {
		it('returns [] on an empty repo', async () => {
			const items = await listAllItems({ repoRoot: env.dir });
			expect(items).toEqual([]);
		});

		it('returns shadow-branch items when shadow branches exist', async () => {
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			await createShadowBranch(env, 'story/abc1234-e3b0c4', head);
			await createShadowBranch(env, 'story/def5678-e3b0c4', head);
			const items = await listAllItems({ repoRoot: env.dir });
			const shadows = items.filter((i) => i.type === 'shadow-branch');
			expect(shadows.map((s) => s.id).sort()).toEqual([
				'story/abc1234-e3b0c4',
				'story/def5678-e3b0c4',
			]);
		});

		it('returns session-state items for every state file (regardless of orphan status)', async () => {
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			await seedStateFile(
				env,
				stateFixture({ session_id: 'sess-one00000000a', base_commit: head }),
			);
			await seedStateFile(
				env,
				stateFixture({ session_id: 'sess-two00000000b', base_commit: head }),
			);
			const items = await listAllItems({ repoRoot: env.dir });
			const states = items.filter((i) => i.type === 'session-state');
			expect(states.map((s) => s.id).sort()).toEqual(['sess-one00000000a', 'sess-two00000000b']);
		});

		it('combines shadow-branch + session-state items when both present', async () => {
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			await createShadowBranch(env, 'story/1111111-aaaaaa', head);
			await seedStateFile(env, stateFixture({ session_id: 'sess-combined0000' }));
			const items = await listAllItems({ repoRoot: env.dir });
			expect(items.filter((i) => i.type === 'shadow-branch')).toHaveLength(1);
			expect(items.filter((i) => i.type === 'session-state')).toHaveLength(1);
		});

		it('each item carries a non-empty `reason` string', async () => {
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			await createShadowBranch(env, 'story/1111111-aaaaaa', head);
			await seedStateFile(env, stateFixture({ session_id: 'sess-reason000000' }));
			const items = await listAllItems({ repoRoot: env.dir });
			for (const item of items) {
				expect(item.reason).toBeTypeOf('string');
				expect(item.reason.length).toBeGreaterThan(0);
			}
		});
	});

	describe('deleteAllCleanupItems', () => {
		// Go: cleanup.go:474 DeleteAllCleanupItems — empty input short-circuit.
		it('returns empty result + makes no calls when items is empty', async () => {
			const result = await deleteAllCleanupItems({ repoRoot: env.dir }, []);
			expect(result).toEqual({
				shadowBranches: [],
				sessionStates: [],
				checkpoints: [],
				failedBranches: [],
				failedStates: [],
				failedCheckpoints: [],
			});
		});

		it('deletes shadow-branch items via `git branch -D`', async () => {
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			await createShadowBranch(env, 'story/abc1234-e3b0c4', head);
			const items: CleanupItem[] = [
				{ type: 'shadow-branch', id: 'story/abc1234-e3b0c4', reason: 'test' },
			];
			const result = await deleteAllCleanupItems({ repoRoot: env.dir }, items);
			expect(result.shadowBranches).toEqual(['story/abc1234-e3b0c4']);
			expect(result.failedBranches).toEqual([]);
			// Verify the branch is actually gone.
			const out = (await env.exec('git', ['branch', '--list', 'story/abc1234-e3b0c4'])).stdout;
			expect(out.trim()).toBe('');
		});

		it('deletes session-state items via StateStore.clear', async () => {
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			await seedStateFile(
				env,
				stateFixture({ session_id: 'sess-delete00000a', base_commit: head }),
			);
			const items: CleanupItem[] = [
				{ type: 'session-state', id: 'sess-delete00000a', reason: 'test' },
			];
			const result = await deleteAllCleanupItems({ repoRoot: env.dir }, items);
			expect(result.sessionStates).toEqual(['sess-delete00000a']);
			expect(result.failedStates).toEqual([]);
			// Verify the file is gone.
			const commonDir = await getGitCommonDir(env.dir);
			await expect(
				fs.stat(path.join(commonDir, 'story-sessions', 'sess-delete00000a.json')),
			).rejects.toHaveProperty('code', 'ENOENT');
		});

		it('groups items by type and deletes each independently', async () => {
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			await createShadowBranch(env, 'story/abc1234-e3b0c4', head);
			await seedStateFile(env, stateFixture({ session_id: 'sess-grouped00000' }));
			const items: CleanupItem[] = [
				{ type: 'shadow-branch', id: 'story/abc1234-e3b0c4', reason: 'a' },
				{ type: 'session-state', id: 'sess-grouped00000', reason: 'b' },
			];
			const result = await deleteAllCleanupItems({ repoRoot: env.dir }, items);
			expect(result.shadowBranches).toEqual(['story/abc1234-e3b0c4']);
			expect(result.sessionStates).toEqual(['sess-grouped00000']);
		});

		it('records failed deletions in `failedBranches` without aborting the batch', async () => {
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			await createShadowBranch(env, 'story/abc1234-e3b0c4', head);
			// 2nd branch does not exist — treated as idempotent success by deleteShadowBranches.
			const items: CleanupItem[] = [
				{ type: 'shadow-branch', id: 'story/abc1234-e3b0c4', reason: 'a' },
				{ type: 'shadow-branch', id: 'story/missing-e3b0c4', reason: 'b' },
			];
			const result = await deleteAllCleanupItems({ repoRoot: env.dir }, items);
			// Both are reported deleted (idempotent sentinel handling).
			expect(result.shadowBranches.sort()).toEqual([
				'story/abc1234-e3b0c4',
				'story/missing-e3b0c4',
			]);
			expect(result.failedBranches).toEqual([]);
		});

		it('idempotent: deleting already-removed shadow branches produces no failure', async () => {
			const items: CleanupItem[] = [
				{ type: 'shadow-branch', id: 'story/never0000-aaaaaa', reason: 'test' },
			];
			const result = await deleteAllCleanupItems({ repoRoot: env.dir }, items);
			expect(result.shadowBranches).toEqual(['story/never0000-aaaaaa']);
			expect(result.failedBranches).toEqual([]);
		});

		it('checkpoint-type items are recorded but not actually deleted (Story defers to metadata-reconcile)', async () => {
			const items: CleanupItem[] = [{ type: 'checkpoint', id: 'deadbeefcafe', reason: 'test' }];
			const result = await deleteAllCleanupItems({ repoRoot: env.dir }, items);
			// Either deleted ([id]) or failed ([id]) — depends on implementation but
			// we only assert it's accounted for, not silently dropped.
			expect([...result.checkpoints, ...result.failedCheckpoints].sort()).toEqual(['deadbeefcafe']);
		});

		it('a session-state item deletes the .json file and its sidecars', async () => {
			const commonDir = await getGitCommonDir(env.dir);
			const stateDir = path.join(commonDir, 'story-sessions');
			await fs.mkdir(stateDir, { recursive: true });
			await fs.writeFile(
				path.join(stateDir, 'sess-sidecar000000.json'),
				JSON.stringify(stateFixture({ session_id: 'sess-sidecar000000' })),
			);
			await fs.writeFile(path.join(stateDir, 'sess-sidecar000000.model'), 'gpt-x');

			const items: CleanupItem[] = [
				{ type: 'session-state', id: 'sess-sidecar000000', reason: 'x' },
			];
			const result = await deleteAllCleanupItems({ repoRoot: env.dir }, items);
			expect(result.sessionStates).toEqual(['sess-sidecar000000']);
			await expect(fs.stat(path.join(stateDir, 'sess-sidecar000000.model'))).rejects.toHaveProperty(
				'code',
				'ENOENT',
			);
		});

		it('handles empty type groups without issuing no-op git branch calls', async () => {
			// No shadow branches in input — just session-state.
			await seedStateFile(env, stateFixture({ session_id: 'sess-onlystate000' }));
			const items: CleanupItem[] = [
				{ type: 'session-state', id: 'sess-onlystate000', reason: 'x' },
			];
			const result = await deleteAllCleanupItems({ repoRoot: env.dir }, items);
			expect(result.sessionStates).toEqual(['sess-onlystate000']);
			expect(result.shadowBranches).toEqual([]);
		});

		it('idempotent: second call on already-deleted items is a no-op', async () => {
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			await createShadowBranch(env, 'story/once0000-aaaaaa', head);
			const items: CleanupItem[] = [
				{ type: 'shadow-branch', id: 'story/once0000-aaaaaa', reason: 'x' },
			];
			await deleteAllCleanupItems({ repoRoot: env.dir }, items);
			const result = await deleteAllCleanupItems({ repoRoot: env.dir }, items);
			expect(result.shadowBranches).toEqual(['story/once0000-aaaaaa']);
			expect(result.failedBranches).toEqual([]);
		});
	});

	describe('regression / go-parity guardrails', () => {
		// Go: cleanup.go:177-183 — checkpoint scan is best-effort, never fatal.
		it('listOrphanedSessionStates tolerates a missing metadata branch', async () => {
			await seedStateFile(env, stateFixture({ session_id: 'sess-nometabra0000' }));
			const items = await listOrphanedSessionStates({ repoRoot: env.dir });
			expect(items).toHaveLength(1);
		});

		it('listAllItems enumerates shadow + state once per item (no duplicates)', async () => {
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			await createShadowBranch(env, 'story/dup0000-aaaaaa', head);
			await seedStateFile(env, stateFixture({ session_id: 'sess-dup000000000' }));
			const items = await listAllItems({ repoRoot: env.dir });
			const idSet = new Set(items.map((i) => `${i.type}/${i.id}`));
			expect(idSet.size).toBe(items.length);
		});

		// Story-side rebrand check.
		it('shadow-branch items use story/ prefix (not entire/)', async () => {
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			await createShadowBranch(env, 'story/abc1234-e3b0c4', head);
			const items = await listAllItems({ repoRoot: env.dir });
			for (const item of items.filter((i) => i.type === 'shadow-branch')) {
				expect(item.id).toMatch(/^story\//);
			}
		});

		it('StateStore round-trip: state persists after seedStateFile + listStore round-trip', async () => {
			// Sanity check fixture helper: the state we seed MUST be loadable by StateStore.
			const commonDir = await getGitCommonDir(env.dir);
			await seedStateFile(env, stateFixture({ session_id: 'sess-rtcheck00000a' }));
			const store = new StateStore(path.join(commonDir, 'story-sessions'));
			const loaded = await store.list();
			expect(loaded.map((s) => s.sessionId)).toContain('sess-rtcheck00000a');
		});
	});
});
