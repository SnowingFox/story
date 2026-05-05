/**
 * `src/commands/_shared/transcript-display.ts` — pure helpers shared
 * between `story explain --full` (TUI) and `story explain --pure --*`
 * (AI plain text). Aggregates transcript JSONL lines into per-turn
 * `TranscriptTurn[]` and paginates them.
 *
 * Aggregation rules under test:
 *   - One Turn per user/human prompt line.
 *   - Assistant text within the same Turn is joined with `\n`.
 *   - Tool-call blocks (`type: 'tool_use'`) are collected with name +
 *     input only; tool results / outputs are dropped.
 *   - Garbage lines (non-JSON, null, non-object) are skipped silently.
 *   - User lines that contain only `tool_result` blocks (Claude
 *     reply-of-tool envelope) do NOT open a new Turn.
 *
 * No `// Go:` anchors — Go's `explain.go` renders line-by-line and has
 * no equivalent helper. This is a Story-side TS extension.
 */

import { describe, expect, it } from 'vitest';
import {
	paginateTurns,
	parseTranscriptTurns,
	type TranscriptTurn,
} from '@/commands/_shared/transcript-display';

function jl(...objs: unknown[]): string[] {
	return objs.map((o) => JSON.stringify(o));
}

describe('parseTranscriptTurns', () => {
	it('returns [] for empty input', () => {
		expect(parseTranscriptTurns([])).toEqual([]);
	});

	it('skips blank / non-JSON / null / non-object lines', () => {
		const lines = ['', '   ', 'not-json', JSON.stringify(null), JSON.stringify(42)];
		expect(parseTranscriptTurns(lines)).toEqual([]);
	});

	it('Claude flat: one user + one assistant → single Turn with both', () => {
		const lines = jl(
			{ type: 'user', content: 'hi there' },
			{ type: 'assistant', content: 'hello back' },
		);
		const turns = parseTranscriptTurns(lines);
		expect(turns).toHaveLength(1);
		expect(turns[0]?.index).toBe(1);
		expect(turns[0]?.userText).toBe('hi there');
		expect(turns[0]?.assistantText).toBe('hello back');
		expect(turns[0]?.toolCalls).toEqual([]);
	});

	it('multiple assistant lines in one Turn aggregate into a single assistantText', () => {
		const lines = jl(
			{ type: 'user', content: 'do the thing' },
			{ type: 'assistant', content: 'thinking step 1' },
			{ type: 'assistant', content: 'thinking step 2' },
			{ type: 'assistant', content: 'final answer' },
		);
		const turns = parseTranscriptTurns(lines);
		expect(turns).toHaveLength(1);
		expect(turns[0]?.assistantText).toBe('thinking step 1\nthinking step 2\nfinal answer');
	});

	it('user line opens a new Turn each time', () => {
		const lines = jl(
			{ type: 'user', content: 'q1' },
			{ type: 'assistant', content: 'a1' },
			{ type: 'user', content: 'q2' },
			{ type: 'assistant', content: 'a2' },
			{ type: 'user', content: 'q3' },
		);
		const turns = parseTranscriptTurns(lines);
		expect(turns).toHaveLength(3);
		expect(turns.map((t: TranscriptTurn) => t.index)).toEqual([1, 2, 3]);
		expect(turns[2]?.userText).toBe('q3');
		expect(turns[2]?.assistantText).toBe('');
	});

	it('Claude multimodal user content (array of {type:text}) flattens to userText', () => {
		const lines = jl({
			type: 'user',
			message: { content: [{ type: 'text', text: 'multi-line\nprompt' }] },
		});
		const turns = parseTranscriptTurns(lines);
		expect(turns).toHaveLength(1);
		expect(turns[0]?.userText).toBe('multi-line\nprompt');
	});

	it('Cursor multimodal user (role:user, message.content:[{type:text}])', () => {
		const lines = jl({
			role: 'user',
			message: { content: [{ type: 'text', text: '改一行文字' }] },
		});
		const turns = parseTranscriptTurns(lines);
		expect(turns).toHaveLength(1);
		expect(turns[0]?.userText).toBe('改一行文字');
	});

	it('Vogon-style flat string message field', () => {
		const lines = jl({ type: 'user', message: 'flat-string-prompt' });
		const turns = parseTranscriptTurns(lines);
		expect(turns).toHaveLength(1);
		expect(turns[0]?.userText).toBe('flat-string-prompt');
	});

	it('user "human" type alias is treated like user', () => {
		const lines = jl({ type: 'human', content: 'q-human' }, { type: 'assistant', content: 'a' });
		const turns = parseTranscriptTurns(lines);
		expect(turns).toHaveLength(1);
		expect(turns[0]?.userText).toBe('q-human');
	});

	it('extracts assistant tool_use blocks: name + input only, no result/output', () => {
		const lines = jl(
			{ type: 'user', content: 'call a tool' },
			{
				type: 'assistant',
				message: {
					content: [
						{ type: 'text', text: 'I will call Edit.' },
						{
							type: 'tool_use',
							id: 'toolu_1',
							name: 'Edit',
							input: { file_path: 'a.ts', old_string: 'x', new_string: 'y' },
						},
					],
				},
			},
		);
		const turns = parseTranscriptTurns(lines);
		expect(turns).toHaveLength(1);
		expect(turns[0]?.assistantText).toBe('I will call Edit.');
		expect(turns[0]?.toolCalls).toHaveLength(1);
		expect(turns[0]?.toolCalls[0]?.name).toBe('Edit');
		expect(turns[0]?.toolCalls[0]?.input).toEqual({
			file_path: 'a.ts',
			old_string: 'x',
			new_string: 'y',
		});
		// Plain-string body must not contain serialized result/output.
		const json = JSON.stringify(turns);
		expect(json).not.toContain('tool_result');
		expect(json).not.toContain('"output"');
	});

	it('user line containing only tool_result blocks does not open a new Turn', () => {
		const lines = jl(
			{ type: 'user', content: 'first prompt' },
			{
				type: 'assistant',
				message: {
					content: [
						{ type: 'text', text: 'calling Bash' },
						{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
					],
				},
			},
			{
				type: 'user',
				message: {
					content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a.ts\nb.ts' }],
				},
			},
			{ type: 'assistant', content: 'done' },
		);
		const turns = parseTranscriptTurns(lines);
		expect(turns).toHaveLength(1);
		expect(turns[0]?.assistantText).toBe('calling Bash\ndone');
		expect(turns[0]?.toolCalls).toHaveLength(1);
		expect(turns[0]?.toolCalls[0]?.name).toBe('Bash');
	});

	it('OpenCode-style {type: tool_use, name, input, result} drops result', () => {
		const lines = jl(
			{ type: 'user', content: 'kick off' },
			{
				type: 'assistant',
				content: [
					{
						type: 'tool_use',
						id: 'call_42',
						name: 'read',
						input: { path: 'src/app.ts' },
						result: { output: 'file contents...' },
					},
				],
			},
		);
		const turns = parseTranscriptTurns(lines);
		expect(turns).toHaveLength(1);
		expect(turns[0]?.toolCalls).toHaveLength(1);
		expect(turns[0]?.toolCalls[0]?.name).toBe('read');
		expect(turns[0]?.toolCalls[0]?.input).toEqual({ path: 'src/app.ts' });
		const json = JSON.stringify(turns);
		expect(json).not.toContain('file contents');
	});

	it('garbage lines mixed with valid ones still produce correct Turn count', () => {
		const lines = [
			'NOT_JSON',
			JSON.stringify({ type: 'user', content: 'q1' }),
			'',
			JSON.stringify({ type: 'assistant', content: 'a1' }),
			'   ',
			JSON.stringify({ type: 'user', content: 'q2' }),
			JSON.stringify(null),
		];
		const turns = parseTranscriptTurns(lines);
		expect(turns).toHaveLength(2);
		expect(turns[0]?.userText).toBe('q1');
		expect(turns[1]?.userText).toBe('q2');
	});

	it('skips lines with no text, no tool_use, and unknown role', () => {
		const lines = jl(
			{ type: 'system', content: 'system msg' },
			{ type: 'user', content: 'q' },
			{ type: 'system', content: 'after' },
		);
		const turns = parseTranscriptTurns(lines);
		expect(turns).toHaveLength(1);
		expect(turns[0]?.assistantText).toBe('');
	});

	it('preserves arbitrary tool input shape (string / array / nested object)', () => {
		const lines = jl(
			{ type: 'user', content: 'multi-tool' },
			{
				type: 'assistant',
				message: {
					content: [
						{ type: 'tool_use', id: 't1', name: 'A', input: 'just a string' },
						{ type: 'tool_use', id: 't2', name: 'B', input: [1, 2, 3] },
						{ type: 'tool_use', id: 't3', name: 'C', input: { nested: { k: 'v' } } },
					],
				},
			},
		);
		const turns = parseTranscriptTurns(lines);
		expect(turns[0]?.toolCalls).toHaveLength(3);
		expect(turns[0]?.toolCalls[0]?.input).toBe('just a string');
		expect(turns[0]?.toolCalls[1]?.input).toEqual([1, 2, 3]);
		expect(turns[0]?.toolCalls[2]?.input).toEqual({ nested: { k: 'v' } });
	});
});

describe('paginateTurns', () => {
	function makeTurns(n: number): TranscriptTurn[] {
		return Array.from({ length: n }, (_, i) => ({
			index: i + 1,
			userText: `q${i + 1}`,
			assistantText: `a${i + 1}`,
			toolCalls: [],
		}));
	}

	it('page 1 of 5 turns @ pageSize 2 → first 2 turns + hasNext', () => {
		const r = paginateTurns(makeTurns(5), 1, 2);
		expect(r.items.map((t) => t.index)).toEqual([1, 2]);
		expect(r.hasNext).toBe(true);
		expect(r.totalPages).toBe(3);
	});

	it('last page → hasNext false', () => {
		const r = paginateTurns(makeTurns(5), 3, 2);
		expect(r.items.map((t) => t.index)).toEqual([5]);
		expect(r.hasNext).toBe(false);
		expect(r.totalPages).toBe(3);
	});

	it('exact divisor: 4 turns @ pageSize 2 → page 2 has 2 items, hasNext false', () => {
		const r = paginateTurns(makeTurns(4), 2, 2);
		expect(r.items.map((t) => t.index)).toEqual([3, 4]);
		expect(r.hasNext).toBe(false);
		expect(r.totalPages).toBe(2);
	});

	it('out-of-range page → empty items, hasNext false, totalPages still computed', () => {
		const r = paginateTurns(makeTurns(3), 5, 2);
		expect(r.items).toEqual([]);
		expect(r.hasNext).toBe(false);
		expect(r.totalPages).toBe(2);
	});

	it('empty turns → totalPages 0, hasNext false', () => {
		const r = paginateTurns([], 1, 2);
		expect(r.items).toEqual([]);
		expect(r.totalPages).toBe(0);
		expect(r.hasNext).toBe(false);
	});

	it('rejects non-positive page', () => {
		expect(() => paginateTurns(makeTurns(2), 0, 2)).toThrow(/page/);
		expect(() => paginateTurns(makeTurns(2), -1, 2)).toThrow(/page/);
	});

	it('rejects non-positive pageSize', () => {
		expect(() => paginateTurns(makeTurns(2), 1, 0)).toThrow(/pageSize/);
	});
});
