/**
 * Phase 6.x agent registry coverage placeholders.
 *
 * Phase 6.1 Part 2 converted the `agent.calculateTokenUsage` `describe.skip`
 * block to **real** tests that exercise the framework dispatch helper
 * (`@/agent/token-usage.calculateTokenUsage`) against inline mock
 * `TokenCalculator` agents — black-box assertions matching the Go
 * `condensation_test.go::TestCalculateTokenUsage_*` expectation tables.
 *
 * Each `it()` keeps the Go anchor (`// Go: condensation_test.go:N`) so
 * Phase 6.5 / 6.7 can replace the inline mock with the real per-agent
 * implementation without losing test parity.
 *
 * @packageDocumentation
 */

import { describe, expect, it } from 'vitest';
import type { TokenUsage } from '@/agent/session';
import { calculateTokenUsage } from '@/agent/token-usage';
import { mockBaseAgent, mockTokenCalcAgent } from '../agent/_helpers';

// Helpful constructor for explicit-shape expectations.
function tokenUsage(
	input: number,
	output: number,
	apiCalls: number,
	cacheCreation = 0,
	cacheRead = 0,
): TokenUsage {
	return {
		inputTokens: input,
		outputTokens: output,
		cacheCreationTokens: cacheCreation,
		cacheReadTokens: cacheRead,
		apiCallCount: apiCalls,
	};
}

// Go: cmd/entire/cli/strategy/manual_commit_condensation_test.go
// TestCalculateTokenUsage_* — black-box assertions: framework calls
// agent.calculateTokenUsage(data, offset) and returns its result. Mock
// agents hard-code per-Go-test expected values. Real Phase 6.2-6.5 agents
// (Claude / Cursor / Codex / OpenCode) will replace these inline mocks
// with full extractor logic; assertions stay identical.
//
// Dropped-from-roadmap agents (see references/dropped-agents.md) removed
// from the placeholder set: Gemini, Copilot, Factory AI Droid. The
// `TestCalculateTokenUsage_DroidStartOffsetSkipsNonMessageLines` /
// `..._DroidStartOffsetBeyondEnd` Go anchors exercised envelope-JSONL
// offset semantics that only applied to Droid — no replacement test is
// needed for the surviving built-in agents.
describe('agent.calculateTokenUsage [Phase 6.1 Part 2: framework dispatch via mock TokenCalculator]', () => {
	it('Cursor returns null for valid Cursor transcript with offset', async () => {
		// Go: condensation_test.go:30 TestCalculateTokenUsage_CursorReturnsNil
		// Cursor doesn't expose token usage → calculateTokenUsage returns nil.
		const cursor = mockTokenCalcAgent(null, {
			name: () => 'cursor' as never,
			type: () => 'Cursor',
		});
		const result = await calculateTokenUsage(
			cursor,
			new TextEncoder().encode('{"role":"user"}\n'),
			0,
			'',
		);
		expect(result).toBeNull();
	});

	it('returns empty for empty data (Claude Code)', async () => {
		// Go: condensation_test.go:47 TestCalculateTokenUsage_EmptyData
		// Empty transcript → mock returns all-zeros TokenUsage (Go: non-nil zero struct).
		const claude = mockTokenCalcAgent(tokenUsage(0, 0, 0), {
			name: () => 'claude-code' as never,
			type: () => 'Claude Code',
		});
		const result = await calculateTokenUsage(claude, new Uint8Array(), 0, '');
		expect(result).toEqual(tokenUsage(0, 0, 0));
	});

	it('Claude Code basic transcript: input/output/cache token totals', async () => {
		// Go: condensation_test.go:61 TestCalculateTokenUsage_ClaudeCodeBasic
		// Single-turn Claude transcript → TokenUsage with apiCallCount=1,
		// inputTokens=10, outputTokens=5 (Go fixture's `usage` block carries
		// input=10/output=5; future real Claude agent will reproduce these).
		const claude = mockTokenCalcAgent(tokenUsage(10, 5, 1), {
			name: () => 'claude-code' as never,
			type: () => 'Claude Code',
		});
		const result = await calculateTokenUsage(
			claude,
			new TextEncoder().encode('{"line":1}\n'),
			0,
			'',
		);
		expect(result?.inputTokens).toBe(10);
		expect(result?.outputTokens).toBe(5);
		expect(result?.apiCallCount).toBe(1);
	});

	it('Claude Code with offset: only counts lines after offset', async () => {
		// Go: condensation_test.go:85 TestCalculateTokenUsage_ClaudeCodeWithOffset
		// 4-line transcript; offset=0 → full counts; offset=2 → only second pair.
		const claude = mockTokenCalcAgent(null, {
			name: () => 'claude-code' as never,
			type: () => 'Claude Code',
			calculateTokenUsage: async (_data, offset) =>
				offset === 0 ? tokenUsage(0, 20, 2) : tokenUsage(0, 15, 1),
		});
		const data = new TextEncoder().encode('{"l":1}\n{"l":2}\n{"l":3}\n{"l":4}\n');
		expect(await calculateTokenUsage(claude, data, 0, '')).toEqual(tokenUsage(0, 20, 2));
		expect(await calculateTokenUsage(claude, data, 2, '')).toEqual(tokenUsage(0, 15, 1));
	});

	it('Cursor with real transcript: extracts cursor-style token shape', async () => {
		// Go: condensation_test.go:178 TestCalculateTokenUsage_CursorRealTranscript
		// Cursor's transcript format → returns null (Go expected: nil).
		const cursor = mockTokenCalcAgent(null, {
			name: () => 'cursor' as never,
			type: () => 'Cursor',
		});
		const data = new TextEncoder().encode('{"type":"user","content":"hi"}\n');
		expect(await calculateTokenUsage(cursor, data, 0, '')).toBeNull();
	});

	it('Cursor with offset: skips lines before offset (still null)', async () => {
		// Go: condensation_test.go:192 TestCalculateTokenUsage_CursorWithOffset
		// Cursor with offset=3 → still null (Cursor doesn't expose tokens).
		const cursor = mockTokenCalcAgent(null, {
			name: () => 'cursor' as never,
			type: () => 'Cursor',
		});
		const data = new TextEncoder().encode('a\nb\nc\nd\n');
		expect(await calculateTokenUsage(cursor, data, 3, '')).toBeNull();
	});

	// Phase 6.1 Part 2 sanity: dispatch returns null when agent does NOT
	// implement TokenCalculator (Vogon — base agent only).
	it('returns null when agent has no TokenCalculator capability (Vogon-style base agent)', async () => {
		const baseOnly = mockBaseAgent({
			name: () => 'base-only' as never,
			type: () => 'BaseOnly',
		});
		const result = await calculateTokenUsage(baseOnly, new TextEncoder().encode('x\n'), 0, '');
		expect(result).toBeNull();
	});

	// Phase 6.1 Part 2 dispatch order: SubagentAwareExtractor wins over
	// TokenCalculator when both are implemented (Go: token_usage.go — checks
	// AsSubagentAwareExtractor first). Mirrors framework precedence so a
	// future Phase 6.2 Claude agent implementing both gets routed correctly.
	it('prefers SubagentAwareExtractor over TokenCalculator when both implemented', async () => {
		const baseOnly = mockBaseAgent({
			name: () => 'sae-and-calc' as never,
			type: () => 'SaeAndCalc',
		});
		const seenSae: Array<{ data: number; offset: number; subagentsDir: string }> = [];
		let calcCalled = false;
		const dual = {
			...baseOnly,
			calculateTotalTokenUsage: async (data: Uint8Array, offset: number, subagentsDir: string) => {
				seenSae.push({ data: data.length, offset, subagentsDir });
				return tokenUsage(99, 33, 7);
			},
			extractAllModifiedFiles: async () => [],
			calculateTokenUsage: async () => {
				calcCalled = true;
				return tokenUsage(0, 0, 0);
			},
		};
		const result = await calculateTokenUsage(
			dual as never,
			new TextEncoder().encode('x'),
			3,
			'/sub',
		);
		expect(result).toEqual(tokenUsage(99, 33, 7));
		expect(seenSae).toHaveLength(1);
		expect(seenSae[0]).toEqual({ data: 1, offset: 3, subagentsDir: '/sub' });
		expect(calcCalled).toBe(false);
	});
});

// `describe.skip('sessionStateBackfillTokenUsage Copilot fullSessionUsage')`
// was removed when Copilot CLI was dropped from the roadmap — see
// references/dropped-agents.md.
