/**
 * Pure helpers for `story explain` transcript rendering. Aggregates
 * raw JSONL transcript lines into per-turn `TranscriptTurn[]`, and
 * paginates them.
 *
 * Shared by:
 *   - `--full` (TUI render in `commands/explain.ts::renderFull`)
 *   - `--pure --full` / `--pure --page <n>` (AI plain-text render)
 *
 * Aggregation rules (Story-side, no Go counterpart — Go's
 * `explain.go` renders line-by-line):
 *
 *   - One `TranscriptTurn` per user/human prompt line.
 *   - Multiple assistant lines within the same turn are joined with
 *     `\n` into a single `assistantText`.
 *   - Tool-call blocks (`type: 'tool_use'`) are collected as
 *     `{ name, input }` only — tool results / outputs are dropped to
 *     keep the AI-facing payload focused on intent, not echo.
 *   - User lines that contain only `tool_result` blocks (Claude's
 *     reply-of-tool envelope) do NOT open a new turn — they're
 *     considered part of the assistant's tool round-trip.
 *   - Garbage lines (non-JSON, `null`, non-object, unknown role with
 *     no payload) are skipped silently.
 *
 * Reuses {@link flattenTranscriptEntryToText} from
 * `@/strategy/transcript-prompts` so transcript-shape defenses
 * (Claude flat / multimodal / Cursor / Vogon) stay in one place.
 *
 * @packageDocumentation
 */

import { flattenTranscriptEntryToText } from '@/strategy/transcript-prompts';
import { stripIDEContextTags } from '@/textutil';

/**
 * One tool invocation found in an assistant message. `input` is kept
 * as the parsed JSON value so the renderer can re-serialize at its
 * preferred density (`JSON.stringify(input, null, 2)` for pretty,
 * `JSON.stringify(input)` for compact).
 */
export interface ToolCall {
	name: string;
	input: unknown;
}

/**
 * One conversational turn: a user prompt + the assistant's reply
 * aggregated into single fields, plus any tool calls observed in the
 * assistant's blocks.
 */
export interface TranscriptTurn {
	/** 1-indexed turn number, matches `── Turn N ──` divider in TUI. */
	index: number;
	/**
	 * User-prompt text (already stripped of IDE context tags). Empty
	 * string when a transcript begins with assistant lines (no leading
	 * user line).
	 */
	userText: string;
	/**
	 * Aggregated assistant text. Multiple assistant entries joined
	 * with `\n`. Empty when the turn has no assistant reply (e.g.
	 * trailing user prompt with no response yet).
	 */
	assistantText: string;
	/** Tool calls observed in this turn's assistant entries. */
	toolCalls: ToolCall[];
}

/**
 * Parse one JSONL transcript entry into the role + raw object.
 * Returns `null` for blank / non-JSON / non-object lines.
 */
function parseEntry(rawLine: string): { role: string; obj: Record<string, unknown> } | null {
	const line = rawLine.trim();
	if (line === '') {
		return null;
	}
	let entry: unknown;
	try {
		entry = JSON.parse(line) as unknown;
	} catch {
		return null;
	}
	if (entry === null || typeof entry !== 'object') {
		return null;
	}
	const obj = entry as Record<string, unknown>;
	const roleRaw = obj.type ?? obj.role ?? '';
	const role = typeof roleRaw === 'string' ? roleRaw : '';
	return { role, obj };
}

/**
 * Inspect an entry's content/message blocks for `type: 'tool_use'`
 * and `type: 'tool_result'` shapes. Returns the lists separately so
 * callers can decide whether to swallow tool-only user envelopes.
 */
function extractBlocks(obj: Record<string, unknown>): {
	toolUses: ToolCall[];
	toolResultCount: number;
	textBlockCount: number;
} {
	const candidates: unknown[] = [];
	if (Array.isArray(obj.content)) {
		candidates.push(...(obj.content as unknown[]));
	}
	const msg = obj.message;
	if (
		msg !== null &&
		typeof msg === 'object' &&
		Array.isArray((msg as Record<string, unknown>).content)
	) {
		candidates.push(...((msg as Record<string, unknown>).content as unknown[]));
	}

	const toolUses: ToolCall[] = [];
	let toolResultCount = 0;
	let textBlockCount = 0;
	for (const block of candidates) {
		if (block === null || typeof block !== 'object') {
			continue;
		}
		const b = block as Record<string, unknown>;
		const t = b.type;
		if (t === 'tool_use') {
			const name = typeof b.name === 'string' ? b.name : '';
			toolUses.push({ name, input: b.input ?? null });
		} else if (t === 'tool_result') {
			toolResultCount++;
		} else if (t === 'text' && typeof b.text === 'string') {
			textBlockCount++;
		}
	}
	return { toolUses, toolResultCount, textBlockCount };
}

/**
 * True for entries Story treats as a user prompt that opens a new
 * Turn. Excludes Claude's tool-result envelope (`type: 'user'` whose
 * `content` is exclusively `tool_result` blocks).
 */
function isUserPromptOpener(role: string, obj: Record<string, unknown>): boolean {
	if (role !== 'user' && role !== 'human') {
		return false;
	}
	const blocks = extractBlocks(obj);
	if (blocks.toolResultCount > 0 && blocks.textBlockCount === 0) {
		// Pure tool-result reply — keep it inside the current turn.
		return false;
	}
	return true;
}

function isAssistant(role: string): boolean {
	return role === 'assistant';
}

/**
 * Aggregate raw JSONL transcript lines into per-turn `TranscriptTurn[]`.
 *
 * @example
 * ```ts
 * parseTranscriptTurns([
 *   '{"type":"user","content":"q1"}',
 *   '{"type":"assistant","content":"a1 step 1"}',
 *   '{"type":"assistant","content":"a1 step 2"}',
 *   '{"type":"user","content":"q2"}',
 * ]);
 * // [
 * //   { index: 1, userText: 'q1', assistantText: 'a1 step 1\na1 step 2', toolCalls: [] },
 * //   { index: 2, userText: 'q2', assistantText: '',                     toolCalls: [] },
 * // ]
 * ```
 *
 * Side effects: none — pure function over the input array.
 */
export function parseTranscriptTurns(lines: string[]): TranscriptTurn[] {
	const turns: TranscriptTurn[] = [];
	let current: TranscriptTurn | null = null;

	const ensureCurrent = (): TranscriptTurn => {
		if (current === null) {
			current = {
				index: turns.length + 1,
				userText: '',
				assistantText: '',
				toolCalls: [],
			};
			turns.push(current);
		}
		return current;
	};

	for (const rawLine of lines) {
		const parsed = parseEntry(rawLine);
		if (parsed === null) {
			continue;
		}
		const { role, obj } = parsed;

		if (isUserPromptOpener(role, obj)) {
			const text = stripIDEContextTags(flattenTranscriptEntryToText(obj));
			const turn: TranscriptTurn = {
				index: turns.length + 1,
				userText: text,
				assistantText: '',
				toolCalls: [],
			};
			turns.push(turn);
			current = turn;
			continue;
		}

		if (isAssistant(role)) {
			const turn = ensureCurrent();
			const text = flattenTranscriptEntryToText(obj);
			if (text !== '') {
				turn.assistantText = turn.assistantText === '' ? text : `${turn.assistantText}\n${text}`;
			}
			for (const tu of extractBlocks(obj).toolUses) {
				turn.toolCalls.push(tu);
			}
		}
	}

	return turns;
}

/**
 * Result of {@link paginateTurns}. `items` is the slice for the
 * requested page; `hasNext` says whether `page + 1` would have any
 * items.
 */
export interface PaginatedTurns {
	items: TranscriptTurn[];
	hasNext: boolean;
	totalPages: number;
}

/**
 * Slice a `TranscriptTurn[]` into page `page` (1-indexed) of size
 * `pageSize`. Out-of-range pages return an empty `items` slice but
 * still report `totalPages` so callers can render "page X of Y".
 *
 * @example
 * ```ts
 * paginateTurns(turns, 1, 2);
 * // { items: turns.slice(0, 2), hasNext: turns.length > 2, totalPages: ceil(turns.length / 2) }
 * ```
 *
 * Side effects: none — pure function over the input array.
 */
export function paginateTurns(
	turns: TranscriptTurn[],
	page: number,
	pageSize: number,
): PaginatedTurns {
	if (!Number.isInteger(page) || page <= 0) {
		throw new Error(`paginateTurns: page must be a positive integer, got ${page}`);
	}
	if (!Number.isInteger(pageSize) || pageSize <= 0) {
		throw new Error(`paginateTurns: pageSize must be a positive integer, got ${pageSize}`);
	}
	const totalPages = Math.ceil(turns.length / pageSize);
	const start = (page - 1) * pageSize;
	const end = start + pageSize;
	const items = turns.slice(start, end);
	const hasNext = end < turns.length;
	return { items, hasNext, totalPages };
}
