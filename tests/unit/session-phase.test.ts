import { describe, expect, it } from 'vitest';
import {
	Action,
	type ActionHandler,
	actionLabel,
	applyTransition,
	Event,
	eventLabel,
	NoOpActionHandler,
	normalizePhase,
	type Phase,
	type TransitionContext,
	transition,
} from '@/session/phase';
import type { SessionState } from '@/session/state-store';

const emptyCtx: TransitionContext = { hasFilesTouched: false, isRebaseInProgress: false };
const rebaseCtx: TransitionContext = { hasFilesTouched: false, isRebaseInProgress: true };
const filesCtx: TransitionContext = { hasFilesTouched: true, isRebaseInProgress: false };

function newState(phase: Phase): SessionState {
	return {
		sessionId: 'test-session',
		baseCommit: 'abc1234',
		startedAt: new Date().toISOString(),
		phase,
		stepCount: 0,
	};
}

/**
 * Spy handler that records which methods were called and can be configured to
 * throw. Each handler defaults to no-op via {@link NoOpActionHandler}.
 */
class SpyHandler extends NoOpActionHandler {
	called = {
		condense: false,
		condenseIfFilesTouched: false,
		discardIfNoFiles: false,
		warnStaleSession: false,
	};
	errors: Partial<Record<keyof SpyHandler['called'], Error | unknown>> = {};

	override handleCondense(state: SessionState): void {
		this.called.condense = true;
		this.maybeThrow('condense', state);
	}
	override handleCondenseIfFilesTouched(state: SessionState): void {
		this.called.condenseIfFilesTouched = true;
		this.maybeThrow('condenseIfFilesTouched', state);
	}
	override handleDiscardIfNoFiles(state: SessionState): void {
		this.called.discardIfNoFiles = true;
		this.maybeThrow('discardIfNoFiles', state);
	}
	override handleWarnStaleSession(state: SessionState): void {
		this.called.warnStaleSession = true;
		this.maybeThrow('warnStaleSession', state);
	}

	private maybeThrow(key: keyof SpyHandler['called'], _: SessionState): void {
		if (this.errors[key] !== undefined) {
			throw this.errors[key];
		}
	}
}

describe('normalizePhase', () => {
	it('maps known values directly', () => {
		expect(normalizePhase('idle')).toBe('idle');
		expect(normalizePhase('active')).toBe('active');
		expect(normalizePhase('ended')).toBe('ended');
	});

	it('migrates legacy `active_committed` to `active`', () => {
		expect(normalizePhase('active_committed')).toBe('active');
	});

	it('falls back to `idle` for empty / unknown / wrong-case values', () => {
		expect(normalizePhase('')).toBe('idle');
		expect(normalizePhase('bogus')).toBe('idle');
		expect(normalizePhase('ACTIVE')).toBe('idle');
	});
});

describe('eventLabel', () => {
	it('returns the human-readable name for every event', () => {
		expect(eventLabel(Event.TurnStart)).toBe('TurnStart');
		expect(eventLabel(Event.TurnEnd)).toBe('TurnEnd');
		expect(eventLabel(Event.GitCommit)).toBe('GitCommit');
		expect(eventLabel(Event.SessionStart)).toBe('SessionStart');
		expect(eventLabel(Event.SessionStop)).toBe('SessionStop');
		expect(eventLabel(Event.Compaction)).toBe('Compaction');
	});

	it('falls back to `Event(N)` for cast / deserialized invalid values', () => {
		// Defensive: real-world hits include malformed JSON or out-of-version data.
		expect(eventLabel(999 as Event)).toBe('Event(999)');
	});
});

describe('actionLabel', () => {
	it('returns the human-readable name for every action', () => {
		expect(actionLabel(Action.Condense)).toBe('Condense');
		expect(actionLabel(Action.CondenseIfFilesTouched)).toBe('CondenseIfFilesTouched');
		expect(actionLabel(Action.DiscardIfNoFiles)).toBe('DiscardIfNoFiles');
		expect(actionLabel(Action.WarnStaleSession)).toBe('WarnStaleSession');
		expect(actionLabel(Action.ClearEndedAt)).toBe('ClearEndedAt');
		expect(actionLabel(Action.UpdateLastInteraction)).toBe('UpdateLastInteraction');
	});

	it('falls back to `Action(N)` for cast / deserialized invalid values', () => {
		expect(actionLabel(999 as Action)).toBe('Action(999)');
	});
});

describe('transition from IDLE', () => {
	it('TurnStart → ACTIVE + [UpdateLastInteraction]', () => {
		expect(transition('idle', Event.TurnStart, emptyCtx)).toEqual({
			newPhase: 'active',
			actions: [Action.UpdateLastInteraction],
		});
	});

	it('TurnEnd is a no-op', () => {
		expect(transition('idle', Event.TurnEnd, emptyCtx)).toEqual({
			newPhase: 'idle',
			actions: [],
		});
	});

	it('GitCommit triggers Condense', () => {
		expect(transition('idle', Event.GitCommit, emptyCtx)).toEqual({
			newPhase: 'idle',
			actions: [Action.Condense],
		});
	});

	it('GitCommit during rebase skips actions', () => {
		expect(transition('idle', Event.GitCommit, rebaseCtx)).toEqual({
			newPhase: 'idle',
			actions: [],
		});
	});

	it('SessionStart is a no-op', () => {
		expect(transition('idle', Event.SessionStart, emptyCtx)).toEqual({
			newPhase: 'idle',
			actions: [],
		});
	});

	it('SessionStop → ENDED + [UpdateLastInteraction]', () => {
		expect(transition('idle', Event.SessionStop, emptyCtx)).toEqual({
			newPhase: 'ended',
			actions: [Action.UpdateLastInteraction],
		});
	});

	it('Compaction → IDLE + [CondenseIfFilesTouched, UpdateLastInteraction]', () => {
		expect(transition('idle', Event.Compaction, emptyCtx)).toEqual({
			newPhase: 'idle',
			actions: [Action.CondenseIfFilesTouched, Action.UpdateLastInteraction],
		});
	});
});

describe('transition from ACTIVE', () => {
	it('TurnStart stays ACTIVE (Ctrl-C recovery)', () => {
		expect(transition('active', Event.TurnStart, emptyCtx)).toEqual({
			newPhase: 'active',
			actions: [Action.UpdateLastInteraction],
		});
	});

	it('TurnEnd → IDLE + [UpdateLastInteraction]', () => {
		expect(transition('active', Event.TurnEnd, emptyCtx)).toEqual({
			newPhase: 'idle',
			actions: [Action.UpdateLastInteraction],
		});
	});

	it('GitCommit triggers Condense immediately', () => {
		expect(transition('active', Event.GitCommit, emptyCtx)).toEqual({
			newPhase: 'active',
			actions: [Action.Condense],
		});
	});

	it('GitCommit during rebase skips actions', () => {
		expect(transition('active', Event.GitCommit, rebaseCtx)).toEqual({
			newPhase: 'active',
			actions: [],
		});
	});

	it('SessionStart warns about stale session', () => {
		expect(transition('active', Event.SessionStart, emptyCtx)).toEqual({
			newPhase: 'active',
			actions: [Action.WarnStaleSession],
		});
	});

	it('SessionStop → ENDED + [UpdateLastInteraction]', () => {
		expect(transition('active', Event.SessionStop, emptyCtx)).toEqual({
			newPhase: 'ended',
			actions: [Action.UpdateLastInteraction],
		});
	});

	it('Compaction stays ACTIVE + [CondenseIfFilesTouched, UpdateLastInteraction]', () => {
		expect(transition('active', Event.Compaction, emptyCtx)).toEqual({
			newPhase: 'active',
			actions: [Action.CondenseIfFilesTouched, Action.UpdateLastInteraction],
		});
	});
});

describe('transition from ENDED', () => {
	it('TurnStart revives session to ACTIVE', () => {
		expect(transition('ended', Event.TurnStart, emptyCtx)).toEqual({
			newPhase: 'active',
			actions: [Action.ClearEndedAt, Action.UpdateLastInteraction],
		});
	});

	it('TurnEnd is a no-op', () => {
		expect(transition('ended', Event.TurnEnd, emptyCtx)).toEqual({
			newPhase: 'ended',
			actions: [],
		});
	});

	it('GitCommit with files → CondenseIfFilesTouched', () => {
		expect(transition('ended', Event.GitCommit, filesCtx)).toEqual({
			newPhase: 'ended',
			actions: [Action.CondenseIfFilesTouched],
		});
	});

	it('GitCommit without files → DiscardIfNoFiles', () => {
		expect(transition('ended', Event.GitCommit, emptyCtx)).toEqual({
			newPhase: 'ended',
			actions: [Action.DiscardIfNoFiles],
		});
	});

	it('GitCommit during rebase skips actions', () => {
		expect(transition('ended', Event.GitCommit, rebaseCtx)).toEqual({
			newPhase: 'ended',
			actions: [],
		});
	});

	it('SessionStart → IDLE + [ClearEndedAt]', () => {
		expect(transition('ended', Event.SessionStart, emptyCtx)).toEqual({
			newPhase: 'idle',
			actions: [Action.ClearEndedAt],
		});
	});

	it('SessionStop is a no-op', () => {
		expect(transition('ended', Event.SessionStop, emptyCtx)).toEqual({
			newPhase: 'ended',
			actions: [],
		});
	});
});

// E.4 Go parity: unknown numeric Event (deserialized bad JSON / future Go-side
// addition) returns no-op TransitionResult instead of throwing
// NonExhaustiveError. Mirrors Go's `switch event { default: return TransitionResult{} }`.
describe('transition with unknown Event (default branch)', () => {
	it('idle + unknown Event → no-op (stays idle, no actions)', () => {
		// 999 is outside the Event enum range
		expect(transition('idle', 999 as Event, emptyCtx)).toEqual({
			newPhase: 'idle',
			actions: [],
		});
	});

	it('active + unknown Event → no-op (stays active)', () => {
		expect(transition('active', 999 as Event, emptyCtx)).toEqual({
			newPhase: 'active',
			actions: [],
		});
	});

	it('ended + unknown Event → no-op (stays ended)', () => {
		expect(transition('ended', 999 as Event, emptyCtx)).toEqual({
			newPhase: 'ended',
			actions: [],
		});
	});
});

describe('transition backward compatibility', () => {
	it('empty phase normalizes to idle', () => {
		expect(transition('' as Phase, Event.TurnStart, emptyCtx)).toEqual(
			transition('idle', Event.TurnStart, emptyCtx),
		);
	});

	it('legacy active_committed normalizes to active', () => {
		expect(transition('active_committed' as Phase, Event.GitCommit, emptyCtx)).toEqual(
			transition('active', Event.GitCommit, emptyCtx),
		);
	});

	it('unknown phase normalizes to idle', () => {
		expect(transition('bogus' as Phase, Event.SessionStop, emptyCtx)).toEqual(
			transition('idle', Event.SessionStop, emptyCtx),
		);
	});
});

describe('rebase GitCommit is a no-op for every phase', () => {
	it.each([
		'idle',
		'active',
		'ended',
	] as const)('%s + GitCommit during rebase stays in same phase with no actions', (phase) => {
		const r = transition(phase, Event.GitCommit, rebaseCtx);
		expect(r).toEqual({ newPhase: phase, actions: [] });
	});
});

describe('exhaustive (phase × event) matrix', () => {
	const phases: Phase[] = ['idle', 'active', 'ended'];
	// `Object.values` on a numeric enum returns BOTH keys and values (reverse map);
	// filter to keep only the numeric variants.
	const events: Event[] = Object.values(Event).filter((v): v is Event => typeof v === 'number');

	it.each(
		phases.flatMap((p) => events.map((e) => ({ phase: p, event: eventLabel(e), value: e }))),
	)('transition($phase, $event) returns a defined result', ({ phase, value }) => {
		const r = transition(phase, value, emptyCtx);
		expect(phases).toContain(r.newPhase);
		expect(Array.isArray(r.actions)).toBe(true);
	});
});

describe('applyTransition', () => {
	it('sets phase and updates lastInteractionTime', async () => {
		const state = newState('idle');
		await applyTransition(
			state,
			{ newPhase: 'active', actions: [Action.UpdateLastInteraction] },
			new SpyHandler(),
		);
		expect(state.phase).toBe('active');
		expect(state.lastInteractionTime).toBeTruthy();
	});

	it.each([
		['Condense', Action.Condense, 'condense'],
		['CondenseIfFilesTouched', Action.CondenseIfFilesTouched, 'condenseIfFilesTouched'],
		['DiscardIfNoFiles', Action.DiscardIfNoFiles, 'discardIfNoFiles'],
		['WarnStaleSession', Action.WarnStaleSession, 'warnStaleSession'],
	] as const)('dispatches %s to the matching handler method', async (_, action, key) => {
		const state = newState('idle');
		const handler = new SpyHandler();
		await applyTransition(state, { newPhase: 'idle', actions: [action] }, handler);
		expect(handler.called[key]).toBe(true);
	});

	it('clears endedAt and fullyCondensed on ClearEndedAt', async () => {
		const state = newState('ended');
		state.endedAt = new Date().toISOString();
		state.fullyCondensed = true;
		await applyTransition(
			state,
			{ newPhase: 'idle', actions: [Action.ClearEndedAt] },
			new SpyHandler(),
		);
		expect(state.endedAt).toBeNull();
		expect(state.fullyCondensed).toBe(false);
	});

	it('throws handler error but still sets the new phase', async () => {
		const state = newState('idle');
		const handler = new SpyHandler();
		handler.errors.condense = new Error('condense failed');
		await expect(
			applyTransition(state, { newPhase: 'active', actions: [Action.Condense] }, handler),
		).rejects.toThrow('Condense: condense failed');
		expect(state.phase).toBe('active');
	});

	it('skips subsequent strategy actions after the first error', async () => {
		const state = newState('idle');
		const handler = new SpyHandler();
		handler.errors.condense = new Error('boom');
		await expect(
			applyTransition(
				state,
				{ newPhase: 'idle', actions: [Action.Condense, Action.CondenseIfFilesTouched] },
				handler,
			),
		).rejects.toThrow('boom');
		expect(handler.called.condense).toBe(true);
		expect(handler.called.condenseIfFilesTouched).toBe(false);
	});

	it('UpdateLastInteraction still runs after a strategy error', async () => {
		const state = newState('idle');
		const handler = new SpyHandler();
		handler.errors.condense = new Error('boom');
		await expect(
			applyTransition(
				state,
				{ newPhase: 'idle', actions: [Action.Condense, Action.UpdateLastInteraction] },
				handler,
			),
		).rejects.toThrow('boom');
		expect(state.lastInteractionTime).toBeTruthy();
	});

	it('ClearEndedAt still runs after a strategy error', async () => {
		const state = newState('ended');
		state.endedAt = new Date().toISOString();
		const handler = new SpyHandler();
		handler.errors.condense = new Error('boom');
		await expect(
			applyTransition(
				state,
				{ newPhase: 'idle', actions: [Action.Condense, Action.ClearEndedAt] },
				handler,
			),
		).rejects.toThrow('boom');
		expect(state.endedAt).toBeNull();
	});

	it('coerces non-Error throws into a message', async () => {
		const state = newState('idle');
		const handler: ActionHandler = {
			handleCondense: () => {
				throw 'plain string thrown';
			},
			handleCondenseIfFilesTouched: () => {},
			handleDiscardIfNoFiles: () => {},
			handleWarnStaleSession: () => {},
		};
		await expect(
			applyTransition(state, { newPhase: 'idle', actions: [Action.Condense] }, handler),
		).rejects.toThrow('Condense: plain string thrown');
	});

	it('preserves the original handler error stack for triage', async () => {
		const state = newState('idle');
		const handler = new SpyHandler();
		const original = new Error('inner cause');
		handler.errors.condense = original;
		try {
			await applyTransition(state, { newPhase: 'idle', actions: [Action.Condense] }, handler);
			expect.unreachable('expected applyTransition to throw');
		} catch (err) {
			// Stack must point to the original throw site, not wrapActionErr.
			expect((err as Error).stack).toBe(original.stack);
		}
	});

	it('throws a descriptive error for an unknown action enum value', async () => {
		// Defensive: cast'd or deserialized state files could carry future enum
		// variants that this CLI version doesn't know about. We must surface a
		// readable error rather than silently dropping the action.
		const state = newState('idle');
		await expect(
			applyTransition(state, { newPhase: 'idle', actions: [999 as Action] }, new SpyHandler()),
		).rejects.toThrow(/unhandled action: Action\(999\)/);
	});
});
