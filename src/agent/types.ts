/**
 * Agent identifier types — single source of truth for the 5 canonical agent
 * type strings + 4 registry name keys + 6 hook lifecycle types + 4 entry kinds.
 *
 * Mirrors Go:
 * - `cmd/entire/cli/agent/types/agent.go`     (`AgentName` / `AgentType` newtype)
 * - `cmd/entire/cli/agent/registry.go:103-122` (`AgentName*` + `AgentType*` + `DefaultAgentName`)
 * - `cmd/entire/cli/agent/types.go:7-14`       (6 `Hook*` const)
 * - `cmd/entire/cli/agent/session.go:60-65`    (4 `Entry*` const)
 *
 * Phase 5.1 shipped this file as a lite anchor with string constants and
 * `AgentType = string`. Phase 6.1 upgrades:
 *   1. Adds `AGENT_NAME_*` constants + `AgentName` branded string
 *   2. Promotes `AgentType` to a union of the canonical string literals
 *   3. Adds `HookType` 6 const + union (lifecycle event kinds)
 *   4. Adds `EntryType` 4 const + union (session entry kinds)
 *   5. Adds {@link normalize} helper to convert raw metadata.agent → AgentType
 *
 * **Dropped from the roadmap** (not in the `AgentType` union): Gemini CLI,
 * Copilot CLI, and Factory AI Droid — see
 * [`references/dropped-agents.md`](../../docs/ts-rewrite/impl/references/dropped-agents.md).
 * External-plugin agents (Phase 6.7) can still ship these shapes out-of-tree
 * via `story-agent-*` binaries.
 *
 * @packageDocumentation
 */

/** Anthropic Claude Code agent. */
export const AGENT_TYPE_CLAUDE_CODE = 'Claude Code' as const;
/** OpenAI Codex agent. */
export const AGENT_TYPE_CODEX = 'Codex' as const;
/** Cursor agent. */
export const AGENT_TYPE_CURSOR = 'Cursor' as const;
/** OpenCode agent. */
export const AGENT_TYPE_OPENCODE = 'OpenCode' as const;
/** Unknown / unrecognized agent — fallback for metadata-stored values that
 *  don't match any registered agent. */
export const AGENT_TYPE_UNKNOWN = 'Unknown' as const;

/**
 * External / plugin agent type — any `story-agent-*` binary's self-reported
 * `AgentType` string. Modeled as `string & {}` so:
 *
 * - IDE autocomplete still shows the built-in `AGENT_TYPE_*` literals first
 *   (the union keeps its narrow members visible at suggestion time).
 * - Arbitrary third-party agent strings remain assignable without a cast.
 * - `switch(agentType)` arms over the built-in literals must still provide a
 *   `default:` branch for external values — matching Go's `type AgentType
 *   string` newtype semantics where the compiler can't prove exhaustivity.
 */
export type ExternalAgent = string & {};

/**
 * Agent type identifier — narrow union of the canonical strings + the
 * `'Unknown'` fallback + {@link ExternalAgent} tail for plugin agents.
 * Mirrors Go `agent.AgentType` (newtype `string`) plus the convention that
 * callers normalize unknown strings to `'Unknown'` (for first-party flows)
 * and accept arbitrary strings (for Phase 6.7 external-plugin agents).
 *
 * **Note**: Vogon (`'Vogon Agent'`) is **not** explicitly in this union — the
 * test agent is excluded from the user-facing type set but still type-checks
 * thanks to the `ExternalAgent` tail. Callers that test Vogon use the direct
 * string literal exported from `@/agent/vogon`.
 */
export type AgentType =
	| typeof AGENT_TYPE_CLAUDE_CODE
	| typeof AGENT_TYPE_CODEX
	| typeof AGENT_TYPE_CURSOR
	| typeof AGENT_TYPE_OPENCODE
	| typeof AGENT_TYPE_UNKNOWN
	| ExternalAgent;

/** Anthropic Claude Code registry key. */
export const AGENT_NAME_CLAUDE_CODE = 'claude-code' as AgentName;
/** OpenAI Codex registry key. */
export const AGENT_NAME_CODEX = 'codex' as AgentName;
/** Cursor registry key. */
export const AGENT_NAME_CURSOR = 'cursor' as AgentName;
/** OpenCode registry key. */
export const AGENT_NAME_OPENCODE = 'opencode' as AgentName;

/**
 * Agent registry key — branded `string`. Mirrors Go `agent.AgentName`
 * newtype. Use the `AGENT_NAME_*` constants for built-in agents; external
 * plugin agents (Phase 6.7) provide their own `AgentName` via the binary's
 * `info` subcommand.
 */
export type AgentName = string & { readonly __brand: 'AgentName' };

/** Default agent for `story enable` when no agent is auto-detected.
 *  Mirrors Go `DefaultAgentName = AgentNameClaudeCode`. */
export const DEFAULT_AGENT_NAME = AGENT_NAME_CLAUDE_CODE;

/** SessionStart hook event. */
export const HOOK_TYPE_SESSION_START = 'session_start' as const;
/** SessionEnd hook event. */
export const HOOK_TYPE_SESSION_END = 'session_end' as const;
/** UserPromptSubmit hook event. */
export const HOOK_TYPE_USER_PROMPT_SUBMIT = 'user_prompt_submit' as const;
/** Stop (turn end) hook event. */
export const HOOK_TYPE_STOP = 'stop' as const;
/** PreToolUse hook event. */
export const HOOK_TYPE_PRE_TOOL_USE = 'pre_tool_use' as const;
/** PostToolUse hook event. */
export const HOOK_TYPE_POST_TOOL_USE = 'post_tool_use' as const;

/** Hook lifecycle event kind. Mirrors Go `agent.HookType` const block. */
export type HookType =
	| typeof HOOK_TYPE_SESSION_START
	| typeof HOOK_TYPE_SESSION_END
	| typeof HOOK_TYPE_USER_PROMPT_SUBMIT
	| typeof HOOK_TYPE_STOP
	| typeof HOOK_TYPE_PRE_TOOL_USE
	| typeof HOOK_TYPE_POST_TOOL_USE;

/** User entry in a session transcript. */
export const ENTRY_TYPE_USER = 'user' as const;
/** Assistant entry in a session transcript. */
export const ENTRY_TYPE_ASSISTANT = 'assistant' as const;
/** Tool invocation entry in a session transcript. */
export const ENTRY_TYPE_TOOL = 'tool' as const;
/** System entry in a session transcript. */
export const ENTRY_TYPE_SYSTEM = 'system' as const;

/** Session entry kind. Mirrors Go `agent.EntryType` const block. */
export type EntryType =
	| typeof ENTRY_TYPE_USER
	| typeof ENTRY_TYPE_ASSISTANT
	| typeof ENTRY_TYPE_TOOL
	| typeof ENTRY_TYPE_SYSTEM;

const KNOWN_AGENT_TYPES: ReadonlySet<string> = new Set<string>([
	AGENT_TYPE_CLAUDE_CODE,
	AGENT_TYPE_CODEX,
	AGENT_TYPE_CURSOR,
	AGENT_TYPE_OPENCODE,
	AGENT_TYPE_UNKNOWN,
]);

/**
 * Narrow a raw metadata.agent string to a known {@link AgentType}, returning
 * {@link AGENT_TYPE_UNKNOWN} for anything that doesn't match. Used by
 * `strategy/prompts.ts: readAgentTypeFromTree` after reading metadata.json
 * to avoid trusting arbitrary user-edited / external-agent-written values.
 *
 * **Vogon caveat**: `'Vogon Agent'` returns `'Unknown'` here because Vogon
 * is excluded from the production union. Test code that needs Vogon should
 * compare against `AGENT_TYPE_VOGON` from `@/agent/vogon` directly.
 *
 * @example
 * normalize('Claude Code');         // 'Claude Code'
 * normalize('Cursor');              // 'Cursor'
 * normalize('My Custom Agent');     // 'Unknown'
 * normalize('');                    // 'Unknown'
 * normalize('claude code');         // 'Unknown' (case-sensitive — matches Go)
 */
export function normalize(rawAgent: string): AgentType {
	if (KNOWN_AGENT_TYPES.has(rawAgent)) {
		return rawAgent as AgentType;
	}
	return AGENT_TYPE_UNKNOWN;
}
