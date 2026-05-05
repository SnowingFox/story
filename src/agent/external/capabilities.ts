/**
 * External agent capability wrapper — implements ALL optional agent interfaces
 * by forwarding to the underlying {@link ExternalAgent}. The {@link DeclaredCaps}
 * returned by {@link WrappedAgent.declaredCapabilities} controls which
 * capabilities the `As*` helpers in `capabilities.ts` will gate through.
 *
 * Mirrors Go `cmd/entire/cli/agent/external/capabilities.go`.
 *
 * @packageDocumentation
 */

import type { CapabilityDeclarer, DeclaredCaps } from '../capabilities';
import type { Event } from '../event';
import type {
	Agent,
	Awaitable,
	HookResponseWriter,
	HookSupport,
	PromptExtractor,
	SubagentAwareExtractor,
	TextGenerator,
	TokenCalculator,
	TranscriptAnalyzer,
	TranscriptPreparer,
} from '../interfaces';
import type { AgentSession, HookInput, TokenUsage } from '../session';
import type { AgentName, AgentType } from '../types';
import type { ExternalAgent } from './index';

/**
 * Wrap an {@link ExternalAgent} as an {@link Agent} that implements all optional
 * interfaces plus {@link CapabilityDeclarer}. The `As*` helpers use
 * `declaredCapabilities()` to gate access at runtime.
 *
 * Mirrors Go `external.Wrap`.
 */
export function wrap(
	ea: ExternalAgent,
): Agent &
	CapabilityDeclarer &
	HookSupport &
	TranscriptAnalyzer &
	PromptExtractor &
	TranscriptPreparer &
	TokenCalculator &
	TextGenerator &
	HookResponseWriter &
	SubagentAwareExtractor {
	if (ea == null) {
		throw new Error('unable to wrap nil agent');
	}
	return new WrappedAgent(ea);
}

/**
 * Reports whether `ag` is backed by an external agent binary.
 *
 * Mirrors Go `external.IsExternal`.
 */
export function isExternal(ag: Agent): boolean {
	return ag instanceof WrappedAgent;
}

/**
 * Forwards all agent interface methods to the underlying ExternalAgent.
 * Capability gating is handled externally by `DeclaredCapabilities()` + the
 * `As*` helpers in `capabilities.ts`.
 */
class WrappedAgent
	implements
		Agent,
		CapabilityDeclarer,
		HookSupport,
		TranscriptAnalyzer,
		PromptExtractor,
		TranscriptPreparer,
		TokenCalculator,
		TextGenerator,
		HookResponseWriter,
		SubagentAwareExtractor
{
	private readonly ea: ExternalAgent;
	private readonly caps: DeclaredCaps;

	constructor(ea: ExternalAgent) {
		this.ea = ea;
		this.caps = ea.info.capabilities;
	}

	// --- CapabilityDeclarer ---
	declaredCapabilities(): DeclaredCaps {
		return this.caps;
	}

	// --- Agent ---
	name(): AgentName {
		return this.ea.name();
	}
	type(): AgentType | string {
		return this.ea.type();
	}
	description(): string {
		return this.ea.description();
	}
	isPreview(): boolean {
		return this.ea.isPreview();
	}
	detectPresence(ctx?: AbortSignal): Promise<boolean> {
		return this.ea.detectPresence(ctx);
	}
	protectedDirs(): string[] {
		return this.ea.protectedDirs();
	}
	readTranscript(sessionRef: string): Promise<Uint8Array> {
		return this.ea.readTranscript(sessionRef);
	}
	chunkTranscript(content: Uint8Array, maxSize: number): Promise<Uint8Array[]> {
		return this.ea.chunkTranscript(content, maxSize);
	}
	reassembleTranscript(chunks: Uint8Array[]): Promise<Uint8Array> {
		return this.ea.reassembleTranscript(chunks);
	}
	getSessionID(input: HookInput): string {
		return this.ea.getSessionID(input);
	}
	getSessionDir(repoPath: string): Promise<string> {
		return this.ea.getSessionDir(repoPath);
	}
	resolveSessionFile(sessionDir: string, agentSessionId: string): Awaitable<string> {
		return this.ea.resolveSessionFile(sessionDir, agentSessionId);
	}
	readSession(input: HookInput): Promise<AgentSession | null> {
		return this.ea.readSession(input);
	}
	writeSession(session: AgentSession): Promise<void> {
		return this.ea.writeSession(session);
	}
	formatResumeCommand(sessionID: string): string {
		return this.ea.formatResumeCommand(sessionID);
	}

	// --- HookSupport ---
	hookNames(): string[] {
		return this.ea.hookNames();
	}
	parseHookEvent(
		hookName: string,
		stdin: NodeJS.ReadableStream,
		ctx?: AbortSignal,
	): Promise<Event | null> {
		return this.ea.parseHookEvent(hookName, stdin, ctx);
	}
	installHooks(opts: { localDev: boolean; force: boolean }, ctx?: AbortSignal): Promise<number> {
		return this.ea.installHooks(opts, ctx);
	}
	uninstallHooks(ctx?: AbortSignal): Promise<void> {
		return this.ea.uninstallHooks(ctx);
	}
	areHooksInstalled(ctx?: AbortSignal): Promise<boolean> {
		return this.ea.areHooksInstalled(ctx);
	}

	// --- TranscriptAnalyzer ---
	getTranscriptPosition(path: string): Promise<number> {
		return this.ea.getTranscriptPosition(path);
	}
	extractModifiedFilesFromOffset(
		path: string,
		startOffset: number,
	): Promise<{ files: string[]; currentPosition: number }> {
		return this.ea.extractModifiedFilesFromOffset(path, startOffset);
	}

	// --- PromptExtractor ---
	extractPrompts(sessionRef: string, fromOffset: number): Promise<string[]> {
		return this.ea.extractPrompts(sessionRef, fromOffset);
	}

	// --- TranscriptPreparer ---
	prepareTranscript(sessionRef: string, ctx?: AbortSignal): Promise<void> {
		return this.ea.prepareTranscript(sessionRef, ctx);
	}

	// --- TokenCalculator ---
	calculateTokenUsage(
		transcriptData: Uint8Array,
		fromOffset: number,
	): Awaitable<TokenUsage | null> {
		return this.ea.calculateTokenUsage(transcriptData, fromOffset);
	}

	// --- TextGenerator ---
	generateText(prompt: string, model: string, ctx?: AbortSignal): Promise<string> {
		return this.ea.generateText(prompt, model, ctx);
	}

	// --- HookResponseWriter ---
	writeHookResponse(message: string): Promise<void> {
		return this.ea.writeHookResponse(message);
	}

	// --- SubagentAwareExtractor ---
	extractAllModifiedFiles(
		transcriptData: Uint8Array,
		fromOffset: number,
		subagentsDir: string,
	): Promise<string[]> {
		return this.ea.extractAllModifiedFiles(transcriptData, fromOffset, subagentsDir);
	}
	calculateTotalTokenUsage(
		transcriptData: Uint8Array,
		fromOffset: number,
		subagentsDir: string,
	): Promise<TokenUsage | null> {
		return this.ea.calculateTotalTokenUsage(transcriptData, fromOffset, subagentsDir);
	}
}
