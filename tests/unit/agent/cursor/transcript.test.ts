/**
 * Tests for `src/agent/cursor/transcript.ts` — Mirrors Go
 * `entire-cli/cmd/entire/cli/agent/cursor/transcript.go` + `transcript_test.go`.
 *
 * Covers:
 * - getTranscriptPosition: sample (4 lines) / empty path / nonexistent / no
 *   trailing newline (4 case)
 * - extractPrompts: sample → 2 prompts / with offset / empty file / IDE-tag
 *   strip (4 case)
 * - extractSummary: sample / empty / multiple assistants → last / no text
 *   blocks → '' (4 case)
 * - extractModifiedFilesFromOffset: always returns { files: [],
 *   currentPosition: 0 } (1 case)
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	extractModifiedFilesFromOffset,
	extractPrompts,
	extractSummary,
	getTranscriptPosition,
} from '@/agent/cursor/transcript';

const FIXTURES = path.join(__dirname, '..', '..', '..', 'fixtures', 'agent', 'cursor');

describe('agent/cursor/transcript — Go: cursor/transcript.go + transcript_test.go', () => {
	let tmpDir: string;
	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cursor-tx-'));
	});
	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	describe('getTranscriptPosition', () => {
		// Go: transcript_test.go:16-30 TestCursorAgent_GetTranscriptPosition
		it('sample transcript → 4 lines', async () => {
			const sample = path.join(FIXTURES, 'sample-transcript.jsonl');
			expect(await getTranscriptPosition(sample)).toBe(4);
		});

		// Go: transcript_test.go:32-43 TestCursorAgent_GetTranscriptPosition_EmptyPath
		it('empty path → 0', async () => {
			expect(await getTranscriptPosition('')).toBe(0);
		});

		// Go: transcript_test.go:45-56 TestCursorAgent_GetTranscriptPosition_NonexistentFile
		it('nonexistent file → 0 (silent ENOENT)', async () => {
			expect(await getTranscriptPosition('/nonexistent/x.jsonl')).toBe(0);
		});

		// Story addition: file w/o trailing newline still counts last line
		it('file without trailing newline still counts last line', async () => {
			const p = path.join(tmpDir, 'no-trailing.jsonl');
			await fs.writeFile(p, '{"role":"user"}\n{"role":"assistant"}'); // 2 lines, no trailing \n
			expect(await getTranscriptPosition(p)).toBe(2);
		});
	});

	describe('extractPrompts', () => {
		// Go: transcript_test.go:60-81 TestCursorAgent_ExtractPrompts
		it('sample → 2 prompts (user_query tags stripped)', async () => {
			const sample = path.join(FIXTURES, 'sample-transcript.jsonl');
			const prompts = await extractPrompts(sample, 0);
			expect(prompts).toEqual(['hello', "add 'one' to a file and commit"]);
		});

		// Go: transcript_test.go:83-101 TestCursorAgent_ExtractPrompts_WithOffset
		it('with offset 2 skips first user+assistant → 1 prompt', async () => {
			const sample = path.join(FIXTURES, 'sample-transcript.jsonl');
			const prompts = await extractPrompts(sample, 2);
			expect(prompts).toEqual(["add 'one' to a file and commit"]);
		});

		// Go: transcript_test.go:103-120 TestCursorAgent_ExtractPrompts_EmptyFile
		it('empty file → []', async () => {
			const empty = path.join(tmpDir, 'empty.jsonl');
			await fs.writeFile(empty, '');
			expect(await extractPrompts(empty, 0)).toEqual([]);
		});

		// Story coverage: failure path (parseFromFileAtLine throws on missing file)
		it('extractPrompts on missing file → throws "failed to parse transcript"', async () => {
			await expect(extractPrompts('/nonexistent/file.jsonl', 0)).rejects.toThrow(
				/failed to parse transcript/,
			);
		});

		// Story addition: <ide_opened_file> tags also stripped (extractUserContent
		// → stripIDEContextTags in @/textutil)
		it('strips <ide_*> context tags', async () => {
			const ide = path.join(FIXTURES, 'ide-context-transcript.jsonl');
			const prompts = await extractPrompts(ide, 0);
			expect(prompts.length).toBe(1);
			expect(prompts[0]).not.toContain('<ide_opened_file>');
			expect(prompts[0]).not.toContain('<user_query>');
			expect(prompts[0]).toContain('refactor this function');
		});
	});

	describe('extractSummary', () => {
		// Go: transcript_test.go:124-138 TestCursorAgent_ExtractSummary
		it('sample → last assistant text "Created one.txt with one and committed."', async () => {
			const sample = path.join(FIXTURES, 'sample-transcript.jsonl');
			expect(await extractSummary(sample)).toBe('Created one.txt with one and committed.');
		});

		// Go: transcript_test.go:140-157 TestCursorAgent_ExtractSummary_EmptyFile
		it('empty file → ""', async () => {
			const empty = path.join(tmpDir, 'empty.jsonl');
			await fs.writeFile(empty, '');
			expect(await extractSummary(empty)).toBe('');
		});

		// Story addition: multiple assistants → returns last one
		it('multiple assistant messages → returns last one', async () => {
			const p = path.join(tmpDir, 'multi.jsonl');
			await fs.writeFile(
				p,
				`${[
					'{"role":"user","message":{"content":[{"type":"text","text":"q1"}]}}',
					'{"role":"assistant","message":{"content":[{"type":"text","text":"a1 first"}]}}',
					'{"role":"user","message":{"content":[{"type":"text","text":"q2"}]}}',
					'{"role":"assistant","message":{"content":[{"type":"text","text":"a2 last"}]}}',
				].join('\n')}\n`,
			);
			expect(await extractSummary(p)).toBe('a2 last');
		});

		// Story addition: last assistant has no text blocks → returns ''
		it('last assistant has only non-text blocks → returns ""', async () => {
			const p = path.join(tmpDir, 'no-text.jsonl');
			await fs.writeFile(
				p,
				'{"role":"assistant","message":{"content":[{"type":"image","data":"x"}]}}\n',
			);
			expect(await extractSummary(p)).toBe('');
		});

		// Story branch coverage: assistant message with non-array content
		it('assistant message.content is a string (not array) → falls through to ""', async () => {
			const p = path.join(tmpDir, 'string-content.jsonl');
			await fs.writeFile(
				p,
				'{"role":"assistant","message":{"content":"plain string not an array"}}\n',
			);
			expect(await extractSummary(p)).toBe('');
		});

		// Story branch coverage: content array contains primitive (non-object) entries
		it('assistant content array with primitive blocks → falls through to ""', async () => {
			const p = path.join(tmpDir, 'primitive-blocks.jsonl');
			await fs.writeFile(
				p,
				'{"role":"assistant","message":{"content":["just a string","another"]}}\n',
			);
			expect(await extractSummary(p)).toBe('');
		});

		// Story branch coverage: reverse walk skips non-assistant (user) lines before
		// finding the assistant
		it('reverse walk skips user lines to find prior assistant', async () => {
			const p = path.join(tmpDir, 'mixed.jsonl');
			await fs.writeFile(
				p,
				`${[
					'{"role":"assistant","message":{"content":[{"type":"text","text":"earlier reply"}]}}',
					'{"role":"user","message":{"content":[{"type":"text","text":"<user_query>q</user_query>"}]}}',
					'{"role":"user","message":{"content":[{"type":"text","text":"<user_query>q2</user_query>"}]}}',
				].join('\n')}\n`,
			);
			expect(await extractSummary(p)).toBe('earlier reply');
		});

		// Story coverage: failure paths (read error)
		it('extractSummary missing file → throws "failed to read transcript"', async () => {
			await expect(extractSummary('/nonexistent/never.jsonl')).rejects.toThrow(
				/failed to read transcript/,
			);
		});

		// Story branch coverage: assistant line with non-object message field
		it('assistant message is a string (not object) → falls through', async () => {
			const p = path.join(tmpDir, 'string-message.jsonl');
			await fs.writeFile(
				p,
				`${[
					'{"role":"assistant","message":"some-string-not-object"}',
					'{"role":"assistant","message":{"content":[{"type":"text","text":"valid earlier"}]}}',
				]
					.reverse()
					.join('\n')}\n`,
			);
			// reverse() so 'some-string-not-object' is the LAST line; walk picks
			// the prior valid assistant.
			expect(await extractSummary(p)).toBe('valid earlier');
		});
	});

	describe('extractModifiedFilesFromOffset', () => {
		// Go: transcript_test.go:161-210 TestCursorAgent_ExtractModifiedFilesFromOffset
		// (3 sub-cases all return nil/0/nil → in TS we collapse to one assertion
		// since extractModifiedFilesFromOffset takes the same code path regardless
		// of input — Cursor always returns empty)
		it('any input → { files: [], currentPosition: 0 }', async () => {
			const sample = path.join(FIXTURES, 'sample-transcript.jsonl');
			expect(await extractModifiedFilesFromOffset(sample, 0)).toEqual({
				files: [],
				currentPosition: 0,
			});
			expect(await extractModifiedFilesFromOffset('/nonexistent.jsonl', 0)).toEqual({
				files: [],
				currentPosition: 0,
			});
			expect(await extractModifiedFilesFromOffset('', 0)).toEqual({
				files: [],
				currentPosition: 0,
			});
		});
	});
});
