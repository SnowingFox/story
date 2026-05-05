/**
 * Summary stub — permanent noop scaffold so the condensation main path can keep
 * its `if (isSummarizeEnabled(settings) && transcript.length > 0) summary = generateSummary(...)`
 * call site stable across phases. Phase 11 (Summarize) replaces the body of
 * `generateSummary` with real LLM calls; the export contract stays identical.
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/strategy/manual_commit_condensation.go`
 * (`generateSummary` call site) + `entire-cli/cmd/entire/cli/summarize/summarize.go`
 * (the real summarize package, deferred to Phase 11).
 *
 * **Note on `isSummarizeEnabled`**: Go's [`settings.go:447-471`](../../entire-cli/cmd/entire/cli/settings/settings.go)
 * places `IsSummarizeEnabled` in the settings layer (utility for any caller),
 * not the summarize subsystem. Story TS mirrors this — `isSummarizeEnabled`
 * lives in [`src/settings/settings.ts:301-310`](../settings/settings.ts) and
 * already has a real implementation reading `strategy_options.summarize.enabled`.
 * `condensation.ts` imports it directly from `../settings/settings`. Phase 11
 * swap is minimal: only `generateSummary` body changes.
 *
 * @packageDocumentation
 */

import type { Summary } from '../checkpoint/types';
import type { LogContext } from '../log';
import type { SessionState } from './types';

/**
 * Phase 5.3 stub: ALWAYS returns `null`. Phase 11 will wire this to an LLM
 * (Anthropic SDK / OpenAI SDK / Vercel AI SDK — selection deferred). The
 * caller in `condensation.ts` writes `summary: null` into the checkpoint
 * metadata when this returns null, which is the documented "summary disabled"
 * shape on the v1 metadata branch.
 *
 * @example
 * await generateSummary(
 *   { component: 'checkpoint', sessionId: 'sess-1' },
 *   redactedTranscript,
 *   ['src/app.ts'],
 *   state,
 * );
 * // Phase 5.3 Part 1: null  (always)
 * // Phase 11:           Summary | null  (real LLM call; null on failure)
 *
 * // Side effects: none — pure noop until Phase 11.
 */
// DEFER(phase-11): replace body with LLM call.
// blocked-by: src/strategy/summarize/* (Phase 11 subsystem not yet started — needs LLM SDK choice + summarize.GenerateFromTranscript per Go entire-cli/cmd/entire/cli/summarize/summarize.go)
// Replacement plan: docs/ts-rewrite/impl/phase-11-summarize/impl.md
export async function generateSummary(
	_logCtx: LogContext,
	_redactedTranscript: Uint8Array,
	_filesTouched: string[],
	_state: SessionState,
): Promise<Summary | null> {
	return null;
}
