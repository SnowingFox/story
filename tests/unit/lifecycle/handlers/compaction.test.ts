/**
 * Phase 7 Part 1 `src/lifecycle/handlers/compaction.ts` — 5 case.
 *
 * Go 参考：`cmd/entire/cli/lifecycle.go` (`handleLifecycleCompaction`) +
 * `lifecycle_test.go: TestHandleLifecycleCompaction_PreservesTranscriptOffset`.
 *
 * TS-divergence from Go (documented in handler source):
 * 1. Go PRESERVES `CheckpointTranscriptStart`. TS spec RE-SNAPSHOTS
 *    `SessionState.transcriptOffset` (a different field introduced in
 *    Phase 7) and BUMPS `SessionState.compactionCount`. Go's
 *    `CheckpointTranscriptStart` stays owned by the condensation pipeline
 *    and is not touched here.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Event } from '@/agent/event';
import type { Agent, TranscriptAnalyzer } from '@/agent/interfaces';
import { AGENT_NAME_CLAUDE_CODE, type AgentName } from '@/agent/types';
import { handleCompaction } from '@/lifecycle/handlers/compaction';
import * as log from '@/log';
import type { SessionState } from '@/session/state-store';

vi.mock('@/strategy/session-state', () => ({
	loadSessionState: vi.fn(async () => null),
	saveSessionState: vi.fn(async () => {}),
	storeModelHint: vi.fn(async () => {}),
	transitionAndLog: vi.fn(async () => {}),
}));

import { Event as PhaseEvent } from '@/session/phase';
import { loadSessionState, saveSessionState, transitionAndLog } from '@/strategy/session-state';

function makeEvent(overrides: Partial<Event> = {}): Event {
	return {
		type: 'Compaction',
		sessionId: 'sid-1',
		previousSessionId: '',
		sessionRef: '/tmp/sid-1.jsonl',
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

function makeTranscriptAgent(
	position: number | (() => Promise<number>),
	name: AgentName = AGENT_NAME_CLAUDE_CODE,
): Agent & TranscriptAnalyzer {
	return {
		name: () => name,
		getTranscriptPosition: typeof position === 'function' ? position : async () => position,
		extractModifiedFilesFromOffset: async () => ({ files: [], currentPosition: 0 }),
	} as unknown as Agent & TranscriptAnalyzer;
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

describe('lifecycle/handlers/compaction', () => {
	beforeEach(() => {
		vi.mocked(loadSessionState).mockReset().mockResolvedValue(null);
		vi.mocked(saveSessionState).mockReset().mockResolvedValue();
		vi.mocked(transitionAndLog).mockReset().mockResolvedValue();
	});

	// Go: lifecycle_test.go TestHandleLifecycleCompaction_PreservesTranscriptOffset
	// TS divergence — re-snapshots offset + bumps compactionCount.
	it('handleCompaction resets transcript offset + bumps compactionCount', async () => {
		const state = makeState({ transcriptOffset: 50, compactionCount: 0 });
		vi.mocked(loadSessionState).mockResolvedValue(state);

		await handleCompaction(makeTranscriptAgent(12), makeEvent());

		expect(saveSessionState).toHaveBeenCalledTimes(1);
		const [saved] = vi.mocked(saveSessionState).mock.calls[0] as [SessionState];
		expect(saved.transcriptOffset).toBe(12);
		expect(saved.compactionCount).toBe(1);
	});

	// Go: lifecycle.go handleLifecycleCompaction — early return when state missing.
	it('missing session state → silent skip', async () => {
		vi.mocked(loadSessionState).mockResolvedValue(null);

		await expect(handleCompaction(makeAgent(), makeEvent())).resolves.toBeUndefined();

		expect(saveSessionState).not.toHaveBeenCalled();
	});

	// Go: lifecycle.go handleLifecycleCompaction — Story-side divergence:
	// analyzer failure is swallowed and offset falls back to 0.
	it('TranscriptAnalyzer throws → offset fallback 0 + log.warn', async () => {
		const state = makeState({ transcriptOffset: 50, compactionCount: 0 });
		vi.mocked(loadSessionState).mockResolvedValue(state);
		const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});

		const agent = makeTranscriptAgent(async () => {
			throw new Error('transcript corrupt');
		});

		await handleCompaction(agent, makeEvent());

		const [saved] = vi.mocked(saveSessionState).mock.calls[0] as [SessionState];
		expect(saved.transcriptOffset).toBe(0);
		expect(saved.compactionCount).toBe(1);
		expect(warnSpy).toHaveBeenCalledWith(
			expect.any(Object),
			'failed to re-read transcript position after compaction',
			expect.objectContaining({ error: 'transcript corrupt' }),
		);
		warnSpy.mockRestore();
	});

	// Go: lifecycle.go handleLifecycleCompaction — Agent without TranscriptAnalyzer
	// gets offset = 0 (compactionCount still bumped).
	it('non-TranscriptAnalyzer agent → offset 0 + compactionCount bump', async () => {
		const state = makeState({ transcriptOffset: 50, compactionCount: 2 });
		vi.mocked(loadSessionState).mockResolvedValue(state);

		await handleCompaction(makeAgent(), makeEvent());

		const [saved] = vi.mocked(saveSessionState).mock.calls[0] as [SessionState];
		expect(saved.transcriptOffset).toBe(0);
		expect(saved.compactionCount).toBe(3);
	});

	// Story 补充：merges event.model (and other metadata) via the shared
	// persistEventMetadataToState so one dispatch call carries metrics through.
	it('persists event.model via persistEventMetadataToState', async () => {
		const state = makeState();
		vi.mocked(loadSessionState).mockResolvedValue(state);

		await handleCompaction(
			makeTranscriptAgent(7),
			makeEvent({ model: 'sonnet-4.6', contextTokens: 9999 }),
		);

		const [saved] = vi.mocked(saveSessionState).mock.calls[0] as [SessionState];
		expect(saved.modelName).toBe('sonnet-4.6');
		expect(saved.contextTokens).toBe(9999);
	});

	// Story 补充: loadSessionState rejection is warn-logged + handler returns silently
	it('loadSessionState rejection is warn-logged + handler returns silently', async () => {
		vi.mocked(loadSessionState).mockRejectedValue(new Error('load crash'));
		const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});

		await expect(handleCompaction(makeAgent(), makeEvent())).resolves.toBeUndefined();

		expect(warnSpy).toHaveBeenCalledWith(
			expect.any(Object),
			'failed to load session state for compaction',
			expect.objectContaining({ error: 'load crash' }),
		);
		expect(saveSessionState).not.toHaveBeenCalled();
		warnSpy.mockRestore();
	});

	// Go: lifecycle.go — transitionAndLog(EventCompaction, NoOpActionHandler)
	// fires once per compaction. Stays in ACTIVE phase (no strategy actions).
	it('fires transitionAndLog with PhaseEvent.Compaction exactly once', async () => {
		const state = makeState({ transcriptOffset: 50, compactionCount: 0 });
		vi.mocked(loadSessionState).mockResolvedValue(state);

		await handleCompaction(makeTranscriptAgent(8), makeEvent());

		expect(transitionAndLog).toHaveBeenCalledTimes(1);
		const [stateArg, eventArg, ctxArg, handlerArg] = vi.mocked(transitionAndLog).mock
			.calls[0] as unknown as [SessionState, PhaseEvent, unknown, { run: () => Promise<void> }];
		expect(stateArg).toBe(state);
		expect(eventArg).toBe(PhaseEvent.Compaction);
		expect(ctxArg).toEqual({ hasFilesTouched: false, isRebaseInProgress: false });
		expect(handlerArg).toBeDefined();
	});

	// Go: lifecycle.go — transition failure is warn-logged but does NOT
	// block saveSessionState (so transcriptOffset / compactionCount still persist).
	it('transitionAndLog failure is logged + saveSessionState still runs', async () => {
		const state = makeState({ transcriptOffset: 0, compactionCount: 0 });
		vi.mocked(loadSessionState).mockResolvedValue(state);
		vi.mocked(transitionAndLog).mockRejectedValue(new Error('bad FSM'));
		const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});

		await handleCompaction(makeTranscriptAgent(4), makeEvent());

		expect(warnSpy).toHaveBeenCalledWith(
			expect.any(Object),
			'compaction transition failed',
			expect.objectContaining({ error: 'bad FSM' }),
		);
		expect(saveSessionState).toHaveBeenCalledTimes(1);
		const [saved] = vi.mocked(saveSessionState).mock.calls[0] as [SessionState];
		expect(saved.transcriptOffset).toBe(4);
		expect(saved.compactionCount).toBe(1);
		warnSpy.mockRestore();
	});

	// Go: lifecycle.go: handleLifecycleCompaction — Go warn-only on save failure;
	// Story-side TS-divergence propagates error for CI visibility (matches
	// model-update / session-end non-fail-open save contract).
	it('handleCompaction rethrows when saveSessionState rejects', async () => {
		const state = makeState({ transcriptOffset: 0, compactionCount: 0 });
		vi.mocked(loadSessionState).mockResolvedValue(state);
		vi.mocked(saveSessionState).mockRejectedValue(new Error('disk full'));

		await expect(handleCompaction(makeTranscriptAgent(3), makeEvent())).rejects.toThrow(
			'disk full',
		);

		expect(saveSessionState).toHaveBeenCalledTimes(1);
	});
});
