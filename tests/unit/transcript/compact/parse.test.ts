import { describe, expect, it } from 'vitest';
import { buildCondensedEntries, extractToolDetail, parseLines } from '@/transcript/compact/parse';

const enc = new TextEncoder();

describe('parseLines', () => {
	// Go: parse_test.go:11 TestParseLines_ParsesCompactTranscript
	// Go: parse.go:17-44 parseLines
	it('parses compact transcript with v=1 + cli_version', () => {
		const input = enc.encode(
			`{"v":1,"agent":"claude-code","cli_version":"0.5.1","type":"user","content":[{"text":"hello"}]}\n` +
				`{"v":1,"agent":"claude-code","cli_version":"0.5.1","type":"assistant","content":[{"type":"text","text":"hi"},{"type":"tool_use","name":"Read","input":{"filePath":"a.txt"}}]}\n`,
		);

		const lines = parseLines(input);
		expect(lines).toHaveLength(2);
		expect(lines[0]?.v).toBe(1);
		expect(lines[0]?.type).toBe('user');

		const userBlocks = lines[0]?.content as Array<{ text: string }>;
		expect(userBlocks).toHaveLength(1);
		expect(userBlocks[0]?.text).toBe('hello');

		expect(lines[1]?.type).toBe('assistant');
		const assistantBlocks = lines[1]?.content as Array<{
			type: string;
			text?: string;
			name?: string;
		}>;
		expect(assistantBlocks).toHaveLength(2);
		expect(assistantBlocks[0]?.type).toBe('text');
		expect(assistantBlocks[0]?.text).toBe('hi');
		expect(assistantBlocks[1]?.type).toBe('tool_use');
		expect(assistantBlocks[1]?.name).toBe('Read');
	});

	// Go: parse.go:18-21 trimmed empty short-circuit
	it('returns [] for empty content', () => {
		expect(parseLines(enc.encode(''))).toEqual([]);
		expect(parseLines(enc.encode('   \n   \t  \n'))).toEqual([]);
	});

	// Go: parse_test.go:53 TestParseLines_RejectsNonCompactLine
	// Go: parse.go:36-38 reject when v=0 or cli_version=''
	it('throws for non-compact format (v=0 or empty cli_version)', () => {
		const noVField = enc.encode(`{"type":"user","content":"hello"}\n`);
		expect(() => parseLines(noVField)).toThrow(/not compact transcript format/);

		const emptyCliVersion = enc.encode(
			`{"v":1,"agent":"x","cli_version":"","type":"user","content":[]}\n`,
		);
		expect(() => parseLines(emptyCliVersion)).toThrow(/not compact transcript format/);
	});
});

describe('buildCondensedEntries', () => {
	// Go: parse_test.go:62 TestBuildCondensedEntries_ParsesCompactTranscript
	// Go: parse.go:46-115 BuildCondensedEntries
	it('categorizes user/assistant text + tool_use entries', () => {
		const input = enc.encode(
			`{"v":1,"agent":"claude-code","cli_version":"0.5.1","type":"user","content":[{"text":"hello"}]}\n` +
				`{"v":1,"agent":"claude-code","cli_version":"0.5.1","type":"assistant","content":[{"type":"text","text":"hi"},{"type":"tool_use","name":"Read","input":{"filePath":"a.txt"}}]}\n`,
		);

		const entries = buildCondensedEntries(input);
		expect(entries).toHaveLength(3);
		expect(entries[0]).toEqual({ type: 'user', content: 'hello' });
		expect(entries[1]).toEqual({ type: 'assistant', content: 'hi' });
		expect(entries[2]).toEqual({
			type: 'tool',
			content: '',
			toolName: 'Read',
			toolDetail: 'a.txt',
		});
	});

	// Go: parse.go:117-124 extractToolDetail per-key scan
	it('extracts tool detail via per-key scan (description/command/file_path/path/pattern)', () => {
		const cases: Array<[Record<string, unknown>, string]> = [
			[{ description: 'do thing', command: 'ls' }, 'do thing'],
			[{ command: 'ls -la' }, 'ls -la'],
			[{ file_path: '/a.txt' }, '/a.txt'],
			[{ filePath: '/b.txt' }, '/b.txt'],
			[{ path: '/c.txt' }, '/c.txt'],
			[{ pattern: 'TODO' }, 'TODO'],
			[{}, ''],
			[{ command: '' }, ''],
			[{ command: 123 }, ''],
		];

		for (const [input, want] of cases) {
			expect(extractToolDetail(input)).toBe(want);
		}
	});

	// Go: parse.go:110-112 errors when entries is empty
	it('throws when no parseable entries', () => {
		const onlyDroppedBlocks = enc.encode(
			`{"v":1,"agent":"claude-code","cli_version":"0.5.1","type":"user","content":[{"image":"x"}]}\n`,
		);
		expect(() => buildCondensedEntries(onlyDroppedBlocks)).toThrow(
			/no parseable compact transcript entries/,
		);
	});

	// Go: parse.go:55-58 invalid blocks JSON skips line
	it('skips line whose content blocks fail to JSON-parse but counts other lines', () => {
		const input = enc.encode(
			`{"v":1,"agent":"claude-code","cli_version":"0.5.1","type":"user","content":"not array"}\n` +
				`{"v":1,"agent":"claude-code","cli_version":"0.5.1","type":"user","content":[{"text":"hello"}]}\n`,
		);

		const entries = buildCondensedEntries(input);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toEqual({ type: 'user', content: 'hello' });
	});

	// Go: parse.go:62-72 user blocks join multiple text parts with '\n'
	it('joins multiple text blocks of a user line with \\n', () => {
		const input = enc.encode(
			`{"v":1,"agent":"claude-code","cli_version":"0.5.1","type":"user","content":[{"text":"line a"},{"text":""},{"text":"line b"}]}\n`,
		);

		const entries = buildCondensedEntries(input);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toEqual({ type: 'user', content: 'line a\nline b' });
	});
});
