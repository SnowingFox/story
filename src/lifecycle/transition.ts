/**
 * Turn-end phase transition — dispatches turn-end actions to the active
 * strategy, then saves the session state.
 *
 * Mirrors Go `cmd/entire/cli/lifecycle.go`
 * (`transitionSessionTurnEnd`).
 *
 * The function is intentionally fail-open: every step either swallows its
 * error (with a `log.warn`) or silently returns. The only path that does
 * NOT save session state is when state was never loaded in the first place
 * (either because it's missing on disk or because `loadSessionState`
 * itself threw).
 *
 * @packageDocumentation
 */

import type { Event } from '@/agent/event';
import * as log from '@/log';
import { NoOpActionHandler, Event as PhaseEvent, type TransitionContext } from '@/session/phase';
import type { SessionState } from '@/session/state-store';
import { ManualCommitStrategy } from '@/strategy/manual-commit';
import { loadSessionState, saveSessionState, transitionAndLog } from '@/strategy/session-state';
import { persistEventMetadataToState } from './dispatch-helpers';
import { loadPrePromptState } from './pre-prompt-state';

/**
 * Transition a session through `TurnEnd` and dispatch strategy-level
 * actions. Used at the tail of {@link handleTurnEnd} (both the happy-path
 * checkpoint branch and the no-changes branch).
 *
 * Steps (all fail-open except the early "state missing" silent return):
 *
 * 1. {@link loadSessionState} — on error, `log.warn` + silent return.
 * 2. `null` state → silent return (Go parity; mirrors
 *    `lifecycle.go if turnState == nil { return }`).
 * 3. Story-led timing metrics are updated: `sessionDurationMs` keeps wall-clock
 *    span while `activeDurationMs` sums normalized TurnStart → TurnEnd spans.
 * 4. {@link persistEventMetadataToState} merges hook-provided metrics
 *    (model, tokens, turn-count) into state.
 *    Agent-provided `durationMs` remains authoritative for wall-clock span.
 * 5. {@link transitionAndLog} fires `PhaseEvent.TurnEnd` with
 *    {@link NoOpActionHandler} (Go parity — no strategy actions on
 *    turn-end). Failures `log.warn` + continue.
 * 6. {@link ManualCommitStrategy.handleTurnEnd} runs strategy-level
 *    turn-end work (reading TurnCheckpointIDs / etc.). Failures
 *    `log.warn` + continue to save.
 * 7. {@link saveSessionState} — failures `log.warn` + resolve (session
 *    may have already mutated in-memory; saving is best-effort here so
 *    we don't retroactively block the user's agent turn).
 *
 * @example
 * await transitionSessionTurnEnd('sid-1', {
 *   type: 'TurnEnd',
 *   sessionId: 'sid-1',
 *   model: 'claude-sonnet-4.6',
 *   // ...zero-value other fields
 * } as Event);
 *
 * // Side effects (existing state on disk):
 * //   .git/story-sessions/sid-1.json   ← phase=idle + merged metrics
 * //   refs/heads/story/<shadow>/...    ← may bump via strategy.handleTurnEnd
 * //   Worktree / index / HEAD:         unchanged
 */
export async function transitionSessionTurnEnd(sessionID: string, event: Event): Promise<void> {
	const logCtx = {
		component: 'lifecycle',
		sessionId: sessionID,
		agent: event.metadata?.agent ?? 'unknown',
	};

	let turnState = null;
	try {
		turnState = await loadSessionState(sessionID);
	} catch (err) {
		log.warn(logCtx, 'failed to load session state for turn end', {
			error: (err as Error).message,
		});
		return;
	}
	if (!turnState) {
		return;
	}

	await updateTurnTimingMetrics(turnState, event, logCtx);
	persistEventMetadataToState(event, turnState);

	const transCtx: TransitionContext = { hasFilesTouched: false, isRebaseInProgress: false };
	try {
		await transitionAndLog(turnState, PhaseEvent.TurnEnd, transCtx, new NoOpActionHandler());
	} catch (err) {
		log.warn(logCtx, 'turn-end transition failed', {
			error: (err as Error).message,
		});
	}

	try {
		const strategy = new ManualCommitStrategy();
		await strategy.handleTurnEnd(turnState);
	} catch (err) {
		log.warn(logCtx, 'turn-end action dispatch failed', {
			error: (err as Error).message,
		});
	}

	try {
		await saveSessionState(turnState);
	} catch (err) {
		log.warn(logCtx, 'failed to update session phase on turn end', {
			error: (err as Error).message,
		});
	}
}

/**
 * Update Story-owned timing metrics before the turn-end state transition.
 *
 * Story-led divergence: Go Entire CLI does not persist per-turn metrics.
 * Story records wall-clock session span separately from active agent time so
 * Cursor-like agents without transcript timestamps can still display response
 * durations.
 */
async function updateTurnTimingMetrics(
	state: SessionState,
	event: Event,
	logCtx: Record<string, unknown>,
): Promise<void> {
	const wallDurationMs = event.timestamp.getTime() - new Date(state.startedAt).getTime();
	if (Number.isFinite(wallDurationMs) && wallDurationMs >= 0) {
		state.sessionDurationMs = wallDurationMs;
	}

	let preState = null;
	try {
		preState = await loadPrePromptState(state.sessionId);
	} catch (err) {
		log.warn(logCtx, 'failed to load pre-prompt state for turn timing', {
			error: (err as Error).message,
		});
		return;
	}
	if (preState === null) {
		return;
	}

	const turnDurationMs = event.timestamp.getTime() - preState.startTime.getTime();
	if (!Number.isFinite(turnDurationMs) || turnDurationMs < 0) {
		log.warn(logCtx, 'skipping negative turn duration metric', {
			durationMs: turnDurationMs,
			startedAt: preState.startTime.toISOString(),
			endedAt: event.timestamp.toISOString(),
		});
		return;
	}

	const previousMetrics = state.turnMetrics ?? [];
	const nextTurnIndex = previousMetrics.length + 1;
	const turnId = state.turnId ?? event.metadata.turn_id ?? `${state.sessionId}:${nextTurnIndex}`;
	const turnMetric = {
		turnId,
		startedAt: preState.startTime.toISOString(),
		endedAt: event.timestamp.toISOString(),
		durationMs: turnDurationMs,
	};
	state.turnMetrics = [...previousMetrics, turnMetric];
	state.activeDurationMs = state.turnMetrics.reduce((sum, metric) => sum + metric.durationMs, 0);
}
