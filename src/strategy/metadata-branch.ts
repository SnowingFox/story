/**
 * Strategy-package facade over the v1 metadata branch (Phase 4.3) and the v2
 * ref namespace (Phase 4.4) — exposes the read-side API the rest of the
 * strategy package needs without depending on `@/checkpoint/*` directly.
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/strategy/common.go:120-650` —
 * `EnsureMetadataBranch` / `ListCheckpoints` / `GetMetadataBranchTree` /
 * `GetV2MetadataBranchTree` / `ReadCheckpointMetadata` /
 * `ReadCheckpointMetadataFromSubtree` / `decodeCheckpointInfo`.
 *
 * Heavy reads delegate to [src/checkpoint/committed.ts](src/checkpoint/committed.ts)
 * (Phase 4.3); JSON parsing uses Phase 4.4 {@link parseMetadataJSON} for
 * snake_case Go-compat.
 *
 * @packageDocumentation
 */

import fsCallback from 'node:fs';
import git from 'isomorphic-git';
import { normalize } from '../agent/types';
import { listCommitted as committedListCommitted } from '../checkpoint/committed';
import {
	METADATA_BRANCH_NAME,
	METADATA_FILE_NAME,
	V2_MAIN_REF_NAME,
} from '../checkpoint/constants';
import { execGit } from '../git';
import { parseMetadataJSON } from '../jsonutil';
import type { CheckpointInfo } from './types';

/**
 * Well-known SHA of the empty git tree (the root tree of an orphan commit
 * with no files). Used by {@link ensureMetadataBranch} when both local and
 * remote refs are missing — bypasses needing to write an empty tree object
 * because git's storage layer already has this hash content-addressed.
 */
const EMPTY_TREE_HASH = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** Git's "no commit" sentinel hash (40 zeros). */
const ZERO_HASH = '0000000000000000000000000000000000000000';

/**
 * Ensure the metadata branch (`story/checkpoints/v1`) is in a usable state.
 *
 * Five-branch logic mirroring Go `common.go:314-430` (`EnsureMetadataBranch`):
 *
 * 1. **local exists + matches remote** — no-op
 * 2. **local exists + diverges from remote + local is empty orphan** — reset
 *    local to `remote.hash` (lifts a placeholder local that was created before
 *    we knew about the remote)
 * 3. **local exists + diverges from remote + local has real data** — no-op;
 *    "reconciliation deferred to push path"  (Phase 5.6 push handles it)
 * 4. **no local + remote exists** — track remote (set `refs/heads/<branch>` to
 *    `remote.hash`)
 * 5. **no local + no remote** — create orphan commit pointing at the empty
 *    tree, with the canonical Go message
 *
 * @example
 * await ensureMetadataBranch(repoRoot);
 * // Side effects depend on which of 5 branches fired; common cases:
 * //   - .git/refs/heads/story/checkpoints/v1 ← created (orphan, empty tree) when neither side existed
 * //   - .git/refs/heads/story/checkpoints/v1 ← reset to origin's hash when local was empty placeholder
 * //   - HEAD: unchanged
 * //   - worktree / index: unchanged
 */
export async function ensureMetadataBranch(repoDir: string): Promise<void> {
	const refName = `refs/heads/${METADATA_BRANCH_NAME}`;
	const remoteRefName = `refs/remotes/origin/${METADATA_BRANCH_NAME}`;

	const remoteHash = await tryRevParse(repoDir, remoteRefName);
	const localHash = await tryRevParse(repoDir, refName);

	if (localHash !== null) {
		// Branch 1-3: local exists
		if (remoteHash !== null && localHash !== remoteHash) {
			const localIsEmpty = await isEmptyMetadataBranch(repoDir, localHash);
			if (localIsEmpty) {
				// Branch 2: lift placeholder.
				// Go: common.go:343 — `[entire] Updated local branch '%s' from origin`.
				// TS drops the `[entire]` brand prefix per [story-vs-entire.md] rebrand.
				await execGit(['update-ref', refName, remoteHash], { cwd: repoDir });
				process.stderr.write(`Updated local branch '${METADATA_BRANCH_NAME}' from origin\n`);
			}
			// Branch 3: real data + diverged → defer to push path (no-op here)
		}
		// Branch 1: local matches remote OR no remote at all → no-op
		return;
	}

	if (remoteHash !== null) {
		// Branch 4: track remote.
		// Go: common.go:366 — `✓ Created local branch '%s' from origin`.
		await execGit(['update-ref', refName, remoteHash], { cwd: repoDir });
		process.stderr.write(`✓ Created local branch '${METADATA_BRANCH_NAME}' from origin\n`);
		return;
	}

	// Branch 5: create orphan with empty tree (Go: common.go:412-428)
	const message = 'Initialize metadata branch\n\nThis branch stores session metadata.\n';
	const orphanCommit = (
		await execGit(['commit-tree', EMPTY_TREE_HASH, '-m', message], { cwd: repoDir })
	).trim();
	await execGit(['update-ref', refName, orphanCommit], { cwd: repoDir });
	// Go: common.go:413 — `✓ Created orphan branch '%s' for session metadata`.
	process.stderr.write(`✓ Created orphan branch '${METADATA_BRANCH_NAME}' for session metadata\n`);
}

/**
 * List all committed checkpoints on the metadata branch (newest first).
 * Returns the strategy-namespaced {@link CheckpointInfo} shape (with `Date`
 * for `createdAt`); Phase 4.3 `CommittedInfo` is converted in-place.
 *
 * Mirrors Go `common.go:120-229` (`ListCheckpoints`); delegates to Phase 4.3
 * {@link committedListCommitted}.
 *
 * @example
 * ```ts
 * const checkpoints = await listCheckpoints(repoDir);
 * // returns: [
 * //   { checkpointId: 'a3b2c4d5e6f7', sessionId: 'sess-2', createdAt: Date, ... },
 * //   { checkpointId: 'def0123456ab', sessionId: 'sess-1', createdAt: Date, ... },
 * // ]
 * // (sorted newest first by Phase 4.3 listCommitted)
 *
 * // Side effects: none — read-only walk of the metadata branch tree (v1 + v2 fallback).
 * //
 * // Disk / git refs / HEAD: unchanged.
 * ```
 */
export async function listCheckpoints(repoDir: string): Promise<CheckpointInfo[]> {
	const raw = await committedListCommitted(repoDir);
	return raw.map((info) => ({
		checkpointId: info.checkpointId,
		sessionId: info.sessionId,
		// `createdAt` is ISO-8601; empty string → Invalid Date — caller's
		// responsibility to filter (matches Go behavior of zero `time.Time`).
		createdAt: new Date(info.createdAt),
		checkpointsCount: info.checkpointsCount,
		filesTouched: info.filesTouched,
		agent: info.agent ? normalize(info.agent) : undefined,
		isTask: info.isTask || undefined,
		toolUseId: info.toolUseId || undefined,
		sessionCount: info.sessionCount || undefined,
		sessionIds: info.sessionIds.length > 0 ? info.sessionIds : undefined,
	}));
}

/**
 * Returns the root tree hash of the v1 metadata branch
 * (`story/checkpoints/v1`), or `null` when the branch doesn't exist.
 *
 * Mirrors Go `common.go:610-628` (`GetMetadataBranchTree`).
 *
 * @example
 * ```ts
 * await getMetadataBranchTree(repoDir);
 * // returns: 'a3b2c4d5e6f7...'   (root tree hash) when refs/heads/story/checkpoints/v1 exists
 * // returns: null                  when the branch doesn't exist
 *
 * // Side effects: none — runs `git rev-parse <ref>^{tree}`.
 * //
 * // Disk / git refs / HEAD: unchanged.
 * ```
 */
export async function getMetadataBranchTree(repoDir: string): Promise<string | null> {
	return readRefTreeHash(repoDir, `refs/heads/${METADATA_BRANCH_NAME}`);
}

/**
 * Returns the root tree hash of the v2 main ref (`refs/story/checkpoints/v2/main`),
 * or `null` when the ref doesn't exist (v2 not yet initialized).
 *
 * Mirrors Go `common.go:630-650` (`GetV2MetadataBranchTree`).
 *
 * @example
 * ```ts
 * await getV2MetadataBranchTree(repoDir);
 * // returns: 'def01234...'   (root tree hash) when refs/story/checkpoints/v2/main exists
 * // returns: null              when v2 metadata isn't initialized yet
 *
 * // Side effects: none — runs `git rev-parse <ref>^{tree}`.
 * //
 * // Disk / git refs / HEAD: unchanged.
 * ```
 */
export async function getV2MetadataBranchTree(repoDir: string): Promise<string | null> {
	return readRefTreeHash(repoDir, V2_MAIN_REF_NAME);
}

/**
 * Returns the root tree hash of the **remote** v1 metadata branch
 * (`refs/remotes/origin/story/checkpoints/v1`), or `null` when the remote
 * ref doesn't exist (no `git fetch origin <metadata>` has run, or origin
 * has no metadata branch yet).
 *
 * Mirrors Go `common.go:841-858` (`GetRemoteMetadataBranchTree`). Used by
 * `EnsureMetadataBranch` (Phase 5.1) and `story resume` / `story explain`
 * (Phase 9.4) to decide whether the local branch needs to be reset to remote.
 *
 * **Go-vs-TS shape**: Go returns `(*object.Tree, error)` and treats "ref
 * missing" as an error; TS returns `string | null` for parity with the local
 * `getMetadataBranchTree` / `getV2MetadataBranchTree` (caller does not need to
 * `try/catch` for the most common condition). The behavior is otherwise
 * identical.
 *
 * @example
 * ```ts
 * await getRemoteMetadataBranchTree(repoDir);
 * // returns: 'a3b2c4d5e6f7...'   (root tree hash) when refs/remotes/origin/story/checkpoints/v1 exists
 * // returns: null                  when the remote ref is missing
 *
 * // Side effects: none — runs `git rev-parse <ref>^{tree}` only.
 * //
 * // Disk / git refs / HEAD / fetch state: unchanged.
 * ```
 */
export async function getRemoteMetadataBranchTree(repoDir: string): Promise<string | null> {
	return readRefTreeHash(repoDir, `refs/remotes/origin/${METADATA_BRANCH_NAME}`);
}

/**
 * Read checkpoint metadata from a tree at the absolute checkpoint path
 * (`<aa>/<bb...>`). Reads `<checkpointPath>/metadata.json`, then walks any
 * referenced session sub-paths to build the full {@link CheckpointInfo}.
 *
 * Mirrors Go `common.go:493-540` (`ReadCheckpointMetadata`).
 *
 * @example
 * ```ts
 * const tree = await getMetadataBranchTree(repoDir);
 * const info = await readCheckpointMetadata(repoDir, tree!, 'a3/b2c4d5e6f7');
 * // returns: { checkpointId: 'a3b2c4d5e6f7', sessionId: '...', sessionIds: [...], ... }
 * // returns: null  (when <checkpointPath>/metadata.json doesn't exist in the tree)
 *
 * // Side effects: none — read-only blob lookups (one for metadata.json plus
 * // one per referenced session subtree).
 * //
 * // Disk / git refs / HEAD / branch tip: unchanged.
 * ```
 */
export async function readCheckpointMetadata(
	repoDir: string,
	treeHash: string,
	checkpointPath: string,
): Promise<CheckpointInfo | null> {
	const blob = await readBlobInTree(
		repoDir,
		treeHash,
		joinPath(checkpointPath, METADATA_FILE_NAME),
	);
	if (blob === null) {
		return null;
	}
	return decodeCheckpointInfoFromTree(repoDir, treeHash, blob, (sessionPath) =>
		// Go normalizePath: strip leading "/" only
		sessionPath.startsWith('/') ? sessionPath.slice(1) : sessionPath,
	);
}

/**
 * Read checkpoint metadata from a sub-tree (the tree IS the checkpoint
 * subtree, not the metadata branch root). Used when the caller already
 * descended one level (e.g. iterating `<aa>/<bb...>` directories).
 *
 * Mirrors Go `common.go:550-608` (`ReadCheckpointMetadataFromSubtree`). The
 * normalize function strips the `<checkpointPath>/` prefix from absolute-form
 * session paths so they resolve under the subtree.
 *
 * @example
 * ```ts
 * // Caller already walked from root tree down to "a3/b2c4d5e6f7" subtree:
 * const subtree = await readTreeEntry(repoDir, root, 'a3/b2c4d5e6f7');
 * const info = await readCheckpointMetadataFromSubtree(repoDir, subtree, 'a3/b2c4d5e6f7');
 * // returns: CheckpointInfo  | null (when metadata.json missing in subtree)
 *
 * // Side effects: none — read-only walk of the subtree blobs.
 * //
 * // Disk / git refs / HEAD / cache: unchanged.
 * ```
 */
export async function readCheckpointMetadataFromSubtree(
	repoDir: string,
	subtreeHash: string,
	checkpointPath: string,
): Promise<CheckpointInfo | null> {
	const blob = await readBlobInTree(repoDir, subtreeHash, METADATA_FILE_NAME);
	if (blob === null) {
		return null;
	}
	const prefix = `/${checkpointPath}/`;
	return decodeCheckpointInfoFromTree(repoDir, subtreeHash, blob, (sessionPath) => {
		if (sessionPath.startsWith(prefix)) {
			return sessionPath.slice(prefix.length);
		}
		return sessionPath.startsWith('/') ? sessionPath.slice(1) : sessionPath;
	});
}

/**
 * Decode a checkpoint summary blob and walk its session entries against the
 * given tree to build the full {@link CheckpointInfo}.
 *
 * Two-format fallback (Go `decodeCheckpointInfo`):
 *
 * 1. **Modern**: blob is a `CheckpointSummary` with `sessions[]` listing
 *    relative file paths; per-session `metadata.json` blobs hold the
 *    individual session metadata. The first session populates `agent`,
 *    `sessionId`, `createdAt`, `isTask`, `toolUseId`. All session IDs
 *    accumulate into `sessionIds[]`.
 * 2. **Legacy**: blob is a flat `CheckpointInfo` with the per-session fields
 *    inlined at the top level. Falls back to this when modern decode produces
 *    `len(sessions) == 0`, mirroring Go's exact two-step probe.
 *
 * `normalizeSessionPath` adapts Go's two-mode path normalization (full-tree vs
 * subtree) to the right relative path inside the tree.
 */
async function decodeCheckpointInfoFromTree(
	repoDir: string,
	treeHash: string,
	summaryBlob: Uint8Array,
	normalizeSessionPath: (path: string) => string,
): Promise<CheckpointInfo> {
	type SessionFilePaths = { metadata?: string; prompt?: string };
	type SummaryLite = {
		checkpointId?: string;
		sessions?: SessionFilePaths[];
		filesTouched?: string[];
		checkpointsCount?: number;
	};

	const summary = parseMetadataJSON<SummaryLite>(new TextDecoder('utf-8').decode(summaryBlob));

	if (!summary.sessions || summary.sessions.length === 0) {
		// Legacy fallback: blob IS the full CheckpointInfo
		return decodeCheckpointInfo(summaryBlob);
	}

	const info: CheckpointInfo = {
		checkpointId: summary.checkpointId ?? '',
		sessionId: '',
		createdAt: new Date(NaN),
		checkpointsCount: summary.checkpointsCount ?? 0,
		filesTouched: summary.filesTouched ?? [],
		sessionCount: summary.sessions.length,
		sessionIds: [],
	};

	for (let i = 0; i < summary.sessions.length; i++) {
		const sessionPaths = summary.sessions[i];
		// `noUncheckedIndexedAccess` requires the explicit guard even though the
		// `i < length` loop bound makes the access safe at runtime.
		if (!sessionPaths?.metadata) {
			continue;
		}
		const sessionMetaPath = normalizeSessionPath(sessionPaths.metadata);
		const sessionBlob = await readBlobInTree(repoDir, treeHash, sessionMetaPath);
		if (sessionBlob === null) {
			continue;
		}

		type SessionMetaLite = {
			sessionId?: string;
			agent?: string;
			createdAt?: string;
			isTask?: boolean;
			toolUseId?: string;
		};
		let sessionMeta: SessionMetaLite;
		try {
			sessionMeta = parseMetadataJSON<SessionMetaLite>(
				new TextDecoder('utf-8').decode(sessionBlob),
			);
		} catch {
			continue;
		}

		if (sessionMeta.sessionId) {
			info.sessionIds!.push(sessionMeta.sessionId);
		}
		// First session populates the representative fields (Go behavior)
		if (i === 0) {
			info.sessionId = sessionMeta.sessionId ?? '';
			info.agent = sessionMeta.agent ? normalize(sessionMeta.agent) : undefined;
			info.createdAt = sessionMeta.createdAt ? new Date(sessionMeta.createdAt) : new Date(NaN);
			info.isTask = sessionMeta.isTask || undefined;
			info.toolUseId = sessionMeta.toolUseId || undefined;
		}
	}

	return info;
}

/**
 * Decode a `metadata.json` blob (raw bytes) into the strategy-namespaced
 * {@link CheckpointInfo} shape. Used by callers that already have the blob
 * in hand and don't need tree traversal (e.g. legacy single-file metadata).
 *
 * Uses Phase 4.4 {@link parseMetadataJSON} (snake_case → camelCase Go-compat).
 *
 * @example
 * ```ts
 * const blob = new TextEncoder().encode(JSON.stringify({
 *   checkpoint_id: 'a3b2c4d5e6f7',
 *   session_id: 'sess-1',
 *   created_at: '2026-04-18T12:00:00Z',
 *   checkpoints_count: 3,
 *   files_touched: ['src/app.ts'],
 *   agent: 'Claude Code',
 * }));
 * decodeCheckpointInfo(blob);
 * // returns: { checkpointId: 'a3b2c4d5e6f7', sessionId: 'sess-1',
 * //           createdAt: Date, checkpointsCount: 3, ... }
 *
 * // Side effects: none — pure JSON decode (snake_case → camelCase).
 * ```
 */
export function decodeCheckpointInfo(raw: Uint8Array): CheckpointInfo {
	const text = new TextDecoder('utf-8').decode(raw);
	const decoded = parseMetadataJSON<{
		checkpointId: string;
		sessionId: string;
		createdAt: string;
		checkpointsCount: number;
		filesTouched?: string[];
		agent?: string;
		isTask?: boolean;
		toolUseId?: string;
		sessionCount?: number;
		sessionIds?: string[];
	}>(text);
	return {
		checkpointId: decoded.checkpointId,
		sessionId: decoded.sessionId,
		createdAt: new Date(decoded.createdAt),
		checkpointsCount: decoded.checkpointsCount,
		filesTouched: decoded.filesTouched ?? [],
		agent: decoded.agent ? normalize(decoded.agent) : undefined,
		isTask: decoded.isTask,
		toolUseId: decoded.toolUseId,
		sessionCount: decoded.sessionCount,
		sessionIds: decoded.sessionIds,
	};
}

// Internal helpers ------------------------------------------------------------

/** `git rev-parse --verify <ref>` returning trimmed hash or null on failure. */
async function tryRevParse(repoDir: string, ref: string): Promise<string | null> {
	try {
		const out = await execGit(['rev-parse', '--verify', ref], { cwd: repoDir });
		const trimmed = out.trim();
		return trimmed === '' || trimmed === ZERO_HASH ? null : trimmed;
	} catch {
		return null;
	}
}

/**
 * Returns true when the commit at `commitHash` points at an empty tree
 * (orphan placeholder with no files). Used by {@link ensureMetadataBranch}
 * to detect the "lift placeholder" case.
 */
async function isEmptyMetadataBranch(repoDir: string, commitHash: string): Promise<boolean> {
	const lsTree = await execGit(['ls-tree', commitHash], { cwd: repoDir });
	return lsTree.trim() === '';
}

/** Resolve `ref` to its commit, then read its tree hash. Returns `null` on missing ref. */
async function readRefTreeHash(repoDir: string, ref: string): Promise<string | null> {
	let commitHash: string;
	try {
		commitHash = await git.resolveRef({ fs: fsCallback, dir: repoDir, ref });
	} catch {
		return null;
	}
	try {
		const commit = await git.readCommit({ fs: fsCallback, dir: repoDir, oid: commitHash });
		return commit.commit.tree;
	} catch {
		return null;
	}
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
