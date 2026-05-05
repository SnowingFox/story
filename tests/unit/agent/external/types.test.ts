/**
 * Tests for `src/agent/external/types.ts` — protocol version constant
 * and response interface shape validation.
 */

import { describe, expect, it } from 'vitest';
import {
	type AgentSessionJSON,
	type EventJSON,
	type ExtractFilesResponse,
	type HookInputJSON,
	type InfoResponse,
	MAX_OUTPUT_BYTES,
	PROTOCOL_VERSION,
	type TokenUsageResponse,
} from '@/agent/external/types';

describe('PROTOCOL_VERSION', () => {
	// Go: types.go:14-15 ProtocolVersion const
	it('is 1', () => {
		expect(PROTOCOL_VERSION).toBe(1);
	});
});

describe('MAX_OUTPUT_BYTES', () => {
	// Go: external.go:428 stdout/stderr cap in run() (mirrors TS MAX_OUTPUT_BYTES)
	it('is 10 MB', () => {
		expect(MAX_OUTPUT_BYTES).toBe(10 * 1024 * 1024);
	});
});

describe('InfoResponse shape', () => {
	// Go: types.go:17-27 InfoResponse struct + JSON tags
	it('accepts a valid info response JSON', () => {
		const info: InfoResponse = {
			protocol_version: 1,
			name: 'my-agent',
			type: 'My Agent',
			description: 'A test agent',
			is_preview: false,
			protected_dirs: ['.myagent'],
			hook_names: ['session_start', 'stop'],
			capabilities: {
				hooks: true,
				transcript_analyzer: false,
				transcript_preparer: false,
				token_calculator: true,
				text_generator: false,
				hook_response_writer: false,
				subagent_aware_extractor: false,
			},
		};
		expect(info.protocol_version).toBe(PROTOCOL_VERSION);
		expect(info.name).toBe('my-agent');
		expect(info.capabilities.hooks).toBe(true);
		expect(info.capabilities.token_calculator).toBe(true);
		expect(info.capabilities.transcript_analyzer).toBe(false);
	});
});

describe('TokenUsageResponse shape', () => {
	// Go: types.go:91-99 TokenUsageResponse recursive subagent_tokens
	it('supports recursive subagent_tokens', () => {
		const usage: TokenUsageResponse = {
			input_tokens: 100,
			cache_creation_tokens: 10,
			cache_read_tokens: 20,
			output_tokens: 50,
			api_call_count: 2,
			subagent_tokens: {
				input_tokens: 30,
				cache_creation_tokens: 0,
				cache_read_tokens: 0,
				output_tokens: 15,
				api_call_count: 1,
			},
		};
		expect(usage.subagent_tokens!.input_tokens).toBe(30);
		expect(usage.subagent_tokens!.subagent_tokens).toBeUndefined();
	});
});

describe('AgentSessionJSON shape', () => {
	// Go: types.go:106-117 AgentSessionJSON
	it('represents session data for protocol transfer', () => {
		const session: AgentSessionJSON = {
			session_id: 'sess-1',
			agent_name: 'my-agent',
			repo_path: '/repo',
			session_ref: '/path/to/transcript',
			start_time: '2024-01-01T00:00:00Z',
			native_data: null,
			modified_files: ['a.ts'],
			new_files: [],
			deleted_files: [],
		};
		expect(session.session_id).toBe('sess-1');
		expect(session.native_data).toBeNull();
	});
});

describe('EventJSON shape', () => {
	// Go: types.go:119-135 eventJSON wire shape
	it('uses numeric type for Go iota mapping', () => {
		const event: EventJSON = {
			type: 1,
			session_id: 'sess-1',
			timestamp: '2024-01-01T00:00:00Z',
		};
		expect(event.type).toBe(1);
		expect(event.previous_session_id).toBeUndefined();
	});
});

describe('HookInputJSON shape', () => {
	// Go: types.go:163-174 HookInputJSON
	it('represents hook input for protocol transfer', () => {
		const input: HookInputJSON = {
			hook_type: 'session_start',
			session_id: 'sess-1',
			session_ref: '/path/to/ref',
			timestamp: '2024-01-01T00:00:00Z',
			user_prompt: 'hello',
		};
		expect(input.hook_type).toBe('session_start');
		expect(input.tool_name).toBeUndefined();
	});
});

describe('ExtractFilesResponse shape', () => {
	// Go: types.go:74-78 ExtractFilesResponse
	it('carries files and current_position', () => {
		const resp: ExtractFilesResponse = {
			files: ['a.ts', 'b.ts'],
			current_position: 5,
		};
		expect(resp.files).toHaveLength(2);
		expect(resp.current_position).toBe(5);
	});
});
