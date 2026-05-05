import { describe, expect, it } from 'vitest';
import {
	asHookResponseWriter,
	asHookSupport,
	asPromptExtractor,
	asSessionBaseDirProvider,
	asSubagentAwareExtractor,
	asTextGenerator,
	asTokenCalculator,
	asTranscriptAnalyzer,
	asTranscriptPreparer,
} from '@/agent/capabilities';
import {
	mockBaseAgent,
	mockBuiltinPromptAgent,
	mockFullAgent,
	mockHookResponseWriter,
	mockHookSupport,
	mockSessionBaseDirAgent,
	mockSubagentAwareAgent,
	mockTextGeneratorAgent,
	mockTokenCalcAgent,
	mockTranscriptAnalyzerAgent,
	mockTranscriptPreparerAgent,
} from './_helpers';

// Go: capabilities.go (CapabilityDeclarer + 9 As* helpers)
// Go: capabilities_test.go (TestAsHookSupport + TestAsXxx — 4 sub each)

describe('agent/capabilities — Go: capabilities.go', () => {
	describe('asHookSupport', () => {
		// Go: capabilities.go:30-42 (AsHookSupport — Hooks gate)
		it('null → [null, false]', () => {
			expect(asHookSupport(null)).toEqual([null, false]);
		});
		it('agent without HookSupport → [null, false]', () => {
			expect(asHookSupport(mockBaseAgent())).toEqual([null, false]);
		});
		it('built-in agent with HookSupport → [hs, true]', () => {
			const hs = mockHookSupport();
			expect(asHookSupport(hs)).toEqual([hs, true]);
		});
		it('declarer hooks=false → [hs, false]', () => {
			const ag = mockFullAgent({ hooks: false });
			expect(asHookSupport(ag)).toEqual([ag, false]);
		});
		it('declarer hooks=true → [hs, true]', () => {
			const ag = mockFullAgent({ hooks: true });
			expect(asHookSupport(ag)).toEqual([ag, true]);
		});
	});

	describe('asTranscriptAnalyzer', () => {
		// Go: capabilities.go:46-58 (AsTranscriptAnalyzer)
		it('null → [null, false]', () => {
			expect(asTranscriptAnalyzer(null)).toEqual([null, false]);
		});
		it('built-in pass; declarer false → [ta, false]', () => {
			const ta = mockTranscriptAnalyzerAgent();
			expect(asTranscriptAnalyzer(ta)).toEqual([ta, true]);
			const ext = mockFullAgent({ transcript_analyzer: false });
			expect(asTranscriptAnalyzer(ext)).toEqual([ext, false]);
			const ext2 = mockFullAgent({ transcript_analyzer: true });
			expect(asTranscriptAnalyzer(ext2)).toEqual([ext2, true]);
		});
	});

	describe('asTranscriptPreparer', () => {
		// Go: capabilities.go:62-74 (AsTranscriptPreparer)
		it('built-in pass; declarer false → [tp, false]', () => {
			const tp = mockTranscriptPreparerAgent();
			expect(asTranscriptPreparer(tp)).toEqual([tp, true]);
			const ext = mockFullAgent({ transcript_preparer: false });
			expect(asTranscriptPreparer(ext)).toEqual([ext, false]);
			expect(asTranscriptPreparer(null)).toEqual([null, false]);
			expect(asTranscriptPreparer(mockBaseAgent())).toEqual([null, false]);
		});
	});

	describe('asTokenCalculator', () => {
		// Go: capabilities.go:78-90 (AsTokenCalculator)
		it('null / not-implemented → [null, false]', () => {
			// Go: capabilities_test.go TestAsTokenCalculator/{nil, not implemented}
			expect(asTokenCalculator(null)).toEqual([null, false]);
			expect(asTokenCalculator(mockBaseAgent())).toEqual([null, false]);
		});
		it('built-in pass; declarer false → [tc, false]; declarer true → [tc, true]', () => {
			const tc = mockTokenCalcAgent();
			expect(asTokenCalculator(tc)).toEqual([tc, true]);
			const ext = mockFullAgent({ token_calculator: false });
			expect(asTokenCalculator(ext)).toEqual([ext, false]);
			const ext2 = mockFullAgent({ token_calculator: true });
			expect(asTokenCalculator(ext2)).toEqual([ext2, true]);
		});
	});

	describe('asTextGenerator', () => {
		// Go: capabilities.go:94-106 (AsTextGenerator)
		it('null / not-implemented → [null, false]', () => {
			// Go: capabilities_test.go TestAsTextGenerator/{nil, not implemented}
			expect(asTextGenerator(null)).toEqual([null, false]);
			expect(asTextGenerator(mockBaseAgent())).toEqual([null, false]);
		});
		it('built-in pass; declarer false → [tg, false]; declarer true → [tg, true]', () => {
			const tg = mockTextGeneratorAgent();
			expect(asTextGenerator(tg)).toEqual([tg, true]);
			const ext = mockFullAgent({ text_generator: false });
			expect(asTextGenerator(ext)).toEqual([ext, false]);
			const ext2 = mockFullAgent({ text_generator: true });
			expect(asTextGenerator(ext2)).toEqual([ext2, true]);
		});
	});

	describe('asHookResponseWriter', () => {
		// Go: capabilities.go:110-122 (AsHookResponseWriter)
		it('null / not-implemented → [null, false]', () => {
			// Go: capabilities_test.go TestAsHookResponseWriter/{nil, not implemented}
			expect(asHookResponseWriter(null)).toEqual([null, false]);
			expect(asHookResponseWriter(mockBaseAgent())).toEqual([null, false]);
		});
		it('built-in pass; declarer false → [hrw, false]; declarer true → [hrw, true]', () => {
			const hrw = mockHookResponseWriter();
			expect(asHookResponseWriter(hrw)).toEqual([hrw, true]);
			const ext = mockFullAgent({ hook_response_writer: false });
			expect(asHookResponseWriter(ext)).toEqual([ext, false]);
			const ext2 = mockFullAgent({ hook_response_writer: true });
			expect(asHookResponseWriter(ext2)).toEqual([ext2, true]);
		});
	});

	describe('asPromptExtractor (shared transcript_analyzer gate)', () => {
		// Go: capabilities.go:129-141 (AsPromptExtractor — uses TranscriptAnalyzer field).
		it('null / not-implemented → [null, false]', () => {
			// Go: capabilities_test.go TestAsPromptExtractor/{nil, not implemented}
			expect(asPromptExtractor(null)).toEqual([null, false]);
			expect(asPromptExtractor(mockBaseAgent())).toEqual([null, false]);
		});
		it('built-in PromptExtractor → [pe, true]', () => {
			const pe = mockBuiltinPromptAgent();
			expect(asPromptExtractor(pe)).toEqual([pe, true]);
		});
		it('declarer transcript_analyzer=true → [pe, true]', () => {
			const ext = mockFullAgent({ transcript_analyzer: true });
			expect(asPromptExtractor(ext)).toEqual([ext, true]);
		});
		it('declarer transcript_analyzer=false → [pe, false] (Go-aligned shared gate)', () => {
			// Note: token_calculator etc. are irrelevant; only transcript_analyzer counts.
			const ext = mockFullAgent({ transcript_analyzer: false, token_calculator: true });
			expect(asPromptExtractor(ext)).toEqual([ext, false]);
		});
	});

	describe('asSessionBaseDirProvider (NO capability gate)', () => {
		// Go: capabilities.go:146-155 (AsSessionBaseDirProvider — built-in only).
		it('null → [null, false]', () => {
			expect(asSessionBaseDirProvider(null)).toEqual([null, false]);
		});
		it('built-in → [sbp, true]', () => {
			const sbp = mockSessionBaseDirAgent();
			expect(asSessionBaseDirProvider(sbp)).toEqual([sbp, true]);
		});
		it('declarer with all-false caps still returns [sbp, true] (no gate)', () => {
			const ext = mockFullAgent({});
			expect(asSessionBaseDirProvider(ext)).toEqual([ext, true]);
		});
	});

	describe('asSubagentAwareExtractor', () => {
		// Go: capabilities.go:159-171 (AsSubagentAwareExtractor)
		it('null / not-implemented → [null, false]', () => {
			// Go: capabilities_test.go TestAsSubagentAwareExtractor/{nil, not implemented}
			expect(asSubagentAwareExtractor(null)).toEqual([null, false]);
			expect(asSubagentAwareExtractor(mockBaseAgent())).toEqual([null, false]);
		});
		it('built-in pass; declarer false → [sae, false]; declarer true → [sae, true]', () => {
			const sae = mockSubagentAwareAgent();
			expect(asSubagentAwareExtractor(sae)).toEqual([sae, true]);
			const ext = mockFullAgent({ subagent_aware_extractor: false });
			expect(asSubagentAwareExtractor(ext)).toEqual([ext, false]);
			const ext2 = mockFullAgent({ subagent_aware_extractor: true });
			expect(asSubagentAwareExtractor(ext2)).toEqual([ext2, true]);
		});
	});
});
