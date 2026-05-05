import { createHash } from 'node:crypto';
import fsCallback from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import git from 'isomorphic-git';
import {
	chunkTranscript as agentChunkTranscript,
	chunkFileName,
	reassembleTranscript,
} from '../agent/chunking';
import { execGit } from '../git';
import { warn } from '../log';
import {
	isInfrastructurePath,
	STORY_METADATA_DIR_NAME,
	shadowBranchName,
	toRelativePath,
} from '../paths';
import { redactJSONLBytes } from '../redact';
import { formatShadowCommit, parseMetadata, parseSession, parseTaskMetadata } from '../trailers';
import { validateAgentID, validateSessionId, validateToolUseID } from '../validation';
import { createBlobFromContent, createCommit, createRedactedBlobFromFile } from './git-objects';
import {
	applyTreeChanges,
	normalizeGitTreePath,
	type TreeChange,
	type TreeEntry,
	ZERO_HASH,
} from './tree-ops';
import type {
	ReadTemporaryResult,
	TemporaryCheckpointInfo,
	TemporaryInfo,
	WriteTemporaryOptions,
	WriteTemporaryResult,
	WriteTemporaryTaskOptions,
} from './types';

/**
 * Temporary (shadow branch) checkpoint operations + shadow naming primitives.
 *
 * Phase 4.1 added the shadow naming helpers (hashWorktreeID /
 * shadowBranchNameForCommit / parseShadowBranchName) at the bottom of this
 * file. Phase 4.2 builds the full read/write/list/delete operations on top of
 * those primitives.
 *
 * Go reference: `entire-cli/cmd/entire/cli/checkpoint/temporary.go` (~1300 lines).
 */

/**
 * Shadow branch ref namespace prefix. Story CLI temporary checkpoints all live
 * under `story/...` so they never collide with user branches.
 *
 * NOTE: Renamed from Go's `entire/` prefix per Story rebrand. See
 * `docs/ts-rewrite/impl/references/story-vs-entire.md`.
 */
export const SHADOW_BRANCH_PREFIX = 'story/';

/** Number of leading hex characters of the base commit hash kept in shadow branch names. */
export const SHADOW_BRANCH_HASH_LENGTH = 7;

/** Number of hex characters of the worktree ID hash kept in shadow branch names. */
export const WORKTREE_ID_HASH_LENGTH = 6;

/**
 * Short, deterministic fingerprint of a git worktree identifier (the linked
 * worktree's internal name, or `''` for the main worktree). Used as the
 * suffix of shadow branch names so per-worktree checkpoints stay separate.
 *
 * @example
 * ```ts
 * hashWorktreeID('')              // 'e3b0c4'   (sha256 of empty string, first 6 hex)
 * hashWorktreeID('feature-auth')  // deterministic 6-hex digest
 * hashWorktreeID('a') === hashWorktreeID('a')  // true (deterministic)
 * ```
 */
export function hashWorktreeID(worktreeID: string): string {
	const digest = createHash('sha256').update(worktreeID).digest('hex');
	return digest.slice(0, WORKTREE_ID_HASH_LENGTH);
}

/**
 * Build the shadow branch name for a `(baseCommit, worktreeID)` pair.
 *
 * Format: `story/<baseCommit[:7]>-<hashWorktreeID(worktreeID)>`. If the base
 * commit is shorter than 7 chars (e.g. in tests), the full string is used.
 *
 * Internally delegates the final string assembly to {@link shadowBranchName}
 * in `src/paths.ts` so the prefix lives in a single place.
 *
 * @example
 * ```ts
 * shadowBranchNameForCommit('abc1234567890', '')         // 'story/abc1234-e3b0c4'
 * shadowBranchNameForCommit('abc1234567890', 'wt-bug')   // 'story/abc1234-<6hex>'
 * shadowBranchNameForCommit('abc', 'wt')                 // 'story/abc-<6hex>'  (commit not padded)
 * ```
 */
export function shadowBranchNameForCommit(baseCommit: string, worktreeID: string): string {
	const commitPart =
		baseCommit.length >= SHADOW_BRANCH_HASH_LENGTH
			? baseCommit.slice(0, SHADOW_BRANCH_HASH_LENGTH)
			: baseCommit;
	return shadowBranchName(commitPart, hashWorktreeID(worktreeID));
}

/**
 * Parse a shadow branch ref back into its components.
 *
 * Returns `null` if the name does not start with `story/`. Otherwise returns
 * `{ commitPrefix, worktreeHash }`. For the legacy old format
 * `story/<commit[:7]>` (no worktree segment) `worktreeHash` is `''`.
 *
 * @example
 * ```ts
 * parseShadowBranchName('story/abc1234-e3b0c4')
 *   // { commitPrefix: 'abc1234', worktreeHash: 'e3b0c4' }
 *
 * parseShadowBranchName('story/abc1234')           // legacy, no worktree segment
 *   // { commitPrefix: 'abc1234', worktreeHash: '' }
 *
 * parseShadowBranchName('main')                    // not a shadow branch
 *   // null
 *
 * parseShadowBranchName('story/checkpoints/v1')    // parser is structural, not semantic
 *   // { commitPrefix: 'checkpoints/v1', worktreeHash: '' }
 * ```
 */
export function parseShadowBranchName(
	branchName: string,
): { commitPrefix: string; worktreeHash: string } | null {
	if (!branchName.startsWith(SHADOW_BRANCH_PREFIX)) {
		return null;
	}
	const suffix = branchName.slice(SHADOW_BRANCH_PREFIX.length);

	const lastDash = suffix.lastIndexOf('-');
	if (lastDash === -1 || lastDash === 0 || lastDash === suffix.length - 1) {
		return { commitPrefix: suffix, worktreeHash: '' };
	}
	return {
		commitPrefix: suffix.slice(0, lastDash),
		worktreeHash: suffix.slice(lastDash + 1),
	};
}

/**
 * Extract the tool-use ID from a task metadata directory path.
 *
 * Task metadata dirs have the shape `.story/metadata/<sessionId>/tasks/<toolUseID>`.
 * If the second-to-last segment is `tasks`, the last segment is the tool-use ID.
 * Otherwise (regular session metadata, no tasks segment) returns `''`.
 *
 * @example
 * ```ts
 * extractToolUseIDFromPath('.story/metadata/sess-1/tasks/tool-abc')  // 'tool-abc'
 * extractToolUseIDFromPath('.story/metadata/sess-1')                 // ''
 * extractToolUseIDFromPath('')                                       // ''
 * ```
 */
export function extractToolUseIDFromPath(metadataDir: string): string {
	const parts = metadataDir.split('/');
	if (parts.length >= 2 && parts[parts.length - 2] === 'tasks') {
		return parts[parts.length - 1] ?? '';
	}
	return '';
}

/**
 * Resolve a path to its repo-relative form, then validate via
 * {@link normalizeGitTreePath}. Used by `buildTreeWithChanges` to turn the
 * absolute / cwd-relative paths reported by `git status` and the agent hook
 * into clean tree-relative paths.
 *
 * Throws if the path can't be made repo-relative or fails normalization
 * (absolute, drive-letter, contains `..`, etc.).
 */
export function normalizeRepoRelativeTreePath(repoRoot: string, p: string): string {
	const rel = toRelativePath(p, repoRoot);
	if (rel !== '' && rel !== '.') {
		return normalizeGitTreePath(rel);
	}
	return normalizeGitTreePath(p);
}

/**
 * Test whether a path exists at `absPath` — accepts **files or directories**
 * (and any other entry type that `fs.stat` resolves). Returns `false` for any
 * stat error (missing, permission denied, dangling symlink, etc.).
 *
 * Despite the name, this is a path-existence check, not a file-only check.
 * Kept named `fileExists` for backward compatibility with existing callers.
 */
export async function fileExists(absPath: string): Promise<boolean> {
	try {
		await fs.stat(absPath);
		return true;
	} catch {
		return false;
	}
}

/**
 * True iff a shadow branch exists for `(baseCommit, worktreeID)`.
 *
 * @example
 * ```ts
 * await shadowBranchExists(repoDir, 'abc1234', '')   // false (no checkpoints yet)
 * // ... writeTemporary({ baseCommit: 'abc1234', ... }) ...
 * await shadowBranchExists(repoDir, 'abc1234', '')   // true
 * ```
 */
export async function shadowBranchExists(
	repoDir: string,
	baseCommit: string,
	worktreeID: string,
): Promise<boolean> {
	const branch = shadowBranchNameForCommit(baseCommit, worktreeID);
	try {
		await git.resolveRef({ fs: fsCallback, dir: repoDir, ref: `refs/heads/${branch}` });
		return true;
	} catch {
		return false;
	}
}

/**
 * Get-or-create the shadow branch for `branchName`. If the branch already
 * exists, returns its tip commit + tree hash. If not, returns
 * `{ parentHash: ZERO_HASH, baseTreeHash: <HEAD tree hash> }` so the caller
 * can start a new orphan branch rooted at the user's current HEAD.
 *
 * Note: this does NOT create the ref on disk — it only returns the bases
 * needed to build the first commit. The actual ref write happens in
 * `writeTemporary` after the commit object is built.
 */
export async function getOrCreateShadowBranch(
	repoDir: string,
	branchName: string,
): Promise<{ parentHash: string; baseTreeHash: string }> {
	const ref = `refs/heads/${branchName}`;
	try {
		const tipOid = await git.resolveRef({ fs: fsCallback, dir: repoDir, ref });
		const { commit } = await git.readCommit({ fs: fsCallback, dir: repoDir, oid: tipOid });
		return { parentHash: tipOid, baseTreeHash: commit.tree };
	} catch {
		// Branch doesn't exist — fall back to HEAD's tree as the base.
		const headOid = await git.resolveRef({ fs: fsCallback, dir: repoDir, ref: 'HEAD' });
		const { commit: headCommit } = await git.readCommit({
			fs: fsCallback,
			dir: repoDir,
			oid: headOid,
		});
		return { parentHash: ZERO_HASH, baseTreeHash: headCommit.tree };
	}
}

/**
 * Result of {@link collectChangedFiles}.
 *
 * - `changed`: files to include in the checkpoint tree (modified, added,
 *   untracked, renamed-to, type-changed, unmerged).
 * - `deleted`: files to remove from the base tree (deleted in worktree, plus
 *   the old name of a rename).
 *
 * The two arrays are disjoint and de-duplicated.
 */
export interface ChangedFilesResult {
	changed: string[];
	deleted: string[];
}

/**
 * Run `git status --porcelain -z -uall` and parse the NUL-separated output
 * into changed / deleted file lists. Used by `writeTemporary` for the FIRST
 * checkpoint to capture the full delta against HEAD (modified tracked +
 * untracked non-ignored files; pre-existing user deletions land in `deleted`).
 *
 * Subsequent checkpoints use the agent-reported file lists directly and skip
 * this function — they don't need the full status walk.
 *
 * **R/C parsing rule** (Go: `temporary.go:1244-1261`): when status code is
 * `R` (rename) or `C` (copy), the record occupies TWO NUL segments — the new
 * name first, then the old name. We must consume both segments and only emit
 * `deleted: [oldName]` when staging is `R` (copies don't delete the source).
 *
 * Skips infrastructure paths (`.story/...`) — those belong to Story CLI's own
 * metadata writes, not the user's worktree.
 */
export async function collectChangedFiles(repoDir: string): Promise<ChangedFilesResult> {
	// Use execa directly (not execGit) — execGit calls .trim() which would strip
	// the leading SPACE character of unstaged status entries like " M tracked.txt",
	// shifting the staging/wtStatus columns and corrupting filename parsing.
	const { stdout } = await execa('git', ['status', '--porcelain', '-z', '-uall'], {
		cwd: repoDir,
	});

	const changed = new Set<string>();
	const deleted = new Set<string>();

	const entries = stdout.split('\0');
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (entry === undefined || entry.length < 3) {
			continue;
		}

		const staging = entry[0];
		const wtStatus = entry[1];
		const filename = entry.slice(3);

		// R/C: rename or copy. Both new and old names live in `entries`; we MUST
		// consume both even if we end up dropping infrastructure paths, so the
		// outer loop pointer stays aligned with the porcelain record stream.
		if (staging === 'R' || staging === 'C') {
			if (!isInfrastructurePath(filename)) {
				changed.add(filename);
			}
			const next = entries[i + 1];
			if (next !== undefined && next !== '') {
				if (staging === 'R' && !isInfrastructurePath(next)) {
					deleted.add(next);
				}
				i++;
			}
			continue;
		}

		if (isInfrastructurePath(filename)) {
			continue;
		}

		// Single-segment status codes. Order matters: D wins over wtStatus M/A;
		// untracked is the (?, ?) special case.
		if (staging === 'D' || wtStatus === 'D') {
			deleted.add(filename);
		} else if (wtStatus === 'M' || wtStatus === 'A') {
			changed.add(filename);
		} else if (staging === '?' && wtStatus === '?') {
			changed.add(filename);
		} else if (staging === 'A' || staging === 'M') {
			changed.add(filename);
		} else if (staging === 'T' || wtStatus === 'T') {
			changed.add(filename);
		} else if (staging === 'U' || wtStatus === 'U') {
			changed.add(filename);
		}
	}

	return { changed: [...changed], deleted: [...deleted] };
}

/**
 * Filter out gitignored files from `files` using `git check-ignore --no-index
 * -z --stdin`. Used by `writeTemporary` for SUBSEQUENT checkpoints, where the
 * agent hook reports candidate files that may include gitignored ones (e.g.
 * `.env` is in agent transcripts because the agent edited it).
 *
 * **Fail closed**: if `git check-ignore` errors with anything other than
 * "no files matched" (exit 1), we return `[]` so secrets in candidate files
 * stay out of the shadow branch. A missing checkpoint is preferable to a
 * leaked secret.
 *
 * Exit-code semantics:
 * - `0`: at least one file is ignored (output lists them; we filter them out)
 * - `1`: no files are ignored (return `files` unchanged)
 * - `128` (or any other): error (return `[]`)
 */
export async function filterGitIgnoredFiles(repoDir: string, files: string[]): Promise<string[]> {
	if (files.length === 0) {
		return files;
	}

	let result: { stdout: string; exitCode: number };
	try {
		const r = await execa('git', ['check-ignore', '--no-index', '-z', '--stdin'], {
			cwd: repoDir,
			input: `${files.join('\0')}\0`,
			reject: false,
		});
		result = { stdout: r.stdout, exitCode: r.exitCode ?? -1 };
	} catch (err) {
		warn(
			{ component: 'checkpoint' },
			'git check-ignore failed, excluding all files from checkpoint',
			{ error: err instanceof Error ? err.message : String(err) },
		);
		return [];
	}

	if (result.exitCode === 1) {
		return files;
	}
	if (result.exitCode !== 0) {
		warn(
			{ component: 'checkpoint' },
			'git check-ignore non-zero exit, excluding all files from checkpoint',
			{ code: result.exitCode },
		);
		return [];
	}

	const ignored = new Set(result.stdout.split('\0').filter(Boolean));
	return files.filter((f) => !ignored.has(f));
}

/**
 * Delete the shadow branch for `(baseCommit, worktreeID)`. Uses the git CLI
 * `git branch -D` rather than isomorphic-git's `deleteBranch` because the
 * latter has a known bug with packed refs (see Phase 4.1 module.md). git CLI
 * correctly removes both loose and packed entries.
 *
 * **Errors propagate** (Go parity, `temporary.go: DeleteShadowBranch`
 * ~636-647): any failure from `git branch -D`, including "branch not found",
 * is wrapped and re-thrown. Earlier TS swallowed `not found`-pattern errors
 * as silent success, but Go errors out — and a previous test
 * (`#44 deleteShadowBranch is a no-op when branch missing`) had pinned that
 * incorrect TS behaviour as if it matched Go. Aligning now; downstream
 * callers (Phase 5+ condensation) that want best-effort delete must wrap
 * with their own try/catch.
 *
 * @example
 * ```ts
 * await deleteShadowBranch(repoDir, 'abc1234', '');
 * await shadowBranchExists(repoDir, 'abc1234', '');   // false
 * ```
 */
export async function deleteShadowBranch(
	repoDir: string,
	baseCommit: string,
	worktreeID: string,
): Promise<void> {
	const branch = shadowBranchNameForCommit(baseCommit, worktreeID);
	await execGit(['branch', '-D', '--', branch], { cwd: repoDir });
}

/**
 * Result of {@link walkDirAsBlobs}: one entry per regular file under the root,
 * with its tree-relative path, blob hash, and git mode.
 */
interface WalkedFile {
	/** Path relative to `dirRel` in the resulting tree. */
	treePath: string;
	hash: string;
	mode: string;
}

/**
 * Recursively walk an absolute filesystem directory, redacting + writing each
 * non-symlink file as a git blob, and yielding `{ treePath, hash, mode }` for
 * each one. The shared core for both {@link addDirectoryToChanges} (returns
 * `TreeChange[]`) and {@link addDirectoryToEntriesWithAbsPath} (fills a Map).
 *
 * **Symlink safety** (Go: `temporary.go:890-906`):
 * - Use `fs.lstat` (NOT `fs.stat`) to inspect each entry — `lstat` returns the
 *   symlink itself, while `stat` would follow it.
 * - Skip symlinked files entirely.
 * - Skip symlinked directories: don't recurse into them. Following a symlink
 *   into `/etc` (or anywhere outside the metadata dir) would let secrets leak
 *   into the checkpoint tree.
 * - The lstat-then-isDirectory ordering is the security-critical bit: if you
 *   call `stat` and it follows the symlink, `isDirectory()` returns true and
 *   you recurse. lstat first, isSymbolicLink check, then isDirectory.
 *
 * **Path traversal**: rejects entries whose relative path starts with `..`
 * (would put the file outside the metadata dir in the tree).
 */
async function walkDirAsBlobs(
	repoDir: string,
	dirAbs: string,
	dirRel: string,
): Promise<WalkedFile[]> {
	const out: WalkedFile[] = [];

	async function recurse(currentAbs: string): Promise<void> {
		const dirEntries = await fs.readdir(currentAbs);
		for (const name of dirEntries) {
			const childAbs = path.join(currentAbs, name);
			const linfo = await fs.lstat(childAbs);

			// Symlink: skip both files and directories. (Symlinked dirs would
			// recurse outside the intended root if we followed.)
			if (linfo.isSymbolicLink()) {
				continue;
			}

			if (linfo.isDirectory()) {
				await recurse(childAbs);
				continue;
			}
			if (!linfo.isFile()) {
				continue;
			}

			const relWithinDir = path.relative(dirAbs, childAbs);
			if (relWithinDir.startsWith('..')) {
				throw new Error(`path traversal detected: ${relWithinDir}`);
			}
			// Use path.posix.join to handle trailing-slash dirRel and convert
			// platform separators to '/' for git tree paths.
			const treePath = path.posix.join(dirRel, relWithinDir.split(path.sep).join('/'));

			const { hash, mode } = await createRedactedBlobFromFile(repoDir, childAbs, treePath);
			out.push({ treePath, hash, mode });
		}
	}

	let rootInfo: import('node:fs').Stats;
	try {
		rootInfo = await fs.lstat(dirAbs);
	} catch (err) {
		// Missing / unreadable root → return empty + warn. Mirrors Go's
		// `filepath.Walk` lstat-skip semantics (Go: temporary.go:953-1003).
		warn({ component: 'checkpoint' }, 'addDirectoryTo*: root path not accessible, skipping', {
			path: dirAbs,
			error: err instanceof Error ? err.message : String(err),
		});
		return out;
	}
	if (rootInfo.isSymbolicLink()) {
		// Root itself is a symlink — refuse to follow it (matches Go behaviour).
		return out;
	}
	if (!rootInfo.isDirectory()) {
		// Regular file (or other non-dir) at the root: don't try to walk it.
		// This branch used to throw, but Go's `filepath.Walk` simply visits the
		// root once and returns — and our walker only emits files via the
		// recurse path, so a non-dir root has nothing to contribute. Return
		// empty + warn so callers get a consistent "no entries" result for any
		// non-walkable root (symlink / regular file / device / etc.).
		warn({ component: 'checkpoint' }, 'addDirectoryTo*: root is not a directory, skipping', {
			path: dirAbs,
		});
		return out;
	}

	await recurse(dirAbs);
	return out;
}

/**
 * Walk `dirAbs` and produce a `TreeChange[]` for every regular file under it,
 * keyed by `${dirRel}/<relPath>`. Used by `buildTreeWithChanges` to fold a
 * metadata directory's contents into a checkpoint tree via `applyTreeChanges`.
 *
 * Symlinks are skipped (security — don't follow into /etc/secrets, etc.) and
 * `..` path traversal in `dirRel` is rejected outright.
 */
export async function addDirectoryToChanges(
	repoDir: string,
	dirAbs: string,
	dirRel: string,
): Promise<TreeChange[]> {
	const files = await walkDirAsBlobs(repoDir, dirAbs, dirRel);
	return files.map((f) => ({
		path: f.treePath,
		entry: {
			name: path.basename(f.treePath),
			mode: f.mode,
			hash: f.hash,
			type: 'blob',
		},
	}));
}

/**
 * Walk `dirAbs` and fill `entries` with one entry per regular file, keyed by
 * full tree-relative path. Used by metadata-walking paths that prefer a
 * `Map<path, TreeEntry>` shape (e.g. `buildTreeFromEntries` consumers).
 *
 * Symlink and traversal protections are identical to {@link addDirectoryToChanges}.
 */
export async function addDirectoryToEntriesWithAbsPath(
	repoDir: string,
	dirAbs: string,
	dirRel: string,
	entries: Map<string, TreeEntry>,
): Promise<void> {
	const files = await walkDirAsBlobs(repoDir, dirAbs, dirRel);
	for (const f of files) {
		entries.set(f.treePath, {
			name: f.treePath,
			mode: f.mode,
			hash: f.hash,
			type: 'blob',
		});
	}
}

const MODE_REGULAR = '100644';
const MODE_EXEC = '100755';

/**
 * Read a file from disk, persist its raw bytes as a git blob, and return the
 * blob's SHA + the git mode (regular vs executable derived from POSIX 0o111).
 *
 * **Safety**: this does NOT redact. Use it for **code files only**. Any file
 * under `.story/metadata/` (transcripts, prompts, attribution payloads, …)
 * MUST go through {@link createRedactedBlobFromFile} (in
 * [`git-objects.ts`](./git-objects.ts)) so secrets are scrubbed before they
 * land on a branch that may be pushed to a remote.
 *
 * The function name carries the `Raw` prefix specifically so a typo (e.g.
 * tab-completing `createBlobFromFile`) doesn't silently fall back to the
 * unredacted variant when the caller meant to redact. `createRawBlobFromFile`
 * vs `createRedactedBlobFromFile` is the safety contract.
 */
export async function createRawBlobFromFile(
	repoDir: string,
	absPath: string,
): Promise<{ hash: string; mode: string }> {
	const stat = await fs.stat(absPath);
	const mode = (stat.mode & 0o111) !== 0 ? MODE_EXEC : MODE_REGULAR;
	const raw = await fs.readFile(absPath);
	const hash = await createBlobFromContent(repoDir, new Uint8Array(raw));
	return { hash, mode };
}

/**
 * Build a checkpoint tree by applying a set of file changes to `baseTreeHash`
 * via {@link applyTreeChanges} (sparse tree-surgery — only paths along touched
 * branches get rewritten, sibling subtrees keep their original hashes).
 *
 * Inputs:
 * - `modifiedFiles`: repo-relative paths of files to add or update. If a file
 *   no longer exists on disk (e.g. deleted between `git status` and now), it
 *   is treated as a deletion.
 * - `deletedFiles`: repo-relative paths of files to remove from the base tree.
 * - `metadataDir` / `metadataDirAbs`: optional metadata directory. When both
 *   non-empty, all files under `metadataDirAbs` are walked (symlinks skipped)
 *   and folded into the tree at `metadataDir`.
 *
 * Repo-relative path normalization is enforced via
 * {@link normalizeRepoRelativeTreePath}; bad paths are skipped with a warning.
 */
export async function buildTreeWithChanges(
	repoDir: string,
	baseTreeHash: string,
	modifiedFiles: string[],
	deletedFiles: string[],
	metadataDir: string,
	metadataDirAbs: string,
): Promise<string> {
	const changes: TreeChange[] = [];

	// Deleted files first — `entry: null` triggers deletion in applyTreeChanges.
	for (const file of deletedFiles) {
		let relPath: string;
		try {
			relPath = normalizeRepoRelativeTreePath(repoDir, file);
		} catch (err) {
			warn({ component: 'checkpoint' }, 'skipping invalid git tree path', {
				operation: 'delete shadow branch entry',
				path: file,
				error: err instanceof Error ? err.message : String(err),
			});
			continue;
		}
		changes.push({ path: relPath, entry: null });
	}

	// Modified / new files — read from disk → blob.
	for (const file of modifiedFiles) {
		let relPath: string;
		try {
			relPath = normalizeRepoRelativeTreePath(repoDir, file);
		} catch (err) {
			warn({ component: 'checkpoint' }, 'skipping invalid git tree path', {
				operation: 'add shadow branch entry',
				path: file,
				error: err instanceof Error ? err.message : String(err),
			});
			continue;
		}

		const absPath = path.join(repoDir, relPath);
		if (!(await fileExists(absPath))) {
			// File disappeared since detection — treat as deletion to keep the
			// tree consistent with the actual worktree.
			changes.push({ path: relPath, entry: null });
			continue;
		}

		try {
			const { hash, mode } = await createRawBlobFromFile(repoDir, absPath);
			changes.push({
				path: relPath,
				entry: { name: path.basename(relPath), mode, hash, type: 'blob' },
			});
		} catch {
			// Skip files that can't be staged (race with deletion, perms, etc.).
		}
	}

	// Metadata directory — fold all its files in via the symlink-safe walker.
	//
	// **Fail-closed** (Go parity): if the metadata walk errors (IO permission,
	// blob write failure, walker rejection of a path), we propagate. An earlier
	// version warn-then-continued, which would let writeTemporary write a
	// "successful" shadow commit with NO transcript / metadata in its tree —
	// downstream rewind / explain would then see an empty checkpoint and the
	// user would lose their session record. Better to fail the whole write so
	// the caller can retry or surface the error.
	//
	// Go reference: `entire-cli/cmd/entire/cli/checkpoint/temporary.go`
	// `buildTreeWithChanges` — `addDirectoryToChanges` errors are returned as
	// `failed to add metadata directory: %w`.
	if (metadataDir !== '' && metadataDirAbs !== '') {
		const metaRel = normalizeRepoRelativeTreePath(repoDir, metadataDir);
		const metaChanges = await addDirectoryToChanges(repoDir, metadataDirAbs, metaRel);
		changes.push(...metaChanges);
	}

	return applyTreeChanges(repoDir, baseTreeHash, changes);
}

/**
 * Write a temporary (shadow branch) checkpoint.
 *
 * - Validates `baseCommit` and `sessionId` upfront.
 * - Resolves (or creates) the shadow branch via {@link getOrCreateShadowBranch}.
 * - For the FIRST checkpoint on this branch (`isFirstCheckpoint: true`),
 *   collects the full delta against HEAD via {@link collectChangedFiles}
 *   (modified tracked + untracked non-ignored + pre-existing user deletions).
 * - For SUBSEQUENT checkpoints, uses the agent-reported lists, filtering
 *   gitignored entries via {@link filterGitIgnoredFiles}.
 * - Builds the new tree via {@link buildTreeWithChanges}.
 * - **Dedups** by tree hash: if the new tree matches the previous checkpoint's
 *   tree, returns `{ skipped: true }` and writes nothing.
 * - Otherwise writes a commit (with the trailer-augmented message from
 *   {@link formatShadowCommit}) and updates the shadow branch ref.
 *
 * Throws on empty `baseCommit` or invalid `sessionId`. The agent layer should
 * have validated these before calling, but we re-check here to fail fast.
 *
 * @example
 * ```ts
 * const result = await writeTemporary(repoDir, {
 *   sessionId: 'sess-1',
 *   baseCommit: 'abc1234567890',
 *   worktreeId: '',                          // main worktree
 *   modifiedFiles: ['src/app.ts'],
 *   newFiles: [],
 *   deletedFiles: [],
 *   metadataDir: '.story/metadata/sess-1',   // Story-CLI-generated transcript dir
 *   metadataDirAbs: '/abs/path/.story/metadata/sess-1',
 *   commitMessage: 'Checkpoint',
 *   authorName: 'Story CLI',
 *   authorEmail: 'story@local',
 *   isFirstCheckpoint: false,
 * });
 * // returns: { commitHash: 'def5678...', skipped: false }
 * //   (or { commitHash: <previous>, skipped: true } if tree hash unchanged)
 *
 * // Side effects in `<repoDir>/.git/`:
 * //   objects/de/f5678...                       ← new commit object
 * //   objects/<tree-hash>                       ← new root tree (sparse-rewritten
 * //                                                from base via applyTreeChanges)
 * //   objects/<blob-hash>                       ← blob for src/app.ts contents
 * //   objects/<...>                             ← blobs for files under metadataDir
 * //   refs/heads/story/abc1234-e3b0c4 → def5678...   (shadow branch ref bumped)
 * //
 * // NOT touched: worktree files, .git/index, .git/HEAD, user's branch refs.
 * //
 * // On dedup hit (skipped: true): NO objects written, NO ref change.
 * //
 * // On error (validation throw OR git failure mid-write): no shadow branch ref
 * // update, but blob/tree objects already written stay in .git/objects/ as
 * // unreachable garbage (collected by `git gc` eventually).
 * ```
 */
export async function writeTemporary(
	repoDir: string,
	opts: WriteTemporaryOptions,
): Promise<WriteTemporaryResult> {
	if (opts.baseCommit === '') {
		throw new Error('BaseCommit is required for temporary checkpoint');
	}
	const sessionErr = validateSessionId(opts.sessionId);
	if (sessionErr !== null) {
		throw new Error(`invalid temporary checkpoint options: ${sessionErr.message}`);
	}

	const branchName = shadowBranchNameForCommit(opts.baseCommit, opts.worktreeId);
	const { parentHash, baseTreeHash } = await getOrCreateShadowBranch(repoDir, branchName);

	// Last tree hash for dedup. Only meaningful when parent exists.
	let lastTreeHash = ZERO_HASH;
	if (parentHash !== ZERO_HASH) {
		try {
			const { commit } = await git.readCommit({
				fs: fsCallback,
				dir: repoDir,
				oid: parentHash,
			});
			lastTreeHash = commit.tree;
		} catch {
			// Treat as no previous tree — fall through to the regular path.
		}
	}

	let allFiles: string[];
	let allDeletedFiles: string[];
	if (opts.isFirstCheckpoint) {
		// First checkpoint: capture the full delta against HEAD via git status.
		const result = await collectChangedFiles(repoDir);
		allFiles = result.changed;
		// Merge user's pre-existing deletions with agent's reported deletions.
		allDeletedFiles = [...result.deleted, ...opts.deletedFiles];
	} else {
		// Subsequent: hook-reported modified + new files, filtered for .gitignore.
		const candidates = [...opts.modifiedFiles, ...opts.newFiles];
		allFiles = await filterGitIgnoredFiles(repoDir, candidates);
		allDeletedFiles = opts.deletedFiles;
	}

	const treeHash = await buildTreeWithChanges(
		repoDir,
		baseTreeHash,
		allFiles,
		allDeletedFiles,
		opts.metadataDir,
		opts.metadataDirAbs,
	);

	// Dedup: identical tree → no new commit.
	if (lastTreeHash !== ZERO_HASH && treeHash === lastTreeHash) {
		return { commitHash: parentHash, skipped: true };
	}

	const commitMsg = formatShadowCommit(opts.commitMessage, opts.metadataDir, opts.sessionId);
	const commitHash = await createCommit(
		repoDir,
		treeHash,
		parentHash,
		commitMsg,
		opts.authorName,
		opts.authorEmail,
	);

	await git.writeRef({
		fs: fsCallback,
		dir: repoDir,
		ref: `refs/heads/${branchName}`,
		value: commitHash,
		force: true,
	});

	return { commitHash, skipped: false };
}

/**
 * Convert isomorphic-git's commit author timestamp (UTC seconds) to an ISO
 * 8601 string in UTC (`...Z`).
 *
 * Note: the `tzOffset` parameter is intentionally unused. `timestamp` is
 * already UTC seconds, so the canonical instant is just
 * `new Date(timestamp * 1000).toISOString()`. We do not preserve the original
 * local-tz offset in the API response — callers that need it can read
 * `commit.author.timezoneOffset` directly off the underlying commit object.
 *
 * Earlier versions did `utcMs - tzOffset * 60 * 1000` which mistakenly
 * relabelled wall-clock local time as UTC (a UTC+8 commit at local 22:00 came
 * out as the next day 06:00Z). This fix returns the actual UTC instant.
 */
function commitTimestampToISO(timestamp: number, _tzOffset: number): string {
	return new Date(timestamp * 1000).toISOString();
}

/**
 * Read the latest checkpoint from a shadow branch. Returns `null` when the
 * branch doesn't exist (expected for newly-started sessions).
 *
 * Extracts the session ID + metadata dir from the tip commit's trailers
 * (written by `formatShadowCommit` in `writeTemporary`).
 */
export async function readTemporary(
	repoDir: string,
	baseCommit: string,
	worktreeId: string,
): Promise<ReadTemporaryResult | null> {
	const branch = shadowBranchNameForCommit(baseCommit, worktreeId);
	let tipOid: string;
	try {
		tipOid = await git.resolveRef({
			fs: fsCallback,
			dir: repoDir,
			ref: `refs/heads/${branch}`,
		});
	} catch {
		return null;
	}

	const { commit } = await git.readCommit({ fs: fsCallback, dir: repoDir, oid: tipOid });

	return {
		commitHash: tipOid,
		treeHash: commit.tree,
		sessionId: parseSession(commit.message) ?? '',
		metadataDir: parseMetadata(commit.message) ?? '',
		timestamp: commitTimestampToISO(commit.author.timestamp, commit.author.timezoneOffset),
	};
}

/** Branch refs that share the `story/` prefix but are NOT shadow branches. */
const NON_SHADOW_STORY_BRANCHES = new Set(['story/checkpoints/v1', 'story/checkpoints/v2']);

/**
 * List all shadow branches in the repo. Filters refs by the `story/` prefix
 * and explicitly excludes the metadata branches (`story/checkpoints/v1` and
 * `v2`) — those are NOT per-`(base, worktree)` shadow refs, they're permanent
 * append-only metadata storage (Phase 4.3).
 */
export async function listTemporary(repoDir: string): Promise<TemporaryInfo[]> {
	const branches = await git.listBranches({ fs: fsCallback, dir: repoDir });

	const out: TemporaryInfo[] = [];
	for (const branchName of branches) {
		if (!branchName.startsWith(SHADOW_BRANCH_PREFIX)) {
			continue;
		}
		if (NON_SHADOW_STORY_BRANCHES.has(branchName)) {
			continue;
		}

		let tipOid: string;
		try {
			tipOid = await git.resolveRef({
				fs: fsCallback,
				dir: repoDir,
				ref: `refs/heads/${branchName}`,
			});
		} catch {
			continue;
		}

		let commit: import('isomorphic-git').CommitObject;
		try {
			const result = await git.readCommit({ fs: fsCallback, dir: repoDir, oid: tipOid });
			commit = result.commit;
		} catch {
			continue;
		}

		const parsed = parseShadowBranchName(branchName);
		out.push({
			branchName,
			baseCommit: parsed?.commitPrefix ?? '',
			latestCommit: tipOid,
			sessionId: parseSession(commit.message) ?? '',
			timestamp: commitTimestampToISO(commit.author.timestamp, commit.author.timezoneOffset),
		});
	}

	return out;
}

/**
 * Walk the commit log of a shadow branch, returning up to `limit` checkpoints
 * matching `sessionId`. If `sessionId` is the empty string, returns all
 * checkpoints regardless of session.
 *
 * Implementation note: scans up to `limit * 5` commits to leave headroom for
 * the session filter (matches Go's `errStop` short-circuit pattern). Uses
 * isomorphic-git's `git.log({ depth })` which returns an array — no need for
 * a sentinel error to break iteration; just `break` out of the loop.
 */
export async function listCheckpointsForBranch(
	repoDir: string,
	branchName: string,
	sessionId: string,
	limit: number,
): Promise<TemporaryCheckpointInfo[]> {
	let log: Awaited<ReturnType<typeof git.log>>;
	try {
		log = await git.log({
			fs: fsCallback,
			dir: repoDir,
			ref: `refs/heads/${branchName}`,
			depth: limit * 5,
		});
	} catch {
		return [];
	}

	const out: TemporaryCheckpointInfo[] = [];
	for (const { oid, commit } of log) {
		if (out.length >= limit) {
			break;
		}

		const commitSessionId = parseSession(commit.message);
		// Skip commits with no Session trailer OR empty trailer value (Go's
		// listCheckpointsForBranch effectively does the same — it can't filter
		// by an empty session id).
		if (commitSessionId === null || commitSessionId === '') {
			continue;
		}
		if (sessionId !== '' && commitSessionId !== sessionId) {
			continue;
		}

		// First line of message — git log style summary.
		const newlineIdx = commit.message.indexOf('\n');
		const summary = newlineIdx > 0 ? commit.message.slice(0, newlineIdx) : commit.message;

		const taskMetadataDir = parseTaskMetadata(commit.message);
		const isTaskCheckpoint = taskMetadataDir !== null;
		const metadataDir = isTaskCheckpoint
			? (taskMetadataDir as string)
			: (parseMetadata(commit.message) ?? '');
		const toolUseId = isTaskCheckpoint ? extractToolUseIDFromPath(taskMetadataDir as string) : '';

		out.push({
			commitHash: oid,
			message: summary,
			sessionId: commitSessionId,
			metadataDir,
			isTaskCheckpoint,
			toolUseId,
			timestamp: commitTimestampToISO(commit.author.timestamp, commit.author.timezoneOffset),
		});
	}

	return out;
}

/**
 * Sentinel error thrown by {@link getTranscriptFromCommit} when no transcript
 * is found in the commit tree (neither chunked, single-file, nor legacy
 * `full.log`). Callers catch this to distinguish "no transcript here" from
 * "git error reading the commit".
 */
export class ErrNoTranscript extends Error {
	constructor(message = 'no transcript in commit tree') {
		super(message);
		this.name = 'ErrNoTranscript';
	}
}

const TRANSCRIPT_FILE_NAMES = ['full.jsonl', 'transcript.jsonl'];
const LEGACY_TRANSCRIPT_FILE_NAME = 'full.log';
/**
 * Chunked transcript suffix regex.
 *
 * **Convention** (mirrors Go upstream `entire-cli/cmd/entire/cli/agent/chunking.go`):
 * chunk files are zero-padded to **at least 3 digits** — `full.jsonl.001`,
 * `.002`, ..., `.010`, ..., `.100`, `.999`, `.1000`. The minimum width of 3
 * keeps the lexical sort order aligned with numeric order for the first 999
 * chunks (the realistic upper bound) and matches what the Go writer emits, so
 * non-standard names like `full.jsonl.1` / `.99` are intentionally NOT matched
 * (any agent emitting them would be writing in a format Go can't read either).
 *
 * Sort happens numerically anyway via `Number.parseInt` below, so wider names
 * (4+ digits) are also safe.
 */
const CHUNK_SUFFIX_RE = /^(.+)\.(\d{3,})$/;

/**
 * Read a transcript file out of a tree at `metadataDir`. Handles both single-
 * file transcripts (`full.jsonl` / `transcript.jsonl`) and chunked transcripts
 * (`full.jsonl.001`, `.002`, ...). Returns `null` if no transcript files are
 * present (caller falls back to `full.log` legacy filename).
 *
 * **Precedence (Go parity)**: scan for chunk files **first**. If any chunks
 * exist, reassemble them — using the base file (e.g. `full.jsonl`) as
 * implicit chunk 0 if it also exists. Only when there are zero chunk files
 * do we fall back to a lone single-file transcript. This matters because
 * partial-write / migration / tooling transient states can produce a tree
 * containing both `full.jsonl` AND `full.jsonl.001+`; Go-side reads such
 * trees by reassembling, and TS must do the same so the bytes round-trip
 * cross-CLI.
 *
 * Go reference: `entire-cli/.../checkpoint/committed.go: readTranscriptFromTree`
 * scans entries first, computes `len(chunkFiles) > 0`, reassembles.
 *
 * **Chunking dispatch (Phase 6.1)**: chunks are sorted by filename suffix
 * (numeric ascending), then handed to `@/agent/chunking.reassembleTranscript`
 * which dispatches per agent. Agents whose chunker uses non-JSONL formatting
 * get format-aware reassembly; unknown agents fall through to JSONL `\n`-join
 * (matches Go `agent.ReassembleJSONL`).
 */
export async function readTranscriptFromTree(
	repoDir: string,
	treeHash: string,
	metadataDir: string,
	agentType: string,
): Promise<Uint8Array | null> {
	let subTree: Awaited<ReturnType<typeof git.readTree>>;
	try {
		subTree = await git.readTree({
			fs: fsCallback,
			dir: repoDir,
			oid: treeHash,
			filepath: metadataDir,
		});
	} catch {
		return null;
	}

	// Pass 1: collect chunk files (`<base>.NNN` for any TRANSCRIPT_FILE_NAMES base).
	// Each transcript-file basename gets its own chunk bucket so we can match the
	// base file (chunk 0) to the right family at the end.
	const chunksByBase = new Map<string, Array<{ index: number; oid: string }>>();
	for (const entry of subTree.tree) {
		if (entry.type !== 'blob') {
			continue;
		}
		const m = CHUNK_SUFFIX_RE.exec(entry.path);
		if (m === null) {
			continue;
		}
		const baseName = m[1];
		const indexStr = m[2];
		/* c8 ignore start — defensive: regex `^(.+)\.(\d{3,})$` guarantees both groups exist. */
		if (baseName === undefined || indexStr === undefined) {
			continue;
		}
		/* c8 ignore stop */
		if (!TRANSCRIPT_FILE_NAMES.includes(baseName)) {
			continue;
		}
		const index = Number.parseInt(indexStr, 10);
		/* c8 ignore start — defensive: regex `\d{3,}` already guarantees parseInt succeeds. */
		if (Number.isNaN(index)) {
			continue;
		}
		/* c8 ignore stop */
		const existing = chunksByBase.get(baseName) ?? [];
		existing.push({ index, oid: entry.oid });
		chunksByBase.set(baseName, existing);
	}

	// Pass 2: chunks exist → reassemble (with optional base file as chunk 0).
	for (const name of TRANSCRIPT_FILE_NAMES) {
		const chunks = chunksByBase.get(name);
		if (chunks === undefined || chunks.length === 0) {
			continue;
		}
		// If a base file (no suffix) also exists, prepend it as implicit chunk 0.
		const baseEntry = subTree.tree.find((e) => e.path === name && e.type === 'blob');
		const allChunks = [...chunks];
		if (baseEntry !== undefined) {
			allChunks.push({ index: 0, oid: baseEntry.oid });
		}
		allChunks.sort((a, b) => a.index - b.index);

		const parts: Uint8Array[] = [];
		for (const c of allChunks) {
			const { blob } = await git.readBlob({ fs: fsCallback, dir: repoDir, oid: c.oid });
			parts.push(blob);
		}
		// Phase 6.1: dispatch via @/agent/chunking — known agents reassemble in
		// their native format; unknown agents fall through to JSONL `\n`-join.
		// Mirrors Go `committed.go: readTranscriptFromTree` which calls
		// `agent.ReassembleTranscript(chunks, agentType)`.
		const reassembled = await reassembleTranscript(parts, agentType);
		return reassembled;
	}

	// Pass 3: no chunks at all → fall back to lone single-file transcript.
	for (const name of TRANSCRIPT_FILE_NAMES) {
		const entry = subTree.tree.find((e) => e.path === name && e.type === 'blob');
		if (entry !== undefined) {
			const { blob } = await git.readBlob({ fs: fsCallback, dir: repoDir, oid: entry.oid });
			return blob;
		}
	}

	return null;
}

/**
 * Read the transcript stored under `metadataDir` inside the tree of
 * `commitHash`. Tries (in order): chunked / single-file via
 * {@link readTranscriptFromTree}, then the legacy `full.log` filename.
 *
 * Throws {@link ErrNoTranscript} when no transcript file is found in the
 * tree. Re-throws other errors (corrupt git state, missing commit, etc.).
 *
 * Phase 6.1 wires per-agent dispatch via `@/agent/chunking.reassembleTranscript`;
 * the legacy single-blob fallback is still used when no chunks are found.
 */
export async function getTranscriptFromCommit(
	repoDir: string,
	commitHash: string,
	metadataDir: string,
	agentType: string,
): Promise<Uint8Array> {
	const { commit } = await git.readCommit({
		fs: fsCallback,
		dir: repoDir,
		oid: commitHash,
	});

	const fromChunks = await readTranscriptFromTree(repoDir, commit.tree, metadataDir, agentType);
	if (fromChunks !== null) {
		return fromChunks;
	}

	// Legacy fallback: `<metadataDir>/full.log` written by older Story CLI versions.
	try {
		const legacy = await git.readBlob({
			fs: fsCallback,
			dir: repoDir,
			oid: commit.tree,
			filepath: `${metadataDir}/${LEGACY_TRANSCRIPT_FILE_NAME}`,
		});
		return legacy.blob;
	} catch {
		throw new ErrNoTranscript(`no transcript in commit ${commitHash} at ${metadataDir}`);
	}
}

/** Convenience: derive the branch name from `(baseCommit, worktreeId)` then delegate. */
export async function listTemporaryCheckpoints(
	repoDir: string,
	baseCommit: string,
	worktreeId: string,
	sessionId: string,
	limit: number,
): Promise<TemporaryCheckpointInfo[]> {
	const branch = shadowBranchNameForCommit(baseCommit, worktreeId);
	return listCheckpointsForBranch(repoDir, branch, sessionId, limit);
}

/**
 * List checkpoints from ALL shadow branches matching `sessionId`. Used by the
 * rewind / explain commands when the user's HEAD has advanced since the
 * session started — they don't know which `baseCommit` the original shadow
 * branch was based on, so they have to scan everything.
 */
export async function listAllTemporaryCheckpoints(
	repoDir: string,
	sessionId: string,
	limit: number,
): Promise<TemporaryCheckpointInfo[]> {
	const branches = await listTemporary(repoDir);

	const out: TemporaryCheckpointInfo[] = [];
	for (const branch of branches) {
		const remaining = limit - out.length;
		if (remaining <= 0) {
			break;
		}
		const cps = await listCheckpointsForBranch(repoDir, branch.branchName, sessionId, remaining);
		out.push(...cps);
	}

	return out.slice(0, limit);
}

/**
 * Add task (subagent) metadata to a tree. Two paths:
 *
 * - **incremental** (`isIncremental: true`): writes a single
 *   `<taskMetadataDir>/checkpoints/<NNN>-<toolUseId>.json` file with the
 *   incremental payload (after redaction). Used during a Task tool's
 *   in-flight progress updates.
 * - **final** (`isIncremental: false`): writes the full task transcript
 *   (chunked-aware), the optional subagent transcript, and a
 *   `<taskMetadataDir>/checkpoint.json` summary file. Used when the Task
 *   tool returns.
 *
 * Phase 6.1 wires per-agent dispatch via `@/agent/chunking.chunkTranscript`:
 * task transcripts that exceed `MAX_CHUNK_SIZE` (50 MB) are split into
 * multiple `full.jsonl` / `full.jsonl.001` / ... blobs. Without a known
 * agent type at write time we fall through to JSONL line-boundary chunking
 * (default behavior for Claude Code / Cursor / Vogon and unknown agents).
 *
 * Mirrors Go `temporary.go: addTaskMetadataToTree`.
 *
 * @example
 * ```ts
 * await addTaskMetadataToTree(repoDir, baseTreeHash, {
 *   sessionId: 'sess-1', toolUseId: 'tu-1', isIncremental: false,
 *   transcriptPath: '/repo/.story/transcripts/abc.jsonl',
 *   subagentTranscriptPath: '', agentId: '',
 *   ...other opts...
 * });
 * // returns: <new tree hash> (string)
 * //
 * // Side effects (final path):
 * //   .git/objects/...             ← N transcript blobs (one per chunk)
 * //   .git/objects/...             ← optional subagent transcript blob
 * //   .git/objects/...             ← checkpoint.json summary blob
 * //   .git/objects/...             ← updated tree(s) for new dir entries
 * //
 * // Disk / refs / HEAD / index: unchanged. Caller is responsible for
 * // committing the new tree hash to a ref.
 * ```
 */
export async function addTaskMetadataToTree(
	repoDir: string,
	baseTreeHash: string,
	opts: WriteTemporaryTaskOptions,
): Promise<string> {
	const sessionMetadataDir = `${STORY_METADATA_DIR_NAME}/${opts.sessionId}`;
	const taskMetadataDir = `${sessionMetadataDir}/tasks/${opts.toolUseId}`;

	const changes: TreeChange[] = [];

	if (opts.isIncremental) {
		const { bytes: redactedData } = await redactJSONLBytes(opts.incrementalData);
		// Use a JSON.RawMessage equivalent: parse-and-re-embed if possible, else
		// fall back to a string. The JSON shape is:
		//   { type, tool_use_id, timestamp, data }
		// Where `data` should be the parsed JSON if redactedData is valid JSON.
		let parsedData: unknown = null;
		const text = new TextDecoder().decode(redactedData);
		if (text.trim() !== '') {
			try {
				parsedData = JSON.parse(text);
			} catch {
				// Not valid JSON — embed as a string.
				parsedData = text;
			}
		}
		const payload = {
			type: opts.incrementalType,
			tool_use_id: opts.toolUseId,
			timestamp: new Date().toISOString(),
			data: parsedData,
		};
		const cpJson = `${JSON.stringify(payload, null, 2)}\n`;
		const cpBlob = await createBlobFromContent(repoDir, new TextEncoder().encode(cpJson));
		const cpFilename = `${String(opts.incrementalSequence).padStart(3, '0')}-${opts.toolUseId}.json`;
		const cpPath = `${taskMetadataDir}/checkpoints/${cpFilename}`;
		changes.push({
			path: cpPath,
			entry: { name: cpFilename, mode: '100644', hash: cpBlob, type: 'blob' },
		});
	} else {
		// Final checkpoint: transcripts (if present) + checkpoint.json summary.

		// Session transcript — Phase 6.1 wires per-agent dispatch via
		// @/agent/chunking. Mirrors Go `temporary.go: addTaskMetadataToTree`
		// (354-383): detect-then-chunk. Transcripts ≤ MAX_CHUNK_SIZE produce a
		// single base file (`full.jsonl`); larger transcripts split into
		// `full.jsonl.001` / `.002` / ... blobs.
		if (opts.transcriptPath !== '') {
			try {
				const raw = await fs.readFile(opts.transcriptPath);
				const transcriptContent = new Uint8Array(raw);
				let chunks: Uint8Array[];
				try {
					chunks = await agentChunkTranscript(transcriptContent, '');
				} catch (chunkErr) {
					warn(
						{ component: 'checkpoint' },
						'failed to chunk transcript, checkpoint will be saved without transcript',
						{
							sessionId: opts.sessionId,
							error: chunkErr instanceof Error ? chunkErr.message : String(chunkErr),
						},
					);
					chunks = [];
				}
				for (let i = 0; i < chunks.length; i++) {
					const chunk = chunks[i]!;
					const blobOid = await createBlobFromContent(repoDir, chunk);
					const chunkName = chunkFileName('full.jsonl', i);
					changes.push({
						path: `${sessionMetadataDir}/${chunkName}`,
						entry: { name: chunkName, mode: '100644', hash: blobOid, type: 'blob' },
					});
				}
			} catch (err) {
				warn({ component: 'checkpoint' }, 'failed to read task transcript, skipping', {
					sessionId: opts.sessionId,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}

		// Subagent transcript (redacted as JSONL) → <taskMetadataDir>/agent-<agentId>.jsonl.
		if (opts.subagentTranscriptPath !== '' && opts.agentId !== '') {
			try {
				const raw = await fs.readFile(opts.subagentTranscriptPath);
				const { bytes: redacted } = await redactJSONLBytes(new Uint8Array(raw));
				const blobOid = await createBlobFromContent(repoDir, redacted);
				const aFilename = `agent-${opts.agentId}.jsonl`;
				changes.push({
					path: `${taskMetadataDir}/${aFilename}`,
					entry: { name: aFilename, mode: '100644', hash: blobOid, type: 'blob' },
				});
			} catch (err) {
				warn({ component: 'checkpoint' }, 'failed to read subagent transcript, skipping', {
					sessionId: opts.sessionId,
					agentId: opts.agentId,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}

		// checkpoint.json summary — always written.
		const cpJson = `${JSON.stringify(
			{
				session_id: opts.sessionId,
				tool_use_id: opts.toolUseId,
				checkpoint_uuid: opts.checkpointUuid,
				agent_id: opts.agentId,
			},
			null,
			2,
		)}\n`;
		const cpBlob = await createBlobFromContent(repoDir, new TextEncoder().encode(cpJson));
		changes.push({
			path: `${taskMetadataDir}/checkpoint.json`,
			entry: { name: 'checkpoint.json', mode: '100644', hash: cpBlob, type: 'blob' },
		});
	}

	return applyTreeChanges(repoDir, baseTreeHash, changes);
}

/**
 * Write a temporary checkpoint produced by a subagent / Task-tool invocation.
 *
 * Differences from {@link writeTemporary}:
 *
 * - Validates `toolUseId` and `agentId` in addition to `sessionId`.
 * - File-collection skips the `git status` first-checkpoint path — task
 *   checkpoints always treat the agent-reported file lists as authoritative
 *   and run them through `filterGitIgnoredFiles`.
 * - After building the code-changes tree, layers task metadata onto it via
 *   {@link addTaskMetadataToTree}.
 * - Uses `opts.commitMessage` directly as the commit message — no
 *   `formatShadowTaskCommit` trailer wrapping (that's the strategy layer's
 *   concern; lands in Phase 5.2).
 *
 * **Caller contract — `commitMessage` MUST contain a `Story-Session: <sessionId>`
 * trailer.** {@link listCheckpointsForBranch} (and downstream
 * {@link listTemporaryCheckpoints} / {@link listAllTemporaryCheckpoints})
 * filter commits without a parsable session trailer via {@link parseSession},
 * so a bare `commitMessage` will silently disappear from listings — the commit
 * still gets written, but no consumer can find it. The strategy layer
 * (Phase 5.2) is responsible for assembling the trailer; this function does
 * NOT inject it for you. If you need a task-flavoured trailer (e.g.
 * `Story-Metadata-Task:`), include it here too.
 */
export async function writeTemporaryTask(
	repoDir: string,
	opts: WriteTemporaryTaskOptions,
): Promise<string> {
	if (opts.baseCommit === '') {
		throw new Error('BaseCommit is required for task checkpoint');
	}
	const sessionErr = validateSessionId(opts.sessionId);
	if (sessionErr !== null) {
		throw new Error(`invalid task checkpoint options: ${sessionErr.message}`);
	}
	const toolUseErr = validateToolUseID(opts.toolUseId);
	if (toolUseErr !== null) {
		throw new Error(`invalid task checkpoint options: ${toolUseErr.message}`);
	}
	const agentErr = validateAgentID(opts.agentId);
	if (agentErr !== null) {
		throw new Error(`invalid task checkpoint options: ${agentErr.message}`);
	}

	const branchName = shadowBranchNameForCommit(opts.baseCommit, opts.worktreeId);
	const { parentHash, baseTreeHash } = await getOrCreateShadowBranch(repoDir, branchName);

	const candidates = [...opts.modifiedFiles, ...opts.newFiles];
	const allFiles = await filterGitIgnoredFiles(repoDir, candidates);

	// Code changes only — no metadata dir on this pass; metadata is layered on
	// next via addTaskMetadataToTree.
	const codeTree = await buildTreeWithChanges(
		repoDir,
		baseTreeHash,
		allFiles,
		opts.deletedFiles,
		'',
		'',
	);
	const finalTree = await addTaskMetadataToTree(repoDir, codeTree, opts);

	const commitHash = await createCommit(
		repoDir,
		finalTree,
		parentHash,
		opts.commitMessage,
		opts.authorName,
		opts.authorEmail,
	);

	await git.writeRef({
		fs: fsCallback,
		dir: repoDir,
		ref: `refs/heads/${branchName}`,
		value: commitHash,
		force: true,
	});

	return commitHash;
}
