/**
 * Prompt extraction + agent-type detection from checkpoint git trees.
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/strategy/common.go:652-838` —
 * `ExtractFirstPrompt` (+ `isOnlySeparators`) / `ReadSessionPromptFromTree` /
 * `ReadAgentTypeFromTree` / `ReadLatestSessionPromptFromCommittedTree` /
 * `ReadAllSessionPromptsFromTree`.
 *
 * **File format**: `prompt.txt` is plain text with prompts separated by
 * `"\n\n---\n\n"` (Go `paths.PromptSeparator`); first prompt wins. The
 * standalone `splitPrompts` / `joinPrompts` serializers live in
 * [src/checkpoint/prompts.ts](src/checkpoint/prompts.ts); this file is the
 * tree-traversal **reader**.
 *
 * **Agent detection**: 6-marker scan in the tree root mirroring Go
 * `common.go:698-754`. Metadata.json wins early when present + non-empty.
 *
 * @packageDocumentation
 */

import fsCallback from 'node:fs';
import git from 'isomorphic-git';
import {
	AGENT_TYPE_CLAUDE_CODE,
	AGENT_TYPE_CODEX,
	AGENT_TYPE_CURSOR,
	AGENT_TYPE_OPENCODE,
	AGENT_TYPE_UNKNOWN,
	type AgentType,
	normalize,
} from '../agent/types';
import { METADATA_FILE_NAME, PROMPT_FILE_NAME } from '../checkpoint/constants';
import type { CheckpointID } from '../id';
import { toPath as toCheckpointPath } from '../id';
import { parseMetadataJSON } from '../jsonutil';
import { MAX_DESCRIPTION_LENGTH } from './constants';
import { truncateDescription } from './messages';

/**
 * Canonical separator between prompts inside `prompt.txt`. Mirrors Go
 * `paths.PromptSeparator` and Phase 4.x `PROMPT_SEPARATOR`.
 */
const PROMPT_SEPARATOR = '\n\n---\n\n';

/**
 * Regex matching a string composed entirely of separator-class chars
 * (`-`, space, `\n`, `\r`, `\t`). Mirrors Go `isOnlySeparators` rune check.
 */
const SEPARATOR_CHARS_RE = /^[-\s]+$/;

/**
 * Extract the first user prompt from `prompt.txt`-style content (text +
 * `"\n\n---\n\n"` separators), truncated to {@link MAX_DESCRIPTION_LENGTH}
 * runes for use as a commit/listing description.
 *
 * Mirrors Go `common.go:652-679` (`ExtractFirstPrompt`):
 * 1. Empty → `""`
 * 2. Split on `PROMPT_SEPARATOR`
 * 3. For each segment: `trim` → if empty or only separator chars, skip
 * 4. Return `truncateDescription(firstQualifying, 60)` (rune-aware + `"..."`)
 * 5. No qualifying segment → `""`
 *
 * Accepts both `string` (Go-aligned) and `Uint8Array` (TS callers reading
 * blobs directly) for ergonomics.
 *
 * @example
 * extractFirstPrompt('First prompt\n\n---\n\nSecond prompt')
 * // => 'First prompt'
 *
 * extractFirstPrompt('---\n\n---\n\nReal content')
 * // => 'Real content'   (separator-only entries skipped)
 *
 * extractFirstPrompt('a'.repeat(100))
 * // => 'a'.repeat(57) + '...'   (truncated to 60 runes)
 *
 * extractFirstPrompt('')
 * // => ''
 */
export function extractFirstPrompt(content: string | Uint8Array): string {
	const text = typeof content === 'string' ? content : new TextDecoder('utf-8').decode(content);
	if (text === '') {
		return '';
	}

	for (const part of text.split(PROMPT_SEPARATOR)) {
		const cleaned = part.trim();
		if (cleaned === '' || isOnlySeparators(cleaned)) {
			continue;
		}
		return truncateDescription(cleaned, MAX_DESCRIPTION_LENGTH);
	}
	return '';
}

/**
 * True when every character of `s` is in the separator class (`-`, whitespace).
 *
 * Mirrors Go `common.go: isOnlySeparators`. Promoted to `export` in Phase 5.4
 * so `extractLastPrompt` (Go: `manual_commit_hooks.go: extractLastPrompt`) can
 * reuse the same separator predicate via [./hooks-content-detection.ts](./hooks-content-detection.ts).
 *
 * @example
 * isOnlySeparators('---');     // true
 * isOnlySeparators(' \n  ');   // true
 * isOnlySeparators('hello');   // false
 */
export function isOnlySeparators(s: string): boolean {
	return SEPARATOR_CHARS_RE.test(s);
}

/**
 * Read `<sessionPath>/prompt.txt` from a tree and return the first prompt
 * via {@link extractFirstPrompt}. Returns `''` when the file is missing or
 * any tree-walk step fails.
 *
 * Mirrors Go `common.go:682-696` (`ReadSessionPromptFromTree`).
 *
 * @example
 * ```ts
 * await readSessionPromptFromTree(repoDir, treeHash, 'a3/b2c4d5e6f7/0');
 * // returns: 'Refactor the auth flow'   (first prompt extracted from prompt.txt)
 * // returns: ''                          (when prompt.txt missing or empty)
 *
 * // Side effects: none — read-only blob lookup in the given tree.
 * //
 * // Disk / git refs / HEAD: unchanged.
 * ```
 */
export async function readSessionPromptFromTree(
	repoDir: string,
	treeHash: string,
	sessionPath: string,
): Promise<string> {
	const blob = await readBlobInTree(repoDir, treeHash, joinPath(sessionPath, PROMPT_FILE_NAME));
	if (blob === null) {
		return '';
	}
	return extractFirstPrompt(blob);
}

/**
 * Detect the agent that produced a checkpoint by walking its session subtree.
 *
 * Mirrors Go `common.go:698-754` (`ReadAgentTypeFromTree`):
 *
 * 1. **Metadata first**: read `<sessionPath>/metadata.json`; if it has a
 *    non-empty `agent` field, return it verbatim (Phase 5.1 best-effort —
 *    Phase 6.1 will run `agent.normalize(...)` against the registry).
 * 2. **Marker scan** in the tree root (NOT the session subtree):
 *    | Marker                       | AgentType            |
 *    |------------------------------|----------------------|
 *    | `.claude/`              (tree) | `Claude Code`       |
 *    | `.opencode/` (tree) OR `opencode.json` (file) | `OpenCode` |
 *    | `.codex/`               (tree) | `Codex`             |
 *    | `.cursor/`              (tree) | `Cursor`            |
 * 3. Detected exactly **one** kind → return it. Detected zero or ≥2 → `Unknown`.
 *
 * @example
 * // .claude/ alone → Claude Code
 * await readAgentTypeFromTree(repoDir, treeWithDotClaude, 'no-metadata')
 * // => 'Claude Code'
 *
 * // .claude/ + .codex/ → ambiguous → Unknown
 * await readAgentTypeFromTree(repoDir, treeWithBoth, 'no-metadata')
 * // => 'Unknown'
 *
 * // metadata.json overrides directory scan
 * await readAgentTypeFromTree(repoDir, treeWithDotClaudeAndMetadata, 'cp')
 * // => 'Cursor'   (when metadata.json says agent="Cursor")
 */
export async function readAgentTypeFromTree(
	repoDir: string,
	treeHash: string,
	sessionPath: string,
): Promise<AgentType> {
	// 1. metadata.json early return
	const metaBlob = await readBlobInTree(
		repoDir,
		treeHash,
		joinPath(sessionPath, METADATA_FILE_NAME),
	);
	if (metaBlob !== null) {
		try {
			const parsed = parseMetadataJSON<{ agent?: string }>(
				new TextDecoder('utf-8').decode(metaBlob),
			);
			if (parsed.agent && parsed.agent !== '') {
				// Phase 6.1: normalize unknown / hand-edited agent strings to
				// AGENT_TYPE_UNKNOWN. Mirrors Go `common.go:ReadAgentTypeFromTree`
				// (Go assigns metadata.Agent directly because Go's AgentType is
				// a `string` newtype; TS strict union requires explicit normalize).
				return normalize(parsed.agent);
			}
		} catch {
			// fall through to marker scan
		}
	}

	// 2. count markers in repo root
	const detected: AgentType[] = [];
	if (await treeExistsInTree(repoDir, treeHash, '.claude')) {
		detected.push(AGENT_TYPE_CLAUDE_CODE);
	}
	if (await treeExistsInTree(repoDir, treeHash, '.opencode')) {
		detected.push(AGENT_TYPE_OPENCODE);
	} else if (await blobExistsInTree(repoDir, treeHash, 'opencode.json')) {
		detected.push(AGENT_TYPE_OPENCODE);
	}
	if (await treeExistsInTree(repoDir, treeHash, '.codex')) {
		detected.push(AGENT_TYPE_CODEX);
	}
	if (await treeExistsInTree(repoDir, treeHash, '.cursor')) {
		detected.push(AGENT_TYPE_CURSOR);
	}

	// `noUncheckedIndexedAccess` requires the explicit guard even though the
	// `length === 1` check makes `detected[0]` safe at runtime.
	if (detected.length === 1 && detected[0] !== undefined) {
		return detected[0];
	}
	return AGENT_TYPE_UNKNOWN;
}

/**
 * Read the latest session's prompt from a committed checkpoint tree, scanning
 * **backward** from `sessionCount-1` down to `0` until a non-empty prompt is
 * found. Mirrors Go `common.go:766-810`
 * (`ReadLatestSessionPromptFromCommittedTree`).
 *
 * Why backward + fallback: condensation can produce sessions with empty
 * `prompt.txt` (e.g. test session interleaved with real one); the user-facing
 * label should still surface a real prompt rather than an empty string.
 *
 * @example
 * // Sessions 2 + 1 have empty prompts, session 0 has "Original prompt"
 * await readLatestSessionPromptFromCommittedTree(repoDir, tree, cpId, 3)
 * // => 'Original prompt'   (backward fallback found it at index 0)
 */
export async function readLatestSessionPromptFromCommittedTree(
	repoDir: string,
	treeHash: string,
	cpId: CheckpointID,
	sessionCount: number,
): Promise<string> {
	const cpPath = toCheckpointPath(cpId);
	// Audit-3 Fix G (2026-04-18): Go uses `cpTree, err := tree.Tree(cpPath)`
	// (common.go:773-778) — a single tree lookup at the checkpoint dir; if
	// absent, return "" immediately. Pre-fix TS looped sessionCount times
	// via readBlobInTree, each call walking from the root tree → O(N) wasted
	// reads when the checkpoint dir doesn't exist. Treat the missing-cpPath
	// path as a fast-fail before the per-session backward scan.
	if (!(await treeExistsInTree(repoDir, treeHash, cpPath))) {
		return '';
	}
	const latestIndex = Math.max(sessionCount - 1, 0);
	for (let i = latestIndex; i >= 0; i--) {
		const sessionPath = joinPath(cpPath, String(i));
		const blob = await readBlobInTree(repoDir, treeHash, joinPath(sessionPath, PROMPT_FILE_NAME));
		if (blob === null) {
			continue;
		}
		const prompt = extractFirstPrompt(blob);
		if (prompt !== '') {
			return prompt;
		}
	}
	return '';
}

/**
 * Read **all** session prompts from a checkpoint tree, indexed parallel to
 * `sessionIds` (caller passes its known session ID list).
 *
 * Mirrors Go `common.go:812-838` (`ReadAllSessionPromptsFromTree`):
 *
 * - **Single-session** (`sessionCount <= 1` OR `sessionIds.length <= 1`):
 *   reads `<checkpointPath>/prompt.txt` (root-level); returns `[prompt]` or
 *   `[]` when empty.
 * - **Multi-session** (`sessionCount > 1` AND `sessionIds.length > 1`):
 *   - For `i` in `[0, sessionCount-2]`: reads `<checkpointPath>/<i>/prompt.txt`
 *     (archived sessions in numbered subdirs)
 *   - For the last index (newest): reads `<checkpointPath>/prompt.txt` (root)
 *
 * @example
 * ```ts
 * // Single-session checkpoint:
 * await readAllSessionPromptsFromTree(repoDir, tree, 'a3/b2c4d5e6f7', 1, ['sess-1']);
 * // returns: ['Refactor the auth flow']
 *
 * // Multi-session (3 sessions): older two read from <cp>/0/prompt.txt and
 * // <cp>/1/prompt.txt; newest from <cp>/prompt.txt:
 * await readAllSessionPromptsFromTree(repoDir, tree, 'a3/b2c4d5e6f7', 3, ['sess-a', 'sess-b', 'sess-c']);
 * // returns: ['First prompt', 'Second prompt', 'Latest prompt']
 *
 * // Side effects: none — read-only blob lookups; up to N tree walks.
 * //
 * // Disk / git refs / HEAD: unchanged.
 * ```
 */
export async function readAllSessionPromptsFromTree(
	repoDir: string,
	treeHash: string,
	checkpointPath: string,
	sessionCount: number,
	sessionIds: string[],
): Promise<string[]> {
	if (sessionCount <= 1 || sessionIds.length <= 1) {
		const prompt = await readSessionPromptFromTree(repoDir, treeHash, checkpointPath);
		return prompt !== '' ? [prompt] : [];
	}
	const result = new Array<string>(sessionIds.length).fill('');
	for (let i = 0; i < sessionCount - 1; i++) {
		result[i] = await readSessionPromptFromTree(
			repoDir,
			treeHash,
			joinPath(checkpointPath, String(i)),
		);
	}
	result[result.length - 1] = await readSessionPromptFromTree(repoDir, treeHash, checkpointPath);
	return result;
}

// Internal helpers ------------------------------------------------------------

/** Returns true when a blob exists at the given path inside `treeHash`. */
async function blobExistsInTree(
	repoDir: string,
	treeHash: string,
	pathInTree: string,
): Promise<boolean> {
	const blob = await readBlobInTree(repoDir, treeHash, pathInTree);
	return blob !== null;
}

/** Returns true when a tree (subdirectory) exists at the given path inside `treeHash`. */
async function treeExistsInTree(
	repoDir: string,
	treeHash: string,
	pathInTree: string,
): Promise<boolean> {
	const segments = pathInTree.split('/').filter((s) => s !== '');
	if (segments.length === 0) {
		return false;
	}
	let currentTree = treeHash;
	for (const segment of segments) {
		try {
			const result = await git.readTree({ fs: fsCallback, dir: repoDir, oid: currentTree });
			const child = result.tree.find((e) => e.path === segment && e.type === 'tree');
			if (!child) {
				return false;
			}
			currentTree = child.oid;
		} catch {
			return false;
		}
	}
	return true;
}

/**
 * Read a blob at `pathInTree` (slash-separated). Returns `null` when any
 * segment / leaf is missing or non-blob. Tolerates traversal failures.
 */
async function readBlobInTree(
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
