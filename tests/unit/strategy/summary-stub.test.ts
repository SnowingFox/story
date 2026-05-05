import { describe, expect, it } from 'vitest';
import { generateSummary } from '@/strategy/summary-stub';
import type { SessionState } from '@/strategy/types';

// Phase 5.3 Part 1 — summary-stub.ts is a permanent noop scaffold for the LLM
// call site. Phase 11 will replace the body of `generateSummary`. Tests below
// pin the noop contract so any accidental change in Phase 11 (or earlier)
// trips immediately.
//
// Note: `isSummarizeEnabled` lives in `src/settings/settings.ts` (mirroring
// Go's settings layer), not in summary-stub. Its tests are in the settings
// test file. condensation.ts imports both `isSummarizeEnabled` from settings
// and `generateSummary` from this file, matching Go's structure.
//
// Go: manual_commit_condensation.go (generateSummary call site —
//     `if settings.IsSummarizeEnabled(ctx) && redactedTranscript.Len() > 0`)

const baseLogCtx = { component: 'checkpoint', sessionId: 'sess-test' };

const minimalState: SessionState = {
	sessionId: 'sess-test',
	baseCommit: 'abc1234',
	startedAt: new Date(0).toISOString(),
	phase: 'idle',
	stepCount: 0,
};

describe('summary-stub.generateSummary', () => {
	// Go: manual_commit_condensation.go (generateSummary) — this stub will be
	// replaced in Phase 11 with the real LLM summary call.
	it('returns null regardless of inputs (Phase 11 will replace)', async () => {
		const transcript = new TextEncoder().encode('user: hello\nassistant: hi\n');
		const summary = await generateSummary(baseLogCtx, transcript, ['src/app.ts'], minimalState);
		expect(summary).toBeNull();
	});

	it('does not throw on edge case inputs (empty bytes, empty filesTouched)', async () => {
		await expect(
			generateSummary(baseLogCtx, new Uint8Array(), [], minimalState),
		).resolves.toBeNull();
	});

	it('does not throw on transcript with non-UTF8 bytes', async () => {
		// Defensive: even if Phase 11 implementation tries to decode the
		// transcript, the stub must not crash on edge inputs.
		const weird = new Uint8Array([0xff, 0xfe, 0x00, 0x42]);
		await expect(generateSummary(baseLogCtx, weird, [], minimalState)).resolves.toBeNull();
	});
});
