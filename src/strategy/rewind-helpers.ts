/**
 * Read-side helpers for rewind operations: dirty-worktree checks, untracked
 * file enumeration, and task-checkpoint metadata extraction.
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/strategy/common.go:1011-1313`:
 * `checkCanRewindWithWarning`, `getTaskCheckpointFromTree`,
 * `getTaskTranscriptFromTree`, `collectUntrackedFiles`.
 *
 * **Phase 5.1 scope**: helpers ship as standalone functions; Phase 5.5
 * wires them into `ManualCommitStrategy.rewind` / `previewRewind` / etc.
 *
 * @packageDocumentation
 */

import fsCallback from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import git from 'isomorphic-git';
import * as registry from '../agent/registry';
import {
	CHECKPOINT_FILE_NAME,
	TRANSCRIPT_FILE_NAME,
	TRANSCRIPT_FILE_NAME_LEGACY,
} from '../checkpoint/constants';
import { execGit } from '../git';
import { parseMetadataJSON } from '../jsonutil';
import { isInfrastructurePath, isSubpath } from '../paths';
import type { TaskCheckpoint } from './types';

/**
 * Run `git status --porcelain -z` and return the **raw** NUL-delimited
 * stdout. `-z` is required to correctly handle filenames with `\n`,
 * tabs, or C-quoted special characters.
 *
 * Mirrors Go `common.go: checkCanRewindWithWarning` which gets the same
 * byte-safe behaviour from go-git's `Worktree.Status()` map.
 */
async function gitStatusRaw(cwd: string): Promise<string> {
	const { stdout } = await execa('git', ['status', '--porcelain', '-z'], { cwd });
	return stdout;
}

/**
 * Split NUL-delimited byte output (as produced by `git status -z`,
 * `git ls-files -z`, and friends). Trailing `\0` — typical for
 * `git ls-files -z` — is stripped so callers don't see a spurious
 * empty entry. Empty input returns `[]`.
 *
 * Mirrors Go `strings.Split(raw, "\x00")` inlined throughout
 * `common.go` — extracted here to avoid drift between the two TS
 * call sites ({@link checkCanRewindWithWarning} + {@link collectUntrackedFiles}).
 *
 * @example
 * parseNullDelimited('');                         // []
 * parseNullDelimited('a\0b\0c\0');                // ['a', 'b', 'c']
 * parseNullDelimited('name with \nnewline\0ok');  // ['name with \nnewline', 'ok']
 */
export function parseNullDelimited(raw: string): string[] {
	if (raw === '') {
		return [];
	}
	const parts = raw.split('\x00');
	// git -z output terminates every entry with \0 — drop the empty tail.
	while (parts.length > 0 && parts[parts.length - 1] === '') {
		parts.pop();
	}
	return parts;
}

/**
 * Returns the list of repository directories that must never be modified or
 * deleted during rewind / reset.
 *
 * Composition: base infrastructure pair (`.git`, `.story`) + every directory
 * declared by {@link Agent.protectedDirs} of every registered agent (e.g.,
 * Vogon contributes `.vogon`; Phase 6.2-6.6 will add `.claude`, `.cursor`,
 * `.gemini`, etc.). Result is deduped + lexically sorted (matches Go).
 *
 * Mirrors Go `common.go:251-266` (`protectedDirs`). Go uses `sync.Once` to
 * cache; TS returns a fresh array each call — cheap because the registry is
 * a small in-memory Map and `Agent.protectedDirs` returns hard-coded literals.
 * No cache means new agents registered mid-process are picked up immediately
 * (useful for `withTestRegistry` test isolation).
 */
export function protectedDirs(): string[] {
	return [...new Set(['.git', '.story', ...registry.allProtectedDirs()])].sort();
}

/**
 * Returns true when `relPath` is **inside** (or equal to) any directory in
 * {@link protectedDirs}. Used by {@link collectUntrackedFiles} as a
 * defense-in-depth filter so rewind never touches `.git/...`, `.story/...`,
 * or (Phase 6.1+) agent config directories — even if `git ls-files
 * --exclude-standard` ever leaks them.
 *
 * Mirrors Go `common.go:238-249` (`isProtectedPath`).
 *
 * @example
 * ```ts
 * isProtectedPath('.git/HEAD')                  // true
 * isProtectedPath('.story')                     // true  (boundary: dir itself)
 * isProtectedPath('.story/metadata/sess/0/x')   // true
 * isProtectedPath('src/foo.ts')                 // false
 * isProtectedPath('.gitignore')                 // false (not under .git/)
 * ```
 */
export function isProtectedPath(relPath: string): boolean {
	for (const dir of protectedDirs()) {
		if (isSubpath(dir, relPath)) {
			return true;
		}
	}
	return false;
}

/**
 * Check whether a rewind is currently safe — always allows rewind, but
 * builds a Go-rich warning message with per-file `+/-` diff stats and a
 * `Total:` footer line.
 *
 * Mirrors Go `common.go: checkCanRewindWithWarning`. Phase 5.5 upgraded
 * from the Phase 5.1 simplified `string[]` shape to the rich diff-stats
 * format used by Go. Story CLI consumers (Phase 9.3) print `message`
 * before asking the user to confirm.
 *
 * 4-way file classification (mirrors Go decision table):
 * - `added`    — git status `A` → counts every line of the worktree file as `+`
 * - `deleted`  — git status `D` → counts every line of the HEAD blob as `-`
 * - `modified` — git status `M` → diffs HEAD blob vs worktree via {@link computeDiffStats}
 * - other      — skipped (`??` untracked, renamed, copied, unmerged etc.)
 *
 * `.story/` infrastructure paths (via {@link isInfrastructurePath}) are
 * skipped so noise from internal metadata doesn't leak to the user.
 *
 * @example
 * ```ts
 * await checkCanRewindWithWarning(repoDir);
 * // Clean worktree:
 * // returns: { canRewind: true, message: '' }
 *
 * // 1 modified (+3/-2) + 1 added (+10):
 * // returns: {
 * //   canRewind: true,
 * //   message:
 * //     'The following uncommitted changes will be reverted:\n' +
 * //     '  added:     new.ts (+10)\n' +
 * //     '  modified:  src/app.ts (+3/-2)\n' +
 * //     '\nTotal: +13/-2 lines\n'
 * // }
 *
 * // Side effects: none — read-only `git status --porcelain` + `git rev-parse HEAD` +
 * // multiple fs.readFile / git tree blob reads. `canRewind` is always true;
 * // message is advisory.
 * //
 * // Disk / git refs / HEAD / index / worktree: unchanged.
 * ```
 */
export async function checkCanRewindWithWarning(repoDir: string): Promise<{
	canRewind: boolean;
	message: string;
}> {
	// Empty repo / can't open / no HEAD → return canRewind=true silently
	// (Go semantics: `return true, "", nil` for any precondition failure).
	let headHash: string;
	try {
		headHash = (await execGit(['rev-parse', 'HEAD'], { cwd: repoDir })).trim();
	} catch {
		return { canRewind: true, message: '' };
	}

	let status: string;
	try {
		status = await gitStatusRaw(repoDir);
	} catch {
		return { canRewind: true, message: '' };
	}
	if (status === '') {
		return { canRewind: true, message: '' };
	}

	let headTreeOid: string;
	try {
		const { commit } = await git.readCommit({ fs: fsCallback, dir: repoDir, oid: headHash });
		headTreeOid = commit.tree;
	} catch {
		return { canRewind: true, message: '' };
	}

	type FileChange = {
		status: 'added' | 'deleted' | 'modified';
		added: number;
		removed: number;
		filename: string;
	};
	const changes: FileChange[] = [];

	for (const line of parseNullDelimited(status)) {
		// `-z` porcelain format is "XY filename" — exactly 2 status chars + space + path.
		// Entries shorter than 4 chars are noise.
		if (line.length < 4) {
			continue;
		}
		const code = line.slice(0, 2);
		const filepath = line.slice(3);
		if (isInfrastructurePath(filepath)) {
			continue;
		}
		// Skip untracked: warn focuses on tracked changes; untracked files are
		// handled separately by rewind Step 5.
		if (code === '??') {
			continue;
		}

		let added = 0;
		let removed = 0;
		let kind: 'added' | 'deleted' | 'modified';

		if (code.includes('A')) {
			kind = 'added';
			try {
				const buf = await fs.readFile(path.join(repoDir, filepath));
				added = countLines(new Uint8Array(buf));
			} catch {
				// keep added=0 on race deletion
			}
		} else if (code.includes('D')) {
			kind = 'deleted';
			const blob = await readBlobAtPath(repoDir, headTreeOid, filepath);
			if (blob !== null) {
				removed = countLines(blob);
			}
		} else if (code.includes('M')) {
			kind = 'modified';
			const headBlob = await readBlobAtPath(repoDir, headTreeOid, filepath);
			let workBuf: Uint8Array | null = null;
			try {
				workBuf = new Uint8Array(await fs.readFile(path.join(repoDir, filepath)));
			} catch {
				workBuf = null;
			}
			if (headBlob !== null && workBuf !== null) {
				[added, removed] = computeDiffStats(headBlob, workBuf);
			}
		} else {
			continue;
		}
		changes.push({ status: kind, added, removed, filename: filepath });
	}

	if (changes.length === 0) {
		return { canRewind: true, message: '' };
	}

	// Sort by filename for stable output.
	changes.sort((a, b) => a.filename.localeCompare(b.filename));

	const lines: string[] = ['The following uncommitted changes will be reverted:'];
	let totalAdded = 0;
	let totalRemoved = 0;
	for (const c of changes) {
		totalAdded += c.added;
		totalRemoved += c.removed;
		let stats = '';
		if (c.added > 0 && c.removed > 0) {
			stats = `+${c.added}/-${c.removed}`;
		} else if (c.added > 0) {
			stats = `+${c.added}`;
		} else if (c.removed > 0) {
			stats = `-${c.removed}`;
		}
		const label = `${c.status}:`.padEnd(10);
		lines.push(`  ${label} ${c.filename}${stats !== '' ? ` (${stats})` : ''}`);
	}
	if (totalAdded > 0 || totalRemoved > 0) {
		lines.push('');
		lines.push(`Total: +${totalAdded}/-${totalRemoved} lines`);
	}

	return { canRewind: true, message: `${lines.join('\n')}\n` };
}

/**
 * Count newline-delimited lines in a buffer. Trailing newline does NOT
 * count as an extra line. Empty input → 0.
 *
 * Mirrors Go `common.go: countLines`.
 *
 * @example
 * ```ts
 * countLines(new TextEncoder().encode(''));            // 0
 * countLines(new TextEncoder().encode('a'));           // 1   (single line, no newline)
 * countLines(new TextEncoder().encode('a\n'));         // 1   (trailing newline NOT extra)
 * countLines(new TextEncoder().encode('a\nb'));        // 2
 * countLines(new TextEncoder().encode('a\nb\nc\n'));   // 3
 * ```
 */
export function countLines(content: Uint8Array): number {
	if (content.length === 0) {
		return 0;
	}
	let count = 1;
	for (const byte of content) {
		if (byte === 0x0a) {
			count++;
		}
	}
	if (content[content.length - 1] === 0x0a) {
		count--;
	}
	return count;
}

/**
 * Diff two buffers line-by-line and return `[added, removed]` counts. Uses
 * Go's set-multiset algorithm (NOT LCS): build a multiset from the old
 * lines, decrement on every match seen in the new lines, count unmatched
 * new lines as `added`, and treat the leftover old multiset entries as
 * `removed`. Cheap and order-insensitive — matches Go behavior for diff
 * stats (not for patches).
 *
 * Normalizes Windows `\r\n` → `\n` first via {@link splitLines}.
 *
 * Mirrors Go `common.go: computeDiffStats`.
 *
 * @example
 * ```ts
 * const enc = (s: string) => new TextEncoder().encode(s);
 *
 * computeDiffStats(enc('a\nb\nc'), enc('a\nb\nd'));   // [1, 1]
 * computeDiffStats(enc(''), enc('a\nb'));             // [2, 0]
 * computeDiffStats(enc('a\nb'), enc(''));             // [0, 2]
 * computeDiffStats(enc('a\nb'), enc('a\nb'));         // [0, 0]
 * computeDiffStats(enc('a\r\nb'), enc('a\nb'));       // [0, 0]   (CRLF normalized)
 * ```
 */
export function computeDiffStats(
	oldContent: Uint8Array,
	newContent: Uint8Array,
): [added: number, removed: number] {
	const oldLines = splitLines(oldContent);
	const newLines = splitLines(newContent);
	const oldSet = new Map<string, number>();
	for (const line of oldLines) {
		oldSet.set(line, (oldSet.get(line) ?? 0) + 1);
	}
	let added = 0;
	for (const line of newLines) {
		const c = oldSet.get(line) ?? 0;
		if (c > 0) {
			oldSet.set(line, c - 1);
		} else {
			added++;
		}
	}
	let removed = 0;
	for (const c of oldSet.values()) {
		removed += c;
	}
	return [added, removed];
}

/**
 * Split content into lines (preserving empty intermediate lines).
 * Normalizes Windows `\r\n` → `\n` first. A trailing `\n` does NOT
 * produce an empty trailing element. Empty input → empty array.
 *
 * Mirrors Go `common.go: splitLines`.
 *
 * @example
 * ```ts
 * const enc = (s: string) => new TextEncoder().encode(s);
 *
 * splitLines(enc(''));               // []
 * splitLines(enc('one'));             // ['one']
 * splitLines(enc('a\nb'));            // ['a', 'b']
 * splitLines(enc('a\nb\n'));          // ['a', 'b']                 (trailing \n stripped)
 * splitLines(enc('a\r\nb\r\nc'));     // ['a', 'b', 'c']            (CRLF normalized)
 * splitLines(enc('a\n\nb'));          // ['a', '', 'b']             (empty middle preserved)
 * ```
 */
export function splitLines(content: Uint8Array): string[] {
	if (content.length === 0) {
		return [];
	}
	let s = new TextDecoder('utf-8').decode(content);
	s = s.replaceAll('\r\n', '\n');
	if (s.endsWith('\n')) {
		s = s.slice(0, -1);
	}
	return s.split('\n');
}

/**
 * List all untracked files in the worktree (relative paths). Filters out
 * any path under {@link protectedDirs} (`.git/`, `.story/`, future agent
 * config dirs) as defense-in-depth so callers never act on a leaked
 * infrastructure path.
 *
 * Mirrors Go `common.go:1383-1413` (`collectUntrackedFiles`) including the
 * `isProtectedPath` post-filter at line 1408. Used by rewind to remember
 * which untracked files existed at session start (so they aren't deleted
 * when rewinding to that point).
 *
 * @example
 * ```ts
 * await collectUntrackedFiles(repoDir);
 * // returns: ['notes.txt', 'tmp/foo.log']   (untracked + not gitignored + not protected)
 * // returns: []                              (clean worktree, or only protected paths leaked)
 *
 * // Side effects: none — runs `git ls-files --others --exclude-standard`.
 * //
 * // Disk / git refs / HEAD / index: unchanged.
 * ```
 */
export async function collectUntrackedFiles(repoDir: string): Promise<string[]> {
	// Go: common.go:1377-1407 uses `exec.CommandContext(ctx, "git", "ls-files",
	// "--others", "--exclude-standard", "-z")` + `strings.Split(raw, "\x00")`.
	// `-z` is required to correctly handle filenames with newlines, tabs, or
	// non-ASCII characters that `ls-files` would otherwise C-quote.
	const { stdout } = await execa('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
		cwd: repoDir,
	});
	if (stdout === '') {
		return [];
	}
	// Defense-in-depth: filter protected paths (`.git/...`, `.story/...`, etc.)
	// even though `--exclude-standard` should already drop them — guards
	// against stale gitignore / agent dirs / .git that some configs leak.
	// Mirrors Go `common.go:1408` filter step.
	return parseNullDelimited(stdout)
		.filter((line) => line.length > 0)
		.filter((line) => !isProtectedPath(line));
}

/**
 * Read a task subagent's `checkpoint.json` from a given tree at a given
 * task-metadata directory path (relative to the tree root).
 *
 * Mirrors Go `common.go:1226-1290` (`getTaskCheckpointFromTree`).
 *
 * @returns the parsed `TaskCheckpoint`, or `null` when the file is missing
 *   or malformed (matches Go's "missing = nil, error = real failure" split).
 *
 * @example
 * ```ts
 * await getTaskCheckpointFromTree(repoDir, treeHash, '.story/metadata/sess/tasks/tu_1');
 * // returns: { sessionId: 'sess', toolUseId: 'tu_1', checkpointUuid: 'uuid-1', agentId: 'a1' }
 *
 * await getTaskCheckpointFromTree(repoDir, treeHash, '.story/metadata/sess/tasks/missing');
 * // returns: null   (no checkpoint.json blob in the tree at that path)
 *
 * // Side effects: none — read-only blob lookup in the given tree.
 * //
 * // Disk / git refs / HEAD: unchanged.
 * ```
 */
export async function getTaskCheckpointFromTree(
	repoDir: string,
	treeHash: string,
	taskMetadataDir: string,
): Promise<TaskCheckpoint | null> {
	const blob = await readBlobAtPath(
		repoDir,
		treeHash,
		joinPath(taskMetadataDir, CHECKPOINT_FILE_NAME),
	);
	if (blob === null) {
		return null;
	}
	try {
		return parseMetadataJSON<TaskCheckpoint>(new TextDecoder('utf-8').decode(blob));
	} catch {
		return null;
	}
}

/**
 * Read the **session-level** transcript blob for a task checkpoint. The task
 * metadata directory is nested two levels under the session directory
 * (`<sessionDir>/tasks/<toolUseID>`); the transcript lives in the session
 * directory itself, NOT inside the task subdirectory.
 *
 * Mirrors Go `common.go:1271-1313` (`getTaskTranscriptFromTree`):
 *
 * 1. Compute `sessionDir = Dir(Dir(taskMetadataDir))` — strip the
 *    `tasks/<toolUseID>` suffix
 * 2. Try `<sessionDir>/<TRANSCRIPT_FILE_NAME>` (modern: `full.jsonl`)
 * 3. On miss, try `<sessionDir>/<TRANSCRIPT_FILE_NAME_LEGACY>` (legacy: `full.log`)
 *
 * Returns transcript bytes, or `null` when neither filename resolves.
 *
 * @example
 * await getTaskTranscriptFromTree(
 *   repoDir,
 *   treeHash,
 *   '.story/metadata/sess/tasks/tu_1',
 * );
 * // Reads from .story/metadata/sess/full.jsonl (modern)
 * //  or       .story/metadata/sess/full.log    (legacy fallback)
 */
export async function getTaskTranscriptFromTree(
	repoDir: string,
	treeHash: string,
	taskMetadataDir: string,
): Promise<Uint8Array | null> {
	// Strip "tasks/<toolUseID>" → session directory.
	// Use POSIX path semantics regardless of host OS (tree paths are always /-separated).
	const sessionDir = path.posix.dirname(path.posix.dirname(taskMetadataDir));

	const modern = await readBlobAtPath(
		repoDir,
		treeHash,
		joinPath(sessionDir, TRANSCRIPT_FILE_NAME),
	);
	if (modern !== null) {
		return modern;
	}
	return readBlobAtPath(repoDir, treeHash, joinPath(sessionDir, TRANSCRIPT_FILE_NAME_LEGACY));
}

/**
 * Read a blob at `pathInTree` (slash-separated). Returns `null` when any
 * segment / leaf is missing or non-blob. Tolerates traversal failures.
 * Internal tree-walking helper.
 */
async function readBlobAtPath(
	repoDir: string,
	treeHash: string,
	pathInTree: string,
): Promise<Uint8Array | null> {
	const segments = pathInTree.split('/').filter((s) => s !== '');
	if (segments.length === 0) {
		return null;
	}
	let currentTree = treeHash;
	for (let i = 0; i < segments.length - 1; i++) {
		try {
			const result = await git.readTree({ fs: fsCallback, dir: repoDir, oid: currentTree });
			const child = result.tree.find((e) => e.path === segments[i] && e.type === 'tree');
			if (!child) {
				return null;
			}
			currentTree = child.oid;
		} catch {
			return null;
		}
	}
	const leaf = segments[segments.length - 1];
	try {
		const result = await git.readTree({ fs: fsCallback, dir: repoDir, oid: currentTree });
		const blobEntry = result.tree.find((e) => e.path === leaf && e.type === 'blob');
		if (!blobEntry) {
			return null;
		}
		const blob = await git.readBlob({ fs: fsCallback, dir: repoDir, oid: blobEntry.oid });
		return blob.blob;
	} catch {
		return null;
	}
}

function joinPath(...parts: string[]): string {
	return parts.filter((p) => p !== '').join('/');
}
