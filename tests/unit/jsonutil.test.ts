import { describe, expect, it } from 'vitest';
import {
	camelToSnake,
	camelToSnakeKeys,
	parseMetadataJSON,
	serializeMetadataJSON,
	snakeToCamel,
	snakeToCamelKeys,
} from '@/jsonutil';

describe('camelToSnake (single key)', () => {
	it('converts simple camelCase identifiers', () => {
		expect(camelToSnake('sessionId')).toBe('session_id');
		expect(camelToSnake('cliVersion')).toBe('cli_version');
		expect(camelToSnake('endLine')).toBe('end_line');
	});

	it('handles multi-word identifiers (apiCallCount, transcriptIdentifierAtStart)', () => {
		expect(camelToSnake('apiCallCount')).toBe('api_call_count');
		expect(camelToSnake('transcriptIdentifierAtStart')).toBe('transcript_identifier_at_start');
		expect(camelToSnake('checkpointTranscriptStart')).toBe('checkpoint_transcript_start');
	});

	it('passes through pure-lowercase keys unchanged', () => {
		expect(camelToSnake('id')).toBe('id');
		expect(camelToSnake('strategy')).toBe('strategy');
		expect(camelToSnake('agent')).toBe('agent');
	});

	it('passes through already-snake_case keys unchanged', () => {
		expect(camelToSnake('session_id')).toBe('session_id');
		expect(camelToSnake('already_snake_case')).toBe('already_snake_case');
	});

	it('lowercases a leading uppercase letter without prepending underscore', () => {
		// Defensive — we don't actually have such fields in metadata, but
		// guard against accidental misuse.
		expect(camelToSnake('Foo')).toBe('foo');
		expect(camelToSnake('FooBar')).toBe('foo_bar');
	});
});

describe('snakeToCamel (single key)', () => {
	it('converts simple snake_case identifiers', () => {
		expect(snakeToCamel('session_id')).toBe('sessionId');
		expect(snakeToCamel('cli_version')).toBe('cliVersion');
		expect(snakeToCamel('end_line')).toBe('endLine');
	});

	it('handles multi-word identifiers', () => {
		expect(snakeToCamel('api_call_count')).toBe('apiCallCount');
		expect(snakeToCamel('transcript_identifier_at_start')).toBe('transcriptIdentifierAtStart');
		expect(snakeToCamel('checkpoint_transcript_start')).toBe('checkpointTranscriptStart');
	});

	it('passes through already-camelCase keys unchanged (legacy data fallback)', () => {
		// Pre-fix TS wrote camelCase to disk. Reading old data must still
		// produce camelCase TS objects without breakage.
		expect(snakeToCamel('sessionId')).toBe('sessionId');
		expect(snakeToCamel('cliVersion')).toBe('cliVersion');
	});

	it('passes through pure-lowercase keys unchanged', () => {
		expect(snakeToCamel('id')).toBe('id');
		expect(snakeToCamel('strategy')).toBe('strategy');
	});
});

describe('round-trip (camelToSnake ∘ snakeToCamel)', () => {
	it('round-trips real metadata field names', () => {
		const fields = [
			'sessionId',
			'checkpointId',
			'cliVersion',
			'createdAt',
			'filesTouched',
			'tokenUsage',
			'inputTokens',
			'cacheCreationTokens',
			'cacheReadTokens',
			'outputTokens',
			'apiCallCount',
			'subagentTokens',
			'sessionMetrics',
			'durationMs',
			'turnCount',
			'contextTokens',
			'contextWindowSize',
			'initialAttribution',
			'agentLines',
			'agentRemoved',
			'humanAdded',
			'humanModified',
			'humanRemoved',
			'totalCommitted',
			'totalLinesChanged',
			'agentPercentage',
			'metricVersion',
			'calculatedAt',
			'transcriptIdentifierAtStart',
			'checkpointTranscriptStart',
			'transcriptLinesAtStart',
			'combinedAttribution',
			'isTask',
			'toolUseId',
			'turnId',
			'promptAttributions',
			'checkpointsCount',
			'sessionCount',
			'sessionIds',
			'contentHash',
			'endLine',
			'openItems',
		];
		for (const f of fields) {
			expect(snakeToCamel(camelToSnake(f))).toBe(f);
		}
	});
});

describe('camelToSnakeKeys (deep)', () => {
	it('converts top-level keys', () => {
		expect(camelToSnakeKeys({ sessionId: 's1', strategy: 'manual' })).toEqual({
			session_id: 's1',
			strategy: 'manual',
		});
	});

	it('recurses into nested objects (tokenUsage.inputTokens)', () => {
		expect(
			camelToSnakeKeys({
				sessionId: 's1',
				tokenUsage: { inputTokens: 10, subagentTokens: { apiCallCount: 1 } },
			}),
		).toEqual({
			session_id: 's1',
			token_usage: { input_tokens: 10, subagent_tokens: { api_call_count: 1 } },
		});
	});

	it('recurses into arrays of objects (sessions[].contentHash)', () => {
		expect(
			camelToSnakeKeys({
				sessions: [{ contentHash: 'h1', metadata: '/a/0/metadata.json' }, { contentHash: 'h2' }],
			}),
		).toEqual({
			sessions: [{ content_hash: 'h1', metadata: '/a/0/metadata.json' }, { content_hash: 'h2' }],
		});
	});

	it('recurses into Summary.learnings.code[].endLine', () => {
		expect(
			camelToSnakeKeys({
				learnings: {
					code: [
						{ path: 'a.ts', line: 1, endLine: 5, finding: 'x' },
						{ path: 'b.ts', finding: 'y' },
					],
					repo: ['a'],
					workflow: [],
				},
			}),
		).toEqual({
			learnings: {
				code: [
					{ path: 'a.ts', line: 1, end_line: 5, finding: 'x' },
					{ path: 'b.ts', finding: 'y' },
				],
				repo: ['a'],
				workflow: [],
			},
		});
	});

	it('preserves string values verbatim (file paths with underscores stay intact)', () => {
		expect(camelToSnakeKeys({ contentHash: '/sharded_path/raw_transcript_hash.txt' })).toEqual({
			content_hash: '/sharded_path/raw_transcript_hash.txt',
		});
	});

	it('passes through primitives, null, undefined verbatim', () => {
		expect(camelToSnakeKeys('plain')).toBe('plain');
		expect(camelToSnakeKeys(42)).toBe(42);
		expect(camelToSnakeKeys(true)).toBe(true);
		expect(camelToSnakeKeys(null)).toBe(null);
		expect(camelToSnakeKeys(undefined)).toBe(undefined);
	});

	it('does not mutate the input', () => {
		const input = { sessionId: 's1', tokenUsage: { inputTokens: 10 } };
		const snapshot = JSON.parse(JSON.stringify(input));
		camelToSnakeKeys(input);
		expect(input).toEqual(snapshot);
	});

	it('skips conversion of class-instance values (defence in depth)', () => {
		class Custom {
			fooBar = 'baz';
		}
		const result = camelToSnakeKeys({ wrap: new Custom() }) as { wrap: Custom };
		// Class instance reference is preserved; its own keys NOT converted
		// (because we don't recurse into non-plain objects).
		expect(result.wrap).toBeInstanceOf(Custom);
		expect(result.wrap.fooBar).toBe('baz');
	});
});

describe('snakeToCamelKeys (deep)', () => {
	it('converts top-level snake keys', () => {
		expect(snakeToCamelKeys({ session_id: 's1', strategy: 'manual' })).toEqual({
			sessionId: 's1',
			strategy: 'manual',
		});
	});

	it('recurses through nested + array shapes', () => {
		expect(
			snakeToCamelKeys({
				token_usage: { input_tokens: 10, subagent_tokens: { api_call_count: 1 } },
				sessions: [{ content_hash: 'h1' }, { content_hash: 'h2' }],
			}),
		).toEqual({
			tokenUsage: { inputTokens: 10, subagentTokens: { apiCallCount: 1 } },
			sessions: [{ contentHash: 'h1' }, { contentHash: 'h2' }],
		});
	});

	it('passes through legacy camelCase data (no _ to convert)', () => {
		// Pre-fix TS wrote camelCase. Reading must still produce camelCase.
		expect(snakeToCamelKeys({ sessionId: 's1', tokenUsage: { inputTokens: 10 } })).toEqual({
			sessionId: 's1',
			tokenUsage: { inputTokens: 10 },
		});
	});

	it('handles mixed snake + camel input (transition window)', () => {
		// In theory a partial-write scenario could leave both forms; both
		// should converge to camelCase TS.
		expect(snakeToCamelKeys({ session_id: 's1', cliVersion: 'v1' })).toEqual({
			sessionId: 's1',
			cliVersion: 'v1',
		});
	});

	it('does not mutate the input', () => {
		const input = { session_id: 's1', token_usage: { input_tokens: 10 } };
		const snapshot = JSON.parse(JSON.stringify(input));
		snakeToCamelKeys(input);
		expect(input).toEqual(snapshot);
	});
});

describe('round-trip (camelToSnakeKeys ∘ snakeToCamelKeys)', () => {
	it('round-trips a realistic CommittedMetadata-shaped payload', () => {
		const payload = {
			cliVersion: undefined,
			checkpointId: 'a3b2c4d5e6f7',
			sessionId: 'sess-1',
			strategy: 'manual-commit',
			createdAt: '2026-01-01T00:00:00.000Z',
			branch: 'main',
			checkpointsCount: 1,
			filesTouched: ['src/app.ts'],
			agent: 'claudecode',
			model: 'claude-sonnet-4',
			turnId: '',
			isTask: false,
			toolUseId: '',
			transcriptIdentifierAtStart: '',
			checkpointTranscriptStart: 7,
			tokenUsage: {
				inputTokens: 100,
				cacheCreationTokens: 0,
				cacheReadTokens: 0,
				outputTokens: 50,
				apiCallCount: 1,
			},
			sessionMetrics: { durationMs: 1234, turnCount: 3 },
			initialAttribution: {
				calculatedAt: '2026-01-01T00:00:00.000Z',
				agentLines: 10,
				agentPercentage: 50,
				metricVersion: 2,
			},
		};
		const snake = camelToSnakeKeys(payload);
		const back = snakeToCamelKeys(snake);
		expect(back).toEqual(payload);
		// Spot-check on-disk shape:
		expect((snake as Record<string, unknown>).session_id).toBe('sess-1');
		expect((snake as Record<string, unknown>).token_usage).toEqual({
			input_tokens: 100,
			cache_creation_tokens: 0,
			cache_read_tokens: 0,
			output_tokens: 50,
			api_call_count: 1,
		});
	});
});

describe('serializeMetadataJSON', () => {
	it('produces snake_case keys with 2-space indent and trailing newline', () => {
		const out = serializeMetadataJSON({ sessionId: 's1', tokenUsage: { inputTokens: 10 } });
		expect(out).toBe(
			[
				'{',
				'  "session_id": "s1",',
				'  "token_usage": {',
				'    "input_tokens": 10',
				'  }',
				'}',
				'',
			].join('\n'),
		);
	});

	it('round-trips through parseMetadataJSON', () => {
		const original = { sessionId: 's1', tokenUsage: { inputTokens: 10 } };
		const text = serializeMetadataJSON(original);
		const parsed = parseMetadataJSON<typeof original>(text);
		expect(parsed).toEqual(original);
	});
});

describe('parseMetadataJSON', () => {
	it('parses snake_case JSON and returns camelCase object (Go-written data)', () => {
		const text = '{"session_id":"s1","token_usage":{"input_tokens":10}}';
		expect(
			parseMetadataJSON<{ sessionId: string; tokenUsage: { inputTokens: number } }>(text),
		).toEqual({
			sessionId: 's1',
			tokenUsage: { inputTokens: 10 },
		});
	});

	it('parses legacy camelCase JSON without conversion (pre-fix TS data)', () => {
		const text = '{"sessionId":"s1","tokenUsage":{"inputTokens":10}}';
		expect(
			parseMetadataJSON<{ sessionId: string; tokenUsage: { inputTokens: number } }>(text),
		).toEqual({
			sessionId: 's1',
			tokenUsage: { inputTokens: 10 },
		});
	});

	it('throws on invalid JSON', () => {
		expect(() => parseMetadataJSON('{ not valid }')).toThrow();
	});
});
