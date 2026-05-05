import fsCallback from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import git from 'isomorphic-git';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_TYPE_CLAUDE_CODE } from '@/agent/types';
import { shadowBranchNameForCommit } from '@/checkpoint/temporary';
import type { CheckpointID } from '@/id';
import { StateStore } from '@/session/state-store';
import { condenseSession } from '@/strategy/condensation';
import { ManualCommitStrategy } from '@/strategy/manual-commit';
import type { SessionState } from '@/strategy/types';
import * as compactMod from '@/transcript/compact';
import { TestEnv } from '../../helpers/test-env';

const SESSION_ID = '2026-04-19-condense-test';
const CHECKPOINT_ID = '0123456789ab' as CheckpointID;

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

async function createShadowBranch(
	env: TestEnv,
	name: string,
	files: Record<string, string>,
): Promise<void> {
	// Build a tree with `.story/metadata/<sessionId>/<file>` blobs.
	const sessionEntries: Array<{ mode: string; path: string; oid: string; type: 'blob' }> = [];
	for (const [filename, content] of Object.entries(files)) {
		const blobOid = await git.writeBlob({
			fs: fsCallback,
			dir: env.dir,
			blob: new TextEncoder().encode(content),
		});
		sessionEntries.push({ mode: '100644', path: filename, oid: blobOid, type: 'blob' });
	}
	const sessionTree = await git.writeTree({
		fs: fsCallback,
		dir: env.dir,
		tree: sessionEntries,
	});
	const metadataTree = await git.writeTree({
		fs: fsCallback,
		dir: env.dir,
		tree: [{ mode: '040000', path: SESSION_ID, oid: sessionTree, type: 'tree' }],
	});
	const storyTree = await git.writeTree({
		fs: fsCallback,
		dir: env.dir,
		tree: [{ mode: '040000', path: 'metadata', oid: metadataTree, type: 'tree' }],
	});
	const rootTree = await git.writeTree({
		fs: fsCallback,
		dir: env.dir,
		tree: [{ mode: '040000', path: '.story', oid: storyTree, type: 'tree' }],
	});
	const commitOid = await git.commit({
		fs: fsCallback,
		dir: env.dir,
		tree: rootTree,
		parent: [],
		message: 'shadow',
		author: { name: 'test', email: 't@e.t', timestamp: 1700000000, timezoneOffset: 0 },
	});
	await git.branch({ fs: fsCallback, dir: env.dir, ref: name, object: commitOid });
}

async function writeSessionState(env: TestEnv, state: SessionState): Promise<void> {
	const dir = path.join(env.gitDir, 'story-sessions');
	await fsCallback.promises.mkdir(dir, { recursive: true });
	const store = new StateStore(dir);
	await store.save(state);
}

describe('condensation.condenseSession — skip gate', () => {
	let env: TestEnv;
	let strategy: ManualCommitStrategy;

	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		strategy = new ManualCommitStrategy(env.dir);
	});

	afterEach(async () => {
		await env.cleanup();
	});

	// Go: cmd/entire/cli/strategy/condense_skip_test.go TestCondenseSession_SkipsWhenNoTranscriptAndNoFiles
	it('returns skipped:true when no transcript and no files (committedFiles=null)', async () => {
		const state = baseState({ filesTouched: [] });
		const out = await condenseSession(strategy, CHECKPOINT_ID, state, null);
		expect(out.skipped).toBe(true);
		expect(out.checkpointId).toBe(CHECKPOINT_ID);
		expect(out.sessionId).toBe(SESSION_ID);
		expect(out.transcript.length).toBe(0);
	});

	// Go: cmd/entire/cli/strategy/condense_skip_test.go TestCondenseSession_SkipsEmptySessionEvenWithCommittedFiles
	// Regression: skip gate must run BEFORE filterFilesTouched so empty sessions
	// don't acquire committedFiles via the mid-turn fallback and bypass the gate.
	it('skip gate runs BEFORE filterFilesTouched (empty session ignores committedFiles)', async () => {
		const state = baseState({ filesTouched: [] });
		const committedFiles = new Set(['some-file.txt']);
		const out = await condenseSession(strategy, CHECKPOINT_ID, state, committedFiles);
		expect(out.skipped).toBe(true);
	});
});

describe('condensation.condenseSession — non-skip path', () => {
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

	it('writes metadata to v1 branch when transcript present + filesTouched non-empty', async () => {
		// Set up a shadow branch with a transcript blob; condenseSession should
		// extract it, redact it, attribute it, and call store.writeCommitted.
		const shadowName = shadowBranchNameForCommit(baseCommitOid, '');
		await createShadowBranch(env, shadowName, {
			'full.jsonl': '{"type":"user","message":{"content":"hi"}}\n',
			'prompt.txt': 'hi',
		});
		const state = baseState({
			baseCommit: baseCommitOid,
			filesTouched: ['app.ts'],
			stepCount: 2,
		});
		await writeSessionState(env, state);

		const out = await condenseSession(strategy, CHECKPOINT_ID, state, null);
		expect(out.skipped).toBe(false);
		expect(out.sessionId).toBe(SESSION_ID);
		expect(out.checkpointId).toBe(CHECKPOINT_ID);
		expect(out.checkpointsCount).toBe(2);

		// v1 metadata branch should now exist with this checkpoint.
		const branchRef = await git.resolveRef({
			fs: fsCallback,
			dir: env.dir,
			ref: 'refs/heads/story/checkpoints/v1',
		});
		expect(branchRef).toBeTruthy();
	});

	it('does NOT skip when filesTouched non-empty even with empty transcript', async () => {
		// No shadow branch, no transcript path → empty extracted data, but
		// filesTouched non-empty means skip gate is NOT hit.
		const state = baseState({
			baseCommit: baseCommitOid,
			filesTouched: ['app.ts'],
		});
		await writeSessionState(env, state);
		const out = await condenseSession(strategy, CHECKPOINT_ID, state, null);
		expect(out.skipped).toBe(false);
		expect(out.filesTouched).toEqual(['app.ts']);
	});
});

describe('condensation.condenseSession — v2 dual-write', () => {
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

	// Go: cmd/entire/cli/strategy/manual_commit_condensation.go writeCommittedV2IfEnabled
	it('skips v2 write when settings.checkpoints_v2 is unset (default)', async () => {
		// Default settings have checkpoints_v2 = false → v2 ref should not exist.
		const state = baseState({
			baseCommit: baseCommitOid,
			filesTouched: ['app.ts'],
		});
		await writeSessionState(env, state);
		await condenseSession(strategy, CHECKPOINT_ID, state, null);
		// v2 ref should NOT exist when settings disabled.
		await expect(
			git.resolveRef({ fs: fsCallback, dir: env.dir, ref: 'refs/story/checkpoints/v2/main' }),
		).rejects.toThrow();
	});

	it('persists Story turn metrics into v2 /main session metadata', async () => {
		await fsCallback.promises.mkdir(path.join(env.dir, '.story'), { recursive: true });
		await writeFile(
			path.join(env.dir, '.story', 'settings.local.json'),
			JSON.stringify({ enabled: true, strategy_options: { checkpoints_v2: true } }),
		);
		const shadowName = shadowBranchNameForCommit(baseCommitOid, '');
		await createShadowBranch(env, shadowName, {
			'full.jsonl': '{"type":"user","message":{"content":"hi"}}\n',
			'prompt.txt': 'hi',
		});
		const state = baseState({
			baseCommit: baseCommitOid,
			filesTouched: ['app.ts'],
			sessionDurationMs: 120_000,
			activeDurationMs: 45_000,
			turnMetrics: [
				{
					turnId: 'turn-1',
					startedAt: '2026-04-27T10:00:00.000Z',
					endedAt: '2026-04-27T10:00:30.000Z',
					durationMs: 30_000,
				},
				{
					turnId: 'turn-2',
					startedAt: '2026-04-27T10:01:00.000Z',
					endedAt: '2026-04-27T10:01:15.000Z',
					durationMs: 15_000,
				},
			],
		});
		await writeSessionState(env, state);
		await condenseSession(strategy, CHECKPOINT_ID, state, null);

		const v2Store = await strategy.getV2CheckpointStore();
		const v2Metadata = await v2Store.readSessionMetadata(CHECKPOINT_ID, 0);
		expect(v2Metadata).not.toBeNull();
		const metrics = v2Metadata?.sessionMetrics;
		expect(metrics?.durationMs).toBeGreaterThanOrEqual(120_000);
		expect(metrics?.activeDurationMs).toBe(45_000);
		expect(metrics?.turnMetrics).toEqual(state.turnMetrics);
	});

	it('writes to v2 main ref when settings.checkpoints_v2 enabled', async () => {
		// Write a settings.local.json enabling checkpoints_v2.
		await writeFile(
			path.join(env.dir, '.story', 'settings.local.json'),
			JSON.stringify({ enabled: true, strategy_options: { checkpoints_v2: true } }),
		).catch(async (err) => {
			if (err.code === 'ENOENT') {
				await fsCallback.promises.mkdir(path.join(env.dir, '.story'), { recursive: true });
				await writeFile(
					path.join(env.dir, '.story', 'settings.local.json'),
					JSON.stringify({ enabled: true, strategy_options: { checkpoints_v2: true } }),
				);
			} else {
				throw err;
			}
		});

		const state = baseState({
			baseCommit: baseCommitOid,
			filesTouched: ['app.ts'],
		});
		await writeSessionState(env, state);
		await condenseSession(strategy, CHECKPOINT_ID, state, null);

		const v2Ref = await git.resolveRef({
			fs: fsCallback,
			dir: env.dir,
			ref: 'refs/story/checkpoints/v2/main',
		});
		expect(v2Ref).toBeTruthy();
	});

	it('warns and continues when v2 write throws (does NOT propagate)', async () => {
		// Force checkpoints_v2 setting on, then make V2GitStore.writeCommitted throw.
		await fsCallback.promises.mkdir(path.join(env.dir, '.story'), { recursive: true });
		await writeFile(
			path.join(env.dir, '.story', 'settings.local.json'),
			JSON.stringify({ enabled: true, strategy_options: { checkpoints_v2: true } }),
		);
		const state = baseState({
			baseCommit: baseCommitOid,
			filesTouched: ['app.ts'],
		});
		await writeSessionState(env, state);

		// Mock V2GitStore.writeCommitted via the strategy's lazy store.
		const v2Store = await strategy.getV2CheckpointStore();
		const spy = vi.spyOn(v2Store, 'writeCommitted').mockRejectedValueOnce(new Error('v2 failed'));
		// v1 write should still succeed; v2 failure swallowed.
		const out = await condenseSession(strategy, CHECKPOINT_ID, state, null);
		expect(out.skipped).toBe(false);
		expect(spy).toHaveBeenCalled();
		spy.mockRestore();
	});
});

describe('condensation.condenseSession — compact + summary stubs', () => {
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

	// TODO(impl-2): once impl-2 ships real Claude compact, change this test to
	// assert non-null compactTranscript bytes are written into the v2 /main tree
	// Phase 5.3 Part 2: compact() is now real impl. With one user line input,
	// it emits exactly one compact line — verify both compact() invocation and
	// the resulting compactTranscriptLines counter.
	it('compact() real impl emits one line for single-user transcript', async () => {
		await fsCallback.promises.mkdir(path.join(env.dir, '.story'), { recursive: true });
		await writeFile(
			path.join(env.dir, '.story', 'settings.local.json'),
			JSON.stringify({ enabled: true, strategy_options: { checkpoints_v2: true } }),
		);
		const shadowName = shadowBranchNameForCommit(baseCommitOid, '');
		await createShadowBranch(env, shadowName, {
			'full.jsonl': '{"type":"user","message":{"content":"hi"}}\n',
		});
		const state = baseState({
			baseCommit: baseCommitOid,
			filesTouched: ['app.ts'],
		});
		await writeSessionState(env, state);

		const compactSpy = vi.spyOn(compactMod, 'compact');
		const out = await condenseSession(strategy, CHECKPOINT_ID, state, null);
		expect(out.compactTranscriptLines).toBe(1);
		expect(compactSpy).toHaveBeenCalled();
		compactSpy.mockRestore();
	});
});

// ─────────────────────────────────────────────────────────────────────
// Tier B2 — Go-aligned scenarios that were missing in Part 1's first pass.
// Each test below is a 1:1 port of a Go scenario; expected values come from
// Go's behavior (NOT TS inference). Per testing-discipline.md §1.
// ─────────────────────────────────────────────────────────────────────

// `describe('condense-helpers.sessionStateBackfillTokenUsage — Copilot ...')`
// was removed when Copilot CLI was dropped from the roadmap — see
// references/dropped-agents.md.

describe('condense-helpers.marshalPromptAttributionsIncludingPending — pendingPromptAttribution append', () => {
	// Go: manual_commit_condensation.go:475-489 marshalPromptAttributionsIncludingPending
	//   `pas := make([]PromptAttribution, len(state.PromptAttributions), len(state.PromptAttributions)+1)`
	//   `copy(pas, state.PromptAttributions)`
	//   `if state.PendingPromptAttribution != nil { pas = append(pas, *state.PendingPromptAttribution) }`
	it('order preserved: PA1 → PA2 → ... → pending appended LAST', async () => {
		const { marshalPromptAttributionsIncludingPending } = await import(
			'@/strategy/condense-helpers'
		);
		const pa1 = {
			checkpointNumber: 1,
			userLinesAdded: 1,
			userLinesRemoved: 0,
			agentLinesAdded: 0,
			agentLinesRemoved: 0,
			userAddedPerFile: { 'a.ts': 1 },
		};
		const pa2 = {
			checkpointNumber: 2,
			userLinesAdded: 2,
			userLinesRemoved: 0,
			agentLinesAdded: 5,
			agentLinesRemoved: 0,
			userAddedPerFile: { 'a.ts': 2 },
		};
		const pending = {
			checkpointNumber: 3,
			userLinesAdded: 7,
			userLinesRemoved: 1,
			agentLinesAdded: 0,
			agentLinesRemoved: 0,
			userAddedPerFile: { 'b.ts': 7 },
			userRemovedPerFile: { 'a.ts': 1 },
		};
		const state = baseState({
			promptAttributions: [pa1, pa2],
			pendingPromptAttribution: pending,
		});
		const out = marshalPromptAttributionsIncludingPending(state);
		expect(Array.isArray(out)).toBe(true);
		const arr = out as Array<{
			checkpointNumber: number;
			userLinesAdded: number;
			userRemovedPerFile?: Record<string, number>;
		}>;
		expect(arr).toHaveLength(3);
		expect(arr[0]?.checkpointNumber).toBe(1);
		expect(arr[1]?.checkpointNumber).toBe(2);
		// Order matters — pending MUST be last (Go: `pas = append(pas, ...)`).
		expect(arr[2]?.checkpointNumber).toBe(3);
		expect(arr[2]?.userLinesAdded).toBe(7);
		expect(arr[2]?.userRemovedPerFile).toEqual({ 'a.ts': 1 });
	});

	it('returns null when both PA list and pending are empty', async () => {
		const { marshalPromptAttributionsIncludingPending } = await import(
			'@/strategy/condense-helpers'
		);
		expect(marshalPromptAttributionsIncludingPending(baseState())).toBeNull();
	});
});

describe('condensation.condenseSession — attributionBaseCommit fallback', () => {
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

	// Go: manual_commit_condensation.go:619-622 — when state.AttributionBaseCommit
	// is empty, falls back to state.BaseCommit. Verifies the fallback succeeds.
	it('attributionBaseCommit empty → uses baseCommit, attribution still produces non-null result', async () => {
		const shadowName = shadowBranchNameForCommit(baseCommitOid, '');
		await createShadowBranch(env, shadowName, {
			'full.jsonl': '{"type":"user","message":{"content":"hi"}}\n',
		});
		const state = baseState({
			baseCommit: baseCommitOid,
			attributionBaseCommit: '',
			filesTouched: ['app.ts'],
			stepCount: 1,
		});
		await writeSessionState(env, state);

		// condenseSession should not throw even though attributionBaseCommit is
		// empty — the fallback to baseCommit means attribution can still resolve.
		const out = await condenseSession(strategy, CHECKPOINT_ID, state, null);
		expect(out.skipped).toBe(false);
		// Branch ref should still be created (proves writeCommitted ran).
		const ref = await git.resolveRef({
			fs: fsCallback,
			dir: env.dir,
			ref: 'refs/heads/story/checkpoints/v1',
		});
		expect(ref).toBeTruthy();
	});
});

describe('condensation.condenseSession — live transcript preferred over shadow tree', () => {
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

	// Go: manual_commit_condensation.go:728-754 — extractSessionData prefers
	// liveTranscriptPath over the shadow tree blob. This handles the case where
	// SaveStep was skipped (no code changes) but the transcript continued growing.
	it('shadow has v1 transcript; live file has v1+v2 → result transcript is live (v1+v2)', async () => {
		const shadowName = shadowBranchNameForCommit(baseCommitOid, '');
		const shadowTranscript = '{"type":"user","message":{"content":"v1"}}\n';
		const liveTranscript =
			'{"type":"user","message":{"content":"v1"}}\n{"type":"user","message":{"content":"v2"}}\n';
		await createShadowBranch(env, shadowName, { 'full.jsonl': shadowTranscript });
		const livePath = path.join(env.dir, 'live.jsonl');
		await writeFile(livePath, liveTranscript);

		const state = baseState({
			baseCommit: baseCommitOid,
			filesTouched: ['app.ts'],
			stepCount: 1,
			transcriptPath: livePath,
		});
		await writeSessionState(env, state);
		const out = await condenseSession(strategy, CHECKPOINT_ID, state, null);
		// Result.transcript reflects what extractSessionData returned (the LIVE bytes).
		const decoded = new TextDecoder().decode(out.transcript);
		expect(decoded).toBe(liveTranscript);
		expect(decoded).toContain('v2');
	});
});

describe('condensation.condenseSession — redact failure drops transcript', () => {
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

	// Go: manual_commit_condensation.go:182-190 — redactSessionTranscript
	// failure must be caught + warned + transcript dropped to empty bytes;
	// metadata write MUST still proceed.
	it('redact throws → log warn + writeOpts.transcript=empty + writeCommitted still runs', async () => {
		const shadowName = shadowBranchNameForCommit(baseCommitOid, '');
		await createShadowBranch(env, shadowName, {
			'full.jsonl': '{"type":"user","message":{"content":"hello"}}\n',
		});
		const state = baseState({
			baseCommit: baseCommitOid,
			filesTouched: ['app.ts'],
			stepCount: 1,
		});
		await writeSessionState(env, state);

		// Mock redactSessionTranscript to throw — caller must catch + continue.
		const helpers = await import('@/strategy/condense-helpers');
		const spy = vi
			.spyOn(helpers, 'redactSessionTranscript')
			.mockRejectedValueOnce(new Error('redact exploded'));

		const out = await condenseSession(strategy, CHECKPOINT_ID, state, null);
		// Skip gate did NOT fire (transcript was non-empty before redact).
		expect(out.skipped).toBe(false);
		// Branch was still written (writeCommitted ran with empty transcript).
		const ref = await git.resolveRef({
			fs: fsCallback,
			dir: env.dir,
			ref: 'refs/heads/story/checkpoints/v1',
		});
		expect(ref).toBeTruthy();
		spy.mockRestore();
	});
});

describe('condensation.condenseSession — skip gate ordering regression (mid-turn agent commit)', () => {
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

	// Go: condense_skip_test.go:50 TestCondenseSession_SkipsEmptySessionEvenWithCommittedFiles
	// — committedFiles non-empty BUT transcript also non-empty (from shadow tree)
	// → must NOT skip. This is the inverse of the original regression: making
	// sure we don't accidentally over-skip when shadow tree has real content.
	it('committedFiles non-empty + filesTouched=[] + transcript=non-empty → does NOT skip', async () => {
		const shadowName = shadowBranchNameForCommit(baseCommitOid, '');
		await createShadowBranch(env, shadowName, {
			'full.jsonl': '{"type":"user","message":{"content":"agent worked"}}\n',
		});
		const state = baseState({
			baseCommit: baseCommitOid,
			filesTouched: [],
			stepCount: 1,
		});
		await writeSessionState(env, state);

		const committedFiles = new Set(['some-file.txt']);
		const out = await condenseSession(strategy, CHECKPOINT_ID, state, committedFiles);
		// Transcript is non-empty (from shadow extract) → skip gate does NOT fire.
		expect(out.skipped).toBe(false);
		// filterFilesTouched fell back to committedFiles minus metadata.
		expect(out.filesTouched).toEqual(['some-file.txt']);
	});
});

describe('condensation.condenseSession — debug timing log fields', () => {
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

	// Go: manual_commit_condensation.go:274-286 — debug log "condense timings"
	// must include 7 timing fields + 2 size fields. Verifies observability
	// surface stays compatible with downstream tooling parsing the log JSON.
	it('emits debug log with 7 timing fields + transcript_bytes + transcript_lines', async () => {
		const log = await import('@/log');
		const shadowName = shadowBranchNameForCommit(baseCommitOid, '');
		await createShadowBranch(env, shadowName, {
			'full.jsonl': '{"type":"user","message":{"content":"hi"}}\n',
		});
		const state = baseState({
			baseCommit: baseCommitOid,
			filesTouched: ['app.ts'],
			stepCount: 1,
		});
		await writeSessionState(env, state);

		const debugSpy = vi.spyOn(log, 'debug');
		await condenseSession(strategy, CHECKPOINT_ID, state, null);

		const timingCall = debugSpy.mock.calls.find((args) => args[1] === 'condense timings');
		expect(timingCall).toBeDefined();
		const fields = timingCall?.[2] as Record<string, unknown>;
		// Go: 7 timing keys + 2 size keys + session_id + checkpoint_id
		expect(fields).toMatchObject({
			session_id: SESSION_ID,
			checkpoint_id: CHECKPOINT_ID,
		});
		const expectedTimingKeys = [
			'extract_session_data_ms',
			'calculate_session_attribution_ms',
			'redact_transcript_ms',
			'compact_transcript_v2_ms',
			'write_committed_v1_ms',
			'write_committed_v2_ms',
			'total_ms',
		];
		for (const key of expectedTimingKeys) {
			expect(fields).toHaveProperty(key);
			expect(typeof fields[key]).toBe('number');
		}
		expect(fields).toHaveProperty('transcript_bytes');
		expect(fields).toHaveProperty('transcript_lines');
		debugSpy.mockRestore();
	});
});

describe('condensation.condenseSession — writeCommitted failure', () => {
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

	// Go: manual_commit_condensation.go:259-263 — store.WriteCommitted error
	// must be wrapped + propagated (NOT swallowed). v1 write failure is fatal.
	it('store.writeCommitted throws → wrap + propagate (NOT swallow)', async () => {
		const shadowName = shadowBranchNameForCommit(baseCommitOid, '');
		await createShadowBranch(env, shadowName, {
			'full.jsonl': '{"type":"user","message":{"content":"hi"}}\n',
		});
		const state = baseState({
			baseCommit: baseCommitOid,
			filesTouched: ['app.ts'],
			stepCount: 1,
		});
		await writeSessionState(env, state);

		// Mock the v1 store.writeCommitted to throw.
		const v1Store = await strategy.getCheckpointStore();
		const spy = vi.spyOn(v1Store, 'writeCommitted').mockRejectedValueOnce(new Error('disk full'));

		await expect(condenseSession(strategy, CHECKPOINT_ID, state, null)).rejects.toThrow(
			/failed to write checkpoint metadata: disk full/,
		);
		spy.mockRestore();
	});
});

// ─────────────────────────────────────────────────────────────────────
// audit-4 Bug 2 — writeTaskMetadataV2IfEnabled real implementation
// Tests cover the 4 paths Go exercises (settings off / no tasks subtree /
// full splice success / resolveSessionIndex failure fail-open).
// Go: manual_commit_condensation.go:1371-1426 writeTaskMetadataV2IfEnabled
// ─────────────────────────────────────────────────────────────────────

import {
	METADATA_FILE_NAME,
	V2_FULL_CURRENT_REF_NAME,
	V2_MAIN_REF_NAME,
} from '@/checkpoint/constants';
import { toPath as cpIdToPath } from '@/id';
import { writeTaskMetadataV2IfEnabled } from '@/strategy/condensation';

describe('condensation.writeTaskMetadataV2IfEnabled', () => {
	let env: TestEnv;
	let strategy: ManualCommitStrategy;
	const TASK_CHECKPOINT_ID = '0123456789ab' as CheckpointID;
	const TASK_SESSION_ID = '2026-04-19-task-test';

	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		strategy = new ManualCommitStrategy(env.dir);
	});

	afterEach(async () => {
		await env.cleanup();
	});

	// Build a shadow commit whose tree contains
	// `.story/metadata/<sessionId>/tasks/<toolUseId>/checkpoint.json` blobs.
	async function buildShadowWithTasks(toolUseIds: string[]): Promise<string> {
		// 1. tasks/<toolUseId>/ blobs
		const taskSubtreeEntries: Array<{
			mode: string;
			path: string;
			oid: string;
			type: 'tree';
		}> = [];
		for (const toolUseId of toolUseIds) {
			const cpBlob = await git.writeBlob({
				fs: fsCallback,
				dir: env.dir,
				blob: new TextEncoder().encode(`{"toolUseId":"${toolUseId}"}`),
			});
			const taskTree = await git.writeTree({
				fs: fsCallback,
				dir: env.dir,
				tree: [{ mode: '100644', path: 'checkpoint.json', oid: cpBlob, type: 'blob' }],
			});
			taskSubtreeEntries.push({ mode: '040000', path: toolUseId, oid: taskTree, type: 'tree' });
		}
		const tasksTree = await git.writeTree({
			fs: fsCallback,
			dir: env.dir,
			tree: taskSubtreeEntries,
		});

		// 2. <sessionId>/ contains tasks/ tree
		const sessionTree = await git.writeTree({
			fs: fsCallback,
			dir: env.dir,
			tree: [{ mode: '040000', path: 'tasks', oid: tasksTree, type: 'tree' }],
		});
		// 3. metadata/<sessionId>/
		const metadataTree = await git.writeTree({
			fs: fsCallback,
			dir: env.dir,
			tree: [{ mode: '040000', path: TASK_SESSION_ID, oid: sessionTree, type: 'tree' }],
		});
		// 4. .story/metadata/
		const storyTree = await git.writeTree({
			fs: fsCallback,
			dir: env.dir,
			tree: [{ mode: '040000', path: 'metadata', oid: metadataTree, type: 'tree' }],
		});
		// 5. root/
		const rootTree = await git.writeTree({
			fs: fsCallback,
			dir: env.dir,
			tree: [{ mode: '040000', path: '.story', oid: storyTree, type: 'tree' }],
		});
		const commitOid = await git.commit({
			fs: fsCallback,
			dir: env.dir,
			tree: rootTree,
			parent: [],
			message: 'shadow with tasks',
			author: { name: 'test', email: 't@e.t', timestamp: 1700000000, timezoneOffset: 0 },
		});
		return commitOid;
	}

	// Build a shadow commit with no tasks/ subtree (just an empty session dir).
	async function buildShadowWithoutTasks(): Promise<string> {
		const sessionTree = await git.writeTree({
			fs: fsCallback,
			dir: env.dir,
			tree: [],
		});
		const metadataTree = await git.writeTree({
			fs: fsCallback,
			dir: env.dir,
			tree: [{ mode: '040000', path: TASK_SESSION_ID, oid: sessionTree, type: 'tree' }],
		});
		const storyTree = await git.writeTree({
			fs: fsCallback,
			dir: env.dir,
			tree: [{ mode: '040000', path: 'metadata', oid: metadataTree, type: 'tree' }],
		});
		const rootTree = await git.writeTree({
			fs: fsCallback,
			dir: env.dir,
			tree: [{ mode: '040000', path: '.story', oid: storyTree, type: 'tree' }],
		});
		const commitOid = await git.commit({
			fs: fsCallback,
			dir: env.dir,
			tree: rootTree,
			parent: [],
			message: 'shadow without tasks',
			author: { name: 'test', email: 't@e.t', timestamp: 1700000000, timezoneOffset: 0 },
		});
		return commitOid;
	}

	// Build a v2 /main ref with one checkpoint that has a session matching TASK_SESSION_ID.
	async function setupV2Main(checkpointId: CheckpointID, sessions: string[]): Promise<void> {
		// Build per-session metadata.json blobs
		const sessionEntries: Array<{ mode: string; path: string; oid: string; type: 'tree' }> = [];
		for (let i = 0; i < sessions.length; i++) {
			const sessId = sessions[i];
			const metaJson = JSON.stringify({
				checkpoint_id: checkpointId,
				session_id: sessId,
				strategy: 'manual-commit',
				created_at: new Date().toISOString(),
				checkpoints_count: 1,
				files_touched: [],
				model: '',
			});
			const metaBlob = await git.writeBlob({
				fs: fsCallback,
				dir: env.dir,
				blob: new TextEncoder().encode(metaJson),
			});
			const sessTree = await git.writeTree({
				fs: fsCallback,
				dir: env.dir,
				tree: [{ mode: '100644', path: METADATA_FILE_NAME, oid: metaBlob, type: 'blob' }],
			});
			sessionEntries.push({ mode: '040000', path: String(i), oid: sessTree, type: 'tree' });
		}

		// Checkpoint-level metadata.json (CheckpointSummary)
		const summaryJson = JSON.stringify({
			checkpoint_id: checkpointId,
			strategy: 'manual-commit',
			checkpoints_count: 1,
			files_touched: [],
			sessions: sessions.map((_sid, i) => ({
				metadata: `${i}/${METADATA_FILE_NAME}`,
				prompt: `${i}/prompts.json`,
			})),
		});
		const summaryBlob = await git.writeBlob({
			fs: fsCallback,
			dir: env.dir,
			blob: new TextEncoder().encode(summaryJson),
		});

		const cpTree = await git.writeTree({
			fs: fsCallback,
			dir: env.dir,
			tree: [
				{ mode: '100644', path: METADATA_FILE_NAME, oid: summaryBlob, type: 'blob' },
				...sessionEntries,
			],
		});

		// Shard tree: <shardSuffix>/ inside <shardPrefix>/
		const cpPath = cpIdToPath(checkpointId);
		const parts = cpPath.split('/');
		const shardPrefix = parts[0] ?? '';
		const shardSuffix = parts[1] ?? '';
		const shardSuffixTree = await git.writeTree({
			fs: fsCallback,
			dir: env.dir,
			tree: [{ mode: '040000', path: shardSuffix, oid: cpTree, type: 'tree' }],
		});
		const rootTree = await git.writeTree({
			fs: fsCallback,
			dir: env.dir,
			tree: [{ mode: '040000', path: shardPrefix, oid: shardSuffixTree, type: 'tree' }],
		});

		const commitOid = await git.commit({
			fs: fsCallback,
			dir: env.dir,
			tree: rootTree,
			parent: [],
			message: `Initial v2 main (checkpoint ${checkpointId})`,
			author: { name: 'test', email: 't@e.t', timestamp: 1700000000, timezoneOffset: 0 },
		});
		await git.writeRef({
			fs: fsCallback,
			dir: env.dir,
			ref: V2_MAIN_REF_NAME,
			value: commitOid,
			force: true,
		});
		// Also bootstrap /full/current ref to the same commit (would-be empty otherwise).
		await git.writeRef({
			fs: fsCallback,
			dir: env.dir,
			ref: V2_FULL_CURRENT_REF_NAME,
			value: commitOid,
			force: true,
		});
	}

	// Go: manual_commit_condensation.go:1378 — settings.checkpoints_v2 disabled → noop.
	it('noop when settings.checkpoints_v2 is unset (default)', async () => {
		// Default settings: no checkpoints_v2 key → returns false → noop.
		await writeTaskMetadataV2IfEnabled(
			strategy,
			env.dir,
			TASK_CHECKPOINT_ID,
			TASK_SESSION_ID,
			null,
		);
		// v2 ref must NOT exist (noop didn't create it).
		await expect(
			git.resolveRef({ fs: fsCallback, dir: env.dir, ref: V2_FULL_CURRENT_REF_NAME }),
		).rejects.toThrow();
	});

	// Go: manual_commit_condensation.go:1378 — shadowRef nil → noop.
	it('noop when shadowOid is null (no shadow tree to read)', async () => {
		await fsCallback.promises.mkdir(path.join(env.dir, '.story'), { recursive: true });
		await writeFile(
			path.join(env.dir, '.story', 'settings.local.json'),
			JSON.stringify({ enabled: true, strategy_options: { checkpoints_v2: true } }),
		);
		await writeTaskMetadataV2IfEnabled(
			strategy,
			env.dir,
			TASK_CHECKPOINT_ID,
			TASK_SESSION_ID,
			null,
		);
		// No /full/current ref written.
		await expect(
			git.resolveRef({ fs: fsCallback, dir: env.dir, ref: V2_FULL_CURRENT_REF_NAME }),
		).rejects.toThrow();
	});

	// Go: manual_commit_condensation.go:1402-1406 — shadow has no tasks/ → silent return.
	it('silent noop when shadow tree has no tasks/ subtree', async () => {
		await fsCallback.promises.mkdir(path.join(env.dir, '.story'), { recursive: true });
		await writeFile(
			path.join(env.dir, '.story', 'settings.local.json'),
			JSON.stringify({ enabled: true, strategy_options: { checkpoints_v2: true } }),
		);
		const shadowOid = await buildShadowWithoutTasks();

		// Should NOT throw, and should NOT touch v2 refs.
		await writeTaskMetadataV2IfEnabled(
			strategy,
			env.dir,
			TASK_CHECKPOINT_ID,
			TASK_SESSION_ID,
			shadowOid,
		);
		await expect(
			git.resolveRef({ fs: fsCallback, dir: env.dir, ref: V2_FULL_CURRENT_REF_NAME }),
		).rejects.toThrow();
	});

	// Go: manual_commit_condensation.go:1419 happy path — splice tasks subtree
	// to v2 /full/current; bumps the ref + new commit contains tasks under
	// <shardPrefix>/<shardSuffix>/<sessionIndex>/tasks/<toolUseId>/...
	it('happy path: shadow tasks/ + v2/main session present → /full/current bumped with splice', async () => {
		await fsCallback.promises.mkdir(path.join(env.dir, '.story'), { recursive: true });
		await writeFile(
			path.join(env.dir, '.story', 'settings.local.json'),
			JSON.stringify({ enabled: true, strategy_options: { checkpoints_v2: true } }),
		);
		const toolUseId = 'toolu_01TASK';
		const shadowOid = await buildShadowWithTasks([toolUseId]);
		// v2 /main contains the checkpoint with TASK_SESSION_ID at index 0.
		await setupV2Main(TASK_CHECKPOINT_ID, [TASK_SESSION_ID]);
		const initialFullCurrent = await git.resolveRef({
			fs: fsCallback,
			dir: env.dir,
			ref: V2_FULL_CURRENT_REF_NAME,
		});

		await writeTaskMetadataV2IfEnabled(
			strategy,
			env.dir,
			TASK_CHECKPOINT_ID,
			TASK_SESSION_ID,
			shadowOid,
		);

		// /full/current ref must have been bumped to a new commit.
		const newFullCurrent = await git.resolveRef({
			fs: fsCallback,
			dir: env.dir,
			ref: V2_FULL_CURRENT_REF_NAME,
		});
		expect(newFullCurrent).not.toBe(initialFullCurrent);

		// Verify the new commit's tree contains the spliced tasks subtree at
		// <shardPrefix>/<shardSuffix>/0/tasks/<toolUseId>/checkpoint.json
		const cpPath = cpIdToPath(TASK_CHECKPOINT_ID);
		const { commit: newCommit } = await git.readCommit({
			fs: fsCallback,
			dir: env.dir,
			oid: newFullCurrent,
		});
		const taskCheckpointBlob = await git.readBlob({
			fs: fsCallback,
			dir: env.dir,
			oid: newCommit.tree,
			filepath: `${cpPath}/0/tasks/${toolUseId}/checkpoint.json`,
		});
		expect(new TextDecoder().decode(taskCheckpointBlob.blob)).toContain(toolUseId);
	});

	// Go: manual_commit_condensation.go:1411 — resolveV2SessionIndexForCheckpoint
	// failure → log warn + return (fail-open; v1 path must not block on v2 task issues).
	it('fail-open: v2/main has no checkpoint → log warn + return (no throw)', async () => {
		await fsCallback.promises.mkdir(path.join(env.dir, '.story'), { recursive: true });
		await writeFile(
			path.join(env.dir, '.story', 'settings.local.json'),
			JSON.stringify({ enabled: true, strategy_options: { checkpoints_v2: true } }),
		);
		const shadowOid = await buildShadowWithTasks(['toolu_01ABC']);
		// v2 /main NOT created → resolveV2SessionIndex throws → log warn + return.

		// Must NOT throw.
		await expect(
			writeTaskMetadataV2IfEnabled(
				strategy,
				env.dir,
				TASK_CHECKPOINT_ID,
				TASK_SESSION_ID,
				shadowOid,
			),
		).resolves.toBeUndefined();
	});
});
