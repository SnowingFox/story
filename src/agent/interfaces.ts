/**
 * Agent contract — 1 mandatory interface (15 methods, 3 functional groups) +
 * 12 optional sub-interfaces. Mirrors Go `cmd/entire/cli/agent/agent.go`.
 *
 * **Mandatory `Agent` interface** is intentionally minimal: identity (6) +
 * transcript storage (3) + legacy session ops (6) = 15 total. Anything beyond
 * the minimum lives in an opt-in sub-interface — agents declare capability via
 * `implements` (TS) and `CapabilityDeclarer` (external agents only, see
 * `capabilities.ts`).
 *
 * @packageDocumentation
 */

import type { Event } from './event';
import type { AgentSession, HookInput, SessionChange, TokenUsage } from './session';
import type { AgentName, AgentType } from './types';

/**
 * `T | Promise<T>` — interface signature shape for methods that **may or may
 * not** need to await something internally. Implementations choose: pure
 * synchronous return when the body has no real I/O, or `async` when there's
 * a real `await`. Callers always `await`; V8 has a fast-path for awaiting a
 * non-Promise value, so the cost is zero when the implementation is sync.
 *
 * **Use this instead of `Promise<T>`** when:
 *   - Some implementations of the same interface are pure (no I/O)
 *   - Forcing every implementation to be `async` would create ceremonial
 *     async (microtask wrapping a sync return) just to satisfy the type
 *
 * @example
 * // Interface allowing both kinds of impl:
 * interface Resolver { foo(x: string): Awaitable<string>; }
 *
 * // Sync impl (no `async` — body has no `await`):
 * const pure: Resolver = { foo: (x) => x.toUpperCase() };
 *
 * // Async impl (real I/O):
 * const real: Resolver = { foo: async (x) => (await fs.readFile(x)).toString() };
 *
 * // Caller (works for both):
 * const v = await resolver.foo('y');
 */
export type Awaitable<T> = T | Promise<T>;

/**
 * Mandatory agent contract. Each agent implementation (Claude Code, Cursor,
 * Aider, Vogon, ...) converts its native format to the normalized types
 * defined in this module.
 *
 * **3 functional groups** (preserved from Go grouping comment):
 * 1. Identity (6) — name / type / description / isPreview / detectPresence /
 *    protectedDirs
 * 2. Transcript Storage (3) — readTranscript / chunkTranscript /
 *    reassembleTranscript
 * 3. Legacy Session (6) — getSessionID / getSessionDir / resolveSessionFile /
 *    readSession / writeSession / formatResumeCommand
 *
 * Agents implement this interface; optional capabilities live in the 12
 * sub-interfaces below.
 *
 * Mirrors Go `agent.Agent`.
 */
export interface Agent {
	/** Registry key (e.g. `"claude-code"`, `"vogon"`). */
	name(): AgentName;
	/** Display type stored in metadata + trailers (e.g. `"Claude Code"`). */
	type(): AgentType | string;
	/** Human-readable description for `story enable` candidate list. */
	description(): string;
	/** Preview vs stable. Affects `story enable` UI. */
	isPreview(): boolean;
	/** Whether this agent is configured in the repo (e.g. `.claude/` dir present). */
	detectPresence(ctx?: AbortSignal): Promise<boolean>;
	/** Repo-root-relative dirs that rewind / reset must NEVER touch. */
	protectedDirs(): string[];

	/** Raw transcript bytes for a session (typically reads from `sessionRef` file path). */
	readTranscript(sessionRef: string): Promise<Uint8Array>;
	/** Split transcript into chunks ≤ maxSize. JSONL chunks at line boundaries;
	 *  JSON splits message arrays. */
	chunkTranscript(content: Uint8Array, maxSize: number): Promise<Uint8Array[]>;
	/** Reverse of {@link Agent.chunkTranscript}. */
	reassembleTranscript(chunks: Uint8Array[]): Promise<Uint8Array>;

	/** Extract session ID from hook input. */
	getSessionID(input: HookInput): string;
	/** Where this agent stores session data for the given repo. */
	getSessionDir(repoPath: string): Promise<string>;
	/**
	 * File path of the session transcript.
	 *
	 * Returns {@link Awaitable} because some agents (Cursor) need to stat the
	 * filesystem to pick between layouts (e.g. nested vs flat) and others
	 * (Claude Code, Vogon) do pure path computation. Sync implementations
	 * just `return path.join(...)` without `async`; the caller always uses
	 * `await`.
	 */
	resolveSessionFile(sessionDir: string, agentSessionId: string): Awaitable<string>;
	/** Read session data from agent's storage. */
	readSession(input: HookInput): Promise<AgentSession | null>;
	/** Write session data for resumption (Phase 5.5 RestoreLogsOnly uses this). */
	writeSession(session: AgentSession): Promise<void>;
	/** Shell command to resume a session (e.g. `"claude --resume <sid>"`). */
	formatResumeCommand(sessionID: string): string;
}

/**
 * Optional: agents with lifecycle hooks (Claude Code, Cursor, Vogon, ...).
 * Mirrors Go `agent.HookSupport`.
 */
export interface HookSupport extends Agent {
	/** Hook verbs this agent supports — become subcommands under `story hooks <agent>`. */
	hookNames(): string[];
	/** Translate agent-native hook → normalized {@link Event} (or `null` if no
	 *  lifecycle action). */
	parseHookEvent(
		hookName: string,
		stdin: NodeJS.ReadableStream,
		ctx?: AbortSignal,
	): Promise<Event | null>;
	/** Install agent-specific hooks. Returns count installed. `localDev` points
	 *  hooks at a local build. */
	installHooks(opts: { localDev: boolean; force: boolean }, ctx?: AbortSignal): Promise<number>;
	/** Remove installed hooks. */
	uninstallHooks(ctx?: AbortSignal): Promise<void>;
	/** Whether hooks are currently installed. */
	areHooksInstalled(ctx?: AbortSignal): Promise<boolean>;
}

/**
 * Optional: agents using file-based detection (Aider, etc.). Mirrors Go
 * `agent.FileWatcher`.
 */
export interface FileWatcher extends Agent {
	getWatchPaths(): Promise<string[]>;
	onFileChange(path: string): Promise<SessionChange | null>;
}

/** Optional: format-aware transcript parsing. Mirrors Go `agent.TranscriptAnalyzer`. */
export interface TranscriptAnalyzer extends Agent {
	/** Current position (line count for JSONL, message count for JSON). 0 if
	 *  file missing/empty. */
	getTranscriptPosition(path: string): Promise<number>;
	/** Files modified since `startOffset`; returns `{files, currentPosition}`. */
	extractModifiedFilesFromOffset(
		path: string,
		startOffset: number,
	): Promise<{ files: string[]; currentPosition: number }>;
}

/** Optional: extract user prompts from transcript (fallback when no hook).
 *  Mirrors Go `agent.PromptExtractor`. */
export interface PromptExtractor extends Agent {
	extractPrompts(sessionRef: string, fromOffset: number): Promise<string[]>;
}

/** Optional: pre-process transcript before reading (Claude Code async flush).
 *  Mirrors Go `agent.TranscriptPreparer`. */
export interface TranscriptPreparer extends Agent {
	prepareTranscript(sessionRef: string, ctx?: AbortSignal): Promise<void>;
}

/**
 * Optional: token usage calculation. Mirrors Go `agent.TokenCalculator`.
 *
 * Returns {@link Awaitable} because some agents (Codex, OpenCode) compute
 * usage with a pure in-memory JSON/JSONL scan and return synchronously; others
 * (Claude Code) need to read subagent transcript files from disk and return a
 * Promise. Same {@link Awaitable}-based design as
 * {@link Agent.resolveSessionFile} — callers always `await` the result, and
 * V8 has a fast-path for synchronous values (zero microtask overhead).
 */
export interface TokenCalculator extends Agent {
	calculateTokenUsage(transcriptData: Uint8Array, fromOffset: number): Awaitable<TokenUsage | null>;
}

/** Optional: non-interactive text generation via agent CLI (e.g. `claude
 *  --print`). Mirrors Go `agent.TextGenerator`. */
export interface TextGenerator extends Agent {
	generateText(prompt: string, model: string, ctx?: AbortSignal): Promise<string>;
}

/** Optional: structured hook response (Claude `systemMessage` JSON, etc.).
 *  Mirrors Go `agent.HookResponseWriter`. */
export interface HookResponseWriter extends Agent {
	writeHookResponse(message: string): Promise<void>;
}

/** Optional: per-agent path resolution for restored sessions. Used by Phase
 *  5.5 RestoreLogsOnly. Mirrors Go `agent.RestoredSessionPathResolver`. */
export interface RestoredSessionPathResolver extends Agent {
	resolveRestoredSessionFile(
		sessionDir: string,
		agentSessionId: string,
		transcript: Uint8Array,
	): Promise<string>;
}

/** Optional marker: agent exists only for testing (Vogon). Excluded from
 *  `story enable` candidate list. Mirrors Go `agent.TestOnly`. */
export interface TestOnly extends Agent {
	isTestOnly(): boolean;
}

/** Optional: agents storing transcripts in `~/.<agent>/projects/<project>/...`.
 *  Enables cross-project session search. Mirrors Go `agent.SessionBaseDirProvider`. */
export interface SessionBaseDirProvider extends Agent {
	getSessionBaseDir(): Promise<string>;
}

/** Optional: agents that can spawn subagents (Claude Code Task tool). Mirrors
 *  Go `agent.SubagentAwareExtractor`. */
export interface SubagentAwareExtractor extends Agent {
	extractAllModifiedFiles(
		transcriptData: Uint8Array,
		fromOffset: number,
		subagentsDir: string,
	): Promise<string[]>;
	calculateTotalTokenUsage(
		transcriptData: Uint8Array,
		fromOffset: number,
		subagentsDir: string,
	): Promise<TokenUsage | null>;
}
