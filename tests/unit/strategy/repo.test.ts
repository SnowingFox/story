/**
 * Phase 5.1 repo.ts unit tests — ported 1:1 from Go
 * `entire-cli/cmd/entire/cli/strategy/common_test.go` (OpenRepository,
 * WorktreeRoot, IsInsideWorktree, GetMainRepoRoot, IsEmptyRepository sections).
 *
 * Each `it()` is annotated with `// Go: <file>:<line> <TestName>` for traceability.
 *
 * **Important Go semantic note** for `IsInsideWorktree`:
 * Go's `IsInsideWorktree` returns true ONLY for secondary git worktrees
 * (where `.git` is a file, not a directory). Returns false in main repo and
 * non-repo. The TS impl currently uses `git rev-parse --is-inside-work-tree`
 * which returns true for ANY git worktree — this divergence is verified by
 * the ported tests below; mismatches surface as test failures (impl gap).
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearGitCommonDirCache, execGit } from '@/git';
import { clearWorktreeRootCache, worktreeRoot } from '@/paths';
import {
	getMainRepoRoot,
	isAncestorOf,
	isEmptyRepository,
	isInsideWorktree,
	openRepository,
} from '@/strategy/repo';
import { TestEnv } from '../../helpers/test-env';

/** Create a worktree using native git (mirrors Go test helper). */
async function createWorktree(repoDir: string, worktreeDir: string, branch: string): Promise<void> {
	await execGit(['worktree', 'add', worktreeDir, '-b', branch], { cwd: repoDir });
}

/** Remove a worktree (best-effort cleanup). */
async function removeWorktree(repoDir: string, worktreeDir: string): Promise<void> {
	try {
		await execGit(['worktree', 'remove', worktreeDir, '--force'], { cwd: repoDir });
	} catch {
		// best-effort
	}
}

describe('strategy/repo — ported from common_test.go', () => {
	beforeEach(() => {
		clearGitCommonDirCache();
		clearWorktreeRootCache();
	});

	afterEach(() => {
		clearGitCommonDirCache();
		clearWorktreeRootCache();
	});

	// Go: common_test.go:24-90 TestOpenRepository
	it('TestOpenRepository — Go: common_test.go:24-90', async () => {
		const env = await TestEnv.create({ initialCommit: false });
		try {
			// Create a test file and commit it
			await env.writeFile('test.txt', 'test content');
			await env.gitAdd('test.txt');
			const commitHash = await env.gitCommit('Initial commit');

			// Test OpenRepository
			const repo = await openRepository(env.dir);
			expect(repo).not.toBeNull();
			expect(repo.root).toBe(env.dir);

			// Verify we can perform basic operations — read HEAD
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			expect(head).toBe(commitHash);

			// Verify we can get the commit message
			const message = (await env.exec('git', ['log', '-1', '--format=%s'])).stdout.trim();
			expect(message).toBe('Initial commit');
		} finally {
			await env.cleanup();
		}
	});

	// Go: common_test.go:92-104 TestOpenRepositoryError
	it('TestOpenRepositoryError — Go: common_test.go:92-104', async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'story-no-git-'));
		try {
			await expect(openRepository(tmpDir)).rejects.toThrow();
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	// Go: common_test.go:106-147 TestWorktreeRoot_Cache
	it('TestWorktreeRoot_Cache — Go: common_test.go:106-147', async () => {
		const env = await TestEnv.create({ initialCommit: true });
		try {
			clearWorktreeRootCache();
			const got = await worktreeRoot(env.dir);
			expect(got).toBe(env.dir);

			// Cache hit: subsequent call returns same result
			const got2 = await worktreeRoot(env.dir);
			expect(got2).toBe(env.dir);
		} finally {
			await env.cleanup();
		}
	});

	// Go: common_test.go:149-186 TestWorktreeRoot_MainRepo
	it('TestWorktreeRoot_MainRepo — Go: common_test.go:149-186', async () => {
		const env = await TestEnv.create({ initialCommit: true });
		try {
			clearWorktreeRootCache();
			const got = await worktreeRoot(env.dir);
			expect(got).toBe(env.dir);

			// Also works from a subdirectory
			const subDir = path.join(env.dir, 'sub', 'dir');
			await fs.mkdir(subDir, { recursive: true });
			clearWorktreeRootCache();
			const gotSub = await worktreeRoot(subDir);
			expect(gotSub).toBe(env.dir);
		} finally {
			await env.cleanup();
		}
	});

	// Go: common_test.go:188-250 TestWorktreeRoot_Worktree
	it('TestWorktreeRoot_Worktree — Go: common_test.go:188-250', async () => {
		const mainEnv = await TestEnv.create({ initialCommit: true });
		// Worktree dir: must not exist before `git worktree add`
		const worktreeBase = await fs.mkdtemp(path.join(os.tmpdir(), 'story-worktree-'));
		const worktreeDir = path.join(worktreeBase, 'wt');
		try {
			await createWorktree(mainEnv.dir, worktreeDir, 'wt-branch');
			const wtResolved = await fs.realpath(worktreeDir);

			clearWorktreeRootCache();
			const got = await worktreeRoot(wtResolved);
			expect(got).toBe(wtResolved);
			expect(got).not.toBe(mainEnv.dir);

			// Also works from a subdirectory within the worktree
			const subDir = path.join(wtResolved, 'deep', 'sub');
			await fs.mkdir(subDir, { recursive: true });
			clearWorktreeRootCache();
			const gotSub = await worktreeRoot(subDir);
			expect(gotSub).toBe(wtResolved);
			expect(gotSub).not.toBe(mainEnv.dir);
		} finally {
			await removeWorktree(mainEnv.dir, worktreeDir);
			await fs.rm(worktreeBase, { recursive: true, force: true });
			await mainEnv.cleanup();
		}
	});

	describe('TestIsInsideWorktree — Go: common_test.go:252-291', () => {
		// Go: common_test.go:253-261 main repo subtest
		it('main repo: returns false (Go: common_test.go:253-261)', async () => {
			const env = await TestEnv.create({ initialCommit: true });
			try {
				expect(await isInsideWorktree(env.dir)).toBe(false);
			} finally {
				await env.cleanup();
			}
		});

		// Go: common_test.go:263-281 worktree subtest
		it('worktree: returns true (Go: common_test.go:263-281)', async () => {
			const mainEnv = await TestEnv.create({ initialCommit: true });
			const worktreeBase = await fs.mkdtemp(path.join(os.tmpdir(), 'story-worktree-iw-'));
			const worktreeDir = path.join(worktreeBase, 'worktree');
			try {
				await createWorktree(mainEnv.dir, worktreeDir, 'test-branch');
				const wtResolved = await fs.realpath(worktreeDir);
				expect(await isInsideWorktree(wtResolved)).toBe(true);
			} finally {
				await removeWorktree(mainEnv.dir, worktreeDir);
				await fs.rm(worktreeBase, { recursive: true, force: true });
				await mainEnv.cleanup();
			}
		});

		// Go: common_test.go:283-290 non-repo subtest
		it('non-repo: returns false (Go: common_test.go:283-290)', async () => {
			const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'story-no-git-'));
			try {
				expect(await isInsideWorktree(tmpDir)).toBe(false);
			} finally {
				await fs.rm(tmpDir, { recursive: true, force: true });
			}
		});
	});

	describe('TestGetMainRepoRoot — Go: common_test.go:293-347', () => {
		// Go: common_test.go:294-315 main repo subtest
		it('main repo (Go: common_test.go:294-315)', async () => {
			const env = await TestEnv.create({ initialCommit: true });
			try {
				const root = await getMainRepoRoot(env.dir);
				expect(root).toBe(env.dir);
			} finally {
				await env.cleanup();
			}
		});

		// Go: common_test.go:317-346 worktree subtest
		it('worktree (Go: common_test.go:317-346)', async () => {
			const mainEnv = await TestEnv.create({ initialCommit: true });
			const worktreeBase = await fs.mkdtemp(path.join(os.tmpdir(), 'story-worktree-mrr-'));
			const worktreeDir = path.join(worktreeBase, 'worktree');
			try {
				await createWorktree(mainEnv.dir, worktreeDir, 'test-branch');
				const wtResolved = await fs.realpath(worktreeDir);
				const root = await getMainRepoRoot(wtResolved);
				expect(root).toBe(mainEnv.dir);
			} finally {
				await removeWorktree(mainEnv.dir, worktreeDir);
				await fs.rm(worktreeBase, { recursive: true, force: true });
				await mainEnv.cleanup();
			}
		});
	});

	describe('TestIsEmptyRepository — Go: common_test.go:1506-1550 TestIsEmptyRepository', () => {
		// Go: common_test.go:1508-1518 TestIsEmptyRepository (empty subtest)
		it('empty repo returns true', async () => {
			const env = await TestEnv.create({ initialCommit: false });
			try {
				expect(await isEmptyRepository(env.dir)).toBe(true);
			} finally {
				await env.cleanup();
			}
		});

		// Go: common_test.go:1520-1549 TestIsEmptyRepository (with-commit subtest)
		it('repo with commit returns false', async () => {
			const env = await TestEnv.create({ initialCommit: true });
			try {
				expect(await isEmptyRepository(env.dir)).toBe(false);
			} finally {
				await env.cleanup();
			}
		});
	});
});

/**
 * TS-only: `isAncestorOf` lives in Go production at `common.go:86-118` but has
 * no dedicated `Test*` in `strategy/*_test.go` (Go covers it transitively via
 * rewind / postrewrite tests). The two tests below pin the wrapper's behavior
 * around `git merge-base --is-ancestor`.
 */
describe('strategy/repo — isAncestorOf (TS-only: no Go Test*)', () => {
	let env: TestEnv;
	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
	});
	afterEach(async () => {
		await env.cleanup();
	});

	it('returns true when commit is an ancestor of target', async () => {
		const a = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		await env.writeFile('b.txt', 'b');
		await env.gitAdd('b.txt');
		const b = await env.gitCommit('b');
		expect(await isAncestorOf(a, b, env.dir)).toBe(true);
	});

	it('returns false when commit is not an ancestor', async () => {
		const a = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		await env.writeFile('b.txt', 'b');
		await env.gitAdd('b.txt');
		const b = await env.gitCommit('b');
		expect(await isAncestorOf(b, a, env.dir)).toBe(false);
	});
});
