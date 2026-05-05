/**
 * Phase 5.4 Part 2 unit tests for [src/strategy/hooks-post-commit-attribution.ts](src/strategy/hooks-post-commit-attribution.ts).
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/strategy/manual_commit_hooks.go`:
 *   - `updateCombinedAttributionForCheckpoint`
 *
 * Each `it()` is annotated with `// Go: <go-file>:<line>` for the
 * audit-test-go-parity gate.
 *
 * **Story-side divergence test** (#42 in tests-2.md):
 * `updateCombinedAttributionForCheckpoint` filters `.story/metadata/` +
 * `.claude/` but **does NOT** filter `.entire/` (Story never writes there;
 * any `.entire/` content is legitimate user files — consistent with Part 1
 * `calculatePromptAttributionAtStart`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitStore } from '@/checkpoint/types';
import { clearGitCommonDirCache } from '@/git';
import { clearWorktreeRootCache } from '@/paths';
import { updateCombinedAttributionForCheckpoint } from '@/strategy/hooks-post-commit-attribution';
import { ManualCommitStrategy } from '@/strategy/manual-commit';
import { TestEnv } from '../../helpers/test-env';

interface SessionFixture {
	sessionId: string;
	filesTouched: string[];
	checkpointsCount: number;
}

async function plantCheckpoint(
	env: TestEnv,
	checkpointId: string,
	sessions: SessionFixture[],
): Promise<void> {
	const store = new GitStore(env.dir);
	for (const s of sessions) {
		await store.writeCommitted({
			checkpointId,
			sessionId: s.sessionId,
			strategy: 'manual-commit',
			branch: 'main',
			transcript: new TextEncoder().encode(`{"sess":"${s.sessionId}"}\n`),
			prompts: [],
			filesTouched: s.filesTouched,
			checkpointsCount: s.checkpointsCount,
			ephemeralBranch: '',
			authorName: 'Story CLI',
			authorEmail: 'story@local',
			metadataDir: '',
			isTask: false,
			toolUseId: '',
			agentId: '',
			checkpointUuid: '',
			transcriptPath: '',
			subagentTranscriptPath: '',
			isIncremental: false,
			incrementalSequence: 0,
			incrementalType: '',
			incrementalData: new Uint8Array(),
			commitSubject: '',
			agent: 'claudecode',
			model: '',
			turnId: '',
			transcriptIdentifierAtStart: '',
			checkpointTranscriptStart: 0,
			compactTranscriptStart: 0,
			tokenUsage: null,
			sessionMetrics: null,
			initialAttribution: null,
			promptAttributionsJson: null,
			summary: null,
			compactTranscript: null,
		});
	}
}

const CKPT_ID = 'a3b2c4d5e6f7';

// Go: manual_commit_hooks.go:1088-1195 — updateCombinedAttributionForCheckpoint
describe('updateCombinedAttributionForCheckpoint — Go: manual_commit_hooks.go (updateCombinedAttributionForCheckpoint)', () => {
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

	// Go: manual_commit_hooks.go:1106-1108 — early return when summary <=1 sessions
	it('early-returns when summary has 0 sessions (no metadata branch)', async () => {
		// No checkpoint — readCommitted returns null.
		await updateCombinedAttributionForCheckpoint(strategy, CKPT_ID, null, null, env.dir);
		// No throw; nothing to verify (early return).
		const store = new GitStore(env.dir);
		const summary = await store.readCommitted(CKPT_ID);
		expect(summary).toBeNull();
	});

	// Go: manual_commit_hooks.go:1106-1108 — single session early return
	it('early-returns when summary has exactly 1 session (no merge needed)', async () => {
		await plantCheckpoint(env, CKPT_ID, [
			{ sessionId: 'solo', filesTouched: ['a.ts'], checkpointsCount: 1 },
		]);
		await updateCombinedAttributionForCheckpoint(strategy, CKPT_ID, null, null, env.dir);
		// summary.combinedAttribution should NOT be set (no merge for 1 session).
		const store = new GitStore(env.dir);
		const summary = await store.readCommitted(CKPT_ID);
		expect(summary?.combinedAttribution).toBeUndefined();
	});

	// Go: manual_commit_hooks.go:1119-1121 — exclude commit-only sessions
	it('excludes sessions with metadata.checkpointsCount === 0 from agentFiles set', async () => {
		// Build a real commit so getAllChangedFiles has content.
		const parent = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		const parentTreeOid = (await env.exec('git', ['rev-parse', `${parent}^{tree}`])).stdout.trim();
		await env.writeFile('src/agent.ts', 'agent line\n');
		await env.writeFile('src/human.ts', 'human line\n');
		await env.gitAdd('src/agent.ts', 'src/human.ts');
		const head = await env.gitCommit('two-file commit');
		const headTreeOid = (await env.exec('git', ['rev-parse', `${head}^{tree}`])).stdout.trim();

		// Session A is commit-only (checkpointsCount=0) — skipped.
		// Session B has checkpointsCount > 0 — its filesTouched defines agentFiles.
		await plantCheckpoint(env, CKPT_ID, [
			{ sessionId: 'A', filesTouched: ['src/agent.ts', 'src/human.ts'], checkpointsCount: 0 },
			{ sessionId: 'B', filesTouched: ['src/agent.ts'], checkpointsCount: 2 },
		]);

		await updateCombinedAttributionForCheckpoint(
			strategy,
			CKPT_ID,
			headTreeOid,
			parentTreeOid,
			env.dir,
		);
		const store = new GitStore(env.dir);
		const summary = await store.readCommitted(CKPT_ID);
		const c = summary?.combinedAttribution;
		expect(c).toBeDefined();
		// Only `src/agent.ts` is agent (from Session B). `src/human.ts` is human.
		expect(c?.agentLines).toBeGreaterThan(0); // src/agent.ts new line
		expect(c?.humanAdded).toBeGreaterThan(0); // src/human.ts new line (not in agentFiles)
	});

	// Go: manual_commit_hooks.go:1127-1129 — early return when agentFiles empty
	it('early-returns when ALL sessions are commit-only (agentFiles empty)', async () => {
		await plantCheckpoint(env, CKPT_ID, [
			{ sessionId: 'A', filesTouched: ['x.ts'], checkpointsCount: 0 },
			{ sessionId: 'B', filesTouched: ['y.ts'], checkpointsCount: 0 },
		]);
		await updateCombinedAttributionForCheckpoint(strategy, CKPT_ID, null, null, env.dir);
		const store = new GitStore(env.dir);
		const summary = await store.readCommitted(CKPT_ID);
		expect(summary?.combinedAttribution).toBeUndefined();
	});

	// **Story-side divergence test (#42)**: .entire/ files NOT filtered (Story never writes there).
	it('counts .entire/ files as user content (Story-side divergence — Go would filter)', async () => {
		const parent = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		const parentTreeOid = (await env.exec('git', ['rev-parse', `${parent}^{tree}`])).stdout.trim();
		// Plant 4 paths: .entire/ + .story/metadata/ + .claude/ + src/
		await env.writeFile('.entire/legit-user-file', 'user content here\n');
		await env.writeFile('.story/metadata/x.txt', 'story metadata\n');
		await env.writeFile('.claude/settings.json', '{"claude":1}\n');
		await env.writeFile('src/user.ts', 'user code\n');
		await env.gitAdd(
			'.entire/legit-user-file',
			'.story/metadata/x.txt',
			'.claude/settings.json',
			'src/user.ts',
		);
		const head = await env.gitCommit('mixed paths');
		const headTreeOid = (await env.exec('git', ['rev-parse', `${head}^{tree}`])).stdout.trim();

		// Session A claims src/agent.ts (NOT in commit) — agentFiles only contains
		// that. So all 4 changed files are non-agent. We expect:
		// - .story/metadata/x.txt → filtered (Story drops Story-internal dir)
		// - .claude/settings.json → filtered (cross-attribution drops agent tooling)
		// - .entire/legit-user-file → counted as human (Story-side divergence)
		// - src/user.ts → counted as human
		await plantCheckpoint(env, CKPT_ID, [
			{ sessionId: 'A', filesTouched: ['src/agent.ts'], checkpointsCount: 1 },
			{ sessionId: 'B', filesTouched: ['src/agent.ts'], checkpointsCount: 1 },
		]);

		await updateCombinedAttributionForCheckpoint(
			strategy,
			CKPT_ID,
			headTreeOid,
			parentTreeOid,
			env.dir,
		);
		const store = new GitStore(env.dir);
		const summary = await store.readCommitted(CKPT_ID);
		const c = summary?.combinedAttribution;
		expect(c).toBeDefined();
		// humanAdded should include `.entire/legit-user-file` (1 line) +
		// `src/user.ts` (1 line) = 2 lines. .story/metadata/ + .claude/ are
		// filtered out.
		expect(c?.humanAdded).toBe(2);
	});

	// Go: classify each changed file as agent or human
	it('classifies each changed file as agent or human and totals lines', async () => {
		const parent = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		const parentTreeOid = (await env.exec('git', ['rev-parse', `${parent}^{tree}`])).stdout.trim();
		await env.writeFile('src/agent.ts', 'A1\nA2\nA3\n');
		await env.writeFile('src/human.ts', 'H1\nH2\n');
		await env.gitAdd('src/agent.ts', 'src/human.ts');
		const head = await env.gitCommit('mix');
		const headTreeOid = (await env.exec('git', ['rev-parse', `${head}^{tree}`])).stdout.trim();

		await plantCheckpoint(env, CKPT_ID, [
			{ sessionId: 'A', filesTouched: ['src/agent.ts'], checkpointsCount: 2 },
			{ sessionId: 'B', filesTouched: ['src/agent.ts'], checkpointsCount: 2 },
		]);

		await updateCombinedAttributionForCheckpoint(
			strategy,
			CKPT_ID,
			headTreeOid,
			parentTreeOid,
			env.dir,
		);
		const store = new GitStore(env.dir);
		const c = (await store.readCommitted(CKPT_ID))?.combinedAttribution;
		expect(c?.agentLines).toBe(3);
		expect(c?.humanAdded).toBe(2);
	});

	// Go: metricVersion: 2 + InitialAttribution shape
	it('persists InitialAttribution with metricVersion=2 + agentPercentage', async () => {
		const parent = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		const parentTreeOid = (await env.exec('git', ['rev-parse', `${parent}^{tree}`])).stdout.trim();
		// 2 agent + 1 human → 2/3 = 66.66...
		await env.writeFile('src/agent.ts', 'A1\nA2\n');
		await env.writeFile('src/human.ts', 'H1\n');
		await env.gitAdd('src/agent.ts', 'src/human.ts');
		const head = await env.gitCommit('ratio');
		const headTreeOid = (await env.exec('git', ['rev-parse', `${head}^{tree}`])).stdout.trim();

		await plantCheckpoint(env, CKPT_ID, [
			{ sessionId: 'A', filesTouched: ['src/agent.ts'], checkpointsCount: 1 },
			{ sessionId: 'B', filesTouched: ['src/agent.ts'], checkpointsCount: 1 },
		]);

		await updateCombinedAttributionForCheckpoint(
			strategy,
			CKPT_ID,
			headTreeOid,
			parentTreeOid,
			env.dir,
		);
		const store = new GitStore(env.dir);
		const c = (await store.readCommitted(CKPT_ID))?.combinedAttribution;
		expect(c?.metricVersion).toBe(2);
		expect(c?.agentPercentage).toBeCloseTo((2 / 3) * 100, 2);
	});

	// Filter `.story/metadata/` + `.claude/` (NOT .entire/)
	it('filters .story/metadata/ + .claude/ paths from line counting', async () => {
		const parent = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		const parentTreeOid = (await env.exec('git', ['rev-parse', `${parent}^{tree}`])).stdout.trim();
		await env.writeFile('.story/metadata/sess-x/full.jsonl', 'meta\n');
		await env.writeFile('.claude/scratch.json', '{}\n');
		await env.gitAdd('.story/metadata/sess-x/full.jsonl', '.claude/scratch.json');
		const head = await env.gitCommit('only filtered');
		const headTreeOid = (await env.exec('git', ['rev-parse', `${head}^{tree}`])).stdout.trim();

		await plantCheckpoint(env, CKPT_ID, [
			{ sessionId: 'A', filesTouched: ['x.ts'], checkpointsCount: 1 },
			{ sessionId: 'B', filesTouched: ['y.ts'], checkpointsCount: 1 },
		]);

		await updateCombinedAttributionForCheckpoint(
			strategy,
			CKPT_ID,
			headTreeOid,
			parentTreeOid,
			env.dir,
		);
		const store = new GitStore(env.dir);
		const c = (await store.readCommitted(CKPT_ID))?.combinedAttribution;
		// All changed files filtered → 0 lines.
		expect(c?.agentLines).toBe(0);
		expect(c?.humanAdded).toBe(0);
		expect(c?.totalLinesChanged).toBe(0);
		expect(c?.agentPercentage).toBe(0);
	});

	// Go: agentPercentage = (agentAdded + agentRemoved) / totalLinesChanged * 100
	it('computes agentPercentage correctly when agent removes + human adds', async () => {
		// Plant initial commit with content.
		await env.writeFile('src/agent.ts', 'A1\nA2\nA3\nA4\n');
		await env.gitAdd('src/agent.ts');
		await env.gitCommit('init agent file');

		const parent = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		const parentTreeOid = (await env.exec('git', ['rev-parse', `${parent}^{tree}`])).stdout.trim();
		// agent removes 2 lines from agent.ts; human adds 1 line to human.ts
		await env.writeFile('src/agent.ts', 'A1\nA2\n');
		await env.writeFile('src/human.ts', 'H1\n');
		await env.gitAdd('src/agent.ts', 'src/human.ts');
		const head = await env.gitCommit('agent-shrinks human-grows');
		const headTreeOid = (await env.exec('git', ['rev-parse', `${head}^{tree}`])).stdout.trim();

		await plantCheckpoint(env, CKPT_ID, [
			{ sessionId: 'A', filesTouched: ['src/agent.ts'], checkpointsCount: 1 },
			{ sessionId: 'B', filesTouched: ['src/agent.ts'], checkpointsCount: 1 },
		]);

		await updateCombinedAttributionForCheckpoint(
			strategy,
			CKPT_ID,
			headTreeOid,
			parentTreeOid,
			env.dir,
		);
		const store = new GitStore(env.dir);
		const c = (await store.readCommitted(CKPT_ID))?.combinedAttribution;
		// agent removed 2, human added 1, total = 3.
		expect(c?.agentRemoved).toBe(2);
		expect(c?.humanAdded).toBe(1);
		expect(c?.totalLinesChanged).toBe(3);
		expect(c?.agentPercentage).toBeCloseTo((2 / 3) * 100, 2);
	});

	// Go: manual_commit_hooks.go: updateCombinedAttributionForCheckpoint:1133-1137 —
	// getAllChangedFiles fails → log warn + return (Story-side: silent, no throw).
	// spec #46
	it('warns + returns silently when getAllChangedFiles rejects', async () => {
		const parent = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		const parentTreeOid = (await env.exec('git', ['rev-parse', `${parent}^{tree}`])).stdout.trim();
		await env.writeFile('src/x.ts', 'x\n');
		await env.gitAdd('src/x.ts');
		const head = await env.gitCommit('add x');
		const headTreeOid = (await env.exec('git', ['rev-parse', `${head}^{tree}`])).stdout.trim();

		await plantCheckpoint(env, CKPT_ID, [
			{ sessionId: 'A', filesTouched: ['src/x.ts'], checkpointsCount: 1 },
			{ sessionId: 'B', filesTouched: ['src/x.ts'], checkpointsCount: 1 },
		]);

		// Force getAllChangedFiles to throw via vi.spyOn (ESM-safe).
		const attr = await import('@/strategy/attribution');
		const spy = vi.spyOn(attr, 'getAllChangedFiles').mockImplementation(async () => {
			throw new Error('forced enumeration fail');
		});
		try {
			// No throw — function logs warn and returns.
			await updateCombinedAttributionForCheckpoint(
				strategy,
				CKPT_ID,
				headTreeOid,
				parentTreeOid,
				env.dir,
			);
		} finally {
			spy.mockRestore();
		}
		// combinedAttribution NOT written.
		const summary = await new GitStore(env.dir).readCommitted(CKPT_ID);
		expect(summary?.combinedAttribution).toBeUndefined();
	});

	// Go: manual_commit_hooks.go: updateCombinedAttributionForCheckpoint:1190-1192 —
	// updateCheckpointSummary throws → wrap with "persisting combined attribution:" prefix.
	// spec #47
	it('propagates updateCheckpointSummary error wrapped with "persisting combined attribution:" prefix', async () => {
		const parent = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		const parentTreeOid = (await env.exec('git', ['rev-parse', `${parent}^{tree}`])).stdout.trim();
		await env.writeFile('src/x.ts', 'x\n');
		await env.gitAdd('src/x.ts');
		const head = await env.gitCommit('add x');
		const headTreeOid = (await env.exec('git', ['rev-parse', `${head}^{tree}`])).stdout.trim();

		await plantCheckpoint(env, CKPT_ID, [
			{ sessionId: 'A', filesTouched: ['src/x.ts'], checkpointsCount: 1 },
			{ sessionId: 'B', filesTouched: ['src/x.ts'], checkpointsCount: 1 },
		]);

		// Force updateCheckpointSummary to throw via the strategy's lazy store.
		const store = await strategy.getCheckpointStore();
		store.updateCheckpointSummary = (async () => {
			throw new Error('forced persist fail');
		}) as typeof store.updateCheckpointSummary;

		await expect(
			updateCombinedAttributionForCheckpoint(
				strategy,
				CKPT_ID,
				headTreeOid,
				parentTreeOid,
				env.dir,
			),
		).rejects.toThrow(/persisting combined attribution: forced persist fail/);
	});

	// Phase 3 branch coverage — readSessionMetadata throws → continue (skip session).
	it('continues to next session when readSessionMetadata throws on one session', async () => {
		const parent = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		const parentTreeOid = (await env.exec('git', ['rev-parse', `${parent}^{tree}`])).stdout.trim();
		await env.writeFile('src/x.ts', 'x\n');
		await env.gitAdd('src/x.ts');
		const head = await env.gitCommit('add x');
		const headTreeOid = (await env.exec('git', ['rev-parse', `${head}^{tree}`])).stdout.trim();

		await plantCheckpoint(env, CKPT_ID, [
			{ sessionId: 'A', filesTouched: ['src/x.ts'], checkpointsCount: 1 },
			{ sessionId: 'B', filesTouched: ['src/x.ts'], checkpointsCount: 1 },
		]);

		// Force readSessionMetadata to throw on the first call (and succeed on
		// the second so we still produce a non-empty agentFiles set).
		const store = await strategy.getCheckpointStore();
		const orig = store.readSessionMetadata.bind(store);
		let callCount = 0;
		store.readSessionMetadata = (async (id, idx) => {
			callCount++;
			if (callCount === 1) {
				throw new Error('forced metadata read fail');
			}
			return await orig(id, idx);
		}) as typeof store.readSessionMetadata;

		// No throw — first iteration silently skipped, second succeeds.
		await updateCombinedAttributionForCheckpoint(
			strategy,
			CKPT_ID,
			headTreeOid,
			parentTreeOid,
			env.dir,
		);
		// combinedAttribution still written based on session B's filesTouched.
		const summary = await new GitStore(env.dir).readCommitted(CKPT_ID);
		expect(summary?.combinedAttribution).toBeDefined();
	});
});
