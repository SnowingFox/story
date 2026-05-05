import { describe, expect, it } from 'vitest';
import { compactCursor } from '@/transcript/compact/cursor';
import { compactJSONL } from '@/transcript/compact/jsonl';
import type { CompactMetadataFields } from '@/transcript/compact/types';

const enc = new TextEncoder();

const cursorOpts: CompactMetadataFields = {
	agent: 'cursor',
	cliVersion: '0.5.1',
	startLine: 0,
};

const claudeOpts: CompactMetadataFields = {
	agent: 'claude-code',
	cliVersion: '0.5.1',
	startLine: 0,
};

describe('compactCursor — alias guard', () => {
	// Go: compact.go:127-130 userAliases (Cursor relies on compactJSONL's userAliases path)
	// Phase 5.3 Part 2 design contract: cursor.ts is a stable export that today
	// equals compactJSONL; future divergence can replace the body without
	// changing the public interface.
	it('compactCursor === compactJSONL (alias guard — function reference identity)', () => {
		expect(compactCursor).toBe(compactJSONL);
	});

	// Go: compact_test.go:423 TestCompact_CursorRoleOnly
	it('compactCursor produces identical bytes as compactJSONL on Cursor fixture', () => {
		const input = enc.encode(
			`{"role":"user","timestamp":"t1","message":{"content":"hello from cursor"}}\n` +
				`{"role":"assistant","timestamp":"t2","message":{"content":[{"type":"text","text":"Hi from Cursor!"}]}}\n`,
		);

		const viaCursor = compactCursor(input, cursorOpts);
		const viaJSONL = compactJSONL(input, cursorOpts);
		expect(viaCursor).toEqual(viaJSONL);
	});

	// Go: compact_test.go:29 TestCompact_SimpleConversation (Claude path)
	it('compactCursor produces identical bytes as compactJSONL on Claude fixture', () => {
		const input = enc.encode(
			`{"type":"user","uuid":"u1","timestamp":"2026-01-01T00:00:00Z","message":{"content":"hello"}}\n` +
				`{"type":"assistant","timestamp":"2026-01-01T00:00:01Z","message":{"id":"msg-1","content":[{"type":"text","text":"Hi!"}]}}\n`,
		);

		const viaCursor = compactCursor(input, claudeOpts);
		const viaJSONL = compactJSONL(input, claudeOpts);
		expect(viaCursor).toEqual(viaJSONL);
	});
});
