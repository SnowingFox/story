/**
 * Compaction handler — fires when an agent compresses its own transcript
 * (Claude Code `/compact`; Cursor internal context rollup; Gemini
 * pre-compress). The transcript's line numbering after compaction no
 * longer matches pre-compaction, so Story must re-anchor its
 * transcript-offset baseline.
 *
 * **Story-side divergence from Go** (intentional feature, not bug;
 * reconfirmed in Phase 7 review 2): Go's `handleLifecycleCompaction`
 * **preserves** `CheckpointTranscriptStart` because Gemini fires
 * pre-compress as a no-op after every tool call
 * (`lifecycle_test.go: TestHandleLifecycleCompaction_PreservesTranscriptOffset`
 * explicitly locks `CheckpointTranscriptStart === 50`).
 *
 * Story extends the semantics: **re-snapshot**
 * {@link SessionState.transcriptOffset} via
 * {@link TranscriptAnalyzer.getTranscriptPosition} and bump
 * {@link SessionState.compactionCount}. This is load-bearing for
 * [Phase 5.3 condensation](../../../docs/ts-rewrite/impl/phase-5-strategy/phase-5.3-condensation/module.md) —
 * without re-anchoring the lifecycle's `transcriptOffset`, the next
 * `TurnEnd` re-parses the transcript prefix that compaction already
 * dropped, producing duplicate condensation rows. Phase 9 analytics also
 * surfaces "frequently-compacting" sessions via `compactionCount`.
 *
 * **The field separation matters**: `checkpointTranscriptStart` is
 * owned by the condensation pipeline and MUST persist across compaction
 * (so Story preserves it too, matching Go). The Phase 7-introduced
 * `transcriptOffset` field is owned by the lifecycle pipeline and is
 * what gets re-anchored here.
 *
 * Steps:
 * 1. Load session state; silent-skip with debug log when missing.
 * 2. Query `asTranscriptAnalyzer(ag).getTranscriptPosition(sessionRef)` for
 *    the post-compaction transcript length. Analyzer errors fall back to
 *    `0` with `log.warn`; agents that don't implement TranscriptAnalyzer
 *    also get `0`.
 * 3. Write new offset + bump `compactionCount`.
 * 4. Persist event metadata (model, tokens, turn-count — see
 *    {@link persistEventMetadataToState}).
 * 5. {@link transitionAndLog} with {@link PhaseEvent.Compaction} +
 *    {@link NoOpActionHandler} (Go parity — `lifecycle.go`; stays in
 *    ACTIVE phase, no strategy actions). Failures are `log.warn`-ed and
 *    DO NOT block the save (matches Go fail-open transition handling).
 * 6. `saveSessionState` — failures propagate (non-fail-open, consistent
 *    with `model-update`).
 *
 * @packageDocumentation
 */

import { asTranscriptAnalyzer } from '@/agent/capabilities';
import type { Event } from '@/agent/event';
import type { Agent } from '@/agent/interfaces';
import * as log from '@/log';
import { NoOpActionHandler, Event as PhaseEvent, type TransitionContext } from '@/session/phase';
import { loadSessionState, saveSessionState, transitionAndLog } from '@/strategy/session-state';
import { persistEventMetadataToState, UNKNOWN_SESSION_ID } from '../dispatch-helpers';

/**
 * Compaction lifecycle handler. Mirrors Go `lifecycle.go`
 * `handleLifecycleCompaction` (with the TS-divergence documented above).
 *
 * @example
 * await handleCompaction(claudeAgent, {
 *   type: 'Compaction',
 *   sessionId: 'sid-1',
 *   sessionRef: '/Users/me/.claude/projects/foo/sid-1.jsonl',
 *   // ...zero-value other fields
 * });
 *
 * // Side effects (existing state on disk, analyzer returns N):
 * //   .git/story-sessions/sid-1.json
 * //     transcriptOffset → N
 * //     compactionCount → (prev ?? 0) + 1
 * //     modelName / contextTokens / ... → merged from event
 * //   Worktree / index / HEAD: unchanged.
 */
export async function handleCompaction(ag: Agent, event: Event): Promise<void> {
	const sessionID = event.sessionId || UNKNOWN_SESSION_ID;
	const logCtx = { component: 'lifecycle', hook: 'compaction', agent: ag.name() };
	log.info(logCtx, 'compaction', {
		event: event.type,
		sessionId: sessionID,
	});

	let state = null;
	try {
		state = await loadSessionState(sessionID);
	} catch (e) {
		log.warn(logCtx, 'failed to load session state for compaction', {
			error: (e as Error).message,
		});
	}

	if (!state) {
		log.debug(logCtx, 'session state missing for compaction', { sessionId: sessionID });
		return;
	}

	let newOffset = 0;
	const [ta, hasTA] = asTranscriptAnalyzer(ag);
	if (hasTA && ta && event.sessionRef) {
		try {
			newOffset = await ta.getTranscriptPosition(event.sessionRef);
		} catch (e) {
			log.warn(logCtx, 'failed to re-read transcript position after compaction', {
				error: (e as Error).message,
			});
			newOffset = 0;
		}
	}

	state.transcriptOffset = newOffset;
	state.compactionCount = (state.compactionCount ?? 0) + 1;
	persistEventMetadataToState(event, state);

	const transCtx: TransitionContext = { hasFilesTouched: false, isRebaseInProgress: false };
	try {
		await transitionAndLog(state, PhaseEvent.Compaction, transCtx, new NoOpActionHandler());
	} catch (e) {
		log.warn(logCtx, 'compaction transition failed', {
			error: (e as Error).message,
		});
	}

	await saveSessionState(state);

	log.info(logCtx, 'compaction handled', {
		sessionId: sessionID,
		transcriptOffset: newOffset,
		compactionCount: state.compactionCount,
	});
}
