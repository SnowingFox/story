/**
 * `src/lifecycle/dispatch-helpers.ts` — 8 case.
 *
 * The full lifecycle `dispatch.ts` test file re-exports + covers these
 * helpers (identity + behavior), but audit-test-go-parity requires each
 * `Mirrors Go` src file to pair with a same-named test file. This file
 * owns the Go-parity smoke tests for the helpers; the complex branch
 * coverage for `persistEventMetadataToState` / `resolveTranscriptOffset`
 * lives in `dispatch.test.ts` (where it was shipped in Part 1 via the
 * re-export).
 *
 * Go 参考：`cmd/entire/cli/lifecycle.go`:
 * - `resolveTranscriptOffset` (§817-839)
 * - `parseTranscriptForCheckpointUUID` (§843-849)
 * - `logFileChanges` (§916-921)
 * - `persistEventMetadataToState` (§923-948)
 * - `unknownSessionID` (rewind.go)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Event } from '@/agent/event';
import {
	logFileChanges,
	parseTranscriptForCheckpointUUID,
	persistEventMetadataToState,
	resolveTranscriptOffset,
	UNKNOWN_SESSION_ID,
} from '@/lifecycle/dispatch-helpers';
import * as log from '@/log';
import type { SessionState } from '@/session/state-store';

const loadSessionStateMock = vi.hoisted(() => vi.fn(async () => null as SessionState | null));
vi.mock('@/strategy/session-state', () => ({ loadSessionState: loadSessionStateMock }));

const parseFromFileAtLineMock = vi.hoisted(() =>
	vi.fn(async (_p: string, _start: number) => [] as unknown[]),
);
vi.mock('@/transcript', () => ({ parseFromFileAtLine: parseFromFileAtLineMock }));

beforeEach(() => {
	loadSessionStateMock.mockReset().mockResolvedValue(null);
	parseFromFileAtLineMock.mockReset().mockResolvedValue([]);
});

afterEach(() => {
	vi.clearAllMocks();
});

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

describe('lifecycle/dispatch-helpers', () => {
	describe('UNKNOWN_SESSION_ID', () => {
		// Go: rewind.go unknownSessionID = "unknown"
		it('equals the literal string "unknown"', () => {
			expect(UNKNOWN_SESSION_ID).toBe('unknown');
		});
	});

	describe('resolveTranscriptOffset', () => {
		// Go: lifecycle.go resolveTranscriptOffset / prefer pre-prompt state
		it('prefers preState.transcriptOffset when positive', async () => {
			const preState = {
				sessionId: 'sid-1',
				untrackedFiles: [],
				transcriptOffset: 42,
				startTime: new Date(0),
			};
			const offset = await resolveTranscriptOffset(preState, 'sid-1');
			expect(offset).toBe(42);
			expect(loadSessionStateMock).not.toHaveBeenCalled();
		});

		// Go: lifecycle.go fallback to sessionState.CheckpointTranscriptStart
		it('falls back to sessionState.checkpointTranscriptStart', async () => {
			loadSessionStateMock.mockResolvedValueOnce(makeState({ checkpointTranscriptStart: 99 }));
			const offset = await resolveTranscriptOffset(null, 'sid-1');
			expect(offset).toBe(99);
		});

		// Go: lifecycle.go default return 0
		it('returns 0 when both preState and sessionState are missing', async () => {
			loadSessionStateMock.mockResolvedValueOnce(null);
			const offset = await resolveTranscriptOffset(null, 'sid-1');
			expect(offset).toBe(0);
		});

		// Story 补充: loadSessionState failure is fail-open (swallow + return 0)
		it('swallows loadSessionState error and returns 0', async () => {
			const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
			loadSessionStateMock.mockRejectedValueOnce(new Error('disk full'));
			const offset = await resolveTranscriptOffset(null, 'sid-1');
			expect(offset).toBe(0);
			expect(warnSpy).toHaveBeenCalledWith(
				expect.objectContaining({ component: 'lifecycle', sessionId: 'sid-1' }),
				'failed to load session state for transcript offset',
				expect.objectContaining({ error: 'disk full' }),
			);
			warnSpy.mockRestore();
		});
	});

	describe('parseTranscriptForCheckpointUUID', () => {
		// Go: lifecycle.go — wraps ParseFromFileAtLine(transcriptPath, 0)
		it('returns parseFromFileAtLine output on success', async () => {
			parseFromFileAtLineMock.mockResolvedValueOnce([{ uuid: 'u1' }, { uuid: 'u2' }]);
			const result = await parseTranscriptForCheckpointUUID('/tmp/x.jsonl');
			expect(result).toEqual([{ uuid: 'u1' }, { uuid: 'u2' }]);
			expect(parseFromFileAtLineMock).toHaveBeenCalledWith('/tmp/x.jsonl', 0);
		});

		// Story 补充: fail-open — read/parse failure returns null (caller uses 0 offset)
		it('returns null on parse failure', async () => {
			parseFromFileAtLineMock.mockRejectedValueOnce(new Error('ENOENT'));
			const result = await parseTranscriptForCheckpointUUID('/tmp/missing.jsonl');
			expect(result).toBeNull();
		});
	});

	describe('logFileChanges', () => {
		// Go: lifecycle.go logFileChanges — emits counts at DEBUG
		it('logs modified / new / deleted counts at debug', () => {
			const debugSpy = vi.spyOn(log, 'debug').mockImplementation(() => {});
			logFileChanges({ component: 'lifecycle' }, ['a.ts'], ['b.ts', 'c.ts'], []);
			expect(debugSpy).toHaveBeenCalledWith(
				{ component: 'lifecycle' },
				'files changed during session',
				{ modified: 1, new: 2, deleted: 0 },
			);
			debugSpy.mockRestore();
		});
	});

	describe('persistEventMetadataToState', () => {
		// Go: lifecycle.go — merges model/durationMs/turnCount/tokens
		it('increments sessionTurnCount by 1 on TurnEnd when event.turnCount is 0', () => {
			const state = makeState({ sessionTurnCount: 2 });
			persistEventMetadataToState(makeEvent({ type: 'TurnEnd', turnCount: 0 }), state);
			expect(state.sessionTurnCount).toBe(3);
		});

		it('keeps hook-provided duration authoritative for wall-clock session duration', () => {
			const state = makeState({ sessionDurationMs: 90_000 });
			persistEventMetadataToState(makeEvent({ type: 'SessionEnd', durationMs: 120_000 }), state);
			expect(state.sessionDurationMs).toBe(120_000);
		});
	});
});
