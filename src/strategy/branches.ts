/**
 * Branch / hard-reset / default-branch helpers for the strategy package.
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/strategy/common.go:1318-1634` —
 * `DeleteBranchCLI` / `HardResetWithProtection` / `GetCurrentBranchName` /
 * `GetMainBranchHash` / `GetDefaultBranchName` / `IsOnDefaultBranch`.
 *
 * **Why git CLI for hard-reset**: Go forks `git reset --hard <hash>`
 * subprocess instead of using go-git's `Reset()` due to a known go-git bug
 * with untracked-file protection. TS follows the same convention via
 * {@link execGit} — never use isomorphic-git's `checkout({ force: true })` for
 * this codepath.
 *
 * @packageDocumentation
 */

import { execGit, getCurrentBranch } from '../git';
import { StrategyError } from './errors';

/**
 * Sentinel SHA returned by Go's `plumbing.ZeroHash` when no main / master
 * branch exists. Used by {@link getMainBranchHash} as the default-not-found
 * marker (matches Go convention for "no commit").
 */
export const ZERO_COMMIT_HASH = '0000000000000000000000000000000000000000';

/**
 * Returned by {@link deleteBranchCli} when the local branch does not exist.
 * Mirrors Go `common.go:1316` `var ErrBranchNotFound = errors.New("branch not found")`.
 *
 * Callers can use reference equality (`err === ErrBranchNotFound`) for the
 * idempotent-deletion pattern (`errors.Is(err, ErrBranchNotFound)` in Go).
 *
 * @example
 * ```ts
 * try {
 *   await deleteBranchCli('story/abc1234-e3b0c4', repoDir);
 * } catch (err) {
 *   if (err === ErrBranchNotFound) {
 *     // already gone — nothing to do
 *   } else {
 *     throw err;
 *   }
 * }
 * ```
 */
export const ErrBranchNotFound = new StrategyError('branch not found');

/**
 * Delete a local branch via `git branch -D <name>`. Force-delete (drops
 * unmerged commits). Caller is responsible for safety-gating.
 *
 * Refuses any name starting with `-` to prevent flag injection on the git
 * argv (Go `common.go` performs the same prefix check before forking).
 *
 * **Pre-check**: probes `git show-ref --verify --quiet refs/heads/<name>` first;
 * if the ref doesn't exist, throws the {@link ErrBranchNotFound} sentinel so
 * callers can use reference-equality for idempotent deletion (Go's
 * `errors.Is(err, ErrBranchNotFound)` analog). Other failures (corrupt repo,
 * permissions, etc.) propagate as-is.
 *
 * Mirrors Go `common.go:1316-1346` (`DeleteBranchCLI` + `ErrBranchNotFound`).
 *
 * @example
 * ```ts
 * await deleteBranchCli('story/abc1234-e3b0c4', repoDir);
 * // returns: undefined
 *
 * // Side effects:
 * //   <repoDir>/.git/refs/heads/story/abc1234-e3b0c4   ← removed
 * //   (or removed from .git/packed-refs if previously packed)
 * //
 * // HEAD / worktree / index / remote refs: unchanged.
 *
 * await deleteBranchCli('does-not-exist', repoDir);
 * // throws: ErrBranchNotFound  (use `err === ErrBranchNotFound` to detect)
 * // Side effects: none — pre-check refused before invoking `git branch -D`.
 *
 * await deleteBranchCli('-foo', repoDir);
 * // throws: Error('deleteBranchCli: refusing branch name starting with "-": -foo')
 * // Side effects: none — refused before forking git.
 * ```
 */
export async function deleteBranchCli(name: string, cwd?: string): Promise<void> {
	if (name.startsWith('-')) {
		throw new Error(`deleteBranchCli: refusing branch name starting with "-": ${name}`);
	}
	// Pre-check: structured "branch not found" sentinel for idempotent callers.
	// `git show-ref --verify --quiet` exits 1 for "ref missing" and 128+ for
	// fatal errors (corrupt repo, not a git directory). Map exit code 1 to
	// ErrBranchNotFound; let other failures propagate so callers see the real
	// underlying error.
	try {
		await execGit(['show-ref', '--verify', '--quiet', `refs/heads/${name}`], { cwd });
	} catch (err) {
		if (err && typeof err === 'object' && 'exitCode' in err) {
			const code = (err as { exitCode: number }).exitCode;
			if (code === 1) {
				throw ErrBranchNotFound;
			}
		}
		throw err;
	}
	await execGit(['branch', '-D', name], { cwd });
}

/**
 * Hard-reset the working tree to a commit hash via `git reset --hard <hash>`,
 * returning the 7-char short SHA of the target commit (Go API parity).
 *
 * Uses the git CLI (not isomorphic-git) because go-git has a known issue with
 * untracked-file protection during hard-reset. Mirrors `common.go:1358-1375`.
 *
 * Refuses any hash starting with `-` to prevent flag injection on the git argv.
 *
 * @example
 * ```ts
 * const shortId = await hardResetWithProtection('a1b2c3d4e5f67890abcd', repoDir);
 * // returns: 'a1b2c3d'   (7-char short SHA of the target commit)
 *
 * // Side effects:
 * //   <repoDir>/.git/HEAD              ← retargeted to a1b2c3d4...
 * //   <repoDir>/.git/index             ← rewritten to match the new tree
 * //   <repoDir>/<tracked-files>        ← reverted to the new tree's contents
 * //
 * // Untracked files / .gitignore'd paths / remote refs: unchanged.
 *
 * await hardResetWithProtection('-foo', repoDir);
 * // throws: Error('hardResetWithProtection: refusing hash starting with "-": -foo')
 * // Side effects: none — refused before forking git.
 * ```
 */
export async function hardResetWithProtection(hash: string, cwd?: string): Promise<string> {
	if (hash.startsWith('-')) {
		throw new Error(`hardResetWithProtection: refusing hash starting with "-": ${hash}`);
	}
	await execGit(['reset', '--hard', hash], { cwd });
	return execGit(['rev-parse', '--short=7', hash], { cwd });
}

/**
 * Returns the current branch name, or `null` when HEAD is detached.
 *
 * Mirrors Go `common.go:1551-1560` (`GetCurrentBranchName`). Wraps Phase 1.3
 * {@link getCurrentBranch} which throws on detached HEAD; we normalize that
 * into `null` since `(string|null)` is the strategy-package convention.
 *
 * @example
 * ```ts
 * await getCurrentBranchName(repoDir);
 * // returns: 'main'   (when on a named branch)
 * // returns: null     (when HEAD is detached / on a tag / on a bare hash)
 *
 * // Side effects: none — runs `git symbolic-ref HEAD` only.
 * //
 * // Disk / git refs / HEAD: unchanged.
 * ```
 */
export async function getCurrentBranchName(cwd?: string): Promise<string | null> {
	try {
		return await getCurrentBranch(cwd);
	} catch {
		return null;
	}
}

/**
 * Returns the SHA of the default branch's tip. For each candidate name (main,
 * master) tries the local ref first, then `origin/<name>`. Returns
 * {@link ZERO_COMMIT_HASH} (40 zeros) when neither name resolves to a commit.
 *
 * Mirrors Go `common.go:1564-1579` (`GetMainBranchHash`) including the
 * remote-fallback chain.
 *
 * @example
 * ```ts
 * // Repo with a local `main` branch:
 * await getMainBranchHash(repoDir);
 * // returns: 'abc1234567890...'   (40-char SHA of refs/heads/main)
 *
 * // Repo with no local main but `origin/master` exists:
 * await getMainBranchHash(repoDir);
 * // returns: 'def56789...'        (SHA of refs/remotes/origin/master)
 *
 * // Empty / no main / no master / no remote:
 * await getMainBranchHash(repoDir);
 * // returns: ZERO_COMMIT_HASH     (40 zeros)
 *
 * // Side effects: none — only `git rev-parse refs/heads|remotes/...` calls.
 * //
 * // Disk / git refs / HEAD: unchanged.
 * ```
 */
export async function getMainBranchHash(cwd?: string): Promise<string> {
	for (const candidate of ['main', 'master']) {
		try {
			return (await execGit(['rev-parse', `refs/heads/${candidate}`], { cwd })).trim();
		} catch {
			// local missing — try remote-tracking ref before next candidate
		}
		try {
			return (await execGit(['rev-parse', `refs/remotes/origin/${candidate}`], { cwd })).trim();
		} catch {
			// neither local nor remote — try next candidate name
		}
	}
	return ZERO_COMMIT_HASH;
}

/**
 * Returns the name of the default branch using a 6-step priority cascade
 * matching Go `common.go:1581-1620`:
 *
 * 1. `origin/HEAD` symbolic ref → strip `refs/remotes/origin/` prefix
 * 2. `origin/main` (remote ref) → `"main"`
 * 3. `origin/master` (remote ref) → `"master"`
 * 4. local `main` → `"main"`
 * 5. local `master` → `"master"`
 * 6. nothing matches → `""` (empty string, **not** a `"main"` fallback)
 *
 * @example
 * // After `git remote set-head origin trunk`:
 * await getDefaultBranchName(repoDir)  // => 'trunk'
 *
 * // Fresh repo with no commits, no remote:
 * await getDefaultBranchName(repoDir)  // => ''
 */
export async function getDefaultBranchName(cwd?: string): Promise<string> {
	// 1. origin/HEAD symbolic ref
	try {
		const target = (
			await execGit(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], { cwd })
		).trim();
		const PREFIX = 'refs/remotes/origin/';
		if (target.startsWith(PREFIX)) {
			const stripped = target.slice(PREFIX.length);
			if (stripped !== '') {
				return stripped;
			}
		}
	} catch {
		// origin/HEAD missing — fall through
	}

	// 2-3. remote main / master
	for (const candidate of ['main', 'master']) {
		try {
			await execGit(['rev-parse', '--verify', `refs/remotes/origin/${candidate}`], { cwd });
			return candidate;
		} catch {
			// not present — try next
		}
	}

	// 4-5. local main / master
	for (const candidate of ['main', 'master']) {
		try {
			await execGit(['rev-parse', '--verify', `refs/heads/${candidate}`], { cwd });
			return candidate;
		} catch {
			// not present — try next
		}
	}

	// 6. nothing — Go returns ""
	return '';
}

/**
 * Returns whether the current branch is the default branch, **plus** the
 * current branch name (mirrors Go's `(bool, string)` tuple return).
 *
 * Detached HEAD returns `{ isOnDefault: false, branchName: '' }`. When
 * {@link getDefaultBranchName} returns `''` (fresh repo / no main / no master /
 * no origin), Go falls back to "is current branch one of {main, master}?" so
 * a freshly-init'd `master` repo with no remote still reads as on-default.
 *
 * Mirrors Go `common.go:1622-1634` (`IsOnDefaultBranch`).
 *
 * @example
 * ```ts
 * // On `main` with `origin/main` set as default:
 * await isOnDefaultBranch(repoDir);
 * // returns: { isOnDefault: true,  branchName: 'main' }
 *
 * // On `feature/x` with `origin/main` as default:
 * await isOnDefaultBranch(repoDir);
 * // returns: { isOnDefault: false, branchName: 'feature/x' }
 *
 * // Detached HEAD:
 * await isOnDefaultBranch(repoDir);
 * // returns: { isOnDefault: false, branchName: '' }
 *
 * // Fresh repo, no remote, on `master` (Go fallback):
 * await isOnDefaultBranch(repoDir);
 * // returns: { isOnDefault: true,  branchName: 'master' }
 *
 * // Side effects: none — calls only `git symbolic-ref HEAD` + `git rev-parse`.
 * //
 * // Disk / git refs / HEAD: unchanged.
 * ```
 */
export async function isOnDefaultBranch(
	cwd?: string,
): Promise<{ isOnDefault: boolean; branchName: string }> {
	const branchName = await getCurrentBranchName(cwd);
	if (branchName === null) {
		return { isOnDefault: false, branchName: '' };
	}

	const defaultBranch = await getDefaultBranchName(cwd);
	if (defaultBranch === '') {
		// Go fallback: when default is unknown, accept main/master as default
		return {
			isOnDefault: branchName === 'main' || branchName === 'master',
			branchName,
		};
	}
	return { isOnDefault: branchName === defaultBranch, branchName };
}
