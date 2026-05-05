import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compact } from '@/transcript/compact';
import type { CompactMetadataFields } from '@/transcript/compact/types';

const enc = new TextEncoder();
const dec = new TextDecoder();

const defaultOpts: CompactMetadataFields = {
	agent: 'claude-code',
	cliVersion: '0.5.1',
	startLine: 0,
};

const cursorOpts: CompactMetadataFields = {
	agent: 'cursor',
	cliVersion: '0.5.1',
	startLine: 0,
};

function nonEmptyLines(bytes: Uint8Array): string[] {
	return dec
		.decode(bytes)
		.split('\n')
		.filter((l) => l.trim() !== '');
}

describe('compact — main dispatch (Go 1:1 format detection)', () => {
	// Go: compact_test.go:514 TestCompact_EmptyInput
	// Go: compact.go:81-83 empty short-circuit (Compact returns ([], nil); TS returns null per documented micro-difference)
	it('returns null for empty input', () => {
		expect(compact(new Uint8Array(), defaultOpts)).toBeNull();
	});

	// Go: compact_test.go:29 TestCompact_SimpleConversation (via Compact main entry)
	// Go: compact.go:114 default branch → compactJSONL
	it('dispatches to compactJSONL for Claude transcript', () => {
		const input = enc.encode(
			`{"type":"user","timestamp":"t1","message":{"content":"hello"}}\n` +
				`{"type":"assistant","timestamp":"t2","message":{"id":"m1","content":[{"type":"text","text":"Hi!"}]}}\n`,
		);

		const result = compact(input, defaultOpts);
		expect(result).not.toBeNull();
		const lines = nonEmptyLines(result!);
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[0]!)).toMatchObject({
			v: 1,
			agent: 'claude-code',
			cli_version: '0.5.1',
			type: 'user',
		});
		expect(JSON.parse(lines[1]!)).toMatchObject({
			v: 1,
			agent: 'claude-code',
			cli_version: '0.5.1',
			type: 'assistant',
		});
	});

	// Go: compact_test.go:423 TestCompact_CursorRoleOnly (via Compact main entry)
	// Go: compact.go:127-130 userAliases — Cursor flows through compactJSONL without a cursor.go
	it('dispatches to compactJSONL for Cursor role-based JSONL (via userAliases)', () => {
		const input = enc.encode(
			`{"role":"user","timestamp":"t1","message":{"content":"hi cursor"}}\n` +
				`{"role":"assistant","timestamp":"t2","message":{"content":[{"type":"text","text":"hello"}]}}\n`,
		);

		const result = compact(input, cursorOpts);
		expect(result).not.toBeNull();
		const lines = nonEmptyLines(result!);
		expect(lines).toHaveLength(2);
		const parsedUser = JSON.parse(lines[0]!) as Record<string, unknown>;
		expect(parsedUser.type).toBe('user');
		expect(parsedUser.agent).toBe('cursor');
		const parsedAssistant = JSON.parse(lines[1]!) as Record<string, unknown>;
		expect(parsedAssistant.type).toBe('assistant');
	});

	// Go: compact.go:114 default branch (unrecognised JSONL falls through to compactJSONL)
	it('dispatches to compactJSONL for unknown JSONL agent (no special detection)', () => {
		// "weird-agent" foreign type/role → normalizeKind returns '' → line dropped, but framework runs.
		const input = enc.encode(`{"type":"user","timestamp":"t1","message":{"content":"foo"}}\n`);
		const result = compact(input, { ...defaultOpts, agent: 'unknown' });
		expect(result).not.toBeNull();
		const lines = nonEmptyLines(result!);
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0]!)).toMatchObject({ agent: 'unknown', type: 'user' });
	});

	// Dropped-agent format payloads must NOT match any dispatch branch after
	// their detectors were removed. Each sample falls through to compactJSONL
	// which emits 0 lines because none match a recognised JSONL kind.
	// Dropped agents (see references/dropped-agents.md): Gemini, Copilot CLI,
	// Factory AI Droid. Codex ships a real detector (so its session_meta
	// header IS recognised) — it's covered by the dedicated codex tests.
	it.each([
		['Gemini-style top-level JSON', `{"sessionId":"x","projectHash":"y"}`],
		['Copilot-style hook line', `{"type":"hook.start","name":"x"}\n`],
		['Droid-style envelope', `{"type":"session_start","session_id":"x"}\n`],
	])('falls through to compactJSONL for dropped-agent format: %s', (_label, body) => {
		const result = compact(enc.encode(body), defaultOpts);
		// Either result is null (empty after compactJSONL), or has 0 emitted lines
		if (result !== null) {
			expect(nonEmptyLines(result)).toHaveLength(0);
		}
	});

	// Go: compact_test.go:524 TestCompact_StartLineBeyondEnd
	// Go: compact.go:101-104 sliceFromLine nil handling
	it('returns null when sliceFromLine yields null (startLine beyond end)', () => {
		const input = enc.encode(
			`{"type":"user","uuid":"u1","timestamp":"t1","message":{"content":"hello"}}\n`,
		);
		const result = compact(input, { ...defaultOpts, startLine: 100 });
		expect(result).toBeNull();
	});

	// Go: compact_test.go:178 TestCompact_ClaudeFixture (via Compact main entry)
	it('roundtrips testdata/claude_full.jsonl fixture', () => {
		const input = readFileSync(join(__dirname, 'testdata', 'claude_full.jsonl'));
		const expected = readFileSync(join(__dirname, 'testdata', 'claude_expected.jsonl'), 'utf8')
			.split('\n')
			.filter((l) => l.trim() !== '');

		const result = compact(input, defaultOpts);
		expect(result).not.toBeNull();
		const got = nonEmptyLines(result!);
		expect(got).toHaveLength(expected.length);
		for (let i = 0; i < expected.length; i++) {
			expect(JSON.parse(got[i]!)).toEqual(JSON.parse(expected[i]!));
		}
	});
});
