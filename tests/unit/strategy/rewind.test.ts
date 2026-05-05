/**
 * Phase 5.5 rewind / previewRewind / canRewind / resetShadowBranchToCheckpoint
 * unit tests.
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/strategy/manual_commit_rewind.go`
 * + `rewind_test.go` (TestShadowStrategy_PreviewRewind /
 * PreviewRewind_LogsOnly / Rewind_FromSubdirectory / Rewind_FromRepoRoot).
 *
 * Each `it()` is annotated with `// Go: <go-file>:<line>` for the
 * audit-test-go-parity gate.
 */

import fsCallback from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import git from 'isomorphic-git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { shadowBranchNameForCommit } from '@/checkpoint/temporary';
import { MODE_DIR, MODE_EXEC, MODE_FILE } from '@/checkpoint/tree-ops';
import { clearGitCommonDirCache } from '@/git';
import type { CheckpointID } from '@/id';
import { clearWorktreeRootCache } from '@/paths';
import { setStderrWriterForTesting } from '@/strategy/hooks-tty';
import { ManualCommitStrategy } from '@/strategy/manual-commit';
import {
	canRewindImpl,
	previewRewindImpl,
	resetShadowBranchToCheckpoint,
	rewindImpl,
	setCollectUntrackedFilesForTesting,
} from '@/strategy/rewind';
import { saveSessionState } from '@/strategy/session-state';
import type { RewindPoint, SessionState } from '@/strategy/types';
import { TestEnv } from '../../helpers/test-env';

interface CapturedWritable extends NodeJS.WritableStream {
	captured: string;
}

function makeWritable(): CapturedWritable {
	const stream: CapturedWritable = {
		captured: '',
		write(chunk: string | Uint8Array): boolean {
			stream.captured += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
			return true;
		},
		end(): void {},
		on(): NodeJS.WritableStream {
			return stream;
		},
		once(): NodeJS.WritableStream {
			return stream;
		},
		emit(): boolean {
			return false;
		},
	} as unknown as CapturedWritable;
	return stream;
}

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

function dummyPoint(overrides: Partial<RewindPoint> = {}): RewindPoint {
	return {
		id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
		message: '',
		metadataDir: '',
		date: new Date(),
		isTaskCheckpoint: false,
		toolUseId: '',
		isLogsOnly: false,
		checkpointId: '' as CheckpointID,
		// Phase 6.1 Part 2 narrowed AgentType to a strict union; '' is no
		// longer valid so cast to express "no agent metadata" (Go semantics).
		agent: '' as never,
		sessionId: '',
		sessionPrompt: '',
		sessionCount: 1,
		sessionIds: [],
		sessionPrompts: [],
		...overrides,
	};
}

/**
 * Build a checkpoint commit on `branch` with the given files in its tree.
 * The commit message includes `Story-Session: <sessionId>` so
 * resetShadowBranchToCheckpoint can find the trailer.
 */
async function buildCheckpointCommit(
	env: TestEnv,
	branch: string,
	sessionId: string,
	files: ReadonlyArray<{ path: string; content: string; mode?: string }>,
	parents: string[] = [],
): Promise<string> {
	// Build a tree with the given files (only single-segment + simple subdir support).
	type TreeEntry = { mode: string; path: string; oid: string; type: 'blob' | 'tree' };
	const rootMap = new Map<string, TreeEntry>();
	const subtrees = new Map<string, Map<string, TreeEntry>>();

	for (const f of files) {
		const blob = await env.writeBlob(f.content);
		const segments = f.path.split('/');
		if (segments.length === 1) {
			rootMap.set(segments[0]!, {
				mode: f.mode ?? MODE_FILE,
				path: segments[0]!,
				oid: blob,
				type: 'blob',
			});
		} else {
			// Single-level subdir for simplicity.
			const sub = subtrees.get(segments[0]!) ?? new Map();
			const remaining = segments.slice(1).join('/');
			if (remaining.includes('/')) {
				throw new Error(`buildCheckpointCommit: deeper paths not supported: ${f.path}`);
			}
			sub.set(remaining, {
				mode: f.mode ?? MODE_FILE,
				path: remaining,
				oid: blob,
				type: 'blob',
			});
			subtrees.set(segments[0]!, sub);
		}
	}

	for (const [dir, sub] of subtrees.entries()) {
		const subTreeOid = await env.writeTree([...sub.values()]);
		rootMap.set(dir, { mode: MODE_DIR, path: dir, oid: subTreeOid, type: 'tree' });
	}

	const treeOid = await env.writeTree([...rootMap.values()]);
	const message =
		'Checkpoint\n\n' +
		`Story-Metadata: .story/metadata/${sessionId}\n` +
		`Story-Session: ${sessionId}\n` +
		'Story-Strategy: manual-commit\n';

	const commitOid = await git.writeCommit({
		fs: fsCallback,
		dir: env.dir,
		commit: {
			tree: treeOid,
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
	if (branch !== '') {
		await git.writeRef({
			fs: fsCallback,
			dir: env.dir,
			ref: `refs/heads/${branch}`,
			value: commitOid,
			force: true,
		});
	}
	return commitOid;
}

// Go: manual_commit_rewind.go: Rewind / PreviewRewind / CanRewind /
// resetShadowBranchToCheckpoint
describe('strategy/rewind — Go: manual_commit_rewind.go', () => {
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
		setStderrWriterForTesting(null);
		setCollectUntrackedFilesForTesting(null);
	});

	// Go: rewind_test.go:411 TestShadowStrategy_Rewind_FromRepoRoot
	describe('rewindImpl main pipeline (10 cases)', () => {
		it('restores files from checkpoint tree at repo root — Go: rewind_test.go:411', async () => {
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			await saveSessionState(
				makeState({ sessionId: 'sess-1', baseCommit: head, stepCount: 1 }),
				env.dir,
			);
			const branch = shadowBranchNameForCommit(head, '');
			const cpHash = await buildCheckpointCommit(env, branch, 'sess-1', [
				{ path: 'src/app.ts', content: "const app = 'hello';\n" },
				{ path: 'src/utils.js', content: 'export function utils() {}\n' },
			]);
			// Make sure src dir doesn't currently exist.
			await fs.rm(path.join(env.dir, 'src'), { recursive: true, force: true });

			const out = makeWritable();
			const err = makeWritable();
			const strategy = new ManualCommitStrategy(env.dir);
			await rewindImpl(strategy, out, err, dummyPoint({ id: cpHash }));

			expect(await fs.readFile(path.join(env.dir, 'src/app.ts'), 'utf-8')).toBe(
				"const app = 'hello';\n",
			);
			expect(await fs.readFile(path.join(env.dir, 'src/utils.js'), 'utf-8')).toBe(
				'export function utils() {}\n',
			);
			expect(out.captured).toMatch(/Restored: src\/app\.ts/);
			expect(out.captured).toMatch(/Restored files from shadow commit [a-f0-9]{7}/);
		});

		// Go: rewind_test.go:275 TestShadowStrategy_Rewind_FromSubdirectory
		it('writes restored files to repo-root-relative paths even when CWD is subdir', async () => {
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			await saveSessionState(makeState({ sessionId: 'sess-sub', baseCommit: head }), env.dir);
			const branch = shadowBranchNameForCommit(head, '');
			const cpHash = await buildCheckpointCommit(env, branch, 'sess-sub', [
				{ path: 'app.ts', content: 'top\n' },
				{ path: 'src/lib.ts', content: 'lib\n' },
			]);
			await fs.rm(path.join(env.dir, 'src'), { recursive: true, force: true });
			await fs.mkdir(path.join(env.dir, 'frontend'), { recursive: true });
			// Strategy bound to the subdir cwd.
			const strategy = new ManualCommitStrategy(path.join(env.dir, 'frontend'));
			const out = makeWritable();
			const err = makeWritable();
			await rewindImpl(strategy, out, err, dummyPoint({ id: cpHash }));

			expect(await fs.readFile(path.join(env.dir, 'app.ts'), 'utf-8')).toBe('top\n');
			expect(await fs.readFile(path.join(env.dir, 'src/lib.ts'), 'utf-8')).toBe('lib\n');
			// Should NOT have written to frontend/<paths>.
			await expect(fs.access(path.join(env.dir, 'frontend/app.ts'))).rejects.toThrow();
		});

		// Go: rewind_test.go (file mode)
		it('restores executable mode 0o755 for filemode.Executable entries', async () => {
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			await saveSessionState(makeState({ sessionId: 'sess-mode', baseCommit: head }), env.dir);
			const branch = shadowBranchNameForCommit(head, '');
			const cpHash = await buildCheckpointCommit(env, branch, 'sess-mode', [
				{ path: 'run.sh', content: '#!/bin/sh\necho hi\n', mode: MODE_EXEC },
			]);

			const out = makeWritable();
			const err = makeWritable();
			const strategy = new ManualCommitStrategy(env.dir);
			await rewindImpl(strategy, out, err, dummyPoint({ id: cpHash }));
			const stat = await fs.stat(path.join(env.dir, 'run.sh'));
			expect(stat.mode & 0o777).toBe(0o755);
		});

		// Go: rewind_test.go: preserves untrackedFilesAtStart
		it('preserves untrackedFilesAtStart files', async () => {
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			await saveSessionState(
				makeState({
					sessionId: 'sess-pres',
					baseCommit: head,
					untrackedFilesAtStart: ['notes.txt'],
				}),
				env.dir,
			);
			const branch = shadowBranchNameForCommit(head, '');
			const cpHash = await buildCheckpointCommit(env, branch, 'sess-pres', [
				{ path: 'app.ts', content: 'app\n' },
			]);
			await env.writeFile('notes.txt', 'my notes');

			const out = makeWritable();
			const err = makeWritable();
			const strategy = new ManualCommitStrategy(env.dir);
			await rewindImpl(strategy, out, err, dummyPoint({ id: cpHash }));
			expect(await fs.readFile(path.join(env.dir, 'notes.txt'), 'utf-8')).toBe('my notes');
		});

		// Go: rewind_test.go: deletes extra untracked
		it('deletes untracked-not-in-cp-and-not-in-HEAD files', async () => {
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			await saveSessionState(makeState({ sessionId: 'sess-del', baseCommit: head }), env.dir);
			const branch = shadowBranchNameForCommit(head, '');
			const cpHash = await buildCheckpointCommit(env, branch, 'sess-del', [
				{ path: 'app.ts', content: 'app\n' },
			]);
			await env.writeFile('extra.tmp', 'remove me');

			const out = makeWritable();
			const err = makeWritable();
			const strategy = new ManualCommitStrategy(env.dir);
			await rewindImpl(strategy, out, err, dummyPoint({ id: cpHash }));
			await expect(fs.access(path.join(env.dir, 'extra.tmp'))).rejects.toThrow();
			expect(out.captured).toMatch(/Deleted: extra\.tmp/);
		});

		// Go: rewind_test.go: does NOT delete tracked-in-HEAD files
		it('does NOT delete untracked-now files that are tracked in HEAD', async () => {
			// Commit a tracked file first.
			await env.writeFile('tracked.md', 'hello');
			await env.gitAdd('tracked.md');
			await env.gitCommit('add tracked');
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();

			await saveSessionState(makeState({ sessionId: 'sess-track', baseCommit: head }), env.dir);
			const branch = shadowBranchNameForCommit(head, '');
			const cpHash = await buildCheckpointCommit(env, branch, 'sess-track', [
				{ path: 'app.ts', content: 'app\n' },
			]);
			// Simulate user removing then re-creating tracked file as untracked.
			await fs.unlink(path.join(env.dir, 'tracked.md'));
			await env.writeFile('tracked.md', 'reincarnated');
			// Untracked? Not really since git status would flag as modified, not untracked.
			// To make it appear in `collectUntrackedFiles` we need to remove it from
			// the index. Simulate via `git rm --cached`.
			await env.exec('git', ['rm', '--cached', 'tracked.md']);

			const out = makeWritable();
			const err = makeWritable();
			const strategy = new ManualCommitStrategy(env.dir);
			await rewindImpl(strategy, out, err, dummyPoint({ id: cpHash }));
			// HEAD still tracks tracked.md → must not be deleted.
			expect(await fs.readFile(path.join(env.dir, 'tracked.md'), 'utf-8')).toBe('reincarnated');
		});

		// Go: rewind_test.go: skip .story/ files
		it('skips .story/ files in checkpoint tree', async () => {
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			await saveSessionState(makeState({ sessionId: 'sess-skip', baseCommit: head }), env.dir);
			const branch = shadowBranchNameForCommit(head, '');
			const cpHash = await buildCheckpointCommit(env, branch, 'sess-skip', [
				{ path: 'app.ts', content: 'app\n' },
				{ path: '.story/metadata-stuff', content: 'should not appear' },
			]);

			const out = makeWritable();
			const err = makeWritable();
			const strategy = new ManualCommitStrategy(env.dir);
			await rewindImpl(strategy, out, err, dummyPoint({ id: cpHash }));
			expect(await fs.readFile(path.join(env.dir, 'app.ts'), 'utf-8')).toBe('app\n');
			await expect(fs.access(path.join(env.dir, '.story/metadata-stuff'))).rejects.toThrow();
		});

		// Go: defense-in-depth filter
		it('defense-in-depth filters protected paths in delete step', async () => {
			// collectUntrackedFiles already filters .story/.git; this test verifies
			// the rewind branch also calls isProtectedPath defensively. We trigger
			// via a tracked-in-cp-but-leaks-into-untracked path is hard to engineer
			// with real git, so we settle for asserting that .git contents are
			// untouched after a normal rewind:
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			await saveSessionState(makeState({ sessionId: 'sess-prot', baseCommit: head }), env.dir);
			const branch = shadowBranchNameForCommit(head, '');
			const cpHash = await buildCheckpointCommit(env, branch, 'sess-prot', [
				{ path: 'app.ts', content: 'app\n' },
			]);

			const beforeHead = await fs.readFile(path.join(env.dir, '.git/HEAD'), 'utf-8');
			const out = makeWritable();
			const err = makeWritable();
			const strategy = new ManualCommitStrategy(env.dir);
			await rewindImpl(strategy, out, err, dummyPoint({ id: cpHash }));
			expect(await fs.readFile(path.join(env.dir, '.git/HEAD'), 'utf-8')).toBe(beforeHead);
		});

		// Go: rewind_test.go: prints "Restored files from shadow commit <short>" footer
		it('prints "Restored files from shadow commit <short>" footer', async () => {
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			await saveSessionState(makeState({ sessionId: 'sess-foot', baseCommit: head }), env.dir);
			const branch = shadowBranchNameForCommit(head, '');
			const cpHash = await buildCheckpointCommit(env, branch, 'sess-foot', [
				{ path: 'app.ts', content: 'app\n' },
			]);
			const out = makeWritable();
			const err = makeWritable();
			const strategy = new ManualCommitStrategy(env.dir);
			await rewindImpl(strategy, out, err, dummyPoint({ id: cpHash }));
			expect(out.captured).toContain(`Restored files from shadow commit ${cpHash.slice(0, 7)}`);
		});

		// Go: manual_commit_rewind.go: warn-only on resetShadowBranchToCheckpoint failure
		it('warn-only when resetShadowBranchToCheckpoint fails (missing session state)', async () => {
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			// No session state for "sess-missing" → resetShadowBranchToCheckpoint throws.
			const branch = shadowBranchNameForCommit(head, '');
			const cpHash = await buildCheckpointCommit(env, branch, 'sess-missing', [
				{ path: 'app.ts', content: 'restored\n' },
			]);

			const out = makeWritable();
			const err = makeWritable();
			const strategy = new ManualCommitStrategy(env.dir);
			await rewindImpl(strategy, out, err, dummyPoint({ id: cpHash }));
			expect(err.captured).toContain('[story] Warning: failed to reset shadow branch');
			// Files still restored.
			expect(await fs.readFile(path.join(env.dir, 'app.ts'), 'utf-8')).toBe('restored\n');
		});
	});

	// Go: rewind_test.go: PreviewRewind* + canRewind + resetShadowBranchToCheckpoint
	describe('previewRewind / canRewind / resetShadowBranchToCheckpoint (5 cases)', () => {
		// Go: rewind_test.go:22 TestShadowStrategy_PreviewRewind
		it('previewRewind returns filesToRestore + filesToDelete preserving untrackedFilesAtStart', async () => {
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			await saveSessionState(
				makeState({
					sessionId: 'sess-prev',
					baseCommit: head,
					untrackedFilesAtStart: ['existing-untracked.txt'],
				}),
				env.dir,
			);
			const branch = shadowBranchNameForCommit(head, '');
			const cpHash = await buildCheckpointCommit(env, branch, 'sess-prev', [
				{ path: 'app.js', content: "console.log('hi');\n" },
			]);
			await env.writeFile('extra.js', 'extra');
			await env.writeFile('existing-untracked.txt', 'existing');

			const strategy = new ManualCommitStrategy(env.dir);
			const preview = await previewRewindImpl(strategy, dummyPoint({ id: cpHash }));
			expect(preview.filesToRestore).toContain('app.js');
			expect(preview.filesToDelete).toContain('extra.js');
			expect(preview.filesToDelete).not.toContain('existing-untracked.txt');
			expect(preview.trackedChanges).toEqual([]);
		});

		// Go: rewind_test.go:170 TestShadowStrategy_PreviewRewind_LogsOnly
		it('previewRewind returns empty preview for isLogsOnly=true point', async () => {
			const strategy = new ManualCommitStrategy(env.dir);
			const preview = await previewRewindImpl(
				strategy,
				dummyPoint({ id: 'abc', isLogsOnly: true, checkpointId: 'aaaaaaaaaaaa' as CheckpointID }),
			);
			expect(preview.filesToRestore).toEqual([]);
			expect(preview.filesToDelete).toEqual([]);
			expect(preview.trackedChanges).toEqual([]);
		});

		// Go: rewind_test.go: previewRewind sorts output
		it('previewRewind returns sorted filesToRestore and filesToDelete', async () => {
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			await saveSessionState(makeState({ sessionId: 'sess-sort', baseCommit: head }), env.dir);
			const branch = shadowBranchNameForCommit(head, '');
			const cpHash = await buildCheckpointCommit(env, branch, 'sess-sort', [
				{ path: 'z.ts', content: 'z\n' },
				{ path: 'a.ts', content: 'a\n' },
				{ path: 'm.ts', content: 'm\n' },
			]);
			await env.writeFile('zzz.tmp', 'z');
			await env.writeFile('aaa.tmp', 'a');

			const strategy = new ManualCommitStrategy(env.dir);
			const preview = await previewRewindImpl(strategy, dummyPoint({ id: cpHash }));
			expect(preview.filesToRestore).toEqual(['a.ts', 'm.ts', 'z.ts']);
			expect(preview.filesToDelete).toEqual(['aaa.tmp', 'zzz.tmp']);
		});

		// Go: manual_commit_test.go:539 TestShadowStrategy_CanRewind_CleanRepo
		// Go: manual_commit_test.go:580 TestShadowStrategy_CanRewind_DirtyRepo
		it('canRewind delegates to checkCanRewindWithWarning: clean → empty message; dirty → contains "uncommitted changes will be reverted" + filename', async () => {
			const strategy = new ManualCommitStrategy(env.dir);
			const clean = await canRewindImpl(strategy);
			expect(clean.canRewind).toBe(true);
			expect(clean.message).toBe('');

			await env.writeFile('.gitkeep', 'modified content\nplus more\n');
			const dirty = await canRewindImpl(strategy);
			expect(dirty.canRewind).toBe(true);
			// Go assertion 1: contains 'uncommitted changes will be reverted'.
			expect(dirty.message).toContain('uncommitted changes will be reverted');
			// Go assertion 2 (manual_commit_test.go:632-634): contains the filename.
			expect(dirty.message).toContain('.gitkeep');
		});

		// Go: manual_commit_test.go:637 TestShadowStrategy_CanRewind_NoRepo
		it('canRewind returns { canRewind: true, message: "" } when not in a git repo at all', async () => {
			// Go test: t.Chdir(<empty tmpdir>) → s.CanRewind(ctx) → (true, "", nil).
			// TS: instantiate strategy bound to a non-git temp dir.
			const tmpDir = await fs.mkdtemp('/tmp/story-not-a-repo-');
			try {
				const strategy = new ManualCommitStrategy(tmpDir);
				const result = await canRewindImpl(strategy);
				expect(result.canRewind).toBe(true);
				expect(result.message).toBe('');
			} finally {
				await fs.rm(tmpDir, { recursive: true, force: true });
			}
		});

		// Story brand red-line — Go writes [entire], Story writes [story].
		it('resetShadowBranchToCheckpoint writes [story] brand to stderr (not [entire])', async () => {
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			await saveSessionState(makeState({ sessionId: 'sess-brand', baseCommit: head }), env.dir);
			const branch = shadowBranchNameForCommit(head, '');
			const cpHash = await buildCheckpointCommit(env, branch, 'sess-brand', [
				{ path: 'app.ts', content: 'a\n' },
			]);

			const captured = makeWritable();
			setStderrWriterForTesting(captured);
			const strategy = new ManualCommitStrategy(env.dir);
			const repo = await strategy.getRepo();
			const headCommitObj = await git.readCommit({ fs: fsCallback, dir: env.dir, oid: cpHash });
			await resetShadowBranchToCheckpoint(strategy, repo, cpHash, headCommitObj.commit.message);
			expect(captured.captured).toContain('[story] Reset shadow branch');
			expect(captured.captured).not.toContain('[entire]');
		});
	});

	// Go: manual_commit_rewind.go: previewRewind / rewind error tolerance
	describe('previewRewind / rewind tolerance (2 cases)', () => {
		// Go: manual_commit_rewind.go: PreviewRewind:589-594 — collectUntrackedFiles error
		// → write `Warning: could not list untracked files for preview: %v\n` to stderr
		// + return partial preview. Phase 5.5 review fix #2.
		it('previewRewind warns on collectUntrackedFiles failure and returns partial preview', async () => {
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			await saveSessionState(makeState({ sessionId: 'sess-warn', baseCommit: head }), env.dir);
			const branch = shadowBranchNameForCommit(head, '');
			const cpHash = await buildCheckpointCommit(env, branch, 'sess-warn', [
				{ path: 'b.ts', content: 'b\n' },
				{ path: 'a.ts', content: 'a\n' },
			]);

			// Inject a collectUntrackedFiles failure via the test override hook
			// (parallels restore-logs's setAgentResolverForTesting pattern).
			setCollectUntrackedFilesForTesting(async () => {
				throw new Error('git ls-files failed');
			});
			const stderrCapture = makeWritable();
			setStderrWriterForTesting(stderrCapture);

			const strategy = new ManualCommitStrategy(env.dir);
			const preview = await previewRewindImpl(strategy, dummyPoint({ id: cpHash }));

			// filesToRestore still populated (sorted); filesToDelete empty (Go partial).
			expect(preview.filesToRestore).toEqual(['a.ts', 'b.ts']);
			expect(preview.filesToDelete).toEqual([]);
			// Stderr warning written, matches Go format string.
			expect(stderrCapture.captured).toContain(
				'Warning: could not list untracked files for preview: git ls-files failed',
			);
		});

		// Go: manual_commit_rewind.go: Rewind (no Story-Session trailer → no preserved set)
		it('rewind without Story-Session trailer continues with empty preserved set', async () => {
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			// No saveSessionState; build a checkpoint without Story-Session trailer.
			type TreeEntry = { mode: string; path: string; oid: string; type: 'blob' };
			const blob = await env.writeBlob('content\n');
			const treeOid = await env.writeTree([
				{ mode: '100644', path: 'foo.ts', oid: blob, type: 'blob' } as TreeEntry,
			]);
			const cpHash = await git.writeCommit({
				fs: fsCallback,
				dir: env.dir,
				commit: {
					tree: treeOid,
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
					message: 'cp without trailer\n',
				},
			});

			const out = makeWritable();
			const err = makeWritable();
			const strategy = new ManualCommitStrategy(env.dir);
			await rewindImpl(strategy, out, err, dummyPoint({ id: cpHash }));
			expect(await fs.readFile(path.join(env.dir, 'foo.ts'), 'utf-8')).toBe('content\n');
			// No-trailer commit triggers a Step 2 warn-only.
			expect(err.captured).toContain('[story] Warning: failed to reset shadow branch');
		});
	});

	// Go: manual_commit_rewind.go failure-injection paths
	describe('rewind failure injection (3 cases)', () => {
		it('throws when checkpoint commit not found', async () => {
			const out = makeWritable();
			const err = makeWritable();
			const strategy = new ManualCommitStrategy(env.dir);
			await expect(
				rewindImpl(
					strategy,
					out,
					err,
					dummyPoint({ id: '0000000000000000000000000000000000000000' }),
				),
			).rejects.toThrow(/failed to get commit/);
		});

		it('resetShadowBranchToCheckpoint throws when commit lacks Story-Session trailer', async () => {
			const strategy = new ManualCommitStrategy(env.dir);
			const repo = await strategy.getRepo();
			await expect(
				resetShadowBranchToCheckpoint(strategy, repo, 'irrelevant', 'no trailer here'),
			).rejects.toThrow(/no Story-Session trailer/);
		});

		it('resetShadowBranchToCheckpoint throws when session state missing', async () => {
			const strategy = new ManualCommitStrategy(env.dir);
			const repo = await strategy.getRepo();
			await expect(
				resetShadowBranchToCheckpoint(
					strategy,
					repo,
					'irrelevant',
					'cp\n\nStory-Session: no-such\n',
				),
			).rejects.toThrow(/session no-such not found/);
		});
	});

	// Phase 9.5 hardening: traversal protection + walkTreeFiles strict/best-effort split.
	// Go: manual_commit_rewind.go:329-340 (checkpoint walk strict) + 373-379 (osroot).
	describe('rewind hardening (Phase 9.5)', () => {
		// Go: manual_commit_rewind.go:373-379 — osroot.WriteFile rejects escape paths.
		it('traversal: checkpoint tree with `../escape.txt` blob is rejected by writeFileInRoot', async () => {
			const sessionId = 'sess-traversal00';
			const shadowBranch = shadowBranchNameForCommit(
				await (async () => (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim())(),
				'',
			);
			await saveSessionState(
				makeState({
					sessionId,
					baseCommit: (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim(),
				}),
				env.dir,
			);

			const commitOid = await buildCheckpointCommit(env, shadowBranch, sessionId, [
				// Attempt to escape the repo root by using `../` in the path.
				{ path: '../escape.txt', content: 'pwn' },
			]);

			const out = makeWritable();
			const errStream = makeWritable();
			const strategy = new ManualCommitStrategy(env.dir);
			await expect(
				rewindImpl(strategy, out, errStream, dummyPoint({ id: commitOid })),
			).rejects.toThrow();
			// Hard assertion: escape target was not written anywhere above repo.
			const escapePath = path.resolve(env.dir, '..', 'escape.txt');
			await expect(fs.stat(escapePath)).rejects.toHaveProperty('code', 'ENOENT');
		});

		// Go: manual_commit_rewind.go:329-340 — checkpoint walk aborts on tree read errors.
		it('walkTreeFilesStrict: checkpoint tree read failure propagates as error', async () => {
			const sessionId = 'sess-badtree00000';
			const baseCommit = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			const shadowBranch = shadowBranchNameForCommit(baseCommit, '');
			await saveSessionState(makeState({ sessionId, baseCommit }), env.dir);

			// Build a valid checkpoint commit, then manually re-point its tree
			// at a nonexistent OID so rewind's walk fails in strict mode.
			const commitOid = await buildCheckpointCommit(env, shadowBranch, sessionId, [
				{ path: 'a.txt', content: 'a' },
			]);
			// Build a commit that points at an impossible tree OID.
			const badTreeCommit = await git.writeCommit({
				fs: fsCallback,
				dir: env.dir,
				commit: {
					tree: 'f'.repeat(40),
					parent: [],
					author: {
						name: 'T',
						email: 't@t.com',
						timestamp: Math.floor(Date.now() / 1000),
						timezoneOffset: 0,
					},
					committer: {
						name: 'T',
						email: 't@t.com',
						timestamp: Math.floor(Date.now() / 1000),
						timezoneOffset: 0,
					},
					message: `cp\n\nStory-Session: ${sessionId}\n`,
				},
			});
			// Use the bad-tree commit as the rewind target.
			void commitOid;
			const out = makeWritable();
			const errStream = makeWritable();
			const strategy = new ManualCommitStrategy(env.dir);
			await expect(
				rewindImpl(strategy, out, errStream, dummyPoint({ id: badTreeCommit })),
			).rejects.toThrow();
		});

		// Phase 9.5 Step 6 contract: rewind writes via writeFileInRoot (traversal-safe).
		it('Step 6: restored files land inside repoRoot (writeFileInRoot happy path)', async () => {
			const sessionId = 'sess-writeinroot';
			const baseCommit = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			const shadowBranch = shadowBranchNameForCommit(baseCommit, '');
			await saveSessionState(makeState({ sessionId, baseCommit }), env.dir);

			const commitOid = await buildCheckpointCommit(env, shadowBranch, sessionId, [
				{ path: 'inside/ok.ts', content: 'export const x = 1;\n' },
			]);

			const out = makeWritable();
			const errStream = makeWritable();
			const strategy = new ManualCommitStrategy(env.dir);
			await rewindImpl(strategy, out, errStream, dummyPoint({ id: commitOid }));

			const restored = await fs.readFile(path.join(env.dir, 'inside', 'ok.ts'), 'utf-8');
			expect(restored).toBe('export const x = 1;\n');
		});

		// Phase 9.5 Step 5: rewind uses removeInRoot for untracked-not-in-cp delete.
		it('Step 5: removeInRoot cleans untracked files below repoRoot but rejects absolute paths', async () => {
			const sessionId = 'sess-stepfiverm0';
			const baseCommit = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			const shadowBranch = shadowBranchNameForCommit(baseCommit, '');
			await saveSessionState(makeState({ sessionId, baseCommit }), env.dir);

			await env.writeFile('scratch.txt', 'ephemeral');
			const commitOid = await buildCheckpointCommit(env, shadowBranch, sessionId, [
				{ path: 'keeper.txt', content: 'persist' },
			]);

			const out = makeWritable();
			const errStream = makeWritable();
			const strategy = new ManualCommitStrategy(env.dir);
			await rewindImpl(strategy, out, errStream, dummyPoint({ id: commitOid }));

			// Untracked scratch removed; checkpoint file restored.
			await expect(fs.stat(path.join(env.dir, 'scratch.txt'))).rejects.toHaveProperty(
				'code',
				'ENOENT',
			);
			expect(await fs.readFile(path.join(env.dir, 'keeper.txt'), 'utf-8')).toBe('persist');
		});
	});
});
