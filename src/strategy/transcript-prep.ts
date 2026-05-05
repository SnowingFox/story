/**
 * Pre-process the transcript file before reading it for condensation /
 * rewind / etc. (e.g., flush buffered writes to disk, normalize line endings).
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/strategy/common.go:1636-1669` —
 * `prepareTranscriptForState` / `prepareTranscriptIfNeeded`.
 *
 * Phase 6.1 Part 2: dispatches via `caps.asTranscriptPreparer` to the
 * agent's `prepareTranscript` implementation. Active phase only (matches Go).
 *
 * @packageDocumentation
 */

import fs from 'node:fs/promises';
import * as caps from '../agent/capabilities';
import * as registry from '../agent/registry';
import * as log from '../log';
import { resolveTranscriptPath } from './resolve-transcript';
import type { SessionState } from './types';

/**
 * Pre-process the transcript for `state` — calls the agent's `prepareTranscript`
 * (e.g. `OpenCode` runs `opencode export` to flush its lazy session bytes).
 *
 * **Active phase only**: idle / ended sessions already had their flush done by
 * the Stop hook (Go: `common.go:1641` — `if !state.Phase.IsActive() ...`).
 *
 * **Failure handling**: any failure (unknown agent / preparer throws) is logged
 * via `log.warn` and swallowed — this is best-effort in hook paths. Story-side
 * uses warn (Go uses silent ignore via `_ = preparer.PrepareTranscript`); the
 * warn helps diagnose stuck-transcript bugs without breaking the hook flow.
 *
 * Mirrors Go `common.go:1636-1675` (`prepareTranscriptForState`; the helper
 * `prepareTranscriptIfNeeded` is exported separately below — Story-side
 * splits the existence-stat from the dispatch core).
 *
 * @example
 * await prepareTranscriptForState(state);
 * // returns: undefined
 * //
 * // Side effects (when state.phase === 'active' AND agent implements
 * // TranscriptPreparer):
 * //   may invoke external CLI (e.g., `opencode export`) which writes the
 * //   transcript file to disk.
 * //
 * // Disk / git refs / HEAD: unchanged in this helper.
 */
export async function prepareTranscriptForState(state: SessionState): Promise<void> {
	// Go: common.go:1640-1641 — active phase + non-empty path + non-empty agent only.
	if (state.phase !== 'active' || !state.transcriptPath || !state.agentType) {
		return;
	}
	const ag = registry.getByAgentType(state.agentType);
	if (ag === null) {
		log.warn({ component: 'strategy.transcript-prep' }, 'unknown agent for transcript prep', {
			agentType: state.agentType,
		});
		return;
	}
	const [prep, hasPrep] = caps.asTranscriptPreparer(ag);
	if (!hasPrep) {
		// Agent doesn't implement TranscriptPreparer — silent (legitimate).
		return;
	}
	try {
		await prep.prepareTranscript(state.transcriptPath);
	} catch (e) {
		log.warn({ component: 'strategy.transcript-prep' }, 'transcript preparer failed', {
			agentType: state.agentType,
			error: (e as Error).message,
		});
	}
}

/**
 * Conditionally pre-process the transcript: only stat-checks the path, then
 * delegates to {@link prepareTranscriptForState} when the file exists.
 *
 * Used by codepaths where the transcript may not exist yet (e.g., session
 * never recorded a turn) — avoids an exception for the common "no transcript
 * yet" case. Story-side helper: Go `common.go:1657-1669` calls
 * `prepareTranscript` directly without an existence guard; the TS wrapper
 * adds `resolveTranscriptPath` + `stat` so cross-CLI extract paths
 * (`extract-session-data`) don't blow up on first-run sessions.
 *
 * @example
 * ```ts
 * // state.transcriptPath = '/repo/.story/sessions/sess-1/transcript.jsonl'
 *
 * await prepareTranscriptIfNeeded(state);
 * // returns: undefined
 *
 * // Side effects (file present + state.phase === 'active'):
 * //   - resolveTranscriptPath may mutate state.transcriptPath when an
 * //     agent-aware migration applies (e.g., Cursor flat → nested layout).
 * //   - prepareTranscriptForState may invoke an external CLI (e.g.,
 * //     `opencode export`) that flushes the transcript file to disk.
 * //
 * // Skip paths (silent return, no work):
 * //   - state.transcriptPath empty
 * //   - file missing (ENOENT)
 * //   - state.phase !== 'active' (idle/ended already flushed)
 * //   - agent unknown / no TranscriptPreparer capability
 * //
 * // Disk / git refs / HEAD / index: unchanged.
 * ```
 */
export async function prepareTranscriptIfNeeded(state: SessionState): Promise<void> {
	if (!state.transcriptPath) {
		return;
	}
	try {
		// Use resolveTranscriptPath so agent-aware path migration is applied
		// (e.g., Cursor flat→nested). Will throw ENOENT if file missing AND
		// no resolver matches; we swallow that.
		const resolved = await resolveTranscriptPath(state);
		await fs.stat(resolved);
	} catch (err) {
		if ((err as { code?: string }).code === 'ENOENT') {
			return;
		}
		throw err;
	}
	await prepareTranscriptForState(state);
}
