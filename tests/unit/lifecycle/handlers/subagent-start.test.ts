/**
 * Phase 7 Part 2 `src/lifecycle/handlers/subagent-start.ts` — 4 case.
 *
 * Go 参考：`cmd/entire/cli/lifecycle.go` (`handleLifecycleSubagentStart`).
 * Go has no direct unit test; case 1 mirrors the Go `CapturePreTaskState`
 * call, case 2 locks the 3 log fields Go emits, and cases 3-4 encode the
 * TS-side wrap-and-rethrow contract (Go wraps via `fmt.Errorf %w`; TS uses
 * `new Error(..., { cause })` — semantically equivalent).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Event } from '@/agent/event';
import type { Agent } from '@/agent/interfaces';
import { AGENT_NAME_CLAUDE_CODE, type AgentName } from '@/agent/types';
import { handleSubagentStart } from '@/lifecycle/handlers/subagent-start';
import * as log from '@/log';

vi.mock('@/lifecycle/pre-task-state', () => ({
	capturePreTaskState: vi.fn(async () => {}),
}));

import { capturePreTaskState } from '@/lifecycle/pre-task-state';

function makeEvent(overrides: Partial<Event> = {}): Event {
	return {
		type: 'SubagentStart',
		sessionId: 'sid-1',
		previousSessionId: '',
		sessionRef: '/tmp/transcript.jsonl',
		prompt: '',
		model: '',
		timestamp: new Date(0),
		toolUseId: 'toolu_abc',
		subagentId: '',
		toolInput: null,
		subagentType: '',
		taskDescription: '',
		modifiedFiles: [],
		responseMessage: '',
		durationMs: 0,
		turnCount: 0,
		contextTokens: 0,
		contextWindowSize: 0,
		metadata: {},
		...overrides,
	};
}

function makeAgent(name: AgentName = AGENT_NAME_CLAUDE_CODE): Agent {
	return { name: () => name } as Agent;
}

describe('lifecycle/handlers/subagent-start', () => {
	beforeEach(() => {
		vi.mocked(capturePreTaskState).mockReset().mockResolvedValue();
	});

	// Go: lifecycle.go handleLifecycleSubagentStart — CapturePreTaskState
	// is called once with event.ToolUseID (no transformation).
	it('captures pre-task state for given toolUseId', async () => {
		await handleSubagentStart(makeAgent(), makeEvent({ toolUseId: 'toolu_xyz' }));

		expect(capturePreTaskState).toHaveBeenCalledTimes(1);
		expect(capturePreTaskState).toHaveBeenCalledWith('toolu_xyz');
	});

	// Go: lifecycle.go — info-log carries event type + session id +
	// tool_use_id + transcript (session_ref). TS Story-side keeps sessionId +
	// toolUseId + transcript (the 3 Event fields the hook actually populates).
	it('log.info fired with sessionId + toolUseId + transcript', async () => {
		const infoSpy = vi.spyOn(log, 'info').mockImplementation(() => {});

		await handleSubagentStart(
			makeAgent(),
			makeEvent({
				sessionId: 'sid-42',
				toolUseId: 'toolu_42',
				sessionRef: '/data/transcripts/sid-42.jsonl',
			}),
		);

		expect(infoSpy).toHaveBeenCalledTimes(1);
		expect(infoSpy).toHaveBeenCalledWith(
			expect.objectContaining({ component: 'lifecycle', hook: 'subagent-start' }),
			'subagent started',
			expect.objectContaining({
				// Go parity: lifecycle.go logs `slog.String("event", event.Type.String())`
				// alongside session/tool/transcript. Review 2 added this key to TS.
				event: 'SubagentStart',
				sessionId: 'sid-42',
				toolUseId: 'toolu_42',
				transcript: '/data/transcripts/sid-42.jsonl',
			}),
		);
		infoSpy.mockRestore();
	});

	// Story 补充：Go wraps the capture failure with `fmt.Errorf("failed to
	// capture pre-task state: %w", err)`. TS mirrors the message prefix so
	// CI grep + operator logs stay 1:1 with Go.
	it('capture failure wrapped and re-thrown', async () => {
		vi.mocked(capturePreTaskState).mockRejectedValue(new Error('fs error'));

		await expect(handleSubagentStart(makeAgent(), makeEvent())).rejects.toThrow(
			/failed to capture pre-task state: fs error/,
		);
	});

	// Story 补充：Go's `%w` verb preserves the wrapped error for `errors.Is`.
	// TS equivalent is `new Error(..., { cause })`. This test locks the
	// contract so SubagentEnd / hook-registry can still inspect the original
	// fs error instead of only seeing the wrap prefix.
	it('propagates cause (Error with .cause)', async () => {
		const original = new Error('fs error');
		vi.mocked(capturePreTaskState).mockRejectedValue(original);

		let thrown: unknown;
		try {
			await handleSubagentStart(makeAgent(), makeEvent());
		} catch (err) {
			thrown = err;
		}

		expect(thrown).toBeInstanceOf(Error);
		const cause = (thrown as Error).cause;
		expect(cause).toBeInstanceOf(Error);
		expect((cause as Error).message).toBe('fs error');
	});
});
