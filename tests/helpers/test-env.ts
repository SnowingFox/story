import fsCallback from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import git from 'isomorphic-git';

/**
 * Absolute path of the Story development repo root (the repo this code lives
 * in). Test files use this to guard against `process.cwd()` accidentally
 * pointing back at the real repo — if a test action runs `installGitHooks` /
 * `ensureSetup` / `worktreeRoot(process.cwd())` while cwd is `STORY_REPO_ROOT`,
 * it leaks real `.git/hooks/*` / `.story/*` into the development repo.
 *
 * See [`AGENTS.md` §测试/smoke 仓库隔离（硬红线）](../../AGENTS.md) for the rule
 * this constant supports.
 */
export const STORY_REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'..',
	'..',
	'..',
	'..',
);

/**
 * Throw immediately if `process.cwd()` is the Story development repo root.
 * Call in `beforeEach` of any command-action test that resolves repoRoot from
 * cwd — early failure here is much cheaper than a silent leak into the real
 * `.git/hooks/`.
 *
 * @example
 * beforeEach(async () => {
 *   env = await TestEnv.create({ initialCommit: true });
 *   process.chdir(env.dir);
 *   assertCwdIsNotStoryRepo();  // hard guard
 * });
 */
export function assertCwdIsNotStoryRepo(): void {
	if (process.cwd() === STORY_REPO_ROOT) {
		throw new Error(
			`test leak: process.cwd() === STORY_REPO_ROOT (${STORY_REPO_ROOT}). ` +
				'Running command actions from the repo root would write real .git/hooks/ / .story/ ' +
				'to the Story development repo. Chdir into a TestEnv temp dir before invoking.',
		);
	}
}

/**
 * A git tree entry as understood by isomorphic-git's `readTree` / `writeTree`.
 * Used by the test plumbing helpers to set up and inspect git object graphs
 * without going through git CLI.
 */
export interface FixtureTreeEntry {
	mode: string;
	path: string;
	oid: string;
	type: 'blob' | 'tree' | 'commit';
}

export interface TestEnvOptions {
	/** Create a bare git repository (no working tree). */
	bare?: boolean;
	/** Create an initial commit with a `.gitkeep` file. */
	initialCommit?: boolean;
}

/**
 * Isolated git repo for testing.
 *
 * Creates a fresh temp directory with `git init` and a deterministic author,
 * so tests are reproducible and independent.
 *
 * @example
 * ```ts
 * const env = await TestEnv.create({ initialCommit: true })
 * await env.writeFile('hello.txt', 'world')
 * await env.gitAdd('hello.txt')
 * await env.cleanup()
 * ```
 */
export class TestEnv {
	/** Absolute path to the repo working directory (symlink-resolved). */
	readonly dir: string;
	/** Absolute path to the `.git` directory. */
	readonly gitDir: string;

	private constructor(dir: string, gitDir: string) {
		this.dir = dir;
		this.gitDir = gitDir;
	}

	static async create(opts?: TestEnvOptions): Promise<TestEnv> {
		const prefix = path.join(os.tmpdir(), 'story-test-');
		const raw = await fs.mkdtemp(prefix);
		const dir = await fs.realpath(raw);

		const env = gitIsolatedEnv();

		if (opts?.bare) {
			await execa('git', ['init', '--bare', dir], { env });
		} else {
			await execa('git', ['init', dir], { env });
		}

		const gitDir = path.join(dir, opts?.bare ? '' : '.git');

		await execa('git', ['config', 'user.name', 'Test'], { cwd: dir, env });
		await execa('git', ['config', 'user.email', 'test@test.com'], { cwd: dir, env });
		await execa('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir, env });

		const testEnv = new TestEnv(dir, gitDir);

		if (opts?.initialCommit) {
			await testEnv.writeFile('.gitkeep', '');
			await testEnv.gitAdd('.gitkeep');
			await testEnv.gitCommit('initial commit');
		}

		return testEnv;
	}

	/** Write a file relative to repo root, creating parent directories as needed. */
	async writeFile(filePath: string, content: string): Promise<void> {
		const abs = path.join(this.dir, filePath);
		await fs.mkdir(path.dirname(abs), { recursive: true });
		await fs.writeFile(abs, content, 'utf-8');
	}

	async readFile(filePath: string): Promise<string> {
		const abs = path.join(this.dir, filePath);
		return fs.readFile(abs, 'utf-8');
	}

	async gitAdd(...files: string[]): Promise<void> {
		await this.exec('git', ['add', ...files]);
	}

	/** Commit and return the full 40-char commit hash. Extra args (e.g. `['--allow-empty']`) are appended. */
	async gitCommit(message: string, extraArgs?: string[]): Promise<string> {
		await this.exec('git', ['commit', '-m', message, ...(extraArgs ?? [])]);
		const { stdout } = await this.exec('git', ['rev-parse', 'HEAD']);
		return stdout.trim();
	}

	/** Return commit subject lines from `git log`, newest first. */
	async gitLog(n?: number): Promise<string[]> {
		const args = ['log', '--format=%s'];
		if (n !== undefined) {
			args.push(`-${n}`);
		}
		const { stdout } = await this.exec('git', args);
		return stdout.trim().split('\n').filter(Boolean);
	}

	async exec(cmd: string, args?: string[]): Promise<{ stdout: string; stderr: string }> {
		const { stdout, stderr } = await execa(cmd, args ?? [], {
			cwd: this.dir,
			env: gitIsolatedEnv(),
		});
		return { stdout, stderr };
	}

	async cleanup(): Promise<void> {
		await fs.rm(this.dir, { recursive: true, force: true });
	}

	/**
	 * Write a blob object to the repo and return its 40-char hex hash.
	 * Used by tests that need to construct git tree fixtures without going
	 * through `git add` (so that the working tree / index stay untouched).
	 */
	async writeBlob(content: string | Uint8Array): Promise<string> {
		const blob = typeof content === 'string' ? new TextEncoder().encode(content) : content;
		return git.writeBlob({ fs: fsCallback, dir: this.dir, blob });
	}

	/** Read a blob's raw bytes by hash. */
	async readBlob(oid: string): Promise<Uint8Array> {
		const result = await git.readBlob({ fs: fsCallback, dir: this.dir, oid });
		return result.blob;
	}

	/**
	 * Write a tree object directly (no working-tree side effects).
	 * Each entry's `path` is the entry name within the tree, NOT a path with slashes.
	 */
	async writeTree(entries: FixtureTreeEntry[]): Promise<string> {
		return git.writeTree({ fs: fsCallback, dir: this.dir, tree: entries });
	}

	/** Read a tree object's entries by hash. */
	async readTree(oid: string): Promise<FixtureTreeEntry[]> {
		const result = await git.readTree({ fs: fsCallback, dir: this.dir, oid });
		return result.tree.map((e) => ({ mode: e.mode, path: e.path, oid: e.oid, type: e.type }));
	}

	/** Force-write a ref (creates or overwrites). */
	async updateRef(ref: string, value: string): Promise<void> {
		await git.writeRef({ fs: fsCallback, dir: this.dir, ref, value, force: true });
	}

	/**
	 * Create a shadow branch ref pointing at a fresh commit whose tree is
	 * the current HEAD tree overlaid with the supplied `files`. Used by
	 * Phase 5.2 content-overlap and migration tests to plant a fixture
	 * shadow branch without going through the full SaveStep path.
	 *
	 * Mirrors Go `content_overlap_test.go:997-1050`
	 * (`createShadowBranchWithContent`).
	 *
	 * @param branchName Full branch name (no `refs/heads/` prefix), typically
	 *   `shadowBranchNameForCommit(baseCommit, worktreeId)`.
	 * @param files Map from file path (forward-slash) to file content. Each
	 *   entry is written as a new blob and added/replaced at the matching
	 *   path in the new tree.
	 * @returns The new commit hash on the shadow branch ref.
	 *
	 * @example
	 * const env = await TestEnv.create({ initialCommit: true });
	 * const sha = await env.withShadowBranch('story/abc1234-e3b0c4', {
	 *   'src/app.ts': 'agent content here\nmore agent code',
	 *   'src/util.ts': 'utility',
	 * });
	 * // .git/refs/heads/story/abc1234-e3b0c4 ← created, points at `sha`
	 * // Worktree / HEAD / index unchanged.
	 */
	async withShadowBranch(branchName: string, files: Record<string, string>): Promise<string> {
		// Read HEAD tree as starting point.
		const head = await git.resolveRef({ fs: fsCallback, dir: this.dir, ref: 'HEAD' });
		const headCommit = await git.readCommit({ fs: fsCallback, dir: this.dir, oid: head });
		const baseTreeOid = headCommit.commit.tree;

		// Read existing tree entries (top-level only — fixture writes are
		// expected to overlay top-level paths or simple subpaths).
		const baseTree = await git.readTree({ fs: fsCallback, dir: this.dir, oid: baseTreeOid });
		const entryMap = new Map<string, FixtureTreeEntry>();
		for (const e of baseTree.tree) {
			entryMap.set(e.path, {
				mode: e.mode,
				path: e.path,
				oid: e.oid,
				type: e.type as 'blob' | 'tree' | 'commit',
			});
		}

		// Overlay each `files` entry.
		// For paths with `/`, build sub-trees recursively (only one level deep
		// supported by this fixture helper; deeper paths panic — keep tests
		// using top-level or single-segment paths).
		for (const [filePath, content] of Object.entries(files)) {
			const segments = filePath.split('/');
			if (segments.length === 1) {
				const blobOid = await this.writeBlob(content);
				entryMap.set(filePath, {
					mode: '100644',
					path: filePath,
					oid: blobOid,
					type: 'blob',
				});
			} else {
				// Single sub-tree level only — build the leaf blob, gather all
				// other files for the same sub-tree, write the sub-tree, then
				// add it as the directory entry.
				throw new Error(
					`withShadowBranch: nested paths not yet supported (got ${filePath}); use top-level paths in fixtures`,
				);
			}
		}

		const treeEntries = [...entryMap.values()];
		const treeOid = await git.writeTree({ fs: fsCallback, dir: this.dir, tree: treeEntries });

		// Write a commit pointing at this tree (no parents — orphan, mirrors
		// the way SaveStep creates the very first shadow checkpoint).
		const commitOid = await git.writeCommit({
			fs: fsCallback,
			dir: this.dir,
			commit: {
				tree: treeOid,
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
				message: `shadow fixture for ${branchName}\n`,
			},
		});

		await git.writeRef({
			fs: fsCallback,
			dir: this.dir,
			ref: `refs/heads/${branchName}`,
			value: commitOid,
			force: true,
		});

		return commitOid;
	}

	/**
	 * Clone this repo into a fresh temp directory and return a TestEnv
	 * pointing at the new clone. Used by tests that need to exercise the
	 * `origin/<branch>` remote-fallback path without spinning up two repos
	 * by hand.
	 */
	async cloneTo(): Promise<TestEnv> {
		const prefix = path.join(os.tmpdir(), 'story-test-clone-');
		const raw = await fs.mkdtemp(prefix);
		const target = await fs.realpath(raw);
		const env = gitIsolatedEnv();
		await execa('git', ['clone', '--no-local', this.dir, target], { env });
		await execa('git', ['config', 'user.name', 'Test'], { cwd: target, env });
		await execa('git', ['config', 'user.email', 'test@test.com'], { cwd: target, env });
		await execa('git', ['config', 'commit.gpgsign', 'false'], { cwd: target, env });
		return new TestEnv(target, path.join(target, '.git'));
	}
}

/**
 * Copy of `process.env` with `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM`
 * pointed at `/dev/null`, preventing user/system git config from leaking into tests.
 */
function gitIsolatedEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (key === 'GIT_CONFIG_GLOBAL' || key === 'GIT_CONFIG_SYSTEM') {
			continue;
		}
		if (value !== undefined) {
			env[key] = value;
		}
	}
	env.GIT_CONFIG_GLOBAL = '/dev/null';
	env.GIT_CONFIG_SYSTEM = '/dev/null';
	return env;
}
