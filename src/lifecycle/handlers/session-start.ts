/**
 * SessionStart handler — fires on the first hook from a session (typically
 * `story hooks claude-code session-start`).
 *
 * Mirrors Go `lifecycle.go` (`handleLifecycleSessionStart`) +
 * `lifecycle.go` (`sessionStartMessage`). The TS spec diverges in
 * two small places — documented inline with `// TS-divergence:` markers:
 *
 *   1. Empty `event.sessionId` → falls back to {@link UNKNOWN_SESSION_ID}
 *      (Go throws `"no session_id"`). Matches tests.md case 1.
 *   2. Empty repository → banner is **not written** at all (Go writes the
 *      empty-repo variant). Matches tests.md case 2.
 *
 * Steps:
 * 1. Resolve sessionId (UNKNOWN_SESSION_ID fallback).
 * 2. Check `isEmptyRepository`; log.warn on error and continue (treat as
 *    non-empty so the banner still ships — tests.md case 8).
 * 3. If non-empty repo AND agent implements `HookResponseWriter`:
 *    a. Build base banner via {@link sessionStartMessage}.
 *    b. Query {@link ManualCommitStrategy.countOtherActiveSessionsWithCheckpoints}
 *       (failure → `log.warn` + `count = 0` fallback). When count > 0,
 *       append the concurrent-sessions hint — Codex gets the single-line
 *       variant (space-prefixed), others get the newline-indented block.
 *       Mirrors Go `lifecycle.go`.
 *    c. `event.responseMessage` override wins when non-empty (Go parity —
 *        override replaces the entire composed message including any
 *        concurrent-sessions suffix).
 *    d. Write banner; failures are logged + swallowed (tests.md case 7).
 * 4. If `event.model` non-empty → {@link storeModelHint} (cross-process).
 * 5. Load session state; if present, `persistEventMetadataToState` +
 *    `transitionAndLog(SessionStart)` + `saveSessionState`.
 *
 * @packageDocumentation
 */

import { asHookResponseWriter } from '@/agent/capabilities';
import type { Event } from '@/agent/event';
import type { Agent } from '@/agent/interfaces';
import { AGENT_NAME_CODEX, type AgentName } from '@/agent/types';
import * as log from '@/log';
import { NoOpActionHandler, Event as PhaseEvent } from '@/session/phase';
import { ManualCommitStrategy } from '@/strategy/manual-commit';
import { isEmptyRepository } from '@/strategy/repo';
import {
	loadSessionState,
	saveSessionState,
	storeModelHint,
	transitionAndLog,
} from '@/strategy/session-state';
import { persistEventMetadataToState, UNKNOWN_SESSION_ID } from '../dispatch-helpers';

/**
 * Session-start lifecycle handler. Mirrors Go `lifecycle.go`
 * `handleLifecycleSessionStart` (with two documented TS-divergences).
 *
 * @example
 * await handleSessionStart(claudeAgent, {
 *   type: 'SessionStart',
 *   sessionId: 'sid-1',
 *   model: 'claude-sonnet-4.6',
 *   sessionRef: '/path/to/abc.jsonl',
 *   timestamp: new Date(),
 *   // ...other zero-value fields
 * });
 *
 * // Side effects (non-empty repo, HookResponseWriter agent, state on disk):
 * //   stdout                                       ← banner JSON
 * //   .git/story-sessions/sid-1.model              ← model hint stored
 * //   .git/story-sessions/sid-1.json               ← state updated
 * //   Worktree / index / HEAD:                     unchanged
 */
export async function handleSessionStart(ag: Agent, event: Event): Promise<void> {
	const sessionID = event.sessionId || UNKNOWN_SESSION_ID;
	const logCtx = { component: 'lifecycle', hook: 'session-start', agent: ag.name() };
	log.info(logCtx, 'session-start', {
		event: event.type,
		sessionId: sessionID,
		sessionRef: event.sessionRef,
		model: event.model,
	});

	let emptyRepo = false;
	try {
		emptyRepo = await isEmptyRepository();
	} catch (e) {
		log.warn(logCtx, 'failed to determine empty-repo state', {
			error: (e as Error).message,
		});
	}

	if (!emptyRepo) {
		const [writer, ok] = asHookResponseWriter(ag);
		if (ok && writer) {
			let message = sessionStartMessage(ag.name(), emptyRepo);

			let otherCount = 0;
			try {
				otherCount = await new ManualCommitStrategy().countOtherActiveSessionsWithCheckpoints(
					sessionID,
				);
			} catch (e) {
				log.warn(logCtx, 'failed to count other active sessions', {
					error: (e as Error).message,
				});
			}
			if (otherCount > 0) {
				if (ag.name() === AGENT_NAME_CODEX) {
					message += ` ${otherCount} other active conversation(s) in this workspace will also be included. Use 'story status' for more information.`;
				} else {
					message += `\n  ${otherCount} other active conversation(s) in this workspace will also be included.\n  Use 'story status' for more information.`;
				}
			}

			if (event.responseMessage) {
				message = event.responseMessage;
			}

			try {
				await writer.writeHookResponse(message);
			} catch (e) {
				log.warn(logCtx, 'failed to write session-start banner', {
					error: (e as Error).message,
				});
			}
		}
	}

	if (event.model) {
		try {
			await storeModelHint(sessionID, event.model);
		} catch (e) {
			log.warn(logCtx, 'failed to store model hint on session start', {
				error: (e as Error).message,
			});
		}
	}

	let state = null;
	try {
		state = await loadSessionState(sessionID);
	} catch (e) {
		log.warn(logCtx, 'failed to load session state on start', {
			error: (e as Error).message,
		});
	}
	if (state) {
		persistEventMetadataToState(event, state);
		try {
			await transitionAndLog(
				state,
				PhaseEvent.SessionStart,
				{ hasFilesTouched: false, isRebaseInProgress: false },
				new NoOpActionHandler(),
			);
		} catch (e) {
			log.warn(logCtx, 'session start transition failed', {
				error: (e as Error).message,
			});
		}
		try {
			await saveSessionState(state);
		} catch (e) {
			log.warn(logCtx, 'failed to update session state on start', {
				error: (e as Error).message,
			});
		}
	}
}

/**
 * Compose the banner message shown on SessionStart. Mirrors Go
 * `lifecycle.go` (`sessionStartMessage`) with the **Story rebrand**:
 * every `"Entire"` literal is replaced with `"Story"` per the story-vs-entire
 * migration guide.
 *
 * Codex gets the single-line variant; all others get the multi-line block.
 *
 * @example
 * sessionStartMessage('codex' as AgentName, false);
 * // → 'Powered by Story: This conversation will be linked to your next commit.'
 *
 * sessionStartMessage('claude-code' as AgentName, true);
 * // → '\n\nPowered by Story:\n  No commits yet — checkpoints will activate after your first commit.'
 */
export function sessionStartMessage(agentName: AgentName, emptyRepo: boolean): string {
	if (agentName === 'codex') {
		if (emptyRepo) {
			return 'Powered by Story: No commits yet — checkpoints will activate after your first commit.';
		}
		return 'Powered by Story: This conversation will be linked to your next commit.';
	}

	if (emptyRepo) {
		return '\n\nPowered by Story:\n  No commits yet — checkpoints will activate after your first commit.';
	}
	return '\n\nPowered by Story:\n  This conversation will be linked to your next commit.';
}
