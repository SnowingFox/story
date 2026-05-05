/**
 * Tests for `src/agent/claude-code/transcript.ts` — Mirrors Go
 * `entire-cli/cmd/entire/cli/agent/claudecode/transcript_test.go`
 * (19 Go test functions) + 3 Story补充 (MultiEdit / mcp / NotebookEdit recognition;
 * non-ASCII path; dedup semantics).
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	calculateTokenUsage,
	calculateTokenUsageFromFile,
	calculateTotalTokenUsage,
	extractAgentIdFromText,
	extractAllModifiedFiles,
	extractModifiedFiles,
	extractSpawnedAgentIds,
	findCheckpointUUID,
	serializeTranscript,
	type TranscriptLine,
	truncateAtUUID,
} from '@/agent/claude-code/transcript';
import { parseFromBytes } from '@/transcript';

const enc = new TextEncoder();

function bytes(s: string): Uint8Array {
	return enc.encode(s);
}

function buildJSONL(...lines: string[]): Uint8Array {
	return bytes(`${lines.join('\n')}\n`);
}

describe('agent/claude-code/transcript — Go: transcript_test.go', () => {
	// --- Parse + Serialize round-trip (Go: TestParseTranscript / TestSerializeTranscript) ---

	describe('parseFromBytes (Phase 4.2 dep, sanity check)', () => {
		// Go: transcript_test.go:12-35 (TestParseTranscript)
		it('parses 2-line valid JSONL', () => {
			const data = `{"type":"user","uuid":"u1","message":{"content":"hello"}}
{"type":"assistant","uuid":"a1","message":{"content":[{"type":"text","text":"hi"}]}}
`;
			const lines = parseFromBytes(data);
			expect(lines).toHaveLength(2);
			expect(lines[0]?.type).toBe('user');
			expect(lines[0]?.uuid).toBe('u1');
			expect(lines[1]?.type).toBe('assistant');
			expect(lines[1]?.uuid).toBe('a1');
		});

		// Go: transcript_test.go:37-54 (TestParseTranscript_SkipsMalformed)
		it('skips middle malformed line', () => {
			const data = `{"type":"user","uuid":"u1","message":{"content":"hello"}}
not valid json
{"type":"assistant","uuid":"a1","message":{"content":[]}}
`;
			const lines = parseFromBytes(data);
			expect(lines).toHaveLength(2);
		});
	});

	describe('serializeTranscript', () => {
		// Go: transcript_test.go:56-78 (TestSerializeTranscript) — round-trip
		it('round-trips through parseFromBytes', () => {
			const lines: TranscriptLine[] = [
				{ type: 'user', uuid: 'u1' },
				{ type: 'assistant', uuid: 'a1' },
			];
			const out = serializeTranscript(lines);
			const text = new TextDecoder().decode(out);
			expect(text).toBe('{"type":"user","uuid":"u1"}\n{"type":"assistant","uuid":"a1"}\n');
			const parsed = parseFromBytes(text);
			expect(parsed).toHaveLength(2);
			expect(parsed[0]?.type).toBe('user');
			expect(parsed[1]?.uuid).toBe('a1');
		});

		// Story 失败路径补充：JSON.stringify circular reference throws.
		it('throws when a line cannot be JSON-stringified (circular ref)', () => {
			const circ: Record<string, unknown> = { type: 'user' };
			circ.self = circ;
			expect(() => serializeTranscript([circ as TranscriptLine])).toThrow(/marshal line/);
		});

		// Story 边界：empty array → empty Uint8Array.
		it('empty input returns empty Uint8Array', () => {
			const out = serializeTranscript([]);
			expect(out.length).toBe(0);
		});
	});

	// --- ExtractModifiedFiles (Go: TestExtractModifiedFiles) ---

	describe('extractModifiedFiles', () => {
		// Go: transcript_test.go:80-115 (TestExtractModifiedFiles)
		it('dedupes Write/Edit, ignores Bash, preserves first-seen order', () => {
			const data = `{"type":"assistant","uuid":"a1","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"foo.go"}}]}}
{"type":"assistant","uuid":"a2","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"bar.go"}}]}}
{"type":"assistant","uuid":"a3","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"ls"}}]}}
{"type":"assistant","uuid":"a4","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"foo.go"}}]}}
`;
			const lines = parseFromBytes(data);
			const files = extractModifiedFiles(lines);
			expect(files).toEqual(['foo.go', 'bar.go']);
		});

		// Story 补充：MultiEdit is NOT in FILE_MODIFICATION_TOOLS — Go: types.go:76-83 array
		// only contains Write / Edit / NotebookEdit / mcp__acp__Write / mcp__acp__Edit.
		// (Phase 6.2 spec says "MultiEdit" but Go upstream's array doesn't include it —
		// we mirror Go exactly.) This test verifies recognition of the 5 listed tools.
		it('recognizes mcp__acp__Write / mcp__acp__Edit / NotebookEdit (Story补充 — Go fixture only covers Write/Edit/Bash)', () => {
			const data = `{"type":"assistant","uuid":"a1","message":{"content":[{"type":"tool_use","name":"NotebookEdit","input":{"notebook_path":"nb.ipynb"}}]}}
{"type":"assistant","uuid":"a2","message":{"content":[{"type":"tool_use","name":"mcp__acp__Write","input":{"file_path":"src/x.ts"}}]}}
{"type":"assistant","uuid":"a3","message":{"content":[{"type":"tool_use","name":"mcp__acp__Edit","input":{"file_path":"src/y.ts"}}]}}
`;
			const lines = parseFromBytes(data);
			const files = extractModifiedFiles(lines);
			expect(files).toEqual(['nb.ipynb', 'src/x.ts', 'src/y.ts']);
		});

		// Story 补充 (testing-discipline §2 盲区 1: ASCII fixture):
		// Confirm the function does not byte-compare paths — non-ASCII path
		// should be returned verbatim through dedup.
		it('preserves non-ASCII paths (Story补充: testing-discipline 7 类盲区 #1)', () => {
			const data = `{"type":"assistant","uuid":"a1","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"src/app-中文.ts"}}]}}
{"type":"assistant","uuid":"a2","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"src/app-中文.ts"}}]}}
`;
			const lines = parseFromBytes(data);
			const files = extractModifiedFiles(lines);
			expect(files).toEqual(['src/app-中文.ts']);
		});

		// Story 失败路径：non-assistant lines / missing fields silently skipped.
		it('skips user / system lines and malformed message content', () => {
			const lines: TranscriptLine[] = [
				{ type: 'user', uuid: 'u1', message: { content: [] } },
				{ type: 'assistant', uuid: 'a1', message: { content: [{ type: 'text', text: 'hi' }] } }, // not tool_use
				{ type: 'assistant', uuid: 'a2', message: 'not an object' as unknown }, // raw string that is not JSON
				{ type: 'system', uuid: 's1' },
			];
			expect(extractModifiedFiles(lines)).toEqual([]);
		});
	});

	// --- TruncateAtUUID (Go: TestTruncateAtUUID) ---

	describe('truncateAtUUID', () => {
		const data = `{"type":"user","uuid":"u1","message":{}}
{"type":"assistant","uuid":"a1","message":{}}
{"type":"user","uuid":"u2","message":{}}
{"type":"assistant","uuid":"a2","message":{}}
`;
		const cases: Array<{ name: string; uuid: string; len: number; lastUUID: string }> = [
			// Go: transcript_test.go:131-143 (table cases)
			{ name: 'truncate at u1', uuid: 'u1', len: 1, lastUUID: 'u1' },
			{ name: 'truncate at a1', uuid: 'a1', len: 2, lastUUID: 'a1' },
			{ name: 'truncate at u2', uuid: 'u2', len: 3, lastUUID: 'u2' },
			{ name: 'truncate at a2', uuid: 'a2', len: 4, lastUUID: 'a2' },
			{ name: 'empty uuid returns all', uuid: '', len: 4, lastUUID: 'a2' },
			{ name: 'unknown uuid returns all', uuid: 'unknown', len: 4, lastUUID: 'a2' },
		];
		for (const c of cases) {
			it(c.name, () => {
				const lines = parseFromBytes(data);
				const truncated = truncateAtUUID(lines, c.uuid);
				expect(truncated).toHaveLength(c.len);
				if (c.len > 0) {
					expect((truncated[truncated.length - 1] as { uuid?: string }).uuid).toBe(c.lastUUID);
				}
			});
		}

		// Go: transcript_test.go:91-104 — empty UUID returns SAME slice reference (pointer return).
		it('empty UUID returns the same slice reference (no copy)', () => {
			const lines = parseFromBytes(data);
			expect(truncateAtUUID(lines, '')).toBe(lines);
		});
	});

	// --- FindCheckpointUUID (Go: TestFindCheckpointUUID) ---

	describe('findCheckpointUUID', () => {
		const data = `{"type":"assistant","uuid":"a1","message":{"content":[{"type":"tool_use","id":"tool1"}]}}
{"type":"user","uuid":"u1","message":{"content":[{"type":"tool_result","tool_use_id":"tool1"}]}}
{"type":"assistant","uuid":"a2","message":{"content":[{"type":"tool_use","id":"tool2"}]}}
{"type":"user","uuid":"u2","message":{"content":[{"type":"tool_result","tool_use_id":"tool2"}]}}
`;
		const cases: Array<{ toolUseId: string; want: string | null }> = [
			// Go: transcript_test.go:175-181 (table)
			{ toolUseId: 'tool1', want: 'u1' },
			{ toolUseId: 'tool2', want: 'u2' },
			{ toolUseId: 'unknown', want: null },
		];
		for (const c of cases) {
			it(`maps tool_use_id="${c.toolUseId}" → ${c.want === null ? 'null' : `"${c.want}"`}`, () => {
				const lines = parseFromBytes(data);
				expect(findCheckpointUUID(lines, c.toolUseId)).toBe(c.want);
			});
		}
	});

	// --- CalculateTokenUsage (Go: TestCalculateTokenUsage_*) ---

	describe('calculateTokenUsage', () => {
		// Go: transcript_test.go:199-246 (TestCalculateTokenUsage_BasicMessages)
		it('sums tokens across distinct message ids', () => {
			const lines: TranscriptLine[] = [
				{
					type: 'assistant',
					uuid: 'asst-1',
					message: {
						id: 'msg_001',
						usage: {
							input_tokens: 10,
							cache_creation_input_tokens: 100,
							cache_read_input_tokens: 50,
							output_tokens: 20,
						},
					},
				},
				{
					type: 'assistant',
					uuid: 'asst-2',
					message: {
						id: 'msg_002',
						usage: {
							input_tokens: 5,
							cache_creation_input_tokens: 200,
							cache_read_input_tokens: 0,
							output_tokens: 30,
						},
					},
				},
			];
			const usage = calculateTokenUsage(lines);
			expect(usage.apiCallCount).toBe(2);
			expect(usage.inputTokens).toBe(15);
			expect(usage.cacheCreationTokens).toBe(300);
			expect(usage.cacheReadTokens).toBe(50);
			expect(usage.outputTokens).toBe(50);
		});

		// Go: transcript_test.go:248-305 (TestCalculateTokenUsage_StreamingDeduplication)
		it('dedupes by max output_tokens per id (streaming)', () => {
			const lines: TranscriptLine[] = [
				{
					type: 'assistant',
					uuid: 'asst-1',
					message: {
						id: 'msg_001',
						usage: {
							input_tokens: 10,
							cache_creation_input_tokens: 100,
							cache_read_input_tokens: 50,
							output_tokens: 1, // first chunk
						},
					},
				},
				{
					type: 'assistant',
					uuid: 'asst-2',
					message: {
						id: 'msg_001', // same id
						usage: {
							input_tokens: 10,
							cache_creation_input_tokens: 100,
							cache_read_input_tokens: 50,
							output_tokens: 5,
						},
					},
				},
				{
					type: 'assistant',
					uuid: 'asst-3',
					message: {
						id: 'msg_001', // same id
						usage: {
							input_tokens: 10,
							cache_creation_input_tokens: 100,
							cache_read_input_tokens: 50,
							output_tokens: 20, // final
						},
					},
				},
			];
			const usage = calculateTokenUsage(lines);
			expect(usage.apiCallCount).toBe(1);
			expect(usage.outputTokens).toBe(20);
			expect(usage.inputTokens).toBe(10);
		});

		// Go: transcript_test.go:307-334 (TestCalculateTokenUsage_IgnoresUserMessages)
		it('skips user-type lines', () => {
			const lines: TranscriptLine[] = [
				{ type: 'user', uuid: 'user-1', message: { content: 'hello' } },
				{
					type: 'assistant',
					uuid: 'asst-1',
					message: {
						id: 'msg_001',
						usage: {
							input_tokens: 10,
							cache_creation_input_tokens: 100,
							cache_read_input_tokens: 0,
							output_tokens: 20,
						},
					},
				},
			];
			expect(calculateTokenUsage(lines).apiCallCount).toBe(1);
		});

		// Go: transcript_test.go:336-345 (TestCalculateTokenUsage_EmptyTranscript)
		it('empty transcript returns zero usage', () => {
			const u = calculateTokenUsage([]);
			expect(u.apiCallCount).toBe(0);
			expect(u.inputTokens).toBe(0);
			expect(u.cacheCreationTokens).toBe(0);
			expect(u.cacheReadTokens).toBe(0);
			expect(u.outputTokens).toBe(0);
		});

		// Story 失败路径：missing id, malformed message, missing usage all skip silently.
		it('skips assistant lines without id / usage / parseable message', () => {
			const lines: TranscriptLine[] = [
				{ type: 'assistant', uuid: 'a1', message: { usage: { output_tokens: 5 } } }, // no id
				{ type: 'assistant', uuid: 'a2', message: { id: 'm1' } }, // no usage
				{ type: 'assistant', uuid: 'a3', message: 'not parseable string' as unknown },
				{ type: 'assistant', uuid: 'a4' }, // no message
			];
			expect(calculateTokenUsage(lines).apiCallCount).toBe(0);
		});
	});

	describe('calculateTokenUsageFromFile', () => {
		let tmpDir: string;
		beforeEach(async () => {
			tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-token-'));
		});
		afterEach(async () => {
			await fs.rm(tmpDir, { recursive: true, force: true });
		});

		// Go: transcript.go:185-197 (CalculateTokenUsageFromFile empty path → zero)
		it('empty path returns zero usage (no fs read)', async () => {
			const u = await calculateTokenUsageFromFile('', 0);
			expect(u.apiCallCount).toBe(0);
		});

		it('reads JSONL file and dedupes by id', async () => {
			const file = path.join(tmpDir, 't.jsonl');
			await fs.writeFile(
				file,
				`{"type":"assistant","uuid":"a1","message":{"id":"m1","usage":{"input_tokens":10,"output_tokens":20,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}\n`,
			);
			const u = await calculateTokenUsageFromFile(file, 0);
			expect(u.apiCallCount).toBe(1);
			expect(u.outputTokens).toBe(20);
		});
	});

	// --- ExtractSpawnedAgentIDs (Go: TestExtractSpawnedAgentIDs_*) ---

	describe('extractSpawnedAgentIds', () => {
		// Go: transcript_test.go:347-377 (TestExtractSpawnedAgentIDs_FromToolResult)
		it('finds agentId in array-text content', () => {
			const lines: TranscriptLine[] = [
				{
					type: 'user',
					uuid: 'user-1',
					message: {
						content: [
							{
								type: 'tool_result',
								tool_use_id: 'toolu_abc123',
								content: [
									{ type: 'text', text: 'Result from agent\n\nagentId: ac66d4b (for resuming)' },
								],
							},
						],
					},
				},
			];
			const m = extractSpawnedAgentIds(lines);
			expect(m.size).toBe(1);
			expect(m.get('ac66d4b')).toBe('toolu_abc123');
		});

		// Go: transcript_test.go:379-424 (TestExtractSpawnedAgentIDs_MultipleAgents)
		it('handles multiple user lines with different agents', () => {
			const lines: TranscriptLine[] = [
				{
					type: 'user',
					uuid: 'u1',
					message: {
						content: [
							{
								type: 'tool_result',
								tool_use_id: 'toolu_001',
								content: [{ type: 'text', text: 'agentId: aaa1111' }],
							},
						],
					},
				},
				{
					type: 'user',
					uuid: 'u2',
					message: {
						content: [
							{
								type: 'tool_result',
								tool_use_id: 'toolu_002',
								content: [{ type: 'text', text: 'agentId: bbb2222' }],
							},
						],
					},
				},
			];
			const m = extractSpawnedAgentIds(lines);
			expect(m.size).toBe(2);
			expect(m.get('aaa1111')).toBe('toolu_001');
			expect(m.get('bbb2222')).toBe('toolu_002');
		});

		// Go: transcript_test.go:426-450 (TestExtractSpawnedAgentIDs_NoAgentID)
		it('returns empty map when no agentId text present', () => {
			const lines: TranscriptLine[] = [
				{
					type: 'user',
					uuid: 'u1',
					message: {
						content: [
							{
								type: 'tool_result',
								tool_use_id: 'toolu_001',
								content: [{ type: 'text', text: 'Some result without agent ID' }],
							},
						],
					},
				},
			];
			expect(extractSpawnedAgentIds(lines).size).toBe(0);
		});

		// Story 补充：plain string content (vs array-of-text).
		// Go: transcript.go:249-255 (Try as plain string fallback) — covered indirectly
		// by makeTaskResultLine helper which produces `content: "agentId: <id>"` (string).
		it('handles tool_result content as plain string (Go: makeTaskResultLine helper)', () => {
			const lines: TranscriptLine[] = [
				{
					type: 'user',
					uuid: 'u1',
					message: {
						content: [
							{
								type: 'tool_result',
								tool_use_id: 'toolu_xyz',
								content: 'agentId: zzz9999',
							},
						],
					},
				},
			];
			const m = extractSpawnedAgentIds(lines);
			expect(m.get('zzz9999')).toBe('toolu_xyz');
		});
	});

	// --- extractAgentIdFromText (Go: TestExtractAgentIDFromText) ---

	describe('extractAgentIdFromText', () => {
		// Go: transcript_test.go:452-493 (table)
		const cases: Array<{ name: string; text: string; want: string }> = [
			{ name: 'standard format', text: 'agentId: ac66d4b (for resuming)', want: 'ac66d4b' },
			{ name: 'at end of text', text: 'Result text\n\nagentId: abc1234', want: 'abc1234' },
			{ name: 'no agent ID', text: 'Some text without agent ID', want: '' },
			{ name: 'empty text', text: '', want: '' },
			{ name: 'agent ID with newline after', text: 'agentId: xyz9999\nMore text', want: 'xyz9999' },
		];
		for (const c of cases) {
			it(c.name, () => {
				expect(extractAgentIdFromText(c.text)).toBe(c.want);
			});
		}

		// Story 失败路径：empty after prefix.
		it('empty id after prefix → empty string', () => {
			expect(extractAgentIdFromText('agentId: ')).toBe('');
			expect(extractAgentIdFromText('agentId: !!!')).toBe('');
		});

		// Story 补充 (Go-strict ASCII): underscore / dash break the run.
		it('underscore / dash break the alphanumeric run (Go: text[end] >= chars only)', () => {
			expect(extractAgentIdFromText('agentId: foo_bar')).toBe('foo');
			expect(extractAgentIdFromText('agentId: foo-bar')).toBe('foo');
		});
	});

	// --- CalculateTotalTokenUsage (Go: TestCalculateTotalTokenUsage_PerCheckpoint) ---

	describe('calculateTotalTokenUsage', () => {
		// Go: transcript_test.go:510-575 (TestCalculateTotalTokenUsage_PerCheckpoint)
		it('per-checkpoint token usage at multiple startLines (subagentsDir empty)', async () => {
			// Build transcript with 3 turns (6 lines):
			// 0: user 1
			// 1: assistant 1 (100/50)
			// 2: user 2
			// 3: assistant 2 (200/100)
			// 4: user 3
			// 5: assistant 3 (300/150)
			const data = bytes(
				`{"type":"user","uuid":"u1","message":{"content":"first prompt"}}\n` +
					`{"type":"assistant","uuid":"a1","message":{"id":"m1","usage":{"input_tokens":100,"output_tokens":50,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}\n` +
					`{"type":"user","uuid":"u2","message":{"content":"second prompt"}}\n` +
					`{"type":"assistant","uuid":"a2","message":{"id":"m2","usage":{"input_tokens":200,"output_tokens":100,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}\n` +
					`{"type":"user","uuid":"u3","message":{"content":"third prompt"}}\n` +
					`{"type":"assistant","uuid":"a3","message":{"id":"m3","usage":{"input_tokens":300,"output_tokens":150,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}\n`,
			);

			// From line 0: all 3 turns
			const u1 = await calculateTotalTokenUsage(data, 0, '');
			expect(u1.inputTokens).toBe(600);
			expect(u1.outputTokens).toBe(300);
			expect(u1.apiCallCount).toBe(3);

			// From line 2 (after turn 1): turns 2+3
			const u2 = await calculateTotalTokenUsage(data, 2, '');
			expect(u2.inputTokens).toBe(500);
			expect(u2.outputTokens).toBe(250);
			expect(u2.apiCallCount).toBe(2);

			// From line 4 (after turns 1+2): turn 3 only
			const u3 = await calculateTotalTokenUsage(data, 4, '');
			expect(u3.inputTokens).toBe(300);
			expect(u3.outputTokens).toBe(150);
			expect(u3.apiCallCount).toBe(1);
		});

		// Story 边界：empty data → zero usage, no parse, no fs read.
		it('empty data returns zero usage without parse', async () => {
			const u = await calculateTotalTokenUsage(new Uint8Array(), 0, '/tmp/nonexistent');
			expect(u.apiCallCount).toBe(0);
			expect(u.subagentTokens).toBeUndefined();
		});

		// Story 失败路径：subagent file missing → swallow, no subagentTokens.
		// Go: transcript.go:316-320 (continue on agentErr).
		it('swallows missing subagent files; subagentTokens unset when no subagent contributed', async () => {
			const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-sub-'));
			try {
				// Main: Task spawn pointing at agentId 'sub_does_not_exist'
				const data = buildJSONL(
					`{"type":"assistant","uuid":"a1","message":{"content":[{"type":"tool_use","id":"toolu_x","name":"Task","input":{"prompt":"do x"}}]}}`,
					`{"type":"user","uuid":"u1","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_x","content":"agentId: subdoesnotexist"}]}}`,
				);
				const u = await calculateTotalTokenUsage(data, 0, tmp);
				expect(u.apiCallCount).toBe(0); // main has no usage
				expect(u.subagentTokens).toBeUndefined(); // file missing → swallow
			} finally {
				await fs.rm(tmp, { recursive: true, force: true });
			}
		});

		// Story 补充：subagent contributes tokens → subagentTokens populated.
		it('merges subagent usage into subagentTokens when subagent file exists', async () => {
			const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-sub-'));
			try {
				await fs.writeFile(
					path.join(tmp, 'agent-subOne.jsonl'),
					`{"type":"assistant","uuid":"sa1","message":{"id":"sm1","usage":{"input_tokens":7,"output_tokens":11,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}\n`,
				);
				const data = buildJSONL(
					`{"type":"assistant","uuid":"a1","message":{"content":[{"type":"tool_use","id":"toolu_x","name":"Task","input":{"prompt":"go"}}]}}`,
					`{"type":"user","uuid":"u1","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_x","content":"agentId: subOne"}]}}`,
				);
				const u = await calculateTotalTokenUsage(data, 0, tmp);
				expect(u.subagentTokens).toBeDefined();
				expect(u.subagentTokens?.inputTokens).toBe(7);
				expect(u.subagentTokens?.outputTokens).toBe(11);
				expect(u.subagentTokens?.apiCallCount).toBe(1);
			} finally {
				await fs.rm(tmp, { recursive: true, force: true });
			}
		});
	});

	// --- ExtractAllModifiedFiles (Go: TestExtractAllModifiedFiles_*) ---

	describe('extractAllModifiedFiles', () => {
		let tmpDir: string;
		beforeEach(async () => {
			tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-allmod-'));
		});
		afterEach(async () => {
			await fs.rm(tmpDir, { recursive: true, force: true });
		});

		// Go: transcript_test.go:683-730 (TestExtractAllModifiedFiles_IncludesSubagentFiles)
		it('merges main + subagent files (3 distinct paths)', async () => {
			const subDir = path.join(tmpDir, 'tasks', 'toolu_task1');
			await fs.mkdir(subDir, { recursive: true });
			await fs.writeFile(
				path.join(subDir, 'agent-sub1.jsonl'),
				`{"type":"assistant","uuid":"sa1","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"/repo/helper.go"}}]}}\n` +
					`{"type":"assistant","uuid":"sa2","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"/repo/utils.go"}}]}}\n`,
			);
			const data = buildJSONL(
				`{"type":"assistant","uuid":"a1","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"/repo/main.go"}}]}}`,
				`{"type":"assistant","uuid":"a2","message":{"content":[{"type":"tool_use","id":"toolu_task1","name":"Task","input":{"prompt":"do something"}}]}}`,
				`{"type":"user","uuid":"u1","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_task1","content":"agentId: sub1"}]}}`,
			);
			const files = await extractAllModifiedFiles(data, 0, subDir);
			expect(files.sort()).toEqual(['/repo/helper.go', '/repo/main.go', '/repo/utils.go']);
		});

		// Go: transcript_test.go:732-766 (TestExtractAllModifiedFiles_DeduplicatesAcrossAgents)
		it('dedupes when main + subagent touch the same file', async () => {
			const subDir = path.join(tmpDir, 'tasks', 'toolu_task1');
			await fs.mkdir(subDir, { recursive: true });
			await fs.writeFile(
				path.join(subDir, 'agent-sub1.jsonl'),
				`{"type":"assistant","uuid":"sa1","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"/repo/shared.go"}}]}}\n`,
			);
			const data = buildJSONL(
				`{"type":"assistant","uuid":"a1","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"/repo/shared.go"}}]}}`,
				`{"type":"assistant","uuid":"a2","message":{"content":[{"type":"tool_use","id":"toolu_task1","name":"Task","input":{}}]}}`,
				`{"type":"user","uuid":"u1","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_task1","content":"agentId: sub1"}]}}`,
			);
			const files = await extractAllModifiedFiles(data, 0, subDir);
			expect(files).toEqual(['/repo/shared.go']);
		});

		// Go: transcript_test.go:768-790 (TestExtractAllModifiedFiles_NoSubagents)
		it('with non-existent subagent dir does not error; returns main files', async () => {
			const data = buildJSONL(
				`{"type":"assistant","uuid":"a1","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"/repo/solo.go"}}]}}`,
			);
			const files = await extractAllModifiedFiles(data, 0, path.join(tmpDir, 'nonexistent'));
			expect(files).toEqual(['/repo/solo.go']);
		});

		// Go: transcript_test.go:792-839 (TestExtractAllModifiedFiles_SubagentOnlyChanges)
		it('subagent-only file changes when main has only Task call', async () => {
			const subDir = path.join(tmpDir, 'tasks', 'toolu_task1');
			await fs.mkdir(subDir, { recursive: true });
			await fs.writeFile(
				path.join(subDir, 'agent-sub1.jsonl'),
				`{"type":"assistant","uuid":"sa1","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"/repo/subagent_file1.go"}}]}}\n` +
					`{"type":"assistant","uuid":"sa2","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"/repo/subagent_file2.go"}}]}}\n`,
			);
			const data = buildJSONL(
				`{"type":"assistant","uuid":"a1","message":{"content":[{"type":"tool_use","id":"toolu_task1","name":"Task","input":{}}]}}`,
				`{"type":"user","uuid":"u1","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_task1","content":"agentId: sub1"}]}}`,
			);
			const files = await extractAllModifiedFiles(data, 0, subDir);
			expect(files.sort()).toEqual(['/repo/subagent_file1.go', '/repo/subagent_file2.go']);
		});

		// Story 边界：empty data → empty array.
		it('empty data returns []', async () => {
			expect(await extractAllModifiedFiles(new Uint8Array(), 0, '/tmp/dir')).toEqual([]);
		});

		// Story 边界：empty subagentsDir skips subagent enumeration.
		it('empty subagentsDir skips subagent enumeration', async () => {
			const data = buildJSONL(
				`{"type":"assistant","uuid":"a1","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"/repo/main.go"}}]}}`,
				`{"type":"assistant","uuid":"a2","message":{"content":[{"type":"tool_use","id":"toolu_x","name":"Task","input":{}}]}}`,
				`{"type":"user","uuid":"u1","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_x","content":"agentId: sub1"}]}}`,
			);
			const files = await extractAllModifiedFiles(data, 0, '');
			expect(files).toEqual(['/repo/main.go']);
		});
	});
});
