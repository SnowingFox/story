/**
 * Tests for `src/agent/external/helpers.ts` — readLimited + marshalHookInput.
 */

import { Buffer } from 'node:buffer';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { marshalHookInput, readLimited } from '@/agent/external/helpers';
import type { HookInput } from '@/agent/session';
import { HOOK_TYPE_SESSION_START } from '@/agent/types';

function baseHookInput(overrides: Partial<HookInput> = {}): HookInput {
	return {
		hookType: HOOK_TYPE_SESSION_START,
		sessionId: 's1',
		sessionRef: '/tmp/ref',
		timestamp: new Date('2026-04-21T00:00:00.000Z'),
		userPrompt: '',
		toolName: '',
		toolUseId: '',
		toolInput: null,
		toolResponse: null,
		rawData: {},
		...overrides,
	};
}

describe('readLimited', () => {
	it('null stream → empty Uint8Array', async () => {
		const out = await readLimited(null, 100);
		expect(out.byteLength).toBe(0);
	});

	it('empty readable → empty', async () => {
		const out = await readLimited(Readable.from([]), 100);
		expect(out.byteLength).toBe(0);
	});

	it('single chunk under cap → full content', async () => {
		const data = new TextEncoder().encode('hello');
		const out = await readLimited(Readable.from([data]), 100);
		expect(new TextDecoder().decode(out)).toBe('hello');
	});

	it('exact boundary: sum of chunks equals limit → keeps all bytes', async () => {
		const a = Buffer.alloc(5, 1);
		const b = Buffer.alloc(5, 2);
		const out = await readLimited(Readable.from([a, b]), 10);
		expect(out.byteLength).toBe(10);
	});

	it('over cap: truncates to limit and drains extra chunks', async () => {
		const a = Buffer.alloc(8, 1);
		const b = Buffer.alloc(8, 2);
		const out = await readLimited(Readable.from([a, b]), 10);
		expect(out.byteLength).toBe(10);
	});

	it('first chunk larger than limit → single subarray', async () => {
		const big = Buffer.alloc(20, 7);
		const out = await readLimited(Readable.from([big]), 5);
		expect(out.byteLength).toBe(5);
		expect(out.every((b) => b === 7)).toBe(true);
	});

	it('limit 0 → never buffers bytes', async () => {
		const out = await readLimited(Readable.from([Buffer.from('abc')]), 0);
		expect(out.byteLength).toBe(0);
	});
});

describe('marshalHookInput', () => {
	it('all fields populated → HookInputJSON with snake_case + ISO timestamp', () => {
		const input = baseHookInput({
			userPrompt: 'hi',
			toolName: 'edit',
			toolUseId: 'tu1',
			toolInput: new TextEncoder().encode(JSON.stringify({ path: 'x' })),
			rawData: { k: 1 },
		});
		const j = marshalHookInput(input);
		expect(j.hook_type).toBe(HOOK_TYPE_SESSION_START);
		expect(j.session_id).toBe('s1');
		expect(j.session_ref).toBe('/tmp/ref');
		expect(j.timestamp).toBe('2026-04-21T00:00:00.000Z');
		expect(j.user_prompt).toBe('hi');
		expect(j.tool_name).toBe('edit');
		expect(j.tool_use_id).toBe('tu1');
		expect(j.tool_input).toEqual({ path: 'x' });
		expect(j.raw_data).toEqual({ k: 1 });
	});

	it('empty optional strings → omitted in JSON shape (undefined fields)', () => {
		const j = marshalHookInput(baseHookInput());
		expect(j.user_prompt).toBeUndefined();
		expect(j.tool_name).toBeUndefined();
		expect(j.tool_use_id).toBeUndefined();
	});

	it('toolInput null → tool_input undefined', () => {
		const j = marshalHookInput(baseHookInput({ toolInput: null }));
		expect(j.tool_input).toBeUndefined();
	});

	it('rawData empty → raw_data undefined', () => {
		const j = marshalHookInput(baseHookInput({ rawData: {} }));
		expect(j.raw_data).toBeUndefined();
	});

	it('invalid UTF-8 in toolInput causes JSON.parse to throw', () => {
		const bad = new Uint8Array([0xff, 0xfe, 0xfd]);
		expect(() => marshalHookInput(baseHookInput({ toolInput: bad }))).toThrow();
	});

	it('invalid JSON bytes in toolInput throws', () => {
		const input = baseHookInput({
			toolInput: new TextEncoder().encode('{not json'),
		});
		expect(() => marshalHookInput(input)).toThrow();
	});

	it('toolInput decodes arbitrary JSON values (array / scalar)', () => {
		const j = marshalHookInput(
			baseHookInput({
				toolInput: new TextEncoder().encode('[1,2,3]'),
			}),
		);
		expect(j.tool_input).toEqual([1, 2, 3]);
	});
});
