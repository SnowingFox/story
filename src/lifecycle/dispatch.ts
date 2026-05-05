/**
 * Lifecycle event dispatcher — the single entry point the framework calls
 * after an agent's `parseHookEvent` emits a normalized {@link Event}.
 *
 * Mirrors Go `cmd/entire/cli/lifecycle.go: DispatchLifecycleEvent`.
 *
 * The dispatcher itself only contains the `match()` table. All shared
 * helpers (`resolveTranscriptOffset`, `parseTranscriptForCheckpointUUID`,
 * `logFileChanges`, `persistEventMetadataToState`, `UNKNOWN_SESSION_ID`)
 * live in {@link ./dispatch-helpers} so handlers can consume them without
 * re-importing the dispatcher itself (which would cycle through every
 * handler at module init time post-Part 2).
 *
 * **Part 2 ship**: all 8 event types route to concrete handlers
 * (`SessionStart`, `ModelUpdate`, `Compaction`, `SessionEnd` from Part 1;
 * `TurnStart`, `TurnEnd`, `SubagentStart`, `SubagentEnd` from Part 2).
 *
 * @packageDocumentation
 */

import { match } from 'ts-pattern';
import {
	EVENT_TYPE_COMPACTION,
	EVENT_TYPE_MODEL_UPDATE,
	EVENT_TYPE_SESSION_END,
	EVENT_TYPE_SESSION_START,
	EVENT_TYPE_SUBAGENT_END,
	EVENT_TYPE_SUBAGENT_START,
	EVENT_TYPE_TURN_END,
	EVENT_TYPE_TURN_START,
	type Event,
} from '@/agent/event';
import type { Agent } from '@/agent/interfaces';
import { handleCompaction } from './handlers/compaction';
import { handleModelUpdate } from './handlers/model-update';
import { handleSessionEnd } from './handlers/session-end';
import { handleSessionStart } from './handlers/session-start';
import { handleSubagentEnd } from './handlers/subagent-end';
import { handleSubagentStart } from './handlers/subagent-start';
import { handleTurnEnd } from './handlers/turn-end';
import { handleTurnStart } from './handlers/turn-start';

// Backward-compat re-exports so callers that imported helpers through
// `../dispatch` (Part 1 convention) still resolve. New callers should
// import directly from `./dispatch-helpers`.
export {
	logFileChanges,
	parseTranscriptForCheckpointUUID,
	persistEventMetadataToState,
	resolveTranscriptOffset,
	UNKNOWN_SESSION_ID,
} from './dispatch-helpers';

/**
 * Dispatch a parsed lifecycle event to the per-type handler.
 *
 * @throws Error('agent cannot be nil') when `ag === null/undefined`.
 * @throws Error('event cannot be nil') when `event === null/undefined`.
 *
 * Handlers themselves may throw — those errors propagate (the CLI top-level
 * catches and logs; Phase 8 git hooks may suppress depending on the hook's
 * fail-open contract).
 *
 * @example
 * await dispatchLifecycleEvent(claudeAgent, {
 *   type: 'TurnStart',
 *   sessionId: 'sid-1',
 *   sessionRef: '/Users/me/.claude/projects/foo/abc.jsonl',
 *   prompt: 'refactor X',
 *   // ...other zero-value fields
 * });
 * // returns: undefined on success; throws on handler error.
 *
 * // Side effects: none from the dispatcher; downstream handlers write
 * // session state + shadow-branch commits (see individual handler docs).
 */
export async function dispatchLifecycleEvent(ag: Agent, event: Event): Promise<void> {
	if (!ag) {
		throw new Error('agent cannot be nil');
	}
	if (!event) {
		throw new Error('event cannot be nil');
	}
	await match(event.type)
		.with(EVENT_TYPE_SESSION_START, () => handleSessionStart(ag, event))
		.with(EVENT_TYPE_MODEL_UPDATE, () => handleModelUpdate(ag, event))
		.with(EVENT_TYPE_COMPACTION, () => handleCompaction(ag, event))
		.with(EVENT_TYPE_SESSION_END, () => handleSessionEnd(ag, event))
		.with(EVENT_TYPE_TURN_START, () => handleTurnStart(ag, event))
		.with(EVENT_TYPE_TURN_END, () => handleTurnEnd(ag, event))
		.with(EVENT_TYPE_SUBAGENT_START, () => handleSubagentStart(ag, event))
		.with(EVENT_TYPE_SUBAGENT_END, () => handleSubagentEnd(ag, event))
		.otherwise((t) => {
			// Go `lifecycle.go`: `return fmt.Errorf("unknown lifecycle event
			// type: %d", event.Type)`. TS uses the string union EventType
			// but a caller can still inject a bogus numeric / string value
			// via an `as unknown as EventType` cast (see Go `EventType(999)`
			// test input). Keep the Go-style error message literal for parity.
			throw new Error(`unknown lifecycle event type: ${t}`);
		});
}
