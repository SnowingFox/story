import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	addDirectoryToChanges,
	addDirectoryToEntriesWithAbsPath,
	addTaskMetadataToTree,
	collectChangedFiles,
	deleteShadowBranch,
	ErrNoTranscript,
	extractToolUseIDFromPath,
	fileExists,
	filterGitIgnoredFiles,
	getOrCreateShadowBranch,
	getTranscriptFromCommit,
	hashWorktreeID,
	listAllTemporaryCheckpoints,
	listTemporary,
	listTemporaryCheckpoints,
	readTemporary,
	shadowBranchExists,
	shadowBranchNameForCommit,
	writeTemporary,
	writeTemporaryTask,
} from '@/checkpoint/temporary';
import type { TreeEntry } from '@/checkpoint/tree-ops';
import { MODE_FILE } from '@/checkpoint/tree-ops';
import type { WriteTemporaryOptions, WriteTemporaryTaskOptions } from '@/checkpoint/types';
import { TestEnv } from '../helpers/test-env';

// Go: temporary.go:567-573 extractToolUseIDFromPath
describe('extractToolUseIDFromPath', () => {
	it.each([
		// #50 — task metadata dir → returns tool-use ID
		{ input: '.story/metadata/sess-1/tasks/tool-abc', want: 'tool-abc' },
		{ input: '.story/metadata/sess-1/tasks/01HXZ-def', want: '01HXZ-def' },
		// #51 — non-task path → empty string
		{ input: '.story/metadata/sess-1', want: '' },
		{ input: '', want: '' },
		{ input: 'tasks', want: '' }, // single segment, no parent
		{ input: '/some/other/path', want: '' },
	])('extractToolUseIDFromPath($input) → $want', ({ input, want }) => {
		expect(extractToolUseIDFromPath(input)).toBe(want);
	});
});

describe('fileExists', () => {
	let env: TestEnv;

	beforeEach(async () => {
		env = await TestEnv.create();
	});

	afterEach(async () => {
		await env.cleanup();
	});

	it('returns true for existing file', async () => {
		await env.writeFile('hello.txt', 'world');
		expect(await fileExists(path.join(env.dir, 'hello.txt'))).toBe(true);
	});

	it('returns true for existing directory', async () => {
		expect(await fileExists(env.dir)).toBe(true);
	});

	it('returns false for nonexistent path', async () => {
		expect(await fileExists(path.join(env.dir, 'does-not-exist'))).toBe(false);
	});
});

// Shadow branch lifecycle (#43-45 + getOrCreateShadowBranch behaviour).
describe('shadow branch lifecycle', () => {
	let env: TestEnv;
	let baseCommit: string;

	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		// Use HEAD as the base commit for shadow branches in these tests.
		const { stdout } = await env.exec('git', ['rev-parse', 'HEAD']);
		baseCommit = stdout.trim();
	});

	afterEach(async () => {
		await env.cleanup();
	});

	// Helper: write a shadow branch ref pointing at HEAD so we have something to delete.
	async function createShadowRef(worktreeID: string): Promise<string> {
		const branch = shadowBranchNameForCommit(baseCommit, worktreeID);
		await env.exec('git', ['update-ref', `refs/heads/${branch}`, 'HEAD']);
		return branch;
	}

	// #43: shadowBranchExists returns true/false correctly
	it('shadowBranchExists returns false when no shadow branch exists', async () => {
		expect(await shadowBranchExists(env.dir, baseCommit, '')).toBe(false);
	});

	it('shadowBranchExists returns true after the ref is written', async () => {
		await createShadowRef('');
		expect(await shadowBranchExists(env.dir, baseCommit, '')).toBe(true);
	});

	// getOrCreateShadowBranch: missing branch falls back to HEAD's tree.
	it('getOrCreateShadowBranch returns ZERO_HASH parent + HEAD tree when branch missing', async () => {
		const branch = shadowBranchNameForCommit(baseCommit, '');
		const { parentHash, baseTreeHash } = await getOrCreateShadowBranch(env.dir, branch);
		expect(parentHash).toBe('0000000000000000000000000000000000000000');
		// baseTreeHash should match HEAD commit's tree.
		const { stdout } = await env.exec('git', ['rev-parse', 'HEAD^{tree}']);
		expect(baseTreeHash).toBe(stdout.trim());
	});

	// getOrCreateShadowBranch: existing branch returns its tip + tree.
	it('getOrCreateShadowBranch returns tip + tree when branch exists', async () => {
		const branch = await createShadowRef('');
		const { parentHash, baseTreeHash } = await getOrCreateShadowBranch(env.dir, branch);
		const headOid = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		const headTree = (await env.exec('git', ['rev-parse', 'HEAD^{tree}'])).stdout.trim();
		expect(parentHash).toBe(headOid);
		expect(baseTreeHash).toBe(headTree);
	});

	// #44: deleteShadowBranch removes the ref
	it('deleteShadowBranch removes the ref', async () => {
		await createShadowRef('');
		expect(await shadowBranchExists(env.dir, baseCommit, '')).toBe(true);
		await deleteShadowBranch(env.dir, baseCommit, '');
		expect(await shadowBranchExists(env.dir, baseCommit, '')).toBe(false);
	});

	// #45: deleteShadowBranch works under packed refs (the entire reason we use git CLI).
	it('deleteShadowBranch works under packed refs', async () => {
		await createShadowRef('');
		// Pack all refs into .git/packed-refs and remove loose ref files.
		// `git pack-refs --all` keeps loose refs by default; --prune removes them.
		await env.exec('git', ['pack-refs', '--all', '--prune']);

		// Sanity: loose ref file should be gone, but the branch should still resolve.
		const branch = shadowBranchNameForCommit(baseCommit, '');
		const looseExists = await fileExists(path.join(env.gitDir, 'refs/heads', branch));
		expect(looseExists).toBe(false);
		expect(await shadowBranchExists(env.dir, baseCommit, '')).toBe(true);

		// Now delete via git CLI; both loose and packed entries should be cleared.
		await deleteShadowBranch(env.dir, baseCommit, '');
		expect(await shadowBranchExists(env.dir, baseCommit, '')).toBe(false);
	});

	// E.2 Go parity: missing branch is an error, NOT a silent success. Earlier
	// TS swallowed `not found` patterns + a misleading comment claimed it
	// "mirrored Go's swallow behaviour" — Go actually propagates (see
	// temporary.go:636-647 wrapped error). Aligning now; downstream callers
	// that want best-effort delete must add their own try/catch.
	it('deleteShadowBranch throws when the branch is missing', async () => {
		await expect(deleteShadowBranch(env.dir, baseCommit, '')).rejects.toThrow();
	});

	// Sanity: shadow branch name uses the worktreeID hash, so different worktrees don't collide.
	it('shadowBranchExists distinguishes worktreeID', async () => {
		await createShadowRef('main-wt');
		expect(await shadowBranchExists(env.dir, baseCommit, 'main-wt')).toBe(true);
		// Different worktreeID → different ref name → branch doesn't exist for "other-wt".
		expect(await shadowBranchExists(env.dir, baseCommit, 'other-wt')).toBe(false);
		// Sanity check against direct hash computation.
		const branch = shadowBranchNameForCommit(baseCommit, 'main-wt');
		expect(branch).toBe(`story/${baseCommit.slice(0, 7)}-${hashWorktreeID('main-wt')}`);
	});
});

// File collection — git status -z parsing.
describe('collectChangedFiles', () => {
	let env: TestEnv;

	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
	});

	afterEach(async () => {
		await env.cleanup();
	});

	it('captures untracked files', async () => {
		await env.writeFile('new.txt', 'fresh');
		const { changed, deleted } = await collectChangedFiles(env.dir);
		expect(changed).toContain('new.txt');
		expect(deleted).toEqual([]);
	});

	it('captures modified tracked files', async () => {
		await env.writeFile('tracked.txt', 'one');
		await env.gitAdd('tracked.txt');
		await env.gitCommit('add tracked');
		await env.writeFile('tracked.txt', 'two');

		const { changed, deleted } = await collectChangedFiles(env.dir);
		expect(changed).toContain('tracked.txt');
		expect(deleted).toEqual([]);
	});

	it('captures deleted tracked files in `deleted`', async () => {
		await env.writeFile('doomed.txt', 'bye');
		await env.gitAdd('doomed.txt');
		await env.gitCommit('add doomed');
		await fs.unlink(path.join(env.dir, 'doomed.txt'));

		const { changed, deleted } = await collectChangedFiles(env.dir);
		expect(deleted).toContain('doomed.txt');
		expect(changed).not.toContain('doomed.txt');
	});

	it('handles renames (R/C two-segment record): old → deleted, new → changed', async () => {
		await env.writeFile('original.txt', 'content');
		await env.gitAdd('original.txt');
		await env.gitCommit('add original');
		await env.exec('git', ['mv', 'original.txt', 'renamed.txt']);

		const { changed, deleted } = await collectChangedFiles(env.dir);
		expect(changed).toContain('renamed.txt');
		expect(deleted).toContain('original.txt');
	});

	it('handles filenames with spaces (NUL separator)', async () => {
		await env.writeFile('with space.txt', 'contents');

		const { changed } = await collectChangedFiles(env.dir);
		expect(changed).toContain('with space.txt');
	});

	it('skips infrastructure paths (.story/...)', async () => {
		await env.writeFile('.story/metadata/foo.json', '{}');

		const { changed } = await collectChangedFiles(env.dir);
		expect(changed.some((f) => f.startsWith('.story/'))).toBe(false);
	});
});

// .gitignore filtering — git check-ignore --stdin.
describe('filterGitIgnoredFiles', () => {
	let env: TestEnv;

	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
	});

	afterEach(async () => {
		await env.cleanup();
	});

	it('returns input unchanged when no .gitignore', async () => {
		const out = await filterGitIgnoredFiles(env.dir, ['a.txt', 'b.txt']);
		expect(out).toEqual(['a.txt', 'b.txt']);
	});

	it('removes files matching .gitignore patterns', async () => {
		await env.writeFile('.gitignore', '.env\nnode_modules/\n');

		const out = await filterGitIgnoredFiles(env.dir, ['src/app.ts', '.env', 'node_modules/foo']);
		expect(out).toEqual(['src/app.ts']);
	});

	it('handles nested .gitignore', async () => {
		await env.writeFile('src/.gitignore', 'secret.txt\n');

		const out = await filterGitIgnoredFiles(env.dir, ['src/app.ts', 'src/secret.txt']);
		expect(out).toEqual(['src/app.ts']);
	});

	it('returns empty array when input is empty', async () => {
		expect(await filterGitIgnoredFiles(env.dir, [])).toEqual([]);
	});
});

// FS walk + symlink safety (#15-17 from tests.md).
describe('addDirectoryToChanges / addDirectoryToEntriesWithAbsPath', () => {
	let env: TestEnv;

	beforeEach(async () => {
		env = await TestEnv.create();
	});

	afterEach(async () => {
		await env.cleanup();
	});

	// #15 — happy path: regular files are picked up at the right tree path.
	it('addDirectoryToChanges produces TreeChange[] for regular files with correct treePath', async () => {
		await env.writeFile('metadata/sub/data.txt', 'safe content');

		const changes = await addDirectoryToChanges(
			env.dir,
			path.join(env.dir, 'metadata'),
			'.story/metadata/session',
		);

		expect(changes).toHaveLength(1);
		expect(changes[0]?.path).toBe('.story/metadata/session/sub/data.txt');
		expect(changes[0]?.entry?.type).toBe('blob');
		expect(changes[0]?.entry?.mode).toBe('100644');
		// Hash should round-trip: read it back via TestEnv fixture and compare bytes.
		const blob = await env.readBlob(changes[0]?.entry?.hash as string);
		expect(new TextDecoder().decode(blob)).toBe('safe content');
	});

	// #15 (parallel): same input shape, but for the entries-map variant.
	it('addDirectoryToEntriesWithAbsPath fills Map keyed by treePath', async () => {
		await env.writeFile('metadata/sub/data.txt', 'safe');

		const entries = new Map<string, TreeEntry>();
		await addDirectoryToEntriesWithAbsPath(
			env.dir,
			path.join(env.dir, 'metadata'),
			'.story/metadata/session',
			entries,
		);

		expect(entries.size).toBe(1);
		expect(entries.has('.story/metadata/session/sub/data.txt')).toBe(true);
	});

	// #16 — symlinked file pointing OUT of metadata dir → skipped.
	it('addDirectoryTo* skips symlinked files (would leak external secrets)', async () => {
		await env.writeFile('metadata/regular.txt', 'normal');
		await env.writeFile('sensitive.txt', 'SECRET');
		await fs.symlink(
			path.join(env.dir, 'sensitive.txt'),
			path.join(env.dir, 'metadata/sneaky-link'),
		);

		const changes = await addDirectoryToChanges(
			env.dir,
			path.join(env.dir, 'metadata'),
			'checkpoint',
		);

		expect(changes).toHaveLength(1);
		expect(changes[0]?.path).toBe('checkpoint/regular.txt');
		expect(changes.some((c) => c.path.endsWith('sneaky-link'))).toBe(false);
	});

	// #17 — symlinked DIRECTORY pointing OUT → don't recurse into it.
	it('addDirectoryTo* skips symlinked directories', async () => {
		await env.writeFile('metadata/regular.txt', 'normal');
		await env.writeFile('external-secrets/secret.txt', 'SECRET');
		await fs.symlink(
			path.join(env.dir, 'external-secrets'),
			path.join(env.dir, 'metadata/evil-dir-link'),
		);

		const changes = await addDirectoryToChanges(
			env.dir,
			path.join(env.dir, 'metadata'),
			'checkpoint',
		);

		// Only regular.txt — nothing from external-secrets should leak through.
		expect(changes).toHaveLength(1);
		expect(changes[0]?.path).toBe('checkpoint/regular.txt');
	});

	// Trailing-slash in dirRel should normalize, not produce double slashes.
	it('addDirectoryToChanges normalizes trailing slash in dirRel', async () => {
		await env.writeFile('metadata/foo.txt', 'x');

		const changes = await addDirectoryToChanges(
			env.dir,
			path.join(env.dir, 'metadata'),
			'checkpoint/',
		);

		expect(changes[0]?.path).toBe('checkpoint/foo.txt');
	});

	// Root-path edge cases: non-dir roots (regular file, missing path) should
	// behave like the symlink case — return [] + warn — rather than throwing.
	// Mirrors Go's `filepath.Walk` lstat-skip semantics so callers get one
	// consistent "no entries" result regardless of why the root is unwalkable.
	it('addDirectoryToChanges returns [] for a regular-file root (no throw)', async () => {
		await env.writeFile('not-a-dir.txt', 'plain file');

		const changes = await addDirectoryToChanges(
			env.dir,
			path.join(env.dir, 'not-a-dir.txt'),
			'checkpoint',
		);
		expect(changes).toEqual([]);
	});

	it('addDirectoryToChanges returns [] for a missing root (no throw)', async () => {
		const changes = await addDirectoryToChanges(
			env.dir,
			path.join(env.dir, 'does-not-exist'),
			'checkpoint',
		);
		expect(changes).toEqual([]);
	});
});

// writeTemporary main flow (#1-12 + #33-34).
describe('writeTemporary', () => {
	let env: TestEnv;
	let baseCommit: string;

	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		baseCommit = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
	});

	afterEach(async () => {
		await env.cleanup();
	});

	function mkOpts(overrides: Partial<WriteTemporaryOptions> = {}): WriteTemporaryOptions {
		return {
			sessionId: 'sess-1',
			baseCommit,
			worktreeId: '',
			modifiedFiles: [],
			newFiles: [],
			deletedFiles: [],
			metadataDir: '',
			metadataDirAbs: '',
			commitMessage: 'Checkpoint',
			authorName: 'Story CLI',
			authorEmail: 'story@local',
			isFirstCheckpoint: false,
			...overrides,
		};
	}

	// Helper: read tree entries (recursive) of a commit by hash.
	async function listTreeFiles(commitHash: string): Promise<Record<string, string>> {
		// `git ls-tree -r --name-only` lists files; we then read their content.
		const { stdout } = await env.exec('git', ['ls-tree', '-r', '--name-only', commitHash]);
		const names = stdout.trim().split('\n').filter(Boolean);
		const out: Record<string, string> = {};
		for (const name of names) {
			const blob = await env.exec('git', ['show', `${commitHash}:${name}`]);
			out[name] = blob.stdout;
		}
		return out;
	}

	// #33 — error: empty BaseCommit
	it('throws when BaseCommit is empty', async () => {
		await expect(writeTemporary(env.dir, mkOpts({ baseCommit: '' }))).rejects.toThrow(
			/BaseCommit is required/,
		);
	});

	// #34 — error: invalid sessionId
	it.each([
		{ name: 'empty', sessionId: '' },
		{ name: 'has /', sessionId: 'sess/1' },
		{ name: 'has \\', sessionId: 'sess\\1' },
	])('throws when sessionId is $name', async ({ sessionId }) => {
		await expect(writeTemporary(env.dir, mkOpts({ sessionId }))).rejects.toThrow(
			/invalid temporary checkpoint options/,
		);
	});

	// #2 — first checkpoint captures all modified tracked files via git status
	it('first checkpoint captures all modified tracked files', async () => {
		// Set up: commit a tracked file, then modify it.
		await env.writeFile('tracked.txt', 'one');
		await env.gitAdd('tracked.txt');
		baseCommit = await env.gitCommit('add tracked');
		await env.writeFile('tracked.txt', 'two');

		const result = await writeTemporary(env.dir, mkOpts({ baseCommit, isFirstCheckpoint: true }));
		expect(result.skipped).toBe(false);

		const files = await listTreeFiles(result.commitHash);
		expect(files['tracked.txt']).toBe('two');
	});

	// #4 — first checkpoint captures untracked files
	it('first checkpoint captures untracked files', async () => {
		await env.writeFile('fresh.txt', 'untracked content');

		const result = await writeTemporary(env.dir, mkOpts({ isFirstCheckpoint: true }));
		expect(result.skipped).toBe(false);

		const files = await listTreeFiles(result.commitHash);
		expect(files['fresh.txt']).toBe('untracked content');
	});

	// #5 — first checkpoint excludes gitignored files
	it('first checkpoint excludes gitignored files', async () => {
		await env.writeFile('.gitignore', '.env\n');
		await env.gitAdd('.gitignore');
		baseCommit = await env.gitCommit('add gitignore');
		await env.writeFile('.env', 'OPENAI_API_KEY=sk-secret');
		await env.writeFile('safe.txt', 'visible');

		const result = await writeTemporary(env.dir, mkOpts({ baseCommit, isFirstCheckpoint: true }));
		const files = await listTreeFiles(result.commitHash);
		expect(files['safe.txt']).toBe('visible');
		expect(files['.env']).toBeUndefined();
	});

	// #6 — subsequent: gitignored modified files are filtered out
	it('subsequent checkpoint excludes gitignored modified files', async () => {
		await env.writeFile('.gitignore', '.env\n');
		await env.gitAdd('.gitignore');
		baseCommit = await env.gitCommit('add gitignore');
		// First checkpoint to set up the shadow branch.
		await writeTemporary(env.dir, mkOpts({ baseCommit, isFirstCheckpoint: true }));
		// Now: agent reports .env as modified — must be filtered out.
		await env.writeFile('.env', 'OPENAI_API_KEY=sk-secret');
		await env.writeFile('legit.ts', 'export const x = 1;');

		const result = await writeTemporary(
			env.dir,
			mkOpts({
				baseCommit,
				modifiedFiles: ['.env'],
				newFiles: ['legit.ts'],
				isFirstCheckpoint: false,
			}),
		);

		const files = await listTreeFiles(result.commitHash);
		expect(files['legit.ts']).toBe('export const x = 1;');
		expect(files['.env']).toBeUndefined();
	});

	// #7 — subsequent: gitignored new files are filtered out
	it('subsequent checkpoint excludes gitignored new files', async () => {
		await env.writeFile('.gitignore', 'secrets/\n');
		await env.gitAdd('.gitignore');
		baseCommit = await env.gitCommit('add gitignore');
		await writeTemporary(env.dir, mkOpts({ baseCommit, isFirstCheckpoint: true }));

		await env.writeFile('secrets/api.txt', 'sk-...');
		await env.writeFile('docs/readme.md', '# hi');

		const result = await writeTemporary(
			env.dir,
			mkOpts({
				baseCommit,
				newFiles: ['secrets/api.txt', 'docs/readme.md'],
				isFirstCheckpoint: false,
			}),
		);

		const files = await listTreeFiles(result.commitHash);
		expect(files['docs/readme.md']).toBe('# hi');
		expect(files['secrets/api.txt']).toBeUndefined();
	});

	// #8 — nested .gitignore patterns are honored
	it('subsequent checkpoint excludes nested gitignored files', async () => {
		await env.writeFile('src/.gitignore', 'private.ts\n');
		await env.gitAdd('src/.gitignore');
		baseCommit = await env.gitCommit('add nested gitignore');
		await writeTemporary(env.dir, mkOpts({ baseCommit, isFirstCheckpoint: true }));

		await env.writeFile('src/public.ts', 'pub');
		await env.writeFile('src/private.ts', 'priv');

		const result = await writeTemporary(
			env.dir,
			mkOpts({
				baseCommit,
				newFiles: ['src/public.ts', 'src/private.ts'],
				isFirstCheckpoint: false,
			}),
		);

		const files = await listTreeFiles(result.commitHash);
		expect(files['src/public.ts']).toBe('pub');
		expect(files['src/private.ts']).toBeUndefined();
	});

	// #1 — dedup: identical content → second call returns skipped: true
	it('skips checkpoint when tree hash unchanged', async () => {
		await env.writeFile('foo.txt', 'same');
		const r1 = await writeTemporary(
			env.dir,
			mkOpts({ newFiles: ['foo.txt'], isFirstCheckpoint: false }),
		);
		expect(r1.skipped).toBe(false);

		const r2 = await writeTemporary(
			env.dir,
			mkOpts({ newFiles: ['foo.txt'], isFirstCheckpoint: false }),
		);
		expect(r2.skipped).toBe(true);
		expect(r2.commitHash).toBe(r1.commitHash);
	});

	// Coverage: when the shadow branch ref points at an OID whose commit object
	// can't be read (corrupt / missing), `getOrCreateShadowBranch` falls back
	// to HEAD's tree as base + ZERO_HASH parent (the dedup-skip branch in
	// writeTemporary itself is dead code through normal call paths because it's
	// gated on parentHash !== ZERO_HASH). The checkpoint still gets written,
	// just rooted at HEAD instead of dedup'd against the unreadable parent.
	it('treats unreadable parent commit as no-previous-tree (fallthrough)', async () => {
		const branch = shadowBranchNameForCommit(baseCommit, '');
		// Bypass `git update-ref` (which refuses nonexistent objects) and write
		// the loose ref file directly to simulate a corrupted shadow branch.
		const fakeOid = '0123456789abcdef0123456789abcdef01234567';
		const refPath = path.join(env.gitDir, 'refs', 'heads', branch);
		await fs.mkdir(path.dirname(refPath), { recursive: true });
		await fs.writeFile(refPath, `${fakeOid}\n`, 'utf-8');

		await env.writeFile('foo.txt', 'fresh');
		// Should NOT throw; should produce a real new commit rooted at HEAD's tree.
		const result = await writeTemporary(
			env.dir,
			mkOpts({ newFiles: ['foo.txt'], isFirstCheckpoint: false }),
		);
		expect(result.skipped).toBe(false);
		expect(result.commitHash).toMatch(/^[0-9a-f]{40}$/);
	});

	// #3 — invalid paths are skipped (with warning), valid neighbour persists
	it('normalizes paths and skips nonexistent files', async () => {
		await env.writeFile('valid.txt', 'good');

		const result = await writeTemporary(
			env.dir,
			mkOpts({
				newFiles: ['valid.txt', 'nonexistent.txt'],
				isFirstCheckpoint: false,
			}),
		);

		const files = await listTreeFiles(result.commitHash);
		expect(files['valid.txt']).toBe('good');
		expect(files['nonexistent.txt']).toBeUndefined();
	});

	// #9 — first: captures both user (already there) and agent (new) changes
	it('first checkpoint captures both user and agent changes', async () => {
		// User pre-existing change: modify a tracked file.
		await env.writeFile('user.txt', 'before');
		await env.gitAdd('user.txt');
		baseCommit = await env.gitCommit('add user.txt');
		await env.writeFile('user.txt', 'user-modified');
		// Agent change: a new file.
		await env.writeFile('agent.txt', 'agent-added');

		const result = await writeTemporary(env.dir, mkOpts({ baseCommit, isFirstCheckpoint: true }));
		const files = await listTreeFiles(result.commitHash);
		expect(files['user.txt']).toBe('user-modified');
		expect(files['agent.txt']).toBe('agent-added');
	});

	// #10 — first: captures user-deleted files (file removed from tree)
	it('first checkpoint captures user-deleted files', async () => {
		await env.writeFile('doomed.txt', 'bye');
		await env.gitAdd('doomed.txt');
		baseCommit = await env.gitCommit('add doomed');
		await fs.unlink(path.join(env.dir, 'doomed.txt'));

		const result = await writeTemporary(env.dir, mkOpts({ baseCommit, isFirstCheckpoint: true }));
		const files = await listTreeFiles(result.commitHash);
		expect(files['doomed.txt']).toBeUndefined();
	});

	// #11 — first: handles renamed files via git status R/C parsing
	it('first checkpoint captures renamed files', async () => {
		await env.writeFile('original.txt', 'content');
		await env.gitAdd('original.txt');
		baseCommit = await env.gitCommit('add original');
		await env.exec('git', ['mv', 'original.txt', 'renamed.txt']);

		const result = await writeTemporary(env.dir, mkOpts({ baseCommit, isFirstCheckpoint: true }));
		const files = await listTreeFiles(result.commitHash);
		expect(files['renamed.txt']).toBe('content');
		expect(files['original.txt']).toBeUndefined();
	});

	// #12 — first: filenames with spaces are handled correctly (NUL parser)
	it('first checkpoint handles filenames with spaces', async () => {
		await env.writeFile('with space.txt', 'spaced');

		const result = await writeTemporary(env.dir, mkOpts({ isFirstCheckpoint: true }));
		const files = await listTreeFiles(result.commitHash);
		expect(files['with space.txt']).toBe('spaced');
	});

	// Go parity / fail-closed: when the metadata directory walk fails
	// (unreadable file, IO error mid-scan), writeTemporary must throw rather
	// than silently writing a checkpoint with no metadata. An earlier version
	// warn-then-continued, producing "successful" shadow commits whose tree
	// lacked transcripts entirely. Fixed in B1-A.2; this test guards it.
	//
	// Go reference: entire-cli/.../checkpoint/temporary.go buildTreeWithChanges
	// returns "failed to add metadata directory: %w" on walk error.
	it('writeTemporary throws when metadata directory contains an unreadable file', async () => {
		// Create a file under the metadata dir then chmod it 000 so readFile fails
		// when walkDirAsBlobs reaches it via createRedactedBlobFromFile.
		const metadataDir = '.story/metadata/sess-fail';
		await env.writeFile(`${metadataDir}/transcript.jsonl`, '{"role":"user"}\n');
		const blockedFile = path.join(env.dir, metadataDir, 'transcript.jsonl');
		await fs.chmod(blockedFile, 0o000);

		try {
			await expect(
				writeTemporary(
					env.dir,
					mkOpts({
						sessionId: 'sess-fail',
						newFiles: [],
						metadataDir,
						metadataDirAbs: path.join(env.dir, metadataDir),
						isFirstCheckpoint: false,
					}),
				),
			).rejects.toThrow();
		} finally {
			// Restore perms so afterEach cleanup can rm -rf.
			await fs.chmod(blockedFile, 0o644).catch(() => {});
		}

		// Shadow branch ref must NOT have been written.
		expect(await shadowBranchExists(env.dir, baseCommit, '')).toBe(false);
	});
});

// Read & List — M8 (#35-42).
describe('readTemporary / listTemporary / listCheckpointsForBranch', () => {
	let env: TestEnv;
	let baseCommit: string;

	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		baseCommit = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
	});

	afterEach(async () => {
		await env.cleanup();
	});

	function mkOpts(overrides: Partial<WriteTemporaryOptions> = {}): WriteTemporaryOptions {
		return {
			sessionId: 'sess-A',
			baseCommit,
			worktreeId: '',
			modifiedFiles: [],
			newFiles: [],
			deletedFiles: [],
			metadataDir: '.story/metadata/sess-A',
			metadataDirAbs: '',
			commitMessage: 'Checkpoint',
			authorName: 'Story CLI',
			authorEmail: 'story@local',
			isFirstCheckpoint: false,
			...overrides,
		};
	}

	// #35 — readTemporary returns null when shadow branch missing
	it('readTemporary returns null when shadow branch missing', async () => {
		expect(await readTemporary(env.dir, baseCommit, '')).toBeNull();
	});

	// #36 — round-trip: write then read returns matching metadata
	it('readTemporary roundtrips with writeTemporary', async () => {
		await env.writeFile('foo.txt', 'bar');
		const wResult = await writeTemporary(env.dir, mkOpts({ newFiles: ['foo.txt'] }));

		const rResult = await readTemporary(env.dir, baseCommit, '');
		expect(rResult).not.toBeNull();
		expect(rResult?.commitHash).toBe(wResult.commitHash);
		expect(rResult?.sessionId).toBe('sess-A');
		expect(rResult?.metadataDir).toBe('.story/metadata/sess-A');
		expect(rResult?.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	// #57 — timestamp encodes the actual UTC instant of the commit author time
	// (regression for the wall-clock-as-UTC bug that mislabelled commits in
	// non-UTC timezones — see commitTimestampToISO docs).
	it('readTemporary timestamp matches commit author UTC instant', async () => {
		await env.writeFile('foo.txt', 'bar');
		const wResult = await writeTemporary(env.dir, mkOpts({ newFiles: ['foo.txt'] }));

		const rResult = await readTemporary(env.dir, baseCommit, '');
		// Pull the raw author timestamp from the commit object via git CLI, then
		// compute the canonical UTC ISO. The two must match to the millisecond.
		const { stdout } = await env.exec('git', ['log', '-1', '--format=%at', wResult.commitHash]);
		const utcSeconds = Number.parseInt(stdout.trim(), 10);
		const expected = new Date(utcSeconds * 1000).toISOString();
		expect(rResult?.timestamp).toBe(expected);
		// And it must end with `Z` (UTC), not a tz offset.
		expect(rResult?.timestamp).toMatch(/Z$/);
	});

	// #37 — listTemporary excludes story/checkpoints/v1
	it('listTemporary excludes story/checkpoints/v1', async () => {
		await env.writeFile('a.txt', 'a');
		await writeTemporary(env.dir, mkOpts({ newFiles: ['a.txt'] }));
		// Manually create the metadata branch ref (mimics what Phase 4.3 would do).
		await env.exec('git', ['update-ref', 'refs/heads/story/checkpoints/v1', 'HEAD']);

		const list = await listTemporary(env.dir);
		expect(list.some((b) => b.branchName === 'story/checkpoints/v1')).toBe(false);
		expect(list.length).toBe(1);
		expect(list[0]?.branchName.startsWith('story/')).toBe(true);
	});

	// #38 — listTemporary excludes story/checkpoints/v2
	it('listTemporary excludes story/checkpoints/v2', async () => {
		await env.writeFile('a.txt', 'a');
		await writeTemporary(env.dir, mkOpts({ newFiles: ['a.txt'] }));
		await env.exec('git', ['update-ref', 'refs/heads/story/checkpoints/v2', 'HEAD']);

		const list = await listTemporary(env.dir);
		expect(list.some((b) => b.branchName === 'story/checkpoints/v2')).toBe(false);
	});

	// #39 — listTemporary only returns story/* prefix branches
	it('listTemporary only returns story/* prefix branches', async () => {
		await env.writeFile('a.txt', 'a');
		await writeTemporary(env.dir, mkOpts({ newFiles: ['a.txt'] }));
		// Create a non-story branch — must be excluded.
		await env.exec('git', ['branch', 'feat/unrelated']);

		const list = await listTemporary(env.dir);
		expect(list.every((b) => b.branchName.startsWith('story/'))).toBe(true);
		expect(list.some((b) => b.branchName === 'feat/unrelated')).toBe(false);
	});

	// #40 — listTemporaryCheckpoints filters by sessionId
	it('listTemporaryCheckpoints filters by sessionId', async () => {
		await env.writeFile('a.txt', '1');
		await writeTemporary(env.dir, mkOpts({ sessionId: 'sess-A', newFiles: ['a.txt'] }));
		await env.writeFile('b.txt', '2');
		await writeTemporary(env.dir, mkOpts({ sessionId: 'sess-B', newFiles: ['b.txt'] }));

		const all = await listTemporaryCheckpoints(env.dir, baseCommit, '', '', 100);
		expect(all.length).toBe(2);

		const onlyA = await listTemporaryCheckpoints(env.dir, baseCommit, '', 'sess-A', 100);
		expect(onlyA.length).toBe(1);
		expect(onlyA[0]?.sessionId).toBe('sess-A');
	});

	// #41 — listTemporaryCheckpoints honors limit
	it('listTemporaryCheckpoints honors limit', async () => {
		for (let i = 0; i < 5; i++) {
			await env.writeFile(`file-${i}.txt`, `content-${i}`);
			await writeTemporary(env.dir, mkOpts({ sessionId: 'sess-A', newFiles: [`file-${i}.txt`] }));
		}

		const limited = await listTemporaryCheckpoints(env.dir, baseCommit, '', 'sess-A', 3);
		expect(limited.length).toBe(3);
	});

	// listCheckpointsForBranch on missing branch returns []
	it('listCheckpointsForBranch returns [] when branch is missing', async () => {
		const out = await listTemporaryCheckpoints(env.dir, baseCommit, 'nonexistent-wt', '', 100);
		expect(out).toEqual([]);
	});

	// listCheckpointsForBranch skips commits without Story-Session trailer (commit
	// authored manually with no trailer must be silently dropped from results).
	it('listCheckpointsForBranch skips commits without a session trailer', async () => {
		// Make a shadow checkpoint via writeTemporary (gets a session trailer).
		await env.writeFile('a.txt', 'a');
		await writeTemporary(env.dir, mkOpts({ sessionId: 'sess-A', newFiles: ['a.txt'] }));
		// Now hand-craft a commit on the same shadow branch with NO session trailer.
		const branch = shadowBranchNameForCommit(baseCommit, '');
		await env
			.exec('git', [
				'commit-tree',
				'-m',
				'no trailer here',
				'-p',
				(await env.exec('git', ['rev-parse', `refs/heads/${branch}`])).stdout.trim(),
				(await env.exec('git', ['rev-parse', `refs/heads/${branch}^{tree}`])).stdout.trim(),
			])
			.then(({ stdout }) => env.exec('git', ['update-ref', `refs/heads/${branch}`, stdout.trim()]));

		const out = await listTemporaryCheckpoints(env.dir, baseCommit, '', '', 100);
		// Only the trailered commit should remain.
		expect(out.length).toBe(1);
	});

	// listCheckpointsForBranch reports task checkpoints (Story-Metadata-Task trailer present).
	it('listCheckpointsForBranch identifies task checkpoints + extracts toolUseId', async () => {
		const taskCommitMsg = [
			'Task',
			'',
			'Story-Metadata-Task: .story/metadata/sess-A/tasks/tool-X',
			'Story-Session: sess-A',
			'Story-Strategy: manual-commit',
		].join('\n');
		await writeTemporaryTask(env.dir, {
			sessionId: 'sess-A',
			baseCommit,
			worktreeId: '',
			toolUseId: 'tool-X',
			agentId: 'agent-X',
			modifiedFiles: [],
			newFiles: [],
			deletedFiles: [],
			transcriptPath: '',
			subagentTranscriptPath: '',
			checkpointUuid: 'uuid-X',
			commitMessage: taskCommitMsg,
			authorName: 'Story CLI',
			authorEmail: 'story@local',
			isIncremental: true,
			incrementalSequence: 1,
			incrementalType: 'progress',
			incrementalData: new Uint8Array(),
		});

		const out = await listTemporaryCheckpoints(env.dir, baseCommit, '', 'sess-A', 100);
		expect(out.length).toBe(1);
		expect(out[0]?.isTaskCheckpoint).toBe(true);
		expect(out[0]?.toolUseId).toBe('tool-X');
		expect(out[0]?.metadataDir).toBe('.story/metadata/sess-A/tasks/tool-X');
	});

	// listAllTemporaryCheckpoints stops once limit is reached across branches.
	it('listAllTemporaryCheckpoints stops at limit across branches', async () => {
		// 3 branches × 1 commit each = 3 commits total. With limit=2, only 2 returned.
		for (let i = 0; i < 3; i++) {
			await env.writeFile(`f${i}.txt`, `c${i}`);
			await writeTemporary(
				env.dir,
				mkOpts({ sessionId: 'sess-A', worktreeId: `wt-${i}`, newFiles: [`f${i}.txt`] }),
			);
		}

		const limited = await listAllTemporaryCheckpoints(env.dir, 'sess-A', 2);
		expect(limited.length).toBe(2);
	});

	// #42 — listAllTemporaryCheckpoints aggregates across branches
	it('listAllTemporaryCheckpoints aggregates across branches', async () => {
		// Create 2 shadow branches by varying worktreeId.
		await env.writeFile('a.txt', 'a');
		await writeTemporary(
			env.dir,
			mkOpts({ sessionId: 'sess-A', worktreeId: 'wt-1', newFiles: ['a.txt'] }),
		);
		await env.writeFile('b.txt', 'b');
		await writeTemporary(
			env.dir,
			mkOpts({ sessionId: 'sess-A', worktreeId: 'wt-2', newFiles: ['b.txt'] }),
		);

		const all = await listAllTemporaryCheckpoints(env.dir, 'sess-A', 100);
		// One commit per shadow branch — total 2.
		expect(all.length).toBe(2);
	});
});

// Transcript reading — M9 (#46/#48/#49; #47 chunked-via-agent-dispatch is `—`).
describe('getTranscriptFromCommit', () => {
	let env: TestEnv;

	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
	});

	afterEach(async () => {
		await env.cleanup();
	});

	// Helper: build a tree with `<metadataDir>/<files>`, commit it, return commit hash.
	async function makeCommitWithMetadataFiles(
		metadataDir: string,
		files: Record<string, string>,
	): Promise<string> {
		// Write files to disk under the metadataDir, then `git add` + commit.
		for (const [name, content] of Object.entries(files)) {
			await env.writeFile(`${metadataDir}/${name}`, content);
		}
		await env.gitAdd(metadataDir);
		return env.gitCommit(`add ${metadataDir} files`);
	}

	// #46 — non-chunked transcript: single full.jsonl file
	it('reads non-chunked transcript', async () => {
		const commit = await makeCommitWithMetadataFiles('.story/metadata/sess-1', {
			'full.jsonl': '{"type":"hello"}\n{"type":"world"}\n',
		});

		const data = await getTranscriptFromCommit(env.dir, commit, '.story/metadata/sess-1', '');
		expect(new TextDecoder().decode(data)).toBe('{"type":"hello"}\n{"type":"world"}\n');
	});

	// Phase 6.1 wires per-agent dispatch via @/agent/chunking. JSONL fallback:
	// reassembleJSONL joins chunks with `\n` (matches Go `agent.ReassembleJSONL`).
	// Chunks stored on disk must NOT have trailing `\n` — chunkJSONL strips them
	// during the chunk write, and reassemble adds exactly one `\n` between
	// adjacent chunks (no trailing `\n` on the final assembly either).
	it('reads chunked transcript via JSONL reassembleTranscript dispatch', async () => {
		const commit = await makeCommitWithMetadataFiles('.story/metadata/sess-2', {
			'full.jsonl.001': '{"chunk":1}',
			'full.jsonl.002': '{"chunk":2}',
			'full.jsonl.010': '{"chunk":10}',
		});

		const data = await getTranscriptFromCommit(env.dir, commit, '.story/metadata/sess-2', '');
		expect(new TextDecoder().decode(data)).toBe('{"chunk":1}\n{"chunk":2}\n{"chunk":10}');
	});

	// Go parity: when both `full.jsonl` (base) and `full.jsonl.001+` (chunks)
	// coexist (e.g. partial write / migration mid-state), we must reassemble —
	// using base as implicit chunk 0 — not return base alone. Earlier TS
	// version returned base immediately, diverging from Go's
	// readTranscriptFromTree which scans for chunks first.
	//
	// Go reference: entire-cli/.../checkpoint/committed.go: readTranscriptFromTree
	it('prefers chunk reassembly over single full.jsonl when both exist (Go parity)', async () => {
		const commit = await makeCommitWithMetadataFiles('.story/metadata/sess-mix-base', {
			'full.jsonl': '{"chunk":0}',
			'full.jsonl.001': '{"chunk":1}',
			'full.jsonl.002': '{"chunk":2}',
		});

		const data = await getTranscriptFromCommit(
			env.dir,
			commit,
			'.story/metadata/sess-mix-base',
			'',
		);
		// Base file is treated as implicit chunk 0 → reassembleJSONL joins all 3
		// with `\n` separators (chunks stored without trailing `\n`).
		expect(new TextDecoder().decode(data)).toBe('{"chunk":0}\n{"chunk":1}\n{"chunk":2}');
	});

	// Chunked path: only chunks with a transcript-base-name are concatenated;
	// other chunked files like `prompt.txt.001` are skipped. Note we DON'T include
	// a full.jsonl here, so the chunked loop actually runs (it's gated by the
	// single-file check that would otherwise short-circuit).
	it('chunked path ignores non-transcript chunked files', async () => {
		const commit = await makeCommitWithMetadataFiles('.story/metadata/sess-mix', {
			'prompt.txt.001': 'should-be-ignored',
			'full.jsonl.001': 'real-chunk\n',
		});

		const data = await getTranscriptFromCommit(env.dir, commit, '.story/metadata/sess-mix', '');
		expect(new TextDecoder().decode(data)).toBe('real-chunk\n');
	});

	// Chunked path: subTree iteration also walks subdirs (which are tree
	// entries, not blobs) — verify we skip those instead of erroring.
	it('chunked path skips non-blob tree entries', async () => {
		// metadata/sess has a subdir + a single full.jsonl chunk file.
		const commit = await makeCommitWithMetadataFiles('.story/metadata/sess-sub', {
			'sub/x.txt': 'inside subdir',
			'full.jsonl.001': 'top-chunk\n',
		});

		const data = await getTranscriptFromCommit(env.dir, commit, '.story/metadata/sess-sub', '');
		expect(new TextDecoder().decode(data)).toBe('top-chunk\n');
	});

	// #48 — legacy filename `full.log` fallback
	it('falls back to legacy full.log when no full.jsonl present', async () => {
		const commit = await makeCommitWithMetadataFiles('.story/metadata/sess-3', {
			'full.log': 'old-format-content\n',
		});

		const data = await getTranscriptFromCommit(env.dir, commit, '.story/metadata/sess-3', '');
		expect(new TextDecoder().decode(data)).toBe('old-format-content\n');
	});

	// #49 — missing transcript throws ErrNoTranscript
	it('throws ErrNoTranscript when transcript missing', async () => {
		const commit = await makeCommitWithMetadataFiles('.story/metadata/sess-4', {
			'metadata.json': '{}',
		});

		await expect(
			getTranscriptFromCommit(env.dir, commit, '.story/metadata/sess-4', ''),
		).rejects.toBeInstanceOf(ErrNoTranscript);
	});

	// Sanity: when metadata dir doesn't exist in the tree, also throw.
	it('throws ErrNoTranscript when metadataDir missing entirely', async () => {
		const commit = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();

		await expect(
			getTranscriptFromCommit(env.dir, commit, '.story/metadata/nonexistent', ''),
		).rejects.toBeInstanceOf(ErrNoTranscript);
	});

	// Touch MODE_FILE so its export is exercised somewhere; remove this if
	// MODE_FILE gets a more natural test home in M10.
	it('MODE_FILE is the standard 100644 git mode', () => {
		expect(MODE_FILE).toBe('100644');
	});
});

// Task checkpoint — M10 (#52 + #22 attempt; #53 stays `—`).
describe('addTaskMetadataToTree / writeTemporaryTask', () => {
	let env: TestEnv;
	let baseCommit: string;

	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		baseCommit = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
	});

	afterEach(async () => {
		await env.cleanup();
	});

	function mkTaskOpts(
		overrides: Partial<WriteTemporaryTaskOptions> = {},
	): WriteTemporaryTaskOptions {
		return {
			sessionId: 'sess-T',
			baseCommit,
			worktreeId: '',
			toolUseId: 'tool-001',
			agentId: 'agent-001',
			modifiedFiles: [],
			newFiles: [],
			deletedFiles: [],
			transcriptPath: '',
			subagentTranscriptPath: '',
			checkpointUuid: 'uuid-001',
			commitMessage: 'Task checkpoint',
			authorName: 'Story CLI',
			authorEmail: 'story@local',
			isIncremental: false,
			incrementalSequence: 0,
			incrementalType: '',
			incrementalData: new Uint8Array(),
			...overrides,
		};
	}

	async function listTreeFiles(commitHash: string): Promise<Record<string, string>> {
		const { stdout } = await env.exec('git', ['ls-tree', '-r', '--name-only', commitHash]);
		const names = stdout.trim().split('\n').filter(Boolean);
		const out: Record<string, string> = {};
		for (const name of names) {
			const blob = await env.exec('git', ['show', `${commitHash}:${name}`]);
			out[name] = blob.stdout;
		}
		return out;
	}

	// #52 — incremental task checkpoint at expected path
	it('writeTemporaryTask writes incremental checkpoint to expected path', async () => {
		const opts = mkTaskOpts({
			isIncremental: true,
			incrementalSequence: 3,
			incrementalType: 'todo_update',
			incrementalData: new TextEncoder().encode(JSON.stringify({ items: ['a', 'b'] })),
		});

		const commitHash = await writeTemporaryTask(env.dir, opts);
		const files = await listTreeFiles(commitHash);

		const expectedPath = '.story/metadata/sess-T/tasks/tool-001/checkpoints/003-tool-001.json';
		expect(files[expectedPath]).toBeDefined();
		const parsed = JSON.parse(files[expectedPath] as string);
		expect(parsed.type).toBe('todo_update');
		expect(parsed.tool_use_id).toBe('tool-001');
		expect(parsed.data).toEqual({ items: ['a', 'b'] });
	});

	// #22 (deferred from Phase 4.1): direct addTaskMetadataToTree path-format test.
	// Identity-stub redact doesn't affect path-format correctness, so this PASSES
	// in the stub era.
	it('addTaskMetadataToTree incremental places file at <metadataDir>/checkpoints/NNN-<id>.json', async () => {
		// Build a base tree with one file, then layer task metadata on top.
		const blob = await env.writeBlob('hello');
		const baseTree = await env.writeTree([
			{ mode: MODE_FILE, path: 'pre-existing.txt', oid: blob, type: 'blob' },
		]);

		const opts = mkTaskOpts({
			sessionId: 'sess-002',
			toolUseId: 'tool-002',
			isIncremental: true,
			incrementalSequence: 7,
			incrementalType: 'progress',
			incrementalData: new TextEncoder().encode(JSON.stringify({ step: 1 })),
		});

		const newTree = await addTaskMetadataToTree(env.dir, baseTree, opts);

		// Verify the original file was preserved (structural sharing).
		const tree = await env.readTree(newTree);
		expect(tree.some((e) => e.path === 'pre-existing.txt')).toBe(true);

		// Verify the incremental file landed at the expected path. We walk the
		// nested tree manually since `git ls-tree -r` requires the tree to be
		// reachable from a commit.
		async function findFile(treeOid: string, expectedPath: string[]): Promise<string | null> {
			const entries = await env.readTree(treeOid);
			const [head, ...rest] = expectedPath;
			const match = entries.find((e) => e.path === head);
			if (match === undefined) {
				return null;
			}
			if (rest.length === 0) {
				return match.oid;
			}
			return findFile(match.oid, rest);
		}

		const fileOid = await findFile(newTree, [
			'.story',
			'metadata',
			'sess-002',
			'tasks',
			'tool-002',
			'checkpoints',
			'007-tool-002.json',
		]);
		expect(fileOid).not.toBeNull();
		const fileBytes = await env.readBlob(fileOid as string);
		const parsed = JSON.parse(new TextDecoder().decode(fileBytes));
		expect(parsed.type).toBe('progress');
		expect(parsed.tool_use_id).toBe('tool-002');
		expect(parsed.data).toEqual({ step: 1 });
	});

	// Final-path coverage: transcript + subagent transcript + checkpoint.json all
	// land at expected paths. (#53 marked `—` for redact correctness, but with
	// identity-stub redact the structural test still works.)
	it('writeTemporaryTask final checkpoint writes transcript + subagent transcript + checkpoint.json', async () => {
		// Set up transcript files on disk outside the repo (just need readable paths).
		const transcriptPath = path.join(env.dir, '.local-transcripts/main.jsonl');
		const subagentPath = path.join(env.dir, '.local-transcripts/sub.jsonl');
		await fs.mkdir(path.join(env.dir, '.local-transcripts'), { recursive: true });
		await fs.writeFile(transcriptPath, '{"role":"user"}\n{"role":"assistant"}\n');
		await fs.writeFile(subagentPath, '{"role":"sub"}\n');

		const opts = mkTaskOpts({
			sessionId: 'sess-final',
			toolUseId: 'tool-final',
			agentId: 'agent-final',
			transcriptPath,
			subagentTranscriptPath: subagentPath,
			checkpointUuid: 'uuid-final',
			isIncremental: false,
		});

		const commitHash = await writeTemporaryTask(env.dir, opts);
		const files = await listTreeFiles(commitHash);

		// Session transcript at sessionMetadataDir/full.jsonl. (env.exec strips
		// trailing newline so we compare without it; the blob in git has it.)
		expect(files['.story/metadata/sess-final/full.jsonl']).toBe(
			'{"role":"user"}\n{"role":"assistant"}',
		);
		// Subagent transcript at taskMetadataDir/agent-<agentId>.jsonl.
		expect(files['.story/metadata/sess-final/tasks/tool-final/agent-agent-final.jsonl']).toBe(
			'{"role":"sub"}',
		);
		// checkpoint.json summary with all 4 fields.
		const summary = JSON.parse(
			files['.story/metadata/sess-final/tasks/tool-final/checkpoint.json'] as string,
		);
		expect(summary).toEqual({
			session_id: 'sess-final',
			tool_use_id: 'tool-final',
			checkpoint_uuid: 'uuid-final',
			agent_id: 'agent-final',
		});
	});

	// #13 — task checkpoint redacts secrets in the subagent transcript.
	// The Phase 4.2 stub redact was a no-op so this assertion couldn't hold
	// then; Phase 4.3 ports the real redactor (secretlint preset + entropy
	// + pattern + opt-in PII), so secrets in the subagent transcript blob
	// land redacted on disk. Marked `✓` in tests.md after this lands.
	it('task checkpoint redacts secrets in subagent transcript', async () => {
		const transcriptPath = path.join(env.dir, '.local-transcripts/main.jsonl');
		const subagentPath = path.join(env.dir, '.local-transcripts/sub.jsonl');
		await fs.mkdir(path.join(env.dir, '.local-transcripts'), { recursive: true });
		await fs.writeFile(transcriptPath, '{"role":"user"}\n');
		// Subagent transcript carries a leaked secret. The redactor must
		// scrub it before the blob is written.
		await fs.writeFile(subagentPath, '{"role":"sub","data":"AWS=AKIAIOSFODNN7EXAMPLE"}\n');

		const opts = mkTaskOpts({
			sessionId: 'sess-redact',
			toolUseId: 'tool-redact',
			agentId: 'agent-redact',
			transcriptPath,
			subagentTranscriptPath: subagentPath,
			checkpointUuid: 'uuid-redact',
			isIncremental: false,
		});

		const commitHash = await writeTemporaryTask(env.dir, opts);
		const files = await listTreeFiles(commitHash);
		const subBlob = files['.story/metadata/sess-redact/tasks/tool-redact/agent-agent-redact.jsonl'];
		expect(subBlob).toBeDefined();
		expect(subBlob).not.toContain('AKIAIOSFODNN7EXAMPLE');
		expect(subBlob).toContain('REDACTED');
	});

	// #14 — task checkpoint also obeys .gitignore (writeTemporaryTask runs
	// candidates through filterGitIgnoredFiles before writing). This used to be
	// marked `—` on the assumption it depended on real redact, but the
	// .gitignore filter path is independent of redact.
	it('task checkpoint excludes gitignored files', async () => {
		await env.writeFile('.gitignore', 'secrets/\n');
		await env.gitAdd('.gitignore');
		baseCommit = await env.gitCommit('add gitignore');
		await env.writeFile('secrets/api.txt', 'sk-secret');
		await env.writeFile('docs/readme.md', '# hi');

		const commitHash = await writeTemporaryTask(
			env.dir,
			mkTaskOpts({
				baseCommit,
				newFiles: ['secrets/api.txt', 'docs/readme.md'],
			}),
		);

		const files = await listTreeFiles(commitHash);
		expect(files['docs/readme.md']).toBeDefined();
		expect(files['secrets/api.txt']).toBeUndefined();
	});

	// Final-path resilience: missing transcript / subagent files are skipped (warned), not errored.
	it('writeTemporaryTask final checkpoint tolerates missing transcript files', async () => {
		const opts = mkTaskOpts({
			sessionId: 'sess-missing',
			transcriptPath: '/nonexistent/transcript.jsonl',
			subagentTranscriptPath: '/nonexistent/sub.jsonl',
			isIncremental: false,
		});

		// Should NOT throw; checkpoint.json still gets written.
		const commitHash = await writeTemporaryTask(env.dir, opts);
		const files = await listTreeFiles(commitHash);
		expect(files['.story/metadata/sess-missing/tasks/tool-001/checkpoint.json']).toBeDefined();
		// But the missing transcripts are absent.
		expect(files['.story/metadata/sess-missing/full.jsonl']).toBeUndefined();
	});

	// Incremental path with non-JSON data — exercises the JSON.parse fallback branch.
	it('addTaskMetadataToTree incremental embeds non-JSON data as a string', async () => {
		const blob = await env.writeBlob('x');
		const baseTree = await env.writeTree([
			{ mode: MODE_FILE, path: 'x.txt', oid: blob, type: 'blob' },
		]);

		const opts = mkTaskOpts({
			sessionId: 'sess-raw',
			toolUseId: 'tool-raw',
			isIncremental: true,
			incrementalSequence: 1,
			incrementalType: 'log',
			incrementalData: new TextEncoder().encode('not-json: just a plain string'),
		});

		const newTree = await addTaskMetadataToTree(env.dir, baseTree, opts);

		async function findFile(treeOid: string, parts: string[]): Promise<string | null> {
			const entries = await env.readTree(treeOid);
			const [head, ...rest] = parts;
			const match = entries.find((e) => e.path === head);
			if (match === undefined) {
				return null;
			}
			if (rest.length === 0) {
				return match.oid;
			}
			return findFile(match.oid, rest);
		}

		const fileOid = await findFile(newTree, [
			'.story',
			'metadata',
			'sess-raw',
			'tasks',
			'tool-raw',
			'checkpoints',
			'001-tool-raw.json',
		]);
		expect(fileOid).not.toBeNull();
		const parsed = JSON.parse(new TextDecoder().decode(await env.readBlob(fileOid as string)));
		expect(parsed.data).toBe('not-json: just a plain string');
	});

	// Incremental with empty data — exercises the empty-text branch.
	it('addTaskMetadataToTree incremental handles empty incrementalData', async () => {
		const opts = mkTaskOpts({
			sessionId: 'sess-empty',
			toolUseId: 'tool-empty',
			isIncremental: true,
			incrementalSequence: 1,
			incrementalType: 'noop',
			incrementalData: new Uint8Array(),
		});
		const commit = await writeTemporaryTask(env.dir, opts);
		const files = await listTreeFiles(commit);
		const cp = files['.story/metadata/sess-empty/tasks/tool-empty/checkpoints/001-tool-empty.json'];
		expect(cp).toBeDefined();
		const parsed = JSON.parse(cp as string);
		expect(parsed.data).toBeNull();
	});

	// Validation paths — empty baseCommit / invalid sessionId/toolUseId/agentId
	it.each([
		{ name: 'empty baseCommit', overrides: { baseCommit: '' }, msg: /BaseCommit is required/ },
		{
			name: 'invalid sessionId',
			overrides: { sessionId: 'bad/id' },
			msg: /invalid task checkpoint/,
		},
		{
			name: 'invalid toolUseId',
			overrides: { toolUseId: 'bad/id' },
			msg: /invalid task checkpoint/,
		},
		{ name: 'invalid agentId', overrides: { agentId: 'bad/id' }, msg: /invalid task checkpoint/ },
	])('writeTemporaryTask rejects $name', async ({ overrides, msg }) => {
		await expect(
			writeTemporaryTask(env.dir, mkTaskOpts(overrides as Partial<WriteTemporaryTaskOptions>)),
		).rejects.toThrow(msg);
	});
});
