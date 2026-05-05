/**
 * Tests for `src/agent/codex/transcript.ts` — Mirrors Go
 * `entire-cli/cmd/entire/cli/agent/codex/transcript.go` + `transcript_test.go`.
 *
 * Covers (26 case):
 * - parseSessionStartTime: 5 throw paths (empty / not session_meta / payload missing /
 *   timestamp empty / Date invalid) + 1 happy
 * - extractFilesFromLine: 4 invalid + 1 happy (apply_patch)
 * - extractFilesFromApplyPatch: 2 (regex parse + dedup; no files)
 * - getTranscriptPosition: 3 (happy / empty path → 0 / ENOENT → 0)
 * - extractModifiedFilesFromOffset: 4 (offset filter + currentPosition / ENOENT throws / physical line counting / EISDIR)
 * - calculateTokenUsage: 5 (cumulative delta / no baseline / no data / apiCalls /
 *   reasoning counted as output)
 * - extractPrompts: 3 (happy / offset filter / trim+skip empty)
 * - sanitizePortableTranscript: 2 (reasoning encrypted_content stripped + compaction dropped)
 *
 * Failure-path total: 9 (parseSessionStartTime 5 throws + extractFilesFromLine 4 invalid + extractModifiedFilesFromOffset ENOENT).
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	calculateTokenUsage,
	extractFilesFromApplyPatch,
	extractFilesFromLine,
	extractModifiedFilesFromOffset,
	extractPrompts,
	getTranscriptPosition,
	parseSessionStartTime,
	sanitizePortableTranscript,
} from '@/agent/codex/transcript';

const FIX = path.join(__dirname, '..', '..', '..', 'fixtures', 'codex');
const enc = new TextEncoder();

async function readFixture(name: string): Promise<Uint8Array> {
	const buf = await fs.readFile(path.join(FIX, name));
	return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

describe('agent/codex/transcript — Go: codex/transcript.go + transcript_test.go', () => {
	describe('parseSessionStartTime', () => {
		// Go: transcript.go:344-372 happy path
		it('parses RFC3339Nano timestamp from session_meta first line', async () => {
			const data = await readFixture('codex-rollout-basic.jsonl');
			const t = parseSessionStartTime(data);
			expect(t.toISOString()).toBe('2026-04-20T15:30:45.123Z');
		});

		// Go: transcript.go:347 ErrEmpty
		it('throws on empty data', () => {
			expect(() => parseSessionStartTime(new Uint8Array())).toThrow(/empty/);
		});

		// Go: transcript.go:355-357 first line not session_meta
		it('throws when first line is not session_meta', () => {
			const data = enc.encode('{"type":"response_item","payload":{}}\n');
			expect(() => parseSessionStartTime(data)).toThrow(/want session_meta/);
		});

		// Go: transcript.go:359-362 payload unmarshal error → first transcript line err
		it('throws on malformed first line JSON', () => {
			const data = enc.encode('not json at all\n');
			expect(() => parseSessionStartTime(data)).toThrow(/parse first transcript line/);
		});

		// Go: transcript.go:364-366 timestamp empty
		it('throws when session_meta.timestamp missing', () => {
			const data = enc.encode('{"type":"session_meta","payload":{"id":"x"}}\n');
			expect(() => parseSessionStartTime(data)).toThrow(/timestamp is empty/);
		});

		// Go: transcript.go:368-370 time.Parse RFC3339Nano error
		it('throws on unparseable timestamp', () => {
			const data = enc.encode(
				'{"type":"session_meta","payload":{"id":"x","timestamp":"not-iso"}}\n',
			);
			expect(() => parseSessionStartTime(data)).toThrow(/parse session_meta timestamp/);
		});
	});

	describe('extractFilesFromLine', () => {
		// Go: transcript.go:166-187 extractFilesFromLine
		it('extracts files from custom_tool_call apply_patch input', () => {
			const line = enc.encode(
				JSON.stringify({
					type: 'response_item',
					payload: {
						type: 'custom_tool_call',
						name: 'apply_patch',
						input:
							'*** Begin Patch\n*** Add File: src/foo.ts\n*** Update File: src/bar.ts\n*** End Patch',
					},
				}),
			);
			expect(extractFilesFromLine(line)).toEqual(['src/foo.ts', 'src/bar.ts']);
		});

		// Go: transcript.go:168-170 invalid JSON returns nil
		it('returns [] on invalid JSON line', () => {
			expect(extractFilesFromLine(enc.encode('not json'))).toEqual([]);
		});

		// Go: transcript.go:172-174 type !== response_item
		it('returns [] when type !== response_item', () => {
			const line = enc.encode('{"type":"session_meta","payload":{}}');
			expect(extractFilesFromLine(line)).toEqual([]);
		});

		// Go: transcript.go:176-179 payload unmarshal failure
		it('returns [] when payload.type is not custom_tool_call apply_patch', () => {
			const line = enc.encode(
				'{"type":"response_item","payload":{"type":"message","role":"user"}}',
			);
			expect(extractFilesFromLine(line)).toEqual([]);
		});

		// Go: transcript.go:181-184 name !== apply_patch
		it('returns [] when payload.name is not apply_patch', () => {
			const line = enc.encode(
				'{"type":"response_item","payload":{"type":"custom_tool_call","name":"shell","input":"*** Add File: x"}}',
			);
			expect(extractFilesFromLine(line)).toEqual([]);
		});
	});

	describe('extractFilesFromApplyPatch', () => {
		// Go: transcript.go:191-203 regex parse + dedupe
		it('parses Add/Update/Delete File and dedupes (preserve first-occurrence)', () => {
			const input =
				'*** Begin Patch\n' +
				'*** Add File: a.ts\n' +
				'*** Update File: b.ts\n' +
				'*** Delete File: c.ts\n' +
				'*** Add File: a.ts\n' + // dup
				'*** End Patch\n';
			expect(extractFilesFromApplyPatch(input)).toEqual(['a.ts', 'b.ts', 'c.ts']);
		});

		it('returns [] when input has no file directives', () => {
			expect(extractFilesFromApplyPatch('*** Begin Patch\nfoo\n*** End Patch')).toEqual([]);
		});

		// Story补充: non-ASCII path defense (testing-discipline §2 盲区 1)
		it('handles non-ASCII paths (Chinese / emoji)', async () => {
			const data = await readFixture('codex-non-ascii-path.jsonl');
			const lines = new TextDecoder()
				.decode(data)
				.split('\n')
				.filter((l) => l.trim());
			// line 2 has the apply_patch
			expect(lines[1]).toBeDefined();
			const files = extractFilesFromLine(enc.encode(lines[1]!));
			expect(files).toEqual(['src/app-中文.ts', 'src/emoji-🎉.ts']);
		});
	});

	describe('getTranscriptPosition', () => {
		let tmp: string;

		beforeEach(async () => {
			tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-pos-'));
		});
		afterEach(async () => {
			await fs.rm(tmp, { recursive: true, force: true });
		});

		// Go: transcript.go:91-117 happy path
		it('counts lines including final non-newline line', async () => {
			const p = path.join(tmp, 't.jsonl');
			await fs.writeFile(p, 'line1\nline2\nline3'); // no trailing newline
			expect(await getTranscriptPosition(p)).toBe(3);
		});

		// Go: transcript.go:92-94 empty path
		it('returns 0 on empty path (no fs read)', async () => {
			expect(await getTranscriptPosition('')).toBe(0);
		});

		// Go: transcript.go:97-100 ENOENT silent
		it('returns 0 on ENOENT', async () => {
			expect(await getTranscriptPosition(path.join(tmp, 'nonexistent.jsonl'))).toBe(0);
		});
	});

	describe('extractModifiedFilesFromOffset', () => {
		let tmp: string;

		beforeEach(async () => {
			tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-mod-'));
		});
		afterEach(async () => {
			await fs.rm(tmp, { recursive: true, force: true });
		});

		// Go: transcript.go:120-159 happy path + currentPosition is total
		it('returns dedup files + currentPosition === total lineNum', async () => {
			const p = path.join(tmp, 't.jsonl');
			const data = await readFixture('codex-rollout-with-apply-patch.jsonl');
			await fs.writeFile(p, data);
			const result = await extractModifiedFilesFromOffset(p, 0);
			expect(result.files).toEqual(['src/foo.ts', 'src/bar.ts', 'src/baz.ts']);
			expect(result.currentPosition).toBe(4); // 4 lines in fixture
		});

		// Go: transcript.go:139-150 offset filter
		it('skips lines <= startOffset (returns empty when offset > apply_patch line)', async () => {
			const p = path.join(tmp, 't.jsonl');
			const data = await readFixture('codex-rollout-with-apply-patch.jsonl');
			await fs.writeFile(p, data);
			const result = await extractModifiedFilesFromOffset(p, 10); // beyond all 4 lines
			expect(result.files).toEqual([]);
			expect(result.currentPosition).toBe(4);
		});

		// Go: transcript.go:119-121 — ENOENT is NOT silenced (unlike GetTranscriptPosition)
		it('throws on ENOENT (Go does not silence open errors)', async () => {
			await expect(
				extractModifiedFilesFromOffset(path.join(tmp, 'nonexistent.jsonl'), 0),
			).rejects.toThrow(/failed to open transcript/);
		});

		// Go: transcript.go:129-145 — physical line counting includes blank lines
		it('counts physical lines including blank lines (Go ReadBytes semantics)', async () => {
			const p = path.join(tmp, 'blanks.jsonl');
			// 5 physical lines: line1, blank, line3-apply_patch, blank, line5
			await fs.writeFile(
				p,
				'{"type":"session_meta","payload":{"id":"x","timestamp":"2026-04-20T15:30:45.000Z"}}\n' +
					'\n' +
					'{"type":"response_item","payload":{"type":"custom_tool_call","status":"completed","call_id":"c1","name":"apply_patch","input":"*** Add File: a.ts\\n"}}\n' +
					'\n' +
					'{"type":"event_msg","payload":{"type":"task_started"}}\n',
			);
			const result = await extractModifiedFilesFromOffset(p, 0);
			expect(result.currentPosition).toBe(5);
			expect(result.files).toEqual(['a.ts']);
		});
	});

	describe('calculateTokenUsage (cumulative delta)', () => {
		// Go: transcript.go:208-258 + transcript_test.go various
		it('computes delta = last - baseline (input/cached/output+reasoning)', async () => {
			const data = await readFixture('codex-rollout-with-tokens.jsonl');
			// fixture: 3 token_count cumulative — input 100→300→600, cached 10→30→60,
			// output 50→150→300, reasoning 5→15→30
			// offset=2 → baseline = line 2 (input=100, cached=10, output=50, reasoning=5)
			//          → last = line 3 (last seen post-offset; line 3 only post-offset)
			// Actually only line 2 (token_count) is event_msg with token_count, lines 3 and 4 are too.
			// So lineNum 1 (session_meta) skipped; lineNum 2/3/4 are token_count.
			// offset=2: baseline = line 2; post-offset = lines 3,4 → last = line 4 (the last)
			// delta: input=600-100=500, cached=60-10=50, output+reasoning=(300+30)-(50+5)=275
			// apiCalls = 2 (lines 3 and 4)
			const u = await calculateTokenUsage(data, 2);
			expect(u).not.toBeNull();
			expect(u?.inputTokens).toBe(500);
			expect(u?.cacheReadTokens).toBe(50);
			expect(u?.outputTokens).toBe(275);
			expect(u?.apiCallCount).toBe(2);
		});

		// Go: transcript.go:236 baselineUsage nil → no subtraction
		it('with no baseline (offset=0) returns last total directly', async () => {
			const data = await readFixture('codex-rollout-with-tokens.jsonl');
			// offset=0: all 3 are post-offset; baseline=null; last=line 4 cumulative
			// inputTokens=600 / cacheRead=60 / output=300+30=330 / apiCalls=3
			const u = await calculateTokenUsage(data, 0);
			expect(u?.inputTokens).toBe(600);
			expect(u?.cacheReadTokens).toBe(60);
			expect(u?.outputTokens).toBe(330);
			expect(u?.apiCallCount).toBe(3);
		});

		// Go: transcript.go:235 lastUsage nil → return nil
		it('returns null when no token_count events', async () => {
			const data = enc.encode(
				'{"type":"session_meta","payload":{"id":"x","timestamp":"2026-04-20T15:30:45.000Z"}}\n' +
					'{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}}\n',
			);
			expect(await calculateTokenUsage(data, 0)).toBeNull();
		});

		// Go: transcript.go:228-233 apiCalls only counts post-offset
		it('apiCallCount counts post-offset token_count events only', async () => {
			const data = await readFixture('codex-rollout-with-tokens.jsonl');
			// offset=3 (line 3 is the second token_count) → only line 4 counts
			const u = await calculateTokenUsage(data, 3);
			expect(u?.apiCallCount).toBe(1);
		});

		// Go: transcript.go:243-244 reasoning_output added to outputTokens delta
		it('reasoning_output_tokens added to outputTokens delta', async () => {
			// Custom fixture: baseline reasoning=10/output=20; last reasoning=30/output=50
			// expected: outputTokens = (50+30) - (20+10) = 50
			const data = enc.encode(
				'{"type":"session_meta","payload":{"id":"x","timestamp":"2026-04-20T15:30:45.000Z"}}\n' +
					'{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":0,"cached_input_tokens":0,"output_tokens":20,"reasoning_output_tokens":10,"total_tokens":30}}}}\n' +
					'{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":0,"cached_input_tokens":0,"output_tokens":50,"reasoning_output_tokens":30,"total_tokens":80}}}}\n',
			);
			const u = await calculateTokenUsage(data, 2);
			expect(u?.outputTokens).toBe(50);
		});
	});

	describe('extractPrompts', () => {
		let tmp: string;

		beforeEach(async () => {
			tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-pr-'));
		});
		afterEach(async () => {
			await fs.rm(tmp, { recursive: true, force: true });
		});

		// Go: transcript.go:262-301 happy path
		it('extracts user input_text content from response_items', async () => {
			const p = path.join(tmp, 'p.jsonl');
			await fs.writeFile(p, await readFixture('codex-rollout-basic.jsonl'));
			const prompts = await extractPrompts(p, 0);
			expect(prompts).toEqual(['hello world']);
		});

		// Go: transcript.go:275-277 offset filter
		it('skips messages at lineNum <= fromOffset', async () => {
			const p = path.join(tmp, 'p.jsonl');
			await fs.writeFile(p, await readFixture('codex-rollout-basic.jsonl'));
			// fixture: line 1 session_meta, line 2 user msg, line 3 assistant, line 4 token_count
			// offset=2 → user msg at lineNum 2 is skipped (lineNum <= offset)
			const prompts = await extractPrompts(p, 2);
			expect(prompts).toEqual([]);
		});

		// Go: transcript.go:294-298 trim + skip empty
		it('trims and skips empty input_text content', async () => {
			const p = path.join(tmp, 'p.jsonl');
			await fs.writeFile(
				p,
				'{"type":"session_meta","payload":{"id":"x","timestamp":"2026-04-20T15:30:45.000Z"}}\n' +
					'{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"   "},{"type":"input_text","text":"actual"}]}}\n',
			);
			const prompts = await extractPrompts(p, 0);
			expect(prompts).toEqual(['actual']);
		});
	});

	describe('defensive branches (Story 补充 — coverage)', () => {
		let tmp: string;
		beforeEach(async () => {
			tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-def-'));
		});
		afterEach(async () => {
			await fs.rm(tmp, { recursive: true, force: true });
		});

		it('getTranscriptPosition throws on EISDIR (non-ENOENT readFile error)', async () => {
			// passing a directory path triggers EISDIR
			await expect(getTranscriptPosition(tmp)).rejects.toThrow(/failed to open/);
		});

		it('getTranscriptPosition returns 0 on empty file', async () => {
			const p = path.join(tmp, 'empty.jsonl');
			await fs.writeFile(p, '');
			expect(await getTranscriptPosition(p)).toBe(0);
		});

		it('extractModifiedFilesFromOffset throws on non-ENOENT readFile error (EISDIR)', async () => {
			await expect(extractModifiedFilesFromOffset(tmp, 0)).rejects.toThrow(/failed to open/);
		});

		it('extractPrompts throws on non-ENOENT readFile error (EISDIR)', async () => {
			await expect(extractPrompts(tmp, 0)).rejects.toThrow(/failed to read/);
		});

		it('extractPrompts skips invalid JSON lines + non-message + non-user role', async () => {
			const p = path.join(tmp, 'p.jsonl');
			await fs.writeFile(
				p,
				'{"type":"session_meta","payload":{"id":"x","timestamp":"2026-04-20T15:30:45.000Z"}}\n' +
					'not json\n' +
					'{"type":"response_item","payload":{"type":"function_call"}}\n' +
					'{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"reply"}]}}\n' +
					'{"type":"response_item","payload":{"type":"message","role":"user","content":"not-an-array"}}\n' +
					'{"type":"response_item","payload":{"type":"message","role":"user","content":[null,{"type":"input_text","text":"valid"}]}}\n',
			);
			expect(await extractPrompts(p, 0)).toEqual(['valid']);
		});

		it('calculateTokenUsage skips invalid JSON / non-event_msg / non-token_count / missing info', async () => {
			const data = enc.encode(
				'{"type":"session_meta","payload":{"id":"x","timestamp":"2026-04-20T15:30:45.000Z"}}\n' +
					'not json\n' +
					'{"type":"response_item","payload":{"type":"message"}}\n' +
					'{"type":"event_msg","payload":{"type":"task_started"}}\n' +
					'{"type":"event_msg","payload":{"type":"token_count"}}\n' + // missing info
					'{"type":"event_msg","payload":{"type":"token_count","info":{}}}\n' + // missing total_token_usage
					'{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":10,"cached_input_tokens":5,"output_tokens":3,"reasoning_output_tokens":2,"total_tokens":15}}}}\n',
			);
			const u = await calculateTokenUsage(data, 0);
			expect(u?.inputTokens).toBe(10);
			expect(u?.outputTokens).toBe(5); // 3 + 2 reasoning
			expect(u?.apiCallCount).toBe(1);
		});

		it('sanitizePortableTranscript: returns input unchanged when sanitized is empty (all dropped)', () => {
			// All lines are compaction → all dropped; return original (matches Go)
			const data = enc.encode(
				'{"type":"response_item","payload":{"type":"compaction"}}\n' +
					'{"type":"response_item","payload":{"type":"compaction_summary"}}\n',
			);
			const out = sanitizePortableTranscript(data);
			expect(out).toEqual(data);
		});

		it('sanitizePortableTranscript: returns input unchanged when empty', () => {
			expect(sanitizePortableTranscript(new Uint8Array())).toEqual(new Uint8Array());
		});

		it('sanitizePortableTranscript: passes through invalid JSON lines', () => {
			const data = enc.encode('not json\n');
			const out = sanitizePortableTranscript(data);
			// invalid JSON line is kept verbatim (Go returns lineData, true)
			expect(new TextDecoder().decode(out)).toContain('not json');
		});

		it('sanitizePortableTranscript: handles compacted line with replacement_history (recursive sanitize)', () => {
			const data = enc.encode(
				`${JSON.stringify({
					type: 'compacted',
					payload: {
						replacement_history: [
							{ type: 'reasoning', encrypted_content: 'SECRET' },
							{ type: 'compaction', text: 'drop me' },
							{ type: 'message', text: 'keep me' },
							null, // non-object item — kept as-is
							{ no_type: 'kept' }, // missing type
						],
					},
				})}\n`,
			);
			const out = new TextDecoder().decode(sanitizePortableTranscript(data));
			expect(out).not.toContain('SECRET');
			expect(out).not.toContain('drop me');
			expect(out).toContain('keep me');
			expect(out).toContain('"no_type":"kept"');
		});

		it('sanitizePortableTranscript: compacted line without replacement_history → preserved unchanged', () => {
			const data = enc.encode(
				`${JSON.stringify({ type: 'compacted', payload: { other: 'data' } })}\n`,
			);
			const out = new TextDecoder().decode(sanitizePortableTranscript(data));
			expect(out).toContain('other');
		});

		it('extractFilesFromLine: returns [] when payload.input is not a string', () => {
			const line = enc.encode(
				'{"type":"response_item","payload":{"type":"custom_tool_call","name":"apply_patch","input":123}}',
			);
			expect(extractFilesFromLine(line)).toEqual([]);
		});

		it('parseSessionStartTime: throws when payload is null', () => {
			const data = enc.encode('{"type":"session_meta","payload":null}\n');
			expect(() => parseSessionStartTime(data)).toThrow(/payload/);
		});
	});

	describe('sanitizePortableTranscript', () => {
		// Go: transcript.go:305-323 SanitizePortableTranscript
		it('strips encrypted_content from reasoning + drops compaction lines', async () => {
			const data = await readFixture('codex-rollout-with-reasoning.jsonl');
			const out = sanitizePortableTranscript(data);
			const text = new TextDecoder().decode(out);
			expect(text).not.toContain('encrypted_content');
			expect(text).not.toContain('REDACTED-SHOULD-BE-STRIPPED');
			// reasoning line is kept (with encrypted_content removed)
			expect(text).toContain('"type":"reasoning"');
			// assistant line preserved
			expect(text).toContain('hi');
		});

		// Go: transcript.go:333-339 compaction lines dropped
		it('drops compaction + compaction_summary lines, preserves message + session_meta', async () => {
			const data = await readFixture('codex-rollout-with-compaction.jsonl');
			const out = sanitizePortableTranscript(data);
			const text = new TextDecoder().decode(out);
			expect(text).not.toContain('"type":"compaction"');
			expect(text).not.toContain('"type":"compaction_summary"');
			expect(text).toContain('session_meta');
			expect(text).toContain('new prompt');
		});
	});
});
