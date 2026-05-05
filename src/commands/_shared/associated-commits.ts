/**
 * Find git commits that reference a given checkpoint ID via their
 * `Story-Checkpoint:` trailer.
 *
 * Mirrors Go `cmd/entire/cli/explain.go: getAssociatedCommits` (the
 * reader side of the `--search-all` flag for `story explain`).
 *
 * Go behaviour:
 *   - default (searchAll=false): first-parent DAG walk with depth limit
 *     `commitScanLimit = 500` — avoids walking into main's history
 *     through merge commit parents
 *   - `--search-all`: full DAG walk with NO depth limit — catches commits
 *     on merged feature branches (second parents of merges)
 *
 * Story-side simplification: `isomorphic-git`'s `git.log` always follows
 * all parents of merges (no first-parent filter). We toggle between
 * depth-limited (500) and unlimited walks. When cross-branch commits
 * leak into the default view, they're labelled so the user can see
 * where they came from. Go's `computeReachableFromMain` filter is not
 * ported (documented TS-divergence in Phase 9.4 impl.md TS-divergence #9).
 *
 * @packageDocumentation
 */

import fsCallback from 'node:fs';
import git from 'isomorphic-git';
import * as log from '@/log';
import { parseCheckpoint } from '@/trailers';

/** Maximum commits walked in default (non --search-all) mode. Mirrors Go `commitScanLimit = 500`. */
export const COMMIT_SCAN_LIMIT = 500;

/**
 * A git commit whose message carries a matching `Story-Checkpoint:` trailer.
 * Shape mirrors Go `associatedCommit`.
 */
export interface AssociatedCommit {
	readonly sha: string;
	readonly shortSha: string;
	readonly message: string;
	readonly author: string;
	readonly email: string;
	readonly date: Date;
}

/**
 * Walk the commit history reachable from `HEAD` and collect commits whose
 * message carries a `Story-Checkpoint:` trailer matching `checkpointId`.
 *
 * Mirrors Go `explain.go: getAssociatedCommits`. Returns an **empty array**
 * on any git error (best-effort, matches Go caller which wraps the call
 * with `//nolint:errcheck` and logs).
 *
 * @example
 * await getAssociatedCommits('/repo', 'ckpt_abcdef123456', false);
 * // returns: [{sha, shortSha, message, author, email, date}, ...]
 * //         (commits within the last 500 of HEAD's history)
 *
 * await getAssociatedCommits('/repo', 'ckpt_abcdef123456', true);
 * // returns: same shape, but walk unbounded — catches commits on
 * //         merged feature branches that Go's first-parent walk skips.
 *
 * // Side effects: read-only — walks git objects via isomorphic-git's
 * // `log()`. No writes, no ref changes.
 */
export async function getAssociatedCommits(
	repoDir: string,
	checkpointId: string,
	searchAll: boolean,
): Promise<AssociatedCommit[]> {
	if (checkpointId === '') {
		return [];
	}
	let headOid: string;
	try {
		headOid = await git.resolveRef({ fs: fsCallback, dir: repoDir, ref: 'HEAD' });
	} catch (e) {
		log.debug({ component: 'commands/_shared/associated-commits' }, 'HEAD unreadable', {
			error: (e as Error).message,
		});
		return [];
	}

	let entries: Awaited<ReturnType<typeof git.log>>;
	try {
		entries = await git.log({
			fs: fsCallback,
			dir: repoDir,
			ref: headOid,
			// searchAll = full DAG (no depth cap). Default = bounded walk so
			// we don't spend seconds on long histories.
			...(searchAll ? {} : { depth: COMMIT_SCAN_LIMIT }),
		});
	} catch (e) {
		log.debug({ component: 'commands/_shared/associated-commits' }, 'git.log failed', {
			error: (e as Error).message,
		});
		return [];
	}

	const matches: AssociatedCommit[] = [];
	for (const entry of entries) {
		const trailer = parseCheckpoint(entry.commit.message);
		if (trailer === null || trailer !== checkpointId) {
			continue;
		}
		const sha = entry.oid;
		const shortSha = sha.length >= 7 ? sha.slice(0, 7) : sha;
		const firstLine = entry.commit.message.split('\n', 1)[0] ?? '';
		matches.push({
			sha,
			shortSha,
			message: firstLine,
			author: entry.commit.author.name,
			email: entry.commit.author.email,
			// isomorphic-git `author.timestamp` is seconds-since-epoch.
			date: new Date(entry.commit.author.timestamp * 1000),
		});
	}
	return matches;
}
