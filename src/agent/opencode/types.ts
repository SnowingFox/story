/**
 * OpenCode agent — JSON shape interfaces, hook stdin payload shapes, and constants.
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/agent/opencode/types.go` +
 * `lifecycle.go` (HookName* const block).
 *
 * **Five concern groups**:
 * 1. {@link ExportSession} + 11 nested types — shape of `opencode export` JSON
 *    output (single JSON object, NOT JSONL — see [module.md §3.A](../../../docs/ts-rewrite/impl/phase-6-agents/phase-6.7-opencode-external-factory/module.md))
 * 2. Hook stdin payload shapes (3 raw types — `SessionInfoRaw` / `TurnStartRaw` /
 *    `TurnEndRaw`) — snake_case keys matching Go JSON tags
 * 3. Role + part-type constants (`ROLE_USER` / `ROLE_ASSISTANT`)
 * 4. {@link FILE_MODIFICATION_TOOLS} — 3 OpenCode tools that mutate files
 * 5. 5 `HOOK_NAME_*` verb constants for `story hooks opencode <verb>` subcommands
 *
 * @packageDocumentation
 */

/**
 * Top-level shape of `opencode export <sessionId>` JSON output. OpenCode's
 * native session format — a single JSON object containing session metadata
 * plus the messages array.
 *
 * **Not JSONL**: chunking + position counting work on `messages.length`, not
 * line counts. See [module.md §3.A.1](../../../docs/ts-rewrite/impl/phase-6-agents/phase-6.7-opencode-external-factory/module.md).
 */
export interface ExportSession {
	info: SessionInfo;
	messages: ExportMessage[];
}

/** Session metadata from the export. */
export interface SessionInfo {
	id: string;
	title?: string;
	/** Unix milliseconds — Go `int64`. */
	createdAt?: number;
	updatedAt?: number;
}

/** A single message envelope (info + parts). */
export interface ExportMessage {
	info: MessageInfo;
	parts: Part[];
}

/** Per-message metadata. `tokens` only present for assistant messages. */
export interface MessageInfo {
	id: string;
	sessionID?: string;
	/** `'user'` or `'assistant'` — see {@link ROLE_USER} / {@link ROLE_ASSISTANT}. */
	role: 'user' | 'assistant';
	time: Time;
	tokens?: Tokens;
	cost?: number;
}

/** Message timestamps (`completed` only for assistant messages). */
export interface Time {
	created: number;
	completed?: number;
}

/** Token counters from assistant messages. */
export interface Tokens {
	input: number;
	output: number;
	reasoning: number;
	cache: Cache;
}

/** Cache token sub-counters. */
export interface Cache {
	read: number;
	write: number;
}

/**
 * A single message part. `type === 'text'` carries `text`; `type === 'tool'`
 * carries `tool` / `callID` / `state`; `'step-start'` / `'step-finish'` are
 * streaming boundaries (no payload).
 */
export interface Part {
	/** Part ID (e.g. `'prt_...'`) — added in OpenCode 1.2.x. */
	id?: string;
	type: 'text' | 'tool' | 'step-start' | 'step-finish' | string;
	text?: string;
	tool?: string;
	callID?: string;
	state?: ToolState;
}

/** Tool execution state; `metadata.files` is the apply_patch / codex path. */
export interface ToolState {
	status: 'pending' | 'running' | 'completed' | 'error' | string;
	input?: Record<string, unknown>;
	output?: string;
	metadata?: ToolStateMetadata;
}

/** Metadata returned by tool execution; `files` populated by apply_patch. */
export interface ToolStateMetadata {
	files?: ToolFileInfo[];
}

/** A file affected by a tool operation. */
export interface ToolFileInfo {
	filePath: string;
	relativePath?: string;
}

/** `session-start` / `session-end` / `compaction` stdin payload. */
export interface SessionInfoRaw {
	session_id: string;
}

/** `turn-start` stdin payload (user prompt submitted). */
export interface TurnStartRaw {
	session_id: string;
	prompt: string;
	model: string;
}

/** `turn-end` stdin payload (session went idle). */
export interface TurnEndRaw {
	session_id: string;
	model: string;
}

/** Message role for user-authored entries. */
export const ROLE_USER = 'user' as const;
/** Message role for assistant-authored entries. */
export const ROLE_ASSISTANT = 'assistant' as const;

/**
 * File-modification tools in OpenCode (matching Go `FileModificationTools`).
 *
 * Tool selection is mutually exclusive in OpenCode upstream:
 * - `apply_patch` for `gpt-*` (non-`gpt-4`, non-`oss`) models — unified diff patches
 * - `edit` + `write` for all other models (Claude / Gemini / `gpt-4` / etc.) —
 *   exact string replacement / overwrite
 *
 * The `batch` tool (experimental) creates separate transcript parts per
 * sub-call, so its children are already captured here.
 */
export const FILE_MODIFICATION_TOOLS: readonly string[] = ['edit', 'write', 'apply_patch'] as const;

/** OpenCode `session-start` hook verb. Subcommand: `story hooks opencode session-start`. */
export const HOOK_NAME_SESSION_START = 'session-start' as const;
/** OpenCode `session-end` hook verb. Fires on `session.deleted` / `server.instance.disposed`. */
export const HOOK_NAME_SESSION_END = 'session-end' as const;
/** OpenCode `turn-start` hook verb. Fires on first text part of a new user message. */
export const HOOK_NAME_TURN_START = 'turn-start' as const;
/** OpenCode `turn-end` hook verb. Fires on `session.status.idle` (sync — see plugin). */
export const HOOK_NAME_TURN_END = 'turn-end' as const;
/** OpenCode `compaction` hook verb — emits a {@link Event} of type `Compaction`. */
export const HOOK_NAME_COMPACTION = 'compaction' as const;
