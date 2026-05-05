/**
 * Tests for `src/agent/opencode/types.ts` — Mirrors Go
 * `entire-cli/cmd/entire/cli/agent/opencode/types.go` +
 * `lifecycle.go` (HookName* const block).
 *
 * Covers:
 * - 5 `HOOK_NAME_*` const values match Go literal strings
 * - `ROLE_USER` / `ROLE_ASSISTANT` const match Go `roleUser` / `roleAssistant`
 * - `FILE_MODIFICATION_TOOLS` array matches Go `FileModificationTools`
 * - `ExportSession` JSON round-trip preserves nested shape
 * - 3 stdin shape interfaces accept canonical Go payloads
 */

import { describe, expect, it } from 'vitest';
import {
	type ExportMessage,
	type ExportSession,
	FILE_MODIFICATION_TOOLS,
	HOOK_NAME_COMPACTION,
	HOOK_NAME_SESSION_END,
	HOOK_NAME_SESSION_START,
	HOOK_NAME_TURN_END,
	HOOK_NAME_TURN_START,
	type Part,
	ROLE_ASSISTANT,
	ROLE_USER,
	type SessionInfoRaw,
	type TurnEndRaw,
	type TurnStartRaw,
} from '@/agent/opencode/types';

describe('agent/opencode/types — Go: opencode/types.go + lifecycle.go', () => {
	// Go: lifecycle.go:24-28 (HookName* const block)
	it('5 HOOK_NAME_* const are exact Go-literal strings', () => {
		expect(HOOK_NAME_SESSION_START).toBe('session-start');
		expect(HOOK_NAME_SESSION_END).toBe('session-end');
		expect(HOOK_NAME_TURN_START).toBe('turn-start');
		expect(HOOK_NAME_TURN_END).toBe('turn-end');
		expect(HOOK_NAME_COMPACTION).toBe('compaction');
	});

	// Go: types.go:58-61 (roleUser / roleAssistant)
	it('ROLE_USER / ROLE_ASSISTANT match Go role literals', () => {
		expect(ROLE_USER).toBe('user');
		expect(ROLE_ASSISTANT).toBe('assistant');
	});

	// Go: types.go:122-126 (FileModificationTools = ["edit", "write", "apply_patch"])
	it('FILE_MODIFICATION_TOOLS is exactly the 3 Go-defined tool names', () => {
		expect(FILE_MODIFICATION_TOOLS).toEqual(['edit', 'write', 'apply_patch']);
	});

	// Go: types.go:5-7 + 10-14 + 18-21 (3 stdin shape structs)
	it('3 stdin shape interfaces accept canonical Go payloads (snake_case keys)', () => {
		const sessionInfo: SessionInfoRaw = JSON.parse('{"session_id":"ses_abc"}');
		expect(sessionInfo.session_id).toBe('ses_abc');

		const turnStart: TurnStartRaw = JSON.parse(
			'{"session_id":"ses_abc","prompt":"refactor foo","model":"claude-sonnet-4-5"}',
		);
		expect(turnStart.session_id).toBe('ses_abc');
		expect(turnStart.prompt).toBe('refactor foo');
		expect(turnStart.model).toBe('claude-sonnet-4-5');

		const turnEnd: TurnEndRaw = JSON.parse('{"session_id":"ses_abc","model":"claude-sonnet-4-5"}');
		expect(turnEnd.session_id).toBe('ses_abc');
		expect(turnEnd.model).toBe('claude-sonnet-4-5');
	});

	// Go: types.go:27-110 (ExportSession + nested types — round-trip JSON
	// from a real `opencode export` payload preserves all fields).
	it('ExportSession round-trips a real opencode export payload', () => {
		const raw = JSON.stringify({
			info: {
				id: 'ses_abc',
				title: 'refactor foo',
				createdAt: 1714000000000,
				updatedAt: 1714000060000,
			},
			messages: [
				{
					info: { id: 'msg_1', role: 'user', time: { created: 1714000000000 } },
					parts: [{ type: 'text', text: 'hi' }],
				},
				{
					info: {
						id: 'msg_2',
						role: 'assistant',
						time: { created: 1714000010000, completed: 1714000020000 },
						tokens: {
							input: 100,
							output: 50,
							reasoning: 10,
							cache: { read: 5, write: 0 },
						},
						cost: 0.0123,
					},
					parts: [
						{ type: 'text', text: 'ok' },
						{
							type: 'tool',
							tool: 'edit',
							callID: 'call_1',
							state: {
								status: 'completed',
								input: { filePath: 'src/foo.ts' },
								output: '+1 -0',
								metadata: { files: [{ filePath: 'src/foo.ts' }] },
							},
						},
					],
				},
			],
		});
		const parsed = JSON.parse(raw) as ExportSession;
		expect(parsed.info.id).toBe('ses_abc');
		expect(parsed.messages.length).toBe(2);
		expect(parsed.messages[0]?.info.role).toBe('user');
		expect(parsed.messages[1]?.info.tokens?.cache.read).toBe(5);
		expect(parsed.messages[1]?.parts[1]?.tool).toBe('edit');
		expect(parsed.messages[1]?.parts[1]?.state?.metadata?.files?.[0]?.filePath).toBe('src/foo.ts');
	});

	// Failure path: invalid stdin shape - missing session_id should still parse
	// (TS interfaces are structural; runtime validation is parser's job, not type's)
	it('SessionInfoRaw shape allows runtime validation downstream', () => {
		// Empty object accepted at type level — parseHookEvent enforces non-empty.
		const empty = JSON.parse('{}') as Partial<SessionInfoRaw>;
		expect(empty.session_id).toBeUndefined();
	});

	it('Part accepts step-start / step-finish streaming boundary messages', () => {
		const raw = JSON.stringify({
			info: { id: 'm1', role: 'assistant', time: { created: 1 } },
			parts: [
				{ type: 'step-start', id: 's1' },
				{ type: 'text', text: 'x' },
				{ type: 'step-finish', id: 's1' },
			],
		});
		const parsed = JSON.parse(raw) as ExportMessage;
		expect(parsed.parts[0]?.type).toBe('step-start');
		expect(parsed.parts[2]?.type).toBe('step-finish');
	});

	it('ToolState status error path preserves optional metadata', () => {
		const raw = JSON.stringify({
			type: 'tool',
			tool: 'write',
			callID: 'c1',
			state: {
				status: 'error',
				input: { filePath: 'a.ts' },
				output: 'failed',
				metadata: { files: [{ filePath: 'a.ts' }] },
			},
		});
		const part = JSON.parse(raw) as Part;
		expect(part.state?.status).toBe('error');
		expect(part.state?.metadata?.files?.[0]?.filePath).toBe('a.ts');
	});
});
