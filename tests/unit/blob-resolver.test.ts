import fsCallback from 'node:fs';
import git from 'isomorphic-git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BlobResolver, collectTranscriptBlobHashes } from '@/checkpoint/blob-resolver';
import { TestEnv } from '../helpers/test-env';

/**
 * Build a checkpoint subtree directly via plumbing so the tests don't depend
 * on writeCommitted (which only lands in Task 6). Layout per session:
 *
 *   <checkpointPath>/
 *     <sessionIndex>/
 *       full.jsonl       — transcript bytes
 *       full.jsonl.001   — optional chunk
 */
async function buildCheckpointTree(
	env: TestEnv,
	checkpointId: string,
	sessions: Array<{ transcript: string; chunks?: string[] }>,
): Promise<{ rootTreeHash: string; sessionBlobHashes: string[][] }> {
	const sessionBlobHashes: string[][] = [];
	const sessionEntries: Array<{ index: number; treeHash: string }> = [];
	for (let i = 0; i < sessions.length; i++) {
		const session = sessions[i]!;
		const transcriptBlob = await env.writeBlob(session.transcript);
		const blobHashes = [transcriptBlob];
		const sessionTreeEntries: Array<{
			mode: string;
			path: string;
			oid: string;
			type: 'blob' | 'tree' | 'commit';
		}> = [{ mode: '100644', path: 'full.jsonl', oid: transcriptBlob, type: 'blob' }];
		if (session.chunks !== undefined) {
			for (let c = 0; c < session.chunks.length; c++) {
				const chunkBlob = await env.writeBlob(session.chunks[c]!);
				blobHashes.push(chunkBlob);
				const idx = c + 1;
				sessionTreeEntries.push({
					mode: '100644',
					path: `full.jsonl.${idx.toString().padStart(3, '0')}`,
					oid: chunkBlob,
					type: 'blob',
				});
			}
		}
		const sessionTree = await env.writeTree(sessionTreeEntries);
		sessionEntries.push({ index: i, treeHash: sessionTree });
		sessionBlobHashes.push(blobHashes);
	}

	const cpDirEntries = sessionEntries.map((s) => ({
		mode: '040000',
		path: String(s.index),
		oid: s.treeHash,
		type: 'tree' as const,
	}));
	const cpDirTree = await env.writeTree(cpDirEntries);
	const idShard = checkpointId.slice(0, 2);
	const idTail = checkpointId.slice(2);
	const shardTree = await env.writeTree([
		{ mode: '040000', path: idTail, oid: cpDirTree, type: 'tree' },
	]);
	const rootTree = await env.writeTree([
		{ mode: '040000', path: idShard, oid: shardTree, type: 'tree' },
	]);

	return { rootTreeHash: rootTree, sessionBlobHashes };
}

describe('BlobResolver', () => {
	let env: TestEnv;

	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
	});

	afterEach(async () => {
		await env.cleanup();
	});

	it('hasBlob returns true for an existing transcript blob', async () => {
		// Go: TestBlobResolver_HasBlob_Present.
		const { sessionBlobHashes } = await buildCheckpointTree(env, 'a3b2c4d5e6f7', [
			{ transcript: 'hello transcript' },
		]);
		const r = new BlobResolver(env.dir);
		expect(await r.hasBlob(sessionBlobHashes[0]![0]!)).toBe(true);
	});

	it('hasBlob returns false for a fabricated hash', async () => {
		// Go: TestBlobResolver_HasBlob_Missing.
		const r = new BlobResolver(env.dir);
		// 40-char hex that almost certainly does not exist locally.
		const fake = '0123456789abcdef0123456789abcdef01234567';
		expect(await r.hasBlob(fake)).toBe(false);
	});

	it('readBlob returns the bytes that were written', async () => {
		// Go: TestBlobResolver_ReadBlob.
		const { sessionBlobHashes } = await buildCheckpointTree(env, 'a3b2c4d5e6f7', [
			{ transcript: 'roundtrip body' },
		]);
		const r = new BlobResolver(env.dir);
		const out = await r.readBlob(sessionBlobHashes[0]![0]!);
		expect(new TextDecoder().decode(out)).toBe('roundtrip body');
	});

	it('readBlob throws for a non-existent hash', async () => {
		// Go: TestBlobResolver_ReadBlob_Missing.
		const r = new BlobResolver(env.dir);
		const fake = 'fedcba9876543210fedcba9876543210fedcba98';
		await expect(r.readBlob(fake)).rejects.toThrow();
	});
});

describe('collectTranscriptBlobHashes', () => {
	let env: TestEnv;

	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
	});

	afterEach(async () => {
		await env.cleanup();
	});

	it('collects a single session transcript blob hash', async () => {
		// Go: TestCollectTranscriptBlobHashes_SingleSession.
		const { rootTreeHash, sessionBlobHashes } = await buildCheckpointTree(env, 'a3b2c4d5e6f7', [
			{ transcript: 'one session' },
		]);
		const refs = await collectTranscriptBlobHashes(env.dir, rootTreeHash, 'a3b2c4d5e6f7');
		expect(refs).toEqual([
			{ sessionIndex: 0, hash: sessionBlobHashes[0]![0]!, path: '0/full.jsonl' },
		]);
		expect(refs[0]!.hash).toMatch(/^[0-9a-f]{40}$/);
	});

	it('collects transcripts (and chunks) across multiple sessions', async () => {
		// Go: TestCollectTranscriptBlobHashes_MultiSession.
		const { rootTreeHash, sessionBlobHashes } = await buildCheckpointTree(env, 'f0469a040e08', [
			{ transcript: 'session 0', chunks: ['chunk-1-of-0', 'chunk-2-of-0'] },
			{ transcript: 'session 1' },
		]);
		const refs = await collectTranscriptBlobHashes(env.dir, rootTreeHash, 'f0469a040e08');

		// Session 0: full.jsonl + full.jsonl.001 + full.jsonl.002.
		const s0 = refs
			.filter((r) => r.sessionIndex === 0)
			.map((r) => r.path)
			.sort();
		expect(s0).toEqual(['0/full.jsonl', '0/full.jsonl.001', '0/full.jsonl.002']);
		// Session 1: full.jsonl only.
		const s1 = refs
			.filter((r) => r.sessionIndex === 1)
			.map((r) => r.path)
			.sort();
		expect(s1).toEqual(['1/full.jsonl']);

		// Hashes match what we wrote.
		const hashesS0 = refs
			.filter((r) => r.sessionIndex === 0)
			.sort((a, b) => a.path.localeCompare(b.path))
			.map((r) => r.hash);
		expect(hashesS0).toEqual(sessionBlobHashes[0]);

		// All hashes resolve through the resolver too.
		const r = new BlobResolver(env.dir);
		for (const ref of refs) {
			expect(await r.hasBlob(ref.hash)).toBe(true);
		}
	});

	it('throws for a non-existent checkpoint id', async () => {
		// Go: TestCollectTranscriptBlobHashes_NonexistentCheckpoint.
		const { rootTreeHash } = await buildCheckpointTree(env, 'a3b2c4d5e6f7', [
			{ transcript: 'present' },
		]);
		await expect(
			collectTranscriptBlobHashes(env.dir, rootTreeHash, 'deadbeefcafe'),
		).rejects.toThrow(/checkpoint tree de\/adbeefcafe/);
	});

	it('only includes valid transcript files (legacy + chunks), ignoring metadata.json', async () => {
		// Build a session tree with metadata.json + full.jsonl.legacy + chunks
		// to confirm the path filter doesn't pull in unrelated entries.
		const transcriptBlob = await env.writeBlob('text');
		const legacyBlob = await env.writeBlob('legacy text');
		const metaBlob = await env.writeBlob('{"meta":true}');
		const noiseBlob = await env.writeBlob('noise');
		const sessionTree = await env.writeTree([
			{ mode: '100644', path: 'full.jsonl', oid: transcriptBlob, type: 'blob' },
			{ mode: '100644', path: 'full.jsonl.001', oid: noiseBlob, type: 'blob' },
			{ mode: '100644', path: 'full.log', oid: legacyBlob, type: 'blob' },
			{ mode: '100644', path: 'metadata.json', oid: metaBlob, type: 'blob' },
		]);
		const cpDirTree = await env.writeTree([
			{ mode: '040000', path: '0', oid: sessionTree, type: 'tree' },
		]);
		const shardTree = await env.writeTree([
			{ mode: '040000', path: 'b2c4d5e6f7', oid: cpDirTree, type: 'tree' },
		]);
		const rootTree = await env.writeTree([
			{ mode: '040000', path: 'a3', oid: shardTree, type: 'tree' },
		]);

		const refs = await collectTranscriptBlobHashes(env.dir, rootTree, 'a3b2c4d5e6f7');
		const paths = refs.map((r) => r.path).sort();
		expect(paths).toEqual(['0/full.jsonl', '0/full.jsonl.001', '0/full.log']);
	});
});

// Sanity check: confirm a low-level isomorphic-git readBlob actually
// surfaces the bytes we passed through env.writeBlob — protects future
// refactors from silently regressing the BlobResolver primitive.
describe('BlobResolver internal contract', () => {
	let env: TestEnv;

	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
	});

	afterEach(async () => {
		await env.cleanup();
	});

	it('round-trips through git.readBlob with byte equality', async () => {
		const oid = await env.writeBlob('check');
		const { blob } = await git.readBlob({ fs: fsCallback, dir: env.dir, oid });
		expect(new TextDecoder().decode(blob)).toBe('check');
	});
});
