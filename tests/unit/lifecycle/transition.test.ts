/**
 * Phase 7 Part 2 `src/lifecycle/transition.ts` — 8 case.
 *
 * Go 参考：`cmd/entire/cli/lifecycle.go` (`transitionSessionTurnEnd`).
 * Go 无直接单测；全部 8 case 均为 Story 补充，覆盖 4 子步骤 × happy/failure
 * + metadata 持久化确认 + log-context agent 字段回退。
 *
 * TS-divergence from Go:
 *
 * 1. `ManualCommitStrategy` 在此处是 `new ManualCommitStrategy()`（Go 使用
 *    `GetStrategy(ctx)`）。mock 方式：hoisted `handleTurnEndMock` 注入构造
 *    返回对象上。
 * 2. 所有子步骤均 fail-open —— 唯一 NOT save 的分支是 "state 缺失/load 抛错"
 *    这一对；transition/strategy/save 任一失败都 `log.warn` 继续（case 4/5/6）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Event } from '@/agent/event';
import * as log from '@/log';
import type { SessionState } from '@/session/state-store';

// Go: lifecycle.go transitionSessionTurnEnd — mock strategy + session-state
// boundary. `transitionAndLog` 也在 `@/strategy/session-state` 内。
vi.mock('@/strategy/session-state', () => ({
	loadSessionState: vi.fn(async () => null),
	saveSessionState: vi.fn(async () => {}),
	transitionAndLog: vi.fn(async () => {}),
}));

const loadPrePromptStateMock = vi.hoisted(() => vi.fn());
vi.mock('@/lifecycle/pre-prompt-state', () => ({
	loadPrePromptState: loadPrePromptStateMock,
}));

const handleTurnEndMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/strategy/manual-commit', () => ({
	ManualCommitStrategy: vi.fn().mockImplementation(() => ({ handleTurnEnd: handleTurnEndMock })),
}));

import { transitionSessionTurnEnd } from '@/lifecycle/transition';
import { loadSessionState, saveSessionState, transitionAndLog } from '@/strategy/session-state';

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

function makeEvent(overrides: Partial<Event> = {}): Event {
	return {
		type: 'TurnEnd',
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

describe('lifecycle/transition — transitionSessionTurnEnd', () => {
	beforeEach(() => {
		vi.mocked(loadSessionState).mockReset().mockResolvedValue(null);
		vi.mocked(saveSessionState).mockReset().mockResolvedValue();
		vi.mocked(transitionAndLog).mockReset().mockResolvedValue();
		loadPrePromptStateMock.mockReset().mockResolvedValue(null);
		handleTurnEndMock.mockReset().mockResolvedValue(undefined);
	});

	afterEach(() => {
		// Only clear spy history — NOT `restoreAllMocks()` which would
		// undo the module-level `vi.mock('@/strategy/manual-commit')`
		// factory binding (making `handleTurnEndMock` unreachable).
		vi.clearAllMocks();
	});

	// Case 1: null state → early return, nothing written. Mirrors Go
	// `lifecycle.go if turnState == nil { return }`.
	it('missing session state → silent return', async () => {
		vi.mocked(loadSessionState).mockResolvedValue(null);

		await expect(transitionSessionTurnEnd('sid-1', makeEvent())).resolves.toBeUndefined();

		expect(loadSessionState).toHaveBeenCalledWith('sid-1');
		expect(transitionAndLog).not.toHaveBeenCalled();
		expect(handleTurnEndMock).not.toHaveBeenCalled();
		expect(saveSessionState).not.toHaveBeenCalled();
	});

	// Case 2: Go parity happy-path — state loads, transition fires, strategy
	// dispatches turn-end, state saves. All 4 spies invoked once in Go-order.
	it('happy path: loads state, transitions, calls strategy.handleTurnEnd, saves', async () => {
		const state = makeState();
		const order: string[] = [];
		vi.mocked(loadSessionState).mockImplementation(async () => {
			order.push('load');
			return state;
		});
		vi.mocked(transitionAndLog).mockImplementation(async () => {
			order.push('transition');
		});
		handleTurnEndMock.mockImplementation(async () => {
			order.push('strategy');
		});
		vi.mocked(saveSessionState).mockImplementation(async () => {
			order.push('save');
		});

		await transitionSessionTurnEnd('sid-1', makeEvent({ model: 'sonnet' }));

		expect(loadSessionState).toHaveBeenCalledWith('sid-1');
		expect(transitionAndLog).toHaveBeenCalledOnce();
		expect(handleTurnEndMock).toHaveBeenCalledWith(state);
		expect(saveSessionState).toHaveBeenCalledWith(state);
		expect(order).toEqual(['load', 'transition', 'strategy', 'save']);
	});

	// Case 3: `persistEventMetadataToState` merges `event.model` into loaded
	// state BEFORE transition/save. Asserts the same reference reaches save.
	it('persistEventMetadataToState applied to loaded state', async () => {
		const state = makeState();
		vi.mocked(loadSessionState).mockResolvedValue(state);

		await transitionSessionTurnEnd('sid-1', makeEvent({ model: 'sonnet' }));

		const [saved] = vi.mocked(saveSessionState).mock.calls[0] as [SessionState];
		expect(saved.modelName).toBe('sonnet');
		// Same object reference — persistEventMetadataToState mutates in-place.
		expect(saved).toBe(state);
	});

	it('records Story turn metrics and active duration from pre-prompt timestamp', async () => {
		const state = makeState({
			startedAt: '2026-04-27T09:59:00.000Z',
			turnId: 'turn-current',
		});
		vi.mocked(loadSessionState).mockResolvedValue(state);
		loadPrePromptStateMock.mockResolvedValue({
			sessionId: 'sid-1',
			startTime: new Date('2026-04-27T10:00:00.000Z'),
			untrackedFiles: [],
			transcriptOffset: 12,
		});

		await transitionSessionTurnEnd(
			'sid-1',
			makeEvent({ timestamp: new Date('2026-04-27T10:00:30.000Z') }),
		);

		const [saved] = vi.mocked(saveSessionState).mock.calls[0] as [SessionState];
		expect(saved.sessionDurationMs).toBe(90_000);
		expect(saved.activeDurationMs).toBe(30_000);
		expect(saved.turnMetrics).toEqual([
			{
				turnId: 'turn-current',
				startedAt: '2026-04-27T10:00:00.000Z',
				endedAt: '2026-04-27T10:00:30.000Z',
				durationMs: 30_000,
			},
		]);
	});

	it('falls back to indexed turn ids when state.turnId is missing', async () => {
		const existing = {
			turnId: 'sid-1:1',
			startedAt: '2026-04-27T09:59:30.000Z',
			endedAt: '2026-04-27T09:59:40.000Z',
			durationMs: 10_000,
		};
		const state = makeState({
			startedAt: '2026-04-27T09:59:00.000Z',
			turnId: undefined,
			turnMetrics: [existing],
			activeDurationMs: 10_000,
		});
		vi.mocked(loadSessionState).mockResolvedValue(state);
		loadPrePromptStateMock.mockResolvedValue({
			sessionId: 'sid-1',
			startTime: new Date('2026-04-27T10:00:00.000Z'),
			untrackedFiles: [],
			transcriptOffset: 1,
		});

		await transitionSessionTurnEnd(
			'sid-1',
			makeEvent({ timestamp: new Date('2026-04-27T10:00:30.000Z') }),
		);

		const [saved] = vi.mocked(saveSessionState).mock.calls[0] as [SessionState];
		expect(saved.turnMetrics).toHaveLength(2);
		expect(saved.turnMetrics?.[1]?.turnId).toBe('sid-1:2');
		expect(saved.activeDurationMs).toBe(40_000);
	});

	it('updates wall-clock duration when pre-prompt state is missing', async () => {
		const state = makeState({ startedAt: '2026-04-27T09:59:00.000Z' });
		vi.mocked(loadSessionState).mockResolvedValue(state);
		loadPrePromptStateMock.mockResolvedValue(null);

		await transitionSessionTurnEnd(
			'sid-1',
			makeEvent({ timestamp: new Date('2026-04-27T10:00:30.000Z') }),
		);

		const [saved] = vi.mocked(saveSessionState).mock.calls[0] as [SessionState];
		expect(saved.sessionDurationMs).toBe(90_000);
		expect(saved.activeDurationMs).toBeUndefined();
		expect(saved.turnMetrics).toBeUndefined();
	});

	it('skips negative turn duration when clocks move backwards', async () => {
		const state = makeState({ startedAt: '2026-04-27T09:59:00.000Z' });
		vi.mocked(loadSessionState).mockResolvedValue(state);
		loadPrePromptStateMock.mockResolvedValue({
			sessionId: 'sid-1',
			startTime: new Date('2026-04-27T10:01:00.000Z'),
			untrackedFiles: [],
			transcriptOffset: 12,
		});
		const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});

		await transitionSessionTurnEnd(
			'sid-1',
			makeEvent({ timestamp: new Date('2026-04-27T10:00:30.000Z') }),
		);

		const [saved] = vi.mocked(saveSessionState).mock.calls[0] as [SessionState];
		expect(saved.sessionDurationMs).toBe(90_000);
		expect(saved.activeDurationMs).toBeUndefined();
		expect(saved.turnMetrics).toBeUndefined();
		expect(warnSpy).toHaveBeenCalledWith(
			expect.objectContaining({ component: 'lifecycle', sessionId: 'sid-1' }),
			'skipping negative turn duration metric',
			expect.objectContaining({ durationMs: -30_000 }),
		);
	});

	// Case 4 (failure path): transitionAndLog reject → log.warn + strategy still runs.
	it('transitionAndLog failure → log.warn + continues to strategy.handleTurnEnd', async () => {
		const state = makeState();
		vi.mocked(loadSessionState).mockResolvedValue(state);
		vi.mocked(transitionAndLog).mockRejectedValue(new Error('fsm boom'));
		const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});

		await expect(transitionSessionTurnEnd('sid-1', makeEvent())).resolves.toBeUndefined();

		expect(warnSpy).toHaveBeenCalledWith(
			expect.any(Object),
			'turn-end transition failed',
			expect.objectContaining({ error: 'fsm boom' }),
		);
		expect(handleTurnEndMock).toHaveBeenCalledWith(state);
		expect(saveSessionState).toHaveBeenCalledWith(state);
	});

	// Case 5 (failure path): strategy.handleTurnEnd reject → log.warn + save runs.
	it('strategy.handleTurnEnd failure → log.warn + continues to save', async () => {
		const state = makeState();
		vi.mocked(loadSessionState).mockResolvedValue(state);
		handleTurnEndMock.mockRejectedValue(new Error('strategy boom'));
		const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});

		await expect(transitionSessionTurnEnd('sid-1', makeEvent())).resolves.toBeUndefined();

		expect(warnSpy).toHaveBeenCalledWith(
			expect.any(Object),
			'turn-end action dispatch failed',
			expect.objectContaining({ error: 'strategy boom' }),
		);
		expect(saveSessionState).toHaveBeenCalledWith(state);
	});

	// Case 6 (failure path, fail-open terminal): saveSessionState reject →
	// log.warn + the function still resolves (agent turn must not re-block).
	it('saveSessionState failure → log.warn + resolves (fail-open)', async () => {
		vi.mocked(loadSessionState).mockResolvedValue(makeState());
		vi.mocked(saveSessionState).mockRejectedValue(new Error('disk boom'));
		const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});

		await expect(transitionSessionTurnEnd('sid-1', makeEvent())).resolves.toBeUndefined();

		expect(warnSpy).toHaveBeenCalledWith(
			expect.any(Object),
			'failed to update session phase on turn end',
			expect.objectContaining({ error: 'disk boom' }),
		);
	});

	// Case 7 (failure path): load reject → log.warn + early silent return —
	// NO state got loaded, so NO downstream side-effects should fire.
	it('loadSessionState failure → log.warn + silent return', async () => {
		vi.mocked(loadSessionState).mockRejectedValue(new Error('disk err'));
		const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});

		await expect(transitionSessionTurnEnd('sid-1', makeEvent())).resolves.toBeUndefined();

		expect(warnSpy).toHaveBeenCalledWith(
			expect.any(Object),
			'failed to load session state for turn end',
			expect.objectContaining({ error: 'disk err' }),
		);
		expect(transitionAndLog).not.toHaveBeenCalled();
		expect(handleTurnEndMock).not.toHaveBeenCalled();
		expect(saveSessionState).not.toHaveBeenCalled();
	});

	// Case 8: log-context `agent` field plumbing. Covers both the populated
	// branch (`event.metadata.agent = 'claude-code'`) and the fallback branch
	// (`event.metadata = {}` → `'unknown'`). Uses load-fail to force a
	// predictable single `log.warn` call per invocation.
	it('log context carries event.metadata.agent (populated + "unknown" fallback)', async () => {
		const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
		vi.mocked(loadSessionState).mockRejectedValue(new Error('x'));

		await transitionSessionTurnEnd('sid-1', makeEvent({ metadata: { agent: 'claude-code' } }));
		expect(warnSpy).toHaveBeenLastCalledWith(
			expect.objectContaining({ agent: 'claude-code', sessionId: 'sid-1' }),
			expect.any(String),
			expect.any(Object),
		);

		warnSpy.mockClear();
		await transitionSessionTurnEnd('sid-1', makeEvent({ metadata: {} }));
		expect(warnSpy).toHaveBeenLastCalledWith(
			expect.objectContaining({ agent: 'unknown', sessionId: 'sid-1' }),
			expect.any(String),
			expect.any(Object),
		);
	});
});
