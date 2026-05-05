/**
 * Strategy-package sentinel errors.
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/strategy/strategy.go:18-28` —
 * `errors.New(...)` constants used as `errors.Is(err, ErrXxx)` sentinels in Go.
 * In TypeScript we use module-level `const` instances + reference-equality
 * comparison (`err === ErrNoMetadata`); `instanceof StrategyError` distinguishes
 * strategy errors from generic `Error`.
 *
 * @packageDocumentation
 */

/**
 * Base class for all strategy-package errors. Allows callers to use
 * `instanceof StrategyError` to distinguish strategy errors from generic Error.
 *
 * @example
 * try {
 *   await strategy.findSessionsForCommit(ctx, commitHash);
 * } catch (err) {
 *   if (err instanceof StrategyError) {
 *     // handle a strategy-specific error
 *   }
 * }
 */
export class StrategyError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = 'StrategyError';
	}
}

/**
 * Returned when a commit does not have a `Story-Metadata:` trailer.
 *
 * Go: `var ErrNoMetadata = errors.New("commit has no entire metadata")`
 * (renamed message to `story metadata` for the Story rebrand).
 */
export const ErrNoMetadata = new StrategyError('commit has no story metadata');

/** Returned when no session info is available. */
export const ErrNoSession = new StrategyError('no session info available');

/** Returned when a rewind point is not a task checkpoint. */
export const ErrNotTaskCheckpoint = new StrategyError('not a task checkpoint');

/** Returned when the repository has no commits yet (HEAD unborn). */
export const ErrEmptyRepository = new StrategyError('repository has no commits yet');
