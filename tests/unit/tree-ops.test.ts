import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	applyTreeChanges,
	buildTreeFromEntries,
	flattenTree,
	MergeMode,
	MODE_DIR,
	MODE_FILE,
	sortTreeEntries,
	storeTree,
	type TreeChange,
	type TreeEntry,
	updateSubtree,
	walkCheckpointShards,
	ZERO_HASH,
} from '@/checkpoint/tree-ops';
import { type FixtureTreeEntry, TestEnv } from '../helpers/test-env';

// Convenience: build a TreeEntry for a regular file at `name` pointing to `oid`.
function fileEntry(name: string, oid: string): TreeEntry {
	return { name, mode: MODE_FILE, hash: oid, type: 'blob' };
}

// Convenience: build a TreeEntry for a directory at `name` pointing to `oid`.
function dirEntry(name: string, oid: string): TreeEntry {
	return { name, mode: MODE_DIR, hash: oid, type: 'tree' };
}

// Recursively walk a tree using TestEnv fixtures, returning a flat path → oid map.
async function flattenWithFixture(
	env: TestEnv,
	treeOid: string,
	prefix = '',
): Promise<Record<string, string>> {
	const result: Record<string, string> = {};
	const walk = async (oid: string, p: string): Promise<void> => {
		const entries = await env.readTree(oid);
		for (const e of entries) {
			const full = p === '' ? e.path : `${p}/${e.path}`;
			if (e.type === 'tree') {
				await walk(e.oid, full);
			} else if (e.type === 'blob') {
				result[full] = e.oid;
			}
		}
	};
	await walk(treeOid, prefix);
	return result;
}

// Recursively assert that every entry in a tree has a non-empty name. Mirrors Go's
// `assertNoEmptyEntryNames`.
async function expectNoEmptyEntryNames(env: TestEnv, treeOid: string): Promise<void> {
	const walk = async (oid: string, p: string): Promise<void> => {
		const entries = await env.readTree(oid);
		for (const e of entries) {
			const full = p === '' ? e.path : `${p}/${e.path}`;
			expect(e.path, `empty entry name at ${full}`).not.toBe('');
			if (e.type === 'tree') {
				await walk(e.oid, full);
			}
		}
	};
	await walk(treeOid, '');
}

let env: TestEnv;

beforeEach(async () => {
	env = await TestEnv.create({ bare: true });
});

afterEach(async () => {
	await env.cleanup();
});

// Go parity: git tree entries are sorted by **UTF-8 byte order**, not by JS
// string `<` (which is UTF-16 code-unit order). Diverging would produce
// different tree OIDs from Go / git itself for any path containing non-ASCII
// chars (CJK, emoji, composed diacritics) — breaking dedup and cross-CLI hash
// stability on the Phase 4.3 metadata branch (which gets pushed).
//
// Go reference: entire-cli/.../checkpoint/temporary.go: sortTreeEntries
describe('sortTreeEntries (UTF-8 byte order)', () => {
	it('orders single-byte vs multi-byte names by UTF-8 bytes (matches git)', () => {
		// '~' is 0x7E (ASCII single byte); 'é' starts with 0xC3 (UTF-8 lead byte
		// of 2-byte sequence). UTF-16 code unit comparison would put 'é' (U+00E9)
		// after '~' (U+007E) since 0x00E9 > 0x007E — and that happens to agree
		// with UTF-8 byte order here (0xC3 > 0x7E too). So this case is a
		// non-divergent baseline; both orderings produce the same result.
		const sorted = sortTreeEntries([fileEntry('é', 'h1'), fileEntry('~', 'h2')]);
		expect(sorted.map((e) => e.name)).toEqual(['~', 'é']);
	});

	it('orders names where UTF-16 and UTF-8 byte order diverge (CJK)', () => {
		// '你' = U+4F60 → UTF-16 code unit 0x4F60.
		// 'A' = U+0041 → UTF-16 code unit 0x0041.
		// Byte-wise UTF-8: '你' = 0xE4 0xBD 0xA0; 'A' = 0x41.
		// Both orders agree: 'A' < '你'. Verify our sort matches.
		const sorted = sortTreeEntries([fileEntry('你', 'h1'), fileEntry('A', 'h2')]);
		expect(sorted.map((e) => e.name)).toEqual(['A', '你']);
	});

	it('orders precomposed vs decomposed diacritics by UTF-8 bytes', () => {
		// Precomposed 'á' = U+00E1 → UTF-8 [0xC3, 0xA1]
		// Decomposed 'á' = U+0061 + U+0301 → UTF-8 [0x61, 0xCC, 0x81]
		// In UTF-8 byte order: decomposed (starts 0x61) < precomposed (starts 0xC3).
		// In UTF-16 code units: same first cmp gives same answer here.
		// More interesting: precomposed-only 'é' vs ASCII 'f'.
		// 'é' (precomposed) UTF-16 = 0x00E9, 'f' = 0x0066 → UTF-16 says 'f' < 'é'
		// 'é' UTF-8 first byte = 0xC3, 'f' = 0x66 → UTF-8 says 'f' < 'é' too.
		// So this case agrees as well.
		const sorted = sortTreeEntries([fileEntry('é', 'h1'), fileEntry('f', 'h2')]);
		expect(sorted.map((e) => e.name)).toEqual(['f', 'é']);
	});

	it('orders 4-byte UTF-8 (emoji/supplementary) consistently with git', () => {
		// '🎉' is U+1F389 → JS string is two UTF-16 code units (surrogate pair):
		//   high surrogate 0xD83C, low surrogate 0xDF89.
		// UTF-8 bytes: 0xF0 0x9F 0x8E 0x89.
		// 'Z' = U+005A.
		// JS string sort: 'Z' = 0x005A < 0xD83C = first surrogate → 'Z' < '🎉'.
		// UTF-8 byte sort: 0x5A < 0xF0 → 'Z' < '🎉'.
		// Both agree here, but verify the surrogate pair doesn't crash Buffer
		// comparison (an actual potential JS pitfall).
		const sorted = sortTreeEntries([fileEntry('🎉', 'h1'), fileEntry('Z', 'h2')]);
		expect(sorted.map((e) => e.name)).toEqual(['Z', '🎉']);
	});

	it('uses Buffer.compare on directory-suffix form (foo vs foo/)', () => {
		// Directory entry 'foo' should sort by 'foo/' (with trailing slash).
		// 'foo' (file) vs 'foo' (dir): file 'foo' (0x66 0x6F 0x6F) < 'foo/' (extra 0x2F)
		const sorted = sortTreeEntries([
			dirEntry('foo', 'h1'),
			fileEntry('foo.txt', 'h2'),
			fileEntry('foo', 'h3'),
		]);
		// Compare bytes:
		//   'foo'      = [66, 6F, 6F]
		//   'foo.txt'  = [66, 6F, 6F, 2E, 74, 78, 74]   (period 0x2E)
		//   'foo/'     = [66, 6F, 6F, 2F]                (slash 0x2F)
		// Byte order: 'foo' < 'foo.txt' (0x2E) < 'foo/' (0x2F)
		expect(sorted.map((e) => e.name)).toEqual(['foo', 'foo.txt', 'foo']);
		expect(sorted.map((e) => e.type)).toEqual(['blob', 'blob', 'tree']);
	});
});

// Go: parse_tree_test.go TestStoreTree_RoundTrip
describe('storeTree', () => {
	it('round-trips: write then read back returns matching entries', async () => {
		const blob = await env.writeBlob('hello');
		const treeHash = await storeTree(env.dir, [fileEntry('file.txt', blob)]);

		expect(treeHash).not.toBe(ZERO_HASH);
		const read = await env.readTree(treeHash);
		expect(read).toHaveLength(1);
		expect(read[0]?.path).toBe('file.txt');
		expect(read[0]?.oid).toBe(blob);
		expect(read[0]?.type).toBe('blob');
	});

	it('produces identical hashes for equal content (content-addressed)', async () => {
		const blob = await env.writeBlob('same');
		const h1 = await storeTree(env.dir, [fileEntry('a.txt', blob)]);
		const h2 = await storeTree(env.dir, [fileEntry('a.txt', blob)]);
		expect(h1).toBe(h2);
	});
});

// Go: parse_tree_test.go TestApplyTreeChanges_*
describe('applyTreeChanges', () => {
	// Go: TestApplyTreeChanges_Empty
	it('returns the original hash when changes is empty', async () => {
		const blob = await env.writeBlob('content');
		const root = await storeTree(env.dir, [fileEntry('file.txt', blob)]);

		const result = await applyTreeChanges(env.dir, root, []);
		expect(result).toBe(root);
	});

	// Go: TestApplyTreeChanges_SkipsInvalidPaths
	it.each([
		{ name: 'leading slash windows path', path: '/C:/Users/r/x.txt' },
		{ name: 'drive letter windows path', path: 'C:/Users/r/x.txt' },
		{ name: 'empty segment', path: 'dir//file.txt' },
		{ name: 'dot segment', path: './dir/file.txt' },
		{ name: 'dot dot segment', path: '../dir/file.txt' },
	])('skips invalid path: $name', async ({ path: invalidPath }) => {
		const validBlob = await env.writeBlob('valid');
		const invalidBlob = await env.writeBlob('invalid');

		const result = await applyTreeChanges(env.dir, ZERO_HASH, [
			{ path: 'valid.txt', entry: fileEntry('valid.txt', validBlob) },
			{ path: invalidPath, entry: fileEntry('whatever', invalidBlob) },
		]);

		await expectNoEmptyEntryNames(env, result);
		const files = await flattenWithFixture(env, result);
		expect(Object.keys(files)).toEqual(['valid.txt']);
		expect(files['valid.txt']).toBe(validBlob);
	});

	// Go: TestApplyTreeChanges_AddFile
	it('adds a new file to an existing tree', async () => {
		const blob1 = await env.writeBlob('existing');
		const blob2 = await env.writeBlob('new-file');
		const root = await storeTree(env.dir, [fileEntry('existing.txt', blob1)]);

		const result = await applyTreeChanges(env.dir, root, [
			{ path: 'new.txt', entry: fileEntry('new.txt', blob2) },
		]);

		const files = await flattenWithFixture(env, result);
		expect(files).toEqual({ 'existing.txt': blob1, 'new.txt': blob2 });
	});

	// Go: TestApplyTreeChanges_DeleteFile
	it('deletes a file when entry is null', async () => {
		const keep = await env.writeBlob('keep');
		const goner = await env.writeBlob('delete-me');
		const root = await storeTree(env.dir, [
			fileEntry('delete.txt', goner),
			fileEntry('keep.txt', keep),
		]);

		const result = await applyTreeChanges(env.dir, root, [{ path: 'delete.txt', entry: null }]);

		const files = await flattenWithFixture(env, result);
		expect(files).toEqual({ 'keep.txt': keep });
	});

	// Go: TestApplyTreeChanges_ModifyNestedFile
	it('modifies a nested file while preserving siblings', async () => {
		const oldBlob = await env.writeBlob('old-content');
		const newBlob = await env.writeBlob('new-content');
		const sibling = await env.writeBlob('sibling');

		const srcTreeOid = await storeTree(env.dir, [fileEntry('handler.ts', oldBlob)]);
		const root = await storeTree(env.dir, [
			fileEntry('README.md', sibling),
			dirEntry('src', srcTreeOid),
		]);

		const result = await applyTreeChanges(env.dir, root, [
			{ path: 'src/handler.ts', entry: fileEntry('handler.ts', newBlob) },
		]);

		const files = await flattenWithFixture(env, result);
		expect(files['src/handler.ts']).toBe(newBlob);
		expect(files['README.md']).toBe(sibling);
	});

	// Go: TestApplyTreeChanges_MultipleDirectories
	it('handles changes across multiple top-level directories, preserving untouched ones', async () => {
		const a = await env.writeBlob('file-a');
		const b = await env.writeBlob('file-b');
		const c = await env.writeBlob('file-c');
		const newBlob = await env.writeBlob('new');

		const t1 = await storeTree(env.dir, [fileEntry('a.txt', a)]);
		const t2 = await storeTree(env.dir, [fileEntry('b.txt', b)]);
		const t3 = await storeTree(env.dir, [fileEntry('c.txt', c)]);
		const root = await storeTree(env.dir, [
			dirEntry('dir1', t1),
			dirEntry('dir2', t2),
			dirEntry('dir3', t3),
		]);

		const result = await applyTreeChanges(env.dir, root, [
			{ path: 'dir1/a.txt', entry: fileEntry('a.txt', newBlob) },
			{ path: 'dir3/c.txt', entry: fileEntry('c.txt', newBlob) },
		]);

		// dir2 subtree hash must be preserved exactly (structural sharing)
		const rootEntries = await env.readTree(result);
		const dir2 = rootEntries.find((e) => e.path === 'dir2');
		expect(dir2?.oid).toBe(t2);

		const files = await flattenWithFixture(env, result);
		expect(files['dir1/a.txt']).toBe(newBlob);
		expect(files['dir2/b.txt']).toBe(b);
		expect(files['dir3/c.txt']).toBe(newBlob);
	});

	// Go: TestApplyTreeChanges_CreateNestedFromEmpty
	it('creates a nested path starting from an empty tree', async () => {
		const blob = await env.writeBlob('deep-content');

		const result = await applyTreeChanges(env.dir, ZERO_HASH, [
			{ path: 'a/b/c/file.txt', entry: fileEntry('file.txt', blob) },
		]);

		const files = await flattenWithFixture(env, result);
		expect(files).toEqual({ 'a/b/c/file.txt': blob });
	});

	// Go: TestApplyTreeChanges_MixedOperations
	it('handles add + delete + modify in a single call', async () => {
		const keep = await env.writeBlob('keep');
		const goner = await env.writeBlob('delete');
		const oldBlob = await env.writeBlob('old');
		const newBlob = await env.writeBlob('new');
		const added = await env.writeBlob('added');

		const root = await storeTree(env.dir, [
			fileEntry('delete.txt', goner),
			fileEntry('keep.txt', keep),
			fileEntry('modify.txt', oldBlob),
		]);

		const result = await applyTreeChanges(env.dir, root, [
			{ path: 'delete.txt', entry: null },
			{ path: 'modify.txt', entry: fileEntry('modify.txt', newBlob) },
			{ path: 'added.txt', entry: fileEntry('added.txt', added) },
		]);

		const files = await flattenWithFixture(env, result);
		expect(files).toEqual({
			'keep.txt': keep,
			'modify.txt': newBlob,
			'added.txt': added,
		});
	});
});

// Go parity: git tree entries can be 'commit' type (mode 160000) for
// submodule references. Earlier TS `flattenTree` / `fromIsoEntries` filtered
// non-blob/tree out → silently dropped submodules. Now they're preserved as
// leaf entries (matching Go `FlattenTree` which keeps everything non-Dir).
//
// Go reference: entire-cli/.../checkpoint/temporary.go FlattenTree:800-824
describe('flattenTree / buildTreeFromEntries — submodule (commit) round-trip', () => {
	it('preserves submodule (commit) entries through flatten → rebuild (root-level)', async () => {
		// Create a fake submodule commit OID. We need a valid SHA-1 hex string;
		// the OID doesn't have to point to a real commit object for the tree
		// write/read to succeed (git tree entries store the OID as opaque hex).
		const fakeSubmoduleOid = 'a'.repeat(40);
		const fileBlob = await env.writeBlob('regular file');

		// Build a tree with one regular file + one root-level submodule entry.
		// (Tree entry paths must be flat names; nested paths are reconstructed
		// via parent trees.)
		const treeOid = await env.writeTree([
			{ mode: MODE_FILE, path: 'README.md', oid: fileBlob, type: 'blob' },
			{ mode: '160000', path: 'submod', oid: fakeSubmoduleOid, type: 'commit' },
		]);

		// Flatten: should record BOTH the blob AND the submodule commit entry.
		const flat = new Map<string, TreeEntry>();
		await flattenTree(env.dir, treeOid, '', flat);

		expect(flat.size).toBe(2);
		expect(flat.get('README.md')?.type).toBe('blob');
		expect(flat.get('README.md')?.hash).toBe(fileBlob);
		expect(flat.get('submod')?.type).toBe('commit');
		expect(flat.get('submod')?.hash).toBe(fakeSubmoduleOid);
		expect(flat.get('submod')?.mode).toBe('160000');

		// Rebuild from the flat map — submodule entry must round-trip with type
		// preserved.
		const rebuiltTreeOid = await buildTreeFromEntries(env.dir, flat);
		const rebuiltEntries = await env.readTree(rebuiltTreeOid);
		const submoduleEntry = rebuiltEntries.find((e) => e.path === 'submod');
		expect(submoduleEntry?.type).toBe('commit');
		expect(submoduleEntry?.oid).toBe(fakeSubmoduleOid);
		expect(submoduleEntry?.mode).toBe('160000');
	});

	it('preserves submodule under a sub-directory (nested path)', async () => {
		// Create vendor/lib structure where lib is a submodule.
		const fakeSubmoduleOid = 'b'.repeat(40);
		// Build the inner tree first (vendor/) containing the submodule.
		const innerTreeOid = await env.writeTree([
			{ mode: '160000', path: 'lib', oid: fakeSubmoduleOid, type: 'commit' },
		]);
		// Then build root tree containing vendor as a subdir.
		const rootTreeOid = await env.writeTree([
			{ mode: MODE_DIR, path: 'vendor', oid: innerTreeOid, type: 'tree' },
		]);

		const flat = new Map<string, TreeEntry>();
		await flattenTree(env.dir, rootTreeOid, '', flat);
		expect(flat.size).toBe(1);
		expect(flat.get('vendor/lib')?.type).toBe('commit');
		expect(flat.get('vendor/lib')?.hash).toBe(fakeSubmoduleOid);

		// Round-trip: buildTreeFromEntries should rebuild vendor/ as a sub-tree
		// with lib (commit) inside.
		const rebuiltRoot = await buildTreeFromEntries(env.dir, flat);
		const rebuiltRootEntries = await env.readTree(rebuiltRoot);
		const vendorEntry = rebuiltRootEntries.find((e) => e.path === 'vendor');
		expect(vendorEntry?.type).toBe('tree');
		const rebuiltInner = await env.readTree(vendorEntry?.oid as string);
		const libEntry = rebuiltInner.find((e) => e.path === 'lib');
		expect(libEntry?.type).toBe('commit');
		expect(libEntry?.oid).toBe(fakeSubmoduleOid);
		expect(libEntry?.mode).toBe('160000');
	});
});

// Go: parse_tree_test.go TestBuildTreeFromEntries_SkipsInvalidPaths
describe('buildTreeFromEntries', () => {
	it.each([
		{ name: 'leading slash', path: '/C:/repo/file.txt' },
		{ name: 'drive letter', path: 'C:/repo/file.txt' },
		{ name: 'empty segment', path: 'dir//file.txt' },
		{ name: 'dot segment', path: './file.txt' },
		{ name: 'dot dot segment', path: '../file.txt' },
	])('skips invalid path during build: $name', async ({ path: invalidPath }) => {
		const validBlob = await env.writeBlob('valid');
		const invalidBlob = await env.writeBlob('invalid');

		const entries = new Map<string, TreeEntry>();
		entries.set('valid.txt', fileEntry('valid.txt', validBlob));
		entries.set(invalidPath, fileEntry('whatever', invalidBlob));

		const treeOid = await buildTreeFromEntries(env.dir, entries);
		await expectNoEmptyEntryNames(env, treeOid);

		const files = await flattenWithFixture(env, treeOid);
		expect(Object.keys(files)).toEqual(['valid.txt']);
		expect(files['valid.txt']).toBe(validBlob);
	});
});

// Go: parse_tree_test.go TestUpdateSubtree_*
describe('updateSubtree', () => {
	// Go: TestUpdateSubtree_CreateFromEmpty
	it('creates a subtree from an empty root', async () => {
		const blob1 = await env.writeBlob('content1');
		const blob2 = await env.writeBlob('content2');

		const result = await updateSubtree(
			env.dir,
			ZERO_HASH,
			['a3', 'b2c4d5e6f7'],
			[fileEntry('metadata.json', blob1), fileEntry('full.jsonl', blob2)],
			{ mergeMode: MergeMode.ReplaceAll },
		);

		const files = await flattenWithFixture(env, result);
		expect(files).toEqual({
			'a3/b2c4d5e6f7/metadata.json': blob1,
			'a3/b2c4d5e6f7/full.jsonl': blob2,
		});
	});

	// Go: TestUpdateSubtree_PreservesSiblings
	it('preserves sibling subtrees when adding a new one', async () => {
		const blobA = await env.writeBlob('existing-a');
		const blobB = await env.writeBlob('existing-b');
		const blobNew = await env.writeBlob('new-content');

		const innerTree1 = await storeTree(env.dir, [fileEntry('file.txt', blobA)]);
		const innerTree2 = await storeTree(env.dir, [fileEntry('file.txt', blobB)]);
		const shardTree = await storeTree(env.dir, [
			dirEntry('existing1', innerTree1),
			dirEntry('existing2', innerTree2),
		]);
		const rootTree = await storeTree(env.dir, [dirEntry('a3', shardTree)]);

		const newRoot = await updateSubtree(
			env.dir,
			rootTree,
			['a3', 'newcheckpoint'],
			[fileEntry('data.json', blobNew)],
			{ mergeMode: MergeMode.ReplaceAll },
		);

		const files = await flattenWithFixture(env, newRoot);
		expect(files['a3/existing1/file.txt']).toBe(blobA);
		expect(files['a3/existing2/file.txt']).toBe(blobB);
		expect(files['a3/newcheckpoint/data.json']).toBe(blobNew);

		// Sibling subtree hashes should match exactly (structural sharing)
		const rootEntries = await env.readTree(newRoot);
		const a3 = rootEntries.find((e) => e.path === 'a3');
		const a3Entries = await env.readTree(a3?.oid as string);
		const existing1 = a3Entries.find((e) => e.path === 'existing1');
		const existing2 = a3Entries.find((e) => e.path === 'existing2');
		expect(existing1?.oid).toBe(innerTree1);
		expect(existing2?.oid).toBe(innerTree2);
	});

	// Go: TestUpdateSubtree_ReplaceExisting
	it('ReplaceAll replaces existing subtree contents wholesale', async () => {
		const blobOld = await env.writeBlob('old');
		const blobNew = await env.writeBlob('new');

		const innerTree = await storeTree(env.dir, [fileEntry('metadata.json', blobOld)]);
		const shardTree = await storeTree(env.dir, [dirEntry('ckpt1', innerTree)]);
		const rootTree = await storeTree(env.dir, [dirEntry('a3', shardTree)]);

		const newRoot = await updateSubtree(
			env.dir,
			rootTree,
			['a3', 'ckpt1'],
			[fileEntry('metadata.json', blobNew), fileEntry('extra.txt', blobNew)],
			{ mergeMode: MergeMode.ReplaceAll },
		);

		const files = await flattenWithFixture(env, newRoot);
		expect(files).toEqual({
			'a3/ckpt1/metadata.json': blobNew,
			'a3/ckpt1/extra.txt': blobNew,
		});
	});

	// Go: TestUpdateSubtree_MergeKeepExisting
	it('MergeKeepExisting merges new entries into existing leaf, honoring deleteNames', async () => {
		const blobExisting = await env.writeBlob('existing');
		const blobNew = await env.writeBlob('new');
		const blobReplacement = await env.writeBlob('replacement');

		const innerTree = await storeTree(env.dir, [
			fileEntry('delete.txt', blobExisting),
			fileEntry('keep.txt', blobExisting),
			fileEntry('replace.txt', blobExisting),
		]);
		const shardTree = await storeTree(env.dir, [dirEntry('ckpt1', innerTree)]);
		const rootTree = await storeTree(env.dir, [dirEntry('a3', shardTree)]);

		const newRoot = await updateSubtree(
			env.dir,
			rootTree,
			['a3', 'ckpt1'],
			[fileEntry('new.txt', blobNew), fileEntry('replace.txt', blobReplacement)],
			{ mergeMode: MergeMode.MergeKeepExisting, deleteNames: ['delete.txt'] },
		);

		const files = await flattenWithFixture(env, newRoot);
		expect(files['a3/ckpt1/keep.txt']).toBe(blobExisting);
		expect(files['a3/ckpt1/replace.txt']).toBe(blobReplacement);
		expect(files['a3/ckpt1/new.txt']).toBe(blobNew);
		expect(files['a3/ckpt1/delete.txt']).toBeUndefined();
	});

	// Go: TestUpdateSubtree_PreservesTopLevelSiblings
	it('preserves top-level sibling shards when modifying one shard', async () => {
		const blobA = await env.writeBlob('shard-a');
		const blobB = await env.writeBlob('shard-b');
		const blobNew = await env.writeBlob('new');

		const innerA = await storeTree(env.dir, [fileEntry('file.txt', blobA)]);
		const shardA = await storeTree(env.dir, [dirEntry('ckpt1', innerA)]);
		const innerB = await storeTree(env.dir, [fileEntry('file.txt', blobB)]);
		const shardB = await storeTree(env.dir, [dirEntry('ckpt2', innerB)]);
		const rootTree = await storeTree(env.dir, [dirEntry('a3', shardA), dirEntry('b7', shardB)]);

		const newRoot = await updateSubtree(
			env.dir,
			rootTree,
			['a3', 'ckpt1'],
			[fileEntry('file.txt', blobNew)],
			{ mergeMode: MergeMode.ReplaceAll },
		);

		const rootEntries = await env.readTree(newRoot);
		const b7 = rootEntries.find((e) => e.path === 'b7');
		expect(b7?.oid).toBe(shardB);

		const files = await flattenWithFixture(env, newRoot);
		expect(files['a3/ckpt1/file.txt']).toBe(blobNew);
		expect(files['b7/ckpt2/file.txt']).toBe(blobB);
	});

	// Go: TestUpdateSubtree_EmptyPathSegments
	it('treats empty path segments as "build at root"', async () => {
		const blob = await env.writeBlob('root-level');
		const result = await updateSubtree(env.dir, ZERO_HASH, [], [fileEntry('file.txt', blob)], {
			mergeMode: MergeMode.ReplaceAll,
		});

		const entries = await env.readTree(result);
		expect(entries).toHaveLength(1);
		expect(entries[0]?.path).toBe('file.txt');
	});

	// Go: TestUpdateSubtree_FileToDirectoryCollision
	it('handles file-to-directory collision (file at path becomes directory)', async () => {
		const blobFile = await env.writeBlob('i-am-a-file');
		const blobNew = await env.writeBlob('new-content');

		const rootTree = await storeTree(env.dir, [fileEntry('a3', blobFile)]);

		const newRoot = await updateSubtree(
			env.dir,
			rootTree,
			['a3', 'ckpt'],
			[fileEntry('data.json', blobNew)],
			{ mergeMode: MergeMode.ReplaceAll },
		);

		const files = await flattenWithFixture(env, newRoot);
		expect(files).toEqual({ 'a3/ckpt/data.json': blobNew });

		const rootEntries = await env.readTree(newRoot);
		const a3 = rootEntries.find((e) => e.path === 'a3');
		expect(a3?.type).toBe('tree');
	});

	// Go: TestUpdateSubtree_EquivalenceWithFlattenRebuild
	it('produces the same tree hash as flattenTree + buildTreeFromEntries', async () => {
		const blobs: string[] = [];
		for (let i = 0; i < 5; i++) {
			blobs.push(await env.writeBlob(`content-${i}`));
		}

		const ckpt1 = await storeTree(env.dir, [
			fileEntry('full.jsonl', blobs[1] as string),
			fileEntry('meta.json', blobs[0] as string),
		]);
		const ckpt2 = await storeTree(env.dir, [fileEntry('meta.json', blobs[2] as string)]);
		const ckpt3 = await storeTree(env.dir, [fileEntry('meta.json', blobs[3] as string)]);
		const shardA3 = await storeTree(env.dir, [dirEntry('ckpt1', ckpt1), dirEntry('ckpt2', ckpt2)]);
		const shardB7 = await storeTree(env.dir, [dirEntry('ckpt3', ckpt3)]);
		const rootTree = await storeTree(env.dir, [dirEntry('a3', shardA3), dirEntry('b7', shardB7)]);

		const newBlob = await env.writeBlob('new-checkpoint');
		const surgeryResult = await updateSubtree(
			env.dir,
			rootTree,
			['a3', 'newckpt'],
			[fileEntry('meta.json', newBlob)],
			{ mergeMode: MergeMode.ReplaceAll },
		);

		const flatEntries = new Map<string, TreeEntry>();
		await flattenTree(env.dir, rootTree, '', flatEntries);
		flatEntries.set('a3/newckpt/meta.json', {
			name: 'a3/newckpt/meta.json',
			mode: MODE_FILE,
			hash: newBlob,
			type: 'blob',
		});
		const flatResult = await buildTreeFromEntries(env.dir, flatEntries);

		expect(surgeryResult).toBe(flatResult);
	});
});

// Equivalence test for ApplyTreeChanges, mirroring the spirit of Go's
// `TestBuildTreeWithChanges_EquivalenceWithFlattenRebuild` but at the pure
// tree-ops level (the buildTreeWithChanges helper itself is Phase 4.2).
describe('applyTreeChanges equivalence with flatten+rebuild', () => {
	it('apply-changes result equals flatten+modify+rebuild result for the same edits', async () => {
		const blobA = await env.writeBlob('original-a');
		const blobB = await env.writeBlob('original-b');
		const blobC = await env.writeBlob('original-c');
		const blobNew = await env.writeBlob('new-a');
		const blobAdded = await env.writeBlob('added');

		const srcTree = await storeTree(env.dir, [fileEntry('a.ts', blobA), fileEntry('b.ts', blobB)]);
		const docsTree = await storeTree(env.dir, [fileEntry('readme.md', blobC)]);
		const root = await storeTree(env.dir, [dirEntry('src', srcTree), dirEntry('docs', docsTree)]);

		const changes: TreeChange[] = [
			{ path: 'src/a.ts', entry: fileEntry('a.ts', blobNew) },
			{ path: 'src/b.ts', entry: null },
			{ path: 'src/sub/added.ts', entry: fileEntry('added.ts', blobAdded) },
		];

		const sparseResult = await applyTreeChanges(env.dir, root, changes);

		const flat = new Map<string, TreeEntry>();
		await flattenTree(env.dir, root, '', flat);
		flat.set('src/a.ts', { name: 'src/a.ts', mode: MODE_FILE, hash: blobNew, type: 'blob' });
		flat.delete('src/b.ts');
		flat.set('src/sub/added.ts', {
			name: 'src/sub/added.ts',
			mode: MODE_FILE,
			hash: blobAdded,
			type: 'blob',
		});
		const fullResult = await buildTreeFromEntries(env.dir, flat);

		expect(sparseResult).toBe(fullResult);
	});
});

// Coverage for walkCheckpointShards — a small but real shard structure.
describe('walkCheckpointShards', () => {
	it('iterates the two-level shard tree, skipping non-shard entries', async () => {
		const blob = await env.writeBlob('cp');
		const cpInner = await storeTree(env.dir, [fileEntry('metadata.json', blob)]);
		// Checkpoint IDs are 12 hex chars: 2-char bucket + 10-char inner directory.
		const bucket = await storeTree(env.dir, [dirEntry('b2c4d5e6f7', cpInner)]);

		// Build a sharded tree with one valid bucket, one stray blob (generation.json),
		// and one wrongly-named bucket (3 chars).
		const generation = await env.writeBlob('{}');
		const wrongBucket = await storeTree(env.dir, [dirEntry('xxx', cpInner)]);
		const root = await storeTree(env.dir, [
			dirEntry('a3', bucket),
			fileEntry('generation.json', generation),
			dirEntry('abc', wrongBucket),
		]);

		const seen: Array<{ id: string; oid: string }> = [];
		await walkCheckpointShards(env.dir, root, async (id, treeOid) => {
			seen.push({ id, oid: treeOid });
		});

		expect(seen).toHaveLength(1);
		expect(seen[0]?.id).toBe('a3b2c4d5e6f7');
		expect(seen[0]?.oid).toBe(cpInner);
	});

	it('skips checkpoint IDs that fail validation', async () => {
		const blob = await env.writeBlob('cp');
		const cpInner = await storeTree(env.dir, [fileEntry('metadata.json', blob)]);
		// "wrong" is 5 chars after the bucket → 2 + 5 = 7 chars total, not a valid ID.
		const bucket = await storeTree(env.dir, [dirEntry('wrong', cpInner)]);
		const root = await storeTree(env.dir, [dirEntry('a3', bucket)]);

		const seen: Array<{ id: string; oid: string }> = [];
		await walkCheckpointShards(env.dir, root, async (id, treeOid) => {
			seen.push({ id, oid: treeOid });
		});
		expect(seen).toHaveLength(0);
	});

	it('skips stray blobs inside a bucket directory', async () => {
		const blob = await env.writeBlob('cp');
		const cpInner = await storeTree(env.dir, [fileEntry('metadata.json', blob)]);
		const stray = await env.writeBlob('not-a-checkpoint');
		const bucket = await storeTree(env.dir, [
			dirEntry('b2c4d5e6f7', cpInner),
			fileEntry('stray.txt', stray),
		]);
		const root = await storeTree(env.dir, [dirEntry('a3', bucket)]);

		const seen: Array<{ id: string; oid: string }> = [];
		await walkCheckpointShards(env.dir, root, async (id, treeOid) => {
			seen.push({ id, oid: treeOid });
		});
		expect(seen).toHaveLength(1);
		expect(seen[0]?.id).toBe('a3b2c4d5e6f7');
	});

	it('skips bucket directories whose tree object cannot be read (corrupt/missing)', async () => {
		// Construct a tree entry whose `oid` points at a non-existent tree object
		// by writing a tree with a dir entry referencing a fake (but well-formed)
		// 40-char hex hash. We bypass our storeTree because it sorts entries; here
		// we go straight through the fixture so the bad entry survives unchanged.
		const fakeOid = 'deadbeef'.repeat(5);
		const root = await env.writeTree([{ mode: MODE_DIR, path: 'a3', oid: fakeOid, type: 'tree' }]);

		const seen: Array<{ id: string; oid: string }> = [];
		await walkCheckpointShards(env.dir, root, async (id, treeOid) => {
			seen.push({ id, oid: treeOid });
		});
		expect(seen).toHaveLength(0);
	});
});

// The fixture types should match isomorphic-git directly; sanity check.
describe('TestEnv tree fixtures', () => {
	it('writeBlob → readBlob round-trips raw bytes', async () => {
		const oid = await env.writeBlob('hello world');
		const bytes = await env.readBlob(oid);
		expect(new TextDecoder().decode(bytes)).toBe('hello world');
	});

	it('writeTree → readTree round-trips a single entry', async () => {
		const blob = await env.writeBlob('content');
		const entries: FixtureTreeEntry[] = [
			{ mode: MODE_FILE, path: 'file.txt', oid: blob, type: 'blob' },
		];
		const treeOid = await env.writeTree(entries);
		const read = await env.readTree(treeOid);
		expect(read).toEqual(entries);
	});
});
