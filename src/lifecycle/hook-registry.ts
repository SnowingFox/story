/**
 * Hook registry + hook dispatcher entry point.
 *
 * Mirrors Go `cmd/entire/cli/hook_registry.go`:
 * - `currentHookAgentName` (Go package-level var) →
 *   {@link hookAgentStorage} (AsyncLocalStorage) in TS for test isolation
 * - `GetCurrentHookAgent` → {@link getCurrentHookAgent}
 * - `executeAgentHook` → {@link executeAgentHook}
 * - `getHookType` → {@link getHookType}
 * - `newAgentHooksCmd` / `newAgentHookVerbCmdWithLogging` → **Phase 8**:
 *   these wrap cobra commands; TS equivalent (cac commands) belongs to
 *   the Phase 8 agent runtime. Part 2 exports the primitives;
 *   {@link HookRegistrar} is the Phase 8 extension point.
 *
 * **TS-divergence from Go** (documented here + inline with `// TS-divergence:`):
 *
 * 1. Go uses a package-level `var currentHookAgentName` + `defer` cleanup.
 *    TS uses `AsyncLocalStorage<HookContext>` so concurrent test workers
 *    (vitest default) cannot leak state across async chains.
 * 2. Go `agent.Get(name)` can return `error`; the TS `get(name)` returns
 *    `Agent | null` (synchronous) and we wrap `null` as a throw to match
 *    the Go wrapped-error shape.
 * 3. Go `IsEnabled(ctx)` takes no explicit repo root; the TS
 *    `isSetUpAndEnabled(repoRoot)` requires one — we seed it from
 *    `worktreeRoot()` (already resolved by layer 1).
 * 4. **Layer 2 fail-open → fail-closed**: Go `IsEnabled` returns
 *    `(true, err)` on settings-load failure so `hook_registry.go`
 *    KEEPS running the hook when settings are corrupt. TS
 *    `isSetUpAndEnabled` swallows errors and returns `false`, so Story
 *    silently skips the hook instead. Rationale inline at Layer 2.
 *
 * @packageDocumentation
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { asHookSupport } from '@/agent/capabilities';
import type { Agent, HookSupport } from '@/agent/interfaces';
import { get as getAgent } from '@/agent/registry';
import type { AgentName } from '@/agent/types';
import { handleClaudeCodePostTodo } from '@/commands/hooks/claude-code/post-todo';
import * as log from '@/log';
import { worktreeRoot } from '@/paths';
import { loadEnabledSettings } from '@/settings/settings';
import { dispatchLifecycleEvent } from './dispatch';

/** Active hook context (per async chain). Mirrors Go `currentHookAgentName`
 *  but carries `hookName` too so `getCurrentHookName()` can attribute log
 *  lines without re-parsing argv. */
interface HookContext {
	agentName: AgentName;
	hookName: string;
}

/**
 * AsyncLocalStorage for the active hook agent. Replaces Go's package-level
 * `currentHookAgentName` var. ALS gives us:
 *
 * 1. Test isolation — vitest's concurrent workers never leak state
 * 2. Deterministic cleanup — TS doesn't need `defer` because the store
 *    auto-scopes to the promise chain started by `als.run(ctx, fn)`
 *
 * Go uses `defer func(){ currentHookAgentName = "" }()` which works because
 * Go tests run serially by default; TS needs the stricter guarantee.
 *
 * Deliberately NOT exported — all access goes through the public accessor
 * functions below.
 */
const hookAgentStorage = new AsyncLocalStorage<HookContext>();

/**
 * Resolve the agent for the currently executing hook. Throws when not
 * inside an {@link executeAgentHook} scope (or its direct {@link hookAgentStorage.run}
 * equivalent used in tests).
 *
 * Mirrors Go `hook_registry.go` (`GetCurrentHookAgent`).
 *
 * @throws Error('not in a hook context: agent name not set') when ALS is empty.
 * @throws Error(`getting hook agent "${name}": <cause>`) when {@link getAgent}
 *   returns null (unknown agent / registry error), wrapping the cause.
 *
 * @example
 * // Inside a hook handler (e.g., production post-todo helper):
 * const ag = await getCurrentHookAgent();  // → Claude Code agent
 * console.log(ag.type());                   // 'claude-code'
 *
 * // Outside executeAgentHook:
 * await getCurrentHookAgent();              // throws
 *
 * // Side effects: none — pure registry read.
 */
export async function getCurrentHookAgent(): Promise<Agent> {
	const ctx = hookAgentStorage.getStore();
	if (!ctx?.agentName) {
		throw new Error('not in a hook context: agent name not set');
	}
	const ag = getAgent(ctx.agentName);
	if (ag === null) {
		// TS-divergence 2: wrap the missing-agent case to match Go's
		// `fmt.Errorf("getting hook agent %q: %w", name, err)` output shape.
		throw new Error(`getting hook agent "${ctx.agentName}": agent not found in registry`);
	}
	return ag;
}

/**
 * Get the hook name for the currently executing hook. Returns `''` when
 * not in a hook context (no throw — log tagging is best-effort).
 *
 * No Go direct counterpart (Go stashes `hookName` inside a cobra
 * `*cobra.Command`); Story-side helpers need this for structured log
 * attributes without threading `hookName` through every call site.
 */
export function getCurrentHookName(): string {
	return hookAgentStorage.getStore()?.hookName ?? '';
}

/**
 * Classify a hook name into a coarse category for logging / span tags.
 *
 * Mirrors Go `hook_registry.go` (`getHookType`):
 * - `pre-task` / `post-task` / `post-todo` → `'subagent'`
 * - `before-tool` / `after-tool` → `'tool'`
 * - everything else → `'agent'`
 *
 * Literal values MUST match the Go constants (`claudecode.HookNamePreTask`
 * etc.) because hook-config files written on-disk by `story enable` are
 * case-sensitive and used by both CLIs on mixed-team repositories.
 */
export function getHookType(hookName: string): 'subagent' | 'tool' | 'agent' {
	switch (hookName) {
		case 'pre-task':
		case 'post-task':
		case 'post-todo': {
			return 'subagent';
		}
		case 'before-tool':
		case 'after-tool': {
			return 'tool';
		}
		default: {
			return 'agent';
		}
	}
}

/**
 * Execute an agent hook: reads stdin, parses the hook event, dispatches via
 * {@link dispatchLifecycleEvent} or (for `post-todo`) directly to
 * {@link handleClaudeCodePostTodo}.
 *
 * Mirrors Go `hook_registry.go` (`executeAgentHook`). 5 silent-skip
 * layers (order matters — each inspects state the previous layer established):
 *
 * 1. Not a git repository → return silently (hooks must never block agents)
 * 2. Story is not enabled in settings → return silently
 * 3. Agent lookup fails → **throw** (propagates; agent registry is internal)
 * 4. Agent doesn't implement `HookSupport` → **throw** (config bug)
 * 5. `parseHookEvent` returns `null`:
 *    - `claude-code` + `post-todo` → delegate to {@link handleClaudeCodePostTodo}
 *    - otherwise → return silently (pass-through hook)
 *
 * @example
 * await executeAgentHook('claude-code', 'session-start', process.stdin);
 *
 * // Sequence (happy path):
 * //   worktreeRoot()            → OK
 * //   isSetUpAndEnabled(root)   → true
 * //   get('claude-code')        → Agent
 * //   asHookSupport(agent)      → [handler, true]
 * //   hookAgentStorage.run({ agentName, hookName }, async () => {
 * //     handler.parseHookEvent('session-start', stdin) → Event
 * //     dispatchLifecycleEvent(agent, event)
 * //   });
 * //
 * // Side effects: any written by the downstream handler (banner stdout,
 * // session-state writes, transcript copies, etc.). This function itself
 * // only reads settings + registry.
 */
export async function executeAgentHook(
	agentName: AgentName,
	hookName: string,
	stdin: NodeJS.ReadableStream,
): Promise<void> {
	// Layer 1: not in a git repo → silent skip
	let repoRoot: string;
	try {
		repoRoot = await worktreeRoot();
	} catch {
		return;
	}

	// Layer 2: Story is not set up / not enabled → silent skip.
	//
	// **TS-divergence from Go** (intentional, keep-fail-closed):
	//
	// Go `cmd/entire/cli/hook_registry.go` reads
	// `enabled, err := IsEnabled(ctx)` and the guard is
	// `if err == nil && !enabled { return nil }` — because Go `IsEnabled`
	// (`config.go`) returns `(true, err)` on settings-load failure,
	// Go KEEPS running the hook when `settings.json` is corrupt / missing
	// (fail-open).
	//
	// Story TS {@link loadEnabledSettings} returns `null` on schema drift;
	// we silently skip here (**fail-closed**). Rationale: Story's settings
	// layer is newer and catches schema drift earlier; running a hook
	// against a broken settings file risks committing corrupted task
	// checkpoints into the shadow branch. The broken-settings case is rare
	// and user-visible (Story CLI won't show any hook output) so the
	// failure mode is preferred over a noisy-but-broken checkpoint path.
	const settings = await loadEnabledSettings(repoRoot);
	if (settings === null) {
		return;
	}

	// Wire `.story/logs/story.log` so downstream `log.*` calls land on disk
	// instead of stderr (which Cursor / most hook drivers swallow). Settings
	// `log_level` overrides the default; env var `ENTIRE_LOG_LEVEL` acts as
	// final fallback. `init` is no-op-safe if log dir creation fails — it
	// flips back to stderr (Phase 9.1 contract).
	try {
		await log.init(repoRoot, settings.log_level ? { level: settings.log_level } : undefined);
	} catch {
		// Never block a hook on logger setup failure.
	}

	const logCtx = {
		component: 'hooks',
		agent: agentName,
		hook: hookName,
		hook_type: getHookType(hookName),
	};
	// DEFER(phase-11): perf.Start root span covering whole hook invocation
	// blocked-by: phase-11 perf module (Go `hook_registry.go` opens a perf span here so child spans in lifecycle handlers + strategy methods auto-nest)
	log.debug(logCtx, 'hook invoked');

	// Layer 3: agent lookup failure → throw
	const ag = getAgent(agentName);
	if (ag === null) {
		throw new Error(`failed to get agent "${agentName}": agent not found in registry`);
	}

	// Layer 4: agent doesn't support hooks → throw
	const [handler, ok] = asHookSupport(ag);
	if (!ok || handler === null) {
		throw new Error(`agent "${agentName}" does not support hooks`);
	}
	const hs = handler as HookSupport;

	// Set ALS so downstream handlers can retrieve the active agent via
	// getCurrentHookAgent(). Auto-cleanup at end of scope.
	await hookAgentStorage.run({ agentName, hookName }, async () => {
		let event: Awaited<ReturnType<HookSupport['parseHookEvent']>>;
		try {
			event = await hs.parseHookEvent(hookName, stdin);
		} catch (err) {
			throw new Error(`failed to parse hook event: ${(err as Error).message}`, {
				cause: err as Error,
			});
		}

		if (event) {
			await dispatchLifecycleEvent(ag, event);
			return;
		}

		// Layer 5: pass-through hook (null event). Only claude-code +
		// post-todo gets special-cased — all other (agent, null event)
		// combos are silent no-ops (matches Go `hook_registry.go`).
		if (agentName === 'claude-code' && hookName === 'post-todo') {
			await handleClaudeCodePostTodo(stdin);
		}
	});
}

/**
 * Phase 8 wired `story hooks <agent> <verb>` via a single catch-all
 * `cli.command('hooks [...args]')` command in `src/cli.ts` that
 * dispatches to {@link handleAgentHookCommand}, which delegates back
 * to {@link executeAgentHook}. The `HookRegistrar` interface below is
 * kept as a forward-compatible extension point: if an agent plugin
 * ever needs to register concrete per-hook cac subcommands (e.g. for
 * `--help` visibility of its hook verbs), it can implement this
 * interface and the CLI wiring can grow a call-site. No production
 * path uses it today — the catch-all pattern suffices for all 5
 * built-in agents + external agents discovered at CLI startup.
 */
export interface HookRegistrar {
	/**
	 * Register a single hook verb under `story hooks <agentName> <hookName>`.
	 * Not wired in Phase 8 — reserved for future per-agent concrete
	 * subcommand registration.
	 */
	registerHook(agentName: AgentName, hookName: string): void;
}

/**
 * **Test-only** hook-scope helper: run `fn` inside a synthetic hook context
 * (so `getCurrentHookAgent()` / `getCurrentHookName()` return the given
 * values without running the full {@link executeAgentHook} machinery).
 *
 * Exported so `tests/unit/lifecycle/hook-registry.test.ts` can assert ALS
 * semantics in isolation.
 */
export function _runInHookScopeForTesting<T>(ctx: HookContext, fn: () => Promise<T>): Promise<T> {
	return hookAgentStorage.run(ctx, fn);
}
