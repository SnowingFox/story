/**
 * Tests for `src/agent/claude-code/response.ts` — Mirrors Go
 * `entire-cli/cmd/entire/cli/agent/claudecode/response_test.go: TestParseGenerateTextResponse`.
 *
 * Six 1:1 sub-cases from the Go table test + one Story TS-feature case
 * (multiple `result` envelopes → backward scan picks the LAST).
 */

import { describe, expect, it } from 'vitest';
import { parseGenerateTextResponse } from '@/agent/claude-code/response';

describe('agent/claude-code/response — Go: response_test.go: TestParseGenerateTextResponse', () => {
	// Go: response_test.go:17-21 ("legacy object result")
	it('parses legacy single-object result', () => {
		expect(parseGenerateTextResponse('{"result":"hello"}')).toBe('hello');
	});

	// Go: response_test.go:22-26 ("legacy object empty result")
	it('parses legacy empty string result (empty != missing)', () => {
		expect(parseGenerateTextResponse('{"result":""}')).toBe('');
	});

	// Go: response_test.go:27-31 ("array result")
	it('parses array of envelopes, picks `type=result` envelope', () => {
		expect(
			parseGenerateTextResponse('[{"type":"system"},{"type":"result","result":"hello"}]'),
		).toBe('hello');
	});

	// Go: response_test.go:32-36 ("array empty result")
	it('parses array result envelope with empty string result', () => {
		expect(parseGenerateTextResponse('[{"type":"system"},{"type":"result","result":""}]')).toBe('');
	});

	// Go: response_test.go:37-41 ("missing result item")
	it('throws when array has no `type:result` envelope', () => {
		expect(() =>
			parseGenerateTextResponse('[{"type":"system"},{"type":"assistant","message":"working"}]'),
		).toThrow(/missing result item/);
	});

	// Go: response_test.go:42-46 ("invalid json")
	it('throws on non-JSON input', () => {
		expect(() => parseGenerateTextResponse('not json')).toThrow(
			/unsupported Claude CLI JSON response/,
		);
	});

	// Story补充：Go test only exercises 2-element arrays. Streaming claude
	// can emit multiple `type:result` envelopes during a turn — the LAST
	// is final. Go: response.go:27-31 (backward iteration).
	it('picks the LAST result envelope when multiple are present (backward scan)', () => {
		const stdout = JSON.stringify([
			{ type: 'system' },
			{ type: 'result', result: 'first partial' },
			{ type: 'result', result: 'second partial' },
			{ type: 'result', result: 'final' },
		]);
		expect(parseGenerateTextResponse(stdout)).toBe('final');
	});

	// Story 补充：accept Uint8Array (raw subprocess stdout) without decode.
	it('accepts Uint8Array input (raw subprocess stdout, no manual decode)', () => {
		const bytes = new TextEncoder().encode('{"result":"hi"}');
		expect(parseGenerateTextResponse(bytes)).toBe('hi');
	});
});
