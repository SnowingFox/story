/**
 * `hooks-content-detection.ts` — content detection helpers for Phase 5.4 hooks
 * (PrepareCommitMsg / PostCommit / handleAmendCommitMsg).
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/strategy/manual_commit_hooks.go`:
 *   - `getStagedFiles` (`git diff --cached --name-only` CLI)
 *   - `sessionHasNewContent` (9-branch decision tree — main predicate)
 *   - `sessionHasNewContentFromLiveTranscript` (no-shadow fallback)
 *   - `resolveFilesTouched` (prefers state.filesTouched else live extract)
 *   - `hasNewTranscriptWork` (Phase 6.1 Part 2: 5-step agent dispatch)
 *   - `extractModifiedFilesFromLiveTranscript` (Phase 6.1 Part 2: analyzer
 *     dispatch + repo-relative POSIX normalization; Claude special branch
 *     deferred to Phase 6.2)
 *   - `filterSessionsWithNewContent` (per-call optimization: getStagedFiles once)
 *   - `getLastPrompt` (read prompt.txt from shadow tree + extractLastPrompt)
 *   - `extractLastPrompt` (pure: split on `\n\n---\n\n`, return last non-empty)
 *   - `readPromptsFromShadowBranch` (split on `\n\n---\n\n`, returns null if missing)
 *   - `interface ContentCheckOpts` (pre-computed staged files + shadow tree OID)
 *
 * Phase 6.1 Part 2 wired the agent registry into `hasNewTranscriptWork` and
 * `extractModifiedFilesFromLiveTranscript`; the Claude-specific
 * `ExtractAllModifiedFiles` subagent-scan branch is deferred to Phase 6.2 (no
 * Claude agent yet).
 *
 * @packageDocumentation
 */

import fsCallback from 'node:fs';
import path from 'node:path';
import git from 'isomorphic-git';
import * as caps from '@/agent/capabilities';
import * as registry from '@/agent/registry';
import {
	PROMPT_FILE_NAME,
	STORY_METADATA_DIR,
	TRANSCRIPT_FILE_NAME,
	TRANSCRIPT_FILE_NAME_LEGACY,
} from '@/checkpoint/constants';
import { shadowBranchNameForCommit } from '@/checkpoint/temporary';
import { execGit } from '@/git';
import * as log from '@/log';
import { worktreeRoot } from '@/paths';
import { isOnlySeparators } from '@/strategy/prompts';
import { stagedFilesOverlapWithContent as stagedFilesOverlapWithContentImpl } from './content-overlap';
import { resolveTranscriptPath } from './resolve-transcript';
import { prepareTranscriptForState } from './transcript-prep';
import { splitPromptContent } from './transcript-prompts';
import type { SessionState } from './types';

const ACTIVE_RECENT_INTERACTION_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/**
 * Pre-computed values to avoid redundant work across multiple sessions in a
 * single hook invocation. Mirrors Go `manual_commit_hooks.go: contentCheckOpts`.
 */
export interface ContentCheckOpts {
	/**
	 * Pre-computed staged files list (from {@link getStagedFiles}).
	 * - `null` / `undefined`: unavailable (error or PostCommit context where
	 *   files are already committed) — callers skip overlap checks and fall
	 *   through to other heuristics (e.g., transcript growth).
	 * - non-`null` empty array: successfully resolved but no files staged.
	 */
	stagedFiles?: readonly string[] | null;
	/**
	 * Pre-resolved shadow branch tree OID — avoids redundant shadow ref lookup
	 * when the caller already resolved it.
	 */
	shadowTreeOid?: string | null;
}

/**
 * Returns staged files via `git diff --cached --name-only`. POSIX-normalized
 * paths. Returns `[]` (non-`null`) when nothing staged, `null` on git CLI error
 * (callers can distinguish "no staged files" from "error resolving staged files").
 *
 * Mirrors Go `manual_commit_hooks.go: getStagedFiles`.
 *
 * @example
 * await getStagedFiles('/repo');
 * // returns: ['src/main.ts', 'src/util.ts']  (POSIX paths, sorted as git outputs)
 * // returns: []  (non-null) when no files are staged
 * // returns: null when git CLI fails (not a repo / corrupted)
 */
export async function getStagedFiles(repoDir: string): Promise<string[] | null> {
	let output: string;
	try {
		output = await execGit(['diff', '--cached', '--name-only'], { cwd: repoDir });
	} catch {
		return null;
	}
	const trimmed = output.replace(/\r\n/g, '\n').trim();
	if (trimmed === '') {
		return [];
	}
	return trimmed
		.split('\n')
		.filter((line) => line !== '')
		.map((line) => line.split(path.sep).join('/'));
}

/**
 * Returns the last non-empty prompt from `prompt.txt` content. Prompts are
 * separated by `\n\n---\n\n`. Skips empty / only-separators trailing entries
 * to find the most recent **real** prompt.
 *
 * Mirrors Go `manual_commit_hooks.go: extractLastPrompt`.
 *
 * @example
 * extractLastPrompt('first\\n\\n---\\n\\nsecond')          // 'second'
 * extractLastPrompt('only')                                // 'only'
 * extractLastPrompt('real\\n\\n---\\n\\n   ')              // 'real'  (trailing whitespace skipped)
 * extractLastPrompt('real\\n\\n---\\n\\n---')              // 'real'  (trailing only-separators skipped)
 * extractLastPrompt('')                                    // ''
 */
export function extractLastPrompt(content: string): string {
	if (content === '') {
		return '';
	}
	const prompts = content.split('\n\n---\n\n');
	for (let i = prompts.length - 1; i >= 0; i--) {
		const cleaned = prompts[i]!.trim();
		if (cleaned !== '' && !isOnlySeparators(cleaned)) {
			return cleaned;
		}
	}
	return '';
}

/**
 * Read `prompt.txt` from the shadow branch tree, split on `\n\n---\n\n`.
 * Returns `null` when shadow ref / file is missing. Used by
 * Phase 5.4 `handleTurnEnd` to harvest all prompts for transcript finalization.
 *
 * Mirrors Go `manual_commit_hooks.go: readPromptsFromShadowBranch`.
 *
 * @example
 * await readPromptsFromShadowBranch('/repo', state);
 * // returns: ['prompt 1', 'prompt 2', 'prompt 3']  | null
 *
 * // Side effects: read-only — git tree blob lookup. No writes.
 */
export async function readPromptsFromShadowBranch(
	repoDir: string,
	state: SessionState,
): Promise<string[] | null> {
	const blob = await readShadowBlob(repoDir, state, PROMPT_FILE_NAME);
	if (blob === null) {
		return null;
	}
	const text = new TextDecoder('utf-8', { fatal: false }).decode(blob);
	if (text === '') {
		return null;
	}
	return splitPromptContent(text);
}

/**
 * Returns the most recent user prompt from a session's shadow branch
 * `prompt.txt` (last non-empty entry per {@link extractLastPrompt}). Returns
 * `''` on any failure (missing shadow / missing file / read error). Used by
 * Phase 5.4 `prepareCommitMsg` for the editor "Last Prompt: ..." comment.
 *
 * Mirrors Go `manual_commit_hooks.go: getLastPrompt`.
 *
 * @example
 * await getLastPrompt('/repo', state);
 * // returns: 'rewrite the README'  | ''
 *
 * // Side effects: read-only — single git tree blob lookup.
 */
export async function getLastPrompt(repoDir: string, state: SessionState): Promise<string> {
	const blob = await readShadowBlob(repoDir, state, PROMPT_FILE_NAME);
	if (blob === null) {
		return '';
	}
	const text = new TextDecoder('utf-8', { fatal: false }).decode(blob);
	return extractLastPrompt(text);
}

/**
 * Returns the file list for a session: prefers `state.filesTouched`, falls
 * back to {@link extractModifiedFilesFromLiveTranscript} when empty.
 *
 * Mirrors Go `manual_commit_hooks.go: resolveFilesTouched`. Phase 6.1 Part 2
 * wires `prepareTranscriptForState` to the agent registry (active phase only)
 * and the live-extract path to the analyzer dispatch.
 *
 * @example
 * await resolveFilesTouched(state);
 * // returns: ['src/a.ts', 'src/b.ts']  (shallow copy of state.filesTouched if set,
 * //                                      else extracted from live transcript)
 *
 * // Side effects: may call prepareTranscriptForState which may flush agent
 * //   transcript buffers (e.g., OpenCode `opencode export`).
 */
export async function resolveFilesTouched(state: SessionState): Promise<string[]> {
	if (state.filesTouched && state.filesTouched.length > 0) {
		return state.filesTouched.slice();
	}
	await prepareTranscriptForState(state);
	return extractModifiedFilesFromLiveTranscript(
		state,
		state.checkpointTranscriptStart ?? 0,
		state.worktreePath ?? '',
	);
}

/**
 * Reports whether the agent has done work since the last condensation.
 *
 * Phase 6.1 Part 2: full 5-step Go-aligned algorithm:
 *   1. transcriptPath / agentType empty → false
 *   2. resolveTranscriptPath fails → false
 *   3. registry.getByAgentType returns null → false
 *   4. (active phase only) `caps.asTranscriptPreparer` flush — failures are
 *      `log.debug`-only (don't block the hook)
 *   5. `caps.asTranscriptAnalyzer.getTranscriptPosition(path)` — return
 *      `pos > state.checkpointTranscriptStart`; any throw → false
 *
 * Mirrors Go `manual_commit_hooks.go:1840-1898 hasNewTranscriptWork`.
 *
 * @example
 * await hasNewTranscriptWork(state);
 * // returns: true   when analyzer reports growth past checkpointTranscriptStart
 * // returns: false  on any failure / unregistered agent / no analyzer support
 */
export async function hasNewTranscriptWork(state: SessionState): Promise<boolean> {
	const logCtx = { component: 'checkpoint', sessionId: state.sessionId };
	if (!state.transcriptPath || state.transcriptPath === '') {
		return false;
	}
	if (!state.agentType || state.agentType === '') {
		return false;
	}
	let transcriptPath: string;
	try {
		transcriptPath = await resolveTranscriptPath(state);
	} catch (e) {
		// Go: manual_commit_hooks.go:1848-1853 — debug log preserved for
		// observability so callers can diagnose stuck-transcript hooks.
		log.debug(logCtx, 'hasNewTranscriptWork: transcript path resolution failed', {
			error: (e as Error).message,
		});
		return false;
	}
	const ag = registry.getByAgentType(state.agentType);
	if (ag === null) {
		return false;
	}
	if (state.phase === 'active') {
		const [prep, hasPrep] = caps.asTranscriptPreparer(ag);
		if (hasPrep) {
			try {
				await prep.prepareTranscript(transcriptPath);
			} catch (e) {
				log.debug(logCtx, 'prepare transcript failed', {
					agentType: state.agentType,
					transcriptPath,
					error: (e as Error).message,
				});
			}
		}
	}
	const [analyzer, hasAnalyzer] = caps.asTranscriptAnalyzer(ag);
	if (!hasAnalyzer) {
		return false;
	}
	let pos: number;
	try {
		pos = await analyzer.getTranscriptPosition(transcriptPath);
	} catch (e) {
		// Go: manual_commit_hooks.go:1881-1888.
		log.debug(logCtx, 'hasNewTranscriptWork: GetTranscriptPosition failed', {
			transcriptPath,
			error: (e as Error).message,
		});
		return false;
	}
	const startOffset = state.checkpointTranscriptStart ?? 0;
	if (pos <= startOffset) {
		// Go: manual_commit_hooks.go:1891-1897 — visibility for the common
		// "checkpoint already covers the latest transcript position" case.
		log.debug(logCtx, 'hasNewTranscriptWork: no new content', {
			currentPos: pos,
			startOffset,
		});
		return false;
	}
	return true;
}

/**
 * Extracts modified files from the live transcript starting at `offset`.
 * Normalizes to repo-relative POSIX paths.
 *
 * Phase 6.1 Part 2 wires the generic agent `extractModifiedFilesFromOffset`
 * dispatch + path normalization. The Claude-specific `ExtractAllModifiedFiles`
 * subagent-scan branch (Go: `manual_commit_hooks.go:1932-1944`) is **deferred
 * to Phase 6.2** — Vogon and other Phase 6.1 agents don't need it, and the
 * Phase 6.2 Claude agent will register its `SubagentAwareExtractor` capability
 * to enable that path automatically.
 *
 * Mirrors Go `manual_commit_hooks.go:1909-2003 extractModifiedFilesFromLiveTranscript`.
 *
 * @example
 * await extractModifiedFilesFromLiveTranscript(state, 0, '/repo');
 * // returns: ['src/main.ts', 'src/util.ts']  (repo-relative POSIX paths)
 * // returns: []  on any failure / unregistered agent / no analyzer support
 */
export async function extractModifiedFilesFromLiveTranscript(
	state: SessionState,
	offset: number,
	worktreePath: string,
): Promise<string[]> {
	const logCtx = { component: 'checkpoint', sessionId: state.sessionId };
	if (!state.transcriptPath || state.transcriptPath === '') {
		return [];
	}
	if (!state.agentType || state.agentType === '') {
		return [];
	}
	let transcriptPath: string;
	try {
		transcriptPath = await resolveTranscriptPath(state);
	} catch (e) {
		// Go: manual_commit_hooks.go:1917-1921.
		log.debug(logCtx, 'extractModifiedFilesFromLiveTranscript: transcript path resolution failed', {
			error: (e as Error).message,
		});
		return [];
	}
	const ag = registry.getByAgentType(state.agentType);
	if (ag === null) {
		return [];
	}
	const [analyzer, hasAnalyzer] = caps.asTranscriptAnalyzer(ag);
	if (!hasAnalyzer) {
		return [];
	}
	let files: string[];
	try {
		const result = await analyzer.extractModifiedFilesFromOffset(transcriptPath, offset);
		files = result.files;
	} catch (e) {
		// Go: manual_commit_hooks.go:1962-1967.
		log.debug(logCtx, 'extractModifiedFilesFromLiveTranscript: main transcript extraction failed', {
			transcriptPath,
			error: (e as Error).message,
		});
		return [];
	}
	if (files.length === 0) {
		return [];
	}
	// Normalize to repo-relative POSIX paths. Mirrors Go
	// `manual_commit_hooks.go:1980-2000` (paths.ToRelativePath + filepath.ToSlash):
	//   1. prefer state.worktreePath
	//   2. fall back to paths.WorktreeRoot(ctx) when state.worktreePath empty
	//   3. with no basePath at all, skip normalization (transcripts already
	//      relative get passed through; test harnesses use this path).
	let basePath = worktreePath;
	if (basePath === '') {
		basePath = await worktreeRoot().catch(() => '');
	}
	if (basePath === '') {
		return files.map((f) => f.split(path.sep).join('/'));
	}
	const normalized: string[] = [];
	for (const f of files) {
		if (path.isAbsolute(f)) {
			const rel = path.relative(basePath, f);
			if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
				normalized.push(rel.split(path.sep).join('/'));
			}
			// abs path outside repo → drop (Go silently skips ../-prefixed paths).
			continue;
		}
		normalized.push(f.split(path.sep).join('/'));
	}
	return normalized;
}

/**
 * No-shadow-branch fallback for {@link sessionHasNewContent}. Used when the
 * agent commits mid-session before SaveStep has created the shadow ref.
 *
 * Returns true only when:
 *   1. {@link hasNewTranscriptWork} is true (Phase 6.1: dispatched via the
 *      registered agent's `TranscriptAnalyzer.getTranscriptPosition`), AND
 *   2. modified files (from {@link extractModifiedFilesFromLiveTranscript})
 *      overlap with `stagedFiles`.
 *
 * Returns `false` whenever the agent is unknown / lacks `TranscriptAnalyzer`
 * (matches Go fail-safe when analyzer unavailable).
 *
 * Mirrors Go `manual_commit_hooks.go: sessionHasNewContentFromLiveTranscript`.
 */
export async function sessionHasNewContentFromLiveTranscript(
	state: SessionState,
	stagedFiles: readonly string[] | null,
): Promise<boolean> {
	if (!(await hasNewTranscriptWork(state))) {
		return false;
	}

	let modifiedFiles = state.filesTouched ?? [];
	if (modifiedFiles.length === 0) {
		modifiedFiles = await extractModifiedFilesFromLiveTranscript(
			state,
			state.checkpointTranscriptStart ?? 0,
			state.worktreePath ?? '',
		);
	}
	if (modifiedFiles.length === 0) {
		return false;
	}

	if (!hasOverlappingFiles(stagedFiles ?? [], modifiedFiles)) {
		return false;
	}
	return true;
}

/**
 * Decides whether a session has new transcript content / files beyond what
 * was already condensed. **Main content-detection predicate** for
 * `prepareCommitMsg` / `postCommit`. Full 9-branch decision tree:
 *
 * 1. shadow branch missing → fall back to live transcript
 * 2. shadow tree has no transcript file + has carry-forward files (PrepareCommitMsg) → staged-overlap check
 * 3. shadow tree has no transcript file + has carry-forward files (PostCommit) → return true
 * 4. shadow tree has no transcript file + no carry-forward → live transcript fallback
 * 5. transcript blob > stored size → growth detected
 * 6. legacy state (start>0, size===0) → assume growth
 * 7. never condensed → growth = (blobSize > 0)
 * 8. growth + staged overlap (PrepareCommitMsg) → result of overlap check
 * 9. recent IDLE + carry-forward + no staged → return true (PostCommit recent-idle path)
 * 10. otherwise → return hasGrowth
 *
 * Mirrors Go `manual_commit_hooks.go: sessionHasNewContent`.
 */
export async function sessionHasNewContent(
	repoDir: string,
	state: SessionState,
	opts: ContentCheckOpts,
): Promise<boolean> {
	const logCtx = { component: 'manual-commit', sessionId: state.sessionId };

	// Resolve shadow tree (use cached if provided).
	let treeOid = opts.shadowTreeOid ?? null;
	if (treeOid === null) {
		const branch = shadowBranchNameForCommit(state.baseCommit, state.worktreeId ?? '');
		try {
			const refOid = await git.resolveRef({
				fs: fsCallback,
				dir: repoDir,
				ref: `refs/heads/${branch}`,
			});
			const commit = await git.readCommit({ fs: fsCallback, dir: repoDir, oid: refOid });
			treeOid = commit.commit.tree;
		} catch {
			log.debug(logCtx, 'sessionHasNewContent: no shadow branch, checking live transcript');
			return sessionHasNewContentFromLiveTranscript(state, opts.stagedFiles ?? null);
		}
	}

	// Look for transcript file blob — fast size-only check via tree-walk.
	const metadataDir = `${STORY_METADATA_DIR}/${state.sessionId}`;
	let transcriptBlobSize: number | null = null;
	const sizes = await Promise.all([
		blobSize(repoDir, treeOid, `${metadataDir}/${TRANSCRIPT_FILE_NAME}`),
		blobSize(repoDir, treeOid, `${metadataDir}/${TRANSCRIPT_FILE_NAME_LEGACY}`),
	]);
	for (const s of sizes) {
		if (s !== null) {
			transcriptBlobSize = s;
			break;
		}
	}

	if (transcriptBlobSize === null) {
		// Shadow branch exists but has no transcript (e.g., carry-forward from mid-session commit).
		const filesTouched = state.filesTouched ?? [];
		if (filesTouched.length > 0) {
			const stagedFiles = opts.stagedFiles ?? null;
			if (stagedFiles !== null && stagedFiles.length > 0) {
				// PrepareCommitMsg context: check staged-files overlap with content.
				const result = await stagedFilesOverlapWithContentImpl(
					repoDir,
					treeOid,
					stagedFiles as string[],
					filesTouched,
				);
				log.debug(logCtx, 'sessionHasNewContent: no transcript, carry-forward with staged files', {
					filesTouched: filesTouched.length,
					stagedFiles: stagedFiles.length,
					result,
				});
				return result;
			}
			// PostCommit context: no staged files, but we have carry-forward files.
			// Return true and let caller do overlap check with committed files.
			log.debug(
				logCtx,
				'sessionHasNewContent: no transcript, carry-forward without staged files (post-commit)',
			);
			return true;
		}
		log.debug(
			logCtx,
			'sessionHasNewContent: no transcript and no files touched, checking live transcript',
		);
		return sessionHasNewContentFromLiveTranscript(state, opts.stagedFiles ?? null);
	}

	// Compute growth — 3 cases match Go.
	let hasTranscriptGrowth: boolean;
	const storedSize = state.checkpointTranscriptSize ?? 0;
	const startOffset = state.checkpointTranscriptStart ?? 0;
	if (storedSize > 0) {
		hasTranscriptGrowth = transcriptBlobSize > storedSize;
	} else if (startOffset > 0) {
		// Legacy session: condensed before but no size tracking. Assume growth.
		hasTranscriptGrowth = true;
	} else {
		// Never condensed: any content means growth.
		hasTranscriptGrowth = transcriptBlobSize > 0;
	}
	const filesTouched = state.filesTouched ?? [];
	const hasUncommittedFiles = filesTouched.length > 0;

	log.debug(logCtx, 'sessionHasNewContent: transcript size check', {
		transcriptBlobSize,
		checkpointTranscriptSize: storedSize,
		hasTranscriptGrowth,
		hasUncommittedFiles,
	});

	if (!hasTranscriptGrowth && !hasUncommittedFiles) {
		return false;
	}

	const stagedFiles = opts.stagedFiles ?? null;
	if (stagedFiles !== null && stagedFiles.length > 0) {
		const result = await stagedFilesOverlapWithContentImpl(
			repoDir,
			treeOid,
			stagedFiles as string[],
			filesTouched,
		);
		log.debug(logCtx, 'sessionHasNewContent: staged files overlap check', {
			stagedFiles: stagedFiles.length,
			result,
		});
		return result;
	}

	// No staged files — recent IDLE carry-forward path.
	if (
		hasUncommittedFiles &&
		state.phase === 'idle' &&
		isRecentInteraction(state.lastInteractionTime)
	) {
		log.debug(
			logCtx,
			'sessionHasNewContent: no staged files, returning true due to recent idle carry-forward files',
			{
				hasTranscriptGrowth,
				hasUncommittedFiles,
				phase: state.phase,
			},
		);
		return true;
	}

	log.debug(logCtx, 'sessionHasNewContent: no staged files, returning transcript growth', {
		hasTranscriptGrowth,
		hasUncommittedFiles,
	});
	return hasTranscriptGrowth;
}

/**
 * Filters input sessions to those with new transcript / file content beyond
 * what was already condensed. Computes the staged-files list **once** and
 * reuses across all sessions (perf: avoids N×3 `git diff --cached` calls).
 *
 * Mirrors Go `manual_commit_hooks.go: filterSessionsWithNewContent`.
 *
 * @example
 * await filterSessionsWithNewContent('/repo', sessions);
 * // returns: SessionState[]  (subset whose sessionHasNewContent returned true)
 *
 * // Side effects: read-only — single `git diff --cached` + per-session
 * //   shadow tree lookup. No writes.
 */
export async function filterSessionsWithNewContent(
	repoDir: string,
	sessions: readonly SessionState[],
): Promise<SessionState[]> {
	const logCtx = { component: 'manual-commit' };
	const stagedFiles = await getStagedFiles(repoDir);
	if (stagedFiles === null) {
		log.debug(
			logCtx,
			'filterSessionsWithNewContent: getStagedFiles failed, skipping overlap checks',
		);
	}

	const result: SessionState[] = [];
	for (const state of sessions) {
		// Skip fully-condensed ENDED sessions — no new content possible.
		if (state.fullyCondensed && state.phase === 'ended') {
			log.debug(
				{ component: 'manual-commit', sessionId: state.sessionId },
				'filterSessionsWithNewContent: skipping fully-condensed ended session',
			);
			continue;
		}
		try {
			const hasNew = await sessionHasNewContent(repoDir, state, { stagedFiles });
			if (hasNew) {
				result.push(state);
			}
		} catch (err) {
			log.debug(
				{ component: 'manual-commit', sessionId: state.sessionId },
				'filterSessionsWithNewContent: error checking session, skipping it',
				{ error: (err as Error).message },
			);
		}
	}
	return result;
}

/**
 * Reads a blob from the shadow branch tree at `<storyMetadataDir>/<sessionId>/<filename>`.
 * Returns `null` when shadow ref / blob is missing. Private helper.
 */
async function readShadowBlob(
	repoDir: string,
	state: SessionState,
	filename: string,
): Promise<Uint8Array | null> {
	const branch = shadowBranchNameForCommit(state.baseCommit, state.worktreeId ?? '');
	let refOid: string;
	try {
		refOid = await git.resolveRef({ fs: fsCallback, dir: repoDir, ref: `refs/heads/${branch}` });
	} catch {
		return null;
	}
	const filepath = `${STORY_METADATA_DIR}/${state.sessionId}/${filename}`;
	try {
		const result = await git.readBlob({ fs: fsCallback, dir: repoDir, oid: refOid, filepath });
		return result.blob;
	} catch {
		return null;
	}
}

/**
 * Returns the byte size of a blob at `filepath` within the tree at `treeOid`,
 * or `null` if missing. Used by the "fast" growth check in
 * {@link sessionHasNewContent} — avoids reading the full transcript content.
 */
async function blobSize(
	repoDir: string,
	treeOid: string,
	filepath: string,
): Promise<number | null> {
	try {
		const result = await git.readBlob({ fs: fsCallback, dir: repoDir, oid: treeOid, filepath });
		return result.blob.byteLength;
	} catch {
		return null;
	}
}

/**
 * Returns true when `lastInteraction` parses to a date within
 * {@link ACTIVE_RECENT_INTERACTION_THRESHOLD_MS} (24h) of now.
 *
 * Mirrors Go `manual_commit_hooks.go: isRecentInteraction` +
 * `activeSessionInteractionThreshold`.
 */
function isRecentInteraction(lastInteraction: string | undefined): boolean {
	if (!lastInteraction) {
		return false;
	}
	const t = Date.parse(lastInteraction);
	if (Number.isNaN(t)) {
		return false;
	}
	return Date.now() - t < ACTIVE_RECENT_INTERACTION_THRESHOLD_MS;
}

/**
 * O(N+M) intersection check on two file-name lists. Mirrors Go's
 * `hasOverlappingFiles` (private helper inside `content_overlap.go`).
 */
function hasOverlappingFiles(a: readonly string[], b: readonly string[]): boolean {
	if (a.length === 0 || b.length === 0) {
		return false;
	}
	const set = new Set(a);
	for (const f of b) {
		if (set.has(f)) {
			return true;
		}
	}
	return false;
}
