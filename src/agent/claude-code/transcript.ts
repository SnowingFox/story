/**
 * Claude Code transcript analytics — JSONL serialization, modified-files
 * extraction, token usage statistics, spawned-subagent tracking, and
 * cross-subagent file/token aggregation.
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/agent/claudecode/transcript.go`
 * (`SerializeTranscript` / `ExtractModifiedFiles` / `TruncateAtUUID` /
 * `FindCheckpointUUID` / `CalculateTokenUsage` / `CalculateTokenUsageFromFile` /
 * `ExtractSpawnedAgentIDs` / `extractAgentIDFromText` /
 * `(*ClaudeCodeAgent).CalculateTotalTokenUsage` /
 * `(*ClaudeCodeAgent).ExtractAllModifiedFiles`).
 *
 * **No write side effects** — only fs reads when explicitly given a
 * `subagentsDir`. All other functions are pure.
 *
 * **`serializeTranscript` byte-precision caveat**: TS re-encodes each
 * parsed line via `JSON.stringify`, while Go writes `transcript.Line.Message`
 * (`json.RawMessage`) verbatim. For canonical Claude transcripts (compact
 * JSON, no extraneous whitespace) the output is byte-identical. A
 * hand-edited transcript with non-canonical whitespace / escape choices
 * round-trips by VALUE but not byte-for-byte. Downstream consumers parse
 * the result by `parseFromBytes` and only observe values, so the divergence
 * is invisible at the application layer.
 *
 * @packageDocumentation
 */

import path from 'node:path';
import {
	parseFromBytes,
	parseFromFileAtLine,
	sliceFromLine,
	type TranscriptLine,
} from '@/transcript';
import { FILE_MODIFICATION_TOOLS, type MessageUsage, type TokenUsage } from './types';

/** Re-export so `./index.ts` and tests use a consistent type alias. */
export type { TranscriptLine };

/**
 * Convert transcript lines back to JSONL bytes. One line per entry, each
 * terminated with `\n` (matches Go `bytes.Buffer.WriteByte('\n')`).
 *
 * @example
 * serializeTranscript([
 *   { type: 'user', uuid: 'u1', message: { content: 'hi' } },
 *   { type: 'assistant', uuid: 'a1', message: { content: 'hello' } },
 * ]);
 * // returns: Uint8Array of '{"type":"user","uuid":"u1","message":{"content":"hi"}}\n{"type":"assistant","uuid":"a1","message":{"content":"hello"}}\n'
 *
 * // Side effects: none — pure.
 *
 * @throws Error if any line fails to JSON.stringify (e.g. circular ref).
 */
export function serializeTranscript(lines: TranscriptLine[]): Uint8Array {
	const enc = new TextEncoder();
	const parts: Uint8Array[] = [];
	for (const line of lines) {
		let text: string;
		try {
			text = JSON.stringify(line);
		} catch (err) {
			throw new Error(`failed to marshal line: ${(err as Error).message}`, {
				cause: err as Error,
			});
		}
		parts.push(enc.encode(`${text}\n`));
	}
	let total = 0;
	for (const p of parts) {
		total += p.length;
	}
	const out = new Uint8Array(total);
	let off = 0;
	for (const p of parts) {
		out.set(p, off);
		off += p.length;
	}
	return out;
}

/**
 * Read `message.content[]` blocks. Tolerates both shapes:
 * - `message: { content: [...] }` (already parsed object)
 * - `message: '<json>'` (string — JSON-encoded; reparse)
 *
 * Returns `null` when content is missing or unparseable.
 */
function readMessageContent(line: TranscriptLine): unknown[] | null {
	const raw = (line as { message?: unknown }).message;
	if (raw === undefined || raw === null) {
		return null;
	}
	let msg: unknown;
	if (typeof raw === 'string') {
		try {
			msg = JSON.parse(raw);
		} catch {
			return null;
		}
	} else if (typeof raw === 'object') {
		msg = raw;
	} else {
		return null;
	}
	const content = (msg as { content?: unknown }).content;
	return Array.isArray(content) ? content : null;
}

/**
 * Extract files modified by `tool_use` blocks in assistant messages.
 *
 * Considers only `line.type === 'assistant'`. For each `tool_use` block whose
 * `name` is in {@link FILE_MODIFICATION_TOOLS}, extracts `input.file_path`
 * (fallback `input.notebook_path`). Deduplicates with insertion-order
 * preservation (first-seen wins) — matches Go `fileSet` map + `files` slice
 * pattern.
 *
 * Skips silently: non-assistant lines, malformed message JSON, non-modification
 * tools, blocks with empty file path.
 *
 * @example
 * extractModifiedFiles([
 *   { type: 'assistant', uuid: 'a1', message: { content: [
 *     { type: 'tool_use', name: 'Write', input: { file_path: 'src/a.ts' } },
 *   ]}},
 *   { type: 'assistant', uuid: 'a2', message: { content: [
 *     { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },  // ignored
 *   ]}},
 * ]);
 * // returns: ['src/a.ts']
 *
 * // Side effects: none — pure.
 */
export function extractModifiedFiles(lines: TranscriptLine[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const line of lines) {
		if (line.type !== 'assistant') {
			continue;
		}
		const content = readMessageContent(line);
		if (content === null) {
			continue;
		}
		for (const block of content) {
			if (
				typeof block !== 'object' ||
				block === null ||
				(block as { type?: unknown }).type !== 'tool_use'
			) {
				continue;
			}
			const name = (block as { name?: unknown }).name;
			if (typeof name !== 'string' || !FILE_MODIFICATION_TOOLS.includes(name)) {
				continue;
			}
			const input = (block as { input?: unknown }).input;
			let file = '';
			if (typeof input === 'object' && input !== null) {
				const fp = (input as { file_path?: unknown }).file_path;
				const np = (input as { notebook_path?: unknown }).notebook_path;
				if (typeof fp === 'string' && fp !== '') {
					file = fp;
				} else if (typeof np === 'string' && np !== '') {
					file = np;
				}
			}
			if (file !== '' && !seen.has(file)) {
				seen.add(file);
				out.push(file);
			}
		}
	}
	return out;
}

/**
 * Return lines up to and including the line with the given UUID. Empty UUID
 * returns lines unchanged (Go: pointer return same slice). UUID not found
 * returns the full slice (Go: slice exhausts the for-loop without match).
 *
 * @example
 * truncateAtUUID([{type:'user', uuid:'u1'}, {type:'assistant', uuid:'a1'}], 'u1');
 * // returns: [{type:'user', uuid:'u1'}]
 *
 * truncateAtUUID([...], '');
 * // returns: original slice (no copy)
 *
 * truncateAtUUID([{uuid:'a'}], 'missing');
 * // returns: original slice (full transcript)
 */
export function truncateAtUUID(lines: TranscriptLine[], uuid: string): TranscriptLine[] {
	if (uuid === '') {
		return lines;
	}
	for (let i = 0; i < lines.length; i++) {
		if ((lines[i] as { uuid?: string }).uuid === uuid) {
			return lines.slice(0, i + 1);
		}
	}
	return lines;
}

/**
 * Find the UUID of the user-message line containing a `tool_result` block
 * whose `tool_use_id` matches `toolUseId`. Returns `null` if no match
 * (Go returns `('', false)` — `null` is the TS analog).
 *
 * @example
 * findCheckpointUUID([
 *   { type: 'user', uuid: 'u1', message: { content: [
 *     { type: 'tool_result', tool_use_id: 'tool1' },
 *   ]}},
 * ], 'tool1');
 * // returns: 'u1'
 *
 * findCheckpointUUID(lines, 'unknown');
 * // returns: null
 */
export function findCheckpointUUID(lines: TranscriptLine[], toolUseId: string): string | null {
	for (const line of lines) {
		if (line.type !== 'user') {
			continue;
		}
		const content = readMessageContent(line);
		if (content === null) {
			continue;
		}
		for (const block of content) {
			if (typeof block !== 'object' || block === null) {
				continue;
			}
			const b = block as { type?: unknown; tool_use_id?: unknown };
			if (b.type === 'tool_result' && b.tool_use_id === toolUseId) {
				const uuid = (line as { uuid?: unknown }).uuid;
				if (typeof uuid === 'string') {
					return uuid;
				}
			}
		}
	}
	return null;
}

/**
 * Compute token usage from a Claude transcript (assistant lines only).
 *
 * **Streaming dedup**: same `message.id` may appear multiple times during
 * streaming (each chunk emits one assistant line); we keep the row with
 * **max** `output_tokens` per id (final streaming state). Sums `input_tokens` /
 * `cache_creation_input_tokens` / `cache_read_input_tokens` / `output_tokens`
 * across unique ids; `apiCallCount` = number of unique ids.
 *
 * Empty transcript → all-zero usage (`apiCallCount: 0`), non-null.
 *
 * @example
 * calculateTokenUsage([
 *   { type: 'assistant', uuid: 'a1', message: { id: 'msg_1', usage: {
 *     input_tokens: 10, output_tokens: 5,
 *     cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
 *   { type: 'assistant', uuid: 'a2', message: { id: 'msg_1', usage: {
 *     input_tokens: 10, output_tokens: 20,
 *     cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
 *   // ↑ same id, output_tokens grew → keep this one (max)
 * ]);
 * // returns: { inputTokens: 10, ..., outputTokens: 20, apiCallCount: 1 }
 */
export function calculateTokenUsage(lines: TranscriptLine[]): TokenUsage {
	const usageById = new Map<string, MessageUsage>();
	for (const line of lines) {
		if (line.type !== 'assistant') {
			continue;
		}
		const raw = (line as { message?: unknown }).message;
		let msg: { id?: unknown; usage?: unknown };
		if (raw === undefined || raw === null) {
			continue;
		}
		if (typeof raw === 'string') {
			try {
				msg = JSON.parse(raw) as typeof msg;
			} catch {
				continue;
			}
		} else if (typeof raw === 'object') {
			msg = raw as typeof msg;
		} else {
			continue;
		}
		const id = msg.id;
		if (typeof id !== 'string' || id === '') {
			continue;
		}
		const usage = msg.usage;
		if (typeof usage !== 'object' || usage === null) {
			continue;
		}
		const u = usage as Partial<MessageUsage>;
		const cur: MessageUsage = {
			input_tokens: typeof u.input_tokens === 'number' ? u.input_tokens : 0,
			cache_creation_input_tokens:
				typeof u.cache_creation_input_tokens === 'number' ? u.cache_creation_input_tokens : 0,
			cache_read_input_tokens:
				typeof u.cache_read_input_tokens === 'number' ? u.cache_read_input_tokens : 0,
			output_tokens: typeof u.output_tokens === 'number' ? u.output_tokens : 0,
		};
		const existing = usageById.get(id);
		if (existing === undefined || cur.output_tokens > existing.output_tokens) {
			usageById.set(id, cur);
		}
	}
	let inputTokens = 0;
	let cacheCreationTokens = 0;
	let cacheReadTokens = 0;
	let outputTokens = 0;
	for (const u of usageById.values()) {
		inputTokens += u.input_tokens;
		cacheCreationTokens += u.cache_creation_input_tokens;
		cacheReadTokens += u.cache_read_input_tokens;
		outputTokens += u.output_tokens;
	}
	return {
		inputTokens,
		cacheCreationTokens,
		cacheReadTokens,
		outputTokens,
		apiCallCount: usageById.size,
	};
}

/**
 * Compute token usage from a transcript file. Empty `path` returns zero usage
 * (no error — matches Go `if path == "" { return &agent.TokenUsage{}, nil }`).
 * Other read errors propagate from `parseFromFileAtLine`.
 *
 * @example
 * await calculateTokenUsageFromFile('/path/transcript.jsonl', 0);
 * // → { inputTokens: ..., apiCallCount: ..., ... }
 *
 * await calculateTokenUsageFromFile('', 0);
 * // → { inputTokens: 0, apiCallCount: 0, ... }   (empty path = zero usage)
 *
 * // Side effects: fs.readFile only.
 */
export async function calculateTokenUsageFromFile(
	p: string,
	startLine: number,
): Promise<TokenUsage> {
	if (p === '') {
		return zeroUsage();
	}
	const lines = await parseFromFileAtLine(p, startLine);
	return calculateTokenUsage(lines);
}

/** Read content as either array of `{type:'text', text:string}` joined with `\n`,
 *  or a plain string. Returns `''` for any other shape. Mirrors Go's two-attempt
 *  unmarshal pattern in `ExtractSpawnedAgentIDs`. */
function readToolResultText(content: unknown): string {
	if (Array.isArray(content)) {
		let out = '';
		for (const tb of content) {
			if (typeof tb === 'object' && tb !== null) {
				const blk = tb as { type?: unknown; text?: unknown };
				if (blk.type === 'text' && typeof blk.text === 'string') {
					out += `${blk.text}\n`;
				}
			}
		}
		return out;
	}
	if (typeof content === 'string') {
		return content;
	}
	return '';
}

/**
 * Extract spawned subagent IDs from `tool_result` blocks in user messages.
 *
 * Returns `Map<agentId, toolUseId>`. Searches the tool_result `content`
 * (string OR array of `{type:'text', text}` joined with `\n`) for
 * `agentId: <id>` where `<id>` is contiguous `[A-Za-z0-9]+` (no `_`, no `-`,
 * matching Go `extractAgentIDFromText`).
 *
 * Last write wins on duplicate agentIds across multiple results (matches Go
 * `agentIDs[id] = block.ToolUseID` map assignment).
 *
 * @example
 * extractSpawnedAgentIds([
 *   { type: 'user', uuid: 'u1', message: { content: [
 *     { type: 'tool_result', tool_use_id: 'toolu_abc',
 *       content: [{ type: 'text', text: 'agentId: ac66d4b' }] },
 *   ]}},
 * ]);
 * // returns: Map { 'ac66d4b' => 'toolu_abc' }
 */
export function extractSpawnedAgentIds(lines: TranscriptLine[]): Map<string, string> {
	const out = new Map<string, string>();
	for (const line of lines) {
		if (line.type !== 'user') {
			continue;
		}
		const content = readMessageContent(line);
		if (content === null) {
			continue;
		}
		for (const block of content) {
			if (typeof block !== 'object' || block === null) {
				continue;
			}
			const b = block as { type?: unknown; tool_use_id?: unknown; content?: unknown };
			if (b.type !== 'tool_result') {
				continue;
			}
			const text = readToolResultText(b.content);
			const agentId = extractAgentIdFromText(text);
			if (agentId !== '' && typeof b.tool_use_id === 'string') {
				out.set(agentId, b.tool_use_id);
			}
		}
	}
	return out;
}

const AGENT_ID_PREFIX = 'agentId: ';

/**
 * Extract an agent ID from text containing `agentId: <id>`. Reads contiguous
 * `[A-Za-z0-9]+` after the prefix. Returns `''` if no prefix or empty id.
 *
 * **Strict ASCII**: matches Go `text[end] >= 'a' && text[end] <= 'z' || ...`
 * — `_` and `-` are NOT alphanumeric and break the run.
 *
 * @example
 * extractAgentIdFromText('agentId: ac66d4b (for resuming)');  // 'ac66d4b'
 * extractAgentIdFromText('Result text\n\nagentId: abc1234');  // 'abc1234'
 * extractAgentIdFromText('agentId: xyz9999\nMore text');      // 'xyz9999'
 * extractAgentIdFromText('No prefix here');                    // ''
 * extractAgentIdFromText('');                                  // ''
 * extractAgentIdFromText('agentId: ');                         // ''   (empty after prefix)
 */
export function extractAgentIdFromText(text: string): string {
	const idx = text.indexOf(AGENT_ID_PREFIX);
	if (idx === -1) {
		return '';
	}
	const start = idx + AGENT_ID_PREFIX.length;
	let end = start;
	while (end < text.length) {
		const c = text.charCodeAt(end);
		const isAlphaNum =
			(c >= 0x30 && c <= 0x39) /* 0-9 */ ||
			(c >= 0x41 && c <= 0x5a) /* A-Z */ ||
			(c >= 0x61 && c <= 0x7a) /* a-z */;
		if (!isAlphaNum) {
			break;
		}
		end++;
	}
	return end > start ? text.slice(start, end) : '';
}

/** Decode a `Uint8Array` to a UTF-8 string (single allocation). */
function decodeUtf8(data: Uint8Array): string {
	return new TextDecoder('utf-8').decode(data);
}

function zeroUsage(): TokenUsage {
	return {
		inputTokens: 0,
		cacheCreationTokens: 0,
		cacheReadTokens: 0,
		outputTokens: 0,
		apiCallCount: 0,
	};
}

/**
 * Compute token usage for a turn including subagents.
 *
 * Empty `data` → zero usage (no parse). Slices `data` from `startLine`
 * (line-based, 0-indexed), parses JSONL, computes main usage. Then for each
 * spawned agent ID, reads `<subagentsDir>/agent-<agentId>.jsonl` and merges
 * into `subagentTokens` field.
 *
 * Skips subagent enumeration entirely if `subagentsDir === ''` (avoids
 * reading from cwd — Go: `if len(agentIDs) > 0 && subagentsDir != ""`).
 * Subagent file errors are swallowed (transcript may not exist yet or have
 * been cleaned up).
 *
 * @example
 * await calculateTotalTokenUsage(transcriptBytes, 0, '/tmp/tasks/abc/');
 * // → {
 * //   inputTokens: 12000, ..., apiCallCount: 8,
 * //   subagentTokens: { inputTokens: 3000, ..., apiCallCount: 2 }   ← only when ≥1 subagent had tokens
 * // }
 *
 * await calculateTotalTokenUsage(new Uint8Array(), 0, '');
 * // → { inputTokens: 0, ..., apiCallCount: 0 }   (no parse, no fs read)
 *
 * // Side effects: fs.readFile on each `<subagentsDir>/agent-<id>.jsonl` (read-only).
 */
export async function calculateTotalTokenUsage(
	data: Uint8Array,
	startLine: number,
	subagentsDir: string,
): Promise<TokenUsage> {
	if (data.length === 0) {
		return zeroUsage();
	}
	const text = decodeUtf8(data);
	const sliced = sliceFromLine(text, startLine) ?? '';
	const parsed = parseFromBytes(sliced);
	const mainUsage = calculateTokenUsage(parsed);
	const agentIds = extractSpawnedAgentIds(parsed);
	if (agentIds.size > 0 && subagentsDir !== '') {
		const sub: TokenUsage = zeroUsage();
		for (const agentId of agentIds.keys()) {
			const agentPath = path.join(subagentsDir, `agent-${agentId}.jsonl`);
			try {
				const u = await calculateTokenUsageFromFile(agentPath, 0);
				sub.inputTokens += u.inputTokens;
				sub.cacheCreationTokens += u.cacheCreationTokens;
				sub.cacheReadTokens += u.cacheReadTokens;
				sub.outputTokens += u.outputTokens;
				sub.apiCallCount += u.apiCallCount;
			} catch {
				// Subagent transcript may not exist yet or have been cleaned up.
			}
		}
		if (sub.apiCallCount > 0) {
			mainUsage.subagentTokens = sub;
		}
	}
	return mainUsage;
}

/**
 * Extract files modified by main agent + all spawned subagents.
 *
 * Empty `data` → `[]`. Slices from `startLine`, parses JSONL, collects main
 * agent files; if `subagentsDir !== ''`, reads each `agent-<id>.jsonl` and
 * merges into the result, **deduplicated** with insertion order preserved.
 *
 * @example
 * await extractAllModifiedFiles(mainTranscriptBytes, 0, '/tmp/tasks/abc/');
 * // returns: ['main.go', 'helper.go', 'utils.go']  (main first, then subagent)
 *
 * await extractAllModifiedFiles(mainTranscriptBytes, 0, '');
 * // returns: ['main.go']  (subagent dir skipped)
 *
 * // Side effects: fs.readFile on each subagent transcript (read-only).
 */
export async function extractAllModifiedFiles(
	data: Uint8Array,
	startLine: number,
	subagentsDir: string,
): Promise<string[]> {
	if (data.length === 0) {
		return [];
	}
	const text = decodeUtf8(data);
	const sliced = sliceFromLine(text, startLine) ?? '';
	const parsed = parseFromBytes(sliced);
	const seen = new Set<string>();
	const out: string[] = [];
	for (const f of extractModifiedFiles(parsed)) {
		if (!seen.has(f)) {
			seen.add(f);
			out.push(f);
		}
	}
	if (subagentsDir === '') {
		return out;
	}
	const agentIds = extractSpawnedAgentIds(parsed);
	for (const agentId of agentIds.keys()) {
		const agentPath = path.join(subagentsDir, `agent-${agentId}.jsonl`);
		let agentLines: TranscriptLine[];
		try {
			agentLines = await parseFromFileAtLine(agentPath, 0);
		} catch {
			continue;
		}
		for (const f of extractModifiedFiles(agentLines)) {
			if (!seen.has(f)) {
				seen.add(f);
				out.push(f);
			}
		}
	}
	return out;
}
