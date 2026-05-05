/**
 * Phase 7 Part 1 `src/lifecycle/commit-message.ts` — 14 case.
 *
 * Story-side implementation; **intentionally divergent from Go** in 4 places
 * (prefix list, `?` trailing, truncate suffix, empty fallback) — see
 * `src/lifecycle/commit-message.ts` JSDoc §TS-divergence and
 * `docs/ts-rewrite/impl/phase-7-lifecycle/impl-1.md` §commit-message for
 * rationale. Go `cmd/entire/cli/commit_message_test.go: TestCleanPromptForCommit`
 * is a *conceptual* parallel, not a 1:1 mirror; individual prefix cases are
 * Story-only and annotated `// Go: N/A — Story-side divergence, see impl-1.md`.
 *
 * 12 prefix strip cases + 1 recursive strip case + 1 `generateCommitMessage`
 * combo case (empty / capitalize / rune-truncate / agentType fallback).
 */

import { describe, expect, it } from 'vitest';
import { cleanPromptForCommit, generateCommitMessage } from '@/lifecycle/commit-message';

describe('lifecycle/commit-message', () => {
	describe('cleanPromptForCommit (12 prefixes + recursive)', () => {
		// Go: N/A — Story-side divergence, see impl-1.md (case-insensitive match)
		it("strips 'can you ' prefix", () => {
			expect(cleanPromptForCommit('Can you fix this')).toBe('fix this');
		});

		// Go: N/A — Story-side divergence, see impl-1.md (case-insensitive match)
		it("strips 'could you ' prefix", () => {
			expect(cleanPromptForCommit('Could you review')).toBe('review');
		});

		// Go: N/A — Story-side divergence, see impl-1.md (prefix-list)
		it("strips 'can we ' prefix", () => {
			expect(cleanPromptForCommit('can we deploy')).toBe('deploy');
		});

		// Go: N/A — Story-side divergence, see impl-1.md (prefix-list)
		it("strips 'could we ' prefix", () => {
			expect(cleanPromptForCommit('Could we refactor')).toBe('refactor');
		});

		// Go: N/A — Story-side divergence, see impl-1.md (case-insensitive match)
		it("strips 'please ' prefix", () => {
			expect(cleanPromptForCommit('Please update X')).toBe('update X');
		});

		// Go: N/A — Story-side divergence, see impl-1.md (prefix-list)
		it("strips 'help me ' prefix", () => {
			expect(cleanPromptForCommit('help me debug')).toBe('debug');
		});

		// Go: N/A — Story-side divergence, see impl-1.md (prefix-list)
		it("strips 'help us ' prefix", () => {
			expect(cleanPromptForCommit('Help us trace Z')).toBe('trace Z');
		});

		// Go: N/A — Story-side divergence, see impl-1.md (prefix-list)
		it("strips 'i want to ' prefix", () => {
			expect(cleanPromptForCommit('i want to refactor')).toBe('refactor');
		});

		// Go: N/A — Story-side divergence, see impl-1.md (prefix-list)
		it("strips 'i need to ' prefix", () => {
			expect(cleanPromptForCommit('I need to patch')).toBe('patch');
		});

		// Go: N/A — Story-side divergence, see impl-1.md (prefix-list)
		it("strips 'i would like to ' prefix", () => {
			expect(cleanPromptForCommit('I would like to cleanup')).toBe('cleanup');
		});

		// Go: N/A — Story-side divergence, see impl-1.md (prefix-list)
		it("strips 'let us ' prefix", () => {
			expect(cleanPromptForCommit('let us organize')).toBe('organize');
		});

		// Go: N/A — Story-side divergence, see impl-1.md (case-insensitive match)
		it('strips "let\'s " prefix', () => {
			expect(cleanPromptForCommit("Let's ship it")).toBe('ship it');
		});

		// Go: N/A — Story-side divergence, see impl-1.md (recursive loop over 12-prefix set)
		it('strips recursive composite prefix "Can you please help me"', () => {
			expect(cleanPromptForCommit('Can you please help me refactor X')).toBe('refactor X');
		});
	});

	describe('generateCommitMessage (empty / capitalize / truncate / agentType)', () => {
		// Go: N/A — Story-side divergence, see impl-1.md (bracketed fallback
		// `[<type>] Task checkpoint` vs Go's `<type> session updates`;
		// `...` truncation marker not present in Go).
		it('handles empty / capitalize / truncate-rune / agentType-fallback', () => {
			expect(generateCommitMessage('', 'claude-code')).toBe('[claude-code] Task checkpoint');
			expect(generateCommitMessage('', '')).toBe('[agent] Task checkpoint');
			expect(generateCommitMessage('fix bug', 'x')).toBe('Fix bug');

			const result = generateCommitMessage('你好A'.repeat(30), 'x');
			expect(result.endsWith('...')).toBe(true);
			// 72 runes + 3-char `...` suffix = 75 Unicode codepoints
			expect([...result].length).toBe(75);
			expect([...result].slice(0, 72).join('')).toBe('你好A'.repeat(24));
		});

		// Go: commit_message.go — `stringutil.TruncateRunes(s, 72)` — the
		// 72-rune truncation length IS mirrored from Go (see
		// `COMMIT_MESSAGE_MAX_LEN` in src). Only the `...` marker and the
		// bracketed fallback are Story-divergent (covered above).
		it('truncates at 72 Unicode codepoints (rune-safe — mirrors Go constant 72)', () => {
			const justFits = `A${'a'.repeat(71)}`;
			expect(generateCommitMessage(justFits, 'x')).toBe(justFits);
			expect([...generateCommitMessage(justFits, 'x')].length).toBe(72);

			const oneOver = `A${'a'.repeat(72)}`;
			const truncated = generateCommitMessage(oneOver, 'x');
			expect([...truncated].length).toBe(75);
			expect(truncated.endsWith('...')).toBe(true);
		});
	});
});
