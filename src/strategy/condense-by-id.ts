/**
 * Two alternate entry points to the condensation pipeline:
 *
 * - {@link condenseSessionByID} — used by `story doctor` to salvage stuck
 *   sessions. Resets state to phase=IDLE on success; deletes the state file
 *   when no shadow branch exists.
 * - {@link condenseAndMarkFullyCondensed} — used by the SessionStop hook for
 *   eager cleanup. Preserves phase=ENDED, never deletes state, and is
 *   fail-open (returns silently when condense throws so PostCommit can retry).
 *
 * The two share most of the pipeline but differ in:
 *
 * 1. State-not-found behavior (ByID throws, eager returns silently)
 * 2. filesTouched handling (eager early-returns; ByID always proceeds)
 * 3. Phase post-condense (ByID → IDLE, eager keeps ENDED)
 * 4. Shadow-missing handling (ByID deletes state, eager just marks FullyCondensed)
 * 5. Error policy (ByID propagates condense errors; eager swallows + warns)
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/strategy/manual_commit_condensation.go`
 * (`CondenseSessionByID` + `CondenseAndMarkFullyCondensed`).
 *
 * @packageDocumentation
 */

import { shadowBranchNameForCommit } from '../checkpoint/temporary';
import { generate as generateCheckpointId } from '../id';
import * as log from '../log';
import * as condensationMod from './condensation';
import { cleanupShadowBranchIfUnused, resolveShadowRef } from './condense-helpers';
import type { ManualCommitStrategy } from './manual-commit';

/**
 * `story doctor` entry point — condense + clean up a stuck session by ID.
 *
 * Behavior tree:
 *
 * - State file missing → throw `'session not found'`.
 * - Shadow branch missing → call `s.clearSessionState(sessionId)` to delete
 *   the state file outright (the doctor convention: stuck sessions with no
 *   shadow data get cleaned, not just marked).
 * - {@link condenseSession} returns `skipped: true` → mark
 *   `state.fullyCondensed = true`, save state, no shadow cleanup.
 * - Successful condense → reset state to IDLE: `stepCount=0` /
 *   `phase='idle'` / `lastCheckpointId=<new>` / clear PA arrays / set
 *   `attributionBaseCommit = baseCommit`. Then best-effort
 *   {@link cleanupShadowBranchIfUnused} (warn-and-continue on failure).
 *
 * Mirrors Go `CondenseSessionByID`.
 *
 * @example
 * await condenseSessionByID(strategy, '2026-04-19-stuck');
 *
 * // Side effects (success path):
 * //   .git/story-sessions/<id>.json                ← rewritten with phase=idle
 * //   refs/heads/story/checkpoints/v1              ← bumped to new commit
 * //   refs/heads/story/<base>-<6hex>               ← deleted (when no other session uses it)
 * // (no-op when state file missing → throws; no-op when shadow missing → state file deleted.)
 */
export async function condenseSessionByID(
	s: ManualCommitStrategy,
	sessionId: string,
): Promise<void> {
	const logCtx = { component: 'condense-by-id', sessionId };
	const state = await s.loadSessionState(sessionId);
	if (state === null) {
		throw new Error(`session not found: ${sessionId}`);
	}

	const checkpointId = generateCheckpointId();
	const repo = await s.getRepo();
	const shadowBranchName = shadowBranchNameForCommit(state.baseCommit, state.worktreeId ?? '');
	const { exists: hasShadowBranch } = await resolveShadowRef(repo.root, shadowBranchName);

	if (!hasShadowBranch) {
		log.info(logCtx, 'no shadow branch for session, clearing state only', {
			session_id: sessionId,
			shadow_branch: shadowBranchName,
		});
		try {
			await s.clearSessionState(sessionId);
		} catch (err) {
			throw new Error(
				`failed to clear session state: ${err instanceof Error ? err.message : String(err)}`,
				{ cause: err as Error },
			);
		}
		return;
	}

	const result = await condensationMod.condenseSession(s, checkpointId, state, null);

	if (result.skipped) {
		log.info(
			logCtx,
			'session condensation skipped (no transcript or files), marking fully condensed',
			{ session_id: sessionId },
		);
		state.fullyCondensed = true;
		await s.saveSessionState(state);
		return;
	}

	log.info(logCtx, 'session condensed by ID', {
		session_id: sessionId,
		checkpoint_id: String(result.checkpointId),
		checkpoints_condensed: result.checkpointsCount,
	});

	// Reset state to IDLE.
	state.stepCount = 0;
	state.checkpointTranscriptStart = result.totalTranscriptLines;
	state.compactTranscriptStart =
		(state.compactTranscriptStart ?? 0) + result.compactTranscriptLines;
	state.checkpointTranscriptSize = result.transcript.length;
	state.phase = 'idle';
	state.lastCheckpointId = result.checkpointId;
	state.attributionBaseCommit = state.baseCommit;
	state.promptAttributions = undefined;
	state.pendingPromptAttribution = undefined;

	try {
		await s.saveSessionState(state);
	} catch (err) {
		throw new Error(
			`failed to save session state: ${err instanceof Error ? err.message : String(err)}`,
			{ cause: err as Error },
		);
	}

	try {
		await cleanupShadowBranchIfUnused(s, repo.root, shadowBranchName, sessionId);
	} catch (err) {
		log.warn(logCtx, 'failed to clean up shadow branch', {
			shadow_branch: shadowBranchName,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

/**
 * SessionStop hook entry point — eager condense + mark FullyCondensed so the
 * later PostCommit hook doesn't have to repeat the work.
 *
 * **Differs from {@link condenseSessionByID}** (Go inlines the function for
 * exactly these reasons):
 *
 * - State file missing → return silently (the session may have been cleaned
 *   up out of band; PostCommit will skip it too).
 * - `state.filesTouched` non-empty → return early. PostCommit needs to walk
 *   the carry-forward state file by file; eager condensation would break the
 *   1:1 commit ↔ checkpoint linkage.
 * - `state.stepCount === 0` → mark FullyCondensed=true and save (skip the
 *   condense entirely; nothing to record).
 * - Shadow branch missing → mark FullyCondensed=true and save; **do NOT
 *   delete state file** (vs. ByID which clears it).
 * - condenseSession throws → log warn + return silently (fail-open; PostCommit
 *   will retry).
 * - On success: reset stepCount/PA arrays but **keep `state.phase = 'ended'`**
 *   (vs. ByID which sets IDLE).
 *
 * Mirrors Go `CondenseAndMarkFullyCondensed`.
 *
 * @example
 * await condenseAndMarkFullyCondensed(strategy, '2026-04-19-ended');
 *
 * // Side effects (success path with shadow branch):
 * //   .git/story-sessions/<id>.json     ← rewritten with phase=ended, fullyCondensed=true
 * //   refs/heads/story/checkpoints/v1   ← bumped to new commit
 * //   refs/heads/story/<base>-<6hex>    ← deleted (when no other session uses it)
 * // No state file deletion. Fail-open on any error.
 */
export async function condenseAndMarkFullyCondensed(
	s: ManualCommitStrategy,
	sessionId: string,
): Promise<void> {
	const logCtx = { component: 'checkpoint', sessionId };
	const state = await s.loadSessionState(sessionId);
	if (state === null) {
		return; // No state file → silent no-op (vs. ByID which throws).
	}

	if ((state.filesTouched ?? []).length > 0) {
		return; // PostCommit needs carry-forward — don't pre-condense.
	}

	if (state.stepCount <= 0) {
		state.fullyCondensed = true;
		await s.saveSessionState(state);
		return;
	}

	let repo: Awaited<ReturnType<typeof s.getRepo>>;
	try {
		repo = await s.getRepo();
	} catch (err) {
		log.warn(logCtx, 'eager condense: failed to open repository', {
			session_id: sessionId,
			error: err instanceof Error ? err.message : String(err),
		});
		return;
	}

	const shadowBranchName = shadowBranchNameForCommit(state.baseCommit, state.worktreeId ?? '');
	const { exists: hasShadowBranch } = await resolveShadowRef(repo.root, shadowBranchName);

	if (!hasShadowBranch) {
		log.info(logCtx, 'eager condense: no shadow branch', {
			session_id: sessionId,
			shadow_branch: shadowBranchName,
		});
		state.stepCount = 0;
		state.fullyCondensed = true;
		await s.saveSessionState(state);
		return;
	}

	let checkpointId: ReturnType<typeof generateCheckpointId>;
	try {
		checkpointId = generateCheckpointId();
	} catch (err) {
		log.warn(logCtx, 'eager condense: failed to generate checkpoint ID', {
			error: err instanceof Error ? err.message : String(err),
		});
		return;
	}

	let result: Awaited<ReturnType<typeof condensationMod.condenseSession>>;
	try {
		result = await condensationMod.condenseSession(s, checkpointId, state, null);
	} catch (err) {
		log.warn(logCtx, 'eager condense on session stop failed, PostCommit will retry', {
			session_id: sessionId,
			error: err instanceof Error ? err.message : String(err),
		});
		return;
	}

	if (result.skipped) {
		log.info(logCtx, 'eager condense skipped (no transcript or files), marking fully condensed', {
			session_id: sessionId,
		});
		state.fullyCondensed = true;
		await s.saveSessionState(state);
		return;
	}

	// Reset state but **keep phase=ENDED** (key difference from ByID).
	state.stepCount = 0;
	state.checkpointTranscriptStart = result.totalTranscriptLines;
	state.compactTranscriptStart =
		(state.compactTranscriptStart ?? 0) + result.compactTranscriptLines;
	state.lastCheckpointId = result.checkpointId;
	state.attributionBaseCommit = state.baseCommit;
	state.promptAttributions = undefined;
	state.pendingPromptAttribution = undefined;
	state.fullyCondensed = true;
	// state.phase remains 'ended' — DO NOT touch.

	log.info(logCtx, 'eager condense on session stop succeeded', {
		session_id: sessionId,
		checkpoint_id: String(result.checkpointId),
	});

	try {
		await s.saveSessionState(state);
	} catch (err) {
		throw new Error(
			`failed to save session state: ${err instanceof Error ? err.message : String(err)}`,
			{ cause: err as Error },
		);
	}

	try {
		await cleanupShadowBranchIfUnused(s, repo.root, shadowBranchName, sessionId);
	} catch (err) {
		log.warn(logCtx, 'eager condense: failed to clean up shadow branch', {
			shadow_branch: shadowBranchName,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}
