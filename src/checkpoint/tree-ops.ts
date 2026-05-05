import fsCallback from 'node:fs';
import git from 'isomorphic-git';
import type { CheckpointID } from '../id';
import { validate as validateCheckpointID } from '../id';
import { warn } from '../log';

/**
 * Low-level git tree manipulation primitives backing checkpoint storage.
 *
 * The two production-relevant entry points are:
 *
 * - {@link applyTreeChanges} — sparse, structural-sharing rewrite of a tree
 *   given a list of file-level edits. O(depth × touched paths).
 * - {@link updateSubtree} — replace or merge a leaf directory inside a tree
 *   at a known path. Used by Phase 4.3 for committed checkpoint shards.
 *
 * The {@link flattenTree} + {@link buildTreeFromEntries} pair implements the
 * full O(N) rebuild fallback and is used in equivalence tests against
 * `applyTreeChanges` to lock in correctness.
 *
 * Go reference: `entire-cli/cmd/entire/cli/checkpoint/parse_tree.go`
 * (algorithms) + `temporary.go` (FlattenTree / BuildTreeFromEntries / sort).
 */

/**
 * Sentinel "no tree" hash matching Go's `plumbing.ZeroHash`. Functions that
 * accept a tree hash treat this value as "start from an empty tree".
 */
export const ZERO_HASH = '0000000000000000000000000000000000000000';

/** Standard git file modes. */
export const MODE_FILE = '100644';
export const MODE_EXEC = '100755';
export const MODE_SYMLINK = '120000';
export const MODE_DIR = '040000';

/**
 * A single git tree entry. Mirrors Go's `object.TreeEntry`.
 *
 * NOTE: `name` is required even though `impl.md` listed only mode/hash/type —
 * the algorithms (and Go reference) need names everywhere. See
 * `tree-ops.test.ts` for round-trip coverage.
 *
 * **Submodule support**: `'commit'` (Go: `filemode.Submodule`, mode `160000`)
 * is preserved as a leaf entry — same as Go `FlattenTree`'s "everything
 * non-Dir is a leaf" handling. Earlier TS version filtered these out, which
 * silently dropped submodule references for any repo containing them.
 */
export interface TreeEntry {
	/** Entry name within its parent tree (NOT a path with slashes). */
	name: string;
	/** Git file mode: e.g. "100644" (regular file), "040000" (directory), "160000" (submodule). */
	mode: string;
	/** Git object hash (SHA-1, 40 hex chars). For commit entries this is the submodule's tip commit. */
	hash: string;
	/** Object type: 'blob' for files, 'tree' for directories, 'commit' for submodules. */
	type: 'blob' | 'tree' | 'commit';
}

/** Standard git file mode for a submodule (gitlink) entry. */
export const MODE_SUBMODULE = '160000';

/**
 * A single file-level change inside a tree. `entry: null` means "delete the
 * entry at `path`". Otherwise the entry replaces or creates the entry at
 * `path` (with the leaf segment of `path` becoming its name).
 */
export interface TreeChange {
	/** Full path within the tree, e.g. `"src/pkg/handler.ts"`. */
	path: string;
	/** New tree entry, or `null` to delete the entry at `path`. */
	entry: TreeEntry | null;
}

/** How {@link updateSubtree} combines new entries with the existing leaf directory. */
export enum MergeMode {
	/** Discard the existing leaf entries and write `newEntries` verbatim. */
	ReplaceAll = 0,
	/** Keep existing leaf entries; overwrite by name; honour `deleteNames`. */
	MergeKeepExisting = 1,
}

/** Options for {@link updateSubtree}. */
export interface UpdateSubtreeOptions {
	/** How to combine new entries with existing ones at the leaf directory. */
	mergeMode: MergeMode;
	/** Entry names to remove when `mergeMode === MergeKeepExisting`. */
	deleteNames?: string[];
}

/**
 * Split a path into its first segment and the rest.
 *
 * @example
 * ```ts
 * splitFirstSegment('a/b/c')   // ['a', 'b/c']
 * splitFirstSegment('file.txt') // ['file.txt', '']
 * splitFirstSegment('')         // ['', '']
 * ```
 */
export function splitFirstSegment(p: string): [first: string, rest: string] {
	const idx = p.indexOf('/');
	if (idx === -1) {
		return [p, ''];
	}
	return [p.slice(0, idx), p.slice(idx + 1)];
}

/**
 * Validate and normalize a git-tree-relative path. Returns the cleaned path or
 * throws on absolute paths, drive-letter paths, empty segments, or `.`/`..`.
 *
 * @example
 * ```ts
 * normalizeGitTreePath('src/app.ts')   // 'src/app.ts'
 * normalizeGitTreePath('src\\app.ts')  // 'src/app.ts'  (backslashes converted)
 * normalizeGitTreePath('/etc/passwd')  // throws: 'path must be relative'
 * normalizeGitTreePath('C:/foo')       // throws: 'path must be relative'
 * normalizeGitTreePath('a//b')         // throws: 'path contains empty segment'
 * normalizeGitTreePath('../x')         // throws: 'path contains invalid segment ".."'
 * ```
 */
export function normalizeGitTreePath(p: string): string {
	if (p === '') {
		throw new Error('path is empty');
	}

	// Match Go's filepath.ToSlash by replacing backslashes
	const slashed = p.replace(/\\/g, '/');
	if (isAbsoluteGitTreePath(slashed)) {
		throw new Error('path must be relative');
	}

	const parts = slashed.split('/');
	for (const part of parts) {
		if (part === '') {
			throw new Error('path contains empty segment');
		}
		if (part === '.' || part === '..') {
			throw new Error(`path contains invalid segment ${JSON.stringify(part)}`);
		}
	}

	return slashed;
}

/**
 * True when `p` looks like an absolute path (POSIX or Windows-style).
 */
function isAbsoluteGitTreePath(p: string): boolean {
	if (p.startsWith('/')) {
		return true;
	}
	// Windows drive-letter form: "C:/..."
	if (p.length >= 3 && p[1] === ':' && p[2] === '/') {
		const drive = p.charCodeAt(0);
		const isUpper = drive >= 65 && drive <= 90; // A-Z
		const isLower = drive >= 97 && drive <= 122; // a-z
		return isUpper || isLower;
	}
	return false;
}

/**
 * Sort tree entries in git's canonical order: by entry name, with directory
 * names getting an implicit trailing `/`. Mutates and returns `entries`.
 *
 * The trailing-slash rule means a file `foo` sorts BEFORE a directory `foo`
 * (because `foo` < `foo/` in lex order), and `foo.txt` (file) sorts BEFORE
 * `foo` (dir, becomes `foo/`).
 *
 * @example
 * ```ts
 * // Mixed file + dir at same level
 * sortTreeEntries([
 *   { name: 'foo',      type: 'tree', mode: MODE_DIR,  hash: 'h1' },
 *   { name: 'foo.txt',  type: 'blob', mode: MODE_FILE, hash: 'h2' },
 *   { name: 'bar',      type: 'blob', mode: MODE_FILE, hash: 'h3' },
 * ]);
 * // → [bar (file), foo.txt (file), foo (dir)]
 * //   because lex order: 'bar' < 'foo.txt' < 'foo/'
 * ```
 */
export function sortTreeEntries(entries: TreeEntry[]): TreeEntry[] {
	entries.sort((a, b) => {
		const nameA = a.type === 'tree' ? `${a.name}/` : a.name;
		const nameB = b.type === 'tree' ? `${b.name}/` : b.name;
		// **UTF-8 byte order** — required for git tree object hash determinism.
		// JS string `<` compares UTF-16 code units, which diverges from UTF-8
		// byte order for some non-ASCII names (e.g. composed vs decomposed
		// diacritics, certain CJK / emoji). Git itself sorts by raw UTF-8
		// bytes, so we must too — otherwise our tree OIDs differ from Go /
		// git's for any path containing such characters, breaking dedup and
		// cross-CLI interop.
		//
		// Go reference: `entire-cli/.../checkpoint/temporary.go` `sortTreeEntries`
		// uses Go string `<` which is UTF-8 byte comparison.
		return Buffer.compare(Buffer.from(nameA, 'utf8'), Buffer.from(nameB, 'utf8'));
	});
	return entries;
}

interface IsoTreeEntry {
	mode: string;
	path: string;
	oid: string;
	type: 'blob' | 'tree' | 'commit';
}

function toIsoEntries(entries: TreeEntry[]): IsoTreeEntry[] {
	return entries.map((e) => ({ mode: e.mode, path: e.name, oid: e.hash, type: e.type }));
}

function fromIsoEntries(entries: IsoTreeEntry[]): TreeEntry[] {
	const result: TreeEntry[] = [];
	for (const e of entries) {
		// Preserve all three valid git tree entry types: blob (file), tree
		// (directory), commit (submodule reference / gitlink, mode 160000).
		// Earlier TS version filtered 'commit' out → silently lost submodule
		// references for any repo containing them. Go `FlattenTree` records
		// any non-Dir entry as a leaf; we mirror that.
		if (e.type !== 'blob' && e.type !== 'tree' && e.type !== 'commit') {
			continue;
		}
		result.push({ name: e.path, mode: e.mode, hash: e.oid, type: e.type });
	}
	return result;
}

/**
 * Persist a tree object to the git object database and return its hash.
 * Sorts entries in git's canonical order before writing.
 */
export async function storeTree(repoDir: string, entries: TreeEntry[]): Promise<string> {
	const sorted = sortTreeEntries([...entries]);
	return git.writeTree({ fs: fsCallback, dir: repoDir, tree: toIsoEntries(sorted) });
}

/**
 * Read a tree's entries; treats {@link ZERO_HASH} as an empty tree.
 */
async function readTreeEntries(repoDir: string, treeHash: string): Promise<TreeEntry[]> {
	if (treeHash === ZERO_HASH) {
		return [];
	}
	const result = await git.readTree({ fs: fsCallback, dir: repoDir, oid: treeHash });
	return fromIsoEntries(result.tree as IsoTreeEntry[]);
}

/**
 * Recursively walk a tree, accumulating leaf entries (blobs **and submodule
 * commits**) into `entries` keyed by full path. Subtrees are descended; all
 * non-tree entries become leaves whose name equals the full path. This mirrors
 * Go's `FlattenTree` (`temporary.go` ~800-824) which records anything that
 * isn't a directory.
 */
export async function flattenTree(
	repoDir: string,
	treeHash: string,
	prefix: string,
	entries: Map<string, TreeEntry>,
): Promise<void> {
	const treeEntries = await readTreeEntries(repoDir, treeHash);
	for (const entry of treeEntries) {
		const fullPath = prefix === '' ? entry.name : `${prefix}/${entry.name}`;

		if (entry.type === 'tree') {
			await flattenTree(repoDir, entry.hash, fullPath, entries);
		} else {
			// blob OR commit (submodule). Preserve original type so
			// buildTreeFromEntries can write submodule entries back correctly.
			entries.set(fullPath, {
				name: fullPath,
				mode: entry.mode,
				hash: entry.hash,
				type: entry.type,
			});
		}
	}
}

interface TreeNode {
	files: TreeEntry[];
	subdirs: Map<string, TreeNode>;
}

function emptyNode(): TreeNode {
	return { files: [], subdirs: new Map() };
}

function insertIntoTree(node: TreeNode, parts: string[], entry: TreeEntry): void {
	if (parts.length === 1) {
		const leaf = parts[0];
		if (leaf === undefined) {
			return;
		}
		node.files.push({ name: leaf, mode: entry.mode, hash: entry.hash, type: entry.type });
		return;
	}
	const dirName = parts[0];
	if (dirName === undefined) {
		return;
	}
	let child = node.subdirs.get(dirName);
	if (child === undefined) {
		child = emptyNode();
		node.subdirs.set(dirName, child);
	}
	insertIntoTree(child, parts.slice(1), entry);
}

async function buildTreeObject(repoDir: string, node: TreeNode): Promise<string> {
	const treeEntries: TreeEntry[] = [...node.files];
	for (const [name, subnode] of node.subdirs) {
		const subHash = await buildTreeObject(repoDir, subnode);
		treeEntries.push({ name, mode: MODE_DIR, hash: subHash, type: 'tree' });
	}
	return storeTree(repoDir, treeEntries);
}

/**
 * Build a full tree object graph from a flat `path → entry` map. The map
 * keys are full paths (using `/`); each entry is leaf-only metadata.
 *
 * Invalid paths (absolute, drive-letter, `..`, etc.) are skipped with a
 * warning, matching Go's behavior.
 */
export async function buildTreeFromEntries(
	repoDir: string,
	entries: Map<string, TreeEntry>,
): Promise<string> {
	const root = emptyNode();
	for (const [fullPath, entry] of entries) {
		let normalized: string;
		try {
			normalized = normalizeGitTreePath(fullPath);
		} catch (err) {
			warn({ component: 'tree-ops' }, 'skipping invalid git tree path', {
				operation: 'build tree entry',
				path: fullPath,
				error: err instanceof Error ? err.message : String(err),
			});
			continue;
		}
		insertIntoTree(root, normalized.split('/'), entry);
	}
	return buildTreeObject(repoDir, root);
}

interface DirChanges {
	subChanges: TreeChange[];
	fileChange: TreeChange | null;
}

/**
 * Apply a set of file-level changes to a tree, rewriting only the paths along
 * each touched route. Untouched subtrees keep their original hashes (the
 * structural-sharing trick that makes this O(touched) instead of O(N)).
 *
 * `entry: null` deletes the entry at `path`. An empty `changes` array short-
 * circuits to the original `rootTreeHash` (no new tree object written).
 *
 * @example
 * ```ts
 * // Modify one file, delete another, add a third in one pass
 * const newRoot = await applyTreeChanges(repoDir, oldRoot, [
 *   { path: 'src/app.ts', entry: { name: 'app.ts', mode: MODE_FILE, hash: blobA, type: 'blob' } },
 *   { path: 'old.txt', entry: null },
 *   { path: 'docs/new.md', entry: { name: 'new.md', mode: MODE_FILE, hash: blobB, type: 'blob' } },
 * ]);
 * ```
 */
export async function applyTreeChanges(
	repoDir: string,
	rootTreeHash: string,
	changes: TreeChange[],
): Promise<string> {
	if (changes.length === 0) {
		return rootTreeHash;
	}

	const currentEntries = await readTreeEntries(repoDir, rootTreeHash);

	const grouped = new Map<string, DirChanges>();
	for (const change of changes) {
		let normalizedPath: string;
		try {
			normalizedPath = normalizeGitTreePath(change.path);
		} catch (err) {
			warn({ component: 'tree-ops' }, 'skipping invalid git tree path', {
				operation: 'apply tree change',
				path: change.path,
				error: err instanceof Error ? err.message : String(err),
			});
			continue;
		}

		const [first, rest] = splitFirstSegment(normalizedPath);
		let bucket = grouped.get(first);
		if (bucket === undefined) {
			bucket = { subChanges: [], fileChange: null };
			grouped.set(first, bucket);
		}
		if (rest === '') {
			bucket.fileChange = { path: normalizedPath, entry: change.entry };
		} else {
			bucket.subChanges.push({ path: rest, entry: change.entry });
		}
	}

	const entryMap = new Map<string, TreeEntry>();
	for (const e of currentEntries) {
		entryMap.set(e.name, e);
	}

	for (const [name, dc] of grouped) {
		if (dc.fileChange !== null) {
			if (dc.fileChange.entry === null) {
				entryMap.delete(name);
			} else {
				entryMap.set(name, {
					name,
					mode: dc.fileChange.entry.mode,
					hash: dc.fileChange.entry.hash,
					type: dc.fileChange.entry.type,
				});
			}
		}
		if (dc.subChanges.length > 0) {
			let existingHash = ZERO_HASH;
			const existing = entryMap.get(name);
			if (existing !== undefined && existing.type === 'tree') {
				existingHash = existing.hash;
			}
			const newSubHash = await applyTreeChanges(repoDir, existingHash, dc.subChanges);
			entryMap.set(name, { name, mode: MODE_DIR, hash: newSubHash, type: 'tree' });
		}
	}

	const result = Array.from(entryMap.values());
	return storeTree(repoDir, result);
}

/**
 * Replace or create a subtree at `pathSegments` within an existing tree.
 *
 * Recurses to the leaf directory then delegates to {@link buildLeafTree} for
 * the merge mode. All sibling entries at each level retain their original
 * hashes — the same structural-sharing trick as `applyTreeChanges`.
 *
 * @example
 * ```ts
 * // Add a new committed-checkpoint subtree at a3/b2c4d5e6f7/
 * const newRoot = await updateSubtree(repoDir, oldRoot,
 *   ['a3', 'b2c4d5e6f7'],
 *   [
 *     { name: 'metadata.json', mode: MODE_FILE, hash: metaBlob, type: 'blob' },
 *     { name: 'transcript.jsonl', mode: MODE_FILE, hash: txBlob, type: 'blob' },
 *   ],
 *   { mergeMode: MergeMode.ReplaceAll },
 * );
 * ```
 */
export async function updateSubtree(
	repoDir: string,
	rootTreeHash: string,
	pathSegments: string[],
	newEntries: TreeEntry[],
	opts: UpdateSubtreeOptions,
): Promise<string> {
	if (pathSegments.length === 0) {
		return buildLeafTree(repoDir, rootTreeHash, newEntries, opts);
	}

	const currentEntries = await readTreeEntries(repoDir, rootTreeHash);
	const targetDir = pathSegments[0];
	if (targetDir === undefined) {
		return buildLeafTree(repoDir, rootTreeHash, newEntries, opts);
	}
	const remainingPath = pathSegments.slice(1);

	let existingSubtreeHash = ZERO_HASH;
	for (const entry of currentEntries) {
		if (entry.name === targetDir && entry.type === 'tree') {
			existingSubtreeHash = entry.hash;
			break;
		}
	}

	const newSubtreeHash = await updateSubtree(
		repoDir,
		existingSubtreeHash,
		remainingPath,
		newEntries,
		opts,
	);

	const updatedEntries: TreeEntry[] = [];
	let replaced = false;
	for (const entry of currentEntries) {
		if (entry.name === targetDir) {
			updatedEntries.push({ name: targetDir, mode: MODE_DIR, hash: newSubtreeHash, type: 'tree' });
			replaced = true;
		} else {
			updatedEntries.push(entry);
		}
	}
	if (!replaced) {
		updatedEntries.push({ name: targetDir, mode: MODE_DIR, hash: newSubtreeHash, type: 'tree' });
	}

	return storeTree(repoDir, updatedEntries);
}

/**
 * Build the leaf-level tree of an `updateSubtree` operation.
 *
 * - {@link MergeMode.ReplaceAll} (or empty existing tree): write `newEntries`
 *   verbatim.
 * - {@link MergeMode.MergeKeepExisting}: keep existing entries, overwrite by
 *   name, drop entries listed in `opts.deleteNames`.
 */
async function buildLeafTree(
	repoDir: string,
	existingTreeHash: string,
	newEntries: TreeEntry[],
	opts: UpdateSubtreeOptions,
): Promise<string> {
	if (opts.mergeMode === MergeMode.ReplaceAll || existingTreeHash === ZERO_HASH) {
		return storeTree(repoDir, [...newEntries]);
	}

	let existing: TreeEntry[];
	try {
		existing = await readTreeEntries(repoDir, existingTreeHash);
	} catch {
		// Mirror Go fallback: if the existing tree can't be read, write new entries verbatim.
		return storeTree(repoDir, [...newEntries]);
	}

	const newByName = new Map<string, TreeEntry>();
	for (const e of newEntries) {
		newByName.set(e.name, e);
	}

	const deleteSet = new Set<string>(opts.deleteNames ?? []);

	const merged: TreeEntry[] = [];
	for (const e of existing) {
		if (deleteSet.has(e.name)) {
			continue;
		}
		const replacement = newByName.get(e.name);
		if (replacement !== undefined) {
			merged.push(replacement);
			newByName.delete(e.name);
		} else {
			merged.push(e);
		}
	}
	for (const e of newEntries) {
		if (newByName.has(e.name)) {
			merged.push(e);
		}
	}

	return storeTree(repoDir, merged);
}

/**
 * Iterate over a two-level shard structure (`<id[:2]>/<id[2:]>/`) inside a
 * tree, calling `fn` for each well-formed checkpoint subtree.
 *
 * Skips entries that aren't directories at either level (e.g. a stray
 * `generation.json` blob at the root), and skips bucket directories whose
 * name isn't exactly 2 chars. The callback receives the parsed checkpoint ID
 * and the inner tree hash; iteration stops if the callback throws.
 *
 * @param repoDir absolute path to the git repo
 * @param treeHash hash of the root tree containing the shard buckets
 * @param fn callback invoked for each checkpoint
 *
 * @example
 * ```ts
 * // Collect every committed-checkpoint metadata blob's hash.
 * const found: Array<[string, string]> = [];
 * await walkCheckpointShards(repoDir, metadataRootTree, async (id, treeHash) => {
 *   const entries = await readTree(repoDir, treeHash);
 *   const meta = entries.find(e => e.name === 'metadata.json');
 *   if (meta !== undefined) {
 *     found.push([id, meta.hash]);
 *   }
 * });
 * ```
 */
export async function walkCheckpointShards(
	repoDir: string,
	treeHash: string,
	fn: (cpId: CheckpointID, cpTreeHash: string) => Promise<void>,
): Promise<void> {
	const buckets = await readTreeEntries(repoDir, treeHash);
	for (const bucket of buckets) {
		if (bucket.type !== 'tree') {
			continue;
		}
		if (bucket.name.length !== 2) {
			continue;
		}

		let inner: TreeEntry[];
		try {
			inner = await readTreeEntries(repoDir, bucket.hash);
		} catch {
			continue;
		}

		for (const cp of inner) {
			if (cp.type !== 'tree') {
				continue;
			}
			const candidate = bucket.name + cp.name;
			if (validateCheckpointID(candidate) !== null) {
				continue;
			}
			await fn(candidate as CheckpointID, cp.hash);
		}
	}
}
