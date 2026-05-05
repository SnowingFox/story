/**
 * v2 dual-write helpers (`/main` + `/full/current`).
 *
 * v1 ([`committed.ts`](./committed.ts)) keeps every checkpoint —
 * metadata + raw transcript — on a single permanent orphan branch. v2
 * splits the storage:
 *
 * - `/main` carries permanent **metadata + compact transcript +
 *   prompts**. It grows slowly and is always pushed / fetched.
 * - `/full/current` carries the **raw transcript** for recent
 *   checkpoints. It auto-rotates into archived `/full/<seq>` refs once
 *   it grows past {@link DEFAULT_MAX_CHECKPOINTS_PER_GENERATION}.
 *
 * Most of the tree-surgery primitives (`flattenCheckpointEntries`,
 * `spliceCheckpointSubtree`, `findSessionIndex`, `writeCheckpointSummary`,
 * etc.) are reused from v1's [`committed.ts`](./committed.ts) to keep the
 * on-disk shape identical to v1 wherever the layout overlaps.
 *
 * Method shape (writeCommitted / updateCommitted / updateSummary) and
 * dual-write semantics (best-effort `/full/current` after mandatory
 * `/main`) match Go upstream.
 *
 * Go reference: `entire-cli/cmd/entire/cli/checkpoint/v2_committed.go`.
 */

import fs from 'node:fs/promises';
import { type CheckpointID, toPath as toCheckpointPath } from '../id';
import { serializeMetadataJSON } from '../jsonutil';
import { warn } from '../log';
import { redactJSONLBytes, redactString } from '../redact';
import { validateAgentID, validateSessionId, validateToolUseID } from '../validation';
import { chunkFileName } from './chunks';
import {
	chunkBytes,
	ErrCheckpointNotFound,
	findSessionIndex,
	flattenCheckpointEntries,
	getGitAuthorFromRepo,
	readJsonFromBlob,
	redactSummary,
	spliceCheckpointSubtree,
	writeCheckpointSummary,
	writeContentHash,
} from './committed';
import {
	COMPACT_TRANSCRIPT_FILE_NAME,
	COMPACT_TRANSCRIPT_HASH_FILE_NAME,
	MAX_CHUNK_SIZE,
	METADATA_FILE_NAME,
	PROMPT_FILE_NAME,
	V2_FULL_CURRENT_REF_NAME,
	V2_MAIN_REF_NAME,
	V2_RAW_TRANSCRIPT_FILE_NAME,
	V2_RAW_TRANSCRIPT_HASH_FILE_NAME,
} from './constants';
import { createBlobFromContent } from './git-objects';
import { joinPrompts } from './prompts';
import { MODE_FILE, type TreeEntry } from './tree-ops';
import type {
	CheckpointSummary,
	CommittedMetadata,
	InitialAttribution,
	SessionFilePaths,
	Summary,
	UpdateCommittedOptions,
	WriteCommittedOptions,
} from './types';
import { countCheckpointsInTree, rotateGeneration } from './v2-generation';
import type { V2GitStore } from './v2-store';

/**
 * Validate identifier-shaped fields on `WriteCommittedOptions`. Mirrors
 * v1's pre-write validation so v2 surfaces identical "invalid checkpoint
 * options: …" error messages.
 */
export function validateWriteOpts(opts: WriteCommittedOptions): void {
	if (opts.checkpointId === '') {
		throw new Error('invalid checkpoint options: checkpoint ID is required');
	}
	const sessionErr = validateSessionId(opts.sessionId);
	if (sessionErr !== null) {
		throw new Error(`invalid checkpoint options: ${sessionErr.message}`);
	}
	const toolUseErr = validateToolUseID(opts.toolUseId);
	if (toolUseErr !== null) {
		throw new Error(`invalid checkpoint options: ${toolUseErr.message}`);
	}
	const agentErr = validateAgentID(opts.agentId);
	if (agentErr !== null) {
		throw new Error(`invalid checkpoint options: ${agentErr.message}`);
	}
}

/**
 * v2 entry point — dual-write to `/main` and (if there's a transcript)
 * `/full/current`. Triggers a generation rotation when the post-write
 * count crosses the threshold; rotation failures are demoted to a warning
 * because the data is already durable on disk.
 *
 * **Failure semantics**: `/main` write failure → throws (data integrity
 * boundary, source of truth). `/full/current` write failure → also throws
 * (matches Go `v2_committed.go:35-51`). Only the post-write rotation step
 * is best-effort. The "outer" v1+v2 dual-write best-effort layer (v2
 * failure not breaking v1) is Phase 5.x condensation's responsibility,
 * not this function.
 *
 * @example
 * ```ts
 * const store = new V2GitStore(repoDir);
 * await store.writeCommitted({
 *   checkpointId: 'a3b2c4d5e6f7',
 *   sessionId: 'sess-1',
 *   strategy: 'manual-commit',
 *   transcript: ENC.encode('{"role":"user"}\n'),    // → /full/current
 *   compactTranscript: ENC.encode('{"compact":true}\n'),  // → /main
 *   prompts: ['hello'],
 *   filesTouched: ['src/app.ts'],
 *   agent: 'claudecode', model: 'claude-sonnet-4',
 *   authorName: 'Alice', authorEmail: 'alice@example.com',
 *   // ... rest of WriteCommittedOptions
 * });
 *
 * // Side effects (TWO ref updates, both atomic):
 * //   refs/story/checkpoints/v2/main → <main-commit>
 * //     tree: a3/b2c4d5e6f7/{metadata.json, 0/{metadata.json, prompt.txt,
 * //                                            transcript.jsonl,
 * //                                            transcript_hash.txt}}
 * //     (NO raw_transcript / full.jsonl on /main)
 * //   refs/story/checkpoints/v2/full/current → <full-commit>
 * //     tree: a3/b2c4d5e6f7/0/{raw_transcript[.NNN], raw_transcript_hash.txt}
 * //     (NO metadata.json / prompt.txt on /full/current — clean root)
 * //
 * // sessionIndex is decided on /main first then reused on /full/current,
 * // so multi-session checkpoints stay aligned across the two refs.
 * //
 * // After the /full/current write, if `countCheckpointsInTree(tree) ≥
 * // store.maxCheckpoints()` (default 100), `rotateGeneration` runs.
 * // Rotation failure → `warn` log only, original write still committed.
 *
 * // Empty transcript → only /main is written (skips /full/current).
 * await store.writeCommitted(baseOpts({ transcript: new Uint8Array() }));
 * ```
 */
export async function writeCommitted(
	store: V2GitStore,
	opts: WriteCommittedOptions,
): Promise<void> {
	validateWriteOpts(opts);

	let sessionIndex: number;
	try {
		sessionIndex = await writeCommittedMain(store, opts);
	} catch (err) {
		throw new Error('v2 /main write failed', { cause: err });
	}

	try {
		await writeCommittedFullTranscript(store, opts, sessionIndex);
	} catch (err) {
		throw new Error('v2 /full/current write failed', { cause: err });
	}
}

/**
 * Update an existing v2 checkpoint's prompts + transcript at the latest
 * (or sessionId-matched) session. Mirrors `GitStore.updateCommitted`.
 *
 * `/main` is updated first (the source of truth); `/full/current` only
 * runs when `opts.transcript` carries new bytes.
 *
 * Session selection: matches `opts.sessionId` first; falls back to the
 * latest session (highest index) when no match.
 *
 * @example
 * ```ts
 * await store.updateCommitted({
 *   checkpointId: 'a3b2c4d5e6f7',
 *   sessionId: 'sess-1',
 *   transcript: ENC.encode('{"role":"final"}\n'),  // → /full/current
 *   compactTranscript: ENC.encode('{"compact":"final"}\n'),  // → /main
 *   prompts: [],
 *   agent: 'claudecode',
 * });
 *
 * // Side effects (up to TWO ref updates):
 * //   refs/story/checkpoints/v2/main → <new commit>
 * //     commit msg: "Finalize checkpoint: a3b2c4d5e6f7\n"
 * //     tree: a3/b2c4d5e6f7/<sessionIdx>/{transcript.jsonl, transcript_hash.txt}
 * //           replaced; root summary's `sessions[idx].transcript` /
 * //           `contentHash` updated to point at the new compact paths.
 * //   refs/story/checkpoints/v2/full/current → <new commit>  (only if
 * //     transcript non-empty) — same shape as writeCommitted: only the
 * //     specific session's raw_transcript[.NNN] / raw_transcript_hash.txt
 * //     replaced; sibling sessions + task subagent metadata untouched.
 * //
 * // /main update failure throws ErrCheckpointNotFound.
 * // /full/current update failure throws (wrapped with cause chain).
 * ```
 */
export async function updateCommitted(
	store: V2GitStore,
	opts: UpdateCommittedOptions,
): Promise<void> {
	if (opts.checkpointId === '') {
		throw new Error('invalid update options: checkpoint ID is required');
	}

	const sessionIndex = await updateCommittedMain(store, opts);

	if (opts.transcript.length > 0) {
		try {
			await updateCommittedFullTranscript(store, opts, sessionIndex);
		} catch (err) {
			throw new Error('v2 /full/current update failed', { cause: err });
		}
	}
}

/**
 * Replace the latest session's `summary` field on `/main`. The summary is
 * redacted before persistence to scrub any AI-generated text that might
 * have captured a credential. Throws {@link ErrCheckpointNotFound} when
 * the checkpoint or its sessions are missing.
 *
 * Only `/main` is touched — `/full/current` doesn't carry summaries.
 *
 * @example
 * ```ts
 * await store.updateSummary('a3b2c4d5e6f7', {
 *   intent: 'add login',
 *   outcome: 'shipped /login route',
 *   learnings: { repo: ['monorepo'], code: [], workflow: [] },
 *   friction: [],
 *   openItems: [],
 * });
 *
 * // Side effects:
 * //   refs/story/checkpoints/v2/main → <new commit>
 * //   commit msg: "Update summary for checkpoint a3b2c4d5e6f7 (session: sess-N)"
 * //   tree change: a3/b2c4d5e6f7/<latestIdx>/metadata.json — only the
 * //   `summary` field replaced (post-redaction); sessionId / strategy /
 * //   tokenUsage etc. preserved verbatim.
 * //
 * // Pass `null` to clear the summary.
 * ```
 */
export async function updateSummary(
	store: V2GitStore,
	checkpointId: string,
	summary: Summary | null,
): Promise<void> {
	const refName = V2_MAIN_REF_NAME;
	let parentHash: string;
	let rootTreeHash: string;
	try {
		const state = await store.getRefState(refName);
		parentHash = state.parentHash;
		rootTreeHash = state.treeHash;
	} catch {
		throw new ErrCheckpointNotFound(checkpointId);
	}

	const cpPath = toCheckpointPath(checkpointId as CheckpointID);
	const basePath = `${cpPath}/`;
	const entries = await flattenCheckpointEntries(store.repoDir, rootTreeHash, cpPath);

	const rootMetadataPath = basePath + METADATA_FILE_NAME;
	const rootEntry = entries.get(rootMetadataPath);
	if (rootEntry === undefined) {
		throw new ErrCheckpointNotFound(checkpointId);
	}
	const cpSummary = await readJsonFromBlob<CheckpointSummary>(store.repoDir, rootEntry.hash);
	if (cpSummary.sessions.length === 0) {
		throw new ErrCheckpointNotFound(checkpointId);
	}

	const latestIndex = cpSummary.sessions.length - 1;
	const sessionMetadataPath = `${basePath}${latestIndex}/${METADATA_FILE_NAME}`;
	const sessionEntry = entries.get(sessionMetadataPath);
	if (sessionEntry === undefined) {
		throw new Error(`session metadata not found at index ${latestIndex}`);
	}

	const metadata = await readJsonFromBlob<CommittedMetadata>(store.repoDir, sessionEntry.hash);
	metadata.summary = (await redactSummary(summary)) ?? undefined;

	const metadataJSON = serializeMetadataJSON(metadata);
	const newBlob = await createBlobFromContent(
		store.repoDir,
		new TextEncoder().encode(metadataJSON),
	);
	entries.set(sessionMetadataPath, {
		name: sessionMetadataPath,
		mode: MODE_FILE,
		hash: newBlob,
		type: 'blob',
	});

	const newTreeHash = await spliceCheckpointSubtree(
		store.repoDir,
		rootTreeHash,
		checkpointId,
		basePath,
		entries,
	);
	const author = await getGitAuthorFromRepo(store.repoDir);
	const commitMsg = `Update summary for checkpoint ${checkpointId} (session: ${metadata.sessionId})`;
	await store.updateRef(refName, newTreeHash, parentHash, commitMsg, author.name, author.email);
}

/**
 * Update the `combinedAttribution` field on a checkpoint's root summary
 * without touching any session data. Throws {@link ErrCheckpointNotFound}
 * when the checkpoint is missing.
 *
 * Only `/main` is touched — `/full/current` doesn't carry summaries.
 *
 * @example
 * ```ts
 * await store.updateCheckpointSummary('a3b2c4d5e6f7', {
 *   calculatedAt: '2026-04-18T00:00:00Z',
 *   agentLines: 100, agentRemoved: 0,
 *   humanAdded: 50, humanModified: 0, humanRemoved: 0,
 *   totalCommitted: 150, totalLinesChanged: 150,
 *   agentPercentage: 67, metricVersion: 2,
 * });
 *
 * // Side effects:
 * //   refs/story/checkpoints/v2/main → <new commit>
 * //   commit msg: "Update checkpoint summary for a3b2c4d5e6f7"
 * //   tree change: a3/b2c4d5e6f7/metadata.json — only `combinedAttribution`
 * //   replaced; sessions[] / checkpointsCount / filesTouched / tokenUsage
 * //   preserved.
 * ```
 */
export async function updateCheckpointSummary(
	store: V2GitStore,
	checkpointId: string,
	combinedAttribution: InitialAttribution | null,
): Promise<void> {
	const refName = V2_MAIN_REF_NAME;
	let parentHash: string;
	let rootTreeHash: string;
	try {
		const state = await store.getRefState(refName);
		parentHash = state.parentHash;
		rootTreeHash = state.treeHash;
	} catch {
		throw new ErrCheckpointNotFound(checkpointId);
	}

	const cpPath = toCheckpointPath(checkpointId as CheckpointID);
	const basePath = `${cpPath}/`;
	const entries = await flattenCheckpointEntries(store.repoDir, rootTreeHash, cpPath);

	const rootMetadataPath = basePath + METADATA_FILE_NAME;
	const rootEntry = entries.get(rootMetadataPath);
	if (rootEntry === undefined) {
		throw new ErrCheckpointNotFound(checkpointId);
	}
	const cpSummary = await readJsonFromBlob<CheckpointSummary>(store.repoDir, rootEntry.hash);
	cpSummary.combinedAttribution = combinedAttribution ?? undefined;

	const newBlob = await createBlobFromContent(
		store.repoDir,
		new TextEncoder().encode(serializeMetadataJSON(cpSummary)),
	);
	entries.set(rootMetadataPath, {
		name: rootMetadataPath,
		mode: MODE_FILE,
		hash: newBlob,
		type: 'blob',
	});

	const newTreeHash = await spliceCheckpointSubtree(
		store.repoDir,
		rootTreeHash,
		checkpointId,
		basePath,
		entries,
	);
	const author = await getGitAuthorFromRepo(store.repoDir);
	const commitMsg = `Update checkpoint summary for ${checkpointId}`;
	await store.updateRef(refName, newTreeHash, parentHash, commitMsg, author.name, author.email);
}

/** Internal: writeCommittedMain / writeCommittedFullTranscript */

async function writeCommittedMain(store: V2GitStore, opts: WriteCommittedOptions): Promise<number> {
	const refName = V2_MAIN_REF_NAME;
	await store.ensureRef(refName);
	const { parentHash, treeHash: rootTreeHash } = await store.getRefState(refName);

	const cpPath = toCheckpointPath(opts.checkpointId as CheckpointID);
	const basePath = `${cpPath}/`;

	const entries = await flattenCheckpointEntries(store.repoDir, rootTreeHash, cpPath);

	const sessionIndex = await writeMainCheckpointEntries(store, opts, basePath, entries);

	const newTreeHash = await spliceCheckpointSubtree(
		store.repoDir,
		rootTreeHash,
		opts.checkpointId,
		basePath,
		entries,
	);
	const commitMsg = `Checkpoint: ${opts.checkpointId}\n`;
	await store.updateRef(
		refName,
		newTreeHash,
		parentHash,
		commitMsg,
		opts.authorName,
		opts.authorEmail,
	);
	return sessionIndex;
}

async function writeMainCheckpointEntries(
	store: V2GitStore,
	opts: WriteCommittedOptions,
	basePath: string,
	entries: Map<string, TreeEntry>,
): Promise<number> {
	const rootMetadataPath = basePath + METADATA_FILE_NAME;
	let existingSummary: CheckpointSummary | null = null;
	const existing = entries.get(rootMetadataPath);
	if (existing !== undefined) {
		try {
			existingSummary = await readJsonFromBlob<CheckpointSummary>(store.repoDir, existing.hash);
		} catch {
			existingSummary = null;
		}
	}

	const sessionIndex = await findSessionIndex(
		store.repoDir,
		basePath,
		existingSummary,
		entries,
		opts.sessionId,
	);
	const sessionPath = `${basePath}${sessionIndex}/`;
	const sessionFilePaths = await writeMainSessionToSubdirectory(store, opts, sessionPath, entries);

	let sessions: SessionFilePaths[];
	if (existingSummary !== null) {
		const len = Math.max(existingSummary.sessions.length, sessionIndex + 1);
		sessions = new Array(len);
		for (let i = 0; i < existingSummary.sessions.length; i++) {
			sessions[i] = existingSummary.sessions[i]!;
		}
		for (let i = 0; i < sessions.length; i++) {
			if (sessions[i] === undefined) {
				sessions[i] = { metadata: '', prompt: '' };
			}
		}
	} else {
		sessions = [{ metadata: '', prompt: '' }];
	}
	sessions[sessionIndex] = sessionFilePaths;

	await writeCheckpointSummary(store.repoDir, opts, basePath, entries, sessions);
	return sessionIndex;
}

async function writeMainSessionToSubdirectory(
	store: V2GitStore,
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

	if (opts.prompts.length > 0) {
		const promptContent = await redactString(joinPrompts(opts.prompts));
		const blobHash = await createBlobFromContent(
			store.repoDir,
			new TextEncoder().encode(promptContent),
		);
		const promptPath = sessionPath + PROMPT_FILE_NAME;
		entries.set(promptPath, {
			name: promptPath,
			mode: MODE_FILE,
			hash: blobHash,
			type: 'blob',
		});
		filePaths.prompt = `/${sessionPath}${PROMPT_FILE_NAME}`;
	}

	// Compact transcript + hash live on /main; raw transcript is in /full/current.
	if (opts.compactTranscript !== null && opts.compactTranscript.length > 0) {
		const compactBlob = await createBlobFromContent(store.repoDir, opts.compactTranscript);
		const compactPath = sessionPath + COMPACT_TRANSCRIPT_FILE_NAME;
		entries.set(compactPath, {
			name: compactPath,
			mode: MODE_FILE,
			hash: compactBlob,
			type: 'blob',
		});
		filePaths.transcript = `/${sessionPath}${COMPACT_TRANSCRIPT_FILE_NAME}`;

		await writeContentHash(
			store.repoDir,
			opts.compactTranscript,
			sessionPath + COMPACT_TRANSCRIPT_HASH_FILE_NAME,
			entries,
		);
		filePaths.contentHash = `/${sessionPath}${COMPACT_TRANSCRIPT_HASH_FILE_NAME}`;
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
		// On v2 /main, checkpointTranscriptStart tracks the COMPACT transcript
		// position (matches Go: `CheckpointTranscriptStart: opts.CompactTranscriptStart`).
		checkpointTranscriptStart: opts.compactTranscriptStart,
		tokenUsage: opts.tokenUsage ?? undefined,
		sessionMetrics: opts.sessionMetrics ?? undefined,
		initialAttribution: opts.initialAttribution ?? undefined,
		promptAttributions: opts.promptAttributionsJson,
		summary: (await redactSummary(opts.summary)) ?? undefined,
		cliVersion: undefined,
	};
	const metadataJSON = serializeMetadataJSON(sessionMetadata);
	const metadataHash = await createBlobFromContent(
		store.repoDir,
		new TextEncoder().encode(metadataJSON),
	);
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

/**
 * Write the raw transcript chunks + content hash to `/full/current`.
 * No-op when the in-memory transcript is empty and no `transcriptPath`
 * fallback exists. Triggers an automatic generation rotation once the
 * post-write checkpoint count crosses the threshold.
 */
async function writeCommittedFullTranscript(
	store: V2GitStore,
	opts: WriteCommittedOptions,
	sessionIndex: number,
): Promise<void> {
	let transcript = opts.transcript;
	if (transcript.length === 0 && opts.transcriptPath !== '') {
		try {
			const raw = await fs.readFile(opts.transcriptPath);
			if (raw.length > 0) {
				const { bytes } = await redactJSONLBytes(new Uint8Array(raw));
				transcript = bytes;
			}
		} catch {
			// Non-fatal — transcript file may not exist yet.
		}
	}
	if (transcript.length === 0) {
		return;
	}

	const refName = V2_FULL_CURRENT_REF_NAME;
	await store.ensureRef(refName);
	const { parentHash, treeHash: rootTreeHash } = await store.getRefState(refName);

	const cpPath = toCheckpointPath(opts.checkpointId as CheckpointID);
	const basePath = `${cpPath}/`;
	const sessionPath = `${basePath}${sessionIndex}/`;

	const entries = await flattenCheckpointEntries(store.repoDir, rootTreeHash, cpPath);

	// Clear prior raw_transcript artifacts for this session, but leave any
	// task subagent metadata / sibling sessions intact.
	const rawBase = sessionPath + V2_RAW_TRANSCRIPT_FILE_NAME;
	const rawHash = sessionPath + V2_RAW_TRANSCRIPT_HASH_FILE_NAME;
	for (const key of [...entries.keys()]) {
		if (key === rawBase || key.startsWith(`${rawBase}.`) || key === rawHash) {
			entries.delete(key);
		}
	}

	await writeTranscriptBlobs(store, transcript, sessionPath, entries);
	await writeContentHash(store.repoDir, transcript, rawHash, entries);

	const newTreeHash = await spliceCheckpointSubtree(
		store.repoDir,
		rootTreeHash,
		opts.checkpointId,
		basePath,
		entries,
	);
	const commitMsg = `Checkpoint: ${opts.checkpointId}\n`;
	await store.updateRef(
		refName,
		newTreeHash,
		parentHash,
		commitMsg,
		opts.authorName,
		opts.authorEmail,
	);

	// Rotation check after a successful write — rotation failures don't
	// invalidate the data we just persisted, so demote them to a warning.
	let count: number;
	try {
		count = await countCheckpointsInTree(store, newTreeHash);
	} catch (err) {
		warn({ component: 'checkpoint' }, 'failed to count checkpoints for rotation check', {
			error: err instanceof Error ? err.message : String(err),
		});
		return;
	}
	if (count >= store.maxCheckpoints()) {
		try {
			await rotateGeneration(store);
		} catch (err) {
			warn({ component: 'checkpoint' }, 'generation rotation failed', {
				error: err instanceof Error ? err.message : String(err),
				checkpoint_count: count,
			});
		}
	}
}

async function writeTranscriptBlobs(
	store: V2GitStore,
	transcript: Uint8Array,
	sessionPath: string,
	entries: Map<string, TreeEntry>,
): Promise<void> {
	const chunks = chunkBytes(transcript, MAX_CHUNK_SIZE);
	for (let i = 0; i < chunks.length; i++) {
		const chunkPath = sessionPath + chunkFileName(V2_RAW_TRANSCRIPT_FILE_NAME, i);
		const blobHash = await createBlobFromContent(store.repoDir, chunks[i]!);
		entries.set(chunkPath, {
			name: chunkPath,
			mode: MODE_FILE,
			hash: blobHash,
			type: 'blob',
		});
	}
}

/** Internal: updateCommittedMain / updateCommittedFullTranscript */

async function updateCommittedMain(
	store: V2GitStore,
	opts: UpdateCommittedOptions,
): Promise<number> {
	const refName = V2_MAIN_REF_NAME;
	let parentHash: string;
	let rootTreeHash: string;
	try {
		const state = await store.getRefState(refName);
		parentHash = state.parentHash;
		rootTreeHash = state.treeHash;
	} catch {
		throw new ErrCheckpointNotFound(opts.checkpointId);
	}

	const cpPath = toCheckpointPath(opts.checkpointId as CheckpointID);
	const basePath = `${cpPath}/`;
	const entries = await flattenCheckpointEntries(store.repoDir, rootTreeHash, cpPath);

	const rootMetadataPath = basePath + METADATA_FILE_NAME;
	const rootEntry = entries.get(rootMetadataPath);
	if (rootEntry === undefined) {
		throw new ErrCheckpointNotFound(opts.checkpointId);
	}
	const summary = await readJsonFromBlob<CheckpointSummary>(store.repoDir, rootEntry.hash);
	if (summary.sessions.length === 0) {
		throw new ErrCheckpointNotFound(opts.checkpointId);
	}

	let sessionIndex = await findSessionIndex(
		store.repoDir,
		basePath,
		summary,
		entries,
		opts.sessionId,
	);
	if (sessionIndex >= summary.sessions.length) {
		sessionIndex = summary.sessions.length - 1;
	}

	const sessionPath = `${basePath}${sessionIndex}/`;

	if (opts.prompts.length > 0) {
		const promptContent = await redactString(joinPrompts(opts.prompts));
		const blobHash = await createBlobFromContent(
			store.repoDir,
			new TextEncoder().encode(promptContent),
		);
		const promptPath = sessionPath + PROMPT_FILE_NAME;
		entries.set(promptPath, {
			name: promptPath,
			mode: MODE_FILE,
			hash: blobHash,
			type: 'blob',
		});
	}

	if (opts.compactTranscript !== null && opts.compactTranscript.length > 0) {
		const compactBlob = await createBlobFromContent(store.repoDir, opts.compactTranscript);
		const compactPath = sessionPath + COMPACT_TRANSCRIPT_FILE_NAME;
		entries.set(compactPath, {
			name: compactPath,
			mode: MODE_FILE,
			hash: compactBlob,
			type: 'blob',
		});
		await writeContentHash(
			store.repoDir,
			opts.compactTranscript,
			sessionPath + COMPACT_TRANSCRIPT_HASH_FILE_NAME,
			entries,
		);

		// Keep the root summary in sync so explain / list see the new compact paths.
		if (sessionIndex >= 0 && sessionIndex < summary.sessions.length) {
			summary.sessions[sessionIndex] = {
				...summary.sessions[sessionIndex]!,
				transcript: `/${sessionPath}${COMPACT_TRANSCRIPT_FILE_NAME}`,
				contentHash: `/${sessionPath}${COMPACT_TRANSCRIPT_HASH_FILE_NAME}`,
			};
			const summaryJSON = serializeMetadataJSON(summary);
			const summaryHash = await createBlobFromContent(
				store.repoDir,
				new TextEncoder().encode(summaryJSON),
			);
			entries.set(rootMetadataPath, {
				name: rootMetadataPath,
				mode: MODE_FILE,
				hash: summaryHash,
				type: 'blob',
			});
		}
	}

	const newTreeHash = await spliceCheckpointSubtree(
		store.repoDir,
		rootTreeHash,
		opts.checkpointId,
		basePath,
		entries,
	);
	const author = await getGitAuthorFromRepo(store.repoDir);
	const commitMsg = `Finalize checkpoint: ${opts.checkpointId}\n`;
	await store.updateRef(refName, newTreeHash, parentHash, commitMsg, author.name, author.email);

	return sessionIndex;
}

async function updateCommittedFullTranscript(
	store: V2GitStore,
	opts: UpdateCommittedOptions,
	sessionIndex: number,
): Promise<void> {
	const refName = V2_FULL_CURRENT_REF_NAME;
	await store.ensureRef(refName);
	const { parentHash, treeHash: rootTreeHash } = await store.getRefState(refName);

	const cpPath = toCheckpointPath(opts.checkpointId as CheckpointID);
	const basePath = `${cpPath}/`;
	const sessionPath = `${basePath}${sessionIndex}/`;

	const entries = await flattenCheckpointEntries(store.repoDir, rootTreeHash, cpPath);

	// Clear only prior raw_transcript + hash for this session — leaves any
	// task subagent metadata stored under sessionPath untouched.
	const rawBase = sessionPath + V2_RAW_TRANSCRIPT_FILE_NAME;
	const rawHash = sessionPath + V2_RAW_TRANSCRIPT_HASH_FILE_NAME;
	for (const key of [...entries.keys()]) {
		if (key === rawBase || key.startsWith(`${rawBase}.`) || key === rawHash) {
			entries.delete(key);
		}
	}

	await writeTranscriptBlobs(store, opts.transcript, sessionPath, entries);
	await writeContentHash(store.repoDir, opts.transcript, rawHash, entries);

	const newTreeHash = await spliceCheckpointSubtree(
		store.repoDir,
		rootTreeHash,
		opts.checkpointId,
		basePath,
		entries,
	);
	const author = await getGitAuthorFromRepo(store.repoDir);
	const commitMsg = `Finalize checkpoint: ${opts.checkpointId}\n`;
	await store.updateRef(refName, newTreeHash, parentHash, commitMsg, author.name, author.email);
}

// Re-export for callers reaching for v2-committed.ts as a one-stop shop.
export { ErrCheckpointNotFound };
