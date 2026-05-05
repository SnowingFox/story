import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	chunkTranscript,
	extractUserContent,
	parseFromBytes,
	parseFromFileAtLine,
	reassembleTranscript,
	sliceFromLine,
} from '@/transcript';
import { TestEnv } from '../helpers/test-env';

describe('parseFromBytes', () => {
	it('parses valid JSONL', () => {
		const data = '{"type":"user","content":"hello"}\n{"type":"assistant","content":"hi"}\n';
		const lines = parseFromBytes(data);
		expect(lines).toHaveLength(2);
		expect(lines[0]!.type).toBe('user');
		expect(lines[1]!.type).toBe('assistant');
	});

	it('returns empty array for empty input', () => {
		expect(parseFromBytes('')).toEqual([]);
	});

	it('skips malformed JSON lines', () => {
		const data = '{"type":"user"}\nnot json\n{"type":"assistant"}\n';
		const lines = parseFromBytes(data);
		expect(lines).toHaveLength(2);
		expect(lines[0]!.type).toBe('user');
		expect(lines[1]!.type).toBe('assistant');
	});

	it('parses last line without trailing newline', () => {
		const data = '{"type":"user","content":"hello"}';
		const lines = parseFromBytes(data);
		expect(lines).toHaveLength(1);
		expect(lines[0]!.type).toBe('user');
	});

	it('normalizes role to type', () => {
		const data = '{"role":"user","content":"hello"}\n';
		const lines = parseFromBytes(data);
		expect(lines[0]!.type).toBe('user');
	});

	it('does not overwrite existing type with role', () => {
		const data = '{"type":"assistant","role":"user"}\n';
		const lines = parseFromBytes(data);
		expect(lines[0]!.type).toBe('assistant');
	});
});

describe('parseFromFileAtLine', () => {
	let env: TestEnv;

	beforeEach(async () => {
		env = await TestEnv.create();
	});

	afterEach(async () => {
		await env.cleanup();
	});

	it('parses from start of file', async () => {
		const content = '{"type":"user"}\n{"type":"assistant"}\n';
		const filePath = path.join(env.dir, 'transcript.jsonl');
		await fs.writeFile(filePath, content);
		const lines = await parseFromFileAtLine(filePath, 0);
		expect(lines).toHaveLength(2);
	});

	it('parses from offset', async () => {
		const content = '{"type":"user"}\n{"type":"assistant"}\n{"type":"user"}\n';
		const filePath = path.join(env.dir, 'transcript.jsonl');
		await fs.writeFile(filePath, content);
		const lines = await parseFromFileAtLine(filePath, 1);
		expect(lines).toHaveLength(2);
		expect(lines[0]!.type).toBe('assistant');
	});

	it('skips malformed lines but still counts them', async () => {
		const content = '{"type":"user"}\nnot json\n{"type":"assistant"}\n';
		const filePath = path.join(env.dir, 'transcript.jsonl');
		await fs.writeFile(filePath, content);
		const lines = await parseFromFileAtLine(filePath, 1);
		expect(lines).toHaveLength(1);
		expect(lines[0]!.type).toBe('assistant');
	});

	it('returns empty for offset past EOF', async () => {
		const content = '{"type":"user"}\n';
		const filePath = path.join(env.dir, 'transcript.jsonl');
		await fs.writeFile(filePath, content);
		const lines = await parseFromFileAtLine(filePath, 100);
		expect(lines).toEqual([]);
	});
});

describe('sliceFromLine', () => {
	it('returns full content when startLine is 0', () => {
		const data = 'line0\nline1\nline2\n';
		expect(sliceFromLine(data, 0)).toBe(data);
	});

	it('skips N lines', () => {
		const data = 'line0\nline1\nline2\n';
		expect(sliceFromLine(data, 2)).toBe('line2\n');
	});

	it('returns null when startLine exceeds line count', () => {
		const data = 'line0\nline1\n';
		expect(sliceFromLine(data, 10)).toBeNull();
	});

	it('returns empty string for empty input', () => {
		expect(sliceFromLine('', 0)).toBe('');
	});

	it('handles content without trailing newline', () => {
		const data = 'line0\nline1';
		expect(sliceFromLine(data, 1)).toBe('line1');
	});
});

describe('chunkTranscript', () => {
	it('returns single chunk when under maxSize', () => {
		const data = '{"a":1}\n{"b":2}';
		const chunks = chunkTranscript(data, 1000);
		expect(chunks).toHaveLength(1);
		expect(chunks[0]).toBe('{"a":1}\n{"b":2}');
	});

	it('splits at line boundaries', () => {
		const line1 = '{"type":"user","content":"hello"}';
		const line2 = '{"type":"assistant","content":"world"}';
		const data = `${line1}\n${line2}`;
		const chunks = chunkTranscript(data, 50);
		expect(chunks).toHaveLength(2);
		expect(chunks[0]).toBe(line1);
		expect(chunks[1]).toBe(line2);
	});

	it('throws when single line exceeds maxSize', () => {
		const longLine = JSON.stringify({ content: 'x'.repeat(100) });
		const data = `${longLine}\n`;
		expect(() => chunkTranscript(data, 10)).toThrow();
	});

	it('round-trips with reassemble', () => {
		const data = '{"a":1}\n{"b":2}\n{"c":3}';
		const chunks = chunkTranscript(data, 20);
		const reassembled = reassembleTranscript(chunks);
		expect(reassembled).toBe(data);
	});

	// Go parity: chunking must use UTF-8 byte length (matches Go `ChunkJSONL`),
	// not JS `.length` (UTF-16 code units). Without this, a 25 MiB Chinese
	// transcript = 25M `.length` but 75 MiB on disk → can blow past git's 100MB
	// blob limit while TS thinks it's safe. The tests below construct inputs
	// where UTF-16 length and UTF-8 byte length diverge sharply.
	//
	// Go reference: entire-cli/cmd/entire/cli/agent/chunking.go: ChunkJSONL
	it('chunks at UTF-8 byte boundaries (matches Go on multi-byte content)', () => {
		// Each '中' is 1 UTF-16 unit but 3 UTF-8 bytes. 10 chars = 30 bytes.
		// Two lines of 30 bytes + newline = 31 bytes each → 62 bytes total.
		// maxSize = 35 bytes → must produce 2 chunks (one line each).
		const line = '中'.repeat(10);
		const data = `${line}\n${line}`;
		const chunks = chunkTranscript(data, 35);
		expect(chunks).toHaveLength(2);
		expect(chunks[0]).toBe(line);
		expect(chunks[1]).toBe(line);
		// And round-trip preserves bytes.
		expect(reassembleTranscript(chunks)).toBe(data);
	});

	it('throws on single line exceeding maxSize in UTF-8 bytes (not codeunits)', () => {
		// 50 emoji = 100 UTF-16 units but 200 UTF-8 bytes. maxSize = 150 → reject.
		const line = '🎉'.repeat(50);
		const data = `${line}\n`;
		expect(() => chunkTranscript(data, 150)).toThrow(
			/exceeds maximum chunk size \(201 bytes > 150 bytes\)/,
		);
	});

	it('keeps single chunk when bytes fit (no spurious split on multi-byte)', () => {
		// 30 Chinese chars = 90 bytes + newline = 91 bytes; maxSize 100 → one chunk
		const line = '中'.repeat(30);
		const data = line;
		const chunks = chunkTranscript(data, 100);
		expect(chunks).toHaveLength(1);
		expect(chunks[0]).toBe(line);
	});
});

describe('reassembleTranscript', () => {
	// Go parity: ReassembleTranscript returns (nil, nil) for empty input —
	// not an empty byte slice. TS now returns null to match.
	it('returns null for empty chunks (Go parity)', () => {
		expect(reassembleTranscript([])).toBeNull();
	});

	it('returns same content for single chunk', () => {
		expect(reassembleTranscript(['{"a":1}'])).toBe('{"a":1}');
	});

	it('joins multiple chunks with newline', () => {
		expect(reassembleTranscript(['{"a":1}', '{"b":2}'])).toBe('{"a":1}\n{"b":2}');
	});
});

describe('extractUserContent', () => {
	it('extracts string content', () => {
		const msg = { role: 'user', content: 'hello world' };
		expect(extractUserContent(msg)).toBe('hello world');
	});

	it('extracts array content', () => {
		const msg = {
			role: 'user',
			content: [
				{ type: 'text', text: 'first part' },
				{ type: 'text', text: 'second part' },
			],
		};
		expect(extractUserContent(msg)).toBe('first part\n\nsecond part');
	});

	it('returns empty for empty message', () => {
		expect(extractUserContent({})).toBe('');
	});

	it('returns empty for invalid content', () => {
		expect(extractUserContent({ content: 42 })).toBe('');
	});

	it('strips IDE context tags', () => {
		const msg = {
			content: 'before<ide_opened_file path="x">content</ide_opened_file>after',
		};
		expect(extractUserContent(msg)).toBe('beforeafter');
	});

	it('ignores tool results in array', () => {
		const msg = {
			content: [
				{ type: 'text', text: 'user text' },
				{ type: 'tool_result', text: 'should be ignored' },
				{ type: 'image', source: {} },
			],
		};
		expect(extractUserContent(msg)).toBe('user text');
	});
});
