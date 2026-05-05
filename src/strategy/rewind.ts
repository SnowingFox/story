/**
 * Phase 5.5 rewind / previewRewind / canRewind implementations.
 *
 * `Rewind` restores a checkpoint's tree to the worktree (deletes
 * untracked-not-in-cp files, restores all checkpoint blobs, resets the
 * shadow branch HEAD). `PreviewRewind` is a dry-run (no writes).
 * `CanRewind` delegates to {@link checkCanRewindWithWarning}.
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/strategy/manual_commit_rewind.go`
 * (`Rewind` / `PreviewRewind` / `CanRewind` / `resetShadowBranchToCheckpoint`).
 *
 * @packageDocumentation
 */

import fsCallback from 'node:fs';
import git from 'isomorphic-git';
import { shadowBranchNameForCommit } from '../checkpoint/temporary';
import { execGit } from '../git';
import { removeInRoot, STORY_METADATA_DIR_NAME, worktreeRoot, writeFileInRoot } from '../paths';
import { parseSession } from '../trailers';
import { getStderrWriter } from './hooks-tty';
import type { ManualCommitStrategy } from './manual-commit';
import type { Repository } from './repo';
import {
	checkCanRewindWithWarning,
	collectUntrackedFiles as collectUntrackedFilesImpl,
	isProtectedPath,
} from './rewind-helpers';
import type { RewindPoint, RewindPreview, SessionState } from './types';

/**
 * Module-level dispatch namespace for {@link collectUntrackedFiles} so
 * tests can swap it out without intercepting an internal call. Production
 * code goes through the real `rewind-helpers.collectUntrackedFiles`;
 * tests override via {@link setCollectUntrackedFilesForTesting}.
 *
 * Mirrors the Phase 5.5 `agentDispatch` / `promptDispatch` pattern from
 * [`./restore-logs.ts`](./restore-logs.ts).
 *
 * @internal
 */
const collectUntrackedFilesDispatch: { collect: (repoDir: string) => Promise<string[]> } = {
	collect: collectUntrackedFilesImpl,
};

/**
 * Test override hook: replace the `collectUntrackedFiles` callback used
 * by {@link rewindImpl} and {@link previewRewindImpl}. Pass `null` to
 * restore the default. Used to inject `git ls-files` failures so tests
 * can verify the Go-equivalent stderr warning ({@link previewRewindImpl}
 * Fix #2).
 */
export function setCollectUntrackedFilesForTesting(
	collect: ((repoDir: string) => Promise<string[]>) | null,
): void {
	collectUntrackedFilesDispatch.collect = collect ?? collectUntrackedFilesImpl;
}

/**
 * Implements the `rewind` action: restore worktree files from a checkpoint
 * commit's tree + reset the shadow branch HEAD to that commit.
 *
 * Mirrors Go `manual_commit_rewind.go: Rewind`.
 *
 * 6-step pipeline (see [module.md "Rewind 6 steps"](../../docs/ts-rewrite/impl/phase-5-strategy/phase-5.5-rewind-reset/module.md)):
 *   1. read commit + tree from `point.id`
 *   2. {@link resetShadowBranchToCheckpoint} (warn-only on failure)
 *   3. read `SessionState.untrackedFilesAtStart` as preserved set
 *   4. build `checkpointFiles` (excluding `.story/`) + `trackedFiles` (HEAD tree)
 *   5. delete `untracked - checkpoint - tracked - preserved` (ENOENT-tolerant)
 *   6. write each checkpoint blob to worktree (mode 0o755 if `100755` else 0o644)
 *
 * **Brand divergence**: Go writes `[entire] Warning: ...` to stderr; Story
 * writes `[story] ...` (see {@link getStderrWriter}).
 *
 * @example
 * ```ts
 * await rewindImpl(strategy, process.stdout, process.stderr, point);
 *
 * // Side effects:
 * //   <repoDir>/.git/refs/heads/story/<base>-<6hex>      ← reset to point.id (best-effort)
 * //   <repoDir>/<file1>, <file2>, ...                    ← restored from checkpoint tree
 * //   <repoDir>/<untracked-not-in-cp>                    ← deleted
 * //   stdout                                              ← per-file '  Restored: <path>' / '  Deleted: <path>'
 * //   stdout                                              ← '\nRestored files from shadow commit <short>\n\n'
 * //   stderr                                              ← '[story] Reset shadow branch ...' (best-effort)
 * //                                                        '[story] Warning: failed to reset shadow branch: ...' (on failure)
 * //
 * // .git/index / HEAD: unchanged (rewind only touches worktree files).
 * ```
 */
export async function rewindImpl(
	s: ManualCommitStrategy,
	out: NodeJS.WritableStream,
	err: NodeJS.WritableStream,
	point: RewindPoint,
): Promise<void> {
	const repo = await s.getRepo();

	// Step 1: read commit + tree.
	let commit: { tree: string; message: string };
	try {
		const result = await git.readCommit({ fs: fsCallback, dir: repo.root, oid: point.id });
		commit = { tree: result.commit.tree, message: result.commit.message };
	} catch (e) {
		throw new Error(`failed to get commit: ${(e as Error).message}`, { cause: e as Error });
	}

	// Step 2: reset shadow branch HEAD (warn-only on failure).
	// CRITICAL: must happen BEFORE restoring files, so subsequent commits don't
	// include prompts from "after the rewound point".
	try {
		await resetShadowBranchToCheckpoint(s, repo, point.id, commit.message);
	} catch (e) {
		err.write(`[story] Warning: failed to reset shadow branch: ${(e as Error).message}\n`);
	}

	// Step 3: load SessionState.untrackedFilesAtStart as preserved set.
	const preservedUntracked = new Set<string>();
	const sessionId = parseSession(commit.message);
	if (sessionId !== null && sessionId !== '') {
		try {
			const state = await s.loadSessionState(sessionId);
			if (state?.untrackedFilesAtStart) {
				for (const f of state.untrackedFilesAtStart) {
					preservedUntracked.add(f);
				}
			}
		} catch {
			// best-effort — non-fatal
		}
	}

	// Step 4: build checkpointFiles (strict — checkpoint tree must be readable)
	// + trackedFiles (best-effort — a corrupt HEAD tree shouldn't block rewind).
	const checkpointFiles = new Set<string>();
	await walkTreeFilesStrict(repo.root, commit.tree, (filePath) => {
		if (!filePath.startsWith(`${STORY_METADATA_DIR_NAME}/`) && !filePath.startsWith('.story/')) {
			checkpointFiles.add(filePath);
		}
	});

	let headOid: string;
	try {
		headOid = (await execGit(['rev-parse', 'HEAD'], { cwd: repo.root })).trim();
	} catch (e) {
		throw new Error(`failed to get HEAD: ${(e as Error).message}`, { cause: e as Error });
	}
	const headCommit = await git.readCommit({ fs: fsCallback, dir: repo.root, oid: headOid });
	const trackedFiles = new Set<string>();
	await walkTreeFilesBestEffort(repo.root, headCommit.commit.tree, (filePath) => {
		trackedFiles.add(filePath);
	});

	// Step 5: delete untracked-not-in-cp / not-tracked / not-preserved.
	const repoRoot = await worktreeRoot(repo.root).catch(() => repo.root);
	let untrackedNow: string[] = [];
	try {
		untrackedNow = await collectUntrackedFilesDispatch.collect(repoRoot);
	} catch (e) {
		err.write(`Warning: error listing untracked files: ${(e as Error).message}\n`);
	}
	for (const relPath of untrackedNow) {
		if (checkpointFiles.has(relPath)) {
			continue;
		}
		if (trackedFiles.has(relPath)) {
			continue;
		}
		if (preservedUntracked.has(relPath)) {
			continue;
		}
		// Defense-in-depth: collectUntrackedFiles already filters protected
		// paths but guard again so a leak couldn't blow away `.git/...`.
		if (isProtectedPath(relPath)) {
			continue;
		}
		try {
			// Traversal-resistant delete (Go: osroot.Remove at manual_commit_rewind.go:373-379).
			await removeInRoot(repoRoot, relPath);
			out.write(`  Deleted: ${relPath}\n`);
		} catch {
			// Go also ignores delete errors (race with concurrent removal).
		}
	}

	// Step 6: restore checkpoint tree files (skip .story/ prefix).
	await walkTreeBlobs(repo.root, commit.tree, async (filePath, blob, mode) => {
		if (filePath.startsWith(`${STORY_METADATA_DIR_NAME}/`) || filePath.startsWith('.story/')) {
			return;
		}
		const perm = mode === '100755' ? 0o755 : 0o644;
		// Traversal-resistant write (Go: osroot.WriteFile at manual_commit_rewind.go:373-379).
		await writeFileInRoot(repoRoot, filePath, blob, perm);
		out.write(`  Restored: ${filePath}\n`);
	});

	out.write('\n');
	const shortId = point.id.length >= 7 ? point.id.slice(0, 7) : point.id;
	out.write(`Restored files from shadow commit ${shortId}\n`);
	out.write('\n');
}

/**
 * Pre-flight check for `rewind`. Always returns `canRewind: true` (manual-
 * commit semantics — rewind is always allowed, dirty worktree is expected
 * and will be replaced by checkpoint contents). The caller (Phase 9.3
 * CLI) prints `message` to the user before asking for confirmation.
 *
 * Mirrors Go `manual_commit_rewind.go: CanRewind` →
 * `common.go: checkCanRewindWithWarning`. Go's
 * `checkCanRewindWithWarning(ctx)` opens the repo internally and returns
 * `(true, "", nil)` when the repo can't be opened (e.g. not in a git
 * directory) — see Go test `manual_commit_test.go: TestShadowStrategy_CanRewind_NoRepo`.
 * Story TS mirrors that: when `s.getRepo()` rejects (e.g. cwd is not a
 * git worktree), return `{ canRewind: true, message: '' }` silently
 * instead of propagating the error to callers.
 *
 * @example
 * ```ts
 * await canRewindImpl(strategy);
 * // returns: { canRewind: true, message: 'The following uncommitted...' }
 * //          or { canRewind: true, message: '' }   (clean worktree / not a git repo)
 *
 * // Side effects: read-only — runs `git status --porcelain` + diff stats reads.
 * ```
 */
export async function canRewindImpl(
	s: ManualCommitStrategy,
): Promise<{ canRewind: boolean; message: string }> {
	let repo: Repository;
	try {
		repo = await s.getRepo();
	} catch {
		// Match Go: `checkCanRewindWithWarning` returns (true, "", nil) when
		// repo can't be opened. CanRewind is a pre-flight check; it must not
		// throw on "not a git repo" — the actual failure surfaces later if
		// the user proceeds with `rewind`.
		return { canRewind: true, message: '' };
	}
	return checkCanRewindWithWarning(repo.root);
}

/**
 * Compute what {@link rewindImpl} *would* do without actually writing /
 * deleting anything. Returns the lists of files to restore (from the
 * checkpoint tree) and to delete (untracked-not-in-cp).
 *
 * Mirrors Go `manual_commit_rewind.go: PreviewRewind`. Same scan as
 * Rewind Steps 4 + 5 but read-only.
 *
 * **Logs-only short-circuit**: `point.isLogsOnly === true` returns
 * `{ filesToRestore: [], filesToDelete: [], trackedChanges: [] }`
 * immediately — logs-only points don't touch the worktree.
 *
 * @example
 * ```ts
 * await previewRewindImpl(strategy, point);
 * // returns: {
 * //   filesToRestore: ['README.md', 'src/app.ts'],
 * //   filesToDelete:  ['extra.tmp'],
 * //   trackedChanges: []   // 5.1 interface field; not populated by Phase 5.5
 * // }
 *
 * // Side effects: read-only — git tree walks + git ls-files.
 * ```
 */
export async function previewRewindImpl(
	s: ManualCommitStrategy,
	point: RewindPoint,
): Promise<RewindPreview> {
	if (point.isLogsOnly) {
		return { filesToRestore: [], filesToDelete: [], trackedChanges: [] };
	}

	const repo = await s.getRepo();
	let commit: { tree: string; message: string };
	try {
		const result = await git.readCommit({ fs: fsCallback, dir: repo.root, oid: point.id });
		commit = { tree: result.commit.tree, message: result.commit.message };
	} catch (e) {
		throw new Error(`failed to get commit: ${(e as Error).message}`, { cause: e as Error });
	}

	const preservedUntracked = new Set<string>();
	const sessionId = parseSession(commit.message);
	if (sessionId !== null && sessionId !== '') {
		try {
			const state = await s.loadSessionState(sessionId);
			if (state?.untrackedFilesAtStart) {
				for (const f of state.untrackedFilesAtStart) {
					preservedUntracked.add(f);
				}
			}
		} catch {
			// best-effort
		}
	}

	const checkpointFiles = new Set<string>();
	const filesToRestore: string[] = [];
	await walkTreeFilesStrict(repo.root, commit.tree, (p) => {
		if (!p.startsWith(`${STORY_METADATA_DIR_NAME}/`) && !p.startsWith('.story/')) {
			checkpointFiles.add(p);
			filesToRestore.push(p);
		}
	});

	let headOid: string;
	try {
		headOid = (await execGit(['rev-parse', 'HEAD'], { cwd: repo.root })).trim();
	} catch (e) {
		throw new Error(`failed to get HEAD: ${(e as Error).message}`, { cause: e as Error });
	}
	const headCommit = await git.readCommit({ fs: fsCallback, dir: repo.root, oid: headOid });
	const trackedFiles = new Set<string>();
	await walkTreeFilesBestEffort(repo.root, headCommit.commit.tree, (p) => trackedFiles.add(p));

	const filesToDelete: string[] = [];
	const repoRoot = await worktreeRoot(repo.root).catch(() => repo.root);
	let untrackedNow: string[] = [];
	try {
		untrackedNow = await collectUntrackedFilesDispatch.collect(repoRoot);
	} catch (e) {
		// Mirrors Go: write warning to stderr but return what we have so far.
		// Go: `manual_commit_rewind.go: PreviewRewind:589-594` writes to os.Stderr.
		// Story TS routes through `getStderrWriter()` so tests can capture it.
		getStderrWriter().write(
			`Warning: could not list untracked files for preview: ${(e as Error).message}\n`,
		);
		filesToRestore.sort();
		return { filesToRestore, filesToDelete: [], trackedChanges: [] };
	}
	for (const relPath of untrackedNow) {
		if (checkpointFiles.has(relPath)) {
			continue;
		}
		if (trackedFiles.has(relPath)) {
			continue;
		}
		if (preservedUntracked.has(relPath)) {
			continue;
		}
		filesToDelete.push(relPath);
	}

	filesToRestore.sort();
	filesToDelete.sort();
	return { filesToRestore, filesToDelete, trackedChanges: [] };
}

/**
 * Reset the shadow branch HEAD to the checkpoint commit so subsequent
 * commits don't include prompts from "after the rewound point". Caller
 * (`rewindImpl` Step 2) treats failure as warn-only.
 *
 * Mirrors Go `manual_commit_rewind.go: resetShadowBranchToCheckpoint`.
 *
 * Algorithm:
 *   1. {@link parseSession}(commit.message) — checkpoint must have `Story-Session:` trailer
 *   2. {@link ManualCommitStrategy.loadSessionState}(sessionId) — must exist
 *   3. {@link shadowBranchNameForCommit}(state.baseCommit, state.worktreeId)
 *   4. `git update-ref refs/heads/<branch> <commit.hash>`
 *
 * Throws when:
 *   - commit lacks `Story-Session:` trailer
 *   - session state missing or load fails
 *   - ref update fails
 *
 * @internal
 *
 * @example
 * ```ts
 * await resetShadowBranchToCheckpoint(strategy, repo, commitHash, commitMessage);
 *
 * // Side effects:
 * //   <repoDir>/.git/refs/heads/story/<base>-<6hex>      ← rewritten to commitHash
 * //   <stderrWriter>                                       ← '[story] Reset shadow branch <name> to checkpoint <short>\n'
 * //
 * // .git/index / HEAD / worktree: unchanged.
 * ```
 */
export async function resetShadowBranchToCheckpoint(
	s: ManualCommitStrategy,
	repo: Repository,
	commitHash: string,
	commitMessage: string,
): Promise<void> {
	const sessionId = parseSession(commitMessage);
	if (sessionId === null || sessionId === '') {
		throw new Error('checkpoint has no Story-Session trailer');
	}
	let state: SessionState | null;
	try {
		state = await s.loadSessionState(sessionId);
	} catch (e) {
		throw new Error(`failed to load session state: ${(e as Error).message}`, {
			cause: e as Error,
		});
	}
	if (state === null) {
		throw new Error(`session ${sessionId} not found`);
	}
	const branch = shadowBranchNameForCommit(state.baseCommit, state.worktreeId ?? '');
	await execGit(['update-ref', `refs/heads/${branch}`, commitHash], { cwd: repo.root });
	const shortId = commitHash.length >= 7 ? commitHash.slice(0, 7) : commitHash;
	getStderrWriter().write(`[story] Reset shadow branch ${branch} to checkpoint ${shortId}\n`);
}

/**
 * Recursively walk every blob entry under `treeOid`, invoking `cb` with
 * the full slash-joined path. **Strict variant — any `readTree` failure
 * throws**, ensuring that callers working with the checkpoint tree never
 * delete user files based on a partial enumeration (Go:
 * `manual_commit_rewind.go:329-340` aborts rewind on checkpoint walk
 * failures).
 *
 * @internal
 */
async function walkTreeFilesStrict(
	repoDir: string,
	treeOid: string,
	cb: (filePath: string) => void,
): Promise<void> {
	await walkTreeFilesInner(repoDir, treeOid, '', cb, { strict: true });
}

/**
 * Same as {@link walkTreeFilesStrict} but swallows `readTree` failures —
 * suitable for the HEAD tree scan (a corrupt HEAD tree shouldn't block
 * rewind; callers only use this for "which files are currently tracked"
 * exclusions where a missing entry is a safe over-approximation).
 *
 * @internal
 */
async function walkTreeFilesBestEffort(
	repoDir: string,
	treeOid: string,
	cb: (filePath: string) => void,
): Promise<void> {
	await walkTreeFilesInner(repoDir, treeOid, '', cb, { strict: false });
}

async function walkTreeFilesInner(
	repoDir: string,
	treeOid: string,
	prefix: string,
	cb: (filePath: string) => void,
	opts: { strict: boolean },
): Promise<void> {
	let entries: Awaited<ReturnType<typeof git.readTree>>;
	try {
		entries = await git.readTree({ fs: fsCallback, dir: repoDir, oid: treeOid });
	} catch (err) {
		if (opts.strict) {
			throw new Error(`failed to read checkpoint tree ${treeOid}: ${(err as Error).message}`, {
				cause: err as Error,
			});
		}
		return;
	}
	for (const entry of entries.tree) {
		const fullPath = prefix === '' ? entry.path : `${prefix}/${entry.path}`;
		if (entry.type === 'blob') {
			cb(fullPath);
		} else if (entry.type === 'tree') {
			await walkTreeFilesInner(repoDir, entry.oid, fullPath, cb, opts);
		}
		// Skip 'commit' entries (submodules).
	}
}

/**
 * Recursively walk every blob entry under `treeOid`, invoking `cb` with
 * the full path, the blob bytes, and the file mode (`'100644'` /
 * `'100755'`). Used by `rewindImpl` Step 6 to restore worktree files.
 *
 * @internal
 */
async function walkTreeBlobs(
	repoDir: string,
	treeOid: string,
	cb: (filePath: string, blob: Uint8Array, mode: string) => Promise<void>,
): Promise<void> {
	await walkTreeBlobsInner(repoDir, treeOid, '', cb);
}

async function walkTreeBlobsInner(
	repoDir: string,
	treeOid: string,
	prefix: string,
	cb: (filePath: string, blob: Uint8Array, mode: string) => Promise<void>,
): Promise<void> {
	let entries: Awaited<ReturnType<typeof git.readTree>>;
	try {
		entries = await git.readTree({ fs: fsCallback, dir: repoDir, oid: treeOid });
	} catch {
		return;
	}
	for (const entry of entries.tree) {
		const fullPath = prefix === '' ? entry.path : `${prefix}/${entry.path}`;
		if (entry.type === 'blob') {
			const blob = await git.readBlob({ fs: fsCallback, dir: repoDir, oid: entry.oid });
			await cb(fullPath, blob.blob, entry.mode);
		} else if (entry.type === 'tree') {
			await walkTreeBlobsInner(repoDir, entry.oid, fullPath, cb);
		}
	}
}
