/**
 * Phase 5.2 Todo 4 — `content-overlap.ts` unit tests.
 *
 * Mirror Go `entire-cli/cmd/entire/cli/strategy/content_overlap_test.go`
 * (~1324 lines, ~28 tests). Each `it()` is annotated with
 * `// Go: <go-file>:<line> <TestName>` for traceability.
 *
 * Fixture builder: {@link TestEnv.withShadowBranch} mirrors Go
 * `createShadowBranchWithContent` (`content_overlap_test.go:997-1050`).
 */

import fsCallback from 'node:fs';
import git from 'isomorphic-git';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shadowBranchNameForCommit } from '@/checkpoint/temporary';
import { clearGitCommonDirCache } from '@/git';
import * as log from '@/log';
import { clearWorktreeRootCache } from '@/paths';

async function shadowTreeOf(repoDir: string, shadowBranch: string): Promise<string> {
	const shadowOid = await git.resolveRef({
		fs: fsCallback,
		dir: repoDir,
		ref: `refs/heads/${shadowBranch}`,
	});
	const shadowCommit = await git.readCommit({ fs: fsCallback, dir: repoDir, oid: shadowOid });
	return shadowCommit.commit.tree;
}

import {
	extractSignificantLines,
	filesOverlapWithContent,
	filesWithRemainingAgentChanges,
	hasSignificantContentOverlap,
	stagedFilesOverlapWithContent,
	subtractFilesByName,
	workingTreeMatchesCommit,
} from '@/strategy/content-overlap';
import { TestEnv } from '../../helpers/test-env';

// Go: content_overlap.go:56-184 filesOverlapWithContent
// Go: content_overlap_test.go:21-184 (TestFilesOverlapWithContent_*)
describe('filesOverlapWithContent — Go: content_overlap.go:56-184', () => {
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

	// Go: content_overlap_test.go:21-63 TestFilesOverlapWithContent_ModifiedFile
	it('modified file (in parent + head) returns true', async () => {
		await env.writeFile('test.txt', 'original content here\n');
		await env.gitAdd('test.txt');
		await env.gitCommit('add test');

		const shadow = shadowBranchNameForCommit('abc1234', '');
		await env.withShadowBranch(shadow, { 'test.txt': 'session modified content here\n' });

		await env.writeFile('test.txt', 'user modified further with longer content\n');
		await env.gitAdd('test.txt');
		await env.gitCommit('modify');
		const headSha = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();

		const result = await filesOverlapWithContent(env.dir, shadow, headSha, ['test.txt']);
		expect(result).toBe(true);
	});

	// Go: content_overlap_test.go:65-100 TestFilesOverlapWithContent_NewFile_ContentMatch
	it('new file with shadow hash match returns true', async () => {
		const original = 'session created this content here\n';
		const shadow = shadowBranchNameForCommit('def5678', '');
		await env.withShadowBranch(shadow, { 'newfile.txt': original });

		await env.writeFile('newfile.txt', original);
		await env.gitAdd('newfile.txt');
		await env.gitCommit('add new');
		const headSha = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();

		const result = await filesOverlapWithContent(env.dir, shadow, headSha, ['newfile.txt']);
		expect(result).toBe(true);
	});

	// Go: content_overlap_test.go:102-140 TestFilesOverlapWithContent_NewFile_ContentMismatch
	it('new file with shadow hash mismatch returns false', async () => {
		const shadow = shadowBranchNameForCommit('ghi9012', '');
		await env.withShadowBranch(shadow, { 'replaced.txt': 'session created this longer content\n' });

		await env.writeFile('replaced.txt', 'user wrote something totally unrelated and longer\n');
		await env.gitAdd('replaced.txt');
		await env.gitCommit('replace');
		const headSha = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();

		const result = await filesOverlapWithContent(env.dir, shadow, headSha, ['replaced.txt']);
		expect(result).toBe(false);
	});

	// Go: content_overlap_test.go FileNotInCommit
	it('file in filesTouched but not in head returns false', async () => {
		const shadow = shadowBranchNameForCommit('jkl3456', '');
		await env.withShadowBranch(shadow, {});
		const headSha = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();

		const result = await filesOverlapWithContent(env.dir, shadow, headSha, ['phantom.ts']);
		expect(result).toBe(false);
	});

	// Go: content_overlap_test.go DeletedFile
	it('deleted file (in parent, not in head) returns true', async () => {
		// Initial commit already wrote .gitkeep. Add tracked.txt.
		await env.writeFile('tracked.txt', 'first content for deletion test\n');
		await env.gitAdd('tracked.txt');
		await env.gitCommit('add tracked');

		const shadow = shadowBranchNameForCommit('mno6789', '');
		await env.withShadowBranch(shadow, {});

		// Delete tracked.txt and commit
		await env.exec('git', ['rm', 'tracked.txt']);
		await env.gitCommit('delete tracked');
		const headSha = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();

		const result = await filesOverlapWithContent(env.dir, shadow, headSha, ['tracked.txt']);
		expect(result).toBe(true);
	});

	// Go: content_overlap_test.go NoShadowBranch
	it('missing shadow branch falls back to filename check (length > 0 = true)', async () => {
		const headSha = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		const result = await filesOverlapWithContent(env.dir, 'story/missing-deadbeef', headSha, [
			'anything.ts',
		]);
		// Go: filesTouched.length > 0 → true on fallback
		expect(result).toBe(true);
	});

	// Go: content_overlap_test.go missing shadow + empty filesTouched
	it('missing shadow with empty filesTouched returns false', async () => {
		const headSha = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		const result = await filesOverlapWithContent(env.dir, 'story/missing-x', headSha, []);
		expect(result).toBe(false);
	});

	// Go: content_overlap.go:107 — hasParentTree=true with parentTree=null treats as initial commit
	it('hasParentTree=true with parentTree=null treats commit as initial (no deletion check)', async () => {
		const shadow = shadowBranchNameForCommit('pqr1234', '');
		await env.withShadowBranch(shadow, {});
		const headSha = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		const result = await filesOverlapWithContent(env.dir, shadow, headSha, ['phantom.ts'], {
			parentTree: null,
			hasParentTree: true,
		});
		expect(result).toBe(false);
	});

	// Go: content_overlap_test.go TestFilesOverlapWithContent_CacheEquivalence
	// Go: content_overlap.go:75-130 — `opts` carries pre-resolved trees so callers
	// (PrepareCommitMsg) avoid redundant reads. Pre-fix vs fresh-read MUST yield the
	// same boolean for the same fixture; fully-cached and partial-cached both equal fresh.
	it('opts pre-resolved trees yield same result as fresh reads (full + partial cache equivalence)', async () => {
		// Build a "modified file" fixture (parent + head both have it; agent edited it).
		await env.writeFile('shared.ts', 'baseline content here\n');
		await env.gitAdd('shared.ts');
		await env.gitCommit('add shared');
		const parentSha = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();

		const shadow = shadowBranchNameForCommit('cache-equiv', '');
		await env.withShadowBranch(shadow, { 'shared.ts': 'agent edited shared content here\n' });

		await env.writeFile('shared.ts', 'baseline content here\nedit\n');
		await env.gitAdd('shared.ts');
		await env.gitCommit('modify shared');
		const headSha = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();

		// Pre-resolve all three trees for the cached call.
		const headTree = (await git.readCommit({ fs: fsCallback, dir: env.dir, oid: headSha })).commit
			.tree;
		const parentTree = (await git.readCommit({ fs: fsCallback, dir: env.dir, oid: parentSha }))
			.commit.tree;
		const shadowTree = await shadowTreeOf(env.dir, shadow);

		const fresh = await filesOverlapWithContent(env.dir, shadow, headSha, ['shared.ts']);
		const fullCache = await filesOverlapWithContent(env.dir, shadow, headSha, ['shared.ts'], {
			headTree,
			shadowTree,
			parentTree,
			hasParentTree: true,
		});
		// Partial cache: only headTree pre-resolved, others fall through to fresh read.
		const partialCache = await filesOverlapWithContent(env.dir, shadow, headSha, ['shared.ts'], {
			headTree,
		});

		expect(fresh).toBe(true);
		expect(fullCache).toBe(fresh);
		expect(partialCache).toBe(fresh);
	});

	// Go: content_overlap.go:65-75 — HEAD commit read fail falls back to filename check
	it('falls back to filename check when headCommitHash points at a non-commit', async () => {
		const shadow = shadowBranchNameForCommit('headfail', '');
		await env.withShadowBranch(shadow, {});
		// Bogus commit hash (40 hex chars but no such object)
		const bogus = '0'.repeat(40);
		const result = await filesOverlapWithContent(env.dir, shadow, bogus, ['x.ts']);
		// filename fallback returns filesTouched.length > 0
		expect(result).toBe(true);
	});

	// Go: content_overlap.go:79-104 — three distinct fallback messages for
	// shadow resolution. Mirrors the granularity of `logging.Debug` calls so
	// ops + reviewers can tell apart "ref missing" vs "commit fail" vs
	// "tree fail" from a single log line.
	describe('shadow resolution: three distinct fallback log messages (Go: content_overlap.go:79-104)', () => {
		// Go: content_overlap.go:80-86 — ref missing
		it('logs "shadow branch not found" when the shadow ref is absent', async () => {
			const debugSpy = vi.spyOn(log, 'debug').mockImplementation(() => {});
			const headSha = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			await filesOverlapWithContent(env.dir, 'story/missing-deadbeef', headSha, ['x.ts']);
			expect(
				debugSpy.mock.calls.some(
					([_ctx, msg]) => typeof msg === 'string' && msg.includes('shadow branch not found'),
				),
			).toBe(true);
			debugSpy.mockRestore();
		});

		// Go: content_overlap.go:88-94 — commit read fail
		// (TS readCommit will fail with InvalidOidError when ref points at a
		// non-commit OID. We plant a tag-like oid that resolves but isn't a commit.)
		it('logs "failed to get shadow commit" when shadow ref resolves but readCommit fails', async () => {
			const debugSpy = vi.spyOn(log, 'debug').mockImplementation(() => {});
			// Plant a ref that points at a tree OID (not a commit) so readCommit fails.
			const treeOid = await git.writeTree({ fs: fsCallback, dir: env.dir, tree: [] });
			const shadow = 'story/badcommit-xx';
			await git.writeRef({
				fs: fsCallback,
				dir: env.dir,
				ref: `refs/heads/${shadow}`,
				value: treeOid,
				force: true,
			});
			const headSha = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			await filesOverlapWithContent(env.dir, shadow, headSha, ['x.ts']);
			const messages = debugSpy.mock.calls.map(([_c, m]) => (typeof m === 'string' ? m : ''));
			// Must include the "failed to get shadow commit" granular message —
			// NOT just collapsed into "shadow branch not found".
			expect(messages.some((m) => m.includes('failed to get shadow commit'))).toBe(true);
			debugSpy.mockRestore();
		});
	});
});

// Go: content_overlap.go:194-352 stagedFilesOverlapWithContent
describe('stagedFilesOverlapWithContent — Go: content_overlap.go:194-352', () => {
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

	// Go: content_overlap_test.go TestStagedFilesOverlapWithContent_ModifiedFile
	it('staged modified file (already in HEAD) always overlaps', async () => {
		await env.writeFile('app.ts', 'original code here for app\n');
		await env.gitAdd('app.ts');
		await env.gitCommit('add app');

		const shadow = shadowBranchNameForCommit('abc1', '');
		await env.withShadowBranch(shadow, { 'app.ts': 'session content for app\n' });
		const shadowTree = await shadowTreeOf(env.dir, shadow);

		// Stage modified app.ts
		await env.writeFile('app.ts', 'user edited content for app\n');
		await env.gitAdd('app.ts');

		const result = await stagedFilesOverlapWithContent(env.dir, shadowTree, ['app.ts'], ['app.ts']);
		expect(result).toBe(true);
	});

	// Go: content_overlap_test.go TestStagedFilesOverlapWithContent_NewFile_ContentMatch
	it('staged new file matching shadow content returns true', async () => {
		const matching = 'agent created this longer content\n';
		const shadow = shadowBranchNameForCommit('abc2', '');
		await env.withShadowBranch(shadow, { 'fresh.ts': matching });
		const shadowTree = await shadowTreeOf(env.dir, shadow);

		await env.writeFile('fresh.ts', matching);
		await env.gitAdd('fresh.ts');

		const result = await stagedFilesOverlapWithContent(
			env.dir,
			shadowTree,
			['fresh.ts'],
			['fresh.ts'],
		);
		expect(result).toBe(true);
	});

	// Go: content_overlap_test.go TestStagedFilesOverlapWithContent_NoOverlap
	it('staged file not in filesTouched is skipped', async () => {
		const shadow = shadowBranchNameForCommit('abc3', '');
		await env.withShadowBranch(shadow, {});
		const shadowTree = await shadowTreeOf(env.dir, shadow);

		await env.writeFile('untracked.ts', 'unrelated content here for skip\n');
		await env.gitAdd('untracked.ts');

		const result = await stagedFilesOverlapWithContent(
			env.dir,
			shadowTree,
			['untracked.ts'],
			['unrelated.ts'], // different file
		);
		expect(result).toBe(false);
	});

	// Go: content_overlap.go:204-209 — falls back to filename check when HEAD read fails
	it('falls back to filename check when HEAD cannot be resolved', async () => {
		// Plant a fake repo dir without HEAD ref
		const tmpDir = `${env.dir}-no-head`;
		await import('node:fs/promises').then((fs) => fs.mkdir(tmpDir, { recursive: true }));
		await env.exec('git', ['init', '--bare', tmpDir]); // bare repo has no HEAD initially
		const result = await stagedFilesOverlapWithContent(tmpDir, '0'.repeat(40), ['x.ts'], ['x.ts']);
		// hasOverlappingFiles fallback: x.ts in both → overlap
		expect(result).toBe(true);
	});

	// Go: content_overlap.go:226-239, 281-288 — staged content comes from the
	// git INDEX (entry.Hash + BlobObject), NOT the worktree. After `git add`
	// followed by further worktree edits, index still has the agent-matching
	// content; worktree has the user's later edits. Overlap must use the index.
	it('uses git index hash (not worktree) when worktree was edited after git add', async () => {
		const matching = 'agent created longer content here\n';
		const shadow = shadowBranchNameForCommit('idx-edit', '');
		await env.withShadowBranch(shadow, { 'fresh.ts': matching });
		const shadowTree = await shadowTreeOf(env.dir, shadow);

		// Step 1: write matching content + git add → index has matching content
		await env.writeFile('fresh.ts', matching);
		await env.gitAdd('fresh.ts');
		// Step 2: edit worktree to differ from index (no second git add)
		// → worktree ≠ index. Go reads index → matches shadow → overlap=true.
		// Buggy TS reads worktree → differs from shadow → overlap=false (WRONG).
		await env.writeFile('fresh.ts', 'completely different worktree content longer\n');

		const result = await stagedFilesOverlapWithContent(
			env.dir,
			shadowTree,
			['fresh.ts'],
			['fresh.ts'],
		);
		expect(result).toBe(true);
	});

	// Go: content_overlap.go:265-268 — index miss = silent skip (no error)
	it('silently skips paths not in git index (Go behavior)', async () => {
		const matching = 'agent content longer here\n';
		const shadow = shadowBranchNameForCommit('idx-miss', '');
		await env.withShadowBranch(shadow, { 'a.ts': matching });
		const shadowTree = await shadowTreeOf(env.dir, shadow);

		// a.ts written to disk but NOT staged via git add → not in index.
		// Go: skip silently, return false.
		await env.writeFile('a.ts', matching);
		// Note: NO `await env.gitAdd('a.ts')`

		const result = await stagedFilesOverlapWithContent(env.dir, shadowTree, ['a.ts'], ['a.ts']);
		expect(result).toBe(false);
	});

	// Go: content_overlap_test.go TestStagedFilesOverlapWithContent_NewFile_ContentMismatch
	// Go: content_overlap.go:306-328 — staged hash !== shadow hash falls through to
	// hasSignificantContentOverlap; ≥2 matching significant lines triggers true.
	it('staged new file mismatch falls through to significant-line overlap', async () => {
		// Both files have ≥2 significant (≥10-char) lines that overlap.
		const shadowContent =
			'function calculateTotal(items) {\n  return sum;\n}\nconst version = "1.0.0";\n';
		const stagedContent =
			'function calculateTotal(items) {\n  return total;\n}\nconst version = "1.0.0";\n';
		const shadow = shadowBranchNameForCommit('mis-sig', '');
		await env.withShadowBranch(shadow, { 'partial.ts': shadowContent });
		const shadowTree = await shadowTreeOf(env.dir, shadow);

		await env.writeFile('partial.ts', stagedContent);
		await env.gitAdd('partial.ts');

		const result = await stagedFilesOverlapWithContent(
			env.dir,
			shadowTree,
			['partial.ts'],
			['partial.ts'],
		);
		expect(result).toBe(true);
	});

	// Go: content_overlap_test.go TestStagedFilesOverlapWithContent_DeletedFile
	// Go: content_overlap.go:265-285 — staged file removal (`git rm` then add) leaves
	// the file in HEAD but absent from index → still overlaps (covered by HEAD-presence path).
	it('staged deletion (file in HEAD but removed from index) overlaps via HEAD-presence path', async () => {
		await env.writeFile('to-remove.ts', 'original tracked content here\n');
		await env.gitAdd('to-remove.ts');
		await env.gitCommit('add to-remove');

		const shadow = shadowBranchNameForCommit('del-stage', '');
		await env.withShadowBranch(shadow, { 'to-remove.ts': 'agent wrote longer content here\n' });
		const shadowTree = await shadowTreeOf(env.dir, shadow);

		// Stage the deletion: rm from worktree + git add removes it from index.
		await env.exec('git', ['rm', 'to-remove.ts']);

		// stagedFiles arg lists what's staged (removed). filesTouched still lists the file
		// — Go: stagedFilesOverlapWithContent inspects HEAD via gitDiffNameOnly; since the
		// file was in HEAD it qualifies as overlapping via the modified-file path.
		const result = await stagedFilesOverlapWithContent(
			env.dir,
			shadowTree,
			['to-remove.ts'],
			['to-remove.ts'],
		);
		expect(result).toBe(true);
	});
});

// Go: content_overlap.go:383-520 filesWithRemainingAgentChanges
describe('filesWithRemainingAgentChanges — Go: content_overlap.go:383-520', () => {
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

	// Go: content_overlap_test.go FileNotCommitted
	it('uncommitted file in filesTouched is kept in remaining', async () => {
		const shadow = shadowBranchNameForCommit('a', '');
		await env.withShadowBranch(shadow, { 'kept.ts': 'agent wrote longer content here\n' });
		const headSha = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();

		const result = await filesWithRemainingAgentChanges(
			env.dir,
			shadow,
			headSha,
			['kept.ts'],
			new Set(),
		);
		expect(result).toEqual(['kept.ts']);
	});

	// Go: content_overlap_test.go FullyCommitted
	it('fully committed file (commit hash === shadow hash) is skipped', async () => {
		const matching = 'agent content matches commit content here\n';
		const shadow = shadowBranchNameForCommit('b', '');
		await env.withShadowBranch(shadow, { 'done.ts': matching });

		await env.writeFile('done.ts', matching);
		await env.gitAdd('done.ts');
		await env.gitCommit('done');
		const headSha = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();

		const result = await filesWithRemainingAgentChanges(
			env.dir,
			shadow,
			headSha,
			['done.ts'],
			new Set(['done.ts']),
		);
		expect(result).toEqual([]);
	});

	// Go: content_overlap_test.go ReplacedContent (clean working tree + commit !== shadow → skip)
	it('clean working tree with content mismatch is skipped (reverted-and-replaced)', async () => {
		const shadow = shadowBranchNameForCommit('c', '');
		await env.withShadowBranch(shadow, { 'replaced.ts': 'agent original longer content here\n' });

		const userContent = 'user wrote something completely unrelated\n';
		await env.writeFile('replaced.ts', userContent);
		await env.gitAdd('replaced.ts');
		await env.gitCommit('user replaced');
		const headSha = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		// Working tree clean (matches commit)

		const result = await filesWithRemainingAgentChanges(
			env.dir,
			shadow,
			headSha,
			['replaced.ts'],
			new Set(['replaced.ts']),
		);
		expect(result).toEqual([]);
	});

	// Go: content_overlap_test.go PartialCommit (commit !== shadow + dirty working tree → keep)
	it('partial commit with dirty working tree is kept', async () => {
		const shadow = shadowBranchNameForCommit('d', '');
		await env.withShadowBranch(shadow, { 'partial.ts': 'agent wrote longer content here line\n' });

		await env.writeFile('partial.ts', 'partial commit version one longer line\n');
		await env.gitAdd('partial.ts');
		await env.gitCommit('partial');
		const headSha = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		// Make working tree dirty (different from commit and from shadow)
		await env.writeFile('partial.ts', 'staged different newer content longer line\n');

		const result = await filesWithRemainingAgentChanges(
			env.dir,
			shadow,
			headSha,
			['partial.ts'],
			new Set(['partial.ts']),
		);
		expect(result).toEqual(['partial.ts']);
	});

	// Go: content_overlap_test.go NoShadowBranch falls back to subtractFilesByName
	it('missing shadow branch falls back to filename-only subtraction', async () => {
		const headSha = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		const result = await filesWithRemainingAgentChanges(
			env.dir,
			'story/nope-deadbeef',
			headSha,
			['a.ts', 'b.ts'],
			new Set(['a.ts']),
		);
		expect(result).toEqual(['b.ts']);
	});

	// Go: content_overlap_test.go PhantomFile
	it('phantom file (not in shadow tree) is skipped to avoid carry-forward loop', async () => {
		const shadow = shadowBranchNameForCommit('e', '');
		await env.withShadowBranch(shadow, { 'real.ts': 'agent created longer content here\n' });
		const headSha = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();

		const result = await filesWithRemainingAgentChanges(
			env.dir,
			shadow,
			headSha,
			['real.ts', 'phantom.ts'],
			new Set(),
		);
		expect(result).toEqual(['real.ts']);
	});

	// Go: content_overlap.go:401-409 — commit tree read fail falls back to subtractFilesByName
	it('falls back to subtractFilesByName when commit tree cannot be resolved', async () => {
		const result = await filesWithRemainingAgentChanges(
			env.dir,
			'story/missing-deadbeef',
			'0000000000000000000000000000000000000000', // bogus commit hash
			['a.ts', 'b.ts'],
			new Set(['a.ts']),
		);
		expect(result).toEqual(['b.ts']);
	});

	// Go: content_overlap.go:419-431 — granular fallback when shadow ref resolves
	// but readCommit fails (3-way split parity)
	it('logs "failed to get shadow commit" in filesWithRemainingAgentChanges when shadow ref points at non-commit', async () => {
		const debugSpy = vi.spyOn(log, 'debug').mockImplementation(() => {});
		// Plant a ref pointing at a tree OID — readCommit will fail.
		const treeOid = await git.writeTree({ fs: fsCallback, dir: env.dir, tree: [] });
		const shadow = 'story/badcommit-2';
		await git.writeRef({
			fs: fsCallback,
			dir: env.dir,
			ref: `refs/heads/${shadow}`,
			value: treeOid,
			force: true,
		});
		const headSha = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		const result = await filesWithRemainingAgentChanges(
			env.dir,
			shadow,
			headSha,
			['a.ts'],
			new Set(),
		);
		expect(result).toEqual(['a.ts']); // fallback to subtractFilesByName
		const messages = debugSpy.mock.calls.map(([_c, m]) => (typeof m === 'string' ? m : ''));
		expect(messages.some((m) => m.includes('failed to get shadow commit'))).toBe(true);
		debugSpy.mockRestore();
	});

	// Go: content_overlap.go:476-484 — committed file but missing from commit tree → keep
	it('file in committedFiles but absent from commit tree is kept (defensive carry-forward)', async () => {
		const shadow = shadowBranchNameForCommit('cf', '');
		await env.withShadowBranch(shadow, { 'gone.ts': 'agent wrote then deleted longer content\n' });
		// HEAD commit doesn't contain gone.ts; pretend it was claimed in committedFiles.
		const headSha = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();

		const result = await filesWithRemainingAgentChanges(
			env.dir,
			shadow,
			headSha,
			['gone.ts'],
			new Set(['gone.ts']),
		);
		expect(result).toEqual(['gone.ts']);
	});

	// Go: content_overlap_test.go TestFilesWithRemainingAgentChanges_CacheEquivalence
	// Go: content_overlap.go:391-440 — `opts` allows pre-resolved trees to short-circuit
	// the per-call reads. Cached and fresh paths must return identical arrays.
	it('opts pre-resolved trees yield same result as fresh reads (cache equivalence)', async () => {
		const shadow = shadowBranchNameForCommit('rem-cache', '');
		await env.withShadowBranch(shadow, { 'kept.ts': 'agent wrote longer content here\n' });
		const headSha = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		const headTree = (await git.readCommit({ fs: fsCallback, dir: env.dir, oid: headSha })).commit
			.tree;
		const shadowTree = await shadowTreeOf(env.dir, shadow);

		const fresh = await filesWithRemainingAgentChanges(
			env.dir,
			shadow,
			headSha,
			['kept.ts'],
			new Set(),
		);
		const cached = await filesWithRemainingAgentChanges(
			env.dir,
			shadow,
			headSha,
			['kept.ts'],
			new Set(),
			{ headTree, shadowTree, hasParentTree: true, parentTree: null },
		);
		expect(fresh).toEqual(['kept.ts']);
		expect(cached).toEqual(fresh);
	});

	// Go: content_overlap_test.go TestFilesWithRemainingAgentChanges_UncommittedDeletion
	// Go: content_overlap.go:447-455 — file in filesTouched but NOT in shadow tree is
	// skipped: agent deleted it; nothing remains to carry forward.
	it('uncommitted deletion (file absent from shadow tree) is skipped', async () => {
		const shadow = shadowBranchNameForCommit('uncommit-del', '');
		// shadow tree is intentionally empty — agent's "deleted" file is not present.
		await env.withShadowBranch(shadow, { 'other.ts': 'agent kept this longer content\n' });
		const headSha = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();

		const result = await filesWithRemainingAgentChanges(
			env.dir,
			shadow,
			headSha,
			['deleted-by-agent.ts'],
			new Set(),
		);
		// File missing from shadow tree → nothing to carry forward.
		expect(result).toEqual([]);
	});
});

// Go: content_overlap.go:543-556 subtractFilesByName
describe('subtractFilesByName — Go: content_overlap.go:543-556', () => {
	// Go: content_overlap_test.go TestSubtractFiles
	it('returns files in filesTouched not in committedFiles, preserving order', () => {
		expect(subtractFilesByName(['a', 'b', 'c'], new Set(['b']))).toEqual(['a', 'c']);
	});

	// Go: content_overlap.go:550 — empty filesTouched returns empty
	it('returns empty array for empty filesTouched', () => {
		expect(subtractFilesByName([], new Set(['a']))).toEqual([]);
	});

	// Go: empty committedFiles → returns full filesTouched
	it('returns full filesTouched when committedFiles is empty', () => {
		expect(subtractFilesByName(['a', 'b'], new Set())).toEqual(['a', 'b']);
	});
});

// Go: content_overlap.go:570-604 hasSignificantContentOverlap
describe('hasSignificantContentOverlap — Go: content_overlap.go:570-604', () => {
	// Go: content_overlap_test.go TestHasSignificantContentOverlap "two matching significant lines - overlap"
	it('returns true when both sides share ≥2 significant lines (and both have ≥2 sig lines)', () => {
		const a = 'this is the first significant line\nand here is the second long line\nshort\n';
		const b = 'this is the first significant line\nand here is the second long line\ndifferent\n';
		expect(hasSignificantContentOverlap(a, b)).toBe(true);
	});

	// Go: content_overlap_test.go "single shared line like package main - no overlap"
	it('returns false when only 1 match in normal-size files (filters package main boilerplate)', () => {
		const a = 'package main is a common header\nfunc Foo() should be unique line\n';
		const b = 'package main is a common header\nfunc Bar() differs from above line\n';
		expect(hasSignificantContentOverlap(a, b)).toBe(false);
	});

	// Go: content_overlap_test.go "very small file with single match - overlap"
	it('returns true when 1 match suffices because either side has < 2 significant lines', () => {
		const tiny = 'this is the only significant line\nshort\n'; // only 1 sig line (>=10)
		const other = 'this is the only significant line\nplus a longer second line\n';
		expect(hasSignificantContentOverlap(tiny, other)).toBe(true);
	});

	// Go: content_overlap.go:578-580 — either side 0 sig lines → false
	it('returns false when either side has 0 significant lines', () => {
		expect(hasSignificantContentOverlap('short\nshort\n', 'this is a longer line here\n')).toBe(
			false,
		);
		expect(hasSignificantContentOverlap('this is a longer line here\n', 'short\nshort\n')).toBe(
			false,
		);
	});
});

// Go: content_overlap.go:613-622 extractSignificantLines
describe('extractSignificantLines — Go: content_overlap.go:613-622', () => {
	// Go: content_overlap.go:617 — len(trimmed) >= 10 keeps long lines
	it('keeps lines with ≥10 chars after trim and filters short ones', () => {
		const result = extractSignificantLines('package main\n}\n\nfunc Foo() {}\n');
		expect(result.has('package main')).toBe(true); // 12 chars
		expect(result.has('func Foo() {}')).toBe(true); // 13 chars
		expect(result.has('}')).toBe(false); // 1 char
		expect(result.has('')).toBe(false); // 0 chars
	});

	// Go: content_overlap.go:613-619 — trim only ' ' and '\t', not '\u00A0'
	it('trims only space/tab, not Unicode whitespace', () => {
		// The '\u00A0' (non-breaking space) is NOT stripped, so the line is kept verbatim.
		const line = '\u00A0this has nbsp prefix\u00A0';
		const result = extractSignificantLines(`${line}\n`);
		expect(result.has(line)).toBe(true);
	});

	// Go: common.go:1208-1218 splitLines — empty input returns empty
	it('returns empty Set for empty input (Go splitLines empty-input contract)', () => {
		expect(extractSignificantLines('')).toEqual(new Set());
	});

	// Go: common.go:1216 strings.TrimSuffix — single trailing \n stripped
	it('strips a single trailing \\n before splitting (Go splitLines parity)', () => {
		// Input 'foo\n' → TrimSuffix → 'foo' → split → ['foo']. NOT ['foo', '']
		// Naive `split(/\r?\n/)` gives ['foo', ''], leaking empty trimmed line.
		const result = extractSignificantLines('a longer than ten chars here\n');
		expect(result.size).toBe(1);
	});

	// Go: common.go:1214 — \r\n normalized to \n
	it('normalizes \\r\\n to \\n', () => {
		const result = extractSignificantLines('first long line one\r\nsecond long line two\r\n');
		expect(result.has('first long line one')).toBe(true);
		expect(result.has('second long line two')).toBe(true);
	});
});

// Go: content_overlap.go:524-539 workingTreeMatchesCommit
describe('workingTreeMatchesCommit — Go: content_overlap.go:524-539', () => {
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

	// Go: content_overlap.go:534 — git blob hash on disk content matches blob OID
	it('returns true when worktree file matches the committed blob hash', async () => {
		const content = 'matching content for the test\n';
		await env.writeFile('check.ts', content);
		await env.gitAdd('check.ts');
		await env.gitCommit('add');

		// Compute the blob OID via plumbing
		const blobOid = await env.writeBlob(content);
		// `writeBlob` is idempotent — returning the canonical blob hash for `content`.

		expect(workingTreeMatchesCommit(env.dir, 'check.ts', blobOid)).toBe(true);
	});

	// Go: content_overlap.go:534 — different on-disk content → false
	it('returns false when worktree file differs from the blob hash', async () => {
		const original = 'one set of contents here\n';
		await env.writeFile('check.ts', original);
		await env.gitAdd('check.ts');
		await env.gitCommit('add');
		const originalBlob = await env.writeBlob(original);

		// Now mutate disk
		await env.writeFile('check.ts', 'completely different content now\n');
		expect(workingTreeMatchesCommit(env.dir, 'check.ts', originalBlob)).toBe(false);
	});

	// Go: content_overlap.go:528-530 — read failure → return false (treat as dirty)
	it('returns false when file does not exist (read failure)', () => {
		expect(workingTreeMatchesCommit(env.dir, 'nonexistent.ts', 'a'.repeat(40))).toBe(false);
	});
});
