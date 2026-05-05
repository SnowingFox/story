/**
 * Phase 5.2 Todo 3 — `manual-commit-migration.ts` unit tests.
 *
 * Three functions that move the shadow-branch ref when HEAD changes
 * mid-session (e.g. user does `git pull` / `git rebase` while the agent
 * is paused). All three are consumed by Phase 5.2 SaveStep / SaveTaskStep
 * (Todo 5) and Phase 5.4 InitializeSession.
 *
 * Go references:
 * - `manual_commit_migration.go:23-39` `migrateShadowBranchIfNeeded`
 * - `manual_commit_migration.go:42-103` `migrateShadowBranchToBaseCommit`
 * - `manual_commit_migration.go:106-118` `migrateAndPersistIfNeeded`
 * - `manual_commit_test.go:1584-1661` TestShadowStrategy_PostRewrite_MigratesExistingShadowBranch
 *   (integration covering migrate path)
 * - `manual_commit_test.go:1663-...` TestShadowStrategy_MigrateAndPersistIfNeeded_PersistsBaseCommitWithoutShadowBranch
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shadowBranchNameForCommit } from '@/checkpoint/temporary';
import { clearGitCommonDirCache } from '@/git';
import { clearWorktreeRootCache } from '@/paths';
import { ManualCommitStrategy } from '@/strategy/manual-commit';
import {
	migrateAndPersistIfNeeded,
	migrateShadowBranchIfNeeded,
	migrateShadowBranchToBaseCommit,
} from '@/strategy/manual-commit-migration';
import type { SessionState } from '@/strategy/types';
import { TestEnv } from '../../helpers/test-env';

function makeState(overrides: Partial<SessionState> = {}): SessionState {
	return {
		sessionId: 'sess-default',
		baseCommit: 'abc1234',
		startedAt: new Date().toISOString(),
		phase: 'idle',
		stepCount: 0,
		...overrides,
	};
}

async function refExists(env: TestEnv, ref: string): Promise<boolean> {
	try {
		await env.exec('git', ['rev-parse', '--verify', `refs/heads/${ref}`]);
		return true;
	} catch {
		return false;
	}
}

// Go: manual_commit_migration.go (3 instance methods, lifted to standalones in TS)
describe('manual-commit-migration — Go: manual_commit_migration.go', () => {
	let env: TestEnv;
	let strategy: ManualCommitStrategy;

	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		clearGitCommonDirCache();
		clearWorktreeRootCache();
		strategy = new ManualCommitStrategy(env.dir);
	});
	afterEach(async () => {
		await env.cleanup();
		clearGitCommonDirCache();
		clearWorktreeRootCache();
	});

	// ─── migrateShadowBranchIfNeeded ──────────────────────────────────────
	describe('migrateShadowBranchIfNeeded — Go: manual_commit_migration.go:23-39', () => {
		// Go: manual_commit_migration.go:24-26 — short-circuit on null/empty state
		it('returns false when state.baseCommit is empty', async () => {
			const state = makeState({ baseCommit: '' });
			const result = await migrateShadowBranchIfNeeded(strategy, env.dir, state);
			expect(result).toBe(false);
			expect(state.baseCommit).toBe('');
		});

		// Go: manual_commit_migration.go:34-36 — HEAD already matches → no-op
		it('returns false when HEAD === state.baseCommit (no migration needed)', async () => {
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			const state = makeState({ baseCommit: head });
			const result = await migrateShadowBranchIfNeeded(strategy, env.dir, state);
			expect(result).toBe(false);
			expect(state.baseCommit).toBe(head);
		});
	});

	// ─── migrateShadowBranchToBaseCommit ──────────────────────────────────
	describe('migrateShadowBranchToBaseCommit — Go: manual_commit_migration.go:42-103', () => {
		// Go: manual_commit_test.go:1584-1661 TestShadowStrategy_PostRewrite_MigratesExistingShadowBranch
		// (subset: just the migrate ref-rename behavior, not the full PostRewrite path)
		it('renames an existing shadow ref to the new base name and updates state.baseCommit', async () => {
			const oldBase = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			// Make a second commit and grab its hash as the "new" base
			await env.writeFile('extra.txt', 'two\n');
			await env.gitAdd('extra.txt');
			await env.gitCommit('second');
			const newBase = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();

			const oldShadow = shadowBranchNameForCommit(oldBase, '');
			const newShadow = shadowBranchNameForCommit(newBase, '');
			expect(oldShadow).not.toBe(newShadow); // pre-flight: collision-free
			// Plant the old shadow ref pointing at oldBase
			await env.exec('git', ['branch', '-f', oldShadow, oldBase]);

			const state = makeState({ baseCommit: oldBase, attributionBaseCommit: oldBase });
			const result = await migrateShadowBranchToBaseCommit(env.dir, state, newBase);

			expect(result).toBe(true);
			expect(state.baseCommit).toBe(newBase);
			// Go: manual_commit_migration.go:97-100 — attributionBaseCommit intentionally preserved
			expect(state.attributionBaseCommit).toBe(oldBase);
			expect(await refExists(env, newShadow)).toBe(true);
			expect(await refExists(env, oldShadow)).toBe(false);
		});

		// Go: manual_commit_migration.go:64-72 — old ref missing falls back to "just update state"
		it('updates only state.baseCommit when the old shadow ref does not exist', async () => {
			const oldBase = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			await env.writeFile('extra.txt', 'two\n');
			await env.gitAdd('extra.txt');
			await env.gitCommit('second');
			const newBase = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();

			const oldShadow = shadowBranchNameForCommit(oldBase, '');
			const newShadow = shadowBranchNameForCommit(newBase, '');
			// Confirm old shadow ref absent
			expect(await refExists(env, oldShadow)).toBe(false);

			const state = makeState({ baseCommit: oldBase, attributionBaseCommit: oldBase });
			const result = await migrateShadowBranchToBaseCommit(env.dir, state, newBase);

			expect(result).toBe(true);
			expect(state.baseCommit).toBe(newBase);
			expect(state.attributionBaseCommit).toBe(oldBase);
			// No new ref created when old ref was absent
			expect(await refExists(env, newShadow)).toBe(false);
		});

		// Go: manual_commit_migration.go:56-61 — hash-prefix collision guard
		it('skips ref rename when oldShadowBranch === newShadowBranch (hash short-prefix collision)', async () => {
			// Force collision by feeding the same baseCommit twice through shadowBranchNameForCommit
			// (worktreeId hashed in, so identical commits → identical name).
			const oldBase = 'abc1234567';
			const newBase = 'abc1234567'; // identical → same shadow branch name
			const state = makeState({ baseCommit: oldBase });

			// Both should resolve to the same name
			expect(shadowBranchNameForCommit(oldBase, '')).toBe(shadowBranchNameForCommit(newBase, ''));

			// Same-base early return at line 48-50 fires before our collision branch — skip this case.
			// To exercise the collision guard, use a new base that collides at prefix but differs in suffix.
			const collidingNewBase = `${oldBase.slice(0, 7)}deadbeef`; // shares 7-char prefix
			expect(shadowBranchNameForCommit(oldBase, '')).toBe(
				shadowBranchNameForCommit(collidingNewBase, ''),
			);
			const result = await migrateShadowBranchToBaseCommit(env.dir, state, collidingNewBase);
			expect(result).toBe(true);
			expect(state.baseCommit).toBe(collidingNewBase);
		});

		// Go: manual_commit_migration.go:75-80 — Storer.SetReference unconditionally
		// overwrites. Required for crash-recovery idempotency: a previous migration
		// may have created the new ref but crashed before deleting the old one. On
		// retry, the second call to migrateShadowBranchToBaseCommit MUST overwrite,
		// not error out with AlreadyExistsError.
		it('overwrites existing newShadowBranch ref (crash-recovery idempotency)', async () => {
			const oldBase = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			await env.writeFile('extra.txt', 'two\n');
			await env.gitAdd('extra.txt');
			await env.gitCommit('second');
			const newBase = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();

			const oldShadow = shadowBranchNameForCommit(oldBase, '');
			const newShadow = shadowBranchNameForCommit(newBase, '');
			// Plant BOTH refs first — simulates a crash between SetReference and
			// DeleteBranchCLI on a previous migration attempt.
			await env.exec('git', ['branch', '-f', oldShadow, oldBase]);
			await env.exec('git', ['branch', '-f', newShadow, oldBase]);

			const state = makeState({ baseCommit: oldBase, attributionBaseCommit: oldBase });
			// MUST succeed (Go SetReference overwrites; isomorphic-git default
			// `force: false` would throw AlreadyExistsError here).
			await expect(migrateShadowBranchToBaseCommit(env.dir, state, newBase)).resolves.toBe(true);

			expect(state.baseCommit).toBe(newBase);
			expect(await refExists(env, newShadow)).toBe(true);
			expect(await refExists(env, oldShadow)).toBe(false); // old ref deleted by CLI
		});

		// Go: manual_commit_migration.go:48-50 — same-base no-op
		it('returns false when state.baseCommit === newBaseCommit (same-base no-op)', async () => {
			const same = 'def5678';
			const state = makeState({ baseCommit: same });
			const result = await migrateShadowBranchToBaseCommit(env.dir, state, same);
			expect(result).toBe(false);
			expect(state.baseCommit).toBe(same);
		});

		// Go: manual_commit_migration.go:45-47 — empty newBaseCommit short-circuits
		it('returns false when newBaseCommit is the empty string', async () => {
			const state = makeState({ baseCommit: 'abc1234' });
			const result = await migrateShadowBranchToBaseCommit(env.dir, state, '');
			expect(result).toBe(false);
			expect(state.baseCommit).toBe('abc1234');
		});
	});

	// ─── migrateAndPersistIfNeeded ────────────────────────────────────────
	describe('migrateAndPersistIfNeeded — Go: manual_commit_migration.go:106-118', () => {
		// Go: manual_commit_migration.go:112 — saveSessionState skipped when no migration
		it('does not call saveSessionState when no migration is needed (HEAD matches)', async () => {
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			const state = makeState({ baseCommit: head });
			const saveSpy = vi.spyOn(strategy, 'saveSessionState').mockResolvedValue();

			await migrateAndPersistIfNeeded(strategy, env.dir, state);

			expect(saveSpy).not.toHaveBeenCalled();
		});

		// Go: manual_commit_migration.go:113-115 — wraps save error verbatim
		it('wraps a saveSessionState error with "failed to save session state after migration"', async () => {
			const oldBase = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			await env.writeFile('extra.txt', 'two\n');
			await env.gitAdd('extra.txt');
			await env.gitCommit('second');

			const state = makeState({ baseCommit: oldBase });
			vi.spyOn(strategy, 'saveSessionState').mockRejectedValue(new Error('disk full'));

			await expect(migrateAndPersistIfNeeded(strategy, env.dir, state)).rejects.toThrow(
				/failed to save session state after migration/,
			);
		});

		// Go: manual_commit_migration.go:108-110 — wraps inner migrate failure
		it('wraps a migrateShadowBranchIfNeeded error with "failed to check/migrate shadow branch"', async () => {
			// Point the strategy at a directory that is NOT a git repo, so that
			// `git rev-parse HEAD` inside migrateShadowBranchIfNeeded throws
			// (caught + wrapped → throws to migrateAndPersistIfNeeded which
			// wraps again with the outer phrase).
			const notRepoDir = `${env.dir}-not-a-repo`;
			await import('node:fs/promises').then((fs) => fs.mkdir(notRepoDir, { recursive: true }));
			const state = makeState({ baseCommit: 'abc1234' });
			await expect(migrateAndPersistIfNeeded(strategy, notRepoDir, state)).rejects.toThrow(
				/failed to check\/migrate shadow branch/,
			);
		});
	});
});
