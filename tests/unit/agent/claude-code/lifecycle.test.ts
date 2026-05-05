/**
 * Tests for `src/agent/claude-code/lifecycle.ts` — Mirrors Go
 * `entire-cli/cmd/entire/cli/agent/claudecode/lifecycle_test.go`
 * (24 test functions: 17 ParseHookEvent + 5 readAndParse + 3 wait/sentinel)
 * + 1 Story 补充 (writeHookResponse JSON shape).
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	calculateTokenUsage,
	checkStopSentinel,
	hookNames,
	parseHookEvent,
	prepareTranscript,
	waitForTranscriptFlush,
	writeHookResponse,
} from '@/agent/claude-code/lifecycle';
import {
	EVENT_TYPE_SESSION_END,
	EVENT_TYPE_SESSION_START,
	EVENT_TYPE_SUBAGENT_END,
	EVENT_TYPE_SUBAGENT_START,
	EVENT_TYPE_TURN_END,
	EVENT_TYPE_TURN_START,
} from '@/agent/event';

function stdinFrom(payload: string): NodeJS.ReadableStream {
	return Readable.from([Buffer.from(payload)]);
}

describe('agent/claude-code/lifecycle — Go: lifecycle_test.go', () => {
	describe('hookNames', () => {
		// Go: lifecycle.go:40-50 (HookNames returns 7 verbs in fixed order).
		it('returns 7 verbs in Go-fixed order', () => {
			expect(hookNames()).toEqual([
				'session-start',
				'session-end',
				'stop',
				'user-prompt-submit',
				'pre-task',
				'post-task',
				'post-todo',
			]);
		});
	});

	describe('parseHookEvent', () => {
		// Go: lifecycle_test.go: TestParseHookEvent_SessionStart
		it('session-start parses to SessionStart event', async () => {
			const stdin = stdinFrom(JSON.stringify({ session_id: 'sid', transcript_path: '/p' }));
			const ev = await parseHookEvent('session-start', stdin);
			expect(ev?.type).toBe(EVENT_TYPE_SESSION_START);
			expect(ev?.sessionId).toBe('sid');
			expect(ev?.sessionRef).toBe('/p');
			expect(ev?.model).toBe('');
			expect(ev?.timestamp).toBeInstanceOf(Date);
		});

		// Go: TestParseHookEvent_SessionStart_IncludesModel
		it('session-start carries optional model', async () => {
			const stdin = stdinFrom(
				JSON.stringify({ session_id: 'sid', transcript_path: '/p', model: 'sonnet' }),
			);
			const ev = await parseHookEvent('session-start', stdin);
			expect(ev?.model).toBe('sonnet');
		});

		it('session-start with absent model returns empty model', async () => {
			const stdin = stdinFrom(JSON.stringify({ session_id: 's', transcript_path: '/p' }));
			const ev = await parseHookEvent('session-start', stdin);
			expect(ev?.model).toBe('');
		});

		// Go: TestParseHookEvent_TurnStart
		it('user-prompt-submit parses to TurnStart with prompt', async () => {
			const stdin = stdinFrom(
				JSON.stringify({ session_id: 's', transcript_path: '/p', prompt: 'hi' }),
			);
			const ev = await parseHookEvent('user-prompt-submit', stdin);
			expect(ev?.type).toBe(EVENT_TYPE_TURN_START);
			expect(ev?.prompt).toBe('hi');
		});

		// Go: TestParseHookEvent_TurnEnd
		it('stop parses to TurnEnd', async () => {
			const stdin = stdinFrom(JSON.stringify({ session_id: 's', transcript_path: '/p' }));
			const ev = await parseHookEvent('stop', stdin);
			expect(ev?.type).toBe(EVENT_TYPE_TURN_END);
		});

		// Go: TestParseHookEvent_TurnEnd_IncludesModel
		it('stop carries optional model', async () => {
			const stdin = stdinFrom(
				JSON.stringify({ session_id: 's', transcript_path: '/p', model: 'haiku' }),
			);
			const ev = await parseHookEvent('stop', stdin);
			expect(ev?.model).toBe('haiku');
		});

		// Go: TestParseHookEvent_SessionEnd
		it('session-end parses to SessionEnd', async () => {
			const stdin = stdinFrom(JSON.stringify({ session_id: 's', transcript_path: '/p' }));
			const ev = await parseHookEvent('session-end', stdin);
			expect(ev?.type).toBe(EVENT_TYPE_SESSION_END);
		});

		// Go: TestParseHookEvent_SessionEnd_IncludesModel
		it('session-end carries optional model', async () => {
			const stdin = stdinFrom(
				JSON.stringify({ session_id: 's', transcript_path: '/p', model: 'opus' }),
			);
			const ev = await parseHookEvent('session-end', stdin);
			expect(ev?.model).toBe('opus');
		});

		// Go: TestParseHookEvent_SubagentStart
		it('pre-task parses to SubagentStart with toolUseId + toolInput', async () => {
			const stdin = stdinFrom(
				JSON.stringify({
					session_id: 's',
					transcript_path: '/p',
					tool_use_id: 'toolu_xyz',
					tool_input: { prompt: 'do x' },
				}),
			);
			const ev = await parseHookEvent('pre-task', stdin);
			expect(ev?.type).toBe(EVENT_TYPE_SUBAGENT_START);
			expect(ev?.toolUseId).toBe('toolu_xyz');
			// toolInput is re-serialized to bytes (Go: json.RawMessage carry-through).
			expect(ev?.toolInput).toBeInstanceOf(Uint8Array);
			const decoded = new TextDecoder().decode(ev?.toolInput as Uint8Array);
			expect(JSON.parse(decoded)).toEqual({ prompt: 'do x' });
		});

		// Go: TestParseHookEvent_SubagentEnd
		it('post-task parses to SubagentEnd with subagentId from tool_response.agentId', async () => {
			const stdin = stdinFrom(
				JSON.stringify({
					session_id: 's',
					transcript_path: '/p',
					tool_use_id: 'toolu_xyz',
					tool_input: {},
					tool_response: { agentId: 'ac66d4b' },
				}),
			);
			const ev = await parseHookEvent('post-task', stdin);
			expect(ev?.type).toBe(EVENT_TYPE_SUBAGENT_END);
			expect(ev?.subagentId).toBe('ac66d4b');
		});

		// Go: TestParseHookEvent_SubagentEnd_NoAgentID
		it('post-task with empty tool_response yields empty subagentId', async () => {
			const stdin = stdinFrom(
				JSON.stringify({
					session_id: 's',
					transcript_path: '/p',
					tool_use_id: 'toolu_xyz',
					tool_input: {},
					tool_response: {},
				}),
			);
			const ev = await parseHookEvent('post-task', stdin);
			expect(ev?.subagentId).toBe('');
		});

		// Go: TestParseHookEvent_PostTodo_ReturnsNil
		it('post-todo verb returns null event (not error)', async () => {
			const stdin = stdinFrom('{}');
			expect(await parseHookEvent('post-todo', stdin)).toBeNull();
		});

		// Go: TestParseHookEvent_UnknownHook_ReturnsNil
		it('unknown hook verb returns null', async () => {
			const stdin = stdinFrom('{}');
			expect(await parseHookEvent('made-up-verb', stdin)).toBeNull();
		});

		// Go: TestParseHookEvent_EmptyInput
		it('throws on empty stdin', async () => {
			const stdin = stdinFrom('');
			await expect(parseHookEvent('session-start', stdin)).rejects.toThrow(/empty hook input/);
		});

		// Go: TestParseHookEvent_MalformedJSON
		it('throws on non-JSON stdin', async () => {
			const stdin = stdinFrom('not json');
			await expect(parseHookEvent('session-start', stdin)).rejects.toThrow(
				/failed to parse hook input/,
			);
		});

		// Go: TestParseHookEvent_AllHookTypes (table) → 7 verbs each map to expected EventType (or null).
		const verbToType: Array<[string, string | null]> = [
			['session-start', EVENT_TYPE_SESSION_START],
			['user-prompt-submit', EVENT_TYPE_TURN_START],
			['stop', EVENT_TYPE_TURN_END],
			['session-end', EVENT_TYPE_SESSION_END],
			['pre-task', EVENT_TYPE_SUBAGENT_START],
			['post-task', EVENT_TYPE_SUBAGENT_END],
			['post-todo', null],
		];
		for (const [verb, expected] of verbToType) {
			it(`dispatches verb="${verb}" to ${expected ?? 'null'}`, async () => {
				const stdin = stdinFrom(
					JSON.stringify({
						session_id: 's',
						transcript_path: '/p',
						tool_use_id: 'tx',
						tool_input: {},
						tool_response: {},
						prompt: 'p',
					}),
				);
				const ev = await parseHookEvent(verb, stdin);
				if (expected === null) {
					expect(ev).toBeNull();
				} else {
					expect(ev?.type).toBe(expected);
				}
			});
		}

		// Go: TestReadAndParse_PartialJSON — missing optional fields: no throw.
		it('parseHookEvent succeeds when stdin missing optional fields', async () => {
			const stdin = stdinFrom(JSON.stringify({ session_id: 'sid' }));
			const ev = await parseHookEvent('session-start', stdin);
			expect(ev?.sessionId).toBe('sid');
			expect(ev?.sessionRef).toBe('');
		});

		// Go: TestReadAndParse_ExtraFields — unknown extra fields silently ignored.
		it('parseHookEvent ignores unknown stdin fields', async () => {
			const stdin = stdinFrom(
				JSON.stringify({
					session_id: 's',
					transcript_path: '/p',
					extra_field: 'should not appear',
				}),
			);
			const ev = await parseHookEvent('session-start', stdin);
			expect(ev?.sessionId).toBe('s');
			expect((ev as unknown as { extra_field?: string }).extra_field).toBeUndefined();
		});
	});

	describe('writeHookResponse', () => {
		function spyStdout(): { chunks: string[]; restore: () => void } {
			const chunks: string[] = [];
			const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((
				chunk: string | Uint8Array,
				encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
				maybeCb?: (err?: Error | null) => void,
			) => {
				chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
				const cb = typeof encodingOrCb === 'function' ? encodingOrCb : maybeCb;
				cb?.();
				return true;
			}) as typeof process.stdout.write);
			return { chunks, restore: () => spy.mockRestore() };
		}

		// Story 补充：Go TestWriteHookResponse covered indirectly; assert exact JSON.
		it('writes {"systemMessage":"<msg>"}\\n to stdout', async () => {
			const { chunks, restore } = spyStdout();
			try {
				await writeHookResponse('hello world');
			} finally {
				restore();
			}
			expect(chunks.join('')).toBe('{"systemMessage":"hello world"}\n');
		});

		// Go: lifecycle.go:30 — `json:"systemMessage,omitempty"` tag means an
		// empty message produces `{}`, NOT `{"systemMessage":""}`. Story-side
		// must mirror this for cross-CLI fixture compatibility.
		it('writes {} (NOT {"systemMessage":""}) when message is empty (Go omitempty parity)', async () => {
			const { chunks, restore } = spyStdout();
			try {
				await writeHookResponse('');
			} finally {
				restore();
			}
			expect(chunks.join('')).toBe('{}\n');
		});
	});

	describe('calculateTokenUsage', () => {
		// Verifies the lifecycle delegation: empty subagentsDir is passed.
		it('delegates to calculateTotalTokenUsage with empty subagentsDir', async () => {
			const data = new TextEncoder().encode(
				`{"type":"assistant","uuid":"a1","message":{"id":"m1","usage":{"input_tokens":10,"output_tokens":5,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}\n`,
			);
			const u = await calculateTokenUsage(data, 0);
			expect(u?.apiCallCount).toBe(1);
			expect(u?.inputTokens).toBe(10);
			expect(u?.subagentTokens).toBeUndefined();
		});
	});

	// --- waitForTranscriptFlush + checkStopSentinel ---

	describe('waitForTranscriptFlush + checkStopSentinel', () => {
		let tmp: string;
		beforeEach(async () => {
			tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-flush-'));
		});
		afterEach(async () => {
			await fs.rm(tmp, { recursive: true, force: true });
		});

		// Go: TestWaitForTranscriptFlush_NonexistentFile_ReturnsImmediately
		it('returns fast (<500ms) when file missing', async () => {
			const start = Date.now();
			await waitForTranscriptFlush(path.join(tmp, 'missing.jsonl'), new Date());
			expect(Date.now() - start).toBeLessThan(500);
		});

		// Go: TestWaitForTranscriptFlush_StaleFile_SkipsWait
		it('returns fast (<500ms) when file mtime > 2 min old (stale agent)', async () => {
			const file = path.join(tmp, 'stale.jsonl');
			await fs.writeFile(file, '{}\n');
			// Force mtime 3 min ago.
			const past = new Date(Date.now() - 3 * 60 * 1000);
			await fs.utimes(file, past, past);
			const start = Date.now();
			await waitForTranscriptFlush(file, new Date());
			expect(Date.now() - start).toBeLessThan(500);
		});

		// Go: TestWaitForTranscriptFlush_RecentFile_WaitsForSentinel — bounded
		// to keep the test ≤ 4s. Use a fresh file with no sentinel; expect ~3s
		// timeout.
		it('waits ~3s when file recent + no sentinel (then warns + returns)', async () => {
			const file = path.join(tmp, 'recent.jsonl');
			await fs.writeFile(file, `{"type":"user","content":"hi"}\n`);
			const start = Date.now();
			await waitForTranscriptFlush(file, new Date());
			const elapsed = Date.now() - start;
			expect(elapsed).toBeGreaterThanOrEqual(2000); // toward 3s timeout
			expect(elapsed).toBeLessThanOrEqual(4500); // safety upper bound
		}, 5000);

		// Story 补充：sentinel found within window → fast return.
		it('returns fast when sentinel timestamp is inside the skew window', async () => {
			const file = path.join(tmp, 'sentinel-fresh.jsonl');
			const sentinelTs = new Date().toISOString();
			await fs.writeFile(
				file,
				`{"type":"user","content":"hi"}\n{"timestamp":"${sentinelTs}","msg":"hooks claude-code stop ran"}\n`,
			);
			const start = Date.now();
			await waitForTranscriptFlush(file, new Date());
			const elapsed = Date.now() - start;
			expect(elapsed).toBeLessThan(500);
		});

		// Story 失败路径 (checkStopSentinel sub-cases).
		it('checkStopSentinel returns false when file unreadable', async () => {
			expect(await checkStopSentinel(path.join(tmp, 'no-such-file'), 4096, new Date(), 2000)).toBe(
				false,
			);
		});

		it('checkStopSentinel returns false when no sentinel string present', async () => {
			const file = path.join(tmp, 'no-sentinel.jsonl');
			await fs.writeFile(file, `{"type":"user","content":"hi"}\n`);
			expect(await checkStopSentinel(file, 4096, new Date(), 2000)).toBe(false);
		});

		it('checkStopSentinel returns false when sentinel timestamp is outside skew window', async () => {
			const file = path.join(tmp, 'old-sentinel.jsonl');
			// Sentinel timestamp is 10s old; window is ±2s.
			const oldTs = new Date(Date.now() - 10_000).toISOString();
			await fs.writeFile(file, `{"timestamp":"${oldTs}","msg":"hooks claude-code stop"}\n`);
			expect(await checkStopSentinel(file, 4096, new Date(), 2000)).toBe(false);
		});

		// Story 补充 (TS 特性): RFC3339Nano timestamps (Claude emits ns precision)
		// must parse correctly. Go uses `time.RFC3339Nano` then `time.RFC3339`
		// fallback; JS `new Date(str)` truncates extra digits to ms but still
		// produces a valid date.
		it('checkStopSentinel accepts nanosecond-precision timestamp (RFC3339Nano)', async () => {
			const file = path.join(tmp, 'nano-sentinel.jsonl');
			// Synthesize a now-ish timestamp with nanosecond precision.
			const nowMs = Date.now();
			const isoMs = new Date(nowMs).toISOString().replace('Z', '');
			const nanoTs = `${isoMs}123456Z`; // append 3 extra digits for nanos
			await fs.writeFile(file, `{"timestamp":"${nanoTs}","msg":"hooks claude-code stop"}\n`);
			expect(await checkStopSentinel(file, 4096, new Date(nowMs), 2000)).toBe(true);
		});

		// Story 补充: malformed timestamp (non-date string) → false.
		it('checkStopSentinel returns false on malformed timestamp string', async () => {
			const file = path.join(tmp, 'bad-ts.jsonl');
			await fs.writeFile(file, `{"timestamp":"not a date","msg":"hooks claude-code stop"}\n`);
			expect(await checkStopSentinel(file, 4096, new Date(), 2000)).toBe(false);
		});

		// Story 补充: empty file → false (no read).
		it('checkStopSentinel returns false on empty file', async () => {
			const file = path.join(tmp, 'empty.jsonl');
			await fs.writeFile(file, '');
			expect(await checkStopSentinel(file, 4096, new Date(), 2000)).toBe(false);
		});
	});

	describe('prepareTranscript', () => {
		it('always resolves (delegates to waitForTranscriptFlush)', async () => {
			const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-prep-'));
			try {
				await expect(prepareTranscript(path.join(tmp, 'missing.jsonl'))).resolves.toBeUndefined();
			} finally {
				await fs.rm(tmp, { recursive: true, force: true });
			}
		});
	});
});
