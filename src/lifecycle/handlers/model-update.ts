/**
 * ModelUpdate handler — fires when an agent reports a model change mid-session
 * (e.g. Gemini's `BeforeModel` hook, Claude Code's `/model` slash command
 * handshake).
 *
 * Mirrors Go `lifecycle.go` (`handleLifecycleModelUpdate`) with two
 * documented TS-divergences from Go:
 *
 *   1. **No StoreModelHint fallback when state is missing**. Go falls back to
 *      writing the `<id>.model` sidecar; TS spec says skip (the sidecar is
 *      only meaningful for agents that fire `SessionStart` before state
 *      exists — `ModelUpdate` only fires after a session is live). Matches
 *      tests.md case 2 (silent skip + debug log).
 *   2. **`saveSessionState` failure propagates** (non-fail-open). Go swallows
 *      and warn-logs; TS spec makes this a hard error so CI surfaces it.
 *      Matches tests.md case 4.
 *
 * The TS spec also routes the model-name copy through
 * {@link persistEventMetadataToState} (instead of a direct
 * `state.modelName = event.model`) so non-model fields like `contextTokens`
 * / `durationMs` / `turnCount` are merged in the same pass — matches
 * tests.md case 3.
 *
 * @packageDocumentation
 */

import type { Event } from '@/agent/event';
import type { Agent } from '@/agent/interfaces';
import * as log from '@/log';
import { loadSessionState, saveSessionState } from '@/strategy/session-state';
import { persistEventMetadataToState } from '../dispatch-helpers';

/**
 * Model-update lifecycle handler. Mirrors Go `lifecycle.go`
 * `handleLifecycleModelUpdate` (with two TS-divergences: no hint-file
 * fallback; save-failures propagate).
 *
 * @example
 * await handleModelUpdate(claudeAgent, {
 *   type: 'ModelUpdate',
 *   sessionId: 'sid-1',
 *   model: 'claude-opus-4.1',
 *   // ...zero-value other fields
 * });
 *
 * // Side effects (existing state on disk):
 * //   .git/story-sessions/sid-1.json   ← modelName + merged hook metrics updated
 * //   stdout / Git refs / HEAD / worktree: unchanged
 */
export async function handleModelUpdate(ag: Agent, event: Event): Promise<void> {
	const logCtx = { component: 'lifecycle', hook: 'model-update', agent: ag.name() };
	log.info(logCtx, 'model-update', {
		sessionId: event.sessionId,
		model: event.model,
	});

	if (!event.sessionId || !event.model) {
		return;
	}

	let state = null;
	try {
		state = await loadSessionState(event.sessionId);
	} catch (e) {
		log.debug(logCtx, 'could not load session state for model update', {
			error: (e as Error).message,
		});
	}

	if (!state) {
		log.debug(logCtx, 'session state missing for model-update', {
			sessionId: event.sessionId,
		});
		return;
	}

	persistEventMetadataToState(event, state);
	await saveSessionState(state);
}
