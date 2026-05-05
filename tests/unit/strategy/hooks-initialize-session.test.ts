/**
 * Phase 5.4 Part 1 unit tests for [src/strategy/hooks-initialize-session.ts](src/strategy/hooks-initialize-session.ts).
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/strategy/manual_commit_hooks.go` (`InitializeSession`,
 * `calculatePromptAttributionAtStart`) + `manual_commit_session.go` (private
 * `initializeSession` constructor).
 *
 * Each `it()` is annotated with `// Go: <go-file>:<line>` for the
 * audit-test-go-parity gate.
 */

import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentType } from '@/agent/types';
import { clearGitCommonDirCache } from '@/git';
import { clearWorktreeRootCache } from '@/paths';
import {
	buildInitialSessionState,
	calculatePromptAttributionAtStart,
	initializeSessionImpl,
} from '@/strategy/hooks-initialize-session';
import { ManualCommitStrategy } from '@/strategy/manual-commit';
import { TestEnv } from '../../helpers/test-env';

// Phase 6.1 Part 2 narrowed AgentType from a `string` alias to a strict
// 8-const union. Tests that intentionally pass `''` to assert the
// "no agent override" branch must cast (Go: `types.AgentType` is a `string`
// newtype that allows the zero value, but TS's strict union excludes `''`).
const EMPTY_AGENT_TYPE = '' as AgentType;

describe('initializeSessionImpl — new session', () => {
	let env: TestEnv;
	let strategy: ManualCommitStrategy;

	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		clearGitCommonDirCache();
		clearWorktreeRootCache();
		strategy = new ManualCommitStrategy(env.dir);
	});
	afterEach(async () => {
		await env.cleanup();
		clearGitCommonDirCache();
		clearWorktreeRootCache();
	});

	// Go: manual_commit_hooks.go: InitializeSession:2247-2265 — new session branch
	it('creates new session via buildInitialSessionState when state.json missing', async () => {
		await initializeSessionImpl(
			strategy,
			'sess-new',
			'Claude Code',
			'/tmp/transcript.jsonl',
			'rewrite the README',
			'claude-sonnet-4',
		);

		const state = await strategy.loadSessionState('sess-new');
		expect(state).not.toBeNull();
		if (state === null) {
			return;
		}
		expect(state.sessionId).toBe('sess-new');
		expect(state.agentType).toBe('Claude Code');
		expect(state.modelName).toBe('claude-sonnet-4');
		expect(state.lastPrompt).toContain('rewrite the README');
		expect(state.transcriptPath).toBe('/tmp/transcript.jsonl');
		expect(state.baseCommit).not.toBe('');
		expect(state.attributionBaseCommit).toBe(state.baseCommit);
		expect(state.turnId).toBeTruthy();
		expect(state.stepCount).toBe(0);
		// EventTurnStart transitions phase to 'active'.
		expect(state.phase).toBe('active');
	});

	// Go: manual_commit_hooks.go: InitializeSession:2243-2244 — partial state recovery
	it('treats state with empty baseCommit as new session (partial state recovery)', async () => {
		// Pre-write a partial state (concurrent-warning placeholder).
		await strategy.saveSessionState({
			sessionId: 'sess-partial',
			baseCommit: '', // partial
			startedAt: new Date().toISOString(),
			phase: 'idle',
			stepCount: 0,
		});

		await initializeSessionImpl(strategy, 'sess-partial', 'Claude Code', '', '', '');

		const state = await strategy.loadSessionState('sess-partial');
		expect(state).not.toBeNull();
		if (state === null) {
			return;
		}
		// baseCommit was rebuilt from HEAD.
		expect(state.baseCommit).not.toBe('');
		expect(state.phase).toBe('active');
	});

	// Go: manual_commit_session.go: initializeSession:307-323 — TurnID generated
	it('generates a unique TurnID for each turn', async () => {
		await initializeSessionImpl(strategy, 's1', 'Claude Code', '', '', '');
		const t1 = (await strategy.loadSessionState('s1'))?.turnId;
		await initializeSessionImpl(strategy, 's1', 'Claude Code', '', 'second prompt', '');
		const t2 = (await strategy.loadSessionState('s1'))?.turnId;
		expect(t1).toBeTruthy();
		expect(t2).toBeTruthy();
		expect(t1).not.toBe(t2);
	});
});

describe('initializeSessionImpl — existing session', () => {
	let env: TestEnv;
	let strategy: ManualCommitStrategy;

	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		clearGitCommonDirCache();
		clearWorktreeRootCache();
		strategy = new ManualCommitStrategy(env.dir);
	});
	afterEach(async () => {
		await env.cleanup();
		clearGitCommonDirCache();
		clearWorktreeRootCache();
	});

	async function setupExisting(): Promise<void> {
		await initializeSessionImpl(
			strategy,
			'sess',
			'Claude Code',
			'/tmp/t.jsonl',
			'first prompt',
			'claude-sonnet-4',
		);
	}

	// Go: manual_commit_hooks.go: InitializeSession:2199-2201 — sticky agentType
	it('does NOT overwrite agentType when already set', async () => {
		await setupExisting();
		await initializeSessionImpl(strategy, 'sess', 'Cursor', '', '', '');
		const state = await strategy.loadSessionState('sess');
		expect(state?.agentType).toBe('Claude Code');
	});

	// Go: manual_commit_hooks.go: InitializeSession:2204-2206 — overwrite model when provided
	it('updates modelName only when arg is non-empty', async () => {
		await setupExisting();
		await initializeSessionImpl(strategy, 'sess', EMPTY_AGENT_TYPE, '', '', '');
		expect((await strategy.loadSessionState('sess'))?.modelName).toBe('claude-sonnet-4');
		await initializeSessionImpl(strategy, 'sess', EMPTY_AGENT_TYPE, '', '', 'claude-opus');
		expect((await strategy.loadSessionState('sess'))?.modelName).toBe('claude-opus');
	});

	// Go: manual_commit_hooks.go: InitializeSession:2209-2211 — overwrite lastPrompt when provided
	it('updates lastPrompt every turn when userPrompt non-empty', async () => {
		await setupExisting();
		await initializeSessionImpl(strategy, 'sess', EMPTY_AGENT_TYPE, '', 'second prompt', '');
		expect((await strategy.loadSessionState('sess'))?.lastPrompt).toContain('second prompt');
		await initializeSessionImpl(strategy, 'sess', EMPTY_AGENT_TYPE, '', '', '');
		// Empty userPrompt → no overwrite.
		expect((await strategy.loadSessionState('sess'))?.lastPrompt).toContain('second prompt');
	});

	// Go: manual_commit_hooks.go: InitializeSession:2214-2216 — overwrite transcriptPath when changed
	it('overwrites transcriptPath when arg differs', async () => {
		await setupExisting();
		await initializeSessionImpl(strategy, 'sess', EMPTY_AGENT_TYPE, '/tmp/new.jsonl', '', '');
		expect((await strategy.loadSessionState('sess'))?.transcriptPath).toBe('/tmp/new.jsonl');
	});

	// Go: manual_commit_hooks.go: InitializeSession:2218-2222 — clear LastCheckpointID + TurnCheckpointIDs each turn
	it('clears lastCheckpointId and turnCheckpointIds on each turn', async () => {
		await setupExisting();
		// Simulate post-PostCommit state.
		const state = (await strategy.loadSessionState('sess'))!;
		state.lastCheckpointId = '0188abcdef01';
		state.turnCheckpointIds = ['cp1', 'cp2'];
		await strategy.saveSessionState(state);

		await initializeSessionImpl(strategy, 'sess', EMPTY_AGENT_TYPE, '', 'next prompt', '');
		const after = (await strategy.loadSessionState('sess'))!;
		expect(after.lastCheckpointId === undefined || after.lastCheckpointId === '').toBe(true);
		expect(after.turnCheckpointIds === undefined || after.turnCheckpointIds.length === 0).toBe(
			true,
		);
	});

	// Go: manual_commit_hooks.go: InitializeSession:2229-2230 — pendingPromptAttribution captured each turn
	it('captures pendingPromptAttribution each turn', async () => {
		await setupExisting();
		const before = (await strategy.loadSessionState('sess'))!;
		expect(before.pendingPromptAttribution).toBeDefined();
		// Modify worktree so attribution has something to count.
		await env.writeFile('change.txt', 'new line\nanother line\n');

		await initializeSessionImpl(strategy, 'sess', EMPTY_AGENT_TYPE, '', 'next prompt', '');
		const after = (await strategy.loadSessionState('sess'))!;
		expect(after.pendingPromptAttribution).toBeDefined();
		expect(after.pendingPromptAttribution?.checkpointNumber).toBe((after.stepCount ?? 0) + 1);
	});

	// Go: manual_commit_hooks.go: InitializeSession:2185-2189 — TurnStart phase transition (idle→active)
	it('transitions phase from idle to active via EventTurnStart', async () => {
		// First setup — initial transition idle→active.
		await setupExisting();
		const initial = (await strategy.loadSessionState('sess'))!;
		expect(initial.phase).toBe('active');
		// Force phase back to idle (simulating end-of-turn) and re-init.
		initial.phase = 'idle';
		await strategy.saveSessionState(initial);

		await initializeSessionImpl(strategy, 'sess', EMPTY_AGENT_TYPE, '', '', '');
		expect((await strategy.loadSessionState('sess'))?.phase).toBe('active');
	});
});

describe('calculatePromptAttributionAtStart', () => {
	let env: TestEnv;

	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		clearGitCommonDirCache();
		clearWorktreeRootCache();
	});
	afterEach(async () => {
		await env.cleanup();
		clearGitCommonDirCache();
		clearWorktreeRootCache();
	});

	// Go: manual_commit_hooks.go: calculatePromptAttributionAtStart:2287 — checkpointNumber = stepCount + 1
	it('sets checkpointNumber = state.stepCount + 1', async () => {
		const headHash = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		const state = {
			sessionId: 's',
			baseCommit: headHash,
			startedAt: new Date().toISOString(),
			phase: 'idle' as const,
			stepCount: 4,
		};
		const result = await calculatePromptAttributionAtStart(env.dir, state);
		expect(result.checkpointNumber).toBe(5);
	});

	// Go: manual_commit_hooks.go: calculatePromptAttributionAtStart — Story-side: only filter .story/metadata/.
	// Go also filters `.entire/` (Entire's metadata dir), but Story never writes to that dir,
	// so any `.entire/` paths in the worktree are legitimate user-owned files.
	it('filters .story/metadata/ but does NOT filter .claude/ or .entire/ (Story clean-slate)', async () => {
		const headHash = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		await env.writeFile('.entire/legit-user-file', 'Story does not write here, count it');
		await env.writeFile('.story/metadata/x.txt', 'should be filtered');
		await env.writeFile('.claude/settings.json', 'should be counted');
		await env.writeFile('src/main.ts', 'should be counted');

		const state = {
			sessionId: 's',
			baseCommit: headHash,
			startedAt: new Date().toISOString(),
			phase: 'idle' as const,
			stepCount: 0,
		};
		const result = await calculatePromptAttributionAtStart(env.dir, state);
		// .claude/, src/, AND .entire/ all contribute user-added lines (Story-side
		// semantic change vs. Go); only .story/metadata/ is filtered.
		const perFile = result.userAddedPerFile ?? {};
		expect(perFile['.claude/settings.json']).toBeDefined();
		expect(perFile['src/main.ts']).toBeDefined();
		expect(perFile['.entire/legit-user-file']).toBeDefined();
		expect(perFile['.story/metadata/x.txt']).toBeUndefined();
	});

	// Go: manual_commit_hooks.go: calculatePromptAttributionAtStart:2295 — stepCount===0 uses baseTree (skip shadow lookup)
	it('uses baseTree (not shadow) when stepCount===0', async () => {
		const headHash = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		await env.writeFile('newfile.txt', 'new\n');

		const state = {
			sessionId: 's',
			baseCommit: headHash,
			startedAt: new Date().toISOString(),
			phase: 'idle' as const,
			stepCount: 0, // → no shadow lookup
		};
		const result = await calculatePromptAttributionAtStart(env.dir, state);
		// Should produce > 0 user-added lines from newfile.txt.
		expect(result.userLinesAdded).toBeGreaterThan(0);
	});
});

describe('initializeSessionImpl — error path coverage', () => {
	let env: TestEnv;
	let strategy: ManualCommitStrategy;

	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		clearGitCommonDirCache();
		clearWorktreeRootCache();
		strategy = new ManualCommitStrategy(env.dir);
	});
	afterEach(async () => {
		await env.cleanup();
		clearGitCommonDirCache();
		clearWorktreeRootCache();
	});

	// Go: manual_commit_hooks.go: InitializeSession:2179-2181 — wraps loadSessionState err
	it('wraps loadSessionState error with "failed to check session state" prefix', async () => {
		// Pre-write malformed state.json so load throws.
		const stateDir = path.join(env.dir, '.git/story-sessions');
		await env.exec('mkdir', ['-p', stateDir]);
		const { writeFile: w } = await import('node:fs/promises');
		await w(path.join(stateDir, 'sess-bad.json'), 'not json{{{');
		await expect(
			initializeSessionImpl(strategy, 'sess-bad', 'Claude Code', '', '', ''),
		).rejects.toThrow(/failed to check session state/);
	});
});

describe('buildInitialSessionState', () => {
	let env: TestEnv;
	let strategy: ManualCommitStrategy;

	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		clearGitCommonDirCache();
		clearWorktreeRootCache();
		strategy = new ManualCommitStrategy(env.dir);
	});
	afterEach(async () => {
		await env.cleanup();
		clearGitCommonDirCache();
		clearWorktreeRootCache();
	});

	// Go: manual_commit_session.go: initializeSession:282-336 — populates all required fields
	it('populates all fields from HEAD + worktree info', async () => {
		const state = await buildInitialSessionState(
			strategy,
			'new-sess',
			'Claude Code',
			'/tmp/t.jsonl',
			'first prompt',
			'claude-sonnet-4',
		);
		expect(state.sessionId).toBe('new-sess');
		expect(state.baseCommit).not.toBe('');
		expect(state.attributionBaseCommit).toBe(state.baseCommit);
		expect(state.worktreePath).toBe(env.dir);
		expect(state.startedAt).toBeTruthy();
		expect(state.lastInteractionTime).toBeTruthy();
		expect(state.turnId).toBeTruthy();
		expect(state.stepCount).toBe(0);
		expect(state.agentType).toBe('Claude Code');
		expect(state.modelName).toBe('claude-sonnet-4');
		expect(state.transcriptPath).toBe('/tmp/t.jsonl');
		expect(state.lastPrompt).toContain('first prompt');
		expect(state.phase).toBe('idle'); // pre-transition; EventTurnStart promotes to 'active'
	});
});
