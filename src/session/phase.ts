/**
 * Session phase state machine.
 *
 * Pure functions that compute the next phase and required side effects given the
 * current phase and an event. Mirrors `entire-cli/cmd/entire/cli/session/phase.go`.
 *
 * @packageDocumentation
 */

import { match, P } from 'ts-pattern';
import type { SessionState } from './state-store';

/** Lifecycle stage of a session. */
export type Phase = 'idle' | 'active' | 'ended';

/** Canonical list of phases (for enumeration / diagrams). */
export const ALL_PHASES: readonly Phase[] = ['idle', 'active', 'ended'];

/**
 * Normalize a phase string. Empty / unknown values fall back to `idle`. The legacy
 * `active_committed` phase (removed with the 1:1 checkpoint model) is migrated
 * to `active` so the `TurnEnd` handler can finalize any pending checkpoints.
 */
export function normalizePhase(s: string): Phase {
	return match(s)
		.with('active', 'active_committed', () => 'active' as const)
		.with('idle', () => 'idle' as const)
		.with('ended', () => 'ended' as const)
		.otherwise(() => 'idle' as const);
}

/** Something that happened to a session. */
export enum Event {
	/** Agent begins working on a prompt. */
	TurnStart = 0,
	/** Agent finishes its turn. */
	TurnEnd = 1,
	/** A git commit was made (PostCommit hook). */
	GitCommit = 2,
	/** Session process started (SessionStart hook). */
	SessionStart = 3,
	/** Session process ended (SessionStop hook). */
	SessionStop = 4,
	/** Agent compacted context mid-turn (PreCompress hook). */
	Compaction = 5,
}

/** Human-readable name for an {@link Event}. Mirrors Go's `Event.String()`. */
export function eventLabel(e: Event): string {
	return match(e)
		.with(Event.TurnStart, () => 'TurnStart')
		.with(Event.TurnEnd, () => 'TurnEnd')
		.with(Event.GitCommit, () => 'GitCommit')
		.with(Event.SessionStart, () => 'SessionStart')
		.with(Event.SessionStop, () => 'SessionStop')
		.with(Event.Compaction, () => 'Compaction')
		.otherwise(() => `Event(${e as number})`);
}

/**
 * Side effect declared by the state machine. The caller is responsible for
 * executing these — {@link transition} only declares them.
 */
export enum Action {
	/** Condense session data to permanent storage. */
	Condense = 0,
	/** Condense only if `filesTouched` is non-empty. */
	CondenseIfFilesTouched = 1,
	/** Discard session if `filesTouched` is empty. */
	DiscardIfNoFiles = 2,
	/** Warn user about stale session(s). */
	WarnStaleSession = 3,
	/** Clear `endedAt` timestamp (session re-entering). */
	ClearEndedAt = 4,
	/** Update `lastInteractionTime`. */
	UpdateLastInteraction = 5,
}

/** Human-readable name for an {@link Action}. Mirrors Go's `Action.String()`. */
export function actionLabel(a: Action): string {
	return match(a)
		.with(Action.Condense, () => 'Condense')
		.with(Action.CondenseIfFilesTouched, () => 'CondenseIfFilesTouched')
		.with(Action.DiscardIfNoFiles, () => 'DiscardIfNoFiles')
		.with(Action.WarnStaleSession, () => 'WarnStaleSession')
		.with(Action.ClearEndedAt, () => 'ClearEndedAt')
		.with(Action.UpdateLastInteraction, () => 'UpdateLastInteraction')
		.otherwise(() => `Action(${a as number})`);
}

/** Read-only context for transitions that need to inspect session state. */
export interface TransitionContext {
	/** `filesTouched.length > 0` */
	hasFilesTouched: boolean;
	/** `.git/rebase-merge/` or `.git/rebase-apply/` exists. */
	isRebaseInProgress: boolean;
}

/** Outcome of a state machine transition. */
export interface TransitionResult {
	newPhase: Phase;
	actions: Action[];
}

const idle = (actions: Action[] = []): TransitionResult => ({ newPhase: 'idle', actions });
const active = (actions: Action[] = []): TransitionResult => ({ newPhase: 'active', actions });
const ended = (actions: Action[] = []): TransitionResult => ({ newPhase: 'ended', actions });

/**
 * Compute the next phase and required actions. Pure function with no side effects.
 *
 * Reads as a state-transition table: each `.with([phase, event], …)` row is one
 * cell of the (phase × event) matrix.
 *
 * **Unknown events** (e.g. deserialized from bad JSON, or an Event variant
 * added in Go but not yet in TS) hit `.otherwise()` and produce a no-op
 * TransitionResult — staying in the current phase with no actions. Mirrors
 * Go's `switch event { default: return TransitionResult{} }` (`phase.go`
 * transitionFromIdle / transitionFromActive / transitionFromEnded).
 *
 * Earlier TS used `.exhaustive()` which throws ts-pattern's `NonExhaustiveError`
 * on bad runtime input — diverging from Go's graceful default branch.
 */
export function transition(current: Phase, event: Event, ctx: TransitionContext): TransitionResult {
	const phase = normalizePhase(current);
	return (
		match([phase, event] as const)
			.with(['idle', Event.TurnStart], () => active([Action.UpdateLastInteraction]))
			.with(['idle', Event.TurnEnd], () => idle())
			.with(['idle', Event.GitCommit], () =>
				ctx.isRebaseInProgress ? idle() : idle([Action.Condense]),
			)
			.with(['idle', Event.SessionStart], () => idle())
			.with(['idle', Event.SessionStop], () => ended([Action.UpdateLastInteraction]))
			.with(['idle', Event.Compaction], () =>
				idle([Action.CondenseIfFilesTouched, Action.UpdateLastInteraction]),
			)
			// Ctrl-C recovery: agent crashed or user interrupted mid-turn.
			.with(['active', Event.TurnStart], () => active([Action.UpdateLastInteraction]))
			.with(['active', Event.TurnEnd], () => idle([Action.UpdateLastInteraction]))
			.with(['active', Event.GitCommit], () =>
				ctx.isRebaseInProgress ? active() : active([Action.Condense]),
			)
			.with(['active', Event.SessionStart], () => active([Action.WarnStaleSession]))
			.with(['active', Event.SessionStop], () => ended([Action.UpdateLastInteraction]))
			// Compaction mid-turn saves progress but stays active; the compaction
			// handler will reset the transcript offset.
			.with(['active', Event.Compaction], () =>
				active([Action.CondenseIfFilesTouched, Action.UpdateLastInteraction]),
			)
			.with(['ended', Event.TurnStart], () =>
				active([Action.ClearEndedAt, Action.UpdateLastInteraction]),
			)
			.with(['ended', Event.TurnEnd], () => ended())
			.with(['ended', Event.GitCommit], () =>
				match(ctx)
					.with({ isRebaseInProgress: true }, () => ended())
					.with({ hasFilesTouched: true }, () => ended([Action.CondenseIfFilesTouched]))
					.otherwise(() => ended([Action.DiscardIfNoFiles])),
			)
			.with(['ended', Event.SessionStart], () => idle([Action.ClearEndedAt]))
			.with(['ended', Event.SessionStop], () => ended())
			.with(['ended', Event.Compaction], () => ended())
			// Default branch: unknown Event → stay in current phase, no actions
			// (Go parity). Note this also covers any future Phase × Event combo
			// missed at compile time; type-level coverage is now best-effort.
			.otherwise(() => ({ newPhase: phase, actions: [] }))
	);
}

/**
 * Strategy-specific side effects for state transitions. Implementations may
 * extend {@link NoOpActionHandler} to override only the methods they need.
 */
export interface ActionHandler {
	handleCondense(state: SessionState): Promise<void> | void;
	handleCondenseIfFilesTouched(state: SessionState): Promise<void> | void;
	handleDiscardIfNoFiles(state: SessionState): Promise<void> | void;
	handleWarnStaleSession(state: SessionState): Promise<void> | void;
}

/** Default {@link ActionHandler} where all methods are no-ops. */
export class NoOpActionHandler implements ActionHandler {
	handleCondense(_: SessionState): void {}
	handleCondenseIfFilesTouched(_: SessionState): void {}
	handleDiscardIfNoFiles(_: SessionState): void {}
	handleWarnStaleSession(_: SessionState): void {}
}

/**
 * Apply a {@link TransitionResult} to `state`: set the new phase unconditionally,
 * then execute all actions.
 *
 * Common actions ({@link Action.UpdateLastInteraction}, {@link Action.ClearEndedAt})
 * always run regardless of handler errors so bookkeeping fields stay consistent
 * with the new phase. Strategy-specific handler actions stop on the first error;
 * subsequent handler actions are skipped but common actions continue.
 *
 * Throws the first handler error encountered (with the action name prepended).
 */
export async function applyTransition(
	state: SessionState,
	result: TransitionResult,
	handler: ActionHandler,
): Promise<void> {
	state.phase = result.newPhase;

	let firstErr: Error | undefined;
	const runStrategy = async (fn: () => Promise<void> | void, action: Action): Promise<void> => {
		if (firstErr) {
			return;
		}
		try {
			await fn();
		} catch (err) {
			firstErr = wrapActionErr(action, err);
		}
	};

	for (const action of result.actions) {
		await match(action)
			.with(Action.UpdateLastInteraction, () => {
				state.lastInteractionTime = new Date().toISOString();
			})
			.with(Action.ClearEndedAt, () => {
				state.endedAt = null;
				state.fullyCondensed = false;
			})
			.with(Action.Condense, (a) => runStrategy(() => handler.handleCondense(state), a))
			.with(Action.CondenseIfFilesTouched, (a) =>
				runStrategy(() => handler.handleCondenseIfFilesTouched(state), a),
			)
			.with(Action.DiscardIfNoFiles, (a) =>
				runStrategy(() => handler.handleDiscardIfNoFiles(state), a),
			)
			.with(Action.WarnStaleSession, (a) =>
				runStrategy(() => handler.handleWarnStaleSession(state), a),
			)
			// Runtime defense for cast'd / deserialized invalid values. Cannot use
			// `.exhaustive()` here because we want a recoverable error rather than
			// ts-pattern's `NonExhaustiveError`. New Action variants WILL fail this
			// branch — protect with the unit test in session-phase.test.ts.
			.otherwise(() => {
				if (!firstErr) {
					firstErr = new Error(`unhandled action: ${actionLabel(action)}`);
				}
			});
	}

	if (firstErr) {
		throw firstErr;
	}
}

function wrapActionErr(action: Action, err: unknown): Error {
	const msg = match(err)
		.with(P.instanceOf(Error), (e) => e.message)
		.otherwise((v) => String(v));
	const wrapped = new Error(`${actionLabel(action)}: ${msg}`);
	// Preserve original stack so downstream error reporters can still trace the
	// failure to the handler that raised it — crucial when triaging hook crashes
	// from production logs.
	if (err instanceof Error && err.stack) {
		wrapped.stack = err.stack;
	}
	return wrapped;
}
