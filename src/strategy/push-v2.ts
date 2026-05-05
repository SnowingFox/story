/**
 * v2 custom-ref push + tree merge + rotation conflict recovery.
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/strategy/push_v2.go`.
 *
 * Story-side text: `[story]` brand on stderr; ref name short prefix is
 * `refs/story/checkpoints/` (Go uses `refs/entire/checkpoints/`); temp
 * fetch ref namespace is `refs/story-fetch-tmp/`.
 */

import fsCallback from 'node:fs';
import { execa } from 'execa';
import git from 'isomorphic-git';
import {
	GENERATION_FILE_NAME,
	V2_FULL_CURRENT_REF_NAME,
	V2_FULL_REF_PREFIX,
} from '@/checkpoint/constants';
import { buildTreeFromEntries, flattenTree, type TreeEntry } from '@/checkpoint/tree-ops';
import { GENERATION_REF_PATTERN } from '@/checkpoint/v2-generation';
import { V2GitStore } from '@/checkpoint/v2-store';
import { execGit } from '@/git';
import { warn } from '@/log';
import { CHECKPOINT_REMOTE_FETCH_TIMEOUT_MS } from './checkpoint-remote';
import {
	appendFetchFilterArgs,
	checkpointGitCommand,
	resolveFetchTarget,
} from './checkpoint-token';
import { getStderrWriter } from './hooks-tty';
import { parsePushResult, printSettingsCommitHint } from './push-common';
import {
	createMergeCommitCommon,
	isURL,
	type PushResult,
	printCheckpointRemoteHint,
	startProgressDots,
} from './push-helpers';

const REFS_STORY_CHECKPOINTS_PREFIX = 'refs/story/checkpoints/';

/**
 * Push a custom ref (`refs/story/checkpoints/v2/...`) to the given target
 * if it exists locally. Custom refs don't have remote-tracking refs, so
 * there's no "has unpushed" optimization — always attempts the push and
 * lets git handle the no-op case (porcelain output `=`).
 *
 * Silently returns on:
 *   - openRepository failure (not a git repo)
 *   - Local ref doesn't exist
 *   - Push failure (logged to stderr as `[story] Warning`)
 *
 * Mirrors Go `pushRefIfNeeded` in `push_v2.go`.
 *
 * @example
 * ```ts
 * await pushRefIfNeeded('origin', 'refs/story/checkpoints/v2/main', { cwd });
 * // returns: void (always — silent on failure)
 *
 * // Side effects:
 * //   - May spawn: git push --no-verify --porcelain origin
 * //                refs/story/checkpoints/v2/main:refs/story/checkpoints/v2/main
 * //   - On non-fast-forward / any other failure: triggers fetchAndMergeRef
 * //     (tree merge + optional rotation conflict recovery) → retry push
 * //   - All errors → stderr `[story] Warning: ...` + return (no throw)
 * //   - On URL target: prints "checkpoint remote" instead of remote name
 * //
 * // Worktree / index / HEAD: unchanged. Local ref may be updated only
 * // when fetchAndMergeRef writes a merge commit on the local branch.
 * ```
 */
export async function pushRefIfNeeded(
	target: string,
	refName: string,
	opts: { cwd: string },
): Promise<void> {
	try {
		await git.resolveRef({ fs: fsCallback, dir: opts.cwd, ref: refName });
	} catch {
		return;
	}
	// Defense-in-depth wrap: doPushRef is silent-on-failure internally
	// (every catch path writes to stderr + returns). This try/catch guards
	// the hook contract against any future bug that might escape.
	try {
		await doPushRef(target, refName, opts);
	} catch (err) {
		getStderrWriter().write(
			`[story] Warning: unexpected error pushing ${shortRefName(refName)}: ${formatErr(err)}\n`,
		);
	}
}

/**
 * Push v2 checkpoint refs to the target. Pushes:
 *   1. `refs/story/checkpoints/v2/main`
 *   2. `refs/story/checkpoints/v2/full/current`
 *   3. The latest archived generation (most likely newly created), if any
 *
 * Older archived generations are immutable and were pushed when created;
 * pushing them again would be wasteful (and is unnecessary).
 *
 * Mirrors Go `pushV2Refs` in `push_v2.go`.
 *
 * @example
 * ```ts
 * await pushV2Refs('origin', { cwd });
 * // returns: void (silent on failure throughout)
 *
 * // Side effects (best-case):
 * //   - 3 separate `git push` invocations:
 * //       refs/story/checkpoints/v2/main:refs/story/checkpoints/v2/main
 * //       refs/story/checkpoints/v2/full/current:refs/story/checkpoints/v2/full/current
 * //       refs/story/checkpoints/v2/full/<latest-13digit>:refs/story/checkpoints/v2/full/<latest-13digit>
 * //   - On rotation conflict (remote has archived gen we don't):
 * //       fetch + tree-merge local /full/current into archived → push archived → adopt remote /full/current
 * //   - All push failures → stderr `[story] Warning: ...` + return (no throw)
 * ```
 */
export async function pushV2Refs(target: string, opts: { cwd: string }): Promise<void> {
	await pushRefIfNeeded(target, 'refs/story/checkpoints/v2/main', opts);
	await pushRefIfNeeded(target, V2_FULL_CURRENT_REF_NAME, opts);

	let store: V2GitStore;
	try {
		store = new V2GitStore(opts.cwd);
	} catch {
		return;
	}
	let archived: string[];
	try {
		archived = await store.listArchivedGenerations();
	} catch {
		return;
	}
	if (archived.length === 0) {
		return;
	}
	const latest = archived[archived.length - 1];
	if (latest === undefined) {
		return;
	}
	await pushRefIfNeeded(target, `${V2_FULL_REF_PREFIX}${latest}`, opts);
}

/**
 * Single `git push --no-verify --porcelain <target> <ref>:<ref>` invocation.
 * 2-minute timeout. Throws `Error('non-fast-forward')` when stderr/stdout
 * contains `non-fast-forward` or `rejected` (caller catches this to trigger
 * the fetch+tree-merge recovery path).
 */
async function tryPushRef(
	target: string,
	refName: string,
	opts: { cwd: string },
): Promise<PushResult> {
	const refSpec = `${refName}:${refName}`;
	const cmd = await checkpointGitCommand(target, [
		'push',
		'--no-verify',
		'--porcelain',
		target,
		refSpec,
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
		if (combined.includes('non-fast-forward') || combined.includes('rejected')) {
			throw new Error('non-fast-forward');
		}
		throw new Error(`push failed: ${combined.trim()}`);
	}
	// Mirror Go's `cmd.CombinedOutput()` — parse both streams for the `=`
	// porcelain flag so a no-op push is detected even if the flag lands on
	// stderr.
	return parsePushResult(combined);
}

/**
 * Main retry pipeline for v2 ref pushes. Try → on **any** failure (not
 * just non-fast-forward), runs `fetchAndMergeRef` (fetch + tree-merge,
 * with rotation conflict handling for `/full/current`) → retries the
 * push. Mirrors Go's `doPushRef` (`push_v2.go: doPushRef`) which always
 * proceeds to "Syncing..." after any failed first push.
 *
 * All failures are written to stderr as `[story] Warning` lines — never
 * thrown.
 */
async function doPushRef(target: string, refName: string, opts: { cwd: string }): Promise<void> {
	const w = getStderrWriter();
	const displayTarget = isURL(target) ? 'checkpoint remote' : target;
	const short = shortRefName(refName);

	w.write(`[story] Pushing ${short} to ${displayTarget}...`);
	let stop = startProgressDots(w);

	// First push attempt. On success → done. On any failure → fall through
	// to fetch+merge + retry, matching Go's unconditional "Syncing" path.
	try {
		const result = await tryPushRef(target, refName, opts);
		finishPushRef(stop, result, target, opts);
		return;
	} catch {
		stop('');
	}

	w.write(`[story] Syncing ${short} with remote...`);
	stop = startProgressDots(w);
	try {
		await fetchAndMergeRef(target, refName, opts);
		stop(' done');
	} catch (err) {
		stop('');
		w.write(`[story] Warning: couldn't sync ${short}: ${formatErr(err)}\n`);
		printCheckpointRemoteHint(target);
		return;
	}

	w.write(`[story] Pushing ${short} to ${displayTarget}...`);
	stop = startProgressDots(w);
	try {
		const result = await tryPushRef(target, refName, opts);
		finishPushRef(stop, result, target, opts);
	} catch (err) {
		stop('');
		w.write(`[story] Warning: failed to push ${short} after sync: ${formatErr(err)}\n`);
		printCheckpointRemoteHint(target);
	}
}

/**
 * Fetch the remote ref into a temp ref, detect any rotation conflict on
 * `/full/current`, then either:
 *   - Run the rotation-recovery handler (merges local entries into the
 *     latest remote archived generation + adopts remote `/full/current`)
 *   - Or do a standard tree merge (flatten local + remote entries, build
 *     merged tree, write merge commit, update local ref)
 *
 * Mirrors Go `fetchAndMergeRef` in `push_v2.go`.
 */
async function fetchAndMergeRef(
	target: string,
	refName: string,
	opts: { cwd: string },
): Promise<void> {
	const fetchTarget = await resolveFetchTarget(target, { cwd: opts.cwd });
	const tmpRefSuffix = refName.replace(/\//g, '-');
	const tmpRefName = `refs/story-fetch-tmp/${tmpRefSuffix}`;

	const refSpec = `+${refName}:${tmpRefName}`;
	const baseArgs = ['fetch', '--no-tags', fetchTarget, refSpec];
	const fetchArgs = await appendFetchFilterArgs(baseArgs, { cwd: opts.cwd });
	const cmd = await checkpointGitCommand(fetchTarget, fetchArgs);
	const env: NodeJS.ProcessEnv = { ...(cmd.env ?? process.env), GIT_TERMINAL_PROMPT: '0' };
	const fetchResult = await execa('git', cmd.args, {
		cwd: opts.cwd,
		env,
		timeout: CHECKPOINT_REMOTE_FETCH_TIMEOUT_MS,
		reject: false,
	});
	if (fetchResult.exitCode !== 0) {
		throw new Error(`fetch failed: ${(fetchResult.stderr || fetchResult.stdout).trim()}`);
	}

	try {
		// Rotation-conflict check is only relevant for /full/current. Mirror
		// Go's `if detectErr == nil && len(remoteOnlyArchives) > 0` —
		// `ls-remote` failure (e.g. transient network blip) silently falls
		// through to the standard tree merge, not an outright failure.
		if (refName === V2_FULL_CURRENT_REF_NAME) {
			let remoteOnlyArchives: string[] = [];
			try {
				remoteOnlyArchives = await detectRemoteOnlyArchives(target, opts.cwd);
			} catch (err) {
				warn(
					{ component: 'strategy/push-v2' },
					'detectRemoteOnlyArchives failed; falling back to standard tree merge',
					{ error: err instanceof Error ? err.message : String(err) },
				);
			}
			if (remoteOnlyArchives.length > 0) {
				await handleRotationConflict(
					target,
					fetchTarget,
					refName,
					tmpRefName,
					remoteOnlyArchives,
					opts,
				);
				return;
			}
		}

		await standardTreeMerge(refName, tmpRefName, opts);
	} finally {
		await tryRemoveRef(opts.cwd, tmpRefName);
	}
}

async function standardTreeMerge(
	refName: string,
	tmpRefName: string,
	opts: { cwd: string },
): Promise<void> {
	const localRef = await git.resolveRef({ fs: fsCallback, dir: opts.cwd, ref: refName });
	const localCommit = await git.readCommit({ fs: fsCallback, dir: opts.cwd, oid: localRef });
	const remoteRef = await git.resolveRef({ fs: fsCallback, dir: opts.cwd, ref: tmpRefName });
	const remoteCommit = await git.readCommit({ fs: fsCallback, dir: opts.cwd, oid: remoteRef });

	const entries = new Map<string, TreeEntry>();
	await flattenTree(opts.cwd, localCommit.commit.tree, '', entries);
	await flattenTree(opts.cwd, remoteCommit.commit.tree, '', entries);

	const mergedTreeHash = await buildTreeFromEntries(opts.cwd, entries);
	const mergeCommitHash = await createMergeCommitCommon(
		opts.cwd,
		mergedTreeHash,
		[localRef, remoteRef],
		`Merge remote ${shortRefName(refName)}`,
	);
	await git.writeRef({
		fs: fsCallback,
		dir: opts.cwd,
		ref: refName,
		value: mergeCommitHash,
		force: true,
	});
}

/**
 * Discover archived generation refs on the remote that don't exist
 * locally. Returns them sorted ascending (oldest first).
 *
 * Filters out `/full/current` (not an archived generation) and any ref
 * that doesn't match {@link GENERATION_REF_PATTERN}.
 */
async function detectRemoteOnlyArchives(target: string, cwd: string): Promise<string[]> {
	const fetchTarget = await resolveFetchTarget(target, { cwd });
	const cmd = await checkpointGitCommand(target, [
		'ls-remote',
		fetchTarget,
		`${V2_FULL_REF_PREFIX}*`,
	]);
	const env: NodeJS.ProcessEnv = { ...(cmd.env ?? process.env), GIT_TERMINAL_PROMPT: '0' };
	const result = await execa('git', cmd.args, {
		cwd,
		env,
		timeout: 30_000,
		reject: false,
	});
	if (result.exitCode !== 0) {
		throw new Error(`ls-remote failed: ${(result.stderr || result.stdout).trim()}`);
	}

	const remoteOnly: string[] = [];
	for (const line of result.stdout.split('\n')) {
		const trimmed = line.trim();
		if (trimmed === '') {
			continue;
		}
		const parts = trimmed.split(/\s+/);
		if (parts.length < 2) {
			continue;
		}
		const refName = parts[1];
		if (refName === undefined) {
			continue;
		}
		const suffix = refName.startsWith(V2_FULL_REF_PREFIX)
			? refName.slice(V2_FULL_REF_PREFIX.length)
			: '';
		if (suffix === '' || suffix === 'current' || !GENERATION_REF_PATTERN.test(suffix)) {
			continue;
		}
		try {
			await git.resolveRef({ fs: fsCallback, dir: cwd, ref: refName });
			// Local has it — skip.
		} catch {
			remoteOnly.push(suffix);
		}
	}
	remoteOnly.sort();
	return remoteOnly;
}

/**
 * Handle a `/full/current` rotation conflict: another machine rotated
 * generations while this one was writing. Strategy:
 *   1. Fetch the latest remote-only archived generation
 *   2. Tree-merge local `/full/current` into the archived generation
 *   3. Update `generation.json: newest_checkpoint_at` if the local commit
 *      time is newer
 *   4. Write a merge commit on top of the archived ref
 *   5. Push the updated archived ref
 *   6. Adopt the fetched remote `/full/current` as the local ref
 */
async function handleRotationConflict(
	target: string,
	fetchTarget: string,
	refName: string,
	tmpRefName: string,
	remoteOnlyArchives: string[],
	opts: { cwd: string },
): Promise<void> {
	const latestArchive = remoteOnlyArchives[remoteOnlyArchives.length - 1];
	if (latestArchive === undefined) {
		return;
	}
	const archiveRefName = `${V2_FULL_REF_PREFIX}${latestArchive}`;
	const archiveTmpRef = `refs/story-fetch-tmp/archive-${latestArchive}`;
	const refspec = `+${archiveRefName}:${archiveTmpRef}`;
	const baseArgs = ['fetch', '--no-tags', fetchTarget, refspec];
	const fetchArgs = await appendFetchFilterArgs(baseArgs, { cwd: opts.cwd });
	const cmd = await checkpointGitCommand(fetchTarget, fetchArgs);
	const env: NodeJS.ProcessEnv = { ...(cmd.env ?? process.env), GIT_TERMINAL_PROMPT: '0' };
	const fetchResult = await execa('git', cmd.args, {
		cwd: opts.cwd,
		env,
		timeout: CHECKPOINT_REMOTE_FETCH_TIMEOUT_MS,
		reject: false,
	});
	if (fetchResult.exitCode !== 0) {
		throw new Error(
			`fetch archived generation failed: ${(fetchResult.stderr || fetchResult.stdout).trim()}`,
		);
	}

	try {
		const archiveRef = await git.resolveRef({
			fs: fsCallback,
			dir: opts.cwd,
			ref: archiveTmpRef,
		});
		const archiveCommit = await git.readCommit({
			fs: fsCallback,
			dir: opts.cwd,
			oid: archiveRef,
		});
		const localRef = await git.resolveRef({ fs: fsCallback, dir: opts.cwd, ref: refName });
		const localCommit = await git.readCommit({ fs: fsCallback, dir: opts.cwd, oid: localRef });

		const entries = new Map<string, TreeEntry>();
		await flattenTree(opts.cwd, archiveCommit.commit.tree, '', entries);
		await flattenTree(opts.cwd, localCommit.commit.tree, '', entries);

		const genEntry = entries.get(GENERATION_FILE_NAME);
		if (genEntry !== undefined) {
			const localCommitDate = new Date(localCommit.commit.committer.timestamp * 1000);
			const updated = await updateGenerationTimestamps(opts.cwd, genEntry.hash, localCommitDate);
			if (updated !== null) {
				entries.set(GENERATION_FILE_NAME, updated);
			} else {
				// Mirror Go's `logging.Warn(ctx, "rotation recovery: failed to update
				// generation timestamps, using stale values", ...)`. The merged
				// archive will keep the existing (possibly stale) timestamp.
				warn(
					{ component: 'strategy/push-v2' },
					'rotation recovery: failed to update generation timestamps, using stale values',
					{ generation_blob: genEntry.hash },
				);
			}
		}

		const mergedTreeHash = await buildTreeFromEntries(opts.cwd, entries);
		const mergeCommitHash = await createMergeCommitCommon(
			opts.cwd,
			mergedTreeHash,
			[archiveRef],
			'Merge local checkpoints into archived generation',
		);
		await git.writeRef({
			fs: fsCallback,
			dir: opts.cwd,
			ref: archiveRefName,
			value: mergeCommitHash,
			force: true,
		});

		// Push the updated archive (reuses tryPushRef so the porcelain failure
		// modes are handled identically).
		await tryPushRef(target, archiveRefName, opts);

		// Adopt remote /full/current as local.
		const remoteRef = await git.resolveRef({ fs: fsCallback, dir: opts.cwd, ref: tmpRefName });
		await git.writeRef({
			fs: fsCallback,
			dir: opts.cwd,
			ref: refName,
			value: remoteRef,
			force: true,
		});
	} finally {
		await tryRemoveRef(opts.cwd, archiveTmpRef);
	}
}

/**
 * Read `generation.json` from a blob, update `newest_checkpoint_at` if the
 * provided `newestFromLocal` is newer, then write a new blob and return
 * an updated tree entry. Returns `null` on parse / read failure.
 */
async function updateGenerationTimestamps(
	cwd: string,
	genBlobHash: string,
	newestFromLocal: Date,
): Promise<TreeEntry | null> {
	let raw: Uint8Array;
	try {
		const blob = await git.readBlob({ fs: fsCallback, dir: cwd, oid: genBlobHash });
		raw = blob.blob;
	} catch {
		return null;
	}
	let parsed: { newest_checkpoint_at?: string; [k: string]: unknown };
	try {
		parsed = JSON.parse(new TextDecoder().decode(raw)) as typeof parsed;
	} catch {
		return null;
	}
	const existingTs = parsed.newest_checkpoint_at ? Date.parse(parsed.newest_checkpoint_at) : 0;
	const newestMs = newestFromLocal.getTime();
	if (newestMs > existingTs) {
		parsed.newest_checkpoint_at = newestFromLocal.toISOString();
	}
	const updatedJson = `${JSON.stringify(parsed, null, 2)}\n`;
	const newBlobHash = await git.writeBlob({
		fs: fsCallback,
		dir: cwd,
		blob: new TextEncoder().encode(updatedJson),
	});
	return { name: GENERATION_FILE_NAME, mode: '100644', hash: newBlobHash, type: 'blob' };
}

/**
 * Return a human-readable short form of a v2 ref name for log output:
 * `'refs/story/checkpoints/v2/main'` → `'v2/main'`. Refs that don't match
 * the Story-canonical prefix are returned unchanged (so logs are still
 * readable when, e.g., tests pass `refs/heads/foo`).
 */
export function shortRefName(refName: string): string {
	if (refName.startsWith(REFS_STORY_CHECKPOINTS_PREFIX)) {
		return refName.slice(REFS_STORY_CHECKPOINTS_PREFIX.length);
	}
	return refName;
}

/**
 * Stop the progress dots and print "done" or "already up-to-date". On
 * "done" (new content actually pushed), also fire the once-per-process
 * settings-commit hint shared with v1 push (so the user only sees one
 * hint regardless of which subsystem pushed first).
 *
 * Mirrors Go's shared `finishPush` (`push_common.go: finishPush`) called
 * from both v1 and v2 push paths.
 */
function finishPushRef(
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

async function tryRemoveRef(cwd: string, refName: string): Promise<void> {
	try {
		await execGit(['update-ref', '-d', refName], { cwd });
	} catch {
		// best-effort cleanup
	}
}

function formatErr(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
