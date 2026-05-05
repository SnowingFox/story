import { describe, expect, it } from 'vitest';
import { NOT_IMPLEMENTED, SilentError } from '@/errors';

describe('SilentError', () => {
	it('is instanceof SilentError', () => {
		const cause = new Error('something broke');
		const err = new SilentError(cause);
		expect(err).toBeInstanceOf(SilentError);
		expect(err).toBeInstanceOf(Error);
	});

	it('preserves the original cause', () => {
		const cause = new Error('original');
		const err = new SilentError(cause);
		expect(err.cause).toBe(cause);
	});

	it('message matches cause message', () => {
		const cause = new Error('session state not found');
		const err = new SilentError(cause);
		expect(err.message).toBe('session state not found');
	});

	it('name is SilentError', () => {
		const err = new SilentError(new Error('test'));
		expect(err.name).toBe('SilentError');
	});

	// E.4 Go parity: `unwrap()` method alias for `cause` (matches Go's
	// `Unwrap() error`). Allows future tooling that walks error chains by
	// method name to work without special-casing TS.
	it('unwrap() returns same value as .cause (Go parity)', () => {
		const cause = new Error('original');
		const err = new SilentError(cause);
		expect(err.unwrap()).toBe(cause);
		expect(err.unwrap()).toBe(err.cause);
	});
});

describe('NOT_IMPLEMENTED', () => {
	it('returns a SilentError instance', () => {
		const err = NOT_IMPLEMENTED('Phase 5.2: SaveStep — see manual_commit_git.go:24');
		expect(err).toBeInstanceOf(SilentError);
		expect(err).toBeInstanceOf(Error);
	});

	it('preserves the message verbatim on the SilentError', () => {
		const msg = 'Phase 5.6: PrePush — see manual_commit_push.go:22';
		const err = NOT_IMPLEMENTED(msg);
		expect(err.message).toBe(msg);
	});

	it('cause is a plain Error wrapping the same message (matches Go parity)', () => {
		const msg = 'Phase 5.4: PostCommit — see manual_commit_hooks.go:824';
		const err = NOT_IMPLEMENTED(msg);
		expect(err.cause).toBeInstanceOf(Error);
		expect(err.cause.message).toBe(msg);
	});

	it('throw NOT_IMPLEMENTED(msg) produces an instanceof SilentError catch', () => {
		expect(() => {
			throw NOT_IMPLEMENTED('Phase 5.3: CondenseSession — see manual_commit_condensation.go:115');
		}).toThrow(SilentError);
		expect(() => {
			throw NOT_IMPLEMENTED('Phase 5.3: CondenseSession — see manual_commit_condensation.go:115');
		}).toThrow(/Phase 5\.3/);
	});
});
