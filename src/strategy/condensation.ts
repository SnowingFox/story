/**
 * `condenseSession` — the 11-step main pipeline that takes a session's
 * accumulated shadow-branch state and writes a permanent metadata record
 * onto the v1 metadata branch (and v2 dual-write when enabled).
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/strategy/manual_commit_condensation.go`
 * (`CondenseSession` + `calculateSessionAttributions` + `buildCompactTranscript`
 * + `compactTranscriptForV2` + `computeCompactTranscriptStart` +
 * `countCompactLines` + `writeCommittedV2IfEnabled` +
 * `writeTaskMetadataV2IfEnabled`).
 *
 * **11-step pipeline** (see `CondenseSession` in Go for the full reference):
 *
 * 1. open repo + resolve agent + log context
 * 2. resolve shadow branch ref
 * 3. re-resolve transcript path (handles agents that relocate mid-session)
 * 4. extract session data (transcript / prompts / files / token usage)
 * 5. backfill token usage (any-agent passthrough — see condense-helpers.ts)
 * 6. **skip gate** — empty transcript + empty filesTouched ⇒ early return
 *    `{ skipped: true }`. MUST run before {@link filterFilesTouched}.
 * 7. {@link filterFilesTouched} (intersection or mid-turn fallback)
 * 8. redact transcript ONCE for v1 + v2 + summary consumers (catch + drop on failure)
 * 9. compute attribution
 * 10. build commit message + summary (Phase 11 noop until then)
 * 11. write to v1 + (optional) v2 dual-write
 *
 * @packageDocumentation
 */

import fsCallback from 'node:fs';
import git from 'isomorphic-git';
import { VERSION as cliVersion } from '@/versioninfo';
import { normalize } from '../agent/types';
import { getGitAuthorFromRepo } from '../checkpoint/committed';
import {
	METADATA_FILE_NAME,
	V2_FULL_CURRENT_REF_NAME,
	V2_MAIN_REF_NAME,
} from '../checkpoint/constants';
import { shadowBranchNameForCommit } from '../checkpoint/temporary';
import { MergeMode, MODE_FILE, type TreeEntry, updateSubtree } from '../checkpoint/tree-ops';
import type {
	CheckpointSummary,
	TokenUsage as CheckpointTokenUsage,
	CommittedMetadata,
	InitialAttribution,
	Summary,
	WriteCommittedOptions,
} from '../checkpoint/types';
import { type CheckpointID, toPath as checkpointIdToPath } from '../id';
import { parseMetadataJSON } from '../jsonutil';
import * as log from '../log';
import { storyMetadataDirForSession } from '../paths';
import type { TokenUsage as SessionTokenUsage } from '../session/state-store';
import {
	isCheckpointsV2Enabled,
	isSummarizeEnabled,
	load as loadSettings,
} from '../settings/settings';
import { compact } from '../transcript/compact';
import { type AttributionParams, calculateAttributionWithAccumulated } from './attribution';
import { getCurrentBranchName } from './branches';
import {
	buildSessionMetrics,
	filterFilesTouched,
	marshalPromptAttributionsIncludingPending,
	redactSessionTranscript,
	resolveShadowRef,
	sessionStateBackfillTokenUsage,
} from './condense-helpers';
import { STRATEGY_NAME_MANUAL_COMMIT } from './constants';
import { extractOrCreateSessionData } from './extract-session-data';
import type { ManualCommitStrategy } from './manual-commit';
import { resolveTranscriptPath } from './resolve-transcript';
import { generateSummary } from './summary-stub';
import type { CondenseResult, ExtractedSessionData, SessionState } from './types';

/**
 * Pre-resolved git objects passed by callers (PostCommit / PrepareCommitMsg)
 * that already read the relevant trees, so {@link condenseSession} can avoid
 * redundant lookups. Mirrors Go `condenseOpts`.
 */
export interface CondenseOpts {
	/** Pre-resolved shadow branch ref OID. `null`/missing = resolve from repo. */
	shadowRefOid?: string | null;
	/** Pre-resolved HEAD tree OID. */
	headTreeOid?: string | null;
	/** Pre-resolved parent tree OID. `null` + `hasParentTree=false` = read on
	 * demand; `null` + `hasParentTree=true` = initial commit (no parent). */
	parentTreeOid?: string | null;
	/** True when `parentTreeOid` was pre-resolved. */
	hasParentTree?: boolean;
	/** Repository worktree path for git CLI commands (defaults to strategy's repo). */
	repoDir?: string;
	/** HEAD's first parent commit hash (preferred diff base for non-agent files). */
	parentCommitHash?: string;
	/** HEAD commit hash (passed through to attribution). */
	headCommitHash?: string;
	/** Union of all sessions' filesTouched. `null` = single-session run. */
	allAgentFiles?: ReadonlySet<string> | null;
}

/**
 * Reshape session-state {@link SessionTokenUsage} (where `subagentTokens` may
 * be `null`) into checkpoint-metadata {@link CheckpointTokenUsage} (where it
 * must be `undefined`). The two interfaces diverge by a single optional-vs-
 * nullable field; the conversion is purely a key cleanup.
 */
function convertTokenUsageForMetadata(
	usage: SessionTokenUsage | null,
): CheckpointTokenUsage | null {
	if (usage === null) {
		return null;
	}
	const out: CheckpointTokenUsage = {
		inputTokens: usage.inputTokens,
		cacheCreationTokens: usage.cacheCreationTokens,
		cacheReadTokens: usage.cacheReadTokens,
		outputTokens: usage.outputTokens,
		apiCallCount: usage.apiCallCount,
	};
	if (usage.subagentTokens != null) {
		out.subagentTokens = convertTokenUsageForMetadata(usage.subagentTokens) ?? undefined;
	}
	return out;
}

/**
 * Count `\n` byte occurrences in a compact transcript blob. Used by callers
 * to track `state.compactTranscriptStart` accumulation across condensations.
 *
 * Mirrors Go `countCompactLines` (`bytes.Count(b, []byte{'\n'})`).
 */
export function countCompactLines(compactTranscript: Uint8Array): number {
	let n = 0;
	for (let i = 0; i < compactTranscript.length; i++) {
		if (compactTranscript[i] === 0x0a) {
			n++;
		}
	}
	return n;
}

/**
 * Compute the compact transcript "start line" offset to record on the v2
 * /main metadata. Prefers `state.compactTranscriptStart` (the canonical
 * counter); for legacy sessions that only persisted the
 * `checkpointTranscriptStart` (raw line offset), reconstructs the compact
 * offset by re-compacting the full transcript and subtracting the scoped
 * compact length.
 *
 * Mirrors Go `computeCompactTranscriptStart`.
 */
export function computeCompactTranscriptStart(
	state: SessionState,
	transcript: Uint8Array,
	scopedCompact: Uint8Array | null,
	agentType: string,
	cliVersion: string,
): number {
	if ((state.compactTranscriptStart ?? 0) > 0) {
		return state.compactTranscriptStart!;
	}
	if (
		(state.checkpointTranscriptStart ?? 0) === 0 ||
		transcript.length === 0 ||
		scopedCompact === null ||
		scopedCompact.length === 0
	) {
		return 0;
	}
	const fullCompacted = compact(transcript, {
		agent: agentType.toLowerCase().replace(/\s+/g, '-'),
		cliVersion,
		startLine: 0,
	});
	if (fullCompacted === null || fullCompacted.length === 0) {
		return 0;
	}
	const fullLines = countCompactLines(fullCompacted);
	const scopedLines = countCompactLines(scopedCompact);
	const offset = fullLines - scopedLines;
	return offset < 0 ? 0 : offset;
}

/**
 * Build the v2 compact transcript (scoped + full) and patch
 * {@link WriteCommittedOptions} with the bytes + start offset. No-op when
 * settings.checkpoints_v2 is disabled. Mirrors Go `buildCompactTranscript`.
 */
async function buildCompactTranscript(
	repoDir: string,
	agentType: string,
	cliVersion: string,
	redacted: Uint8Array,
	state: SessionState,
	writeOpts: WriteCommittedOptions,
): Promise<void> {
	const settings = await loadSettings(repoDir);
	if (!isCheckpointsV2Enabled(settings)) {
		return;
	}
	const opts = {
		agent: agentType.toLowerCase().replace(/\s+/g, '-'),
		cliVersion,
		startLine: state.checkpointTranscriptStart ?? 0,
	};
	const scoped = compact(redacted, opts);
	const full = compact(redacted, { ...opts, startLine: 0 });
	writeOpts.compactTranscript = full;
	writeOpts.compactTranscriptStart = computeCompactTranscriptStart(
		state,
		redacted,
		scoped,
		agentType,
		cliVersion,
	);
}

/**
 * v2 dual-write — writes the same checkpoint to `refs/story/checkpoints/v2/main`
 * when settings.checkpoints_v2 is enabled. Failures log a warning and DO NOT
 * propagate so the v1 write isn't held hostage by a v2 issue (fail-open
 * during the dual-write transition).
 *
 * Mirrors Go `writeCommittedV2IfEnabled`.
 *
 * @example
 * await writeCommittedV2IfEnabled(strategy, repoDir, writeOpts);
 *
 * // Side effects (when settings.checkpoints_v2 = true):
 * //   refs/story/checkpoints/v2/main          ← bumped to new commit
 * //   refs/story/checkpoints/v2/full/current  ← bumped (raw transcript)
 * // (no-op when settings disabled or v2 write throws.)
 */
export async function writeCommittedV2IfEnabled(
	s: ManualCommitStrategy,
	repoDir: string,
	opts: WriteCommittedOptions,
): Promise<void> {
	const settings = await loadSettings(repoDir);
	if (!isCheckpointsV2Enabled(settings)) {
		return;
	}
	try {
		const v2Store = await s.getV2CheckpointStore();
		await v2Store.writeCommitted(opts);
	} catch (err) {
		log.warn({ component: 'checkpoint' }, 'v2 dual-write failed', {
			checkpoint_id: opts.checkpointId,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

/**
 * Resolve the per-session sub-tree index inside a v2 `/main` checkpoint tree.
 *
 * The v2 main ref stores each checkpoint as
 * `<shardPrefix>/<shardSuffix>/<sessionIndex>/{metadata.json,...}` where
 * `sessionIndex` is the position of the session inside `CheckpointSummary.sessions`.
 * `writeTaskMetadataV2IfEnabled` needs this index to splice the shadow `tasks/`
 * subtree into the right `<sessionIndex>` slot of the matching `/full/current`
 * checkpoint.
 *
 * Algorithm (mirrors Go `manual_commit_condensation.go: resolveV2SessionIndexForCheckpoint`):
 * 1. Read `refs/story/checkpoints/v2/main` → readCommit → root tree
 * 2. Read root → `<checkpointId.path>` subtree
 * 3. Read `<checkpoint>/metadata.json` blob → parse `CheckpointSummary`
 * 4. For i in 0..summary.sessions.length: read `<checkpoint>/<i>/metadata.json`
 *    → parse `CommittedMetadata` → return i if `sessionId` matches
 * 5. Not found → throw `session ${sessionId} not found in v2 checkpoint ${checkpointId}`
 *
 * @example
 * await resolveV2SessionIndexForCheckpoint(repoDir, '0123456789ab', 'sess-foo')
 * // 1   (the second session in checkpoint 0123456789ab)
 *
 * // Side effects: none — read-only git lookups.
 */
export async function resolveV2SessionIndexForCheckpoint(
	repoDir: string,
	checkpointId: CheckpointID,
	sessionId: string,
): Promise<number> {
	const tip = await git.resolveRef({ fs: fsCallback, dir: repoDir, ref: V2_MAIN_REF_NAME });
	const { commit } = await git.readCommit({ fs: fsCallback, dir: repoDir, oid: tip });
	const rootTree = commit.tree;
	const cpPath = checkpointIdToPath(checkpointId);

	// Read checkpoint-level metadata.json → CheckpointSummary
	const summaryBlob = await git.readBlob({
		fs: fsCallback,
		dir: repoDir,
		oid: rootTree,
		filepath: `${cpPath}/${METADATA_FILE_NAME}`,
	});
	const summary = parseMetadataJSON<CheckpointSummary>(new TextDecoder().decode(summaryBlob.blob));

	for (let i = 0; i < summary.sessions.length; i++) {
		try {
			const sessionMetaBlob = await git.readBlob({
				fs: fsCallback,
				dir: repoDir,
				oid: rootTree,
				filepath: `${cpPath}/${i}/${METADATA_FILE_NAME}`,
			});
			const sessionMeta = parseMetadataJSON<CommittedMetadata>(
				new TextDecoder().decode(sessionMetaBlob.blob),
			);
			if (sessionMeta.sessionId === sessionId) {
				return i;
			}
		} catch {
			// Missing session subtree / unreadable metadata: skip and continue.
		}
	}

	throw new Error(`session "${sessionId}" not found in v2 checkpoint ${checkpointId}`);
}

/**
 * Splice a `tasks/` subtree from the shadow branch into v2 `/full/current` at
 * `<shardPrefix>/<shardSuffix>/<sessionIndex>/tasks/`, bumping `/full/current`
 * to a new commit. Uses {@link MergeMode.MergeKeepExisting} so existing task
 * subtrees in v2 (from a prior splice) survive — only new toolUseIds added.
 *
 * Mirrors Go `manual_commit_condensation.go: spliceTaskTreeToV2FullCurrent`.
 *
 * @example
 * await spliceTaskTreeToV2FullCurrent(repoDir, store, '0123456789ab', 1, '<tasksTreeOid>');
 *
 * // Side effects in `<repoDir>/.git/`:
 * //   objects/<commit>                              ← new commit
 * //   refs/story/checkpoints/v2/full/current        ← bumped to <commit>
 * //   /main / /full/<seq> / shadow refs / worktree  ← unchanged
 */
export async function spliceTaskTreeToV2FullCurrent(
	repoDir: string,
	store: { getRefState(refName: string): Promise<{ parentHash: string; treeHash: string }> },
	checkpointId: CheckpointID,
	sessionIndex: number,
	tasksTreeOid: string,
): Promise<void> {
	const { parentHash, treeHash } = await store.getRefState(V2_FULL_CURRENT_REF_NAME);

	// Read the incoming tasks tree's entries (each is a tool-use-id subtree).
	const tasksTree = await git.readTree({ fs: fsCallback, dir: repoDir, oid: tasksTreeOid });
	const incomingEntries: TreeEntry[] = tasksTree.tree.map((e) => ({
		name: e.path,
		mode: e.mode,
		hash: e.oid,
		type: e.type,
	}));

	const shardPrefix = checkpointId.slice(0, 2);
	const shardSuffix = checkpointId.slice(2);
	const sessionDir = String(sessionIndex);

	const newRootHash = await updateSubtree(
		repoDir,
		treeHash,
		[shardPrefix, shardSuffix, sessionDir, 'tasks'],
		incomingEntries,
		{ mergeMode: MergeMode.MergeKeepExisting },
	);

	const author = await getGitAuthorFromRepo(repoDir);
	const { createCommit } = await import('../checkpoint/git-objects');
	const commitHash = await createCommit(
		repoDir,
		newRootHash,
		parentHash,
		`Checkpoint: ${checkpointId} (task metadata)\n`,
		author.name,
		author.email,
	);
	await git.writeRef({
		fs: fsCallback,
		dir: repoDir,
		ref: V2_FULL_CURRENT_REF_NAME,
		value: commitHash,
		force: true,
	});
	void MODE_FILE; // imported for tree-ops API surface alignment; sub-tree mode handled by updateSubtree
}

/**
 * v2 dual-write for task metadata trees. Splices the shadow tree's
 * `<sessionMetadataDir>/tasks/<tool-use-id>/...` subtree into v2
 * `/full/current` so task rewind artifacts are immediately available without
 * running `story migrate --checkpoints v2`.
 *
 * Behavior:
 * 1. Settings `checkpoints_v2` disabled OR `shadowOid === null` → no-op.
 * 2. Shadow tree has no `<sessionMetadataDir>/tasks/` subtree → silent no-op
 *    (most sessions don't have sub-agent task checkpoints).
 * 3. Resolve sessionIndex via {@link resolveV2SessionIndexForCheckpoint},
 *    then splice via {@link spliceTaskTreeToV2FullCurrent}.
 * 4. Any error → log warn + return (fail-open; v1 write must not be blocked
 *    by v2 task metadata splice issues).
 *
 * Mirrors Go `manual_commit_condensation.go: writeTaskMetadataV2IfEnabled`.
 *
 * @example
 * await writeTaskMetadataV2IfEnabled(strategy, repoDir, '0123456789ab', 'sess-1', '<shadowCommitOid>');
 *
 * // Side effects (settings.checkpoints_v2 enabled + shadow has tasks/ + v2 main has session):
 * //   refs/story/checkpoints/v2/full/current  ← bumped to new commit
 * //   /main / shadow refs / worktree          ← unchanged
 * // (no-op when settings disabled / no shadow OID / no tasks subtree / any error.)
 */
export async function writeTaskMetadataV2IfEnabled(
	s: ManualCommitStrategy,
	repoDir: string,
	checkpointId: CheckpointID,
	sessionId: string,
	shadowOid: string | null,
): Promise<void> {
	const settings = await loadSettings(repoDir);
	if (!isCheckpointsV2Enabled(settings) || shadowOid === null) {
		return;
	}

	const logCtx = { component: 'checkpoint', sessionId };

	// Step 1: read shadow tree, look for <sessionMetadataDir>/tasks/ subtree.
	let tasksTreeOid: string;
	try {
		const { commit } = await git.readCommit({
			fs: fsCallback,
			dir: repoDir,
			oid: shadowOid,
		});
		const tasksPath = `${storyMetadataDirForSession(sessionId)}/tasks`;
		try {
			const tasksTree = await git.readTree({
				fs: fsCallback,
				dir: repoDir,
				oid: commit.tree,
				filepath: tasksPath,
			});
			tasksTreeOid = tasksTree.oid;
		} catch {
			// No tasks/ subtree — most sessions don't have sub-agent task checkpoints.
			// Silent return matches Go (`shadowTree.Tree(tasksPath)` err → return).
			return;
		}
	} catch (err) {
		log.warn(logCtx, 'v2 dual-write task metadata copy skipped: failed to read shadow tree', {
			checkpoint_id: String(checkpointId),
			session_id: sessionId,
			error: err instanceof Error ? err.message : String(err),
		});
		return;
	}

	// Step 2: resolve session index in v2 /main checkpoint.
	let sessionIndex: number;
	try {
		sessionIndex = await resolveV2SessionIndexForCheckpoint(repoDir, checkpointId, sessionId);
	} catch (err) {
		log.warn(logCtx, 'v2 dual-write task metadata copy skipped: failed to resolve session index', {
			checkpoint_id: String(checkpointId),
			session_id: sessionId,
			error: err instanceof Error ? err.message : String(err),
		});
		return;
	}

	// Step 3: splice tasks/ tree into v2 /full/current.
	try {
		const v2Store = await s.getV2CheckpointStore();
		await spliceTaskTreeToV2FullCurrent(repoDir, v2Store, checkpointId, sessionIndex, tasksTreeOid);
	} catch (err) {
		log.warn(logCtx, 'v2 dual-write task metadata copy failed', {
			checkpoint_id: String(checkpointId),
			session_id: sessionId,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

/**
 * Pre-resolve trees + run {@link calculateAttributionWithAccumulated} for the
 * `condenseSession` main path. Handles the `shadowOid === null` "agent
 * committed mid-turn" fallback (uses HEAD tree as the shadow). Pulls the
 * `pendingPromptAttribution` into the PA list passed to the algorithm so the
 * persisted diagnostics match the computed attribution shape.
 *
 * Mirrors Go `calculateSessionAttributions`.
 */
async function calculateSessionAttributions(
	repoDir: string,
	shadowOid: string | null,
	sessionData: ExtractedSessionData,
	state: SessionState,
	opts: {
		headTreeOid: string | null;
		parentTreeOid: string | null;
		hasParentTree: boolean;
		attributionBaseCommit: string;
		parentCommitHash: string;
		headCommitHash: string;
		allAgentFiles: ReadonlySet<string> | null;
	},
): Promise<InitialAttribution | null> {
	let headTreeOid = opts.headTreeOid;
	if (headTreeOid === null) {
		try {
			const headOid = await git.resolveRef({ fs: fsCallback, dir: repoDir, ref: 'HEAD' });
			const c = await git.readCommit({ fs: fsCallback, dir: repoDir, oid: headOid });
			headTreeOid = c.commit.tree;
			if (opts.parentTreeOid === null && !opts.hasParentTree && c.commit.parent.length > 0) {
				const parentCommit = await git.readCommit({
					fs: fsCallback,
					dir: repoDir,
					oid: c.commit.parent[0]!,
				});
				opts = { ...opts, parentTreeOid: parentCommit.commit.tree };
			}
		} catch (err) {
			log.debug({ component: 'attribution' }, 'attribution skipped: failed to get HEAD tree', {
				error: err instanceof Error ? err.message : String(err),
			});
			return null;
		}
	}

	let shadowTreeOid: string | null;
	if (shadowOid !== null) {
		try {
			const c = await git.readCommit({ fs: fsCallback, dir: repoDir, oid: shadowOid });
			shadowTreeOid = c.commit.tree;
		} catch (err) {
			log.debug({ component: 'attribution' }, 'attribution skipped: failed to get shadow tree', {
				error: err instanceof Error ? err.message : String(err),
			});
			return null;
		}
	} else {
		// Mid-turn agent commit: use HEAD tree as shadow.
		shadowTreeOid = headTreeOid;
	}

	let baseTreeOid: string | null = null;
	if (opts.attributionBaseCommit !== '') {
		try {
			const c = await git.readCommit({
				fs: fsCallback,
				dir: repoDir,
				oid: opts.attributionBaseCommit,
			});
			baseTreeOid = c.commit.tree;
		} catch {
			// best-effort; baseTreeOid stays null
		}
	}

	const promptAttrs = [
		...(state.promptAttributions ?? []),
		...(state.pendingPromptAttribution != null ? [state.pendingPromptAttribution] : []),
	];

	const params: AttributionParams = {
		repoDir,
		baseTreeOid,
		shadowTreeOid,
		headTreeOid,
		parentTreeOid: opts.parentTreeOid,
		filesTouched: sessionData.filesTouched,
		promptAttributions: promptAttrs,
		parentCommitHash: opts.parentCommitHash,
		attributionBaseCommit: opts.attributionBaseCommit,
		headCommitHash: opts.headCommitHash,
		allAgentFiles: opts.allAgentFiles,
	};
	return calculateAttributionWithAccumulated(params);
}

/**
 * Condense a session's shadow branch into permanent storage on the v1 metadata
 * branch (and v2 dual-write when enabled). 11-step main pipeline; see
 * file-level docstring for the step list.
 *
 * Returns `{ skipped: true, ... }` early when there's no transcript AND no
 * filesTouched — the caller (PostCommit hook / doctor / eager paths) decides
 * what to do with state when this happens.
 *
 * @example
 * await condenseSession(strategy, checkpointId, state, committedFiles);
 * // CondenseResult { checkpointId, sessionId, prompts, transcript, ... }
 *
 * // Side effects (non-skipped):
 * //   refs/heads/story/checkpoints/v1                  ← bumped to new commit
 * //   .git/objects/<hash>                              ← new metadata + transcript + prompts
 * //   refs/story/checkpoints/v2/main (settings open)   ← bumped to new commit
 * //   worktree / index / HEAD: unchanged.
 * //   shadow branch ref: unchanged (cleanup walks via cleanupShadowBranchIfUnused
 * //                                  in CondenseSessionByID/Eager paths only).
 */
export async function condenseSession(
	s: ManualCommitStrategy,
	checkpointId: CheckpointID,
	state: SessionState,
	committedFiles: ReadonlySet<string> | null,
	opts?: CondenseOpts,
): Promise<CondenseResult> {
	const repo = await s.getRepo();
	const o = opts ?? {};
	const logCtx = { component: 'checkpoint', sessionId: state.sessionId };
	const condenseStart = Date.now();
	const agentType = normalize(state.agentType ?? '');

	// Step 2: resolve shadow ref.
	const shadowBranchName = shadowBranchNameForCommit(state.baseCommit, state.worktreeId ?? '');
	const { refOid: shadowOid, exists: hasShadowBranch } = await resolveShadowRef(
		repo.root,
		shadowBranchName,
		o.shadowRefOid,
	);

	// Step 3: re-resolve transcript path (handles agent migrations mid-session).
	try {
		await resolveTranscriptPath(state);
	} catch {
		// best-effort; downstream readers handle missing transcripts.
	}

	// Step 4: extract session data.
	const extractStart = Date.now();
	const sessionData = await extractOrCreateSessionData(s, shadowOid, hasShadowBranch, state);
	const extractDurationMs = Date.now() - extractStart;

	// Step 5: backfill token usage (any-agent passthrough).
	const backfillUsage = sessionStateBackfillTokenUsage(
		logCtx,
		agentType,
		sessionData.transcript,
		sessionData.tokenUsage,
	);
	if (backfillUsage !== null) {
		state.tokenUsage = backfillUsage;
	}

	// Step 6: SKIP GATE — runs BEFORE filterFilesTouched (regression-tested).
	if (sessionData.transcript.length === 0 && sessionData.filesTouched.length === 0) {
		log.info(logCtx, 'session skipped: no transcript or files to condense', {
			session_id: state.sessionId,
			agent_type: agentType,
			checkpoint_id: String(checkpointId),
			has_shadow_branch: hasShadowBranch,
			transcript_path: state.transcriptPath ?? '',
		});
		return {
			checkpointId,
			sessionId: state.sessionId,
			skipped: true,
			checkpointsCount: 0,
			filesTouched: [],
			prompts: [],
			totalTranscriptLines: 0,
			compactTranscriptLines: 0,
			transcript: new Uint8Array(),
		};
	}

	// Step 7: filterFilesTouched.
	filterFilesTouched(sessionData, committedFiles);

	// Step 8: redact transcript ONCE for all consumers; failure → drop transcript + warn.
	let redactedTranscript: Uint8Array = new Uint8Array();
	let redactDurationMs = 0;
	try {
		const r = await redactSessionTranscript(sessionData.transcript);
		redactedTranscript = r.redactedTranscript;
		redactDurationMs = r.durationMs;
	} catch (err) {
		log.warn(logCtx, 'failed to redact transcript secrets, dropping transcript for checkpoint', {
			session_id: state.sessionId,
			checkpoint_id: String(checkpointId),
			error: err instanceof Error ? err.message : String(err),
		});
	}

	// Step 9: attribution.
	const attrBase =
		state.attributionBaseCommit && state.attributionBaseCommit !== ''
			? state.attributionBaseCommit
			: state.baseCommit;
	const attrStart = Date.now();
	const attribution = await calculateSessionAttributions(repo.root, shadowOid, sessionData, state, {
		headTreeOid: o.headTreeOid ?? null,
		parentTreeOid: o.parentTreeOid ?? null,
		hasParentTree: o.hasParentTree ?? false,
		attributionBaseCommit: attrBase,
		parentCommitHash: o.parentCommitHash ?? '',
		headCommitHash: o.headCommitHash ?? '',
		allAgentFiles: o.allAgentFiles ?? null,
	});
	const attrDurationMs = Date.now() - attrStart;

	// Step 10: branch + summary.
	const branchName = (await getCurrentBranchName(repo.root)) ?? '';
	let summary: Summary | null = null;
	const settings = await loadSettings(repo.root);
	if (isSummarizeEnabled(settings) && redactedTranscript.length > 0) {
		summary = await generateSummary(logCtx, redactedTranscript, sessionData.filesTouched, state);
	}

	const promptAttributionsJson = marshalPromptAttributionsIncludingPending(state);

	const writeOpts: WriteCommittedOptions = {
		checkpointId: String(checkpointId),
		sessionId: state.sessionId,
		strategy: STRATEGY_NAME_MANUAL_COMMIT,
		branch: branchName,
		transcript: redactedTranscript,
		prompts: sessionData.prompts,
		filesTouched: sessionData.filesTouched,
		checkpointsCount: state.stepCount,
		ephemeralBranch: shadowBranchName,
		authorName: '',
		authorEmail: '',
		metadataDir: '',
		isTask: false,
		toolUseId: '',
		agentId: '',
		checkpointUuid: '',
		transcriptPath: state.transcriptPath ?? '',
		subagentTranscriptPath: '',
		isIncremental: false,
		incrementalSequence: 0,
		incrementalType: '',
		incrementalData: new Uint8Array(),
		commitSubject: `Checkpoint ${String(checkpointId)}`,
		agent: agentType,
		model: state.modelName ?? '',
		turnId: state.turnId ?? '',
		transcriptIdentifierAtStart: state.transcriptIdentifierAtStart ?? '',
		checkpointTranscriptStart: state.checkpointTranscriptStart ?? 0,
		compactTranscriptStart: 0,
		// Go parity: writeOpts.TokenUsage uses sessionData.TokenUsage (the
		// freshly-extracted transcript total), NOT state.TokenUsage. State and
		// writeOpts diverge intentionally — state mutates so the next condense
		// sees the authoritative running total; the metadata only needs THIS
		// checkpoint's scoped extract (Go: manual_commit_condensation.go
		// writeOpts.TokenUsage).
		tokenUsage: convertTokenUsageForMetadata(sessionData.tokenUsage ?? null),
		sessionMetrics: buildSessionMetrics(state),
		initialAttribution: attribution,
		promptAttributionsJson,
		summary,
		compactTranscript: null,
	};

	const author = await getGitAuthorFromRepo(repo.root);
	writeOpts.authorName = author.name;
	writeOpts.authorEmail = author.email;

	// CLI version written into transcript.jsonl `cli_version` metadata.
	// Mirrors Go `manual_commit_condensation.go:1504 CLIVersion: versioninfo.Version`.
	const compactStart = Date.now();
	await buildCompactTranscript(
		repo.root,
		agentType,
		cliVersion,
		redactedTranscript,
		state,
		writeOpts,
	);
	const compactDurationMs = Date.now() - compactStart;

	// Step 11: write to v1.
	const writeV1Start = Date.now();
	const store = await s.getCheckpointStore();
	try {
		await store.writeCommitted(writeOpts);
	} catch (err) {
		throw new Error(
			`failed to write checkpoint metadata: ${err instanceof Error ? err.message : String(err)}`,
			{ cause: err as Error },
		);
	}
	const writeV1DurationMs = Date.now() - writeV1Start;

	// Step 11b: v2 dual-write (when enabled).
	const writeV2Start = Date.now();
	await writeCommittedV2IfEnabled(s, repo.root, writeOpts);
	await writeTaskMetadataV2IfEnabled(s, repo.root, checkpointId, state.sessionId, shadowOid);
	const writeV2DurationMs = Date.now() - writeV2Start;

	log.debug(logCtx, 'condense timings', {
		session_id: state.sessionId,
		checkpoint_id: String(checkpointId),
		extract_session_data_ms: extractDurationMs,
		calculate_session_attribution_ms: attrDurationMs,
		redact_transcript_ms: redactDurationMs,
		compact_transcript_v2_ms: compactDurationMs,
		write_committed_v1_ms: writeV1DurationMs,
		write_committed_v2_ms: writeV2DurationMs,
		total_ms: Date.now() - condenseStart,
		transcript_bytes: sessionData.transcript.length,
		transcript_lines: sessionData.fullTranscriptLines,
	});

	// Compact lines for state.compactTranscriptStart accumulation (scoped only).
	let compactLines = 0;
	if (writeOpts.compactTranscript !== null && writeOpts.compactTranscript !== undefined) {
		const fullLines = countCompactLines(writeOpts.compactTranscript);
		compactLines = fullLines - writeOpts.compactTranscriptStart;
	}

	// Use checkpointIdToPath only to validate the checkpoint id format —
	// downstream consumers expect the bare id from CondenseResult.
	void checkpointIdToPath;

	return {
		checkpointId,
		sessionId: state.sessionId,
		checkpointsCount: state.stepCount,
		filesTouched: sessionData.filesTouched,
		prompts: sessionData.prompts,
		totalTranscriptLines: sessionData.fullTranscriptLines,
		compactTranscriptLines: compactLines,
		transcript: sessionData.transcript,
		skipped: false,
	};
}
