/**
 * `hooks-turn-end.ts` — `Stop` agent hook entry for the manual-commit strategy.
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/strategy/manual_commit_hooks.go`:
 *   - `HandleTurnEnd` (the public hook entry method)
 *   - `finalizeAllTurnCheckpoints` (per-checkpoint transcript replacement)
 *
 * @packageDocumentation
 */

import { readFile } from 'node:fs/promises';
import * as caps from '@/agent/capabilities';
import * as registry from '@/agent/registry';
import { CHECKPOINT_ID_PATTERN, type CheckpointID, deserialize } from '@/id';
import * as log from '@/log';
import { redactJSONLBytes, redactString } from '@/redact';
import { isCheckpointsV2Enabled, load as loadSettings } from '@/settings/settings';
import { getLastPrompt, readPromptsFromShadowBranch } from './hooks-content-detection';
import type { ManualCommitStrategy } from './manual-commit';
import { resolveTranscriptPath } from './resolve-transcript';
import { readPromptsFromFilesystem } from './transcript-prompts';
import type { SessionState } from './types';

/**
 * Implements the `Stop` agent hook entry. Replaces the provisional transcript
 * in each checkpoint created during this turn (`state.turnCheckpointIds[]`)
 * with the full session transcript via {@link finalizeAllTurnCheckpoints}.
 *
 * Then advances `state.checkpointTranscriptStart` to the actual transcript end
 * after mid-turn commits — but **only when 3 AND conditions hold**:
 *   1. `hadMidTurnCommits` (snapshot of `state.turnCheckpointIds.length > 0`
 *      taken **before** finalize clears it)
 *   2. `state.transcriptPath !== ''`
 *   3. `state.filesTouched.length === 0` (no carry-forward in flight; carry-forward
 *      already reset `checkpointTranscriptStart=0` for self-contained transcripts)
 *
 * **Phase 6.1 Part 2**: agent registry is wired — the advance step now
 * dispatches via `registry.getByAgentType` + `caps.asTranscriptAnalyzer` +
 * `getTranscriptPosition`, advancing `checkpointTranscriptStart` whenever
 * `pos > current`. Agents without `TranscriptAnalyzer` (e.g., Vogon) still
 * skip advance silently.
 *
 * Always best-effort: errors are logged but never thrown to the agent.
 *
 * Mirrors Go `manual_commit_hooks.go: HandleTurnEnd`.
 *
 * @example
 * await handleTurnEndImpl(strategy, state);
 *
 * // Side effects (per cpID in state.turnCheckpointIds, when finalize succeeds):
 * //   refs/heads/story/checkpoints/v1                ← rewritten with full transcript
 * //   refs/story/checkpoints/v2/main (v2 enabled)    ← dual-write
 * //   state.turnCheckpointIds                        ← cleared (always)
 * //   state.checkpointTranscriptStart                ← advances when registered
 * //                                                    agent's analyzer reports
 * //                                                    pos > current start
 * //
 * // HEAD / index / worktree: unchanged.
 */
export async function handleTurnEndImpl(
	s: ManualCommitStrategy,
	state: SessionState,
): Promise<void> {
	const hadMidTurnCommits = (state.turnCheckpointIds ?? []).length > 0;

	const errCount = await finalizeAllTurnCheckpoints(s, state);
	if (errCount > 0) {
		log.warn(
			{ component: 'checkpoint', sessionId: state.sessionId },
			'HandleTurnEnd completed with errors (best-effort)',
			{ error_count: errCount },
		);
	}

	// Advance CheckpointTranscriptStart after mid-turn commits — 3 AND conditions:
	//   1. hadMidTurnCommits
	//   2. state.transcriptPath !== ''
	//   3. state.filesTouched.length === 0 (no carry-forward in flight)
	const filesTouched = state.filesTouched ?? [];
	if (
		hadMidTurnCommits &&
		state.transcriptPath !== undefined &&
		state.transcriptPath !== '' &&
		filesTouched.length === 0
	) {
		// Phase 6.1 Part 2: full 5-step Go-aligned mid-turn advance.
		// Mirrors Go `manual_commit_hooks.go:2546-2563` (HandleTurnEnd
		// post-condition advance). Failures at any step → silently skip
		// (state.checkpointTranscriptStart unchanged).
		let transcriptPath: string;
		try {
			transcriptPath = await resolveTranscriptPath(state);
		} catch {
			return;
		}
		const ag = registry.getByAgentType(state.agentType ?? '');
		if (ag === null) {
			return;
		}
		const [analyzer, hasAnalyzer] = caps.asTranscriptAnalyzer(ag);
		if (!hasAnalyzer) {
			return;
		}
		try {
			const pos = await analyzer.getTranscriptPosition(transcriptPath);
			if (pos > (state.checkpointTranscriptStart ?? 0)) {
				state.checkpointTranscriptStart = pos;
			}
		} catch {
			// Keep previous checkpointTranscriptStart on analyzer error.
		}
	}
}

/**
 * Iterate `state.turnCheckpointIds`, replacing each checkpoint's transcript
 * with the freshly-read full session transcript.
 *
 * **5 fail-fast branches** each clear `turnCheckpointIds` and return errCount=1:
 *   1. `transcriptPath === ''` → return 1
 *   2. `resolveTranscriptPath()` throws → return 1
 *   3. `readFile()` throws OR returns empty → return 1
 *   4. (per-cpID) invalid checkpoint ID → errCount++ continue
 *   5. (per-cpID) `store.updateCommitted` throws → errCount++ continue
 *
 * Redaction failure is **NOT** a fail-fast — drops transcript but keeps
 * writing metadata (attribution / filesTouched / prompts) so we don't lose
 * everything just because one secret pattern panicked.
 *
 * Mirrors Go `manual_commit_hooks.go: finalizeAllTurnCheckpoints`.
 *
 * @returns errCount — 0 means all checkpoints succeeded; ≥1 means some / all
 *   failed (caller `handleTurnEndImpl` only logs the aggregate, never propagates).
 */
export async function finalizeAllTurnCheckpoints(
	s: ManualCommitStrategy,
	state: SessionState,
): Promise<number> {
	const turnCheckpointIds = state.turnCheckpointIds ?? [];
	if (turnCheckpointIds.length === 0) {
		return 0; // Branch 0: no work
	}

	const logCtx = { component: 'checkpoint', sessionId: state.sessionId };
	log.info(logCtx, 'finalizing turn checkpoints with full transcript', {
		checkpoint_count: turnCheckpointIds.length,
	});

	// Branch 1: transcriptPath empty
	if (!state.transcriptPath || state.transcriptPath === '') {
		log.warn(logCtx, 'finalize: no transcript path, skipping');
		state.turnCheckpointIds = [];
		return 1;
	}

	// Branch 2: resolveTranscriptPath fails
	let transcriptPath: string;
	try {
		transcriptPath = await resolveTranscriptPath(state);
	} catch (err) {
		log.warn(logCtx, 'finalize: transcript path resolution failed, skipping', {
			error: (err as Error).message,
		});
		state.turnCheckpointIds = [];
		return 1;
	}

	// Branch 3: readFile fails OR empty
	let fullTranscript: Uint8Array;
	try {
		fullTranscript = await readFile(transcriptPath);
	} catch (err) {
		log.warn(logCtx, 'finalize: failed to read transcript, skipping', {
			transcript_path: state.transcriptPath,
			error: (err as Error).message,
		});
		state.turnCheckpointIds = [];
		return 1;
	}
	if (fullTranscript.length === 0) {
		log.warn(logCtx, 'finalize: empty transcript, skipping', {
			transcript_path: state.transcriptPath,
		});
		state.turnCheckpointIds = [];
		return 1;
	}

	// Branch 4: openRepository fails
	let repo: Awaited<ReturnType<ManualCommitStrategy['getRepo']>>;
	try {
		repo = await s.getRepo();
	} catch (err) {
		log.warn(logCtx, 'finalize: failed to open repository', { error: (err as Error).message });
		state.turnCheckpointIds = [];
		return 1;
	}

	// Read prompts: shadow branch first, fallback to filesystem.
	let prompts = (await readPromptsFromShadowBranch(repo.root, state)) ?? [];
	if (prompts.length === 0) {
		prompts = (await readPromptsFromFilesystem(state.sessionId, repo.root)) ?? [];
	}
	// Last-resort: getLastPrompt fallback (same shadow tree, single entry).
	// Go doesn't do this — kept as a no-op when readPromptsFromShadowBranch failed.
	void getLastPrompt;

	// Redact transcript — drop on failure but keep going (best-effort).
	let redactedTranscript: Uint8Array;
	try {
		const result = await redactJSONLBytes(fullTranscript);
		redactedTranscript = result.bytes;
	} catch (err) {
		log.warn(logCtx, 'finalize: transcript redaction failed, dropping transcript', {
			error: (err as Error).message,
		});
		redactedTranscript = new Uint8Array(0);
	}
	const redactedPrompts = await Promise.all(prompts.map((p) => redactString(p)));

	const store = await s.getCheckpointStore();

	// Eval v2 flag once before loop (matches Go optimization).
	let v2Enabled = false;
	try {
		const settings = await loadSettings(repo.root);
		v2Enabled = isCheckpointsV2Enabled(settings);
	} catch {
		// non-fatal: treat as disabled
	}
	let v2Store: Awaited<ReturnType<ManualCommitStrategy['getV2CheckpointStore']>> | null = null;
	if (v2Enabled) {
		try {
			v2Store = await s.getV2CheckpointStore();
		} catch {
			v2Store = null;
		}
	}

	let errCount = 0;
	for (const cpIdStr of turnCheckpointIds) {
		// Branch 4 (per-cpID): parse failure
		if (!CHECKPOINT_ID_PATTERN.test(cpIdStr)) {
			log.warn(logCtx, 'finalize: invalid checkpoint ID, skipping', {
				checkpoint_id: cpIdStr,
			});
			errCount++;
			continue;
		}
		const cpId: CheckpointID = deserialize(cpIdStr);

		const updateOpts = {
			checkpointId: cpId,
			sessionId: state.sessionId,
			transcript: redactedTranscript,
			prompts: redactedPrompts,
			agent: state.agentType ?? '',
			// Phase 6.1 Part 2 keeps `compactTranscript: null` — the
			// `compactTranscriptForV2` builder (Go: manual_commit_condensation.go)
			// is agent-specific (per-agent transcript rewriting) and lands when
			// each Phase 6.2-6.4 agent ships its `TranscriptAnalyzer.buildCompact`.
			// This matches Go's fail-open path at `finalizeAllTurnCheckpoints:2693`
			// where `ag` may be nil.
			compactTranscript: null,
		};

		// Branch 5 (per-cpID): updateCommitted failure
		try {
			await store.updateCommitted(updateOpts);
		} catch (err) {
			log.warn(logCtx, 'finalize: failed to update checkpoint', {
				checkpoint_id: cpIdStr,
				error: (err as Error).message,
			});
			errCount++;
			continue;
		}

		// V2 dual-write (warn-only on failure — does NOT count toward errCount)
		if (v2Store !== null) {
			try {
				await v2Store.updateCommitted(updateOpts);
			} catch (err) {
				log.warn(logCtx, 'v2 dual-write update failed', {
					checkpoint_id: cpIdStr,
					error: (err as Error).message,
				});
			}
		}

		log.info(logCtx, 'finalize: checkpoint updated with full transcript', {
			checkpoint_id: cpIdStr,
		});
	}

	// Clear turn checkpoint IDs. Do NOT modify checkpointTranscriptStart here
	// — that's handled by the outer handleTurnEndImpl, after this returns.
	state.turnCheckpointIds = [];
	return errCount;
}
