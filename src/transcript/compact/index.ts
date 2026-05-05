/**
 * Main dispatch for the compact transcript subsystem.
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/transcript/compact/compact.go`
 * (the `Compact` function). Format-detection based dispatch — does **not**
 * accept an `agentType` parameter (Go 1:1).
 *
 * Algorithm:
 *
 *   1. Empty input → return null.
 *   2. Pre-truncation format detection (formats that need to see header lines):
 *      - {@link isOpenCodeFormat} → {@link compactOpenCode} (single JSON object;
 *        `startLine` as message-index offset, not line offset)
 *      - {@link isCodexFormat} → {@link compactCodex} (Phase 6.5 — handles its
 *        own startLine slicing internally; preserves session_meta header line
 *        when offset === 0)
 *   3. {@link sliceFromLine} truncation at `opts.startLine`. (Documented Go
 *      micro-difference: Go falls through to `compactJSONL([]byte{}, opts)`
 *      which returns `(nil, nil)`; we return `null` directly. Caller behaviour
 *      is equivalent — `condensation.ts` checks `=== null || .length === 0`.)
 *   4. Default: {@link compactJSONL} — handles Claude Code + Cursor + Unknown
 *      JSONL agents.
 *
 * **Dropped**: Gemini, Copilot CLI, and Factory AI Droid format detectors
 * were removed when those agents were dropped from the built-in roadmap —
 * see [`references/dropped-agents.md`](../../../docs/ts-rewrite/impl/references/dropped-agents.md).
 * External plugins can still ship these parsers via `story-agent-*` binaries.
 *
 * @packageDocumentation
 */

import { sliceFromLine } from '../../transcript';
import { compactCodex, isCodexFormat } from './codex';
import { compactJSONL } from './jsonl';
import { compactOpenCode, isOpenCodeFormat } from './opencode';
import type { CompactMetadataFields } from './types';

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/**
 * Convert a redacted full-format transcript into the compact `transcript.jsonl`
 * format, returning `null` when there is nothing to write.
 *
 * The input must be pre-redacted (via `redactJSONLBytes` in Phase 1.4 redact
 * module). Caller (`writeCommittedV2IfEnabled` in
 * `src/strategy/condensation.ts`) treats `null` as "skip writing
 * `transcript.jsonl` on the v2 `/main` ref".
 *
 * @example
 *   compact(redactedBytes, { agent: 'claude-code', cliVersion: '0.5.1', startLine: 0 });
 *   // → Uint8Array of compact transcript lines, or null on empty / Phase-6.x stub format / startLine beyond end
 *   //
 *   // Side effects: none (pure transformation)
 */
export function compact(redacted: Uint8Array, opts: CompactMetadataFields): Uint8Array | null {
	if (redacted.length === 0) {
		return null;
	}

	if (isOpenCodeFormat(redacted)) {
		const out = compactOpenCode(redacted, opts);
		return out !== null && out.length === 0 ? null : out;
	}
	if (isCodexFormat(redacted)) {
		// Codex: BEFORE sliceFromLine — compactCodex handles its own startLine
		// slicing (preserves session_meta header line for parseSessionStartTime).
		const out = compactCodex(redacted, opts);
		return out.length === 0 ? null : out;
	}

	const text = decoder.decode(redacted);
	const truncated = sliceFromLine(text, opts.startLine);
	if (truncated === null || truncated === '') {
		return null;
	}
	const truncatedBytes = encoder.encode(truncated);

	return compactJSONL(truncatedBytes, opts);
}
