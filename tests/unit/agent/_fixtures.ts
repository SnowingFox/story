/**
 * Shared transcript fixtures for `tests/unit/agent/*.test.ts`.
 *
 * Minimum viable bytes that exercise the dispatch paths in
 * `_phase-6-x-placeholders.test.ts` (Phase 6.1 Part 2 expanded these to
 * match `condensation_test.go`'s expected token totals).
 *
 * **Dropped**: Gemini CLI + Factory AI Droid fixtures were removed when
 * those agents were dropped from the roadmap — see
 * `references/dropped-agents.md`.
 */

const enc = new TextEncoder();

/** Claude-style JSONL: 2 lines (user prompt + assistant reply with usage). */
export const claudeJSONLFixture: Uint8Array = enc.encode(
	`${JSON.stringify({ type: 'user', uuid: 'u1', content: 'hello' })}\n${JSON.stringify({
		type: 'assistant',
		uuid: 'a1',
		content: 'world',
		usage: {
			input_tokens: 10,
			output_tokens: 20,
			cache_creation_input_tokens: 5,
			cache_read_input_tokens: 3,
		},
	})}\n`,
);

/** Cursor-style JSONL: minimal placeholder (Cursor TokenCalculator returns null). */
export const cursorJSONLFixture: Uint8Array = enc.encode(
	`${JSON.stringify({ type: 'user', content: 'hi' })}\n${JSON.stringify({
		type: 'assistant',
		content: 'hello',
	})}\n`,
);
