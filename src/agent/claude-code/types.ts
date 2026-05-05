/**
 * Claude Code agent — interfaces, hook input shapes, and constants.
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/agent/claudecode/types.go`
 * (settings JSON / token usage / 5 tool name + FileModificationTools)
 * + `hooks.go: HookName* / ClaudeSettingsFileName / metadataDenyRule /
 * entireHookPrefixes`.
 *
 * Five concern groups in one module to match the Go layout:
 * 1. `.claude/settings.json` JSON shape (`ClaudeSettings` / `ClaudeHooks` /
 *    `ClaudeHookMatcher` / `ClaudeHookEntry`)
 * 2. Hook stdin payload shapes (`SessionInfoRaw` / `UserPromptSubmitRaw` /
 *    `TaskHookInputRaw` / `PostToolHookInputRaw`)
 * 3. Token-usage shapes (`MessageUsage` / `MessageWithUsage`)
 * 4. Tool name constants + `FILE_MODIFICATION_TOOLS` array
 * 5. Hook verb / settings file / metadata deny rule / managed prefix constants
 *
 * **Story-side rebrand** (5 literals — see [module.md "Story-side 偏离速查"]):
 * - `STORY_TEST_CLAUDE_PROJECT_DIR` env var (with ENTIRE_TEST_* read fallback)
 * - `Read(./.story/metadata/**)` deny rule (Go: `.entire/`)
 * - `'story '` hook prefix (Go: `'entire '`)
 * - `'bun run ${CLAUDE_PROJECT_DIR}/src/cli.ts '` localDev prefix (Go: `'go run ...'`)
 * - `STORY_HOOK_PREFIXES` array (above two)
 *
 * @packageDocumentation
 */

import type { TokenUsage } from '@/agent/session';

/**
 * Top-level shape of `<repoRoot>/.claude/settings.json`.
 *
 * Story-side install/uninstall preserves user-managed top-level keys
 * (`permissions`, `customField`, etc.) by parsing through `Record<string,
 * unknown>` first; this interface is only used for thin reads (e.g.
 * `areHooksInstalled`).
 */
export interface ClaudeSettings {
	hooks?: ClaudeHooks;
}

/** Per-hook-type matcher arrays. */
export interface ClaudeHooks {
	SessionStart?: ClaudeHookMatcher[];
	SessionEnd?: ClaudeHookMatcher[];
	Stop?: ClaudeHookMatcher[];
	UserPromptSubmit?: ClaudeHookMatcher[];
	PreToolUse?: ClaudeHookMatcher[];
	PostToolUse?: ClaudeHookMatcher[];
}

/** A matcher: filter (e.g. `'Task'`, `'TodoWrite'`, or `''` for "all") + commands. */
export interface ClaudeHookMatcher {
	matcher: string;
	hooks: ClaudeHookEntry[];
}

/** A single hook command. `type` is always `'command'` for now. */
export interface ClaudeHookEntry {
	type: 'command';
	command: string;
}

/** Used by `session-start` / `session-end` / `stop` hook stdin. */
export interface SessionInfoRaw {
	session_id: string;
	transcript_path: string;
	/** Optional model identifier (e.g. `'claude-3-5-sonnet-20240620'`); absent in older Claude versions. */
	model?: string;
}

/** Used by `user-prompt-submit` hook stdin. */
export interface UserPromptSubmitRaw {
	session_id: string;
	transcript_path: string;
	prompt: string;
}

/** Used by `pre-task` hook stdin. */
export interface TaskHookInputRaw {
	session_id: string;
	transcript_path: string;
	tool_use_id: string;
	/** Raw tool input (preserved as parsed JSON; not serialized back). */
	tool_input: unknown;
}

/** Used by `post-task` hook stdin. */
export interface PostToolHookInputRaw extends TaskHookInputRaw {
	tool_response?: {
		/**
		 * camelCase from Claude (NOT `agent_id`). Empty/missing means main agent
		 * spawned the task but no agent ID was returned (e.g. tool failed).
		 */
		agentId?: string;
	};
}

/** Per-message usage object emitted by Claude API. */
export interface MessageUsage {
	input_tokens: number;
	cache_creation_input_tokens: number;
	cache_read_input_tokens: number;
	output_tokens: number;
}

/** Assistant message with usage — used to extract token counts from transcript JSONL. */
export interface MessageWithUsage {
	id: string;
	usage: MessageUsage;
}

/** Re-export {@link TokenUsage} so callers within `claude-code/` only need one import. */
export type { TokenUsage };

/** Built-in `Write` tool. */
export const TOOL_WRITE = 'Write' as const;
/** Built-in `Edit` tool. */
export const TOOL_EDIT = 'Edit' as const;
/** Built-in `NotebookEdit` tool. */
export const TOOL_NOTEBOOK_EDIT = 'NotebookEdit' as const;
/** MCP-prefixed write tool (Claude Code agent client protocol). */
export const TOOL_MCP_WRITE = 'mcp__acp__Write' as const;
/** MCP-prefixed edit tool. */
export const TOOL_MCP_EDIT = 'mcp__acp__Edit' as const;

/**
 * Tools whose `tool_use` blocks indicate file modification.
 * Mirrors Go `FileModificationTools = []string{Write, Edit, NotebookEdit, mcp__acp__Write, mcp__acp__Edit}`.
 */
export const FILE_MODIFICATION_TOOLS: readonly string[] = [
	TOOL_WRITE,
	TOOL_EDIT,
	TOOL_NOTEBOOK_EDIT,
	TOOL_MCP_WRITE,
	TOOL_MCP_EDIT,
] as const;

export const HOOK_NAME_SESSION_START = 'session-start' as const;
export const HOOK_NAME_SESSION_END = 'session-end' as const;
export const HOOK_NAME_STOP = 'stop' as const;
export const HOOK_NAME_USER_PROMPT_SUBMIT = 'user-prompt-submit' as const;
export const HOOK_NAME_PRE_TASK = 'pre-task' as const;
export const HOOK_NAME_POST_TASK = 'post-task' as const;
export const HOOK_NAME_POST_TODO = 'post-todo' as const;

/** Filename for Claude Code settings (under `.claude/`). */
export const CLAUDE_SETTINGS_FILE_NAME = 'settings.json' as const;

/**
 * Single `permissions.deny` rule injected by `installHooks` to prevent Claude
 * from reading Story session metadata.
 *
 * **Story-side divergence**: Go uses `Read(./.entire/metadata/**)`. Story
 * uses `.story/`.
 */
export const METADATA_DENY_RULE = 'Read(./.story/metadata/**)' as const;

/**
 * Hook command prefixes that identify Story-managed hooks (used by
 * `isStoryHook` detection during `force` reinstall and uninstall).
 *
 * **Story-side divergence**: Go uses `['entire ', 'go run ${CLAUDE_PROJECT_DIR}/cmd/entire/main.go ']`.
 * Story uses `bun run` + `src/cli.ts`.
 */
export const STORY_HOOK_PREFIXES: readonly string[] = [
	'story ',
	// biome-ignore lint/suspicious/noTemplateCurlyInString: ${CLAUDE_PROJECT_DIR} is a literal shell variable placeholder Claude expands at hook-execution time, NOT a JS template substitution.
	'bun run ${CLAUDE_PROJECT_DIR}/src/cli.ts ',
] as const;
