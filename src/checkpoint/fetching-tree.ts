/**
 * Tree-walker that auto-fetches missing blobs from a remote.
 *
 * After a treeless fetch (`git fetch --filter=blob:none`) the metadata
 * branch's tree objects are present locally but transcript blobs are not.
 * `FetchingTree` wraps a tree-hash and:
 *
 * 1. **Fast path**: tries to read the requested blob via isomorphic-git.
 * 2. **Fetcher path**: if the blob is missing and a {@link BlobFetchFunc}
 *    was supplied, calls the fetcher with the missing hash and retries.
 * 3. **`cat-file` fallback**: isomorphic-git caches packfile indices and
 *    will not see blobs added to a pack by an external `git fetch-pack`
 *    after the first read. When step 2 succeeds at the OS level but
 *    isomorphic-git still 404s, we shell out to `git cat-file -p <hash>`
 *    which always reads the on-disk object store directly.
 *
 * `preFetch()` collects every locally-missing blob recursively and asks the
 * fetcher for them in one round-trip — much cheaper than per-blob fetches
 * during sequential `file()` calls.
 *
 * Go reference: `entire-cli/cmd/entire/cli/checkpoint/fetching_tree.go`.
 */

import fsCallback from 'node:fs';
import { execa } from 'execa';
import git from 'isomorphic-git';
import { execGit } from '../git';
import { warn } from '../log';

/** Fetch missing blob objects by hash from a remote. */
export type BlobFetchFunc = (hashes: string[]) => Promise<void>;

interface RawTreeEntry {
	mode: string;
	path: string;
	oid: string;
	type: 'blob' | 'tree' | 'commit';
}

/**
 * Lazy view over a git tree that fetches missing blobs on demand.
 *
 * Construct with the absolute repo path, the root tree hash, and an
 * optional fetcher. When `fetch` is `undefined`, `file()` behaves like a
 * plain isomorphic-git read.
 *
 * @example
 * ```ts
 * const tree = await FetchingTree.create(repoDir, rootTreeHash, async (hashes) => {
 *   await execGit(['fetch', 'origin', '--no-tags', `${hashes.join(' ')}`], { cwd: repoDir });
 * });
 * await tree.preFetch();              // batch one round-trip
 * const transcript = await tree.file('a3/b2c4d5e6f7/0/full.jsonl');
 * ```
 */
export class FetchingTree {
	readonly repoDir: string;
	readonly treeHash: string;
	private readonly fetcher: BlobFetchFunc | undefined;
	private cachedEntries: RawTreeEntry[] | null = null;

	private constructor(repoDir: string, treeHash: string, fetcher: BlobFetchFunc | undefined) {
		this.repoDir = repoDir;
		this.treeHash = treeHash;
		this.fetcher = fetcher;
	}

	/**
	 * Build a FetchingTree from a tree hash. Validates the tree exists by
	 * reading its top-level entries (which must already be local since
	 * treeless fetch keeps trees).
	 */
	static async create(
		repoDir: string,
		treeHash: string,
		fetcher?: BlobFetchFunc,
	): Promise<FetchingTree> {
		const t = new FetchingTree(repoDir, treeHash, fetcher);
		await t.rawEntries();
		return t;
	}

	/** Direct child entries of this tree (no blob reads). */
	async rawEntries(): Promise<RawTreeEntry[]> {
		if (this.cachedEntries !== null) {
			return this.cachedEntries;
		}
		const result = await git.readTree({ fs: fsCallback, dir: this.repoDir, oid: this.treeHash });
		this.cachedEntries = result.tree.map((e) => ({
			mode: e.mode,
			path: e.path,
			oid: e.oid,
			type: e.type,
		}));
		return this.cachedEntries;
	}

	/**
	 * Walk the tree at `subpath` and return a FetchingTree for it. `subpath`
	 * is `/`-joined just like a git filepath.
	 *
	 * Throws if the path does not exist (matches Go's `tree %s: %w`).
	 */
	async tree(subpath: string): Promise<FetchingTree> {
		const result = await git.readTree({
			fs: fsCallback,
			dir: this.repoDir,
			oid: this.treeHash,
			filepath: subpath,
		});
		const sub = new FetchingTree(this.repoDir, result.oid, this.fetcher);
		sub.cachedEntries = result.tree.map((e) => ({
			mode: e.mode,
			path: e.path,
			oid: e.oid,
			type: e.type,
		}));
		return sub;
	}

	/**
	 * Read a file blob at `filepath` (slash-joined relative to this tree).
	 *
	 * Returns `null` if the path does not point at a blob (or the entry is
	 * missing entirely after fetching). Throws only when both isomorphic-git
	 * and `git cat-file` fail to produce bytes — which would mean the local
	 * object store is corrupt or the fetch silently dropped the request.
	 *
	 * @example
	 * ```ts
	 * const bytes = await tree.file('a3/b2c4d5e6f7/0/full.jsonl');
	 * // bytes === null if the file is not in the tree
	 * // bytes === Uint8Array(...)  on success (post-fetch + cat-file fallback)
	 * ```
	 */
	async file(filepath: string): Promise<Uint8Array | null> {
		// Fast path: blob already local.
		try {
			const { blob } = await git.readBlob({
				fs: fsCallback,
				dir: this.repoDir,
				oid: this.treeHash,
				filepath,
			});
			return blob;
		} catch {
			// fall through
		}

		// Locate the entry via tree traversal so we can ask the fetcher for
		// the right hash. If the path simply doesn't exist, surface null.
		const entry = await this.findEntry(filepath);
		if (entry === null || entry.type !== 'blob') {
			return null;
		}

		if (this.fetcher === undefined) {
			return null;
		}

		try {
			await this.fetcher([entry.oid]);
		} catch (err) {
			warn({ component: 'checkpoint' }, 'FetchingTree.file: blob fetch failed', {
				path: filepath,
				hash: entry.oid.slice(0, 12),
				error: err instanceof Error ? err.message : String(err),
			});
			return null;
		}

		// Retry — works for loose objects added by the fetch.
		try {
			const { blob } = await git.readBlob({
				fs: fsCallback,
				dir: this.repoDir,
				oid: entry.oid,
			});
			return blob;
		} catch {
			// Still missing from isomorphic-git's view (likely cached pack
			// index). Read from the on-disk object store via `git cat-file`.
		}

		return readBlobViaGit(this.repoDir, entry.oid);
	}

	/**
	 * Pre-fetch every blob this tree (recursively) references but is not
	 * already local. Returns the number of blobs fetched. No-op when no
	 * fetcher is wired or every blob is local.
	 */
	async preFetch(): Promise<number> {
		if (this.fetcher === undefined) {
			return 0;
		}
		const missing: string[] = [];
		await this.collectMissingBlobs(this.treeHash, missing, new Set());
		if (missing.length === 0) {
			return 0;
		}
		await this.fetcher(missing);
		return missing.length;
	}

	private async collectMissingBlobs(
		treeHash: string,
		out: string[],
		visited: Set<string>,
	): Promise<void> {
		if (visited.has(treeHash)) {
			return;
		}
		visited.add(treeHash);

		let entries: Awaited<ReturnType<typeof git.readTree>>;
		try {
			entries = await git.readTree({ fs: fsCallback, dir: this.repoDir, oid: treeHash });
		} catch {
			return;
		}
		for (const entry of entries.tree) {
			if (entry.type === 'blob') {
				const present = await blobExistsLocally(this.repoDir, entry.oid);
				if (!present) {
					out.push(entry.oid);
				}
			} else if (entry.type === 'tree') {
				await this.collectMissingBlobs(entry.oid, out, visited);
			}
		}
	}

	private async findEntry(filepath: string): Promise<RawTreeEntry | null> {
		const segments = filepath.split('/').filter((s) => s !== '');
		if (segments.length === 0) {
			return null;
		}
		let currentTree = this.treeHash;
		for (let i = 0; i < segments.length - 1; i++) {
			const seg = segments[i]!;
			let entries: Awaited<ReturnType<typeof git.readTree>>;
			try {
				entries = await git.readTree({ fs: fsCallback, dir: this.repoDir, oid: currentTree });
			} catch {
				return null;
			}
			const childTree = entries.tree.find((e) => e.path === seg && e.type === 'tree');
			if (childTree === undefined) {
				return null;
			}
			currentTree = childTree.oid;
		}
		const last = segments[segments.length - 1]!;
		let entries: Awaited<ReturnType<typeof git.readTree>>;
		try {
			entries = await git.readTree({ fs: fsCallback, dir: this.repoDir, oid: currentTree });
		} catch {
			return null;
		}
		const found = entries.tree.find((e) => e.path === last);
		if (found === undefined) {
			return null;
		}
		return { mode: found.mode, path: found.path, oid: found.oid, type: found.type };
	}
}

async function blobExistsLocally(repoDir: string, hash: string): Promise<boolean> {
	try {
		await git.readBlob({ fs: fsCallback, dir: repoDir, oid: hash });
		return true;
	} catch {
		// Fall through to git cat-file probe — handles freshly-fetched
		// objects that isomorphic-git doesn't see due to packfile caching.
	}
	try {
		await execGit(['cat-file', '-e', hash], { cwd: repoDir });
		return true;
	} catch {
		return false;
	}
}

/**
 * Read a blob via `git cat-file -p <hash>` directly from the on-disk
 * object store. Bypasses isomorphic-git so freshly-fetched packed blobs
 * can be read without restarting the process.
 */
async function readBlobViaGit(repoDir: string, hash: string): Promise<Uint8Array> {
	try {
		const result = await execa('git', ['cat-file', '-p', hash], {
			cwd: repoDir,
			encoding: 'buffer',
		});
		const stdout = result.stdout;
		if (stdout instanceof Uint8Array) {
			return stdout;
		}
		// Fallback: execa typing leaks `string | Buffer` even with `encoding: 'buffer'`.
		return new TextEncoder().encode(String(stdout));
	} catch (err) {
		throw new Error(
			`blob ${hash.slice(0, 12)} not readable after fetch: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}
