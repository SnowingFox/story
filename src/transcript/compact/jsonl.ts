/**
 * Two-pass JSONL transcript compactor — handles all JSONL-formatted transcripts
 * (Claude Code, Cursor, Unknown).
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/transcript/compact/compact.go`
 * (algorithms `compactJSONL` / `compactJSONLWith` + 18 helpers + private
 * `parsedEntry` / `toolResultEntry` / `toolResultFile` types).
 *
 * Algorithm:
 *
 *   Pass 1 (`parseJSONLEntries`): each line → intermediate `parsedEntry`
 *     `{ kind, ts, id, userText, userImages, toolResults, content,
 *        inputTokens, outputTokens }`
 *
 *   Pass 2 (loop): for each entry,
 *     - assistant: merge consecutive same-id assistant entries; lookahead user
 *       tool_result entries → `inlineToolResults` attaches `result` to matching
 *       `tool_use` blocks; emit `assistant` line; if consumed user had
 *       text/image also emit a separate `user` line; skip empty content arrays
 *     - user: skip if pure tool_results (already consumed); else emit `user`
 *       line
 *
 * Cursor (`role:'user'` / `role:'assistant'`) flows through unchanged via
 * `userAliases` + `normalizeKind` — no per-agent dispatch in this file.
 *
 * @packageDocumentation
 */

import { stripIDEContextTags } from '../../textutil';
import { sliceFromLine } from '../../transcript';
import type { CompactMetadataFields } from './types';

/**
 * Type / role string constants. Kept local (rather than importing from the
 * parent `transcript` module) to avoid an import cycle.
 */
const TYPE_USER = 'user';
const TYPE_ASSISTANT = 'assistant';
const CONTENT_TYPE_TEXT = 'text';
const CONTENT_TYPE_TOOL_USE = 'tool_use';

const TOOL_RESULT_STATUS_ERROR = 'error';

/** JSONL entry types that carry no parser-relevant data. */
const droppedTypes = new Set(['progress', 'file-history-snapshot', 'queue-operation', 'system']);

/** JSONL `type` / `role` values that map to the canonical `'user'` kind. */
const userAliases = new Set([TYPE_USER, 'human']);

/** Structured file metadata extracted from Read/Edit `toolUseResult`. */
interface ToolResultFile {
	filePath: string;
	/** 0 if not available (e.g. Edit results). */
	numLines: number;
}

/**
 * One tool_result block parsed out of a user message (with optional rich
 * metadata enriched from the sibling `toolUseResult` envelope).
 */
interface ToolResultEntry {
	toolUseID: string;
	output: string;
	isError: boolean;
	/** Read/Edit: file path and line count. */
	file?: ToolResultFile;
	/** Grep: number of matching files. */
	matchCount: number;
}

/**
 * Intermediate representation of one JSONL line during the two-pass conversion.
 */
interface ParsedEntry {
	kind: 'user' | 'assistant';
	/** Raw `timestamp` field from the JSONL line (passthrough). */
	ts: unknown;
	/** Assistant message id (`message.id`). */
	id: string;
	/** Prompt id (user only, e.g. Claude's `promptId`). */
	userID: string;
	inputTokens: number;
	outputTokens: number;
	/** Stripped assistant content (array of blocks or a string), or undefined. */
	content: unknown;
	userText: string;
	userImages: unknown[];
	toolResults: ToolResultEntry[];
}

/**
 * Optional preprocessor that runs on each parsed JSONL line before
 * normalization. Used by future agent-specific compactors (e.g. Codex needs to
 * remap `response_item.payload`); kept exported so Phase 6.5 can wire it up
 * without changing this file's signature.
 */
export type LinePreprocessor = (raw: Record<string, unknown>) => Record<string, unknown>;

/**
 * Convert a JSONL transcript into the compact `transcript.jsonl` format.
 *
 * Input must be pre-redacted. Empty input → empty bytes (`new Uint8Array()`).
 *
 * @example
 *   compactJSONL(redactedBytes, { agent: 'claude-code', cliVersion: '0.5.1', startLine: 0 });
 *   // → Uint8Array of newline-terminated compact transcript lines
 *   //
 *   // Side effects: none (pure transformation)
 */
export function compactJSONL(content: Uint8Array, opts: CompactMetadataFields): Uint8Array {
	return compactJSONLWith(content, opts, undefined);
}

/**
 * `compactJSONL` extension that accepts an optional per-line preprocessor.
 */
export function compactJSONLWith(
	content: Uint8Array,
	opts: CompactMetadataFields,
	preprocess: LinePreprocessor | undefined,
): Uint8Array {
	const baseAgent = opts.agent;
	const baseCli = opts.cliVersion;

	// Pass 1: parse all lines into intermediate entries.
	const entries = parseJSONLEntries(content, preprocess);

	// Pass 2: merge and emit.
	const out: string[] = [];

	let i = 0;
	while (i < entries.length) {
		const e = entries[i]!;

		if (e.kind === TYPE_ASSISTANT) {
			// Merge consecutive assistant entries with the same message ID.
			let merged = e;
			while (
				i + 1 < entries.length &&
				entries[i + 1]!.kind === TYPE_ASSISTANT &&
				entries[i + 1]!.id === e.id
			) {
				i++;
				merged = mergeAssistantEntries(merged, entries[i]!);
			}

			// Look ahead for user tool_result entries to inline.
			if (
				i + 1 < entries.length &&
				entries[i + 1]!.kind === TYPE_USER &&
				hasToolResults(entries[i + 1]!)
			) {
				const userEntry = entries[i + 1]!;
				merged = inlineToolResults(merged, userEntry);
				i++; // consume the user tool_result entry

				if (userEntry.userText !== '' || userEntry.userImages.length > 0) {
					emitAssistant(out, baseAgent, baseCli, merged);
					emitUser(out, baseAgent, baseCli, userEntry);
					i++;
					continue;
				}
			}

			if (isEmptyContentArray(merged.content)) {
				i++;
				continue;
			}

			emitAssistant(out, baseAgent, baseCli, merged);
		} else {
			// kind === TYPE_USER
			if (hasToolResults(e) && e.userText === '' && e.userImages.length === 0) {
				i++;
				continue;
			}
			emitUser(out, baseAgent, baseCli, e);
		}

		i++;
	}

	return new TextEncoder().encode(out.join(''));
}

/**
 * Append a compact `assistant` line to `out`. Field order matches Go struct
 * declaration: v / agent / cli_version / type / ts / id / input_tokens /
 * output_tokens / content.
 */
function emitAssistant(out: string[], agent: string, cliVersion: string, e: ParsedEntry): void {
	const line: Record<string, unknown> = {
		v: 1,
		agent,
		cli_version: cliVersion,
		type: TYPE_ASSISTANT,
	};
	if (e.ts !== undefined) {
		line.ts = e.ts;
	}
	if (e.id !== '') {
		line.id = e.id;
	}
	if (e.inputTokens > 0) {
		line.input_tokens = e.inputTokens;
	}
	if (e.outputTokens > 0) {
		line.output_tokens = e.outputTokens;
	}
	line.content = e.content ?? null;
	appendLine(out, line);
}

/**
 * Append a compact `user` line to `out`. Synthesises a `text` block (with
 * optional `id` from `promptId`) when text is present OR when there are no
 * images; image blocks pass through verbatim.
 */
function emitUser(out: string[], agent: string, cliVersion: string, e: ParsedEntry): void {
	const blocks: unknown[] = [];

	if (e.userText !== '' || e.userImages.length === 0) {
		const textBlock: Record<string, unknown> = {};
		if (e.userID !== '') {
			textBlock.id = e.userID;
		}
		textBlock.text = e.userText;
		blocks.push(textBlock);
	}

	for (const img of e.userImages) {
		blocks.push(img);
	}

	const line: Record<string, unknown> = {
		v: 1,
		agent,
		cli_version: cliVersion,
		type: TYPE_USER,
	};
	if (e.ts !== undefined) {
		line.ts = e.ts;
	}
	line.content = blocks;
	appendLine(out, line);
}

/** JSON-stringify a transcript line and append to `out` with trailing newline. */
function appendLine(out: string[], line: Record<string, unknown>): void {
	let json: string;
	try {
		json = JSON.stringify(line);
	} catch {
		return;
	}
	out.push(json);
	out.push('\n');
}

/**
 * Parse all JSONL lines into intermediate entries, dropping malformed lines
 * and lines whose `type` / `role` is in `droppedTypes`.
 */
function parseJSONLEntries(
	content: Uint8Array,
	preprocess: LinePreprocessor | undefined,
): ParsedEntry[] {
	const entries: ParsedEntry[] = [];
	const text = new TextDecoder().decode(content);
	if (text === '') {
		return entries;
	}

	for (const rawLine of text.split('\n')) {
		const trimmed = rawLine.trim();
		if (trimmed === '') {
			continue;
		}
		const e = parseLine(trimmed, preprocess);
		if (e !== null) {
			entries.push(e);
		}
	}

	return entries;
}

/**
 * Convert a single JSONL line text into a `ParsedEntry`. Returns `null` for
 * malformed JSON or for lines whose normalized kind is empty (dropped types,
 * unknown types).
 */
function parseLine(lineText: string, preprocess: LinePreprocessor | undefined): ParsedEntry | null {
	let raw: Record<string, unknown>;
	try {
		const parsed = JSON.parse(lineText);
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return null;
		}
		raw = parsed as Record<string, unknown>;
	} catch {
		return null;
	}

	if (preprocess !== undefined) {
		raw = preprocess(raw);
	}

	const kind = normalizeKind(raw);
	if (kind === '') {
		return null;
	}

	const e: ParsedEntry = {
		kind: kind as 'user' | 'assistant',
		ts: raw.timestamp,
		id: '',
		userID: '',
		inputTokens: 0,
		outputTokens: 0,
		content: undefined,
		userText: '',
		userImages: [],
		toolResults: [],
	};

	const msg = parseMessage(raw);

	if (kind === TYPE_ASSISTANT) {
		if (msg !== null) {
			e.id = unquote(msg.id);
			if ('content' in msg) {
				e.content = stripAssistantContent(msg.content);
			}
			const usage = extractUsageTokens(msg);
			e.inputTokens = usage.inputTokens;
			e.outputTokens = usage.outputTokens;
		}
	} else {
		// kind === TYPE_USER
		e.userID = unquote(raw.promptId);
		if (msg !== null && 'content' in msg) {
			const uc = extractUserContent(msg.content);
			e.userText = uc.text;
			e.userImages = uc.images;
			e.toolResults = uc.toolResults;
		}
		const turRaw = raw.toolUseResult;
		if (turRaw !== undefined && turRaw !== null && typeof turRaw === 'object') {
			e.toolResults = enrichToolResults(e.toolResults, turRaw as Record<string, unknown>);
		}
	}

	return e;
}

/**
 * Return canonical entry kind (`'user'` / `'assistant'`) or `''` for dropped /
 * unknown lines. Checks `type` first, falls back to `role`.
 */
function normalizeKind(raw: Record<string, unknown>): string {
	let kind = unquote(raw.type);
	if (kind === '') {
		kind = unquote(raw.role);
	}
	if (droppedTypes.has(kind)) {
		return '';
	}
	if (userAliases.has(kind)) {
		return TYPE_USER;
	}
	if (kind === TYPE_ASSISTANT) {
		return TYPE_ASSISTANT;
	}
	return '';
}

/** Extract the parsed `message` object, or `null` when absent / non-object. */
function parseMessage(raw: Record<string, unknown>): Record<string, unknown> | null {
	const msgRaw = raw.message;
	if (msgRaw === undefined || msgRaw === null || typeof msgRaw !== 'object') {
		return null;
	}
	if (Array.isArray(msgRaw)) {
		return null;
	}
	return msgRaw as Record<string, unknown>;
}

/** Extract `usage.input_tokens` / `usage.output_tokens`; `(0, 0)` on absence. */
function extractUsageTokens(msg: Record<string, unknown>): {
	inputTokens: number;
	outputTokens: number;
} {
	const usage = msg.usage;
	if (usage === undefined || usage === null || typeof usage !== 'object') {
		return { inputTokens: 0, outputTokens: 0 };
	}
	const u = usage as Record<string, unknown>;
	const inputTokens = typeof u.input_tokens === 'number' ? u.input_tokens : 0;
	const outputTokens = typeof u.output_tokens === 'number' ? u.output_tokens : 0;
	return { inputTokens, outputTokens };
}

/** Return `true` iff `raw` is the JS empty array `[]`. */
function isEmptyContentArray(raw: unknown): boolean {
	return Array.isArray(raw) && raw.length === 0;
}

function hasToolResults(e: ParsedEntry): boolean {
	return e.toolResults.length > 0;
}

interface UserContentParts {
	text: string;
	images: unknown[];
	toolResults: ToolResultEntry[];
}

/**
 * Separate user `message.content` into text, images, and tool_result entries.
 * Strips IDE context tags from text (both string-content and array-content
 * paths). Multiple text blocks are concatenated with `'\n\n'` then trimmed.
 */
function extractUserContent(contentRaw: unknown): UserContentParts {
	if (typeof contentRaw === 'string') {
		return {
			text: stripIDEContextTags(contentRaw),
			images: [],
			toolResults: [],
		};
	}

	if (!Array.isArray(contentRaw)) {
		return { text: '', images: [], toolResults: [] };
	}

	const uc: UserContentParts = { text: '', images: [], toolResults: [] };

	for (const blockRaw of contentRaw) {
		if (blockRaw === null || typeof blockRaw !== 'object' || Array.isArray(blockRaw)) {
			continue;
		}
		const block = blockRaw as Record<string, unknown>;
		const blockType = unquote(block.type);

		if (blockType === 'tool_result') {
			const isError = typeof block.is_error === 'boolean' ? block.is_error : false;
			uc.toolResults.push({
				toolUseID: unquote(block.tool_use_id),
				output: unquote(block.content),
				isError,
				matchCount: 0,
			});
		} else if (blockType === 'image') {
			uc.images.push(blockRaw);
		} else if (blockType === CONTENT_TYPE_TEXT) {
			const stripped = stripIDEContextTags(unquote(block.text));
			if (stripped !== '') {
				uc.text += `${stripped}\n\n`;
			}
		}
	}

	uc.text = uc.text.trim();
	return uc;
}

/**
 * Strip `thinking` / `redacted_thinking` blocks and reduce `tool_use` blocks
 * to `{type, id, name, input}` only. Returns the input verbatim when it is a
 * string (not an array of blocks).
 */
function stripAssistantContent(contentRaw: unknown): unknown {
	if (typeof contentRaw === 'string') {
		return contentRaw;
	}
	if (!Array.isArray(contentRaw)) {
		return contentRaw;
	}

	const result: Record<string, unknown>[] = [];
	for (const blockRaw of contentRaw) {
		if (blockRaw === null || typeof blockRaw !== 'object' || Array.isArray(blockRaw)) {
			continue;
		}
		const block = blockRaw as Record<string, unknown>;
		const blockType = unquote(block.type);

		if (blockType === 'thinking' || blockType === 'redacted_thinking') {
			continue;
		}

		if (blockType === CONTENT_TYPE_TOOL_USE) {
			const stripped: Record<string, unknown> = {};
			copyField(stripped, block, 'type');
			copyField(stripped, block, 'id');
			copyField(stripped, block, 'name');
			copyField(stripped, block, 'input');
			result.push(stripped);
			continue;
		}

		result.push(block);
	}
	return result;
}

function copyField(dst: Record<string, unknown>, src: Record<string, unknown>, key: string): void {
	if (key in src) {
		dst[key] = src[key];
	}
}

/**
 * Merge structured metadata from a `toolUseResult` envelope into existing tool
 * result entries. The Bash branch additionally creates a fresh entry when none
 * exist (compatibility with transcripts that only include toolUseResult).
 */
function enrichToolResults(
	results: ToolResultEntry[],
	tur: Record<string, unknown>,
): ToolResultEntry[] {
	// Bash-style: stdout provides the output text.
	const stdout = unquote(tur.stdout);
	if (stdout !== '') {
		if (results.length === 0) {
			results = [
				{
					toolUseID: '',
					output: stdout,
					isError: false,
					matchCount: 0,
				},
			];
		} else if (results.length === 1) {
			results[0]!.output = stdout;
		}
	}

	// Read-style: file{filePath, numLines}.
	const fileRaw = tur.file;
	if (fileRaw !== undefined && fileRaw !== null && typeof fileRaw === 'object') {
		const file = fileRaw as Record<string, unknown>;
		const filePath = unquote(file.filePath);
		const numLines = typeof file.numLines === 'number' ? file.numLines : 0;
		if (filePath !== '') {
			applyToSingleResult(results, (tr) => {
				tr.file = { filePath, numLines };
			});
		}
	}

	// Edit-style: top-level filePath.
	const editFilePath = unquote(tur.filePath);
	if (editFilePath !== '') {
		applyToSingleResult(results, (tr) => {
			tr.file = { filePath: editFilePath, numLines: 0 };
		});
	}

	// Grep-style: numFiles as match count.
	if (typeof tur.numFiles === 'number' && tur.numFiles > 0) {
		const n = tur.numFiles;
		applyToSingleResult(results, (tr) => {
			tr.matchCount = n;
		});
	}

	return results;
}

function applyToSingleResult(results: ToolResultEntry[], fn: (tr: ToolResultEntry) => void): void {
	if (results.length === 1) {
		fn(results[0]!);
	}
}

/**
 * Combine two assistant entries with the same message ID. Concatenates content
 * blocks (any non-array content treated as empty for the concat — matches Go's
 * `json.Unmarshal` failure mode where the local slice stays nil and the merge
 * result is `[]`). Later timestamp wins; later non-zero token counts overwrite
 * earlier ones (Claude streaming reports cumulative usage, so the last
 * fragment is final).
 */
function mergeAssistantEntries(a: ParsedEntry, b: ParsedEntry): ParsedEntry {
	const merged: ParsedEntry = {
		...a,
		userImages: [...a.userImages],
		toolResults: [...a.toolResults],
	};
	merged.ts = b.ts;
	if (b.inputTokens > 0) {
		merged.inputTokens = b.inputTokens;
	}
	if (b.outputTokens > 0) {
		merged.outputTokens = b.outputTokens;
	}

	const aBlocks = Array.isArray(a.content) ? (a.content as unknown[]) : [];
	const bBlocks = Array.isArray(b.content) ? (b.content as unknown[]) : [];
	merged.content = [...aBlocks, ...bBlocks];

	return merged;
}

/**
 * Attach `result` fields to matching `tool_use` blocks in the assistant
 * entry's content, using outputs from the user `tool_result` entries.
 *
 * For each `toolResultEntry`: scan content blocks from the end and find the
 * last `tool_use` block whose `id` matches `tr.toolUseID` (or any `tool_use`
 * if `toolUseID` is empty — pre-2024 Claude compat). No-match → skip the
 * result.
 */
function inlineToolResults(assistant: ParsedEntry, user: ParsedEntry): ParsedEntry {
	const blocks = Array.isArray(assistant.content)
		? (assistant.content as Record<string, unknown>[])
		: null;
	if (blocks === null || blocks.length === 0) {
		return assistant;
	}

	for (const tr of user.toolResults) {
		let idx = -1;
		for (let i = blocks.length - 1; i >= 0; i--) {
			const block = blocks[i];
			if (
				block === undefined ||
				block === null ||
				typeof block !== 'object' ||
				Array.isArray(block)
			) {
				continue;
			}
			if (unquote(block.type) === CONTENT_TYPE_TOOL_USE) {
				if (tr.toolUseID === '' || unquote(block.id) === tr.toolUseID) {
					idx = i;
					break;
				}
			}
		}
		if (idx === -1) {
			continue;
		}
		blocks[idx]!.result = buildToolResult(tr);
	}

	assistant.content = blocks;
	return assistant;
}

/**
 * Construct the inlined `result` object for a `tool_use` block with optional
 * rich metadata (`file`, `matchCount`).
 */
function buildToolResult(tr: ToolResultEntry): Record<string, unknown> {
	const r: Record<string, unknown> = {
		output: tr.output,
		status: tr.isError ? TOOL_RESULT_STATUS_ERROR : 'success',
	};
	if (tr.file !== undefined) {
		const fileObj: Record<string, unknown> = { filePath: tr.file.filePath };
		if (tr.file.numLines > 0) {
			fileObj.numLines = tr.file.numLines;
		}
		r.file = fileObj;
	}
	if (tr.matchCount > 0) {
		r.matchCount = tr.matchCount;
	}
	return r;
}

/** Return `raw` as a string when it is one, otherwise `''`. */
function unquote(raw: unknown): string {
	return typeof raw === 'string' ? raw : '';
}

/**
 * Wrapper for callers that want to apply line-level pre-truncation before
 * compaction. Mirrors the way Go's `Compact()` calls
 * `transcript.SliceFromLine` before delegating to `compactJSONL`.
 *
 * @example
 *   sliceJSONLBytes(redactedBytes, opts.startLine);
 *   // → Uint8Array of post-truncation bytes (or empty when startLine ≥ total lines)
 *   //
 *   // Side effects: none (pure transformation)
 */
export function sliceJSONLBytes(content: Uint8Array, startLine: number): Uint8Array {
	const text = new TextDecoder().decode(content);
	const sliced = sliceFromLine(text, startLine);
	if (sliced === null) {
		return new Uint8Array();
	}
	return new TextEncoder().encode(sliced);
}
