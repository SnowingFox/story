/**
 * Tests for `src/agent/cursor/lifecycle.ts` — Mirrors Go
 * `entire-cli/cmd/entire/cli/agent/cursor/lifecycle.go` + `lifecycle_test.go`.
 *
 * Covers:
 * - intFromJSON: 5 cases (null / '' / numeric string / non-numeric / number)
 * - parseHookEvent 7-verb dispatch + IDE/CLI variants (16 case)
 * - Fast-skip: subagent task='' / unknown verb / empty stdin / malformed (6 case)
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { CursorAgent } from '@/agent/cursor';
import { intFromJSON } from '@/agent/cursor/lifecycle';
import {
	HOOK_NAME_BEFORE_SUBMIT_PROMPT,
	HOOK_NAME_PRE_COMPACT,
	HOOK_NAME_SESSION_END,
	HOOK_NAME_SESSION_START,
	HOOK_NAME_STOP,
	HOOK_NAME_SUBAGENT_START,
	HOOK_NAME_SUBAGENT_STOP,
} from '@/agent/cursor/types';
import {
	EVENT_TYPE_COMPACTION,
	EVENT_TYPE_SESSION_END,
	EVENT_TYPE_SESSION_START,
	EVENT_TYPE_SUBAGENT_END,
	EVENT_TYPE_SUBAGENT_START,
	EVENT_TYPE_TURN_END,
	EVENT_TYPE_TURN_START,
} from '@/agent/event';

function stdin(payload: string): NodeJS.ReadableStream {
	return Readable.from([payload]);
}

describe('agent/cursor/lifecycle — Go: cursor/lifecycle.go + lifecycle_test.go', () => {
	describe('intFromJSON', () => {
		// Go: lifecycle.go:18-24 intFromJSON (5 fail-safe paths)
		it('null → 0', () => {
			expect(intFromJSON(null)).toBe(0);
		});
		it('"" → 0', () => {
			expect(intFromJSON('')).toBe(0);
		});
		it('"123" → 123', () => {
			expect(intFromJSON('123')).toBe(123);
		});
		it('"abc" → 0 (parseInt fails)', () => {
			expect(intFromJSON('abc')).toBe(0);
		});
		it('123 (number) → 123', () => {
			expect(intFromJSON(123)).toBe(123);
		});
		// Story branch coverage: bool / array / object input fall to the default 0
		it('boolean / array / object → 0 (fall-safe default)', () => {
			expect(intFromJSON(true)).toBe(0);
			expect(intFromJSON([1, 2])).toBe(0);
			expect(intFromJSON({ a: 1 })).toBe(0);
		});
		// Story branch coverage: NaN / Infinity → 0
		it('NaN / Infinity → 0', () => {
			expect(intFromJSON(Number.NaN)).toBe(0);
			expect(intFromJSON(Number.POSITIVE_INFINITY)).toBe(0);
		});
	});

	describe('parseHookEvent 7-verb dispatch', () => {
		const a = new CursorAgent();

		// Go: lifecycle_test.go:20-44 TestParseHookEvent_SessionStart
		it('session-start basic → SessionStart event', async () => {
			const ev = await a.parseHookEvent(
				HOOK_NAME_SESSION_START,
				stdin('{"conversation_id":"test-session-123","transcript_path":"/tmp/transcript.jsonl"}'),
			);
			expect(ev).not.toBeNull();
			expect(ev?.type).toBe(EVENT_TYPE_SESSION_START);
			expect(ev?.sessionId).toBe('test-session-123');
			expect(ev?.sessionRef).toBe('/tmp/transcript.jsonl');
			expect(ev?.timestamp.getTime()).toBeGreaterThan(0);
		});

		// Go: lifecycle_test.go:46-61 TestParseHookEvent_SessionStart_IncludesModel
		it('session-start IncludesModel → event.model === "gpt-4o"', async () => {
			const ev = await a.parseHookEvent(
				HOOK_NAME_SESSION_START,
				stdin('{"conversation_id":"sm","transcript_path":"/tmp/t.jsonl","model":"gpt-4o"}'),
			);
			expect(ev?.model).toBe('gpt-4o');
		});

		// Go: lifecycle_test.go:63-78 TestParseHookEvent_SessionStart_EmptyModel
		it('session-start EmptyModel → event.model === ""', async () => {
			const ev = await a.parseHookEvent(
				HOOK_NAME_SESSION_START,
				stdin('{"conversation_id":"snm","transcript_path":"/tmp/t.jsonl"}'),
			);
			expect(ev?.model).toBe('');
		});

		// Go: lifecycle_test.go:80-101 TestParseHookEvent_TurnStart
		it('before-submit-prompt basic → TurnStart with prompt="Hello world"', async () => {
			const ev = await a.parseHookEvent(
				HOOK_NAME_BEFORE_SUBMIT_PROMPT,
				stdin(
					'{"conversation_id":"sess-456","transcript_path":"/tmp/t.jsonl","prompt":"Hello world"}',
				),
			);
			expect(ev?.type).toBe(EVENT_TYPE_TURN_START);
			expect(ev?.sessionId).toBe('sess-456');
			expect(ev?.prompt).toBe('Hello world');
		});

		// Go: lifecycle_test.go:103-117 TestParseHookEvent_TurnStart_IncludesModel
		it('before-submit-prompt IncludesModel', async () => {
			const ev = await a.parseHookEvent(
				HOOK_NAME_BEFORE_SUBMIT_PROMPT,
				stdin(
					'{"conversation_id":"m","transcript_path":"/tmp/t.jsonl","prompt":"hi","model":"gpt-4o"}',
				),
			);
			expect(ev?.model).toBe('gpt-4o');
		});

		// Go: lifecycle_test.go:119-133 TestParseHookEvent_TurnStart_EmptyModel
		it('before-submit-prompt EmptyModel', async () => {
			const ev = await a.parseHookEvent(
				HOOK_NAME_BEFORE_SUBMIT_PROMPT,
				stdin('{"conversation_id":"nm","transcript_path":"/tmp/t.jsonl","prompt":"hi"}'),
			);
			expect(ev?.model).toBe('');
		});

		// Go: lifecycle_test.go:135-164 TestParseHookEvent_TurnStart_CLINoTranscriptPath
		it('before-submit-prompt CLI no transcript_path → resolved via flat path', async () => {
			let tmpDir: string;
			tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cursor-tp-'));
			try {
				const transcriptFile = path.join(tmpDir, 'cli-turn-start.jsonl');
				await fs.writeFile(transcriptFile, '{"role":"user"}\n');
				const orig = process.env.STORY_TEST_CURSOR_PROJECT_DIR;
				process.env.STORY_TEST_CURSOR_PROJECT_DIR = tmpDir;
				try {
					const ev = await a.parseHookEvent(
						HOOK_NAME_BEFORE_SUBMIT_PROMPT,
						stdin('{"conversation_id":"cli-turn-start","prompt":"Hello"}'),
					);
					expect(ev?.type).toBe(EVENT_TYPE_TURN_START);
					expect(ev?.sessionRef).toBe(transcriptFile);
					expect(ev?.prompt).toBe('Hello');
				} finally {
					if (orig === undefined) {
						delete process.env.STORY_TEST_CURSOR_PROJECT_DIR;
					} else {
						process.env.STORY_TEST_CURSOR_PROJECT_DIR = orig;
					}
				}
			} finally {
				await fs.rm(tmpDir, { recursive: true, force: true });
			}
		});

		// Go: lifecycle_test.go:166-184 TestParseHookEvent_TurnEnd
		it('stop basic → TurnEnd event', async () => {
			const ev = await a.parseHookEvent(
				HOOK_NAME_STOP,
				stdin('{"conversation_id":"sess-789","transcript_path":"/tmp/stop.jsonl"}'),
			);
			expect(ev?.type).toBe(EVENT_TYPE_TURN_END);
			expect(ev?.sessionId).toBe('sess-789');
		});

		// Go: lifecycle_test.go:223-258 TestParseHookEvent_TurnEnd_CLINoTranscriptPath
		it('stop CLI no transcript_path → flat path resolved + turnCount=3', async () => {
			let tmpDir: string;
			tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cursor-te-'));
			try {
				const transcriptDir = path.join(tmpDir, 'agent-transcripts');
				await fs.mkdir(transcriptDir, { recursive: true });
				const transcriptFile = path.join(transcriptDir, 'cli-session-id.jsonl');
				await fs.writeFile(transcriptFile, '{"role":"user"}');
				const orig = process.env.STORY_TEST_CURSOR_PROJECT_DIR;
				process.env.STORY_TEST_CURSOR_PROJECT_DIR = transcriptDir;
				try {
					const ev = await a.parseHookEvent(
						HOOK_NAME_STOP,
						stdin('{"conversation_id":"cli-session-id","status":"completed","loop_count":3}'),
					);
					expect(ev?.type).toBe(EVENT_TYPE_TURN_END);
					expect(ev?.sessionRef).toBe(transcriptFile);
					expect(ev?.turnCount).toBe(3);
				} finally {
					if (orig === undefined) {
						delete process.env.STORY_TEST_CURSOR_PROJECT_DIR;
					} else {
						process.env.STORY_TEST_CURSOR_PROJECT_DIR = orig;
					}
				}
			} finally {
				await fs.rm(tmpDir, { recursive: true, force: true });
			}
		});

		// Go: lifecycle_test.go:297-313 TestParseHookEvent_TurnEnd_IDEWithTranscriptPath
		it('stop IDE with transcript_path → uses raw path (no resolution)', async () => {
			const idePath =
				'/home/user/.cursor/projects/proj/agent-transcripts/ide-session/ide-session.jsonl';
			const ev = await a.parseHookEvent(
				HOOK_NAME_STOP,
				stdin(
					`{"conversation_id":"ide-session","transcript_path":"${idePath}","status":"completed","loop_count":5}`,
				),
			);
			expect(ev?.sessionRef).toBe(idePath);
		});

		// Go: lifecycle_test.go:186-204 TestParseHookEvent_SessionEnd
		it('session-end basic → SessionEnd event', async () => {
			const ev = await a.parseHookEvent(
				HOOK_NAME_SESSION_END,
				stdin('{"conversation_id":"ending-session","transcript_path":"/tmp/end.jsonl"}'),
			);
			expect(ev?.type).toBe(EVENT_TYPE_SESSION_END);
			expect(ev?.sessionId).toBe('ending-session');
		});

		// Go: lifecycle_test.go:206-221 TestParseHookEvent_SessionEnd_IncludesModel
		it('session-end IncludesModel', async () => {
			const ev = await a.parseHookEvent(
				HOOK_NAME_SESSION_END,
				stdin('{"conversation_id":"em","transcript_path":"/tmp/e.jsonl","model":"gpt-4o"}'),
			);
			expect(ev?.model).toBe('gpt-4o');
		});

		// Go: lifecycle_test.go:260-295 TestParseHookEvent_SessionEnd_CLINoTranscriptPath
		it('session-end CLI no transcript_path → flat path resolved + duration_ms=45000', async () => {
			let tmpDir: string;
			tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cursor-se-'));
			try {
				const transcriptDir = path.join(tmpDir, 'agent-transcripts');
				await fs.mkdir(transcriptDir, { recursive: true });
				const transcriptFile = path.join(transcriptDir, 'cli-end-session.jsonl');
				await fs.writeFile(transcriptFile, '{"role":"user"}');
				const orig = process.env.STORY_TEST_CURSOR_PROJECT_DIR;
				process.env.STORY_TEST_CURSOR_PROJECT_DIR = transcriptDir;
				try {
					const ev = await a.parseHookEvent(
						HOOK_NAME_SESSION_END,
						stdin(
							'{"conversation_id":"cli-end-session","reason":"user_closed","duration_ms":45000,"is_background_agent":false,"final_status":"completed"}',
						),
					);
					expect(ev?.type).toBe(EVENT_TYPE_SESSION_END);
					expect(ev?.sessionRef).toBe(transcriptFile);
					expect(ev?.durationMs).toBe(45000);
				} finally {
					if (orig === undefined) {
						delete process.env.STORY_TEST_CURSOR_PROJECT_DIR;
					} else {
						process.env.STORY_TEST_CURSOR_PROJECT_DIR = orig;
					}
				}
			} finally {
				await fs.rm(tmpDir, { recursive: true, force: true });
			}
		});

		// Go: lifecycle_test.go:383-407 TestParseHookEvent_PreCompact
		it('pre-compact → Compaction event with contextTokens=8500, contextWindowSize=16000', async () => {
			const ev = await a.parseHookEvent(
				HOOK_NAME_PRE_COMPACT,
				stdin(
					'{"conversation_id":"compact-session","transcript_path":"/tmp/compact.jsonl","context_tokens":8500,"context_window_size":16000}',
				),
			);
			expect(ev?.type).toBe(EVENT_TYPE_COMPACTION);
			expect(ev?.sessionId).toBe('compact-session');
			expect(ev?.contextTokens).toBe(8500);
			expect(ev?.contextWindowSize).toBe(16000);
		});

		// Go: lifecycle_test.go:315-345 TestParseHookEvent_SubagentStart
		it('subagent-start → SubagentStart with subagentId + toolUseId === subagentId', async () => {
			const payload = JSON.stringify({
				conversation_id: 'main-session',
				transcript_path: '/tmp/main.jsonl',
				subagent_id: 'sub_abc123',
				task: 'do something',
			});
			const ev = await a.parseHookEvent(HOOK_NAME_SUBAGENT_START, stdin(payload));
			expect(ev?.type).toBe(EVENT_TYPE_SUBAGENT_START);
			expect(ev?.sessionId).toBe('main-session');
			expect(ev?.toolUseId).toBe('sub_abc123');
			expect(ev?.subagentId).toBe('sub_abc123');
			expect(ev?.taskDescription).toBe('do something');
		});

		// Go: lifecycle_test.go:347-381 TestParseHookEvent_SubagentEnd
		it('subagent-stop → SubagentEnd with modifiedFiles', async () => {
			const payload = JSON.stringify({
				conversation_id: 'main-session',
				transcript_path: '/tmp/main.jsonl',
				subagent_id: 'sub_xyz789',
				task: 'task done',
				modified_files: ['src/foo.ts', 'src/bar.ts'],
			});
			const ev = await a.parseHookEvent(HOOK_NAME_SUBAGENT_STOP, stdin(payload));
			expect(ev?.type).toBe(EVENT_TYPE_SUBAGENT_END);
			expect(ev?.toolUseId).toBe('sub_xyz789');
			expect(ev?.modifiedFiles).toEqual(['src/foo.ts', 'src/bar.ts']);
		});
	});

	describe('parseHookEvent fast-skip + error', () => {
		const a = new CursorAgent();

		// Go: lifecycle_test.go:409-423 TestParseHookEvent_UnknownHook_ReturnsNil
		it('unknown verb → null (no lifecycle action)', async () => {
			const ev = await a.parseHookEvent(
				'unknown-hook-name',
				stdin('{"session_id":"x","transcript_path":"/tmp/x.jsonl"}'),
			);
			expect(ev).toBeNull();
		});

		// Go: lifecycle_test.go:425-438 TestParseHookEvent_EmptyInput_ReturnsError
		it('empty stdin → throws "empty hook input"', async () => {
			await expect(a.parseHookEvent(HOOK_NAME_SESSION_START, stdin(''))).rejects.toThrow(
				/empty hook input/,
			);
		});

		// Go: lifecycle_test.go:498-512 TestParseHookEvent_MalformedJSON
		it('malformed JSON → throws "failed to parse hook input"', async () => {
			await expect(
				a.parseHookEvent(
					HOOK_NAME_SESSION_START,
					stdin('{"session_id":"test","transcript_path":INVALID}'),
				),
			).rejects.toThrow(/failed to parse hook input/);
		});

		// Go fast-skip: lifecycle.go:161-163 (parseSubagentStart task=='' → nil)
		it('subagent-start task="" → null (spurious skip)', async () => {
			const payload = JSON.stringify({
				conversation_id: 'm',
				transcript_path: '/tmp/m.jsonl',
				subagent_id: 's',
				task: '',
			});
			expect(await a.parseHookEvent(HOOK_NAME_SUBAGENT_START, stdin(payload))).toBeNull();
		});

		// Go fast-skip: lifecycle.go:181-183 (parseSubagentStop task=='' → nil)
		it('subagent-stop task="" → null (spurious skip)', async () => {
			const payload = JSON.stringify({
				conversation_id: 'm',
				transcript_path: '/tmp/m.jsonl',
				subagent_id: 's',
				task: '',
			});
			expect(await a.parseHookEvent(HOOK_NAME_SUBAGENT_STOP, stdin(payload))).toBeNull();
		});

		// Story branch coverage: each parser with all optional fields omitted
		// (exercises the `?? ''` / `?? []` nullish-coalescing fallbacks).
		it('parseSessionStart with no optional fields → all zero defaults', async () => {
			const ev = await a.parseHookEvent(HOOK_NAME_SESSION_START, stdin('{"conversation_id":"x"}'));
			expect(ev?.sessionRef).toBe('');
			expect(ev?.model).toBe('');
		});

		it('parseTurnStart with omitted prompt + model → both ""', async () => {
			const ev = await a.parseHookEvent(
				HOOK_NAME_BEFORE_SUBMIT_PROMPT,
				stdin('{"conversation_id":"x","transcript_path":"/t"}'),
			);
			expect(ev?.prompt).toBe('');
			expect(ev?.model).toBe('');
		});

		it('parseTurnEnd with no model + no loop_count → defaults', async () => {
			const ev = await a.parseHookEvent(
				HOOK_NAME_STOP,
				stdin('{"conversation_id":"x","transcript_path":"/t"}'),
			);
			expect(ev?.model).toBe('');
			expect(ev?.turnCount).toBe(0);
		});

		it('parseSessionEnd with no model + no duration_ms → defaults', async () => {
			const ev = await a.parseHookEvent(
				HOOK_NAME_SESSION_END,
				stdin('{"conversation_id":"x","transcript_path":"/t"}'),
			);
			expect(ev?.model).toBe('');
			expect(ev?.durationMs).toBe(0);
		});

		// Branch: parseSubagentStart with task field omitted entirely (undefined)
		it('parseSubagentStart with task undefined → null (fast-skip)', async () => {
			const ev = await a.parseHookEvent(
				HOOK_NAME_SUBAGENT_START,
				stdin('{"conversation_id":"m","subagent_id":"s"}'),
			);
			expect(ev).toBeNull();
		});

		it('parseSubagentStop with task undefined → null (fast-skip)', async () => {
			const ev = await a.parseHookEvent(
				HOOK_NAME_SUBAGENT_STOP,
				stdin('{"conversation_id":"m","subagent_id":"s"}'),
			);
			expect(ev).toBeNull();
		});

		// Story branch coverage: resolveTranscriptRef getSessionDir failure path.
		// Worktree resolves OK (we're in a real git repo: project root) but a
		// shimmed `getSessionDir` throws — exercises lines 150-154 (the second
		// log.warn path).
		it('CLI mode + getSessionDir throws → returns event with empty sessionRef', async () => {
			const { parseHookEvent } = await import('@/agent/cursor/lifecycle');
			// Create a CursorAgent-like `this` whose getSessionDir always throws.
			const stubAgent = Object.assign(new CursorAgent(), {
				getSessionDir: async () => {
					throw new Error('forced failure for branch coverage');
				},
			});
			const ev = await parseHookEvent.call(
				stubAgent,
				HOOK_NAME_STOP,
				stdin('{"conversation_id":"orphan"}'),
			);
			expect(ev?.type).toBe(EVENT_TYPE_TURN_END);
			expect(ev?.sessionRef).toBe('');
		});

		it('parsePreCompact with all numeric fields missing → contextTokens/Window 0', async () => {
			const ev = await a.parseHookEvent(HOOK_NAME_PRE_COMPACT, stdin('{"conversation_id":"x"}'));
			expect(ev?.type).toBe(EVENT_TYPE_COMPACTION);
			expect(ev?.contextTokens).toBe(0);
			expect(ev?.contextWindowSize).toBe(0);
			expect(ev?.sessionRef).toBe('');
		});

		it('parseSubagentStart with no subagent_type → defaults to ""', async () => {
			const payload = JSON.stringify({
				conversation_id: 'm',
				transcript_path: '/t',
				subagent_id: 's',
				task: 't',
			});
			const ev = await a.parseHookEvent(HOOK_NAME_SUBAGENT_START, stdin(payload));
			expect(ev?.subagentType).toBe('');
		});

		it('parseSubagentStop with no modified_files → defaults to []', async () => {
			const payload = JSON.stringify({
				conversation_id: 'm',
				transcript_path: '/t',
				subagent_id: 's',
				task: 't',
			});
			const ev = await a.parseHookEvent(HOOK_NAME_SUBAGENT_STOP, stdin(payload));
			expect(ev?.modifiedFiles).toEqual([]);
		});

		// Branch: every optional field omitted (only `task` present so we don't
		// hit fast-skip) → exercises every `?? ''` / `?? []` nullish branch in
		// parseSubagentStart / parseSubagentStop.
		it('parseSubagentStart all-optional-omitted → all defaults', async () => {
			const ev = await a.parseHookEvent(HOOK_NAME_SUBAGENT_START, stdin('{"task":"do"}'));
			expect(ev?.sessionId).toBe('');
			expect(ev?.sessionRef).toBe('');
			expect(ev?.subagentId).toBe('');
			expect(ev?.toolUseId).toBe('');
			expect(ev?.subagentType).toBe('');
		});

		it('parseSubagentStop all-optional-omitted → all defaults', async () => {
			const ev = await a.parseHookEvent(HOOK_NAME_SUBAGENT_STOP, stdin('{"task":"done"}'));
			expect(ev?.sessionId).toBe('');
			expect(ev?.sessionRef).toBe('');
			expect(ev?.subagentId).toBe('');
			expect(ev?.toolUseId).toBe('');
			expect(ev?.subagentType).toBe('');
			expect(ev?.modifiedFiles).toEqual([]);
		});

		// Story branch coverage: resolveTranscriptRef failure paths
		// (worktreeRoot throws when CWD is not in a git repo)
		it('CLI mode + worktreeRoot fails → returns event with empty sessionRef (warn logged)', async () => {
			let outsideRepo: string;
			outsideRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'cursor-outside-'));
			const originalCwd = process.cwd();
			try {
				// CD to a dir without .git so worktreeRoot() throws.
				process.chdir(outsideRepo);
				const ev = await a.parseHookEvent(
					HOOK_NAME_STOP,
					stdin('{"conversation_id":"orphan","status":"completed"}'),
				);
				expect(ev?.type).toBe(EVENT_TYPE_TURN_END);
				// resolveTranscriptRef returns '' when worktreeRoot fails.
				expect(ev?.sessionRef).toBe('');
			} finally {
				process.chdir(originalCwd);
				await fs.rm(outsideRepo, { recursive: true, force: true });
			}
		});

		// Go: lifecycle_test.go:514-579 TestParseHookEvent_AllHookTypes (table)
		it('AllHookTypes table — each known verb dispatches to expected EventType', async () => {
			const cases: Array<
				[string, ReturnType<typeof a.parseHookEvent> extends Promise<infer X> ? X : never]
			> = [];
			const allCases = [
				{
					verb: HOOK_NAME_SESSION_START,
					expected: EVENT_TYPE_SESSION_START,
					payload: '{"conversation_id":"s1","transcript_path":"/t"}',
				},
				{
					verb: HOOK_NAME_BEFORE_SUBMIT_PROMPT,
					expected: EVENT_TYPE_TURN_START,
					payload: '{"conversation_id":"s2","transcript_path":"/t","prompt":"hi"}',
				},
				{
					verb: HOOK_NAME_STOP,
					expected: EVENT_TYPE_TURN_END,
					payload: '{"conversation_id":"s3","transcript_path":"/t"}',
				},
				{
					verb: HOOK_NAME_SESSION_END,
					expected: EVENT_TYPE_SESSION_END,
					payload: '{"conversation_id":"s4","transcript_path":"/t"}',
				},
				{
					verb: HOOK_NAME_SUBAGENT_START,
					expected: EVENT_TYPE_SUBAGENT_START,
					payload:
						'{"conversation_id":"s5","transcript_path":"/t","subagent_id":"sub1","task":"do"}',
				},
				{
					verb: HOOK_NAME_SUBAGENT_STOP,
					expected: EVENT_TYPE_SUBAGENT_END,
					payload:
						'{"conversation_id":"s6","transcript_path":"/t","subagent_id":"sub2","task":"done"}',
				},
			];
			for (const c of allCases) {
				const ev = await a.parseHookEvent(c.verb, stdin(c.payload));
				expect(ev).not.toBeNull();
				expect(ev?.type).toBe(c.expected);
			}
			void cases;
		});
	});
});
