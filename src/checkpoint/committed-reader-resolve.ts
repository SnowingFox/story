/**
 * v1/v2 fallback resolver for committed-checkpoint reads.
 *
 * The Story CLI is mid-migration: Phase 4.4 will introduce a v2 metadata
 * store backed by a different ref namespace. This module gives downstream
 * commands a stable surface — they pass both stores and a "prefer v2" flag,
 * we pick whichever one actually has the checkpoint.
 *
 * Phase 4.3 ships the resolver but only ever sees `v2Store === null` from
 * production callers, so the v2 branch never fires. The branch + tests are
 * here so Phase 4.4 can flip on the v2 store without touching the resolver.
 *
 * Go reference:
 * `entire-cli/cmd/entire/cli/checkpoint/committed_reader_resolve.go`.
 */

import { ErrCheckpointNotFound, ErrNoTranscript } from './committed';
import type { CheckpointSummary, CommittedReader } from './types';

/**
 * Resolution result: which reader actually fielded the request, plus the
 * summary it returned (so callers don't need a second `readCommitted`).
 */
export interface CommittedReaderResolution {
	reader: CommittedReader;
	summary: CheckpointSummary | null;
}

/**
 * Decide whether to read `checkpointId` from v2 or v1.
 *
 * Algorithm:
 *
 * 1. If `preferCheckpointsV2 && v2Store !== null`, try v2 first.
 * 2. On a v2 hit (`summary !== null`), return `(v2Store, summary)`.
 * 3. On a v2 miss / `ErrCheckpointNotFound` / parse error, fall through.
 * 4. Try v1. Hit → `(v1Store, summary)`. Miss → `(v1Store, null)`.
 *
 * @example
 * ```ts
 * // Common case: v2 has the checkpoint, prefer it.
 * const v1 = new GitStore(repoDir);
 * const v2 = new V2GitStore(repoDir);
 * const { reader, summary } = await resolveCommittedReader(
 *   null, 'a3b2c4d5e6f7', v1, v2, true
 * );
 * // reader === v2; summary === <CheckpointSummary from v2 /main>
 * // Caller now reads sessions through `reader.readSessionContent(...)`
 * // without caring which store is which.
 *
 * // Fallback: v2 enabled but doesn't have this checkpoint (e.g. legacy
 * // checkpoint written before v2 was turned on).
 * await resolveCommittedReader(null, 'oldcheckpoint', v1, v2, true);
 * // → { reader: v1, summary: <CheckpointSummary from v1> }
 *
 * // Fallback: malformed v2 metadata. Resolver swallows the error and
 * // tries v1 instead — keeps the migration window resilient.
 * await resolveCommittedReader(null, 'corruptv2', v1, v2, true);
 * // → { reader: v1, summary: <CheckpointSummary from v1> }
 *
 * // Disabled v2: skip the v2 attempt entirely.
 * await resolveCommittedReader(null, 'a3b2c4d5e6f7', v1, v2, false);
 * // → { reader: v1, summary: <v1 summary> }
 *
 * // Both stores miss → resolver still returns v1 (with null summary) so
 * // the caller has a reader to use for richer error messages.
 * await resolveCommittedReader(null, 'deadbeefcafe', v1, null, false);
 * // → { reader: v1, summary: null }
 * ```
 */
export async function resolveCommittedReader(
	_ctx: AbortSignal | null,
	checkpointId: string,
	v1Store: CommittedReader,
	v2Store: CommittedReader | null,
	preferCheckpointsV2: boolean,
): Promise<CommittedReaderResolution> {
	if (preferCheckpointsV2 && v2Store !== null) {
		try {
			const summary = await v2Store.readCommitted(checkpointId);
			if (summary !== null) {
				return { reader: v2Store, summary };
			}
			// Miss → fall through to v1.
		} catch (err) {
			if (!isExpectedMiss(err)) {
				// Don't propagate v2 failures — Go logs and falls through to
				// keep a valid v1 copy reachable during the migration window.
			}
			// fall through
		}
	}

	const summary = await v1Store.readCommitted(checkpointId);
	return { reader: v1Store, summary };
}

/**
 * Companion of {@link resolveCommittedReader} for the raw session log read
 * path (`getSessionLog`). Same v2-first-then-v1 fallback shape.
 *
 * Returns `null` when neither store has the checkpoint or its transcript.
 * Re-throws non-sentinel errors from v1 (e.g. corrupt git object) so they
 * surface as bugs instead of silently turning into "no log available".
 *
 * @example
 * ```ts
 * const log = await resolveRawSessionLog(null, 'a3b2c4d5e6f7', v1, v2, true);
 * // log === { transcript: <Uint8Array>, sessionId: 'sess-2' }
 *
 * // v2 enabled but missing this checkpoint → fall back to v1.
 * await resolveRawSessionLog(null, 'oldcp', v1, v2, true);
 * // → { transcript: <v1 raw>, sessionId: 'sess-1' }
 *
 * // Neither has it → null (not throw).
 * await resolveRawSessionLog(null, 'deadbeefcafe', v1, null, true);
 * // → null
 *
 * // Real I/O error from v1 (corrupt object) bubbles up unchanged.
 * // Compare to "expected miss" sentinels (ErrCheckpointNotFound,
 * // ErrNoTranscript) which are downgraded to null.
 * ```
 */
export async function resolveRawSessionLog(
	_ctx: AbortSignal | null,
	checkpointId: string,
	v1Store: CommittedReader,
	v2Store: CommittedReader | null,
	preferCheckpointsV2: boolean,
): Promise<{ transcript: Uint8Array; sessionId: string } | null> {
	if (preferCheckpointsV2 && v2Store !== null) {
		try {
			const log = await v2Store.getSessionLog(checkpointId);
			if (log !== null && log.transcript.length > 0) {
				return log;
			}
		} catch (err) {
			if (!isExpectedMiss(err)) {
				// fall through, same rationale as resolveCommittedReader
			}
		}
	}

	try {
		return await v1Store.getSessionLog(checkpointId);
	} catch (err) {
		if (isExpectedMiss(err)) {
			return null;
		}
		throw err;
	}
}

function isExpectedMiss(err: unknown): boolean {
	return err instanceof ErrCheckpointNotFound || err instanceof ErrNoTranscript;
}
