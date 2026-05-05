/**
 * Phase 5.1 messages.ts unit tests — ported 1:1 from Go
 * `entire-cli/cmd/entire/cli/strategy/messages_test.go`.
 *
 * Each `it()` is annotated with `// Go: <file>:<line> <TestName>` for traceability.
 * Additional TS-only tests (UTF-8 / emoji rune boundaries) are kept where they
 * verify behavior implied by Go but not exercised in the Go table.
 */

import { describe, expect, it } from 'vitest';
import {
	countTodos,
	extractInProgressTodo,
	extractLastCompletedTodo,
	formatIncrementalMessage,
	formatIncrementalSubject,
	formatSubagentEndMessage,
	truncateDescription,
	truncatePromptForStorage,
} from '@/strategy/messages';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

// Go: messages_test.go:5-52 TestTruncateDescription
describe('truncateDescription — Go: messages_test.go:5-52 TestTruncateDescription', () => {
	it('short string unchanged', () => {
		expect(truncateDescription('Short', 60)).toBe('Short');
	});

	it('exactly max length unchanged', () => {
		expect(truncateDescription('123456', 6)).toBe('123456');
	});

	it('long string truncated with ellipsis', () => {
		expect(
			truncateDescription('This is a very long description that exceeds the maximum length', 30),
		).toBe('This is a very long descrip...');
	});

	it('empty string', () => {
		expect(truncateDescription('', 60)).toBe('');
	});

	it('max length less than ellipsis', () => {
		// Go: maxLen=2 → "He" (no ellipsis appended)
		expect(truncateDescription('Hello', 2)).toBe('He');
	});

	// TS-only: UTF-8 rune-aware truncation (Go uses []rune slicing too via [...s])
	it('preserves UTF-8 rune boundaries (CJK)', () => {
		expect(truncateDescription('你好世界abc', 4)).toBe('你...');
	});

	it('preserves UTF-8 rune boundaries (emoji)', () => {
		expect(truncateDescription('😀😁😂😃😄', 4)).toBe('😀...');
	});

	it('drops ellipsis when maxLen < 3 (Go-aligned)', () => {
		expect(truncateDescription('Hello', 1)).toBe('H');
		expect(truncateDescription('Hello', 0)).toBe('');
	});
});

// Go: messages_test.go:54-101 TestFormatSubagentEndMessage
describe('formatSubagentEndMessage — Go: messages_test.go:54-101 TestFormatSubagentEndMessage', () => {
	it('full message with all fields', () => {
		expect(formatSubagentEndMessage('dev', 'Implement user authentication', 'toolu_019t1c')).toBe(
			"Completed 'dev' agent: Implement user authentication (toolu_019t1c)",
		);
	});

	it('empty description', () => {
		expect(formatSubagentEndMessage('dev', '', 'toolu_019t1c')).toBe(
			"Completed 'dev' agent (toolu_019t1c)",
		);
	});

	it('empty agent type', () => {
		expect(formatSubagentEndMessage('', 'Implement user authentication', 'toolu_019t1c')).toBe(
			'Completed agent: Implement user authentication (toolu_019t1c)',
		);
	});

	it('both empty', () => {
		expect(formatSubagentEndMessage('', '', 'toolu_019t1c')).toBe('Task: toolu_019t1c');
	});

	// TS-only: long description truncated by MAX_DESCRIPTION_LENGTH
	it('truncates long description (TS supplemental)', () => {
		const longDesc = 'a'.repeat(100);
		const result = formatSubagentEndMessage('dev', longDesc, 'tu_x');
		expect(result).toContain("Completed 'dev' agent:");
		expect(result).toContain('(tu_x)');
		expect(result).toContain('...');
	});
});

// Go: messages_test.go:103-143 TestFormatIncrementalMessage
describe('formatIncrementalMessage — Go: messages_test.go:103-143 TestFormatIncrementalMessage', () => {
	it('with todo content', () => {
		expect(
			formatIncrementalMessage('Set up Node.js project with package.json', 1, 'toolu_01CJhrr'),
		).toBe('Set up Node.js project with package.json (toolu_01CJhrr)');
	});

	it('empty todo content falls back to checkpoint format', () => {
		expect(formatIncrementalMessage('', 3, 'toolu_01CJhrr')).toBe('Checkpoint #3: toolu_01CJhrr');
	});

	it('long todo content truncated', () => {
		expect(
			formatIncrementalMessage(
				'This is a very long todo item that describes in detail what needs to be done for this step of the implementation process',
				2,
				'toolu_01CJhrr',
			),
		).toBe('This is a very long todo item that describes in detail wh... (toolu_01CJhrr)');
	});
});

// Go: messages_test.go:251-295 TestFormatIncrementalSubject
describe('formatIncrementalSubject — Go: messages_test.go:251-295 TestFormatIncrementalSubject', () => {
	it('incremental with todo content', () => {
		expect(
			formatIncrementalSubject('TodoWrite', '', '', 'Set up Node.js project', 1, 'toolu_01CJhrr'),
		).toBe('Set up Node.js project (toolu_01CJhrr)');
	});

	it('incremental without todo content', () => {
		expect(formatIncrementalSubject('TodoWrite', '', '', '', 3, 'toolu_01CJhrr')).toBe(
			'Checkpoint #3: toolu_01CJhrr',
		);
	});
});

// Go: messages_test.go:145-201 TestExtractLastCompletedTodo
describe('extractLastCompletedTodo — Go: messages_test.go:145-201 TestExtractLastCompletedTodo', () => {
	it('typical case - last completed is the work just finished', () => {
		expect(
			extractLastCompletedTodo(
				enc(
					'[{"content": "First task", "status": "completed"}, {"content": "Second task", "status": "completed"}, {"content": "Third task", "status": "in_progress"}]',
				),
			),
		).toBe('Second task');
	});

	it('single completed item', () => {
		expect(
			extractLastCompletedTodo(enc('[{"content": "First task", "status": "completed"}]')),
		).toBe('First task');
	});

	it('multiple completed - returns last one', () => {
		expect(
			extractLastCompletedTodo(
				enc(
					'[{"content": "First task", "status": "completed"}, {"content": "Second task", "status": "completed"}, {"content": "Third task", "status": "completed"}]',
				),
			),
		).toBe('Third task');
	});

	it('no completed items - empty string', () => {
		expect(
			extractLastCompletedTodo(
				enc(
					'[{"content": "First task", "status": "in_progress"}, {"content": "Second task", "status": "pending"}]',
				),
			),
		).toBe('');
	});

	it('empty array', () => {
		expect(extractLastCompletedTodo(enc('[]'))).toBe('');
	});

	it('invalid JSON', () => {
		expect(extractLastCompletedTodo(enc('not valid json'))).toBe('');
	});

	it('null', () => {
		expect(extractLastCompletedTodo(enc('null'))).toBe('');
	});

	it('completed items mixed with pending', () => {
		expect(
			extractLastCompletedTodo(
				enc(
					'[{"content": "Done 1", "status": "completed"}, {"content": "Pending 1", "status": "pending"}, {"content": "Done 2", "status": "completed"}, {"content": "Pending 2", "status": "pending"}]',
				),
			),
		).toBe('Done 2');
	});

	// TS supplemental: empty input bytes
	it('empty input bytes returns empty (TS supplemental)', () => {
		expect(extractLastCompletedTodo(new Uint8Array(0))).toBe('');
	});
});

// Go: messages_test.go:203-249 TestCountTodos
describe('countTodos — Go: messages_test.go:203-249 TestCountTodos', () => {
	it('typical list with multiple items', () => {
		expect(
			countTodos(
				enc(
					'[{"content": "First task", "status": "completed"}, {"content": "Second task", "status": "in_progress"}, {"content": "Third task", "status": "pending"}]',
				),
			),
		).toBe(3);
	});

	it('single item', () => {
		expect(countTodos(enc('[{"content": "Only task", "status": "pending"}]'))).toBe(1);
	});

	it('empty array', () => {
		expect(countTodos(enc('[]'))).toBe(0);
	});

	it('invalid JSON', () => {
		expect(countTodos(enc('not valid json'))).toBe(0);
	});

	it('null', () => {
		expect(countTodos(enc('null'))).toBe(0);
	});

	it('six items - planning scenario', () => {
		expect(
			countTodos(
				enc(
					'[{"content": "Task 1", "status": "pending"}, {"content": "Task 2", "status": "pending"}, {"content": "Task 3", "status": "pending"}, {"content": "Task 4", "status": "pending"}, {"content": "Task 5", "status": "pending"}, {"content": "Task 6", "status": "in_progress"}]',
				),
			),
		).toBe(6);
	});

	// TS supplemental: empty input bytes
	it('empty input bytes returns 0 (TS supplemental)', () => {
		expect(countTodos(new Uint8Array(0))).toBe(0);
	});
});

// Go: messages_test.go:297-363 TestExtractInProgressTodo
describe('extractInProgressTodo — Go: messages_test.go:297-363 TestExtractInProgressTodo', () => {
	it('single in_progress item', () => {
		expect(
			extractInProgressTodo(
				enc(
					'[{"content": "First task", "status": "completed"}, {"content": "Second task", "status": "in_progress"}, {"content": "Third task", "status": "pending"}]',
				),
			),
		).toBe('Second task');
	});

	it('no in_progress - fallback to first pending', () => {
		expect(
			extractInProgressTodo(
				enc(
					'[{"content": "First task", "status": "completed"}, {"content": "Second task", "status": "pending"}, {"content": "Third task", "status": "pending"}]',
				),
			),
		).toBe('Second task');
	});

	it('no in_progress or pending - single completed returns last completed', () => {
		expect(extractInProgressTodo(enc('[{"content": "First task", "status": "completed"}]'))).toBe(
			'First task',
		);
	});

	it('all completed - returns last completed item', () => {
		expect(
			extractInProgressTodo(
				enc(
					'[{"content": "First task", "status": "completed"}, {"content": "Second task", "status": "completed"}, {"content": "Third task", "status": "completed"}]',
				),
			),
		).toBe('Third task');
	});

	it('empty array', () => {
		expect(extractInProgressTodo(enc('[]'))).toBe('');
	});

	it('invalid JSON', () => {
		expect(extractInProgressTodo(enc('not valid json'))).toBe('');
	});

	it('null', () => {
		expect(extractInProgressTodo(enc('null'))).toBe('');
	});

	it('activeForm field present - use content', () => {
		expect(
			extractInProgressTodo(
				enc('[{"content": "Run tests", "activeForm": "Running tests", "status": "in_progress"}]'),
			),
		).toBe('Run tests');
	});

	it('unknown status - fallback to first item content', () => {
		expect(
			extractInProgressTodo(
				enc(
					'[{"content": "First task", "status": "unknown"}, {"content": "Second task", "status": "other"}]',
				),
			),
		).toBe('First task');
	});

	it('empty status - fallback to first item content', () => {
		expect(
			extractInProgressTodo(
				enc('[{"content": "First task", "status": ""}, {"content": "Second task", "status": ""}]'),
			),
		).toBe('First task');
	});

	// TS supplemental: empty input bytes
	it('empty input bytes returns empty (TS supplemental)', () => {
		expect(extractInProgressTodo(new Uint8Array(0))).toBe('');
	});

	// ─── audit-3 Fix B: Go-parity for in_progress with empty/null content ──
	// Go: messages.go:171-175 — `if todo.Status == "in_progress" { return todo.Content }`
	// returns Content directly even if "" / missing (JSON zero-value). The Go code
	// does NOT continue to the pending fallback when the in_progress item exists.
	// Pre-fix TS added `&& typeof todo.content === 'string'` guard that skipped
	// items with null / missing content, falling through to pending — divergent.

	// Go: messages.go:171-175 — null content with in_progress status returns ""
	it('returns empty when in_progress item has null content (Go: messages.go:171-175 status wins)', () => {
		expect(
			extractInProgressTodo(
				enc('[{"content": null, "status": "in_progress"}, {"content": "P1", "status": "pending"}]'),
			),
		).toBe('');
	});

	// Go: messages.go:171-175 — missing content key with in_progress returns ""
	it('returns empty when in_progress item has no content key (Go: zero-value Content="")', () => {
		expect(
			extractInProgressTodo(
				enc('[{"status": "in_progress"}, {"content": "P1", "status": "pending"}]'),
			),
		).toBe('');
	});

	// Go: messages.go:171-175 — empty string content with in_progress returns ""
	it('returns empty when in_progress item has empty string content (Go: status match wins, no fallback)', () => {
		expect(
			extractInProgressTodo(
				enc('[{"content": "", "status": "in_progress"}, {"content": "P1", "status": "pending"}]'),
			),
		).toBe('');
	});
});

/**
 * truncatePromptForStorage is a Phase 5.1 helper colocated in messages.ts but
 * defined in Go `manual_commit_types.go:21-25`. Tests cover behavior that
 * underpins SessionState.lastPrompt storage (collapse whitespace + truncate
 * to MAX_LAST_PROMPT_RUNES with "..." suffix).
 */
// Go: manual_commit_types.go:21-25 truncatePromptForStorage
describe('truncatePromptForStorage — Go: manual_commit_types.go:21-25', () => {
	it('collapses whitespace runs to single space', () => {
		expect(truncatePromptForStorage('hello   \n\n  world')).toBe('hello world');
	});

	it('truncates to MAX_LAST_PROMPT_RUNES (100) with ellipsis', () => {
		const long = 'a'.repeat(200);
		const result = truncatePromptForStorage(long);
		expect([...result]).toHaveLength(100);
		expect(result.endsWith('...')).toBe(true);
	});

	it('does not modify short prompts', () => {
		expect(truncatePromptForStorage('hello world')).toBe('hello world');
	});

	it('preserves CJK rune boundaries when truncating', () => {
		const s = '你'.repeat(200);
		const result = truncatePromptForStorage(s);
		expect([...result]).toHaveLength(100);
	});
});
