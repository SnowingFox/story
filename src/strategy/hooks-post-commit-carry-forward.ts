/**
 * `hooks-post-commit-carry-forward.ts` — Carry uncommitted agent files
 * forward to a fresh shadow branch when PostCommit consumed only part of a
 * session's work.
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/strategy/manual_commit_hooks.go`:
 *   - `carryForwardToNewShadowBranch`
 *
 * **Critical invariant**: this resets `stepCount=1`, `*Start=0`, and
 * `lastCheckpointId=''` on success but **does NOT clear**
 * `state.turnCheckpointIds` — those still need finalization in
 * HandleTurnEnd with the full transcript.
 *
 * **Empty MetadataDir**: the new shadow branch is intentionally written
 * with an empty `metadataDir`. Including the transcript would cause
 * `sessionHasNewContent` to always return `true` (because the new
 * branch's `CheckpointTranscriptStart` is reset to `0`). Trade-off: each
 * carry-forward checkpoint is self-contained and re-bundles the full
 * transcript on the next condense — extra storage in exchange for
 * correctness.
 *
 * @packageDocumentation
 */

import * as log from '@/log';
import type { ManualCommitStrategy } from './manual-commit';
import type { SessionState } from './types';

/**
 * Create a new shadow branch at the **current HEAD** containing only the
 * `remainingFiles` (no metadata directory). On success, reset session
 * bookkeeping for the next condense cycle. On `writeTemporary` failure or
 * dedup-skip, log + return — `state` is left untouched.
 *
 * Mirrors Go `manual_commit_hooks.go: carryForwardToNewShadowBranch`.
 *
 * @example
 * await carryForwardToNewShadowBranch(strategy, state, ['src/main.ts', 'src/util.ts']);
 *
 * // Side effects (writeTemporary success):
 * //   refs/heads/story/<headSha>-<wt6>      ← new shadow branch ref
 * //   .git/objects/...                       ← new commit + tree + blobs
 * //   state                                   ← stepCount=1 / *Start=0 /
 * //                                            lastCheckpointId=''
 * //                                            (state.turnCheckpointIds preserved)
 * //
 * // Side effects (dedup-skip): none — state untouched.
 * //
 * // HEAD / index / worktree / state.json on disk (caller saves): unchanged.
 */
export async function carryForwardToNewShadowBranch(
	s: ManualCommitStrategy,
	state: SessionState,
	remainingFiles: readonly string[],
): Promise<void> {
	const start = Date.now();
	let store: Awaited<ReturnType<typeof s.getCheckpointStore>>;
	try {
		store = await s.getCheckpointStore();
	} catch (err) {
		log.warn(
			{ component: 'checkpoint', sessionId: state.sessionId },
			'post-commit: carry-forward failed (could not open checkpoint store)',
			{ error: err instanceof Error ? err.message : String(err) },
		);
		return;
	}

	let result: Awaited<ReturnType<typeof store.writeTemporary>>;
	try {
		result = await store.writeTemporary({
			sessionId: state.sessionId,
			baseCommit: state.baseCommit,
			worktreeId: state.worktreeId ?? '',
			modifiedFiles: [...remainingFiles],
			newFiles: [],
			deletedFiles: [],
			// **INTENTIONAL**: empty MetadataDir. Including transcript would
			// cause sessionHasNewContent to always return true (because the
			// new branch's CheckpointTranscriptStart resets to 0 below).
			metadataDir: '',
			metadataDirAbs: '',
			commitMessage: 'carry forward: uncommitted session files',
			// **Story-side divergence**: Go's `manual_commit_hooks.go:
			// carryForwardToNewShadowBranch` calls `store.WriteTemporary` with
			// the AuthorName / AuthorEmail fields left as zero-value (empty
			// strings) — go-git's commit object then defaults to the local git
			// `user.name` / `user.email` config. Story instead pins the author
			// to a stable identifier so `git log refs/heads/story/...` clearly
			// attributes carry-forward checkpoint commits to the CLI itself,
			// matching the Phase 5.2 SaveStep convention (see save-step.ts).
			// This also avoids surprising users by writing checkpoints under
			// their personal git identity.
			authorName: 'Story CLI',
			authorEmail: 'story@local',
			isFirstCheckpoint: false,
		});
	} catch (err) {
		log.warn(
			{ component: 'checkpoint', sessionId: state.sessionId },
			'post-commit: carry-forward failed',
			{ error: err instanceof Error ? err.message : String(err) },
		);
		return;
	}

	if (result.skipped) {
		log.debug(
			{ component: 'checkpoint', sessionId: state.sessionId },
			'post-commit: carry-forward skipped (no changes)',
		);
		return;
	}

	// Reset state for the carry-forward checkpoint.
	// CheckpointTranscriptStart=0 is intentional — each carry-forward
	// checkpoint is self-contained with full transcript on the next condense.
	state.stepCount = 1;
	state.checkpointTranscriptStart = 0;
	state.compactTranscriptStart = 0;
	state.checkpointTranscriptSize = 0;
	state.lastCheckpointId = '';
	// **DO NOT clear state.turnCheckpointIds** — those still need
	// finalization with the full transcript when HandleTurnEnd runs.

	log.info(
		{ component: 'checkpoint', sessionId: state.sessionId },
		'post-commit: carried forward remaining files',
		{ remainingFiles: remainingFiles.length },
	);
	log.debug({ component: 'checkpoint', sessionId: state.sessionId }, 'carry-forward timings', {
		writeMs: Date.now() - start,
		remainingFiles: remainingFiles.length,
	});
}
