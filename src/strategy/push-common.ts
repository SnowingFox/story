/**
 * v1 metadata branch push + fetch+rebase recovery.
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/strategy/push_common.go` (the
 * branch / metadata-side; v2 ref logic lives in `push-v2.ts`).
 *
 * Story-side text: `[story] Pushing|Warning|Note|Syncing` brand throughout.
 */

import { spawnSync } from 'node:child_process';
import fsCallback from 'node:fs';
import { execa } from 'execa';
import git from 'isomorphic-git';
import { buildTreeFromEntries, flattenTree, type TreeEntry } from '@/checkpoint/tree-ops';
import { execGit, getGitAuthor } from '@/git';
import { getCheckpointRemote, loadFromBytes } from '@/settings/settings';
import {
	appendFetchFilterArgs,
	checkpointGitCommand,
	resolveFetchTarget,
} from './checkpoint-token';
import { MAX_COMMIT_TRAVERSAL_DEPTH } from './constants';
import { getStderrWriter } from './hooks-tty';
import { reconcileDisconnectedMetadataBranch } from './metadata-reconcile';
import {
	isURL,
	type PushResult,
	printCheckpointRemoteHint,
	startProgressDots,
} from './push-helpers';

/**
 * Timeout for the entire `fetchAndRebaseSessionsCommon` flow (fetch +
 * reconcile + cherry-pick). Mirrors Go's `2*time.Minute` context wrap in
 * `push_common.go: fetchAndRebaseSessionsCommon`. Different from
 * {@link CHECKPOINT_REMOTE_FETCH_TIMEOUT_MS} (30s, single-fetch path).
 */
const PUSH_REBASE_FETCH_TIMEOUT_MS = 2 * 60 * 1000;

let settingsHintPrinted = false;

class PushRemoteRejectedError extends Error {
	constructor(output: string) {
		super(`remote rejected push: ${output}`);
		this.name = 'PushRemoteRejectedError';
	}
}

/**
 * Test-only helper: reset the settings-hint `sync.Once` gate so subsequent
 * test runs in the same process can re-trigger the hint.
 */
export function resetSettingsHintForTesting(): void {
	settingsHintPrinted = false;
}

/**
 * Push a branch to the given target if it has unpushed changes. The target
 * can be a remote name (e.g. `'origin'`) or a URL for direct push.
 *
 * When pushing to a URL, the *has unpushed* optimization is skipped since
 * there are no remote tracking refs — git itself handles the no-op case.
 *
 * Does not check any settings — callers are responsible for gating
 * (`isPushSessionsDisabled`, etc).
 *
 * Mirrors Go `pushBranchIfNeeded` in `push_common.go`.
 *
 * @example
 * ```ts
 * // Standard push to remote name with local + tracking ref both present
 * await pushBranchIfNeeded('origin', 'story/checkpoints/v1', { cwd });
 * // returns: void (always — silent on failure)
 *
 * // Side effects:
 * //   - May spawn: git push --no-verify --porcelain origin story/checkpoints/v1
 * //   - On non-fast-forward: triggers fetchAndRebaseSessionsCommon → cherry-pick + retry push
 * //   - All errors caught + written to stderr as "[story] Warning: ..."
 * //   - On success: refs/remotes/origin/story/checkpoints/v1 updated by git
 * //
 * // Local refs / worktree / HEAD: unchanged unless rebase ran.
 *
 * // No local branch → silent return
 * await pushBranchIfNeeded('origin', 'story/checkpoints/v1', { cwd });
 * // returns: void; nothing happens
 *
 * // openRepository fails (not a git repo) → silent return
 * await pushBranchIfNeeded('origin', 'story/checkpoints/v1', { cwd });
 * // returns: void; no error thrown
 * ```
 */
export async function pushBranchIfNeeded(
	target: string,
	branchName: string,
	opts: { cwd: string },
): Promise<void> {
	let localHash: string;
	try {
		localHash = await git.resolveRef({
			fs: fsCallback,
			dir: opts.cwd,
			ref: `refs/heads/${branchName}`,
		});
	} catch {
		// Either not a git repo or local branch missing — both silent.
		return;
	}

	// Remote-name target: only push when local hash differs from remote tracking ref.
	if (!isURL(target)) {
		const hasUnpushed = await hasUnpushedSessionsCommon(opts.cwd, target, localHash, branchName);
		if (!hasUnpushed) {
			return;
		}
	}

	// Defense-in-depth wrap: doPushBranch is silent-on-failure internally
	// (every catch path writes to stderr + returns). This try/catch guards
	// the hook contract against any future bug that might escape.
	try {
		await doPushBranch(target, branchName, opts);
	} catch (err) {
		getStderrWriter().write(
			`[story] Warning: unexpected error pushing ${branchName}: ${formatErr(err)}\n`,
		);
	}
}

/**
 * Parse `git push --porcelain` output for ref status flags. In porcelain
 * mode, each ref gets a tab-delimited status line:
 *
 *     <flag>\t<from>:<to>\t<summary>
 *
 * where flag `=` means the ref was already up-to-date. Locale-independent
 * unlike the human-readable "Everything up-to-date" message.
 *
 * @example
 * ```ts
 * parsePushResult('To origin\n=\trefs/heads/main:refs/heads/main\t[up to date]\nDone');
 * // returns: { upToDate: true }
 *
 * parsePushResult('To origin\n*\trefs/heads/main:refs/heads/main\t[new branch]\nDone');
 * // returns: { upToDate: false }
 *
 * parsePushResult('');
 * // returns: { upToDate: false }
 * ```
 */
export function parsePushResult(output: string): PushResult {
	for (const line of output.split('\n')) {
		if (line.startsWith('=\t')) {
			return { upToDate: true };
		}
	}
	return { upToDate: false };
}

/**
 * Compare local branch hash against the remote tracking ref
 * (`refs/remotes/<remote>/<branch>`). Returns `true` when:
 *   - The remote tracking ref is missing (we have content to push)
 *   - The hashes differ (any difference: ahead, behind, or diverged)
 *
 * Returns `false` only when both refs exist and point at the same commit.
 */
async function hasUnpushedSessionsCommon(
	repoDir: string,
	remote: string,
	localHash: string,
	branchName: string,
): Promise<boolean> {
	let remoteHash: string;
	try {
		remoteHash = await git.resolveRef({
			fs: fsCallback,
			dir: repoDir,
			ref: `refs/remotes/${remote}/${branchName}`,
		});
	} catch {
		// Remote tracking ref missing → there's content to push.
		return true;
	}
	return localHash !== remoteHash;
}

/**
 * Main push retry pipeline. Tries the push; on **any** failure (not just
 * non-fast-forward), runs `fetchAndRebaseSessionsCommon` (fetch +
 * reconcile + cherry-pick) and retries. This mirrors Go's `doPushBranch`
 * (`push_common.go: doPushBranch`) which always proceeds to "Syncing..."
 * after any failed first push — covers unreachable remote, auth failure,
 * DNS, and the recoverable non-fast-forward case in one path.
 *
 * All failures are written to stderr as `[story] Warning` lines — never
 * thrown.
 */
async function doPushBranch(
	target: string,
	branchName: string,
	opts: { cwd: string },
): Promise<void> {
	const w = getStderrWriter();
	const displayTarget = isURL(target) ? 'checkpoint remote' : target;

	w.write(`[story] Pushing ${branchName} to ${displayTarget}...`);
	let stop = startProgressDots(w);

	// First push attempt. On success → done. On any failure → fall through
	// to fetch+rebase + retry, matching Go's unconditional "Syncing" path.
	try {
		const result = await tryPushSessionsCommon(target, branchName, opts);
		finishPush(stop, result, target, opts);
		return;
	} catch (err) {
		stop('');
		if (err instanceof PushRemoteRejectedError) {
			w.write(`[story] Warning: failed to push ${branchName}: ${formatErr(err)}\n`);
			printCheckpointRemoteHint(target);
			return;
		}
	}

	// Recovery path: fetch + reconcile + cherry-pick, then retry push.
	w.write(`[story] Syncing ${branchName} with remote...`);
	stop = startProgressDots(w);
	try {
		await fetchAndRebaseSessionsCommon(target, branchName, opts);
		stop(' done');
	} catch (err) {
		stop('');
		w.write(`[story] Warning: couldn't sync ${branchName}: ${formatErr(err)}\n`);
		printCheckpointRemoteHint(target);
		return;
	}

	w.write(`[story] Pushing ${branchName} to ${displayTarget}...`);
	stop = startProgressDots(w);
	try {
		const result = await tryPushSessionsCommon(target, branchName, opts);
		finishPush(stop, result, target, opts);
	} catch (err) {
		stop('');
		w.write(`[story] Warning: failed to push ${branchName} after sync: ${formatErr(err)}\n`);
		printCheckpointRemoteHint(target);
	}
}

/**
 * Single `git push --no-verify --porcelain` invocation. 2-minute timeout.
 *
 * Throws `Error('non-fast-forward')` when stderr/stdout contains the
 * phrases `non-fast-forward` or `rejected` (caller catches this to trigger
 * the fetch+rebase recovery path). Other failures throw with the raw
 * output.
 */
async function tryPushSessionsCommon(
	remote: string,
	branchName: string,
	opts: { cwd: string },
): Promise<PushResult> {
	const cmd = await checkpointGitCommand(remote, [
		'push',
		'--no-verify',
		'--porcelain',
		remote,
		branchName,
	]);
	const env: NodeJS.ProcessEnv = { ...(cmd.env ?? process.env), GIT_TERMINAL_PROMPT: '0' };
	const result = await execa('git', cmd.args, {
		cwd: opts.cwd,
		env,
		timeout: 2 * 60 * 1000,
		reject: false,
	});

	const combined = `${result.stdout}\n${result.stderr}`;
	if (result.exitCode !== 0) {
		if (isNonFastForwardOutput(combined)) {
			throw new Error('non-fast-forward');
		}
		if (isRemoteRejectedOutput(combined)) {
			throw new PushRemoteRejectedError(cleanPushOutput(combined));
		}
		throw new Error(`push failed: ${combined.trim()}`);
	}
	// Mirror Go's `cmd.CombinedOutput()` semantics — parse both streams so
	// porcelain `=` flags (rare, but possible on stderr) still match.
	return parsePushResult(combined);
}

function isNonFastForwardOutput(output: string): boolean {
	return (
		output.includes('non-fast-forward') ||
		output.includes('(fetch first)') ||
		output.includes('remote contains work that you do not')
	);
}

function isRemoteRejectedOutput(output: string): boolean {
	return /remote rejected|pre-receive hook declined|protected/i.test(output);
}

function cleanPushOutput(output: string): string {
	return output
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.join(' | ');
}

/**
 * Fetch the remote branch + reconcile any disconnect (cherry-pick local
 * commits onto remote tip when no shared ancestor) + cherry-pick
 * local-only commits onto the new tip. Updates the local ref to the new
 * tip. Cleans up any temporary fetched ref.
 *
 * Mirrors Go `fetchAndRebaseSessionsCommon` in `push_common.go`.
 */
async function fetchAndRebaseSessionsCommon(
	target: string,
	branchName: string,
	opts: { cwd: string },
): Promise<void> {
	const fetchTarget = await resolveFetchTarget(target, { cwd: opts.cwd });
	const usedTempRef = isURL(fetchTarget);

	let fetchedRefName: string;
	let refSpec: string;
	if (usedTempRef) {
		fetchedRefName = `refs/story-fetch-tmp/${branchName}`;
		refSpec = `+refs/heads/${branchName}:${fetchedRefName}`;
	} else {
		fetchedRefName = `refs/remotes/${target}/${branchName}`;
		refSpec = `+refs/heads/${branchName}:refs/remotes/${target}/${branchName}`;
	}

	const baseArgs = ['fetch', '--no-tags', fetchTarget, refSpec];
	const fetchArgs = await appendFetchFilterArgs(baseArgs, { cwd: opts.cwd });
	const cmd = await checkpointGitCommand(fetchTarget, fetchArgs);
	const env: NodeJS.ProcessEnv = { ...(cmd.env ?? process.env), GIT_TERMINAL_PROMPT: '0' };
	// 2-minute timeout matches Go's `2*time.Minute` context wrap on the
	// whole `fetchAndRebaseSessionsCommon` body. Distinct from the 30s
	// single-fetch timeout used by `fetchMetadataBranch` / `fetchV2MainFromURL`
	// in `checkpoint-remote.ts`.
	const fetchResult = await execa('git', cmd.args, {
		cwd: opts.cwd,
		env,
		timeout: PUSH_REBASE_FETCH_TIMEOUT_MS,
		reject: false,
	});
	if (fetchResult.exitCode !== 0) {
		throw new Error(`fetch failed: ${(fetchResult.stderr || fetchResult.stdout).trim()}`);
	}

	// Reconcile any disconnect before rebasing.
	await reconcileDisconnectedMetadataBranch(opts.cwd, fetchedRefName, getStderrWriter());

	const localRef = await git.resolveRef({
		fs: fsCallback,
		dir: opts.cwd,
		ref: `refs/heads/${branchName}`,
	});
	const remoteRef = await git.resolveRef({
		fs: fsCallback,
		dir: opts.cwd,
		ref: fetchedRefName,
	});

	if (localRef === remoteRef) {
		await maybeRemoveTempRef(opts.cwd, fetchedRefName, usedTempRef);
		return;
	}

	const mergeBase = await getMergeBase(opts.cwd, localRef, remoteRef);
	if (mergeBase === localRef) {
		// Local is ancestor of remote → fast-forward.
		await git.writeRef({
			fs: fsCallback,
			dir: opts.cwd,
			ref: `refs/heads/${branchName}`,
			value: remoteRef,
			force: true,
		});
		await maybeRemoveTempRef(opts.cwd, fetchedRefName, usedTempRef);
		return;
	}

	// Collect local-only commits + cherry-pick onto remote tip.
	const localCommits = await collectCommitsSince(opts.cwd, localRef, remoteRef);
	if (localCommits.length === 0) {
		await git.writeRef({
			fs: fsCallback,
			dir: opts.cwd,
			ref: `refs/heads/${branchName}`,
			value: remoteRef,
			force: true,
		});
		await maybeRemoveTempRef(opts.cwd, fetchedRefName, usedTempRef);
		return;
	}

	const newTip = await cherryPickOnto(opts.cwd, remoteRef, localCommits);
	await git.writeRef({
		fs: fsCallback,
		dir: opts.cwd,
		ref: `refs/heads/${branchName}`,
		value: newTip,
		force: true,
	});
	await maybeRemoveTempRef(opts.cwd, fetchedRefName, usedTempRef);
}

async function maybeRemoveTempRef(
	repoDir: string,
	refName: string,
	usedTempRef: boolean,
): Promise<void> {
	if (!usedTempRef) {
		return;
	}
	try {
		await execGit(['update-ref', '-d', refName], { cwd: repoDir });
	} catch {
		// best-effort cleanup
	}
}

/** Run `git merge-base hashA hashB` and return the resulting hash. */
async function getMergeBase(repoDir: string, hashA: string, hashB: string): Promise<string> {
	const result = await execa('git', ['merge-base', hashA, hashB], {
		cwd: repoDir,
		timeout: 10_000,
		reject: false,
	});
	if (result.exitCode !== 0) {
		throw new Error(
			`git merge-base failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`}`,
		);
	}
	return result.stdout.trim();
}

interface CommitChainEntry {
	hash: string;
	tree: string;
	parents: string[];
	author: { name: string; email: string; timestamp: number; timezoneOffset: number };
	message: string;
}

/**
 * Walk `<exclude>..<tip>` via `git rev-list --reverse --topo-order
 * --no-merges` and return commits oldest-first. Throws when chain exceeds
 * {@link MAX_COMMIT_TRAVERSAL_DEPTH}. Skips merge commits (their delta vs
 * first-parent would re-apply changes from the non-first-parent history).
 */
async function collectCommitsSince(
	repoDir: string,
	tip: string,
	exclude: string,
): Promise<CommitChainEntry[]> {
	const out = await execGit(
		['rev-list', '--reverse', '--topo-order', '--no-merges', `${exclude}..${tip}`],
		{ cwd: repoDir },
	);
	const lines = out.split('\n').filter((l) => l.length > 0);
	if (lines.length > MAX_COMMIT_TRAVERSAL_DEPTH) {
		throw new Error(`commit chain exceeded ${MAX_COMMIT_TRAVERSAL_DEPTH} commits; aborting rebase`);
	}
	const entries: CommitChainEntry[] = [];
	for (const hash of lines) {
		const result = await git.readCommit({ fs: fsCallback, dir: repoDir, oid: hash });
		const c = result.commit;
		if (c.parent.length > 1) {
			continue;
		}
		entries.push({
			hash: result.oid,
			tree: c.tree,
			parents: c.parent,
			author: c.author,
			message: c.message,
		});
	}
	return entries;
}

/**
 * Cherry-pick each commit's delta (added/modified/deleted entries vs its
 * first parent) onto `base`, building a linear chain. Returns the new tip
 * hash. Skips commits with empty delta.
 *
 * Author preservation matches Go `createCherryPickCommit` in
 * `metadata_reconcile.go: createCherryPickCommit` — original author + new
 * committer (local repo's `user.name` / `user.email` + `time.Now()`).
 */
async function cherryPickOnto(
	repoDir: string,
	base: string,
	commits: CommitChainEntry[],
): Promise<string> {
	const localAuthor = await getGitAuthor(repoDir);
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
 * Stop the progress dots and print "already up-to-date" or "done"
 * depending on the push result. When new content was actually pushed
 * (not up-to-date), conditionally prints the settings-commit hint.
 */
function finishPush(
	stop: (suffix: string) => void,
	result: PushResult,
	target: string,
	opts: { cwd: string },
): void {
	if (result.upToDate) {
		stop(' already up-to-date');
		return;
	}
	stop(' done');
	printSettingsCommitHint(target, opts);
}

/**
 * Sync.Once-style hint after a successful push to a URL: warn the user
 * if the committed `.story/settings.json` does not contain a
 * `checkpoint_remote` config. The discovery service finds the external
 * checkpoint repo by reading the committed project settings, so the
 * `checkpoint_remote` must be present in `HEAD:.story/settings.json`
 * (not just in `settings.local.json` or uncommitted local changes).
 *
 * Exported (`@internal`) so [`./push-v2.ts`](./push-v2.ts) `finishPushRef`
 * can share the same once-gate. Mirrors Go's `finishPush` (push_common.go)
 * being shared across v1 + v2 push paths.
 *
 * @internal
 */
export function printSettingsCommitHint(target: string, opts: { cwd: string }): void {
	if (!isURL(target)) {
		return;
	}
	if (settingsHintPrinted) {
		return;
	}
	settingsHintPrinted = true;

	const committed = isCheckpointRemoteCommittedSync(opts.cwd);
	if (committed) {
		return;
	}
	const w = getStderrWriter();
	w.write(
		'[story] Note: Checkpoints were pushed to a separate checkpoint remote, but .story/settings.json does not contain checkpoint_remote in the latest commit. entire.io will not be able to discover these checkpoints until checkpoint_remote is committed and pushed in .story/settings.json.\n',
	);
}

/**
 * True iff the committed `.story/settings.json` at HEAD contains a valid
 * `checkpoint_remote` configuration. Synchronous variant — we use
 * `git show HEAD:.story/settings.json` and parse the bytes directly so the
 * caller doesn't need to await another async hop after the push completes.
 *
 * The `.story/settings.json` literal in the git ref-path is intentional —
 * `git show <commit>:<path>` requires a worktree-relative path with no
 * leading `/`, so we cannot use {@link getStoryFilePath} (which returns
 * an absolute path). The literal mirrors `STORY_DIR` + `SETTINGS_FILE`
 * from `@/checkpoint/constants` and `@/settings/settings`.
 */
function isCheckpointRemoteCommittedSync(cwd: string): boolean {
	try {
		const result = spawnSyncGit(['show', 'HEAD:.story/settings.json'], cwd);
		if (result.exitCode !== 0) {
			return false;
		}
		const settings = loadFromBytes(result.stdout);
		return getCheckpointRemote(settings) !== null;
	} catch {
		return false;
	}
}

interface SyncShimResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

function spawnSyncGit(args: string[], cwd: string): SyncShimResult {
	const r = spawnSync('git', args, { encoding: 'utf8', cwd });
	return {
		exitCode: r.status ?? -1,
		stdout: typeof r.stdout === 'string' ? r.stdout : '',
		stderr: typeof r.stderr === 'string' ? r.stderr : '',
	};
}

function formatErr(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
