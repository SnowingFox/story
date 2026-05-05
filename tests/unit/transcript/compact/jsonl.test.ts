import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compactJSONL } from '@/transcript/compact/jsonl';
import type { CompactMetadataFields } from '@/transcript/compact/types';

const enc = new TextEncoder();
const dec = new TextDecoder();

const defaultOpts: CompactMetadataFields = {
	agent: 'claude-code',
	cliVersion: '0.5.1',
	startLine: 0,
};

const cursorOpts: CompactMetadataFields = {
	agent: 'cursor',
	cliVersion: '0.5.1',
	startLine: 0,
};

/**
 * Mirrors Go `assertJSONLines` (compact_test.go:606-634): split actual into
 * non-empty lines, deep-equal each parsed line against the expected JSON
 * string. Key order doesn't matter.
 */
function assertJSONLines(actual: Uint8Array, expected: string[]): void {
	const actualLines = dec
		.decode(actual)
		.split('\n')
		.filter((l) => l.trim() !== '');

	if (expected.length === 0 && actualLines.length === 0) {
		return;
	}

	expect(actualLines.length).toBe(expected.length);
	for (let i = 0; i < expected.length; i++) {
		const got = JSON.parse(actualLines[i]!);
		const want = JSON.parse(expected[i]!);
		expect(got).toEqual(want);
	}
}

describe('compactJSONL — basic + field handling', () => {
	// Go: compact_test.go:29 TestCompact_SimpleConversation
	// Go: compact.go:236 emitAssistant / 247 emitUser
	it('emits user line for simple conversation', () => {
		const input = enc.encode(
			`{"type":"user","uuid":"u1","timestamp":"2026-01-01T00:00:00Z","parentUuid":"","cwd":"/repo","message":{"content":"hello"}}\n` +
				`{"type":"assistant","timestamp":"2026-01-01T00:00:01Z","requestId":"req-1","message":{"id":"msg-1","content":[{"type":"text","text":"Hi!"}],"usage":{"input_tokens":100,"output_tokens":50}}}\n`,
		);

		const expected = [
			`{"v":1,"agent":"claude-code","cli_version":"0.5.1","type":"user","ts":"2026-01-01T00:00:00Z","content":[{"text":"hello"}]}`,
			`{"v":1,"agent":"claude-code","cli_version":"0.5.1","type":"assistant","ts":"2026-01-01T00:00:01Z","id":"msg-1","input_tokens":100,"output_tokens":50,"content":[{"type":"text","text":"Hi!"}]}`,
		];

		assertJSONLines(compactJSONL(input, defaultOpts), expected);
	});

	// Go: compact_test.go:48 TestCompact_AssistantStripping
	// Go: compact.go:623-660 stripAssistantContent
	it('strips thinking/redacted_thinking blocks from assistant', () => {
		const input = enc.encode(
			`{"type":"assistant","timestamp":"2026-01-01T00:00:01Z","requestId":"req-1","message":{"id":"msg-1","content":[{"type":"thinking","thinking":"hmm..."},{"type":"redacted_thinking","data":"secret"},{"type":"text","text":"Here's my answer."},{"type":"tool_use","id":"tu-1","name":"Bash","input":{"command":"ls"},"caller":"internal"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"abc"}}]}}\n`,
		);

		const expected = [
			`{"v":1,"agent":"claude-code","cli_version":"0.5.1","type":"assistant","ts":"2026-01-01T00:00:01Z","id":"msg-1","content":[{"type":"text","text":"Here's my answer."},{"type":"tool_use","id":"tu-1","name":"Bash","input":{"command":"ls"}},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"abc"}}]}`,
		];

		assertJSONLines(compactJSONL(input, defaultOpts), expected);
	});

	// Go: compact_test.go:65 TestCompact_AssistantThinkingOnly
	// Go: compact.go:215-216 isEmptyContentArray short-circuit
	it('drops assistant entry with only thinking content', () => {
		const input = enc.encode(
			`{"type":"assistant","timestamp":"2026-01-01T00:00:01Z","requestId":"req-1","message":{"id":"msg-1","content":[{"type":"thinking","thinking":"hmm..."}]}}\n`,
		);

		assertJSONLines(compactJSONL(input, defaultOpts), []);
	});

	// Go: compact_test.go:141 TestCompact_AssistantStringContent
	// Go: compact.go:625-627 stripAssistantContent string passthrough
	it('passes through assistant string content unchanged', () => {
		const input = enc.encode(
			`{"type":"assistant","timestamp":"t1","requestId":"r1","message":{"id":"m1","content":"just a string"}}\n`,
		);

		const expected = [
			`{"v":1,"agent":"claude-code","cli_version":"0.5.1","type":"assistant","ts":"t1","id":"m1","content":"just a string"}`,
		];

		assertJSONLines(compactJSONL(input, defaultOpts), expected);
	});

	// Go: compact_test.go:158 TestCompact_HumanTypeAlias
	// Go: compact.go:127-130 userAliases
	it("accepts type:'human' as user alias", () => {
		const input = enc.encode(
			`{"type":"human","timestamp":"2026-01-01T00:00:00Z","message":{"content":"hello human"}}\n` +
				`{"type":"assistant","timestamp":"2026-01-01T00:00:01Z","message":{"id":"m1","content":[{"type":"text","text":"Hi!"}]}}\n`,
		);

		const expected = [
			`{"v":1,"agent":"claude-code","cli_version":"0.5.1","type":"user","ts":"2026-01-01T00:00:00Z","content":[{"text":"hello human"}]}`,
			`{"v":1,"agent":"claude-code","cli_version":"0.5.1","type":"assistant","ts":"2026-01-01T00:00:01Z","id":"m1","content":[{"type":"text","text":"Hi!"}]}`,
		];

		assertJSONLines(compactJSONL(input, defaultOpts), expected);
	});

	// Go: compact_test.go:192 TestCompact_AssistantTokenUsage
	// Go: compact.go:450-463 extractUsageTokens
	it('writes input/output tokens from usage', () => {
		const input = enc.encode(
			`{"type":"user","uuid":"u1","timestamp":"t0","message":{"content":"hello"}}\n` +
				`{"type":"assistant","timestamp":"t1","requestId":"r1","message":{"id":"m1","content":[{"type":"text","text":"Hi!"}],"usage":{"input_tokens":200,"output_tokens":75}}}\n`,
		);

		const expected = [
			`{"v":1,"agent":"claude-code","cli_version":"0.5.1","type":"user","ts":"t0","content":[{"text":"hello"}]}`,
			`{"v":1,"agent":"claude-code","cli_version":"0.5.1","type":"assistant","ts":"t1","id":"m1","input_tokens":200,"output_tokens":75,"content":[{"type":"text","text":"Hi!"}]}`,
		];

		assertJSONLines(compactJSONL(input, defaultOpts), expected);
	});

	// Go: compact.go mergeAssistantEntries — fallback semantics when either
	// fragment's content is not a JSON array. Go's `json.Unmarshal` fails
	// silently, leaving the local block slice nil; the resulting merge is `[]`,
	// which gets dropped by `isEmptyContentArray` downstream. We lock that
	// behaviour so a future regression that preserves a string a.content can't
	// slip through.
	it('mergeAssistantEntries: non-array fragment content treated as empty for concat', () => {
		// Fragment a: string content (rare malformed input). Fragment b: array
		// with one block, same message id. Expected merge: only b's blocks
		// survive — they are emitted to the output.
		const input = enc.encode(
			`{"type":"assistant","timestamp":"t1","requestId":"r1","message":{"id":"m1","content":"a-string"}}\n` +
				`{"type":"assistant","timestamp":"t2","requestId":"r1","message":{"id":"m1","content":[{"type":"text","text":"b-block"}]}}\n`,
		);

		const result = compactJSONL(input, defaultOpts);
		const lines = dec
			.decode(result)
			.split('\n')
			.filter((l) => l.trim() !== '');
		expect(lines).toHaveLength(1);
		const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
		expect(parsed.id).toBe('m1');
		expect(parsed.ts).toBe('t2');
		expect(parsed.content).toEqual([{ type: 'text', text: 'b-block' }]);
	});

	// Go: compact_test.go:211 TestCompact_StreamingFragmentTokenMerge
	// Go: compact.go:369-388 mergeAssistantEntries
	it('takes later token counts during streaming merge', () => {
		const input = enc.encode(
			`{"type":"assistant","timestamp":"t1","requestId":"r1","message":{"id":"m1","content":[{"type":"thinking","thinking":"hmm"}],"usage":{"input_tokens":100,"output_tokens":5}}}\n` +
				`{"type":"assistant","timestamp":"t2","requestId":"r1","message":{"id":"m1","content":[{"type":"text","text":"done"}],"usage":{"input_tokens":100,"output_tokens":42}}}\n`,
		);

		const expected = [
			`{"v":1,"agent":"claude-code","cli_version":"0.5.1","type":"assistant","ts":"t2","id":"m1","input_tokens":100,"output_tokens":42,"content":[{"type":"text","text":"done"}]}`,
		];

		assertJSONLines(compactJSONL(input, defaultOpts), expected);
	});

	// Go: compact_test.go:230 TestCompact_NoUsageOmitsTokenFields
	// Go: compact.go:241-242 omitempty for input_tokens/output_tokens
	it('omits token fields when usage absent', () => {
		const input = enc.encode(
			`{"type":"assistant","timestamp":"t1","requestId":"r1","message":{"id":"m1","content":[{"type":"text","text":"Hi!"}]}}\n`,
		);

		const result = compactJSONL(input, defaultOpts);
		const lines = dec
			.decode(result)
			.split('\n')
			.filter((l) => l.trim() !== '');
		expect(lines).toHaveLength(1);
		const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
		expect(parsed.input_tokens).toBeUndefined();
		expect(parsed.output_tokens).toBeUndefined();
		expect(parsed.id).toBe('m1');
	});

	// Go: compact_test.go:404 TestCompact_FieldOrder
	// Go: compact.go:27-37 transcriptLine struct field order
	it('produces deterministic field order (v/agent/cli_version/type/ts/content)', () => {
		const input = enc.encode(
			`{"type":"user","uuid":"u1","timestamp":"2026-01-01T00:00:00Z","message":{"content":"hello"}}\n`,
		);

		const result = compactJSONL(input, defaultOpts);
		const expected = `{"v":1,"agent":"claude-code","cli_version":"0.5.1","type":"user","ts":"2026-01-01T00:00:00Z","content":[{"text":"hello"}]}\n`;
		expect(dec.decode(result)).toBe(expected);
	});

	// TS additional defensive: trailing newline + each line independently parseable
	// Go: compact.go:281 appendLine appends '\n'
	it('appends \\n after each output line', () => {
		const input = enc.encode(
			`{"type":"user","timestamp":"t1","message":{"content":"a"}}\n` +
				`{"type":"user","timestamp":"t2","message":{"content":"b"}}\n`,
		);

		const result = dec.decode(compactJSONL(input, defaultOpts));
		expect(result.endsWith('\n')).toBe(true);
		const lines = result.split('\n').filter((l) => l !== '');
		expect(lines).toHaveLength(2);
		for (const line of lines) {
			expect(() => JSON.parse(line)).not.toThrow();
		}
	});
});

describe('compactJSONL — tool_use inlining + rich metadata', () => {
	// Go: compact_test.go:80 TestCompact_UserWithToolResult
	// Go: compact.go:392-422 inlineToolResults / 498-542 enrichToolResults
	it('inlines tool_result into preceding tool_use (with file metadata)', () => {
		const input = enc.encode(
			`{"type":"assistant","timestamp":"2026-01-01T00:00:59Z","requestId":"req-1","message":{"id":"msg-1","content":[{"type":"tool_use","id":"tu-1","name":"Bash","input":{"command":"ls"}}]}}\n` +
				`{"type":"user","uuid":"u2","timestamp":"2026-01-01T00:01:00Z","parentUuid":"u1","cwd":"/repo","sessionId":"sess-1","message":{"content":[{"type":"tool_result","tool_use_id":"tu-1","content":"file1.txt\\nfile2.txt"},{"type":"text","text":"now fix the bug"}]},"toolUseResult":{"type":"text","file":{"filePath":"/repo/file1.txt","numLines":10},"output":"file1.txt\\nfile2.txt","matchCount":2}}\n`,
		);

		const expected = [
			`{"v":1,"agent":"claude-code","cli_version":"0.5.1","type":"assistant","ts":"2026-01-01T00:00:59Z","id":"msg-1","content":[{"type":"tool_use","id":"tu-1","name":"Bash","input":{"command":"ls"},"result":{"output":"file1.txt\\nfile2.txt","status":"success","file":{"filePath":"/repo/file1.txt","numLines":10}}}]}`,
			`{"v":1,"agent":"claude-code","cli_version":"0.5.1","type":"user","ts":"2026-01-01T00:01:00Z","content":[{"text":"now fix the bug"}]}`,
		];

		assertJSONLines(compactJSONL(input, defaultOpts), expected);
	});

	// Go: compact_test.go:102 TestCompact_UserWithMultipleToolResults
	// Go: compact.go:392-422 inlineToolResults handles multiple results
	it('handles multiple tool_results in single user entry', () => {
		const input = enc.encode(
			`{"type":"assistant","timestamp":"2026-01-01T00:00:59Z","requestId":"req-1","message":{"id":"msg-1","content":[{"type":"tool_use","id":"tu-1","name":"ReadFile","input":{"path":"a.txt"}},{"type":"tool_use","id":"tu-2","name":"ReadFile","input":{"path":"b.txt"}}]}}\n` +
				`{"type":"user","uuid":"u2","timestamp":"2026-01-01T00:01:00Z","message":{"content":[{"type":"tool_result","tool_use_id":"tu-1","content":"A"},{"type":"tool_result","tool_use_id":"tu-2","content":"B"},{"type":"text","text":"continue"}]}}\n`,
		);

		const expected = [
			`{"v":1,"agent":"claude-code","cli_version":"0.5.1","type":"assistant","ts":"2026-01-01T00:00:59Z","id":"msg-1","content":[{"type":"tool_use","id":"tu-1","name":"ReadFile","input":{"path":"a.txt"},"result":{"output":"A","status":"success"}},{"type":"tool_use","id":"tu-2","name":"ReadFile","input":{"path":"b.txt"},"result":{"output":"B","status":"success"}}]}`,
			`{"v":1,"agent":"claude-code","cli_version":"0.5.1","type":"user","ts":"2026-01-01T00:01:00Z","content":[{"text":"continue"}]}`,
		];

		assertJSONLines(compactJSONL(input, defaultOpts), expected);
	});

	// Go: compact_test.go:121 TestCompact_UserNoText
	// Go: compact.go:226-227 user purely tool_results skipped after consume
	it('drops user line when only tool_result (no text)', () => {
		const input = enc.encode(
			`{"type":"assistant","timestamp":"t0","requestId":"req-1","message":{"id":"msg-1","content":[{"type":"tool_use","id":"tu-1","name":"Bash","input":{"command":"echo done"}}]}}\n` +
				`{"type":"user","uuid":"u1","timestamp":"t1","message":{"content":[{"type":"tool_result","tool_use_id":"tu-1","content":"done"}]},"toolUseResult":{"stdout":"done","stderr":""}}\n`,
		);

		const expected = [
			`{"v":1,"agent":"claude-code","cli_version":"0.5.1","type":"assistant","ts":"t0","id":"msg-1","content":[{"type":"tool_use","id":"tu-1","name":"Bash","input":{"command":"echo done"},"result":{"output":"done","status":"success"}}]}`,
		];

		assertJSONLines(compactJSONL(input, defaultOpts), expected);
	});

	// Go: compact_test.go:250 TestCompact_ReadToolResult_PreservesFileMetadata
	// Go: compact.go:511-521 enrichToolResults file branch
	it('preserves Read tool file metadata { filePath, numLines } in result.file', () => {
		const input = enc.encode(
			`{"type":"assistant","timestamp":"t0","requestId":"req-1","message":{"id":"msg-1","content":[{"type":"tool_use","id":"tu-1","name":"Read","input":{"file_path":"/repo/main.go"}}]}}\n` +
				`{"type":"user","uuid":"u1","timestamp":"t1","message":{"content":[{"type":"tool_result","tool_use_id":"tu-1","content":"package main\\nfunc main() {}"}]},"toolUseResult":{"type":"text","file":{"filePath":"/repo/main.go","numLines":2,"startLine":1,"totalLines":2,"content":"package main\\nfunc main() {}"}}}\n`,
		);

		const expected = [
			`{"v":1,"agent":"claude-code","cli_version":"0.5.1","type":"assistant","ts":"t0","id":"msg-1","content":[{"type":"tool_use","id":"tu-1","name":"Read","input":{"file_path":"/repo/main.go"},"result":{"output":"package main\\nfunc main() {}","status":"success","file":{"filePath":"/repo/main.go","numLines":2}}}]}`,
		];

		assertJSONLines(compactJSONL(input, defaultOpts), expected);
	});

	// Go: compact_test.go:268 TestCompact_GrepToolResult_PreservesMatchCount
	// Go: compact.go:531-539 enrichToolResults numFiles branch
	it('preserves Grep tool matchCount as result.matchCount', () => {
		const input = enc.encode(
			`{"type":"assistant","timestamp":"t0","requestId":"req-1","message":{"id":"msg-1","content":[{"type":"tool_use","id":"tu-1","name":"Grep","input":{"pattern":"TODO"}}]}}\n` +
				`{"type":"user","uuid":"u1","timestamp":"t1","message":{"content":[{"type":"tool_result","tool_use_id":"tu-1","content":"Found 5 files\\na.go\\nb.go"}]},"toolUseResult":{"content":"Found 5 files\\na.go\\nb.go","numFiles":5,"numLines":10,"filenames":["a.go","b.go"],"mode":"files_with_matches"}}\n`,
		);

		const expected = [
			`{"v":1,"agent":"claude-code","cli_version":"0.5.1","type":"assistant","ts":"t0","id":"msg-1","content":[{"type":"tool_use","id":"tu-1","name":"Grep","input":{"pattern":"TODO"},"result":{"output":"Found 5 files\\na.go\\nb.go","status":"success","matchCount":5}}]}`,
		];

		assertJSONLines(compactJSONL(input, defaultOpts), expected);
	});

	// Go: compact_test.go:286 TestCompact_EditToolResult_PreservesFilePath
	// Go: compact.go:524-529 enrichToolResults Edit-style filePath branch
	it('preserves Edit tool filePath only (no numLines)', () => {
		const input = enc.encode(
			`{"type":"assistant","timestamp":"t0","requestId":"req-1","message":{"id":"msg-1","content":[{"type":"tool_use","id":"tu-1","name":"Edit","input":{"file_path":"/repo/main.go","old_string":"bad","new_string":"good"}}]}}\n` +
				`{"type":"user","uuid":"u1","timestamp":"t1","message":{"content":[{"type":"tool_result","tool_use_id":"tu-1","content":""}]},"toolUseResult":{"filePath":"/repo/main.go","oldString":"bad","newString":"good","structuredPatch":"@@ -1 +1 @@\\n-bad\\n+good"}}\n`,
		);

		const expected = [
			`{"v":1,"agent":"claude-code","cli_version":"0.5.1","type":"assistant","ts":"t0","id":"msg-1","content":[{"type":"tool_use","id":"tu-1","name":"Edit","input":{"file_path":"/repo/main.go","old_string":"bad","new_string":"good"},"result":{"output":"","status":"success","file":{"filePath":"/repo/main.go"}}}]}`,
		];

		assertJSONLines(compactJSONL(input, defaultOpts), expected);
	});
});

describe('compactJSONL — user content + image', () => {
	const tinyPNG =
		'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

	// Go: compact_test.go:306 TestCompact_UserWithImages
	// Go: compact.go:247-272 emitUser with userImages
	it('emits image blocks verbatim from user content', () => {
		const input = enc.encode(
			`{"type":"user","promptId":"p1","timestamp":"t1","message":{"content":[{"type":"text","text":"the footer should still show"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"${tinyPNG}"}},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"${tinyPNG}"}}]}}\n` +
				`{"type":"assistant","timestamp":"t2","requestId":"r1","message":{"id":"m1","content":[{"type":"text","text":"I see the screenshots."}]}}\n`,
		);

		const expected = [
			`{"v":1,"agent":"claude-code","cli_version":"0.5.1","type":"user","ts":"t1","content":[{"id":"p1","text":"the footer should still show"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"${tinyPNG}"}},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"${tinyPNG}"}}]}`,
			`{"v":1,"agent":"claude-code","cli_version":"0.5.1","type":"assistant","ts":"t2","id":"m1","content":[{"type":"text","text":"I see the screenshots."}]}`,
		];

		assertJSONLines(compactJSONL(input, defaultOpts), expected);
	});

	// Go: compact_test.go:327 TestCompact_UserWithImageOnly
	// Go: compact.go:251 emitUser only-image guard (skip text block)
	it('emits user line with only image (no text block)', () => {
		const input = enc.encode(
			`{"type":"user","timestamp":"t1","message":{"content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"${tinyPNG}"}}]}}\n`,
		);

		const expected = [
			`{"v":1,"agent":"claude-code","cli_version":"0.5.1","type":"user","ts":"t1","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"${tinyPNG}"}}]}`,
		];

		assertJSONLines(compactJSONL(input, defaultOpts), expected);
	});

	// Go: compact.go:252 userTextBlock ID field (promptId)
	// TS additional reinforcement: explicit assertion on text block id field
	it('preserves promptId on user text block when present', () => {
		const input = enc.encode(
			`{"type":"user","promptId":"prompt-xyz","timestamp":"t1","message":{"content":"plain text"}}\n`,
		);

		const expected = [
			`{"v":1,"agent":"claude-code","cli_version":"0.5.1","type":"user","ts":"t1","content":[{"id":"prompt-xyz","text":"plain text"}]}`,
		];

		assertJSONLines(compactJSONL(input, defaultOpts), expected);
	});
});

describe('compactJSONL — fixture round-trip', () => {
	// Go: compact_test.go:178 TestCompact_ClaudeFixture (testdata/claude_full)
	// Go: compact.go:81-115 Compact (full pipeline) — but compactJSONL is the body
	it('roundtrips testdata/claude_full.jsonl fixture', () => {
		const input = readFileSync(join(__dirname, 'testdata', 'claude_full.jsonl'));
		const expected = readFileSync(join(__dirname, 'testdata', 'claude_expected.jsonl'), 'utf8')
			.split('\n')
			.filter((l) => l.trim() !== '');

		assertJSONLines(compactJSONL(input, defaultOpts), expected);
	});

	// Go: compact_test.go:184 TestCompact_ClaudeFixture2
	it('roundtrips testdata/claude_full2.jsonl fixture', () => {
		const input = readFileSync(join(__dirname, 'testdata', 'claude_full2.jsonl'));
		const expected = readFileSync(join(__dirname, 'testdata', 'claude_expected2.jsonl'), 'utf8')
			.split('\n')
			.filter((l) => l.trim() !== '');

		assertJSONLines(compactJSONL(input, defaultOpts), expected);
	});

	// Inline fixtureFullJSONL — Go: compact_test.go:349-357
	// Go: compact_test.go:379 TestCompact_FullFixture_NoTruncation
	const fixtureFullJSONL = `${[
		`{"type":"user","uuid":"u1","timestamp":"2026-01-01T00:00:00Z","parentUuid":"","cwd":"/repo","sessionId":"sess-1","version":"1","gitBranch":"main","message":{"content":"hello"}}`,
		`{"type":"assistant","timestamp":"2026-01-01T00:00:01Z","requestId":"req-1","message":{"id":"msg-1","content":[{"type":"thinking","thinking":"let me think..."},{"type":"text","text":"Hi there!"},{"type":"tool_use","id":"tu-1","name":"Bash","input":{"command":"ls"},"caller":"some-caller"}]}}`,
		`{"type":"progress","message":{"type":"bash","content":"running..."}}`,
		`{"type":"user","uuid":"u2","timestamp":"2026-01-01T00:01:00Z","parentUuid":"u1","cwd":"/repo","sessionId":"sess-1","version":"1","gitBranch":"main","message":{"content":[{"type":"tool_result","tool_use_id":"tu-1","content":"file1.txt\\nfile2.txt"},{"type":"text","text":"now fix the bug"}]},"toolUseResult":{"type":"text","file":{"filePath":"/repo/file1.txt","numLines":10},"output":"file1.txt\\nfile2.txt","matchCount":2}}`,
		`{"type":"assistant","timestamp":"2026-01-01T00:01:01Z","requestId":"req-2","message":{"id":"msg-2","content":[{"type":"thinking","thinking":"analyzing the bug..."},{"type":"redacted_thinking","data":"abc123"},{"type":"text","text":"I found the issue."},{"type":"tool_use","id":"tu-2","name":"Edit","input":{"file_path":"/repo/bug.go","old_string":"bad","new_string":"good"},"caller":"internal"}]}}`,
		`{"type":"file-history-snapshot","files":["/repo/bug.go"]}`,
		`{"type":"system","message":{"content":"system reminder"}}`,
	].join('\n')}\n`;

	it('processes inline fixtureFullJSONL without truncation', () => {
		const expected = [
			`{"v":1,"agent":"claude-code","cli_version":"0.5.1","type":"user","ts":"2026-01-01T00:00:00Z","content":[{"text":"hello"}]}`,
			`{"v":1,"agent":"claude-code","cli_version":"0.5.1","type":"assistant","ts":"2026-01-01T00:00:01Z","id":"msg-1","content":[{"type":"text","text":"Hi there!"},{"type":"tool_use","id":"tu-1","name":"Bash","input":{"command":"ls"},"result":{"output":"file1.txt\\nfile2.txt","status":"success","file":{"filePath":"/repo/file1.txt","numLines":10}}}]}`,
			`{"v":1,"agent":"claude-code","cli_version":"0.5.1","type":"user","ts":"2026-01-01T00:01:00Z","content":[{"text":"now fix the bug"}]}`,
			`{"v":1,"agent":"claude-code","cli_version":"0.5.1","type":"assistant","ts":"2026-01-01T00:01:01Z","id":"msg-2","content":[{"type":"text","text":"I found the issue."},{"type":"tool_use","id":"tu-2","name":"Edit","input":{"file_path":"/repo/bug.go","old_string":"bad","new_string":"good"}}]}`,
		];

		assertJSONLines(compactJSONL(enc.encode(fixtureFullJSONL), defaultOpts), expected);
	});

	// Go: compact_test.go:360 TestCompact_FullFixture_WithTruncation
	// Note: compactJSONL itself doesn't truncate; truncation happens in compact()
	// (index.ts) before compactJSONL is called. Here we simulate by passing the
	// post-sliceFromLine bytes to compactJSONL directly. startLine=3 in the Go
	// test means lines 0-2 are dropped, leaving lines 3-6.
	it('truncates inline fixtureFullJSONL from startLine offset', () => {
		// Lines 3-6 of fixtureFullJSONL (indices 3..6 inclusive in the original 7).
		const truncated = `${[
			`{"type":"user","uuid":"u2","timestamp":"2026-01-01T00:01:00Z","parentUuid":"u1","cwd":"/repo","sessionId":"sess-1","version":"1","gitBranch":"main","message":{"content":[{"type":"tool_result","tool_use_id":"tu-1","content":"file1.txt\\nfile2.txt"},{"type":"text","text":"now fix the bug"}]},"toolUseResult":{"type":"text","file":{"filePath":"/repo/file1.txt","numLines":10},"output":"file1.txt\\nfile2.txt","matchCount":2}}`,
			`{"type":"assistant","timestamp":"2026-01-01T00:01:01Z","requestId":"req-2","message":{"id":"msg-2","content":[{"type":"thinking","thinking":"analyzing the bug..."},{"type":"redacted_thinking","data":"abc123"},{"type":"text","text":"I found the issue."},{"type":"tool_use","id":"tu-2","name":"Edit","input":{"file_path":"/repo/bug.go","old_string":"bad","new_string":"good"},"caller":"internal"}]}}`,
			`{"type":"file-history-snapshot","files":["/repo/bug.go"]}`,
			`{"type":"system","message":{"content":"system reminder"}}`,
		].join('\n')}\n`;

		const expected = [
			`{"v":1,"agent":"claude-code","cli_version":"0.5.1","type":"user","ts":"2026-01-01T00:01:00Z","content":[{"text":"now fix the bug"}]}`,
			`{"v":1,"agent":"claude-code","cli_version":"0.5.1","type":"assistant","ts":"2026-01-01T00:01:01Z","id":"msg-2","content":[{"type":"text","text":"I found the issue."},{"type":"tool_use","id":"tu-2","name":"Edit","input":{"file_path":"/repo/bug.go","old_string":"bad","new_string":"good"}}]}`,
		];

		assertJSONLines(compactJSONL(enc.encode(truncated), defaultOpts), expected);
	});
});

describe('compactJSONL — Cursor / IDE strip / mixed format', () => {
	// Go: compact_test.go:423 TestCompact_CursorRoleOnly
	// Go: compact.go:127-130 userAliases (role:'user' alias)
	it('handles Cursor role:user / role:assistant via userAliases', () => {
		const input = enc.encode(
			`{"role":"user","timestamp":"t1","message":{"content":"hello from cursor"}}\n` +
				`{"role":"assistant","timestamp":"t2","message":{"content":[{"type":"text","text":"Hi from Cursor!"}]}}\n`,
		);

		const expected = [
			`{"v":1,"agent":"cursor","cli_version":"0.5.1","type":"user","ts":"t1","content":[{"text":"hello from cursor"}]}`,
			`{"v":1,"agent":"cursor","cli_version":"0.5.1","type":"assistant","ts":"t2","content":[{"type":"text","text":"Hi from Cursor!"}]}`,
		];

		assertJSONLines(compactJSONL(input, cursorOpts), expected);
	});

	// Go: compact_test.go:445 TestCompact_StripsIDEContextTags
	// Go: compact.go:578-580 extractUserContent string content branch
	it('strips IDE context tags from user string content', () => {
		const input = enc.encode(
			`{"role":"user","timestamp":"t1","message":{"content":"<user_query>\\nhello world\\n</user_query>"}}\n`,
		);

		const expected = [
			`{"v":1,"agent":"cursor","cli_version":"0.5.1","type":"user","ts":"t1","content":[{"text":"hello world"}]}`,
		];

		assertJSONLines(compactJSONL(input, cursorOpts), expected);
	});

	// Go: compact_test.go:465 TestCompact_StripsIDEContextTagsFromContentBlocks
	// Go: compact.go:611-619 extractUserContent text-block accumulate '\n\n' + trim
	it('strips IDE tags from text blocks in array content (multi block joined with \\n\\n)', () => {
		const input = enc.encode(
			`{"type":"user","timestamp":"t1","message":{"content":[{"type":"text","text":"<user_query>\\nfix the bug\\n</user_query>"},{"type":"text","text":"also this"}]}}\n`,
		);

		const expected = [
			`{"v":1,"agent":"claude-code","cli_version":"0.5.1","type":"user","ts":"t1","content":[{"text":"fix the bug\\n\\nalso this"}]}`,
		];

		assertJSONLines(compactJSONL(input, defaultOpts), expected);
	});

	// Go: compact_test.go:485 TestCompact_MixedFormats
	// Go: compact.go:135-151 normalizeKind type/role precedence
	it('handles mixed Claude type + Cursor role + human alias in same transcript', () => {
		const input = enc.encode(
			`{"type":"user","timestamp":"t1","message":{"content":"claude user"}}\n` +
				`{"type":"assistant","timestamp":"t2","message":{"id":"m1","content":[{"type":"text","text":"claude assistant"}]}}\n` +
				`{"role":"user","timestamp":"t3","message":{"content":"cursor user"}}\n` +
				`{"role":"assistant","timestamp":"t4","message":{"content":[{"type":"text","text":"cursor assistant"}]}}\n` +
				`{"type":"human","timestamp":"t5","message":{"content":"human alias"}}\n` +
				`{"type":"progress","message":{"content":"should be dropped"}}\n`,
		);

		const expected = [
			`{"v":1,"agent":"cursor","cli_version":"0.5.1","type":"user","ts":"t1","content":[{"text":"claude user"}]}`,
			`{"v":1,"agent":"cursor","cli_version":"0.5.1","type":"assistant","ts":"t2","id":"m1","content":[{"type":"text","text":"claude assistant"}]}`,
			`{"v":1,"agent":"cursor","cli_version":"0.5.1","type":"user","ts":"t3","content":[{"text":"cursor user"}]}`,
			`{"v":1,"agent":"cursor","cli_version":"0.5.1","type":"assistant","ts":"t4","content":[{"type":"text","text":"cursor assistant"}]}`,
			`{"v":1,"agent":"cursor","cli_version":"0.5.1","type":"user","ts":"t5","content":[{"text":"human alias"}]}`,
		];

		assertJSONLines(compactJSONL(input, cursorOpts), expected);
	});
});

describe('compactJSONL — defensive edge cases', () => {
	// Go: compact_test.go:538 TestCompact_MalformedLinesSkipped
	// Go: compact.go:312-316 parseLine returns false on JSON error
	it('skips malformed JSON lines (best-effort)', () => {
		const input = enc.encode(
			`{"type":"user","uuid":"u1","timestamp":"t1","message":{"content":"hello"}}\n` +
				`not valid json at all\n` +
				`{"type":"assistant","timestamp":"t2","requestId":"r1","message":{"id":"m1","content":"hi"}}\n`,
		);

		const expected = [
			`{"v":1,"agent":"claude-code","cli_version":"0.5.1","type":"user","ts":"t1","content":[{"text":"hello"}]}`,
			`{"v":1,"agent":"claude-code","cli_version":"0.5.1","type":"assistant","ts":"t2","id":"m1","content":"hi"}`,
		];

		assertJSONLines(compactJSONL(input, defaultOpts), expected);
	});

	// Go: compact_test.go:558 TestCompact_OnlyDroppedTypes
	// Go: compact.go:117-123 droppedTypes
	it('emits empty bytes for only-dropped-types', () => {
		const input = enc.encode(
			`{"type":"progress","message":{"content":"..."}}\n` +
				`{"type":"file-history-snapshot","files":[]}\n` +
				`{"type":"queue-operation","op":"enqueue"}\n` +
				`{"type":"system","message":{"content":"reminder"}}\n`,
		);

		const result = compactJSONL(input, defaultOpts);
		expect(result.length).toBe(0);
	});

	// Go: compact_test.go:524 TestCompact_StartLineBeyondEnd
	// Note: compactJSONL doesn't itself slice — caller (compact() in index.ts) does.
	// We test the equivalent: passing empty bytes returns empty bytes.
	it('emits empty bytes when input is empty (slice-beyond-end equivalent)', () => {
		const result = compactJSONL(new Uint8Array(), defaultOpts);
		expect(result.length).toBe(0);
	});

	// TS additional defensive
	it('emits empty bytes for unparseable lines only', () => {
		const input = enc.encode(`not json\n42\n[\n`);
		const result = compactJSONL(input, defaultOpts);
		expect(result.length).toBe(0);
	});
});
