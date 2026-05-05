import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
	EVENT_TYPE_COMPACTION,
	EVENT_TYPE_MODEL_UPDATE,
	EVENT_TYPE_SESSION_END,
	EVENT_TYPE_SESSION_START,
	EVENT_TYPE_SUBAGENT_END,
	EVENT_TYPE_SUBAGENT_START,
	EVENT_TYPE_TURN_END,
	EVENT_TYPE_TURN_START,
	type EventType,
	eventTypeToString,
	readAndParseHookInput,
} from '@/agent/event';

// Go: event.go (EventType + String + Event + ReadAndParseHookInput)

function makeStdin(payload: string): Readable {
	return Readable.from([payload]);
}

describe('agent/event — Go: event.go', () => {
	describe('eventTypeToString', () => {
		it('all 8 EventType values stringify to PascalCase Go names', () => {
			// Go: event.go:47-66 — String() switch returns Go const names verbatim.
			const cases: Array<[EventType, string]> = [
				[EVENT_TYPE_SESSION_START, 'SessionStart'],
				[EVENT_TYPE_TURN_START, 'TurnStart'],
				[EVENT_TYPE_TURN_END, 'TurnEnd'],
				[EVENT_TYPE_COMPACTION, 'Compaction'],
				[EVENT_TYPE_SESSION_END, 'SessionEnd'],
				[EVENT_TYPE_SUBAGENT_START, 'SubagentStart'],
				[EVENT_TYPE_SUBAGENT_END, 'SubagentEnd'],
				[EVENT_TYPE_MODEL_UPDATE, 'ModelUpdate'],
			];
			for (const [t, expected] of cases) {
				expect(eventTypeToString(t)).toBe(expected);
			}
		});
	});

	describe('readAndParseHookInput', () => {
		// Go: event.go:132-146 — generic readAll → empty-check → JSON.unmarshal.
		it('parses valid JSON to typed T', async () => {
			const result = await readAndParseHookInput<{ foo: string }>(makeStdin('{"foo":"bar"}'));
			expect(result).toEqual({ foo: 'bar' });
		});

		it('empty stdin throws "empty hook input"', async () => {
			await expect(readAndParseHookInput(makeStdin(''))).rejects.toThrow('empty hook input');
		});

		it('non-JSON stdin throws "failed to parse hook input"', async () => {
			await expect(readAndParseHookInput(makeStdin('not json'))).rejects.toThrow(
				'failed to parse hook input',
			);
		});

		it('large payload across multiple chunks parses correctly', async () => {
			const chunked = new Readable({
				read() {
					this.push('{"a":');
					this.push('"hello"}');
					this.push(null);
				},
			});
			const result = await readAndParseHookInput<{ a: string }>(chunked);
			expect(result).toEqual({ a: 'hello' });
		});
	});
});
