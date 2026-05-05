/**
 * v1 metadata branch + v2 /main ref disconnect detection and cherry-pick
 * repair.
 *
 * Used by:
 *   - `push-common.ts` `fetchAndRebaseSessionsCommon` →
 *     `reconcileDisconnectedMetadataBranch` (push retry path)
 *   - Phase 9.5 `story doctor` command → all 5 export functions below
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/strategy/metadata_reconcile.go`.
 *
 * **History context**: empty-orphan bug — older Story versions created an
 * empty orphan commit when `ensureMetadataBranch` initialized the v1
 * branch. After fetch, local + remote could each have independent empty
 * orphans → `git merge-base` returns no common ancestor → ordinary merge
 * fails. Cherry-pick recovery preserves all data because checkpoint shards
 * use unique paths (`<id[:2]>/<id[2:]>/...`).
 *
 * Story-side text divergence: `[story]` brand throughout; `Run 'story doctor' to fix.`
 * (Go uses `entire`); temp ref namespace `refs/story-fetch-tmp/...`.
 */

import fsCallback from 'node:fs';
import { execa } from 'execa';
import git from 'isomorphic-git';
import { METADATA_BRANCH_NAME, V2_MAIN_REF_NAME } from '@/checkpoint/constants';
import { buildTreeFromEntries, flattenTree, type TreeEntry } from '@/checkpoint/tree-ops';
import { execGit, getGitAuthor } from '@/git';
import { CHECKPOINT_REMOTE_FETCH_TIMEOUT_MS } from './checkpoint-remote';
import {
	appendFetchFilterArgs,
	checkpointGitCommand,
	resolveFetchTarget,
} from './checkpoint-token';
import { MAX_COMMIT_TRAVERSAL_DEPTH } from './constants';
import { getStderrWriter } from './hooks-tty';

/** Temp ref used by doctor's v2 /main fetch. */
export const V2_DOCTOR_TMP_REF = 'refs/story-fetch-tmp/doctor-v2-main';

let warnedOnce = false;

/**
 * Test-only helper: reset the `warnIfMetadataDisconnected` once-gate so
 * subsequent test runs in the same process can re-trigger the warning.
 */
export function resetWarnOnceForTesting(): void {
	warnedOnce = false;
}

/**
 * Check whether the local v1 metadata branch and the provided remote ref
 * exist but share no common ancestor.
 *
 * Returns `false` when local missing / remote missing / same hash /
 * shared ancestry. Returns `true` only when both refs exist and
 * `git merge-base` exits 1 (no common ancestor — the empty-orphan bug
 * or accidental disconnect).
 *
 * Mirrors Go `IsMetadataDisconnected`.
 */
export async function isMetadataDisconnected(
	repoDir: string,
	remoteRefName: string,
): Promise<boolean> {
	const localHash = await tryReadRef(repoDir, `refs/heads/${METADATA_BRANCH_NAME}`);
	if (localHash === null) {
		return false;
	}
	const remoteHash = await tryReadRef(repoDir, remoteRefName);
	if (remoteHash === null) {
		return false;
	}
	if (localHash === remoteHash) {
		return false;
	}
	return isDisconnected(repoDir, localHash, remoteHash);
}

/**
 * Sync.Once-style one-time stderr warning if the v1 metadata branch is
 * disconnected from the local `refs/remotes/origin/<branch>` tracking ref.
 * Does NOT fix the problem — directs the user to `story doctor`.
 *
 * Used at pre-push time as an advisory check; the actual repair happens
 * via {@link reconcileDisconnectedMetadataBranch} inside the push retry
 * loop.
 *
 * Mirrors Go `WarnIfMetadataDisconnected`.
 *
 * @example
 * ```ts
 * await warnIfMetadataDisconnected({ cwd });
 * // First call (and disconnected):
 * //   stderr ←
 * //     "[story] Warning: Local and remote session metadata branches are disconnected.\n"
 * //     "[story] Some checkpoints from remote may not be visible. Run 'story doctor' to fix.\n"
 * //
 * // All subsequent calls in the same process: no-op
 * //
 * // Side effects: at most one stderr write; no refs / disk modified.
 * ```
 */
export async function warnIfMetadataDisconnected(opts: { cwd: string }): Promise<void> {
	if (warnedOnce) {
		return;
	}
	warnedOnce = true;
	let disconnected: boolean;
	try {
		disconnected = await isMetadataDisconnected(
			opts.cwd,
			`refs/remotes/origin/${METADATA_BRANCH_NAME}`,
		);
	} catch {
		return;
	}
	if (!disconnected) {
		return;
	}
	const w = getStderrWriter();
	w.write('[story] Warning: Local and remote session metadata branches are disconnected.\n');
	w.write("[story] Some checkpoints from remote may not be visible. Run 'story doctor' to fix.\n");
}

/**
 * Detect and repair disconnected local/remote `story/checkpoints/v1`
 * branches. Cherry-picks local commits onto the remote tip; checkpoint
 * shards use unique paths so cherry-picks always apply cleanly.
 *
 * No-ops when:
 *   - Local branch missing
 *   - Remote ref missing
 *   - Same hash
 *   - Shared ancestry (not our problem — the standard tree merge in
 *     `push-common.ts` handles diverged-but-mergeable cases)
 *
 * Repair when local + remote disconnected:
 *   1. Collect local commit chain via first-parent walk
 *   2. Filter out empty-tree commits (the orphan bug commit)
 *   3. If no data commits → fast-forward local to remote
 *   4. Otherwise: cherry-pick onto remote tip → update local ref
 *
 * Progress messages written to `w` (typically `process.stderr` for hooks
 * or `cmd.stderr` for commands).
 *
 * Mirrors Go `ReconcileDisconnectedMetadataBranch`.
 *
 * @example
 * ```ts
 * await reconcileDisconnectedMetadataBranch(
 *   '/repo',
 *   'refs/remotes/origin/story/checkpoints/v1',
 *   process.stderr,
 * );
 *
 * // Side effects when disconnected + has data commits:
 * //   stderr ← "[story] Detected disconnected session metadata (local and remote share no common ancestor)\n"
 * //   stderr ← "[story] Cherry-picking 5 local checkpoint(s) onto remote...\n"
 * //   <repoDir>/.git/objects/<hash> ← 5 new commit objects (cherry-picked)
 * //   refs/heads/story/checkpoints/v1 ← <new tip hash>
 * //   stderr ← "[story] Done — all local and remote checkpoints preserved\n"
 * //
 * // When local has only empty-orphan commit:
 * //   refs/heads/story/checkpoints/v1 ← remote hash (fast-forward)
 * //   stderr ← "[story] Done — local had no checkpoint data, reset to remote\n"
 * //
 * // Worktree / index / HEAD: unchanged.
 * ```
 */
export async function reconcileDisconnectedMetadataBranch(
	repoDir: string,
	remoteRefName: string,
	w: NodeJS.WritableStream,
): Promise<void> {
	const localHash = await tryReadRef(repoDir, `refs/heads/${METADATA_BRANCH_NAME}`);
	if (localHash === null) {
		return;
	}
	const remoteHash = await tryReadRef(repoDir, remoteRefName);
	if (remoteHash === null) {
		return;
	}
	if (localHash === remoteHash) {
		return;
	}
	const disconnected = await isDisconnected(repoDir, localHash, remoteHash);
	if (!disconnected) {
		return;
	}

	w.write(
		'[story] Detected disconnected session metadata (local and remote share no common ancestor)\n',
	);

	const chain = await collectCommitChain(repoDir, localHash);
	const dataCommits: CommitChainEntry[] = [];
	for (const entry of chain) {
		const treeEntries = await git.readTree({ fs: fsCallback, dir: repoDir, oid: entry.tree });
		if (treeEntries.tree.length > 0) {
			dataCommits.push(entry);
		}
	}

	if (dataCommits.length === 0) {
		await git.writeRef({
			fs: fsCallback,
			dir: repoDir,
			ref: `refs/heads/${METADATA_BRANCH_NAME}`,
			value: remoteHash,
			force: true,
		});
		w.write('[story] Done — local had no checkpoint data, reset to remote\n');
		return;
	}

	w.write(`[story] Cherry-picking ${dataCommits.length} local checkpoint(s) onto remote...\n`);

	const newTip = await cherryPickOnto(repoDir, remoteHash, dataCommits);
	await git.writeRef({
		fs: fsCallback,
		dir: repoDir,
		ref: `refs/heads/${METADATA_BRANCH_NAME}`,
		value: newTip,
		force: true,
	});
	w.write('[story] Done — all local and remote checkpoints preserved\n');
}

/**
 * V2 `/main` variant of {@link isMetadataDisconnected}. Uses
 * `git ls-remote` to discover the remote ref (custom refs don't have
 * remote-tracking refs locally) and a temp fetched ref for comparison.
 *
 * Returns `false` when local /main missing, remote ref missing, or
 * shared ancestry. Returns `true` only when both refs exist and
 * merge-base exits 1.
 *
 * Mirrors Go `IsV2MainDisconnected`.
 */
export async function isV2MainDisconnected(repoDir: string, remote: string): Promise<boolean> {
	const localHash = await tryReadRef(repoDir, V2_MAIN_REF_NAME);
	if (localHash === null) {
		return false;
	}
	const remoteHash = await lsRemoteRef(repoDir, remote, V2_MAIN_REF_NAME);
	if (remoteHash === '') {
		return false;
	}
	if (localHash === remoteHash) {
		return false;
	}

	try {
		await fetchRefToTemp(repoDir, remote, V2_MAIN_REF_NAME, V2_DOCTOR_TMP_REF);
	} catch (err) {
		throw new Error(
			`failed to fetch remote v2 /main: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	try {
		const fetchedHash = await tryReadRef(repoDir, V2_DOCTOR_TMP_REF);
		if (fetchedHash === null) {
			// fetchRefToTemp claimed success but the temp ref isn't present —
			// something is wrong (concurrent prune? broken FS?). Mirror Go's
			// `resolveRefHash` returning an error rather than silently
			// reporting "not disconnected".
			throw new Error(
				`fetched v2 /main but temp ref ${V2_DOCTOR_TMP_REF} is missing — repo may be in an inconsistent state`,
			);
		}
		if (localHash === fetchedHash) {
			return false;
		}
		return isDisconnected(repoDir, localHash, fetchedHash);
	} finally {
		await cleanupTmpRef(repoDir, V2_DOCTOR_TMP_REF);
	}
}

/**
 * V2 `/main` variant of {@link reconcileDisconnectedMetadataBranch}.
 * Uses `git ls-remote` + temp-ref fetch to compare against remote.
 *
 * Mirrors Go `ReconcileDisconnectedV2Ref`.
 */
export async function reconcileDisconnectedV2Ref(
	repoDir: string,
	remote: string,
	w: NodeJS.WritableStream,
): Promise<void> {
	const localHash = await tryReadRef(repoDir, V2_MAIN_REF_NAME);
	if (localHash === null) {
		return;
	}
	const remoteHash = await lsRemoteRef(repoDir, remote, V2_MAIN_REF_NAME);
	if (remoteHash === '') {
		return;
	}
	if (localHash === remoteHash) {
		return;
	}

	await fetchRefToTemp(repoDir, remote, V2_MAIN_REF_NAME, V2_DOCTOR_TMP_REF);
	try {
		const fetchedHash = await tryReadRef(repoDir, V2_DOCTOR_TMP_REF);
		if (fetchedHash === null || localHash === fetchedHash) {
			return;
		}
		const disconnected = await isDisconnected(repoDir, localHash, fetchedHash);
		if (!disconnected) {
			return;
		}

		w.write(
			'[story] Detected disconnected v2 /main refs (local and remote share no common ancestor)\n',
		);

		const chain = await collectCommitChain(repoDir, localHash);
		const dataCommits: CommitChainEntry[] = [];
		for (const entry of chain) {
			const treeEntries = await git.readTree({ fs: fsCallback, dir: repoDir, oid: entry.tree });
			if (treeEntries.tree.length > 0) {
				dataCommits.push(entry);
			}
		}

		if (dataCommits.length === 0) {
			await git.writeRef({
				fs: fsCallback,
				dir: repoDir,
				ref: V2_MAIN_REF_NAME,
				value: fetchedHash,
				force: true,
			});
			w.write('[story] Done — local had no checkpoint data, reset to remote\n');
			return;
		}

		w.write(`[story] Cherry-picking ${dataCommits.length} local checkpoint(s) onto remote...\n`);
		const newTip = await cherryPickOnto(repoDir, fetchedHash, dataCommits);
		await git.writeRef({
			fs: fsCallback,
			dir: repoDir,
			ref: V2_MAIN_REF_NAME,
			value: newTip,
			force: true,
		});
		w.write('[story] Done — all local and remote checkpoints preserved\n');
	} finally {
		await cleanupTmpRef(repoDir, V2_DOCTOR_TMP_REF);
	}
}

interface CommitChainEntry {
	hash: string;
	tree: string;
	parents: string[];
	author: { name: string; email: string; timestamp: number; timezoneOffset: number };
	committer: { name: string; email: string; timestamp: number; timezoneOffset: number };
	message: string;
}

/**
 * Resolve a git ref to its commit hash. Returns `null` ONLY when the ref
 * is missing (isomorphic-git raises `NotFoundError` with `code` set).
 * Other failures (corrupt repo, I/O error, permission denied) propagate
 * as throws — mirrors Go's `errors.Is(err, plumbing.ErrReferenceNotFound)`
 * discrimination so we don't silently report "not disconnected" when the
 * underlying read failed.
 */
async function tryReadRef(repoDir: string, ref: string): Promise<string | null> {
	try {
		return await git.resolveRef({ fs: fsCallback, dir: repoDir, ref });
	} catch (err) {
		if (err !== null && typeof err === 'object' && 'code' in err && err.code === 'NotFoundError') {
			return null;
		}
		throw err;
	}
}

/**
 * Run `git merge-base hashA hashB` and classify by exit code:
 *   - 0 → shared ancestor → `false`
 *   - 1 → no common ancestor → `true`
 *   - other → throw (corrupt repo / invalid hash / git not installed)
 */
async function isDisconnected(repoDir: string, hashA: string, hashB: string): Promise<boolean> {
	const result = await execa('git', ['merge-base', hashA, hashB], {
		cwd: repoDir,
		reject: false,
		timeout: 10_000,
	});
	if (result.exitCode === 0) {
		return false;
	}
	if (result.exitCode === 1) {
		return true;
	}
	throw new Error(
		`git merge-base failed (exit ${result.exitCode}): ${result.stderr || result.stdout || 'unknown error'}`,
	);
}

/**
 * Walk from `tip` back along `commit.parent[0]` until reaching a root
 * commit. Returns oldest-first. Throws when chain exceeds
 * {@link MAX_COMMIT_TRAVERSAL_DEPTH}.
 */
async function collectCommitChain(repoDir: string, tip: string): Promise<CommitChainEntry[]> {
	const chain: CommitChainEntry[] = [];
	let current = tip;

	let reachedRoot = false;
	for (let i = 0; i < MAX_COMMIT_TRAVERSAL_DEPTH; i++) {
		const result = await git.readCommit({ fs: fsCallback, dir: repoDir, oid: current });
		const c = result.commit;
		const entry: CommitChainEntry = {
			hash: result.oid,
			tree: c.tree,
			parents: c.parent,
			author: c.author,
			committer: c.committer,
			message: c.message,
		};
		chain.push(entry);
		if (c.parent.length === 0) {
			reachedRoot = true;
			break;
		}
		const next = c.parent[0];
		if (next === undefined) {
			reachedRoot = true;
			break;
		}
		current = next;
	}

	if (!reachedRoot) {
		throw new Error(
			`commit chain exceeded ${MAX_COMMIT_TRAVERSAL_DEPTH} commits without reaching root; aborting reconciliation`,
		);
	}

	chain.reverse();
	return chain;
}

/**
 * Apply each commit's delta (added / modified / deleted entries vs its
 * first parent) onto `base`, building a linear chain. Per-commit:
 *   1. Compute commit's tree entries (flatten)
 *   2. Compute parent's tree entries (empty for root)
 *   3. `added` = entries present in commit but not in parent (or with different hash)
 *   4. `deleted` = entries present in parent but not in commit
 *   5. Apply delta onto current tip's tree (also flattened)
 *   6. Build merged tree object + create a new commit (parent = current tip,
 *      author = original commit's author, committer = local user)
 *
 * Returns the new tip hash. Skips no-op commits (empty added + deleted).
 */
async function cherryPickOnto(
	repoDir: string,
	base: string,
	commits: CommitChainEntry[],
): Promise<string> {
	let currentTip = base;
	for (const commit of commits) {
		const commitEntries = new Map<string, TreeEntry>();
		await flattenTree(repoDir, commit.tree, '', commitEntries);

		const parentEntries = new Map<string, TreeEntry>();
		if (commit.parents.length > 0) {
			const parentHash = commit.parents[0];
			if (parentHash !== undefined) {
				const parentCommit = await git.readCommit({
					fs: fsCallback,
					dir: repoDir,
					oid: parentHash,
				});
				await flattenTree(repoDir, parentCommit.commit.tree, '', parentEntries);
			}
		}

		const added = new Map<string, TreeEntry>();
		for (const [path, entry] of commitEntries) {
			const parentEntry = parentEntries.get(path);
			if (parentEntry === undefined || parentEntry.hash !== entry.hash) {
				added.set(path, entry);
			}
		}
		const deleted: string[] = [];
		for (const path of parentEntries.keys()) {
			if (!commitEntries.has(path)) {
				deleted.push(path);
			}
		}

		if (added.size === 0 && deleted.length === 0) {
			continue;
		}

		const tipCommit = await git.readCommit({ fs: fsCallback, dir: repoDir, oid: currentTip });
		const merged = new Map<string, TreeEntry>();
		await flattenTree(repoDir, tipCommit.commit.tree, '', merged);
		for (const [path, entry] of added) {
			merged.set(path, entry);
		}
		for (const path of deleted) {
			merged.delete(path);
		}

		const mergedTreeHash = await buildTreeFromEntries(repoDir, merged);
		const localAuthor = await getGitAuthor(repoDir);
		const now = Math.floor(Date.now() / 1000);

		const newHash = await git.writeCommit({
			fs: fsCallback,
			dir: repoDir,
			commit: {
				tree: mergedTreeHash,
				parent: [currentTip],
				author: commit.author,
				committer: {
					name: localAuthor.name,
					email: localAuthor.email,
					timestamp: now,
					timezoneOffset: 0,
				},
				message: commit.message,
			},
		});
		currentTip = newHash;
	}
	return currentTip;
}

/**
 * Run `git ls-remote <remote> <ref>` and return the matching hash, or `''`
 * when the ref doesn't exist on the remote.
 */
async function lsRemoteRef(repoDir: string, remote: string, refName: string): Promise<string> {
	const fetchTarget = await resolveFetchTarget(remote, { cwd: repoDir });
	const cmd = await checkpointGitCommand(remote, ['ls-remote', fetchTarget, refName]);
	const env: NodeJS.ProcessEnv = { ...(cmd.env ?? process.env), GIT_TERMINAL_PROMPT: '0' };
	const result = await execa('git', cmd.args, {
		cwd: repoDir,
		env,
		timeout: 10_000,
		reject: false,
	});
	if (result.exitCode !== 0) {
		throw new Error(`git ls-remote failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
	}
	const line = result.stdout.trim();
	if (line === '') {
		return '';
	}
	const parts = line.split(/\s+/);
	if (parts.length < 2) {
		return '';
	}
	const hash = parts[0];
	return hash ?? '';
}

/** Fetch a remote ref into a temporary local ref for comparison. */
async function fetchRefToTemp(
	repoDir: string,
	remote: string,
	srcRef: string,
	dstRef: string,
): Promise<void> {
	const fetchTarget = await resolveFetchTarget(remote, { cwd: repoDir });
	const refspec = `+${srcRef}:${dstRef}`;
	const baseArgs = ['fetch', '--no-tags', fetchTarget, refspec];
	const fetchArgs = await appendFetchFilterArgs(baseArgs, { cwd: repoDir });
	const cmd = await checkpointGitCommand(remote, fetchArgs);
	const env: NodeJS.ProcessEnv = { ...(cmd.env ?? process.env), GIT_TERMINAL_PROMPT: '0' };
	const result = await execa('git', cmd.args, {
		cwd: repoDir,
		env,
		timeout: CHECKPOINT_REMOTE_FETCH_TIMEOUT_MS,
		reject: false,
	});
	if (result.exitCode !== 0) {
		const detail = (result.stderr || result.stdout).trim();
		throw new Error(detail || 'git fetch failed');
	}
}

async function cleanupTmpRef(repoDir: string, refName: string): Promise<void> {
	try {
		await execGit(['update-ref', '-d', refName], { cwd: repoDir });
	} catch {
		// best-effort cleanup
	}
}
