/**
 * Phase 7 Part 2 `src/lifecycle/hook-registry.ts` — 20 case.
 *
 * Go 对照：`cmd/entire/cli/hook_registry_test.go` (where applicable) — 5
 * silent-skip layers + ALS semantics + `getHookType` classifier. Case titles
 * include explicit `// Go:` breadcrumbs (e.g. the Go test names
 * `TestHookCommand_SetsCurrentHookAgentName`, `TestGetCurrentHookAgent`,
 * etc.); ALS-concurrency / `getCurrentHookName` behaviour have no Go
 * counterpart so they are labelled "Story 补充".
 *
 * TS-divergence from Go (documented inline in `hook-registry.ts`):
 * 1. Package-level `currentHookAgentName` var → `AsyncLocalStorage` for
 *    concurrent test-worker isolation.
 * 2. Go `agent.Get(name) (Agent, error)` → TS `get(name) Agent | null`;
 *    null is wrapped as a throw with the Go error-prefix.
 * 3. Go `IsEnabled(ctx)` → TS layer now calls {@link loadEnabledSettings}
 *    (returns `StorySettings | null`) instead of the thin boolean wrapper
 *    {@link isSetUpAndEnabled}. Rationale: hook registry needs the loaded
 *    settings to wire `log_level` into `log.init` — using the combined
 *    call avoids reading `settings.json` twice per hook invocation (see
 *    `settings.ts:462-471` and `hook-registry.ts:203-209`).
 *
 *    **API surface decision** (keep both exports):
 *    - `loadEnabledSettings(repoRoot)` → hook gate + settings consumer
 *      (this is what the hook registry calls; silent-skip on `null`).
 *    - `isSetUpAndEnabled(repoRoot)` → retained as a lightweight boolean
 *      gate for callers that don't need the loaded settings (e.g. docs /
 *      doctor commands, `initHookLogging` parity).
 *
 *    Both are exported, both are mocked here. Silent-skip scenarios (Go
 *    fail-open vs. TS fail-closed, see `hook-registry.ts:192-213`) are
 *    exercised via the `loadEnabledSettings` mock path since that is the
 *    code path the hook dispatcher actually runs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent, HookSupport } from '@/agent/interfaces';
import { AGENT_NAME_CLAUDE_CODE, AGENT_NAME_CURSOR, type AgentName } from '@/agent/types';
import type { StorySettings } from '@/settings/settings';

vi.mock('@/paths', async () => {
	const actual = await vi.importActual<typeof import('@/paths')>('@/paths');
	return { ...actual, worktreeRoot: vi.fn(async () => '/tmp/test-repo') };
});
// Mock both exports — `loadEnabledSettings` is what `hook-registry.ts`
// currently calls (since Phase 7.x refactor), `isSetUpAndEnabled` is
// kept in the mock surface to mirror the real module shape and to
// prevent accidental regressions if the hook registry ever swaps back
// to the thin boolean gate for a subset of callers.
vi.mock('@/settings/settings', () => ({
	loadEnabledSettings: vi.fn(async () => ({ enabled: true }) as StorySettings),
	isSetUpAndEnabled: vi.fn(async () => true),
}));
vi.mock('@/agent/registry', () => ({ get: vi.fn() }));
vi.mock('@/agent/capabilities', async () => {
	const actual =
		await vi.importActual<typeof import('@/agent/capabilities')>('@/agent/capabilities');
	return { ...actual, asHookSupport: vi.fn() };
});
vi.mock('@/lifecycle/dispatch', () => ({ dispatchLifecycleEvent: vi.fn(async () => {}) }));
vi.mock('@/commands/hooks/claude-code/post-todo', () => ({
	handleClaudeCodePostTodo: vi.fn(async () => {}),
}));

import { asHookSupport } from '@/agent/capabilities';
import { get as getAgent } from '@/agent/registry';
import { handleClaudeCodePostTodo } from '@/commands/hooks/claude-code/post-todo';
import { dispatchLifecycleEvent } from '@/lifecycle/dispatch';
import {
	_runInHookScopeForTesting,
	executeAgentHook,
	getCurrentHookAgent,
	getCurrentHookName,
	getHookType,
} from '@/lifecycle/hook-registry';
import { worktreeRoot } from '@/paths';
import { isSetUpAndEnabled, loadEnabledSettings } from '@/settings/settings';

function makeAgent(name: AgentName = AGENT_NAME_CLAUDE_CODE): Agent {
	return { name: () => name, type: () => 'Claude Code' } as Agent;
}

function makeHookSupport(name: AgentName = AGENT_NAME_CLAUDE_CODE): HookSupport {
	return {
		name: () => name,
		type: () => 'Claude Code',
		parseHookEvent: vi.fn(async () => null),
		hookNames: () => ['session-start', 'post-todo'],
	} as unknown as HookSupport;
}

describe('lifecycle/hook-registry', () => {
	beforeEach(() => {
		vi.mocked(worktreeRoot).mockReset().mockResolvedValue('/tmp/test-repo');
		// `loadEnabledSettings` is the one the hook registry actually calls;
		// `isSetUpAndEnabled` is mocked-but-unused to preserve the full
		// module shape (see file-level JSDoc "API surface decision").
		vi.mocked(loadEnabledSettings)
			.mockReset()
			.mockResolvedValue({ enabled: true } as StorySettings);
		vi.mocked(isSetUpAndEnabled).mockReset().mockResolvedValue(true);
		vi.mocked(getAgent).mockReset().mockReturnValue(makeAgent());
		vi.mocked(asHookSupport)
			.mockReset()
			// biome-ignore lint/suspicious/noExplicitAny: 3-tuple-in-2-tuple narrowing in mock
			.mockReturnValue([makeHookSupport(), true] as any);
		vi.mocked(dispatchLifecycleEvent).mockReset().mockResolvedValue();
		vi.mocked(handleClaudeCodePostTodo).mockReset().mockResolvedValue();
	});

	afterEach(() => {
		// Use `clearAllMocks` (not `restoreAllMocks`) so the module-level
		// `vi.mock(...)` factory bindings stay intact between tests.
		vi.clearAllMocks();
	});

	// Go: hook_registry_test.go: TestHookCommand_SetsCurrentHookAgentName
	it('executeAgentHook sets ALS for duration of handler', async () => {
		const capturedName: string[] = [];
		const hs = makeHookSupport();
		hs.parseHookEvent = vi.fn(async () => {
			const ag = await getCurrentHookAgent();
			capturedName.push(ag.name());
			return null;
			// biome-ignore lint/suspicious/noExplicitAny: vitest Mock typing
		}) as any;
		// biome-ignore lint/suspicious/noExplicitAny: 3-tuple-in-2-tuple narrowing
		vi.mocked(asHookSupport).mockReturnValue([hs, true] as any);
		vi.mocked(getAgent).mockReturnValue(makeAgent());

		await executeAgentHook(AGENT_NAME_CLAUDE_CODE, 'session-start', process.stdin);

		expect(capturedName).toEqual([AGENT_NAME_CLAUDE_CODE]);
	});

	// Go: hook_registry_test.go: TestHookCommand_SetsCurrentHookAgentName
	// (deferred cleanup — TS uses AsyncLocalStorage auto-scope).
	it('ALS cleared after executeAgentHook resolves', async () => {
		await executeAgentHook(AGENT_NAME_CLAUDE_CODE, 'session-start', process.stdin);

		await expect(getCurrentHookAgent()).rejects.toThrow(
			'not in a hook context: agent name not set',
		);
	});

	// Story 补充: Go relies on serial test execution + a package-level var;
	// TS runs tests concurrently so ALS isolation is load-bearing. This
	// case locks the invariant that two in-flight `executeAgentHook` calls
	// never leak each other's agent name through `getCurrentHookAgent`.
	//
	// Review 2 D1: previous impl used `setTimeout(5ms)` to force interleaving;
	// that's theoretically flaky on slow CI. Switched to a **Promise barrier**
	// so handler A reads its agent, blocks until B also reads, then both
	// resolve — the overlap is guaranteed regardless of wall-clock speed.
	it('concurrent executeAgentHook calls have isolated ALS contexts', async () => {
		const seen: AgentName[] = [];
		vi.mocked(getAgent).mockImplementation((name) => makeAgent(name));

		// Two-phase barrier: both handlers must reach `bothArrived` before
		// either returns, guaranteeing their ALS frames overlap in time.
		let arrivedCount = 0;
		let resolveBothArrived: () => void = () => {};
		const bothArrived = new Promise<void>((r) => {
			resolveBothArrived = r;
		});

		vi.mocked(asHookSupport).mockImplementation(() => {
			const hs = makeHookSupport();
			hs.parseHookEvent = vi.fn(async () => {
				const ag = await getCurrentHookAgent();
				arrivedCount += 1;
				if (arrivedCount === 2) {
					resolveBothArrived();
				}
				// Both handlers wait here until the second one also arrives —
				// this forces the ALS frames to overlap without any timer.
				await bothArrived;
				seen.push(ag.name() as AgentName);
				return null;
				// biome-ignore lint/suspicious/noExplicitAny: vitest Mock typing
			}) as any;
			// biome-ignore lint/suspicious/noExplicitAny: 3-tuple-in-2-tuple narrowing
			return [hs, true] as any;
		});

		await Promise.all([
			executeAgentHook(AGENT_NAME_CLAUDE_CODE, 'session-start', process.stdin),
			executeAgentHook(AGENT_NAME_CURSOR, 'session-start', process.stdin),
		]);

		expect(seen.sort()).toEqual([AGENT_NAME_CLAUDE_CODE, AGENT_NAME_CURSOR].sort());
	});

	// Go: hook_registry.go (layer 1 — worktreeRoot failure → return)
	it('executeAgentHook silent-skip when not in git repo', async () => {
		vi.mocked(worktreeRoot).mockRejectedValue(new Error('not a git repo'));

		await expect(
			executeAgentHook(AGENT_NAME_CLAUDE_CODE, 'session-start', process.stdin),
		).resolves.toBeUndefined();

		expect(dispatchLifecycleEvent).not.toHaveBeenCalled();
		expect(handleClaudeCodePostTodo).not.toHaveBeenCalled();
	});

	// Go: hook_registry.go (layer 2 — IsEnabled false → return).
	// TS uses `loadEnabledSettings` which returns `null` for any of:
	// (a) Story not set up, (b) settings.enabled=false, (c) settings
	// file load / parse failure. All three collapse into the single
	// silent-skip branch in `hook-registry.ts:210-213`. The Go test for
	// `IsEnabled` → `false` is mirrored here.
	it('executeAgentHook silent-skip when loadEnabledSettings returns null (disabled or not set up)', async () => {
		vi.mocked(loadEnabledSettings).mockResolvedValue(null);

		await expect(
			executeAgentHook(AGENT_NAME_CLAUDE_CODE, 'session-start', process.stdin),
		).resolves.toBeUndefined();

		expect(dispatchLifecycleEvent).not.toHaveBeenCalled();
		expect(handleClaudeCodePostTodo).not.toHaveBeenCalled();
	});

	// Story 补充 — TS-divergence (fail-closed):
	// Go `IsEnabled(ctx)` returns `(true, err)` on settings-load failure
	// so Go `hook_registry.go:102-105` **keeps running the hook** when
	// `settings.json` is corrupt / unreadable (fail-open). TS
	// `loadEnabledSettings` catches load errors internally and returns
	// `null`, which trips the same silent-skip branch → Story skips
	// (fail-closed). Rationale documented in `hook-registry.ts:192-213`.
	// We simulate this by having the mock resolve to null; in production
	// the real function catches before reaching the hook.
	it('executeAgentHook silent-skip when loadEnabledSettings returns null due to load failure (TS fail-closed)', async () => {
		vi.mocked(loadEnabledSettings).mockResolvedValue(null);

		await expect(
			executeAgentHook(AGENT_NAME_CLAUDE_CODE, 'session-start', process.stdin),
		).resolves.toBeUndefined();

		expect(dispatchLifecycleEvent).not.toHaveBeenCalled();
		expect(handleClaudeCodePostTodo).not.toHaveBeenCalled();
	});

	// Go: hook_registry.go (layer 3 — agent.Get error → %w wrap)
	it('executeAgentHook throws when getAgent returns null', async () => {
		vi.mocked(getAgent).mockReturnValue(null);

		await expect(
			executeAgentHook(AGENT_NAME_CLAUDE_CODE, 'session-start', process.stdin),
		).rejects.toThrow(/failed to get agent "claude-code":/);
	});

	// Go: hook_registry.go (layer 4 — AsHookSupport !ok → error)
	it('executeAgentHook throws when agent lacks HookSupport', async () => {
		// biome-ignore lint/suspicious/noExplicitAny: 3-tuple-in-2-tuple narrowing
		vi.mocked(asHookSupport).mockReturnValue([null, false] as any);

		await expect(
			executeAgentHook(AGENT_NAME_CLAUDE_CODE, 'session-start', process.stdin),
		).rejects.toThrow(/agent "claude-code" does not support hooks/);
	});

	// Go: hook_registry.go (layer 5 happy — parseHookEvent returns
	// event → dispatchLifecycleEvent called with (agent, event))
	it('executeAgentHook dispatches event when parseHookEvent returns non-null', async () => {
		const ag = makeAgent();
		vi.mocked(getAgent).mockReturnValue(ag);

		const event = {
			type: 'SessionStart',
			sessionId: 'sid-1',
			previousSessionId: '',
			sessionRef: '',
			prompt: '',
			model: '',
			timestamp: new Date(0),
			toolUseId: '',
			subagentId: '',
			toolInput: null,
			subagentType: '',
			taskDescription: '',
			modifiedFiles: [],
			responseMessage: '',
			durationMs: 0,
			turnCount: 0,
			contextTokens: 0,
			contextWindowSize: 0,
			metadata: {},
		};
		const hs = makeHookSupport();
		// biome-ignore lint/suspicious/noExplicitAny: event cast for mock typing
		hs.parseHookEvent = vi.fn(async () => event as any) as any;
		// biome-ignore lint/suspicious/noExplicitAny: 3-tuple-in-2-tuple narrowing
		vi.mocked(asHookSupport).mockReturnValue([hs, true] as any);

		await executeAgentHook(AGENT_NAME_CLAUDE_CODE, 'session-start', process.stdin);

		expect(dispatchLifecycleEvent).toHaveBeenCalledTimes(1);
		expect(dispatchLifecycleEvent).toHaveBeenCalledWith(ag, event);
		expect(handleClaudeCodePostTodo).not.toHaveBeenCalled();
	});

	// Go: hook_registry.go (layer 5 special-case — claude-code +
	// post-todo + null event → handleClaudeCodePostTodo)
	it('executeAgentHook special-cases claude-code + post-todo when event null', async () => {
		const hs = makeHookSupport();
		// biome-ignore lint/suspicious/noExplicitAny: vitest Mock typing
		hs.parseHookEvent = vi.fn(async () => null) as any;
		// biome-ignore lint/suspicious/noExplicitAny: 3-tuple-in-2-tuple narrowing
		vi.mocked(asHookSupport).mockReturnValue([hs, true] as any);

		await executeAgentHook(AGENT_NAME_CLAUDE_CODE, 'post-todo', process.stdin);

		expect(handleClaudeCodePostTodo).toHaveBeenCalledOnce();
		expect(dispatchLifecycleEvent).not.toHaveBeenCalled();
	});

	// Go: hook_registry.go (layer 5 pass-through — null event, not
	// claude-code/post-todo → silent no-op).
	it('executeAgentHook no-ops when event null AND not claude-code/post-todo', async () => {
		const hs = makeHookSupport(AGENT_NAME_CURSOR);
		// biome-ignore lint/suspicious/noExplicitAny: vitest Mock typing
		hs.parseHookEvent = vi.fn(async () => null) as any;
		// biome-ignore lint/suspicious/noExplicitAny: 3-tuple-in-2-tuple narrowing
		vi.mocked(asHookSupport).mockReturnValue([hs, true] as any);
		vi.mocked(getAgent).mockReturnValue(makeAgent(AGENT_NAME_CURSOR));

		await executeAgentHook(AGENT_NAME_CURSOR, 'turn-start', process.stdin);

		expect(dispatchLifecycleEvent).not.toHaveBeenCalled();
		expect(handleClaudeCodePostTodo).not.toHaveBeenCalled();
	});

	// Go: hook_registry.go (layer 5 parse error — wrap with
	// "failed to parse hook event: %w")
	it('executeAgentHook throws when parseHookEvent fails', async () => {
		const hs = makeHookSupport();
		hs.parseHookEvent = vi.fn(async () => {
			throw new Error('bad json');
			// biome-ignore lint/suspicious/noExplicitAny: vitest Mock typing
		}) as any;
		// biome-ignore lint/suspicious/noExplicitAny: 3-tuple-in-2-tuple narrowing
		vi.mocked(asHookSupport).mockReturnValue([hs, true] as any);

		await expect(
			executeAgentHook(AGENT_NAME_CLAUDE_CODE, 'session-start', process.stdin),
		).rejects.toThrow(/failed to parse hook event: bad json/);
	});

	// Go: hook_registry_test.go: TestGetCurrentHookAgent_NotSet
	it('getCurrentHookAgent throws outside hook context', async () => {
		await expect(getCurrentHookAgent()).rejects.toThrow(
			'not in a hook context: agent name not set',
		);
	});

	// Go: hook_registry_test.go: TestGetCurrentHookAgent_Set
	it('getCurrentHookAgent returns agent inside ALS scope', async () => {
		const expected = makeAgent();
		vi.mocked(getAgent).mockReturnValue(expected);

		const ag = await _runInHookScopeForTesting(
			{ agentName: AGENT_NAME_CLAUDE_CODE, hookName: 'session-start' },
			async () => getCurrentHookAgent(),
		);

		expect(ag).toBe(expected);
		expect(ag.name()).toBe(AGENT_NAME_CLAUDE_CODE);
	});

	// Go: hook_registry.go (GetCurrentHookAgent wraps agent.Get error
	// as `getting hook agent %q: %w`)
	it('getCurrentHookAgent wraps getAgent null', async () => {
		vi.mocked(getAgent).mockReturnValue(null);

		await expect(
			_runInHookScopeForTesting({ agentName: 'x' as AgentName, hookName: 'y' }, async () =>
				getCurrentHookAgent(),
			),
		).rejects.toThrow(/getting hook agent "x":/);
	});

	// Story 补充: No Go equivalent (Go reads hookName off *cobra.Command);
	// TS exposes a helper so log-tagging doesn't have to re-parse argv.
	// Outside ALS the helper returns '' (best-effort — never throws).
	it('getCurrentHookName returns empty string outside ALS', () => {
		expect(getCurrentHookName()).toBe('');
	});

	// Story 补充: inside ALS scope getCurrentHookName surfaces the value
	// that executeAgentHook stashed alongside agentName.
	it('getCurrentHookName returns hookName inside ALS', async () => {
		const name = await _runInHookScopeForTesting(
			{ agentName: AGENT_NAME_CLAUDE_CODE, hookName: 'session-start' },
			async () => getCurrentHookName(),
		);

		expect(name).toBe('session-start');
	});

	// Go: hook_registry.go (getHookType — subagent arm)
	it('getHookType returns "subagent" for pre-task/post-task/post-todo', () => {
		expect(getHookType('pre-task')).toBe('subagent');
		expect(getHookType('post-task')).toBe('subagent');
		expect(getHookType('post-todo')).toBe('subagent');
	});

	// Go: hook_registry.go (getHookType — tool arm)
	it('getHookType returns "tool" for before-tool/after-tool', () => {
		expect(getHookType('before-tool')).toBe('tool');
		expect(getHookType('after-tool')).toBe('tool');
	});

	// Go: hook_registry.go (getHookType — default "agent" arm)
	it('getHookType returns "agent" for everything else', () => {
		expect(getHookType('session-start')).toBe('agent');
		expect(getHookType('unknown')).toBe('agent');
	});
});
