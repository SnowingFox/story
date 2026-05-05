import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	allProtectedDirs,
	clearForTesting,
	defaultAgent,
	detect,
	detectAll,
	get,
	getByAgentType,
	list,
	register,
	stringList,
	withTestRegistry,
} from '@/agent/registry';
import {
	AGENT_NAME_CLAUDE_CODE,
	AGENT_TYPE_CLAUDE_CODE,
	AGENT_TYPE_CURSOR,
	type AgentName,
	DEFAULT_AGENT_NAME,
} from '@/agent/types';
import { detectableAgent, failingDetectAgent, mockBaseAgent, testOnlyAgent } from './_helpers';

// Go: registry.go (Register / Get / List / StringList / Detect / DetectAll /
//                  GetByAgentType / Default / AllProtectedDirs)
// Go: registry_test.go (TestRegistryOperations + TestDetect + TestAgentNameConstants +
//                       TestDefault + TestAllProtectedDirs)

describe('agent/registry — Go: registry.go', () => {
	// Each test uses withTestRegistry to isolate from any module-level
	// self-register (e.g., src/agent/vogon.ts registers Vogon at import time).
	afterEach(() => {
		// Defensive: ensure no test leaks state.
		clearForTesting();
	});

	describe('register + get', () => {
		// Go: registry_test.go TestRegistryOperations/Register and Get.
		it('register + get returns the same agent factory result', async () => {
			await withTestRegistry(() => {
				register('test' as AgentName, () => mockBaseAgent({ name: () => 'test' as AgentName }));
				const ag = get('test' as AgentName);
				expect(ag?.name()).toBe('test');
			});
		});

		it('get(unknown) returns null', async () => {
			await withTestRegistry(() => {
				expect(get('nonexistent' as AgentName)).toBeNull();
			});
		});

		it('register(same name) replaces previous factory', async () => {
			await withTestRegistry(() => {
				register('a' as AgentName, () => mockBaseAgent({ description: () => 'first' }));
				register('a' as AgentName, () => mockBaseAgent({ description: () => 'second' }));
				expect(get('a' as AgentName)?.description()).toBe('second');
			});
		});
	});

	describe('list / stringList', () => {
		// Go: registry.go:43-53 (List sorted) + registry.go:56-69 (StringList excludes TestOnly).
		it('list() returns sorted agent names', async () => {
			await withTestRegistry(() => {
				register('agent-b' as AgentName, () => mockBaseAgent());
				register('agent-a' as AgentName, () => mockBaseAgent());
				expect(list()).toEqual(['agent-a', 'agent-b']);
			});
		});

		it('list() returns [] when empty', async () => {
			await withTestRegistry(() => {
				expect(list()).toEqual([]);
			});
		});

		it('stringList() excludes TestOnly agents', async () => {
			await withTestRegistry(() => {
				register('mock' as AgentName, () => mockBaseAgent());
				register('vogon' as AgentName, () => testOnlyAgent('vogon' as AgentName, 'Vogon Agent'));
				expect(stringList()).toEqual(['mock']);
			});
		});

		it('clearForTesting() empties registry', () => {
			register('a' as AgentName, () => mockBaseAgent());
			clearForTesting();
			expect(list()).toEqual([]);
		});
	});

	describe('detect / detectAll', () => {
		// Go: registry.go:74-98 (DetectAll iterates List() in sorted order;
		// Detect returns first detected; Detect returns null if no agents).
		it('detect() returns null when no agent detected', async () => {
			await withTestRegistry(async () => {
				register('a' as AgentName, () => mockBaseAgent({ detectPresence: async () => false }));
				expect(await detect()).toBeNull();
			});
		});

		it('detect() returns first detectable agent in sorted order', async () => {
			await withTestRegistry(async () => {
				register('z' as AgentName, () => detectableAgent('z' as AgentName, 'Z'));
				register('a' as AgentName, () => detectableAgent('a' as AgentName, 'A'));
				register('m' as AgentName, () =>
					mockBaseAgent({ name: () => 'm' as AgentName, detectPresence: async () => false }),
				);
				const found = await detect();
				expect(found?.name()).toBe('a');
			});
		});

		it('detectAll() skips agents whose detectPresence throws', async () => {
			await withTestRegistry(async () => {
				register('a' as AgentName, () => failingDetectAgent('a' as AgentName, new Error('boom')));
				register('b' as AgentName, () => detectableAgent('b' as AgentName, 'B'));
				register('c' as AgentName, () => detectableAgent('c' as AgentName, 'C'));
				const found = await detectAll();
				expect(found.map((a) => a.name())).toEqual(['b', 'c']);
			});
		});
	});

	describe('getByAgentType / defaultAgent', () => {
		// Go: registry.go:137-149 (GetByAgentType linear search) + registry.go:179-182 (Default).
		it('getByAgentType returns matching agent', async () => {
			await withTestRegistry(() => {
				register('claude-code' as AgentName, () =>
					mockBaseAgent({
						name: () => 'claude-code' as AgentName,
						type: () => AGENT_TYPE_CLAUDE_CODE,
					}),
				);
				register('cursor' as AgentName, () =>
					mockBaseAgent({
						name: () => 'cursor' as AgentName,
						type: () => AGENT_TYPE_CURSOR,
					}),
				);
				expect(getByAgentType(AGENT_TYPE_CURSOR)?.name()).toBe('cursor');
			});
		});

		it('getByAgentType("") returns null', async () => {
			await withTestRegistry(() => {
				register('a' as AgentName, () => mockBaseAgent({ type: () => 'A' }));
				expect(getByAgentType('')).toBeNull();
			});
		});

		it('defaultAgent() returns null when DEFAULT_AGENT_NAME not registered', async () => {
			await withTestRegistry(() => {
				expect(defaultAgent()).toBeNull();
			});
		});

		it('defaultAgent() returns claude-code when registered', async () => {
			await withTestRegistry(() => {
				register(DEFAULT_AGENT_NAME, () => mockBaseAgent({ name: () => AGENT_NAME_CLAUDE_CODE }));
				expect(defaultAgent()?.name()).toBe(AGENT_NAME_CLAUDE_CODE);
			});
		});
	});

	describe('allProtectedDirs', () => {
		// Go: registry.go:152-173 (union + dedupe + sort).
		it('allProtectedDirs() returns [] for empty registry', async () => {
			await withTestRegistry(() => {
				expect(allProtectedDirs()).toEqual([]);
			});
		});

		it('allProtectedDirs() unions, dedupes, sorts', async () => {
			await withTestRegistry(() => {
				register('a' as AgentName, () => mockBaseAgent({ protectedDirs: () => ['.shared'] }));
				register('b' as AgentName, () => mockBaseAgent({ protectedDirs: () => ['.shared', '.b'] }));
				expect(allProtectedDirs()).toEqual(['.b', '.shared']);
			});
		});
	});

	describe('withTestRegistry', () => {
		it('isolates state and restores after exception', async () => {
			register('persistent' as AgentName, () => mockBaseAgent());
			await expect(
				withTestRegistry(() => {
					register('temp' as AgentName, () => mockBaseAgent());
					throw new Error('boom');
				}),
			).rejects.toThrow('boom');
			// After: persistent restored, temp gone.
			expect(list()).toEqual(['persistent']);
		});
	});
});

// Note: tests use vi from vitest only via afterEach cleanup; no spies needed
// for the registry test suite. The reference here keeps biome happy if
// imports change in the future.
void vi;
