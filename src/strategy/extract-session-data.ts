/**
 * Three-branch session data extraction used by `condenseSession`. Reads the
 * transcript / prompts / token usage from either the shadow branch tree or
 * the live transcript file, depending on which data source is available.
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/strategy/manual_commit_condensation.go`
 * (`extractOrCreateSessionData` / `extractSessionData` /
 * `extractSessionDataFromLiveTranscript`).
 *
 * Three-branch dispatch (in `extractOrCreateSessionData`):
 *
 * 1. **shadow branch exists** → {@link extractSessionData} reads tree blobs
 *    (preferring the live transcript file when available — the shadow tree
 *    copy may be stale if the last turn ended without code changes).
 * 2. **only `state.transcriptPath` set** → {@link extractSessionDataFromLiveTranscript}
 *    reads from disk (mid-session commit before SaveStep ran).
 * 3. **neither** → empty data carrying `state.filesTouched`; the
 *    {@link condenseSession} skip gate handles the empty case.
 *
 * @packageDocumentation
 */

import fsCallback from 'node:fs';
import fs from 'node:fs/promises';
import git from 'isomorphic-git';
import * as registry from '../agent/registry';
import { calculateTokenUsage } from '../agent/token-usage';
import { normalize } from '../agent/types';
import {
	PROMPT_FILE_NAME,
	TRANSCRIPT_FILE_NAME,
	TRANSCRIPT_FILE_NAME_LEGACY,
} from '../checkpoint/constants';
import * as log from '../log';
import { storyMetadataDirForSession } from '../paths';
import type { ManualCommitStrategy } from './manual-commit';
import { resolveTranscriptPath } from './resolve-transcript';
import { prepareTranscriptIfNeeded } from './transcript-prep';
import {
	countTranscriptItems,
	readPromptsFromFilesystem,
	splitPromptContent,
} from './transcript-prompts';
import type { AgentType, ExtractedSessionData, SessionState } from './types';

/**
 * Three-branch dispatch for session data extraction. See file-level docstring
 * for the dispatch matrix.
 *
 * @example
 * await extractOrCreateSessionData(strategy, shadowOid, true, state);
 * // ExtractedSessionData { transcript: ..., prompts: [...], filesTouched: [...] }
 *
 * // Side effects: read-only — git blob lookups + filesystem reads.
 */
export async function extractOrCreateSessionData(
	s: ManualCommitStrategy,
	shadowOid: string | null,
	hasShadowBranch: boolean,
	state: SessionState,
): Promise<ExtractedSessionData> {
	if (hasShadowBranch && shadowOid !== null) {
		try {
			return await extractSessionData(
				s,
				shadowOid,
				state.sessionId,
				state.filesTouched ?? [],
				normalize(state.agentType ?? ''),
				state.transcriptPath ?? '',
				state.checkpointTranscriptStart ?? 0,
				state.phase === 'active',
			);
		} catch (err) {
			throw new Error(
				`failed to extract session data: ${err instanceof Error ? err.message : String(err)}`,
				{ cause: err as Error },
			);
		}
	}
	if (state.transcriptPath !== undefined && state.transcriptPath !== '') {
		try {
			return await extractSessionDataFromLiveTranscript(s, state);
		} catch (err) {
			throw new Error(
				`failed to extract session data from live transcript: ${err instanceof Error ? err.message : String(err)}`,
				{ cause: err as Error },
			);
		}
	}

	log.debug(
		{ component: 'checkpoint', sessionId: state.sessionId },
		'no shadow branch and no transcript path, returning empty session data',
		{ session_id: state.sessionId, agent_type: state.agentType ?? '' },
	);
	return {
		transcript: new Uint8Array(),
		fullTranscriptLines: 0,
		prompts: [],
		filesTouched: state.filesTouched ?? [],
		tokenUsage: null,
	};
}

/**
 * Read a blob at `<treeOid>/<filepath>` from a commit's tree. Returns `null`
 * when the file isn't present (or any read fails). Used internally by
 * {@link extractSessionData} so the per-file fallbacks (transcript ↔ legacy ↔
 * prompt ↔ filesystem) read like a clean cascade.
 */
async function readTreeBlob(
	repoDir: string,
	commitOid: string,
	filepath: string,
): Promise<Uint8Array | null> {
	try {
		const result = await git.readBlob({
			fs: fsCallback,
			dir: repoDir,
			oid: commitOid,
			filepath,
		});
		return result.blob;
	} catch {
		return null;
	}
}

/**
 * Extract transcript / prompts / files / tokenUsage from a shadow branch
 * commit tree. Prefers the live transcript file over the shadow tree copy
 * (the shadow copy can be stale when the last SaveStep was a no-op dedup).
 *
 * Algorithm:
 * 1. Read commit → tree (`shadowOid`).
 * 2. Transcript: `liveTranscriptPath` non-empty → `prepareTranscriptIfNeeded`
 *    (active sessions only) → `fs.readFile`; fall back to tree blob
 *    `<metadataDir>/full.jsonl` then `<metadataDir>/full.log` (legacy).
 * 3. Prompts: tree blob `<metadataDir>/prompt.txt` → `splitPromptContent`;
 *    fallback to `readPromptsFromFilesystem(sessionId)`.
 * 4. `filesTouched`: from `state.filesTouched` (NOT the tree's full file list).
 * 5. `tokenUsage`: dispatched via `@/agent/token-usage.calculateTokenUsage`
 *    — `SubagentAwareExtractor` (preferred) → `TokenCalculator` → `null`
 *    when the agent is unregistered or implements neither.
 *
 * Mirrors Go `extractSessionData`.
 *
 * @example
 * await extractSessionData(strategy, shadowOid, sessionId, ['src/app.ts'],
 *                          'Claude Code', '/abs/transcript.jsonl', 0, false);
 * // ExtractedSessionData { transcript: ..., prompts: [...], ... }
 *
 * // Side effects: read-only — blob lookups + filesystem reads + optional
 * //   prepareTranscriptIfNeeded (Phase 5.1 stub: stat-only check).
 */
export async function extractSessionData(
	s: ManualCommitStrategy,
	shadowOid: string,
	sessionId: string,
	filesTouched: string[],
	agentType: AgentType,
	liveTranscriptPath: string,
	checkpointTranscriptStart: number,
	isActive: boolean,
): Promise<ExtractedSessionData> {
	const repo = await s.getRepo();
	const metadataDir = storyMetadataDirForSession(sessionId);

	let fullTranscript = '';
	if (liveTranscriptPath !== '') {
		if (isActive) {
			// Phase 6.1 Part 2: prepareTranscriptIfNeeded dispatches via
			// caps.asTranscriptPreparer (see src/strategy/transcript-prep.ts);
			// active phase + non-empty path/agent + agent implements
			// TranscriptPreparer ⇒ flush. Failures are warned + swallowed.
			await prepareTranscriptIfNeeded({
				sessionId,
				baseCommit: '',
				startedAt: '',
				phase: 'active',
				stepCount: 0,
				transcriptPath: liveTranscriptPath,
				agentType,
			});
		}
		try {
			const liveData = await fs.readFile(liveTranscriptPath);
			if (liveData.length > 0) {
				fullTranscript = new TextDecoder('utf-8', { fatal: false }).decode(liveData);
			}
		} catch {
			// Non-fatal — fall through to shadow tree copy.
		}
	}

	if (fullTranscript === '') {
		const blob = await readTreeBlob(repo.root, shadowOid, `${metadataDir}/${TRANSCRIPT_FILE_NAME}`);
		if (blob !== null) {
			fullTranscript = new TextDecoder('utf-8', { fatal: false }).decode(blob);
		} else {
			const legacy = await readTreeBlob(
				repo.root,
				shadowOid,
				`${metadataDir}/${TRANSCRIPT_FILE_NAME_LEGACY}`,
			);
			if (legacy !== null) {
				fullTranscript = new TextDecoder('utf-8', { fatal: false }).decode(legacy);
			}
		}
	}

	const data: ExtractedSessionData = {
		transcript: new Uint8Array(),
		fullTranscriptLines: 0,
		prompts: [],
		filesTouched,
		tokenUsage: null,
	};

	if (fullTranscript !== '') {
		data.transcript = new TextEncoder().encode(fullTranscript);
		data.fullTranscriptLines = countTranscriptItems(agentType, fullTranscript);

		const promptBlob = await readTreeBlob(
			repo.root,
			shadowOid,
			`${metadataDir}/${PROMPT_FILE_NAME}`,
		);
		if (promptBlob !== null) {
			const text = new TextDecoder('utf-8', { fatal: false }).decode(promptBlob);
			if (text !== '') {
				data.prompts = splitPromptContent(text) ?? [];
			}
		}
		if (data.prompts.length === 0) {
			const fsPrompts = await readPromptsFromFilesystem(sessionId, repo.root);
			if (fsPrompts !== null) {
				data.prompts = fsPrompts;
			}
		}
	}

	// Phase 6.1 Part 2: agent dispatch — registered agents that implement
	// TokenCalculator (or SubagentAwareExtractor for the live-transcript variant)
	// produce a token usage struct sliced from `checkpointTranscriptStart`.
	// Unknown agent / no calculator ⇒ null (Go: condensation_test.go::CursorReturnsNil).
	const ag = registry.getByAgentType(agentType);
	data.tokenUsage = await calculateTokenUsage(ag, data.transcript, checkpointTranscriptStart, '');

	return data;
}

/**
 * Extract from the live transcript file when no shadow branch exists yet
 * (mid-session commit before SaveStep ran). Resolves the transcript path
 * (handles agents that relocate mid-session — Phase 5.2 wired the resolver).
 * Throws on read failure or empty file.
 *
 * **Phase 5.4 dependency**: Go's `s.resolveFilesTouched(ctx, state)` falls
 * back to transcript-extracted file paths when state is empty. Phase 5.3
 * skips that fallback (always uses `state.filesTouched`); Phase 5.4 wires the
 * resolver and removes the marker below.
 *
 * Mirrors Go `extractSessionDataFromLiveTranscript`.
 *
 * @example
 * await extractSessionDataFromLiveTranscript(strategy, state);
 * // ExtractedSessionData with transcript bytes from disk.
 *
 * // Side effects: read-only — disk read + optional transcript path resolution
 * //   (which may mutate state.transcriptPath if an agent migration is detected).
 */
export async function extractSessionDataFromLiveTranscript(
	s: ManualCommitStrategy,
	state: SessionState,
): Promise<ExtractedSessionData> {
	void s; // strategy reference reserved for Phase 5.4 resolveFilesTouched wiring.
	const transcriptPath = await resolveTranscriptPath(state);

	let liveData: Buffer;
	try {
		liveData = await fs.readFile(transcriptPath);
	} catch (err) {
		throw new Error(
			`failed to read live transcript: ${err instanceof Error ? err.message : String(err)}`,
			{ cause: err as Error },
		);
	}
	if (liveData.length === 0) {
		throw new Error('live transcript is empty');
	}
	const fullTranscript = new TextDecoder('utf-8', { fatal: false }).decode(liveData);
	// Buffer extends Uint8Array; copy bytes into a clean Uint8Array so callers
	// don't accidentally get a Buffer with surprising semantics.
	const transcriptBytes = Uint8Array.from(liveData);
	const data: ExtractedSessionData = {
		transcript: transcriptBytes,
		fullTranscriptLines: countTranscriptItems(normalize(state.agentType ?? ''), fullTranscript),
		prompts: (await readPromptsFromFilesystem(state.sessionId)) ?? [],
		// Phase 5.4 Part 1 wired resolveFilesTouched + extractModifiedFilesFromLiveTranscript
		// in src/strategy/hooks-content-detection.ts (Phase 6.1 Part 2 wires the
		// per-agent analyzer dispatch in that file). The live-transcript variant
		// here keeps state.filesTouched fallback semantics — Go-aligned with
		// `manual_commit.go: extractLiveSessionData` which doesn't recompute
		// touches at this stage.
		filesTouched: state.filesTouched ?? [],
		tokenUsage: null,
	};
	// Phase 6.1 Part 2: token usage from the live transcript bytes (same
	// dispatch as the shadow-tree variant above). state.checkpointTranscriptStart
	// is the offset to slice from (Go: `state.CheckpointTranscriptStart`).
	const ag = registry.getByAgentType(state.agentType ?? '');
	data.tokenUsage = await calculateTokenUsage(
		ag,
		data.transcript,
		state.checkpointTranscriptStart ?? 0,
		'',
	);
	return data;
}
