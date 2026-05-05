/**
 * Permanent (`story/checkpoints/v1`) metadata branch read/write/update path.
 *
 * The metadata branch is an orphan branch carrying the accumulated tree of
 * every committed checkpoint, sharded by ID prefix:
 *
 * ```
 * <id[:2]>/<id[2:]>/
 *   metadata.json          ← CheckpointSummary (aggregated stats)
 *   0/                     ← session 0
 *     metadata.json        ← CommittedMetadata (per-session)
 *     full.jsonl[.NNN]     ← (chunked) transcript
 *     prompt.txt
 *     content_hash.txt
 *   1/                     ← session 1, etc.
 * ```
 *
 * Writes use sparse tree surgery via [`tree-ops.updateSubtree`](./tree-ops.ts):
 * only the touched checkpoint subtree is rewritten, sibling subtrees keep
 * their original hashes. Reads go through {@link FetchingTree} so callers
 * can opt into treeless-fetch mode by wiring a {@link BlobFetchFunc} via
 * `GitStore.setBlobFetcher`; every `read*` helper accepts an optional
 * `fetcher` parameter that the GitStore wrapper threads through.
 *
 * Phase 4.4 promotes a set of internal helpers to `export` so the v2
 * checkpoint store (`v2-store.ts` / `v2-committed.ts` / `v2-read.ts` /
 * `v2-generation.ts`) can compose without duplicating tree-surgery, session
 * indexing, or aggregation code: `ensureSessionsBranch`,
 * `getSessionsBranchRef`, `writeBranchRef`, `flattenCheckpointEntries`,
 * `spliceCheckpointSubtree`, `findSessionIndex`, `readJsonFromBlob`,
 * `chunkBytes`, `aggregateTokenUsage`, `mergeFilesTouched`,
 * `writeContentHash`, `writeCheckpointSummary`, plus the existing
 * `getGitAuthorFromRepo` / `redactSummary`. v2's `/main` ref reuses the
 * same helpers with different file names (`transcript.jsonl` instead of
 * `full.jsonl`).
 *
 * Go reference: `entire-cli/cmd/entire/cli/checkpoint/committed.go`.
 */

import { createHash } from 'node:crypto';
import fsCallback from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import git from 'isomorphic-git';
import { chunkTranscript as agentChunkTranscript } from '../agent/chunking';
import { type AgentType, normalize } from '../agent/types';
import { execGit } from '../git';
import { type CheckpointID, toPath as toCheckpointPath } from '../id';
import { parseMetadataJSON, serializeMetadataJSON } from '../jsonutil';
import { warn } from '../log';
import { redactJSONLBytes, redactString } from '../redact';
import {
	AGENT_TRAILER_KEY,
	METADATA_TASK_TRAILER_KEY,
	SESSION_TRAILER_KEY,
	STRATEGY_TRAILER_KEY,
} from '../trailers';
import { validateAgentID, validateSessionId, validateToolUseID } from '../validation';
import { chunkFileName, parseChunkIndex, sortChunkFiles } from './chunks';
import {
	CONTENT_HASH_FILE_NAME,
	MAX_CHUNK_SIZE,
	METADATA_BRANCH_NAME,
	METADATA_FILE_NAME,
	PROMPT_FILE_NAME,
	TRANSCRIPT_FILE_NAME,
	TRANSCRIPT_FILE_NAME_LEGACY,
} from './constants';
import { type BlobFetchFunc, FetchingTree } from './fetching-tree';
import { createBlobFromContent, createCommit, createRedactedBlobFromFile } from './git-objects';
import { joinPrompts } from './prompts';
import {
	MergeMode,
	MODE_DIR,
	MODE_FILE,
	type TreeEntry,
	updateSubtree,
	ZERO_HASH,
} from './tree-ops';
import type {
	CheckpointAuthor,
	CheckpointSummary,
	CommittedInfo,
	CommittedMetadata,
	InitialAttribution,
	SessionContent,
	SessionFilePaths,
	Summary,
	TokenUsage,
	UpdateCommittedOptions,
	WriteCommittedOptions,
} from './types';

/** Trailer key copied from Go `EphemeralBranchTrailerKey`. Not Story-prefixed. */
const EPHEMERAL_BRANCH_TRAILER_KEY = 'Ephemeral-branch';

/**
 * Sentinel error thrown by update paths when the targeted checkpoint does
 * not exist on the metadata branch.
 */
export class ErrCheckpointNotFound extends Error {
	constructor(checkpointId?: string) {
		super(
			checkpointId === undefined ? 'checkpoint not found' : `checkpoint not found: ${checkpointId}`,
		);
		this.name = 'ErrCheckpointNotFound';
	}
}

/** Public read API */

/**
 * Read a committed checkpoint's root summary by ID. Returns `null` when the
 * checkpoint does not exist (matches Go: missing checkpoint is not an
 * error). Optional `fetcher` enables treeless-fetch for missing blobs.
 *
 * @example
 * ```ts
 * const summary = await readCommitted(repoDir, 'a3b2c4d5e6f7');
 * // summary === {
 * //   checkpointId: 'a3b2c4d5e6f7',
 * //   strategy: 'manual-commit',
 * //   branch: 'main',
 * //   checkpointsCount: 3,
 * //   filesTouched: ['src/app.ts', 'src/login.ts'],
 * //   sessions: [{ metadata: '/0/metadata.json', transcript: '/0/full.jsonl', ... }],
 * //   tokenUsage: { inputTokens: 1234, ... },
 * // }
 *
 * const missing = await readCommitted(repoDir, 'deadbeefcafe');
 * // missing === null
 * ```
 */
export async function readCommitted(
	repoDir: string,
	checkpointId: string,
	fetcher?: BlobFetchFunc,
): Promise<CheckpointSummary | null> {
	const ft = await getFetchingTree(repoDir, fetcher);
	if (ft === null) {
		return null;
	}
	const cpPath = toCheckpointPath(checkpointId as CheckpointID);
	let cpTree: FetchingTree;
	try {
		cpTree = await ft.tree(cpPath);
	} catch {
		return null;
	}
	const metaBytes = await cpTree.file(METADATA_FILE_NAME);
	if (metaBytes === null) {
		return null;
	}
	try {
		return parseMetadataJSON<CheckpointSummary>(new TextDecoder().decode(metaBytes));
	} catch (err) {
		throw new Error(
			`failed to parse metadata.json: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

/** Read just the per-session metadata (no transcript / prompts). */
export async function readSessionMetadata(
	repoDir: string,
	checkpointId: string,
	sessionIndex: number,
	fetcher?: BlobFetchFunc,
): Promise<CommittedMetadata | null> {
	const ft = await getFetchingTree(repoDir, fetcher);
	if (ft === null) {
		throw new ErrCheckpointNotFound(checkpointId);
	}
	const cpPath = toCheckpointPath(checkpointId as CheckpointID);
	const sessionPath = `${cpPath}/${sessionIndex}`;
	let sessionTree: FetchingTree;
	try {
		sessionTree = await ft.tree(sessionPath);
	} catch (err) {
		throw new Error(
			`session ${sessionIndex} not found: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	const metaBytes = await sessionTree.file(METADATA_FILE_NAME);
	if (metaBytes === null) {
		throw new Error(`metadata.json not found for session ${sessionIndex}`);
	}
	try {
		return parseMetadataJSON<CommittedMetadata>(new TextDecoder().decode(metaBytes));
	} catch (err) {
		throw new Error(
			`failed to parse session metadata: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

/**
 * Full session content (metadata + transcript + prompts) for `sessionIndex`.
 *
 * Throws {@link ErrCheckpointNotFound} when the checkpoint or session is
 * missing; returns `null` is reserved for the "summary exists but the
 * session has been intentionally deleted" path which doesn't currently occur
 * (Go always errors). Throws `ErrNoTranscript` when the session exists but
 * has no transcript bytes (mirrors Go).
 *
 * Reassembles chunked transcripts (`full.jsonl` + `full.jsonl.001` + …) and
 * tolerates legacy single-blob `full.log`.
 *
 * @example
 * ```ts
 * const session = await readSessionContent(repoDir, 'a3b2c4d5e6f7', 0);
 * // session === {
 * //   metadata: { sessionId: 'sess-1', strategy: 'manual-commit',
 * //               agent: 'claudecode', tokenUsage: {...}, ... },
 * //   transcript: <Uint8Array of full.jsonl + chunks reassembled>,
 * //   prompts: 'first prompt\n---\nsecond prompt',
 * // }
 *
 * try {
 *   await readSessionContent(repoDir, 'a3b2c4d5e6f7', 99);
 * } catch (err) {
 *   // Error: session 99 not found: ENOTDIR ...
 * }
 *
 * try {
 *   await readSessionContent(repoDir, 'deadbeefcafe', 0);
 * } catch (err) {
 *   // err instanceof ErrCheckpointNotFound
 * }
 * ```
 */
export async function readSessionContent(
	repoDir: string,
	checkpointId: string,
	sessionIndex: number,
	fetcher?: BlobFetchFunc,
): Promise<SessionContent | null> {
	const ft = await getFetchingTree(repoDir, fetcher);
	if (ft === null) {
		throw new ErrCheckpointNotFound(checkpointId);
	}
	const cpPath = toCheckpointPath(checkpointId as CheckpointID);
	let cpTree: FetchingTree;
	try {
		cpTree = await ft.tree(cpPath);
	} catch {
		throw new ErrCheckpointNotFound(checkpointId);
	}
	let sessionTree: FetchingTree;
	try {
		sessionTree = await cpTree.tree(String(sessionIndex));
	} catch (err) {
		throw new Error(
			`session ${sessionIndex} not found: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	let metadata: CommittedMetadata = {} as CommittedMetadata;
	let agentType: AgentType | '' = '';
	const metaBytes = await sessionTree.file(METADATA_FILE_NAME);
	if (metaBytes !== null) {
		try {
			metadata = parseMetadataJSON<CommittedMetadata>(new TextDecoder().decode(metaBytes));
			// metadata.agent is a free-form string from on-disk JSON; normalize to
			// the strict AgentType union so chunk/reassemble dispatch sees a known
			// agent (or `AGENT_TYPE_UNKNOWN`). Mirrors the prompts.ts read pattern.
			agentType = metadata.agent ? normalize(metadata.agent) : '';
		} catch {
			// Tolerate malformed metadata — leaves blank object, mirrors Go.
		}
	}

	const transcript = await readTranscriptFromTree(sessionTree, agentType);
	const promptBytes = await sessionTree.file(PROMPT_FILE_NAME);
	const prompts = promptBytes === null ? '' : new TextDecoder().decode(promptBytes);

	if (transcript === null || transcript.length === 0) {
		throw new ErrNoTranscript(`session ${sessionIndex} has no transcript`);
	}

	return { metadata, transcript, prompts };
}

/** Convenience: read the highest-index session's full content. */
export async function readLatestSessionContent(
	repoDir: string,
	checkpointId: string,
	fetcher?: BlobFetchFunc,
): Promise<SessionContent | null> {
	const summary = await readCommitted(repoDir, checkpointId, fetcher);
	if (summary === null) {
		throw new ErrCheckpointNotFound(checkpointId);
	}
	if (summary.sessions.length === 0) {
		throw new Error(`checkpoint has no sessions: ${checkpointId}`);
	}
	return readSessionContent(repoDir, checkpointId, summary.sessions.length - 1, fetcher);
}

/**
 * Look up a session by its `sessionId` (rather than index). Linear scan
 * across the checkpoint's sessions; mirrors Go's behaviour.
 *
 * Throws {@link ErrCheckpointNotFound} for a missing checkpoint and a
 * plain `Error` for a missing sessionId (matches Go: distinguishes the
 * two cases so commands can give different user messages).
 *
 * @example
 * ```ts
 * // Two sessions on this checkpoint: sess-A (index 0), sess-B (index 1).
 * const a = await readSessionContentById(repoDir, 'a3b2c4d5e6f7', 'sess-A');
 * // a.metadata.sessionId === 'sess-A'
 *
 * try {
 *   await readSessionContentById(repoDir, 'a3b2c4d5e6f7', 'sess-X');
 * } catch (err) {
 *   // Error: session "sess-X" not found in checkpoint a3b2c4d5e6f7
 * }
 * ```
 */
export async function readSessionContentById(
	repoDir: string,
	checkpointId: string,
	sessionId: string,
	fetcher?: BlobFetchFunc,
): Promise<SessionContent | null> {
	const summary = await readCommitted(repoDir, checkpointId, fetcher);
	if (summary === null) {
		throw new ErrCheckpointNotFound(checkpointId);
	}
	for (let i = 0; i < summary.sessions.length; i++) {
		try {
			const content = await readSessionContent(repoDir, checkpointId, i, fetcher);
			if (content !== null && content.metadata.sessionId === sessionId) {
				return content;
			}
		} catch {}
	}
	throw new Error(`session "${sessionId}" not found in checkpoint ${checkpointId}`);
}

/**
 * List every committed checkpoint. Walks the sharded layout
 * (`<id[:2]>/<id[2:]>/`) on `story/checkpoints/v1` and falls back to
 * `origin/story/checkpoints/v1` when the local branch is missing.
 *
 * Sort: most recent `createdAt` first.
 *
 * @example
 * ```ts
 * const list = await listCommitted(repoDir);
 * // list === [
 * //   { checkpointId: 'bbbbbbbbbbbb', sessionId: 'sess-2',
 * //     createdAt: '2026-04-18T...', sessionCount: 1, agent: 'claudecode',
 * //     filesTouched: ['src/login.ts'], ... },
 * //   { checkpointId: 'aaaaaaaaaaaa', sessionId: 'sess-1',
 * //     createdAt: '2026-04-17T...', ... },
 * // ]
 * //
 * // For multi-session checkpoints, the listing's `sessionId` / `agent`
 * // / `createdAt` reflect the LATEST session (highest index).
 * ```
 */
export async function listCommitted(
	repoDir: string,
	fetcher?: BlobFetchFunc,
): Promise<CommittedInfo[]> {
	const ft = await getFetchingTree(repoDir, fetcher);
	if (ft === null) {
		return [];
	}

	const out: CommittedInfo[] = [];
	const buckets = await ft.rawEntries();
	for (const bucket of buckets) {
		if (bucket.type !== 'tree' || bucket.path.length !== 2) {
			continue;
		}
		let bucketTree: FetchingTree;
		try {
			bucketTree = await ft.tree(bucket.path);
		} catch {
			continue;
		}
		const inner = await bucketTree.rawEntries();
		for (const cp of inner) {
			if (cp.type !== 'tree') {
				continue;
			}
			const cpId = bucket.path + cp.path;
			if (!/^[0-9a-f]{12}$/.test(cpId)) {
				continue;
			}
			const info = await readCommittedInfo(ft, cpId);
			if (info !== null) {
				out.push(info);
			}
		}
	}

	out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	return out;
}

async function readCommittedInfo(
	ft: FetchingTree,
	checkpointId: string,
): Promise<CommittedInfo | null> {
	const info: CommittedInfo = {
		checkpointId,
		sessionId: '',
		createdAt: '',
		checkpointsCount: 0,
		filesTouched: [],
		agent: '',
		isTask: false,
		toolUseId: '',
		sessionCount: 0,
		sessionIds: [],
	};
	const cpPath = toCheckpointPath(checkpointId as CheckpointID);
	let cpTree: FetchingTree;
	try {
		cpTree = await ft.tree(cpPath);
	} catch {
		return null;
	}
	const metaBytes = await cpTree.file(METADATA_FILE_NAME);
	if (metaBytes === null) {
		return info;
	}
	let summary: CheckpointSummary;
	try {
		summary = parseMetadataJSON<CheckpointSummary>(new TextDecoder().decode(metaBytes));
	} catch {
		return info;
	}
	info.checkpointsCount = summary.checkpointsCount;
	info.filesTouched = summary.filesTouched ?? [];
	info.sessionCount = summary.sessions.length;

	// Walk every session in index order so sessionIds reflects the storage
	// order; pick up the latest session's metadata as the listing's
	// representative (Go takes the highest-index session).
	const sessionIds: string[] = [];
	for (let i = 0; i < summary.sessions.length; i++) {
		try {
			const sessionTree = await cpTree.tree(String(i));
			const smBytes = await sessionTree.file(METADATA_FILE_NAME);
			if (smBytes === null) {
				continue;
			}
			const sm = parseMetadataJSON<CommittedMetadata>(new TextDecoder().decode(smBytes));
			sessionIds.push(sm.sessionId);
			if (i === summary.sessions.length - 1) {
				info.agent = sm.agent ?? '';
				info.sessionId = sm.sessionId ?? '';
				info.createdAt = sm.createdAt ?? '';
				info.isTask = sm.isTask ?? false;
				info.toolUseId = sm.toolUseId ?? '';
			}
		} catch {
			// Continue — missing session metadata still counts in the list.
		}
	}
	info.sessionIds = sessionIds;
	return info;
}

/**
 * Convenience read: the latest session's transcript bytes (or `null` for a
 * missing checkpoint). Throws when the latest session has zero-length
 * transcript — that's a corrupt checkpoint, not a "no data" condition.
 *
 * @example
 * ```ts
 * const bytes = await getTranscript(repoDir, 'a3b2c4d5e6f7');
 * // bytes === <Uint8Array of latest session's full.jsonl>
 *
 * await getTranscript(repoDir, 'deadbeefcafe');  // → null (not throw)
 * ```
 */
export async function getTranscript(
	repoDir: string,
	checkpointId: string,
	fetcher?: BlobFetchFunc,
): Promise<Uint8Array | null> {
	const content = await readLatestSessionContent(repoDir, checkpointId, fetcher);
	if (content === null) {
		return null;
	}
	if (content.transcript.length === 0) {
		throw new Error(`no transcript found for checkpoint: ${checkpointId}`);
	}
	return content.transcript;
}

/**
 * Convenience read: latest session's transcript + sessionId. Returns
 * `null` for missing checkpoints. Used by the resume / explain commands
 * that need to identify which session a transcript belongs to.
 *
 * @example
 * ```ts
 * const log = await getSessionLog(repoDir, 'a3b2c4d5e6f7');
 * // log === { transcript: <Uint8Array>, sessionId: 'sess-2' }
 *
 * await getSessionLog(repoDir, 'deadbeefcafe');  // → null
 * ```
 */
export async function getSessionLog(
	repoDir: string,
	checkpointId: string,
	fetcher?: BlobFetchFunc,
): Promise<{ transcript: Uint8Array; sessionId: string } | null> {
	const content = await readLatestSessionContent(repoDir, checkpointId, fetcher);
	if (content === null) {
		return null;
	}
	return { transcript: content.transcript, sessionId: content.metadata.sessionId };
}

/**
 * Module-level wrapper around {@link getSessionLog}. Mirrors Go's
 * `LookupSessionLog` — opens the repo at `repoDir` and runs the read.
 */
export function lookupSessionLog(
	repoDir: string,
	checkpointId: string,
	fetcher?: BlobFetchFunc,
): Promise<{ transcript: Uint8Array; sessionId: string } | null> {
	return getSessionLog(repoDir, checkpointId, fetcher);
}

/**
 * Locate the commit on the metadata branch whose subject matches
 * `Checkpoint: <id>` and return its author. Returns `{ name: '', email: '' }`
 * for unknown / missing checkpoints (matches Go: never throws).
 *
 * Used by `story explain` to attribute who created a checkpoint without
 * having to parse the metadata blob.
 *
 * @example
 * ```ts
 * const author = await getCheckpointAuthor(repoDir, 'a3b2c4d5e6f7');
 * // author === { name: 'Alice', email: 'alice@example.com' }
 *
 * await getCheckpointAuthor(repoDir, 'deadbeefcafe');
 * // === { name: '', email: '' }   (missing checkpoint, no throw)
 * ```
 */
export async function getCheckpointAuthor(
	repoDir: string,
	checkpointId: string,
): Promise<CheckpointAuthor> {
	const ref = `refs/heads/${METADATA_BRANCH_NAME}`;
	let tipOid: string;
	try {
		tipOid = await git.resolveRef({ fs: fsCallback, dir: repoDir, ref });
	} catch {
		return { name: '', email: '' };
	}

	const target = `Checkpoint: ${checkpointId}`;
	let log: Awaited<ReturnType<typeof git.log>>;
	try {
		log = await git.log({ fs: fsCallback, dir: repoDir, ref: tipOid });
	} catch {
		return { name: '', email: '' };
	}

	for (const { commit } of log) {
		const newlineIdx = commit.message.indexOf('\n');
		const subject = newlineIdx > 0 ? commit.message.slice(0, newlineIdx) : commit.message;
		if (subject === target) {
			return { name: commit.author.name, email: commit.author.email };
		}
	}
	return { name: '', email: '' };
}

/** Public write API */

/**
 * Write (or in-place update) a session inside `<id[:2]>/<id[2:]>/` on the
 * metadata branch. Creates the orphan branch on first call. Idempotent for
 * the same `(checkpointId, sessionId)` pair: re-writing replaces the
 * existing session subtree (clearing stale files like a no-prompts rewrite).
 *
 * Throws on any validation failure (`invalid committed checkpoint options:
 * <reason>`).
 *
 * @example
 * ```ts
 * await writeCommitted(repoDir, {
 *   checkpointId: 'a3b2c4d5e6f7',
 *   sessionId: 'sess-1',
 *   strategy: 'manual-commit',
 *   transcript: ENC.encode('{"role":"user"}\n'),
 *   prompts: ['hello'],
 *   filesTouched: ['src/app.ts'],
 *   agent: 'claudecode',
 *   model: 'claude-sonnet-4',
 *   authorName: 'Alice',
 *   authorEmail: 'alice@example.com',
 *   // ... rest of WriteCommittedOptions
 * });
 *
 * // Side effects in `<repoDir>/.git/`:
 * //   refs/heads/story/checkpoints/v1 → <commit>
 * //   commit message: "Checkpoint: a3b2c4d5e6f7\n\n…\nStory-Session: sess-1\n…"
 * //   tree layout under that commit:
 * //     a3/b2c4d5e6f7/
 * //       metadata.json          ← CheckpointSummary (snake_case)
 * //       0/
 * //         metadata.json        ← CommittedMetadata for sess-1
 * //         full.jsonl[.NNN]     ← chunked redacted transcript
 * //         prompt.txt           ← redacted joined prompts
 * //         content_hash.txt     ← sha256 of transcript bytes
 * //
 * // Repeating the call with the same (checkpointId, sessionId) replaces
 * // the entire `0/` subtree atomically (single new commit). Repeating with
 * // a NEW sessionId appends `1/`, `2/`, … and re-aggregates the root
 * // metadata.json (sessionCount, filesTouched, tokenUsage).
 * //
 * // Worktree / index / HEAD are never touched.
 * ```
 */
export async function writeCommitted(repoDir: string, opts: WriteCommittedOptions): Promise<void> {
	if (opts.checkpointId === '') {
		throw new Error('invalid committed checkpoint options: checkpoint ID is required');
	}
	const sessionErr = validateSessionId(opts.sessionId);
	if (sessionErr !== null) {
		throw new Error(`invalid committed checkpoint options: ${sessionErr.message}`);
	}
	const toolUseErr = validateToolUseID(opts.toolUseId);
	if (toolUseErr !== null) {
		throw new Error(`invalid committed checkpoint options: ${toolUseErr.message}`);
	}
	const agentErr = validateAgentID(opts.agentId);
	if (agentErr !== null) {
		throw new Error(`invalid committed checkpoint options: ${agentErr.message}`);
	}

	await ensureSessionsBranch(repoDir);
	const { parentHash, rootTreeHash } = await getSessionsBranchRef(repoDir);

	const cpPath = toCheckpointPath(opts.checkpointId as CheckpointID);
	const basePath = `${cpPath}/`;
	const entries = await flattenCheckpointEntries(repoDir, rootTreeHash, cpPath);

	let taskMetadataPath = '';
	if (opts.isTask && opts.toolUseId !== '') {
		taskMetadataPath = await writeTaskCheckpointEntries(repoDir, opts, basePath, entries);
	}

	await writeStandardCheckpointEntries(repoDir, opts, basePath, entries);

	const newTreeHash = await spliceCheckpointSubtree(
		repoDir,
		rootTreeHash,
		opts.checkpointId,
		basePath,
		entries,
	);
	const commitMsg = buildCommitMessage(opts, taskMetadataPath);
	const newCommitHash = await createCommit(
		repoDir,
		newTreeHash,
		parentHash,
		commitMsg,
		opts.authorName,
		opts.authorEmail,
	);
	await writeBranchRef(repoDir, METADATA_BRANCH_NAME, newCommitHash);
}

/**
 * Replace the transcript + prompts of an existing session inside a
 * checkpoint. Used at TurnEnd to swap the partial condensation transcript
 * for the final full transcript.
 *
 * Session selection: matches `opts.sessionId` first; falls back to the
 * latest session (highest index) when no match — same as Go's
 * `findSessionIndex` behaviour.
 *
 * Throws {@link ErrCheckpointNotFound} when the checkpoint doesn't exist.
 *
 * @example
 * ```ts
 * await updateCommitted(repoDir, {
 *   checkpointId: 'a3b2c4d5e6f7',
 *   sessionId: 'sess-1',
 *   transcript: ENC.encode('{"role":"final"}\n'),  // replaces session's transcript chunks + content_hash
 *   prompts: ['updated prompt'],                    // replaces session's prompt.txt
 *   agent: 'claudecode',
 *   compactTranscript: null,                        // v1 ignores this; v2 writes it
 * });
 *
 * // Side effects in `<repoDir>/.git/`:
 * //   refs/heads/story/checkpoints/v1 → <new commit>
 * //   commit message: "Finalize transcript for Checkpoint: a3b2c4d5e6f7"
 * //   tree under that commit: a3/b2c4d5e6f7/<sessionIdx>/full.jsonl[.NNN] +
 * //   content_hash.txt + prompt.txt all replaced; sibling sessions, root
 * //   metadata.json, other checkpoints — all untouched (sparse splice via
 * //   updateSubtree).
 * //
 * // Throws ErrCheckpointNotFound if `a3b2c4d5e6f7` doesn't exist on the
 * // metadata branch — caller checks `err instanceof ErrCheckpointNotFound`.
 * ```
 */
export async function updateCommitted(
	repoDir: string,
	opts: UpdateCommittedOptions,
): Promise<void> {
	if (opts.checkpointId === '') {
		throw new Error('invalid update options: checkpoint ID is required');
	}

	await ensureSessionsBranch(repoDir);
	const { parentHash, rootTreeHash } = await getSessionsBranchRef(repoDir);

	const cpPath = toCheckpointPath(opts.checkpointId as CheckpointID);
	const basePath = `${cpPath}/`;
	const entries = await flattenCheckpointEntries(repoDir, rootTreeHash, cpPath);

	const rootMetadataPath = basePath + METADATA_FILE_NAME;
	const summaryEntry = entries.get(rootMetadataPath);
	if (summaryEntry === undefined) {
		throw new ErrCheckpointNotFound(opts.checkpointId);
	}
	const summary = await readJsonFromBlob<CheckpointSummary>(repoDir, summaryEntry.hash);
	if (summary.sessions.length === 0) {
		throw new ErrCheckpointNotFound(opts.checkpointId);
	}

	let sessionIndex = -1;
	for (let i = 0; i < summary.sessions.length; i++) {
		const metaPath = `${basePath}${i}/${METADATA_FILE_NAME}`;
		const metaEntry = entries.get(metaPath);
		if (metaEntry === undefined) {
			continue;
		}
		try {
			const meta = await readJsonFromBlob<CommittedMetadata>(repoDir, metaEntry.hash);
			if (meta.sessionId === opts.sessionId) {
				sessionIndex = i;
				break;
			}
		} catch {}
	}
	if (sessionIndex === -1) {
		// Fall back to the latest session — Go does the same with a debug log.
		sessionIndex = summary.sessions.length - 1;
	}

	const sessionPath = `${basePath}${sessionIndex}/`;
	if (opts.transcript.length > 0) {
		await replaceTranscript(repoDir, opts.transcript, opts.agent, sessionPath, entries);
	}
	if (opts.prompts.length > 0) {
		const promptContent = await redactString(joinPrompts(opts.prompts));
		const blobHash = await createBlobFromContent(repoDir, new TextEncoder().encode(promptContent));
		const promptPath = sessionPath + PROMPT_FILE_NAME;
		entries.set(promptPath, { name: promptPath, mode: MODE_FILE, hash: blobHash, type: 'blob' });
	}

	const newTreeHash = await spliceCheckpointSubtree(
		repoDir,
		rootTreeHash,
		opts.checkpointId,
		basePath,
		entries,
	);
	const author = await getGitAuthorFromRepo(repoDir);
	const commitMsg = `Finalize transcript for Checkpoint: ${opts.checkpointId}`;
	const newCommitHash = await createCommit(
		repoDir,
		newTreeHash,
		parentHash,
		commitMsg,
		author.name,
		author.email,
	);
	await writeBranchRef(repoDir, METADATA_BRANCH_NAME, newCommitHash);
}

/**
 * Replace the latest session's `summary` field (used by post-condensation
 * AI summary persistence). Throws {@link ErrCheckpointNotFound} if the
 * checkpoint is missing.
 *
 * The summary is run through {@link redactSummary} before persistence, so
 * any AI-generated text that captured a credential gets scrubbed.
 *
 * @example
 * ```ts
 * await updateSummary(repoDir, 'a3b2c4d5e6f7', {
 *   intent: 'add login flow',
 *   outcome: 'shipped /login route',
 *   learnings: { repo: ['monorepo'], code: [], workflow: [] },
 *   friction: [],
 *   openItems: [],
 * });
 *
 * // Side effects:
 * //   refs/heads/story/checkpoints/v1 → <new commit>
 * //   commit message: "Update summary for checkpoint a3b2c4d5e6f7 (session: sess-N)"
 * //   tree change: a3/b2c4d5e6f7/<latestIdx>/metadata.json — only the
 * //   `summary` field replaced; sessionId / strategy / filesTouched /
 * //   tokenUsage etc. preserved verbatim.
 * //
 * // Pass `null` to clear the summary field (sets it to undefined on disk).
 * ```
 */
export async function updateSummary(
	repoDir: string,
	checkpointId: string,
	summary: Summary | null,
): Promise<void> {
	await ensureSessionsBranch(repoDir);
	const { parentHash, rootTreeHash } = await getSessionsBranchRef(repoDir);

	const cpPath = toCheckpointPath(checkpointId as CheckpointID);
	const basePath = `${cpPath}/`;
	const entries = await flattenCheckpointEntries(repoDir, rootTreeHash, cpPath);

	const rootMetadataPath = basePath + METADATA_FILE_NAME;
	const summaryEntry = entries.get(rootMetadataPath);
	if (summaryEntry === undefined) {
		throw new ErrCheckpointNotFound(checkpointId);
	}
	const cpSummary = await readJsonFromBlob<CheckpointSummary>(repoDir, summaryEntry.hash);
	const latestIndex = cpSummary.sessions.length - 1;
	if (latestIndex < 0) {
		throw new ErrCheckpointNotFound(checkpointId);
	}
	const sessionMetadataPath = `${basePath}${latestIndex}/${METADATA_FILE_NAME}`;
	const sessionEntry = entries.get(sessionMetadataPath);
	if (sessionEntry === undefined) {
		throw new Error(`session metadata not found at ${sessionMetadataPath}`);
	}
	const existing = await readJsonFromBlob<CommittedMetadata>(repoDir, sessionEntry.hash);
	existing.summary = (await redactSummary(summary)) ?? undefined;

	const newBlob = await createBlobFromContent(
		repoDir,
		new TextEncoder().encode(`${JSON.stringify(existing, null, 2)}\n`),
	);
	entries.set(sessionMetadataPath, {
		name: sessionMetadataPath,
		mode: MODE_FILE,
		hash: newBlob,
		type: 'blob',
	});

	const newTreeHash = await spliceCheckpointSubtree(
		repoDir,
		rootTreeHash,
		checkpointId,
		basePath,
		entries,
	);
	const author = await getGitAuthorFromRepo(repoDir);
	const commitMsg = `Update summary for checkpoint ${checkpointId} (session: ${existing.sessionId})`;
	const newCommitHash = await createCommit(
		repoDir,
		newTreeHash,
		parentHash,
		commitMsg,
		author.name,
		author.email,
	);
	await writeBranchRef(repoDir, METADATA_BRANCH_NAME, newCommitHash);
}

/**
 * Update the root `combinedAttribution` field on the checkpoint summary
 * without touching any session data. Throws {@link ErrCheckpointNotFound}
 * when the checkpoint is missing.
 *
 * Used by the AI-code-rate pipeline (Phase 5.3) to merge per-session
 * `initialAttribution` into a checkpoint-level rollup at condensation time.
 *
 * @example
 * ```ts
 * await updateCheckpointSummary(repoDir, 'a3b2c4d5e6f7', {
 *   calculatedAt: '2026-04-18T00:00:00Z',
 *   agentLines: 100, agentRemoved: 0,
 *   humanAdded: 50, humanModified: 0, humanRemoved: 0,
 *   totalCommitted: 150, totalLinesChanged: 150,
 *   agentPercentage: 67, metricVersion: 2,
 * });
 *
 * // Side effects:
 * //   refs/heads/story/checkpoints/v1 → <new commit>
 * //   commit message: "Update checkpoint summary for a3b2c4d5e6f7"
 * //   tree change: a3/b2c4d5e6f7/metadata.json — only the
 * //   `combinedAttribution` field replaced; sessions[] / checkpointsCount /
 * //   filesTouched / tokenUsage all preserved.
 * //
 * // Pass `null` to clear the field.
 * ```
 */
export async function updateCheckpointSummary(
	repoDir: string,
	checkpointId: string,
	combinedAttribution: InitialAttribution | null,
): Promise<void> {
	await ensureSessionsBranch(repoDir);
	const { parentHash, rootTreeHash } = await getSessionsBranchRef(repoDir);

	const cpPath = toCheckpointPath(checkpointId as CheckpointID);
	const basePath = `${cpPath}/`;
	const entries = await flattenCheckpointEntries(repoDir, rootTreeHash, cpPath);

	const rootMetadataPath = basePath + METADATA_FILE_NAME;
	const summaryEntry = entries.get(rootMetadataPath);
	if (summaryEntry === undefined) {
		throw new ErrCheckpointNotFound(checkpointId);
	}
	const cpSummary = await readJsonFromBlob<CheckpointSummary>(repoDir, summaryEntry.hash);
	cpSummary.combinedAttribution = combinedAttribution ?? undefined;

	const newBlob = await createBlobFromContent(
		repoDir,
		new TextEncoder().encode(serializeMetadataJSON(cpSummary)),
	);
	entries.set(rootMetadataPath, {
		name: rootMetadataPath,
		mode: MODE_FILE,
		hash: newBlob,
		type: 'blob',
	});

	const newTreeHash = await spliceCheckpointSubtree(
		repoDir,
		rootTreeHash,
		checkpointId,
		basePath,
		entries,
	);
	const author = await getGitAuthorFromRepo(repoDir);
	const commitMsg = `Update checkpoint summary for ${checkpointId}`;
	const newCommitHash = await createCommit(
		repoDir,
		newTreeHash,
		parentHash,
		commitMsg,
		author.name,
		author.email,
	);
	await writeBranchRef(repoDir, METADATA_BRANCH_NAME, newCommitHash);
}

/** Internal: tree shape helpers */

export async function ensureSessionsBranch(repoDir: string): Promise<void> {
	const ref = `refs/heads/${METADATA_BRANCH_NAME}`;
	try {
		await git.resolveRef({ fs: fsCallback, dir: repoDir, ref });
		return;
	} catch {
		// Need to create.
	}
	const emptyTree = await git.writeTree({ fs: fsCallback, dir: repoDir, tree: [] });
	const author = await getGitAuthorFromRepo(repoDir);
	const commitHash = await createCommit(
		repoDir,
		emptyTree,
		ZERO_HASH,
		'Initialize sessions branch',
		author.name,
		author.email,
	);
	await writeBranchRef(repoDir, METADATA_BRANCH_NAME, commitHash);
}

export async function getSessionsBranchRef(
	repoDir: string,
): Promise<{ parentHash: string; rootTreeHash: string }> {
	const ref = `refs/heads/${METADATA_BRANCH_NAME}`;
	const tipOid = await git.resolveRef({ fs: fsCallback, dir: repoDir, ref });
	const { commit } = await git.readCommit({ fs: fsCallback, dir: repoDir, oid: tipOid });
	return { parentHash: tipOid, rootTreeHash: commit.tree };
}

export async function writeBranchRef(
	repoDir: string,
	branchName: string,
	value: string,
): Promise<void> {
	await git.writeRef({
		fs: fsCallback,
		dir: repoDir,
		ref: `refs/heads/${branchName}`,
		value,
		force: true,
	});
}

/**
 * Read the entries under `<checkpointPath>` from the root tree. Returns an
 * empty map when the checkpoint subtree doesn't exist (matches Go: this is
 * the "first write" path, not an error).
 */
export async function flattenCheckpointEntries(
	repoDir: string,
	rootTreeHash: string,
	checkpointPath: string,
): Promise<Map<string, TreeEntry>> {
	const entries = new Map<string, TreeEntry>();
	if (rootTreeHash === ZERO_HASH) {
		return entries;
	}
	let cpTree: Awaited<ReturnType<typeof git.readTree>>;
	try {
		cpTree = await git.readTree({
			fs: fsCallback,
			dir: repoDir,
			oid: rootTreeHash,
			filepath: checkpointPath,
		});
	} catch {
		return entries;
	}
	await collectTreeEntries(repoDir, cpTree.oid, checkpointPath, entries);
	return entries;
}

async function collectTreeEntries(
	repoDir: string,
	treeHash: string,
	prefix: string,
	out: Map<string, TreeEntry>,
): Promise<void> {
	const result = await git.readTree({ fs: fsCallback, dir: repoDir, oid: treeHash });
	for (const entry of result.tree) {
		const fullPath = `${prefix}/${entry.path}`;
		if (entry.type === 'tree') {
			await collectTreeEntries(repoDir, entry.oid, fullPath, out);
		} else {
			out.set(fullPath, {
				name: fullPath,
				mode: entry.mode,
				hash: entry.oid,
				type: entry.type,
			});
		}
	}
}

/**
 * Splice the rebuilt checkpoint subtree back into the root tree at the
 * sharded path. Sibling shards keep their original hashes (structural
 * sharing).
 */
export async function spliceCheckpointSubtree(
	repoDir: string,
	rootTreeHash: string,
	checkpointId: string,
	basePath: string,
	entries: Map<string, TreeEntry>,
): Promise<string> {
	const relEntries = new Map<string, TreeEntry>();
	for (const [p, entry] of entries) {
		if (!p.startsWith(basePath)) {
			continue;
		}
		const rel = p.slice(basePath.length);
		relEntries.set(rel, { ...entry, name: rel });
	}
	const cpTreeHash = await buildSubtreeFromRelEntries(repoDir, relEntries);
	const shardPrefix = checkpointId.slice(0, 2);
	const shardSuffix = checkpointId.slice(2);
	return updateSubtree(
		repoDir,
		rootTreeHash,
		[shardPrefix],
		[{ name: shardSuffix, mode: MODE_DIR, hash: cpTreeHash, type: 'tree' }],
		{ mergeMode: MergeMode.MergeKeepExisting },
	);
}

async function buildSubtreeFromRelEntries(
	repoDir: string,
	entries: Map<string, TreeEntry>,
): Promise<string> {
	interface Node {
		files: TreeEntry[];
		subdirs: Map<string, Node>;
	}
	const newNode = (): Node => ({ files: [], subdirs: new Map() });
	const root = newNode();
	for (const [p, entry] of entries) {
		const parts = p.split('/').filter((s) => s !== '');
		let node = root;
		for (let i = 0; i < parts.length - 1; i++) {
			const seg = parts[i]!;
			let child = node.subdirs.get(seg);
			if (child === undefined) {
				child = newNode();
				node.subdirs.set(seg, child);
			}
			node = child;
		}
		const leaf = parts[parts.length - 1]!;
		node.files.push({ ...entry, name: leaf });
	}

	async function build(node: Node): Promise<string> {
		const treeEntries: TreeEntry[] = [...node.files];
		for (const [name, child] of node.subdirs) {
			const subHash = await build(child);
			treeEntries.push({ name, mode: MODE_DIR, hash: subHash, type: 'tree' });
		}
		const isoEntries = treeEntries.map((e) => ({
			mode: e.mode,
			path: e.name,
			oid: e.hash,
			type: e.type,
		}));
		return git.writeTree({ fs: fsCallback, dir: repoDir, tree: isoEntries });
	}
	return build(root);
}

/** Internal: per-write helpers */

async function writeStandardCheckpointEntries(
	repoDir: string,
	opts: WriteCommittedOptions,
	basePath: string,
	entries: Map<string, TreeEntry>,
): Promise<void> {
	const rootMetadataPath = basePath + METADATA_FILE_NAME;
	let existingSummary: CheckpointSummary | null = null;
	const existingEntry = entries.get(rootMetadataPath);
	if (existingEntry !== undefined) {
		try {
			existingSummary = await readJsonFromBlob<CheckpointSummary>(repoDir, existingEntry.hash);
		} catch {
			existingSummary = null;
		}
	}

	const sessionIndex = await findSessionIndex(
		repoDir,
		basePath,
		existingSummary,
		entries,
		opts.sessionId,
	);
	const sessionPath = `${basePath}${sessionIndex}/`;
	const sessionFilePaths = await writeSessionToSubdirectory(repoDir, opts, sessionPath, entries);

	if (opts.metadataDir !== '') {
		await copyMetadataDir(repoDir, opts.metadataDir, sessionPath, entries);
	}

	let sessions: SessionFilePaths[];
	if (existingSummary !== null) {
		const len = Math.max(existingSummary.sessions.length, sessionIndex + 1);
		sessions = new Array(len);
		for (let i = 0; i < existingSummary.sessions.length; i++) {
			sessions[i] = existingSummary.sessions[i]!;
		}
		// Fill any unwritten slots with sentinel (Go grows the slice with
		// zero-value entries; we approximate with empty path strings).
		for (let i = 0; i < sessions.length; i++) {
			if (sessions[i] === undefined) {
				sessions[i] = { metadata: '', prompt: '' };
			}
		}
	} else {
		sessions = [{ metadata: '', prompt: '' }];
	}
	sessions[sessionIndex] = sessionFilePaths;

	await writeCheckpointSummary(repoDir, opts, basePath, entries, sessions);
}

async function writeSessionToSubdirectory(
	repoDir: string,
	opts: WriteCommittedOptions,
	sessionPath: string,
	entries: Map<string, TreeEntry>,
): Promise<SessionFilePaths> {
	// Clear stale entries under this sessionPath so a re-write of the same
	// session ID drops files that aren't being written this round.
	for (const key of [...entries.keys()]) {
		if (key.startsWith(sessionPath)) {
			entries.delete(key);
		}
	}

	const filePaths: SessionFilePaths = { metadata: '', prompt: '' };

	const wroteTranscript = await writeTranscript(repoDir, opts, sessionPath, entries);
	if (wroteTranscript) {
		filePaths.transcript = `/${sessionPath}${TRANSCRIPT_FILE_NAME}`;
		filePaths.contentHash = `/${sessionPath}${CONTENT_HASH_FILE_NAME}`;
	}

	if (opts.prompts.length > 0) {
		const promptContent = await redactString(joinPrompts(opts.prompts));
		const blobHash = await createBlobFromContent(repoDir, new TextEncoder().encode(promptContent));
		const promptPath = sessionPath + PROMPT_FILE_NAME;
		entries.set(promptPath, {
			name: promptPath,
			mode: MODE_FILE,
			hash: blobHash,
			type: 'blob',
		});
		filePaths.prompt = `/${sessionPath}${PROMPT_FILE_NAME}`;
	}

	const sessionMetadata: CommittedMetadata = {
		checkpointId: opts.checkpointId,
		sessionId: opts.sessionId,
		strategy: opts.strategy,
		createdAt: new Date().toISOString(),
		branch: opts.branch,
		checkpointsCount: opts.checkpointsCount,
		filesTouched: opts.filesTouched,
		agent: opts.agent,
		model: opts.model,
		turnId: opts.turnId,
		isTask: opts.isTask,
		toolUseId: opts.toolUseId,
		transcriptIdentifierAtStart: opts.transcriptIdentifierAtStart,
		checkpointTranscriptStart: opts.checkpointTranscriptStart,
		// Deprecated mirror — kept for backwards compatibility with consumers
		// that haven't migrated to checkpointTranscriptStart yet.
		transcriptLinesAtStart: opts.checkpointTranscriptStart,
		tokenUsage: opts.tokenUsage ?? undefined,
		sessionMetrics: opts.sessionMetrics ?? undefined,
		initialAttribution: opts.initialAttribution ?? undefined,
		promptAttributions: opts.promptAttributionsJson,
		summary: (await redactSummary(opts.summary)) ?? undefined,
		cliVersion: undefined,
	};
	const metadataJSON = serializeMetadataJSON(sessionMetadata);
	const metadataHash = await createBlobFromContent(repoDir, new TextEncoder().encode(metadataJSON));
	const metadataPath = sessionPath + METADATA_FILE_NAME;
	entries.set(metadataPath, {
		name: metadataPath,
		mode: MODE_FILE,
		hash: metadataHash,
		type: 'blob',
	});
	filePaths.metadata = `/${sessionPath}${METADATA_FILE_NAME}`;

	return filePaths;
}

export async function writeCheckpointSummary(
	repoDir: string,
	opts: WriteCommittedOptions,
	basePath: string,
	entries: Map<string, TreeEntry>,
	sessions: SessionFilePaths[],
): Promise<void> {
	const { checkpointsCount, filesTouched, tokenUsage } = await reaggregateFromEntries(
		repoDir,
		basePath,
		sessions.length,
		entries,
	);

	let combinedAttribution: InitialAttribution | undefined;
	const rootMetadataPath = basePath + METADATA_FILE_NAME;
	const existing = entries.get(rootMetadataPath);
	if (existing !== undefined) {
		try {
			const previousSummary = await readJsonFromBlob<CheckpointSummary>(repoDir, existing.hash);
			combinedAttribution = previousSummary.combinedAttribution;
		} catch {
			combinedAttribution = undefined;
		}
	}

	const summary: CheckpointSummary = {
		checkpointId: opts.checkpointId,
		strategy: opts.strategy,
		branch: opts.branch,
		checkpointsCount,
		filesTouched,
		sessions,
		tokenUsage: tokenUsage ?? undefined,
		combinedAttribution,
	};
	const metadataJSON = serializeMetadataJSON(summary);
	const metadataHash = await createBlobFromContent(repoDir, new TextEncoder().encode(metadataJSON));
	entries.set(rootMetadataPath, {
		name: rootMetadataPath,
		mode: MODE_FILE,
		hash: metadataHash,
		type: 'blob',
	});
}

export async function findSessionIndex(
	repoDir: string,
	basePath: string,
	existingSummary: CheckpointSummary | null,
	entries: Map<string, TreeEntry>,
	sessionId: string,
): Promise<number> {
	if (existingSummary === null) {
		return 0;
	}
	for (let i = 0; i < existingSummary.sessions.length; i++) {
		const metaPath = `${basePath}${i}/${METADATA_FILE_NAME}`;
		const metaEntry = entries.get(metaPath);
		if (metaEntry === undefined) {
			continue;
		}
		try {
			const meta = await readJsonFromBlob<CommittedMetadata>(repoDir, metaEntry.hash);
			if (meta.sessionId === sessionId) {
				return i;
			}
		} catch {}
	}
	return existingSummary.sessions.length;
}

async function reaggregateFromEntries(
	repoDir: string,
	basePath: string,
	sessionCount: number,
	entries: Map<string, TreeEntry>,
): Promise<{ checkpointsCount: number; filesTouched: string[]; tokenUsage: TokenUsage | null }> {
	let totalCount = 0;
	let allFiles: string[] = [];
	let totalTokens: TokenUsage | null = null;
	for (let i = 0; i < sessionCount; i++) {
		const metaPath = `${basePath}${i}/${METADATA_FILE_NAME}`;
		const entry = entries.get(metaPath);
		if (entry === undefined) {
			continue;
		}
		const meta = await readJsonFromBlob<CommittedMetadata>(repoDir, entry.hash);
		totalCount += meta.checkpointsCount ?? 0;
		allFiles = mergeFilesTouched(allFiles, meta.filesTouched ?? []);
		totalTokens = aggregateTokenUsage(totalTokens, meta.tokenUsage ?? null);
	}
	return { checkpointsCount: totalCount, filesTouched: allFiles, tokenUsage: totalTokens };
}

/**
 * Write `bytes`'s `sha256:` fingerprint as a single-line UTF-8 blob at
 * `fullPath`, registering the blob entry in `entries`. Used by both the v1
 * `full.jsonl` write path and the Phase 4.4 v2 `transcript.jsonl` /
 * `raw_transcript` write paths so the on-disk hash format stays identical.
 */
export async function writeContentHash(
	repoDir: string,
	bytes: Uint8Array,
	fullPath: string,
	entries: Map<string, TreeEntry>,
): Promise<void> {
	const contentHash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
	const blobHash = await createBlobFromContent(repoDir, new TextEncoder().encode(contentHash));
	entries.set(fullPath, { name: fullPath, mode: MODE_FILE, hash: blobHash, type: 'blob' });
}

async function writeTranscript(
	repoDir: string,
	opts: WriteCommittedOptions,
	sessionPath: string,
	entries: Map<string, TreeEntry>,
): Promise<boolean> {
	let transcriptBytes = opts.transcript;

	if (transcriptBytes.length === 0 && opts.transcriptPath !== '') {
		try {
			const raw = await fs.readFile(opts.transcriptPath);
			if (raw.length > 0) {
				const { bytes } = await redactJSONLBytes(new Uint8Array(raw));
				transcriptBytes = bytes;
			}
		} catch {
			// Non-fatal: transcript file may not exist yet.
		}
	}
	if (transcriptBytes.length === 0) {
		return false;
	}

	if (opts.agent === 'codex') {
		transcriptBytes = sanitizeCodexPortableTranscript(transcriptBytes);
	}

	const chunks = chunkBytes(transcriptBytes, MAX_CHUNK_SIZE);
	for (let i = 0; i < chunks.length; i++) {
		const chunkPath = sessionPath + chunkFileName(TRANSCRIPT_FILE_NAME, i);
		const blobHash = await createBlobFromContent(repoDir, chunks[i]!);
		entries.set(chunkPath, {
			name: chunkPath,
			mode: MODE_FILE,
			hash: blobHash,
			type: 'blob',
		});
	}

	await writeContentHash(repoDir, transcriptBytes, sessionPath + CONTENT_HASH_FILE_NAME, entries);
	return true;
}

/**
 * Replace the transcript files in `entries` (under `sessionPath`) with the
 * chunked output from `@/agent/chunking.chunkTranscript(transcript, agentType)`.
 * Removes any pre-existing base + chunk files first; updates the contentHash
 * blob to match the new transcript bytes.
 *
 * Phase 6.1 wires per-agent chunker via the agent registry — agents with
 * non-JSONL formats get format-aware chunking; unknown agents fall through
 * to JSONL `\n`-boundary splitting.
 *
 * Mirrors Go `committed.go:1357-1401` (`(*GitStore).replaceTranscript`).
 *
 * @example
 * ```ts
 * const entries = new Map<string, TreeEntry>([
 *   [`${sessionPath}full.jsonl`, { ... }],
 *   [`${sessionPath}full.jsonl.001`, { ... }],
 * ]);
 * await replaceTranscript(repoDir, newBytes, 'Claude Code', sessionPath, entries);
 * // returns: void
 * //
 * // Side effects:
 * //   .git/objects/...                          ← N transcript blobs (one per chunk)
 * //   .git/objects/...                          ← contentHash blob (sha256 hex)
 * //   entries map mutated:
 * //     - delete: <sessionPath>full.jsonl + any <sessionPath>full.jsonl.NNN
 * //     - add: <sessionPath>full.jsonl + .001 / .002 / ... (per chunkFileName)
 * //     - set: <sessionPath>content_hash.txt (via writeContentHash)
 * //
 * // Disk / refs / HEAD: unchanged. Caller writes the updated tree later.
 * ```
 */
async function replaceTranscript(
	repoDir: string,
	transcript: Uint8Array,
	agentType: string,
	sessionPath: string,
	entries: Map<string, TreeEntry>,
): Promise<void> {
	const transcriptBase = sessionPath + TRANSCRIPT_FILE_NAME;
	for (const key of [...entries.keys()]) {
		if (key === transcriptBase || key.startsWith(`${transcriptBase}.`)) {
			entries.delete(key);
		}
	}

	// Phase 6.1: dispatch via @/agent/chunking — known agents chunk in their
	// native format; unknown agents fall back to JSONL byte-boundary split.
	const chunks = await agentChunkTranscript(transcript, agentType);
	for (let i = 0; i < chunks.length; i++) {
		const chunkPath = sessionPath + chunkFileName(TRANSCRIPT_FILE_NAME, i);
		const blobHash = await createBlobFromContent(repoDir, chunks[i]!);
		entries.set(chunkPath, {
			name: chunkPath,
			mode: MODE_FILE,
			hash: blobHash,
			type: 'blob',
		});
	}

	await writeContentHash(repoDir, transcript, sessionPath + CONTENT_HASH_FILE_NAME, entries);
}

/**
 * Walk `metadataDir` recursively and copy every regular file into the
 * checkpoint tree at `basePath/<rel>`. Skips symlinks (lstat-first to avoid
 * following them) and rejects `..`-traversal.
 */
async function copyMetadataDir(
	repoDir: string,
	metadataDir: string,
	basePath: string,
	entries: Map<string, TreeEntry>,
): Promise<void> {
	let rootStat: import('node:fs').Stats;
	try {
		rootStat = await fs.lstat(metadataDir);
	} catch {
		return;
	}
	if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
		return;
	}

	async function walk(currentAbs: string): Promise<void> {
		const dirEntries = await fs.readdir(currentAbs);
		for (const name of dirEntries) {
			const childAbs = path.join(currentAbs, name);
			const linfo = await fs.lstat(childAbs);
			if (linfo.isSymbolicLink()) {
				continue;
			}
			if (linfo.isDirectory()) {
				await walk(childAbs);
				continue;
			}
			if (!linfo.isFile()) {
				continue;
			}
			const relWithin = path.relative(metadataDir, childAbs);
			if (relWithin.startsWith('..')) {
				throw new Error(`path traversal detected: ${relWithin}`);
			}
			const treeRel = relWithin.split(path.sep).join('/');
			const fullPath = basePath + treeRel;
			const { hash, mode } = await createRedactedBlobFromFile(repoDir, childAbs, treeRel);
			entries.set(fullPath, { name: fullPath, mode, hash, type: 'blob' });
		}
	}
	await walk(metadataDir);
}

/** Internal: task / incremental write paths */

async function writeTaskCheckpointEntries(
	repoDir: string,
	opts: WriteCommittedOptions,
	basePath: string,
	entries: Map<string, TreeEntry>,
): Promise<string> {
	const taskPath = `${basePath}tasks/${opts.toolUseId}/`;
	if (opts.isIncremental) {
		return writeIncrementalTaskCheckpoint(repoDir, opts, taskPath, entries);
	}
	return writeFinalTaskCheckpoint(repoDir, opts, taskPath, entries);
}

async function writeIncrementalTaskCheckpoint(
	repoDir: string,
	opts: WriteCommittedOptions,
	taskPath: string,
	entries: Map<string, TreeEntry>,
): Promise<string> {
	const { bytes: redactedData } = await redactJSONLBytes(opts.incrementalData);
	let parsedData: unknown = null;
	const text = new TextDecoder().decode(redactedData);
	if (text.trim() !== '') {
		try {
			parsedData = JSON.parse(text);
		} catch {
			parsedData = text;
		}
	}
	const payload = {
		type: opts.incrementalType,
		tool_use_id: opts.toolUseId,
		timestamp: new Date().toISOString(),
		data: parsedData,
	};
	const cpJson = `${JSON.stringify(payload, null, 2)}\n`;
	const blobHash = await createBlobFromContent(repoDir, new TextEncoder().encode(cpJson));
	const cpFilename = `${String(opts.incrementalSequence).padStart(3, '0')}-${opts.toolUseId}.json`;
	const cpPath = `${taskPath}checkpoints/${cpFilename}`;
	entries.set(cpPath, { name: cpPath, mode: MODE_FILE, hash: blobHash, type: 'blob' });
	return cpPath;
}

async function writeFinalTaskCheckpoint(
	repoDir: string,
	opts: WriteCommittedOptions,
	taskPath: string,
	entries: Map<string, TreeEntry>,
): Promise<string> {
	const summary = {
		session_id: opts.sessionId,
		tool_use_id: opts.toolUseId,
		checkpoint_uuid: opts.checkpointUuid,
		agent_id: opts.agentId,
	};
	const cpJson = `${JSON.stringify(summary, null, 2)}\n`;
	const blobHash = await createBlobFromContent(repoDir, new TextEncoder().encode(cpJson));
	const cpFile = `${taskPath}checkpoint.json`;
	entries.set(cpFile, { name: cpFile, mode: MODE_FILE, hash: blobHash, type: 'blob' });

	if (opts.subagentTranscriptPath !== '' && opts.agentId !== '') {
		try {
			const raw = new Uint8Array(await fs.readFile(opts.subagentTranscriptPath));
			const { bytes: redacted } = await redactJSONLBytes(raw);
			const subBlob = await createBlobFromContent(repoDir, redacted);
			const aFilename = `agent-${opts.agentId}.jsonl`;
			const aPath = taskPath + aFilename;
			entries.set(aPath, { name: aPath, mode: MODE_FILE, hash: subBlob, type: 'blob' });
		} catch (err) {
			warn({ component: 'checkpoint' }, 'failed to read subagent transcript, skipping', {
				agentId: opts.agentId,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	// Strip the trailing slash to match Go's return value.
	return taskPath.slice(0, -1);
}

/** Internal: aggregation + redaction helpers */

export function mergeFilesTouched(existing: string[], additional: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const f of existing) {
		const normalized = f.split(path.sep).join('/');
		if (!seen.has(normalized)) {
			seen.add(normalized);
			out.push(normalized);
		}
	}
	for (const f of additional) {
		const normalized = f.split(path.sep).join('/');
		if (!seen.has(normalized)) {
			seen.add(normalized);
			out.push(normalized);
		}
	}
	out.sort();
	return out;
}

export function aggregateTokenUsage(a: TokenUsage | null, b: TokenUsage | null): TokenUsage | null {
	if (a === null && b === null) {
		return null;
	}
	const result: TokenUsage = {
		inputTokens: 0,
		cacheCreationTokens: 0,
		cacheReadTokens: 0,
		outputTokens: 0,
		apiCallCount: 0,
	};
	if (a !== null) {
		result.inputTokens += a.inputTokens;
		result.cacheCreationTokens += a.cacheCreationTokens;
		result.cacheReadTokens += a.cacheReadTokens;
		result.outputTokens += a.outputTokens;
		result.apiCallCount += a.apiCallCount;
	}
	if (b !== null) {
		result.inputTokens += b.inputTokens;
		result.cacheCreationTokens += b.cacheCreationTokens;
		result.cacheReadTokens += b.cacheReadTokens;
		result.outputTokens += b.outputTokens;
		result.apiCallCount += b.apiCallCount;
	}
	return result;
}

/**
 * Redact every text field of a {@link Summary}, preserving structural
 * fields (paths, line numbers). Mirrors Go's `redactSummary`.
 *
 * Async because `redactString` runs `@secretlint/core` (async). Every text
 * field in the summary is fed through `redactString` independently — the
 * caller awaits the assembled `Summary` before persisting.
 */
export async function redactSummary(s: Summary | null | undefined): Promise<Summary | null> {
	if (s === null || s === undefined) {
		return null;
	}
	const [intent, outcome, friction, openItems, repo, workflow, code] = await Promise.all([
		redactString(s.intent),
		redactString(s.outcome),
		redactStringSlice(s.friction),
		redactStringSlice(s.openItems),
		redactStringSlice(s.learnings.repo),
		redactStringSlice(s.learnings.workflow),
		Promise.all(
			s.learnings.code.map(async (cl) => ({
				path: cl.path,
				line: cl.line,
				endLine: cl.endLine,
				finding: await redactString(cl.finding),
			})),
		),
	]);
	return {
		intent,
		outcome,
		friction,
		openItems,
		learnings: { repo, workflow, code },
	};
}

async function redactStringSlice(ss: string[]): Promise<string[]> {
	return Promise.all(ss.map((s) => redactString(s)));
}

function buildCommitMessage(opts: WriteCommittedOptions, taskMetadataPath: string): string {
	let msg = `Checkpoint: ${opts.checkpointId}\n\n`;
	if (opts.commitSubject !== '') {
		msg += `${opts.commitSubject}\n\n`;
	}
	msg += `${SESSION_TRAILER_KEY}: ${opts.sessionId}\n`;
	msg += `${STRATEGY_TRAILER_KEY}: ${opts.strategy}\n`;
	if (opts.agent !== '') {
		msg += `${AGENT_TRAILER_KEY}: ${opts.agent}\n`;
	}
	if (opts.ephemeralBranch !== '') {
		msg += `${EPHEMERAL_BRANCH_TRAILER_KEY}: ${opts.ephemeralBranch}\n`;
	}
	if (taskMetadataPath !== '') {
		msg += `${METADATA_TASK_TRAILER_KEY}: ${taskMetadataPath}\n`;
	}
	return msg;
}

/** Internal: blob JSON helpers */

/**
 * Read a JSON blob from the repo's object store and parse it as `T`.
 *
 * Goes through {@link parseMetadataJSON} so on-disk snake_case keys
 * (Go-written or post-Phase-4.5 TS-written) get converted back to
 * camelCase TS shape; legacy camelCase data passes through unchanged.
 */
export async function readJsonFromBlob<T>(repoDir: string, hash: string): Promise<T> {
	const { blob } = await git.readBlob({ fs: fsCallback, dir: repoDir, oid: hash });
	const text = new TextDecoder().decode(blob);
	return parseMetadataJSON<T>(text);
}

/** Internal: tree access for read paths */

async function getFetchingTree(
	repoDir: string,
	fetcher?: BlobFetchFunc,
): Promise<FetchingTree | null> {
	const treeHash = await getSessionsBranchTree(repoDir);
	if (treeHash === null) {
		return null;
	}
	return FetchingTree.create(repoDir, treeHash, fetcher);
}

async function getSessionsBranchTree(repoDir: string): Promise<string | null> {
	for (const ref of [
		`refs/heads/${METADATA_BRANCH_NAME}`,
		`refs/remotes/origin/${METADATA_BRANCH_NAME}`,
	]) {
		try {
			const oid = await git.resolveRef({ fs: fsCallback, dir: repoDir, ref });
			const { commit } = await git.readCommit({ fs: fsCallback, dir: repoDir, oid });
			return commit.tree;
		} catch {
			// Try next ref.
		}
	}
	return null;
}

/** Internal: transcript reassembly + chunking */

async function readTranscriptFromTree(
	tree: FetchingTree,
	_agentType: string,
): Promise<Uint8Array | null> {
	const entries = await tree.rawEntries();

	const chunkFiles: string[] = [];
	let hasBaseFile = false;
	for (const e of entries) {
		if (e.type !== 'blob') {
			continue;
		}
		if (e.path === TRANSCRIPT_FILE_NAME || e.path === TRANSCRIPT_FILE_NAME_LEGACY) {
			hasBaseFile = true;
		}
		if (e.path.startsWith(`${TRANSCRIPT_FILE_NAME}.`)) {
			const idx = parseChunkIndex(e.path, TRANSCRIPT_FILE_NAME);
			if (idx > 0) {
				chunkFiles.push(e.path);
			}
		}
	}

	if (chunkFiles.length > 0) {
		let ordered = sortChunkFiles(chunkFiles, TRANSCRIPT_FILE_NAME);
		if (hasBaseFile) {
			ordered = [TRANSCRIPT_FILE_NAME, ...ordered];
		}
		const parts: Uint8Array[] = [];
		for (const name of ordered) {
			const bytes = await tree.file(name);
			if (bytes !== null) {
				parts.push(bytes);
			}
		}
		if (parts.length === 0) {
			return null;
		}
		return concatBytes(parts);
	}

	const base = await tree.file(TRANSCRIPT_FILE_NAME);
	if (base !== null) {
		return base;
	}
	const legacy = await tree.file(TRANSCRIPT_FILE_NAME_LEGACY);
	return legacy;
}

export function chunkBytes(data: Uint8Array, maxSize: number): Uint8Array[] {
	if (data.length === 0) {
		return [];
	}
	if (data.length <= maxSize) {
		return [data];
	}
	// JSONL fallback: split at newline boundaries so individual JSON objects
	// stay intact. Mirrors Go `ChunkJSONL` (the default branch of
	// `agent.ChunkTranscript` when no agent-specific chunker is registered).
	const text = new TextDecoder().decode(data);
	const lines = text.split('\n');
	const chunks: Uint8Array[] = [];
	let current = '';
	const enc = new TextEncoder();
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const lineWithNL = `${line}\n`;
		const lineLen = enc.encode(lineWithNL).length;
		if (lineLen > maxSize) {
			throw new Error(
				`JSONL line ${i + 1} exceeds maximum chunk size (${lineLen} bytes > ${maxSize} bytes); cannot split a single JSON object`,
			);
		}
		const currentLen = enc.encode(current).length;
		if (currentLen + lineLen > maxSize && currentLen > 0) {
			chunks.push(enc.encode(current.replace(/\n$/, '')));
			current = '';
		}
		current += lineWithNL;
	}
	if (current.length > 0) {
		chunks.push(enc.encode(current.replace(/\n$/, '')));
	}
	return chunks;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
	let total = 0;
	for (const p of parts) {
		total += p.length;
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const p of parts) {
		out.set(p, offset);
		offset += p.length;
	}
	return out;
}

/** Codex sanitization (minimal port — full agent registry lands in Phase 6.x) */

interface CodexRolloutLine {
	type?: string;
	payload?: unknown;
	[k: string]: unknown;
}

/**
 * Drop encrypted Codex `reasoning` payloads and remove `compaction*` lines
 * outright. Mirrors Go's `agent/codex.SanitizePortableTranscript` for the
 * subset that Phase 4.3 needs (test #13). Phase 6.x will move this into the
 * codex agent module proper.
 */
function sanitizeCodexPortableTranscript(data: Uint8Array): Uint8Array {
	const text = new TextDecoder().decode(data);
	const lines = text.split('\n');
	const out: string[] = [];
	let mutated = false;
	for (const raw of lines) {
		if (raw === '') {
			out.push(raw);
			continue;
		}
		let parsed: CodexRolloutLine;
		try {
			parsed = JSON.parse(raw) as CodexRolloutLine;
		} catch {
			out.push(raw);
			continue;
		}
		if (parsed.type === 'compacted') {
			mutated = true;
			// Best-effort: keep the compacted summary line as-is for now —
			// the full sanitiser is in Phase 6.x.
			out.push(raw);
			continue;
		}
		if (parsed.type !== 'response_item') {
			out.push(raw);
			continue;
		}
		const payload = parsed.payload;
		if (payload === null || typeof payload !== 'object') {
			out.push(raw);
			continue;
		}
		const payloadObj = payload as Record<string, unknown>;
		const itemType = payloadObj.type;
		if (typeof itemType !== 'string') {
			out.push(raw);
			continue;
		}
		if (itemType === 'reasoning') {
			delete payloadObj.encrypted_content;
			parsed.payload = payloadObj;
			out.push(JSON.stringify(parsed));
			mutated = true;
			continue;
		}
		if (itemType === 'compaction' || itemType === 'compaction_summary') {
			mutated = true;
			continue;
		}
		out.push(raw);
	}
	if (!mutated) {
		return data;
	}
	return new TextEncoder().encode(out.join('\n'));
}

/** Internal: git author resolution */

interface GitAuthorTriple {
	name: string;
	email: string;
}

/**
 * Resolve the git author for commits Story creates on the metadata branch.
 *
 * Order: local (`<repo>/.git/config`) → global (`~/.gitconfig`) → defaults
 * (`Unknown` / `unknown@local`). Matches Go's `GetGitAuthorFromRepo`.
 */
export async function getGitAuthorFromRepo(repoDir: string): Promise<GitAuthorTriple> {
	let name = '';
	let email = '';

	try {
		const localName = await execGit(['config', '--local', 'user.name'], { cwd: repoDir });
		name = localName.trim();
	} catch {
		// missing — fall through to global
	}
	try {
		const localEmail = await execGit(['config', '--local', 'user.email'], { cwd: repoDir });
		email = localEmail.trim();
	} catch {
		// missing — fall through to global
	}

	if (name === '' || email === '') {
		try {
			const globalName = await runGitConfigGlobal(['--global', 'user.name']);
			if (name === '' && globalName !== null) {
				name = globalName;
			}
		} catch {
			// ignore
		}
		try {
			const globalEmail = await runGitConfigGlobal(['--global', 'user.email']);
			if (email === '' && globalEmail !== null) {
				email = globalEmail;
			}
		} catch {
			// ignore
		}
	}

	if (name === '') {
		name = 'Unknown';
	}
	if (email === '') {
		email = 'unknown@local';
	}
	return { name, email };
}

/**
 * Run `git config <args>` and return the trimmed stdout, or `null` if the
 * config key is absent / git is unavailable. Used for the global-config
 * fallback in {@link getGitAuthorFromRepo}.
 */
async function runGitConfigGlobal(args: string[]): Promise<string | null> {
	try {
		const result = await execa('git', ['config', ...args], { reject: false });
		if (result.exitCode !== 0) {
			return null;
		}
		return String(result.stdout).trim();
	} catch {
		return null;
	}
}

/**
 * Sentinel re-export for callers that already use `ErrNoTranscript` from
 * the temporary module — keep the same identity so `instanceof` works
 * across both checkpoint paths.
 */

import { ErrNoTranscript } from './temporary';

export { ErrNoTranscript };
