/**
 * Three-tier remote-fetch fallback for the v2 `/main` ref.
 *
 * After a fresh `git clone` the v2 metadata refs are not present locally —
 * they live outside `refs/heads/*` so the default clone refspec skips
 * them. Higher layers (the resume / explain commands) need a way to
 * reach `refs/story/checkpoints/v2/main` without forcing the user to
 * configure remotes manually.
 *
 * {@link getV2MetadataTree} encodes the strategy the Go client uses:
 *
 * 1. **Treeless fetch**: cheap (`--filter=blob:none`), pulls the ref +
 *    tree without large transcript blobs. Most callers only need the
 *    metadata tree, so this succeeds the majority of the time.
 * 2. **Local fallback**: maybe a previous tree-only fetch already
 *    populated the ref locally; check before paying for another network
 *    round-trip.
 * 3. **Full fetch**: last resort — pulls all blobs too.
 *
 * Both fetcher functions are injected by the CLI layer (see
 * `Phase 9.4 fetch suite`). Production callers wire them to git CLI
 * invocations; tests inject mocks. Either fetcher may be `null` when the
 * caller knows it can't do that flavour of fetch (e.g. in a sandboxed
 * read-only environment) — the resolver simply skips the corresponding
 * tier.
 *
 * Go reference: `entire-cli/cmd/entire/cli/checkpoint/v2_resolve.go`.
 */

import fsCallback from 'node:fs';
import git from 'isomorphic-git';
import { V2_MAIN_REF_NAME } from './constants';

/**
 * Fetch a ref into the local repo. The argument signature is intentionally
 * bare — the caller closes over the remote, ref name, depth options, etc.
 * `signal` lets long-running fetches participate in command cancellation.
 *
 * Should reject when the underlying fetch fails (no ref, network error,
 * etc.); the resolver swallows the error and falls through to the next
 * tier instead of propagating.
 */
export type FetchRefFunc = (signal?: AbortSignal) => Promise<void>;

/**
 * Resolve the root tree of the v2 `/main` ref, fetching from the remote
 * if necessary.
 *
 * Returns `null` if every tier (treeless fetch, local lookup, full
 * fetch) fails to produce a readable tree.
 *
 * @example
 * ```ts
 * const tree = await getV2MetadataTree(repoDir, treelessFetchFn, fullFetchFn);
 * if (tree === null) {
 *   // Ref isn't reachable anywhere — surface a "no v2 data" error.
 * } else {
 *   // tree.treeHash is the root tree of refs/story/checkpoints/v2/main.
 *   // Read it via FetchingTree / readTree as needed.
 * }
 * ```
 */
export async function getV2MetadataTree(
	repoDir: string,
	treelessFetchFn: FetchRefFunc | null,
	fullFetchFn: FetchRefFunc | null,
	signal?: AbortSignal,
): Promise<{ treeHash: string } | null> {
	if (treelessFetchFn !== null) {
		try {
			await treelessFetchFn(signal);
			const tree = await readMainRefTree(repoDir);
			if (tree !== null) {
				return tree;
			}
		} catch {
			// fall through
		}
	}

	const local = await readMainRefTree(repoDir);
	if (local !== null) {
		return local;
	}

	if (fullFetchFn !== null) {
		try {
			await fullFetchFn(signal);
			const tree = await readMainRefTree(repoDir);
			if (tree !== null) {
				return tree;
			}
		} catch {
			// fall through
		}
	}

	return null;
}

async function readMainRefTree(repoDir: string): Promise<{ treeHash: string } | null> {
	let tip: string;
	try {
		tip = await git.resolveRef({ fs: fsCallback, dir: repoDir, ref: V2_MAIN_REF_NAME });
	} catch {
		return null;
	}
	try {
		const { commit } = await git.readCommit({ fs: fsCallback, dir: repoDir, oid: tip });
		return { treeHash: commit.tree };
	} catch {
		return null;
	}
}
