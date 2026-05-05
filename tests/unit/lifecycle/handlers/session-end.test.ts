/**
 * Phase 7 Part 1 `src/lifecycle/handlers/session-end.ts` — 5 case.
 *
 * Go 参考：`cmd/entire/cli/lifecycle.go` (`handleLifecycleSessionEnd` +
 * `markSessionEnded`) + `lifecycle_test.go:
 * TestHandleLifecycleSessionEnd_EmptySessionID`.
 *
 * TS-divergences from Go (documented in handler source):
 *
 * 1. `state.phase === 'ended'` idempotent short-circuit (Go re-runs
 *    transition which bumps lastInteractionTime).
 * 2. `markSessionEnded` error blocks eager condense (Go parity but TS
 *    logs a non-fatal warn instead of leaking the err upward).
 * 3. Strategy is a fresh `new ManualCommitStrategy()` (Go uses
 *    `GetStrategy(ctx)`).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Event } from '@/agent/event';
import type { Agent } from '@/agent/interfaces';
import { AGENT_NAME_CLAUDE_CODE, type AgentName } from '@/agent/types';
import { handleSessionEnd, markSessionEnded } from '@/lifecycle/handlers/session-end';
import * as log from '@/log';
import type { SessionState } from '@/session/state-store';

const condenseMock = vi.hoisted(() => vi.fn(async (_: string) => {}));

vi.mock('@/strategy/session-state', () => ({
	loadSessionState: vi.fn(async () => null),
	saveSessionState: vi.fn(async () => {}),
	storeModelHint: vi.fn(async () => {}),
	transitionAndLog: vi.fn(async () => {}),
}));

vi.mock('@/strategy/manual-commit', () => ({
	ManualCommitStrategy: vi.fn().mockImplementation(() => ({
		condenseAndMarkFullyCondensed: condenseMock,
	})),
}));

import { loadSessionState, saveSessionState, transitionAndLog } from '@/strategy/session-state';

function makeEvent(overrides: Partial<Event> = {}): Event {
	return {
		type: 'SessionEnd',
		sessionId: 'sid-1',
		previousSessionId: '',
		sessionRef: '',
		prompt: '',
		model: '',
		timestamp: new Date('2026-04-21T13:00:00.000Z'),
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
		phase: 'active',
		stepCount: 0,
		...overrides,
	};
}

describe('lifecycle/handlers/session-end', () => {
	beforeEach(() => {
		vi.mocked(loadSessionState).mockReset().mockResolvedValue(null);
		vi.mocked(saveSessionState).mockReset().mockResolvedValue();
		vi.mocked(transitionAndLog).mockReset().mockResolvedValue();
		condenseMock.mockReset().mockResolvedValue(undefined);
	});

	// Go: lifecycle_test.go TestHandleLifecycleSessionEnd_EmptySessionID
	// TS-divergence: rather than returning early (Go), TS falls back to
	// UNKNOWN_SESSION_ID and still attempts the mark + condense so any
	// dangling "unknown" session state gets swept.
	it('fallback to UNKNOWN_SESSION_ID when event.sessionId empty', async () => {
		const state = makeState({ sessionId: 'unknown' });
		vi.mocked(loadSessionState).mockResolvedValue(state);

		await expect(
			handleSessionEnd(makeAgent(), makeEvent({ sessionId: '' })),
		).resolves.toBeUndefined();

		expect(loadSessionState).toHaveBeenCalledWith('unknown');
		expect(condenseMock).toHaveBeenCalledWith('unknown');
	});

	// Go: lifecycle.go markSessionEnded — phase transitions active → ended
	// and endedAt = time.Now() (NOT event.timestamp). Story matches Go's choice
	// so the terminal marker reflects when Story actually wrote the state.
	it('marks state phase = ended + endedAt = current time (Go parity, not event.timestamp)', async () => {
		const state = makeState({ phase: 'active' });
		vi.mocked(loadSessionState).mockResolvedValue(state);
		vi.mocked(transitionAndLog).mockImplementation(async (s) => {
			s.phase = 'ended';
		});

		const before = Date.now();
		await handleSessionEnd(makeAgent(), makeEvent());
		const after = Date.now();

		const [saved] = vi.mocked(saveSessionState).mock.calls[0] as [SessionState];
		expect(saved.phase).toBe('ended');
		expect(saved.endedAt).toBeDefined();
		const endedAtMs = new Date(saved.endedAt as string).getTime();
		expect(endedAtMs).toBeGreaterThanOrEqual(before);
		expect(endedAtMs).toBeLessThanOrEqual(after);
		expect(saved.endedAt).not.toBe('2026-04-21T13:00:00.000Z');
	});

	// TS-divergence from Go: short-circuit when already ended to keep
	// `lastInteractionTime` stable (Go re-runs the transition).
	it('idempotent: already-ended session is not re-saved', async () => {
		vi.mocked(loadSessionState).mockResolvedValue(makeState({ phase: 'ended' }));

		await markSessionEnded(makeEvent(), 'sid-1');

		expect(saveSessionState).not.toHaveBeenCalled();
		expect(transitionAndLog).not.toHaveBeenCalled();
	});

	// Go: lifecycle.go — missing state → silent no-op
	// Story-side divergence: condense is still attempted for the sessionID
	// so any dangling non-state metadata gets swept.
	it('missing state → silent skip + condense still attempted', async () => {
		vi.mocked(loadSessionState).mockResolvedValue(null);

		await handleSessionEnd(makeAgent(), makeEvent());

		expect(saveSessionState).not.toHaveBeenCalled();
		expect(condenseMock).toHaveBeenCalledWith('sid-1');
	});

	// Go: lifecycle.go — eager condense failure is logged + swallowed
	// (PostCommit carry-forward retries on the next commit).
	it('condenseAndMarkFullyCondensed failure logged not re-thrown', async () => {
		vi.mocked(loadSessionState).mockResolvedValue(makeState({ phase: 'active' }));
		condenseMock.mockRejectedValue(new Error('condense boom'));
		const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});

		await expect(handleSessionEnd(makeAgent(), makeEvent())).resolves.toBeUndefined();

		expect(warnSpy).toHaveBeenCalledWith(
			expect.any(Object),
			'eager condensation failed (non-fatal)',
			expect.objectContaining({ sessionId: 'sid-1', error: 'condense boom' }),
		);
		warnSpy.mockRestore();
	});

	// Story 补充: markSessionEnded error blocks eager condense (save rejection path)
	it('markSessionEnded rejection blocks eager condense', async () => {
		vi.mocked(loadSessionState).mockResolvedValue(makeState({ phase: 'active' }));
		vi.mocked(saveSessionState).mockRejectedValue(new Error('disk boom'));
		const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});

		await expect(handleSessionEnd(makeAgent(), makeEvent())).resolves.toBeUndefined();

		expect(warnSpy).toHaveBeenCalledWith(
			expect.any(Object),
			'failed to mark session ended',
			expect.objectContaining({ error: 'disk boom' }),
		);
		expect(condenseMock).not.toHaveBeenCalled();
		warnSpy.mockRestore();
	});

	// Story 补充: transitionAndLog failure inside markSessionEnded is logged but
	// endedAt + saveSessionState still run (so the terminal marker still persists
	// even on bad FSM). Mirrors Go: transition warn + save runs unconditionally.
	it('transitionAndLog failure is logged + endedAt/saveSessionState still run', async () => {
		const state = makeState({ phase: 'active' });
		vi.mocked(loadSessionState).mockResolvedValue(state);
		vi.mocked(transitionAndLog).mockRejectedValue(new Error('bad FSM'));
		const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});

		const before = Date.now();
		await handleSessionEnd(makeAgent(), makeEvent());
		const after = Date.now();

		expect(warnSpy).toHaveBeenCalledWith(
			expect.any(Object),
			'session stop transition failed',
			expect.objectContaining({ error: 'bad FSM' }),
		);
		expect(saveSessionState).toHaveBeenCalledTimes(1);
		const [saved] = vi.mocked(saveSessionState).mock.calls[0] as [SessionState];
		const endedAtMs = new Date(saved.endedAt as string).getTime();
		expect(endedAtMs).toBeGreaterThanOrEqual(before);
		expect(endedAtMs).toBeLessThanOrEqual(after);
		warnSpy.mockRestore();
	});

	// Story 补充: endedAt always reflects "now" — even when event.timestamp is
	// invalid (Go parity: time.Now() ignores hook timestamp entirely).
	it('endedAt always uses new Date() regardless of event.timestamp validity', async () => {
		vi.mocked(loadSessionState).mockResolvedValue(makeState({ phase: 'active' }));
		const before = Date.now();

		const ev = makeEvent();
		// biome-ignore lint/suspicious/noExplicitAny: force invalid Date to prove fallback unused
		(ev as any).timestamp = new Date('not-a-valid-date');

		await handleSessionEnd(makeAgent(), ev);

		const [saved] = vi.mocked(saveSessionState).mock.calls[0] as [SessionState];
		expect(saved.endedAt).toBeDefined();
		const savedMs = new Date(saved.endedAt as string).getTime();
		expect(savedMs).toBeGreaterThanOrEqual(before);
		expect(savedMs).toBeLessThanOrEqual(Date.now());
	});

	// Go: lifecycle.go — persistEventMetadataToState is invoked BEFORE
	// transitionAndLog (so transition sees up-to-date metadata), and endedAt is
	// assigned AFTER the transition (so 'now' reflects the moment we wrote the
	// terminal state, not when the transition began).
	it('Go-parity call order: persistEventMetadata → transition → endedAt → save', async () => {
		const order: string[] = [];
		const state = makeState({ phase: 'active' });
		vi.mocked(loadSessionState).mockResolvedValue(state);
		vi.mocked(transitionAndLog).mockImplementation(async () => {
			order.push('transition');
			expect(state.modelName).toBe('opus-x');
			expect(state.endedAt).toBeUndefined();
		});
		vi.mocked(saveSessionState).mockImplementation(async (s) => {
			order.push('save');
			expect(s.endedAt).toBeDefined();
		});

		await handleSessionEnd(makeAgent(), makeEvent({ model: 'opus-x' }));

		expect(order).toEqual(['transition', 'save']);
	});
});
