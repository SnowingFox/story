/**
 * Detect file changes since the last incremental state snapshot using git
 * porcelain v1 output.
 *
 * Mirrors Go `cmd/entire/cli/state.go`: `FileChanges` struct +
 * `DetectFileChanges` + `filterToUncommittedFiles` + `FilterAndNormalizePaths`
 * + `mergeUnique` + `getUntrackedFilesForState`.
 *
 * **Implementation note**: Go uses `go-git`'s `worktree.Status()`; TS uses
 * `git status --porcelain=v1 -z` via `execGit`. Output contract is identical
 * (`XY path` entries, NUL-separated) so `detectFileChanges` produces the same
 * bucketing result.
 *
 * @packageDocumentation
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execGit, readGitBlob } from '@/git';
import * as log from '@/log';
import { isInfrastructurePath, toRelativePath, worktreeRoot } from '@/paths';

/**
 * Files changed since the baseline. Empty arrays, never null.
 *
 * - `modified` — tracked files with differences vs index/HEAD (`M` / `A` / `R` /
 *   `T` / `U` status codes — anything other than pure untracked / deleted)
 * - `new` — untracked files that did NOT exist at baseline (i.e. appeared
 *   during the turn / task). Pre-existing untracked files (in
 *   `previouslyUntracked`) are silently dropped.
 * - `deleted` — tracked files missing from worktree (either staged delete
 *   `D ` or unstaged delete ` D`)
 */
export interface FileChanges {
	modified: string[];
	new: string[];
	deleted: string[];
}

/**
 * Detect file changes since the baseline. Uses `git status --porcelain=v1 -z`
 * to enumerate:
 *
 * - `??` → `new` (unless `previouslyUntracked` already contained it — those are
 *   the untracked files that existed at baseline and are silently dropped).
 * - `D` in either column → `deleted`
 * - `R` (rename) → emits `<from>` as `deleted` + `<to>` as `modified`. In
 *   porcelain-z format, renames use a two-entry form `R  <to>\0<from>\0`,
 *   so we advance the loop index past the follow-up `<from>` entry to
 *   avoid parsing it as a status entry.
 * - `C` (copy) → emits `<to>` as `modified`; `<from>` is left unchanged.
 *   Same two-entry shape as rename, so the follow-up entry is consumed.
 * - Any other non-space status → `modified`
 *
 * Paths are normalized relative to `repoRoot`, and any path under `.story/`
 * is filtered out (matches Go `FilterAndNormalizePaths`).
 *
 * @example
 * await detectFileChanges(['existing.log']);
 * // { modified: ['src/a.ts'], new: ['src/b.ts'], deleted: ['src/c.ts'] }
 *
 * // Side effects: read-only `git status` invocation.
 */
export async function detectFileChanges(previouslyUntracked: string[] = []): Promise<FileChanges> {
	const root = await worktreeRoot();
	// `-uall` (aka `--untracked-files=all`) expands fresh subdirectories
	// into individual file entries. Without it, git's default
	// `--untracked-files=normal` collapses new directories into a single
	// `?? docs/` line — downstream content-overlap checks
	// (`stagedFilesOverlapWithContent`) compare against full file paths
	// (`docs/red.md`) from the staging area, so a directory-level entry
	// never overlaps and `filesTouched` silently skips every newly-created
	// file. Go's go-git `worktree.Status()` always returns per-file entries
	// — `-uall` is the porcelain equivalent.
	//
	// NB: pass `trim: false` so the leading space in " M <path>" entries
	// is preserved; otherwise `slice(3)` mangles the first char of every
	// worktree-modified path (`src/config.go` → `rc/config.go`).
	const raw = await execGit(['status', '--porcelain=v1', '-z', '-uall'], {
		cwd: root,
		trim: false,
	});
	const entries = raw.split('\0').filter((e) => e.length > 0);

	const prevSet = new Set(previouslyUntracked);
	const modified: string[] = [];
	const newFiles: string[] = [];
	const deleted: string[] = [];
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (entry === undefined || entry.length < 3) {
			continue;
		}
		const x = entry[0];
		const y = entry[1];
		const p = entry.slice(3);
		if (x === 'R' || x === 'C') {
			const from = entries[i + 1];
			if (from !== undefined) {
				i++;
				if (x === 'R') {
					deleted.push(from);
				}
			}
			modified.push(p);
			continue;
		}
		if (x === '?' && y === '?') {
			if (!prevSet.has(p)) {
				newFiles.push(p);
			}
			continue;
		}
		if (x === 'D' || y === 'D') {
			deleted.push(p);
			continue;
		}
		if (x !== ' ' || y !== ' ') {
			modified.push(p);
		}
	}

	return {
		modified: filterAndNormalizePaths(modified, root),
		new: filterAndNormalizePaths(newFiles, root),
		deleted: filterAndNormalizePaths(deleted, root),
	};
}

/**
 * Normalize a list of paths to be worktree-relative and drop any that fall
 * under `.story/` (Story's own infrastructure should never appear as a user
 * change).
 *
 * Mirrors Go `FilterAndNormalizePaths`.
 */
export function filterAndNormalizePaths(files: string[], repoRoot: string): string[] {
	const out: string[] = [];
	for (const f of files) {
		if (f === '') {
			continue;
		}
		let rel: string;
		if (path.isAbsolute(f)) {
			rel = toRelativePath(f, repoRoot);
			if (!rel) {
				continue;
			}
		} else {
			rel = f;
		}
		if (isInfrastructurePath(rel)) {
			continue;
		}
		out.push(rel);
	}
	return out;
}

/**
 * Filter a list down to files whose worktree bytes differ from HEAD (i.e.
 * the file either is not in HEAD at all, or is in HEAD but has local
 * changes). Used by Part 2 `handleLifecycleTurnEnd` to avoid
 * double-counting files the agent already included in a previous checkpoint.
 *
 * Algorithm (mirrors Go `filterToUncommittedFiles` in
 * `entire-cli/cmd/entire/cli/state.go`):
 *
 * 1. If HEAD does not exist (no commits yet), fail-open return `files`.
 * 2. For each file:
 *    - `git show HEAD:<path>` to fetch the blob bytes. If that fails the
 *      file is not in HEAD and we keep it.
 *    - `fs.readFile` the worktree bytes. On read error, keep it (fail-open;
 *      e.g. file deleted in the meantime).
 *    - Compare bytes. If identical, drop it (already committed as-is);
 *      otherwise keep it.
 *
 * Fail-open is the invariant: on any unexpected git/fs error we keep the
 * path so real changes are never silently dropped.
 *
 * Note: TS uses `git show HEAD:<path>` with `encoding: 'buffer'` to get
 * byte-exact blob contents (go-git's `headFile.Contents()` equivalent).
 * The Go implementation uses go-git's `headTree.File()` /
 * `file.Contents()` directly; the on-disk semantics are equivalent.
 */
export async function filterToUncommittedFiles(
	files: string[],
	repoRoot: string,
): Promise<string[]> {
	if (files.length === 0) {
		return files;
	}

	try {
		await execGit(['rev-parse', '--verify', 'HEAD'], { cwd: repoRoot });
	} catch {
		return files;
	}

	const out: string[] = [];
	for (const f of files) {
		let headBytes: Buffer;
		try {
			headBytes = await readGitBlob(`HEAD:${f}`, { cwd: repoRoot });
		} catch {
			out.push(f);
			continue;
		}

		let workingBytes: Buffer;
		try {
			workingBytes = await fs.readFile(path.join(repoRoot, f));
		} catch {
			out.push(f);
			continue;
		}

		if (Buffer.compare(headBytes, workingBytes) !== 0) {
			out.push(f);
		}
	}
	return out;
}

/**
 * Merge two string arrays, preserving order and deduplicating.
 *
 * Mirrors Go `mergeUnique`.
 */
export function mergeUnique(base: string[], extra: string[]): string[] {
	const seen = new Set(base);
	const out = [...base];
	for (const item of extra) {
		if (!seen.has(item)) {
			seen.add(item);
			out.push(item);
		}
	}
	return out;
}

/**
 * Read the current set of untracked files (`git status --porcelain=v1 -z`
 * filtered to `??` entries). Used by `capturePrePromptState` /
 * `capturePreTaskState` to seed the baseline snapshot.
 *
 * Paths inside `.story/` (checkpoint-cache / tmp / etc.) are filtered out
 * via {@link isInfrastructurePath} so Story's own scratch files never
 * appear as "changed" in snapshots. Mirrors Go `state.go`
 * (`if !paths.IsInfrastructurePath(file) { untrackedFiles = append(...) }`).
 *
 * TS-divergence (error handling only): swallows any fs/git error, returns
 * `[]`, and emits a `log.warn` at the helper level so the caller sees an
 * empty list instead of an error. Go `state.go: getUntrackedFilesForState`
 * returns `error` up the stack and the caller (`CapturePrePromptState` /
 * `CapturePreTaskState`) propagates it. The Story-side handlers wrap
 * lifecycle-event failures at a higher level, so failing-closed here
 * would break banner / baseline snapshot flows unnecessarily.
 *
 * @example
 * await getUntrackedFilesForState();
 * // → ['untracked.log', 'new.txt']   (`.story/tmp/pre-prompt-sid.json` excluded)
 */
export async function getUntrackedFilesForState(): Promise<string[]> {
	try {
		const root = await worktreeRoot();
		// `-uall` so a brand-new subdirectory expands to per-file entries
		// rather than collapsing to `?? docs/` (Go parity — see
		// `detectFileChanges` comment). `trim: false` so the leading
		// space of `?? <path>` is preserved (otherwise `entry.slice(3)`
		// mangles the path's first char).
		const raw = await execGit(['status', '--porcelain=v1', '-z', '-uall'], {
			cwd: root,
			trim: false,
		});
		const out: string[] = [];
		for (const entry of raw.split('\0')) {
			if (entry.length >= 3 && entry[0] === '?' && entry[1] === '?') {
				const p = entry.slice(3);
				if (!isInfrastructurePath(p)) {
					out.push(p);
				}
			}
		}
		return out;
	} catch (err) {
		log.warn({ component: 'lifecycle' }, 'failed to capture untracked file list', {
			error: (err as Error).message,
		});
		return [];
	}
}
