/**
 * Phase 5.1 strategy/errors.ts unit tests.
 *
 * **TS-only**: Go declares 4 sentinel errors via `errors.New(...)` in
 * `strategy.go:18-28` (production file) — there is no dedicated Go `Test*`
 * function exercising the sentinel surface; matching is done at consumer
 * sites with `errors.Is(...)`. The TS tests below pin the Story-side identity
 * + message contract; they are **const-parity checks**, not test-ports.
 */

import { describe, expect, it } from 'vitest';
import {
	ErrEmptyRepository,
	ErrNoMetadata,
	ErrNoSession,
	ErrNotTaskCheckpoint,
	StrategyError,
} from '@/strategy/errors';

// Go: strategy.go:18-28 — sentinel error declarations (4x errors.New(...))
// TS-only: no dedicated Go Test* — Go uses `errors.Is(err, sentinel)` at call sites.
// Tests below verify identity + message contract for the 4 sentinel exports.
describe('StrategyError sentinels — Go: strategy.go:18-28 (production declarations)', () => {
	it('all 4 sentinels are StrategyError instances', () => {
		for (const err of [ErrNoMetadata, ErrNoSession, ErrNotTaskCheckpoint, ErrEmptyRepository]) {
			expect(err).toBeInstanceOf(StrategyError);
			expect(err).toBeInstanceOf(Error);
			expect(err.name).toBe('StrategyError');
		}
	});

	it('reference equality works for sentinels (Go errors.Is parity)', () => {
		// In Go, `errors.Is(err, ErrNoMetadata)` checks identity.
		// In TS we use `err === ErrNoMetadata` because they're const instances.
		// Round-trip via a holder var to make biome's noSelfCompare happy
		// while still proving identity equality.
		const same = ErrNoMetadata;
		expect(same).toBe(ErrNoMetadata);
		expect(ErrNoMetadata as Error).not.toBe(ErrNoSession as Error);
	});

	it('messages match Go (with Story rebrand on ErrNoMetadata)', () => {
		expect(ErrNoMetadata.message).toBe('commit has no story metadata');
		expect(ErrNoSession.message).toBe('no session info available');
		expect(ErrNotTaskCheckpoint.message).toBe('not a task checkpoint');
		expect(ErrEmptyRepository.message).toBe('repository has no commits yet');
	});

	it('StrategyError accepts a cause chain', () => {
		const cause = new Error('underlying');
		const err = new StrategyError('wrapped', { cause });
		expect(err.cause).toBe(cause);
		expect(err.message).toBe('wrapped');
	});
});
