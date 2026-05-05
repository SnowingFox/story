/**
 * Local blob existence + read primitives, and a tree-only walker that
 * collects transcript blob hashes without requiring the blobs to be local.
 *
 * Used by the treeless-fetch flow: after `git fetch --filter=blob:none` the
 * metadata branch's tree objects are present but the transcript blobs are
 * not. {@link collectTranscriptBlobHashes} surfaces the hashes a caller
 * needs to fetch; {@link BlobResolver} answers existence + content questions
 * about whatever already lives in the local object store.
 *
 * Go reference: `entire-cli/cmd/entire/cli/checkpoint/blob_resolver.go`.
 */

import fsCallback from 'node:fs';
import git from 'isomorphic-git';
import { type CheckpointID, toPath as toCheckpointPath } from '../id';
import { parseChunkIndex } from './chunks';
import { TRANSCRIPT_FILE_NAME, TRANSCRIPT_FILE_NAME_LEGACY } from './constants';

/**
 * Reference to a transcript blob inside a committed checkpoint's tree.
 * Surfaces just the metadata needed to identify the blob (hash + tree path
 * + originating session index); the blob itself may or may not be local.
 */
export interface TranscriptBlobRef {
	/** 0-based session index within the checkpoint subtree. */
	sessionIndex: number;
	/** Git blob hash (40-char hex). */
	hash: string;
	/** Path relative to the checkpoint directory, e.g. `0/full.jsonl.001`. */
	path: string;
}

/**
 * Read-only adapter over the repo's local object store.
 *
 * Phase 4.3 only ships the local-store probe (`hasBlob` / `readBlob`); the
 * Phase 4.4 treeless-fetch hookup wires {@link
 * './fetching-tree'.FetchingTree} to call back to a remote when this
 * resolver reports the blob is missing.
 *
 * @example
 * ```ts
 * const r = new BlobResolver(repoDir);
 * if (await r.hasBlob('a1b2...')) {
 *   const bytes = await r.readBlob('a1b2...');
 * }
 * ```
 */
export class BlobResolver {
	readonly repoDir: string;

	constructor(repoDir: string) {
		this.repoDir = repoDir;
	}

	/**
	 * Probe the local object store for `hash`. Returns `true` for both loose
	 * and packed objects without reading the blob's bytes.
	 */
	async hasBlob(hash: string): Promise<boolean> {
		try {
			await git.readBlob({ fs: fsCallback, dir: this.repoDir, oid: hash });
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Read the blob with `hash` from the local object store. Throws when the
	 * blob is not present (callers handle the missing case explicitly so
	 * fetcher fallbacks can be wired in).
	 */
	async readBlob(hash: string): Promise<Uint8Array> {
		const { blob } = await git.readBlob({ fs: fsCallback, dir: this.repoDir, oid: hash });
		return blob;
	}
}

/**
 * Walk the committed-checkpoint subtree at `<id[:2]>/<id[2:]>/<N>/...` and
 * return every transcript blob reference (base file + chunk files) across
 * every session.
 *
 * Tree-only: this function reads tree objects, not blobs, so it works even
 * after a treeless fetch that has not pulled the transcript blobs locally.
 *
 * Session enumeration follows Go (`for i := 0; ; i++` until the `<i>` tree
 * lookup errors). Within each session, both `full.jsonl` (chunk 0) and any
 * `full.jsonl.NNN` chunks are emitted; legacy `full.log` is also collected.
 *
 * Throws if the checkpoint subtree itself is missing (matches Go's
 * `tree.Tree(checkpointID.Path())` propagation).
 *
 * @example
 * ```ts
 * const refs = await collectTranscriptBlobHashes(repoDir, rootTree, 'a3b2c4d5e6f7');
 * // refs = [
 * //   { sessionIndex: 0, hash: '<oid>', path: '0/full.jsonl' },
 * //   { sessionIndex: 0, hash: '<oid>', path: '0/full.jsonl.001' },
 * //   { sessionIndex: 1, hash: '<oid>', path: '1/full.jsonl' },
 * // ]
 * ```
 */
export async function collectTranscriptBlobHashes(
	repoDir: string,
	rootTreeHash: string,
	checkpointId: CheckpointID,
): Promise<TranscriptBlobRef[]> {
	const checkpointPath = toCheckpointPath(checkpointId);

	let cpTree: Awaited<ReturnType<typeof git.readTree>>;
	try {
		cpTree = await git.readTree({
			fs: fsCallback,
			dir: repoDir,
			oid: rootTreeHash,
			filepath: checkpointPath,
		});
	} catch (err) {
		throw new Error(
			`checkpoint tree ${checkpointPath}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	const out: TranscriptBlobRef[] = [];
	for (let i = 0; ; i++) {
		const sessionDir = String(i);
		const sessionEntry = cpTree.tree.find((e) => e.path === sessionDir && e.type === 'tree');
		if (sessionEntry === undefined) {
			break;
		}

		let sessionTree: Awaited<ReturnType<typeof git.readTree>>;
		try {
			sessionTree = await git.readTree({
				fs: fsCallback,
				dir: repoDir,
				oid: sessionEntry.oid,
			});
		} catch {
			break;
		}

		for (const entry of sessionTree.tree) {
			if (entry.type !== 'blob') {
				continue;
			}
			if (entry.path === TRANSCRIPT_FILE_NAME || entry.path === TRANSCRIPT_FILE_NAME_LEGACY) {
				out.push({
					sessionIndex: i,
					hash: entry.oid,
					path: `${sessionDir}/${entry.path}`,
				});
				continue;
			}
			if (entry.path.startsWith(`${TRANSCRIPT_FILE_NAME}.`)) {
				const idx = parseChunkIndex(entry.path, TRANSCRIPT_FILE_NAME);
				if (idx > 0) {
					out.push({
						sessionIndex: i,
						hash: entry.oid,
						path: `${sessionDir}/${entry.path}`,
					});
				}
			}
		}
	}

	return out;
}
