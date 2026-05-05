/**
 * Phase 7 Part 1 `src/lifecycle/handlers/model-update.ts` — 4 case.
 *
 * Go 参考：`cmd/entire/cli/lifecycle.go` (`handleLifecycleModelUpdate`).
 * Go has no direct unit test; cases 1-3 mirror the Go branches and case 4 is a
 * Story-side addition for the non-fail-open save contract.
 *
 * TS-divergence from Go (documented in handler source at
 * `src/lifecycle/handlers/model-update.ts` JSDoc):
 * 1. **No `storeModelHint` fallback when session state is missing.** Go
 *    `lifecycle.go` writes the `<id>.model` sidecar via
 *    `storeModelHint` before returning; Story-side `handleModelUpdate`
 *    deliberately skips the hint file and logs at `debug`. The sidecar
 *    only matters when `SessionStart` fires before state exists, and
 *    `ModelUpdate` is always post-`SessionStart`. `session-state` module's
 *    `storeModelHint` export is therefore NOT mocked in this test file —
 *    verifying any absence via code review is enough.
 * 2. `saveSessionState` failure propagates (non-fail-open); Go swallows.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Event } from '@/agent/event';
import type { Agent } from '@/agent/interfaces';
import { AGENT_NAME_CLAUDE_CODE, type AgentName } from '@/agent/types';
import { handleModelUpdate } from '@/lifecycle/handlers/model-update';
import * as log from '@/log';
import type { SessionState } from '@/session/state-store';

// TS-divergence: `storeModelHint` is intentionally omitted from this mock
// object. `handleModelUpdate` does NOT import it (Story skips the hint-file
// fallback — see file-level JSDoc). If a future refactor adds a hint-file
// call here, TS will emit a hard module-import error so the divergence
// stays visible. Compare: `src/lifecycle/handlers/session-start.ts` DOES
// mock `storeModelHint` (that handler legitimately writes the sidecar).
vi.mock('@/strategy/session-state', () => ({
	loadSessionState: vi.fn(async () => null),
	saveSessionState: vi.fn(async () => {}),
}));

import { loadSessionState, saveSessionState } from '@/strategy/session-state';

function makeEvent(overrides: Partial<Event> = {}): Event {
	return {
		type: 'ModelUpdate',
		sessionId: 'sid-1',
		previousSessionId: '',
		sessionRef: '',
		prompt: '',
		model: '',
		timestamp: new Date(0),
		toolUseId: '',
		subagentId: '',
		toolInput: null,
		subagentType: '',
		taskDescription: '',
		modifiedFiles: [],
		responseMessage: '',
		durationMs: 0,
		turnCount: 0,
		contextTokens: 0,
		contextWindowSize: 0,
		metadata: {},
		...overrides,
	};
}

function makeAgent(name: AgentName = AGENT_NAME_CLAUDE_CODE): Agent {
	return { name: () => name } as Agent;
}

function makeState(overrides: Partial<SessionState> = {}): SessionState {
	return {
		sessionId: 'sid-1',
		baseCommit: 'abc1234',
		startedAt: new Date(0).toISOString(),
		phase: 'idle',
		stepCount: 0,
		...overrides,
	};
}

describe('lifecycle/handlers/model-update', () => {
	beforeEach(() => {
		vi.mocked(loadSessionState).mockReset().mockResolvedValue(null);
		vi.mocked(saveSessionState).mockReset().mockResolvedValue();
	});

	// Go: lifecycle.go — direct write to state.ModelName when state exists
	it('updates existing session state model', async () => {
		const state = makeState({ modelName: 'sonnet' });
		vi.mocked(loadSessionState).mockResolvedValue(state);

		await handleModelUpdate(makeAgent(), makeEvent({ model: 'opus' }));

		expect(saveSessionState).toHaveBeenCalledTimes(1);
		const [saved] = vi.mocked(saveSessionState).mock.calls[0] as [SessionState];
		expect(saved.modelName).toBe('opus');
	});

	// Go: lifecycle.go — early return when SessionID or Model empty (+
	// Story-side divergence: skip the hint-file fallback; debug-log instead)
	it('silent skip when session state missing', async () => {
		vi.mocked(loadSessionState).mockResolvedValue(null);
		const debugSpy = vi.spyOn(log, 'debug').mockImplementation(() => {});

		await expect(
			handleModelUpdate(makeAgent(), makeEvent({ model: 'opus' })),
		).resolves.toBeUndefined();

		expect(saveSessionState).not.toHaveBeenCalled();
		expect(debugSpy).toHaveBeenCalledWith(
			expect.any(Object),
			'session state missing for model-update',
			expect.objectContaining({ sessionId: 'sid-1' }),
		);
		debugSpy.mockRestore();
	});

	// Story 补充：persistEventMetadataToState also merges non-model fields.
	// Routes metadata copy through the shared persist fn so one dispatch call
	// carries all 5 hook-provided metrics onto SessionState.
	it('persistEventMetadataToState also merges non-model fields', async () => {
		const state = makeState();
		vi.mocked(loadSessionState).mockResolvedValue(state);

		await handleModelUpdate(
			makeAgent(),
			makeEvent({
				model: 'opus',
				turnCount: 5,
				contextTokens: 10_000,
				durationMs: 1234,
				contextWindowSize: 200_000,
			}),
		);

		const [saved] = vi.mocked(saveSessionState).mock.calls[0] as [SessionState];
		expect(saved.modelName).toBe('opus');
		expect(saved.sessionTurnCount).toBe(5);
		expect(saved.contextTokens).toBe(10_000);
		expect(saved.sessionDurationMs).toBe(1234);
		expect(saved.contextWindowSize).toBe(200_000);
	});

	// Story 补充：saveSessionState rejection must propagate (non-fail-open).
	it('throws when saveSessionState fails', async () => {
		const state = makeState();
		vi.mocked(loadSessionState).mockResolvedValue(state);
		vi.mocked(saveSessionState).mockRejectedValue(new Error('disk full'));

		await expect(handleModelUpdate(makeAgent(), makeEvent({ model: 'opus' }))).rejects.toThrow(
			'disk full',
		);
	});

	// Story 补充: early return when sessionId or model is empty (lines 57-59)
	it('early return when sessionId is empty (no state load attempted)', async () => {
		await handleModelUpdate(makeAgent(), makeEvent({ sessionId: '', model: 'opus' }));
		expect(loadSessionState).not.toHaveBeenCalled();
		expect(saveSessionState).not.toHaveBeenCalled();
	});

	it('early return when model is empty (no state load attempted)', async () => {
		await handleModelUpdate(makeAgent(), makeEvent({ sessionId: 'sid-1', model: '' }));
		expect(loadSessionState).not.toHaveBeenCalled();
		expect(saveSessionState).not.toHaveBeenCalled();
	});

	// Story 补充: loadSessionState rejection is debug-logged + handler returns silently
	it('loadSessionState rejection debug-logged + handler returns silently', async () => {
		vi.mocked(loadSessionState).mockRejectedValue(new Error('load crash'));
		const debugSpy = vi.spyOn(log, 'debug').mockImplementation(() => {});

		await expect(
			handleModelUpdate(makeAgent(), makeEvent({ model: 'opus' })),
		).resolves.toBeUndefined();

		expect(debugSpy).toHaveBeenCalledWith(
			expect.any(Object),
			'could not load session state for model update',
			expect.objectContaining({ error: 'load crash' }),
		);
		expect(saveSessionState).not.toHaveBeenCalled();
		debugSpy.mockRestore();
	});
});
