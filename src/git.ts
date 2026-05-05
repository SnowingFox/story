import { closeSync, openSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';

/**
 * Execute a git CLI command. Returns `stdout` trimmed by default. Throws
 * on non-zero exit.
 *
 * Pass `{ trim: false }` for commands whose output is byte-significant
 * (e.g. `git status --porcelain=v1 -z` where the leading space in
 * ` M <path>` / ` D <path>` entries must be preserved, or trimming would
 * shift every subsequent slice by one). Callers that already parse with
 * explicit offsets don't need the default trim — consumers who read
 * back into shells / comparisons (`git config` output, `git rev-parse
 * HEAD`, ...) expect the trimmed form.
 */
export async function execGit(
	args: string[],
	opts?: { cwd?: string; trim?: boolean },
): Promise<string> {
	const { stdout } = await execa('git', args, {
		cwd: opts?.cwd ?? process.cwd(),
	});
	if (opts?.trim === false) {
		return stdout;
	}
	return stdout.trim();
}

/**
 * Read a git blob at a given revision as raw bytes — no trimming, no UTF-8
 * decoding. Used by byte-exact comparisons against the worktree (e.g.
 * `filterToUncommittedFiles`).
 *
 * @example
 * const headBytes = await readGitBlob('HEAD:src/a.ts', { cwd: '/repo' });
 */
export async function readGitBlob(objectSpec: string, opts?: { cwd?: string }): Promise<Buffer> {
	const result = await execa('git', ['show', objectSpec], {
		cwd: opts?.cwd ?? process.cwd(),
		encoding: 'buffer',
	});
	return Buffer.from(result.stdout as unknown as Uint8Array);
}

/** Resolve the `.git` directory for the repo at `cwd`. Handles worktrees. */
export async function getGitDir(cwd?: string): Promise<string> {
	const dir = cwd ?? process.cwd();
	const result = await execGit(['rev-parse', '--git-dir'], { cwd: dir });
	if (path.isAbsolute(result)) {
		return result;
	}
	return path.resolve(dir, result);
}

let gitCommonDirCache = '';
let gitCommonDirCacheKey = '';

/** Clear the cached git common dir (call in test `beforeEach`). */
export function clearGitCommonDirCache(): void {
	gitCommonDirCache = '';
	gitCommonDirCacheKey = '';
}

/** Resolve the shared `.git` directory (same as gitDir in non-worktree repos). Cached by cwd. */
export async function getGitCommonDir(cwd?: string): Promise<string> {
	const dir = cwd ?? process.cwd();
	if (gitCommonDirCache && gitCommonDirCacheKey === dir) {
		return gitCommonDirCache;
	}

	const result = await execGit(['rev-parse', '--git-common-dir'], { cwd: dir });
	let commonDir: string;
	if (path.isAbsolute(result)) {
		commonDir = result;
	} else {
		commonDir = path.resolve(dir, result);
	}

	gitCommonDirCacheKey = dir;
	gitCommonDirCache = commonDir;
	return commonDir;
}

/**
 * Detect if git is mid-rebase, cherry-pick, or revert.
 *
 * During these operations commits are replayed and should not get new trailers.
 */
export async function isGitSequenceOperation(cwd?: string): Promise<boolean> {
	let gitDir: string;
	try {
		gitDir = await getGitDir(cwd);
	} catch {
		return false;
	}

	const markers = ['rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'];
	for (const marker of markers) {
		try {
			await fs.stat(path.join(gitDir, marker));
			return true;
		} catch {
			// not present
		}
	}
	return false;
}

/** Check if the worktree has staged, unstaged, or untracked changes. */
export async function hasUncommittedChanges(cwd?: string): Promise<boolean> {
	const output = await execGit(['status', '--porcelain'], { cwd });
	return output.length > 0;
}

/** Switch to a branch or ref. Rejects refs starting with `-` to prevent option injection. */
export async function checkoutBranch(ref: string, cwd?: string): Promise<void> {
	if (ref.startsWith('-')) {
		throw new Error(`checkout failed: invalid ref "${ref}"`);
	}
	await execGit(['checkout', ref], { cwd });
}

/** Return the full 40-char commit hash of HEAD. */
export async function getHeadCommit(cwd?: string): Promise<string> {
	return execGit(['rev-parse', 'HEAD'], { cwd });
}

/** List files changed in a specific commit. `--root` handles initial commits transparently. */
export async function getFilesChangedInCommit(commitHash: string, cwd?: string): Promise<string[]> {
	const output = await execGit(
		['diff-tree', '--root', '--no-commit-id', '-r', '--name-only', commitHash],
		{ cwd },
	);
	if (output.length === 0) {
		return [];
	}
	return output.split('\n').filter(Boolean);
}

/**
 * Return the subset of `files` that are matched by `.gitignore` rules.
 *
 * Distinguishes the three relevant `git check-ignore` exit codes:
 *   - `0`: at least one file is ignored — output lists them
 *   - `1`: no files are ignored — return `[]`
 *   - other (128 / spawn failure / etc): real error — propagate
 *
 * Earlier TS swallowed all errors as `[]`, masking actual git failures
 * (corrupt repo, missing binary, etc.) as "no files ignored".
 */
export async function checkIgnore(files: string[], cwd?: string): Promise<string[]> {
	if (files.length === 0) {
		return [];
	}
	const result = await execa('git', ['check-ignore', ...files], {
		cwd: cwd ?? process.cwd(),
		reject: false,
	});
	if (result.exitCode === 0) {
		return result.stdout.trim().split('\n').filter(Boolean);
	}
	if (result.exitCode === 1) {
		return [];
	}
	// exit 128 / -1 / etc → real error. Surface stderr.
	throw new Error(
		`git check-ignore failed (exit ${result.exitCode}): ${result.stderr || result.stdout || 'unknown error'}`,
	);
}

/**
 * Detect whether an interactive terminal is available.
 *
 * Check order: STORY_TEST_TTY override (Story-first, ENTIRE_TEST_TTY back-compat
 * fallback), agent env vars, GIT_TERMINAL_PROMPT, /dev/tty probe.
 *
 * **Brand precedence:** `STORY_TEST_TTY` is the canonical Story env var. The
 * Go binary still ships `ENTIRE_TEST_TTY` (whitelisted exception in
 * `references/story-vs-entire.md`), so we fall back to it for back-compat —
 * matters for shared e2e harness, dev workflows that drive both binaries, and
 * upstream Go integration tests.
 */
export function hasTTY(): boolean {
	const storyOverride = process.env.STORY_TEST_TTY;
	if (storyOverride !== undefined && storyOverride !== '') {
		return storyOverride === '1';
	}
	const entireOverride = process.env.ENTIRE_TEST_TTY;
	if (entireOverride !== undefined && entireOverride !== '') {
		return entireOverride === '1';
	}

	if (process.env.GEMINI_CLI) {
		return false;
	}
	if (process.env.COPILOT_CLI) {
		return false;
	}
	if (process.env.PI_CODING_AGENT) {
		return false;
	}
	if (process.env.GIT_TERMINAL_PROMPT === '0') {
		return false;
	}

	try {
		const fd = openSync('/dev/tty', 'r+');
		closeSync(fd);
		return true;
	} catch {
		return false;
	}
}

/** Git user identity from config. */
export interface GitAuthor {
	name: string;
	email: string;
}

/** Return the current branch name. Throws if HEAD is detached. */
export async function getCurrentBranch(cwd?: string): Promise<string> {
	const branch = await execGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
	if (branch === 'HEAD') {
		throw new Error('not on a branch (detached HEAD)');
	}
	return branch;
}

/** Retrieve git user.name and user.email, falling back to defaults. */
export async function getGitAuthor(cwd?: string): Promise<GitAuthor> {
	let name = 'Unknown';
	let email = 'unknown@local';
	try {
		name = await execGit(['config', 'user.name'], { cwd });
	} catch {
		// keep default
	}
	try {
		email = await execGit(['config', 'user.email'], { cwd });
	} catch {
		// keep default
	}
	return { name, email };
}

/**
 * Check whether a branch exists on the `origin` remote.
 *
 * Two-step probe matching Go's `BranchExistsOnRemote` (`git_operations.go:271-302`):
 *   1. Local check — `git branch -r --list origin/<name>`. Only legit "not found"
 *      result is empty stdout (`git branch --list` exits 0 even on no match);
 *      any actual error from git (corrupt repo, not a git dir, etc.) is
 *      propagated. Earlier TS swallowed all errors as `false`, masking real
 *      problems as "branch doesn't exist".
 *   2. Remote check — `git ls-remote --heads origin refs/heads/<name>`. Failures
 *      here (no network, no remote configured, auth, ...) are treated as
 *      "branch not found" (return `false`) — same as Go line 296-299.
 */
/**
 * Check whether a local branch exists. Symmetric counterpart to
 * {@link branchExistsOnRemote}.
 *
 * Mirrors Go `git_operations.go:304-320 BranchExistsLocally`. Uses
 * `git rev-parse --verify --quiet refs/heads/<name>`:
 *   - exit 0 → branch exists → `true`
 *   - any other exit (128 on missing ref, other errors) → `false`
 *
 * Unlike Go's `repo.Reference(...)` which distinguishes "not found"
 * from real errors, we follow the plumbing-CLI convention (same as
 * `entire` CLI in practice) and treat all non-zero exits as "not
 * present" — stale refs, corrupt HEAD, and missing-ref all produce
 * `false`. This matches what Go `repo.Reference` does via its
 * `errors.Is(err, plumbing.ErrReferenceNotFound)` branch, but
 * collapses the two cases because `git rev-parse --verify --quiet`
 * already filters out parseable errors at exit-code level.
 *
 * @example
 * await branchExistsLocally('main', '/repo');
 * // returns: true   (refs/heads/main exists)
 * // returns: false  (no such ref, or repo has no refs, or repo is bare+empty)
 *
 * // Side effects: read-only — single `git rev-parse --verify --quiet` probe.
 */
export async function branchExistsLocally(branchName: string, cwd?: string): Promise<boolean> {
	try {
		await execGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branchName}`], { cwd });
		return true;
	} catch {
		return false;
	}
}

export async function branchExistsOnRemote(branchName: string, cwd?: string): Promise<boolean> {
	// Step 1: local check. Propagate non-"not found" errors.
	const localOutput = await execGit(['branch', '-r', '--list', `origin/${branchName}`], { cwd });
	if (localOutput.trim().length > 0) {
		return true;
	}
	// Step 2: actual remote check. Network / auth / no-remote failures here
	// are treated as "not found" (Go matches this at line 296-299).
	try {
		const output = await execGit(['ls-remote', '--heads', 'origin', `refs/heads/${branchName}`], {
			cwd,
		});
		return output.trim().length > 0;
	} catch {
		return false;
	}
}

/**
 * Return the set of files changed between two commits using `git diff-tree -z`.
 * Pass empty string for `commit1` to handle initial (root) commits.
 */
export async function diffTreeFiles(
	commit1: string,
	commit2: string,
	cwd?: string,
): Promise<Set<string>> {
	const files = await diffTreeRaw(commit1, commit2, cwd);
	return new Set(files);
}

/** Return the list of files changed between two commits using `git diff-tree -z`. */
export async function diffTreeFileList(
	commit1: string,
	commit2: string,
	cwd?: string,
): Promise<string[]> {
	return diffTreeRaw(commit1, commit2, cwd);
}

async function diffTreeRaw(commit1: string, commit2: string, cwd?: string): Promise<string[]> {
	let args: string[];
	if (commit1 === '') {
		args = ['diff-tree', '--root', '--no-commit-id', '-r', '-z', commit2];
	} else {
		args = ['diff-tree', '--no-commit-id', '-r', '-z', commit1, commit2];
	}
	const output = await execGit(args, { cwd });
	return parseDiffTreeOutput(output);
}

/** Parse null-separated git diff-tree -r -z output into file paths. */
export function parseDiffTreeOutput(data: string): string[] {
	if (!data) {
		return [];
	}
	const parts = data.split('\0');
	const files: string[] = [];
	let i = 0;
	while (i < parts.length) {
		const part = parts[i]!;
		if (part.startsWith(':')) {
			const status = extractStatus(part);
			i++;
			if (i >= parts.length) {
				break;
			}
			const filePath = parts[i]!;
			if (filePath !== '') {
				files.push(filePath);
			}
			i++;
			if ((status === 'R' || status === 'C') && i < parts.length) {
				const path2 = parts[i]!;
				if (path2 !== '' && !path2.startsWith(':')) {
					files.push(path2);
					i++;
				}
			}
		} else {
			i++;
		}
	}
	return files;
}

/** Extract the single-char status letter from a diff-tree status line. */
export function extractStatus(statusLine: string): string {
	const trimmed = statusLine.trim();
	if (trimmed.length === 0) {
		return '';
	}
	const fields = trimmed.split(/\s+/);
	if (fields.length < 5) {
		return '';
	}
	const statusField = fields[4]!;
	if (statusField.length === 0) {
		return '';
	}
	return statusField[0]!;
}

/**
 * Check whether the current branch is the repo's default (main / master) and
 * whether the caller should skip the operation to avoid polluting main /
 * master history.
 *
 * Mirrors Go `git_operations.go: ShouldSkipOnDefaultBranch` (cli wrapper
 * around `IsOnDefaultBranch`). Foundation backlog item #18.
 *
 * Implementation note: delegates to Phase 5.1 strategy-level
 * {@link import('./strategy/branches').isOnDefaultBranch} (which calls
 * `git symbolic-ref` + `git rev-parse`). On any error (not in a git repo,
 * detached HEAD, fresh repo with no remote and no main/master), returns
 * `{ skip: false, branchName: '' }` — Go fail-safe pattern: when undecidable,
 * **allow** the operation.
 *
 * @example
 * await shouldSkipOnDefaultBranch();
 * // On main with origin/main as default:
 * //   → { skip: true,  branchName: 'main' }
 * // On feature/x:
 * //   → { skip: false, branchName: 'feature/x' }
 * // Detached HEAD / not a git repo:
 * //   → { skip: false, branchName: '' }
 *
 * // Side effects: none — read-only git CLI calls.
 */
export async function shouldSkipOnDefaultBranch(
	cwd?: string,
): Promise<{ skip: boolean; branchName: string }> {
	// Lazy-import to avoid a circular dependency between
	// `@/git` ↔ `@/strategy/branches` ↔ `@/strategy/errors`.
	const { isOnDefaultBranch } = await import('./strategy/branches');
	try {
		const { isOnDefault, branchName } = await isOnDefaultBranch(cwd);
		return { skip: isOnDefault, branchName };
	} catch {
		return { skip: false, branchName: '' };
	}
}

/**
 * Return `true` when the current HEAD is checked out on the repository's
 * default branch. Thin wrapper over the strategy-level
 * {@link import('./strategy/branches').isOnDefaultBranch} that reduces
 * the `(isOnDefault, branchName)` tuple to the boolean needed by
 * command-layer callers (e.g. `story trail`, agent hook pre-checks).
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/git_operations.go:
 * IsOnDefaultBranch` (cli-level version — foundation-backlog #23).
 *
 * @example
 * await isOnDefaultBranch({ repoRoot: '/repo' });
 * // On `main` with origin/main as default:
 * //   → true
 * // On `feature/x` / detached HEAD / fresh repo with no main/master:
 * //   → false
 *
 * // Side effects: none — read-only git CLI calls.
 */
export async function isOnDefaultBranch(ctx: { repoRoot: string }): Promise<boolean> {
	const { isOnDefaultBranch: strategyIsOnDefaultBranch } = await import('./strategy/branches');
	const { isOnDefault } = await strategyIsOnDefaultBranch(ctx.repoRoot);
	return isOnDefault;
}
