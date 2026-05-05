/**
 * v2 read helpers — `/main` for metadata + compact transcript, `/full/*`
 * for raw transcripts.
 *
 * The split layout means most reads touch two refs:
 *
 * - `readCommitted` / `listCommitted` / `readSessionMetadataAndPrompts`
 *   only consult `/main`.
 * - `readSessionContent` (and its convenience wrappers `getTranscript` /
 *   `getSessionLog`) read metadata from `/main` and then walk the
 *   `/full/*` family — `/full/current` first, then archived
 *   `/full/<seq>` refs in descending order, then a one-shot remote fetch
 *   of `/full/*` refs the local repo doesn't yet have.
 *
 * Read failures are deliberately quiet: a missing tree / blob returns
 * `null` (or {@link ErrCheckpointNotFound} / {@link ErrNoTranscript}
 * sentinels for the "obvious" missing-data cases) so the v1/v2
 * fallback resolver can keep trying v1 without crashing.
 *
 * Go reference: `entire-cli/cmd/entire/cli/checkpoint/v2_read.go`.
 */

import fsCallback from 'node:fs';
import git from 'isomorphic-git';
import { normalize } from '../agent/types';
import { execGit } from '../git';
import { type CheckpointID, toPath as toCheckpointPath } from '../id';
import { parseMetadataJSON } from '../jsonutil';
import { debug } from '../log';
import { parseChunkIndex, sortChunkFiles } from './chunks';
import { ErrCheckpointNotFound, ErrNoTranscript } from './committed';
import {
	COMPACT_TRANSCRIPT_FILE_NAME,
	METADATA_FILE_NAME,
	PROMPT_FILE_NAME,
	V2_FULL_CURRENT_REF_NAME,
	V2_FULL_REF_PREFIX,
	V2_MAIN_REF_NAME,
	V2_RAW_TRANSCRIPT_FILE_NAME,
} from './constants';
import type {
	CheckpointAuthor,
	CheckpointSummary,
	CommittedInfo,
	CommittedMetadata,
	SessionContent,
} from './types';
import { listArchivedGenerations } from './v2-generation';
import type { V2GitStore } from './v2-store';

const EMPTY_METADATA: CommittedMetadata = {
	checkpointId: '',
	sessionId: '',
	strategy: '',
	createdAt: '',
	checkpointsCount: 0,
	filesTouched: [],
	model: '',
};

/**
 * Read the root `CheckpointSummary` from `/main`. Returns `null` for any
 * "missing" condition (ref absent, tree unreadable, JSON parse failure)
 * so the resolver can fall back to v1 silently.
 *
 * @example
 * ```ts
 * const summary = await readCommitted(store, 'a3b2c4d5e6f7');
 * // summary === {
 * //   checkpointId: 'a3b2c4d5e6f7',
 * //   strategy: 'manual-commit',
 * //   sessions: [{ metadata: '/0/metadata.json',
 * //                transcript: '/0/transcript.jsonl',  // compact, on /main
 * //                contentHash: '/0/transcript_hash.txt' }],
 * //   ...
 * // }
 *
 * // Missing checkpoint OR uninitialised /main → null (no throw).
 * await readCommitted(store, 'deadbeefcafe');  // → null
 * ```
 */
export async function readCommitted(
	store: V2GitStore,
	checkpointId: string,
): Promise<CheckpointSummary | null> {
	let rootTreeHash: string;
	try {
		rootTreeHash = (await store.getRefState(V2_MAIN_REF_NAME)).treeHash;
	} catch {
		return null;
	}
	const cpPath = toCheckpointPath(checkpointId as CheckpointID);
	let summaryHash: string;
	try {
		summaryHash = await resolveTreeFile(
			store.repoDir,
			rootTreeHash,
			`${cpPath}/${METADATA_FILE_NAME}`,
		);
	} catch {
		return null;
	}
	if (summaryHash === '') {
		return null;
	}
	let blob: Uint8Array;
	try {
		blob = (await git.readBlob({ fs: fsCallback, dir: store.repoDir, oid: summaryHash })).blob;
	} catch {
		return null;
	}
	try {
		return parseMetadataJSON<CheckpointSummary>(new TextDecoder().decode(blob));
	} catch {
		return null;
	}
}

/**
 * List every committed checkpoint by walking `/main`'s sharded tree.
 * Sort order matches v1: most recent `createdAt` first.
 *
 * @example
 * ```ts
 * const list = await listCommitted(store);
 * // list === [
 * //   { checkpointId: 'bbbbbbbbbbbb', sessionId: 'sess-2',
 * //     createdAt: '2026-04-18T...', sessionCount: 1, agent: 'claudecode',
 * //     filesTouched: ['src/login.ts'], ... },
 * //   { checkpointId: 'aaaaaaaaaaaa', sessionId: 'sess-1', ... },
 * // ]
 * //
 * // Empty / uninitialised /main → []  (no throw)
 * ```
 */
export async function listCommitted(store: V2GitStore): Promise<CommittedInfo[]> {
	let rootTreeHash: string;
	try {
		rootTreeHash = (await store.getRefState(V2_MAIN_REF_NAME)).treeHash;
	} catch {
		return [];
	}
	let root: Awaited<ReturnType<typeof git.readTree>>;
	try {
		root = await git.readTree({ fs: fsCallback, dir: store.repoDir, oid: rootTreeHash });
	} catch {
		return [];
	}

	const out: CommittedInfo[] = [];
	for (const bucket of root.tree) {
		if (bucket.type !== 'tree' || bucket.path.length !== 2 || !/^[0-9a-f]{2}$/.test(bucket.path)) {
			continue;
		}
		let inner: Awaited<ReturnType<typeof git.readTree>>;
		try {
			inner = await git.readTree({ fs: fsCallback, dir: store.repoDir, oid: bucket.oid });
		} catch {
			continue;
		}
		for (const cp of inner.tree) {
			if (cp.type !== 'tree' || cp.path.length !== 10 || !/^[0-9a-f]{10}$/.test(cp.path)) {
				continue;
			}
			const checkpointId = bucket.path + cp.path;
			const info = await readCommittedInfo(store, checkpointId, cp.oid);
			if (info !== null) {
				out.push(info);
			}
		}
	}
	out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	return out;
}

async function readCommittedInfo(
	store: V2GitStore,
	checkpointId: string,
	cpTreeHash: string,
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

	let cpTree: Awaited<ReturnType<typeof git.readTree>>;
	try {
		cpTree = await git.readTree({ fs: fsCallback, dir: store.repoDir, oid: cpTreeHash });
	} catch {
		return info;
	}
	const summaryEntry = cpTree.tree.find((e) => e.path === METADATA_FILE_NAME && e.type === 'blob');
	if (summaryEntry === undefined) {
		return info;
	}
	let summary: CheckpointSummary;
	try {
		const blob = (await git.readBlob({ fs: fsCallback, dir: store.repoDir, oid: summaryEntry.oid }))
			.blob;
		summary = parseMetadataJSON<CheckpointSummary>(new TextDecoder().decode(blob));
	} catch {
		return info;
	}
	info.checkpointsCount = summary.checkpointsCount;
	info.filesTouched = summary.filesTouched ?? [];
	info.sessionCount = summary.sessions.length;

	const sessionIds: string[] = [];
	for (let i = 0; i < summary.sessions.length; i++) {
		const sessionEntry = cpTree.tree.find((e) => e.path === String(i) && e.type === 'tree');
		if (sessionEntry === undefined) {
			continue;
		}
		let sessionTree: Awaited<ReturnType<typeof git.readTree>>;
		try {
			sessionTree = await git.readTree({
				fs: fsCallback,
				dir: store.repoDir,
				oid: sessionEntry.oid,
			});
		} catch {
			continue;
		}
		const metaEntry = sessionTree.tree.find(
			(e) => e.path === METADATA_FILE_NAME && e.type === 'blob',
		);
		if (metaEntry === undefined) {
			continue;
		}
		try {
			const blob = (await git.readBlob({ fs: fsCallback, dir: store.repoDir, oid: metaEntry.oid }))
				.blob;
			const meta = parseMetadataJSON<CommittedMetadata>(new TextDecoder().decode(blob));
			sessionIds.push(meta.sessionId);
			if (i === summary.sessions.length - 1) {
				info.agent = meta.agent ?? '';
				info.sessionId = meta.sessionId ?? '';
				info.createdAt = meta.createdAt ?? '';
				info.isTask = meta.isTask ?? false;
				info.toolUseId = meta.toolUseId ?? '';
			}
		} catch {
			// continue
		}
	}
	info.sessionIds = sessionIds;
	return info;
}

/**
 * Read the per-session metadata blob from `/main`. Returns `null` if the
 * session metadata file is missing (callers treat as "not found").
 */
export async function readSessionMetadata(
	store: V2GitStore,
	checkpointId: string,
	sessionIndex: number,
): Promise<CommittedMetadata | null> {
	let rootTreeHash: string;
	try {
		rootTreeHash = (await store.getRefState(V2_MAIN_REF_NAME)).treeHash;
	} catch {
		throw new ErrCheckpointNotFound(checkpointId);
	}
	const cpPath = toCheckpointPath(checkpointId as CheckpointID);
	const metaHash = await resolveTreeFile(
		store.repoDir,
		rootTreeHash,
		`${cpPath}/${sessionIndex}/${METADATA_FILE_NAME}`,
	);
	if (metaHash === '') {
		return null;
	}
	try {
		const blob = (await git.readBlob({ fs: fsCallback, dir: store.repoDir, oid: metaHash })).blob;
		return parseMetadataJSON<CommittedMetadata>(new TextDecoder().decode(blob));
	} catch {
		return null;
	}
}

/**
 * Read just the compact transcript blob (`transcript.jsonl`) from
 * `/main`. Throws {@link ErrCheckpointNotFound} when the checkpoint /
 * session is missing, {@link ErrNoTranscript} when the compact transcript
 * is absent or empty.
 *
 * Compact transcript is the redacted + summarised form on `/main` —
 * cheap to read for `story explain` UI; for resume / restoreLogsOnly
 * use {@link readSessionContent} which pulls the raw transcript from
 * `/full/*` instead.
 *
 * @example
 * ```ts
 * const compact = await readSessionCompactTranscript(store, 'a3b2c4d5e6f7', 0);
 * // compact === <Uint8Array of /main session 0's transcript.jsonl>
 *
 * // No compact transcript written for this session → ErrNoTranscript.
 * try { await readSessionCompactTranscript(store, 'a3b2c4d5e6f7', 1); }
 * catch (err) { /* err instanceof ErrNoTranscript *\/ }
 *
 * // Missing checkpoint → ErrCheckpointNotFound.
 * try { await readSessionCompactTranscript(store, 'deadbeefcafe', 0); }
 * catch (err) { /* err instanceof ErrCheckpointNotFound *\/ }
 * ```
 */
export async function readSessionCompactTranscript(
	store: V2GitStore,
	checkpointId: string,
	sessionIndex: number,
): Promise<Uint8Array | null> {
	let rootTreeHash: string;
	try {
		rootTreeHash = (await store.getRefState(V2_MAIN_REF_NAME)).treeHash;
	} catch {
		throw new ErrCheckpointNotFound(checkpointId);
	}
	const cpPath = toCheckpointPath(checkpointId as CheckpointID);
	let cpTreeHash: string;
	try {
		cpTreeHash = await resolveTreeDir(store.repoDir, rootTreeHash, cpPath);
	} catch {
		throw new ErrCheckpointNotFound(checkpointId);
	}
	let sessionTreeHash: string;
	try {
		sessionTreeHash = await resolveTreeDir(store.repoDir, cpTreeHash, String(sessionIndex));
	} catch {
		throw new ErrCheckpointNotFound(checkpointId);
	}
	const compactHash = await resolveTreeFile(
		store.repoDir,
		sessionTreeHash,
		COMPACT_TRANSCRIPT_FILE_NAME,
	);
	if (compactHash === '') {
		throw new ErrNoTranscript('compact transcript missing');
	}
	let blob: Uint8Array;
	try {
		blob = (await git.readBlob({ fs: fsCallback, dir: store.repoDir, oid: compactHash })).blob;
	} catch {
		throw new ErrNoTranscript('compact transcript unreadable');
	}
	if (blob.length === 0) {
		throw new ErrNoTranscript('compact transcript empty');
	}
	return blob;
}

/**
 * Read metadata + prompts + compact transcript from `/main` without
 * touching `/full/*`. Used by code paths (e.g. `story explain` summary
 * view) that can render the compact transcript directly and don't need
 * the raw bytes — saves a potential remote fetch for `/full/*` archives.
 *
 * @example
 * ```ts
 * const slim = await readSessionMetadataAndPrompts(store, 'a3b2c4d5e6f7', 0);
 * // slim === {
 * //   metadata: { sessionId: 'sess-1', agent: 'claudecode', ... },
 * //   transcript: <Uint8Array of compact transcript.jsonl, NOT raw>,
 * //   prompts: 'first prompt\n---\nsecond prompt',
 * // }
 *
 * // Missing checkpoint → ErrCheckpointNotFound.
 * ```
 */
export async function readSessionMetadataAndPrompts(
	store: V2GitStore,
	checkpointId: string,
	sessionIndex: number,
): Promise<SessionContent | null> {
	let rootTreeHash: string;
	try {
		rootTreeHash = (await store.getRefState(V2_MAIN_REF_NAME)).treeHash;
	} catch {
		throw new ErrCheckpointNotFound(checkpointId);
	}
	const cpPath = toCheckpointPath(checkpointId as CheckpointID);
	let cpTreeHash: string;
	try {
		cpTreeHash = await resolveTreeDir(store.repoDir, rootTreeHash, cpPath);
	} catch {
		throw new ErrCheckpointNotFound(checkpointId);
	}
	let sessionTreeHash: string;
	try {
		sessionTreeHash = await resolveTreeDir(store.repoDir, cpTreeHash, String(sessionIndex));
	} catch {
		throw new ErrCheckpointNotFound(checkpointId);
	}

	let metadata: CommittedMetadata = { ...EMPTY_METADATA };
	const metaHash = await resolveTreeFile(store.repoDir, sessionTreeHash, METADATA_FILE_NAME);
	if (metaHash !== '') {
		try {
			const blob = (await git.readBlob({ fs: fsCallback, dir: store.repoDir, oid: metaHash })).blob;
			metadata = parseMetadataJSON<CommittedMetadata>(new TextDecoder().decode(blob));
		} catch (err) {
			throw new Error(
				`failed to parse session metadata: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	let prompts = '';
	const promptHash = await resolveTreeFile(store.repoDir, sessionTreeHash, PROMPT_FILE_NAME);
	if (promptHash !== '') {
		try {
			const blob = (await git.readBlob({ fs: fsCallback, dir: store.repoDir, oid: promptHash }))
				.blob;
			prompts = new TextDecoder().decode(blob);
		} catch {
			// non-fatal — empty prompts string
		}
	}

	let transcript = new Uint8Array();
	const compactHash = await resolveTreeFile(
		store.repoDir,
		sessionTreeHash,
		COMPACT_TRANSCRIPT_FILE_NAME,
	);
	if (compactHash !== '') {
		try {
			const blob = (await git.readBlob({ fs: fsCallback, dir: store.repoDir, oid: compactHash }))
				.blob;
			if (blob.length > 0) {
				// `Uint8Array<ArrayBufferLike>` (from `readBlob`) → assignable to
				// `Uint8Array<ArrayBuffer>` (the local `transcript` type) requires
				// an explicit copy when targeting strict TS lib variants.
				transcript = new Uint8Array(blob);
			}
		} catch {
			// keep empty
		}
	}

	return { metadata, transcript, prompts };
}

/**
 * Full read for `resume` / `RestoreLogsOnly`: metadata + prompts from
 * `/main`, raw transcript from `/full/*` (with archive walk + remote
 * fetch fallback). Throws {@link ErrNoTranscript} when no raw transcript
 * is reachable.
 *
 * Raw-transcript lookup order (matches Go `v2_read.go:248-468`):
 *
 * 1. `/full/current` (active generation)
 * 2. Archived generations `/full/<seq>` in **descending** numeric order
 *    (newest archive first — recent checkpoints likely there)
 * 3. `git fetch <store.fetchRemote> /full/*` to discover archives the
 *    local repo doesn't have, then retry steps 1+2 on the new refs only
 *
 * @example
 * ```ts
 * const session = await readSessionContent(store, 'a3b2c4d5e6f7', 0);
 * // session === {
 * //   metadata: { sessionId: 'sess-1', agent: 'claudecode', ... },
 * //   transcript: <Uint8Array of RAW transcript reassembled from
 * //                /full/<active-or-archived>/0/raw_transcript[.NNN]>,
 * //   prompts: 'first prompt\n---',
 * // }
 *
 * // Checkpoint exists on /main but raw transcript not reachable
 * // (never written, archive ref missing locally + fetch failed):
 * try { await readSessionContent(store, 'a3b2c4d5e6f7', 0); }
 * catch (err) { /* err instanceof ErrNoTranscript *\/ }
 *
 * // Checkpoint missing entirely → ErrCheckpointNotFound.
 *
 * // After `git clone`, all /full/* refs are missing → readSessionContent
 * // auto-fetches via store.fetchRemote on the first call, then succeeds.
 * ```
 */
export async function readSessionContent(
	store: V2GitStore,
	checkpointId: string,
	sessionIndex: number,
): Promise<SessionContent | null> {
	let rootTreeHash: string;
	try {
		rootTreeHash = (await store.getRefState(V2_MAIN_REF_NAME)).treeHash;
	} catch {
		throw new ErrCheckpointNotFound(checkpointId);
	}
	const cpPath = toCheckpointPath(checkpointId as CheckpointID);
	let cpTreeHash: string;
	try {
		cpTreeHash = await resolveTreeDir(store.repoDir, rootTreeHash, cpPath);
	} catch {
		throw new ErrCheckpointNotFound(checkpointId);
	}
	let sessionTreeHash: string;
	try {
		sessionTreeHash = await resolveTreeDir(store.repoDir, cpTreeHash, String(sessionIndex));
	} catch (err) {
		throw new Error(
			`session ${sessionIndex} not found: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	let metadata: CommittedMetadata = { ...EMPTY_METADATA };
	const metaHash = await resolveTreeFile(store.repoDir, sessionTreeHash, METADATA_FILE_NAME);
	if (metaHash !== '') {
		try {
			const blob = (await git.readBlob({ fs: fsCallback, dir: store.repoDir, oid: metaHash })).blob;
			metadata = parseMetadataJSON<CommittedMetadata>(new TextDecoder().decode(blob));
		} catch (err) {
			throw new Error(
				`failed to parse session metadata: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	let prompts = '';
	const promptHash = await resolveTreeFile(store.repoDir, sessionTreeHash, PROMPT_FILE_NAME);
	if (promptHash !== '') {
		try {
			const blob = (await git.readBlob({ fs: fsCallback, dir: store.repoDir, oid: promptHash }))
				.blob;
			prompts = new TextDecoder().decode(blob);
		} catch {
			// empty
		}
	}

	// Normalize the on-disk metadata.agent to the strict AgentType union so
	// reassemble dispatch sees a known agent (or AGENT_TYPE_UNKNOWN). Mirrors
	// the committed.ts: readSessionContent + prompts.ts: readAgentTypeFromTree
	// pattern across the codebase.
	const transcript = await readTranscriptFromFullRefs(
		store,
		checkpointId,
		sessionIndex,
		metadata.agent ? normalize(metadata.agent) : '',
	);
	if (transcript === null || transcript.length === 0) {
		throw new ErrNoTranscript(`session ${sessionIndex} has no raw transcript`);
	}

	return { metadata, transcript, prompts };
}

/** Convenience: read the highest-index session's full content. */
export async function readLatestSessionContent(
	store: V2GitStore,
	checkpointId: string,
): Promise<SessionContent | null> {
	const summary = await readCommitted(store, checkpointId);
	if (summary === null) {
		throw new ErrCheckpointNotFound(checkpointId);
	}
	if (summary.sessions.length === 0) {
		throw new Error(`checkpoint has no sessions: ${checkpointId}`);
	}
	return readSessionContent(store, checkpointId, summary.sessions.length - 1);
}

/** Look up a session by `sessionId` (linear scan over sessions on `/main`). */
export async function readSessionContentById(
	store: V2GitStore,
	checkpointId: string,
	sessionId: string,
): Promise<SessionContent | null> {
	const summary = await readCommitted(store, checkpointId);
	if (summary === null) {
		throw new ErrCheckpointNotFound(checkpointId);
	}
	for (let i = 0; i < summary.sessions.length; i++) {
		try {
			const content = await readSessionContent(store, checkpointId, i);
			if (content !== null && content.metadata.sessionId === sessionId) {
				return content;
			}
		} catch {
			// keep scanning
		}
	}
	throw new Error(`session "${sessionId}" not found in checkpoint ${checkpointId}`);
}

/** Convenience: latest session's raw transcript bytes (or `null`). */
export async function getTranscript(
	store: V2GitStore,
	checkpointId: string,
): Promise<Uint8Array | null> {
	const content = await readLatestSessionContent(store, checkpointId);
	if (content === null) {
		return null;
	}
	if (content.transcript.length === 0) {
		throw new Error(`no transcript found for checkpoint: ${checkpointId}`);
	}
	return content.transcript;
}

/** Convenience: latest session's transcript + sessionId (or `null`). */
export async function getSessionLog(
	store: V2GitStore,
	checkpointId: string,
): Promise<{ transcript: Uint8Array; sessionId: string } | null> {
	const summary = await readCommitted(store, checkpointId);
	if (summary === null) {
		return null;
	}
	if (summary.sessions.length === 0) {
		return null;
	}
	const latestIndex = summary.sessions.length - 1;
	const content = await readSessionContent(store, checkpointId, latestIndex);
	if (content === null) {
		return null;
	}
	return { transcript: content.transcript, sessionId: content.metadata.sessionId };
}

/**
 * Locate the commit on `/main` whose subject is `Checkpoint: <id>` and
 * return its author. Returns `{ name: '', email: '' }` for missing
 * checkpoints (matches v1's contract — never throws).
 *
 * @example
 * ```ts
 * const author = await getCheckpointAuthor(store, 'a3b2c4d5e6f7');
 * // author === { name: 'Alice', email: 'alice@example.com' }
 *
 * await getCheckpointAuthor(store, 'deadbeefcafe');
 * // === { name: '', email: '' }   (no throw)
 * ```
 */
export async function getCheckpointAuthor(
	store: V2GitStore,
	checkpointId: string,
): Promise<CheckpointAuthor> {
	let tip: string;
	try {
		tip = await git.resolveRef({
			fs: fsCallback,
			dir: store.repoDir,
			ref: V2_MAIN_REF_NAME,
		});
	} catch {
		return { name: '', email: '' };
	}

	const target = `Checkpoint: ${checkpointId}`;
	let log: Awaited<ReturnType<typeof git.log>>;
	try {
		log = await git.log({ fs: fsCallback, dir: store.repoDir, ref: tip });
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

/** Internal: raw-transcript walking across /full/* refs */

/**
 * Walk `/full/current` first, then archived `/full/<seq>` in descending
 * order, looking for the raw transcript at `<cpPath>/<sessionIndex>/`.
 * Falls back to `git fetch <fetchRemote> +/full/*:/full/*` to discover
 * generations the local repo doesn't have. Returns `null` when nothing
 * yields bytes.
 */
async function readTranscriptFromFullRefs(
	store: V2GitStore,
	checkpointId: string,
	sessionIndex: number,
	_agentType: string,
): Promise<Uint8Array | null> {
	const cpPath = toCheckpointPath(checkpointId as CheckpointID);
	const sessionPath = `${cpPath}/${sessionIndex}`;

	const localCurrent = await readTranscriptFromRef(store, V2_FULL_CURRENT_REF_NAME, sessionPath);
	if (localCurrent !== null && localCurrent.length > 0) {
		return localCurrent;
	}

	const archived = await listArchivedGenerations(store);
	for (let i = archived.length - 1; i >= 0; i--) {
		const refName = V2_FULL_REF_PREFIX + archived[i];
		const result = await readTranscriptFromRef(store, refName, sessionPath);
		if (result !== null && result.length > 0) {
			return result;
		}
	}

	try {
		await fetchRemoteFullRefs(store);
	} catch (err) {
		debug({ component: 'checkpoint' }, 'failed to fetch remote /full/* refs', {
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}

	const post = await listArchivedGenerations(store);
	const seen = new Set(archived);
	for (let i = post.length - 1; i >= 0; i--) {
		if (seen.has(post[i]!)) {
			continue;
		}
		const refName = V2_FULL_REF_PREFIX + post[i];
		const result = await readTranscriptFromRef(store, refName, sessionPath);
		if (result !== null && result.length > 0) {
			return result;
		}
	}

	const retryCurrent = await readTranscriptFromRef(store, V2_FULL_CURRENT_REF_NAME, sessionPath);
	if (retryCurrent !== null && retryCurrent.length > 0) {
		return retryCurrent;
	}
	return null;
}

async function readTranscriptFromRef(
	store: V2GitStore,
	refName: string,
	sessionPath: string,
): Promise<Uint8Array | null> {
	let rootTreeHash: string;
	try {
		rootTreeHash = (await store.getRefState(refName)).treeHash;
	} catch {
		return null;
	}
	let sessionTreeHash: string;
	try {
		sessionTreeHash = await resolveTreeDir(store.repoDir, rootTreeHash, sessionPath);
	} catch {
		return null;
	}
	return readTranscriptFromObjectTree(store, sessionTreeHash);
}

async function readTranscriptFromObjectTree(
	store: V2GitStore,
	sessionTreeHash: string,
): Promise<Uint8Array | null> {
	let tree: Awaited<ReturnType<typeof git.readTree>>;
	try {
		tree = await git.readTree({ fs: fsCallback, dir: store.repoDir, oid: sessionTreeHash });
	} catch {
		return null;
	}

	const chunkFiles: string[] = [];
	let hasBaseFile = false;
	for (const entry of tree.tree) {
		if (entry.type !== 'blob') {
			continue;
		}
		if (entry.path === V2_RAW_TRANSCRIPT_FILE_NAME) {
			hasBaseFile = true;
		}
		if (entry.path.startsWith(`${V2_RAW_TRANSCRIPT_FILE_NAME}.`)) {
			const idx = parseChunkIndex(entry.path, V2_RAW_TRANSCRIPT_FILE_NAME);
			if (idx > 0) {
				chunkFiles.push(entry.path);
			}
		}
	}

	if (chunkFiles.length > 0) {
		let ordered = sortChunkFiles(chunkFiles, V2_RAW_TRANSCRIPT_FILE_NAME);
		if (hasBaseFile) {
			ordered = [V2_RAW_TRANSCRIPT_FILE_NAME, ...ordered];
		}
		const parts: Uint8Array[] = [];
		for (const name of ordered) {
			const entry = tree.tree.find((e) => e.path === name && e.type === 'blob');
			if (entry === undefined) {
				continue;
			}
			try {
				const blob = (await git.readBlob({ fs: fsCallback, dir: store.repoDir, oid: entry.oid }))
					.blob;
				parts.push(blob);
			} catch {
				// skip
			}
		}
		if (parts.length === 0) {
			return null;
		}
		return concatBytes(parts);
	}

	if (hasBaseFile) {
		const entry = tree.tree.find(
			(e) => e.path === V2_RAW_TRANSCRIPT_FILE_NAME && e.type === 'blob',
		);
		if (entry !== undefined) {
			try {
				return (await git.readBlob({ fs: fsCallback, dir: store.repoDir, oid: entry.oid })).blob;
			} catch {
				return null;
			}
		}
	}
	return null;
}

/**
 * Discover and fetch every `/full/*` ref present on `store.fetchRemote`
 * but missing locally. Skips refs that already exist locally (cheap
 * `git ls-remote` filter). Errors propagate so the caller can demote
 * them to debug logs.
 */
async function fetchRemoteFullRefs(store: V2GitStore): Promise<void> {
	const lsRemoteOut = await execGit(['ls-remote', store.fetchRemote, `${V2_FULL_REF_PREFIX}*`], {
		cwd: store.repoDir,
	});
	const refSpecs: string[] = [];
	for (const line of lsRemoteOut.trim().split('\n')) {
		if (line === '') {
			continue;
		}
		const parts = line.split(/\s+/);
		if (parts.length < 2) {
			continue;
		}
		const remoteRef = parts[1]!;
		try {
			await git.resolveRef({ fs: fsCallback, dir: store.repoDir, ref: remoteRef });
			continue; // already local
		} catch {
			// missing — fetch it
		}
		refSpecs.push(`+${remoteRef}:${remoteRef}`);
	}
	if (refSpecs.length === 0) {
		return;
	}
	await execGit(['fetch', '--no-tags', store.fetchRemote, ...refSpecs], {
		cwd: store.repoDir,
	});
}

/** Internal: low-level tree-path resolution */

/**
 * Walk `treeHash` along `subpath` (slash-joined) and return the leaf
 * blob's object hash. Returns `''` when any segment is missing or the
 * leaf isn't a blob.
 */
async function resolveTreeFile(
	repoDir: string,
	treeHash: string,
	subpath: string,
): Promise<string> {
	const parts = subpath.split('/').filter((s) => s !== '');
	if (parts.length === 0) {
		return '';
	}
	let current = treeHash;
	for (let i = 0; i < parts.length - 1; i++) {
		const seg = parts[i]!;
		let entries: Awaited<ReturnType<typeof git.readTree>>;
		try {
			entries = await git.readTree({ fs: fsCallback, dir: repoDir, oid: current });
		} catch {
			return '';
		}
		const child = entries.tree.find((e) => e.path === seg && e.type === 'tree');
		if (child === undefined) {
			return '';
		}
		current = child.oid;
	}
	let entries: Awaited<ReturnType<typeof git.readTree>>;
	try {
		entries = await git.readTree({ fs: fsCallback, dir: repoDir, oid: current });
	} catch {
		return '';
	}
	const last = parts[parts.length - 1]!;
	const found = entries.tree.find((e) => e.path === last && e.type === 'blob');
	if (found === undefined) {
		return '';
	}
	return found.oid;
}

/**
 * Walk `treeHash` along `subpath` and return the directory's tree hash.
 * Throws if any segment is missing or the leaf isn't a tree.
 */
async function resolveTreeDir(repoDir: string, treeHash: string, subpath: string): Promise<string> {
	if (subpath === '') {
		return treeHash;
	}
	const parts = subpath.split('/').filter((s) => s !== '');
	let current = treeHash;
	for (const seg of parts) {
		const entries = await git.readTree({ fs: fsCallback, dir: repoDir, oid: current });
		const child = entries.tree.find((e) => e.path === seg && e.type === 'tree');
		if (child === undefined) {
			throw new Error(`tree path ${subpath} not found`);
		}
		current = child.oid;
	}
	return current;
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
