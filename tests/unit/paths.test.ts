import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	absPath,
	clearWorktreeRootCache,
	getLastTimestampFromBytes,
	getLastTimestampFromFile,
	getStoryFilePath,
	getWorktreeID,
	isInfrastructurePath,
	isSubpath,
	normalizeMSYSPath,
	parseTimestampFromJSONL,
	readFileInRoot,
	removeInRoot,
	SESSION_STATE_DIR_NAME,
	sessionStateDir,
	shadowBranchName,
	storyDir,
	toRelativePath,
	worktreeRoot,
	writeFileInRoot,
} from '@/paths';
import { TestEnv } from '../helpers/test-env';

describe('worktreeRoot', () => {
	let env: TestEnv;

	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		clearWorktreeRootCache();
	});

	afterEach(async () => {
		await env.cleanup();
	});

	it('returns repo root', async () => {
		const root = await worktreeRoot(env.dir);
		expect(root).toBe(env.dir);
	});

	it('caches by cwd', async () => {
		const first = await worktreeRoot(env.dir);
		const second = await worktreeRoot(env.dir);
		expect(first).toBe(second);
	});

	it('clearWorktreeRootCache invalidates cache', async () => {
		const first = await worktreeRoot(env.dir);
		clearWorktreeRootCache();
		const second = await worktreeRoot(env.dir);
		expect(first).toBe(second);
	});

	it('fails outside git repo', async () => {
		const tmpDir = await import('node:os').then((os) => os.tmpdir());
		await expect(worktreeRoot(tmpDir)).rejects.toThrow();
	});

	// Go parity (B.4): worktreeRoot returns the path as `git rev-parse
	// --show-toplevel` reports it — does NOT resolve symlinks. Earlier TS
	// version called fs.realpath which diverged from Go for any user entering
	// the repo via a symlink (`~/proj` → `/Volumes/data/proj`); subsequent
	// path comparisons / cache keys / .story/ paths then disagreed cross-CLI.
	//
	// Go reference: paths.go: WorktreeRoot ~86-117
	it('returns symlink path, not realpath (matches Go)', async () => {
		const os = await import('node:os');
		// Create a symlink that points to the test repo.
		const linkParent = await fs.mkdtemp(path.join(os.tmpdir(), 'story-symlink-'));
		const linkPath = path.join(linkParent, 'symlinked-repo');
		try {
			await fs.symlink(env.dir, linkPath, 'dir');
			clearWorktreeRootCache();
			// Call worktreeRoot from inside the symlink. Git resolves
			// --show-toplevel based on its own cwd handling, which on most
			// systems returns the realpath because git itself canonicalises.
			// The contract we're testing is: TS does NOT do an EXTRA realpath
			// on top — whatever git returns is what we return. Verify by
			// comparing to a direct git invocation.
			const gitOutput = (
				await import('execa').then(({ execa }) =>
					execa('git', ['rev-parse', '--show-toplevel'], { cwd: linkPath }),
				)
			).stdout.trim();
			const wtRoot = await worktreeRoot(linkPath);
			// They must agree exactly (no extra realpath layer).
			expect(wtRoot).toBe(gitOutput);
		} finally {
			await fs.rm(linkParent, { recursive: true, force: true });
		}
	});
});

describe('getWorktreeID', () => {
	let env: TestEnv;

	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
	});

	afterEach(async () => {
		await env.cleanup();
	});

	it('main worktree (git directory)', () => {
		expect(getWorktreeID(env.dir)).toBeNull();
	});

	it('linked worktree simple name', async () => {
		const wtDir = path.join(env.dir, '..', 'test-wt');
		await fs.mkdir(wtDir, { recursive: true });
		await fs.writeFile(
			path.join(wtDir, '.git'),
			`gitdir: ${path.join(env.dir, '.git', 'worktrees', 'test-wt')}\n`,
		);
		expect(getWorktreeID(wtDir)).toBe('test-wt');
	});

	it('linked worktree with subdirectory name', async () => {
		const wtDir = path.join(env.dir, '..', 'feature-auth');
		await fs.mkdir(wtDir, { recursive: true });
		await fs.writeFile(
			path.join(wtDir, '.git'),
			`gitdir: ${path.join(env.dir, '.git', 'worktrees', 'feature/auth')}\n`,
		);
		expect(getWorktreeID(wtDir)).toBe('feature/auth');
	});

	it('no .git exists', () => {
		const tmpDir = require('node:os').tmpdir();
		const noGitDir = path.join(tmpDir, `no-git-test-${Date.now()}`);
		require('node:fs').mkdirSync(noGitDir, { recursive: true });
		try {
			expect(() => getWorktreeID(noGitDir)).toThrow('failed to stat .git');
		} finally {
			require('node:fs').rmSync(noGitDir, { recursive: true });
		}
	});

	it('invalid .git file format', async () => {
		const wtDir = path.join(env.dir, '..', 'invalid-git');
		await fs.mkdir(wtDir, { recursive: true });
		await fs.writeFile(path.join(wtDir, '.git'), 'not a gitdir line\n');
		expect(() => getWorktreeID(wtDir)).toThrow('invalid .git file format');
	});

	it('bare repo worktree simple name', async () => {
		const wtDir = path.join(env.dir, '..', 'bare-wt');
		await fs.mkdir(wtDir, { recursive: true });
		await fs.writeFile(path.join(wtDir, '.git'), `gitdir: /repo/.bare/worktrees/main\n`);
		expect(getWorktreeID(wtDir)).toBe('main');
	});

	it('bare repo worktree with subdirectory name', async () => {
		const wtDir = path.join(env.dir, '..', 'bare-feature');
		await fs.mkdir(wtDir, { recursive: true });
		await fs.writeFile(path.join(wtDir, '.git'), `gitdir: /repo/.bare/worktrees/feature/auth\n`);
		expect(getWorktreeID(wtDir)).toBe('feature/auth');
	});

	it('gitdir without worktrees path', async () => {
		const wtDir = path.join(env.dir, '..', 'no-worktrees');
		await fs.mkdir(wtDir, { recursive: true });
		await fs.writeFile(path.join(wtDir, '.git'), `gitdir: /some/random/path\n`);
		expect(() => getWorktreeID(wtDir)).toThrow('no worktrees');
	});
});

describe('pure path functions', () => {
	it('shadowBranchName format', () => {
		const name = shadowBranchName('abc1234567890', 'e3b0c4');
		expect(name).toBe('story/abc1234-e3b0c4');
	});

	it('sessionStateDir format', () => {
		const dir = sessionStateDir('/repo/.git');
		expect(dir).toBe(path.join('/repo/.git', 'story-sessions'));
	});

	it('SESSION_STATE_DIR_NAME is the Story rebrand of Go entire-sessions', () => {
		expect(SESSION_STATE_DIR_NAME).toBe('story-sessions');
	});

	it('storyDir format', () => {
		const dir = storyDir('/home/user/project');
		expect(dir).toBe(path.join('/home/user/project', '.story'));
	});

	it('getStoryFilePath format', () => {
		const p = getStoryFilePath('/home/user/project', 'settings.json');
		expect(p).toBe(path.join('/home/user/project', '.story', 'settings.json'));
	});
});

describe('isSubpath', () => {
	it('child inside parent', () => {
		expect(isSubpath('/a/b', '/a/b/c')).toBe(true);
	});

	it('equal paths', () => {
		expect(isSubpath('/a/b', '/a/b')).toBe(true);
	});

	it('child outside parent', () => {
		expect(isSubpath('/a/b', '/a/c')).toBe(false);
	});

	it('parent prefix but not subpath', () => {
		expect(isSubpath('/a/b', '/a/bc')).toBe(false);
	});

	it('dot-dot escape', () => {
		expect(isSubpath('/a/b', '/a/b/../../../etc/passwd')).toBe(false);
	});

	it('dot-dot at end', () => {
		expect(isSubpath('/a/b', '/a/b/..')).toBe(false);
	});

	it('dot-dot in middle', () => {
		expect(isSubpath('/a/b/c', '/a/b/c/../../d')).toBe(false);
	});

	it('relative child inside', () => {
		expect(isSubpath('.story', '.story/metadata/test')).toBe(true);
	});

	it('relative equal', () => {
		expect(isSubpath('.story', '.story')).toBe(true);
	});

	it('relative outside', () => {
		expect(isSubpath('.story', 'src/main.go')).toBe(false);
	});

	it('relative prefix not subpath', () => {
		expect(isSubpath('.story', '.storyfile')).toBe(false);
	});

	it('root parent', () => {
		expect(isSubpath('/', '/anything')).toBe(true);
	});

	it('dot current dir parent', () => {
		expect(isSubpath('.', 'foo/bar')).toBe(true);
	});
});

describe('isInfrastructurePath', () => {
	it('.story/metadata/test is infrastructure', () => {
		expect(isInfrastructurePath('.story/metadata/test')).toBe(true);
	});

	it('.story is infrastructure', () => {
		expect(isInfrastructurePath('.story')).toBe(true);
	});

	it('src/main.go is not infrastructure', () => {
		expect(isInfrastructurePath('src/main.go')).toBe(false);
	});

	it('.storyfile is not infrastructure', () => {
		expect(isInfrastructurePath('.storyfile')).toBe(false);
	});
});

describe('toRelativePath', () => {
	it('basic relative conversion', () => {
		const rel = toRelativePath('/home/user/project/src/main.ts', '/home/user/project');
		expect(rel).toBe(path.join('src', 'main.ts'));
	});

	it('returns empty for outside path', () => {
		expect(toRelativePath('/other/path', '/home/user/project')).toBe('');
	});
});

describe('normalizeMSYSPath', () => {
	it('normalizeMSYSPath no-op on unix', () => {
		expect(normalizeMSYSPath('/c/Users/test')).toBe('/c/Users/test');
	});
});

describe('absPath', () => {
	let env: TestEnv;

	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		clearWorktreeRootCache();
	});

	afterEach(async () => {
		await env.cleanup();
	});

	it('returns absolute paths unchanged', async () => {
		const abs = path.isAbsolute('/already/absolute') ? '/already/absolute' : 'C:\\already';
		expect(await absPath(abs, env.dir)).toBe(abs);
	});

	it('joins relative paths to worktree root', async () => {
		const result = await absPath('foo/bar.txt', env.dir);
		expect(result).toBe(path.join(env.dir, 'foo/bar.txt'));
	});

	it('handles single segment relative path', async () => {
		const result = await absPath('file.txt', env.dir);
		expect(result).toBe(path.join(env.dir, 'file.txt'));
	});
});

describe('readFileInRoot / writeFileInRoot / removeInRoot', () => {
	let root: string;

	beforeEach(async () => {
		const raw = await fs.mkdtemp(path.join(os.tmpdir(), 'story-osroot-'));
		root = await fs.realpath(raw);
	});

	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	it('writeFileInRoot writes a file', async () => {
		await writeFileInRoot(root, 'hello.txt', 'world');
		const content = await fs.readFile(path.join(root, 'hello.txt'), 'utf-8');
		expect(content).toBe('world');
	});

	it('writeFileInRoot creates parent dirs', async () => {
		await writeFileInRoot(root, 'a/b/c.txt', 'nested');
		const content = await fs.readFile(path.join(root, 'a/b/c.txt'), 'utf-8');
		expect(content).toBe('nested');
	});

	it('writeFileInRoot honors mode', async () => {
		await writeFileInRoot(root, 'priv.txt', 'secret', 0o600);
		const stat = await fs.stat(path.join(root, 'priv.txt'));
		// Mask out file type bits; only check perm bits.
		expect(stat.mode & 0o777).toBe(0o600);
	});

	it('readFileInRoot reads file content', async () => {
		await fs.writeFile(path.join(root, 'data.bin'), Buffer.from([1, 2, 3]));
		const buf = await readFileInRoot(root, 'data.bin');
		expect(Array.from(buf)).toEqual([1, 2, 3]);
	});

	it('removeInRoot deletes a file', async () => {
		await fs.writeFile(path.join(root, 'gone.txt'), 'bye');
		await removeInRoot(root, 'gone.txt');
		await expect(fs.access(path.join(root, 'gone.txt'))).rejects.toThrow();
	});

	it('removeInRoot does not throw for missing file', async () => {
		await expect(removeInRoot(root, 'missing.txt')).resolves.toBeUndefined();
	});

	it('rejects absolute paths', async () => {
		await expect(writeFileInRoot(root, '/etc/passwd', 'x')).rejects.toThrow(/invalid path/);
		await expect(readFileInRoot(root, '/etc/passwd')).rejects.toThrow(/invalid path/);
		await expect(removeInRoot(root, '/etc/passwd')).rejects.toThrow(/invalid path/);
	});

	it('rejects null bytes', async () => {
		await expect(writeFileInRoot(root, 'bad\0path', 'x')).rejects.toThrow(/invalid path/);
	});

	it('rejects path traversal escapes', async () => {
		await expect(writeFileInRoot(root, '../escape.txt', 'x')).rejects.toThrow(/escapes root/);
		await expect(readFileInRoot(root, '../etc/passwd')).rejects.toThrow(/escapes root/);
	});

	it('handles symlinked root directory', async () => {
		// Create a target outside `root`, write through `root`, verify it lands inside.
		// Then symlink the root dir and write through symlink — should still work.
		const linkRoot = `${root}-link`;
		await fs.symlink(root, linkRoot, 'dir');
		try {
			await writeFileInRoot(linkRoot, 'sym.txt', 'via-symlink');
			const content = await fs.readFile(path.join(root, 'sym.txt'), 'utf-8');
			expect(content).toBe('via-symlink');
		} finally {
			await fs.unlink(linkRoot);
		}
	});
});

// Go: paths/transcript.go GetLastTimestampFromFile / GetLastTimestampFromBytes / ParseTimestampFromJSONL
describe('timestamp helpers — Go: paths/transcript.go', () => {
	let dir: string;

	beforeEach(async () => {
		const raw = await fs.mkdtemp(path.join(os.tmpdir(), 'story-ts-helpers-'));
		dir = await fs.realpath(raw);
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	// Go: paths/transcript.go: GetLastTimestampFromFile (happy path)
	it('getLastTimestampFromFile reads timestamp from last non-empty JSONL line', async () => {
		const fixture =
			'{"timestamp":"2026-04-15T10:00:00Z","msg":"first"}\n' +
			'{"timestamp":"2026-04-15T10:15:00Z","msg":"second"}\n' +
			'{"timestamp":"2026-04-15T10:30:00Z","msg":"third"}\n';
		const file = path.join(dir, 'sess.jsonl');
		await fs.writeFile(file, fixture, 'utf-8');
		const ts = await getLastTimestampFromFile(file);
		expect(ts).not.toBeNull();
		expect(ts!.toISOString()).toBe('2026-04-15T10:30:00.000Z');
	});

	// Go: paths/transcript.go: GetLastTimestampFromFile (5 failure modes)
	it('getLastTimestampFromFile returns null on missing / empty / non-JSON / non-RFC3339 / no timestamp', async () => {
		// Missing file.
		expect(await getLastTimestampFromFile(path.join(dir, 'no-such-file.jsonl'))).toBeNull();

		// Empty file.
		const emptyFile = path.join(dir, 'empty.jsonl');
		await fs.writeFile(emptyFile, '', 'utf-8');
		expect(await getLastTimestampFromFile(emptyFile)).toBeNull();

		// Non-JSON last line.
		const nonJsonFile = path.join(dir, 'non-json.jsonl');
		await fs.writeFile(nonJsonFile, 'not json at all\n', 'utf-8');
		expect(await getLastTimestampFromFile(nonJsonFile)).toBeNull();

		// Unparseable timestamp.
		const badTsFile = path.join(dir, 'bad-ts.jsonl');
		await fs.writeFile(badTsFile, '{"timestamp":"not a date"}\n', 'utf-8');
		expect(await getLastTimestampFromFile(badTsFile)).toBeNull();

		// JSON without timestamp field.
		const noTsFile = path.join(dir, 'no-ts.jsonl');
		await fs.writeFile(noTsFile, '{"msg":"no ts here"}\n', 'utf-8');
		expect(await getLastTimestampFromFile(noTsFile)).toBeNull();
	});

	// Go: paths/transcript.go: GetLastTimestampFromBytes (happy path)
	it('getLastTimestampFromBytes parses last line of in-memory buffer', () => {
		const fixture =
			'{"timestamp":"2026-04-15T10:00:00Z"}\n' + '{"timestamp":"2026-04-15T10:30:00Z"}\n';
		const ts = getLastTimestampFromBytes(new TextEncoder().encode(fixture));
		expect(ts).not.toBeNull();
		expect(ts!.toISOString()).toBe('2026-04-15T10:30:00.000Z');
	});

	// Go: paths/transcript.go: GetLastTimestampFromBytes (empty)
	it('getLastTimestampFromBytes empty buffer returns null', () => {
		expect(getLastTimestampFromBytes(new Uint8Array(0))).toBeNull();
	});

	// Go: paths/transcript.go: ParseTimestampFromJSONL (5 cases table-driven)
	it('parseTimestampFromJSONL parses {"timestamp":"<rfc3339>"} else null', () => {
		// Valid.
		const valid = parseTimestampFromJSONL('{"timestamp":"2026-04-15T10:30:00Z","extra":1}');
		expect(valid).not.toBeNull();
		expect(valid!.toISOString()).toBe('2026-04-15T10:30:00.000Z');

		// Non-JSON.
		expect(parseTimestampFromJSONL('not json')).toBeNull();

		// Missing timestamp field.
		expect(parseTimestampFromJSONL('{"msg":"hi"}')).toBeNull();

		// Unparseable timestamp.
		expect(parseTimestampFromJSONL('{"timestamp":"not a date"}')).toBeNull();

		// Empty input.
		expect(parseTimestampFromJSONL('')).toBeNull();
	});
});
