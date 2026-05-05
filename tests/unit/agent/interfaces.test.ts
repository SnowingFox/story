import { describe, expect, it } from 'vitest';
import type {
	Agent,
	FileWatcher,
	HookResponseWriter,
	HookSupport,
	PromptExtractor,
	RestoredSessionPathResolver,
	SessionBaseDirProvider,
	SubagentAwareExtractor,
	TestOnly,
	TextGenerator,
	TokenCalculator,
	TranscriptAnalyzer,
	TranscriptPreparer,
} from '@/agent/interfaces';
import { AGENT_NAME_CLAUDE_CODE, AGENT_TYPE_UNKNOWN } from '@/agent/types';

// Go: agent.go (Agent + 12 optional sub-interfaces)
// Go: agent_test.go (TestAgentInterfaceCompliance)

/** Minimal Agent stub for compile-time interface checks. */
function baseAgent(): Agent {
	return {
		name: () => AGENT_NAME_CLAUDE_CODE,
		type: () => AGENT_TYPE_UNKNOWN,
		description: () => 'mock',
		isPreview: () => false,
		detectPresence: async () => false,
		protectedDirs: () => [],
		readTranscript: async () => new Uint8Array(),
		chunkTranscript: async (content) => [content],
		reassembleTranscript: async (chunks) => chunks[0] ?? new Uint8Array(),
		getSessionID: (input) => input.sessionId,
		getSessionDir: async () => '/tmp/sessions',
		resolveSessionFile: (dir, id) => `${dir}/${id}`,
		readSession: async () => null,
		writeSession: async () => {},
		formatResumeCommand: (id) => `mock --session ${id}`,
	};
}

describe('agent/interfaces — Go: agent.go', () => {
	// Go: agent_test.go TestAgentInterfaceCompliance — interface satisfaction
	// is enforced statically; here we exercise the fact that an object
	// providing every method type-checks as Agent.
	it('Agent: 15 methods can be implemented + invoked via the interface', async () => {
		const ag: Agent = baseAgent();
		expect(ag.name()).toBe(AGENT_NAME_CLAUDE_CODE);
		expect(ag.type()).toBe(AGENT_TYPE_UNKNOWN);
		expect(ag.description()).toBe('mock');
		expect(ag.isPreview()).toBe(false);
		await expect(ag.detectPresence()).resolves.toBe(false);
		expect(ag.protectedDirs()).toEqual([]);
		await expect(ag.readTranscript('ref')).resolves.toBeInstanceOf(Uint8Array);
		await expect(ag.chunkTranscript(new Uint8Array([1]), 100)).resolves.toEqual([
			new Uint8Array([1]),
		]);
	});

	it('HookSupport extends Agent (compile-time)', () => {
		const hs: HookSupport = {
			...baseAgent(),
			hookNames: () => ['stop'],
			parseHookEvent: async () => null,
			installHooks: async () => 0,
			uninstallHooks: async () => {},
			areHooksInstalled: async () => false,
		};
		const ag: Agent = hs; // upcast must work
		expect(ag.name()).toBe(AGENT_NAME_CLAUDE_CODE);
		expect(hs.hookNames()).toEqual(['stop']);
	});

	it('FileWatcher extends Agent', () => {
		const fw: FileWatcher = {
			...baseAgent(),
			getWatchPaths: async () => ['/tmp'],
			onFileChange: async () => null,
		};
		const ag: Agent = fw;
		expect(ag.name()).toBe(AGENT_NAME_CLAUDE_CODE);
		expect(fw.getWatchPaths).toBeInstanceOf(Function);
	});

	it('TestOnly is satisfied by an agent declaring isTestOnly()', () => {
		const to: TestOnly = {
			...baseAgent(),
			isTestOnly: () => true,
		};
		expect(to.isTestOnly()).toBe(true);
	});

	it('all 12 optional sub-interfaces exist as types and accept structural shapes', () => {
		// This case is mostly compile-time; the runtime assert is just that the
		// shape is constructible (no `extends Agent` violations).
		const ta: TranscriptAnalyzer = {
			...baseAgent(),
			getTranscriptPosition: async () => 0,
			extractModifiedFilesFromOffset: async () => ({ files: [], currentPosition: 0 }),
		};
		const pe: PromptExtractor = {
			...baseAgent(),
			extractPrompts: async () => [],
		};
		const tp: TranscriptPreparer = { ...baseAgent(), prepareTranscript: async () => {} };
		const tc: TokenCalculator = { ...baseAgent(), calculateTokenUsage: async () => null };
		const tg: TextGenerator = { ...baseAgent(), generateText: async () => '' };
		const hrw: HookResponseWriter = { ...baseAgent(), writeHookResponse: async () => {} };
		const rspr: RestoredSessionPathResolver = {
			...baseAgent(),
			resolveRestoredSessionFile: async () => '',
		};
		const sbdp: SessionBaseDirProvider = {
			...baseAgent(),
			getSessionBaseDir: async () => '/tmp',
		};
		const sae: SubagentAwareExtractor = {
			...baseAgent(),
			extractAllModifiedFiles: async () => [],
			calculateTotalTokenUsage: async () => null,
		};
		// Each must be assignable to Agent (sub-interface property).
		const all: Agent[] = [ta, pe, tp, tc, tg, hrw, rspr, sbdp, sae];
		expect(all).toHaveLength(9);
	});
});
