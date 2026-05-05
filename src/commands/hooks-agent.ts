/**
 * Dispatcher for `story hooks <agent> <verb>` — the agent-hook CLI
 * entry point.
 *
 * Each registered agent's hook config (e.g. `.claude/settings.json`,
 * `.codex/config.toml`) calls `story hooks <agent> <verb>` with
 * stdin-delivered event JSON. This module translates the
 * `(agent, verb)` pair into a {@link executeAgentHook} call — the
 * underlying dispatch machinery (layer-1 worktree gate, layer-2
 * enabled gate, layer-3 agent lookup, layer-4 capability check,
 * layer-5 parseHookEvent + dispatchLifecycleEvent) lives in
 * [`src/lifecycle/hook-registry.ts`](../lifecycle/hook-registry.ts)
 * and was shipped in Phase 7 Part 2.
 *
 * Mirrors Go `cmd/entire/cli/hook_registry.go: newAgentHookVerbCmd*`
 * and the external-agent fallback `RunE` in
 * `cmd/entire/cli/hooks_cmd.go: newHooksCmd`. TS uses a single unified
 * catch-all rather than per-agent concrete cobra subcommands because
 * cac has no native multi-word command tree — see the `hooks-git.ts`
 * commentary.
 *
 * ## Not-ported Go tests (architectural divergence, documented)
 *
 * The following Go tests in `hook_registry_test.go` have no TS
 * counterpart because TS diverges architecturally:
 *
 * - `TestNewAgentHookVerbCmd_LogsInvocation` — TS does not register
 *   per-verb subcommands with logging PreRun/PostRun hooks; a single
 *   catch-all `hooks [...args]` command dispatches here. Logging
 *   attribution lives inside `executeAgentHook` instead.
 * - `TestClaudeCodeHooksCmd_HasLoggingHooks` — no `claude-code`
 *   subcommand factory in TS.
 * - `TestGeminiCLIHooksCmd_HasLoggingHooks` — no `gemini-cli`
 *   subcommand factory in TS.
 *
 * These are explicit Phase 8 design decisions (cac lacks multi-word
 * command trees) — see `docs/ts-rewrite/impl/phase-8-hooks/impl.md`
 * §「cac 限制」.
 *
 * @packageDocumentation
 */

import type { AgentName } from '@/agent/types';
import { executeAgentHook } from '@/lifecycle/hook-registry';

/**
 * Entry point for the `story hooks <agent> <verb>` path. `args` is the
 * full positional arg list (NOT including `hooks`), so
 * `['claude-code', 'session-start']` invokes
 * `executeAgentHook('claude-code', 'session-start', process.stdin)`.
 *
 * Silently no-ops when `args` has fewer than 2 elements (nothing
 * addressable; matches Go `hooks_cmd.go:37-40` which shows help for
 * `len(args) < 2`).
 *
 * **Errors propagate** — this mirrors Go `hook_registry.go:176` where
 * `newAgentHookVerbCmdWithLogging.RunE` returns the
 * `executeAgentHook(...)` error directly, causing cobra to exit
 * non-zero. Matching Go parity lets agent CLIs detect hook failures
 * via exit code (e.g. Claude Code displays hook errors to the user
 * when the shim exits non-zero). `executeAgentHook` itself has 5
 * silent-skip layers for non-error conditions (not a git repo / Story
 * disabled / pass-through null events), so the common path still
 * resolves void.
 *
 * @example
 * // From cac action in src/cli.ts:
 * await handleAgentHookCommand(['claude-code', 'session-start']);
 * // Side effects:
 * //   - Invokes executeAgentHook('claude-code', 'session-start', process.stdin)
 * //   - Propagates any thrown error (cac will write it to stderr + exit 1)
 * //   - No output when executeAgentHook returns normally (silent-skip or success)
 *
 * // External agent (registered via discoverAndRegister in cli.ts run()):
 * await handleAgentHookCommand(['my-ext-agent', 'custom-hook']);
 *
 * // Defensive: missing args → silent no-op
 * await handleAgentHookCommand(['claude-code']);
 * // returns: undefined (executeAgentHook not called)
 */
export async function handleAgentHookCommand(args: string[]): Promise<void> {
	const agentName = args[0];
	const hookName = args[1];
	if (agentName === undefined || hookName === undefined) {
		return;
	}

	// Errors propagate — matches Go hook_registry.go:176
	// `return executeAgentHook(cmd, agentName, hookName, false)`.
	// `executeAgentHook` has 5 silent-skip layers (not a git repo /
	// Story disabled / agent not found / no HookSupport / pass-through
	// null event), so only real failures bubble.
	await executeAgentHook(agentName as AgentName, hookName, process.stdin);
}
