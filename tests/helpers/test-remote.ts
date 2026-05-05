import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import type { TestEnv } from './test-env';

/**
 * Local bare git repo used as a fake remote for Phase 5.6 push / fetch tests.
 *
 * Construct one with {@link TestRemote.create}, then `addRef` / `addBranch`
 * to seed it with refs your test needs. The {@link url} is a plain
 * filesystem path (works with `git fetch <path>` / `git remote add origin <path>`).
 *
 * @example
 * ```ts
 * const remote = await TestRemote.create();
 * const env = await TestEnv.create({ initialCommit: true });
 * await env.exec('git', ['remote', 'add', 'origin', remote.url]);
 *
 * // Seed remote with a v1 metadata branch:
 * const seedEnv = await TestEnv.create({ initialCommit: true });
 * await remote.pushFrom(seedEnv, 'master:story/checkpoints/v1');
 *
 * // ... run code under test that fetches / pushes ...
 *
 * await remote.cleanup();
 * await env.cleanup();
 * ```
 */
export class TestRemote {
	/**
	 * Plain filesystem path (e.g. `/var/folders/.../story-test-remote-XXXXXX`).
	 * Use this when the code under test treats the target as a remote name
	 * or path. Note: `isURL(this.url)` returns `false` for this string —
	 * use {@link fileURL} when the code path requires URL detection.
	 */
	readonly url: string;
	/** Same as {@link url} (alias for clarity in test code). */
	readonly dir: string;
	/**
	 * `file://` URL form pointing at the same bare repo. Use this in
	 * tests that exercise URL-detection branches (`isURL` returns `true`).
	 */
	readonly fileURL: string;

	private constructor(dir: string) {
		this.dir = dir;
		this.url = dir;
		this.fileURL = `file://${dir}`;
	}

	static async create(): Promise<TestRemote> {
		const prefix = path.join(os.tmpdir(), 'story-test-remote-');
		const raw = await fs.mkdtemp(prefix);
		const dir = await fs.realpath(raw);
		await execa('git', ['init', '--bare', dir], { env: gitIsolatedEnv() });
		return new TestRemote(dir);
	}

	/**
	 * Push refs from `srcEnv` into this bare repo. `refspec` follows
	 * standard git semantics, e.g. `'master:refs/heads/main'` or
	 * `'+refs/heads/foo:refs/heads/foo'`.
	 */
	async pushFrom(srcEnv: TestEnv, refspec: string): Promise<void> {
		await execa('git', ['push', this.url, refspec], {
			cwd: srcEnv.dir,
			env: gitIsolatedEnv(),
		});
	}

	/** Read the commit hash of a ref on this remote. Returns `null` when missing. */
	async resolveRef(refName: string): Promise<string | null> {
		try {
			const { stdout } = await execa(
				'git',
				['--git-dir', this.dir, 'rev-parse', '--verify', refName],
				{ env: gitIsolatedEnv(), reject: false },
			);
			const trimmed = stdout.trim();
			return trimmed.length === 40 ? trimmed : null;
		} catch {
			return null;
		}
	}

	/** Run `git ls-remote <url> [pattern]` against this remote and return raw lines. */
	async lsRemote(pattern?: string): Promise<string[]> {
		const args = ['ls-remote', this.url];
		if (pattern) {
			args.push(pattern);
		}
		const { stdout } = await execa('git', args, { env: gitIsolatedEnv() });
		return stdout.split('\n').filter((l) => l.length > 0);
	}

	async cleanup(): Promise<void> {
		await fs.rm(this.dir, { recursive: true, force: true });
	}
}

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
	env.GIT_TERMINAL_PROMPT = '0';
	return env;
}
