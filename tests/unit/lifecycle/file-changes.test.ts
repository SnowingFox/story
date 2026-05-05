/**
 * Phase 7 Part 1 `src/lifecycle/file-changes.ts` — 14 case.
 *
 * Go 参考：`cmd/entire/cli/state_test.go`:
 * - `TestDetectFileChanges_NewAndDeletedFiles`
 * - `TestDetectFileChanges_DeletedFilesWithNilPreState`
 * - `TestDetectFileChanges_NoChanges`
 * - `TestDetectFileChanges_NilPreviouslyUntracked_ReturnsModified`
 * - `TestFilterAndNormalizePaths_SiblingDirectories`
 * - `TestMergeUnique` (2 sub)
 * - `TestFilterToUncommittedFiles_ReallyModified`
 *
 * Story 补充: infrastructure path filtering, non-ASCII paths, error branches
 * (`detectFileChanges` throws, `filterToUncommittedFiles` fail-open,
 * `getUntrackedFilesForState` fail-safe).
 *
 * Each `it()` is annotated with `// Go: <anchor>` for traceability.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	detectFileChanges,
	filterAndNormalizePaths,
	filterToUncommittedFiles,
	getUntrackedFilesForState,
	mergeUnique,
} from '@/lifecycle/file-changes';
import { clearWorktreeRootCache } from '@/paths';

vi.mock('node:fs/promises', async () => {
	const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
	return {
		...actual,
		readFile: vi.fn(actual.readFile),
	};
});

/**
 * Build a porcelain `-z` payload by joining entries with NUL separators.
 * Every entry becomes `XY<space>path` with a trailing NUL, matching git's
 * actual output format.
 */
function porcelainZ(...entries: string[]): string {
	return `${entries.join('\0')}\0`;
}

describe('lifecycle/file-changes', () => {
	beforeEach(() => {
		clearWorktreeRootCache();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		clearWorktreeRootCache();
	});

	// Go: state_test.go: TestDetectFileChanges_NewAndDeletedFiles
	it('detectFileChanges segregates M / ?? / D correctly', async () => {
		const paths = await import('@/paths');
		vi.spyOn(paths, 'worktreeRoot').mockResolvedValue('/repo');
		const git = await import('@/git');
		vi.spyOn(git, 'execGit').mockResolvedValue(porcelainZ('M  a', '?? b', ' D c', 'A  d'));

		const result = await detectFileChanges([]);
		expect(result.modified).toEqual(['a', 'd']);
		expect(result.new).toEqual(['b']);
		expect(result.deleted).toEqual(['c']);
	});

	// Go: state_test.go: TestDetectFileChanges_DeletedFilesWithNilPreState
	it('deleted files are detected without pre-state', async () => {
		const paths = await import('@/paths');
		vi.spyOn(paths, 'worktreeRoot').mockResolvedValue('/repo');
		const git = await import('@/git');
		vi.spyOn(git, 'execGit').mockResolvedValue(porcelainZ(' D x'));

		const result = await detectFileChanges([]);
		expect(result).toEqual({ modified: [], new: [], deleted: ['x'] });
	});

	// Go: state_test.go: TestDetectFileChanges_NoChanges
	it('no changes → all buckets empty', async () => {
		const paths = await import('@/paths');
		vi.spyOn(paths, 'worktreeRoot').mockResolvedValue('/repo');
		const git = await import('@/git');
		vi.spyOn(git, 'execGit').mockResolvedValue('');

		const result = await detectFileChanges([]);
		expect(result).toEqual({ modified: [], new: [], deleted: [] });
	});

	// Go: state_test.go: TestDetectFileChanges_NilPreviouslyUntracked_ReturnsModified
	it('?? files with undefined previouslyUntracked → treated as new', async () => {
		const paths = await import('@/paths');
		vi.spyOn(paths, 'worktreeRoot').mockResolvedValue('/repo');
		const git = await import('@/git');
		vi.spyOn(git, 'execGit').mockResolvedValue(porcelainZ('?? x'));

		const result = await detectFileChanges();
		expect(result.new).toEqual(['x']);
		expect(result.modified).toEqual([]);
	});

	// Go: state.go: FilterAndNormalizePaths (.story/ drop; Story 补充)
	it('detectFileChanges filters .story/ infrastructure paths from all 3 buckets', async () => {
		const paths = await import('@/paths');
		vi.spyOn(paths, 'worktreeRoot').mockResolvedValue('/repo');
		const git = await import('@/git');
		vi.spyOn(git, 'execGit').mockResolvedValue(
			porcelainZ('M  .story/metadata/foo.json', '?? .story/tmp/x', ' D .story/sessions/y'),
		);

		const result = await detectFileChanges([]);
		expect(result.modified).toEqual([]);
		expect(result.new).toEqual([]);
		expect(result.deleted).toEqual([]);
	});

	// Go: state.go: DetectFileChanges (NUL-delimiter + non-ASCII path; Story 补充)
	it('detectFileChanges respects NUL-delimiter (non-ASCII path)', async () => {
		const paths = await import('@/paths');
		vi.spyOn(paths, 'worktreeRoot').mockResolvedValue('/repo');
		const git = await import('@/git');
		vi.spyOn(git, 'execGit').mockResolvedValue(porcelainZ('M  src/app-中文.ts'));

		const result = await detectFileChanges([]);
		expect(result.modified).toEqual(['src/app-中文.ts']);
	});

	// Go: state.go: DetectFileChanges (error branch; Story 补充)
	it('detectFileChanges throws when git status errors', async () => {
		const paths = await import('@/paths');
		vi.spyOn(paths, 'worktreeRoot').mockResolvedValue('/repo');
		const git = await import('@/git');
		vi.spyOn(git, 'execGit').mockRejectedValue(new Error('boom'));

		await expect(detectFileChanges([])).rejects.toThrow('boom');
	});

	// Go: state_test.go: TestFilterAndNormalizePaths_SiblingDirectories
	it('filterAndNormalizePaths handles sibling directories', () => {
		const result = filterAndNormalizePaths(['/a/b/f.ts', '/c/g.ts'], '/a');
		expect(result).toEqual(['b/f.ts']);
	});

	// Go: state.go: FilterAndNormalizePaths (.story/ drop branch; Story 补充)
	it('filterAndNormalizePaths drops .story/ paths', () => {
		const result = filterAndNormalizePaths(['.story/tmp/x', 'src/a.ts'], '/repo');
		expect(result).toEqual(['src/a.ts']);
	});

	// Go: state_test.go: TestMergeUnique (preserves order + dedupes)
	it('mergeUnique preserves order + dedupes', () => {
		expect(mergeUnique(['a', 'b'], ['c', 'a'])).toEqual(['a', 'b', 'c']);
	});

	// Go: state_test.go: TestMergeUnique (empty inputs)
	it('mergeUnique handles empty arrays', () => {
		expect(mergeUnique([], [])).toEqual([]);
		expect(mergeUnique(['a'], [])).toEqual(['a']);
		expect(mergeUnique([], ['a'])).toEqual(['a']);
	});

	// Go: state_test.go: TestFilterToUncommittedFiles_ReallyModified
	it('filterToUncommittedFiles keeps committed+modified file (HEAD differs from worktree)', async () => {
		const git = await import('@/git');
		vi.spyOn(git, 'execGit').mockResolvedValue('ref: refs/heads/main');
		vi.spyOn(git, 'readGitBlob').mockImplementation(async (spec) => {
			if (spec === 'HEAD:a') {
				return Buffer.from('committed\n');
			}
			throw new Error('not in HEAD');
		});
		const fs = await import('node:fs/promises');
		const readFileMock = fs.readFile as unknown as ReturnType<typeof vi.fn>;
		readFileMock.mockImplementation(async (p: unknown) => {
			if (typeof p === 'string' && p.endsWith('/a')) {
				return Buffer.from('modified\n');
			}
			throw new Error('unexpected read');
		});

		// 'a' is in HEAD but worktree differs → keep; 'b' not in HEAD → keep
		const result = await filterToUncommittedFiles(['a', 'b'], '/repo');
		expect(result).toEqual(['a', 'b']);
	});

	// Go: state_test.go: TestFilterToUncommittedFiles_ReallyModified (content-equal branch)
	it('filterToUncommittedFiles drops files whose worktree bytes match HEAD', async () => {
		const git = await import('@/git');
		vi.spyOn(git, 'execGit').mockResolvedValue('ref: refs/heads/main');
		vi.spyOn(git, 'readGitBlob').mockImplementation(async (spec) => {
			if (spec === 'HEAD:a') {
				return Buffer.from('same-bytes');
			}
			throw new Error('not in HEAD');
		});
		const fs = await import('node:fs/promises');
		const readFileMock = fs.readFile as unknown as ReturnType<typeof vi.fn>;
		readFileMock.mockImplementation(async (p: unknown) => {
			if (typeof p === 'string' && p.endsWith('/a')) {
				return Buffer.from('same-bytes');
			}
			throw new Error('unexpected read');
		});

		// 'a' bytes equal → drop; 'b' not in HEAD → keep
		const result = await filterToUncommittedFiles(['a', 'b'], '/repo');
		expect(result).toEqual(['b']);
	});

	// Go: state.go: filterToUncommittedFiles (fail-open: HEAD missing; Story 补充)
	it('filterToUncommittedFiles fails open when HEAD does not exist', async () => {
		const git = await import('@/git');
		vi.spyOn(git, 'execGit').mockRejectedValue(new Error('no HEAD'));

		const result = await filterToUncommittedFiles(['a', 'b'], '/repo');
		expect(result).toEqual(['a', 'b']);
	});

	// Go: state.go filterToUncommittedFiles fail-open invariant (fs.readFile reject)
	it('filterToUncommittedFiles keeps file when fs.readFile rejects (fail-open)', async () => {
		const git = await import('@/git');
		vi.spyOn(git, 'execGit').mockResolvedValue('ref: refs/heads/main');
		vi.spyOn(git, 'readGitBlob').mockResolvedValue(Buffer.from('head'));
		const fs = await import('node:fs/promises');
		const readFileMock = fs.readFile as unknown as ReturnType<typeof vi.fn>;
		readFileMock.mockRejectedValueOnce(Object.assign(new Error('EACCES'), { code: 'EACCES' }));

		const result = await filterToUncommittedFiles(['a'], '/repo');
		expect(result).toEqual(['a']);
	});

	// Go: state.go filterToUncommittedFiles fail-open invariant (readGitBlob reject)
	it('filterToUncommittedFiles keeps file when readGitBlob rejects (fail-open)', async () => {
		const git = await import('@/git');
		vi.spyOn(git, 'execGit').mockResolvedValue('ref: refs/heads/main');
		vi.spyOn(git, 'readGitBlob').mockRejectedValue(new Error('blob not found'));
		const fs = await import('node:fs/promises');
		const readFileMock = fs.readFile as unknown as ReturnType<typeof vi.fn>;
		readFileMock.mockResolvedValueOnce(Buffer.from('worktree-bytes'));

		const result = await filterToUncommittedFiles(['only-in-worktree.ts'], '/repo');
		expect(result).toEqual(['only-in-worktree.ts']);
	});

	// Go: state.go: filterToUncommittedFiles (empty input short-circuit; Story 补充)
	it('filterToUncommittedFiles returns [] for empty input without spawning git', async () => {
		const git = await import('@/git');
		const execSpy = vi.spyOn(git, 'execGit');

		const result = await filterToUncommittedFiles([], '/repo');
		expect(result).toEqual([]);
		expect(execSpy).not.toHaveBeenCalled();
	});

	// Go: state.go: getUntrackedFilesForState (error branch; Story 补充)
	it('getUntrackedFilesForState returns [] on git error + log.warn', async () => {
		const paths = await import('@/paths');
		vi.spyOn(paths, 'worktreeRoot').mockRejectedValue(new Error('no repo'));
		const log = await import('@/log');
		const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});

		const result = await getUntrackedFilesForState();
		expect(result).toEqual([]);
		expect(warnSpy).toHaveBeenCalledTimes(1);
	});

	// Go: state.go: getUntrackedFilesForState (success branch; Story 补充)
	it('getUntrackedFilesForState parses `??` porcelain entries only', async () => {
		const paths = await import('@/paths');
		vi.spyOn(paths, 'worktreeRoot').mockResolvedValue('/repo');
		const git = await import('@/git');
		vi.spyOn(git, 'execGit').mockResolvedValue(
			porcelainZ('?? foo.log', '?? bar/baz.tmp', 'M  already-tracked.ts'),
		);

		const result = await getUntrackedFilesForState();
		expect(result).toEqual(['foo.log', 'bar/baz.tmp']);
	});

	// Go: state.go getUntrackedFilesForState — filters out
	// `.story/` infrastructure paths via `paths.IsInfrastructurePath`.
	// Story's own scratch files (tmp snapshots, checkpoint cache) must
	// never appear in the baseline untracked list.
	it('getUntrackedFilesForState excludes .story/ infrastructure paths', async () => {
		const paths = await import('@/paths');
		vi.spyOn(paths, 'worktreeRoot').mockResolvedValue('/repo');
		const git = await import('@/git');
		vi.spyOn(git, 'execGit').mockResolvedValue(
			porcelainZ(
				'?? .story/tmp/pre-prompt-sid.json',
				'?? .story/checkpoint-cache/entry.json',
				'?? foo.log',
				'?? src/new-file.ts',
			),
		);

		const result = await getUntrackedFilesForState();
		expect(result).toEqual(['foo.log', 'src/new-file.ts']);
		expect(result).not.toContain('.story/tmp/pre-prompt-sid.json');
		expect(result).not.toContain('.story/checkpoint-cache/entry.json');
	});

	// Go: state.go: FilterAndNormalizePaths (empty-string guard; Story 补充)
	it('filterAndNormalizePaths skips empty string entries', () => {
		const result = filterAndNormalizePaths(['', 'src/a.ts', ''], '/repo');
		expect(result).toEqual(['src/a.ts']);
	});

	// Go: state_test.go: TestDetectFileChanges (rename two-entry form; Story 补充)
	it('detectFileChanges parses porcelain-z rename entries correctly (R <to>\\0<from>)', async () => {
		const paths = await import('@/paths');
		vi.spyOn(paths, 'worktreeRoot').mockResolvedValue('/repo');
		const git = await import('@/git');
		// git status --porcelain=v1 -z rename entry: "R  <to>\0<from>\0"
		// Here: old/foo.ts → new/foo.ts, plus an unrelated M other.ts entry
		vi.spyOn(git, 'execGit').mockResolvedValue(
			porcelainZ('R  new/foo.ts', 'old/foo.ts', 'M  other.ts'),
		);

		const result = await detectFileChanges([]);
		// <to> goes into modified, <from> goes into deleted, 'other.ts' stays modified
		expect(result.modified).toEqual(['new/foo.ts', 'other.ts']);
		expect(result.deleted).toEqual(['old/foo.ts']);
		expect(result.new).toEqual([]);
	});

	// Go: state_test.go: TestDetectFileChanges (copy two-entry form; Story 补充)
	it('detectFileChanges parses porcelain-z copy entries correctly (C <to>\\0<from>)', async () => {
		const paths = await import('@/paths');
		vi.spyOn(paths, 'worktreeRoot').mockResolvedValue('/repo');
		const git = await import('@/git');
		// Copy: <from> stays on disk unchanged, <to> is a new bytewise-identical file.
		// We still must consume the follow-up <from> entry so it isn't misparsed.
		vi.spyOn(git, 'execGit').mockResolvedValue(porcelainZ('C  dst.ts', 'src.ts', 'M  z.ts'));

		const result = await detectFileChanges([]);
		expect(result.modified).toEqual(['dst.ts', 'z.ts']);
		expect(result.deleted).toEqual([]);
		expect(result.new).toEqual([]);
	});

	// Go: state.go: DetectFileChanges (short-entry skip; Story 补充)
	it('detectFileChanges skips short porcelain entries (length < 3)', async () => {
		const paths = await import('@/paths');
		vi.spyOn(paths, 'worktreeRoot').mockResolvedValue('/repo');
		const git = await import('@/git');
		vi.spyOn(git, 'execGit').mockResolvedValue(`XY\0M  ok.ts\0`);

		const result = await detectFileChanges([]);
		expect(result.modified).toEqual(['ok.ts']);
		expect(result.new).toEqual([]);
		expect(result.deleted).toEqual([]);
	});
});
