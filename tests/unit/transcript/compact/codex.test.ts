/**
 * Tests for `src/transcript/compact/codex.ts` — Mirrors Go
 * `entire-cli/cmd/entire/cli/transcript/compact/codex.go` + `codex_test.go`.
 *
 * Covers:
 * - isCodexFormat (6 case): session_meta / response_item / event_msg /
 *   turn_context first line → true; non-Codex / invalid-then-valid → true/false
 * - compactCodex byte-equal Go fixture (codex_full.jsonl → codex_expected.jsonl)
 * - compactCodex inline cases (Go TestCompact_CodexInlineCases 7 sub-case +
 *   Story 补充): user system filter / function_call / multiple output_text /
 *   apply_patch custom_tool_call / standalone tool_call / mixed func+custom /
 *   reasoning + event_msg dropped
 * - compactCodex startLine offset BEFORE format-specific parsing (Go
 *   TestCompact_CodexStartLine + IgnoresTokenCountEvents)
 * - codexCustomOutputText double fallback (string vs {text} object)
 * - **Decision防御**: compactor token field is **raw** event_msg.token_count
 *   pass-through (NOT cumulative delta — that's in transcript.ts)
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compactCodex, isCodexFormat } from '@/transcript/compact/codex';
import type { CompactMetadataFields } from '@/transcript/compact/types';

const enc = new TextEncoder();
const FIX_DIR = path.join(__dirname, 'testdata');

const codexOpts: CompactMetadataFields = {
	agent: 'codex',
	cliVersion: '0.5.1',
	startLine: 0,
};

describe('isCodexFormat — Go: compact/codex.go:23-49 + codex_test.go TestIsCodexFormat', () => {
	// Go: codex_test.go:184-192 codex session_meta first line
	it('returns true for valid Codex JSONL with session_meta first line', () => {
		const input = enc.encode('{"timestamp":"t1","type":"session_meta","payload":{"id":"s1"}}\n');
		expect(isCodexFormat(input)).toBe(true);
	});

	// Story补充: response_item first line still ✓ (Go switch 4-case acceptance)
	it('returns true when first line is response_item', () => {
		const input = enc.encode(
			'{"type":"response_item","payload":{"type":"message","role":"user"}}\n',
		);
		expect(isCodexFormat(input)).toBe(true);
	});

	// Story补充: event_msg first line still ✓
	it('returns true when first line is event_msg', () => {
		const input = enc.encode('{"type":"event_msg","payload":{"type":"task_started"}}\n');
		expect(isCodexFormat(input)).toBe(true);
	});

	// Go: compact/codex.go:39-40 turn_context is a valid Codex type
	it('returns true when first line is turn_context', () => {
		const input = enc.encode(
			'{"type":"turn_context","payload":{"turn_id":"t1","context_id":"c1"}}\n',
		);
		expect(isCodexFormat(input)).toBe(true);
	});

	// Go: codex_test.go:194-198 claude format ✗
	it('returns false for Claude/Cursor JSONL', () => {
		const input = enc.encode('{"type":"user","uuid":"u1","message":{"content":"hi"}}\n');
		expect(isCodexFormat(input)).toBe(false);
	});

	// Go: codex_test.go:24-37 invalid first line → continue, second valid line evaluated
	it('skips invalid JSON first line, evaluates next line', () => {
		const input = enc.encode('not json\n{"type":"session_meta","payload":{"id":"s1"}}\n');
		expect(isCodexFormat(input)).toBe(true);
	});

	// Failure path: empty / no valid lines → false
	it('returns false on empty content', () => {
		expect(isCodexFormat(new Uint8Array())).toBe(false);
	});

	// Go: codex_test.go:217-225 TestIsCodexFormat_LargeFirstLine — 70KB first line
	it('handles large first line (70KB session_meta)', () => {
		const blob = 'x'.repeat(70 * 1024);
		const input = enc.encode(
			`{"timestamp":"t1","type":"session_meta","payload":{"id":"s1","blob":"${blob}"}}\n`,
		);
		expect(isCodexFormat(input)).toBe(true);
	});
});

describe('compactCodex — Go: compact/codex.go + codex_test.go', () => {
	// Go: codex_test.go:13-18 TestCompact_CodexFixture (byte-equal)
	it('matches Go fixture byte-for-byte (codex_full.jsonl → codex_expected.jsonl)', async () => {
		const input = await fs.readFile(path.join(FIX_DIR, 'codex_full.jsonl'));
		const expected = await fs.readFile(path.join(FIX_DIR, 'codex_expected.jsonl'));
		const actual = compactCodex(
			new Uint8Array(input.buffer, input.byteOffset, input.byteLength),
			codexOpts,
		);
		// Buffer.equals is byte-level
		expect(Buffer.from(actual).equals(expected)).toBe(true);
	});

	// Go: codex_test.go:34-46 inline TestCompact_CodexInlineCases "assistant with function call and output"
	it('packs assistant + function_call + output into single line with tool_use', () => {
		const input = enc.encode(
			'{"timestamp":"t1","type":"session_meta","payload":{"id":"s1"}}\n' +
				'{"timestamp":"t2","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Running the command."}]}}\n' +
				'{"timestamp":"t3","type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\\"cmd\\":\\"ls\\"}","call_id":"call_1"}}\n' +
				'{"timestamp":"t4","type":"response_item","payload":{"type":"function_call_output","call_id":"call_1","output":"file1.txt\\nfile2.txt"}}\n',
		);
		const out = new TextDecoder().decode(compactCodex(input, codexOpts));
		// Note: alphabetical key order — text block `{text, type}`, tool_use block
		// `{id, input, name, result, type}` — matches Go map[string]json.RawMessage
		// json.Marshal sort. Inline JSON inside `input` (parsed from `arguments`)
		// preserves source key order via V8 JSON.parse + JSON.stringify.
		const expectedLine =
			'{"v":1,"agent":"codex","cli_version":"0.5.1","type":"assistant","ts":"t2","content":[{"text":"Running the command.","type":"text"},{"id":"call_1","input":{"cmd":"ls"},"name":"exec_command","result":{"output":"file1.txt\\nfile2.txt","status":"success"},"type":"tool_use"}]}\n';
		expect(out).toBe(expectedLine);
	});

	// Go: codex_test.go:80-94 "assistant with custom_tool_call apply_patch"
	it('packs apply_patch custom_tool_call as {input: <plain text>} (not parsed JSON)', () => {
		const input = enc.encode(
			'{"timestamp":"t1","type":"session_meta","payload":{"id":"s1"}}\n' +
				'{"timestamp":"t2","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Creating the file now."}]}}\n' +
				'{"timestamp":"t3","type":"response_item","payload":{"type":"custom_tool_call","status":"completed","call_id":"call_1","name":"apply_patch","input":"*** Begin Patch\\n*** Add File: hello.txt\\n+Hello World\\n*** End Patch\\n"}}\n' +
				'{"timestamp":"t4","type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"call_1","output":{"type":"text","text":"Success. Updated: A hello.txt"}}}\n',
		);
		const out = new TextDecoder().decode(compactCodex(input, codexOpts));
		const expectedLine =
			'{"v":1,"agent":"codex","cli_version":"0.5.1","type":"assistant","ts":"t2","content":[{"text":"Creating the file now.","type":"text"},{"id":"call_1","input":{"input":"*** Begin Patch\\n*** Add File: hello.txt\\n+Hello World\\n*** End Patch\\n"},"name":"apply_patch","result":{"output":"Success. Updated: A hello.txt","status":"success"},"type":"tool_use"}]}\n';
		expect(out).toBe(expectedLine);
	});

	// Go: codex_test.go:97-110 "standalone custom_tool_call"
	it('emits standalone tool_call without preceding assistant text', () => {
		const input = enc.encode(
			'{"timestamp":"t1","type":"session_meta","payload":{"id":"s1"}}\n' +
				'{"timestamp":"t2","type":"response_item","payload":{"type":"custom_tool_call","status":"completed","call_id":"call_2","name":"apply_patch","input":"*** Begin Patch\\n*** Update File: readme.md\\n-old\\n+new\\n*** End Patch\\n"}}\n' +
				'{"timestamp":"t3","type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"call_2","output":{"type":"text","text":"Success. Updated: M readme.md"}}}\n',
		);
		const out = new TextDecoder().decode(compactCodex(input, codexOpts));
		expect(out).toContain('"type":"tool_use"');
		expect(out).toContain('"name":"apply_patch"');
		expect(out).toContain('"call_2"');
	});

	// Go: codex_test.go:48-58 "user message with system content filtered"
	it('drops system content prefixes from user text (developer + AGENTS.md filtered)', () => {
		const input = enc.encode(
			'{"timestamp":"t1","type":"session_meta","payload":{"id":"s1"}}\n' +
				'{"timestamp":"t2","type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"<permissions>sandbox</permissions>"}]}}\n' +
				'{"timestamp":"t3","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md\\ninstructions"},{"type":"input_text","text":"hello world"}]}}\n',
		);
		const out = new TextDecoder().decode(compactCodex(input, codexOpts));
		// Only "hello world" should survive — developer message + AGENTS.md text filtered
		const expectedLine =
			'{"v":1,"agent":"codex","cli_version":"0.5.1","type":"user","ts":"t3","content":[{"text":"hello world"}]}\n';
		expect(out).toBe(expectedLine);
	});

	// Go: codex_test.go:228-258 TestCompact_CodexStartLine
	it('startLine slices via sliceFromLine BEFORE format-specific parsing', () => {
		const input = enc.encode(
			'{"timestamp":"t1","type":"session_meta","payload":{"id":"s1"}}\n' +
				'{"timestamp":"t2","type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"<permissions>sandbox</permissions>"}]}}\n' +
				'{"timestamp":"t3","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md\\ninstructions"}]}}\n' +
				'{"timestamp":"t4","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"first prompt"}]}}\n' +
				'{"timestamp":"t5","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"response to first"}]}}\n',
		);
		const out = new TextDecoder().decode(
			compactCodex(input, { agent: 'codex', cliVersion: '0.5.1', startLine: 4 }),
		);
		// startLine=4 skips first 4 lines; only assistant "response to first" survives
		// (text block alphabetical: text/type)
		expect(out).toBe(
			'{"v":1,"agent":"codex","cli_version":"0.5.1","type":"assistant","ts":"t5","content":[{"text":"response to first","type":"text"}]}\n',
		);
	});

	// Go: codex_test.go:260-280 TestCompact_CodexStartLine_IgnoresTokenCountEvents
	it('startLine pass-through includes subsequent token_count attached to assistant', () => {
		const input = enc.encode(
			'{"timestamp":"t1","type":"session_meta","payload":{"id":"s1"}}\n' +
				'{"timestamp":"t2","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"first prompt"}]}}\n' +
				'{"timestamp":"t3","type":"event_msg","payload":{"type":"token_count","input_tokens":10,"output_tokens":0}}\n' +
				'{"timestamp":"t4","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"second entry"}]}}\n',
		);
		const out = new TextDecoder().decode(
			compactCodex(input, { agent: 'codex', cliVersion: '0.5.1', startLine: 2 }),
		);
		expect(out).toBe(
			'{"v":1,"agent":"codex","cli_version":"0.5.1","type":"assistant","ts":"t4","input_tokens":10,"content":[{"text":"second entry","type":"text"}]}\n',
		);
	});

	// Story补充 (decision check): compactor token field is RAW pass-through, NOT delta
	it('compactor uses raw event_msg.token_count (NOT cumulative delta)', () => {
		// 2 token_counts cumulative-style input=100 → 300 (delta 200);
		// compactor MUST emit input_tokens=300 (the latest raw value), not 200.
		const input = enc.encode(
			'{"timestamp":"t1","type":"session_meta","payload":{"id":"s1"}}\n' +
				'{"timestamp":"t2","type":"event_msg","payload":{"type":"token_count","input_tokens":100,"output_tokens":50}}\n' +
				'{"timestamp":"t3","type":"event_msg","payload":{"type":"token_count","input_tokens":300,"output_tokens":150}}\n' +
				'{"timestamp":"t4","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"reply"}]}}\n',
		);
		const out = new TextDecoder().decode(compactCodex(input, codexOpts));
		// expect input_tokens=300, output_tokens=150 (raw last token_count, NOT delta 200/100)
		expect(out).toContain('"input_tokens":300');
		expect(out).toContain('"output_tokens":150');
	});

	// Failure path: empty content → empty output
	it('returns empty Uint8Array on empty content', () => {
		const out = compactCodex(new Uint8Array(), codexOpts);
		expect(out.length).toBe(0);
	});

	// Failure path: startLine ≥ total lines → empty output
	it('returns empty Uint8Array when startLine exceeds total lines', () => {
		const input = enc.encode(
			'{"timestamp":"t1","type":"session_meta","payload":{"id":"s1"}}\n' +
				'{"timestamp":"t2","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}}\n',
		);
		const out = compactCodex(input, { agent: 'codex', cliVersion: '0.5.1', startLine: 100 });
		expect(out.length).toBe(0);
	});

	// Go: codex_test.go:144-156 reasoning + event_msg dropped
	it('drops reasoning + event_msg (non-token_count) when reading lines', () => {
		const input = enc.encode(
			'{"timestamp":"t1","type":"session_meta","payload":{"id":"s1"}}\n' +
				'{"timestamp":"t2","type":"event_msg","payload":{"type":"task_started"}}\n' +
				'{"timestamp":"t3","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}}\n' +
				'{"timestamp":"t4","type":"response_item","payload":{"type":"reasoning","summary":[]}}\n' +
				'{"timestamp":"t5","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hello"}]}}\n',
		);
		const out = new TextDecoder().decode(compactCodex(input, codexOpts));
		expect(out).toBe(
			'{"v":1,"agent":"codex","cli_version":"0.5.1","type":"user","ts":"t3","content":[{"text":"hi"}]}\n' +
				'{"v":1,"agent":"codex","cli_version":"0.5.1","type":"assistant","ts":"t5","content":[{"text":"hello","type":"text"}]}\n',
		);
	});

	// Go: codex_test.go:60-69 multiple output_text blocks joined with \n\n
	it('joins multiple assistant output_text blocks with \\n\\n', () => {
		const input = enc.encode(
			'{"timestamp":"t1","type":"session_meta","payload":{"id":"s1"}}\n' +
				'{"timestamp":"t2","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"first line"},{"type":"output_text","text":"second line"}]}}\n',
		);
		const out = new TextDecoder().decode(compactCodex(input, codexOpts));
		expect(out).toBe(
			'{"v":1,"agent":"codex","cli_version":"0.5.1","type":"assistant","ts":"t2","content":[{"text":"first line\\n\\nsecond line","type":"text"}]}\n',
		);
	});

	// Story 补充 (defensive branches — coverage)
	it('skips empty user text (all blocks system content)', () => {
		const input = enc.encode(
			'{"timestamp":"t1","type":"session_meta","payload":{"id":"s1"}}\n' +
				'{"timestamp":"t2","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>x</environment_context>"}]}}\n',
		);
		// All content is system-injected; user line skipped (empty text)
		expect(compactCodex(input, codexOpts).length).toBe(0);
	});

	it('skips empty assistant text (all output_text empty/missing)', () => {
		const input = enc.encode(
			'{"timestamp":"t1","type":"session_meta","payload":{"id":"s1"}}\n' +
				'{"timestamp":"t2","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":""}]}}\n',
		);
		expect(compactCodex(input, codexOpts).length).toBe(0);
	});

	it('codexUserText: non-array content → "" (skipped)', () => {
		const input = enc.encode(
			'{"timestamp":"t1","type":"session_meta","payload":{"id":"s1"}}\n' +
				'{"timestamp":"t2","type":"response_item","payload":{"type":"message","role":"user","content":"not-an-array"}}\n',
		);
		expect(compactCodex(input, codexOpts).length).toBe(0);
	});

	it('codexAssistantText: non-array content → "" (skipped)', () => {
		const input = enc.encode(
			'{"timestamp":"t1","type":"session_meta","payload":{"id":"s1"}}\n' +
				'{"timestamp":"t2","type":"response_item","payload":{"type":"message","role":"assistant","content":"not-an-array"}}\n',
		);
		expect(compactCodex(input, codexOpts).length).toBe(0);
	});

	it('codexUserText: skips block when type !== input_text or block is null', () => {
		const input = enc.encode(
			'{"timestamp":"t1","type":"session_meta","payload":{"id":"s1"}}\n' +
				'{"timestamp":"t2","type":"response_item","payload":{"type":"message","role":"user","content":[null,{"type":"image","data":"..."},{"type":"input_text","text":"valid"}]}}\n',
		);
		const out = new TextDecoder().decode(compactCodex(input, codexOpts));
		expect(out).toContain('valid');
	});

	it('orphan function_call_output (no preceding call) → skip', () => {
		const input = enc.encode(
			'{"timestamp":"t1","type":"session_meta","payload":{"id":"s1"}}\n' +
				'{"timestamp":"t2","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hi"}]}}\n' +
				'{"timestamp":"t3","type":"response_item","payload":{"type":"function_call_output","call_id":"orphan","output":"ignored"}}\n' +
				'{"timestamp":"t4","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"reply"}]}}\n',
		);
		const out = new TextDecoder().decode(compactCodex(input, codexOpts));
		// orphan output skipped; assistant + user lines emitted
		expect(out).toContain('"text":"hi"');
		expect(out).toContain('"text":"reply"');
		expect(out).not.toContain('orphan');
	});

	it('codexCustomToolUseBlock: no input field → block omits input', () => {
		const input = enc.encode(
			'{"timestamp":"t1","type":"session_meta","payload":{"id":"s1"}}\n' +
				'{"timestamp":"t2","type":"response_item","payload":{"type":"custom_tool_call","name":"shell","call_id":"c1"}}\n',
		);
		const out = new TextDecoder().decode(compactCodex(input, codexOpts));
		// tool_use block has name + id + type but no input field
		expect(out).toContain('"name":"shell"');
		expect(out).toContain('"id":"c1"');
		expect(out).not.toContain('"input"');
	});

	it('codexToolUseBlock: invalid arguments JSON → input field omitted', () => {
		const input = enc.encode(
			'{"timestamp":"t1","type":"session_meta","payload":{"id":"s1"}}\n' +
				'{"timestamp":"t2","type":"response_item","payload":{"type":"function_call","name":"shell","call_id":"c1","arguments":"not-json"}}\n',
		);
		const out = new TextDecoder().decode(compactCodex(input, codexOpts));
		expect(out).toContain('"name":"shell"');
		expect(out).not.toContain('"input"');
	});

	it('codexCustomOutputText: numeric output → "" (default branch)', () => {
		const input = enc.encode(
			'{"timestamp":"t1","type":"session_meta","payload":{"id":"s1"}}\n' +
				'{"timestamp":"t2","type":"response_item","payload":{"type":"custom_tool_call","name":"x","call_id":"c1","input":"i"}}\n' +
				'{"timestamp":"t3","type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"c1","output":42}}\n',
		);
		const out = new TextDecoder().decode(compactCodex(input, codexOpts));
		// non-string non-object output → '' result
		expect(out).toContain('"output":""');
	});

	it('codexCustomOutputText: string output → plain pass-through (forward-compat)', () => {
		const input = enc.encode(
			'{"timestamp":"t1","type":"session_meta","payload":{"id":"s1"}}\n' +
				'{"timestamp":"t2","type":"response_item","payload":{"type":"custom_tool_call","name":"x","call_id":"c1","input":"i"}}\n' +
				'{"timestamp":"t3","type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"c1","output":"plain string"}}\n',
		);
		const out = new TextDecoder().decode(compactCodex(input, codexOpts));
		expect(out).toContain('"output":"plain string"');
	});

	it('tool_call without preceding assistant + no output → tb emitted as standalone', () => {
		const input = enc.encode(
			'{"timestamp":"t1","type":"session_meta","payload":{"id":"s1"}}\n' +
				'{"timestamp":"t2","type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"{}","call_id":"c1"}}\n',
		);
		const out = new TextDecoder().decode(compactCodex(input, codexOpts));
		// standalone, no output match → tb without result
		expect(out).toContain('"name":"shell"');
		expect(out).not.toContain('"result"');
	});

	// codexUserText: stripIDEContextTags reduces text to '' → that block also skipped
	it('codexUserText skips block when stripIDEContextTags reduces to empty', () => {
		const input = enc.encode(
			'{"timestamp":"t1","type":"session_meta","payload":{"id":"s1"}}\n' +
				'{"timestamp":"t2","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<ide_context>only-context</ide_context>"},{"type":"input_text","text":"actual"}]}}\n',
		);
		const out = new TextDecoder().decode(compactCodex(input, codexOpts));
		expect(out).toContain('actual');
		expect(out).not.toContain('only-context');
	});

	// codexAssistantText: skips block when text empty (covers blockRaw.text === '' branch)
	it('codexAssistantText skips empty-text output blocks but keeps non-empty', () => {
		const input = enc.encode(
			'{"timestamp":"t1","type":"session_meta","payload":{"id":"s1"}}\n' +
				'{"timestamp":"t2","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":""},{"type":"output_text","text":"kept"}]}}\n',
		);
		const out = new TextDecoder().decode(compactCodex(input, codexOpts));
		expect(out).toContain('kept');
	});

	// token_count BEFORE assistant message → carries to next assistant
	it('token_count before assistant carries via pendingInTok/pendingOutTok', () => {
		const input = enc.encode(
			'{"timestamp":"t1","type":"session_meta","payload":{"id":"s1"}}\n' +
				'{"timestamp":"t2","type":"event_msg","payload":{"type":"token_count","input_tokens":99,"output_tokens":11}}\n' +
				'{"timestamp":"t3","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"reply"}]}}\n',
		);
		const out = new TextDecoder().decode(compactCodex(input, codexOpts));
		expect(out).toContain('"input_tokens":99');
		expect(out).toContain('"output_tokens":11');
	});

	// codexCustomToolUseBlock: empty call_id → block omits id
	it('tool_use block omits id when call_id is empty', () => {
		const input = enc.encode(
			'{"timestamp":"t1","type":"session_meta","payload":{"id":"s1"}}\n' +
				'{"timestamp":"t2","type":"response_item","payload":{"type":"function_call","name":"x","arguments":"{}"}}\n',
		);
		const out = new TextDecoder().decode(compactCodex(input, codexOpts));
		expect(out).not.toContain('"id"');
		expect(out).toContain('"name":"x"');
	});

	// Standalone tool_call followed by token_count (consumed via codexConsumeToolCall trailing scan)
	it('standalone tool_call consumes trailing token_count into output line', () => {
		const input = enc.encode(
			'{"timestamp":"t1","type":"session_meta","payload":{"id":"s1"}}\n' +
				'{"timestamp":"t2","type":"response_item","payload":{"type":"function_call","name":"x","arguments":"{}","call_id":"c1"}}\n' +
				'{"timestamp":"t3","type":"event_msg","payload":{"type":"token_count","input_tokens":7,"output_tokens":3}}\n',
		);
		const out = new TextDecoder().decode(compactCodex(input, codexOpts));
		expect(out).toContain('"input_tokens":7');
		expect(out).toContain('"output_tokens":3');
	});

	// codexToolOutputText for function_call_output with non-string output → ''
	it('function_call_output with non-string output → empty result', () => {
		const input = enc.encode(
			'{"timestamp":"t1","type":"session_meta","payload":{"id":"s1"}}\n' +
				'{"timestamp":"t2","type":"response_item","payload":{"type":"function_call","name":"x","arguments":"{}","call_id":"c1"}}\n' +
				'{"timestamp":"t3","type":"response_item","payload":{"type":"function_call_output","call_id":"c1","output":42}}\n',
		);
		const out = new TextDecoder().decode(compactCodex(input, codexOpts));
		expect(out).toContain('"output":""');
	});

	// codexCustomOutputText: object output without text field → ''
	it('custom_tool_call_output object without text → empty', () => {
		const input = enc.encode(
			'{"timestamp":"t1","type":"session_meta","payload":{"id":"s1"}}\n' +
				'{"timestamp":"t2","type":"response_item","payload":{"type":"custom_tool_call","name":"x","input":"i","call_id":"c1"}}\n' +
				'{"timestamp":"t3","type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"c1","output":{"other":"data"}}}\n',
		);
		const out = new TextDecoder().decode(compactCodex(input, codexOpts));
		expect(out).toContain('"output":""');
	});

	// Last line without trailing newline (covers iterateLines trailing-content branch)
	it('handles content without trailing newline', () => {
		const input = enc.encode(
			'{"timestamp":"t1","type":"session_meta","payload":{"id":"s1"}}\n' +
				'{"timestamp":"t2","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"final"}]}}', // NO trailing \n
		);
		const out = new TextDecoder().decode(compactCodex(input, codexOpts));
		expect(out).toContain('final');
	});

	// trimSpaceLine: line with leading/trailing whitespace
	it('trims whitespace around lines + skips empty-after-trim', () => {
		const input = enc.encode(
			'   \t  \n' + // pure whitespace line — skip
				'{"timestamp":"t1","type":"session_meta","payload":{"id":"s1"}}\n' +
				'  {"timestamp":"t2","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"trimmed"}]}}  \n',
		);
		const out = new TextDecoder().decode(compactCodex(input, codexOpts));
		expect(out).toContain('trimmed');
	});

	// Failure: invalid JSON inside parseCodexLines is silently skipped
	it('parseCodexLines silently skips invalid JSON lines', () => {
		const input = enc.encode(
			'{"timestamp":"t1","type":"session_meta","payload":{"id":"s1"}}\n' +
				'not-valid-json\n' +
				'{"timestamp":"t2","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"survived"}]}}\n',
		);
		const out = new TextDecoder().decode(compactCodex(input, codexOpts));
		expect(out).toContain('survived');
	});

	// Go: codex_test.go:113-128 mixed function + custom calls
	it('handles mixed function_call + custom_tool_call after same assistant', () => {
		const input = enc.encode(
			'{"timestamp":"t1","type":"session_meta","payload":{"id":"s1"}}\n' +
				'{"timestamp":"t2","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Running then patching."}]}}\n' +
				'{"timestamp":"t3","type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\\"cmd\\":\\"ls\\"}","call_id":"call_1"}}\n' +
				'{"timestamp":"t4","type":"response_item","payload":{"type":"function_call_output","call_id":"call_1","output":"file.txt"}}\n' +
				'{"timestamp":"t5","type":"response_item","payload":{"type":"custom_tool_call","status":"completed","call_id":"call_2","name":"apply_patch","input":"patch data"}}\n' +
				'{"timestamp":"t6","type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"call_2","output":{"type":"text","text":"ok"}}}\n',
		);
		const out = new TextDecoder().decode(compactCodex(input, codexOpts));
		expect(out).toContain('"call_1"');
		expect(out).toContain('"call_2"');
		expect(out).toContain('"name":"exec_command"');
		expect(out).toContain('"name":"apply_patch"');
	});
});
