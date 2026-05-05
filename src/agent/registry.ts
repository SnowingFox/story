/**
 * Agent registry — module-level singleton mapping {@link AgentName} →
 * {@link Factory}. Agents are registered **explicitly** from
 * {@link registerBuiltinAgents} in `src/agent/bootstrap.ts`, which is called by
 * `cli.ts: run()` at CLI startup and by test `beforeAll` hooks. Agent modules
 * must NOT call {@link register} at module top level (see
 * [`AGENTS.md` §异步/模块边界](../../AGENTS.md)) — module-side-effect
 * registration leaks state across test files and hides startup ordering.
 *
 * Mirrors Go `cmd/entire/cli/agent/registry.go`; the TS choice to move from
 * Go's `init()` to an explicit bootstrap function is deliberate
 * (see Phase 6.3 polish retro in
 * [phase-6.1-framework/legacy.md](../../docs/ts-rewrite/impl/phase-6-agents/phase-6.1-framework/legacy.md)).
 *
 * @packageDocumentation
 */

import type { Agent } from './interfaces';
import { type AgentName, type AgentType, DEFAULT_AGENT_NAME } from './types';

/** Factory creates a new agent instance. Mirrors Go `agent.Factory`. */
export type Factory = () => Agent;

const registryMap: Map<AgentName, Factory> = new Map();

/**
 * Add an agent factory to the registry. Called **exclusively** from
 * `src/agent/bootstrap.ts: registerBuiltinAgents()` (built-in agents) or from
 * test helpers like {@link withTestRegistry}. Agent modules must NOT call this
 * at module top level.
 *
 * **Re-registering the same name replaces the previous factory** (matches Go
 * `Register` which writes to map without checking presence). Useful for tests
 * that swap implementations via {@link withTestRegistry}.
 *
 * Mirrors Go `agent.Register`.
 *
 * @example
 * ```ts
 * register(AGENT_NAME_VOGON, () => new VogonAgent());
 * // Side effects: registry Map now contains AGENT_NAME_VOGON → factory
 * ```
 */
export function register(name: AgentName, factory: Factory): void {
	registryMap.set(name, factory);
}

/**
 * Retrieve an agent by name. Returns `null` for unknown names (Go returns
 * `(nil, error)`; TS uses `null` per project convention because callers
 * almost always check for null and skip).
 *
 * Mirrors Go `agent.Get`.
 *
 * @example
 * const ag = get(AGENT_NAME_VOGON);
 * // returns: VogonAgent | null
 *
 * get('nonexistent' as AgentName);
 * // returns: null
 */
export function get(name: AgentName): Agent | null {
	const factory = registryMap.get(name);
	return factory === undefined ? null : factory();
}

/**
 * All registered agent names, sorted lexically. Mirrors Go `agent.List`.
 *
 * @example
 * list();
 * // returns: ['claude-code', 'cursor', 'vogon']  (sorted)
 */
export function list(): AgentName[] {
	return [...registryMap.keys()].sort() as AgentName[];
}

/**
 * User-facing agent names (excludes `TestOnly` agents like Vogon), sorted
 * lexically. Used by `story enable` candidate list.
 *
 * Mirrors Go `agent.StringList` (registry.go:56-69) — instantiates each
 * factory once to check `isTestOnly()`.
 *
 * @example
 * stringList();
 * // returns: ['claude-code', 'cursor']  (Vogon excluded)
 */
export function stringList(): string[] {
	const names: string[] = [];
	for (const [name, factory] of registryMap) {
		const ag = factory();
		// Duck-type the TestOnly marker (TS lacks Go's interface assertion).
		const isTestOnlyFn = (ag as { isTestOnly?: () => boolean }).isTestOnly;
		if (typeof isTestOnlyFn === 'function' && isTestOnlyFn.call(ag)) {
			continue;
		}
		names.push(name as string);
	}
	return names.sort();
}

/**
 * All agents whose {@link Agent.detectPresence} reports `true`, in sorted
 * registry-name order. Returns `[]` when none detected.
 *
 * Agents whose `detectPresence` throws are skipped (matches Go: `if err !=
 * nil { continue }`).
 *
 * Mirrors Go `agent.DetectAll`.
 *
 * @example
 * await detectAll();
 * // returns: [ClaudeCodeAgent, CursorAgent]   (both .claude/ + .cursor/ present)
 *
 * // Side effects: each agent's detectPresence may stat files / run git commands.
 */
export async function detectAll(ctx?: AbortSignal): Promise<Agent[]> {
	const names = list(); // sorted, lock-safe
	const detected: Agent[] = [];
	for (const name of names) {
		const ag = get(name);
		if (ag === null) {
			continue;
		}
		try {
			if (await ag.detectPresence(ctx)) {
				detected.push(ag);
			}
		} catch {
			// Same as Go: if err != nil, skip (don't abort the whole loop).
		}
	}
	return detected;
}

/**
 * First agent whose `detectPresence` reports `true`, in sorted registry-name
 * order. Returns `null` (Go returns error) when no agent detected.
 *
 * Mirrors Go `agent.Detect`.
 *
 * @example
 * await detect();
 * // returns: ClaudeCodeAgent | null
 */
export async function detect(ctx?: AbortSignal): Promise<Agent | null> {
	const all = await detectAll(ctx);
	return all.length === 0 ? null : all[0]!;
}

/**
 * Retrieve an agent by its `Type()` identifier (the metadata-stored display
 * name, e.g. `"Claude Code"`). Linear search through registered factories
 * — acceptable because agent count is small (~7 built-in + N external).
 *
 * Mirrors Go `agent.GetByAgentType`.
 *
 * **Phase 5.5 callers** (restore-logs.ts) use this to resolve the agent for
 * a checkpoint's session metadata.
 *
 * @example
 * getByAgentType('Claude Code');
 * // returns: ClaudeCodeAgent | null
 *
 * getByAgentType(AGENT_TYPE_UNKNOWN);
 * // returns: null
 */
export function getByAgentType(agentType: AgentType | string): Agent | null {
	if (agentType === '') {
		return null;
	}
	for (const factory of registryMap.values()) {
		const ag = factory();
		if (ag.type() === agentType) {
			return ag;
		}
	}
	return null;
}

/**
 * Default agent for `story enable` setup. Returns `null` if {@link
 * DEFAULT_AGENT_NAME} isn't registered.
 *
 * Mirrors Go `agent.Default`.
 */
export function defaultAgent(): Agent | null {
	return get(DEFAULT_AGENT_NAME);
}

/**
 * Union of `protectedDirs()` from all registered agents, sorted + deduped.
 * Used by Phase 5.5 rewind / reset to know which dirs are off-limits.
 *
 * Mirrors Go `agent.AllProtectedDirs`.
 *
 * @example
 * allProtectedDirs();
 * // returns: ['.claude', '.cursor', '.gemini', '.vogon']  (sorted, deduped)
 */
export function allProtectedDirs(): string[] {
	const seen = new Set<string>();
	const dirs: string[] = [];
	for (const factory of registryMap.values()) {
		for (const d of factory().protectedDirs()) {
			if (!seen.has(d)) {
				seen.add(d);
				dirs.push(d);
			}
		}
	}
	return dirs.sort();
}

/**
 * **Test-only**: snapshot the current registry, run `setup` against a fresh
 * registry, restore on completion (including on exception). Mirrors Go's
 * `originalRegistry` save/restore pattern in `registry_test.go`.
 *
 * @example
 * ```ts
 * await withTestRegistry(async () => {
 *   register(AGENT_NAME_VOGON, () => new VogonAgent());
 *   const ag = get(AGENT_NAME_VOGON);
 *   expect(ag).toBeInstanceOf(VogonAgent);
 * });
 * // Registry restored to pre-test state automatically.
 * ```
 */
export async function withTestRegistry(setup: () => void | Promise<void>): Promise<void> {
	const snapshot = new Map(registryMap);
	registryMap.clear();
	try {
		await setup();
	} finally {
		registryMap.clear();
		for (const [k, v] of snapshot) {
			registryMap.set(k, v);
		}
	}
}

/**
 * **Test-only**: clear the registry. Useful for tests that need a known empty
 * starting state without saving/restoring (caller manages cleanup).
 */
export function clearForTesting(): void {
	registryMap.clear();
}
