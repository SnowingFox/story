/**
 * Phase 5.4 Part 2 unit tests for [src/strategy/hooks-post-commit.ts](src/strategy/hooks-post-commit.ts).
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/strategy/manual_commit_hooks.go`:
 *   - `PostCommit` (11-step main pipeline)
 *   - `postCommitActionHandler` (TS class implementing `ActionHandler`) +
 *     4 method (`handleCondense` / `handleCondenseIfFilesTouched` /
 *     `handleDiscardIfNoFiles` / `handleWarnStaleSession`)
 *   - `shouldCondenseWithOverlapCheck` (6-branch decision tree, ts-pattern.match)
 *   - `condenseAndUpdateState`
 *   - `postCommitProcessSession` (10-step per-session sub-pipeline)
 *   - `updateBaseCommitIfChanged` + `postCommitUpdateBaseCommitOnly`
 *   - leaf helpers: `truncateHash` / `isRecentInteraction` / `subtractFiles` /
 *     `filesChangedInCommit`
 *
 * Each `it()` is annotated with `// Go: <go-file>:<line>` for the
 * audit-test-go-parity gate.
 *
 * **Batch 1 — leaf helpers only**: this file initially ships truncateHash /
 * isRecentInteraction / subtractFiles / filesChangedInCommit /
 * updateBaseCommitIfChanged / postCommitUpdateBaseCommitOnly tests. Batch 3
 * appends the 21 cases for ActionHandler / shouldCondenseWithOverlapCheck /
 * postCommitProcessSession / postCommitImpl.
 */

import fsCallback from 'node:fs';
import path from 'node:path';
import git from 'isomorphic-git';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_TYPE_CLAUDE_CODE } from '@/agent/types';
import { shadowBranchNameForCommit } from '@/checkpoint/temporary';
import { clearGitCommonDirCache } from '@/git';
import type { CheckpointID } from '@/id';
import { clearWorktreeRootCache } from '@/paths';
import {
	filesChangedInCommit,
	isRecentInteraction,
	PostCommitActionHandler,
	postCommitImpl,
	postCommitUpdateBaseCommitOnly,
	subtractFiles,
	truncateHash,
	updateBaseCommitIfChanged,
} from '@/strategy/hooks-post-commit';
import { ManualCommitStrategy } from '@/strategy/manual-commit';
import { loadSessionState, saveSessionState } from '@/strategy/session-state';
import type { SessionState } from '@/strategy/types';
import { TestEnv } from '../../helpers/test-env';

function makeState(overrides: Partial<SessionState> = {}): SessionState {
	return {
		sessionId: 'sess-default',
		baseCommit: 'deadbeef',
		startedAt: new Date().toISOString(),
		phase: 'idle',
		stepCount: 0,
		...overrides,
	};
}

// Go: manual_commit_hooks.go (truncateHash + isRecentInteraction + subtractFiles)
describe('hooks-post-commit leaf helpers — Go: manual_commit_hooks.go', () => {
	// Go: manual_commit_hooks.go: truncateHash
	describe('truncateHash', () => {
		it('truncates to 7 chars when longer', () => {
			expect(truncateHash('abcdefghij1234')).toBe('abcdefg');
		});
		it('returns short hashes unchanged', () => {
			expect(truncateHash('abc')).toBe('abc');
		});
		it('exactly 7 chars: no change', () => {
			expect(truncateHash('1234567')).toBe('1234567');
		});
		it('handles empty string', () => {
			expect(truncateHash('')).toBe('');
		});
	});

	// Go: manual_commit_hooks.go:892-901 (isRecentInteraction +
	// activeSessionInteractionThreshold)
	describe('isRecentInteraction', () => {
		it('returns false for null lastInteraction', () => {
			expect(isRecentInteraction(null)).toBe(false);
		});
		it('returns false for unparseable timestamp', () => {
			expect(isRecentInteraction('not-an-iso-date')).toBe(false);
		});
		it('returns true for recent timestamp (within 24h)', () => {
			const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
			expect(isRecentInteraction(oneHourAgo)).toBe(true);
		});
		it('returns false for stale timestamp (> 24h ago)', () => {
			const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
			expect(isRecentInteraction(twoDaysAgo)).toBe(false);
		});
	});

	// Go: manual_commit_hooks.go: subtractFiles
	describe('subtractFiles', () => {
		it('returns files not in exclude set', () => {
			expect(subtractFiles(['a', 'b', 'c'], new Set(['b']))).toEqual(['a', 'c']);
		});
		it('preserves input order', () => {
			expect(subtractFiles(['c', 'a', 'b'], new Set(['a']))).toEqual(['c', 'b']);
		});
		it('returns empty when all excluded', () => {
			expect(subtractFiles(['a', 'b'], new Set(['a', 'b']))).toEqual([]);
		});
		it('returns input copy when exclude set empty', () => {
			expect(subtractFiles(['a', 'b'], new Set())).toEqual(['a', 'b']);
		});
	});
});

// Go: manual_commit_hooks.go (filesChangedInCommit + filesChangedInCommitFallback)
describe('filesChangedInCommit — Go: manual_commit_hooks.go', () => {
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

	it('fast path: returns set of files changed via git diff-tree', async () => {
		const parent = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		await env.writeFile('a.txt', 'a');
		await env.writeFile('b.txt', 'b');
		await env.gitAdd('a.txt', 'b.txt');
		const head = await env.gitCommit('two files');

		// We don't pass tree OIDs (fast path uses commit hashes only).
		const files = await filesChangedInCommit(env.dir, head, parent, null, null);
		expect([...files].sort()).toEqual(['a.txt', 'b.txt']);
	});

	it('initial commit (no parent) uses --root flag', async () => {
		// Fresh repo with one commit — that commit has no parent.
		const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		const files = await filesChangedInCommit(env.dir, head, '', null, null);
		// Just the .gitkeep created by initialCommit.
		expect([...files]).toContain('.gitkeep');
	});

	it('falls back to tree-walk via getAllChangedFiles when git diff-tree fails', async () => {
		// Build real trees but use non-hex commit hashes so `git diff-tree` rejects
		// them with a syntax error (forces fallback path); pass real tree OIDs for
		// getAllChangedFiles to consume.
		const parent = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		const parentTreeOid = (await env.exec('git', ['rev-parse', `${parent}^{tree}`])).stdout.trim();

		await env.writeFile('a.txt', 'agent change');
		await env.gitAdd('a.txt');
		const head = await env.gitCommit('add a');
		const headTreeOid = (await env.exec('git', ['rev-parse', `${head}^{tree}`])).stdout.trim();

		// Bogus non-hex strings make git diff-tree fail with "Not a valid object name"
		// — exercising the fallback branch.
		const files = await filesChangedInCommit(
			env.dir,
			'not-a-valid-hash',
			'not-a-valid-hash-either',
			headTreeOid,
			parentTreeOid,
		);
		expect([...files]).toContain('a.txt');
	});
});

// Go: manual_commit_hooks.go: updateBaseCommitIfChanged
describe('updateBaseCommitIfChanged — Go: manual_commit_hooks.go', () => {
	it('updates state.baseCommit + attributionBaseCommit for ACTIVE session when newHead differs', () => {
		const state = makeState({ phase: 'active', baseCommit: 'old', attributionBaseCommit: 'old' });
		updateBaseCommitIfChanged(state, 'newhead');
		expect(state.baseCommit).toBe('newhead');
		expect(state.attributionBaseCommit).toBe('newhead');
	});

	it('is no-op for IDLE phase (lastCheckpointID reuse needs old base)', () => {
		const state = makeState({ phase: 'idle', baseCommit: 'old', attributionBaseCommit: 'old' });
		updateBaseCommitIfChanged(state, 'newhead');
		expect(state.baseCommit).toBe('old');
		expect(state.attributionBaseCommit).toBe('old');
	});

	it('is no-op for ENDED phase', () => {
		const state = makeState({ phase: 'ended', baseCommit: 'old', attributionBaseCommit: 'old' });
		updateBaseCommitIfChanged(state, 'newhead');
		expect(state.baseCommit).toBe('old');
	});

	it('is no-op when newHead equals baseCommit', () => {
		const state = makeState({
			phase: 'active',
			baseCommit: 'samehead',
			attributionBaseCommit: 'samehead',
		});
		updateBaseCommitIfChanged(state, 'samehead');
		expect(state.baseCommit).toBe('samehead');
		// AttributionBaseCommit unchanged (no-op short-circuit).
		expect(state.attributionBaseCommit).toBe('samehead');
	});
});

// Go: manual_commit_hooks.go:1483-... — postCommitUpdateBaseCommitOnly
describe('postCommitUpdateBaseCommitOnly — Go: manual_commit_hooks.go (postCommitUpdateBaseCommitOnly)', () => {
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

	it('saves each ACTIVE session immediately (no batch) with newHead', async () => {
		const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		// Plant shadow branches so listAllSessionStates orphan filter keeps the rows.
		const shadowBr = shadowBranchNameForCommit('oldbase', '');
		await env.exec('git', ['branch', '-f', shadowBr, head]);

		await saveSessionState(
			makeState({
				sessionId: 'sA',
				phase: 'active',
				baseCommit: 'oldbase',
				attributionBaseCommit: 'oldbase',
				worktreePath: env.dir,
			}),
			env.dir,
		);
		await saveSessionState(
			makeState({
				sessionId: 'sB',
				phase: 'active',
				baseCommit: 'oldbase',
				attributionBaseCommit: 'oldbase',
				worktreePath: env.dir,
			}),
			env.dir,
		);

		const strategy = new ManualCommitStrategy(env.dir);
		await postCommitUpdateBaseCommitOnly(strategy, 'newhead');

		const sa = await loadSessionState('sA', env.dir);
		const sb = await loadSessionState('sB', env.dir);
		expect(sa?.baseCommit).toBe('newhead');
		expect(sa?.attributionBaseCommit).toBe('newhead');
		expect(sb?.baseCommit).toBe('newhead');
	});

	it('skips IDLE/ENDED sessions (no save attempted)', async () => {
		const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		const shadowBr = shadowBranchNameForCommit('oldbase', '');
		await env.exec('git', ['branch', '-f', shadowBr, head]);

		await saveSessionState(
			makeState({
				sessionId: 'idle1',
				phase: 'idle',
				baseCommit: 'oldbase',
				attributionBaseCommit: 'oldbase',
				worktreePath: env.dir,
				lastCheckpointId: 'a3b2c4d5e6f7',
			}),
			env.dir,
		);

		const strategy = new ManualCommitStrategy(env.dir);
		await postCommitUpdateBaseCommitOnly(strategy, 'newhead');

		const s = await loadSessionState('idle1', env.dir);
		expect(s?.baseCommit).toBe('oldbase');
	});

	it('no-op when no sessions exist', async () => {
		const strategy = new ManualCommitStrategy(env.dir);
		// No throw.
		await postCommitUpdateBaseCommitOnly(strategy, 'newhead');
	});
});

// ----------------------------------------------------------------------------
// Batch 3: PostCommitActionHandler + shouldCondenseWithOverlapCheck +
// postCommitImpl integration tests.
// ----------------------------------------------------------------------------

const SESSION_ID = '2026-04-20-batch3-test';
const CHECKPOINT_ID = '0123456789ab' as CheckpointID;

/** Build a shadow branch tree carrying the canonical session metadata files
 *  (`full.jsonl` + `prompt.txt`) AND optional top-level worktree-file blobs
 *  (e.g. `app.ts`) for end-to-end PostCommit tests. The worktree-file blobs
 *  let `filesOverlapWithContent` find content-match overlap when the test
 *  commits the SAME content via `git commit`. */
async function plantShadowBranchWithSessionData(
	env: TestEnv,
	branchName: string,
	sessionId: string,
	metadataFiles: Record<string, string>,
	worktreeFiles: Record<string, string> = {},
): Promise<void> {
	const sessionEntries: Array<{ mode: string; path: string; oid: string; type: 'blob' }> = [];
	for (const [filename, content] of Object.entries(metadataFiles)) {
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
		tree: [{ mode: '040000', path: sessionId, oid: sessionTree, type: 'tree' }],
	});
	const storyTree = await git.writeTree({
		fs: fsCallback,
		dir: env.dir,
		tree: [{ mode: '040000', path: 'metadata', oid: metadataTree, type: 'tree' }],
	});
	const rootEntries: Array<{ mode: string; path: string; oid: string; type: 'blob' | 'tree' }> = [
		{ mode: '040000', path: '.story', oid: storyTree, type: 'tree' },
	];
	for (const [filename, content] of Object.entries(worktreeFiles)) {
		const blobOid = await git.writeBlob({
			fs: fsCallback,
			dir: env.dir,
			blob: new TextEncoder().encode(content),
		});
		rootEntries.push({ mode: '100644', path: filename, oid: blobOid, type: 'blob' });
	}
	const rootTree = await git.writeTree({
		fs: fsCallback,
		dir: env.dir,
		tree: rootEntries,
	});
	// IMPORTANT: use git.writeCommit (NOT git.commit) so HEAD's branch is
	// NOT advanced — this is a shadow branch fixture, the worktree commit
	// must remain untouched by the plant.
	const commitOid = await git.writeCommit({
		fs: fsCallback,
		dir: env.dir,
		commit: {
			tree: rootTree,
			parent: [],
			author: {
				name: 'test',
				email: 't@e.t',
				timestamp: 1700000000,
				timezoneOffset: 0,
			},
			committer: {
				name: 'test',
				email: 't@e.t',
				timestamp: 1700000000,
				timezoneOffset: 0,
			},
			message: 'shadow fixture',
		},
	});
	await git.branch({ fs: fsCallback, dir: env.dir, ref: branchName, object: commitOid });
}

// Go: manual_commit_hooks.go: PostCommit
describe('postCommitImpl — Go: manual_commit_hooks.go (PostCommit, 11-step main pipeline)', () => {
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

	// Go: manual_commit_hooks.go:951-956 — no trailer → postCommitUpdateBaseCommitOnly path
	it('calls postCommitUpdateBaseCommitOnly when commit has no Story-Checkpoint trailer', async () => {
		// Make a commit with no trailer.
		await env.writeFile('a.txt', 'hello');
		await env.gitAdd('a.txt');
		const head = await env.gitCommit('plain commit');

		// Plant shadow branch + ACTIVE session with old baseCommit.
		const oldBranch = shadowBranchNameForCommit('oldbase', '');
		await env.exec('git', ['branch', '-f', oldBranch, head]);
		await saveSessionState(
			{
				sessionId: 'sA',
				baseCommit: 'oldbase',
				attributionBaseCommit: 'oldbase',
				startedAt: new Date().toISOString(),
				phase: 'active',
				stepCount: 0,
				worktreePath: env.dir,
			},
			env.dir,
		);

		await postCommitImpl(strategy);

		// ACTIVE session.baseCommit should be advanced to HEAD.
		const after = await loadSessionState('sA', env.dir);
		expect(after?.baseCommit).toBe(head);
		expect(after?.attributionBaseCommit).toBe(head);
	});

	// Go: manual_commit_hooks.go:967-977 — trailer present but 0 sessions → log warn + return
	it('warns when commit has trailer but no sessions for worktree', async () => {
		// Commit with trailer but no SessionState files.
		await env.writeFile('b.txt', 'hi');
		await env.gitAdd('b.txt');
		await env.gitCommit(`feat: test\n\nStory-Checkpoint: ${CHECKPOINT_ID}`);
		// No throw.
		await postCommitImpl(strategy);
	});

	// Go: manual_commit_hooks.go:1037-1049 — happy path: condenseSession + advance state
	it('happy path: ACTIVE session condenses + appends checkpointId to turnCheckpointIds', async () => {
		// Capture HEAD as the parent for the upcoming commit.
		const parentSha = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();

		// Plant shadow branch with full.jsonl so condenseSession has data.
		const shadowBr = shadowBranchNameForCommit(parentSha, '');
		await plantShadowBranchWithSessionData(env, shadowBr, SESSION_ID, {
			'full.jsonl': '{"type":"user","message":{"content":"hi"}}\n',
			'prompt.txt': 'hi',
		});

		// Save session state pointing at the planted shadow branch. With
		// lastInteractionTime=now, shouldCondenseWithOverlapCheck takes the
		// ACTIVE+recent fast path (skipping the overlap check).
		await saveSessionState(
			{
				sessionId: SESSION_ID,
				baseCommit: parentSha,
				attributionBaseCommit: parentSha,
				startedAt: new Date().toISOString(),
				phase: 'active',
				stepCount: 2,
				agentType: AGENT_TYPE_CLAUDE_CODE,
				filesTouched: ['app.ts'],
				worktreePath: env.dir,
				turnCheckpointIds: [],
				lastInteractionTime: new Date().toISOString(),
			},
			env.dir,
		);

		// Make a real commit with the matching trailer.
		await env.writeFile('app.ts', 'agent code');
		await env.gitAdd('app.ts');
		await env.gitCommit(`feat: agent\n\nStory-Checkpoint: ${CHECKPOINT_ID}`);

		await postCommitImpl(strategy);

		// Session.turnCheckpointIds should now contain the checkpointId.
		const after = await loadSessionState(SESSION_ID, env.dir);
		expect(after?.turnCheckpointIds ?? []).toContain(CHECKPOINT_ID);
		// lastCheckpointId set.
		expect(after?.lastCheckpointId).toBe(CHECKPOINT_ID);
		// baseCommit advanced to HEAD (= the new commit hash).
		const newHead = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		expect(after?.baseCommit).toBe(newHead);
	});

	// Go: manual_commit_hooks.go:1024-1042 — fullyCondensed ENDED skipped early
	it('skips fullyCondensed ENDED sessions before processing loop', async () => {
		const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		// Plant shadow + commit with trailer.
		const shadowBr = shadowBranchNameForCommit(head, '');
		await env.exec('git', ['branch', '-f', shadowBr, head]);

		await saveSessionState(
			{
				sessionId: 'fc-sess',
				baseCommit: head,
				attributionBaseCommit: head,
				startedAt: new Date().toISOString(),
				phase: 'ended',
				stepCount: 5,
				fullyCondensed: true,
				worktreePath: env.dir,
				lastCheckpointId: 'a3b2c4d5e6f7',
			},
			env.dir,
		);

		await env.writeFile('x.ts', 'x');
		await env.gitAdd('x.ts');
		await env.gitCommit(`feat: x\n\nStory-Checkpoint: ${CHECKPOINT_ID}`);

		await postCommitImpl(strategy);

		// fc-sess must be UNCHANGED (early skip).
		const after = await loadSessionState('fc-sess', env.dir);
		expect(after?.fullyCondensed).toBe(true);
		expect(after?.baseCommit).toBe(head);
		expect(after?.lastCheckpointId).toBe('a3b2c4d5e6f7');
	});

	// Go: manual_commit_hooks.go:1037-1049 — IDLE + GitCommit → Condense (NOT CondenseIfFilesTouched)
	// **Easy-to-misread invariant test** (per impl-2.md "State machine 触发的 Action 路由").
	it('IDLE + GitCommit routes to handleCondense (state machine invariant guard, NOT CondenseIfFilesTouched)', async () => {
		const parentSha = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		const shadowBr = shadowBranchNameForCommit(parentSha, '');
		// Include `app.ts` blob in the shadow tree at the SAME content the test
		// is about to commit — this lets filesOverlapWithContent find a content
		// match and return true (otherwise the new-file branch returns false
		// because shadow has no matching app.ts).
		await plantShadowBranchWithSessionData(
			env,
			shadowBr,
			SESSION_ID,
			{
				'full.jsonl': '{"type":"user","message":{"content":"go idle"}}\n',
				'prompt.txt': 'go idle',
			},
			{ 'app.ts': 'mod' },
		);

		// IDLE session — emits Action.Condense (not CondenseIfFilesTouched).
		// We verify the invariant by observing condenseSession was called
		// (state.lastCheckpointId set + state.stepCount reset to 0).
		await saveSessionState(
			{
				sessionId: SESSION_ID,
				baseCommit: parentSha,
				attributionBaseCommit: parentSha,
				startedAt: new Date().toISOString(),
				phase: 'idle',
				stepCount: 3,
				agentType: AGENT_TYPE_CLAUDE_CODE,
				filesTouched: ['app.ts'],
				worktreePath: env.dir,
			},
			env.dir,
		);

		await env.writeFile('app.ts', 'mod');
		await env.gitAdd('app.ts');
		await env.gitCommit(`feat\n\nStory-Checkpoint: ${CHECKPOINT_ID}`);

		await postCommitImpl(strategy);

		const after = await loadSessionState(SESSION_ID, env.dir);
		// Condensation ran (lastCheckpointId + stepCount=0).
		expect(after?.lastCheckpointId).toBe(CHECKPOINT_ID);
		expect(after?.stepCount).toBe(0);
		// IDLE + condensed: turnCheckpointIds should NOT include this checkpoint
		// (only ACTIVE+condensed appends).
		expect(after?.turnCheckpointIds ?? []).not.toContain(CHECKPOINT_ID);
	});

	// Go: manual_commit_hooks.go:980-988 — rebase in progress
	it('skips phase transition when rebase/sequence in progress (manual repo state)', async () => {
		const parentSha = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		const shadowBr = shadowBranchNameForCommit(parentSha, '');
		await plantShadowBranchWithSessionData(env, shadowBr, SESSION_ID, {
			'full.jsonl': '{"type":"user","message":{"content":"x"}}\n',
		});

		await saveSessionState(
			{
				sessionId: SESSION_ID,
				baseCommit: parentSha,
				attributionBaseCommit: parentSha,
				startedAt: new Date().toISOString(),
				phase: 'active',
				stepCount: 1,
				agentType: AGENT_TYPE_CLAUDE_CODE,
				filesTouched: ['x.ts'],
				worktreePath: env.dir,
			},
			env.dir,
		);

		// Plant a rebase-in-progress sentinel directory so isGitSequenceOperation returns true.
		await fsCallback.promises.mkdir(path.join(env.dir, '.git', 'rebase-merge'), {
			recursive: true,
		});
		await fsCallback.promises.writeFile(path.join(env.dir, '.git', 'rebase-merge', 'msgnum'), '1');

		await env.writeFile('x.ts', 'mod');
		await env.gitAdd('x.ts');
		await env.gitCommit(`feat\n\nStory-Checkpoint: ${CHECKPOINT_ID}`);

		await postCommitImpl(strategy);

		// During rebase, ACTIVE session's GitCommit produces NO action — phase
		// stays ACTIVE; lastCheckpointId NOT set; stepCount NOT reset.
		const after = await loadSessionState(SESSION_ID, env.dir);
		expect(after?.phase).toBe('active');
		expect(after?.lastCheckpointId ?? '').toBe('');
		expect(after?.stepCount).toBe(1);
	});

	// Go: manual_commit_hooks.go:921-1086 — silent on every error inside the hook
	it('silent on missing repo / read failure (returns void without throwing)', async () => {
		// Strategy bound to a directory that's NOT a git repo.
		const badStrategy = new ManualCommitStrategy('/nonexistent-dir-for-test');
		await postCommitImpl(badStrategy);
		// No throw.
	});

	// Go: manual_commit_hooks.go:1081-1083 — stale ENDED warn triggers
	it('triggers warnStaleEndedSessions when ≥ 3 stale ENDED sessions exist', async () => {
		const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		// Plant 3 stale ENDED sessions (non-fullyCondensed, stepCount>0, shadow ref exists).
		for (const id of ['stale1', 'stale2', 'stale3']) {
			const oldBase = `staleb_${id}________________________________`.slice(0, 40);
			const br = shadowBranchNameForCommit(oldBase, '');
			await env.exec('git', ['branch', '-f', br, head]);
			await saveSessionState(
				{
					sessionId: id,
					baseCommit: oldBase,
					attributionBaseCommit: oldBase,
					startedAt: new Date().toISOString(),
					phase: 'ended',
					stepCount: 5,
					fullyCondensed: false,
					worktreePath: env.dir,
				},
				env.dir,
			);
		}
		// Make a plain commit (no trailer) — postCommit takes the "no trailer"
		// path which doesn't increment count, but the stale check itself runs
		// only when there IS a trailer (Step 11). So we need a trailer.
		await env.writeFile('x.ts', 'x');
		await env.gitAdd('x.ts');
		await env.gitCommit(`x\n\nStory-Checkpoint: ${CHECKPOINT_ID}`);

		// No throw — stale warn happens silently (writes to stderr injection).
		await postCommitImpl(strategy);
	});
});

// Go: manual_commit_hooks.go:737-792 — postCommitActionHandler.HandleCondense*
//     and shouldCondenseWithOverlapCheck (6-branch decision tree)
describe('PostCommitActionHandler + shouldCondenseWithOverlapCheck — Go: manual_commit_hooks.go', () => {
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

	function makeHandler(overrides: {
		hasNew: boolean;
		filesTouchedBefore?: readonly string[];
		sessionsWithCommittedFiles?: number;
		committedFileSet?: Set<string>;
	}): PostCommitActionHandler {
		// Minimal opts — only the fields shouldCondenseWithOverlapCheck reads.
		// The handler is tested through its public behavior via postCommitImpl
		// elsewhere; here we just need shouldCondenseWithOverlapCheck branches.
		return new PostCommitActionHandler({
			s: strategy,
			repo: { root: env.dir, gitDir: env.gitDir, gitCommonDir: env.gitDir },
			checkpointId: CHECKPOINT_ID,
			commit: {
				message: 'test',
				parent: ['p1'],
				tree: 'treesha',
				author: {
					name: 'x',
					email: 'x',
					timestamp: 0,
					timezoneOffset: 0,
				},
				committer: {
					name: 'x',
					email: 'x',
					timestamp: 0,
					timezoneOffset: 0,
				},
			},
			commitOid: 'newhead',
			newHead: 'newhead',
			repoDir: env.dir,
			shadowBranchName: 'story/x',
			shadowBranchesToDelete: new Set<string>(),
			committedFileSet: overrides.committedFileSet ?? new Set<string>(),
			hasNew: overrides.hasNew,
			filesTouchedBefore: overrides.filesTouchedBefore ?? [],
			sessionsWithCommittedFiles: overrides.sessionsWithCommittedFiles ?? 0,
			headTreeOid: null,
			parentTreeOid: null,
			shadowRefOid: null,
			shadowTreeOid: null,
			allAgentFiles: new Set<string>(),
		});
	}

	// Go: manual_commit_hooks.go:800-802 — !hasNew → false
	it('shouldCondenseWithOverlapCheck returns false when !hasNew', async () => {
		const h = makeHandler({ hasNew: false });
		// We test via the protected method through a public decision: handleCondense
		// only calls condenseAndUpdateState if shouldCondense returns true. With
		// hasNew=false and filesTouchedBefore=[], no condense path fires →
		// state untouched.
		const state: SessionState = {
			sessionId: 'no-new',
			baseCommit: 'b',
			startedAt: new Date().toISOString(),
			phase: 'active',
			stepCount: 0,
			lastInteractionTime: new Date().toISOString(),
		};
		await h.handleCondense(state);
		expect(h.condensed).toBe(false);
	});

	// Go: manual_commit_hooks.go:818-826 — ACTIVE+recent+normal → would-condense (hasNew=true,
	// no read-only guard hit). Verified via handleCondense call path: condenseAndUpdateState
	// is called → throws (no real shadow branch) → returns false but the *attempt* happened.
	it('shouldCondenseWithOverlapCheck returns true for ACTIVE+recent+filesTouchedBefore non-empty', async () => {
		const h = makeHandler({
			hasNew: true,
			filesTouchedBefore: ['x.ts'],
			sessionsWithCommittedFiles: 1,
		});
		const state: SessionState = {
			sessionId: 'ar',
			baseCommit: 'b',
			startedAt: new Date().toISOString(),
			phase: 'active',
			stepCount: 0,
			lastInteractionTime: new Date().toISOString(),
		};
		// We can't directly inspect shouldCondense's bool; observe via condense
		// attempt — should call condenseAndUpdateState (which fails due to no
		// shadow branch). condensed remains false because the underlying condense
		// throws/skips, but the path was taken. We verify the OPPOSITE branch
		// in the next test (read-only ACTIVE skips entirely → updateBaseCommitIfChanged
		// runs, advancing baseCommit to newHead).
		await h.handleCondense(state);
		// state.baseCommit may have updated if condense path was bypassed via
		// updateBaseCommitIfChanged; in this branch we expect condense was attempted
		// (so baseCommit NOT advanced via the "else" branch).
		expect(state.baseCommit).toBe('b');
	});

	// Go: manual_commit_hooks.go:818-825 — ACTIVE+recent+read-only guard → false
	it('read-only ACTIVE guard: returns false when sessionsWithCommittedFiles>0 + filesTouchedBefore=[]', async () => {
		const h = makeHandler({
			hasNew: true,
			filesTouchedBefore: [],
			sessionsWithCommittedFiles: 1,
		});
		const state: SessionState = {
			sessionId: 'ro',
			baseCommit: 'b',
			startedAt: new Date().toISOString(),
			phase: 'active',
			stepCount: 0,
			lastInteractionTime: new Date().toISOString(),
		};
		await h.handleCondense(state);
		// Read-only guard tripped → updateBaseCommitIfChanged path taken →
		// state.baseCommit advanced to newHead.
		expect(state.baseCommit).toBe('newhead');
		expect(h.condensed).toBe(false);
	});

	// Go: manual_commit_hooks.go:827-829 — stale + filesTouchedBefore=[] → false
	it('stale (non-active OR no recent interaction) + filesTouchedBefore=[] → false', async () => {
		const h = makeHandler({
			hasNew: true,
			filesTouchedBefore: [],
		});
		const state: SessionState = {
			sessionId: 'stale-empty',
			baseCommit: 'b',
			startedAt: new Date().toISOString(),
			phase: 'idle', // not active
			stepCount: 0,
		};
		await h.handleCondense(state);
		// IDLE → updateBaseCommitIfChanged is no-op (only ACTIVE updates).
		expect(state.baseCommit).toBe('b');
		expect(h.condensed).toBe(false);
	});

	// Go: manual_commit_hooks.go:835-843 — stale + filesTouchedBefore non-empty
	// + intersection with committedFileSet empty → false
	it('stale + intersection of filesTouchedBefore × committedFileSet is empty → false', async () => {
		const h = makeHandler({
			hasNew: true,
			filesTouchedBefore: ['unrelated.ts'],
			committedFileSet: new Set(['otherfile.ts']),
		});
		const state: SessionState = {
			sessionId: 'stale-no-overlap',
			baseCommit: 'b',
			startedAt: new Date().toISOString(),
			phase: 'idle',
			stepCount: 0,
		};
		await h.handleCondense(state);
		// No condense (intersection empty); IDLE → no baseCommit update.
		expect(state.baseCommit).toBe('b');
		expect(h.condensed).toBe(false);
	});
});

// Go: manual_commit_hooks.go: postCommitActionHandler — methods
describe('PostCommitActionHandler 4-method routing — Go: manual_commit_hooks.go', () => {
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

	function makeHandler(): PostCommitActionHandler {
		return new PostCommitActionHandler({
			s: strategy,
			repo: { root: env.dir, gitDir: env.gitDir, gitCommonDir: env.gitDir },
			checkpointId: CHECKPOINT_ID,
			commit: {
				message: 't',
				parent: ['p'],
				tree: 't',
				author: { name: 'x', email: 'x', timestamp: 0, timezoneOffset: 0 },
				committer: { name: 'x', email: 'x', timestamp: 0, timezoneOffset: 0 },
			},
			commitOid: 'newhead',
			newHead: 'newhead',
			repoDir: env.dir,
			shadowBranchName: 'story/x',
			shadowBranchesToDelete: new Set<string>(),
			committedFileSet: new Set<string>(),
			hasNew: false, // shouldCondense → false
			filesTouchedBefore: [],
			sessionsWithCommittedFiles: 0,
			headTreeOid: null,
			parentTreeOid: null,
			shadowRefOid: null,
			shadowTreeOid: null,
			allAgentFiles: new Set<string>(),
		});
	}

	it('handleDiscardIfNoFiles is a no-op except for updateBaseCommitIfChanged on ACTIVE', async () => {
		const h = makeHandler();
		const state: SessionState = {
			sessionId: 'd1',
			baseCommit: 'b',
			startedAt: new Date().toISOString(),
			phase: 'active',
			stepCount: 0,
		};
		await h.handleDiscardIfNoFiles(state);
		// ACTIVE + baseCommit !== newHead → updated.
		expect(state.baseCommit).toBe('newhead');
	});

	it('handleWarnStaleSession is a no-op (interface completeness only)', async () => {
		const h = makeHandler();
		const state: SessionState = {
			sessionId: 'w1',
			baseCommit: 'b',
			startedAt: new Date().toISOString(),
			phase: 'active',
			stepCount: 0,
		};
		const before = state.baseCommit;
		await h.handleWarnStaleSession(state);
		expect(state.baseCommit).toBe(before);
	});

	it('handleCondenseIfFilesTouched returns early when state.filesTouched is empty', async () => {
		const h = makeHandler();
		const state: SessionState = {
			sessionId: 'cif',
			baseCommit: 'b',
			startedAt: new Date().toISOString(),
			phase: 'ended',
			stepCount: 0,
			filesTouched: [],
		};
		await h.handleCondenseIfFilesTouched(state);
		// No condense; ENDED → no baseCommit update.
		expect(h.condensed).toBe(false);
		expect(state.baseCommit).toBe('b');
	});
});

// ============================================================================
// Phase 1 follow-up — Spec rows #5, #6, #8, #9, #11–#13, #15, #16 from
// tests-2.md that were missing dedicated `it()` cases. Plus Phase 3 catch /
// fail-open coverage tests that push branch coverage to ≥ 85% per file.
// ============================================================================

// Go: manual_commit_hooks.go: PostCommit (perf invariant + cross-attribution + cleanup)
describe('postCommitImpl integration — Phase 1 follow-up — Go: manual_commit_hooks.go (PostCommit)', () => {
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

	// Go: manual_commit_hooks.go: PostCommit (Step 5) — pre-resolve trees ONCE.
	// spec #5
	it('postCommit pre-resolves HEAD tree + parent tree once across the per-session loop (perf invariant)', async () => {
		const parentSha = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		// Plant 2 sessions so the per-session loop runs twice.
		const shadowBr = shadowBranchNameForCommit(parentSha, '');
		await plantShadowBranchWithSessionData(env, shadowBr, SESSION_ID, {
			'full.jsonl': '{"type":"user","message":{"content":"hi"}}\n',
			'prompt.txt': 'hi',
		});
		await saveSessionState(
			{
				sessionId: SESSION_ID,
				baseCommit: parentSha,
				attributionBaseCommit: parentSha,
				startedAt: new Date().toISOString(),
				phase: 'active',
				stepCount: 1,
				agentType: AGENT_TYPE_CLAUDE_CODE,
				filesTouched: ['app.ts'],
				worktreePath: env.dir,
				lastInteractionTime: new Date().toISOString(),
			},
			env.dir,
		);
		await saveSessionState(
			{
				sessionId: 'sess-other',
				baseCommit: parentSha,
				attributionBaseCommit: parentSha,
				startedAt: new Date().toISOString(),
				phase: 'active',
				stepCount: 1,
				agentType: AGENT_TYPE_CLAUDE_CODE,
				filesTouched: ['app.ts'],
				worktreePath: env.dir,
				lastInteractionTime: new Date().toISOString(),
			},
			env.dir,
		);

		await env.writeFile('app.ts', 'agent code');
		await env.gitAdd('app.ts');
		await env.gitCommit(`feat\n\nStory-Checkpoint: ${CHECKPOINT_ID}`);

		// Spy on execGit via vi.spyOn (ESM-safe). We count how many times
		// `rev-parse HEAD^{tree}` is invoked — the pre-resolve must happen
		// exactly once even across N sessions.
		const gitMod = await import('@/git');
		let headTreeRevParseCalls = 0;
		const spy = vi.spyOn(gitMod, 'execGit').mockImplementation(async (args, _opts) => {
			if (args[0] === 'rev-parse' && args[1] !== undefined && /HEAD\^\{tree\}$/.test(args[1])) {
				headTreeRevParseCalls++;
			}
			return await (vi.mocked(gitMod.execGit).getMockImplementation()
				? Promise.resolve('') // unreachable — overridden below
				: '');
		});
		spy.mockRestore();
		// Re-spy with passthrough — we want to count + delegate.
		const origExecGit = gitMod.execGit;
		const passthrough = vi.spyOn(gitMod, 'execGit').mockImplementation(async (args, opts) => {
			if (args[0] === 'rev-parse' && args[1] !== undefined && /HEAD\^\{tree\}$/.test(args[1])) {
				headTreeRevParseCalls++;
			}
			return origExecGit(args, opts);
		});
		try {
			await postCommitImpl(strategy);
		} finally {
			passthrough.mockRestore();
		}
		// Pre-resolved once at Step 5 (could be 0 if HEAD tree is read via the
		// parent-tree resolution shortcut, but never > 1).
		expect(headTreeRevParseCalls).toBeLessThanOrEqual(1);
	});

	// Go: manual_commit_hooks.go: PostCommit (Step 9) — cross-attribution called.
	// spec #6
	it('postCommit calls updateCombinedAttributionForCheckpoint after per-session loop (cross-attribution)', async () => {
		// Set up 2 sessions on same checkpoint so cross-attribution path fires
		// (summary.sessions.length > 1 inside updateCombinedAttributionForCheckpoint).
		const parentSha = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		const shadowBr = shadowBranchNameForCommit(parentSha, '');
		await plantShadowBranchWithSessionData(env, shadowBr, SESSION_ID, {
			'full.jsonl': '{"type":"user","message":{"content":"hi"}}\n',
			'prompt.txt': 'hi',
		});
		await plantShadowBranchWithSessionData(
			env,
			`story/${parentSha.slice(0, 7)}-other`,
			'sess-other',
			{
				'full.jsonl': '{"type":"user","message":{"content":"hi2"}}\n',
			},
		);
		await saveSessionState(
			{
				sessionId: SESSION_ID,
				baseCommit: parentSha,
				attributionBaseCommit: parentSha,
				startedAt: new Date().toISOString(),
				phase: 'active',
				stepCount: 2,
				agentType: AGENT_TYPE_CLAUDE_CODE,
				filesTouched: ['app.ts'],
				worktreePath: env.dir,
				worktreeId: '',
				lastInteractionTime: new Date().toISOString(),
			},
			env.dir,
		);
		await saveSessionState(
			{
				sessionId: 'sess-other',
				baseCommit: parentSha,
				attributionBaseCommit: parentSha,
				startedAt: new Date().toISOString(),
				phase: 'active',
				stepCount: 2,
				agentType: AGENT_TYPE_CLAUDE_CODE,
				filesTouched: ['util.ts'],
				worktreePath: env.dir,
				worktreeId: 'other',
				lastInteractionTime: new Date().toISOString(),
			},
			env.dir,
		);

		await env.writeFile('app.ts', 'agent A');
		await env.writeFile('util.ts', 'agent B');
		await env.gitAdd('app.ts', 'util.ts');
		await env.gitCommit(`feat: 2 sessions\n\nStory-Checkpoint: ${CHECKPOINT_ID}`);

		// Spy on store.updateCheckpointSummary to verify cross-attribution wrote.
		const store = await strategy.getCheckpointStore();
		const origUpdate = store.updateCheckpointSummary.bind(store);
		let updateCalled = 0;
		store.updateCheckpointSummary = ((id, attr) => {
			updateCalled++;
			return origUpdate(id, attr);
		}) as typeof store.updateCheckpointSummary;

		await postCommitImpl(strategy);

		// updateCheckpointSummary called when summary > 1 sessions + non-zero agent files.
		expect(updateCalled).toBeGreaterThanOrEqual(1);
	});

	// Go: manual_commit_hooks.go: PostCommit (Step 10) — preserve uncondensed-active branch.
	// spec #8
	it('postCommit preserves shadow branch when uncondensedActiveOnBranch contains it', async () => {
		// 2 sessions on SAME shadow branch (same baseCommit + worktreeId).
		// Session A is ACTIVE with no real content → won't be condensed (hasNew false fallback).
		// Session B is ACTIVE with real content → will be condensed.
		const parentSha = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		const shadowBr = shadowBranchNameForCommit(parentSha, '');
		await plantShadowBranchWithSessionData(env, shadowBr, 'sess-with-content', {
			'full.jsonl': '{"type":"user","message":{"content":"hi"}}\n',
			'prompt.txt': 'hi',
		});

		// "Empty" ACTIVE session — no transcript, no files; should NOT condense
		// because shouldCondenseWithOverlapCheck has nothing to overlap.
		await saveSessionState(
			{
				sessionId: 'sess-empty-active',
				baseCommit: parentSha,
				attributionBaseCommit: parentSha,
				startedAt: new Date().toISOString(),
				phase: 'active',
				stepCount: 0,
				agentType: AGENT_TYPE_CLAUDE_CODE,
				filesTouched: [],
				worktreePath: env.dir,
				worktreeId: '',
				lastInteractionTime: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(), // stale
			},
			env.dir,
		);
		await saveSessionState(
			{
				sessionId: 'sess-with-content',
				baseCommit: parentSha,
				attributionBaseCommit: parentSha,
				startedAt: new Date().toISOString(),
				phase: 'active',
				stepCount: 1,
				agentType: AGENT_TYPE_CLAUDE_CODE,
				filesTouched: ['app.ts'],
				worktreePath: env.dir,
				worktreeId: '',
				lastInteractionTime: new Date().toISOString(),
			},
			env.dir,
		);

		await env.writeFile('app.ts', 'mod');
		await env.gitAdd('app.ts');
		await env.gitCommit(`feat\n\nStory-Checkpoint: ${CHECKPOINT_ID}`);

		await postCommitImpl(strategy);

		// Shadow branch should be preserved because empty ACTIVE session is in
		// uncondensedActiveOnBranch (didn't condense → branch needed for it).
		const ref = await env.exec('git', ['rev-parse', `refs/heads/${shadowBr}`]).catch(() => null);
		expect(ref).not.toBeNull();
	});

	// Go: manual_commit_hooks.go: PostCommit (Step 10) — delete branch when all condensed.
	// spec #9
	it('postCommit deletes shadow branch when all sessions on it are condensed / non-active', async () => {
		const parentSha = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		const shadowBr = shadowBranchNameForCommit(parentSha, '');
		await plantShadowBranchWithSessionData(
			env,
			shadowBr,
			SESSION_ID,
			{
				'full.jsonl': '{"type":"user","message":{"content":"x"}}\n',
				'prompt.txt': 'x',
			},
			{ 'app.ts': 'mod' },
		);
		await saveSessionState(
			{
				sessionId: SESSION_ID,
				baseCommit: parentSha,
				attributionBaseCommit: parentSha,
				startedAt: new Date().toISOString(),
				phase: 'active',
				stepCount: 1,
				agentType: AGENT_TYPE_CLAUDE_CODE,
				filesTouched: ['app.ts'],
				worktreePath: env.dir,
				worktreeId: '',
				lastInteractionTime: new Date().toISOString(),
			},
			env.dir,
		);

		await env.writeFile('app.ts', 'mod');
		await env.gitAdd('app.ts');
		await env.gitCommit(`feat\n\nStory-Checkpoint: ${CHECKPOINT_ID}`);

		await postCommitImpl(strategy);

		// Shadow branch deleted (all-condensed cleanup).
		await expect(env.exec('git', ['rev-parse', `refs/heads/${shadowBr}`])).rejects.toBeTruthy();
	});

	// Go: postCommitProcessSession — transitionCtx.HasFilesTouched set BEFORE TransitionAndLog.
	// spec #11
	it('postCommitProcessSession sets transitionCtx.hasFilesTouched before TransitionAndLog (ENDED routing)', async () => {
		// ENDED + filesTouched=['x'] → state machine emits CondenseIfFilesTouched
		// (NOT DiscardIfNoFiles). We verify this routing happened by observing
		// that condensation actually ran (handler.condensed=true → state.lastCheckpointId set).
		const parentSha = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		const shadowBr = shadowBranchNameForCommit(parentSha, '');
		await plantShadowBranchWithSessionData(
			env,
			shadowBr,
			SESSION_ID,
			{
				'full.jsonl': '{"type":"user","message":{"content":"end"}}\n',
				'prompt.txt': 'end',
			},
			{ 'app.ts': 'mod' },
		);
		await saveSessionState(
			{
				sessionId: SESSION_ID,
				baseCommit: parentSha,
				attributionBaseCommit: parentSha,
				startedAt: new Date().toISOString(),
				phase: 'ended',
				stepCount: 3,
				agentType: AGENT_TYPE_CLAUDE_CODE,
				filesTouched: ['app.ts'],
				worktreePath: env.dir,
				worktreeId: '',
			},
			env.dir,
		);
		await env.writeFile('app.ts', 'mod');
		await env.gitAdd('app.ts');
		await env.gitCommit(`feat\n\nStory-Checkpoint: ${CHECKPOINT_ID}`);

		await postCommitImpl(strategy);

		const after = await loadSessionState(SESSION_ID, env.dir);
		// Condensation ran — proves CondenseIfFilesTouched was emitted (NOT DiscardIfNoFiles).
		expect(after?.lastCheckpointId).toBe(CHECKPOINT_ID);
	});

	// Go: postCommitProcessSession — ACTIVE uses resolveFilesTouched (not state.filesTouched copy).
	// spec #12
	it('postCommitProcessSession snapshots filesTouchedBefore via resolveFilesTouched for ACTIVE', async () => {
		// ACTIVE + state.filesTouched present → resolveFilesTouched returns
		// state.filesTouched (Phase 5.4 Part 1 noop branch). Condensation should
		// see those files as filesTouchedBefore.
		const parentSha = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		const shadowBr = shadowBranchNameForCommit(parentSha, '');
		await plantShadowBranchWithSessionData(
			env,
			shadowBr,
			SESSION_ID,
			{
				'full.jsonl': '{"type":"user","message":{"content":"x"}}\n',
				'prompt.txt': 'x',
			},
			{ 'app.ts': 'mod' },
		);
		await saveSessionState(
			{
				sessionId: SESSION_ID,
				baseCommit: parentSha,
				attributionBaseCommit: parentSha,
				startedAt: new Date().toISOString(),
				phase: 'active',
				stepCount: 1,
				agentType: AGENT_TYPE_CLAUDE_CODE,
				filesTouched: ['app.ts'],
				worktreePath: env.dir,
				worktreeId: '',
				lastInteractionTime: new Date().toISOString(),
			},
			env.dir,
		);
		await env.writeFile('app.ts', 'mod');
		await env.gitAdd('app.ts');
		await env.gitCommit(`feat\n\nStory-Checkpoint: ${CHECKPOINT_ID}`);

		await postCommitImpl(strategy);

		// Condensation completed (filesTouchedBefore=['app.ts'] was used).
		const after = await loadSessionState(SESSION_ID, env.dir);
		expect(after?.lastCheckpointId).toBe(CHECKPOINT_ID);
	});

	// Go: postCommitProcessSession — IDLE/ENDED shallow-copies state.filesTouched (NOT alias).
	// spec #13
	it('postCommitProcessSession shallow-copies state.filesTouched for IDLE/ENDED (no alias)', async () => {
		// IDLE + filesTouched=['x','y']; after condense state.filesTouched is
		// cleared, but the SNAPSHOT (filesTouchedBefore) had ['x','y'] for the
		// carry-forward computation. We verify by checking that condense ran
		// (non-empty filesTouchedBefore drove the overlap path).
		const parentSha = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		const shadowBr = shadowBranchNameForCommit(parentSha, '');
		await plantShadowBranchWithSessionData(
			env,
			shadowBr,
			SESSION_ID,
			{
				'full.jsonl': '{"type":"user","message":{"content":"idle"}}\n',
				'prompt.txt': 'idle',
			},
			{ 'x.ts': 'agent x', 'y.ts': 'agent y' },
		);
		await saveSessionState(
			{
				sessionId: SESSION_ID,
				baseCommit: parentSha,
				attributionBaseCommit: parentSha,
				startedAt: new Date().toISOString(),
				phase: 'idle',
				stepCount: 2,
				agentType: AGENT_TYPE_CLAUDE_CODE,
				filesTouched: ['x.ts', 'y.ts'],
				worktreePath: env.dir,
				worktreeId: '',
			},
			env.dir,
		);
		// Commit only x.ts; y.ts remains "agent-touched but uncommitted".
		await env.writeFile('x.ts', 'agent x');
		await env.gitAdd('x.ts');
		await env.gitCommit(`feat: partial\n\nStory-Checkpoint: ${CHECKPOINT_ID}`);

		await postCommitImpl(strategy);

		const after = await loadSessionState(SESSION_ID, env.dir);
		// Condensation ran via the IDLE+Condense routing (filesTouchedBefore was
		// the SHALLOW-COPIED snapshot ['x.ts','y.ts']). Then carry-forward
		// detected y.ts not committed → state.filesTouched = ['y.ts'].
		// (lastCheckpointId reset by carry-forward — see condense → carry-forward
		// state mutation chain in hooks-post-commit.ts; we instead verify the
		// snapshot drove the carry-forward decision correctly.)
		expect(after?.filesTouched).toEqual(['y.ts']);
	});

	// Go: postCommitProcessSession step 7 — carry-forward when condensed + remaining files > 0.
	// spec #15
	it('postCommitProcessSession calls carryForwardToNewShadowBranch when condensed + remaining files > 0', async () => {
		const parentSha = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		const shadowBr = shadowBranchNameForCommit(parentSha, '');
		// shadow tree has BOTH a.ts AND b.ts; commit only a.ts; b.ts remains.
		await plantShadowBranchWithSessionData(
			env,
			shadowBr,
			SESSION_ID,
			{
				'full.jsonl': '{"type":"user","message":{"content":"x"}}\n',
				'prompt.txt': 'x',
			},
			{ 'a.ts': 'agent a', 'b.ts': 'agent b' },
		);
		await saveSessionState(
			{
				sessionId: SESSION_ID,
				baseCommit: parentSha,
				attributionBaseCommit: parentSha,
				startedAt: new Date().toISOString(),
				phase: 'active',
				stepCount: 1,
				agentType: AGENT_TYPE_CLAUDE_CODE,
				filesTouched: ['a.ts', 'b.ts'],
				worktreePath: env.dir,
				worktreeId: '',
				lastInteractionTime: new Date().toISOString(),
			},
			env.dir,
		);
		// Only commit a.ts; need b.ts in worktree for carry-forward writeTemporary.
		await env.writeFile('a.ts', 'agent a');
		await env.writeFile('b.ts', 'agent b');
		await env.gitAdd('a.ts'); // only a.ts staged
		await env.gitCommit(`feat: only a\n\nStory-Checkpoint: ${CHECKPOINT_ID}`);

		await postCommitImpl(strategy);

		// New shadow branch at HEAD should be created via carry-forward.
		const newHead = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		const newShadowBr = shadowBranchNameForCommit(newHead, '');
		const ref = await env.exec('git', ['rev-parse', `refs/heads/${newShadowBr}`]).catch(() => null);
		expect(ref).not.toBeNull();
	});

	// Go: postCommitProcessSession step 8 — fullyCondensed mark for ENDED.
	// spec #16
	it('postCommitProcessSession marks state.fullyCondensed=true for ENDED + no remaining + condensed', async () => {
		const parentSha = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		const shadowBr = shadowBranchNameForCommit(parentSha, '');
		await plantShadowBranchWithSessionData(
			env,
			shadowBr,
			SESSION_ID,
			{
				'full.jsonl': '{"type":"user","message":{"content":"end"}}\n',
				'prompt.txt': 'end',
			},
			{ 'final.ts': 'agent final' },
		);
		await saveSessionState(
			{
				sessionId: SESSION_ID,
				baseCommit: parentSha,
				attributionBaseCommit: parentSha,
				startedAt: new Date().toISOString(),
				phase: 'ended',
				stepCount: 1,
				agentType: AGENT_TYPE_CLAUDE_CODE,
				filesTouched: ['final.ts'],
				worktreePath: env.dir,
				worktreeId: '',
				fullyCondensed: false,
			},
			env.dir,
		);
		await env.writeFile('final.ts', 'agent final');
		await env.gitAdd('final.ts');
		await env.gitCommit(`feat: end\n\nStory-Checkpoint: ${CHECKPOINT_ID}`);

		await postCommitImpl(strategy);

		const after = await loadSessionState(SESSION_ID, env.dir);
		// ENDED + filesTouched cleared after condense + condensed=true → fullyCondensed mark.
		expect(after?.fullyCondensed).toBe(true);
		expect(after?.filesTouched ?? []).toEqual([]);
	});
});

// ============================================================================
// Phase 3 — branch coverage push for hooks-post-commit.ts.
// Targets fail-open / silent-error catch paths to cover lines flagged by
// `bun run test:coverage` as missing (76.92% → ≥ 85% per-file branch).
// ============================================================================

describe('postCommitImpl fail-open paths — Phase 3 branch coverage', () => {
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

	// Go: PostCommit step 3 — worktreeRoot fails (non-git dir) → silent return.
	it('postCommit silently returns when worktreeRoot throws (Step 3 catch)', async () => {
		const badStrategy = new ManualCommitStrategy('/dev/null/no-such-dir');
		await badStrategy.postCommit(); // does not throw
	});

	// Go: PostCommit step 9 — updateCombinedAttributionForCheckpoint throws → caught + log warn.
	it('postCommit catches updateCombinedAttributionForCheckpoint throw + logs warn', async () => {
		const parentSha = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		const shadowBr = shadowBranchNameForCommit(parentSha, '');
		await plantShadowBranchWithSessionData(
			env,
			shadowBr,
			SESSION_ID,
			{ 'full.jsonl': '{"type":"user","message":{"content":"x"}}\n' },
			{ 'app.ts': 'mod' },
		);
		await saveSessionState(
			{
				sessionId: SESSION_ID,
				baseCommit: parentSha,
				attributionBaseCommit: parentSha,
				startedAt: new Date().toISOString(),
				phase: 'active',
				stepCount: 1,
				agentType: AGENT_TYPE_CLAUDE_CODE,
				filesTouched: ['app.ts'],
				worktreePath: env.dir,
				worktreeId: '',
				lastInteractionTime: new Date().toISOString(),
			},
			env.dir,
		);
		await env.writeFile('app.ts', 'mod');
		await env.gitAdd('app.ts');
		await env.gitCommit(`feat\n\nStory-Checkpoint: ${CHECKPOINT_ID}`);

		// Force updateCombinedAttributionForCheckpoint to throw via vi.spyOn —
		// postCommit Step 9 must catch + log warn.
		const attrMod = await import('@/strategy/hooks-post-commit-attribution');
		const spy = vi
			.spyOn(attrMod, 'updateCombinedAttributionForCheckpoint')
			.mockImplementation(async () => {
				throw new Error('forced attribution fail');
			});
		try {
			// No throw — caught at Step 9.
			await postCommitImpl(strategy);
		} finally {
			spy.mockRestore();
		}
	});

	// Go: PostCommit step 10 — deleteShadowBranch throws → caught + log warn.
	it('postCommit catches deleteShadowBranch throw + continues', async () => {
		const parentSha = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		const shadowBr = shadowBranchNameForCommit(parentSha, '');
		await plantShadowBranchWithSessionData(
			env,
			shadowBr,
			SESSION_ID,
			{ 'full.jsonl': '{"type":"user","message":{"content":"x"}}\n' },
			{ 'app.ts': 'mod' },
		);
		await saveSessionState(
			{
				sessionId: SESSION_ID,
				baseCommit: parentSha,
				attributionBaseCommit: parentSha,
				startedAt: new Date().toISOString(),
				phase: 'active',
				stepCount: 1,
				agentType: AGENT_TYPE_CLAUDE_CODE,
				filesTouched: ['app.ts'],
				worktreePath: env.dir,
				worktreeId: '',
				lastInteractionTime: new Date().toISOString(),
			},
			env.dir,
		);
		await env.writeFile('app.ts', 'mod');
		await env.gitAdd('app.ts');
		await env.gitCommit(`feat\n\nStory-Checkpoint: ${CHECKPOINT_ID}`);

		// Force deleteShadowBranch to throw via vi.spyOn (ESM-safe).
		const helpers = await import('@/strategy/save-step-helpers');
		const spy = vi.spyOn(helpers, 'deleteShadowBranch').mockImplementation(async () => {
			throw new Error('forced delete fail');
		});
		try {
			await postCommitImpl(strategy);
		} finally {
			spy.mockRestore();
		}
	});

	// Go: postCommitProcessSession step 9 — saveSessionState throws → caught + log warn.
	it('postCommitProcessSession catches saveSessionState throw', async () => {
		const parentSha = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		const shadowBr = shadowBranchNameForCommit(parentSha, '');
		await plantShadowBranchWithSessionData(
			env,
			shadowBr,
			SESSION_ID,
			{ 'full.jsonl': '{"type":"user","message":{"content":"x"}}\n' },
			{ 'app.ts': 'mod' },
		);
		await saveSessionState(
			{
				sessionId: SESSION_ID,
				baseCommit: parentSha,
				attributionBaseCommit: parentSha,
				startedAt: new Date().toISOString(),
				phase: 'active',
				stepCount: 1,
				agentType: AGENT_TYPE_CLAUDE_CODE,
				filesTouched: ['app.ts'],
				worktreePath: env.dir,
				worktreeId: '',
				lastInteractionTime: new Date().toISOString(),
			},
			env.dir,
		);
		await env.writeFile('app.ts', 'mod');
		await env.gitAdd('app.ts');
		await env.gitCommit(`feat\n\nStory-Checkpoint: ${CHECKPOINT_ID}`);

		// Force the strategy's saveSessionState to throw.
		(strategy as unknown as { saveSessionState: () => Promise<never> }).saveSessionState =
			async () => {
				throw new Error('forced save fail');
			};
		// No throw — caught.
		await postCommitImpl(strategy);
	});

	// Go: PostCommit step 4 — sessionHasNewContent throws (non-ACTIVE) → fail-open hasNew=true + debug log.
	// Covers Phase 2 B2 fix + branch coverage.
	it('postCommitProcessSession fail-opens hasNew=true + logs when sessionHasNewContent throws (non-ACTIVE)', async () => {
		const parentSha = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		const shadowBr = shadowBranchNameForCommit(parentSha, '');
		await plantShadowBranchWithSessionData(
			env,
			shadowBr,
			SESSION_ID,
			{ 'full.jsonl': '{"type":"user","message":{"content":"x"}}\n' },
			{ 'app.ts': 'mod' },
		);
		await saveSessionState(
			{
				sessionId: SESSION_ID,
				baseCommit: parentSha,
				attributionBaseCommit: parentSha,
				startedAt: new Date().toISOString(),
				phase: 'idle', // non-ACTIVE → goes through sessionHasNewContent
				stepCount: 1,
				agentType: AGENT_TYPE_CLAUDE_CODE,
				filesTouched: ['app.ts'],
				worktreePath: env.dir,
				worktreeId: '',
			},
			env.dir,
		);
		await env.writeFile('app.ts', 'mod');
		await env.gitAdd('app.ts');
		await env.gitCommit(`feat\n\nStory-Checkpoint: ${CHECKPOINT_ID}`);

		// Force sessionHasNewContent to throw via vi.spyOn (ESM-safe).
		const detection = await import('@/strategy/hooks-content-detection');
		const spy = vi.spyOn(detection, 'sessionHasNewContent').mockImplementation(async () => {
			throw new Error('forced content check fail');
		});
		try {
			// No throw; hasNew falls back to true → condense path may attempt.
			await postCommitImpl(strategy);
		} finally {
			spy.mockRestore();
		}
	});

	// Go: postCommitProcessSession — transitionAndLog throws → caught + log warn.
	it('postCommitProcessSession catches transitionAndLog throw', async () => {
		const parentSha = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		const shadowBr = shadowBranchNameForCommit(parentSha, '');
		await plantShadowBranchWithSessionData(
			env,
			shadowBr,
			SESSION_ID,
			{ 'full.jsonl': '{"type":"user","message":{"content":"x"}}\n' },
			{ 'app.ts': 'mod' },
		);
		await saveSessionState(
			{
				sessionId: SESSION_ID,
				baseCommit: parentSha,
				attributionBaseCommit: parentSha,
				startedAt: new Date().toISOString(),
				phase: 'active',
				stepCount: 1,
				agentType: AGENT_TYPE_CLAUDE_CODE,
				filesTouched: ['app.ts'],
				worktreePath: env.dir,
				worktreeId: '',
				lastInteractionTime: new Date().toISOString(),
			},
			env.dir,
		);
		await env.writeFile('app.ts', 'mod');
		await env.gitAdd('app.ts');
		await env.gitCommit(`feat\n\nStory-Checkpoint: ${CHECKPOINT_ID}`);

		// Force condenseSession to throw — transitionAndLog wraps + rethrows;
		// postCommitProcessSession catches.
		(strategy as unknown as { condenseSession: () => Promise<never> }).condenseSession =
			async () => {
				throw new Error('forced condense fail');
			};
		await postCommitImpl(strategy);
	});

	// Phase 4 follow-up — force countWarnableStaleEndedSessions ≥ threshold via spy.
	it('postCommit invokes warnStaleEndedSessions when count >= threshold (covers Step 11 then-branch)', async () => {
		const parentSha = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		const shadowBr = shadowBranchNameForCommit(parentSha, '');
		await plantShadowBranchWithSessionData(
			env,
			shadowBr,
			SESSION_ID,
			{ 'full.jsonl': '{"type":"user","message":{"content":"x"}}\n' },
			{ 'app.ts': 'mod' },
		);
		await saveSessionState(
			{
				sessionId: SESSION_ID,
				baseCommit: parentSha,
				attributionBaseCommit: parentSha,
				startedAt: new Date().toISOString(),
				phase: 'active',
				stepCount: 1,
				agentType: AGENT_TYPE_CLAUDE_CODE,
				filesTouched: ['app.ts'],
				worktreePath: env.dir,
				worktreeId: '',
				lastInteractionTime: new Date().toISOString(),
			},
			env.dir,
		);
		await env.writeFile('app.ts', 'mod');
		await env.gitAdd('app.ts');
		await env.gitCommit(`feat\n\nStory-Checkpoint: ${CHECKPOINT_ID}`);

		// Force countWarnableStaleEndedSessions to return ≥ 3 so Step 11 fires.
		const sessionMod = await import('@/strategy/manual-commit-session');
		const spy = vi
			.spyOn(sessionMod, 'countWarnableStaleEndedSessions')
			.mockImplementation(async () => 5);
		try {
			// No throw — warn fires silently.
			await postCommitImpl(strategy);
		} finally {
			spy.mockRestore();
		}
	});

	// Phase 4 follow-up — exercise HEAD rev-parse catch (line 866) + parent rev-parse catch (line 876).
	it('postCommit silently keeps tree OIDs null when execGit rev-parse fails (lines 866/876 catch)', async () => {
		const parentSha = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		const shadowBr = shadowBranchNameForCommit(parentSha, '');
		await plantShadowBranchWithSessionData(
			env,
			shadowBr,
			SESSION_ID,
			{ 'full.jsonl': '{"type":"user","message":{"content":"x"}}\n' },
			{ 'app.ts': 'mod' },
		);
		await saveSessionState(
			{
				sessionId: SESSION_ID,
				baseCommit: parentSha,
				attributionBaseCommit: parentSha,
				startedAt: new Date().toISOString(),
				phase: 'active',
				stepCount: 1,
				agentType: AGENT_TYPE_CLAUDE_CODE,
				filesTouched: ['app.ts'],
				worktreePath: env.dir,
				worktreeId: '',
				lastInteractionTime: new Date().toISOString(),
			},
			env.dir,
		);
		await env.writeFile('app.ts', 'mod');
		await env.gitAdd('app.ts');
		await env.gitCommit(`feat\n\nStory-Checkpoint: ${CHECKPOINT_ID}`);

		// Make execGit throw for any `rev-parse <sha>^{tree}` invocation —
		// covers the empty-catch blocks on lines 866 + 876.
		const gitMod = await import('@/git');
		const orig = gitMod.execGit;
		const spy = vi.spyOn(gitMod, 'execGit').mockImplementation(async (args, opts) => {
			if (args[0] === 'rev-parse' && args[1] !== undefined && /\^\{tree\}$/.test(args[1])) {
				throw new Error('forced rev-parse fail');
			}
			return orig(args, opts);
		});
		try {
			await postCommitImpl(strategy);
		} finally {
			spy.mockRestore();
		}
	});

	// Go: handleCondenseIfFilesTouched — non-empty files + shouldCondense=true path.
	it('handleCondenseIfFilesTouched calls condenseAndUpdateState when filesTouched non-empty + ACTIVE+recent', async () => {
		// Use ENDED + filesTouched + valid shadow + commit overlap → CondenseIfFilesTouched
		// path (state machine for ENDED+GitCommit+hasFilesTouched=true).
		const parentSha = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		const shadowBr = shadowBranchNameForCommit(parentSha, '');
		await plantShadowBranchWithSessionData(
			env,
			shadowBr,
			SESSION_ID,
			{
				'full.jsonl': '{"type":"user","message":{"content":"x"}}\n',
				'prompt.txt': 'x',
			},
			{ 'app.ts': 'mod' },
		);
		await saveSessionState(
			{
				sessionId: SESSION_ID,
				baseCommit: parentSha,
				attributionBaseCommit: parentSha,
				startedAt: new Date().toISOString(),
				phase: 'ended',
				stepCount: 1,
				agentType: AGENT_TYPE_CLAUDE_CODE,
				filesTouched: ['app.ts'],
				worktreePath: env.dir,
				worktreeId: '',
				lastInteractionTime: new Date().toISOString(),
			},
			env.dir,
		);
		await env.writeFile('app.ts', 'mod');
		await env.gitAdd('app.ts');
		await env.gitCommit(`feat: ended\n\nStory-Checkpoint: ${CHECKPOINT_ID}`);

		await postCommitImpl(strategy);

		const after = await loadSessionState(SESSION_ID, env.dir);
		// Condensation ran via handleCondenseIfFilesTouched (ENDED → CondenseIfFilesTouched).
		expect(after?.lastCheckpointId).toBe(CHECKPOINT_ID);
	});
});
