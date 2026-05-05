/**
 * Tests for `src/agent/external/index.ts` — ExternalAgent class, convertTokenUsage,
 * and convertEventJSON.
 *
 * Binary-level tests use fixture scripts under `tests/fixtures/external/bin/`.
 */

import { chmodSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
	EVENT_TYPE_COMPACTION,
	EVENT_TYPE_MODEL_UPDATE,
	EVENT_TYPE_SESSION_END,
	EVENT_TYPE_SESSION_START,
	EVENT_TYPE_SUBAGENT_END,
	EVENT_TYPE_SUBAGENT_START,
	EVENT_TYPE_TURN_END,
	EVENT_TYPE_TURN_START,
} from '@/agent/event';
import { convertEventJSON, convertTokenUsage, ExternalAgent } from '@/agent/external/index';
import type { EventJSON, TokenUsageResponse } from '@/agent/external/types';
import { PROTOCOL_VERSION } from '@/agent/external/types';
import { HOOK_TYPE_SESSION_START } from '@/agent/types';

const fixtureBinDir = path.join(
	fileURLToPath(new URL('.', import.meta.url)),
	'../../../fixtures/external/bin',
);
const STUB_GOOD = path.join(fixtureBinDir, 'story-agent-stub');
const STUB_BAD_JSON = path.join(fixtureBinDir, 'story-agent-bad-json');
const STUB_WRONG_PROTO = path.join(fixtureBinDir, 'story-agent-wrong-proto');

describe('PROTOCOL_VERSION', () => {
	// Go: external.go:47-50 New validates info.ProtocolVersion against ProtocolVersion
	it('matches expected version', () => {
		expect(PROTOCOL_VERSION).toBe(1);
	});
});

describe('convertTokenUsage', () => {
	// Go: external.go:541-556 convertTokenUsage
	it('returns null for null input', () => {
		expect(convertTokenUsage(null)).toBeNull();
	});

	it('converts a flat TokenUsageResponse', () => {
		const resp: TokenUsageResponse = {
			input_tokens: 100,
			cache_creation_tokens: 10,
			cache_read_tokens: 20,
			output_tokens: 50,
			api_call_count: 3,
		};
		const usage = convertTokenUsage(resp);
		expect(usage).not.toBeNull();
		expect(usage!.inputTokens).toBe(100);
		expect(usage!.cacheCreationTokens).toBe(10);
		expect(usage!.cacheReadTokens).toBe(20);
		expect(usage!.outputTokens).toBe(50);
		expect(usage!.apiCallCount).toBe(3);
		expect(usage!.subagentTokens).toBeUndefined();
	});

	it('recursively converts subagent_tokens', () => {
		const resp: TokenUsageResponse = {
			input_tokens: 100,
			cache_creation_tokens: 0,
			cache_read_tokens: 0,
			output_tokens: 50,
			api_call_count: 1,
			subagent_tokens: {
				input_tokens: 30,
				cache_creation_tokens: 5,
				cache_read_tokens: 10,
				output_tokens: 15,
				api_call_count: 1,
			},
		};
		const usage = convertTokenUsage(resp);
		expect(usage!.subagentTokens).not.toBeNull();
		expect(usage!.subagentTokens!.inputTokens).toBe(30);
		expect(usage!.subagentTokens!.cacheCreationTokens).toBe(5);
	});

	it('handles deeply nested subagent_tokens', () => {
		const resp: TokenUsageResponse = {
			input_tokens: 100,
			cache_creation_tokens: 0,
			cache_read_tokens: 0,
			output_tokens: 50,
			api_call_count: 1,
			subagent_tokens: {
				input_tokens: 30,
				cache_creation_tokens: 0,
				cache_read_tokens: 0,
				output_tokens: 15,
				api_call_count: 1,
				subagent_tokens: {
					input_tokens: 10,
					cache_creation_tokens: 0,
					cache_read_tokens: 0,
					output_tokens: 5,
					api_call_count: 1,
				},
			},
		};
		const usage = convertTokenUsage(resp);
		expect(usage!.subagentTokens!.subagentTokens!.inputTokens).toBe(10);
	});
});

describe('convertEventJSON', () => {
	// Go: external.go:224-228 ParseHookEvent: json.Unmarshal into eventJSON, then toEvent()
	const baseEvent: EventJSON = {
		type: 1,
		session_id: 'sid-1',
	};

	it.each([
		[1, EVENT_TYPE_SESSION_START],
		[2, EVENT_TYPE_TURN_START],
		[3, EVENT_TYPE_TURN_END],
		[4, EVENT_TYPE_COMPACTION],
		[5, EVENT_TYPE_SESSION_END],
		[6, EVENT_TYPE_SUBAGENT_START],
		[7, EVENT_TYPE_SUBAGENT_END],
		[8, EVENT_TYPE_MODEL_UPDATE],
	] as const)('maps numeric type %d → %s', (num, expectedType) => {
		const ev = convertEventJSON({ ...baseEvent, type: num });
		expect(ev.type).toBe(expectedType);
	});

	it('throws on unknown numeric event type', () => {
		expect(() => convertEventJSON({ ...baseEvent, type: 0 })).toThrow(/unknown event type: 0/);
		expect(() => convertEventJSON({ ...baseEvent, type: 9 })).toThrow(/unknown event type: 9/);
		expect(() => convertEventJSON({ ...baseEvent, type: -1 })).toThrow(/unknown event type: -1/);
	});

	it('parses a valid ISO-8601 timestamp into a Date', () => {
		const ev = convertEventJSON({
			...baseEvent,
			timestamp: '2026-04-21T12:34:56.789Z',
		});
		expect(ev.timestamp).toBeInstanceOf(Date);
		expect(ev.timestamp.toISOString()).toBe('2026-04-21T12:34:56.789Z');
	});

	it('falls back to epoch (Date(0)) when timestamp is absent', () => {
		const ev = convertEventJSON(baseEvent);
		expect(ev.timestamp).toBeInstanceOf(Date);
		expect(ev.timestamp.getTime()).toBe(0);
	});

	it('produces an Invalid Date when timestamp is malformed (matches JS Date semantics)', () => {
		const ev = convertEventJSON({ ...baseEvent, timestamp: 'not-a-date' });
		expect(ev.timestamp).toBeInstanceOf(Date);
		expect(Number.isNaN(ev.timestamp.getTime())).toBe(true);
	});

	it('defaults optional string fields to empty string', () => {
		const ev = convertEventJSON(baseEvent);
		expect(ev.previousSessionId).toBe('');
		expect(ev.sessionRef).toBe('');
		expect(ev.prompt).toBe('');
		expect(ev.model).toBe('');
		expect(ev.toolUseId).toBe('');
		expect(ev.subagentId).toBe('');
		expect(ev.subagentType).toBe('');
		expect(ev.taskDescription).toBe('');
		expect(ev.responseMessage).toBe('');
	});

	it('passes through populated fields verbatim', () => {
		const ev = convertEventJSON({
			type: 2,
			session_id: 'sid-1',
			previous_session_id: 'sid-0',
			session_ref: '/tmp/sess.jsonl',
			prompt: 'hello',
			model: 'claude-sonnet-4.6',
			tool_use_id: 'tu-1',
			subagent_id: 'agent-1',
			subagent_type: 'Task',
			task_description: 'do the thing',
			response_message: 'done',
			metadata: { foo: 'bar' },
		});
		expect(ev.sessionId).toBe('sid-1');
		expect(ev.previousSessionId).toBe('sid-0');
		expect(ev.sessionRef).toBe('/tmp/sess.jsonl');
		expect(ev.prompt).toBe('hello');
		expect(ev.model).toBe('claude-sonnet-4.6');
		expect(ev.toolUseId).toBe('tu-1');
		expect(ev.subagentId).toBe('agent-1');
		expect(ev.subagentType).toBe('Task');
		expect(ev.taskDescription).toBe('do the thing');
		expect(ev.responseMessage).toBe('done');
		expect(ev.metadata).toEqual({ foo: 'bar' });
	});

	it('JSON-encodes tool_input into UTF-8 bytes when present', () => {
		const ev = convertEventJSON({
			...baseEvent,
			tool_input: { path: '/tmp/x.txt', content: 'hi' },
		});
		expect(ev.toolInput).toBeInstanceOf(Uint8Array);
		const decoded = new TextDecoder().decode(ev.toolInput!);
		expect(JSON.parse(decoded)).toEqual({ path: '/tmp/x.txt', content: 'hi' });
	});

	it('leaves toolInput as null when tool_input is absent', () => {
		const ev = convertEventJSON(baseEvent);
		expect(ev.toolInput).toBeNull();
	});

	it('defaults metadata to empty object when absent', () => {
		const ev = convertEventJSON(baseEvent);
		expect(ev.metadata).toEqual({});
	});

	it('always zeroes hook-only metric fields (filled elsewhere)', () => {
		// durationMs / turnCount / contextTokens / contextWindowSize / modifiedFiles
		// are not carried over the wire by external binaries — they originate in
		// hook payloads processed by strategy methods post-conversion.
		const ev = convertEventJSON(baseEvent);
		expect(ev.durationMs).toBe(0);
		expect(ev.turnCount).toBe(0);
		expect(ev.contextTokens).toBe(0);
		expect(ev.contextWindowSize).toBe(0);
		expect(ev.modifiedFiles).toEqual([]);
	});
});

describe('ExternalAgent + fixture binary (story-agent-stub)', () => {
	// Go: external.go:34-54 New (info subcommand) + external.go:399-448 run
	beforeAll(() => {
		for (const p of [STUB_GOOD, STUB_BAD_JSON, STUB_WRONG_PROTO]) {
			chmodSync(p, 0o755);
		}
	});

	it('create() loads info JSON and exposes identity', async () => {
		const agent = await ExternalAgent.create(STUB_GOOD);
		expect(agent.name()).toBe('stub-agent');
		expect(agent.type()).toBe('Stub');
		expect(agent.info.protocol_version).toBe(PROTOCOL_VERSION);
	});

	it('create() throws when binary path does not exist', async () => {
		await expect(ExternalAgent.create('/nonexistent/path/story-agent-nope')).rejects.toThrow();
	});

	it('create() throws on invalid info JSON', async () => {
		await expect(ExternalAgent.create(STUB_BAD_JSON)).rejects.toThrow(/invalid JSON/);
	});

	it('create() throws on protocol version mismatch', async () => {
		await expect(ExternalAgent.create(STUB_WRONG_PROTO)).rejects.toThrow(
			/protocol version mismatch/,
		);
	});

	it('run() passes stdin bytes and reads stdout JSON', async () => {
		const agent = await ExternalAgent.create(STUB_GOOD);
		const out = await agent.run(undefined, new TextEncoder().encode('payload'), 'echo-stdin');
		const j = JSON.parse(new TextDecoder().decode(out)) as { got: string };
		expect(j.got).toBe('payload');
	});

	it('run() abort signal stops a hanging child', async () => {
		const agent = await ExternalAgent.create(STUB_GOOD);
		const ac = new AbortController();
		const p = agent.run(ac.signal, null, 'hang');
		setTimeout(() => ac.abort(), 50);
		await expect(p).rejects.toThrow();
	});

	it('run() throws when stdout exceeds 10MB cap', async () => {
		const agent = await ExternalAgent.create(STUB_GOOD);
		await expect(agent.run(undefined, null, 'huge-stdout')).rejects.toThrow(/output exceeded/);
	});

	it('run() surfaces stderr on non-zero exit', async () => {
		const agent = await ExternalAgent.create(STUB_GOOD);
		await expect(agent.run(undefined, null, 'fail-stderr')).rejects.toThrow(/expected failure/);
	});

	it('run() exit 0 ignores stderr content (stdout still returned)', async () => {
		const agent = await ExternalAgent.create(STUB_GOOD);
		const out = await agent.run(undefined, null, 'stderr-ok');
		expect(new TextDecoder().decode(out).trim()).toContain('ok-line');
	});

	it('getSessionID() uses spawnSync path', async () => {
		const agent = await ExternalAgent.create(STUB_GOOD);
		const id = agent.getSessionID({
			hookType: HOOK_TYPE_SESSION_START,
			sessionId: 'x',
			sessionRef: 'y',
			timestamp: new Date(0),
			userPrompt: '',
			toolName: '',
			toolUseId: '',
			toolInput: null,
			toolResponse: null,
			rawData: {},
		});
		expect(id).toBe('stub-session-id');
	});

	it('resolveSessionFile() uses spawnSync JSON response', async () => {
		const agent = await ExternalAgent.create(STUB_GOOD);
		expect(agent.resolveSessionFile('/tmp/sd', 'aid')).toBe('/tmp/resolved.json');
	});

	it('formatResumeCommand() uses spawnSync JSON response', async () => {
		const agent = await ExternalAgent.create(STUB_GOOD);
		expect(agent.formatResumeCommand('sid')).toBe('stub resume cmd');
	});

	it('detectPresence() async run parses detect JSON', async () => {
		const agent = await ExternalAgent.create(STUB_GOOD);
		await expect(agent.detectPresence()).resolves.toBe(true);
	});

	it('parseHookEvent() forwards stdin to parse-hook and returns null for stdout "null"', async () => {
		const agent = await ExternalAgent.create(STUB_GOOD);
		const ev = await agent.parseHookEvent('session-start', Readable.from([]));
		expect(ev).toBeNull();
	});

	it('getSessionID returns empty string when hook input JSON.stringify fails', async () => {
		const agent = await ExternalAgent.create(STUB_GOOD);
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		const id = agent.getSessionID({
			hookType: HOOK_TYPE_SESSION_START,
			sessionId: 'x',
			sessionRef: 'y',
			timestamp: new Date(0),
			userPrompt: '',
			toolName: '',
			toolUseId: '',
			toolInput: null,
			toolResponse: null,
			rawData: circular,
		});
		expect(id).toBe('');
	});
});
