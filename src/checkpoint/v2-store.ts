/**
 * V2 metadata-store class + low-level ref management.
 *
 * Phase 4.4 splits the v1 single-orphan-branch layout
 * (`story/checkpoints/v1`) into three ref families:
 *
 * - `refs/story/checkpoints/v2/main` — permanent metadata + compact
 *   transcript + prompts. Always pushed / fetched.
 * - `refs/story/checkpoints/v2/full/current` — active raw transcripts.
 *   Auto-archived when the checkpoint count crosses
 *   {@link DEFAULT_MAX_CHECKPOINTS_PER_GENERATION}.
 * - `refs/story/checkpoints/v2/full/<13-digit-seq>` — frozen archive
 *   generations. Fetched on demand only.
 *
 * `V2GitStore` is the class clients hold on to. Every method delegates to a
 * standalone helper in [`v2-committed.ts`](./v2-committed.ts) (writes),
 * [`v2-read.ts`](./v2-read.ts) (reads), or
 * [`v2-generation.ts`](./v2-generation.ts) (rotation). This file owns the
 * three primitives that those modules build on (`ensureRef` /
 * `getRefState` / `updateRef`) and the rotation-threshold accessor
 * (`maxCheckpoints`) so tests can override it via
 * `maxCheckpointsPerGeneration` without touching production defaults.
 *
 * Construction surface and method shape match the Phase 4.3 stub so the
 * v1/v2 fallback resolver in
 * [`committed-reader-resolve.ts`](./committed-reader-resolve.ts) keeps
 * working unchanged.
 *
 * Go reference: `entire-cli/cmd/entire/cli/checkpoint/v2_store.go`.
 */

import fsCallback from 'node:fs';
import git from 'isomorphic-git';
import { getGitAuthorFromRepo } from './committed';
import { V2_FULL_CURRENT_REF_NAME, V2_FULL_REF_PREFIX, V2_MAIN_REF_NAME } from './constants';
import type { BlobFetchFunc } from './fetching-tree';
import { createCommit } from './git-objects';
import { ZERO_HASH } from './tree-ops';
import type {
	CheckpointAuthor,
	CheckpointSummary,
	CommittedInfo,
	CommittedMetadata,
	CommittedReader,
	InitialAttribution,
	SessionContent,
	Summary,
	UpdateCommittedOptions,
	WriteCommittedOptions,
} from './types';
import * as v2c from './v2-committed';
import * as v2g from './v2-generation';
import { DEFAULT_MAX_CHECKPOINTS_PER_GENERATION, type GenerationMetadata } from './v2-generation';
import * as v2r from './v2-read';

/** Default git remote used for fetch-on-demand of `/full/*` refs. */
const DEFAULT_FETCH_REMOTE = 'origin';

/**
 * v2 checkpoint store backed by a real git repository.
 *
 * Lifecycle — Phase 4.4 production callers construct the store once per
 * repo and keep the same instance across reads / writes so the
 * {@link BlobFetchFunc} survives between calls.
 *
 * @remarks
 * `fetchRemote` (default `'origin'`) must be a configured git remote on
 * the repo for the third-tier `/full/*` remote-fetch fallback inside
 * {@link readSessionContent} to work. If the remote is missing or
 * misconfigured, the fetch step in
 * `v2-read.ts:readTranscriptFromFullRefs` fails silently (logged at
 * debug level) and `readSessionContent` surfaces `ErrNoTranscript` for
 * archived checkpoints whose raw transcript is not yet local. CLI
 * commands that construct this store are responsible for upstream
 * `git remote add` / config validation.
 */
export class V2GitStore implements CommittedReader {
	readonly repoDir: string;
	readonly fetchRemote: string;

	/**
	 * Override for the rotation threshold. Zero = use the package default.
	 * Tests set this to a small value (e.g. 2) so a handful of writes
	 * triggers a rotation.
	 */
	maxCheckpointsPerGeneration: number = 0;

	private blobFetcher?: BlobFetchFunc;

	/** v2 ref-namespace constants exposed on the instance for convenience. */
	static readonly mainRefName = V2_MAIN_REF_NAME;
	static readonly fullCurrentRefName = V2_FULL_CURRENT_REF_NAME;
	static readonly fullRefPrefix = V2_FULL_REF_PREFIX;

	constructor(repoDir: string, fetchRemote: string = DEFAULT_FETCH_REMOTE) {
		this.repoDir = repoDir;
		this.fetchRemote = fetchRemote === '' ? DEFAULT_FETCH_REMOTE : fetchRemote;
	}

	/**
	 * Inject (or replace) the blob fetcher used by treeless-fetch reads.
	 * The fetcher is called with a list of missing blob hashes when a
	 * read path's `FetchingTree` would otherwise 404.
	 *
	 * @example
	 * ```ts
	 * const store = new V2GitStore(repoDir);
	 * store.setBlobFetcher(async (hashes) => {
	 *   await execGit(['fetch', 'origin', '--no-tags', ...hashes], { cwd: repoDir });
	 * });
	 * // Subsequent store.readSessionContent(...) calls will auto-fetch
	 * // missing transcript blobs from origin instead of throwing.
	 *
	 * store.setBlobFetcher(undefined);  // disable
	 * ```
	 */
	setBlobFetcher(fetcher: BlobFetchFunc | undefined): void {
		this.blobFetcher = fetcher;
	}

	/** @internal Read accessor for read-side helpers. */
	getBlobFetcher(): BlobFetchFunc | undefined {
		return this.blobFetcher;
	}

	/**
	 * Effective rotation threshold (defaults to 100). When
	 * `maxCheckpointsPerGeneration` is `0` (production default), returns
	 * {@link DEFAULT_MAX_CHECKPOINTS_PER_GENERATION}; when set non-zero
	 * (test override), returns that value.
	 *
	 * @example
	 * ```ts
	 * const store = new V2GitStore(repoDir);
	 * store.maxCheckpoints();           // 100
	 * store.maxCheckpointsPerGeneration = 2;  // test fixture
	 * store.maxCheckpoints();           // 2 — rotation triggers after 2 writes
	 * ```
	 */
	maxCheckpoints(): number {
		if (this.maxCheckpointsPerGeneration > 0) {
			return this.maxCheckpointsPerGeneration;
		}
		return DEFAULT_MAX_CHECKPOINTS_PER_GENERATION;
	}

	// =====================================================================
	// Ref management primitives (used by v2-committed / v2-read / v2-generation)
	// =====================================================================

	/**
	 * Ensure `refName` exists. If absent, create an orphan commit with an
	 * empty tree and point the ref at it. Idempotent: returns immediately
	 * when the ref already resolves.
	 *
	 * @example
	 * ```ts
	 * await store.ensureRef('refs/story/checkpoints/v2/main');
	 * // Side effect (only on first call):
	 * //   .git/objects/<hash>      ← empty tree
	 * //   .git/objects/<hash>      ← orphan commit "Initialize v2 ref"
	 * //   .git/refs/story/checkpoints/v2/main → <commit hash>
	 * ```
	 */
	async ensureRef(refName: string): Promise<void> {
		try {
			await git.resolveRef({ fs: fsCallback, dir: this.repoDir, ref: refName });
			return;
		} catch {
			// fall through to create
		}
		const emptyTree = await git.writeTree({ fs: fsCallback, dir: this.repoDir, tree: [] });
		const author = await getGitAuthorFromRepo(this.repoDir);
		const commitHash = await createCommit(
			this.repoDir,
			emptyTree,
			ZERO_HASH,
			'Initialize v2 ref',
			author.name,
			author.email,
		);
		await git.writeRef({
			fs: fsCallback,
			dir: this.repoDir,
			ref: refName,
			value: commitHash,
			force: true,
		});
	}

	/**
	 * Resolve `refName` to its parent commit hash and root tree hash.
	 * Throws if the ref does not exist (callers handle this differently
	 * depending on whether the ref is required).
	 *
	 * @example
	 * ```ts
	 * await store.ensureRef(V2_MAIN_REF_NAME);
	 * const { parentHash, treeHash } = await store.getRefState(V2_MAIN_REF_NAME);
	 * // parentHash = '<40-char hex of /main tip commit>'
	 * // treeHash   = '<40-char hex of that commit's root tree>'
	 * //
	 * // Pass `parentHash` as the parent of the next commit when calling
	 * // {@link updateRef}; pass `treeHash` to tree-walk helpers like
	 * // `flattenCheckpointEntries`.
	 *
	 * await store.getRefState('refs/does-not-exist');
	 * // throws — caller decides whether to ensureRef + retry or surface
	 * // the error (write paths re-throw as ErrCheckpointNotFound).
	 * ```
	 */
	async getRefState(refName: string): Promise<{ parentHash: string; treeHash: string }> {
		const tip = await git.resolveRef({ fs: fsCallback, dir: this.repoDir, ref: refName });
		const { commit } = await git.readCommit({ fs: fsCallback, dir: this.repoDir, oid: tip });
		return { parentHash: tip, treeHash: commit.tree };
	}

	/**
	 * Create a new commit on `refName` with `treeHash` and `parentHash`,
	 * then update the ref to point at it. Returns the new commit hash.
	 *
	 * @example
	 * ```ts
	 * const { parentHash, treeHash } = await store.getRefState(V2_MAIN_REF_NAME);
	 * const newTreeHash = await spliceCheckpointSubtree(...);
	 * const commitHash = await store.updateRef(
	 *   V2_MAIN_REF_NAME,
	 *   newTreeHash,
	 *   parentHash,
	 *   'Checkpoint: a3b2c4d5e6f7\n',
	 *   'Alice',
	 *   'alice@example.com',
	 * );
	 * // Side effects in `<repoDir>/.git/`:
	 * //   objects/<commitHash>     ← new commit (tree=newTreeHash, parent=parentHash, ...)
	 * //   refs/story/checkpoints/v2/main → <commitHash>
	 * // Returns: commitHash (40-char hex), useful for callers that want
	 * // to log it or pass to `getCheckpointAuthor`.
	 * ```
	 */
	async updateRef(
		refName: string,
		treeHash: string,
		parentHash: string,
		message: string,
		authorName: string,
		authorEmail: string,
	): Promise<string> {
		const commitHash = await createCommit(
			this.repoDir,
			treeHash,
			parentHash,
			message,
			authorName,
			authorEmail,
		);
		await git.writeRef({
			fs: fsCallback,
			dir: this.repoDir,
			ref: refName,
			value: commitHash,
			force: true,
		});
		return commitHash;
	}

	// =====================================================================
	// Write surface (delegates to v2-committed.ts)
	// =====================================================================

	writeCommitted(opts: WriteCommittedOptions): Promise<void> {
		return v2c.writeCommitted(this, opts);
	}

	updateCommitted(opts: UpdateCommittedOptions): Promise<void> {
		return v2c.updateCommitted(this, opts);
	}

	updateSummary(checkpointId: string, summary: Summary | null): Promise<void> {
		return v2c.updateSummary(this, checkpointId, summary);
	}

	// =====================================================================
	// Read surface (delegates to v2-read.ts) — implements CommittedReader
	// =====================================================================

	readCommitted(checkpointId: string): Promise<CheckpointSummary | null> {
		return v2r.readCommitted(this, checkpointId);
	}

	listCommitted(): Promise<CommittedInfo[]> {
		return v2r.listCommitted(this);
	}

	readSessionContent(checkpointId: string, sessionIndex: number): Promise<SessionContent | null> {
		return v2r.readSessionContent(this, checkpointId, sessionIndex);
	}

	readSessionContentById(checkpointId: string, sessionId: string): Promise<SessionContent | null> {
		return v2r.readSessionContentById(this, checkpointId, sessionId);
	}

	readLatestSessionContent(checkpointId: string): Promise<SessionContent | null> {
		return v2r.readLatestSessionContent(this, checkpointId);
	}

	readSessionMetadata(
		checkpointId: string,
		sessionIndex: number,
	): Promise<CommittedMetadata | null> {
		return v2r.readSessionMetadata(this, checkpointId, sessionIndex);
	}

	readSessionMetadataAndPrompts(
		checkpointId: string,
		sessionIndex: number,
	): Promise<SessionContent | null> {
		return v2r.readSessionMetadataAndPrompts(this, checkpointId, sessionIndex);
	}

	readSessionCompactTranscript(
		checkpointId: string,
		sessionIndex: number,
	): Promise<Uint8Array | null> {
		return v2r.readSessionCompactTranscript(this, checkpointId, sessionIndex);
	}

	getTranscript(checkpointId: string): Promise<Uint8Array | null> {
		return v2r.getTranscript(this, checkpointId);
	}

	getSessionLog(
		checkpointId: string,
	): Promise<{ transcript: Uint8Array; sessionId: string } | null> {
		return v2r.getSessionLog(this, checkpointId);
	}

	getCheckpointAuthor(checkpointId: string): Promise<CheckpointAuthor> {
		return v2r.getCheckpointAuthor(this, checkpointId);
	}

	updateCheckpointSummary(
		checkpointId: string,
		combinedAttribution: InitialAttribution | null,
	): Promise<void> {
		return v2c.updateCheckpointSummary(this, checkpointId, combinedAttribution);
	}

	// =====================================================================
	// Generation surface (delegates to v2-generation.ts)
	// =====================================================================

	readGeneration(treeHash: string): Promise<GenerationMetadata> {
		return v2g.readGeneration(this, treeHash);
	}

	readGenerationFromRef(refName: string): Promise<GenerationMetadata> {
		return v2g.readGenerationFromRef(this, refName);
	}

	countCheckpointsInTree(treeHash: string): Promise<number> {
		return v2g.countCheckpointsInTree(this, treeHash);
	}

	listArchivedGenerations(): Promise<string[]> {
		return v2g.listArchivedGenerations(this);
	}
}
