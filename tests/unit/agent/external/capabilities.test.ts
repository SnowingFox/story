/**
 * Tests for `src/agent/external/capabilities.ts` — wrap() + WrappedAgent
 * class + isExternal().
 *
 * Uses a mock ExternalAgent that bypasses binary execution.
 */

import { describe, expect, it } from 'vitest';
import type { DeclaredCaps } from '@/agent/capabilities';
import {
	asHookSupport,
	asTextGenerator,
	asTokenCalculator,
	asTranscriptAnalyzer,
} from '@/agent/capabilities';
import { isExternal, wrap } from '@/agent/external/capabilities';
import type { ExternalAgent } from '@/agent/external/index';
import type { InfoResponse } from '@/agent/external/types';
import type { Agent } from '@/agent/interfaces';
import type { AgentName } from '@/agent/types';

function makeCaps(overrides: Partial<DeclaredCaps> = {}): DeclaredCaps {
	return {
		hooks: false,
		transcript_analyzer: false,
		transcript_preparer: false,
		token_calculator: false,
		text_generator: false,
		hook_response_writer: false,
		subagent_aware_extractor: false,
		...overrides,
	};
}

function makeInfo(caps: DeclaredCaps): InfoResponse {
	return {
		protocol_version: 1,
		name: 'test-agent',
		type: 'Test Agent',
		description: 'A test agent',
		is_preview: false,
		protected_dirs: ['.test'],
		hook_names: ['session_start'],
		capabilities: caps,
	};
}

function makeMockExternalAgent(caps: DeclaredCaps): ExternalAgent {
	const info = makeInfo(caps);
	return {
		binaryPath: '/usr/bin/story-agent-test',
		info,
		name: () => 'test-agent' as AgentName,
		type: () => 'Test Agent',
		description: () => 'A test agent',
		isPreview: () => false,
		detectPresence: async () => true,
		protectedDirs: () => ['.test'],
		readTranscript: async () => new Uint8Array(),
		chunkTranscript: async () => [],
		reassembleTranscript: async () => new Uint8Array(),
		getSessionID: () => '',
		getSessionDir: async () => '',
		resolveSessionFile: () => '',
		readSession: async () => null,
		writeSession: async () => {},
		formatResumeCommand: () => '',
		hookNames: () => ['session_start'],
		parseHookEvent: async () => null,
		installHooks: async () => 0,
		uninstallHooks: async () => {},
		areHooksInstalled: async () => false,
		getTranscriptPosition: async () => 0,
		extractModifiedFilesFromOffset: async () => ({ files: [], currentPosition: 0 }),
		extractPrompts: async () => [],
		extractSummary: async () => '',
		prepareTranscript: async () => {},
		calculateTokenUsage: async () => null,
		generateText: async () => '',
		writeHookResponse: async () => {},
		extractAllModifiedFiles: async () => [],
		calculateTotalTokenUsage: async () => null,
		run: async () => new Uint8Array(),
	} as unknown as ExternalAgent;
}

describe('wrap()', () => {
	// Go: capabilities.go:16-24 Wrap
	it('throws for null agent', () => {
		// Go: capabilities.go:17-19 nil agent check
		expect(() => wrap(null as unknown as ExternalAgent)).toThrow('unable to wrap nil agent');
	});

	// Go: capabilities.go:26-32 wrappedAgent + identity forwards
	it('returns a WrappedAgent that implements Agent', () => {
		const ea = makeMockExternalAgent(makeCaps());
		const wrapped = wrap(ea);
		expect(wrapped.name()).toBe('test-agent');
		expect(wrapped.type()).toBe('Test Agent');
		expect(wrapped.description()).toBe('A test agent');
		expect(wrapped.isPreview()).toBe(false);
		expect(wrapped.protectedDirs()).toEqual(['.test']);
	});

	// Go: capabilities.go:36 DeclaredCapabilities()
	it('forwards declaredCapabilities() from info', () => {
		const caps = makeCaps({ hooks: true, token_calculator: true });
		const ea = makeMockExternalAgent(caps);
		const wrapped = wrap(ea);
		const declared = wrapped.declaredCapabilities();
		expect(declared.hooks).toBe(true);
		expect(declared.token_calculator).toBe(true);
		expect(declared.transcript_analyzer).toBe(false);
	});
});

describe('isExternal()', () => {
	// Go: capabilities.go:132-136 IsExternal
	it('returns true for a wrapped external agent', () => {
		const ea = makeMockExternalAgent(makeCaps());
		const wrapped = wrap(ea);
		expect(isExternal(wrapped)).toBe(true);
	});

	it('returns false for a non-external agent', () => {
		const fakeAgent = {
			name: () => 'builtin',
			type: () => 'Builtin',
		} as unknown as Agent;
		expect(isExternal(fakeAgent)).toBe(false);
	});
});

describe('capability gating via As* helpers', () => {
	// Go: capabilities.go:26-130 wrappedAgent optional-interface forwards + DeclaredCapabilities gating
	it('gates hookSupport based on declared capabilities', () => {
		const capsWithHooks = makeCaps({ hooks: true });
		const ea = makeMockExternalAgent(capsWithHooks);
		const wrapped = wrap(ea);
		const [hs, ok] = asHookSupport(wrapped);
		expect(ok).toBe(true);
		expect(hs).not.toBeNull();
	});

	it('denies hookSupport when not declared', () => {
		const capsNoHooks = makeCaps({ hooks: false });
		const ea = makeMockExternalAgent(capsNoHooks);
		const wrapped = wrap(ea);
		const [, ok] = asHookSupport(wrapped);
		expect(ok).toBe(false);
	});

	it('gates transcriptAnalyzer based on declared capabilities', () => {
		const caps = makeCaps({ transcript_analyzer: true });
		const ea = makeMockExternalAgent(caps);
		const wrapped = wrap(ea);
		const [ta, ok] = asTranscriptAnalyzer(wrapped);
		expect(ok).toBe(true);
		expect(ta).not.toBeNull();
	});

	it('denies transcriptAnalyzer when not declared', () => {
		const caps = makeCaps({ transcript_analyzer: false });
		const ea = makeMockExternalAgent(caps);
		const wrapped = wrap(ea);
		const [, ok] = asTranscriptAnalyzer(wrapped);
		expect(ok).toBe(false);
	});

	it('gates tokenCalculator based on declared capabilities', () => {
		const caps = makeCaps({ token_calculator: true });
		const ea = makeMockExternalAgent(caps);
		const wrapped = wrap(ea);
		const [tc, ok] = asTokenCalculator(wrapped);
		expect(ok).toBe(true);
		expect(tc).not.toBeNull();
	});

	it('gates textGenerator based on declared capabilities', () => {
		const caps = makeCaps({ text_generator: true });
		const ea = makeMockExternalAgent(caps);
		const wrapped = wrap(ea);
		const [tg, ok] = asTextGenerator(wrapped);
		expect(ok).toBe(true);
		expect(tg).not.toBeNull();
	});

	it('denies tokenCalculator when not declared', () => {
		const caps = makeCaps({ token_calculator: false });
		const ea = makeMockExternalAgent(caps);
		const wrapped = wrap(ea);
		const [, ok] = asTokenCalculator(wrapped);
		expect(ok).toBe(false);
	});
});
