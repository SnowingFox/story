/**
 * Shared push primitives used by both `push-common.ts` and `push-v2.ts`.
 *
 * Lives in its own file to avoid TypeScript circular import. Go puts these
 * helpers in `push_common.go`, but Go has no import-cycle constraint.
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/strategy/push_common.go`
 * (`isURL` / `startProgressDots` / `createMergeCommitCommon` /
 * `printCheckpointRemoteHint`).
 */

import fsCallback from 'node:fs';
import git from 'isomorphic-git';
import { getGitAuthor } from '@/git';
import { getStderrWriter } from './hooks-tty';

/** Outcome of a single push attempt. */
export interface PushResult {
	/** True when the remote already had all commits (nothing transferred). */
	upToDate: boolean;
}

/**
 * Detect whether a target string is a URL (vs. a remote name).
 *
 * URL = string contains `://` (HTTPS / `ssh://` form) **or** `@` (SSH SCP
 * `git@host:path` form). Anything else (e.g. `'origin'`, `'upstream'`) is
 * treated as a git remote name and resolved via `git remote get-url`.
 *
 * @example
 * ```ts
 * isURL('origin');                              // false
 * isURL('https://github.com/o/r.git');          // true
 * isURL('ssh://git@github.com/o/r.git');        // true
 * isURL('git@github.com:o/r.git');              // true
 * ```
 */
export function isURL(target: string): boolean {
	return target.includes('://') || target.includes('@');
}

/**
 * Print `.` to `w` every second until the returned `stop` callback is
 * invoked. The `stop` callback prints a final suffix (e.g. `' done'` or
 * `' already up-to-date'`) followed by a newline, then clears the
 * underlying interval timer.
 *
 * Used to give visual feedback during push / fetch operations that may take
 * several seconds. Mirrors Go `startProgressDots` in `push_common.go`.
 *
 * @example
 * ```ts
 * process.stderr.write('[story] Pushing main to origin');
 * const stop = startProgressDots(process.stderr);
 *
 * try {
 *   await doPush();         // may take 5s
 *   stop(' done');          // → "[story] Pushing main to origin..... done\n"
 * } catch {
 *   stop(' failed');        // → "[story] Pushing main to origin... failed\n"
 * }
 *
 * // Side effects:
 * //   - setInterval(1000) writes '.' to w on each tick
 * //   - stop() clears the timer + writes the suffix + '\n'
 * //   - Disk / git refs / HEAD: unchanged
 * ```
 */
export function startProgressDots(w: NodeJS.WritableStream): (suffix: string) => void {
	let stopped = false;
	const timer = setInterval(() => {
		if (!stopped) {
			w.write('.');
		}
	}, 1000);
	return (suffix: string): void => {
		if (stopped) {
			return;
		}
		stopped = true;
		clearInterval(timer);
		w.write(`${suffix}\n`);
	};
}

/**
 * Create a merge commit pointing at `treeHash` with the given parent
 * commits and message. Author + committer use the local git config
 * identity (`user.name` / `user.email`). Used by `fetchAndMergeRef`
 * (push-v2.ts) when a v2 ref push needs a merge commit on top of the
 * tree-flatten merge result.
 *
 * Mirrors Go `createMergeCommitCommon` in `push_common.go`.
 *
 * @example
 * ```ts
 * await createMergeCommitCommon(
 *   '/repo',
 *   mergedTreeHash,
 *   [localHash, remoteHash],
 *   'Merge remote v2/main',
 * );
 * // returns: '7a3b9c...' (new commit hash)
 *
 * // Side effects in `<repoDir>/.git/`:
 * //   objects/7a/3b9c... ← new commit object (parents: [localHash, remoteHash], tree: mergedTreeHash)
 * //
 * // Refs / worktree / HEAD: unchanged. Caller updates the ref.
 * ```
 */
export async function createMergeCommitCommon(
	repoDir: string,
	treeHash: string,
	parents: string[],
	message: string,
): Promise<string> {
	const author = await getGitAuthor(repoDir);
	const now = Math.floor(Date.now() / 1000);
	const sig = {
		name: author.name,
		email: author.email,
		timestamp: now,
		timezoneOffset: 0,
	};

	return git.writeCommit({
		fs: fsCallback,
		dir: repoDir,
		commit: {
			tree: treeHash,
			parent: parents,
			author: sig,
			committer: sig,
			message,
		},
	});
}

/**
 * Print a stderr hint when a push to a checkpoint URL fails. Only prints
 * when the target is a URL (not the user's default remote).
 *
 * Shared between [`./push-common.ts`](./push-common.ts) and
 * [`./push-v2.ts`](./push-v2.ts) so the user sees the same message
 * regardless of which subsystem failed. Mirrors Go's single-source
 * `printCheckpointRemoteHint` in `push_common.go`.
 */
export function printCheckpointRemoteHint(target: string): void {
	if (!isURL(target)) {
		return;
	}
	const w = getStderrWriter();
	w.write(
		'[story] A checkpoint remote is configured in Story settings (.story/settings.json or .story/settings.local.json) but could not be synced.\n',
	);
	w.write(
		'[story] Checkpoints are saved locally but not synced. Ensure you have access to the checkpoint remote and that its checkpoint branch accepts updates.\n',
	);
}
