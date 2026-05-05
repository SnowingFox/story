/**
 * Deterministic Cursor-style multimodal JSONL fixtures for E2E `explain`
 * transcript-shape coverage (no API calls).
 */

/** Needle embedded in a clean multimodal Cursor user line (shape test). */
export const E2E_SHAPE_MM_NEEDLE = 'fixture-e2e-mm-needle-9c3a2f1b';

/** Needle inside valid JSONL after a garbage prefix line (intermediate test). */
export const E2E_INTERMEDIATE_NEEDLE = 'fixture-e2e-intermediate-needle-7d2e4a9c';

/** Non-JSON first line in garbled-prefix transcript (must match garbled line constant). */
export const E2E_GARBAGE_PREFIX_LINE = 'not-json-garbage-prefix-line-e2e-8b1c4d2e';

/**
 * One JSONL object: Cursor multimodal `user` message with `text` block = `needle`.
 */
export function cursorMultimodalUserLine(needle: string): string {
	return JSON.stringify({
		role: 'user',
		message: {
			content: [{ type: 'text', text: needle }],
		},
	});
}

/**
 * UTF-8 bytes: single valid JSONL line (multimodal user) containing {@link E2E_SHAPE_MM_NEEDLE}.
 */
export function buildCleanShapeTranscriptUtf8(): Uint8Array {
	const line = cursorMultimodalUserLine(E2E_SHAPE_MM_NEEDLE);
	return new TextEncoder().encode(`${line}\n`);
}

/**
 * UTF-8 bytes: garbage prefix line + valid JSONL containing {@link E2E_INTERMEDIATE_NEEDLE}.
 */
export function buildGarbledPrefixTranscriptUtf8(): Uint8Array {
	const line = cursorMultimodalUserLine(E2E_INTERMEDIATE_NEEDLE);
	return new TextEncoder().encode(`${E2E_GARBAGE_PREFIX_LINE}\n${line}\n`);
}

// `--pure --page` E2E fixtures.
//
// Three deterministic turns with one tool_use block in turn 2. Used by
// `explain-transcript-shapes.e2e.test.ts` to exercise the AI plain-text
// pagination path on a real committed transcript:
//   - `--pure --page 1` → contains turns 1+2, surfaces the tool input,
//     and ends with a `next: ... --page 2` hint.
//   - `--pure --page 2` → contains turn 3 only, no next-page hint.
//   - `--pure --full`   → contains all three turns + the tool input, no
//     bar / banner / ANSI.
//
// The tool result is intentionally a unique sentinel so we can assert it
// is dropped from the AI plain-text payload (per design: tool inputs
// only, results are noise).
/** Needle in the user prompt of turn 1 — must appear on `--pure --page 1`. */
export const E2E_PURE_T1_NEEDLE = 'fixture-e2e-pure-t1-needle-1a2b3c4d';
/** Needle in the user prompt of turn 2 — must appear on `--pure --page 1`. */
export const E2E_PURE_T2_NEEDLE = 'fixture-e2e-pure-t2-needle-5e6f7a8b';
/** Needle in the user prompt of turn 3 — must appear on `--pure --page 2` only. */
export const E2E_PURE_T3_NEEDLE = 'fixture-e2e-pure-t3-needle-9c0d1e2f';
/** Tool input file path for turn 2 — must appear on `--pure --page 1`. */
export const E2E_PURE_TOOL_INPUT_NEEDLE = 'src/fixture-e2e-pure-tool-input.ts';
/** Tool result content — must NOT appear in any `--pure` output. */
export const E2E_PURE_TOOL_RESULT_NEEDLE = 'fixture-e2e-pure-tool-RESULT-PAYLOAD-secret';

/**
 * Build a deterministic 3-turn JSONL transcript with a tool_use in
 * turn 2 (Claude-shape envelope). Side-effect free.
 */
export function buildPurePagedTranscriptUtf8(): Uint8Array {
	const lines = [
		JSON.stringify({ type: 'user', content: E2E_PURE_T1_NEEDLE }),
		JSON.stringify({ type: 'assistant', content: 'ack-1' }),
		JSON.stringify({ type: 'user', content: E2E_PURE_T2_NEEDLE }),
		JSON.stringify({
			type: 'assistant',
			message: {
				content: [
					{ type: 'text', text: 'I will Edit the file.' },
					{
						type: 'tool_use',
						id: 'toolu_pure_1',
						name: 'Edit',
						input: { file_path: E2E_PURE_TOOL_INPUT_NEEDLE, old_string: 'a', new_string: 'b' },
					},
				],
			},
		}),
		JSON.stringify({
			type: 'user',
			message: {
				content: [
					{
						type: 'tool_result',
						tool_use_id: 'toolu_pure_1',
						content: E2E_PURE_TOOL_RESULT_NEEDLE,
					},
				],
			},
		}),
		JSON.stringify({ type: 'assistant', content: 'edit done' }),
		JSON.stringify({ type: 'user', content: E2E_PURE_T3_NEEDLE }),
		JSON.stringify({ type: 'assistant', content: 'ack-3' }),
	];
	return new TextEncoder().encode(`${lines.join('\n')}\n`);
}
