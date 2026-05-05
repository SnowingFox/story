/**
 * AI code attribution algorithm — computes the 9-field `InitialAttribution`
 * record (`agentLines` / `humanAdded` / `agentPercentage` / etc.) that the
 * `condenseSession` pipeline writes into the v1 metadata branch.
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/strategy/manual_commit_attribution.go`
 * (single file, 572 lines, 6-phase algorithm + 11 helpers).
 *
 * The 6 phases:
 *
 * 1. **accumulatePromptEdits** — sum user adds/removes from per-prompt
 *    snapshots; track PA1 (baseline) separately so pre-session worktree dirt
 *    can be subtracted from human contribution counts.
 * 2. **diffAgentTouchedFiles** — base→shadow and shadow→head diffs for each
 *    agent-touched file (intermediate work + post-checkpoint user edits).
 * 3. **diffNonAgentFiles** — enumerate files changed in the commit that
 *    weren't agent-touched (uses `git diff-tree` when commit hashes available;
 *    falls back to a tree walk for the doctor / `condenseSessionByID` path).
 * 4. **classifyAccumulatedEdits** — split prompt-attributed user edits into
 *    "fell on agent files" vs "fell on committed non-agent files" buckets.
 * 5. **classifyBaselineEdits** — same split but PA1-only (used for subtraction).
 * 6. **derived metrics** — algebra over the four buckets to produce the final
 *    `InitialAttribution` shape with `metricVersion: 2` (changed-lines %).
 *
 * Binary files (NULL byte detection inside the first 8 KiB of blob content) are
 * silently excluded from line counting.
 *
 * @packageDocumentation
 */

import fsCallback from 'node:fs';
import diffMatchPatch from 'diff-match-patch';
import git from 'isomorphic-git';
import { match } from 'ts-pattern';
import type { PromptAttribution } from '../session/state-store';

const dmp = new diffMatchPatch.diff_match_patch();
const DIFF_DELETE = -1;
const DIFF_INSERT = 1;
const DIFF_EQUAL = 0;

/**
 * `getFileContent` "is binary" probe — checks the first 8 KiB for a NULL byte.
 * Same heuristic as git's internal binary detector and Go's `IsBinary`.
 */
function isBinaryBlob(bytes: Uint8Array): boolean {
	const window = bytes.length > 8000 ? 8000 : bytes.length;
	for (let i = 0; i < window; i++) {
		if (bytes[i] === 0) {
			return true;
		}
	}
	return false;
}

/**
 * Count newline-terminated lines in a string. Empty input = 0; single line
 * without trailing newline still counts as 1.
 *
 * Mirrors Go `countLinesStr`.
 *
 * @example
 * countLinesStr('')              // 0
 * countLinesStr('hello')         // 1
 * countLinesStr('hello\n')       // 1
 * countLinesStr('hello\nworld')  // 2
 *
 * // Side effects: none — pure string scan.
 */
export function countLinesStr(content: string): number {
	if (content === '') {
		return 0;
	}
	let lines = 0;
	for (let i = 0; i < content.length; i++) {
		if (content[i] === '\n') {
			lines++;
		}
	}
	if (!content.endsWith('\n')) {
		lines++;
	}
	return lines;
}

/**
 * Line-level diff between two text blobs. Returns `{ unchanged, added,
 * removed }` line counts. Three fast-paths:
 *
 * 1. **Equal** → `unchanged = countLinesStr(a)`
 * 2. **Left empty** → all of `b` was added
 * 3. **Right empty** → all of `a` was removed
 *
 * Otherwise runs `diff-match-patch.diff_linesToChars_ + diff_main +
 * diff_charsToLines_` (line-mode diff) and tallies `DIFF_EQUAL / INSERT /
 * DELETE` ops.
 *
 * Mirrors Go `diffLines` (uses `sergi/go-diff/diffmatchpatch`); both libraries
 * implement the same Myers diff with a `linesToChars` pre-pass for line-mode
 * granularity, so identical inputs produce identical line tallies.
 *
 * @example
 * diffLines('a\nb\n', 'a\nc\n')
 * // { unchanged: 1, added: 1, removed: 1 }
 *
 * // Side effects: none — pure computation.
 */
export function diffLines(
	checkpointContent: string,
	committedContent: string,
): { unchanged: number; added: number; removed: number } {
	if (checkpointContent === committedContent) {
		return { unchanged: countLinesStr(committedContent), added: 0, removed: 0 };
	}
	if (checkpointContent === '') {
		return { unchanged: 0, added: countLinesStr(committedContent), removed: 0 };
	}
	if (committedContent === '') {
		return { unchanged: 0, added: 0, removed: countLinesStr(checkpointContent) };
	}

	const { chars1, chars2, lineArray } = dmp.diff_linesToChars_(checkpointContent, committedContent);
	const diffs = dmp.diff_main(chars1, chars2, false);
	dmp.diff_charsToLines_(diffs, lineArray);

	let unchanged = 0;
	let added = 0;
	let removed = 0;
	for (const [op, text] of diffs) {
		const lines = countLinesStr(text);
		match(op)
			.with(DIFF_EQUAL, () => {
				unchanged += lines;
			})
			.with(DIFF_INSERT, () => {
				added += lines;
			})
			.with(DIFF_DELETE, () => {
				removed += lines;
			})
			.otherwise(() => {});
	}
	return { unchanged, added, removed };
}

/**
 * Read blob content from a tree at `path`, decoded as UTF-8.
 *
 * Returns `''` when:
 *
 * - `treeOid` is `null` (e.g. initial commit fallback)
 * - the tree / file lookup fails (missing path / corrupt object)
 * - the blob is detected as binary (first 8 KiB contains NULL byte) — line
 *   diffs are meaningless for non-text content, and Go's `IsBinary` short-
 *   circuits the same way.
 *
 * Mirrors Go `getFileContent` (which uses go-git's `File.IsBinary`).
 *
 * @example
 * await getFileContent(repoDir, treeOid, 'src/app.ts')
 * // 'export function ...'
 *
 * await getFileContent(repoDir, null, 'anything')         // ''
 * await getFileContent(repoDir, treeOid, 'binary.png')    // ''
 *
 * // Side effects: none — read-only blob lookup via isomorphic-git.
 */
export async function getFileContent(
	repoDir: string,
	treeOid: string | null,
	path: string,
): Promise<string> {
	if (treeOid === null) {
		return '';
	}
	let blobBytes: Uint8Array;
	try {
		const result = await git.readBlob({
			fs: fsCallback,
			dir: repoDir,
			oid: treeOid,
			filepath: path,
		});
		blobBytes = result.blob;
	} catch {
		return '';
	}
	if (isBinaryBlob(blobBytes)) {
		return '';
	}
	try {
		return new TextDecoder('utf-8', { fatal: false }).decode(blobBytes);
	} catch {
		return '';
	}
}

/**
 * Aggregated user edit data extracted from {@link PromptAttribution}[].
 * Internal to the attribution algorithm; not exported because callers should
 * use the higher-level {@link calculateAttributionWithAccumulated}.
 */
export interface AccumulatedEdits {
	userAdded: number;
	userRemoved: number;
	addedPerFile: Record<string, number>;
	removedPerFile: Record<string, number>;
	/** Pre-session "dirty worktree" baseline edits (PA1 only). */
	baselineUserRemoved: number;
	baselineUserAddedPerFile: Record<string, number>;
}

/**
 * Sum user additions / removals across every {@link PromptAttribution} record
 * captured during the session. Tracks PA1 (`checkpointNumber <= 1`)
 * **separately** as the "baseline" — these are pre-session worktree edits the
 * user did before the agent ran, and Phase 4b subtracts them from human
 * contribution counts.
 *
 * Mirrors Go `accumulatePromptEdits`.
 *
 * @example
 * accumulatePromptEdits([{ checkpointNumber: 1, userLinesAdded: 5, ... }])
 * // {
 * //   userAdded: 5, userRemoved: 0, addedPerFile: {}, removedPerFile: {},
 * //   baselineUserRemoved: 0, baselineUserAddedPerFile: {},
 * // }
 *
 * // Side effects: none — pure aggregation.
 */
export function accumulatePromptEdits(promptAttributions: PromptAttribution[]): AccumulatedEdits {
	const result: AccumulatedEdits = {
		userAdded: 0,
		userRemoved: 0,
		addedPerFile: {},
		removedPerFile: {},
		baselineUserRemoved: 0,
		baselineUserAddedPerFile: {},
	};
	for (const pa of promptAttributions) {
		result.userAdded += pa.userLinesAdded;
		result.userRemoved += pa.userLinesRemoved;
		for (const [filePath, added] of Object.entries(pa.userAddedPerFile ?? {})) {
			result.addedPerFile[filePath] = (result.addedPerFile[filePath] ?? 0) + added;
		}
		for (const [filePath, removed] of Object.entries(pa.userRemovedPerFile ?? {})) {
			result.removedPerFile[filePath] = (result.removedPerFile[filePath] ?? 0) + removed;
		}
		if (pa.checkpointNumber <= 1) {
			result.baselineUserRemoved += pa.userLinesRemoved;
			for (const [filePath, added] of Object.entries(pa.userAddedPerFile ?? {})) {
				result.baselineUserAddedPerFile[filePath] =
					(result.baselineUserAddedPerFile[filePath] ?? 0) + added;
			}
		}
	}
	return result;
}

/**
 * Per-file diff results for agent-touched files (Phase 2 of the algorithm).
 *
 * - `totalAgentAndUserWorkAdded` — base→shadow added lines (everything written
 *   to the shadow tree, agent + user co-edits both included)
 * - `postCheckpointUserAdded` / `postCheckpointUserRemoved` — shadow→head
 *   user-only edits (anything between the latest checkpoint and the actual
 *   commit)
 * - `postCheckpointUserRemovedPerFile` — same removals, broken out per file
 *   for the LIFO `estimateUserSelfModifications` heuristic in Phase 5.
 */
export interface AgentFileDiffs {
	totalAgentAndUserWorkAdded: number;
	postCheckpointUserAdded: number;
	postCheckpointUserRemoved: number;
	postCheckpointUserRemovedPerFile: Record<string, number>;
}

/**
 * Compute base→shadow and shadow→head diffs for each agent-touched file. The
 * shadow tree is a snapshot at checkpoint time — it contains both the agent's
 * work AND any user edits that landed between checkpoints.
 *
 * Mirrors Go `diffAgentTouchedFiles`.
 *
 * @example
 * await diffAgentTouchedFiles(repoDir, baseOid, shadowOid, headOid, ['src/app.ts'])
 * // {
 * //   totalAgentAndUserWorkAdded: 5,   // base → shadow added 5 lines
 * //   postCheckpointUserAdded: 1,      // shadow → head added 1 user line
 * //   postCheckpointUserRemoved: 0,
 * //   postCheckpointUserRemovedPerFile: {},
 * // }
 *
 * // Side effects: read-only blob lookups; one tree-resolution per filesTouched item.
 */
export async function diffAgentTouchedFiles(
	repoDir: string,
	baseTreeOid: string | null,
	shadowTreeOid: string | null,
	headTreeOid: string | null,
	filesTouched: string[],
): Promise<AgentFileDiffs> {
	const result: AgentFileDiffs = {
		totalAgentAndUserWorkAdded: 0,
		postCheckpointUserAdded: 0,
		postCheckpointUserRemoved: 0,
		postCheckpointUserRemovedPerFile: {},
	};
	for (const filePath of filesTouched) {
		const baseContent = await getFileContent(repoDir, baseTreeOid, filePath);
		const shadowContent = await getFileContent(repoDir, shadowTreeOid, filePath);
		const headContent = await getFileContent(repoDir, headTreeOid, filePath);

		const { added: workAdded } = diffLines(baseContent, shadowContent);
		result.totalAgentAndUserWorkAdded += workAdded;

		const { added: postUserAdded, removed: postUserRemoved } = diffLines(
			shadowContent,
			headContent,
		);
		result.postCheckpointUserAdded += postUserAdded;
		result.postCheckpointUserRemoved += postUserRemoved;

		if (postUserRemoved > 0) {
			result.postCheckpointUserRemovedPerFile[filePath] = postUserRemoved;
		}
	}
	return result;
}

import type { InitialAttribution } from '../checkpoint/types';
import { execGit } from '../git';

// PHASE 3: non-agent file diffs.

/**
 * Per-file diff results for files changed in the commit but NOT touched by
 * any agent (Phase 3 of the algorithm).
 */
export interface NonAgentFileDiffs {
	allChangedFiles: string[];
	committedNonAgentSet: Set<string>;
	userEditsToNonAgentFiles: number;
	userRemovedFromNonAgentFiles: number;
}

/**
 * True when the file was touched by any agent session (this session or a
 * cross-session sibling) or is CLI metadata that should be excluded from
 * attribution.
 *
 * **Why two prefixes (`.story/` AND `.entire/`)**: Go's counterpart in
 * [`manual_commit_attribution.go:560-572`](../../entire-cli/cmd/entire/cli/strategy/manual_commit_attribution.go)
 * filters only `.entire/` (matching `paths.EntireMetadataDir = ".entire/metadata"`
 * + the broader `.entire/` umbrella) because Entire is the only product writing
 * to `.entire/` in its own deployments. Story extends the filter to `.story/`
 * for the same reason — Story writes to `.story/` (`STORY_METADATA_DIR_NAME =
 * '.story/metadata'` in [`paths.ts`](../paths.ts)) so its files must be excluded
 * from attribution.
 *
 * Keeping `.entire/` here is a cross-tool safety net for users who migrate from
 * Entire to Story while their repo still contains legacy `.entire/` paths from
 * the old CLI — those are not "human work" produced for the current Story
 * session, so they must not inflate `humanAdded`. The cost is one extra string
 * comparison per file; the benefit is correct attribution for migrating users.
 *
 * Mirrors Go `isAgentOrMetadataFile` semantics, with the additional `.story/`
 * prefix appropriate for the Story namespace.
 */
export function isAgentOrMetadataFile(
	filePath: string,
	filesTouched: string[],
	allAgentFiles: ReadonlySet<string> | null,
): boolean {
	if (filesTouched.includes(filePath)) {
		return true;
	}
	if (allAgentFiles?.has(filePath)) {
		return true;
	}
	return filePath.startsWith('.entire/') || filePath.startsWith('.story/');
}

/**
 * Tree-walk fallback for {@link getAllChangedFiles} — used when commit hashes
 * aren't available (doctor / `condenseSessionByID`). Lists every file path
 * whose blob OID differs between the two trees.
 *
 * Mirrors Go `getAllChangedFilesBetweenTreesSlow`.
 */
async function getAllChangedFilesBetweenTreesSlow(
	repoDir: string,
	tree1Oid: string | null,
	tree2Oid: string | null,
): Promise<string[]> {
	if (tree1Oid === null && tree2Oid === null) {
		return [];
	}
	const tree1Hashes = new Map<string, string>();
	const tree2Hashes = new Map<string, string>();

	async function collect(treeOid: string, into: Map<string, string>): Promise<void> {
		await git.walk({
			fs: fsCallback,
			dir: repoDir,
			trees: [git.TREE({ ref: treeOid })],
			map: async (filepath, [entry]) => {
				if (filepath === '.') {
					return;
				}
				if (entry === null || entry === undefined) {
					return;
				}
				const type = await entry.type();
				if (type !== 'blob') {
					return;
				}
				const oid = await entry.oid();
				into.set(filepath, oid);
			},
		});
	}

	if (tree1Oid !== null) {
		await collect(tree1Oid, tree1Hashes);
	}
	if (tree2Oid !== null) {
		await collect(tree2Oid, tree2Hashes);
	}

	const changed: string[] = [];
	for (const [p, h1] of tree1Hashes) {
		const h2 = tree2Hashes.get(p);
		if (h2 === undefined || h2 !== h1) {
			changed.push(p);
		}
	}
	for (const p of tree2Hashes.keys()) {
		if (!tree1Hashes.has(p)) {
			changed.push(p);
		}
	}
	return changed;
}

/**
 * Return every file that changed between the attribution base and HEAD.
 *
 * Fast path: when both commit hashes are present, runs `git diff-tree -r
 * --no-commit-id --name-only` (the Go counterpart uses
 * `gitops.DiffTreeFileList`). Slow path: tree walk via
 * {@link getAllChangedFilesBetweenTreesSlow} — used by the doctor path where
 * we only have tree OIDs.
 *
 * Mirrors Go `getAllChangedFiles`.
 *
 * @example
 * await getAllChangedFiles(repoDir, null, null, repoDir, 'abc1234', 'def5678')
 * // ['src/app.ts', 'src/util.ts']
 *
 * // Side effects: spawns `git diff-tree` (fast path) or read-only walk (slow path).
 */
export async function getAllChangedFiles(
	repoDir: string,
	baseTreeOid: string | null,
	headTreeOid: string | null,
	gitDir: string,
	baseCommitHash: string,
	headCommitHash: string,
): Promise<string[]> {
	if (baseCommitHash !== '' && headCommitHash !== '') {
		const out = await execGit(
			['diff-tree', '-r', '--no-commit-id', '--name-only', baseCommitHash, headCommitHash],
			{ cwd: gitDir },
		);
		const lines = out.split('\n');
		const result: string[] = [];
		for (const l of lines) {
			const t = l.trim();
			if (t !== '') {
				result.push(t);
			}
		}
		return result;
	}
	return getAllChangedFilesBetweenTreesSlow(repoDir, baseTreeOid, headTreeOid);
}

/**
 * Enumerate files changed in the commit that weren't agent-touched, then
 * compute their user additions / removals. Prefers `parentTreeOid` (and
 * `parentCommitHash`) so only THIS commit's edits count; falls back to
 * `baseTreeOid` for initial commits.
 *
 * Mirrors Go `diffNonAgentFiles`.
 *
 * @example
 * await diffNonAgentFiles(params)
 * // { allChangedFiles: [...], committedNonAgentSet: Set([...]),
 * //   userEditsToNonAgentFiles: 5, userRemovedFromNonAgentFiles: 2 }
 *
 * // Side effects: same as getAllChangedFiles.
 */
export async function diffNonAgentFiles(p: AttributionParams): Promise<NonAgentFileDiffs | null> {
	const diffBaseCommit = p.parentCommitHash !== '' ? p.parentCommitHash : p.attributionBaseCommit;
	let allChangedFiles: string[];
	try {
		allChangedFiles = await getAllChangedFiles(
			p.repoDir,
			p.baseTreeOid,
			p.headTreeOid,
			p.repoDir,
			diffBaseCommit,
			p.headCommitHash,
		);
	} catch {
		return null;
	}

	const nonAgentDiffTree = p.parentTreeOid ?? p.baseTreeOid;
	const result: NonAgentFileDiffs = {
		allChangedFiles,
		committedNonAgentSet: new Set(),
		userEditsToNonAgentFiles: 0,
		userRemovedFromNonAgentFiles: 0,
	};
	for (const filePath of allChangedFiles) {
		if (isAgentOrMetadataFile(filePath, p.filesTouched, p.allAgentFiles)) {
			continue;
		}
		result.committedNonAgentSet.add(filePath);
		const baseContent = await getFileContent(p.repoDir, nonAgentDiffTree, filePath);
		const headContent = await getFileContent(p.repoDir, p.headTreeOid, filePath);
		const { added, removed } = diffLines(baseContent, headContent);
		result.userEditsToNonAgentFiles += added;
		result.userRemovedFromNonAgentFiles += removed;
	}
	return result;
}

// PHASE 4 + 4b: classify accumulated edits.

/** User edits split into agent-file vs committed-non-agent buckets. */
export interface ClassifiedEdits {
	toAgentFiles: number;
	toCommittedNonAgentFiles: number;
	removedFromAgentFiles: number;
	removedFromCommittedNonAgent: number;
}

/**
 * Split accumulated user edits (from {@link accumulatePromptEdits}) into
 * "fell on agent files" vs "fell on committed non-agent files" buckets.
 * Worktree-only edits to files NOT in either bucket are ignored.
 *
 * Mirrors Go `classifyAccumulatedEdits`.
 */
export function classifyAccumulatedEdits(
	accum: AccumulatedEdits,
	filesTouched: string[],
	committedNonAgentSet: ReadonlySet<string>,
): ClassifiedEdits {
	const result: ClassifiedEdits = {
		toAgentFiles: 0,
		toCommittedNonAgentFiles: 0,
		removedFromAgentFiles: 0,
		removedFromCommittedNonAgent: 0,
	};
	const filesTouchedSet = new Set(filesTouched);
	for (const [filePath, added] of Object.entries(accum.addedPerFile)) {
		if (filesTouchedSet.has(filePath)) {
			result.toAgentFiles += added;
		} else if (committedNonAgentSet.has(filePath)) {
			result.toCommittedNonAgentFiles += added;
		}
	}
	for (const [filePath, removed] of Object.entries(accum.removedPerFile)) {
		if (filesTouchedSet.has(filePath)) {
			result.removedFromAgentFiles += removed;
		} else if (committedNonAgentSet.has(filePath)) {
			result.removedFromCommittedNonAgent += removed;
		}
	}
	return result;
}

/**
 * Same split as {@link classifyAccumulatedEdits} but for PA1 (baseline)
 * additions only — used in Phase 4b to subtract pre-session worktree dirt
 * from human contribution counts. Removals are NOT tracked at baseline (Go
 * behavior — pre-session worktree state already accounts for whatever was
 * removed before the agent ran).
 *
 * Mirrors Go `classifyBaselineEdits`.
 */
export function classifyBaselineEdits(
	baselineAddedPerFile: Record<string, number>,
	filesTouched: string[],
	committedNonAgentSet: ReadonlySet<string>,
): ClassifiedEdits {
	const result: ClassifiedEdits = {
		toAgentFiles: 0,
		toCommittedNonAgentFiles: 0,
		removedFromAgentFiles: 0,
		removedFromCommittedNonAgent: 0,
	};
	const filesTouchedSet = new Set(filesTouched);
	for (const [filePath, added] of Object.entries(baselineAddedPerFile)) {
		if (filesTouchedSet.has(filePath)) {
			result.toAgentFiles += added;
		} else if (committedNonAgentSet.has(filePath)) {
			result.toCommittedNonAgentFiles += added;
		}
	}
	return result;
}

// PHASE 6: agent deletions + LIFO self-mod estimate.

/**
 * Compute agent-removed lines that actually remain deleted in the final
 * commit. Per file: takes `min(base→shadow removed, base→head removed)` to
 * avoid over-counting when the user re-added something the agent deleted.
 * Then subtracts accumulated user removals to agent files (the user already
 * "claimed" those removals via prompt-attributed edits).
 *
 * Mirrors Go `computeAgentDeletions`.
 *
 * @example
 * await computeAgentDeletions(repoDir, baseOid, shadowOid, headOid, ['x.ts'], 0)
 * // 5  when agent removed 5 lines that survive into the head
 *
 * // Side effects: read-only blob lookups via getFileContent.
 */
export async function computeAgentDeletions(
	repoDir: string,
	baseTreeOid: string | null,
	shadowTreeOid: string | null,
	headTreeOid: string | null,
	filesTouched: string[],
	accumulatedRemovedToAgentFiles: number,
): Promise<number> {
	let agentRemovedInCommit = 0;
	for (const filePath of filesTouched) {
		const baseContent = await getFileContent(repoDir, baseTreeOid, filePath);
		const shadowContent = await getFileContent(repoDir, shadowTreeOid, filePath);
		const headContent = await getFileContent(repoDir, headTreeOid, filePath);

		const { removed: removedBaseToShadow } = diffLines(baseContent, shadowContent);
		const { removed: removedBaseToHead } = diffLines(baseContent, headContent);

		agentRemovedInCommit += Math.min(removedBaseToShadow, removedBaseToHead);
	}
	return Math.max(0, agentRemovedInCommit - accumulatedRemovedToAgentFiles);
}

/**
 * Estimate how many removed lines were actually the user's own additions
 * (LIFO heuristic — when the user removes lines from a file, they likely
 * remove their own recent additions before agent-authored lines).
 *
 * Mirrors Go `estimateUserSelfModifications`.
 *
 * @example
 * estimateUserSelfModifications({ 'x.ts': 5 }, { 'x.ts': 8 })
 * // 5 — user can only self-modify up to what they previously added.
 *
 * // Side effects: none — pure aggregation.
 */
export function estimateUserSelfModifications(
	accumulatedUserAddedPerFile: Record<string, number>,
	postCheckpointUserRemovedPerFile: Record<string, number>,
): number {
	let selfModified = 0;
	for (const [filePath, removed] of Object.entries(postCheckpointUserRemovedPerFile)) {
		const userAddedToFile = accumulatedUserAddedPerFile[filePath] ?? 0;
		selfModified += Math.min(removed, userAddedToFile);
	}
	return selfModified;
}

// MAIN ENTRY: calculateAttributionWithAccumulated.

/**
 * Bundled inputs for {@link calculateAttributionWithAccumulated}. Mirrors Go
 * `AttributionParams`.
 */
export interface AttributionParams {
	/** Repo working directory for git CLI calls. */
	repoDir: string;
	/** Session base commit tree OID. `null` means "no base"; the algorithm
	 * still works (degraded — base→shadow becomes "all added"). */
	baseTreeOid: string | null;
	/** Shadow branch tree OID. `null` triggers the "agent committed mid-turn,
	 * use HEAD as shadow" fallback in the caller. */
	shadowTreeOid: string | null;
	/** HEAD commit tree OID. */
	headTreeOid: string;
	/** HEAD's first parent tree OID; `null` for initial commits. */
	parentTreeOid: string | null;
	/** Agent-touched file paths. */
	filesTouched: string[];
	/** Per-prompt user edit snapshots (PA1 = baseline; later PAs = mid-turn). */
	promptAttributions: PromptAttribution[];
	/** HEAD's first parent commit hash (preferred diff base for non-agent files). */
	parentCommitHash: string;
	/** Session base commit hash (fallback for non-agent file detection). */
	attributionBaseCommit: string;
	/** HEAD commit hash for `git diff-tree`. */
	headCommitHash: string;
	/** Files touched by ALL agent sessions; `null` = single-session run. */
	allAgentFiles: ReadonlySet<string> | null;
}

/**
 * Compute final attribution using accumulated prompt data + tree diffs (the
 * 6-phase algorithm). Returns `null` when there's nothing to attribute
 * (`filesTouched` empty or non-agent enumeration fails).
 *
 * `metricVersion: 2` (changed-lines % algorithm; legacy v0 / v1 was
 * additions-only and is no longer produced).
 *
 * Mirrors Go `CalculateAttributionWithAccumulated`.
 *
 * @example
 * await calculateAttributionWithAccumulated(params)
 * // {
 * //   calculatedAt: '2026-04-19T...', metricVersion: 2,
 * //   agentLines: 147, agentRemoved: 3,
 * //   humanAdded: 5, humanModified: 0, humanRemoved: 0,
 * //   totalCommitted: 152, totalLinesChanged: 155,
 * //   agentPercentage: 96.7,
 * // }
 *
 * // Side effects: read-only — blob lookups + optional `git diff-tree`.
 */
export async function calculateAttributionWithAccumulated(
	p: AttributionParams,
): Promise<InitialAttribution | null> {
	if (p.filesTouched.length === 0) {
		return null;
	}

	// Phase 1
	const accum = accumulatePromptEdits(p.promptAttributions);

	// Phase 2
	const agentDiffs = await diffAgentTouchedFiles(
		p.repoDir,
		p.baseTreeOid,
		p.shadowTreeOid,
		p.headTreeOid,
		p.filesTouched,
	);

	// Phase 3
	const nonAgent = await diffNonAgentFiles(p);
	if (nonAgent === null) {
		return null;
	}

	// Phase 4
	const classified = classifyAccumulatedEdits(accum, p.filesTouched, nonAgent.committedNonAgentSet);

	// Phase 4b
	const baselineClassified = classifyBaselineEdits(
		accum.baselineUserAddedPerFile,
		p.filesTouched,
		nonAgent.committedNonAgentSet,
	);

	// Phase 5: derived metrics
	const totalAgentAdded = Math.max(
		0,
		agentDiffs.totalAgentAndUserWorkAdded - classified.toAgentFiles,
	);
	const postToNonAgentFiles = Math.max(
		0,
		nonAgent.userEditsToNonAgentFiles - classified.toCommittedNonAgentFiles,
	);
	const sessionAccumulatedToAgentFiles = Math.max(
		0,
		classified.toAgentFiles - baselineClassified.toAgentFiles,
	);
	const sessionAccumulatedToNonAgent = Math.max(
		0,
		classified.toCommittedNonAgentFiles - baselineClassified.toCommittedNonAgentFiles,
	);
	const relevantAccumulatedUser = sessionAccumulatedToAgentFiles + sessionAccumulatedToNonAgent;
	const totalUserAdded =
		relevantAccumulatedUser + agentDiffs.postCheckpointUserAdded + postToNonAgentFiles;
	const relevantAccumulatedRemoved =
		classified.removedFromAgentFiles + classified.removedFromCommittedNonAgent;
	const totalUserRemoved = relevantAccumulatedRemoved + agentDiffs.postCheckpointUserRemoved;

	const totalHumanModified = Math.min(totalUserAdded, totalUserRemoved);
	const userSelfModified = estimateUserSelfModifications(
		accum.addedPerFile,
		agentDiffs.postCheckpointUserRemovedPerFile,
	);
	const humanModifiedAgent = Math.max(0, totalHumanModified - userSelfModified);

	const pureUserAdded = totalUserAdded - totalHumanModified;
	const pureUserRemoved = totalUserRemoved - totalHumanModified;

	let totalCommitted = totalAgentAdded + pureUserAdded - pureUserRemoved;
	if (totalCommitted <= 0) {
		totalCommitted = Math.max(0, totalAgentAdded);
	}

	const agentLinesInCommit = Math.max(0, totalAgentAdded - pureUserRemoved - humanModifiedAgent);

	// Phase 6
	const agentRemovedInCommit = await computeAgentDeletions(
		p.repoDir,
		p.baseTreeOid,
		p.shadowTreeOid,
		p.headTreeOid,
		p.filesTouched,
		classified.removedFromAgentFiles,
	);

	const agentChangedLines = agentLinesInCommit + agentRemovedInCommit;
	const totalLinesChanged =
		agentChangedLines +
		pureUserAdded +
		totalHumanModified +
		pureUserRemoved +
		nonAgent.userRemovedFromNonAgentFiles;

	const agentPercentage = totalLinesChanged > 0 ? (agentChangedLines / totalLinesChanged) * 100 : 0;

	return {
		calculatedAt: new Date().toISOString(),
		agentLines: agentLinesInCommit,
		agentRemoved: agentRemovedInCommit,
		humanAdded: pureUserAdded,
		humanModified: totalHumanModified,
		humanRemoved: pureUserRemoved,
		totalCommitted,
		totalLinesChanged,
		agentPercentage,
		metricVersion: 2,
	};
}

/**
 * Snapshot per-prompt attribution at prompt start (before the agent runs).
 *
 * **Phase 5.3 export**: this is consumed by Phase 5.4 InitializeSession /
 * TurnStart hook handlers. The body is implemented here because the algorithm
 * (line-level diff between three trees) belongs naturally with the rest of
 * `attribution.ts`.
 *
 * For checkpoint 1 (`lastCheckpointTreeOid` is null) the
 * `agentLinesAdded` / `agentLinesRemoved` fields are 0 — no previous
 * checkpoint to measure cumulative agent work against.
 *
 * Mirrors Go `CalculatePromptAttribution`.
 *
 * @example
 * await calculatePromptAttribution(repoDir, baseOid, lastCheckpointOid, worktreeFiles, 2)
 * // PromptAttribution { checkpointNumber: 2, userLinesAdded: ..., agentLinesAdded: ... }
 *
 * // Side effects: read-only — blob lookups.
 */
export async function calculatePromptAttribution(
	repoDir: string,
	baseTreeOid: string | null,
	lastCheckpointTreeOid: string | null,
	worktreeFiles: ReadonlyMap<string, string>,
	checkpointNumber: number,
): Promise<PromptAttribution> {
	const result: PromptAttribution = {
		checkpointNumber,
		userLinesAdded: 0,
		userLinesRemoved: 0,
		agentLinesAdded: 0,
		agentLinesRemoved: 0,
		userAddedPerFile: {},
		userRemovedPerFile: {},
	};
	if (worktreeFiles.size === 0) {
		return result;
	}

	const referenceTree = lastCheckpointTreeOid ?? baseTreeOid;
	for (const [filePath, worktreeContent] of worktreeFiles) {
		const referenceContent = await getFileContent(repoDir, referenceTree, filePath);
		const baseContent = await getFileContent(repoDir, baseTreeOid, filePath);

		const { added: userAdded, removed: userRemoved } = diffLines(referenceContent, worktreeContent);
		result.userLinesAdded += userAdded;
		result.userLinesRemoved += userRemoved;
		if (userAdded > 0) {
			result.userAddedPerFile![filePath] = userAdded;
		}
		if (userRemoved > 0) {
			result.userRemovedPerFile![filePath] = userRemoved;
		}

		if (lastCheckpointTreeOid !== null) {
			const checkpointContent = await getFileContent(repoDir, lastCheckpointTreeOid, filePath);
			const { added: agentAdded, removed: agentRemoved } = diffLines(
				baseContent,
				checkpointContent,
			);
			result.agentLinesAdded += agentAdded;
			result.agentLinesRemoved += agentRemoved;
		}
	}
	return result;
}
