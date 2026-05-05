/**
 * Shared test helpers for `tests/unit/agent/*.test.ts`.
 *
 * Mock factories cover every shape the framework dispatch path needs:
 * - {@link mockBaseAgent} — minimal Agent with no optional sub-interfaces
 * - {@link mockHookSupport} / {@link mockTokenCalcAgent} / etc. — single-capability agents
 * - {@link mockBuiltinPromptAgent} — built-in agent with Agent + PromptExtractor
 * - {@link mockFullAgent} — external (CapabilityDeclarer) agent that implements
 *   every optional sub-interface; used to verify capability gates
 * - {@link detectableAgent} / {@link undetectableAgent} / {@link testOnlyAgent}
 *   — registry detect / TestOnly behavior
 *
 * Mocks are factories (not singletons) so tests can mutate without leaking
 * state across `it()`s. Pass `overrides` to customize specific methods.
 */

import { Readable } from 'node:stream';
import { vi } from 'vitest';
import type { CapabilityDeclarer, DeclaredCaps } from '@/agent/capabilities';
import type {
	Agent,
	HookResponseWriter,
	HookSupport,
	PromptExtractor,
	SessionBaseDirProvider,
	SubagentAwareExtractor,
	TestOnly,
	TextGenerator,
	TokenCalculator,
	TranscriptAnalyzer,
	TranscriptPreparer,
} from '@/agent/interfaces';
import type { TokenUsage } from '@/agent/session';
import { AGENT_TYPE_UNKNOWN, type AgentName, type AgentType } from '@/agent/types';

/** Minimal Agent — name() + type() + every required method as no-op. */
export function mockBaseAgent(overrides: Partial<Agent> = {}): Agent {
	const base: Agent = {
		name: () => 'mock' as AgentName,
		type: () => AGENT_TYPE_UNKNOWN,
		description: () => 'mock agent',
		isPreview: () => false,
		detectPresence: async () => false,
		protectedDirs: () => [],
		readTranscript: async () => new Uint8Array(),
		chunkTranscript: async (content) => [content],
		reassembleTranscript: async (chunks) => (chunks.length === 0 ? new Uint8Array() : chunks[0]!),
		getSessionID: (input) => input.sessionId,
		getSessionDir: async () => '/tmp/mock',
		resolveSessionFile: (dir, id) => `${dir}/${id}`,
		readSession: async () => null,
		writeSession: async () => {},
		formatResumeCommand: (id) => `mock --session ${id}`,
	};
	return { ...base, ...overrides };
}

/** Built-in Agent + HookSupport (no CapabilityDeclarer). */
export function mockHookSupport(overrides: Partial<HookSupport> = {}): HookSupport {
	return {
		...mockBaseAgent(),
		hookNames: () => ['stop'],
		parseHookEvent: async () => null,
		installHooks: async () => 0,
		uninstallHooks: async () => {},
		areHooksInstalled: async () => false,
		...overrides,
	};
}

/** Built-in Agent + TranscriptAnalyzer. */
export function mockTranscriptAnalyzerAgent(
	overrides: Partial<TranscriptAnalyzer> = {},
): TranscriptAnalyzer {
	return {
		...mockBaseAgent(),
		getTranscriptPosition: async () => 0,
		extractModifiedFilesFromOffset: async () => ({ files: [], currentPosition: 0 }),
		...overrides,
	};
}

/** Built-in Agent + TranscriptPreparer. */
export function mockTranscriptPreparerAgent(
	overrides: Partial<TranscriptPreparer> = {},
): TranscriptPreparer {
	return {
		...mockBaseAgent(),
		prepareTranscript: async () => {},
		...overrides,
	};
}

/** Built-in Agent + TokenCalculator returning a fixed shape. */
export function mockTokenCalcAgent(
	usage: TokenUsage | null = null,
	overrides: Partial<TokenCalculator> = {},
): TokenCalculator {
	return {
		...mockBaseAgent(),
		calculateTokenUsage: async () => usage,
		...overrides,
	};
}

/** Built-in Agent + TextGenerator. */
export function mockTextGeneratorAgent(overrides: Partial<TextGenerator> = {}): TextGenerator {
	return {
		...mockBaseAgent(),
		generateText: async () => '',
		...overrides,
	};
}

/** Built-in Agent + HookResponseWriter. */
export function mockHookResponseWriter(
	overrides: Partial<HookResponseWriter> = {},
): HookResponseWriter {
	return {
		...mockBaseAgent(),
		writeHookResponse: async () => {},
		...overrides,
	};
}

/** Built-in Agent + PromptExtractor (no CapabilityDeclarer; gates via duck-type). */
export function mockBuiltinPromptAgent(overrides: Partial<PromptExtractor> = {}): PromptExtractor {
	return {
		...mockBaseAgent(),
		extractPrompts: async () => [],
		...overrides,
	};
}

/** Built-in Agent + SubagentAwareExtractor. */
export function mockSubagentAwareAgent(
	overrides: Partial<SubagentAwareExtractor> = {},
): SubagentAwareExtractor {
	return {
		...mockBaseAgent(),
		extractAllModifiedFiles: async () => [],
		calculateTotalTokenUsage: async () => null,
		...overrides,
	};
}

/** Built-in Agent + SessionBaseDirProvider. */
export function mockSessionBaseDirAgent(
	overrides: Partial<SessionBaseDirProvider> = {},
): SessionBaseDirProvider {
	return {
		...mockBaseAgent(),
		getSessionBaseDir: async () => '/tmp/sessions',
		...overrides,
	};
}

/** External agent (CapabilityDeclarer) implementing every optional sub-interface.
 *  Used by capability tests to verify the declared-capability gate path. */
export function mockFullAgent(
	caps: Partial<DeclaredCaps> = {},
	overrides: Partial<Agent> = {},
): Agent &
	HookSupport &
	TranscriptAnalyzer &
	TranscriptPreparer &
	TokenCalculator &
	TextGenerator &
	HookResponseWriter &
	PromptExtractor &
	SessionBaseDirProvider &
	SubagentAwareExtractor &
	CapabilityDeclarer {
	const declared: DeclaredCaps = {
		hooks: false,
		transcript_analyzer: false,
		transcript_preparer: false,
		token_calculator: false,
		text_generator: false,
		hook_response_writer: false,
		subagent_aware_extractor: false,
		...caps,
	};
	return {
		...mockBaseAgent(overrides),
		hookNames: () => ['stop'],
		parseHookEvent: async () => null,
		installHooks: async () => 0,
		uninstallHooks: async () => {},
		areHooksInstalled: async () => false,
		getTranscriptPosition: async () => 0,
		extractModifiedFilesFromOffset: async () => ({ files: [], currentPosition: 0 }),
		prepareTranscript: async () => {},
		calculateTokenUsage: async () => null,
		generateText: async () => '',
		writeHookResponse: async () => {},
		extractPrompts: async () => [],
		getSessionBaseDir: async () => '/tmp',
		extractAllModifiedFiles: async () => [],
		calculateTotalTokenUsage: async () => null,
		declaredCapabilities: () => declared,
	};
}

/** Agent that always reports `detectPresence(): true`. */
export function detectableAgent(
	name: AgentName,
	type: AgentType | string,
	protectedDirs: string[] = [],
): Agent {
	return mockBaseAgent({
		name: () => name,
		type: () => type,
		detectPresence: async () => true,
		protectedDirs: () => protectedDirs,
	});
}

/** Agent whose `detectPresence` always rejects. */
export function failingDetectAgent(name: AgentName, error: Error): Agent {
	return mockBaseAgent({
		name: () => name,
		detectPresence: async () => {
			throw error;
		},
	});
}

/** Agent + TestOnly returning `isTestOnly() === true`. */
export function testOnlyAgent(name: AgentName, type: AgentType | string): Agent & TestOnly {
	return {
		...mockBaseAgent({ name: () => name, type: () => type }),
		isTestOnly: () => true,
	};
}

/** Construct a Readable stream from a string or Buffer. */
export function makeFakeStdin(payload: string | Buffer): NodeJS.ReadableStream {
	return Readable.from([payload]);
}

/** Temporarily set / unset env vars; restores previous values via afterEach.
 *  Returns a restore() callback for explicit teardown. */
export function withMockProcessEnv(env: Record<string, string | undefined>): () => void {
	const previous: Record<string, string | undefined> = {};
	for (const [key, value] of Object.entries(env)) {
		previous[key] = process.env[key];
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
	return () => {
		for (const [key, original] of Object.entries(previous)) {
			if (original === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = original;
			}
		}
	};
}

/** Capture stdout writes during `fn()`; restores on resolve / reject. Invokes
 *  the optional callback so callers using the `(chunk, cb)` overload don't hang. */
export async function captureStdout(fn: () => Promise<void> | void): Promise<string> {
	const chunks: string[] = [];
	const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((
		chunk: string | Uint8Array,
		encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
		maybeCb?: (err?: Error | null) => void,
	) => {
		chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
		const cb = typeof encodingOrCb === 'function' ? encodingOrCb : maybeCb;
		cb?.();
		return true;
	}) as typeof process.stdout.write);
	try {
		await fn();
	} finally {
		spy.mockRestore();
	}
	return chunks.join('');
}
