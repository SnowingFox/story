/**
 * Fetch helpers used by `story resume` (foundation-backlog item #21) +
 * future Phase 9.x consumers.
 *
 * Mirrors Go `cmd/entire/cli/git_operations.go:348-615` — 8 functions
 * that exercise different git-fetch refspec / partial-clone / by-hash
 * patterns against the `origin` remote or an explicit URL. All helpers
 * are CLI-only (shell out to git) because `isomorphic-git`'s `fetch`
 * does not use the user's credential helpers, which breaks HTTPS URLs
 * that require auth (same workaround as Phase 5.6 push helpers).
 *
 * Go-parity wiring (Phase 9.4 review fix B1-B7):
 *   - Every fetch routes through `checkpointGitCommand` so
 *     `STORY_CHECKPOINT_TOKEN` is injected via `http.extraHeader` for
 *     HTTPS Basic auth (private repo support).
 *   - Fetch args get `--filter=blob:none` conditionally appended via
 *     `appendFetchFilterArgs` when `strategy_options.filtered_fetches`
 *     is true. For filtered fetches the remote name is also resolved
 *     to a URL via `resolveFetchTarget` so git doesn't persist
 *     `remote.<name>.partialclonefilter` config onto the remote name.
 *   - 2-minute timeout via `execa({ timeout })` matches Go
 *     `context.WithTimeout`.
 *   - v2 `/main` fetches land on {@link V2_MAIN_FETCH_TMP_REF} first and
 *     promote via {@link promoteTmpRefSafely} — avoids clobbering
 *     locally-ahead refs on concurrent fetch + push.
 *   - Metadata-branch fetches run {@link safelyAdvanceLocalRef} after
 *     the fetch so `refs/heads/story/checkpoints/v1` keeps up with
 *     `refs/remotes/<remote>/story/checkpoints/v1`.
 *
 * Story-side naming note: `fetchMetadataBranch` here is the **origin
 * variant** (remote name parameter). The URL variant is
 * {@link ../strategy/checkpoint-remote.fetchMetadataBranch} (Phase 5.6).
 * The module separation keeps the names ergonomic at each callsite.
 *
 * @packageDocumentation
 */

import fsCallback from 'node:fs';
import { execa } from 'execa';
import git from 'isomorphic-git';
import { METADATA_BRANCH_NAME, V2_MAIN_REF_NAME } from '@/checkpoint/constants';
import { SilentError } from '@/errors';
import { execGit } from '@/git';
import {
	appendFetchFilterArgs,
	checkpointGitCommand,
	resolveFetchTarget,
} from '@/strategy/checkpoint-token';
import {
	promoteTmpRefSafely,
	safelyAdvanceLocalRef,
	V2_MAIN_FETCH_TMP_REF,
} from '@/strategy/ref-promote';
import { validateBranchName } from '@/validation';

/** Go-parity timeout for every fetch invocation (`context.WithTimeout(ctx, 2*time.Minute)`). */
const FETCH_TIMEOUT_MS = 2 * 60 * 1000;

/**
 * Execute `git <args>` with Story's fetch discipline: checkpoint token
 * injection, 2-minute timeout, error surface carrying the remote target
 * for log correlation.
 *
 * @internal
 */
async function runFetchCommand(repoRoot: string, target: string, args: string[]): Promise<void> {
	const cmd = await checkpointGitCommand(target, args);
	const env: NodeJS.ProcessEnv = cmd.env ?? process.env;
	const result = await execa('git', cmd.args, {
		cwd: repoRoot,
		env,
		timeout: FETCH_TIMEOUT_MS,
		reject: false,
	});
	if (result.timedOut) {
		throw new Error(`fetch timed out after ${FETCH_TIMEOUT_MS}ms`);
	}
	if (result.exitCode !== 0) {
		const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
		const detail = combined !== '' ? `: ${combined}` : '';
		throw new Error(`git fetch failed (exit ${result.exitCode})${detail}`);
	}
}

/**
 * Fetch a branch from `<remote>` and check it out locally. Foundation
 * #22 entry — validates the branch name via {@link validateBranchName}
 * before any git shell invocation.
 *
 * Mirrors Go `git_operations.go:352 FetchAndCheckoutRemoteBranch`.
 *
 * Algorithm:
 *   1. `validateBranchName(branchName)` — throw SilentError on invalid
 *   2. `git fetch <remote> +refs/heads/<branch>:refs/remotes/<remote>/<branch>`
 *   3. `git checkout <branch>`
 *
 * @example
 * await fetchAndCheckoutRemoteBranch('/repo', 'origin', 'feat/dark-mode');
 *
 * // Side effects on success:
 * //   <repo>/.git/refs/remotes/origin/feat/dark-mode   ← created
 * //   <repo>/.git/refs/heads/feat/dark-mode            ← created (via checkout -b)
 * //   <repo>/.git/HEAD                                 ← points at feat/dark-mode
 * //   <repo>/<worktree>                                ← contents of that branch's tip
 * // Unchanged: other local branches, other remote refs.
 *
 * // Invalid branch name → SilentError; no git processes spawned.
 * // Fetch failure       → wrapped Error with stderr message; refs unchanged.
 */
export async function fetchAndCheckoutRemoteBranch(
	repoRoot: string,
	remote: string,
	branchName: string,
): Promise<void> {
	// Step 1: foundation #22 — validate first.
	const err = await validateBranchName(branchName, repoRoot);
	if (err !== null) {
		throw new SilentError(err);
	}

	// Step 2: fetch. Go `FetchAndCheckoutRemoteBranch` hardcodes `origin`
	// but Story's CLI allows an arbitrary remote name via the `remote`
	// parameter. When `remote === 'origin'` the refspec matches Go
	// character-for-character.
	const refSpec = `+refs/heads/${branchName}:refs/remotes/${remote}/${branchName}`;
	try {
		await runFetchCommand(repoRoot, remote, ['fetch', remote, refSpec]);
	} catch (e) {
		throw new Error(
			`failed to fetch branch '${branchName}' from ${remote}: ${(e as Error).message}`,
		);
	}

	// Step 3: checkout. `git checkout <branch>` auto-creates a tracking
	// branch when a single remote-tracking ref matches.
	try {
		await execGit(['checkout', branchName], { cwd: repoRoot });
	} catch (e) {
		throw new Error(`failed to checkout '${branchName}': ${(e as Error).message}`);
	}
}

/**
 * Fetch the story/checkpoints/v1 branch from `<remote>` into a
 * remote-tracking ref. Non-shallow (complete history). Then
 * fast-forward `refs/heads/story/checkpoints/v1` via
 * {@link safelyAdvanceLocalRef} so callers reading the local branch
 * see the new tip.
 *
 * Mirrors Go `git_operations.go:398 FetchMetadataBranch` +
 * `git_operations.go:441-454` (`SafelyAdvanceLocalRef` tail).
 *
 * @example
 * await fetchMetadataBranch('/repo', 'origin');
 *
 * // Side effects:
 * //   <repo>/.git/refs/remotes/origin/story/checkpoints/v1   ← updated
 * //   <repo>/.git/refs/heads/story/checkpoints/v1            ← advanced (ff only)
 * //   <repo>/.git/objects/...                                 ← new pack objects
 * // Unchanged: HEAD, worktree, index, other refs.
 */
export async function fetchMetadataBranch(repoRoot: string, remote: string): Promise<void> {
	await fetchMetadataFromOrigin(repoRoot, remote, false);
}

/**
 * Shallow fetch of story/checkpoints/v1 (latest tip + tree objects only,
 * no blobs / history). Used by doctor / trace flows to cheaply verify
 * metadata structure without downloading the full blob content.
 *
 * Mirrors Go `git_operations.go:407 FetchMetadataTreeOnly`. Same
 * `SafelyAdvanceLocalRef` tail as {@link fetchMetadataBranch}.
 */
export async function fetchMetadataTreeOnly(repoRoot: string, remote: string): Promise<void> {
	await fetchMetadataFromOrigin(repoRoot, remote, true);
}

async function fetchMetadataFromOrigin(
	repoRoot: string,
	remote: string,
	shallow: boolean,
): Promise<void> {
	const fetchTarget = await resolveFetchTarget(remote, { cwd: repoRoot });
	const refSpec = `+refs/heads/${METADATA_BRANCH_NAME}:refs/remotes/${remote}/${METADATA_BRANCH_NAME}`;
	const baseArgs = ['fetch', '--no-tags'];
	if (shallow) {
		baseArgs.push('--depth=1');
	}
	baseArgs.push(fetchTarget, refSpec);
	// Conditionally append `--filter=blob:none` when filtered_fetches is on.
	const args = await appendFetchFilterArgs(baseArgs, { cwd: repoRoot });
	try {
		await runFetchCommand(repoRoot, fetchTarget, args);
	} catch (e) {
		throw new Error(
			`failed to fetch ${METADATA_BRANCH_NAME} from ${remote}: ${(e as Error).message}`,
		);
	}
	// Go-parity tail: safely advance the local metadata branch so readers
	// of refs/heads/story/checkpoints/v1 see the latest commit.
	try {
		const remoteHash = await git.resolveRef({
			fs: fsCallback,
			dir: repoRoot,
			ref: `refs/remotes/${remote}/${METADATA_BRANCH_NAME}`,
		});
		await safelyAdvanceLocalRef(repoRoot, `refs/heads/${METADATA_BRANCH_NAME}`, remoteHash);
	} catch {
		// advance is best-effort; callers still have the remote-tracking ref.
	}
}

/**
 * Shallow fetch of the v2 `/main` ref (tree objects only, no blobs, no
 * history). v2 refs live under `refs/story/checkpoints/v2/`, not
 * `refs/heads/`, so we use an explicit refspec.
 *
 * Mirrors Go `git_operations.go:461 FetchV2MainTreeOnly`. Lands on
 * {@link V2_MAIN_FETCH_TMP_REF} then promotes via
 * {@link promoteTmpRefSafely}.
 */
export async function fetchV2MainTreeOnly(repoRoot: string, remote: string): Promise<void> {
	await fetchV2MainFromOrigin(repoRoot, remote, true);
}

/**
 * Fetch the v2 `/main` ref from origin (treeless — blobs only come on
 * demand via {@link fetchBlobsByHash}).
 *
 * Mirrors Go `git_operations.go:469 FetchV2MainRef`. Also uses the
 * tmp-ref + promote dance.
 */
export async function fetchV2MainRef(repoRoot: string, remote: string): Promise<void> {
	await fetchV2MainFromOrigin(repoRoot, remote, false);
}

async function fetchV2MainFromOrigin(
	repoRoot: string,
	remote: string,
	shallow: boolean,
): Promise<void> {
	const fetchTarget = await resolveFetchTarget(remote, { cwd: repoRoot });
	// Go-parity: land on tmp ref first so locally-ahead v2 work isn't clobbered.
	const refSpec = `+${V2_MAIN_REF_NAME}:${V2_MAIN_FETCH_TMP_REF}`;
	const baseArgs = ['fetch', '--no-tags'];
	if (shallow) {
		baseArgs.push('--depth=1');
	}
	baseArgs.push(fetchTarget, refSpec);
	const args = await appendFetchFilterArgs(baseArgs, { cwd: repoRoot });
	try {
		await runFetchCommand(repoRoot, fetchTarget, args);
	} catch (e) {
		throw new Error(`failed to fetch v2 /main from ${remote}: ${(e as Error).message}`);
	}
	// Promote tmp → real ref (safelyAdvance inside).
	await promoteTmpRefSafely(repoRoot, V2_MAIN_FETCH_TMP_REF, V2_MAIN_REF_NAME, 'v2 /main');
}

/**
 * Fetch v2 `/main` from an explicit URL (checkpoint_remote flow).
 *
 * Mirrors Go `git_operations.go:510 FetchV2MetadataFromCheckpointRemote`.
 * Unlike Go's helper (which reads the URL via `remote.FetchURL(ctx)`),
 * this function accepts the URL directly so the caller
 * ([`../strategy/checkpoint-remote`](../strategy/checkpoint-remote.ts))
 * owns configuration resolution.
 *
 * @example
 * await fetchV2MetadataFromCheckpointRemote('/repo', 'https://github.com/o/r.git');
 *
 * // Side effects: identical to fetchV2MainRef, but from the URL.
 *
 * // Empty URL → SilentError "no checkpoint_remote configured" (Go parity).
 */
export async function fetchV2MetadataFromCheckpointRemote(
	repoRoot: string,
	checkpointRemoteUrl: string,
): Promise<void> {
	if (checkpointRemoteUrl === '') {
		throw new SilentError(new Error('no checkpoint_remote configured'));
	}
	const refSpec = `+${V2_MAIN_REF_NAME}:${V2_MAIN_FETCH_TMP_REF}`;
	const baseArgs = ['fetch', '--no-tags', checkpointRemoteUrl, refSpec];
	const args = await appendFetchFilterArgs(baseArgs, { cwd: repoRoot });
	try {
		await runFetchCommand(repoRoot, checkpointRemoteUrl, args);
	} catch (e) {
		throw new Error(`failed to fetch v2 /main from checkpoint remote: ${(e as Error).message}`);
	}
	await promoteTmpRefSafely(repoRoot, V2_MAIN_FETCH_TMP_REF, V2_MAIN_REF_NAME, 'v2 /main');
}

/**
 * Fetch v1 metadata branch from an explicit URL.
 *
 * Mirrors Go `git_operations.go:529 FetchMetadataFromCheckpointRemote`.
 */
export async function fetchMetadataFromCheckpointRemote(
	repoRoot: string,
	checkpointRemoteUrl: string,
): Promise<void> {
	if (checkpointRemoteUrl === '') {
		throw new SilentError(new Error('no checkpoint_remote configured'));
	}
	const refSpec = `+refs/heads/${METADATA_BRANCH_NAME}:refs/heads/${METADATA_BRANCH_NAME}`;
	const baseArgs = ['fetch', '--no-tags', checkpointRemoteUrl, refSpec];
	const args = await appendFetchFilterArgs(baseArgs, { cwd: repoRoot });
	try {
		await runFetchCommand(repoRoot, checkpointRemoteUrl, args);
	} catch (e) {
		throw new Error(`failed to fetch from checkpoint remote: ${(e as Error).message}`);
	}
}

/**
 * Batch-fetch specific blob objects by SHA-1 hash. Powers the lazy
 * blob-fetching tree provider for v2 checkpoints — once Phase 4.x
 * ships a TS equivalent of Go's `NewFetchingTree`, its blob resolver
 * will call into this helper.
 *
 * Mirrors Go `git_operations.go:566 FetchBlobsByHash`. Requires the
 * server to enable `uploadpack.allowReachableSHA1InWant` (supported by
 * GitHub / GitLab / Bitbucket).
 *
 * Fallback chain on by-hash fetch failure (Go parity):
 *   1. Try `fetchMetadataFromCheckpointRemote(url)` when `checkpointUrl`
 *      is non-empty (e.g. private checkpoint-remote repo)
 *   2. Otherwise / on step 1 failure, fall back to
 *      `fetchMetadataBranch(remote)` (full metadata refresh)
 *
 * Awaiting Phase 4.x fetching-tree equivalent — the function is
 * shipped, but no production callsite wires it in yet.
 *
 * @example
 * await fetchBlobsByHash('/repo', 'origin', ['deadbeef...', 'cafeface...']);
 * // Happy: single fetch fetches all hashes; new pack objects appear under .git/objects.
 *
 * await fetchBlobsByHash('/repo', 'origin', ['missing...'], 'https://github.com/o/r.git');
 * // On failure: first tries URL fetch, then falls back to `origin` full metadata fetch.
 */
export async function fetchBlobsByHash(
	repoRoot: string,
	remote: string,
	blobHashes: readonly string[],
	checkpointUrl = '',
): Promise<void> {
	if (blobHashes.length === 0) {
		return;
	}
	const fetchTarget = await resolveFetchTarget(remote, { cwd: repoRoot });
	const args = ['fetch', '--no-tags', '--no-write-fetch-head', fetchTarget, ...blobHashes];
	try {
		await runFetchCommand(repoRoot, fetchTarget, args);
		return;
	} catch {
		// First try checkpoint-remote URL fetch (private-repo scenario), then
		// fall back to full metadata branch fetch. Matches Go
		// `git_operations.go:588-594`.
		if (checkpointUrl !== '') {
			try {
				await fetchMetadataFromCheckpointRemote(repoRoot, checkpointUrl);
				return;
			} catch {
				// fall through
			}
		}
		await fetchMetadataBranch(repoRoot, remote);
	}
}
