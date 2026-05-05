/**
 * Stand-alone helpers used by the condensation pipeline. Eight independent
 * utilities that do not own algorithm state; they're factored out of
 * {@link condenseSession} for unit-testability and reuse by the doctor / eager
 * variants.
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/strategy/manual_commit_condensation.go`
 * (`filterFilesTouched` / `committedFilesExcludingMetadata` /
 * `marshalPromptAttributionsIncludingPending` / `buildSessionMetrics` /
 * `sessionStateBackfillTokenUsage` / `cleanupShadowBranchIfUnused` /
 * `resolveShadowRef` / `redactSessionTranscript`).
 *
 * @packageDocumentation
 */

import fsCallback from 'node:fs';
import git from 'isomorphic-git';
import { shadowBranchNameForCommit } from '../checkpoint/temporary';
import type { SessionMetrics } from '../checkpoint/types';
import type { LogContext } from '../log';
import { STORY_METADATA_DIR_NAME } from '../paths';
import { redactJSONLBytes } from '../redact';
import type { TokenUsage } from '../session/state-store';
import { deleteBranchCli, ErrBranchNotFound } from './branches';
import type { ManualCommitStrategy } from './manual-commit';
import { listAllSessionStates } from './manual-commit-session';
import type { AgentType, ExtractedSessionData, PromptAttribution, SessionState } from './types';

/**
 * Narrow `sessionData.filesTouched` to the intersection with `committedFiles`.
 * When `filesTouched` is empty (mid-turn commit, before SaveStep ran), fall
 * back to `committedFilesExcludingMetadata(committedFiles)` so the checkpoint
 * still reflects what this commit captured.
 *
 * **Mutates `sessionData` in place** (Go parity: `func filterFilesTouched(sessionData *ExtractedSessionData, ...)`).
 *
 * **Ordering invariant**: must be called AFTER the skip gate in
 * {@link condenseSession}. Calling it earlier would let the fallback assign
 * committedFiles to a genuinely empty session and bypass the gate (regression
 * test: `condense_skip_test.go: TestCondenseSession_SkipsEmptySessionEvenWithCommittedFiles`).
 *
 * @example
 * filterFilesTouched(data, new Set(['a', 'b']));
 * // data.filesTouched = previous ∩ {a, b}, mutated in place.
 *
 * // Side effects: mutates `sessionData.filesTouched`.
 * // Disk / git refs / HEAD: unchanged.
 */
export function filterFilesTouched(
	sessionData: ExtractedSessionData,
	committedFiles: ReadonlySet<string> | null,
): void {
	if (committedFiles === null || committedFiles.size === 0) {
		return;
	}
	if (sessionData.filesTouched.length > 0) {
		const filtered: string[] = [];
		for (const f of sessionData.filesTouched) {
			if (committedFiles.has(f)) {
				filtered.push(f);
			}
		}
		sessionData.filesTouched = filtered;
		return;
	}
	sessionData.filesTouched = committedFilesExcludingMetadata(committedFiles);
}

/**
 * Filter Story / Entire metadata paths out of `committedFiles`, then sort
 * lexicographically. Used by the {@link filterFilesTouched} mid-turn fallback
 * so the checkpoint records the user's actual commit rather than CLI metadata
 * scribbles.
 *
 * **Two-prefix rationale** (mirrors {@link isAgentOrMetadataFile} in
 * `attribution.ts`): Go's
 * [`committedFilesExcludingMetadata`](../../entire-cli/cmd/entire/cli/strategy/manual_commit_condensation.go)
 * filters `.entire/` only (Entire's own metadata namespace). Story extends to
 * `.story/` (its own namespace via {@link STORY_METADATA_DIR_NAME}) AND keeps
 * `.entire/` as a safety net for users migrating from Entire CLI — legacy
 * `.entire/` files in a Story-managed repo are not "user work" and shouldn't
 * leak into the checkpoint's filesTouched. The extra string comparison is
 * cheap; the benefit is correct cross-tool behavior.
 *
 * @example
 * committedFilesExcludingMetadata(new Set(['c', '.story/x', 'a', '.entire/y']));
 * // ['a', 'c']
 *
 * // Side effects: none — pure set/filter/sort.
 */
export function committedFilesExcludingMetadata(committedFiles: ReadonlySet<string>): string[] {
	void STORY_METADATA_DIR_NAME; // imported for cross-reference; broader '.story/' suffices below.
	const result: string[] = [];
	for (const f of committedFiles) {
		if (f.startsWith('.entire/') || f.startsWith('.story/')) {
			continue;
		}
		result.push(f);
	}
	result.sort();
	return result;
}

/**
 * Build the full PromptAttribution slice (including the in-flight
 * `pendingPromptAttribution` for mid-turn commits) and return it as a JS array.
 * Returns `null` when there's nothing to record. Caller hands the result to
 * the metadata serializer, which encodes snake_case keys.
 *
 * **Consistency requirement**: must use the same array shape as the slice
 * passed to `calculateSessionAttributions` so the persisted diagnostics match
 * the computed `InitialAttribution`.
 *
 * @example
 * marshalPromptAttributionsIncludingPending({ promptAttributions: [pa1], pendingPromptAttribution: pa2, ... })
 * // [pa1, pa2]
 *
 * // Side effects: none — pure inspection.
 */
export function marshalPromptAttributionsIncludingPending(
	state: SessionState,
): PromptAttribution[] | null {
	const list: PromptAttribution[] = [];
	for (const pa of state.promptAttributions ?? []) {
		list.push(pa);
	}
	if (state.pendingPromptAttribution != null) {
		list.push(state.pendingPromptAttribution);
	}
	if (list.length === 0) {
		return null;
	}
	return list;
}

/**
 * Extract hook-provided and Story-owned session metrics.
 *
 * Returns `null` when all metric fields are empty — this matches Go's "no
 * metrics ⇒ omit field" encoding for agents that don't report them.
 * Story-led divergence: Go Entire CLI does not persist per-turn metrics; Story
 * adds active duration and turn metrics as forward-compatible metadata.
 *
 * @example
 * buildSessionMetrics(stateWithDurationMs5000)
 * // { durationMs: 5000, turnCount: 0, contextTokens: 0, contextWindowSize: 0 }
 *
 * buildSessionMetrics(stateWithTurnMetrics)
 * // {
 * //   durationMs: 120000,
 * //   activeDurationMs: 45000,
 * //   turnMetrics: [{ turnId: 'turn-1', startedAt: '...', endedAt: '...', durationMs: 45000 }],
 * //   turnCount: 0,
 * //   contextTokens: 0,
 * //   contextWindowSize: 0,
 * // }
 *
 * // Side effects: none — pure inspection.
 */
export function buildSessionMetrics(state: SessionState): SessionMetrics | null {
	const dur = state.sessionDurationMs ?? 0;
	const turn = state.sessionTurnCount ?? 0;
	const active = state.activeDurationMs ?? 0;
	const turnMetrics = state.turnMetrics ?? [];
	const ctx = state.contextTokens ?? 0;
	const ctxWin = state.contextWindowSize ?? 0;
	if (
		dur === 0 &&
		turn === 0 &&
		active === 0 &&
		turnMetrics.length === 0 &&
		ctx === 0 &&
		ctxWin === 0
	) {
		return null;
	}
	const out: SessionMetrics = {
		durationMs: dur,
		turnCount: turn,
		contextTokens: ctx,
		contextWindowSize: ctxWin,
	};
	if (active > 0) {
		out.activeDurationMs = active;
	}
	if (turnMetrics.length > 0) {
		out.turnMetrics = turnMetrics;
	}
	return out;
}

/** True when `usage` carries any non-zero counter (recursive into subagent tokens). */
function hasTokenUsageData(usage: TokenUsage | null | undefined): boolean {
	if (usage == null) {
		return false;
	}
	if (
		usage.inputTokens > 0 ||
		usage.cacheCreationTokens > 0 ||
		usage.cacheReadTokens > 0 ||
		usage.outputTokens > 0 ||
		usage.apiCallCount > 0
	) {
		return true;
	}
	return hasTokenUsageData(usage.subagentTokens);
}

/**
 * Choose the best session-level token usage to persist after condensation.
 *
 * **Dropped**: the Copilot CLI special-case (`session.shutdown` full-session
 * reparse from Go arms 1+2) was removed when Phase 6.6 was dropped from the
 * roadmap — see [`references/dropped-agents.md`](../../docs/ts-rewrite/impl/references/dropped-agents.md).
 * Arms 3+4 (any-agent passthrough + null fallback) cover all remaining
 * agents.
 *
 * **Arms** (originally Go `manual_commit_condensation.go:519-545` arms 3+4):
 *
 * 1. **Any agent + checkpoint has data** → return checkpoint usage. Uses
 *    {@link hasTokenUsageData} (recursive 5-counter check) NOT a
 *    single-field check, so cached-only requests (`inputTokens=0` +
 *    `cacheReadTokens>0`) and output-only responses survive correctly.
 * 2. **Otherwise** → null.
 *
 * @example
 * sessionStateBackfillTokenUsage(ctx, 'Claude Code', new Uint8Array(), checkpointUsage)
 * // → checkpointUsage (passthrough via arm 1)
 *
 * sessionStateBackfillTokenUsage(ctx, 'Cursor', empty, { inputTokens: 0, outputTokens: 100, cacheReadTokens: 50, ... })
 * // → checkpointUsage (arm 1 — hasTokenUsageData true even when inputTokens=0)
 *
 * // Side effects: none — pure inspection.
 */
export function sessionStateBackfillTokenUsage(
	_logCtx: LogContext,
	_agentType: AgentType,
	_transcript: Uint8Array,
	checkpointUsage: TokenUsage | null,
): TokenUsage | null {
	// Arm 1 (Go:532-534): any agent + checkpoint has data. Uses
	// hasTokenUsageData (recursive 5-counter check) NOT inputTokens > 0; the
	// latter would lose data on cached-only / output-only / subagent-only
	// checkpoints.
	if (hasTokenUsageData(checkpointUsage)) {
		return checkpointUsage;
	}

	// Arm 2 (Go:535): null.
	return null;
}

/**
 * Delete the shadow branch when no other live session references it. Iterates
 * `listAllSessionStates`, skips the caller's own session, and bails when any
 * other session shares the same shadow branch name and has at least one
 * checkpoint. Otherwise removes the branch via the CLI helper.
 *
 * `ErrBranchNotFound` is silently absorbed (idempotent — branch may have been
 * cleaned up out-of-band). Other errors propagate so the caller can decide
 * whether to warn-and-continue or escalate.
 *
 * @example
 * await cleanupShadowBranchIfUnused(strategy, repoDir, 'story/abc1234-abcdef', 'sess-1');
 *
 * // Side effects:
 * //   refs/heads/story/abc1234-abcdef ← removed when no other session needs it
 * //   (no-op when another session is still active on the same branch).
 * // Disk for unrelated session state files / HEAD / worktree: unchanged.
 */
export async function cleanupShadowBranchIfUnused(
	s: ManualCommitStrategy,
	repoDir: string,
	shadowBranchName: string,
	excludeSessionId: string,
): Promise<void> {
	void s;
	let allStates: SessionState[];
	try {
		allStates = await listAllSessionStates(repoDir);
	} catch (err) {
		throw new Error(
			`failed to list session states: ${err instanceof Error ? err.message : String(err)}`,
			{ cause: err as Error },
		);
	}

	for (const state of allStates) {
		if (state.sessionId === excludeSessionId) {
			continue;
		}
		const otherShadow = shadowBranchNameForCommit(state.baseCommit, state.worktreeId ?? '');
		if (otherShadow === shadowBranchName && state.stepCount > 0) {
			return;
		}
	}

	try {
		await deleteBranchCli(shadowBranchName, repoDir);
	} catch (err) {
		if (err === ErrBranchNotFound) {
			return;
		}
		throw err;
	}
}

/**
 * Resolve the shadow branch ref. Accepts a pre-resolved OID for callers that
 * already read the branch (PostCommit / `condenseSession` opts). Otherwise
 * runs `git.resolveRef('refs/heads/<branchName>')` and reports
 * `{ refOid: null, exists: false }` on any failure (missing ref / corrupt
 * repo / etc.) — callers downstream rely on the boolean to choose between the
 * shadow-branch and live-transcript extraction paths.
 *
 * @example
 * await resolveShadowRef(repoDir, 'story/abc1234-abcdef');
 * // { refOid: 'aabb…', exists: true }
 * // { refOid: null,    exists: false }   when the ref is gone
 *
 * // Side effects: none — read-only ref lookup.
 */
export async function resolveShadowRef(
	repoDir: string,
	branchName: string,
	preResolvedOid?: string | null,
): Promise<{ refOid: string | null; exists: boolean }> {
	if (preResolvedOid != null && preResolvedOid !== '') {
		return { refOid: preResolvedOid, exists: true };
	}
	try {
		const oid = await git.resolveRef({
			fs: fsCallback,
			dir: repoDir,
			ref: `refs/heads/${branchName}`,
		});
		return { refOid: oid, exists: true };
	} catch {
		return { refOid: null, exists: false };
	}
}

/**
 * Run JSONL-aware secret + PII redaction over the transcript bytes for the v1
 * + v2 metadata writers. Empty input short-circuits to empty bytes (no
 * redaction overhead). Other failures propagate so the condense main path can
 * decide between "drop transcript / continue with metadata" (Go behavior) and
 * "fail the condense entirely" (debug only).
 *
 * Returns `{ redactedTranscript, durationMs }` so the caller can include the
 * redaction time in its perf log.
 *
 * @example
 * await redactSessionTranscript(transcriptBytes);
 * // { redactedTranscript: Uint8Array, durationMs: 12 }
 *
 * // Side effects: none — pure transformation. The redactor itself is
 * // deterministic for a given input.
 */
export async function redactSessionTranscript(
	transcript: Uint8Array,
): Promise<{ redactedTranscript: Uint8Array; durationMs: number }> {
	const start = performance.now();
	if (transcript.length === 0) {
		return { redactedTranscript: new Uint8Array(), durationMs: performance.now() - start };
	}
	const { bytes } = await redactJSONLBytes(transcript);
	return { redactedTranscript: bytes, durationMs: performance.now() - start };
}
