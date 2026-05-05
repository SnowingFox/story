import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	branchExistsOnRemote,
	checkIgnore,
	checkoutBranch,
	clearGitCommonDirCache,
	diffTreeFileList,
	diffTreeFiles,
	execGit,
	extractStatus,
	getCurrentBranch,
	getFilesChangedInCommit,
	getGitAuthor,
	getGitCommonDir,
	getGitDir,
	getHeadCommit,
	hasTTY,
	hasUncommittedChanges,
	isGitSequenceOperation,
	isOnDefaultBranch,
	parseDiffTreeOutput,
	shouldSkipOnDefaultBranch,
} from '@/git';
import * as branches from '@/strategy/branches';
import { TestEnv } from '../helpers/test-env';

describe('isGitSequenceOperation', () => {
	let env: TestEnv;

	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
	});

	afterEach(async () => {
		await env.cleanup();
	});

	it('returns false in normal repo', async () => {
		expect(await isGitSequenceOperation(env.dir)).toBe(false);
	});

	it('returns true during rebase (rebase-merge)', async () => {
		await fs.mkdir(path.join(env.gitDir, 'rebase-merge'), { recursive: true });
		expect(await isGitSequenceOperation(env.dir)).toBe(true);
	});

	it('returns true during rebase (rebase-apply)', async () => {
		await fs.mkdir(path.join(env.gitDir, 'rebase-apply'), { recursive: true });
		expect(await isGitSequenceOperation(env.dir)).toBe(true);
	});

	it('returns true during cherry-pick', async () => {
		await fs.writeFile(path.join(env.gitDir, 'CHERRY_PICK_HEAD'), '');
		expect(await isGitSequenceOperation(env.dir)).toBe(true);
	});

	it('returns true during revert', async () => {
		await fs.writeFile(path.join(env.gitDir, 'REVERT_HEAD'), '');
		expect(await isGitSequenceOperation(env.dir)).toBe(true);
	});

	it('returns false after cleanup', async () => {
		await fs.mkdir(path.join(env.gitDir, 'rebase-apply'), { recursive: true });
		expect(await isGitSequenceOperation(env.dir)).toBe(true);
		await fs.rm(path.join(env.gitDir, 'rebase-apply'), { recursive: true });
		expect(await isGitSequenceOperation(env.dir)).toBe(false);
	});

	it('returns false for non-git directory', async () => {
		const os = await import('node:os');
		expect(await isGitSequenceOperation(os.tmpdir())).toBe(false);
	});

	it('detects rebase markers in linked worktree gitDir', async () => {
		const wtId = 'test-wt';
		const wtGitDir = path.join(env.gitDir, 'worktrees', wtId);
		await fs.mkdir(path.join(wtGitDir, 'rebase-merge'), { recursive: true });
		const wtDir = path.join(env.dir, '..', `linked-wt-${Date.now()}`);
		await fs.mkdir(wtDir, { recursive: true });
		await fs.writeFile(path.join(wtDir, '.git'), `gitdir: ${wtGitDir}\n`);
		// Minimal files git needs to recognize the linked worktree
		await fs.writeFile(path.join(wtGitDir, 'HEAD'), 'ref: refs/heads/test-wt\n');
		await fs.writeFile(path.join(wtGitDir, 'commondir'), '../..\n');
		await fs.writeFile(path.join(wtGitDir, 'gitdir'), `${wtDir}\n`);
		expect(await isGitSequenceOperation(wtDir)).toBe(true);
		await fs.rm(wtDir, { recursive: true, force: true });
	});
});

describe('hasTTY', () => {
	const savedEnv: Record<string, string | undefined> = {};
	const envKeys = [
		'STORY_TEST_TTY',
		'ENTIRE_TEST_TTY',
		'GEMINI_CLI',
		'COPILOT_CLI',
		'PI_CODING_AGENT',
		'GIT_TERMINAL_PROMPT',
	];

	beforeEach(() => {
		for (const key of envKeys) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
	});

	afterEach(() => {
		for (const key of envKeys) {
			if (savedEnv[key] !== undefined) {
				process.env[key] = savedEnv[key];
			} else {
				delete process.env[key];
			}
		}
	});

	it('respects STORY_TEST_TTY=1 (Story-canonical brand)', () => {
		process.env.STORY_TEST_TTY = '1';
		expect(hasTTY()).toBe(true);
	});

	it('respects STORY_TEST_TTY=0 (Story-canonical brand)', () => {
		process.env.STORY_TEST_TTY = '0';
		expect(hasTTY()).toBe(false);
	});

	it('respects ENTIRE_TEST_TTY=1 (back-compat fallback)', () => {
		process.env.ENTIRE_TEST_TTY = '1';
		expect(hasTTY()).toBe(true);
	});

	it('respects ENTIRE_TEST_TTY=0 (back-compat fallback)', () => {
		process.env.ENTIRE_TEST_TTY = '0';
		expect(hasTTY()).toBe(false);
	});

	it('STORY_TEST_TTY takes precedence over ENTIRE_TEST_TTY', () => {
		process.env.STORY_TEST_TTY = '1';
		process.env.ENTIRE_TEST_TTY = '0';
		expect(hasTTY()).toBe(true);
	});

	it('returns false when GEMINI_CLI is set', () => {
		process.env.GEMINI_CLI = '1';
		expect(hasTTY()).toBe(false);
	});

	it('returns false when COPILOT_CLI is set', () => {
		process.env.COPILOT_CLI = '1';
		expect(hasTTY()).toBe(false);
	});

	it('returns false when PI_CODING_AGENT is set', () => {
		process.env.PI_CODING_AGENT = 'true';
		expect(hasTTY()).toBe(false);
	});

	it('returns false when GIT_TERMINAL_PROMPT=0', () => {
		process.env.GIT_TERMINAL_PROMPT = '0';
		expect(hasTTY()).toBe(false);
	});

	it('falls through to /dev/tty probe when no env override', () => {
		const result = hasTTY();
		expect(typeof result).toBe('boolean');
	});
});

describe('git CLI wrappers', () => {
	let env: TestEnv;

	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		clearGitCommonDirCache();
	});

	afterEach(async () => {
		await env.cleanup();
	});

	it('getGitDir returns .git path', async () => {
		const gitDir = await getGitDir(env.dir);
		expect(gitDir).toBe(path.join(env.dir, '.git'));
	});

	it('getGitCommonDir returns .git path in normal repo', async () => {
		const commonDir = await getGitCommonDir(env.dir);
		expect(commonDir).toBe(path.join(env.dir, '.git'));
	});

	it('getGitCommonDir returns cached value on second call', async () => {
		const first = await getGitCommonDir(env.dir);
		const second = await getGitCommonDir(env.dir);
		expect(first).toBe(second);
	});

	it('hasUncommittedChanges detects untracked files', async () => {
		await env.writeFile('untracked.txt', 'content');
		expect(await hasUncommittedChanges(env.dir)).toBe(true);
	});

	it('hasUncommittedChanges detects staged changes', async () => {
		await env.writeFile('staged.txt', 'content');
		await env.gitAdd('staged.txt');
		expect(await hasUncommittedChanges(env.dir)).toBe(true);
	});

	it('hasUncommittedChanges detects unstaged changes (modify tracked file)', async () => {
		await env.writeFile('tracked.txt', 'initial');
		await env.gitAdd('tracked.txt');
		await env.gitCommit('add tracked');
		await env.writeFile('tracked.txt', 'modified');
		expect(await hasUncommittedChanges(env.dir)).toBe(true);
	});

	it('hasUncommittedChanges clean on fresh commit', async () => {
		expect(await hasUncommittedChanges(env.dir)).toBe(false);
	});

	it('getHeadCommit returns valid 40-char hex hash', async () => {
		const hash = await getHeadCommit(env.dir);
		expect(hash).toMatch(/^[0-9a-f]{40}$/);
	});

	it('getFilesChangedInCommit lists files from normal commit', async () => {
		await env.writeFile('a.txt', 'a');
		await env.writeFile('b.txt', 'b');
		await env.gitAdd('a.txt', 'b.txt');
		const hash = await env.gitCommit('add files');
		const files = await getFilesChangedInCommit(hash, env.dir);
		expect(files).toContain('a.txt');
		expect(files).toContain('b.txt');
	});

	it('getFilesChangedInCommit handles initial (root) commit', async () => {
		const hash = await getHeadCommit(env.dir);
		const files = await getFilesChangedInCommit(hash, env.dir);
		expect(files).toContain('.gitkeep');
	});

	it('getFilesChangedInCommit includes deleted files', async () => {
		await env.writeFile('to-delete.txt', 'content');
		await env.gitAdd('to-delete.txt');
		await env.gitCommit('add file');

		await env.exec('git', ['rm', 'to-delete.txt']);
		const hash = await env.gitCommit('delete file');
		const files = await getFilesChangedInCommit(hash, env.dir);
		expect(files).toContain('to-delete.txt');
	});

	it('getFilesChangedInCommit returns empty for no-change commit', async () => {
		const hash = await env.gitCommit('empty', ['--allow-empty']);
		const files = await getFilesChangedInCommit(hash, env.dir);
		expect(files).toEqual([]);
	});

	it('checkoutBranch rejects dash-prefixed ref', async () => {
		await expect(checkoutBranch('--orphan', env.dir)).rejects.toThrow('invalid ref');
	});

	it('checkoutBranch switches to existing branch', async () => {
		await execGit(['branch', 'feature'], { cwd: env.dir });
		await checkoutBranch('feature', env.dir);
		const branch = await execGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: env.dir });
		expect(branch).toBe('feature');
	});

	it('checkoutBranch throws for nonexistent branch', async () => {
		await expect(checkoutBranch('nonexistent', env.dir)).rejects.toThrow();
	});

	it('checkIgnore returns ignored files', async () => {
		await env.writeFile('.gitignore', '*.log\n');
		await env.gitAdd('.gitignore');
		await env.gitCommit('add gitignore');
		const ignored = await checkIgnore(['test.log', 'keep.txt'], env.dir);
		expect(ignored).toContain('test.log');
		expect(ignored).not.toContain('keep.txt');
	});

	it('checkIgnore returns empty for empty input', async () => {
		const ignored = await checkIgnore([], env.dir);
		expect(ignored).toEqual([]);
	});

	it('checkIgnore returns empty when nothing is ignored', async () => {
		const ignored = await checkIgnore(['not-ignored.txt'], env.dir);
		expect(ignored).toEqual([]);
	});
});

describe('getCurrentBranch', () => {
	let env: TestEnv;

	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
	});

	afterEach(async () => {
		await env.cleanup();
	});

	it('returns current branch name', async () => {
		await execGit(['checkout', '-b', 'feature'], { cwd: env.dir });
		expect(await getCurrentBranch(env.dir)).toBe('feature');
	});

	it('errors on detached HEAD', async () => {
		const hash = await execGit(['rev-parse', 'HEAD'], { cwd: env.dir });
		await execGit(['checkout', hash], { cwd: env.dir });
		await expect(getCurrentBranch(env.dir)).rejects.toThrow('detached HEAD');
	});
});

describe('getGitAuthor', () => {
	let env: TestEnv;

	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
	});

	afterEach(async () => {
		await env.cleanup();
	});

	it('returns configured author', async () => {
		const author = await getGitAuthor(env.dir);
		expect(author.name).toBe('Test');
		expect(author.email).toBe('test@test.com');
	});

	it('returns defaults when no config', async () => {
		await execGit(['config', '--unset', 'user.name'], { cwd: env.dir });
		await execGit(['config', '--unset', 'user.email'], { cwd: env.dir });
		const author = await getGitAuthor(env.dir);
		expect(author.name).toBeTruthy();
		expect(author.email).toBeTruthy();
	});
});

describe('branchExistsOnRemote', () => {
	let env: TestEnv;
	let bareDir: string;

	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		bareDir = path.join(env.dir, '..', `bare-${Date.now()}.git`);
		await fs.mkdir(bareDir, { recursive: true });
		await execGit(['init', '--bare'], { cwd: bareDir });
		await execGit(['remote', 'add', 'origin', bareDir], { cwd: env.dir });
		await execGit(['push', 'origin', 'HEAD:refs/heads/feature-x'], { cwd: env.dir });
	});

	afterEach(async () => {
		await env.cleanup();
		await fs.rm(bareDir, { recursive: true, force: true });
	});

	it('returns true when branch exists on remote', async () => {
		expect(await branchExistsOnRemote('feature-x', env.dir)).toBe(true);
	});

	it('returns false when branch does not exist on remote', async () => {
		expect(await branchExistsOnRemote('nope-no-such-branch', env.dir)).toBe(false);
	});

	// Go parity (B.3): non-not-found errors must propagate. Earlier TS swallowed
	// all errors as `false`, masking corrupt-repo / not-a-git-dir / etc. as
	// "branch doesn't exist" → caused unnecessary fetches / duplicate branch
	// creation downstream.
	//
	// Go reference: git_operations.go:286-288 `failed to check remote branch: %w`.
	it('propagates errors from local check (non-git directory)', async () => {
		// Run from a directory that is NOT a git repo. `git branch` will fail
		// with "fatal: not a git repository" — this should throw, not silently
		// return false.
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'story-non-git-'));
		try {
			await expect(branchExistsOnRemote('any-branch', tmp)).rejects.toThrow();
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	it('returns false (not throw) when ls-remote fails (e.g., no remote)', async () => {
		// Remove the origin remote so ls-remote will fail. Local check returns
		// empty (no remote-tracking ref for feature-x anymore? actually there is
		// because we already fetched). Use a fresh env without remote.
		const env2 = await TestEnv.create({ initialCommit: true });
		try {
			// No remote configured — local check returns empty, ls-remote fails
			// because there's no 'origin' to query. Should return false, not throw.
			expect(await branchExistsOnRemote('whatever', env2.dir)).toBe(false);
		} finally {
			await env2.cleanup();
		}
	});
});

describe('diffTreeFiles', () => {
	let env: TestEnv;

	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
	});

	afterEach(async () => {
		await env.cleanup();
	});

	it('diffTreeFiles normal commit', async () => {
		const commit1 = await execGit(['rev-parse', 'HEAD'], { cwd: env.dir });
		await env.writeFile('new.txt', 'content');
		await env.gitAdd('new.txt');
		const commit2 = await env.gitCommit('add new');
		const files = await diffTreeFiles(commit1, commit2, env.dir);
		expect(files.has('new.txt')).toBe(true);
	});

	it('diffTreeFiles initial commit', async () => {
		const commit = await execGit(['rev-parse', 'HEAD'], { cwd: env.dir });
		const files = await diffTreeFiles('', commit, env.dir);
		expect(files.has('.gitkeep')).toBe(true);
	});

	it('diffTreeFiles no changes', async () => {
		const commit = await execGit(['rev-parse', 'HEAD'], { cwd: env.dir });
		const files = await diffTreeFiles(commit, commit, env.dir);
		expect(files.size).toBe(0);
	});

	it('diffTreeFiles deleted file', async () => {
		await env.writeFile('to-delete.txt', 'content');
		await env.gitAdd('to-delete.txt');
		const commit1 = await env.gitCommit('add file');
		await env.exec('git', ['rm', 'to-delete.txt']);
		const commit2 = await env.gitCommit('delete file');
		const files = await diffTreeFiles(commit1, commit2, env.dir);
		expect(files.has('to-delete.txt')).toBe(true);
	});

	it('diffTreeFileList multi-commit range', async () => {
		const commit1 = await execGit(['rev-parse', 'HEAD'], { cwd: env.dir });
		await env.writeFile('a.txt', 'a');
		await env.gitAdd('a.txt');
		await env.gitCommit('add a');
		await env.writeFile('b.txt', 'b');
		await env.gitAdd('b.txt');
		const commit2 = await env.gitCommit('add b');
		const files = await diffTreeFileList(commit1, commit2, env.dir);
		expect(files).toContain('a.txt');
		expect(files).toContain('b.txt');
	});

	it('diffTreeFiles subdirectory files', async () => {
		const commit1 = await execGit(['rev-parse', 'HEAD'], { cwd: env.dir });
		await env.writeFile('sub/dir/file.txt', 'content');
		await env.gitAdd('sub/dir/file.txt');
		const commit2 = await env.gitCommit('add nested file');
		const files = await diffTreeFiles(commit1, commit2, env.dir);
		expect(files.has('sub/dir/file.txt')).toBe(true);
	});
});

describe('parseDiffTreeOutput', () => {
	it('empty output', () => {
		expect(parseDiffTreeOutput('')).toEqual([]);
	});

	it('single modified file', () => {
		const data = ':100644 100644 abc1234 def5678 M\0file.txt\0';
		expect(parseDiffTreeOutput(data)).toEqual(['file.txt']);
	});

	it('multiple files', () => {
		const data =
			':100644 100644 abc def M\0a.txt\0:100644 000000 abc 000 D\0b.txt\0:000000 100644 000 abc A\0c.txt\0';
		const files = parseDiffTreeOutput(data);
		expect(files).toContain('a.txt');
		expect(files).toContain('b.txt');
		expect(files).toContain('c.txt');
	});

	it('rename', () => {
		const data = ':100644 100644 abc1234 def5678 R100\0old.txt\0new.txt\0';
		const files = parseDiffTreeOutput(data);
		expect(files).toContain('old.txt');
		expect(files).toContain('new.txt');
	});

	it('copy', () => {
		const data = ':100644 100644 abc1234 abc1234 C075\0src.txt\0dst.txt\0';
		const files = parseDiffTreeOutput(data);
		expect(files).toContain('src.txt');
		expect(files).toContain('dst.txt');
	});

	it('rename mixed with modify', () => {
		const data =
			':100644 100644 abc def R100\0old.txt\0new.txt\0:100644 100644 abc def M\0other.txt\0';
		const files = parseDiffTreeOutput(data);
		expect(files).toContain('old.txt');
		expect(files).toContain('new.txt');
		expect(files).toContain('other.txt');
	});
});

describe('extractStatus', () => {
	it('modify', () => {
		expect(extractStatus(':100644 100644 abc1234 def5678 M')).toBe('M');
	});

	it('add', () => {
		expect(extractStatus(':000000 100644 0000000 abc1234 A')).toBe('A');
	});

	it('delete', () => {
		expect(extractStatus(':100644 000000 abc1234 0000000 D')).toBe('D');
	});

	it('rename with score', () => {
		expect(extractStatus(':100644 100644 abc1234 def5678 R100')).toBe('R');
	});

	it('copy with score', () => {
		expect(extractStatus(':100644 100644 abc1234 abc1234 C075')).toBe('C');
	});

	it('type change', () => {
		expect(extractStatus(':100644 120000 abc1234 def5678 T')).toBe('T');
	});

	it('empty string', () => {
		expect(extractStatus('')).toBe('');
	});

	it('too few fields', () => {
		expect(extractStatus(':100644 100644 abc1234')).toBe('');
	});

	it('whitespace only', () => {
		expect(extractStatus('   ')).toBe('');
	});
});

// Phase 6.2 Part 2: foundation backlog item #18.
// Go: git_operations.go:163-174 (ShouldSkipOnDefaultBranch wraps IsOnDefaultBranch).
describe('shouldSkipOnDefaultBranch (foundation backlog #18)', () => {
	let env: TestEnv;
	beforeEach(async () => {
		// Need an initial commit so `git rev-parse --abbrev-ref HEAD` returns the
		// actual branch name (`main` / `master`) rather than `HEAD` (detached).
		env = await TestEnv.create({ initialCommit: true });
	});
	afterEach(async () => {
		await env.cleanup();
		vi.restoreAllMocks();
	});

	it('on default branch (main / master) returns skip=true + branchName', async () => {
		// TestEnv default branch is the repo's HEAD after init — typically `master`
		// for older git defaults, `main` for newer. Since `IsOnDefaultBranch`'s Go
		// fallback accepts either when no remote default is set, this is on-default.
		const result = await shouldSkipOnDefaultBranch(env.dir);
		expect(result.skip).toBe(true);
		expect(['main', 'master']).toContain(result.branchName);
	});

	it('on a non-default branch returns skip=false + branchName', async () => {
		await execGit(['checkout', '-b', 'feature/test-x'], { cwd: env.dir });
		const result = await shouldSkipOnDefaultBranch(env.dir);
		expect(result).toEqual({ skip: false, branchName: 'feature/test-x' });
	});

	it('fail-safe: when isOnDefaultBranch throws, returns { skip: false, branchName: "" }', async () => {
		// Mock isOnDefaultBranch to throw — exercises the catch fallback.
		// Go: git_operations.go:170-173 returns (false, "") on any inner error.
		const spy = vi.spyOn(branches, 'isOnDefaultBranch').mockRejectedValue(new Error('mock'));
		try {
			const result = await shouldSkipOnDefaultBranch(env.dir);
			expect(result).toEqual({ skip: false, branchName: '' });
		} finally {
			spy.mockRestore();
		}
	});
});

// Phase 9.5: foundation backlog item #23.
// Go: git_operations.go: IsOnDefaultBranch — cli-level boolean wrapper.
describe('isOnDefaultBranch (foundation backlog #23)', () => {
	let env: TestEnv;
	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
	});
	afterEach(async () => {
		await env.cleanup();
		vi.restoreAllMocks();
	});

	// Go: git_operations.go: IsOnDefaultBranch — happy main/master branch.
	it('returns true when HEAD is on the default branch', async () => {
		expect(await isOnDefaultBranch({ repoRoot: env.dir })).toBe(true);
	});

	it('returns false when HEAD is on a non-default branch', async () => {
		await execGit(['checkout', '-b', 'feature/not-default'], { cwd: env.dir });
		expect(await isOnDefaultBranch({ repoRoot: env.dir })).toBe(false);
	});

	it('returns false when HEAD is detached', async () => {
		const head = await getHeadCommit(env.dir);
		await execGit(['checkout', '--detach', head], { cwd: env.dir });
		expect(await isOnDefaultBranch({ repoRoot: env.dir })).toBe(false);
	});

	it('returns false when on a branch that is not main/master and no origin/HEAD exists', async () => {
		// No remote configured → getDefaultBranchName returns '' → fallback to
		// {main, master} membership check. `topic` is neither, so not default.
		await execGit(['checkout', '-b', 'topic/x'], { cwd: env.dir });
		expect(await isOnDefaultBranch({ repoRoot: env.dir })).toBe(false);
	});
});
