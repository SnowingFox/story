/**
 * Cursor agent — JSON shape interfaces, hook stdin payload shapes, and constants.
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/agent/cursor/types.go` +
 * `hooks.go` (hook name constants + `entireHookPrefixes`).
 *
 * Three concern groups:
 * 1. `.cursor/hooks.json` JSON shape (`CursorHooksFile` / `CursorHooks` /
 *    `CursorHookEntry`)
 * 2. Hook stdin payload shapes (7 interfaces — `SessionStartRaw` /
 *    `StopHookInputRaw` / `SessionEndRaw` / `BeforeSubmitPromptInputRaw` /
 *    `PreCompactHookInputRaw` / `SubagentStartHookInputRaw` /
 *    `SubagentStopHookInputRaw`)
 * 3. Hook verb / settings file / managed-prefix constants
 *
 * **Story-side rebrand** (3 literals — see [module.md "Story-side 偏离速查"]):
 * - `STORY_TEST_CURSOR_PROJECT_DIR` env var (with `ENTIRE_TEST_*` read fallback)
 * - `'story hooks cursor '` production hook prefix (Go: `'entire hooks cursor '`)
 * - `'bun run "$(git rev-parse --show-toplevel)"/src/cli.ts hooks cursor '`
 *   localDev prefix (Go: `'go run "..."/cmd/entire/main.go hooks cursor '`)
 *
 * @packageDocumentation
 */

/**
 * Top-level shape of `<repoRoot>/.cursor/hooks.json`. Cursor uses a flat JSON
 * file with `version` + `hooks` sections.
 *
 * Story install/uninstall preserves user-managed top-level keys
 * (`cursorSettings`, etc.) by parsing through `Record<string, unknown>` first;
 * this interface is only used for thin reads (e.g. `areHooksInstalled`).
 */
export interface CursorHooksFile {
	version?: number;
	hooks?: CursorHooks;
}

/** Per-hook-type entry arrays (camelCase keys matching Cursor's schema). */
export interface CursorHooks {
	sessionStart?: CursorHookEntry[];
	sessionEnd?: CursorHookEntry[];
	beforeSubmitPrompt?: CursorHookEntry[];
	stop?: CursorHookEntry[];
	preCompact?: CursorHookEntry[];
	subagentStart?: CursorHookEntry[];
	subagentStop?: CursorHookEntry[];
}

/** A single Cursor hook command entry. `matcher` filters by tool name on
 *  subagent hooks (optional). */
export interface CursorHookEntry {
	command: string;
	matcher?: string;
}

/**
 * Common 8 fields present in every Cursor hook stdin payload.
 *
 * `transcript_path` is populated by Cursor IDE; Cursor CLI may omit it on
 * `stop` / `session-end` / `before-submit-prompt` (the parser falls back to
 * `resolveTranscriptRef` to compute the path dynamically).
 */
interface CursorCommonHookFields {
	conversation_id: string;
	generation_id?: string;
	model?: string;
	hook_event_name?: string;
	cursor_version?: string;
	workspace_roots?: string[];
	user_email?: string;
	transcript_path?: string;
}

/** `session-start` hook stdin shape. `composer_mode` is IDE-only (`'agent'`). */
export interface SessionStartRaw extends CursorCommonHookFields {
	is_background_agent?: boolean;
	composer_mode?: string;
}

/** `stop` hook stdin shape. `loop_count` is `json.Number` in Go — TS receives
 *  `string | number`; pass through `intFromJSON`. */
export interface StopHookInputRaw extends CursorCommonHookFields {
	status?: string;
	loop_count?: string | number;
}

/** `session-end` hook stdin shape. */
export interface SessionEndRaw extends CursorCommonHookFields {
	reason?: string;
	duration_ms?: string | number;
	is_background_agent?: boolean;
	final_status?: string;
}

/** `before-submit-prompt` hook stdin shape. */
export interface BeforeSubmitPromptInputRaw extends CursorCommonHookFields {
	prompt: string;
}

/** `pre-compact` hook stdin shape. */
export interface PreCompactHookInputRaw extends CursorCommonHookFields {
	trigger?: string;
	context_usage_percent?: string | number;
	context_tokens?: string | number;
	context_window_size?: string | number;
	message_count?: string | number;
	messages_to_compact?: string | number;
	is_first_compaction?: boolean;
}

/** `subagent-start` hook stdin shape. **`task === ''`** triggers parser
 *  fast-skip (spurious IDE event). */
export interface SubagentStartHookInputRaw extends CursorCommonHookFields {
	subagent_id: string;
	subagent_type?: string;
	subagent_model?: string;
	task: string;
	parent_conversation_id?: string;
	tool_call_id?: string;
	is_parallel_worker?: boolean;
}

/** `subagent-stop` hook stdin shape. **`task === ''`** triggers parser
 *  fast-skip. `modified_files` carries the per-subagent file list. */
export interface SubagentStopHookInputRaw extends CursorCommonHookFields {
	subagent_id: string;
	subagent_type?: string;
	status?: string;
	duration_ms?: string | number;
	summary?: string;
	parent_conversation_id?: string;
	message_count?: string | number;
	tool_call_count?: string | number;
	modified_files?: string[];
	loop_count?: string | number;
	task: string;
	description?: string;
	agent_transcript_path?: string;
}

/** Cursor `session-start` hook verb. Subcommand: `story hooks cursor session-start`. */
export const HOOK_NAME_SESSION_START = 'session-start' as const;
/** Cursor `session-end` hook verb. */
export const HOOK_NAME_SESSION_END = 'session-end' as const;
/** Cursor `before-submit-prompt` hook verb. */
export const HOOK_NAME_BEFORE_SUBMIT_PROMPT = 'before-submit-prompt' as const;
/** Cursor `stop` hook verb. */
export const HOOK_NAME_STOP = 'stop' as const;
/** Cursor `pre-compact` hook verb. Emits a {@link Event} of type
 *  `Compaction` — Cursor is the first agent to use this event type. */
export const HOOK_NAME_PRE_COMPACT = 'pre-compact' as const;
/** Cursor `subagent-start` hook verb. */
export const HOOK_NAME_SUBAGENT_START = 'subagent-start' as const;
/** Cursor `subagent-stop` hook verb. */
export const HOOK_NAME_SUBAGENT_STOP = 'subagent-stop' as const;

/** Filename of Cursor's hook config under `<repoRoot>/.cursor/`. */
export const CURSOR_HOOKS_FILE_NAME = 'hooks.json' as const;

/**
 * Hook command prefixes that identify Story-managed Cursor hooks. Used by
 * `isManagedHookCommand` to decide which entries to remove during force
 * reinstall / uninstall.
 *
 * **Story-side divergence**: Go uses
 * `['entire ', 'go run "$(git rev-parse --show-toplevel)"/cmd/entire/main.go ']`.
 */
export const STORY_HOOK_PREFIXES: readonly string[] = [
	'story ',
	'bun run "$(git rev-parse --show-toplevel)"/src/cli.ts ',
] as const;
