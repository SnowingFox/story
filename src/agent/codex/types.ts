/**
 * Codex agent — interfaces, hook input shapes, and constants.
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/agent/codex/types.go` +
 * `lifecycle.go` (HookName* consts) + `hooks.go` (HooksFileName,
 * configFileName, featureLine, entireHookPrefixes — Story-rebranded).
 *
 * Five concern groups:
 * 1. `.codex/hooks.json` JSON shape ({@link HooksFile} / {@link HookEvents} /
 *    {@link MatcherGroup} / {@link HookEntry})
 * 2. Hook stdin payload shapes ({@link SessionStartRaw} /
 *    {@link UserPromptSubmitRaw} / {@link StopRaw}) — snake_case from Codex
 * 3. 4 hook verb constants ({@link HOOK_NAME_SESSION_START} etc.)
 * 4. File / config constants ({@link HOOKS_FILE_NAME} / {@link CONFIG_FILE_NAME} /
 *    {@link FEATURE_LINE})
 * 5. Story-side prefix constants ({@link STORY_HOOK_PREFIXES})
 *
 * **Story-side rebrand** (3 literals — see [story-vs-entire.md]):
 * - `STORY_TEST_CODEX_SESSION_DIR` env var (with `ENTIRE_TEST_*` read fallback;
 *   resolved in {@link import('./index').CodexAgent.getSessionDir})
 * - `'story hooks codex '` production hook prefix (Go: `'entire hooks codex '`)
 * - `'bun run "$(git rev-parse --show-toplevel)"/src/cli.ts hooks codex '`
 *   localDev prefix (Go: `'go run "..."/cmd/entire/main.go hooks codex '`)
 *
 * @packageDocumentation
 */

/** Top-level shape of `<repoRoot>/.codex/hooks.json`. */
export interface HooksFile {
	hooks: HookEvents;
}

/**
 * Per-event-type matcher arrays. Codex uses **PascalCase** keys
 * (`SessionStart` / `UserPromptSubmit` / `Stop` / `PreToolUse`) — different
 * from Cursor (camelCase) and Claude Code.
 *
 * Story manages 3 of the 4 (PreToolUse is pass-through, listed in
 * `hookNames()` but `parseHookEvent()` returns null without reading stdin).
 */
export interface HookEvents {
	SessionStart?: MatcherGroup[];
	UserPromptSubmit?: MatcherGroup[];
	Stop?: MatcherGroup[];
	PreToolUse?: MatcherGroup[];
}

/**
 * A matcher group: optional matcher pattern + a list of commands. Lifecycle
 * hooks (SessionStart / UserPromptSubmit / Stop) typically use `matcher: null`
 * (not filtered by tool name); PreToolUse can use a matcher like `'^Bash$'`.
 */
export interface MatcherGroup {
	matcher: string | null;
	hooks: HookEntry[];
}

/** A single Codex hook command entry. `timeout` (seconds) is optional. */
export interface HookEntry {
	type: 'command';
	command: string;
	timeout?: number;
}

/**
 * `session-start` hook stdin shape. `transcript_path` is `*string` in Go
 * (nullable); some Codex CLI source-modes (`resume` / `clear`) omit it,
 * so callers must pass through {@link derefString} for a safe fallback.
 */
export interface SessionStartRaw {
	session_id: string;
	transcript_path: string | null;
	cwd: string;
	hook_event_name: string;
	model: string;
	permission_mode: string;
	source: string;
}

/** `user-prompt-submit` hook stdin shape. */
export interface UserPromptSubmitRaw {
	session_id: string;
	turn_id: string;
	transcript_path: string | null;
	cwd: string;
	hook_event_name: string;
	model: string;
	permission_mode: string;
	prompt: string;
}

/** `stop` hook stdin shape. `last_assistant_message` is also nullable. */
export interface StopRaw {
	session_id: string;
	turn_id: string;
	transcript_path: string | null;
	cwd: string;
	hook_event_name: string;
	model: string;
	permission_mode: string;
	stop_hook_active: boolean;
	last_assistant_message: string | null;
}

/**
 * Safely dereference a nullable string field. Mirrors Go `derefString`:
 * `nil` / `undefined` → `''`; non-empty string passes through.
 *
 * @example
 * derefString(null);       // ''
 * derefString(undefined);  // ''
 * derefString('foo');      // 'foo'
 */
export function derefString(s: string | null | undefined): string {
	return s ?? '';
}

/** Codex `session-start` hook verb. Subcommand: `story hooks codex session-start`. */
export const HOOK_NAME_SESSION_START = 'session-start' as const;
/**
 * Codex `user-prompt-submit` hook verb. Subcommand:
 * `story hooks codex user-prompt-submit`.
 * Go: `lifecycle.go:HookNameUserPromptSubmit`.
 */
export const HOOK_NAME_USER_PROMPT_SUBMIT = 'user-prompt-submit' as const;
/**
 * Codex `stop` hook verb. Subcommand: `story hooks codex stop`.
 * Go: `lifecycle.go:HookNameStop`.
 */
export const HOOK_NAME_STOP = 'stop' as const;
/**
 * Codex `pre-tool-use` hook verb. Listed in `hookNames()` so the CLI
 * registers it, but {@link import('./lifecycle').parseHookEvent} returns
 * `null` (pass-through; no lifecycle action).
 */
export const HOOK_NAME_PRE_TOOL_USE = 'pre-tool-use' as const;

/** Filename of Codex's hook config under `<repoRoot>/.codex/`. */
export const HOOKS_FILE_NAME = 'hooks.json' as const;

/** Filename of Codex's TOML config under `<repoRoot>/.codex/`. */
export const CONFIG_FILE_NAME = 'config.toml' as const;

/**
 * TOML line that enables the `codex_hooks` feature. Required for Codex CLI
 * to actually invoke hooks declared in {@link HOOKS_FILE_NAME}.
 */
export const FEATURE_LINE = 'codex_hooks = true' as const;

/**
 * Hook command prefixes that identify Story-managed Codex hooks. Used by
 * {@link import('@/agent/hook-command').isManagedHookCommand} to decide
 * which entries to remove during force reinstall / uninstall.
 *
 * **Story-side divergence**: Go uses
 * `['entire ', 'go run "$(git rev-parse --show-toplevel)"/cmd/entire/main.go ']`.
 */
export const STORY_HOOK_PREFIXES: readonly string[] = [
	'story ',
	'bun run "$(git rev-parse --show-toplevel)"/src/cli.ts ',
] as const;
