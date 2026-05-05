/**
 * Phase 5.1 extract-session.ts unit tests.
 *
 * **TS-only**: Go's `ExtractSessionIDFromCommit` (`common.go:1415-1431`) has
 * no dedicated `Test*` in `strategy/*_test.go` — Go covers it transitively
 * via PostCommit / postrewrite tests. The TS tests below pin both Go paths:
 *   1. `Story-Session:` trailer (primary)
 *   2. `filepath.Base(metadataDir)` fallback from `Story-Metadata:` trailer
 */

import { describe, expect, it } from 'vitest';
import { extractSessionIdFromCommit } from '@/strategy/extract-session';

// TS-only: Go production lives at common.go:1415-1431; no dedicated `Test*`.
describe('extractSessionIdFromCommit — Go: common.go:1415-1431 (production; no dedicated Go Test*)', () => {
	it('returns session id from a single trailer', () => {
		const msg = 'feat: add foo\n\nStory-Session: abc-123';
		expect(extractSessionIdFromCommit(msg)).toBe('abc-123');
	});

	it('returns empty string when no Story-Session trailer present', () => {
		const msg = 'refactor: nothing\n\nBase-Commit: deadbeef';
		expect(extractSessionIdFromCommit(msg)).toBe('');
	});

	it('returns the first Story-Session trailer when multiple are present', () => {
		const msg = 'merge: x\n\nStory-Session: first-id\nStory-Session: second-id';
		expect(extractSessionIdFromCommit(msg)).toBe('first-id');
	});

	it('returns empty string for empty commit message', () => {
		expect(extractSessionIdFromCommit('')).toBe('');
	});

	it('handles trailing whitespace in trailer value', () => {
		const msg = 'commit\n\nStory-Session: trim-me  ';
		expect(extractSessionIdFromCommit(msg)).toBe('trim-me');
	});

	// Go: common.go:1425-1427 — fallback to metadata trailer's basename
	it('falls back to Story-Metadata basename when Story-Session missing — Go: common.go:1425-1427', () => {
		const msg = 'feat: condense\n\nStory-Metadata: .story/metadata/2025-12-01-abc-session-id';
		// Go: filepath.Base(".story/metadata/2025-12-01-abc-session-id") = "2025-12-01-abc-session-id"
		expect(extractSessionIdFromCommit(msg)).toBe('2025-12-01-abc-session-id');
	});

	it('prefers Story-Session over Story-Metadata when both present — Go: common.go:1421-1428', () => {
		const msg =
			'feat: x\n\nStory-Session: explicit-id\nStory-Metadata: .story/metadata/different-id';
		expect(extractSessionIdFromCommit(msg)).toBe('explicit-id');
	});

	// ─── audit-3 Fix A revisited (2026-04-18): NO-OP ──────────────────────
	// audit-3 plan claimed Go-parity divergence on empty Story-Session trailer
	// + Story-Metadata fallback. Investigation showed both Go and TS share the
	// same `Story-Session:\s*(.+)` regex — `\s` matches newline, so an empty
	// Session trailer followed by another trailer line causes the regex to
	// greedily capture the next line. Both Go and TS therefore return the same
	// (bogus) value. There is no real divergence at the extract-session.ts
	// layer; any "fix" would just paper over the regex behavior.
	//
	// The right fix would be to change parseSession's regex to not cross
	// newlines (e.g., `[ \t]*(.*)`) — but that's a Phase 1.2 trailers regex
	// change, not a Phase 5.x audit fix, and it would affect every trailer
	// parser symmetrically. Deferred outside this audit.
});
