/**
 * v2 generation metadata + automatic rotation of `/full/current`.
 *
 * The v2 raw-transcript ref (`refs/story/checkpoints/v2/full/current`)
 * grows linearly: every checkpoint adds a transcript subtree under the
 * sharded `<id[:2]>/<id[2:]>/<sessionIdx>/raw_transcript[.NNN]` path.
 * Once the count crosses {@link DEFAULT_MAX_CHECKPOINTS_PER_GENERATION}
 * the ref is **frozen** into a numbered archive
 * (`refs/story/checkpoints/v2/full/0000000000001`, …) and `/full/current`
 * is reset to a fresh empty orphan. Permanent metadata on `/main` is
 * untouched by rotation.
 *
 * Three concurrency safeguards prevent two writers from corrupting each
 * other when they hit the threshold simultaneously:
 *
 * 1. Pre-check: re-count the tree right before archiving — if another
 *    process already rotated, count drops below threshold and we no-op.
 * 2. Archive-name claim: refuse to overwrite an existing `/full/<seq>`.
 * 3. Post-archive recheck: the archive ref is created pointing at the
 *    pre-rotation commit; if `/full/current` advanced in between we
 *    abandon the reset. Worst case: the archive ref is missing
 *    `generation.json`; readers fall back to zero-value metadata and the
 *    raw transcripts inside are still usable.
 *
 * The 13-digit zero-padded suffix makes string sort = numeric sort, so
 * scans and listings stay cheap even with hundreds of generations.
 *
 * Go reference: `entire-cli/cmd/entire/cli/checkpoint/v2_generation.go`.
 */

import fsCallback from 'node:fs';
import git from 'isomorphic-git';
import { parseMetadataJSON, serializeMetadataJSON } from '../jsonutil';
import { info, warn } from '../log';
import {
	writeBranchRef as _writeBranchRef,
	getGitAuthorFromRepo,
	readJsonFromBlob,
} from './committed';
import { GENERATION_FILE_NAME, V2_FULL_CURRENT_REF_NAME, V2_FULL_REF_PREFIX } from './constants';
import { createBlobFromContent, createCommit } from './git-objects';
import { MergeMode, MODE_FILE, type TreeEntry, updateSubtree, ZERO_HASH } from './tree-ops';
import type { V2GitStore } from './v2-store';

/**
 * Default rotation threshold — when `/full/current` reaches this many
 * checkpoints, it is archived and replaced with a fresh empty orphan.
 *
 * Sized so a year of routine use generates ~12-25 archives (manageable
 * `git fetch` round-trips) without each generation growing into a
 * multi-GB blob. Tests override via `V2GitStore.maxCheckpointsPerGeneration`.
 */
export const DEFAULT_MAX_CHECKPOINTS_PER_GENERATION = 100;

/** Width of the zero-padded numeric suffix on archived generation refs. */
export const GENERATION_REF_WIDTH = 13;

/**
 * Strict shape that an archived generation suffix must match. Excludes
 * `current` and any malformed refs inside `V2_FULL_REF_PREFIX`.
 */
export const GENERATION_REF_PATTERN = /^\d{13}$/;

/**
 * Bookkeeping payload written to `generation.json` at the root of an
 * archived `/full/<seq>` ref. Only present on archives — `/full/current`
 * stays free of root-level files (so push merges never conflict on
 * `generation.json`).
 *
 * Fields are ISO 8601 UTC strings derived from git commit timestamps when
 * the rotation runs; readers tolerate missing fields by filling zero values.
 */
export interface GenerationMetadata {
	oldestCheckpointAt: string;
	newestCheckpointAt: string;
}

const ZERO_GENERATION: GenerationMetadata = {
	oldestCheckpointAt: '',
	newestCheckpointAt: '',
};

/**
 * Read `generation.json` from the given root tree. Returns a zero-value
 * `GenerationMetadata` when the tree is empty / missing the file (treated
 * as a brand-new generation).
 *
 * Tolerant of malformed input: missing fields / parse errors all degrade
 * to zero-value rather than throwing — a corrupt archive shouldn't break
 * `listArchivedGenerations`-style enumeration.
 *
 * @example
 * ```ts
 * // Archived generation with timestamps:
 * const gen = await readGeneration(store, archiveTreeHash);
 * // gen === {
 * //   oldestCheckpointAt: '2026-04-15T03:14:15.000Z',
 * //   newestCheckpointAt: '2026-04-17T18:09:42.000Z',
 * // }
 *
 * // Empty / fresh /full/current tree (no generation.json yet):
 * await readGeneration(store, ZERO_HASH);
 * // === { oldestCheckpointAt: '', newestCheckpointAt: '' }
 *
 * // Malformed generation.json on disk:
 * await readGeneration(store, brokenTreeHash);
 * // === { oldestCheckpointAt: '', newestCheckpointAt: '' }   (no throw)
 * ```
 */
export async function readGeneration(
	store: V2GitStore,
	treeHash: string,
): Promise<GenerationMetadata> {
	if (treeHash === ZERO_HASH || treeHash === '') {
		return { ...ZERO_GENERATION };
	}
	let tree: Awaited<ReturnType<typeof git.readTree>>;
	try {
		tree = await git.readTree({ fs: fsCallback, dir: store.repoDir, oid: treeHash });
	} catch {
		return { ...ZERO_GENERATION };
	}
	const entry = tree.tree.find((e) => e.path === GENERATION_FILE_NAME && e.type === 'blob');
	if (entry === undefined) {
		return { ...ZERO_GENERATION };
	}
	let blob: Uint8Array;
	try {
		blob = (await git.readBlob({ fs: fsCallback, dir: store.repoDir, oid: entry.oid })).blob;
	} catch {
		return { ...ZERO_GENERATION };
	}
	let parsed: Partial<GenerationMetadata>;
	try {
		parsed = parseMetadataJSON<Partial<GenerationMetadata>>(new TextDecoder().decode(blob));
	} catch {
		return { ...ZERO_GENERATION };
	}
	if (parsed === null || typeof parsed !== 'object') {
		return { ...ZERO_GENERATION };
	}
	return {
		oldestCheckpointAt:
			typeof parsed.oldestCheckpointAt === 'string' ? parsed.oldestCheckpointAt : '',
		newestCheckpointAt:
			typeof parsed.newestCheckpointAt === 'string' ? parsed.newestCheckpointAt : '',
	};
}

/** Resolve `refName` and read its `generation.json`. */
export async function readGenerationFromRef(
	store: V2GitStore,
	refName: string,
): Promise<GenerationMetadata> {
	const { treeHash } = await store.getRefState(refName);
	return readGeneration(store, treeHash);
}

/**
 * Marshal a `GenerationMetadata` into a blob `TreeEntry` named
 * `generation.json`. Routed through {@link serializeMetadataJSON} so the
 * on-disk format (`oldest_checkpoint_at` / `newest_checkpoint_at`) stays
 * Go-compatible without per-field hand-mapping.
 */
async function marshalGenerationBlob(
	store: V2GitStore,
	gen: GenerationMetadata,
): Promise<TreeEntry> {
	const data = serializeMetadataJSON(gen);
	const hash = await createBlobFromContent(store.repoDir, new TextEncoder().encode(data));
	return { name: GENERATION_FILE_NAME, mode: MODE_FILE, hash, type: 'blob' };
}

/**
 * Count second-level shard directories under the root tree — each one
 * represents one committed checkpoint. Walks `<id[:2]>/<id[2:]>/`
 * lazily, ignoring any tree entries that don't match the sharded layout
 * (e.g. `generation.json` at root). Returns 0 for the empty tree.
 *
 * Used by the rotation trigger (`writeCommitted` → check post-write count
 * vs `store.maxCheckpoints()`) and by tests inspecting tree shape.
 *
 * @example
 * ```ts
 * // /full/current with 3 checkpoints across 2 buckets ('aa/...', 'cc/...'):
 * await countCheckpointsInTree(store, fullCurrentTreeHash);
 * // === 3
 *
 * // Empty / freshly-rotated /full/current:
 * await countCheckpointsInTree(store, ZERO_HASH);
 * // === 0
 *
 * // Tree with `generation.json` at root + 2 checkpoints — generation.json
 * // (a blob, not a 2-char shard tree) is ignored.
 * await countCheckpointsInTree(store, archiveTreeHash);
 * // === 2
 * ```
 */
export async function countCheckpointsInTree(store: V2GitStore, treeHash: string): Promise<number> {
	if (treeHash === ZERO_HASH || treeHash === '') {
		return 0;
	}
	let root: Awaited<ReturnType<typeof git.readTree>>;
	try {
		root = await git.readTree({ fs: fsCallback, dir: store.repoDir, oid: treeHash });
	} catch {
		return 0;
	}
	let count = 0;
	for (const bucket of root.tree) {
		if (bucket.type !== 'tree' || bucket.path.length !== 2 || !/^[0-9a-f]{2}$/.test(bucket.path)) {
			continue;
		}
		let inner: Awaited<ReturnType<typeof git.readTree>>;
		try {
			inner = await git.readTree({ fs: fsCallback, dir: store.repoDir, oid: bucket.oid });
		} catch {
			continue;
		}
		for (const cp of inner.tree) {
			if (cp.type !== 'tree' || cp.path.length !== 10 || !/^[0-9a-f]{10}$/.test(cp.path)) {
				continue;
			}
			count += 1;
		}
	}
	return count;
}

/**
 * Splice `generation.json` into the given root tree, preserving every
 * existing entry. Returns the new root tree hash.
 */
export async function addGenerationJSONToTree(
	store: V2GitStore,
	rootTreeHash: string,
	gen: GenerationMetadata,
): Promise<string> {
	const entry = await marshalGenerationBlob(store, gen);
	return updateSubtree(store.repoDir, rootTreeHash, [], [entry], {
		mergeMode: MergeMode.MergeKeepExisting,
	});
}

/**
 * Derive the oldest / newest checkpoint timestamps for the active
 * `/full/current` ref by walking the commit history of that ref.
 *
 * `/full/*` trees do not store per-checkpoint metadata (that lives on
 * `/main`), so we fall back to commit timestamps. Returns `now` for both
 * endpoints when the ref is unreachable — keeps `generation.json` valid
 * even in degenerate cases.
 */
export async function computeGenerationTimestamps(store: V2GitStore): Promise<GenerationMetadata> {
	const now = new Date().toISOString();
	const fallback: GenerationMetadata = { oldestCheckpointAt: now, newestCheckpointAt: now };
	let tip: string;
	try {
		tip = await git.resolveRef({
			fs: fsCallback,
			dir: store.repoDir,
			ref: V2_FULL_CURRENT_REF_NAME,
		});
	} catch {
		return fallback;
	}

	let log: Awaited<ReturnType<typeof git.log>>;
	try {
		log = await git.log({ fs: fsCallback, dir: store.repoDir, ref: tip });
	} catch {
		return fallback;
	}
	if (log.length === 0) {
		return fallback;
	}

	const newest = new Date(log[0]!.commit.committer.timestamp * 1000).toISOString();
	const oldest = new Date(log[log.length - 1]!.commit.committer.timestamp * 1000).toISOString();
	return { oldestCheckpointAt: oldest, newestCheckpointAt: newest };
}

/**
 * List all archived generation suffixes (e.g. `["0000000000001", …]`) in
 * ascending numeric order. Excludes `current` and any malformed entries.
 *
 * Used by `nextGenerationNumber` (max+1) and by `readSessionContent` to
 * walk archives in descending order looking for old raw transcripts.
 *
 * @example
 * ```ts
 * await listArchivedGenerations(store);
 * // === ['0000000000001', '0000000000002', '0000000000003']
 * //
 * // Sort is alphanumeric on 13-digit zero-padded suffixes — equivalent
 * // to numeric sort. So `[3, 1, 2]` written in any order comes back
 * // sorted ascending without explicit numeric parsing.
 *
 * // Refs that don't match the strict 13-digit pattern (or `current`)
 * // are excluded:
 * //   refs/.../full/current             — excluded (literal name)
 * //   refs/.../full/0000000000005       — included
 * //   refs/.../full/garbage             — excluded (not 13 digits)
 * //   refs/.../full/00000000000001      — excluded (14 digits)
 * ```
 */
export async function listArchivedGenerations(store: V2GitStore): Promise<string[]> {
	const refs = await git.listRefs({
		fs: fsCallback,
		dir: store.repoDir,
		filepath: V2_FULL_REF_PREFIX,
	});
	const archived: string[] = [];
	for (const suffix of refs) {
		if (suffix === 'current' || !GENERATION_REF_PATTERN.test(suffix)) {
			continue;
		}
		archived.push(suffix);
	}
	archived.sort();
	return archived;
}

/**
 * Compute the next sequential archive number = `max(existing) + 1`.
 * Returns `1` when no archives exist. Skips entries that fail numeric
 * parsing (defence in depth — `listArchivedGenerations` already filters).
 *
 * @example
 * ```ts
 * // No archives yet:
 * await nextGenerationNumber(store);  // === 1
 *
 * // After 3 rotations:
 * await nextGenerationNumber(store);  // === 4
 *
 * // Holes (e.g. 1 + 3 + 7 exist) → still max+1, NOT fill-in:
 * // returns 8, not 2.
 * ```
 */
export async function nextGenerationNumber(store: V2GitStore): Promise<number> {
	const archived = await listArchivedGenerations(store);
	let maxNum = 0;
	for (const name of archived) {
		const n = Number.parseInt(name, 10);
		if (!Number.isNaN(n) && n > maxNum) {
			maxNum = n;
		}
	}
	return maxNum + 1;
}

/**
 * Format `n` as a zero-padded archive ref name.
 *
 * @example
 * ```ts
 * archiveRefName(3)
 * // 'refs/story/checkpoints/v2/full/0000000000003'
 * ```
 */
export function archiveRefName(n: number): string {
	return `${V2_FULL_REF_PREFIX}${String(n).padStart(GENERATION_REF_WIDTH, '0')}`;
}

/**
 * Archive `/full/current` and replace it with a fresh empty orphan.
 *
 * Two-phase sequence with three concurrency safeguards (see file header
 * for the safety story):
 *
 * 1. Re-read `/full/current` and re-count checkpoints; bail if another
 *    rotator already cleared the ref.
 * 2. Compute the next archive number and refuse to clobber an existing
 *    archive ref of the same name.
 * 3. Tentatively point the archive ref at the current `/full/current`
 *    commit, then re-read `/full/current`; if it changed mid-rotation,
 *    abandon the reset (archive ref is left without `generation.json` —
 *    {@link readGeneration} tolerates that) so a concurrent writer can
 *    run rotation again.
 * 4. Otherwise add `generation.json` to the archive tree, commit it, and
 *    update the archive ref to the new commit.
 * 5. Finally write a fresh orphan empty-tree commit and point
 *    `/full/current` at it.
 *
 * Called automatically by {@link writeCommitted} when the post-write
 * count crosses `store.maxCheckpoints()`. Failures (any safeguard
 * tripping or partial completion) are swallowed by the caller as warn
 * logs — the underlying transcript writes are already durable.
 *
 * @example
 * ```ts
 * // Pre-state:
 * //   refs/story/checkpoints/v2/full/current → Cur0  (100 checkpoints)
 * //   refs/story/checkpoints/v2/full/0000000000001  ← prior archive
 * //   refs/story/checkpoints/v2/full/0000000000002  ← prior archive
 * //
 * await rotateGeneration(store);
 * //
 * // Post-state (happy path, no concurrent writers):
 * //   refs/story/checkpoints/v2/full/current → EmptyOrphan
 * //     (parent: ZERO_HASH; tree: empty; msg: "Start generation")
 * //   refs/story/checkpoints/v2/full/0000000000003 → ArchiveCommit
 * //     (parent: Cur0; tree: Cur0's tree + generation.json at root with
 * //      oldestCheckpointAt / newestCheckpointAt derived from Cur0's
 * //      commit history; msg: "Archive generation")
 * //
 * // Concurrent-rotation scenarios:
 * //   ─ Safeguard 1: another rotator cleared /full/current → count < threshold
 * //     → return without doing anything.
 * //   ─ Safeguard 2: archive ref 0000000000003 already exists → log "skipping"
 * //     and return (the other rotator owns this slot).
 * //   ─ Safeguard 3: /full/current advanced (new CP written) between our
 * //     archive-ref claim and the post-recheck → log "aborting reset" and
 * //     return WITHOUT resetting /full/current. The archive ref points at
 * //     the pre-advance commit (without generation.json) — readGeneration
 * //     tolerates that and returns zero-value metadata, raw transcripts
 * //     still readable. The next writer triggers rotation again cleanly.
 * ```
 */
export async function rotateGeneration(store: V2GitStore): Promise<void> {
	const refName = V2_FULL_CURRENT_REF_NAME;

	// Safeguard 1: re-check the threshold under a fresh read.
	let currentTreeHash: string;
	try {
		const state = await store.getRefState(refName);
		currentTreeHash = state.treeHash;
	} catch (err) {
		throw new Error(
			`rotation: failed to read /full/current: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	const checkpointCount = await countCheckpointsInTree(store, currentTreeHash);
	if (checkpointCount < store.maxCheckpoints()) {
		return;
	}

	let currentTip: string;
	try {
		currentTip = await git.resolveRef({ fs: fsCallback, dir: store.repoDir, ref: refName });
	} catch (err) {
		throw new Error(
			`rotation: failed to read /full/current ref: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	const archiveNumber = await nextGenerationNumber(store);
	const archiveRef = archiveRefName(archiveNumber);

	// Safeguard 2: refuse to clobber an existing archive ref.
	try {
		await git.resolveRef({ fs: fsCallback, dir: store.repoDir, ref: archiveRef });
		info({ component: 'checkpoint' }, 'rotation: archive ref already exists, skipping', {
			archiveRef,
		});
		return;
	} catch {
		// not present — proceed
	}

	// Tentative archive: point archive ref at the pre-rotation commit so
	// concurrent rotators see a name collision and bail at safeguard 2.
	await git.writeRef({
		fs: fsCallback,
		dir: store.repoDir,
		ref: archiveRef,
		value: currentTip,
		force: true,
	});

	// Safeguard 3: re-read /full/current — abort the reset if it advanced.
	let postArchiveTip: string;
	try {
		postArchiveTip = await git.resolveRef({ fs: fsCallback, dir: store.repoDir, ref: refName });
	} catch (err) {
		throw new Error(
			`rotation: failed to re-read /full/current: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	if (postArchiveTip !== currentTip) {
		info(
			{ component: 'checkpoint' },
			'rotation: /full/current changed during rotation, aborting reset',
			{},
		);
		return;
	}

	// Stamp the archive tree with generation.json.
	const gen = await computeGenerationTimestamps(store);
	const archiveTreeHash = await addGenerationJSONToTree(store, currentTreeHash, gen);

	const author = await getGitAuthorFromRepo(store.repoDir);
	const archiveCommitHash = await createCommit(
		store.repoDir,
		archiveTreeHash,
		currentTip,
		'Archive generation',
		author.name,
		author.email,
	);
	await git.writeRef({
		fs: fsCallback,
		dir: store.repoDir,
		ref: archiveRef,
		value: archiveCommitHash,
		force: true,
	});

	// Phase 2: fresh empty orphan for the next generation.
	const emptyTree = await git.writeTree({ fs: fsCallback, dir: store.repoDir, tree: [] });
	const orphanCommit = await createCommit(
		store.repoDir,
		emptyTree,
		ZERO_HASH,
		'Start generation',
		author.name,
		author.email,
	);
	await git.writeRef({
		fs: fsCallback,
		dir: store.repoDir,
		ref: refName,
		value: orphanCommit,
		force: true,
	});

	info({ component: 'checkpoint' }, 'generation rotation complete', {
		archived_generation: archiveNumber,
		archive_ref: archiveRef,
	});
}

/** Re-export for callers that need the same-module log helpers. */
export { _writeBranchRef as writeBranchRef, readJsonFromBlob, warn };
