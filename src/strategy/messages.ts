/**
 * Strategy-package commit message helpers + todo-JSON parsers.
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/strategy/messages.go` (full file).
 * Pure string / JSON helpers — no I/O, no agent registry.
 *
 * @packageDocumentation
 */

import { collapseWhitespace, truncateRunes } from '../stringutil';
import { MAX_DESCRIPTION_LENGTH, MAX_LAST_PROMPT_RUNES } from './constants';

/**
 * Truncate a string to `maxLen` Unicode runes, appending "..." if truncated.
 * Uses rune-based slicing (via {@link truncateRunes}) so multi-byte UTF-8
 * characters (CJK, emoji) are not split mid-codepoint.
 *
 * Edge: when `maxLen < 3` the suffix is dropped (only `maxLen` runes kept).
 *
 * Mirrors Go `messages.go:18-26` (`TruncateDescription`).
 *
 * @example
 * truncateDescription('hello world', 5)  // => 'he...'
 * truncateDescription('你好世界abc', 4)   // => '你...' (rune-aware)
 * truncateDescription('abcde', 10)       // => 'abcde' (no truncation needed)
 * truncateDescription('abcde', 2)        // => 'ab' (maxLen<3, no ellipsis)
 */
export function truncateDescription(s: string, maxLen: number): string {
	const runes = [...s];
	if (runes.length <= maxLen) {
		return s;
	}
	if (maxLen < 3) {
		return truncateRunes(s, maxLen, '');
	}
	return truncateRunes(s, maxLen, '...');
}

/**
 * Format a commit message for when a subagent (Task tool) completes.
 * Mirrors Go `messages.go:35-37` (`FormatSubagentEndMessage`).
 *
 * Format: `Completed '<agent-type>' agent: <description> (<tool-use-id>)`
 *
 * Edge cases (handled by {@link formatSubagentMessage}):
 * - Empty `description`: `Completed '<agent-type>' agent (<tool-use-id>)`
 * - Empty `agentType`: `Completed agent: <description> (<tool-use-id>)`
 * - Both empty: `Task: <tool-use-id>`
 */
export function formatSubagentEndMessage(
	agentType: string,
	description: string,
	toolUseId: string,
): string {
	return formatSubagentMessage('Completed', agentType, description, toolUseId);
}

/**
 * Shared helper for subagent start/end messages. Truncates `description` to
 * {@link MAX_DESCRIPTION_LENGTH} runes if non-empty.
 *
 * Mirrors Go `messages.go:40-60` (`formatSubagentMessage`).
 */
function formatSubagentMessage(
	verb: string,
	agentType: string,
	description: string,
	toolUseId: string,
): string {
	if (agentType === '' && description === '') {
		return `Task: ${toolUseId}`;
	}
	const desc = description === '' ? '' : truncateDescription(description, MAX_DESCRIPTION_LENGTH);
	if (agentType !== '' && desc !== '') {
		return `${verb} '${agentType}' agent: ${desc} (${toolUseId})`;
	}
	if (agentType !== '') {
		return `${verb} '${agentType}' agent (${toolUseId})`;
	}
	return `${verb} agent: ${desc} (${toolUseId})`;
}

/**
 * Format the commit message subject for incremental checkpoints.
 * Currently delegates to {@link formatIncrementalMessage}; the four leading
 * args (incrementalType / subagentType / taskDescription) are preserved for
 * Go API parity / forward compatibility but unused.
 *
 * Mirrors Go `messages.go:68-79` (`FormatIncrementalSubject`).
 */
export function formatIncrementalSubject(
	_incrementalType: string,
	_subagentType: string,
	_taskDescription: string,
	todoContent: string,
	incrementalSequence: number,
	shortToolUseId: string,
): string {
	return formatIncrementalMessage(todoContent, incrementalSequence, shortToolUseId);
}

/**
 * Format a commit message for an incremental subagent checkpoint.
 *
 * Format: `<truncated-todo-content> (<tool-use-id>)`. If `todoContent` is empty,
 * falls back to: `Checkpoint #<sequence>: <tool-use-id>`.
 *
 * Mirrors Go `messages.go:85-93` (`FormatIncrementalMessage`).
 */
export function formatIncrementalMessage(
	todoContent: string,
	sequence: number,
	toolUseId: string,
): string {
	if (todoContent === '') {
		return `Checkpoint #${sequence}: ${toolUseId}`;
	}
	const truncated = truncateDescription(todoContent, MAX_DESCRIPTION_LENGTH);
	return `${truncated} (${toolUseId})`;
}

/**
 * Single todo item as parsed from `tool_input.todos` (TodoWrite tool).
 * Mirrors Go `messages.go:96-100` (`todoItem` struct).
 */
interface TodoItem {
	content?: string;
	activeForm?: string;
	status?: string;
}

/**
 * Parse the `todos` JSON array safely; returns `[]` for empty / invalid input.
 * Centralizes the "JSON.parse + Array shape check" guard used by all 3
 * `extract*` helpers below.
 */
function parseTodos(todosJson: Uint8Array): TodoItem[] {
	if (todosJson.length === 0) {
		return [];
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder('utf-8').decode(todosJson));
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) {
		return [];
	}
	return parsed as TodoItem[];
}

/**
 * Extract the content of the last completed todo from `tool_input.todos`.
 *
 * When TodoWrite is called in PostToolUse the NEW list is provided which has
 * the just-completed work marked as "completed". The last completed item is
 * the most recently finished task — used to label commit messages.
 *
 * Returns empty string if no completed items exist or JSON is invalid.
 *
 * Mirrors Go `messages.go:110-128` (`ExtractLastCompletedTodo`).
 *
 * @example
 * const json = new TextEncoder().encode(
 *   '[{"content":"a","status":"completed"},{"content":"b","status":"pending"},{"content":"c","status":"completed"}]'
 * );
 * extractLastCompletedTodo(json) // => 'c'
 */
export function extractLastCompletedTodo(todosJson: Uint8Array): string {
	let last = '';
	for (const todo of parseTodos(todosJson)) {
		if (todo.status === 'completed' && typeof todo.content === 'string') {
			last = todo.content;
		}
	}
	return last;
}

/**
 * Count the number of todo items in the JSON array.
 * Returns 0 if the JSON is invalid or empty.
 * Mirrors Go `messages.go:132-143` (`CountTodos`).
 */
export function countTodos(todosJson: Uint8Array): number {
	return parseTodos(todosJson).length;
}

/**
 * Extract the content of the in-progress todo, with a priority cascade for
 * commit-message labeling on incremental checkpoints.
 *
 * Priority order:
 * 1. `in_progress` item (current work) — status match wins, return Content
 *    even if empty / missing (Go zero-value behavior; no fallback)
 * 2. first `pending` item (next work — fallback)
 * 3. last `completed` item (final work just finished)
 * 4. first item's content with unrecognized status (edge case)
 * 5. empty string (no items)
 *
 * Mirrors Go `messages.go:156-202` (`ExtractInProgressTodo`). Earlier TS used
 * `typeof todo.content === 'string'` guards that skipped null/missing content
 * — that fell through to pending, diverging from Go's "status match wins"
 * semantics. Audit-3 Fix B removed those guards.
 */
export function extractInProgressTodo(todosJson: Uint8Array): string {
	const todos = parseTodos(todosJson);
	if (todos.length === 0) {
		return '';
	}
	for (const todo of todos) {
		if (todo.status === 'in_progress') {
			// Go: messages.go:172 — `return todo.Content` (Content is "" when
			// missing / null in JSON via Go's `string` zero-value). Status match
			// wins — do NOT fall through to pending.
			return todo.content ?? '';
		}
	}
	for (const todo of todos) {
		if (todo.status === 'pending') {
			return todo.content ?? '';
		}
	}
	let lastCompleted = '';
	for (const todo of todos) {
		if (todo.status === 'completed') {
			lastCompleted = todo.content ?? '';
		}
	}
	if (lastCompleted !== '') {
		return lastCompleted;
	}
	const first = todos[0];
	if (first?.content) {
		return first.content;
	}
	return '';
}

/**
 * Truncate a user prompt for storage in `state.lastPrompt`. Collapses
 * whitespace, then truncates to {@link MAX_LAST_PROMPT_RUNES} runes (with
 * "..." suffix if truncated).
 *
 * Mirrors Go `manual_commit_types.go:23-25` (`truncatePromptForStorage`).
 *
 * @example
 * truncatePromptForStorage('hello   \n\n  world')  // => 'hello world'
 * truncatePromptForStorage('a'.repeat(200))         // => 'a'.repeat(97) + '...'
 */
export function truncatePromptForStorage(prompt: string): string {
	return truncateRunes(collapseWhitespace(prompt), MAX_LAST_PROMPT_RUNES, '...');
}
