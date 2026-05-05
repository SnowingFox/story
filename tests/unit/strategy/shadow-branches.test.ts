/**
 * Phase 9.1 `src/strategy/shadow-branches.ts` unit tests — ported 1:1 from
 * Go `entire-cli/cmd/entire/cli/strategy/cleanup_test.go` (when applicable)
 * + new TS-side edge cases for the naming rebrand (`story/` vs Go `entire/`).
 *
 * Each `it()` is annotated with `// Go: <file>:<func>` for traceability.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execGit } from '@/git';
import {
	deleteShadowBranches,
	isShadowBranch,
	listShadowBranches,
} from '@/strategy/shadow-branches';
import { TestEnv } from '../../helpers/test-env';

describe('strategy/shadow-branches', () => {
	describe('isShadowBranch', () => {
		// Go: strategy/cleanup.go: IsShadowBranch — pattern matching happy / edge
		it('matches story/<7+hex>(-<6hex>)? patterns; rejects short/missing prefixes', () => {
			expect(isShadowBranch('story/abc1234')).toBe(true);
			expect(isShadowBranch('story/abc1234567890')).toBe(true);
			expect(isShadowBranch('story/abc1234-e3b0c4')).toBe(true);
			expect(isShadowBranch('story/DEADBEE-ABC123')).toBe(true);

			// Short hash (< 7 chars) — rejected.
			expect(isShadowBranch('story/abc')).toBe(false);
			// Wrong prefix (Go rebrand guard: must be `story/`, not `entire/`).
			expect(isShadowBranch('entire/abc1234')).toBe(false);
			// No prefix at all.
			expect(isShadowBranch('main')).toBe(false);
			expect(isShadowBranch('feature/branch')).toBe(false);
			// Non-hex characters in hash.
			expect(isShadowBranch('story/zzzzzzz')).toBe(false);
			// Worktree suffix must be exactly 6 chars when present.
			expect(isShadowBranch('story/abc1234-e3b0c')).toBe(false); // 5 chars
			expect(isShadowBranch('story/abc1234-e3b0c45')).toBe(false); // 7 chars
		});

		// Go: strategy/cleanup.go: IsShadowBranch — explicit exclusions
		it('explicitly excludes story/checkpoints/v1 / v2 heads and story/trails/v1', () => {
			expect(isShadowBranch('story/checkpoints/v1')).toBe(false);
			expect(isShadowBranch('story/checkpoints/v2/main')).toBe(false);
			expect(isShadowBranch('story/trails/v1')).toBe(false);
		});
	});

	describe('listShadowBranches (real git repo via TestEnv)', () => {
		let env: TestEnv;

		beforeEach(async () => {
			env = await TestEnv.create({ initialCommit: true });
		});

		afterEach(async () => {
			await env.cleanup();
		});

		// Go: strategy/cleanup.go: ListShadowBranches — no shadow branches returns []
		it('returns empty array when no shadow branches exist (Go parity: empty slice, not nil)', async () => {
			const result = await listShadowBranches({ repoRoot: env.dir });
			expect(result).toEqual([]);
			expect(Array.isArray(result)).toBe(true);
		});

		// Go: strategy/cleanup.go: ListShadowBranches — mix of shadow + non-shadow refs
		it('returns only shadow branches, filtering out metadata / v2 / trails / non-story refs', async () => {
			const head = await execGit(['rev-parse', 'HEAD'], { cwd: env.dir });
			// 3 shadow branches
			await execGit(['branch', 'story/abc1234-e3b0c4', head], { cwd: env.dir });
			await execGit(['branch', 'story/def5678-f4c1d5', head], { cwd: env.dir });
			await execGit(['branch', 'story/a1b2c3d4e5f6', head], { cwd: env.dir });
			// 3 protected story/ refs that must be filtered out
			await execGit(['branch', 'story/checkpoints/v1', head], { cwd: env.dir });
			await execGit(['branch', 'story/checkpoints/v2/main', head], { cwd: env.dir });
			await execGit(['branch', 'story/trails/v1', head], { cwd: env.dir });
			// A non-story branch — must not appear.
			await execGit(['branch', 'feature/foo', head], { cwd: env.dir });

			const result = await listShadowBranches({ repoRoot: env.dir });
			expect(result.sort()).toEqual([
				'story/a1b2c3d4e5f6',
				'story/abc1234-e3b0c4',
				'story/def5678-f4c1d5',
			]);
		});
	});

	describe('deleteShadowBranches (real git repo via TestEnv)', () => {
		let env: TestEnv;

		beforeEach(async () => {
			env = await TestEnv.create({ initialCommit: true });
		});

		afterEach(async () => {
			await env.cleanup();
		});

		// Go: strategy/cleanup.go: DeleteShadowBranches — empty input short-circuits
		it('returns { deleted: [], failed: [] } for empty input (short-circuit)', async () => {
			const result = await deleteShadowBranches({ repoRoot: env.dir }, []);
			expect(result).toEqual({ deleted: [], failed: [] });
		});

		// Go: strategy/cleanup.go: DeleteShadowBranches — best-effort: one failure
		// does not stop the rest. The failed branch is the non-existent middle
		// entry; TS treats "already gone" as success (idempotent semantics), so
		// we force a real failure with an invalid ref name.
		it('best-effort: continues past individual failures and reports them in `failed`', async () => {
			const head = await execGit(['rev-parse', 'HEAD'], { cwd: env.dir });
			await execGit(['branch', 'story/aaa0000-e3b0c4', head], { cwd: env.dir });
			await execGit(['branch', 'story/ccc2222-e3b0c4', head], { cwd: env.dir });

			// Include a name that deleteBranchCli refuses by policy (leading "-"
			// → flag-injection guard). This surfaces as a real failure, unlike
			// "branch already gone" which is idempotent success.
			const result = await deleteShadowBranches({ repoRoot: env.dir }, [
				'story/aaa0000-e3b0c4',
				'-injected',
				'story/ccc2222-e3b0c4',
			]);
			expect(result.deleted.sort()).toEqual(['story/aaa0000-e3b0c4', 'story/ccc2222-e3b0c4']);
			expect(result.failed).toEqual(['-injected']);

			// Verify git side: both shadow branches actually gone.
			const remaining = await listShadowBranches({ repoRoot: env.dir });
			expect(remaining).toEqual([]);
		});

		// Idempotent semantics: "branch already gone" counts as deleted, so retries
		// after a partial crash don't flap between failed/deleted states.
		it('counts already-gone branches as deleted (idempotent on retry)', async () => {
			const head = await execGit(['rev-parse', 'HEAD'], { cwd: env.dir });
			await execGit(['branch', 'story/aaa0000-e3b0c4', head], { cwd: env.dir });

			const first = await deleteShadowBranches({ repoRoot: env.dir }, [
				'story/aaa0000-e3b0c4',
				'story/zzz9999-e3b0c4',
			]);
			// First call: one real delete + one "never existed" sentinel.
			expect(first.deleted.sort()).toEqual(['story/aaa0000-e3b0c4', 'story/zzz9999-e3b0c4']);
			expect(first.failed).toEqual([]);
		});
	});
});
