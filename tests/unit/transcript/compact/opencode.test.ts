/**
 * Tests for `src/transcript/compact/opencode.ts` — Mirrors Go
 * `entire-cli/cmd/entire/cli/transcript/compact/opencode.go`.
 *
 * Covers:
 * - isOpenCodeFormat: valid JSON with info+messages, JSONL, plain text, empty, malformed
 * - compactOpenCode: user messages, assistant messages with tool calls,
 *   startLine offset, empty messages, tokens, system-reminder filtering
 * - msToTimestamp: 0 → null, valid ms → ISO string
 * - openCodeToolResult: completed → success, error → error
 * - compact() dispatch integration: OpenCode JSON detected and compacted
 */

import { describe, expect, it } from 'vitest';
import { compact } from '@/transcript/compact/index';
import { compactOpenCode, isOpenCodeFormat } from '@/transcript/compact/opencode';
import type { CompactMetadataFields } from '@/transcript/compact/types';

const enc = new TextEncoder();
const dec = new TextDecoder();

const opencodeOpts: CompactMetadataFields = {
	agent: 'opencode',
	cliVersion: '0.1.0',
	startLine: 0,
};

function makeSession(messages: unknown[]): string {
	return JSON.stringify({ info: { id: 'sess-1' }, messages });
}

function parseOutputLines(bytes: Uint8Array | null): Record<string, unknown>[] {
	if (bytes === null || bytes.length === 0) {
		return [];
	}
	const text = dec.decode(bytes).trim();
	if (text === '') {
		return [];
	}
	return text.split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('isOpenCodeFormat', () => {
	it('returns true for valid JSON with info + messages keys', () => {
		const input = enc.encode('{"info":{"id":"x"},"messages":[]}');
		expect(isOpenCodeFormat(input)).toBe(true);
	});

	it('returns true with whitespace around JSON', () => {
		const input = enc.encode('  {"info":{},"messages":[]} \n');
		expect(isOpenCodeFormat(input)).toBe(true);
	});

	it('returns false for JSONL (multiple lines)', () => {
		const input = enc.encode('{"type":"user","message":{"content":"hi"}}\n{"type":"assistant"}\n');
		expect(isOpenCodeFormat(input)).toBe(false);
	});

	it('returns false for plain text', () => {
		expect(isOpenCodeFormat(enc.encode('not json at all'))).toBe(false);
	});

	it('returns false for empty input', () => {
		expect(isOpenCodeFormat(new Uint8Array())).toBe(false);
	});

	it('returns false for malformed JSON', () => {
		expect(isOpenCodeFormat(enc.encode('{invalid json'))).toBe(false);
	});

	it('returns false for JSON without info key', () => {
		expect(isOpenCodeFormat(enc.encode('{"messages":[]}'))).toBe(false);
	});

	it('returns false for JSON without messages key', () => {
		expect(isOpenCodeFormat(enc.encode('{"info":{}}'))).toBe(false);
	});
});

describe('compactOpenCode — user messages', () => {
	it('emits a compact user line from a user message with text parts', () => {
		const session = makeSession([
			{
				info: { id: 'u1', role: 'user', time: { created: 1700000000000 } },
				parts: [{ type: 'text', text: 'Hello world' }],
			},
		]);
		const lines = parseOutputLines(compactOpenCode(enc.encode(session), opencodeOpts));
		expect(lines).toHaveLength(1);
		expect(lines[0]!.type).toBe('user');
		const content = lines[0]!.content as { text: string }[];
		expect(content[0]!.text).toBe('Hello world');
	});

	it('strips IDE context tags from user text', () => {
		const session = makeSession([
			{
				info: { id: 'u1', role: 'user', time: { created: 0 } },
				parts: [{ type: 'text', text: '<user_query>real prompt</user_query>' }],
			},
		]);
		const lines = parseOutputLines(compactOpenCode(enc.encode(session), opencodeOpts));
		expect(lines).toHaveLength(1);
		const content = lines[0]!.content as { text: string }[];
		expect(content[0]!.text).toBe('real prompt');
	});

	it('skips text parts that become empty after stripping', () => {
		const session = makeSession([
			{
				info: { id: 'u1', role: 'user', time: { created: 0 } },
				parts: [
					{ type: 'text', text: '<system-reminder>ctx</system-reminder>' },
					{ type: 'text', text: 'real' },
				],
			},
		]);
		const lines = parseOutputLines(compactOpenCode(enc.encode(session), opencodeOpts));
		expect(lines).toHaveLength(1);
		const content = lines[0]!.content as { text: string }[];
		expect(content).toHaveLength(1);
		expect(content[0]!.text).toBe('real');
	});
});

describe('compactOpenCode — assistant messages', () => {
	it('emits a compact assistant line with text + tool parts', () => {
		const session = makeSession([
			{
				info: {
					id: 'a1',
					role: 'assistant',
					time: { created: 1700000000000 },
					tokens: { input: 100, output: 50 },
				},
				parts: [
					{ type: 'text', text: 'Let me help' },
					{
						type: 'tool',
						callID: 'call-1',
						tool: 'read_file',
						state: {
							input: { path: '/tmp/x.ts' },
							output: 'file contents',
							status: 'completed',
						},
					},
				],
			},
		]);
		const lines = parseOutputLines(compactOpenCode(enc.encode(session), opencodeOpts));
		expect(lines).toHaveLength(1);
		expect(lines[0]!.type).toBe('assistant');
		expect(lines[0]!.id).toBe('a1');
		expect(lines[0]!.input_tokens).toBe(100);
		expect(lines[0]!.output_tokens).toBe(50);

		const content = lines[0]!.content as Record<string, unknown>[];
		expect(content).toHaveLength(2);
		expect(content[0]!.type).toBe('text');
		expect(content[1]!.type).toBe('tool_use');
		expect(content[1]!.name).toBe('read_file');
		expect(content[1]!.id).toBe('call-1');

		const result = content[1]!.result as Record<string, unknown>;
		expect(result.output).toBe('file contents');
		expect(result.status).toBe('success');
	});

	it('marks tool result as error when status is not completed', () => {
		const session = makeSession([
			{
				info: { id: 'a1', role: 'assistant', time: { created: 0 } },
				parts: [
					{
						type: 'tool',
						tool: 'bash',
						state: {
							output: 'command failed',
							status: 'error',
						},
					},
				],
			},
		]);
		const lines = parseOutputLines(compactOpenCode(enc.encode(session), opencodeOpts));
		const content = lines[0]!.content as Record<string, unknown>[];
		const result = content[0]!.result as Record<string, unknown>;
		expect(result.status).toBe('error');
	});

	it('omits token fields when tokens are zero', () => {
		const session = makeSession([
			{
				info: { id: 'a1', role: 'assistant', time: { created: 0 } },
				parts: [{ type: 'text', text: 'response' }],
			},
		]);
		const lines = parseOutputLines(compactOpenCode(enc.encode(session), opencodeOpts));
		expect(lines[0]!.input_tokens).toBeUndefined();
		expect(lines[0]!.output_tokens).toBeUndefined();
	});
});

describe('compactOpenCode — startLine offset', () => {
	it('applies startLine as message-index offset', () => {
		const session = makeSession([
			{
				info: { id: 'u1', role: 'user', time: { created: 0 } },
				parts: [{ type: 'text', text: 'first' }],
			},
			{
				info: { id: 'a1', role: 'assistant', time: { created: 0 } },
				parts: [{ type: 'text', text: 'resp' }],
			},
			{
				info: { id: 'u2', role: 'user', time: { created: 0 } },
				parts: [{ type: 'text', text: 'second' }],
			},
		]);
		const opts = { ...opencodeOpts, startLine: 2 };
		const lines = parseOutputLines(compactOpenCode(enc.encode(session), opts));
		expect(lines).toHaveLength(1);
		const content = lines[0]!.content as { text: string }[];
		expect(content[0]!.text).toBe('second');
	});

	it('returns empty when startLine >= messages.length', () => {
		const session = makeSession([
			{
				info: { id: 'u1', role: 'user', time: { created: 0 } },
				parts: [{ type: 'text', text: 'only' }],
			},
		]);
		const result = compactOpenCode(enc.encode(session), { ...opencodeOpts, startLine: 5 });
		expect(result).not.toBeNull();
		expect(result!.length).toBe(0);
	});
});

describe('compactOpenCode — edge cases', () => {
	it('returns null for empty messages array', () => {
		const session = makeSession([]);
		const result = compactOpenCode(enc.encode(session), opencodeOpts);
		expect(result).toBeNull();
	});

	it('returns null for invalid JSON', () => {
		const result = compactOpenCode(enc.encode('not json'), opencodeOpts);
		expect(result).toBeNull();
	});

	it('emits timestamp as ISO string for non-zero ms', () => {
		const session = makeSession([
			{
				info: { id: 'u1', role: 'user', time: { created: 1700000000000 } },
				parts: [{ type: 'text', text: 'hi' }],
			},
		]);
		const lines = parseOutputLines(compactOpenCode(enc.encode(session), opencodeOpts));
		const ts = lines[0]!.ts as string;
		expect(ts).toContain('2023-11-14');
	});

	it('omits timestamp when time.created is 0', () => {
		const session = makeSession([
			{
				info: { id: 'u1', role: 'user', time: { created: 0 } },
				parts: [{ type: 'text', text: 'hi' }],
			},
		]);
		const lines = parseOutputLines(compactOpenCode(enc.encode(session), opencodeOpts));
		expect(lines[0]!.ts).toBeUndefined();
	});
});

describe('compact() dispatch — OpenCode integration', () => {
	it('detects OpenCode format and dispatches to compactOpenCode', () => {
		const session = makeSession([
			{
				info: { id: 'u1', role: 'user', time: { created: 0 } },
				parts: [{ type: 'text', text: 'Hello' }],
			},
			{
				info: { id: 'a1', role: 'assistant', time: { created: 0 } },
				parts: [{ type: 'text', text: 'Hi' }],
			},
		]);
		const result = compact(enc.encode(session), opencodeOpts);
		expect(result).not.toBeNull();
		const lines = parseOutputLines(result);
		expect(lines).toHaveLength(2);
		expect(lines[0]!.type).toBe('user');
		expect(lines[1]!.type).toBe('assistant');
	});
});
