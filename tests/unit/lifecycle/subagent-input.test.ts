/**
 * Phase 7 Part 1 `src/lifecycle/subagent-input.ts` — 10 case.
 *
 * Go 参考：`cmd/entire/cli/hooks_test.go
 * TestParseSubagentTypeAndDescription` 7 sub 1:1 镜像 + 3 Story 补充
 * （`Uint8Array` 入参分支、`"null"` JSON literal 分支、JSON 非对象分支）。
 *
 * Each `it()` is annotated with `// Go: <anchor>`.
 */

import { describe, expect, it } from 'vitest';
import { parseSubagentTypeAndDescription } from '@/lifecycle/subagent-input';

describe('lifecycle/subagent-input — parseSubagentTypeAndDescription', () => {
	// Go: hooks_test.go TestParseSubagentTypeAndDescription/full_task_input
	it('parses valid JSON object', () => {
		const input = JSON.stringify({
			subagent_type: 'dev',
			description: 'Implement user authentication',
			prompt: 'Do the work',
		});
		expect(parseSubagentTypeAndDescription(input)).toEqual([
			'dev',
			'Implement user authentication',
		]);
	});

	// Go: hooks_test.go TestParseSubagentTypeAndDescription/only_subagent_type
	it('parses only subagent_type (description defaults to empty)', () => {
		const input = JSON.stringify({
			subagent_type: 'reviewer',
			prompt: 'Review changes',
		});
		expect(parseSubagentTypeAndDescription(input)).toEqual(['reviewer', '']);
	});

	// Go: hooks_test.go TestParseSubagentTypeAndDescription/only_description
	it('parses only description (subagent_type defaults to empty)', () => {
		const input = JSON.stringify({
			description: 'Fix the bug',
			prompt: 'Fix it',
		});
		expect(parseSubagentTypeAndDescription(input)).toEqual(['', 'Fix the bug']);
	});

	// Go: hooks_test.go TestParseSubagentTypeAndDescription/neither_field
	it('returns empty tuple when neither field present (with prompt fallback)', () => {
		const input = JSON.stringify({ prompt: 'Do something' });
		expect(parseSubagentTypeAndDescription(input)).toEqual(['', '']);
	});

	// Go: hooks_test.go TestParseSubagentTypeAndDescription/empty_input
	it('returns empty tuple on empty input', () => {
		expect(parseSubagentTypeAndDescription('')).toEqual(['', '']);
	});

	// Go: hooks_test.go TestParseSubagentTypeAndDescription/invalid_json
	it('returns empty tuple on invalid JSON', () => {
		expect(parseSubagentTypeAndDescription('not valid json')).toEqual(['', '']);
	});

	// Go: hooks_test.go TestParseSubagentTypeAndDescription/null_input
	it('returns empty tuple on JSON "null" literal', () => {
		expect(parseSubagentTypeAndDescription('null')).toEqual(['', '']);
	});

	// Go: N/A — Story 补充: JS `null` input (TS accepts Uint8Array | string | null)
	it('returns empty tuple on JS null input', () => {
		expect(parseSubagentTypeAndDescription(null)).toEqual(['', '']);
	});

	// Go: N/A — Story 补充: JSON non-object (array / bare string) still yields empty tuple
	it('returns empty tuple on JSON non-object value', () => {
		expect(parseSubagentTypeAndDescription('"bare"')).toEqual(['', '']);
	});

	// Go: N/A — Story 补充: TS-only Uint8Array input branch
	it('accepts Uint8Array input and decodes as JSON', () => {
		const bytes = new TextEncoder().encode(
			JSON.stringify({ subagent_type: 'x', description: 'y' }),
		);
		expect(parseSubagentTypeAndDescription(bytes)).toEqual(['x', 'y']);
	});
});
