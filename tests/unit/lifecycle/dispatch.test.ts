/**
 * `src/lifecycle/dispatch.ts` — 14 case (Phase 7 Part 1 +
 * Part 2 upgrade).
 *
 * Go 参考：`cmd/entire/cli/lifecycle_test.go`:
 * - `TestDispatchLifecycleEvent_NilAgent`
 * - `TestDispatchLifecycleEvent_NilEvent`
 * - `TestDispatchLifecycleEvent_UnknownEventType`
 * - `TestDispatchLifecycleEvent_RoutesToCorrectHandler` (8 sub-cases)
 * - `TestResolveTranscriptOffset_PrefersPrePromptState` / `_NilPrePromptState` /
 *   `_ZeroOffsetInPrePromptState`
 *
 * All 8 handlers (4 Part 1 + 4 Part 2) are mocked so routing can be
 * asserted without the implementation's side effects. The stale
 * "throws Phase 7 Part 2 NOT_IMPLEMENTED" assertions were replaced in
 * the Part 2 `dispatch.ts` upgrade — each of the 4 Part 2 handlers is
 * now verified via spy + `toHaveBeenCalledWith`.
 */

import { describe, expect, it, vi } from 'vitest';
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
	type EventType,
} from '@/agent/event';
import type { Agent } from '@/agent/interfaces';
import {
	dispatchLifecycleEvent,
	logFileChanges,
	parseTranscriptForCheckpointUUID,
	persistEventMetadataToState,
	resolveTranscriptOffset,
	UNKNOWN_SESSION_ID,
} from '@/lifecycle/dispatch';
import * as log from '@/log';
import type { SessionState } from '@/session/state-store';

vi.mock('@/lifecycle/handlers/session-start', () => ({
	handleSessionStart: vi.fn(async () => {}),
}));
vi.mock('@/lifecycle/handlers/model-update', () => ({
	handleModelUpdate: vi.fn(async () => {}),
}));
vi.mock('@/lifecycle/handlers/compaction', () => ({
	handleCompaction: vi.fn(async () => {}),
}));
vi.mock('@/lifecycle/handlers/session-end', () => ({
	handleSessionEnd: vi.fn(async () => {}),
	markSessionEnded: vi.fn(async () => {}),
}));
vi.mock('@/lifecycle/handlers/turn-start', () => ({
	handleTurnStart: vi.fn(async () => {}),
}));
vi.mock('@/lifecycle/handlers/turn-end', () => ({
	handleTurnEnd: vi.fn(async () => {}),
}));
vi.mock('@/lifecycle/handlers/subagent-start', () => ({
	handleSubagentStart: vi.fn(async () => {}),
}));
vi.mock('@/lifecycle/handlers/subagent-end', () => ({
	handleSubagentEnd: vi.fn(async () => {}),
}));

function makeEvent(type: EventType, overrides: Partial<Event> = {}): Event {
	return {
		type,
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

/** Minimal agent stub — handlers are mocked, so no method needs a real impl. */
function makeAgent(): Agent {
	return {} as Agent;
}

describe('lifecycle/dispatch', () => {
	describe('dispatchLifecycleEvent', () => {
		// Go: lifecycle_test.go: TestDispatchLifecycleEvent_NilAgent
		it('throws on null agent', async () => {
			await expect(
				dispatchLifecycleEvent(null as unknown as Agent, makeEvent(EVENT_TYPE_SESSION_START)),
			).rejects.toThrow('agent cannot be nil');
		});

		// Go: lifecycle_test.go: TestDispatchLifecycleEvent_NilEvent
		it('throws on null event', async () => {
			await expect(dispatchLifecycleEvent(makeAgent(), null as unknown as Event)).rejects.toThrow(
				'event cannot be nil',
			);
		});

		// Go: lifecycle_test.go TestDispatchLifecycleEvent_UnknownEventType
		// Go passes `EventType(999)` (a bogus numeric); TS `EventType` is a
		// string union, so we force-inject `999` via an `as unknown` cast
		// to simulate the same out-of-range input. Asserts the Go-style
		// error message literal emitted by the dispatcher's `otherwise()`.
		it("throws 'unknown lifecycle event type' on bogus event.type", async () => {
			const bad = makeEvent(EVENT_TYPE_SESSION_START);
			(bad as unknown as { type: number }).type = 999;
			await expect(dispatchLifecycleEvent(makeAgent(), bad)).rejects.toThrow(
				/unknown lifecycle event type: 999/,
			);
		});

		// Go: lifecycle_test.go: TestDispatchLifecycleEvent_RoutesToCorrectHandler/SessionStart
		it('dispatches SessionStart to handleSessionStart', async () => {
			const mod = await import('@/lifecycle/handlers/session-start');
			const spy = vi.mocked(mod.handleSessionStart);
			spy.mockClear();
			const ag = makeAgent();
			const ev = makeEvent(EVENT_TYPE_SESSION_START);
			await dispatchLifecycleEvent(ag, ev);
			expect(spy).toHaveBeenCalledTimes(1);
			expect(spy).toHaveBeenCalledWith(ag, ev);
		});

		// Go: lifecycle_test.go: TestDispatchLifecycleEvent_RoutesToCorrectHandler/ModelUpdate
		it('dispatches ModelUpdate to handleModelUpdate', async () => {
			const mod = await import('@/lifecycle/handlers/model-update');
			const spy = vi.mocked(mod.handleModelUpdate);
			spy.mockClear();
			const ag = makeAgent();
			const ev = makeEvent(EVENT_TYPE_MODEL_UPDATE);
			await dispatchLifecycleEvent(ag, ev);
			expect(spy).toHaveBeenCalledTimes(1);
			expect(spy).toHaveBeenCalledWith(ag, ev);
		});

		// Go: lifecycle_test.go: TestDispatchLifecycleEvent_RoutesToCorrectHandler/Compaction
		it('dispatches Compaction to handleCompaction', async () => {
			const mod = await import('@/lifecycle/handlers/compaction');
			const spy = vi.mocked(mod.handleCompaction);
			spy.mockClear();
			const ag = makeAgent();
			const ev = makeEvent(EVENT_TYPE_COMPACTION);
			await dispatchLifecycleEvent(ag, ev);
			expect(spy).toHaveBeenCalledTimes(1);
			expect(spy).toHaveBeenCalledWith(ag, ev);
		});

		// Go: lifecycle_test.go: TestDispatchLifecycleEvent_RoutesToCorrectHandler/SessionEnd
		it('dispatches SessionEnd to handleSessionEnd', async () => {
			const mod = await import('@/lifecycle/handlers/session-end');
			const spy = vi.mocked(mod.handleSessionEnd);
			spy.mockClear();
			const ag = makeAgent();
			const ev = makeEvent(EVENT_TYPE_SESSION_END);
			await dispatchLifecycleEvent(ag, ev);
			expect(spy).toHaveBeenCalledTimes(1);
			expect(spy).toHaveBeenCalledWith(ag, ev);
		});

		// Go: lifecycle_test.go: TestDispatchLifecycleEvent_RoutesToCorrectHandler/TurnStart
		// Phase 7 Part 2 upgrade: placeholder throw replaced by real handler dispatch.
		it('dispatches TurnStart to handleTurnStart', async () => {
			const mod = await import('@/lifecycle/handlers/turn-start');
			const spy = vi.mocked(mod.handleTurnStart);
			spy.mockClear();
			const ag = makeAgent();
			const ev = makeEvent(EVENT_TYPE_TURN_START);
			await dispatchLifecycleEvent(ag, ev);
			expect(spy).toHaveBeenCalledTimes(1);
			expect(spy).toHaveBeenCalledWith(ag, ev);
		});

		// Go: lifecycle_test.go: TestDispatchLifecycleEvent_RoutesToCorrectHandler/TurnEnd
		it('dispatches TurnEnd to handleTurnEnd', async () => {
			const mod = await import('@/lifecycle/handlers/turn-end');
			const spy = vi.mocked(mod.handleTurnEnd);
			spy.mockClear();
			const ag = makeAgent();
			const ev = makeEvent(EVENT_TYPE_TURN_END);
			await dispatchLifecycleEvent(ag, ev);
			expect(spy).toHaveBeenCalledTimes(1);
			expect(spy).toHaveBeenCalledWith(ag, ev);
		});

		// Go: lifecycle_test.go: TestDispatchLifecycleEvent_RoutesToCorrectHandler/SubagentStart
		it('dispatches SubagentStart to handleSubagentStart', async () => {
			const mod = await import('@/lifecycle/handlers/subagent-start');
			const spy = vi.mocked(mod.handleSubagentStart);
			spy.mockClear();
			const ag = makeAgent();
			const ev = makeEvent(EVENT_TYPE_SUBAGENT_START);
			await dispatchLifecycleEvent(ag, ev);
			expect(spy).toHaveBeenCalledTimes(1);
			expect(spy).toHaveBeenCalledWith(ag, ev);
		});

		// Go: lifecycle_test.go: TestDispatchLifecycleEvent_RoutesToCorrectHandler/SubagentEnd
		it('dispatches SubagentEnd to handleSubagentEnd', async () => {
			const mod = await import('@/lifecycle/handlers/subagent-end');
			const spy = vi.mocked(mod.handleSubagentEnd);
			spy.mockClear();
			const ag = makeAgent();
			const ev = makeEvent(EVENT_TYPE_SUBAGENT_END);
			await dispatchLifecycleEvent(ag, ev);
			expect(spy).toHaveBeenCalledTimes(1);
			expect(spy).toHaveBeenCalledWith(ag, ev);
		});

		// Go: lifecycle_test.go TestDispatchLifecycleEvent_RoutesToCorrectHandler/SubagentStart
		// Go table asserts that `handleLifecycleSubagentStart` wraps its
		// `CapturePreTaskState` error as `"failed to capture pre-task state: ..."`
		// and propagates up through `DispatchLifecycleEvent`. The TS dispatcher
		// is `.with(EVENT_TYPE_SUBAGENT_START, () => handleSubagentStart(ag, event))`
		// with no error suppression, so any handler rejection bubbles up to the
		// caller unchanged — asserted here via a mocked rejection.
		it('propagates SubagentStart handler error up to caller', async () => {
			const mod = await import('@/lifecycle/handlers/subagent-start');
			const spy = vi.mocked(mod.handleSubagentStart);
			spy.mockClear();
			spy.mockRejectedValueOnce(new Error('failed to capture pre-task state: disk full'));
			const ag = makeAgent();
			const ev = makeEvent(EVENT_TYPE_SUBAGENT_START);
			await expect(dispatchLifecycleEvent(ag, ev)).rejects.toThrow(
				/failed to capture pre-task state: disk full/,
			);
		});
	});

	describe('persistEventMetadataToState', () => {
		// Go: lifecycle_test.go: persistEventMetadataToState (TS field mapping)
		it('merges event.model + turnCount + tokens + durationMs into state', () => {
			const state: SessionState = {
				sessionId: 'sid',
				baseCommit: 'abc',
				startedAt: new Date(0).toISOString(),
				phase: 'idle' as SessionState['phase'],
				stepCount: 0,
			};
			const event = makeEvent(EVENT_TYPE_TURN_END, {
				model: 'claude-sonnet-4.6',
				durationMs: 1234,
				turnCount: 5,
				contextTokens: 10_000,
				contextWindowSize: 200_000,
			});

			persistEventMetadataToState(event, state);

			expect(state.modelName).toBe('claude-sonnet-4.6');
			expect(state.sessionDurationMs).toBe(1234);
			expect(state.sessionTurnCount).toBe(5);
			expect(state.contextTokens).toBe(10_000);
			expect(state.contextWindowSize).toBe(200_000);

			// Zero-value event fields should leave state unchanged.
			const state2: SessionState = {
				sessionId: 'sid',
				baseCommit: 'abc',
				startedAt: new Date(0).toISOString(),
				phase: 'idle' as SessionState['phase'],
				stepCount: 0,
				modelName: 'prev',
				sessionDurationMs: 7,
				sessionTurnCount: 3,
				contextTokens: 2,
				contextWindowSize: 4,
			};
			const zero = makeEvent(EVENT_TYPE_SESSION_START);
			persistEventMetadataToState(zero, state2);
			expect(state2.modelName).toBe('prev');
			expect(state2.sessionDurationMs).toBe(7);
			expect(state2.sessionTurnCount).toBe(3);
			expect(state2.contextTokens).toBe(2);
			expect(state2.contextWindowSize).toBe(4);

			// TurnEnd with no hook-provided turnCount should increment state.
			const state3: SessionState = {
				sessionId: 'sid',
				baseCommit: 'abc',
				startedAt: new Date(0).toISOString(),
				phase: 'idle' as SessionState['phase'],
				stepCount: 0,
				sessionTurnCount: 2,
			};
			persistEventMetadataToState(makeEvent(EVENT_TYPE_TURN_END), state3);
			expect(state3.sessionTurnCount).toBe(3);
		});
	});

	describe('resolveTranscriptOffset', () => {
		// Go: TestResolveTranscriptOffset_{PrefersPrePromptState,NilPrePromptState,ZeroOffsetInPrePromptState}
		it('returns preState.transcriptOffset when set; else 0 fallback (Part 1)', async () => {
			const pre = {
				sessionId: 'sid',
				untrackedFiles: [],
				transcriptOffset: 42,
				startTime: new Date(),
			};
			expect(await resolveTranscriptOffset(pre, 'sid')).toBe(42);
			expect(await resolveTranscriptOffset(null, 'sid')).toBe(0);
			expect(
				await resolveTranscriptOffset(
					{ sessionId: 'sid', untrackedFiles: [], transcriptOffset: 0, startTime: new Date() },
					'sid',
				),
			).toBe(0);
		});
	});

	describe('UNKNOWN_SESSION_ID', () => {
		// Go: rewind.go: unknownSessionID = "unknown" constant
		it("UNKNOWN_SESSION_ID constant is 'unknown' literal", () => {
			expect(UNKNOWN_SESSION_ID).toBe('unknown');
		});
	});

	describe('part-2 stub helpers', () => {
		// Go: lifecycle.go: parseTranscriptForCheckpointUUID — Part 1 stub returns null
		it('parseTranscriptForCheckpointUUID stub returns null', async () => {
			const result = await parseTranscriptForCheckpointUUID('/fake/path.jsonl');
			expect(result).toBeNull();
		});

		// Go: lifecycle.go: logFileChanges — emits a single debug entry with 3 counts
		it('logFileChanges emits debug log with file counts', () => {
			const debugSpy = vi.spyOn(log, 'debug').mockImplementation(() => {});
			logFileChanges({ component: 'test' }, ['a.ts'], ['b.ts', 'c.ts'], []);
			expect(debugSpy).toHaveBeenCalledWith({ component: 'test' }, 'files changed during session', {
				modified: 1,
				new: 2,
				deleted: 0,
			});
			debugSpy.mockRestore();
		});
	});
});
