import { describe, expect, it, vi } from 'vitest';
import { calculateTokenUsage } from '@/agent/token-usage';
import * as log from '@/log';
import { mockBaseAgent, mockSubagentAwareAgent, mockTokenCalcAgent } from './_helpers';

const sampleUsage = {
	inputTokens: 100,
	cacheCreationTokens: 5,
	cacheReadTokens: 3,
	outputTokens: 50,
	apiCallCount: 1,
};

const subUsage = {
	inputTokens: 200,
	cacheCreationTokens: 10,
	cacheReadTokens: 6,
	outputTokens: 80,
	apiCallCount: 2,
};

describe('agent/token-usage — Go: token_usage.go', () => {
	// Go: token_usage.go:13-41 (CalculateTokenUsage dispatcher: SAE preferred over TC).
	it('null agent → null', async () => {
		expect(await calculateTokenUsage(null, new Uint8Array(), 0, '')).toBeNull();
	});

	it('agent without TokenCalculator → null', async () => {
		expect(await calculateTokenUsage(mockBaseAgent(), new Uint8Array(), 0, '')).toBeNull();
	});

	it('agent with TokenCalculator only → returns calculator result', async () => {
		const ag = mockTokenCalcAgent(sampleUsage);
		expect(await calculateTokenUsage(ag, new Uint8Array(), 0, '')).toEqual(sampleUsage);
	});

	it('agent with SubagentAwareExtractor preferred over TokenCalculator', async () => {
		// Build a hybrid: SAE returns subUsage; the optional TokenCalculator
		// (also implemented) returns sampleUsage. SAE must win.
		const hybrid = {
			...mockSubagentAwareAgent({
				calculateTotalTokenUsage: async () => subUsage,
			}),
			calculateTokenUsage: async () => sampleUsage,
		};
		expect(await calculateTokenUsage(hybrid, new Uint8Array(), 0, '')).toEqual(subUsage);
	});

	it('calculator throws → log.debug + null', async () => {
		const debugSpy = vi.spyOn(log, 'debug').mockImplementation(() => {});
		const ag = {
			...mockTokenCalcAgent(),
			calculateTokenUsage: async () => {
				throw new Error('boom');
			},
		};
		const result = await calculateTokenUsage(ag, new Uint8Array(), 0, '');
		expect(result).toBeNull();
		expect(debugSpy).toHaveBeenCalledWith(
			expect.objectContaining({ component: 'agent.token-usage' }),
			expect.stringContaining('failed token extraction'),
			expect.objectContaining({ error: 'boom' }),
		);
		debugSpy.mockRestore();
	});

	it('SAE throws → log.debug + null (different message)', async () => {
		const debugSpy = vi.spyOn(log, 'debug').mockImplementation(() => {});
		const ag = mockSubagentAwareAgent({
			calculateTotalTokenUsage: async () => {
				throw new Error('inner');
			},
		});
		const result = await calculateTokenUsage(ag, new Uint8Array(), 0, '');
		expect(result).toBeNull();
		expect(debugSpy).toHaveBeenCalledWith(
			expect.objectContaining({ component: 'agent.token-usage' }),
			expect.stringContaining('failed subagent aware token extraction'),
			expect.objectContaining({ error: 'inner' }),
		);
		debugSpy.mockRestore();
	});
});
