/**
 * Content-aware overlap detection used by Phase 5.4 PostCommit /
 * PrepareCommitMsg to decide whether a commit contains session work.
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/strategy/content_overlap.go` (635
 * lines, 8 export + 5 private helpers).
 *
 * Why this lives in Phase 5.2 (not 5.4): see [phase-5.2 module.md "为什么
 * content_overlap.go 归 5.2 而不归 5.4"](../../docs/ts-rewrite/impl/phase-5-strategy/phase-5.2-save-step/module.md).
 *
 * Design notes:
 * - All exports are standalone (no `s: ManualCommitStrategy` parameter) —
 *   they only need a `repoDir` and isomorphic-git plumbing.
 * - `logCtx` is optional; defaults to `{ component: 'checkpoint' }`. Phase 5.4
 *   PostCommit threads in `{ component: 'checkpoint', sessionId }`.
 * - `splitLines` mirrors Go `common.go:1208-1218` exactly (`\r\n` → `\n` +
 *   trim trailing `\n` + split). Naive `content.split(/\r?\n/)` diverges on
 *   inputs ending in `\n`.
 * - `trimLine` only strips ` ` and `\t` (NOT `String.prototype.trim()`,
 *   which also strips `\u00A0` etc.).
 *
 * @packageDocumentation
 */

import { createHash } from 'node:crypto';
import fsCallback from 'node:fs';
import path from 'node:path';
import git from 'isomorphic-git';
import { execGit } from '../git';
import type { LogContext } from '../log';
import * as log from '../log';

/**
 * Pre-resolved git objects to avoid redundant reads during PostCommit /
 * PrepareCommitMsg. When a field is non-null, callers use it directly
 * instead of reading from the repo.
 *
 * Mirrors Go `content_overlap.go:45-50` (`overlapOpts`).
 */
export interface OverlapOpts {
	/** HEAD commit's tree hash (raw 40-char hex). null = not pre-resolved. */
	headTree?: string | null;
	/** Shadow branch tree hash. null = not pre-resolved. */
	shadowTree?: string | null;
	/** HEAD's first parent's tree hash. null = not pre-resolved OR initial commit. */
	parentTree?: string | null;
	/**
	 * Disambiguates `parentTree=null` (initial commit) from `parentTree=null`
	 * (not resolved). When `true`, the algorithm skips the lazy parent-tree
	 * read and treats null as "initial commit".
	 */
	hasParentTree?: boolean;
}

const CHECKPOINT_LOG_CTX: LogContext = { component: 'checkpoint' };

/**
 * Check whether any file in `filesTouched` overlaps with the committed
 * content, using content-aware comparison to detect "reverted-and-replaced".
 *
 * Decision tree per file (returns true on first overlap):
 * 1. **deletion**: file in parentTree, NOT in headTree → overlap
 * 2. **modified**: file in parentTree AND in headTree → overlap
 * 3. **new file content match**: NOT in parentTree, in headTree, headHash === shadowHash → overlap
 * 4. **new file content mismatch**: NOT in parentTree, in headTree, headHash !== shadowHash → continue
 *
 * Fail-open fallback: when any tree resolution (HEAD tree, shadow ref,
 * shadow commit) fails, returns `filesTouched.length > 0` — i.e. assume
 * overlap when at least one file was touched. Matches Go
 * `content_overlap.go:73-101` (`return len(filesTouched) > 0, nil` on each
 * resolution-failure branch).
 *
 * Mirrors Go `content_overlap.go:56-184`.
 */
export async function filesOverlapWithContent(
	repoDir: string,
	shadowBranchName: string,
	headCommitHash: string,
	filesTouched: string[],
	opts?: OverlapOpts,
	logCtx?: LogContext,
): Promise<boolean> {
	const ctx = logCtx ?? CHECKPOINT_LOG_CTX;
	const o = opts ?? {};

	let headTree: string | null = o.headTree ?? null;
	if (headTree === null) {
		try {
			const c = await git.readCommit({ fs: fsCallback, dir: repoDir, oid: headCommitHash });
			headTree = c.commit.tree;
		} catch (err) {
			log.debug(
				ctx,
				'filesOverlapWithContent: failed to get HEAD tree, falling back to filename check',
				{ error: err instanceof Error ? err.message : String(err) },
			);
			return filesTouched.length > 0;
		}
	}

	let shadowTree: string | null = o.shadowTree ?? null;
	if (shadowTree === null) {
		// Go: content_overlap.go:79-104 — three distinct fallback messages
		// (ref missing / commit read fail / tree read fail). Splitting them
		// keeps log granularity matching Go for ops + reviewers.
		const ref = `refs/heads/${shadowBranchName}`;
		let shadowOid: string;
		try {
			shadowOid = await git.resolveRef({ fs: fsCallback, dir: repoDir, ref });
		} catch (err) {
			log.debug(
				ctx,
				'filesOverlapWithContent: shadow branch not found, falling back to filename check',
				{
					branch: shadowBranchName,
					error: err instanceof Error ? err.message : String(err),
				},
			);
			return filesTouched.length > 0;
		}
		try {
			const sc = await git.readCommit({ fs: fsCallback, dir: repoDir, oid: shadowOid });
			shadowTree = sc.commit.tree;
		} catch (err) {
			log.debug(
				ctx,
				'filesOverlapWithContent: failed to get shadow commit, falling back to filename check',
				{ error: err instanceof Error ? err.message : String(err) },
			);
			return filesTouched.length > 0;
		}
	}

	let parentTree: string | null = o.parentTree ?? null;
	if (parentTree === null && !o.hasParentTree) {
		try {
			const c = await git.readCommit({ fs: fsCallback, dir: repoDir, oid: headCommitHash });
			if (c.commit.parent.length > 0) {
				const p = await git.readCommit({
					fs: fsCallback,
					dir: repoDir,
					oid: c.commit.parent[0]!,
				});
				parentTree = p.commit.tree;
			}
		} catch {
			// swallow — parentTree stays null, treated as initial commit downstream
		}
	}

	for (const filePath of filesTouched) {
		const headFile = await readBlobInTree(repoDir, headTree, filePath);

		if (headFile === null) {
			// Deletion check: file in parent tree → counts as overlap.
			if (parentTree !== null) {
				const parentFile = await readBlobInTree(repoDir, parentTree, filePath);
				if (parentFile !== null) {
					log.debug(ctx, 'filesOverlapWithContent: deleted file counts as overlap', {
						file: filePath,
					});
					return true;
				}
			}
			continue; // not in parent either — skip
		}

		// Modified vs new file detection.
		let isModified = false;
		if (parentTree !== null) {
			const parentFile = await readBlobInTree(repoDir, parentTree, filePath);
			if (parentFile !== null) {
				isModified = true;
			}
		}

		if (isModified) {
			log.debug(ctx, 'filesOverlapWithContent: modified file counts as overlap', {
				file: filePath,
			});
			return true;
		}

		// New file: compare against shadow tree.
		const shadowFile = await readBlobInTree(repoDir, shadowTree, filePath);
		if (shadowFile === null) {
			log.debug(ctx, 'filesOverlapWithContent: file in filesTouched but not in shadow branch', {
				file: filePath,
			});
			continue;
		}

		if (headFile.hash === shadowFile.hash) {
			log.debug(ctx, 'filesOverlapWithContent: new file content match found', {
				file: filePath,
				hash: headFile.hash,
			});
			return true;
		}

		log.debug(
			ctx,
			'filesOverlapWithContent: new file content mismatch (may be reverted & replaced)',
			{
				file: filePath,
				head_hash: headFile.hash,
				shadow_hash: shadowFile.hash,
			},
		);
	}

	log.debug(ctx, 'filesOverlapWithContent: no overlapping files found', {
		files_checked: filesTouched.length,
	});
	return false;
}

/**
 * Like {@link filesOverlapWithContent} but for staged-but-uncommitted files,
 * used in PrepareCommitMsg's carry-forward decision.
 *
 * For new files (not in HEAD) where staged hash !== shadow hash, also checks
 * {@link hasSignificantContentOverlap} on the raw bytes — distinguishes
 * "partial staging" (kept some agent content) from "reverted-and-replaced".
 *
 * Mirrors Go `content_overlap.go:194-352`.
 */
export async function stagedFilesOverlapWithContent(
	repoDir: string,
	shadowTreeOid: string,
	stagedFiles: string[],
	filesTouched: string[],
	logCtx?: LogContext,
): Promise<boolean> {
	const ctx = logCtx ?? CHECKPOINT_LOG_CTX;
	const touchedSet = new Set(filesTouched);

	let headTree: string;
	try {
		const head = await git.resolveRef({ fs: fsCallback, dir: repoDir, ref: 'HEAD' });
		const headCommit = await git.readCommit({ fs: fsCallback, dir: repoDir, oid: head });
		headTree = headCommit.commit.tree;
	} catch (err) {
		log.debug(
			ctx,
			'stagedFilesOverlapWithContent: failed to get HEAD, falling back to filename check',
			{ error: err instanceof Error ? err.message : String(err) },
		);
		return hasOverlappingFiles(stagedFiles, filesTouched);
	}

	// Build index entry → blob OID map (Go: idx.Entries → indexEntries).
	// Mirrors `repo.Storer.Index()` (content_overlap.go:227-239). Uses git CLI
	// `git ls-files -s` because isomorphic-git's index reader exposes a less
	// stable surface and we need exact byte parity with Go's hash compare.
	let indexEntries: Map<string, string>;
	try {
		indexEntries = await readIndexEntries(repoDir);
	} catch (err) {
		log.debug(
			ctx,
			'stagedFilesOverlapWithContent: failed to get index, falling back to filename check',
			{ error: err instanceof Error ? err.message : String(err) },
		);
		return hasOverlappingFiles(stagedFiles, filesTouched);
	}

	for (const stagedPath of stagedFiles) {
		if (!touchedSet.has(stagedPath)) {
			log.debug(ctx, 'stagedFilesOverlapWithContent: staged file not in files_touched, skipping', {
				staged_file: stagedPath,
			});
			continue;
		}

		const headFile = await readBlobInTree(repoDir, headTree, stagedPath);
		const isModified = headFile !== null;
		if (isModified) {
			log.debug(ctx, 'stagedFilesOverlapWithContent: modified file counts as overlap', {
				file: stagedPath,
			});
			return true;
		}

		// New file: read staged blob hash from the git index (NOT from worktree).
		// Go: content_overlap.go:265-268 — silent skip when path missing from index.
		const stagedHash = indexEntries.get(stagedPath);
		if (stagedHash === undefined) {
			continue;
		}

		const shadowFile = await readBlobInTree(repoDir, shadowTreeOid, stagedPath);
		if (shadowFile === null) {
			log.debug(ctx, 'stagedFilesOverlapWithContent: file not in shadow tree, skipping', {
				file: stagedPath,
			});
			continue;
		}

		// Exact hash match — index blob OID === shadow blob OID.
		if (stagedHash === shadowFile.hash) {
			log.debug(ctx, 'stagedFilesOverlapWithContent: new file content match found', {
				file: stagedPath,
				hash: stagedHash,
			});
			return true;
		}

		// Hashes differ — read both blob bytes and run significant-line overlap
		// (Go: content_overlap.go:290-336 reads from BlobObject + Reader/io.ReadAll).
		let stagedBytes: Uint8Array;
		try {
			const blob = await git.readBlob({ fs: fsCallback, dir: repoDir, oid: stagedHash });
			stagedBytes = blob.blob;
		} catch (err) {
			log.debug(ctx, 'stagedFilesOverlapWithContent: failed to read staged blob', {
				file: stagedPath,
				error: err instanceof Error ? err.message : String(err),
			});
			continue;
		}
		const stagedContent = new TextDecoder('utf-8').decode(stagedBytes);
		const shadowContent = new TextDecoder('utf-8').decode(shadowFile.content);
		if (hasSignificantContentOverlap(stagedContent, shadowContent)) {
			log.debug(
				ctx,
				'stagedFilesOverlapWithContent: new file has partial overlap (partial staging)',
				{ file: stagedPath },
			);
			return true;
		}

		log.debug(
			ctx,
			'stagedFilesOverlapWithContent: new file has no significant overlap (reverted & replaced)',
			{
				file: stagedPath,
				staged_hash: stagedHash,
				shadow_hash: shadowFile.hash,
			},
		);
	}

	log.debug(ctx, 'stagedFilesOverlapWithContent: no overlapping files found', {
		staged_files: stagedFiles.length,
		files_touched: filesTouched.length,
		staged_paths: truncateStringSlice(stagedFiles, 10),
		touched_paths: truncateStringSlice(filesTouched, 10),
	});
	return false;
}

/**
 * Compute files from `filesTouched` that still have uncommitted agent
 * changes after a partial commit (used in PrepareCommitMsg carry-forward).
 *
 * For each file in `filesTouched`:
 * - skip if not in shadow tree (phantom path or agent deletion → no carry-forward)
 * - keep if not in `committedFiles` (uncommitted agent change)
 * - keep if commit content !== shadow content AND working tree dirty (partial staging)
 * - skip if commit content !== shadow content AND working tree matches commit (reverted-and-replaced)
 * - skip if commit content === shadow content (fully committed)
 *
 * Falls back to {@link subtractFilesByName} on tree resolution failure.
 *
 * Mirrors Go `content_overlap.go:383-520`.
 */
export async function filesWithRemainingAgentChanges(
	repoDir: string,
	shadowBranchName: string,
	headCommitHash: string,
	filesTouched: string[],
	committedFiles: ReadonlySet<string>,
	opts?: OverlapOpts,
	logCtx?: LogContext,
): Promise<string[]> {
	const ctx = logCtx ?? CHECKPOINT_LOG_CTX;
	const o = opts ?? {};

	let commitTree: string | null = o.headTree ?? null;
	if (commitTree === null) {
		try {
			const c = await git.readCommit({ fs: fsCallback, dir: repoDir, oid: headCommitHash });
			commitTree = c.commit.tree;
		} catch (err) {
			log.debug(
				ctx,
				'filesWithRemainingAgentChanges: failed to get commit tree, falling back to file subtraction',
				{ error: err instanceof Error ? err.message : String(err) },
			);
			return subtractFilesByName(filesTouched, committedFiles, ctx);
		}
	}

	let shadowTree: string | null = o.shadowTree ?? null;
	if (shadowTree === null) {
		// Go: content_overlap.go:414-438 — three distinct fallback messages
		// (ref missing / commit fail / tree fail) for the same observability
		// reason as filesOverlapWithContent.
		const ref = `refs/heads/${shadowBranchName}`;
		let shadowOid: string;
		try {
			shadowOid = await git.resolveRef({ fs: fsCallback, dir: repoDir, ref });
		} catch (err) {
			log.debug(
				ctx,
				'filesWithRemainingAgentChanges: shadow branch not found, falling back to file subtraction',
				{
					branch: shadowBranchName,
					error: err instanceof Error ? err.message : String(err),
				},
			);
			return subtractFilesByName(filesTouched, committedFiles, ctx);
		}
		try {
			const sc = await git.readCommit({ fs: fsCallback, dir: repoDir, oid: shadowOid });
			shadowTree = sc.commit.tree;
		} catch (err) {
			log.debug(
				ctx,
				'filesWithRemainingAgentChanges: failed to get shadow commit, falling back to file subtraction',
				{ error: err instanceof Error ? err.message : String(err) },
			);
			return subtractFilesByName(filesTouched, committedFiles, ctx);
		}
	}

	const remaining: string[] = [];
	for (const filePath of filesTouched) {
		const shadowFile = await readBlobInTree(repoDir, shadowTree, filePath);
		if (shadowFile === null) {
			log.debug(ctx, 'filesWithRemainingAgentChanges: file not in shadow tree, skipping', {
				file: filePath,
			});
			continue;
		}

		if (!committedFiles.has(filePath)) {
			remaining.push(filePath);
			log.debug(ctx, 'filesWithRemainingAgentChanges: file not committed, keeping', {
				file: filePath,
			});
			continue;
		}

		const commitFile = await readBlobInTree(repoDir, commitTree, filePath);
		if (commitFile === null) {
			remaining.push(filePath);
			log.debug(
				ctx,
				'filesWithRemainingAgentChanges: file not in commit tree but in shadow, keeping',
				{ file: filePath },
			);
			continue;
		}

		if (commitFile.hash === shadowFile.hash) {
			log.debug(ctx, 'filesWithRemainingAgentChanges: content fully committed', {
				file: filePath,
			});
			continue;
		}

		// commit content !== shadow content — check working tree
		if (workingTreeMatchesCommit(repoDir, filePath, commitFile.hash)) {
			log.debug(
				ctx,
				'filesWithRemainingAgentChanges: content differs from shadow but working tree is clean, skipping',
				{
					file: filePath,
					commit_hash: commitFile.hash.slice(0, 7),
					shadow_hash: shadowFile.hash.slice(0, 7),
				},
			);
			continue;
		}

		remaining.push(filePath);
		log.debug(
			ctx,
			'filesWithRemainingAgentChanges: content mismatch with dirty working tree, keeping for carry-forward',
			{
				file: filePath,
				commit_hash: commitFile.hash.slice(0, 7),
				shadow_hash: shadowFile.hash.slice(0, 7),
			},
		);
	}

	log.debug(ctx, 'filesWithRemainingAgentChanges: result', {
		files_touched: filesTouched.length,
		committed_files: committedFiles.size,
		remaining_files: remaining.length,
	});

	return remaining;
}

/**
 * Filename-only fallback for {@link filesWithRemainingAgentChanges}: returns
 * files in `filesTouched` not present in `committedFiles`, preserving order.
 *
 * Mirrors Go `content_overlap.go:543-556`.
 */
export function subtractFilesByName(
	filesTouched: string[],
	committedFiles: ReadonlySet<string>,
	logCtx?: LogContext,
): string[] {
	const ctx = logCtx ?? CHECKPOINT_LOG_CTX;
	log.debug(ctx, 'subtractFilesByName: ', {
		filesTouched,
		committedFiles: [...committedFiles],
	});
	const remaining: string[] = [];
	for (const f of filesTouched) {
		if (!committedFiles.has(f)) {
			remaining.push(f);
		}
	}
	return remaining;
}

/**
 * Heuristic: do staged and shadow contents share enough significant lines to
 * indicate "user kept agent work"? Significant lines are trimmed and
 * ≥10 chars (filters `}`, `});`, `} else {` boilerplate).
 *
 * Threshold:
 * - Both sides ≥ 2 significant lines → require ≥ 2 line matches (filters
 *   `package main` boilerplate)
 * - Either side < 2 significant lines → require ≥ 1 match (small files exception)
 * - Either side 0 significant lines → false (no meaningful overlap possible)
 *
 * Mirrors Go `content_overlap.go:570-604`.
 *
 * @example
 * hasSignificantContentOverlap('package main\nfunc Foo() {}', 'package main\nfunc Bar() {}')
 * // => false  (only 1 match `package main`, both sides have ≥2 sig lines)
 */
export function hasSignificantContentOverlap(
	stagedContent: string,
	shadowContent: string,
): boolean {
	const shadowLines = extractSignificantLines(shadowContent);
	const stagedLines = extractSignificantLines(stagedContent);

	if (shadowLines.size === 0 || stagedLines.size === 0) {
		return false;
	}

	const isVerySmallFile = shadowLines.size < 2 || stagedLines.size < 2;
	const requiredMatches = isVerySmallFile ? 1 : 2;

	let matchCount = 0;
	for (const line of stagedLines) {
		if (shadowLines.has(line)) {
			matchCount++;
			if (matchCount >= requiredMatches) {
				return true;
			}
		}
	}
	return false;
}

/**
 * Build the set of significant lines from a content blob: trim each line,
 * keep those ≥ 10 characters. Returns a `Set` for O(1) membership tests.
 *
 * Splitting follows Go's `splitLines` (`common.go:1208-1218`): normalize
 * `\r\n` → `\n`, **trim trailing newline**, split on `\n`. Empty input
 * returns an empty Set.
 *
 * Mirrors Go `content_overlap.go:613-622`.
 *
 * @example
 * extractSignificantLines('package main\n}\n\nfunc Foo() {}\n')
 * // => Set { 'package main', 'func Foo() {}' }   ('}' / '' filtered)
 */
export function extractSignificantLines(content: string): Set<string> {
	const lines = new Set<string>();
	for (const rawLine of splitLines(content)) {
		const trimmed = trimLine(rawLine);
		if (trimmed.length >= 10) {
			lines.add(trimmed);
		}
	}
	return lines;
}

/**
 * Synchronous: check whether the file on disk matches the committed blob
 * hash. Returns `false` on read failure (treat as dirty), never throws.
 *
 * SHA1 vs SHA256 selected by `commitHash` length — 40 hex → SHA1, 64 hex →
 * SHA256. Computes git blob hash format (`SHA(blob <len>\0<content>)`),
 * not raw file SHA.
 *
 * Mirrors Go `content_overlap.go:524-539`.
 */
export function workingTreeMatchesCommit(
	worktreeRoot: string,
	filePath: string,
	commitHash: string,
): boolean {
	let diskContent: Buffer;
	try {
		diskContent = fsCallback.readFileSync(path.join(worktreeRoot, filePath));
	} catch {
		return false;
	}
	return computeBlobHashFromBytes(diskContent, commitHash) === commitHash;
}

/**
 * Filename-only intersection — returns true if any staged file appears in
 * filesTouched. Used as fallback when content-aware comparison isn't
 * possible. Private helper.
 *
 * Mirrors Go `content_overlap.go:356-368`.
 */
function hasOverlappingFiles(stagedFiles: string[], filesTouched: string[]): boolean {
	const touchedSet = new Set(filesTouched);
	for (const staged of stagedFiles) {
		if (touchedSet.has(staged)) {
			return true;
		}
	}
	return false;
}

/**
 * Return the first `n` elements of a slice for concise logging. Mirrors Go
 * `content_overlap.go:18-23` (`truncateStringSlice`).
 */
function truncateStringSlice(s: string[], n: number): string[] {
	if (s.length <= n) {
		return s;
	}
	return s.slice(0, n);
}

/**
 * Strip leading/trailing space and tab. Does NOT strip `\n` / `\r` (caller
 * already split on them) and does NOT use `String.prototype.trim()`
 * (which also strips `\u00A0` and other Unicode whitespace).
 *
 * Mirrors Go `content_overlap.go:625-635` (`trimLine`).
 */
function trimLine(line: string): string {
	let start = 0;
	let end = line.length;
	while (start < end && (line[start] === ' ' || line[start] === '\t')) {
		start++;
	}
	while (end > start && (line[end - 1] === ' ' || line[end - 1] === '\t')) {
		end--;
	}
	return line.slice(start, end);
}

/**
 * Mirror Go `common.go:1208-1218` (`splitLines`): normalize `\r\n` → `\n`,
 * **trim a single trailing `\n`** to avoid an empty last element, then
 * split on `\n`. Empty input returns empty array.
 *
 * Important: the naive TS equivalent `content.split(/\r?\n/)` produces
 * `['foo', '']` for input `'foo\n'`, which then leaks an empty trimmed
 * line through `extractSignificantLines`. Go strips the trailing `\n`
 * before splitting, producing `['foo']`. We must match.
 */
function splitLines(content: string): string[] {
	if (content === '') {
		return [];
	}
	let s = content.replace(/\r\n/g, '\n');
	if (s.endsWith('\n')) {
		s = s.slice(0, -1);
	}
	return s.split('\n');
}

interface BlobLookup {
	hash: string;
	content: Uint8Array;
}

/**
 * Read a blob at `path` inside the tree at `treeOid`. Returns null when
 * the path is absent (NotFoundError catch — avoids spreading try/catch
 * across the algorithm).
 *
 * Returns `{ hash: oid (40-hex), content: Uint8Array }` on hit.
 */
async function readBlobInTree(
	repoDir: string,
	treeOid: string | null,
	filePath: string,
): Promise<BlobLookup | null> {
	if (treeOid === null) {
		return null;
	}
	try {
		const result = await git.readBlob({
			fs: fsCallback,
			dir: repoDir,
			oid: treeOid,
			filepath: filePath,
		});
		return { hash: result.oid, content: result.blob };
	} catch {
		return null;
	}
}

/**
 * Compute git blob hash format: `SHA(blob <len>\0<content>)`. Algorithm
 * picked from `commitHash.length`: 40 hex chars → SHA1, 64 hex → SHA256.
 *
 * Used by {@link workingTreeMatchesCommit} to verify a worktree file matches
 * a committed blob hash without going through git's own hasher. (The
 * staged-content path now reads the index OID directly; no string→hash
 * computation needed there.)
 *
 * Mirrors the Go logic in `content_overlap.go:530-538` which uses
 * `plumbing.NewHasher(algo, BlobObject, len(content))`.
 */
function computeBlobHashFromBytes(bytes: Buffer, commitHash: string): string {
	const algo = commitHash.length === 64 ? 'sha256' : 'sha1';
	const header = Buffer.from(`blob ${bytes.length}\0`, 'utf8');
	const h = createHash(algo);
	h.update(header);
	h.update(bytes);
	return h.digest('hex');
}

/**
 * Read the git index entries via `git ls-files -s` and return a map from
 * file path → blob OID. Mirrors Go `repo.Storer.Index().Entries` aggregation
 * (content_overlap.go:227-239). Returns an empty map for an unborn / empty
 * index. Throws (caught by caller) when `git ls-files` itself fails.
 *
 * Output format from `git ls-files -s`:
 *   `<mode> <oid> <stage>\t<path>` (one per line)
 *
 * For Stage 0 entries (the normal case — no merge conflict) we keep the OID;
 * higher stages (merge conflict ours/theirs) are skipped here because Go's
 * `idx.Entries` iteration also produces last-write-wins on duplicate paths
 * and the staged content for committed files is read from stage 0.
 */
async function readIndexEntries(repoDir: string): Promise<Map<string, string>> {
	const out = await execGit(['ls-files', '-s'], { cwd: repoDir });
	const map = new Map<string, string>();
	if (out === '') {
		return map;
	}
	for (const line of out.split('\n')) {
		if (line === '') {
			continue;
		}
		// `<mode> <oid> <stage>\t<path>`
		const tabIdx = line.indexOf('\t');
		if (tabIdx === -1) {
			continue;
		}
		const meta = line.slice(0, tabIdx).split(' ');
		if (meta.length < 3) {
			continue;
		}
		const stage = meta[2];
		if (stage !== '0') {
			continue;
		}
		const oid = meta[1];
		const filePath = line.slice(tabIdx + 1);
		if (oid !== undefined) {
			map.set(filePath, oid);
		}
	}
	return map;
}
