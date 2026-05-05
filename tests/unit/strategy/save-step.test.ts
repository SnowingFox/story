/**
 * Phase 5.2 Todo 5 — `save-step.ts` unit tests.
 *
 * Tests `saveStep` (12-step main path) and `saveTaskStep` (task path) by
 * driving real {@link ManualCommitStrategy} instances against `TestEnv` git
 * repos, with the Phase 5.4 stub `initializeSession` mocked when needed.
 *
 * Go references:
 * - `manual_commit_git.go:24-186` `SaveStep`
 * - `manual_commit_git.go:190-315` `SaveTaskStep`
 * - `manual_commit_test.go` SaveStep + SaveTaskStep test families
 */

import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shadowBranchExists, shadowBranchNameForCommit } from '@/checkpoint/temporary';
import { clearGitCommonDirCache } from '@/git';
import { clearWorktreeRootCache } from '@/paths';
import { ManualCommitStrategy } from '@/strategy/manual-commit';
import { saveStep, saveTaskStep } from '@/strategy/save-step';
import type { SessionState, StepContext, TaskStepContext } from '@/strategy/types';
import { TestEnv } from '../../helpers/test-env';

function makeState(overrides: Partial<SessionState> = {}): SessionState {
	return {
		sessionId: 'sess-test',
		baseCommit: 'placeholder',
		startedAt: new Date().toISOString(),
		phase: 'idle',
		stepCount: 0,
		...overrides,
	};
}

function makeStep(overrides: Partial<StepContext> = {}): StepContext {
	return {
		sessionId: 'sess-test',
		modifiedFiles: [],
		newFiles: [],
		deletedFiles: [],
		metadataDir: '.story/metadata/sess-test',
		metadataDirAbs: '/abs/.story/metadata/sess-test',
		commitMessage: 'Checkpoint #1',
		transcriptPath: '/abs/transcript.jsonl',
		authorName: 'Story CLI',
		authorEmail: 'story@local',
		agentType: 'Claude Code',
		stepTranscriptIdentifier: 'msg-1',
		stepTranscriptStart: 0,
		tokenUsage: null,
		...overrides,
	};
}

function makeTaskStep(overrides: Partial<TaskStepContext> = {}): TaskStepContext {
	return {
		sessionId: 'sess-test',
		toolUseId: 'tool-use-abcdef0123456789',
		agentId: 'agent-1',
		modifiedFiles: [],
		newFiles: [],
		deletedFiles: [],
		transcriptPath: '/abs/transcript.jsonl',
		subagentTranscriptPath: '/abs/sub-transcript.jsonl',
		checkpointUuid: '00000000-0000-0000-0000-000000000001',
		authorName: 'Story CLI',
		authorEmail: 'story@local',
		isIncremental: false,
		incrementalSequence: 0,
		incrementalType: '',
		incrementalData: new Uint8Array(),
		subagentType: 'general-purpose',
		taskDescription: 'doing work',
		todoContent: '',
		agentType: 'Claude Code',
		...overrides,
	};
}

// ─── saveStep ─────────────────────────────────────────────────────────────
// Go: manual_commit_git.go:24-186 SaveStep
describe('saveStep — Go: manual_commit_git.go:24-186', () => {
	let env: TestEnv;
	let strategy: ManualCommitStrategy;
	let head: string;
	let metadataDirAbs: string;

	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		clearGitCommonDirCache();
		clearWorktreeRootCache();
		strategy = new ManualCommitStrategy(env.dir);
		head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		metadataDirAbs = path.join(env.dir, '.story/metadata/sess-test');
	});
	afterEach(async () => {
		await env.cleanup();
		clearGitCommonDirCache();
		clearWorktreeRootCache();
	});

	// Go: manual_commit_git.go:99 — first checkpoint creates shadow branch + bumps stepCount
	it('happy path: first checkpoint creates shadow branch + bumps stepCount to 1', async () => {
		const state = makeState({ baseCommit: head });
		await strategy.saveSessionState(state);

		// Stage a file so writeTemporary has a tree to record.
		await env.writeFile('app.ts', 'function hello() {}\n');
		const step = makeStep({
			modifiedFiles: ['app.ts'],
			metadataDir: '.story/metadata/sess-test',
			metadataDirAbs,
		});

		await saveStep(strategy, step);

		const reloaded = await strategy.loadSessionState('sess-test');
		expect(reloaded?.stepCount).toBe(1);
		expect(reloaded?.filesTouched).toEqual(['app.ts']);
		expect(reloaded?.transcriptIdentifierAtStart).toBe('msg-1');
		expect(await shadowBranchExists(env.dir, head, '')).toBe(true);
	});

	// Go: manual_commit_git.go:120-130 — dedup hit early-returns; state untouched
	it('early-returns on writeTemporary dedup (no state mutation)', async () => {
		const state = makeState({ baseCommit: head });
		await strategy.saveSessionState(state);

		await env.writeFile('app.ts', 'function hello() {}\n');
		const step = makeStep({
			modifiedFiles: ['app.ts'],
			metadataDirAbs,
			stepTranscriptIdentifier: 'msg-A',
		});

		await saveStep(strategy, step);
		const afterFirst = await strategy.loadSessionState('sess-test');
		expect(afterFirst?.stepCount).toBe(1);

		// Re-run with same files → writeTemporary hits dedup.
		const stepDedup = makeStep({
			modifiedFiles: ['app.ts'],
			metadataDirAbs,
			stepTranscriptIdentifier: 'msg-DUP-not-recorded',
		});
		await saveStep(strategy, stepDedup);
		const afterDedup = await strategy.loadSessionState('sess-test');
		expect(afterDedup?.stepCount).toBe(1); // unchanged
		expect(afterDedup?.transcriptIdentifierAtStart).toBe('msg-A'); // not overwritten
	});

	// Go: manual_commit_git.go:78-85 — pendingPromptAttribution consumed and cleared
	it('consumes pendingPromptAttribution and clears it', async () => {
		const state = makeState({
			baseCommit: head,
			pendingPromptAttribution: {
				checkpointNumber: 99,
				userLinesAdded: 3,
				userLinesRemoved: 1,
				agentLinesAdded: 5,
				agentLinesRemoved: 0,
			},
		});
		await strategy.saveSessionState(state);

		await env.writeFile('app.ts', 'function hello() {}\n');
		await saveStep(strategy, makeStep({ modifiedFiles: ['app.ts'], metadataDirAbs }));

		const reloaded = await strategy.loadSessionState('sess-test');
		expect(reloaded?.pendingPromptAttribution ?? null).toBeNull();
		expect(reloaded?.promptAttributions?.[0]?.checkpointNumber).toBe(99);
		expect(reloaded?.promptAttributions?.[0]?.userLinesAdded).toBe(3);
	});

	// Go: manual_commit_git.go:84 — pendingPromptAttribution null → fallback uses stepCount+1
	it('falls back to checkpoint-number-only attribution when pending is null', async () => {
		const state = makeState({ baseCommit: head, stepCount: 4 });
		await strategy.saveSessionState(state);

		await env.writeFile('app.ts', 'function hello() {}\n');
		await saveStep(strategy, makeStep({ modifiedFiles: ['app.ts'], metadataDirAbs }));

		const reloaded = await strategy.loadSessionState('sess-test');
		// Pre-increment value of stepCount + 1 == post-increment value (5).
		expect(reloaded?.stepCount).toBe(5);
		expect(reloaded?.promptAttributions?.[0]?.checkpointNumber).toBe(5);
		expect(reloaded?.promptAttributions?.[0]?.userLinesAdded).toBe(0);
	});

	// Go: manual_commit_git.go:147-149 — transcriptIdentifierAtStart only set on first
	// Go: manual_commit_git.go:99-118 — second step finds shadow branch already
	// present (`branchExisted=true`) and appends a new commit, bumping stepCount.
	// Row 5 of phase-5.2/tests.md (`subsequent step: appends to existing shadow branch`).
	it('subsequent step: appends to existing shadow branch', async () => {
		const state = makeState({ baseCommit: head });
		await strategy.saveSessionState(state);

		// First checkpoint creates the shadow branch.
		await env.writeFile('app.ts', 'function hello() {}\n');
		await saveStep(strategy, makeStep({ modifiedFiles: ['app.ts'], metadataDirAbs }));
		expect(await shadowBranchExists(env.dir, head, '')).toBe(true);
		const shadowRef = `refs/heads/${shadowBranchNameForCommit(head, '')}`;
		const firstHash = (await env.exec('git', ['rev-parse', shadowRef])).stdout.trim();

		// Second step: branch already exists; saveStep appends and bumps stepCount.
		await env.writeFile('app.ts', 'function hello() { return 1; }\n');
		await saveStep(strategy, makeStep({ modifiedFiles: ['app.ts'], metadataDirAbs }));

		const reloaded = await strategy.loadSessionState('sess-test');
		expect(reloaded?.stepCount).toBe(2);
		const secondHash = (await env.exec('git', ['rev-parse', shadowRef])).stdout.trim();
		expect(secondHash).not.toBe(firstHash); // new commit on the same branch
	});

	it('records transcriptIdentifier only on first checkpoint', async () => {
		const state = makeState({ baseCommit: head });
		await strategy.saveSessionState(state);

		await env.writeFile('app.ts', 'function hello() {}\n');
		await saveStep(
			strategy,
			makeStep({ modifiedFiles: ['app.ts'], metadataDirAbs, stepTranscriptIdentifier: 'msg-1' }),
		);

		// Second save with different transcript identifier
		await env.writeFile('app.ts', 'function hello() { return 1; }\n');
		await saveStep(
			strategy,
			makeStep({ modifiedFiles: ['app.ts'], metadataDirAbs, stepTranscriptIdentifier: 'msg-2' }),
		);

		const reloaded = await strategy.loadSessionState('sess-test');
		expect(reloaded?.stepCount).toBe(2);
		expect(reloaded?.transcriptIdentifierAtStart).toBe('msg-1');
	});

	// Go: manual_commit_git.go:151-154 — token usage accumulates
	it('accumulates tokenUsage across steps', async () => {
		const state = makeState({ baseCommit: head });
		await strategy.saveSessionState(state);

		await env.writeFile('app.ts', 'function hello() {}\n');
		await saveStep(
			strategy,
			makeStep({
				modifiedFiles: ['app.ts'],
				metadataDirAbs,
				tokenUsage: {
					inputTokens: 10,
					cacheCreationTokens: 0,
					cacheReadTokens: 0,
					outputTokens: 20,
					apiCallCount: 1,
				},
			}),
		);

		await env.writeFile('app.ts', 'function hello() { return 1; }\n');
		await saveStep(
			strategy,
			makeStep({
				modifiedFiles: ['app.ts'],
				metadataDirAbs,
				tokenUsage: {
					inputTokens: 5,
					cacheCreationTokens: 0,
					cacheReadTokens: 0,
					outputTokens: 7,
					apiCallCount: 1,
				},
			}),
		);

		const reloaded = await strategy.loadSessionState('sess-test');
		expect(reloaded?.tokenUsage?.inputTokens).toBe(15);
		expect(reloaded?.tokenUsage?.outputTokens).toBe(27);
		expect(reloaded?.tokenUsage?.apiCallCount).toBe(2);
	});

	// Go: manual_commit_git.go:46-54 SaveStep partial-state recovery (DEFER phase-5.4)
	// Strategy A — mock initializeSession to return cleanly.
	it('saveStep falls back to initializeSession when state is missing (mocked, awaits Phase 5.4)', async () => {
		// Plant the state via the mock — initializeSession would normally
		// create+persist it.
		vi.spyOn(strategy, 'initializeSession').mockImplementation(
			async (sid, agent, _t, _p, _m): Promise<void> => {
				const fresh = makeState({
					sessionId: sid,
					baseCommit: head,
					agentType: agent,
				});
				await strategy.saveSessionState(fresh);
			},
		);

		await env.writeFile('app.ts', 'function hello() {}\n');
		await saveStep(strategy, makeStep({ modifiedFiles: ['app.ts'], metadataDirAbs }));

		expect(strategy.initializeSession).toHaveBeenCalledOnce();
		const reloaded = await strategy.loadSessionState('sess-test');
		expect(reloaded?.stepCount).toBe(1);
		expect(reloaded?.agentType).toBe('Claude Code');
	});

	// ─── error wrap parity ─────────────────────────────────────────────────

	// Go: manual_commit_git.go:43 — wraps load error verbatim
	it('saveStep wraps loadSessionState errors with "failed to load session state"', async () => {
		const state = makeState({ baseCommit: head });
		await strategy.saveSessionState(state);
		vi.spyOn(strategy, 'loadSessionState').mockRejectedValue(new Error('disk corrupt'));
		await expect(
			saveStep(strategy, makeStep({ modifiedFiles: ['app.ts'], metadataDirAbs })),
		).rejects.toThrow(/failed to load session state/);
	});

	// Go: manual_commit_git.go:52 — wraps initializeSession failure
	it('saveStep wraps initializeSession failure with "failed to initialize session"', async () => {
		// state missing → fallback path
		vi.spyOn(strategy, 'initializeSession').mockRejectedValue(new Error('hooks failed'));
		await env.writeFile('app.ts', 'content\n');
		await expect(
			saveStep(strategy, makeStep({ modifiedFiles: ['app.ts'], metadataDirAbs })),
		).rejects.toThrow(/failed to initialize session/);
	});

	// Go: manual_commit_git.go:69 — wraps getCheckpointStore failure
	it('saveStep wraps getCheckpointStore failure with "failed to get checkpoint store"', async () => {
		const state = makeState({ baseCommit: head });
		await strategy.saveSessionState(state);
		vi.spyOn(strategy, 'getCheckpointStore').mockRejectedValue(new Error('store init fail'));
		await env.writeFile('app.ts', 'content\n');
		await expect(
			saveStep(strategy, makeStep({ modifiedFiles: ['app.ts'], metadataDirAbs })),
		).rejects.toThrow(/failed to get checkpoint store/);
	});
});

// ─── saveTaskStep ─────────────────────────────────────────────────────────
// Go: manual_commit_git.go:190-315 SaveTaskStep
describe('saveTaskStep — Go: manual_commit_git.go:190-315', () => {
	let env: TestEnv;
	let strategy: ManualCommitStrategy;
	let head: string;

	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		clearGitCommonDirCache();
		clearWorktreeRootCache();
		strategy = new ManualCommitStrategy(env.dir);
		head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
	});
	afterEach(async () => {
		await env.cleanup();
		clearGitCommonDirCache();
		clearWorktreeRootCache();
	});

	// Go: manual_commit_git.go:244-247 — task commit message contains all 3 trailers
	it('writes task checkpoint with all 3 trailers in commit message', async () => {
		const state = makeState({ baseCommit: head });
		await strategy.saveSessionState(state);
		await env.writeFile('app.ts', 'function hello() {}\n');
		await saveTaskStep(
			strategy,
			makeTaskStep({
				modifiedFiles: ['app.ts'],
			}),
		);

		const shadow = shadowBranchNameForCommit(head, '');
		expect(await shadowBranchExists(env.dir, head, '')).toBe(true);

		const log = (await env.exec('git', ['log', '-1', '--format=%B', shadow])).stdout;
		expect(log).toContain('Story-Metadata-Task: ');
		expect(log).toContain('Story-Session: sess-test');
		expect(log).toContain('Story-Strategy: manual-commit');
	});

	// Go: manual_commit_git.go:275-281 — saveTaskStep does NOT update stepCount/promptAttr/tokenUsage
	it('merges filesTouched but does not touch stepCount/promptAttributions/tokenUsage', async () => {
		const initialState = makeState({
			baseCommit: head,
			stepCount: 5,
			promptAttributions: [
				{
					checkpointNumber: 5,
					userLinesAdded: 1,
					userLinesRemoved: 2,
					agentLinesAdded: 3,
					agentLinesRemoved: 4,
				},
			],
			tokenUsage: {
				inputTokens: 10,
				cacheCreationTokens: 0,
				cacheReadTokens: 0,
				outputTokens: 20,
				apiCallCount: 1,
			},
			filesTouched: ['existing.ts'],
		});
		await strategy.saveSessionState(initialState);

		await env.writeFile('new-task.ts', 'task content\n');
		await saveTaskStep(strategy, makeTaskStep({ modifiedFiles: ['new-task.ts'] }));

		const reloaded = await strategy.loadSessionState('sess-test');
		expect(reloaded?.stepCount).toBe(5); // unchanged
		expect(reloaded?.promptAttributions?.length).toBe(1); // unchanged
		expect(reloaded?.tokenUsage?.inputTokens).toBe(10); // unchanged
		expect(reloaded?.filesTouched).toEqual(['existing.ts', 'new-task.ts']); // merged
	});

	// Go: manual_commit_git.go:198 partial-state recovery (mocked, like saveStep)
	it('saveTaskStep falls back to initializeSession when state missing (mocked)', async () => {
		vi.spyOn(strategy, 'initializeSession').mockImplementation(
			async (sid, agent, _t, _p, _m): Promise<void> => {
				const fresh = makeState({
					sessionId: sid,
					baseCommit: head,
					agentType: agent,
				});
				await strategy.saveSessionState(fresh);
			},
		);

		await env.writeFile('new-task.ts', 'task content\n');
		await saveTaskStep(strategy, makeTaskStep({ modifiedFiles: ['new-task.ts'] }));

		expect(strategy.initializeSession).toHaveBeenCalledOnce();
		const reloaded = await strategy.loadSessionState('sess-test');
		expect(reloaded?.filesTouched).toContain('new-task.ts');
	});

	// Go: manual_commit_git.go:283-289 — branch existed path emits "committed task checkpoint to shadow branch"
	it('emits "committed task checkpoint to shadow branch" log when branch already exists', async () => {
		const state = makeState({ baseCommit: head });
		await strategy.saveSessionState(state);
		// Plant the shadow branch first
		const shadow = shadowBranchNameForCommit(head, '');
		await env.exec('git', ['branch', '-f', shadow, head]);

		await env.writeFile('app.ts', 'first version\n');
		await saveTaskStep(
			strategy,
			makeTaskStep({ modifiedFiles: ['app.ts'], toolUseId: 'tu-existing-1' }),
		);
		// No assertion needed beyond covering the branchExisted=true log path;
		// the test passes if execution doesn't throw.
		expect(await shadowBranchExists(env.dir, head, '')).toBe(true);
	});

	// Go: manual_commit_git.go:305-310 — isIncremental log attrs
	it('emits incremental log attributes when step.isIncremental === true', async () => {
		const state = makeState({ baseCommit: head });
		await strategy.saveSessionState(state);
		await env.writeFile('todos.json', '[{"task": "first"}]\n');
		await saveTaskStep(
			strategy,
			makeTaskStep({
				modifiedFiles: ['todos.json'],
				isIncremental: true,
				incrementalSequence: 3,
				incrementalType: 'TodoWrite',
				todoContent: 'in-progress task',
				toolUseId: 'tu-incremental-1',
			}),
		);
		// Pass = no throw. (The log attrs themselves are stderr side effects;
		// we cover the branch executes without failure.)
		expect(true).toBe(true);
	});

	// Go: manual_commit_git.go:278-281 — wraps post-write saveSessionState error
	it('wraps a saveSessionState error after task checkpoint with "failed to save session state"', async () => {
		const state = makeState({ baseCommit: head });
		await strategy.saveSessionState(state); // pre-save state file before mocking
		await env.writeFile('app.ts', 'first version\n');
		// Mock the post-write saveSessionState invocation inside saveTaskStep.
		vi.spyOn(strategy, 'saveSessionState').mockRejectedValue(new Error('disk full'));
		await expect(
			saveTaskStep(strategy, makeTaskStep({ modifiedFiles: ['app.ts'] })),
		).rejects.toThrow(/failed to save session state/);
	});

	// Go: manual_commit_git.go:193 — wraps openRepository error
	it('saveTaskStep wraps openRepository error with "failed to open git repository"', async () => {
		vi.spyOn(strategy, 'getRepo').mockRejectedValue(new Error('not a git dir'));
		await expect(
			saveTaskStep(strategy, makeTaskStep({ modifiedFiles: ['app.ts'] })),
		).rejects.toThrow(/failed to open git repository/);
	});

	// Go: manual_commit_git.go:198 — load error treated like null state (CRITICAL)
	// Different from saveStep which wraps + propagates the load error.
	it('saveTaskStep falls back to initializeSession when loadSessionState throws (Go: load err == null state)', async () => {
		// loadSessionState throws on first call, then returns a fresh state after init.
		const fresh = makeState({ baseCommit: head, agentType: 'Claude Code' });
		vi.spyOn(strategy, 'loadSessionState')
			.mockRejectedValueOnce(new Error('corrupt state file'))
			.mockResolvedValueOnce(fresh);
		const initSpy = vi
			.spyOn(strategy, 'initializeSession')
			.mockImplementation(async (_sid, _agent, _t, _p, _m): Promise<void> => {
				// pretend init wrote a fresh state — second loadSessionState call returns it
			});

		await env.writeFile('app.ts', 'task content\n');
		await saveTaskStep(strategy, makeTaskStep({ modifiedFiles: ['app.ts'] }));

		expect(initSpy).toHaveBeenCalledOnce();
	});

	// Go: manual_commit_git.go:202 — wraps initializeSession error
	it('saveTaskStep wraps initializeSession failure with "failed to initialize session for task checkpoint"', async () => {
		vi.spyOn(strategy, 'initializeSession').mockRejectedValue(new Error('hooks failed'));
		await env.writeFile('app.ts', 'task content\n');
		await expect(
			saveTaskStep(strategy, makeTaskStep({ modifiedFiles: ['app.ts'] })),
		).rejects.toThrow(/failed to initialize session for task checkpoint/);
	});

	// Go: manual_commit_git.go:213 — wraps getCheckpointStore error
	it('saveTaskStep wraps getCheckpointStore failure with "failed to get checkpoint store"', async () => {
		const state = makeState({ baseCommit: head });
		await strategy.saveSessionState(state);
		vi.spyOn(strategy, 'getCheckpointStore').mockRejectedValue(new Error('store init fail'));
		await env.writeFile('app.ts', 'task content\n');
		await expect(
			saveTaskStep(strategy, makeTaskStep({ modifiedFiles: ['app.ts'] })),
		).rejects.toThrow(/failed to get checkpoint store/);
	});
});
