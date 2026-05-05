/**
 * Repository / worktree helpers for the strategy package.
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/strategy/common.go:56-89` (`IsEmptyRepository`, `IsAncestorOf`)
 * and `:860-955` (`OpenRepository`, `IsInsideWorktree`, `GetMainRepoRoot`, `GetGitCommonDir`).
 *
 * Where Go uses go-git's `*git.Repository` value, TS just bundles the relevant
 * paths in a small struct ({@link Repository}) — all heavy work goes through
 * the Phase 1.3 `execGit` wrapper, not an in-process git library.
 *
 * @packageDocumentation
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { execGit, getGitDir, getGitCommonDir as gitCommonDirRaw } from '../git';
import { worktreeRoot } from '../paths';

/**
 * Bundle of useful repo paths returned from {@link openRepository}.
 * All three are absolute, symlink-non-resolved paths (matching `git rev-parse`).
 */
export interface Repository {
	/** Worktree root (`git rev-parse --show-toplevel`). */
	root: string;
	/** Per-worktree `.git` dir (`git rev-parse --git-dir`). For the main worktree this equals the common dir. */
	gitDir: string;
	/** Shared `.git` dir (`git rev-parse --git-common-dir`). For linked worktrees points at the main repo's `.git`. */
	gitCommonDir: string;
}

/**
 * Open the git repository containing `cwd` (defaults to `process.cwd()`).
 *
 * Mirrors Go `common.go:860-876` (`OpenRepository`). Returns a small
 * {@link Repository} bundle — all subsequent operations use git CLI via
 * {@link execGit}.
 *
 * @example
 * const repo = await openRepository();
 * // repo.root         === '/path/to/worktree'
 * // repo.gitDir       === '/path/to/worktree/.git'  (or .git/worktrees/<id> for linked)
 * // repo.gitCommonDir === '/path/to/worktree/.git'  (always main repo's .git)
 */
export async function openRepository(cwd?: string): Promise<Repository> {
	const root = await worktreeRoot(cwd);
	const [gitDir, gitCommonDir] = await Promise.all([getGitDir(root), gitCommonDirRaw(root)]);
	return { root, gitDir, gitCommonDir };
}

/**
 * Returns the shared `.git` directory for `cwd`. For linked worktrees this
 * resolves to the main repo's `.git` (so all worktrees on the same repo
 * share the same session-state directory).
 *
 * Mirrors Go `common.go:937-955` (`GetGitCommonDir`). Thin wrapper around
 * Phase 1.3 {@link gitCommonDirRaw}; re-exported here so strategy callers can
 * stay within `@/strategy/repo`.
 *
 * @example
 * ```ts
 * await getGitCommonDir('/repo');                     // '/repo/.git'
 * await getGitCommonDir('/repo/wt-feature');          // '/repo/.git'  (linked worktree → main repo's .git)
 *
 * // Side effects: none — runs `git rev-parse --git-common-dir` only.
 * //
 * // Disk / git refs / HEAD: unchanged.
 * ```
 */
export async function getGitCommonDir(cwd?: string): Promise<string> {
	return gitCommonDirRaw(cwd);
}

/**
 * Returns the path to the main repo's worktree root, even when called from
 * inside a linked worktree. For the main worktree itself returns the same
 * path as {@link openRepository}.
 *
 * Mirrors Go `common.go:878-932` (`GetMainRepoRoot`). Implementation reads
 * `<gitCommonDir>/..` since the common dir is always located at
 * `<mainRoot>/.git/`.
 *
 * @example
 * ```ts
 * await getMainRepoRoot('/repo');                  // '/repo'
 * await getMainRepoRoot('/repo/wt-feature');       // '/repo'  (linked → main worktree)
 *
 * // Side effects: none — runs `git rev-parse --git-common-dir` and a path.dirname.
 * //
 * // Disk / git refs / HEAD: unchanged.
 * ```
 */
export async function getMainRepoRoot(cwd?: string): Promise<string> {
	const commonDir = await getGitCommonDir(cwd);
	// `<mainRoot>/.git` is the canonical layout. For bare repos `commonDir`
	// itself IS the main "root"; we still walk up one level which yields the
	// containing directory — acceptable for our use case.
	const path = await import('node:path');
	return path.dirname(commonDir);
}

/**
 * Returns true ONLY when `cwd` is inside a **secondary git worktree** (i.e.
 * the linked worktree where `.git` is a *file* / gitfile, not a directory).
 *
 * Returns false in:
 * - The main worktree (where `.git` is a directory)
 * - A directory that is not a git repo at all
 *
 * Mirrors Go `common.go:878-895` exactly:
 * ```go
 * gitInfo, err := os.Stat(filepath.Join(repoRoot, ".git"))
 * if err != nil { return false }
 * return !gitInfo.IsDir()  // ← true ONLY when .git is a file
 * ```
 *
 * **Why this asymmetry**: callers use `isInsideWorktree` to gate worktree-only
 * behavior (e.g. avoid global config writes when running inside `git worktree
 * add`-spawned dirs). The detection is "is this a linked worktree?" which is
 * exactly the gitfile case.
 *
 * @example
 * await isInsideWorktree('/repo')                  // main repo: .git is dir → false
 * await isInsideWorktree('/repo/wt-feature')       // linked worktree: .git is file → true
 * await isInsideWorktree('/tmp/random')            // non-repo: stat fails → false
 */
export async function isInsideWorktree(cwd?: string): Promise<boolean> {
	let root: string;
	try {
		root = await worktreeRoot(cwd);
	} catch {
		return false;
	}
	const gitPath = path.join(root, '.git');
	try {
		const stat = await fs.stat(gitPath);
		return !stat.isDirectory();
	} catch {
		return false;
	}
}

/**
 * Returns true if HEAD is unborn (the repo has no commits yet).
 *
 * Mirrors Go `common.go:56` (`IsEmptyRepository`). Used by `ensureMetadataBranch`
 * and `ensureSetup` to decide whether to skip orphan-branch creation (`git
 * checkout --orphan` requires HEAD to exist).
 *
 * @example
 * ```ts
 * await isEmptyRepository('/fresh-init-repo');       // true   (no commits yet)
 * await isEmptyRepository('/repo-with-commits');     // false
 *
 * // Side effects: none — runs `git rev-parse --verify HEAD` only.
 * //
 * // Disk / git refs / HEAD: unchanged.
 * ```
 */
export async function isEmptyRepository(cwd?: string): Promise<boolean> {
	try {
		await execGit(['rev-parse', '--verify', 'HEAD'], { cwd });
		return false;
	} catch {
		// `git rev-parse --verify HEAD` exits non-zero on unborn HEAD.
		return true;
	}
}

/**
 * Bounded ancestor check — returns true if `commit` is an ancestor of `target`.
 *
 * Mirrors Go `common.go:89` (`IsAncestorOf`). Uses `git merge-base --is-ancestor`
 * (exits 0 if true, 1 if false, other on error).
 *
 * @example
 * ```ts
 * await isAncestorOf('abc1234', 'def5678', repoDir);  // true   (abc1234 is reachable from def5678)
 * await isAncestorOf('def5678', 'abc1234', repoDir);  // false  (descendant ≠ ancestor)
 * await isAncestorOf('abc1234', 'abc1234', repoDir);  // true   (commit is ancestor of itself)
 *
 * // Side effects: none — runs `git merge-base --is-ancestor`.
 * //
 * // Disk / git refs / HEAD: unchanged.
 * //
 * // Errors: rethrows for non-1 exit codes (e.g. unknown commit, broken repo).
 * ```
 */
export async function isAncestorOf(commit: string, target: string, cwd?: string): Promise<boolean> {
	try {
		await execGit(['merge-base', '--is-ancestor', commit, target], { cwd });
		return true;
	} catch (err) {
		// exit code 1 = not an ancestor (clean false). Other codes = real error.
		if (
			err &&
			typeof err === 'object' &&
			'exitCode' in err &&
			(err as { exitCode: number }).exitCode === 1
		) {
			return false;
		}
		throw err;
	}
}
