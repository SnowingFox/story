/**
 * Phase 5.2 Todo 0 — `resolveAgentType` unit tests (Phase 5.1 漏 ship 补).
 *
 * The Go upstream defines this helper as a private function in
 * `entire-cli/cmd/entire/cli/strategy/common.go:305-312` with no direct
 * `*_test.go` coverage (only indirectly exercised via
 * `TestSaveStep_UsesCtxAgentType_*`). We add direct unit coverage here so
 * the priority rule (`existing state.agentType > ctx value`) is locked in.
 */

import { describe, expect, it } from 'vitest';
import { resolveAgentType } from '@/strategy/common';
import type { SessionState } from '@/strategy/types';

function makeState(overrides: Partial<SessionState> = {}): SessionState {
	return {
		sessionId: 'sess-1',
		baseCommit: 'abc1234',
		startedAt: new Date().toISOString(),
		phase: 'idle',
		stepCount: 0,
		...overrides,
	};
}

// Go: common.go:305-312 resolveAgentType
describe('resolveAgentType — Go: common.go:305-312', () => {
	// Go: common.go:308-310 "if state != nil && state.AgentType != \"\" return state.AgentType"
	it('returns state.agentType when state has a non-empty agentType (priority over ctx)', () => {
		const state = makeState({ agentType: 'Claude Code' });
		expect(resolveAgentType('Codex', state)).toBe('Claude Code');
	});

	// Go: common.go:308 — empty string falls through the guard, ctx wins
	it('returns ctx value when state.agentType is the empty string', () => {
		const state = makeState({ agentType: '' });
		expect(resolveAgentType('Cursor', state)).toBe('Cursor');
	});

	// Go: common.go:307 — nil state falls through, ctx wins
	it('returns ctx value when state is null', () => {
		expect(resolveAgentType('OpenCode', null)).toBe('OpenCode');
	});

	// Go: common.go:307 — undefined treated identically to null (TS extra)
	it('returns ctx value when state is undefined', () => {
		expect(resolveAgentType('Claude Code', undefined)).toBe('Claude Code');
	});

	// Go: common.go:308 — state present but agentType field missing (undefined)
	it('returns ctx value when state has no agentType field at all', () => {
		const state = makeState();
		expect(resolveAgentType('Codex', state)).toBe('Codex');
	});
});
