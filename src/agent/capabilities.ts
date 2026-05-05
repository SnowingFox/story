/**
 * Capability gating — pure functions that return `[T, true]` if an agent
 * implements the optional interface AND (for {@link CapabilityDeclarer} agents)
 * has declared the capability.
 *
 * **Built-in agents** (Claude Code, Cursor, Vogon, ...) implement the
 * interface directly via `implements`; the duck-type path returns
 * `[T, true]` immediately.
 *
 * **External plugin agents** (Phase 6.7) implement {@link CapabilityDeclarer}
 * and the framework checks `declaredCapabilities` before allowing the
 * sub-interface call — prevents calling `transcript_analyzer` on a binary
 * that didn't declare it.
 *
 * Mirrors Go `cmd/entire/cli/agent/capabilities.go`.
 *
 * @packageDocumentation
 */

import type {
	Agent,
	HookResponseWriter,
	HookSupport,
	PromptExtractor,
	SessionBaseDirProvider,
	SubagentAwareExtractor,
	TextGenerator,
	TokenCalculator,
	TranscriptAnalyzer,
	TranscriptPreparer,
} from './interfaces';

/**
 * JSON-serializable capability declaration. Built-in agents do NOT implement
 * this interface; only external plugin agents do (loaded from binary's `info`
 * subcommand response).
 *
 * Mirrors Go `agent.DeclaredCaps`. JSON keys snake_case match Go's external
 * agent protocol schema.
 *
 * **No `prompt_extractor` field** — `asPromptExtractor` shares the
 * `transcript_analyzer` gate (Go: `capabilities.go:138`).
 */
export interface DeclaredCaps {
	hooks: boolean;
	transcript_analyzer: boolean;
	transcript_preparer: boolean;
	token_calculator: boolean;
	text_generator: boolean;
	hook_response_writer: boolean;
	subagent_aware_extractor: boolean;
}

/** Implemented by agents that declare capabilities at registration time
 *  (external plugin agents). Mirrors Go `agent.CapabilityDeclarer`. */
export interface CapabilityDeclarer {
	declaredCapabilities(): DeclaredCaps;
}

/** Runtime check for {@link CapabilityDeclarer} (TS lacks Go's interface
 *  type-assertion; we duck-type on the marker method). */
function isCapabilityDeclarer(ag: Agent): ag is Agent & CapabilityDeclarer {
	return typeof (ag as Agent & CapabilityDeclarer).declaredCapabilities === 'function';
}

/** Common As* logic: nil-safe → duck-type marker → declarer gate. Returns
 *  `[T, gate]` where `gate` matches Go's `(<T>, bool)` 2-tuple. */
function asCapability<T extends Agent>(
	ag: Agent | null,
	hasMarker: (ag: Agent) => boolean,
	gate: (caps: DeclaredCaps) => boolean,
): [T, true] | [T, false] | [null, false] {
	if (ag === null) {
		return [null, false];
	}
	if (!hasMarker(ag)) {
		return [null, false];
	}
	const t = ag as unknown as T;
	if (isCapabilityDeclarer(ag)) {
		return gate(ag.declaredCapabilities()) ? [t, true] : [t, false];
	}
	return [t, true];
}

/**
 * Type guard: agent implements {@link HookSupport} AND (if external) has
 * declared `hooks: true`. Returns `[hookSupport, true]` on success,
 * `[null, false]` on failure (or `[hs, false]` if external + not declared).
 *
 * Mirrors Go `agent.AsHookSupport`.
 *
 * @example
 * const [hs, ok] = asHookSupport(agent);
 * if (ok) {
 *   await hs.installHooks({ localDev: false, force: false });
 * }
 *
 * asHookSupport(null);  // [null, false]
 */
export function asHookSupport(
	ag: Agent | null,
): [HookSupport, true] | [HookSupport, false] | [null, false] {
	return asCapability<HookSupport>(
		ag,
		(a) => typeof (a as HookSupport).installHooks === 'function',
		(c) => c.hooks,
	);
}

/** Mirrors Go `agent.AsTranscriptAnalyzer`. */
export function asTranscriptAnalyzer(
	ag: Agent | null,
): [TranscriptAnalyzer, true] | [TranscriptAnalyzer, false] | [null, false] {
	return asCapability<TranscriptAnalyzer>(
		ag,
		(a) => typeof (a as TranscriptAnalyzer).getTranscriptPosition === 'function',
		(c) => c.transcript_analyzer,
	);
}

/** Mirrors Go `agent.AsTranscriptPreparer`. */
export function asTranscriptPreparer(
	ag: Agent | null,
): [TranscriptPreparer, true] | [TranscriptPreparer, false] | [null, false] {
	return asCapability<TranscriptPreparer>(
		ag,
		(a) => typeof (a as TranscriptPreparer).prepareTranscript === 'function',
		(c) => c.transcript_preparer,
	);
}

/** Mirrors Go `agent.AsTokenCalculator`. */
export function asTokenCalculator(
	ag: Agent | null,
): [TokenCalculator, true] | [TokenCalculator, false] | [null, false] {
	return asCapability<TokenCalculator>(
		ag,
		(a) => typeof (a as TokenCalculator).calculateTokenUsage === 'function',
		(c) => c.token_calculator,
	);
}

/** Mirrors Go `agent.AsTextGenerator`. */
export function asTextGenerator(
	ag: Agent | null,
): [TextGenerator, true] | [TextGenerator, false] | [null, false] {
	return asCapability<TextGenerator>(
		ag,
		(a) => typeof (a as TextGenerator).generateText === 'function',
		(c) => c.text_generator,
	);
}

/** Mirrors Go `agent.AsHookResponseWriter`. */
export function asHookResponseWriter(
	ag: Agent | null,
): [HookResponseWriter, true] | [HookResponseWriter, false] | [null, false] {
	return asCapability<HookResponseWriter>(
		ag,
		(a) => typeof (a as HookResponseWriter).writeHookResponse === 'function',
		(c) => c.hook_response_writer,
	);
}

/**
 * Mirrors Go `agent.AsPromptExtractor`. **Special case**: shares the
 * `transcript_analyzer` capability gate (Go: `capabilities.go:138`).
 * Conceptually prompt extraction is part of transcript analysis.
 */
export function asPromptExtractor(
	ag: Agent | null,
): [PromptExtractor, true] | [PromptExtractor, false] | [null, false] {
	return asCapability<PromptExtractor>(
		ag,
		(a) => typeof (a as PromptExtractor).extractPrompts === 'function',
		(c) => c.transcript_analyzer, // shared gate (Go quirk)
	);
}

/**
 * Mirrors Go `agent.AsSessionBaseDirProvider`. **No capability gate** —
 * this is a built-in-only feature; external agents don't get to declare it.
 */
export function asSessionBaseDirProvider(
	ag: Agent | null,
): [SessionBaseDirProvider, true] | [null, false] {
	if (ag === null) {
		return [null, false];
	}
	if (typeof (ag as SessionBaseDirProvider).getSessionBaseDir !== 'function') {
		return [null, false];
	}
	return [ag as unknown as SessionBaseDirProvider, true];
}

/** Mirrors Go `agent.AsSubagentAwareExtractor`. */
export function asSubagentAwareExtractor(
	ag: Agent | null,
): [SubagentAwareExtractor, true] | [SubagentAwareExtractor, false] | [null, false] {
	return asCapability<SubagentAwareExtractor>(
		ag,
		(a) => typeof (a as SubagentAwareExtractor).extractAllModifiedFiles === 'function',
		(c) => c.subagent_aware_extractor,
	);
}
