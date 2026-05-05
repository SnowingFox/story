/**
 * Tests for `src/agent/codex/lifecycle.ts` — Mirrors Go
 * `entire-cli/cmd/entire/cli/agent/codex/lifecycle.go` + `lifecycle_test.go`.
 *
 * Covers:
 * - hookNames returns 4 verbs (Go HookNames)
 * - parseHookEvent 4-verb dispatch (session-start → SessionStart;
 *   user-prompt-submit → TurnStart; stop → TurnEnd;
 *   pre-tool-use → null pass-through)
 * - Failure paths: empty stdin / malformed JSON / unknown verb / nullable
 *   transcript_path → derefString ''
 * - writeHookResponse spy stdout {systemMessage}
 */

import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CodexAgent } from '@/agent/codex';
import {
	HOOK_NAME_PRE_TOOL_USE,
	HOOK_NAME_SESSION_START,
	HOOK_NAME_STOP,
	HOOK_NAME_USER_PROMPT_SUBMIT,
} from '@/agent/codex/types';
import {
	EVENT_TYPE_SESSION_START,
	EVENT_TYPE_TURN_END,
	EVENT_TYPE_TURN_START,
} from '@/agent/event';

function stdin(payload: string): NodeJS.ReadableStream {
	return Readable.from([payload]);
}

describe('agent/codex/lifecycle — Go: codex/lifecycle.go + lifecycle_test.go', () => {
	const agent = new CodexAgent();

	// Go: lifecycle.go:30-36 HookNames
	it('hookNames returns 4 verbs in Go order', () => {
		expect(agent.hookNames()).toEqual([
			'session-start',
			'user-prompt-submit',
			'stop',
			'pre-tool-use',
		]);
	});

	// Go: lifecycle_test.go:14-31 TestParseHookEvent_SessionStart
	it('session-start basic → SessionStart event with sessionId/sessionRef/model/timestamp', async () => {
		const ev = await agent.parseHookEvent(
			HOOK_NAME_SESSION_START,
			stdin(
				'{"session_id":"sess-1","transcript_path":"/tmp/t.jsonl","cwd":"/repo","hook_event_name":"SessionStart","model":"gpt-5","permission_mode":"workspace-write","source":"startup"}',
			),
		);
		expect(ev).not.toBeNull();
		expect(ev?.type).toBe(EVENT_TYPE_SESSION_START);
		expect(ev?.sessionId).toBe('sess-1');
		expect(ev?.sessionRef).toBe('/tmp/t.jsonl');
		expect(ev?.model).toBe('gpt-5');
		expect(ev?.timestamp.getTime()).toBeGreaterThan(0);
	});

	// Go: lifecycle.go:53-65 parseSessionStart + types.go:36 TranscriptPath *string nullable
	it('session-start nullable transcript_path → derefString "" (no throw)', async () => {
		const ev = await agent.parseHookEvent(
			HOOK_NAME_SESSION_START,
			stdin(
				'{"session_id":"sess-2","transcript_path":null,"cwd":"/repo","hook_event_name":"SessionStart","model":"gpt-5","permission_mode":"workspace-write","source":"resume"}',
			),
		);
		expect(ev?.sessionRef).toBe('');
	});

	// Go: lifecycle_test.go:33-50 TestParseHookEvent_TurnStart
	it('user-prompt-submit basic → TurnStart with prompt', async () => {
		const ev = await agent.parseHookEvent(
			HOOK_NAME_USER_PROMPT_SUBMIT,
			stdin(
				'{"session_id":"s","turn_id":"t1","transcript_path":"/tmp/x.jsonl","cwd":"/r","hook_event_name":"UserPromptSubmit","model":"gpt-5","permission_mode":"w","prompt":"hello"}',
			),
		);
		expect(ev?.type).toBe(EVENT_TYPE_TURN_START);
		expect(ev?.sessionId).toBe('s');
		expect(ev?.prompt).toBe('hello');
		expect(ev?.model).toBe('gpt-5');
	});

	// Go: lifecycle_test.go:52-69 TestParseHookEvent_TurnEnd
	it('stop basic → TurnEnd event', async () => {
		const ev = await agent.parseHookEvent(
			HOOK_NAME_STOP,
			stdin(
				'{"session_id":"s","turn_id":"t1","transcript_path":"/tmp/x.jsonl","cwd":"/r","hook_event_name":"Stop","model":"gpt-5","permission_mode":"w","stop_hook_active":true,"last_assistant_message":"bye"}',
			),
		);
		expect(ev?.type).toBe(EVENT_TYPE_TURN_END);
		expect(ev?.sessionId).toBe('s');
		expect(ev?.model).toBe('gpt-5');
	});

	// Go: lifecycle_test.go:71-79 TestParseHookEvent_PreToolUse_ReturnsNil
	it('pre-tool-use → null (pass-through; does NOT read stdin)', async () => {
		// Empty stdin must NOT throw because pass-through path skips read entirely.
		const ev = await agent.parseHookEvent(HOOK_NAME_PRE_TOOL_USE, stdin(''));
		expect(ev).toBeNull();
	});

	// Go: lifecycle_test.go:81-89 TestParseHookEvent_UnknownHook_ReturnsNil
	it('unknown verb → null', async () => {
		const ev = await agent.parseHookEvent('made-up-verb', stdin('{}'));
		expect(ev).toBeNull();
	});

	// Go: lifecycle_test.go:91-99 TestParseHookEvent_EmptyInput_ReturnsError
	it('session-start empty stdin throws "empty hook input"', async () => {
		await expect(agent.parseHookEvent(HOOK_NAME_SESSION_START, stdin(''))).rejects.toThrow(
			/empty hook input/,
		);
	});

	// Go: lifecycle_test.go:101-109 TestParseHookEvent_MalformedJSON_ReturnsError
	it('user-prompt-submit malformed JSON throws', async () => {
		await expect(
			agent.parseHookEvent(HOOK_NAME_USER_PROMPT_SUBMIT, stdin('{invalid json')),
		).rejects.toThrow();
	});

	// Failure path: stop hook also throws on bad input
	it('stop empty stdin throws', async () => {
		await expect(agent.parseHookEvent(HOOK_NAME_STOP, stdin(''))).rejects.toThrow(
			/empty hook input/,
		);
	});

	// Recency: timestamp within 1s of now
	it('parseHookEvent timestamp is recent (within 1s of now)', async () => {
		const before = Date.now();
		const ev = await agent.parseHookEvent(
			HOOK_NAME_SESSION_START,
			stdin(
				'{"session_id":"s","transcript_path":"/x","cwd":"/r","hook_event_name":"SessionStart","model":"m","permission_mode":"w","source":"startup"}',
			),
		);
		const after = Date.now();
		expect(ev).not.toBeNull();
		expect(ev?.timestamp.getTime()).toBeGreaterThanOrEqual(before);
		expect(ev?.timestamp.getTime()).toBeLessThanOrEqual(after + 5);
	});

	describe('writeHookResponse', () => {
		let originalWrite: typeof process.stdout.write;
		let writes: string[];

		beforeEach(() => {
			writes = [];
			originalWrite = process.stdout.write;
			process.stdout.write = ((chunk: unknown, ...args: unknown[]): boolean => {
				writes.push(typeof chunk === 'string' ? chunk : (chunk?.toString?.() ?? ''));
				const cb = args[args.length - 1];
				if (typeof cb === 'function') {
					(cb as (err?: Error | null) => void)(null);
				}
				return true;
			}) as typeof process.stdout.write;
		});

		afterEach(() => {
			process.stdout.write = originalWrite;
		});

		// Go: lifecycle.go:18-26 WriteHookResponse — encoding/json.NewEncoder.Encode
		// emits trailing newline. Output: `{"systemMessage":"hello"}\n`.
		it('writeHookResponse writes {"systemMessage":"<msg>"}\\n to stdout', async () => {
			await agent.writeHookResponse('hello');
			expect(writes.join('')).toBe('{"systemMessage":"hello"}\n');
		});

		// Go: lifecycle.go:19 SystemMessage `json:"systemMessage,omitempty"` — empty
		// string omitted on encode. Story matches via JSON.stringify (default).
		it('writeHookResponse with empty message omits systemMessage field', async () => {
			await agent.writeHookResponse('');
			// Note: TS JSON.stringify keeps "" by default (no omitempty); we mimic Go
			// by manually stripping when message === ''.
			expect(writes.join('')).toBe('{}\n');
		});

		// Failure branch: stdout.write callback fires error → promise rejects
		it('writeHookResponse rejects when process.stdout.write fails', async () => {
			process.stdout.write = ((_chunk: unknown, ...args: unknown[]): boolean => {
				const cb = args[args.length - 1];
				if (typeof cb === 'function') {
					(cb as (err?: Error | null) => void)(new Error('disk full'));
				}
				return false;
			}) as typeof process.stdout.write;
			await expect(agent.writeHookResponse('hello')).rejects.toThrow(/disk full/);
		});
	});

	// Story 补充: parser default-fallback branches (?? '')
	describe('parser ?? "" fallbacks (Story 补充 — coverage)', () => {
		const a = new CodexAgent();

		it('session-start with missing session_id/model uses "" defaults', async () => {
			const ev = await a.parseHookEvent(HOOK_NAME_SESSION_START, stdin('{"transcript_path":"/x"}'));
			expect(ev?.sessionId).toBe('');
			expect(ev?.model).toBe('');
			expect(ev?.sessionRef).toBe('/x');
		});

		it('user-prompt-submit with missing fields uses "" defaults', async () => {
			const ev = await a.parseHookEvent(HOOK_NAME_USER_PROMPT_SUBMIT, stdin('{}'));
			expect(ev?.sessionId).toBe('');
			expect(ev?.model).toBe('');
			expect(ev?.prompt).toBe('');
			expect(ev?.sessionRef).toBe('');
		});

		it('stop with missing fields uses "" defaults', async () => {
			const ev = await a.parseHookEvent(HOOK_NAME_STOP, stdin('{}'));
			expect(ev?.sessionId).toBe('');
			expect(ev?.model).toBe('');
		});
	});
});
