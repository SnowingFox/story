/**
 * Strategy-package shared helpers extracted from Go's `common.go`.
 *
 * Phase 5.1 split most of `common.go` into topical files (constants /
 * branches / repo / prompts / metadata-branch / etc.), but a couple of
 * tiny helpers had no obvious home and were inadvertently dropped. This
 * file reclaims that space — preserving the Go file mapping so future
 * `common.go` ports land here naturally.
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/strategy/common.go` (residual
 * helpers).
 *
 * @packageDocumentation
 */

import { normalize } from '../agent/types';
import type { AgentType, SessionState } from './types';

/**
 * Pick the best agent type from the context value and the existing session
 * state. Priority: `state.agentType` (when present and non-empty) wins over
 * the caller-provided `ctxAgentType`.
 *
 * Used by Phase 5.2 SaveStep / SaveTaskStep on the partial-state recovery
 * path so the rebuilt session keeps the agent identity that earlier
 * checkpoints already recorded — falling back to whatever the current
 * agent advertises (`step.agentType`) only when state has nothing better.
 *
 * Mirrors Go `common.go:305-312` (`resolveAgentType`).
 *
 * @example
 * resolveAgentType('Codex', { ..., agentType: 'Claude Code' })
 * // => 'Claude Code'   (existing state wins)
 *
 * resolveAgentType('Claude Code', { ..., agentType: '' })
 * // => 'Claude Code'   (empty string falls through, ctx wins)
 *
 * resolveAgentType('Claude Code', null)
 * // => 'Claude Code'   (no state, ctx wins)
 */
export function resolveAgentType(
	ctxAgentType: AgentType,
	state: SessionState | null | undefined,
): AgentType {
	if (state?.agentType && state.agentType !== '') {
		// SessionState.agentType is `string | undefined` (raw JSON value from
		// state-store); normalize to the union per Go semantics.
		return normalize(state.agentType);
	}
	return ctxAgentType;
}
