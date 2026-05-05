/**
 * Phase 5.5 rewind-points unit tests — getRewindPoints / getLogsOnlyRewindPoints
 * / resolveLatestCheckpointFromMap / readSessionPrompt.
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/strategy/manual_commit_rewind.go`
 * (`GetRewindPoints` / `GetLogsOnlyRewindPoints` /
 * `ResolveLatestCheckpointFromMap` / `readSessionPrompt`).
 *
 * Each `it()` is annotated with `// Go: <go-file>:<line>` for the
 * audit-test-go-parity gate.
 */

import fsCallback from 'node:fs';
import git from 'isomorphic-git';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { METADATA_BRANCH_NAME } from '@/checkpoint/constants';
import { shadowBranchNameForCommit } from '@/checkpoint/temporary';
import { MODE_DIR, MODE_FILE } from '@/checkpoint/tree-ops';
import { clearGitCommonDirCache } from '@/git';
import type { CheckpointID } from '@/id';
import { clearWorktreeRootCache } from '@/paths';
import { ManualCommitStrategy } from '@/strategy/manual-commit';
import * as metadataBranch from '@/strategy/metadata-branch';
import * as prompts from '@/strategy/prompts';
import {
	getLogsOnlyRewindPoints,
	getRewindPointsImpl,
	readSessionPrompt,
	resolveLatestCheckpointFromMap,
} from '@/strategy/rewind-points';
import { saveSessionState } from '@/strategy/session-state';
import type { CheckpointInfo, SessionState } from '@/strategy/types';
import { TestEnv } from '../../helpers/test-env';

function makeState(overrides: Partial<SessionState> = {}): SessionState {
	return {
		sessionId: 'sess-default',
		baseCommit: 'deadbeef',
		startedAt: new Date().toISOString(),
		phase: 'idle',
		stepCount: 1,
		...overrides,
	};
}

/** Build a shadow checkpoint commit on the given shadow branch with proper trailers. */
async function createShadowCheckpointCommit(
	env: TestEnv,
	branch: string,
	sessionId: string,
	metadataDir: string,
	parents: string[],
): Promise<string> {
	const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
	const headCommit = await git.readCommit({ fs: fsCallback, dir: env.dir, oid: head });
	const message =
		'Checkpoint\n\n' +
		`Story-Metadata: ${metadataDir}\n` +
		`Story-Session: ${sessionId}\n` +
		'Story-Strategy: manual-commit\n';
	const commitOid = await git.writeCommit({
		fs: fsCallback,
		dir: env.dir,
		commit: {
			tree: headCommit.commit.tree,
			parent: parents,
			author: {
				name: 'Test',
				email: 'test@test.com',
				timestamp: Math.floor(Date.now() / 1000),
				timezoneOffset: 0,
			},
			committer: {
				name: 'Test',
				email: 'test@test.com',
				timestamp: Math.floor(Date.now() / 1000),
				timezoneOffset: 0,
			},
			message,
		},
	});
	await git.writeRef({
		fs: fsCallback,
		dir: env.dir,
		ref: `refs/heads/${branch}`,
		value: commitOid,
		force: true,
	});
	return commitOid;
}

/** Build a metadata branch tree with N checkpoint metadata.json blobs. */
async function buildMetadataBranchWithCheckpoints(
	env: TestEnv,
	checkpoints: ReadonlyArray<{
		checkpointId: string;
		sessionId: string;
		createdAt: string;
		sessionPrompt?: string;
		sessionCount?: number;
		sessionIds?: string[];
		sessionPrompts?: string[];
		agent?: string;
	}>,
): Promise<void> {
	type TreeEntry = {
		mode: string;
		path: string;
		oid: string;
		type: 'blob' | 'tree' | 'commit';
	};

	// Group entries by 2-char shard.
	const shards = new Map<string, TreeEntry[]>();

	for (const cp of checkpoints) {
		const cpDirShard = cp.checkpointId.slice(0, 2);
		const cpDirRest = cp.checkpointId.slice(2);
		const sessionCount = cp.sessionIds?.length ?? cp.sessionCount ?? 1;

		const cpEntries: TreeEntry[] = [];

		// Per-session subdirs (always present so readCommittedInfo can pick up
		// representative sessionId / agent / createdAt from the highest-index one).
		const sessionsList: Array<{ metadata: string }> = [];
		for (let i = 0; i < sessionCount; i++) {
			const sid = cp.sessionIds?.[i] ?? cp.sessionId;
			const sessionMetaJson = JSON.stringify({
				session_id: sid,
				agent: cp.agent ?? 'Claude Code',
				created_at: cp.createdAt,
			});
			const sessionMetaBlob = await env.writeBlob(sessionMetaJson);

			const sessTreeEntries: TreeEntry[] = [
				{ mode: MODE_FILE, path: 'metadata.json', oid: sessionMetaBlob, type: 'blob' },
			];
			// Older sessions store their prompt under <i>/prompt.txt
			if (
				i < sessionCount - 1 &&
				cp.sessionPrompts &&
				cp.sessionPrompts[i] !== undefined &&
				cp.sessionPrompts[i] !== ''
			) {
				const promptBlob = await env.writeBlob(cp.sessionPrompts[i] ?? '');
				sessTreeEntries.push({
					mode: MODE_FILE,
					path: 'prompt.txt',
					oid: promptBlob,
					type: 'blob',
				});
			}

			const sessTree = await env.writeTree(sessTreeEntries);
			cpEntries.push({ mode: MODE_DIR, path: String(i), oid: sessTree, type: 'tree' });
			sessionsList.push({ metadata: `/${cpDirShard}/${cpDirRest}/${i}/metadata.json` });
		}

		// Summary metadata.json (listCommitted reads this then walks each session).
		const summaryJson = JSON.stringify({
			checkpoint_id: cp.checkpointId,
			sessions: sessionsList,
			files_touched: [],
			checkpoints_count: sessionCount,
		});
		const metadataBlob = await env.writeBlob(summaryJson);
		cpEntries.push({ mode: MODE_FILE, path: 'metadata.json', oid: metadataBlob, type: 'blob' });

		// Top-level prompt.txt (latest/newest session for both single + multi).
		if (cp.sessionPrompt !== undefined && cp.sessionPrompt !== '') {
			const promptBlob = await env.writeBlob(cp.sessionPrompt);
			cpEntries.push({
				mode: MODE_FILE,
				path: 'prompt.txt',
				oid: promptBlob,
				type: 'blob',
			});
		}

		const cpInnerTree = await env.writeTree(cpEntries);

		const shardEntries = shards.get(cpDirShard) ?? [];
		shardEntries.push({ mode: MODE_DIR, path: cpDirRest, oid: cpInnerTree, type: 'tree' });
		shards.set(cpDirShard, shardEntries);
	}

	const rootEntries: TreeEntry[] = [];
	for (const [shardName, entries] of shards.entries()) {
		const shardTree = await env.writeTree(entries);
		rootEntries.push({ mode: MODE_DIR, path: shardName, oid: shardTree, type: 'tree' });
	}
	const rootTree = await env.writeTree(rootEntries);

	const commitOid = await git.writeCommit({
		fs: fsCallback,
		dir: env.dir,
		commit: {
			tree: rootTree,
			parent: [],
			author: {
				name: 'Test',
				email: 'test@test.com',
				timestamp: Math.floor(Date.now() / 1000),
				timezoneOffset: 0,
			},
			committer: {
				name: 'Test',
				email: 'test@test.com',
				timestamp: Math.floor(Date.now() / 1000),
				timezoneOffset: 0,
			},
			message: `metadata branch fixture\n`,
		},
	});
	await git.writeRef({
		fs: fsCallback,
		dir: env.dir,
		ref: `refs/heads/${METADATA_BRANCH_NAME}`,
		value: commitOid,
		force: true,
	});
}

/** Append a Story-Checkpoint trailer commit to HEAD branch (logs-only candidate). */
async function appendLogsOnlyCommit(
	env: TestEnv,
	checkpointIds: readonly string[],
): Promise<string> {
	const trailerLines = checkpointIds.map((id) => `Story-Checkpoint: ${id}`).join('\n');
	await env.writeFile(`marker-${Math.random().toString(36).slice(2, 8)}.txt`, 'm');
	await env.exec('git', ['add', '-A']);
	const message = `feat: change\n\n${trailerLines}\n`;
	const commitArgs = ['commit', '-m', message];
	await env.exec('git', commitArgs);
	return (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
}

// Go: manual_commit_rewind.go (rewind-points module)
describe('strategy/rewind-points — Go: manual_commit_rewind.go', () => {
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

	// Go: manual_commit_rewind.go: ResolveLatestCheckpointFromMap (2 cases)
	describe('resolveLatestCheckpointFromMap', () => {
		it('picks the latest by createdAt across multiple cpIDs', () => {
			const map = new Map<string, CheckpointInfo>([
				[
					'cp-a',
					{
						checkpointId: 'cp-a' as CheckpointID,
						sessionId: 's',
						createdAt: new Date('2026-04-15T00:00:00Z'),
						checkpointsCount: 1,
						filesTouched: [],
					},
				],
				[
					'cp-b',
					{
						checkpointId: 'cp-b' as CheckpointID,
						sessionId: 's',
						createdAt: new Date('2026-04-16T00:00:00Z'),
						checkpointsCount: 1,
						filesTouched: [],
					},
				],
				[
					'cp-c',
					{
						checkpointId: 'cp-c' as CheckpointID,
						sessionId: 's',
						createdAt: new Date('2026-04-14T00:00:00Z'),
						checkpointsCount: 1,
						filesTouched: [],
					},
				],
			]);
			const result = resolveLatestCheckpointFromMap(
				['cp-a', 'cp-b', 'cp-c'] as CheckpointID[],
				map,
			);
			expect(result).not.toBeNull();
			expect(result?.checkpointId).toBe('cp-b');
		});

		it('returns null when no input ID is in map', () => {
			const map = new Map<string, CheckpointInfo>();
			expect(resolveLatestCheckpointFromMap(['unknown' as CheckpointID], map)).toBeNull();
		});
	});

	// Go: manual_commit_rewind.go: readSessionPrompt (2 cases)
	describe('readSessionPrompt', () => {
		it('returns first prompt from prompt.txt blob', async () => {
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			// Build a tree containing .story/metadata/sess-1/prompt.txt with a 2-prompt
			// content separated by `---`. extractFirstPrompt returns the first one.
			const promptContent = 'First prompt\n\n---\n\nSecond prompt';
			const promptBlob = await env.writeBlob(promptContent);
			const sessTree = await env.writeTree([
				{ mode: MODE_FILE, path: 'prompt.txt', oid: promptBlob, type: 'blob' },
			]);
			const metaTree = await env.writeTree([
				{ mode: MODE_DIR, path: 'sess-1', oid: sessTree, type: 'tree' },
			]);
			const dotStoryTree = await env.writeTree([
				{ mode: MODE_DIR, path: 'metadata', oid: metaTree, type: 'tree' },
			]);
			// Need a parent commit's tree; merge with HEAD tree.
			const headCommit = await git.readCommit({ fs: fsCallback, dir: env.dir, oid: head });
			const headTree = await git.readTree({
				fs: fsCallback,
				dir: env.dir,
				oid: headCommit.commit.tree,
			});
			const rootEntries = [
				...headTree.tree.filter((e) => e.path !== '.story'),
				{ mode: MODE_DIR, path: '.story', oid: dotStoryTree, type: 'tree' as const },
			];
			const rootTree = await env.writeTree(rootEntries);
			const commitOid = await git.writeCommit({
				fs: fsCallback,
				dir: env.dir,
				commit: {
					tree: rootTree,
					parent: [head],
					author: {
						name: 'Test',
						email: 'test@test.com',
						timestamp: Math.floor(Date.now() / 1000),
						timezoneOffset: 0,
					},
					committer: {
						name: 'Test',
						email: 'test@test.com',
						timestamp: Math.floor(Date.now() / 1000),
						timezoneOffset: 0,
					},
					message: 'cp\n',
				},
			});

			const got = await readSessionPrompt(env.dir, commitOid, '.story/metadata/sess-1');
			expect(got).toBe('First prompt');
		});

		it('returns empty string on commit / tree / blob lookup failure', async () => {
			// commit not found
			expect(
				await readSessionPrompt(
					env.dir,
					'0000000000000000000000000000000000000000',
					'.story/metadata/sess',
				),
			).toBe('');
			// blob missing in real commit
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			expect(await readSessionPrompt(env.dir, head, '.story/metadata/no-such-sess')).toBe('');
		});
	});

	// Go: manual_commit_rewind.go: GetLogsOnlyRewindPoints
	describe('getLogsOnlyRewindPoints', () => {
		it('returns [] when no metadata branch exists', async () => {
			const strategy = new ManualCommitStrategy(env.dir);
			const points = await getLogsOnlyRewindPoints(strategy, 10);
			expect(points).toEqual([]);
		});

		it('returns logs-only commits matching metadata branch checkpoints (single-session)', async () => {
			await buildMetadataBranchWithCheckpoints(env, [
				{
					checkpointId: 'aabbccddeeff',
					sessionId: 'sess-1',
					createdAt: '2026-04-15T10:00:00Z',
					sessionPrompt: 'rewrite the README',
				},
			]);
			await appendLogsOnlyCommit(env, ['aabbccddeeff']);

			const strategy = new ManualCommitStrategy(env.dir);
			const points = await getLogsOnlyRewindPoints(strategy, 10);
			expect(points).toHaveLength(1);
			expect(points[0]?.isLogsOnly).toBe(true);
			expect(points[0]?.checkpointId).toBe('aabbccddeeff');
			expect(points[0]?.sessionPrompt).toBe('rewrite the README');
			expect(points[0]?.sessionPrompts).toEqual(['rewrite the README']);
		});

		it('reads multi-session prompts and uses last as main sessionPrompt', async () => {
			await buildMetadataBranchWithCheckpoints(env, [
				{
					checkpointId: 'cafef00d1234',
					sessionId: 'sess-c',
					createdAt: '2026-04-15T10:00:00Z',
					sessionCount: 3,
					sessionIds: ['sess-a', 'sess-b', 'sess-c'],
					sessionPrompts: ['First prompt', 'Second prompt', 'Latest prompt'],
					sessionPrompt: 'Latest prompt',
				},
			]);
			await appendLogsOnlyCommit(env, ['cafef00d1234']);

			const strategy = new ManualCommitStrategy(env.dir);
			const points = await getLogsOnlyRewindPoints(strategy, 10);
			expect(points).toHaveLength(1);
			expect(points[0]?.sessionCount).toBe(3);
			expect(points[0]?.sessionIds).toEqual(['sess-a', 'sess-b', 'sess-c']);
			expect(points[0]?.sessionPrompts).toEqual(['First prompt', 'Second prompt', 'Latest prompt']);
			expect(points[0]?.sessionPrompt).toBe('Latest prompt');
		});

		it('handles getMetadataBranchTree returning null gracefully', async () => {
			// Set up: checkpoint exists in listCheckpoints but tree itself is nullified.
			await buildMetadataBranchWithCheckpoints(env, [
				{
					checkpointId: 'deadbeef0001',
					sessionId: 'sess-d',
					createdAt: '2026-04-15T10:00:00Z',
				},
			]);
			await appendLogsOnlyCommit(env, ['deadbeef0001']);

			const spy = vi.spyOn(metadataBranch, 'getMetadataBranchTree').mockResolvedValue(null);

			const strategy = new ManualCommitStrategy(env.dir);
			const points = await getLogsOnlyRewindPoints(strategy, 10);
			expect(points).toHaveLength(1);
			expect(points[0]?.sessionPrompt).toBe('');
			expect(points[0]?.sessionPrompts).toEqual([]);

			spy.mockRestore();
		});

		it('respects limit (trims to limit)', async () => {
			const cps: Array<{
				checkpointId: string;
				sessionId: string;
				createdAt: string;
			}> = [];
			for (let i = 0; i < 5; i++) {
				cps.push({
					checkpointId: `1234567890${(i + 10).toString(16).padStart(2, '0')}`,
					sessionId: `sess-${i}`,
					createdAt: `2026-04-15T10:0${i}:00Z`,
				});
			}
			await buildMetadataBranchWithCheckpoints(env, cps);
			for (const cp of cps) {
				await appendLogsOnlyCommit(env, [cp.checkpointId]);
			}

			const strategy = new ManualCommitStrategy(env.dir);
			const points = await getLogsOnlyRewindPoints(strategy, 3);
			expect(points.length).toBeLessThanOrEqual(3);
		});

		// Phase 9.5 hardening: all-parents traversal of merge commits.
		// Go: manual_commit_rewind.go: GetLogsOnlyRewindPoints uses LogOrderCommitterTime
		// which walks every parent. TS used to default to isomorphic-git's
		// first-parent traversal — checkpoints reachable only through a merge's
		// secondary parent were silently dropped.
		it('walks all parents of merge commits so checkpoints on side branches are found', async () => {
			// Create a topology:    main:   A---M
			//                              \ /
			//                      feature:  B
			// Where B carries a Story-Checkpoint trailer. Before the fix,
			// TS stops at A (first parent of M); now we also visit B.
			const _head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			// Build a feature branch off HEAD.
			await env.exec('git', ['checkout', '-b', 'feature/side']);
			await env.writeFile('side.txt', 'side');

			// Register a checkpoint on metadata branch that will live on B only.
			await buildMetadataBranchWithCheckpoints(env, [
				{
					checkpointId: 'fede00011122',
					sessionId: 'sess-side',
					createdAt: '2026-04-15T10:00:00Z',
				},
			]);

			await env.exec('git', ['add', '-A']);
			const sideCommit = await env.gitCommit('feat: side work\n\nStory-Checkpoint: fede00011122\n');
			void sideCommit;

			// Jump back to HEAD and merge.
			await env.exec('git', ['checkout', '-']);
			// The HEAD commit is `head`; make a merge commit.
			await env.exec('git', ['merge', '--no-ff', 'feature/side', '-m', 'merge feature']);

			const strategy = new ManualCommitStrategy(env.dir);
			const points = await getLogsOnlyRewindPoints(strategy, 50);
			// The checkpoint should be reachable via the merge's side parent.
			expect(points.some((p) => p.checkpointId === 'fede00011122')).toBe(true);
		});
	});

	// Go: manual_commit_rewind.go: GetRewindPoints
	describe('getRewindPointsImpl', () => {
		// Go: manual_commit_test.go:433 TestShadowStrategy_GetRewindPoints_NoShadowBranch
		it('returns [] when no shadow branches and no logs-only commits exist', async () => {
			// Fresh repo with one commit (already done by TestEnv.create({ initialCommit: true }))
			// — no shadow branches, no metadata branch, no sessions. Mirror Go test.
			const strategy = new ManualCommitStrategy(env.dir);
			const points = await getRewindPointsImpl(strategy, 10);
			expect(points).toEqual([]);
		});

		it('returns shadow checkpoints for active sessions', async () => {
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			// Save a session whose baseCommit matches HEAD so findSessionsForCommit picks it up.
			await saveSessionState(
				makeState({
					sessionId: 'sess-1',
					baseCommit: head,
					stepCount: 1,
					agentType: 'Claude Code',
				}),
				env.dir,
			);
			const branch = shadowBranchNameForCommit(head, '');
			await createShadowCheckpointCommit(env, branch, 'sess-1', '.story/metadata/sess-1', []);

			const strategy = new ManualCommitStrategy(env.dir);
			const points = await getRewindPointsImpl(strategy, 10);
			expect(points.length).toBeGreaterThan(0);
			const shadowPoint = points.find((p) => !p.isLogsOnly);
			expect(shadowPoint).toBeDefined();
			expect(shadowPoint?.sessionId).toBe('sess-1');
			expect(shadowPoint?.agent).toBe('Claude Code');
		});

		it('returns only logs-only when no active sessions for HEAD', async () => {
			await buildMetadataBranchWithCheckpoints(env, [
				{
					checkpointId: 'feedfeed1234',
					sessionId: 'sess-x',
					createdAt: '2026-04-15T10:00:00Z',
					sessionPrompt: 'hello',
				},
			]);
			await appendLogsOnlyCommit(env, ['feedfeed1234']);

			const strategy = new ManualCommitStrategy(env.dir);
			const points = await getRewindPointsImpl(strategy, 10);
			expect(points.length).toBe(1);
			expect(points[0]?.isLogsOnly).toBe(true);
		});

		it('silently swallows getLogsOnlyRewindPoints errors and returns shadow-only', async () => {
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			await saveSessionState(
				makeState({ sessionId: 'sess-only', baseCommit: head, stepCount: 1 }),
				env.dir,
			);
			const branch = shadowBranchNameForCommit(head, '');
			await createShadowCheckpointCommit(env, branch, 'sess-only', '.story/metadata/sess-only', []);

			// Force getLogsOnlyRewindPoints (via its internal listCheckpoints call) to throw.
			const spy = vi.spyOn(metadataBranch, 'listCheckpoints').mockRejectedValue(new Error('boom'));

			const strategy = new ManualCommitStrategy(env.dir);
			const points = await getRewindPointsImpl(strategy, 10);
			// The shadow point still appears.
			expect(points.length).toBeGreaterThan(0);
			expect(points.every((p) => !p.isLogsOnly)).toBe(true);
			spy.mockRestore();
		});

		it('caches sessionPrompt by sessionId across multiple checkpoints from same session', async () => {
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			await saveSessionState(
				makeState({ sessionId: 'sess-cache', baseCommit: head, stepCount: 2 }),
				env.dir,
			);
			const branch = shadowBranchNameForCommit(head, '');
			// Two chained shadow commits for same session.
			const first = await createShadowCheckpointCommit(
				env,
				branch,
				'sess-cache',
				'.story/metadata/sess-cache',
				[],
			);
			await createShadowCheckpointCommit(env, branch, 'sess-cache', '.story/metadata/sess-cache', [
				first,
			]);

			const spy = vi.spyOn(prompts, 'extractFirstPrompt');
			const strategy = new ManualCommitStrategy(env.dir);
			await getRewindPointsImpl(strategy, 10);
			// readSessionPrompt is called once for cache miss; the second checkpoint
			// reuses the cached value. With two checkpoints from same session, we
			// expect at most 1 invocation of extractFirstPrompt for that session.
			// (extractFirstPrompt may be called for other paths too, e.g. logs-only;
			// here metadata branch is empty so total ≤ 1.)
			expect(spy.mock.calls.length).toBeLessThanOrEqual(1);
			spy.mockRestore();
		});

		it('dedupes by id when logs-only commit hash equals shadow cp commit', async () => {
			// Set up shadow + manual same-id logs-only point through mocking
			// getLogsOnlyRewindPoints output to include a duplicate id.
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			await saveSessionState(
				makeState({ sessionId: 'sess-dup', baseCommit: head, stepCount: 1 }),
				env.dir,
			);
			const branch = shadowBranchNameForCommit(head, '');
			const cpHash = await createShadowCheckpointCommit(
				env,
				branch,
				'sess-dup',
				'.story/metadata/sess-dup',
				[],
			);

			// Inject a logs-only point with the same id as the shadow point.
			await buildMetadataBranchWithCheckpoints(env, [
				{
					checkpointId: 'aaaabbbbcccc',
					sessionId: 'sess-dup',
					createdAt: '2026-04-15T10:00:00Z',
				},
			]);
			// Manually fabricate a logs-only result via mock (since the real commit
			// hash matching is not easy to engineer).
			const { getLogsOnlyRewindPoints: _real } = await import('@/strategy/rewind-points');
			const _ = _real; // keep ref to avoid TS complaining

			// Use vi.doMock pattern via spyOn on getMetadataBranchTree to
			// shape the logs-only result. Easier: spyOn getLogsOnlyRewindPoints
			// directly via dynamic-imported module.
			const rewindPointsModule = await import('@/strategy/rewind-points');
			const spy = vi.spyOn(rewindPointsModule, 'getLogsOnlyRewindPoints').mockResolvedValue([
				{
					id: cpHash,
					message: 'dup',
					metadataDir: '',
					date: new Date(),
					isTaskCheckpoint: false,
					toolUseId: '',
					isLogsOnly: true,
					checkpointId: 'aaaabbbbcccc' as CheckpointID,
					agent: 'Claude Code',
					sessionId: 'sess-dup',
					sessionPrompt: '',
					sessionCount: 1,
					sessionIds: ['sess-dup'],
					sessionPrompts: [],
				},
			]);

			const strategy = new ManualCommitStrategy(env.dir);
			const points = await getRewindPointsImpl(strategy, 10);
			const sameIdHits = points.filter((p) => p.id === cpHash);
			expect(sameIdHits.length).toBe(1);
			spy.mockRestore();
		});
	});
});
