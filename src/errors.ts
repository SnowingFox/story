/**
 * Signals that the error message has already been printed; top-level catch
 * should only set exit code.
 *
 * Mirrors Go's `*SilentError { Err error; Unwrap() }` shape — `cause` is the
 * Go-native field name analog (TS's standard convention is `cause`); `unwrap()`
 * is the method alias matching Go's `Unwrap()` for any future cross-language
 * tooling that walks errors by method name.
 */
export class SilentError extends Error {
	constructor(public readonly cause: Error) {
		super(cause.message);
		this.name = 'SilentError';
	}

	/** Method alias for `cause`, matching Go's `Unwrap() error`. */
	unwrap(): Error {
		return this.cause;
	}
}

/**
 * Construct a {@link SilentError} marking an unimplemented codepath that's
 * deferred to a future phase. Call sites are intentionally
 * `throw NOT_IMPLEMENTED('Phase X.Y: <name> — see <go-file>:<line>')` so that
 * [`scripts/audit-deferrals.sh`](../scripts/audit-deferrals.sh) can locate
 * unresolved stubs by literal grep on `throw NOT_IMPLEMENTED('Phase X.Y')`.
 *
 * Introduced in Phase 5.1 to support the `ManualCommitStrategy` class shell
 * pattern (18 stub methods filled by Phases 5.2-5.6); subsequent phases reuse
 * the same helper for any cross-phase forward-marker stub.
 *
 * @example
 * // src/strategy/manual-commit.ts (Phase 5.1) — example below uses
 * // 'Phase X.Y' placeholder to avoid being caught by audit-deferrals.sh
 * // as a real stub. Real call sites use literal 'Phase 5.2', 'Phase 5.3', etc.
 * saveStep(ctx, step) {
 *   throw NOT_IMPLEMENTED('Phase X.Y: SaveStep — see <go-file>:<line>');
 * }
 *
 * // Later, in src/cli/main.ts top-level catch:
 * catch (err) {
 *   if (err instanceof SilentError) {
 *     console.error(err.message); // single-line, no stack trace
 *     process.exit(1);
 *   }
 *   throw err;
 * }
 */
export function NOT_IMPLEMENTED(message: string): SilentError {
	return new SilentError(new Error(message));
}
