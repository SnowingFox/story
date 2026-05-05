import fsCallback from 'node:fs';
import path from 'node:path';
import git from 'isomorphic-git';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_TYPE_CLAUDE_CODE } from '@/agent/types';
import { shadowBranchNameForCommit } from '@/checkpoint/temporary';
import type { CheckpointID } from '@/id';
import { StateStore } from '@/session/state-store';
import * as condensationMod from '@/strategy/condensation';
import { condenseAndMarkFullyCondensed, condenseSessionByID } from '@/strategy/condense-by-id';
import { ManualCommitStrategy } from '@/strategy/manual-commit';
import type { SessionState } from '@/strategy/types';
import { TestEnv } from '../../helpers/test-env';

const SESSION_ID = '2026-04-19-by-id-test';

function baseState(overrides: Partial<SessionState> = {}): SessionState {
	return {
		sessionId: SESSION_ID,
		baseCommit: '0000000000000000000000000000000000000000',
		startedAt: new Date().toISOString(),
		phase: 'idle',
		stepCount: 0,
		agentType: AGENT_TYPE_CLAUDE_CODE,
		...overrides,
	};
}

async function writeSessionState(env: TestEnv, state: SessionState): Promise<void> {
	const dir = path.join(env.gitDir, 'story-sessions');
	await fsCallback.promises.mkdir(dir, { recursive: true });
	const store = new StateStore(dir);
	await store.save(state);
}

async function loadState(env: TestEnv, sessionId: string): Promise<SessionState | null> {
	const dir = path.join(env.gitDir, 'story-sessions');
	const store = new StateStore(dir);
	return store.load(sessionId);
}

async function createBranch(env: TestEnv, name: string, oid: string): Promise<void> {
	await git.branch({ fs: fsCallback, dir: env.dir, ref: name, object: oid });
}

// Go: cmd/entire/cli/strategy/manual_commit_condensation.go CondenseSessionByID
describe('condense-by-id.condenseSessionByID', () => {
	let env: TestEnv;
	let strategy: ManualCommitStrategy;
	let baseCommitOid: string;

	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		strategy = new ManualCommitStrategy(env.dir);
		baseCommitOid = await git.resolveRef({ fs: fsCallback, dir: env.dir, ref: 'HEAD' });
	});

	afterEach(async () => {
		await env.cleanup();
	});

	it('throws when session state not found', async () => {
		await expect(condenseSessionByID(strategy, 'no-such-session')).rejects.toThrow(
			/session not found/,
		);
	});

	it('clears state file when shadow branch missing', async () => {
		const state = baseState({ baseCommit: baseCommitOid });
		await writeSessionState(env, state);
		// No shadow branch created.
		await condenseSessionByID(strategy, SESSION_ID);
		// State file should be deleted (clearSessionState path).
		const after = await loadState(env, SESSION_ID);
		expect(after).toBeNull();
	});

	// Go: cmd/entire/cli/strategy/condense_skip_test.go TestCondenseSessionByID_SkippedPreservesState
	it('marks FullyCondensed=true when condensation skipped (preserves stepCount/phase)', async () => {
		// Empty session w/ shadow branch but no transcript → skip gate fires
		// in condenseSession; condenseSessionByID standardizes the state to
		// FullyCondensed=true while preserving stepCount and phase.
		const state = baseState({
			baseCommit: baseCommitOid,
			stepCount: 3,
			phase: 'idle',
			filesTouched: [],
		});
		await writeSessionState(env, state);
		const branchName = shadowBranchNameForCommit(baseCommitOid, '');
		await createBranch(env, branchName, baseCommitOid);

		await condenseSessionByID(strategy, SESSION_ID);
		const after = await loadState(env, SESSION_ID);
		expect(after?.fullyCondensed).toBe(true);
		expect(after?.stepCount).toBe(3);
		expect(after?.phase).toBe('idle');
	});

	it('warns when shadow branch cleanup fails (does NOT throw)', async () => {
		const state = baseState({
			baseCommit: baseCommitOid,
			stepCount: 1,
			filesTouched: ['app.ts'],
		});
		await writeSessionState(env, state);
		const branchName = shadowBranchNameForCommit(baseCommitOid, '');
		await createBranch(env, branchName, baseCommitOid);

		const cleanupSpy = vi
			.spyOn(await import('@/strategy/condense-helpers'), 'cleanupShadowBranchIfUnused')
			.mockRejectedValueOnce(new Error('cleanup failed'));
		await expect(condenseSessionByID(strategy, SESSION_ID)).resolves.toBeUndefined();
		expect(cleanupSpy).toHaveBeenCalled();
		cleanupSpy.mockRestore();
	});
});

// Go: cmd/entire/cli/strategy/manual_commit_condensation.go CondenseAndMarkFullyCondensed
describe('condense-by-id.condenseAndMarkFullyCondensed', () => {
	let env: TestEnv;
	let strategy: ManualCommitStrategy;
	let baseCommitOid: string;

	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		strategy = new ManualCommitStrategy(env.dir);
		baseCommitOid = await git.resolveRef({ fs: fsCallback, dir: env.dir, ref: 'HEAD' });
	});

	afterEach(async () => {
		await env.cleanup();
	});

	it('returns silently when session state not found (vs ByID which throws)', async () => {
		await expect(
			condenseAndMarkFullyCondensed(strategy, 'no-such-session'),
		).resolves.toBeUndefined();
	});

	it('early-returns when filesTouched non-empty (PostCommit needs carry-forward)', async () => {
		const state = baseState({
			baseCommit: baseCommitOid,
			filesTouched: ['app.ts'],
			stepCount: 5,
		});
		await writeSessionState(env, state);

		const condenseSpy = vi.spyOn(condensationMod, 'condenseSession');
		await condenseAndMarkFullyCondensed(strategy, SESSION_ID);
		// State must NOT have changed (PostCommit will pick it up later).
		expect(condenseSpy).not.toHaveBeenCalled();
		const after = await loadState(env, SESSION_ID);
		expect(after?.stepCount).toBe(5);
		expect(after?.filesTouched).toEqual(['app.ts']);
		expect(after?.fullyCondensed).toBeUndefined();
		condenseSpy.mockRestore();
	});

	it('marks FullyCondensed=true when stepCount=0 (skip condense entirely)', async () => {
		const state = baseState({
			baseCommit: baseCommitOid,
			stepCount: 0,
			filesTouched: [],
		});
		await writeSessionState(env, state);

		const condenseSpy = vi.spyOn(condensationMod, 'condenseSession');
		await condenseAndMarkFullyCondensed(strategy, SESSION_ID);
		expect(condenseSpy).not.toHaveBeenCalled();
		const after = await loadState(env, SESSION_ID);
		expect(after?.fullyCondensed).toBe(true);
		condenseSpy.mockRestore();
	});

	it('marks FullyCondensed=true + does NOT delete state when shadow branch missing', async () => {
		const state = baseState({
			baseCommit: baseCommitOid,
			stepCount: 2,
			filesTouched: [],
		});
		await writeSessionState(env, state);
		// No shadow branch.
		await condenseAndMarkFullyCondensed(strategy, SESSION_ID);
		const after = await loadState(env, SESSION_ID);
		expect(after).not.toBeNull(); // NOT deleted (vs ByID which clears).
		expect(after?.fullyCondensed).toBe(true);
		expect(after?.stepCount).toBe(0);
	});

	it('returns silently when condenseSession throws (fail-open for PostCommit retry)', async () => {
		const state = baseState({
			baseCommit: baseCommitOid,
			stepCount: 2,
			filesTouched: [],
		});
		await writeSessionState(env, state);
		const branchName = shadowBranchNameForCommit(baseCommitOid, '');
		await createBranch(env, branchName, baseCommitOid);

		const condenseSpy = vi
			.spyOn(condensationMod, 'condenseSession')
			.mockRejectedValueOnce(new Error('condense exploded'));
		await expect(condenseAndMarkFullyCondensed(strategy, SESSION_ID)).resolves.toBeUndefined();
		const after = await loadState(env, SESSION_ID);
		// State unchanged on fail-open.
		expect(after?.stepCount).toBe(2);
		expect(after?.fullyCondensed).toBeUndefined();
		condenseSpy.mockRestore();
	});

	// Go: cmd/entire/cli/strategy/condense_skip_test.go TestCondenseAndMarkFullyCondensed_SkippedMarksFullyCondensed
	it('keeps phase=ENDED after successful condense (NOT IDLE like ByID)', async () => {
		const state = baseState({
			baseCommit: baseCommitOid,
			stepCount: 2,
			phase: 'ended',
			filesTouched: [],
		});
		await writeSessionState(env, state);
		const branchName = shadowBranchNameForCommit(baseCommitOid, '');
		await createBranch(env, branchName, baseCommitOid);

		// Mock condenseSession to return non-skipped result so we exercise the
		// state-reset arm that preserves phase=ENDED.
		const fakeId = 'aaaabbbbcccc' as CheckpointID;
		const condenseSpy = vi.spyOn(condensationMod, 'condenseSession').mockResolvedValueOnce({
			checkpointId: fakeId,
			sessionId: SESSION_ID,
			checkpointsCount: 2,
			filesTouched: [],
			prompts: [],
			totalTranscriptLines: 0,
			compactTranscriptLines: 0,
			transcript: new Uint8Array(),
			skipped: false,
		});
		// cleanupShadowBranchIfUnused needs to succeed; mock it.
		const cleanupSpy = vi
			.spyOn(await import('@/strategy/condense-helpers'), 'cleanupShadowBranchIfUnused')
			.mockResolvedValueOnce(undefined);

		await condenseAndMarkFullyCondensed(strategy, SESSION_ID);
		const after = await loadState(env, SESSION_ID);
		expect(after?.phase).toBe('ended');
		expect(after?.stepCount).toBe(0);
		expect(after?.fullyCondensed).toBe(true);
		expect(after?.lastCheckpointId).toBe(fakeId);

		condenseSpy.mockRestore();
		cleanupSpy.mockRestore();
	});

	it('marks FullyCondensed=true when condense skipped (eager path)', async () => {
		const state = baseState({
			baseCommit: baseCommitOid,
			stepCount: 2,
			phase: 'ended',
			filesTouched: [],
		});
		await writeSessionState(env, state);
		const branchName = shadowBranchNameForCommit(baseCommitOid, '');
		await createBranch(env, branchName, baseCommitOid);

		// condenseSession runs → no transcript → skip gate fires → returns skipped:true.
		await condenseAndMarkFullyCondensed(strategy, SESSION_ID);
		const after = await loadState(env, SESSION_ID);
		expect(after?.fullyCondensed).toBe(true);
		expect(after?.phase).toBe('ended');
	});
});

describe('condense-by-id.condenseSessionByID — happy path', () => {
	let env: TestEnv;
	let strategy: ManualCommitStrategy;
	let baseCommitOid: string;

	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		strategy = new ManualCommitStrategy(env.dir);
		baseCommitOid = await git.resolveRef({ fs: fsCallback, dir: env.dir, ref: 'HEAD' });
	});

	afterEach(async () => {
		await env.cleanup();
	});

	it('resets state to phase=IDLE after successful condense (NOT ended like eager)', async () => {
		const state = baseState({
			baseCommit: baseCommitOid,
			stepCount: 2,
			phase: 'active',
			filesTouched: ['app.ts'],
		});
		await writeSessionState(env, state);
		const branchName = shadowBranchNameForCommit(baseCommitOid, '');
		await createBranch(env, branchName, baseCommitOid);

		const fakeId = 'eeeeffff0000' as CheckpointID;
		const condenseSpy = vi.spyOn(condensationMod, 'condenseSession').mockResolvedValueOnce({
			checkpointId: fakeId,
			sessionId: SESSION_ID,
			checkpointsCount: 2,
			filesTouched: ['app.ts'],
			prompts: [],
			totalTranscriptLines: 5,
			compactTranscriptLines: 0,
			transcript: new TextEncoder().encode('hi\n'),
			skipped: false,
		});
		const cleanupSpy = vi
			.spyOn(await import('@/strategy/condense-helpers'), 'cleanupShadowBranchIfUnused')
			.mockResolvedValueOnce(undefined);

		await condenseSessionByID(strategy, SESSION_ID);
		const after = await loadState(env, SESSION_ID);
		expect(after?.phase).toBe('idle'); // ByID resets to IDLE, vs eager keeps ENDED.
		expect(after?.stepCount).toBe(0);
		expect(after?.lastCheckpointId).toBe(fakeId);
		expect(after?.attributionBaseCommit).toBe(baseCommitOid);
		expect(after?.promptAttributions).toBeUndefined();
		expect(after?.pendingPromptAttribution).toBeUndefined();

		condenseSpy.mockRestore();
		cleanupSpy.mockRestore();
	});
});
