/**
 * Codex transcript parser, token usage calculator, prompt extractor,
 * and rollout sanitizer.
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/agent/codex/transcript.go`.
 *
 * Concern groups:
 * 1. JSONL line shapes ({@link RolloutLine} / {@link SessionMetaPayload} /
 *    {@link ResponseItemPayload} / {@link ContentItem} / {@link EventMsgPayload} /
 *    {@link TokenCountInfo} / {@link TokenUsageData})
 * 2. TranscriptAnalyzer: {@link getTranscriptPosition} /
 *    {@link extractModifiedFilesFromOffset}
 * 3. apply_patch file extraction ({@link extractFilesFromApplyPatch} regex)
 * 4. TokenCalculator: {@link calculateTokenUsage} (cumulative delta —
 *    Codex reports session-wide totals, so we subtract baseline)
 * 5. PromptExtractor: {@link extractPrompts}
 * 6. Rollout sanitization ({@link sanitizePortableTranscript} +
 *    {@link sanitizeRestoredTranscript} alias) — strips encrypted reasoning
 *    fragments + drops compaction lines so `codex resume` doesn't choke
 * 7. JSONL helpers ({@link splitJSONL} / {@link parseSessionStartTime})
 *
 * @packageDocumentation
 */

import fs from 'node:fs/promises';
import { reassembleJSONL } from '@/agent/chunking';
import type { TokenUsage } from '@/agent/session';

/** Top-level JSONL line in Codex rollout files. */
export interface RolloutLine {
	timestamp?: string;
	/** `'session_meta'` / `'response_item'` / `'event_msg'` / `'turn_context'` /
	 *  `'compacted'` */
	type: string;
	payload: unknown;
}

const ROLLOUT_LINE_TYPE_RESPONSE_ITEM = 'response_item';

/** Payload for `type === 'session_meta'` lines (first line only). */
export interface SessionMetaPayload {
	id: string;
	/** RFC3339Nano timestamp string. Required. */
	timestamp: string;
}

/** Payload for `type === 'response_item'` lines. */
export interface ResponseItemPayload {
	/** `'message'` / `'function_call'` / `'function_call_output'` /
	 *  `'custom_tool_call'` / `'custom_tool_call_output'` / `'reasoning'` /
	 *  `'compaction'` / `'compaction_summary'` */
	type: string;
	role?: string;
	name?: string;
	/** apply_patch input — **plain text patch**, NOT JSON. */
	input?: string;
	/** Array of {@link ContentItem} for messages; opaque otherwise. */
	content?: unknown;
	encrypted_content?: string;
}

/** A single content block in a message. */
export interface ContentItem {
	/** `'input_text'` (user) / `'output_text'` (assistant). */
	type: string;
	text: string;
}

/** Payload for `type === 'event_msg'` lines. */
export interface EventMsgPayload {
	/** `'token_count'` is the only one this module consumes. */
	type: string;
	info?: unknown;
}

/** Codex `event_msg.token_count.info` shape. */
export interface TokenCountInfo {
	total_token_usage?: TokenUsageData;
}

/**
 * Codex `total_token_usage` — **cumulative** across the whole session,
 * NOT per-message (this is the key difference from Claude Code).
 */
export interface TokenUsageData {
	input_tokens: number;
	cached_input_tokens: number;
	output_tokens: number;
	reasoning_output_tokens: number;
	total_tokens: number;
}

/**
 * Regex for `*** Add File: <path>` / `*** Update File: <path>` /
 * `*** Delete File: <path>` lines in apply_patch input.
 *
 * **Global flag required** for `String.prototype.matchAll`.
 */
const APPLY_PATCH_FILE_REGEX = /\*\*\* (?:Add|Update|Delete) File: (.+)/g;

/**
 * Count lines in a JSONL transcript file. Returns `0` if path is empty or
 * file is missing (ENOENT). Counts the final line even when it lacks a
 * trailing newline (matches Go `bufio.Reader.ReadBytes` EOF handling).
 *
 * @example
 * await getTranscriptPosition('');                // 0
 * await getTranscriptPosition('/missing/file');   // 0 (ENOENT silent)
 * await getTranscriptPosition('/path/4-line');    // 4
 *
 * // Side effects: read-only fs.readFile.
 */
export async function getTranscriptPosition(transcriptPath: string): Promise<number> {
	if (transcriptPath === '') {
		return 0;
	}
	let data: Buffer;
	try {
		data = await fs.readFile(transcriptPath);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			return 0;
		}
		throw new Error(`failed to open transcript: ${(err as Error).message}`, {
			cause: err as Error,
		});
	}
	if (data.length === 0) {
		return 0;
	}
	let n = 0;
	for (let i = 0; i < data.length; i++) {
		if (data[i] === 0x0a /* '\n' */) {
			n++;
		}
	}
	if (data[data.length - 1] !== 0x0a) {
		n++;
	}
	return n;
}

/**
 * Extract modified file paths from rollout lines after `startOffset` (line
 * number, 1-indexed; `lineNum <= startOffset` lines skipped). Returns
 * `{ files, currentPosition }` where `currentPosition` is the **total**
 * line count (not the offset).
 *
 * @example
 * await extractModifiedFilesFromOffset('/path/4-line.jsonl', 0);
 * // returns: { files: ['src/foo.ts', 'src/bar.ts'], currentPosition: 4 }
 *
 * // Side effects: read-only fs.readFile.
 *
 * @throws Error on any fs.readFile failure (including ENOENT — mirrors Go
 *   `codex.go:119-121` which wraps all `os.Open` errors, unlike
 *   `GetTranscriptPosition` which silences ENOENT).
 */
export async function extractModifiedFilesFromOffset(
	transcriptPath: string,
	startOffset: number,
): Promise<{ files: string[]; currentPosition: number }> {
	if (transcriptPath === '') {
		return { files: [], currentPosition: 0 };
	}
	let data: Buffer;
	try {
		data = await fs.readFile(transcriptPath);
	} catch (err) {
		throw new Error(`failed to open transcript: ${(err as Error).message}`, {
			cause: err as Error,
		});
	}
	const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
	const seen = new Set<string>();
	const files: string[] = [];
	let lineNum = 0;
	let start = 0;
	for (let i = 0; i < bytes.length; i++) {
		if (bytes[i] === 0x0a) {
			lineNum++;
			if (lineNum > startOffset) {
				const lineData = bytes.subarray(start, i);
				if (lineData.length > 0) {
					for (const f of extractFilesFromLine(lineData)) {
						if (!seen.has(f)) {
							seen.add(f);
							files.push(f);
						}
					}
				}
			}
			start = i + 1;
		}
	}
	if (start < bytes.length) {
		lineNum++;
		if (lineNum > startOffset) {
			const lineData = bytes.subarray(start);
			if (lineData.length > 0) {
				for (const f of extractFilesFromLine(lineData)) {
					if (!seen.has(f)) {
						seen.add(f);
						files.push(f);
					}
				}
			}
		}
	}
	return { files, currentPosition: lineNum };
}

/**
 * Extract modified file paths from a single rollout JSONL line. Returns
 * `[]` for invalid JSON / non-`response_item` types / non-apply_patch
 * tools (Go silently swallows all parse errors).
 */
export function extractFilesFromLine(lineData: Uint8Array): string[] {
	const text = new TextDecoder().decode(lineData);
	let line: RolloutLine;
	try {
		line = JSON.parse(text) as RolloutLine;
	} catch {
		return [];
	}
	if (line.type !== ROLLOUT_LINE_TYPE_RESPONSE_ITEM) {
		return [];
	}
	const payload = line.payload as ResponseItemPayload | undefined;
	if (
		!payload ||
		typeof payload !== 'object' ||
		payload.type !== 'custom_tool_call' ||
		payload.name !== 'apply_patch' ||
		typeof payload.input !== 'string'
	) {
		return [];
	}
	return extractFilesFromApplyPatch(payload.input);
}

/**
 * Parse apply_patch input for file paths. Format:
 * `*** Add File: <path>` / `*** Update File: <path>` / `*** Delete File: <path>`.
 * Returns deduplicated list (preserve first-occurrence order).
 *
 * @example
 * extractFilesFromApplyPatch('*** Add File: a.ts\n*** Update File: b.ts\n*** Add File: a.ts');
 * // returns: ['a.ts', 'b.ts']   (dup dropped)
 */
export function extractFilesFromApplyPatch(input: string): string[] {
	const seen = new Set<string>();
	const files: string[] = [];
	for (const match of input.matchAll(APPLY_PATCH_FILE_REGEX)) {
		const filePath = (match[1] ?? '').trim();
		if (filePath !== '' && !seen.has(filePath)) {
			seen.add(filePath);
			files.push(filePath);
		}
	}
	return files;
}

/**
 * Compute token usage delta starting from `fromOffset` (line number,
 * 1-indexed; `lineNum <= fromOffset` lines treated as baseline).
 *
 * Codex reports **cumulative** `total_token_usage` (session-wide totals),
 * so we subtract baseline (last token_count at/before offset) from last
 * (last token_count strictly after offset). Returns `null` when no
 * post-offset usage data found.
 *
 * `OutputTokens = (last.output + last.reasoning_output) -
 *                 (baseline.output + baseline.reasoning_output)`
 * — reasoning is counted toward output (matches Go + OpenAI billing).
 *
 * `apiCallCount` = count of token_count events strictly after offset.
 *
 * Synchronous: pure in-memory scan. Returned via {@link Awaitable} (see
 * {@link TokenCalculator}) so callers always write `await fn(...)` regardless
 * of which agent's implementation they hit.
 *
 * @example
 * calculateTokenUsage(bytes, 2);
 * // returns: { inputTokens: 500, cacheReadTokens: 50, outputTokens: 275,
 * //           cacheCreationTokens: 0, apiCallCount: 2 }
 *
 * // Side effects: pure transformation.
 */
export function calculateTokenUsage(
	transcriptData: Uint8Array,
	fromOffset: number,
): TokenUsage | null {
	let baseline: TokenUsageData | null = null;
	let last: TokenUsageData | null = null;
	let apiCalls = 0;
	let lineNum = 0;
	for (const lineData of splitJSONL(transcriptData)) {
		lineNum++;
		let line: RolloutLine;
		try {
			line = JSON.parse(new TextDecoder().decode(lineData)) as RolloutLine;
		} catch {
			continue;
		}
		if (line.type !== 'event_msg') {
			continue;
		}
		const evt = line.payload as EventMsgPayload | undefined;
		if (!evt || typeof evt !== 'object' || evt.type !== 'token_count' || evt.info === undefined) {
			continue;
		}
		const info = evt.info as TokenCountInfo;
		if (!info || typeof info !== 'object' || !info.total_token_usage) {
			continue;
		}
		if (lineNum <= fromOffset) {
			baseline = info.total_token_usage;
		} else {
			last = info.total_token_usage;
			apiCalls++;
		}
	}
	if (last === null) {
		return null;
	}
	let inputTokens = last.input_tokens;
	let cacheReadTokens = last.cached_input_tokens;
	let outputTokens = last.output_tokens + last.reasoning_output_tokens;
	if (baseline) {
		inputTokens -= baseline.input_tokens;
		cacheReadTokens -= baseline.cached_input_tokens;
		outputTokens -= baseline.output_tokens + baseline.reasoning_output_tokens;
	}
	return {
		inputTokens,
		cacheReadTokens,
		outputTokens,
		cacheCreationTokens: 0,
		apiCallCount: apiCalls,
	};
}

/**
 * Extract user prompts from rollout, starting after `fromOffset` (line
 * number, 1-indexed; `lineNum <= fromOffset` skipped). Returns trimmed
 * non-empty `input_text` content from `role === 'user'` messages.
 *
 * @example
 * await extractPrompts('/path/sample.jsonl', 0);
 * // returns: ['hello world']
 *
 * await extractPrompts('/missing', 0);  // []  (ENOENT silent)
 *
 * // Side effects: read-only fs.readFile.
 */
export async function extractPrompts(sessionRef: string, fromOffset: number): Promise<string[]> {
	let data: Buffer;
	try {
		data = await fs.readFile(sessionRef);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			return [];
		}
		throw new Error(`failed to read transcript: ${(err as Error).message}`, {
			cause: err as Error,
		});
	}
	const prompts: string[] = [];
	let lineNum = 0;
	for (const lineData of splitJSONL(
		new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
	)) {
		lineNum++;
		if (lineNum <= fromOffset) {
			continue;
		}
		let line: RolloutLine;
		try {
			line = JSON.parse(new TextDecoder().decode(lineData)) as RolloutLine;
		} catch {
			continue;
		}
		if (line.type !== ROLLOUT_LINE_TYPE_RESPONSE_ITEM) {
			continue;
		}
		const payload = line.payload as ResponseItemPayload | undefined;
		if (!payload || payload.type !== 'message' || payload.role !== 'user') {
			continue;
		}
		const items = payload.content;
		if (!Array.isArray(items)) {
			continue;
		}
		for (const itemRaw of items as ContentItem[]) {
			if (!itemRaw || typeof itemRaw !== 'object') {
				continue;
			}
			const text = (itemRaw.text ?? '').trim();
			if (text !== '' && itemRaw.type === 'input_text') {
				prompts.push(text);
			}
		}
	}
	return prompts;
}

/**
 * Strip encrypted reasoning fragments + drop `compaction` /
 * `compaction_summary` lines. Used before writing a restored transcript
 * back to disk so `codex resume` doesn't choke on stale `encrypted_content`
 * from a different session context.
 *
 * **Returns input unchanged** when the result would be empty (matches Go
 * `transcript.go:308-310` `if len(sanitized) == 0 { return data }`).
 *
 * @example
 * sanitizePortableTranscript(reasoningBytes);
 * // → bytes with reasoning lines kept but `encrypted_content` field deleted;
 * //   compaction / compaction_summary lines dropped entirely.
 *
 * // Side effects: pure transformation.
 */
export function sanitizePortableTranscript(data: Uint8Array): Uint8Array {
	const lines = splitJSONL(data);
	if (lines.length === 0) {
		return data;
	}
	const sanitized: Uint8Array[] = [];
	for (const lineData of lines) {
		const result = sanitizeRolloutLine(lineData);
		if (!result.keep) {
			continue;
		}
		sanitized.push(result.line);
	}
	if (sanitized.length === 0) {
		return data;
	}
	return reassembleJSONL(sanitized);
}

/**
 * Alias for use in `writeSession` path (Go has both as separate funcs but
 * `sanitizeRestoredTranscript` just calls `SanitizePortableTranscript`).
 */
export function sanitizeRestoredTranscript(data: Uint8Array): Uint8Array {
	return sanitizePortableTranscript(data);
}

/**
 * Per-line sanitization. Returns `{line, keep}`:
 *
 *   - non-JSON / non-response_item / non-compacted → `{lineData, true}` (passthrough)
 *   - response_item.payload.type === 'reasoning' → strip `encrypted_content` field
 *   - response_item.payload.type === 'compaction' / 'compaction_summary' → drop
 *   - type === 'compacted' → recursively sanitize `replacement_history` array
 */
function sanitizeRolloutLine(lineData: Uint8Array): { line: Uint8Array; keep: boolean } {
	let line: RolloutLine;
	try {
		line = JSON.parse(new TextDecoder().decode(lineData)) as RolloutLine;
	} catch {
		return { line: lineData, keep: true };
	}
	if (line.type === 'compacted') {
		return sanitizeCompactedLine(line);
	}
	if (line.type !== ROLLOUT_LINE_TYPE_RESPONSE_ITEM) {
		return { line: lineData, keep: true };
	}
	const payload = line.payload as Record<string, unknown> | undefined;
	if (!payload || typeof payload !== 'object') {
		return { line: lineData, keep: true };
	}
	const itemType = payload.type;
	if (typeof itemType !== 'string') {
		return { line: lineData, keep: true };
	}
	if (itemType === 'reasoning') {
		delete payload.encrypted_content;
		line.payload = payload;
		return { line: encodeLine(line), keep: true };
	}
	if (itemType === 'compaction' || itemType === 'compaction_summary') {
		return { line: new Uint8Array(), keep: false };
	}
	return { line: lineData, keep: true };
}

/**
 * Sanitize a `type === 'compacted'` line: recursively clean
 * `replacement_history` array (which may contain nested reasoning /
 * compaction items). Always keeps the line.
 */
function sanitizeCompactedLine(line: RolloutLine): { line: Uint8Array; keep: boolean } {
	const payload = line.payload as Record<string, unknown> | undefined;
	if (!payload || typeof payload !== 'object') {
		return { line: encodeLine(line), keep: true };
	}
	const replacementHistory = payload.replacement_history;
	if (!Array.isArray(replacementHistory)) {
		return { line: encodeLine(line), keep: true };
	}
	payload.replacement_history = sanitizeHistoryItems(replacementHistory);
	line.payload = payload;
	return { line: encodeLine(line), keep: true };
}

/** Recursively sanitize replacement_history items (same rules as
 *  per-line: reasoning → strip encrypted_content; compaction → drop). */
function sanitizeHistoryItems(items: unknown[]): unknown[] {
	const sanitized: unknown[] = [];
	for (const item of items) {
		if (!item || typeof item !== 'object') {
			sanitized.push(item);
			continue;
		}
		const itemMap = item as Record<string, unknown>;
		const itemType = itemMap.type;
		if (typeof itemType !== 'string') {
			sanitized.push(itemMap);
			continue;
		}
		if (itemType === 'reasoning') {
			delete itemMap.encrypted_content;
			sanitized.push(itemMap);
			continue;
		}
		if (itemType === 'compaction' || itemType === 'compaction_summary') {
			continue;
		}
		sanitized.push(itemMap);
	}
	return sanitized;
}

function encodeLine(line: RolloutLine): Uint8Array {
	return new TextEncoder().encode(JSON.stringify(line));
}

/**
 * Split JSONL bytes by `\n`, drop empty / whitespace-only lines.
 * Mirrors Go `transcript.go: splitJSONL`.
 */
export function splitJSONL(data: Uint8Array): Uint8Array[] {
	const out: Uint8Array[] = [];
	let start = 0;
	for (let i = 0; i < data.length; i++) {
		if (data[i] === 0x0a /* '\n' */) {
			const slice = trimSpaceLine(data.subarray(start, i));
			if (slice.length > 0) {
				out.push(slice);
			}
			start = i + 1;
		}
	}
	if (start < data.length) {
		const slice = trimSpaceLine(data.subarray(start));
		if (slice.length > 0) {
			out.push(slice);
		}
	}
	return out;
}

function trimSpaceLine(b: Uint8Array): Uint8Array {
	let lo = 0;
	let hi = b.length;
	while (lo < hi && isSpace(b[lo] ?? 0)) {
		lo++;
	}
	while (hi > lo && isSpace(b[hi - 1] ?? 0)) {
		hi--;
	}
	return b.subarray(lo, hi);
}

function isSpace(byte: number): boolean {
	return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

/**
 * Parse session start time from the **first** rollout line (must be
 * `type === 'session_meta'` with non-empty RFC3339Nano `timestamp`).
 *
 * @example
 * parseSessionStartTime(bytes);
 * // returns: Date
 *
 * parseSessionStartTime(new Uint8Array());
 * // throws: Error('transcript is empty')
 *
 * parseSessionStartTime(notSessionMetaBytes);
 * // throws: Error('first transcript line is "response_item", want session_meta')
 */
export function parseSessionStartTime(data: Uint8Array): Date {
	const lines = splitJSONL(data);
	if (lines.length === 0) {
		throw new Error('transcript is empty');
	}
	let line: RolloutLine;
	try {
		line = JSON.parse(new TextDecoder().decode(lines[0] ?? new Uint8Array())) as RolloutLine;
	} catch (err) {
		throw new Error(`parse first transcript line: ${(err as Error).message}`, {
			cause: err as Error,
		});
	}
	if (line.type !== 'session_meta') {
		throw new Error(`first transcript line is "${line.type}", want session_meta`);
	}
	const meta = line.payload as SessionMetaPayload | undefined;
	if (!meta || typeof meta !== 'object') {
		throw new Error('parse session_meta payload: payload missing');
	}
	if (!meta.timestamp || meta.timestamp === '') {
		throw new Error('session_meta timestamp is empty');
	}
	const d = new Date(meta.timestamp);
	if (Number.isNaN(d.getTime())) {
		throw new Error(`parse session_meta timestamp "${meta.timestamp}"`);
	}
	return d;
}
