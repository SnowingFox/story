/**
 * Shared type declarations for the compact transcript subsystem.
 *
 * Shape derived from Go
 * `entire-cli/cmd/entire/cli/transcript/compact/compact.go` (`MetadataFields`
 * / `transcriptLine` structs). No behavioural code lives here — the runtime
 * algorithms that produce `CompactTranscriptLine`-shaped output live in
 * sibling `index.ts` / `jsonl.ts` and are covered by their own tests.
 *
 * @packageDocumentation
 */

/**
 * Metadata fields written verbatim onto every output line of the compact
 * transcript. Shape derived from Go `compact.MetadataFields`.
 */
export interface CompactMetadataFields {
	/** Lowercase, hyphenated agent identifier (e.g. `'claude-code'`, `'cursor'`). */
	agent: string;
	/** CLI version (`versioninfo.Version` equivalent). */
	cliVersion: string;
	/** `checkpoint_transcript_start` line/message offset (0 = no truncation). */
	startLine: number;
}

/**
 * Uniform output line in the compact `transcript.jsonl`. Field order is
 * preserved by the JSON encoder; mirrors Go `compact.transcriptLine` (struct
 * declaration order).
 */
export interface CompactTranscriptLine {
	/** Format version, always `1` for the current compact format. */
	v: number;
	/** Agent identifier (echoed from {@link CompactMetadataFields.agent}). */
	agent: string;
	/** CLI version (echoed from {@link CompactMetadataFields.cliVersion}). */
	cli_version: string;
	/** Entry kind. */
	type: 'user' | 'assistant';
	/** Optional timestamp passthrough (raw JSON value from the source line). */
	ts?: unknown;
	/** Assistant message id (omitted on user lines). */
	id?: string;
	/** API input tokens (assistant only; omitted when 0 in Go encoding). */
	input_tokens?: number;
	/** API output tokens (assistant only; omitted when 0 in Go encoding). */
	output_tokens?: number;
	/** Content blocks (assistant: array of text/tool_use/...; user: array of text/image). */
	content: unknown;
}
