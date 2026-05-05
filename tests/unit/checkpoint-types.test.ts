import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { joinPrompts, PROMPT_SEPARATOR, splitPrompts } from '@/checkpoint/prompts';
import {
	hashWorktreeID,
	parseShadowBranchName,
	SHADOW_BRANCH_HASH_LENGTH,
	shadowBranchNameForCommit,
	WORKTREE_ID_HASH_LENGTH,
} from '@/checkpoint/temporary';
import { splitFirstSegment } from '@/checkpoint/tree-ops';
import { CheckpointType, GitStore } from '@/checkpoint/types';
import { TestEnv } from '../helpers/test-env';

// Go: checkpoint_test.go TestCheckpointType_Values
describe('CheckpointType enum', () => {
	it('Temporary=0, Committed=1 (matches Go iota)', () => {
		expect(CheckpointType.Temporary).toBe(0);
		expect(CheckpointType.Committed).toBe(1);
	});
});

// Go: parse_tree_test.go TestSplitFirstSegment
describe('splitFirstSegment', () => {
	it.each([
		{ input: 'file.txt', first: 'file.txt', rest: '' },
		{ input: 'a/b', first: 'a', rest: 'b' },
		{ input: 'a/b/c', first: 'a', rest: 'b/c' },
		{ input: 'dir/sub/file.txt', first: 'dir', rest: 'sub/file.txt' },
		{ input: '', first: '', rest: '' },
	])('splits %s into ($first, $rest)', ({ input, first, rest }) => {
		const [gotFirst, gotRest] = splitFirstSegment(input);
		expect(gotFirst).toBe(first);
		expect(gotRest).toBe(rest);
	});
});

// Go: temporary_test.go TestHashWorktreeID
describe('hashWorktreeID', () => {
	it.each([
		{ name: 'empty string (main worktree)', input: '' },
		{ name: 'simple worktree name', input: 'test-123' },
		{ name: 'complex worktree name', input: 'feature/auth-system' },
	])('returns $name as 6-char hex', ({ input }) => {
		const got = hashWorktreeID(input);
		expect(got).toHaveLength(WORKTREE_ID_HASH_LENGTH);
		expect(got).toMatch(/^[0-9a-f]{6}$/);
	});

	// Go: TestHashWorktreeID_Deterministic
	it('is deterministic for the same input', () => {
		const id = 'test-worktree';
		expect(hashWorktreeID(id)).toBe(hashWorktreeID(id));
	});

	// Go: TestHashWorktreeID_DifferentInputs
	it('produces different hashes for different inputs', () => {
		expect(hashWorktreeID('worktree-a')).not.toBe(hashWorktreeID('worktree-b'));
	});
});

// Go: temporary_test.go TestShadowBranchNameForCommit
describe('shadowBranchNameForCommit', () => {
	it.each([
		{
			name: 'main worktree',
			baseCommit: 'abc1234567890',
			worktreeId: '',
			want: `story/abc1234-${hashWorktreeID('')}`,
		},
		{
			name: 'linked worktree',
			baseCommit: 'abc1234567890',
			worktreeId: 'test-123',
			want: `story/abc1234-${hashWorktreeID('test-123')}`,
		},
		{
			name: 'short commit hash (less than 7 chars)',
			baseCommit: 'abc',
			worktreeId: 'wt',
			want: `story/abc-${hashWorktreeID('wt')}`,
		},
	])('formats $name correctly', ({ baseCommit, worktreeId, want }) => {
		expect(shadowBranchNameForCommit(baseCommit, worktreeId)).toBe(want);
	});

	it('uses exactly the first 7 hex chars when commit is 7+ chars long', () => {
		const branch = shadowBranchNameForCommit('1234567890abcdef', 'main');
		expect(branch.startsWith('story/1234567-')).toBe(true);
	});

	it('emits a name matching `story/<7-hex>-<6-hex>` for full-length commits', () => {
		const branch = shadowBranchNameForCommit('a'.repeat(40), 'wt');
		expect(branch).toMatch(/^story\/[0-9a-f]{7}-[0-9a-f]{6}$/);
		expect(branch.split('-')[0]?.slice('story/'.length)).toHaveLength(SHADOW_BRANCH_HASH_LENGTH);
	});
});

// Go: temporary_test.go TestParseShadowBranchName
describe('parseShadowBranchName', () => {
	it.each([
		{
			name: 'new format with worktree hash',
			input: 'story/abc1234-e3b0c4',
			want: { commitPrefix: 'abc1234', worktreeHash: 'e3b0c4' },
		},
		{
			name: 'old format without worktree hash',
			input: 'story/abc1234',
			want: { commitPrefix: 'abc1234', worktreeHash: '' },
		},
		{
			name: 'full commit hash with worktree',
			input: 'story/abcdef1234567890-fedcba',
			want: { commitPrefix: 'abcdef1234567890', worktreeHash: 'fedcba' },
		},
		{
			// Go: ParseShadowBranchName doesn't validate semantics — `checkpoints/v1` parses too
			name: 'metadata branch (parser does not validate)',
			input: 'story/checkpoints/v1',
			want: { commitPrefix: 'checkpoints/v1', worktreeHash: '' },
		},
		{
			name: 'empty suffix after prefix',
			input: 'story/',
			want: { commitPrefix: '', worktreeHash: '' },
		},
	])('parses $name', ({ input, want }) => {
		expect(parseShadowBranchName(input)).toEqual(want);
	});

	it('returns null for branches outside the story/ namespace', () => {
		expect(parseShadowBranchName('main')).toBeNull();
		expect(parseShadowBranchName('feat/x')).toBeNull();
		expect(parseShadowBranchName('refs/heads/story/x')).toBeNull();
	});

	// Go: TestParseShadowBranchName_RoundTrip
	it.each([
		{ baseCommit: 'abc1234567890', worktreeId: '' },
		{ baseCommit: 'abc1234567890', worktreeId: 'test-worktree' },
		{ baseCommit: 'deadbeef', worktreeId: 'feature/auth' },
	])('round-trips ($baseCommit, $worktreeId)', ({ baseCommit, worktreeId }) => {
		const branch = shadowBranchNameForCommit(baseCommit, worktreeId);
		const parsed = parseShadowBranchName(branch);
		expect(parsed).not.toBeNull();
		const expectedCommit =
			baseCommit.length > SHADOW_BRANCH_HASH_LENGTH
				? baseCommit.slice(0, SHADOW_BRANCH_HASH_LENGTH)
				: baseCommit;
		expect(parsed?.commitPrefix).toBe(expectedCommit);
		expect(parsed?.worktreeHash).toBe(hashWorktreeID(worktreeId));
	});
});

// Go: prompts_test.go TestJoinAndSplitPrompts_RoundTrip
describe('joinPrompts / splitPrompts', () => {
	it('round-trip preserves prompts (multi-prompt with embedded newlines)', () => {
		const original = ['first line\nwith newline', 'second prompt'];
		const joined = joinPrompts(original);
		expect(joined).toBe(`first line\nwith newline${PROMPT_SEPARATOR}second prompt`);
		expect(splitPrompts(joined)).toEqual(original);
	});

	it('round-trip preserves a single prompt (no separators)', () => {
		const original = ['only one'];
		expect(splitPrompts(joinPrompts(original))).toEqual(original);
	});

	// Go: TestSplitPromptContent_EmptyContent
	it('splitPrompts returns [] for empty content', () => {
		expect(splitPrompts('')).toEqual([]);
	});

	it('splitPrompts strips trailing empty entries (mirrors Go behavior)', () => {
		const content = `a${PROMPT_SEPARATOR}b${PROMPT_SEPARATOR}`;
		expect(splitPrompts(content)).toEqual(['a', 'b']);
	});
});

// GitStore is now fully wired: Phase 4.2 plumbed temporary-checkpoint
// methods, Phase 4.3 plumbed committed-checkpoint methods + the read-side
// `CommittedReader` surface (getTranscript / getSessionLog /
// getCheckpointAuthor / readLatestSessionContent / readSessionMetadata /
// updateSummary / updateCheckpointSummary) + the `setBlobFetcher` hook for
// the (Phase 4.4) treeless-fetch flow.
describe('GitStore constructor + fetcher hook', () => {
	it('records the repo dir on the constructor', () => {
		const store = new GitStore('/tmp/repo');
		expect(store.repoDir).toBe('/tmp/repo');
	});

	it('stores and returns the blob fetcher via setBlobFetcher/getBlobFetcher', () => {
		const store = new GitStore('/tmp/repo');
		expect(store.getBlobFetcher()).toBeUndefined();
		const fetcher = async () => {};
		store.setBlobFetcher(fetcher);
		expect(store.getBlobFetcher()).toBe(fetcher);
		store.setBlobFetcher(undefined);
		expect(store.getBlobFetcher()).toBeUndefined();
	});
});

// Phase 4.2 wire-up smoke tests: confirm GitStore.{writeTemporary, readTemporary,
// listTemporary} actually reach the standalone implementations in
// `temporary.ts` and don't accidentally regress to the old `NOT_IMPLEMENTED`
// throws. Functional behavior (deduplication, .gitignore filtering, etc.) is
// owned by `checkpoint-temporary.test.ts`; here we only verify that the
// delegation path is alive.
describe('GitStore Phase 4.2 wire-up (smoke tests)', () => {
	let env: TestEnv;
	let store: GitStore;
	let baseCommit: string;

	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		store = new GitStore(env.dir);
		baseCommit = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
	});

	afterEach(async () => {
		await env.cleanup();
	});

	it('listTemporary returns [] for a repo with no shadow branches', async () => {
		await expect(store.listTemporary()).resolves.toEqual([]);
	});

	it('readTemporary returns null when the shadow branch is missing', async () => {
		await expect(store.readTemporary(baseCommit, '')).resolves.toBeNull();
	});

	it('writeTemporary delegates and produces a real checkpoint commit', async () => {
		await env.writeFile('hello.ts', 'console.log("hi")');
		const result = await store.writeTemporary({
			sessionId: 'sess-smoke',
			baseCommit,
			worktreeId: '',
			modifiedFiles: [],
			newFiles: ['hello.ts'],
			deletedFiles: [],
			metadataDir: '',
			metadataDirAbs: '',
			commitMessage: 'Smoke checkpoint',
			authorName: 'Story CLI',
			authorEmail: 'story@local',
			isFirstCheckpoint: false,
		});

		expect(result.skipped).toBe(false);
		expect(result.commitHash).toMatch(/^[0-9a-f]{40}$/);

		// Round-trip via readTemporary to confirm the delegation chain is live
		// in both directions.
		const round = await store.readTemporary(baseCommit, '');
		expect(round).not.toBeNull();
		expect(round?.commitHash).toBe(result.commitHash);
		expect(round?.sessionId).toBe('sess-smoke');
	});

	// ─── audit-3 Fix F (2026-04-18): GitStore.writeTemporaryTask delegation ─
	// Go: manual_commit_git.go:212-251 — `store.WriteTemporaryTask` is part of
	// the GitStore API. Phase 5.2 SaveTaskStep relies on this method. Pre-fix
	// TS only had a standalone `writeTemporaryTask(repoDir, ...)` and SaveTaskStep
	// bypassed the store entirely. Audit-3 wired the method onto GitStore — this
	// smoke test verifies the new delegation produces a real shadow-branch commit.
	it('writeTemporaryTask delegates and produces a real task checkpoint commit (Fix F)', async () => {
		await env.writeFile('out.txt', 'subagent wrote this');
		const result = await store.writeTemporaryTask({
			sessionId: 'sess-task-smoke',
			baseCommit,
			worktreeId: '',
			toolUseId: 'toolu_01abcdef0123456789',
			agentId: 'agent-01',
			modifiedFiles: [],
			newFiles: ['out.txt'],
			deletedFiles: [],
			transcriptPath: '',
			subagentTranscriptPath: '',
			checkpointUuid: '00000000-0000-0000-0000-00000000abcd',
			commitMessage:
				'task subagent end\n\nStory-Session: sess-task-smoke\nStory-Metadata: .story/metadata/sess-task-smoke/tasks/toolu_01ab\n',
			authorName: 'Story CLI',
			authorEmail: 'story@local',
			isIncremental: false,
			incrementalSequence: 0,
			incrementalType: '',
			incrementalData: new Uint8Array(),
		});

		expect(result).toMatch(/^[0-9a-f]{40}$/);
	});
});

// Phase 4.3 wire-up smoke tests: confirm GitStore.{writeCommitted,
// readCommitted, readSessionContent, readSessionContentById, listCommitted,
// updateCommitted} actually reach the standalone implementations in
// `committed.ts`. Functional behavior (aggregation, multi-session in-place
// update, redaction, etc.) is owned by `checkpoint-committed.test.ts` and
// `checkpoint-committed-update.test.ts`; here we only verify that each
// delegation path is alive and returns the expected null/empty-collection
// shapes for a repo with no metadata branch.
describe('GitStore Phase 4.3 wire-up (smoke tests)', () => {
	let env: TestEnv;
	let store: GitStore;

	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		await env.exec('git', ['config', 'user.name', 'Test']);
		await env.exec('git', ['config', 'user.email', 'test@test.local']);
		store = new GitStore(env.dir);
	});

	afterEach(async () => {
		await env.cleanup();
	});

	it('listCommitted returns [] for a repo with no metadata branch', async () => {
		await expect(store.listCommitted()).resolves.toEqual([]);
	});

	it('readCommitted returns null for a non-existent checkpoint', async () => {
		await expect(store.readCommitted('deadbeefcafe')).resolves.toBeNull();
	});

	it('writeCommitted then readCommitted round-trip via the GitStore instance', async () => {
		await store.writeCommitted({
			checkpointId: 'a3b2c4d5e6f7',
			sessionId: 'sess-smoke-43',
			strategy: 'manual-commit',
			branch: 'main',
			transcript: new TextEncoder().encode('{"smoke":1}\n'),
			prompts: [],
			filesTouched: ['src/x.ts'],
			checkpointsCount: 1,
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

		const summary = await store.readCommitted('a3b2c4d5e6f7');
		expect(summary?.checkpointId).toBe('a3b2c4d5e6f7');
		const session = await store.readSessionContent('a3b2c4d5e6f7', 0);
		expect(session?.metadata.sessionId).toBe('sess-smoke-43');
		const byId = await store.readSessionContentById('a3b2c4d5e6f7', 'sess-smoke-43');
		expect(byId?.metadata.sessionId).toBe('sess-smoke-43');

		// listCommitted now finds the just-written checkpoint.
		const list = await store.listCommitted();
		expect(list.map((c) => c.checkpointId)).toEqual(['a3b2c4d5e6f7']);
	});

	it('updateCommitted delegates through the GitStore instance', async () => {
		// Minimal pre-flight: write so the update has something to replace.
		await store.writeCommitted({
			checkpointId: 'a3b2c4d5e6f7',
			sessionId: 'sess-smoke-43',
			strategy: 'manual-commit',
			branch: 'main',
			transcript: new TextEncoder().encode('orig\n'),
			prompts: [],
			filesTouched: [],
			checkpointsCount: 1,
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
		await store.updateCommitted({
			checkpointId: 'a3b2c4d5e6f7',
			sessionId: 'sess-smoke-43',
			transcript: new TextEncoder().encode('updated\n'),
			prompts: [],
			agent: 'claudecode',
			compactTranscript: null,
		});
		const session = await store.readSessionContent('a3b2c4d5e6f7', 0);
		expect(new TextDecoder().decode(session?.transcript ?? new Uint8Array())).toBe('updated\n');
	});
});
