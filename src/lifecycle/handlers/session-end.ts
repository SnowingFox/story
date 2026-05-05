/**
 * SessionEnd handler — agent signals the session is finished (Claude Code
 * `session-end` hook; Codex stop; user `/exit`). Marks state as phase
 * `ended` then eagerly runs condensation + `fullyCondensed` marker so a
 * follow-up `story rewind` / `story explain` gets a pristine view without
 * waiting for the next `PostCommit` to process the session.
 *
 * Mirrors Go `lifecycle.go` (`handleLifecycleSessionEnd`) +
 * `lifecycle.go` (`markSessionEnded`).
 *
 * **TS-divergence notes** (documented inline):
 *
 * 1. Go uses `state.Phase = PhaseEnded` (uppercase enum). TS Phase type is
 *    `'idle' | 'active' | 'ended'` (lowercase string-literal union) —
 *    canonical value is `'ended'`. All call-sites + persisted JSON +
 *    tests.md assertions normalize to lowercase.
 * 2. Go's `markSessionEnded` unconditionally runs `TransitionAndLog`. TS
 *    spec short-circuits when `state.phase === 'ended'` for idempotency —
 *    avoids bumping `lastInteractionTime` on repeat `session-end` hooks.
 * 3. Go's `handleLifecycleSessionEnd` treats `markSessionEnded` errors as
 *    "don't condense" (bails early). TS matches — if `markSessionEnded`
 *    throws, we log + skip condense rather than letting the error
 *    propagate (fail-open; matches tests.md case 5 behavior).
 * 4. Go gets the strategy via `GetStrategy(ctx)`; TS instantiates a fresh
 *    `ManualCommitStrategy()` bound to `process.cwd()` — the only in-tree
 *    strategy and the one that owns `condenseAndMarkFullyCondensed`.
 *
 * @packageDocumentation
 */

import type { Event } from '@/agent/event';
import type { Agent } from '@/agent/interfaces';
import * as log from '@/log';
import { NoOpActionHandler, Event as PhaseEvent, type TransitionContext } from '@/session/phase';
import { ManualCommitStrategy } from '@/strategy/manual-commit';
import { loadSessionState, saveSessionState, transitionAndLog } from '@/strategy/session-state';
import { persistEventMetadataToState, UNKNOWN_SESSION_ID } from '../dispatch-helpers';

/**
 * Terminal transition for a session. Safe to call multiple times
 * (idempotent — a double `session-end` hook is a no-op once state is
 * already at `'ended'`).
 *
 * Steps:
 * 1. `sessionId` empty → fall back to {@link UNKNOWN_SESSION_ID} (matches
 *    tests.md case 1 + Go's `handleLifecycleSessionEnd` early-return which
 *    TS softens to "try mark + condense anyway so dangling metadata gets
 *    swept").
 * 2. {@link markSessionEnded} — phase → `'ended'`, `endedAt` =
 *    `new Date().toISOString()` (Go parity — `time.Now()`, NOT the
 *    hook's `event.Timestamp`), metadata merged via
 *    {@link persistEventMetadataToState}. Throws on disk errors,
 *    silently skips when state missing. Errors here **block** the eager
 *    condense (inconsistent state; let PostCommit retry).
 * 3. Eager {@link ManualCommitStrategy.condenseAndMarkFullyCondensed} —
 *    failures are `log.warn`-ed and swallowed (PostCommit carry-forward
 *    will retry on next commit; matches tests.md case 5 + Go fail-open).
 *
 * @example
 * await handleSessionEnd(claudeAgent, {
 *   type: 'SessionEnd',
 *   sessionId: 'sid-1',
 *   timestamp: new Date('2026-04-21T13:00:00Z'),
 *   // ...zero-value other fields
 * });
 *
 * // Side effects (existing state, empty filesTouched):
 * //   .git/story-sessions/sid-1.json     ← phase=ended + endedAt + fullyCondensed=true
 * //   refs/heads/story/checkpoints/v1    ← condense may bump this ref
 * //   refs/heads/story/<base>-<6hex>     ← deleted when no other session uses it
 * //   Worktree / index / HEAD:            unchanged
 */
export async function handleSessionEnd(ag: Agent, event: Event): Promise<void> {
	const sessionID = event.sessionId || UNKNOWN_SESSION_ID;
	const logCtx = { component: 'lifecycle', hook: 'session-end', agent: ag.name() };
	log.info(logCtx, 'session-end', {
		event: event.type,
		sessionId: sessionID,
	});

	let marked = false;
	try {
		await markSessionEnded(event, sessionID);
		marked = true;
	} catch (e) {
		log.warn(logCtx, 'failed to mark session ended', {
			error: (e as Error).message,
		});
	}

	if (!marked) {
		return;
	}

	try {
		const strategy = new ManualCommitStrategy();
		await strategy.condenseAndMarkFullyCondensed(sessionID);
	} catch (e) {
		log.warn(logCtx, 'eager condensation failed (non-fatal)', {
			sessionId: sessionID,
			error: (e as Error).message,
		});
	}
}

/**
 * Mark a session's terminal state. Mirrors Go `markSessionEnded`
 * (`lifecycle.go`).
 *
 * - Missing state (null from {@link loadSessionState}) → silent return
 *   (Go parity; idempotent pre-state path).
 * - Already `phase === 'ended'` → silent return (TS-divergence from Go —
 *   Go unconditionally re-runs transition which bumps
 *   `lastInteractionTime`; TS short-circuits to keep double-hook truly
 *   idempotent; matches tests.md case 3).
 * - Otherwise the call order mirrors Go exactly:
 *   1. {@link persistEventMetadataToState} merges hook-provided metrics
 *      (model, tokens, turn-count) into state.
 *   2. {@link transitionAndLog} fires `PhaseEvent.SessionStop` with
 *      {@link NoOpActionHandler} (Go parity — no strategy-specific
 *      actions on session-end). Failures `log.warn` but DO NOT block
 *      the subsequent `endedAt` assignment + save.
 *   3. `endedAt` is always `new Date().toISOString()` — Go uses
 *      `time.Now()` and ignores the hook's `event.Timestamp` for the
 *      terminal marker. Story does the same to match.
 *   4. {@link saveSessionState} persists the terminal state. Failures
 *      propagate (non-fail-open — consistent with `model-update` +
 *      `compaction`).
 */
export async function markSessionEnded(event: Event, sessionID: string): Promise<void> {
	const state = await loadSessionState(sessionID);
	if (!state) {
		return;
	}
	if (state.phase === 'ended') {
		return;
	}

	persistEventMetadataToState(event, state);

	const transCtx: TransitionContext = { hasFilesTouched: false, isRebaseInProgress: false };
	try {
		await transitionAndLog(state, PhaseEvent.SessionStop, transCtx, new NoOpActionHandler());
	} catch (e) {
		log.warn({ component: 'lifecycle', sessionId: sessionID }, 'session stop transition failed', {
			error: (e as Error).message,
		});
	}

	state.endedAt = new Date().toISOString();

	await saveSessionState(state);
}
