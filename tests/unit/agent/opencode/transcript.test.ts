/**
 * Tests for `src/agent/opencode/transcript.ts` — Mirrors Go
 * `entire-cli/cmd/entire/cli/agent/opencode/transcript.go` +
 * `transcript_test.go`.
 *
 * Covers:
 * - parseExportSession success / empty / invalid JSON (Go testExportJSON)
 * - getTranscriptPosition success / nonexistent file
 * - extractModifiedFiles + extractModifiedFilesFromOffset (3 fixture variants:
 *   standard / apply_patch metadata / camelCase filePath)
 * - extractFilePaths (8 Go table cases — metadata > input.filePath > input.path)
 * - calculateTokenUsage (offset 0, offset 2, empty data)
 * - extractTextFromParts joins text parts only
 * - isSystemReminderOnly (6 Go table cases)
 * - stripSystemReminders (5 Go table cases)
 * - extractAllUserPrompts (basic / system-reminder-only excluded / mixed strip /
 *   whitespace+sysreminder = empty / non-ASCII Chinese fixture)
 * - Failure paths: invalid JSON throws, missing file → 0 (not throw)
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { OpenCodeAgent } from '@/agent/opencode';
import {
	calculateTokenUsage,
	extractAllUserPrompts,
	extractFilePaths,
	extractModifiedFiles,
	extractModifiedFilesFromOffset,
	extractTextFromParts,
	getTranscriptPosition,
	isSystemReminderOnly,
	parseExportSession,
	sliceFromMessage,
	stripSystemReminders,
} from '@/agent/opencode/transcript';
import type { ExportSession, ToolState } from '@/agent/opencode/types';

// Go: transcript_test.go:14-62 testExportJSON
const testExportSession: ExportSession = {
	info: { id: 'test-session-id' },
	messages: [
		{
			info: { id: 'msg-1', role: 'user', time: { created: 1708300000 } },
			parts: [{ type: 'text', text: 'Fix the bug in main.go' }],
		},
		{
			info: {
				id: 'msg-2',
				role: 'assistant',
				time: { created: 1708300001, completed: 1708300005 },
				tokens: { input: 150, output: 80, reasoning: 10, cache: { read: 5, write: 15 } },
				cost: 0.003,
			},
			parts: [
				{ type: 'text', text: "I'll fix the bug." },
				{
					type: 'tool',
					tool: 'edit',
					callID: 'call-1',
					state: {
						status: 'completed',
						input: { filePath: 'main.go' },
						output: 'Applied edit',
					},
				},
			],
		},
		{
			info: { id: 'msg-3', role: 'user', time: { created: 1708300010 } },
			parts: [{ type: 'text', text: 'Also fix util.go' }],
		},
		{
			info: {
				id: 'msg-4',
				role: 'assistant',
				time: { created: 1708300011, completed: 1708300015 },
				tokens: { input: 200, output: 100, reasoning: 5, cache: { read: 10, write: 20 } },
				cost: 0.005,
			},
			parts: [
				{
					type: 'tool',
					tool: 'write',
					callID: 'call-2',
					state: {
						status: 'completed',
						input: { filePath: 'util.go' },
						output: 'File written',
					},
				},
				{ type: 'text', text: 'Done fixing util.go.' },
			],
		},
	],
};
const testExportJSON = JSON.stringify(testExportSession);

// Go: transcript_test.go:278-348 testApplyPatchExportJSON
const testApplyPatchExportJSON = JSON.stringify({
	info: { id: 'test-apply-patch' },
	messages: [
		{
			info: { id: 'msg-1', role: 'user', time: { created: 1708300000 } },
			parts: [{ type: 'text', text: 'Fix the table layout' }],
		},
		{
			info: {
				id: 'msg-2',
				role: 'assistant',
				time: { created: 1708300001, completed: 1708300005 },
				tokens: { input: 200, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
			},
			parts: [
				{ type: 'text', text: "I'll fix the layout." },
				{
					type: 'tool',
					tool: 'apply_patch',
					callID: 'call-1',
					state: {
						status: 'completed',
						input: { patchText: '*** Begin Patch\n*** Update File: /repo/layout.py' },
						output: 'Success.',
						metadata: { files: [{ filePath: '/repo/layout.py', relativePath: 'layout.py' }] },
					},
				},
			],
		},
		{
			info: { id: 'msg-3', role: 'user', time: { created: 1708300010 } },
			parts: [{ type: 'text', text: 'Also fix the resize handler' }],
		},
		{
			info: {
				id: 'msg-4',
				role: 'assistant',
				time: { created: 1708300011, completed: 1708300015 },
				tokens: { input: 250, output: 120, reasoning: 0, cache: { read: 0, write: 0 } },
			},
			parts: [
				{
					type: 'tool',
					tool: 'apply_patch',
					callID: 'call-2',
					state: {
						status: 'completed',
						input: { patchText: '*** Begin Patch' },
						output: 'Success.',
						metadata: {
							files: [
								{ filePath: '/repo/layout.py', relativePath: 'layout.py' },
								{ filePath: '/repo/resize.py', relativePath: 'resize.py' },
							],
						},
					},
				},
			],
		},
	],
});

// Go: transcript_test.go:395-431 testCamelCaseExportJSON
const testCamelCaseExportJSON = JSON.stringify({
	info: { id: 'test-camelcase' },
	messages: [
		{
			info: { id: 'msg-1', role: 'user', time: { created: 1708300000 } },
			parts: [{ type: 'text', text: 'Fix the bug' }],
		},
		{
			info: {
				id: 'msg-2',
				role: 'assistant',
				time: { created: 1708300001, completed: 1708300005 },
			},
			parts: [
				{
					type: 'tool',
					tool: 'write',
					callID: 'call-1',
					state: {
						status: 'completed',
						input: { filePath: '/repo/new_file.rb', content: "puts 'hello'" },
						output: 'Wrote file',
					},
				},
			],
		},
		{
			info: { id: 'msg-3', role: 'user', time: { created: 1708300010 } },
			parts: [{ type: 'text', text: 'Now edit it' }],
		},
		{
			info: {
				id: 'msg-4',
				role: 'assistant',
				time: { created: 1708300011, completed: 1708300015 },
			},
			parts: [
				{
					type: 'tool',
					tool: 'edit',
					callID: 'call-2',
					state: {
						status: 'completed',
						input: { filePath: '/repo/new_file.rb', oldString: 'hello', newString: 'world' },
						output: 'Edit applied',
					},
				},
			],
		},
	],
});

async function withTempTranscript(
	content: string,
	fn: (filePath: string) => Promise<void>,
): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-tr-'));
	try {
		const filePath = path.join(dir, 'test-session.json');
		await fs.writeFile(filePath, content);
		await fn(filePath);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

describe('agent/opencode/transcript — Go: opencode/transcript.go + transcript_test.go', () => {
	describe('parseExportSession', () => {
		// Go: TestParseExportSession (transcript_test.go:74-91)
		it('parses 4-message fixture', () => {
			const session = parseExportSession(new TextEncoder().encode(testExportJSON));
			expect(session).not.toBeNull();
			expect(session!.messages.length).toBe(4);
			expect(session!.messages[0]?.info.id).toBe('msg-1');
			expect(session!.messages[0]?.info.role).toBe('user');
		});

		// Go: TestParseExportSession_Empty (transcript_test.go:93-111)
		it('empty / null data → null', () => {
			expect(parseExportSession(new Uint8Array())).toBeNull();
		});

		// Go: TestParseExportSession_InvalidJSON (transcript_test.go:113-120)
		it('invalid JSON → throws', () => {
			expect(() => parseExportSession(new TextEncoder().encode('not json'))).toThrow(
				/failed to parse export session/,
			);
		});
	});

	describe('sliceFromMessage', () => {
		// Go: SliceFromMessage (transcript.go:48-75) — 0 returns original
		it('startMessageIndex <= 0 → returns original', () => {
			const data = new TextEncoder().encode(testExportJSON);
			expect(sliceFromMessage(data, 0)).toBe(data);
			expect(sliceFromMessage(data, -1)).toBe(data);
		});

		// Go: SliceFromMessage — empty input passes through
		it('empty data → returns empty', () => {
			const data = new Uint8Array();
			expect(sliceFromMessage(data, 0)).toBe(data);
		});

		// Go: SliceFromMessage:61-63 — startMessageIndex >= len → null
		it('startMessageIndex >= len(messages) → null', () => {
			const data = new TextEncoder().encode(testExportJSON);
			expect(sliceFromMessage(data, 4)).toBeNull();
			expect(sliceFromMessage(data, 999)).toBeNull();
		});

		// Go: SliceFromMessage:65-74 — slice from middle
		it('slices messages array from given index', () => {
			const data = new TextEncoder().encode(testExportJSON);
			const sliced = sliceFromMessage(data, 2);
			expect(sliced).not.toBeNull();
			const parsed = JSON.parse(new TextDecoder().decode(sliced!)) as ExportSession;
			expect(parsed.messages.length).toBe(2);
			expect(parsed.messages[0]?.info.id).toBe('msg-3');
			expect(parsed.info.id).toBe('test-session-id');
		});
	});

	describe('getTranscriptPosition', () => {
		// Go: TestGetTranscriptPosition (transcript_test.go:122-134)
		it('returns messages.length', async () => {
			await withTempTranscript(testExportJSON, async (p) => {
				const pos = await getTranscriptPosition(p);
				expect(pos).toBe(4);
			});
		});

		// Go: TestGetTranscriptPosition_NonexistentFile (transcript_test.go:136-147)
		it('nonexistent file → 0', async () => {
			expect(await getTranscriptPosition('/nonexistent/path.json')).toBe(0);
		});
	});

	describe('extractModifiedFilesFromOffset (standard fixture)', () => {
		// Go: TestExtractModifiedFilesFromOffset (transcript_test.go:149-180)
		it('from offset 0: 2 files (main.go + util.go), pos=4', async () => {
			await withTempTranscript(testExportJSON, async (p) => {
				const { files, currentPosition } = await extractModifiedFilesFromOffset(p, 0);
				expect(currentPosition).toBe(4);
				expect(files).toEqual(['main.go', 'util.go']);
			});
		});

		it('from offset 2: only util.go', async () => {
			await withTempTranscript(testExportJSON, async (p) => {
				const { files, currentPosition } = await extractModifiedFilesFromOffset(p, 2);
				expect(currentPosition).toBe(4);
				expect(files).toEqual(['util.go']);
			});
		});

		// Failure path: nonexistent file → empty (matches Go os.IsNotExist swallow)
		it('nonexistent file → empty + 0', async () => {
			const { files, currentPosition } = await extractModifiedFilesFromOffset('/nonexistent', 0);
			expect(files).toEqual([]);
			expect(currentPosition).toBe(0);
		});
	});

	describe('extractModifiedFilesFromOffset (apply_patch fixture)', () => {
		// Go: TestExtractModifiedFilesFromOffset_ApplyPatch (transcript_test.go:350-375)
		it('from offset 0: 2 files dedup (layout.py + resize.py)', async () => {
			await withTempTranscript(testApplyPatchExportJSON, async (p) => {
				const { files, currentPosition } = await extractModifiedFilesFromOffset(p, 0);
				expect(currentPosition).toBe(4);
				expect(files).toEqual(['/repo/layout.py', '/repo/resize.py']);
			});
		});

		it('from offset 2: only msg-4 files (layout.py + resize.py)', async () => {
			await withTempTranscript(testApplyPatchExportJSON, async (p) => {
				const { files } = await extractModifiedFilesFromOffset(p, 2);
				expect(files).toEqual(['/repo/layout.py', '/repo/resize.py']);
			});
		});
	});

	describe('extractModifiedFilesFromOffset (camelCase fixture)', () => {
		// Go: TestExtractModifiedFilesFromOffset_CamelCaseFilePath (transcript_test.go:433-461)
		it('from offset 0: deduplicates write+edit on same file', async () => {
			await withTempTranscript(testCamelCaseExportJSON, async (p) => {
				const { files, currentPosition } = await extractModifiedFilesFromOffset(p, 0);
				expect(currentPosition).toBe(4);
				expect(files).toEqual(['/repo/new_file.rb']);
			});
		});

		it('from offset 2: still finds the edit in msg-4', async () => {
			await withTempTranscript(testCamelCaseExportJSON, async (p) => {
				const { files } = await extractModifiedFilesFromOffset(p, 2);
				expect(files).toEqual(['/repo/new_file.rb']);
			});
		});
	});

	describe('extractModifiedFiles (bytes-based, for ReadSession)', () => {
		// Go: TestExtractModifiedFiles (transcript_test.go:653-669)
		it('returns 2 files in order from full transcript', () => {
			const files = extractModifiedFiles(new TextEncoder().encode(testExportJSON));
			expect(files).toEqual(['main.go', 'util.go']);
		});

		// Go: TestExtractModifiedFiles_ApplyPatch (transcript_test.go:377-393)
		it('apply_patch fixture: 2 files in order (deduped across messages)', () => {
			const files = extractModifiedFiles(new TextEncoder().encode(testApplyPatchExportJSON));
			expect(files).toEqual(['/repo/layout.py', '/repo/resize.py']);
		});

		it('empty data → empty', () => {
			expect(extractModifiedFiles(new Uint8Array())).toEqual([]);
		});
	});

	describe('extractFilePaths (Go table)', () => {
		// Go: TestExtractFilePaths (transcript_test.go:182-276)
		const cases: Array<[string, ToolState | null, string[]]> = [
			[
				'camelCase filePath from input',
				{ status: 'completed', input: { filePath: '/repo/main.go' } },
				['/repo/main.go'],
			],
			[
				'path key from input',
				{ status: 'completed', input: { path: '/repo/main.go' } },
				['/repo/main.go'],
			],
			[
				'filePath takes priority over path',
				{ status: 'completed', input: { filePath: '/a.go', path: '/b.go' } },
				['/a.go'],
			],
			['empty input', { status: 'completed', input: {} }, []],
			['null state', null, []],
			[
				'metadata files (apply_patch)',
				{
					status: 'completed',
					input: { patchText: '*** Begin Patch' },
					metadata: { files: [{ filePath: '/repo/main.go', relativePath: 'main.go' }] },
				},
				['/repo/main.go'],
			],
			[
				'metadata multiple files',
				{
					status: 'completed',
					input: { patchText: '...' },
					metadata: {
						files: [{ filePath: '/repo/a.go' }, { filePath: '/repo/b.go' }],
					},
				},
				['/repo/a.go', '/repo/b.go'],
			],
			[
				'metadata takes priority over input',
				{
					status: 'completed',
					input: { filePath: '/input/file.go' },
					metadata: { files: [{ filePath: '/meta/file.go' }] },
				},
				['/meta/file.go'],
			],
			[
				'empty metadata falls back to input',
				{
					status: 'completed',
					input: { filePath: '/repo/main.go' },
					metadata: {},
				},
				['/repo/main.go'],
			],
		];
		for (const [name, state, want] of cases) {
			it(name, () => {
				expect(extractFilePaths(state)).toEqual(want);
			});
		}

		// Failure path: input.filePath non-string → skip
		it('input.filePath non-string → empty', () => {
			expect(
				extractFilePaths({ status: 'completed', input: { filePath: 123 as unknown as string } }),
			).toEqual([]);
		});
	});

	describe('calculateTokenUsage', () => {
		// Go: TestCalculateTokenUsage (transcript_test.go:463-488)
		it('from offset 0: aggregates both assistant messages', async () => {
			const a = new OpenCodeAgent();
			const usage = await calculateTokenUsage.call(a, new TextEncoder().encode(testExportJSON), 0);
			expect(usage).not.toBeNull();
			expect(usage!.inputTokens).toBe(350);
			expect(usage!.outputTokens).toBe(180);
			expect(usage!.cacheReadTokens).toBe(15);
			expect(usage!.cacheCreationTokens).toBe(35);
			expect(usage!.apiCallCount).toBe(2);
		});

		// Go: TestCalculateTokenUsage_FromOffset (transcript_test.go:490-507)
		it('from offset 2: aggregates only msg-4', async () => {
			const a = new OpenCodeAgent();
			const usage = await calculateTokenUsage.call(a, new TextEncoder().encode(testExportJSON), 2);
			expect(usage!.inputTokens).toBe(200);
			expect(usage!.outputTokens).toBe(100);
			expect(usage!.apiCallCount).toBe(1);
		});

		// Go: TestCalculateTokenUsage_EmptyData (transcript_test.go:509-520)
		it('empty data → null', async () => {
			const a = new OpenCodeAgent();
			expect(await calculateTokenUsage.call(a, new Uint8Array(), 0)).toBeNull();
		});

		// Failure path: invalid JSON → throws (synchronous throw since
		// calculateTokenUsage is now sync per TokenCalculator Awaitable<T> contract).
		it('invalid JSON → throws', () => {
			const a = new OpenCodeAgent();
			expect(() => calculateTokenUsage.call(a, new TextEncoder().encode('not json'), 0)).toThrow(
				/failed to parse transcript/,
			);
		});
	});

	describe('extractTextFromParts', () => {
		// Go: ExtractTextFromParts (transcript.go:201-210)
		it('joins text parts only with newline', () => {
			expect(
				extractTextFromParts([
					{ type: 'text', text: 'hello' },
					{ type: 'tool', tool: 'edit' },
					{ type: 'text', text: 'world' },
				]),
			).toBe('hello\nworld');
		});

		it('skips empty text parts', () => {
			expect(
				extractTextFromParts([
					{ type: 'text', text: '' },
					{ type: 'text', text: 'x' },
				]),
			).toBe('x');
		});

		it('empty array → ""', () => {
			expect(extractTextFromParts([])).toBe('');
		});
	});

	describe('isSystemReminderOnly (Go table)', () => {
		// Go: TestIsSystemReminderOnly (transcript_test.go:794-844)
		const cases: Array<[string, string, boolean]> = [
			['exact system-reminder', '<system-reminder>context here</system-reminder>', true],
			['with surrounding whitespace', '  \n<system-reminder>context</system-reminder>\n  ', true],
			['not system-reminder', 'Fix the bug', false],
			['mixed content', 'Fix the bug\n<system-reminder>context</system-reminder>', false],
			['empty', '', false],
			[
				'real content between multiple blocks',
				'<system-reminder>a</system-reminder>Fix this<system-reminder>b</system-reminder>',
				false,
			],
		];
		for (const [name, content, want] of cases) {
			it(name, () => {
				expect(isSystemReminderOnly(content)).toBe(want);
			});
		}
	});

	describe('stripSystemReminders (Go table)', () => {
		// Go: TestStripSystemReminders (transcript_test.go:846-889)
		const cases: Array<[string, string, string]> = [
			['no system-reminder', 'Fix the bug', 'Fix the bug'],
			['only system-reminder', '<system-reminder>context</system-reminder>', ''],
			['mixed content', 'Fix the bug\n<system-reminder>context</system-reminder>', 'Fix the bug'],
			[
				'system-reminder in middle',
				'First part\n<system-reminder>context</system-reminder>\nSecond part',
				'First part\n\nSecond part',
			],
			[
				'multiple system-reminders',
				'<system-reminder>a</system-reminder>Fix this<system-reminder>b</system-reminder>',
				'Fix this',
			],
		];
		for (const [name, content, want] of cases) {
			it(name, () => {
				expect(stripSystemReminders(content)).toBe(want);
			});
		}
	});

	describe('extractAllUserPrompts', () => {
		// Go: TestExtractAllUserPrompts (transcript_test.go:671-687)
		it('extracts 2 user prompts from standard fixture', () => {
			const prompts = extractAllUserPrompts(new TextEncoder().encode(testExportJSON));
			expect(prompts).toEqual(['Fix the bug in main.go', 'Also fix util.go']);
		});

		// Go: TestExtractAllUserPrompts_SystemReminderOnly (transcript_test.go:689-733)
		it('excludes system-reminder-only messages', () => {
			const session: ExportSession = {
				info: { id: 'test-sysreminder' },
				messages: [
					{
						info: { id: 'm1', role: 'user', time: { created: 0 } },
						parts: [{ type: 'text', text: 'Fix the bug' }],
					},
					{
						info: { id: 'm2', role: 'user', time: { created: 1 } },
						parts: [
							{
								type: 'text',
								text: '<system-reminder>\nAs you answer the user, see AGENTS.md...\n</system-reminder>',
							},
						],
					},
					{
						info: { id: 'm3', role: 'user', time: { created: 2 } },
						parts: [{ type: 'text', text: 'Now fix util.go' }],
					},
				],
			};
			const prompts = extractAllUserPrompts(new TextEncoder().encode(JSON.stringify(session)));
			expect(prompts).toEqual(['Fix the bug', 'Now fix util.go']);
		});

		// Go: TestExtractAllUserPrompts_SystemReminderMixed (transcript_test.go:735-764)
		it('strips system-reminder from mixed message', () => {
			const session: ExportSession = {
				info: { id: 'test-mixed' },
				messages: [
					{
						info: { id: 'm1', role: 'user', time: { created: 0 } },
						parts: [
							{
								type: 'text',
								text: 'Fix the bug\n<system-reminder>\nAGENTS.md...\n</system-reminder>',
							},
						],
					},
				],
			};
			const prompts = extractAllUserPrompts(new TextEncoder().encode(JSON.stringify(session)));
			expect(prompts).toEqual(['Fix the bug']);
		});

		// Go: TestExtractAllUserPrompts_SystemReminderWithWhitespace (transcript_test.go:766-792)
		it('whitespace + system-reminder → 0 prompts', () => {
			const session: ExportSession = {
				info: { id: 'test-ws' },
				messages: [
					{
						info: { id: 'm1', role: 'user', time: { created: 0 } },
						parts: [
							{
								type: 'text',
								text: '  \n<system-reminder>\nctx\n</system-reminder>\n  ',
							},
						],
					},
				],
			};
			const prompts = extractAllUserPrompts(new TextEncoder().encode(JSON.stringify(session)));
			expect(prompts).toEqual([]);
		});

		// Failure path / Story-extra (盲区 1: ASCII fixture only) — non-ASCII content
		it('preserves CJK + emoji in user prompts (UTF-8 round-trip)', () => {
			const session: ExportSession = {
				info: { id: 'test-cjk' },
				messages: [
					{
						info: { id: 'm1', role: 'user', time: { created: 0 } },
						parts: [{ type: 'text', text: '修复 main.go 的 bug 🐛' }],
					},
				],
			};
			const prompts = extractAllUserPrompts(new TextEncoder().encode(JSON.stringify(session)));
			expect(prompts).toEqual(['修复 main.go 的 bug 🐛']);
		});

		// Failure path: malformed JSON → throws (matches Go ExtractAllUserPrompts behavior)
		it('malformed JSON → throws', () => {
			expect(() => extractAllUserPrompts(new TextEncoder().encode('not json'))).toThrow(
				/failed to parse export session/,
			);
		});

		it('empty data → empty array', () => {
			expect(extractAllUserPrompts(new Uint8Array())).toEqual([]);
		});
	});

	// Failure path coverage check: extractModifiedFiles non-completed status
	describe('failure paths', () => {
		// Go: extractFilePaths only checks Type === 'tool' && State !== nil; non-tool parts skipped
		it('extractModifiedFiles: non-tool part skipped', () => {
			const session: ExportSession = {
				info: { id: 't' },
				messages: [
					{
						info: { id: 'm1', role: 'assistant', time: { created: 0 } },
						parts: [{ type: 'text', text: 'no tool here' }],
					},
				],
			};
			expect(extractModifiedFiles(new TextEncoder().encode(JSON.stringify(session)))).toEqual([]);
		});

		// Go: extractModifiedFiles only counts assistant messages
		it('extractModifiedFiles: user message tool call skipped', () => {
			const session: ExportSession = {
				info: { id: 't' },
				messages: [
					{
						info: { id: 'm1', role: 'user', time: { created: 0 } },
						parts: [
							{
								type: 'tool',
								tool: 'edit',
								state: { status: 'completed', input: { filePath: '/leak.go' } },
							},
						],
					},
				],
			};
			expect(extractModifiedFiles(new TextEncoder().encode(JSON.stringify(session)))).toEqual([]);
		});

		// Go: only FileModificationTools (edit/write/apply_patch) trigger
		it('extractModifiedFiles: non-FILE_MODIFICATION_TOOLS skipped', () => {
			const session: ExportSession = {
				info: { id: 't' },
				messages: [
					{
						info: { id: 'm1', role: 'assistant', time: { created: 0 } },
						parts: [
							{
								type: 'tool',
								tool: 'bash',
								state: { status: 'completed', input: { filePath: '/leak.go' } },
							},
						],
					},
				],
			};
			expect(extractModifiedFiles(new TextEncoder().encode(JSON.stringify(session)))).toEqual([]);
		});
	});
});
