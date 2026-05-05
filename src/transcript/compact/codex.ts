/**
 * Codex compactor: convert Codex JSONL rollout into compact transcript.jsonl.
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/transcript/compact/codex.go`.
 *
 * **Algorithm** (3 dispatch case + token accumulator):
 *
 *   Pass 1: parseCodexLines — keep only `response_item` + `event_msg(token_count)` lines.
 *   Pass 2: walk linearly, tracking pendingInTok / pendingOutTok across events.
 *
 *   For each non-token line:
 *     - `message[role=user]`     → emit user line (drops system content, joins text blocks)
 *     - `message[role=assistant]` → collect any subsequent function_call /
 *                                   custom_tool_call (with output) into a single
 *                                   assistant line carrying text + tool_use blocks
 *     - standalone `function_call` / `custom_tool_call` (no preceding assistant) →
 *                                   emit standalone assistant line with single
 *                                   tool_use block
 *
 * **Codex-specific concerns**:
 * - System content (AGENTS.md, environment_context, permissions, ...) dropped from user text
 * - apply_patch custom tool input is **plain text patch**, NOT JSON args
 * - custom_tool_call_output is `{type: text, text: ...}` object — use `codexCustomOutputText`
 *   double fallback (string vs object)
 *
 * **Field key order — alphabetical** (matches Go `map[string]json.RawMessage`
 * serialization). Each emit function builds blocks by inserting keys in
 * alphabetical order; `JSON.stringify` preserves insertion order in V8.
 *
 * **Helper Go arm order** (`compact/codex.go:84-167` `compactCodex` switch):
 *
 *   1. `isCodexTokenCountLine(cl)`                        → update pendingInTok/Out + continue
 *   2. `p.type === 'message' && p.role === 'user'`        → emit user line if non-empty
 *   3. `p.type === 'message' && p.role === 'assistant'`   → collect tool calls + emit assistant
 *   4. `p.type === function_call | custom_tool_call`      → standalone tool_use line
 *
 * `opts.startLine > 0` triggers `sliceFromLine` BEFORE format-specific parsing
 * (matches Go: must preserve session_meta header for `parseSessionStartTime`
 * elsewhere; for compactor specifically we drop session_meta after slice).
 *
 * @packageDocumentation
 */

import { stripIDEContextTags } from '../../textutil';
import { sliceFromLine } from '../../transcript';
import type { CompactMetadataFields } from './types';

const TYPE_USER = 'user';
const TYPE_ASSISTANT = 'assistant';
const CONTENT_TYPE_TEXT = 'text';
const CONTENT_TYPE_TOOL_USE = 'tool_use';

const TRANSCRIPT_TYPE_MESSAGE = 'message';
const CODEX_TYPE_RESPONSE_ITEM = 'response_item';
const CODEX_TYPE_FUNCTION_CALL = 'function_call';
const CODEX_TYPE_FUNCTION_CALL_OUTPUT = 'function_call_output';
const CODEX_TYPE_CUSTOM_TOOL_CALL = 'custom_tool_call';
const CODEX_TYPE_CUSTOM_TOOL_CALL_OUTPUT = 'custom_tool_call_output';

const TOOL_RESULT_STATUS_SUCCESS = 'success';

/**
 * Detect Codex JSONL format by inspecting the first valid (parseable) JSON
 * line's `type` field. Skips invalid JSON lines until one parses (matches Go
 * `bufio.Scanner.Scan` + `json.Unmarshal err continue`).
 *
 * Returns `true` for `session_meta` / `response_item` / `event_msg` /
 * `turn_context` (Codex's 4 line types); `false` otherwise.
 *
 * @example
 * isCodexFormat(codexBytes);   // true
 * isCodexFormat(claudeBytes);  // false
 * isCodexFormat(emptyBytes);   // false
 *
 * // Side effects: pure inspection.
 */
export function isCodexFormat(content: Uint8Array): boolean {
	for (const line of iterateLines(content)) {
		let probe: { type?: unknown };
		try {
			probe = JSON.parse(new TextDecoder().decode(line)) as { type?: unknown };
		} catch {
			continue;
		}
		const t = probe.type;
		if (
			t === 'session_meta' ||
			t === CODEX_TYPE_RESPONSE_ITEM ||
			t === 'event_msg' ||
			t === 'turn_context'
		) {
			return true;
		}
		return false;
	}
	return false;
}

interface CodexLine {
	timestamp?: string;
	type: string;
	payload: unknown;
}

interface CodexPayload {
	type?: string;
	role?: string;
	content?: unknown;
	phase?: string;
	name?: string;
	arguments?: string;
	input?: string;
	call_id?: string;
	output?: unknown;
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/**
 * Convert a Codex JSONL transcript into the compact format. `opts.startLine`
 * is treated as a **raw newline offset**: applied via {@link sliceFromLine}
 * BEFORE format-specific parsing (matches Go: Codex's session_meta header
 * is line 1; downstream `parseSessionStartTime` reads the original bytes).
 *
 * Returns empty `Uint8Array` when slice empties the content or when no
 * lines emit.
 *
 * **Go arm map** (`compact/codex.go:63-160 compactCodex`):
 *
 * | line.type | Go action | TS equivalent |
 * | --- | --- | --- |
 * | `session_meta` | passthrough | passthrough |
 * | `response_item` (message) | emit user/assistant text | {@link codexUserPrompt} / {@link codexAssistantReply} |
 * | `response_item` (function_call/custom_tool_call) | emit tool call | {@link codexToolOutput} |
 * | `event_msg` (token_count) | emit raw | passthrough |
 * | `event_msg` (other) / `turn_context` / `compacted` | drop | drop |
 * | unknown type | passthrough | passthrough |
 *
 * JSON key order is alphabetical to match Go `map[string]json.RawMessage`.
 *
 * @example
 * compactCodex(codexFullBytes, { agent: 'codex', cliVersion: '0.5.1', startLine: 0 });
 * // returns: Uint8Array of compact JSONL output (byte-equal to Go fixture).
 *
 * // Side effects: pure transformation.
 */
export function compactCodex(content: Uint8Array, opts: CompactMetadataFields): Uint8Array {
	let bytes: Uint8Array = content;
	if (opts.startLine > 0) {
		const text = decoder.decode(content);
		const sliced = sliceFromLine(text, opts.startLine);
		if (sliced === null || sliced === '') {
			return new Uint8Array();
		}
		bytes = encoder.encode(sliced);
	}
	const lines = parseCodexLines(bytes);

	const out: string[] = [];
	let pendingInTok = 0;
	let pendingOutTok = 0;

	const refIdx = { i: 0 };
	for (refIdx.i = 0; refIdx.i < lines.length; refIdx.i++) {
		const cl = lines[refIdx.i] as CodexLine;
		if (isCodexTokenCountLine(cl)) {
			const counts = codexTokenCount(cl.payload);
			pendingInTok = counts.input;
			pendingOutTok = counts.output;
			continue;
		}
		const p = (cl.payload ?? {}) as CodexPayload;
		const ts = cl.timestamp;

		if (p.type === TRANSCRIPT_TYPE_MESSAGE && p.role === 'user') {
			const text = codexUserText(p.content);
			if (text === '') {
				continue;
			}
			emitUser(out, opts, ts, text);
			continue;
		}
		if (p.type === TRANSCRIPT_TYPE_MESSAGE && p.role === 'assistant') {
			const text = codexAssistantText(p.content);
			if (text === '') {
				continue;
			}
			const toolBlocks: Record<string, unknown>[] = [];
			let inTok = pendingInTok;
			let outTok = pendingOutTok;
			pendingInTok = 0;
			pendingOutTok = 0;
			while (refIdx.i + 1 < lines.length) {
				const next = lines[refIdx.i + 1] as CodexLine;
				if (isCodexTokenCountLine(next)) {
					const c = codexTokenCount(next.payload);
					inTok = c.input;
					outTok = c.output;
					refIdx.i++;
					continue;
				}
				const np = (next.payload ?? {}) as CodexPayload;
				if (np.type === CODEX_TYPE_FUNCTION_CALL || np.type === CODEX_TYPE_CUSTOM_TOOL_CALL) {
					refIdx.i++;
					const cur: { input: number; output: number } = { input: inTok, output: outTok };
					const tb = codexConsumeToolCall(np, lines, refIdx, cur);
					inTok = cur.input;
					outTok = cur.output;
					if (tb) {
						toolBlocks.push(tb);
					}
					continue;
				}
				if (
					np.type === CODEX_TYPE_FUNCTION_CALL_OUTPUT ||
					np.type === CODEX_TYPE_CUSTOM_TOOL_CALL_OUTPUT
				) {
					// Orphan output without preceding call — skip.
					refIdx.i++;
					continue;
				}
				break;
			}
			emitAssistant(out, opts, ts, inTok, outTok, codexBuildContent(text, toolBlocks));
			continue;
		}
		if (p.type === CODEX_TYPE_FUNCTION_CALL || p.type === CODEX_TYPE_CUSTOM_TOOL_CALL) {
			let inTok = pendingInTok;
			let outTok = pendingOutTok;
			pendingInTok = 0;
			pendingOutTok = 0;
			const cur: { input: number; output: number } = { input: inTok, output: outTok };
			const tb = codexConsumeToolCall(p, lines, refIdx, cur);
			inTok = cur.input;
			outTok = cur.output;
			while (
				refIdx.i + 1 < lines.length &&
				isCodexTokenCountLine(lines[refIdx.i + 1] as CodexLine)
			) {
				const c = codexTokenCount((lines[refIdx.i + 1] as CodexLine).payload);
				inTok = c.input;
				outTok = c.output;
				refIdx.i++;
			}
			if (tb) {
				emitAssistant(out, opts, ts, inTok, outTok, [tb]);
			}
		}
	}
	return encoder.encode(out.join(''));
}

/** Emit a user line. Field order matches Go struct: v / agent / cli_version /
 *  type / ts / content. Inner content block: `{text}` (single key). */
function emitUser(
	out: string[],
	opts: CompactMetadataFields,
	ts: string | undefined,
	text: string,
): void {
	const line: Record<string, unknown> = {
		v: 1,
		agent: opts.agent,
		cli_version: opts.cliVersion,
		type: TYPE_USER,
	};
	if (ts !== undefined) {
		line.ts = ts;
	}
	line.content = [{ text }];
	out.push(JSON.stringify(line));
	out.push('\n');
}

/** Emit an assistant line. Field order matches Go struct: v / agent /
 *  cli_version / type / ts / [input_tokens] / [output_tokens] / content. */
function emitAssistant(
	out: string[],
	opts: CompactMetadataFields,
	ts: string | undefined,
	inputTokens: number,
	outputTokens: number,
	content: Array<Record<string, unknown>>,
): void {
	const line: Record<string, unknown> = {
		v: 1,
		agent: opts.agent,
		cli_version: opts.cliVersion,
		type: TYPE_ASSISTANT,
	};
	if (ts !== undefined) {
		line.ts = ts;
	}
	if (inputTokens > 0) {
		line.input_tokens = inputTokens;
	}
	if (outputTokens > 0) {
		line.output_tokens = outputTokens;
	}
	line.content = content;
	out.push(JSON.stringify(line));
	out.push('\n');
}

function parseCodexLines(content: Uint8Array): CodexLine[] {
	const lines: CodexLine[] = [];
	for (const lineData of iterateLines(content)) {
		let cl: CodexLine;
		try {
			cl = JSON.parse(decoder.decode(lineData)) as CodexLine;
		} catch {
			continue;
		}
		if (cl.type === CODEX_TYPE_RESPONSE_ITEM || isCodexTokenCountLine(cl)) {
			lines.push(cl);
		}
	}
	return lines;
}

function isCodexTokenCountLine(cl: CodexLine | undefined): boolean {
	if (!cl || cl.type !== 'event_msg') {
		return false;
	}
	const p = (cl.payload ?? {}) as { type?: string };
	return p.type === 'token_count';
}

function codexTokenCount(payload: unknown): { input: number; output: number } {
	const tc = (payload ?? {}) as { input_tokens?: number; output_tokens?: number };
	return { input: tc.input_tokens ?? 0, output: tc.output_tokens ?? 0 };
}

/**
 * Extract the actual user prompt text from a Codex user message, dropping
 * system-injected content (AGENTS.md, environment_context, permissions,
 * turn_aborted, etc.) and stripping IDE context tags.
 */
function codexUserText(raw: unknown): string {
	if (!Array.isArray(raw)) {
		return '';
	}
	const texts: string[] = [];
	for (const blockRaw of raw as Array<{ type?: string; text?: string }>) {
		if (!blockRaw || typeof blockRaw !== 'object' || blockRaw.type !== 'input_text') {
			continue;
		}
		const text = blockRaw.text ?? '';
		if (isCodexSystemContent(text)) {
			continue;
		}
		const stripped = stripIDEContextTags(text);
		if (stripped !== '') {
			texts.push(stripped);
		}
	}
	return texts.join('\n\n');
}

/**
 * True when `text` starts with one of the 6 system-injected prefixes Codex
 * adds to user/developer messages (Go `compact/codex.go: isCodexSystemContent`).
 */
function isCodexSystemContent(text: string): boolean {
	const prefixes = [
		'<permissions',
		'<collaboration_mode>',
		'<skills_instructions>',
		'<environment_context>',
		'<turn_aborted>',
		'# AGENTS.md',
	];
	for (const p of prefixes) {
		if (text.length >= p.length && text.slice(0, p.length) === p) {
			return true;
		}
	}
	return false;
}

function codexAssistantText(raw: unknown): string {
	if (!Array.isArray(raw)) {
		return '';
	}
	const texts: string[] = [];
	for (const blockRaw of raw as Array<{ type?: string; text?: string }>) {
		if (
			blockRaw &&
			typeof blockRaw === 'object' &&
			blockRaw.type === 'output_text' &&
			blockRaw.text &&
			blockRaw.text !== ''
		) {
			texts.push(blockRaw.text);
		}
	}
	return texts.join('\n\n');
}

/**
 * Build a tool_use block from a `function_call` payload. **Field key order
 * is alphabetical** (id / input / name / type) to match Go
 * `map[string]json.RawMessage` serialization byte-for-byte.
 *
 * `input` is parsed from the `arguments` JSON string (Go: `json.RawMessage`
 * passes through; V8 `JSON.parse` preserves source key order).
 */
function codexToolUseBlock(p: CodexPayload): Record<string, unknown> {
	const block: Record<string, unknown> = {};
	const callId = p.call_id ?? '';
	if (callId !== '') {
		block.id = callId;
	}
	if (p.arguments) {
		try {
			block.input = JSON.parse(p.arguments) as unknown;
		} catch {
			// silent skip — Go same behavior (json.Unmarshal failure leaves block.input unset)
		}
	}
	block.name = p.name ?? '';
	// `result` (if present) is set later by codexConsumeToolCall, in alphabetical
	// position between `name` and `type` — we explicitly leave it for the caller
	// to inject before `type`.
	block.type = CONTENT_TYPE_TOOL_USE;
	return block;
}

/**
 * Build a tool_use block from a `custom_tool_call` payload (e.g. apply_patch).
 * Unlike `function_call`, the `input` field is **plain text** wrapped in
 * `{input: <text>}` object (NOT parsed JSON args).
 *
 * **Alphabetical field order**: id / input / name / type.
 */
function codexCustomToolUseBlock(p: CodexPayload): Record<string, unknown> {
	const block: Record<string, unknown> = {};
	const callId = p.call_id ?? '';
	if (callId !== '') {
		block.id = callId;
	}
	if (p.input && p.input !== '') {
		block.input = { input: p.input };
	}
	block.name = p.name ?? '';
	block.type = CONTENT_TYPE_TOOL_USE;
	return block;
}

function codexCallIDAndType(payload: unknown): { callID: string; typ: string } {
	const p = (payload ?? {}) as { type?: string; call_id?: string };
	return { callID: p.call_id ?? '', typ: p.type ?? '' };
}

function codexToolOutputText(payload: unknown, outputType: string): string {
	if (outputType === CODEX_TYPE_CUSTOM_TOOL_CALL_OUTPUT) {
		return codexCustomOutputText(payload);
	}
	const p = (payload ?? {}) as { output?: unknown };
	return typeof p.output === 'string' ? p.output : '';
}

/**
 * Extract output text from a `custom_tool_call_output` payload. Output may be:
 *   - plain string (forward-compat fallback)
 *   - `{type: 'text', text: '...'}` object (default Codex format)
 *
 * Returns `''` for any other shape.
 */
function codexCustomOutputText(payload: unknown): string {
	const p = (payload ?? {}) as { output?: unknown };
	if (p.output === undefined || p.output === null) {
		return '';
	}
	if (typeof p.output === 'string') {
		return p.output;
	}
	if (typeof p.output === 'object') {
		const obj = p.output as { text?: string };
		return typeof obj.text === 'string' ? obj.text : '';
	}
	return '';
}

/**
 * Consume a tool call line + any trailing token_count + matching output line.
 * Mutates `refIdx.i` to advance past consumed lines and `cur` to update token
 * counters. Returns the tool_use block (with `result` injected before `type`
 * to maintain alphabetical key order) or `null` if `p.type` is not a tool call.
 */
function codexConsumeToolCall(
	p: CodexPayload,
	lines: CodexLine[],
	refIdx: { i: number },
	cur: { input: number; output: number },
): Record<string, unknown> | null {
	let tb: Record<string, unknown>;
	let outputType: string;
	if (p.type === CODEX_TYPE_FUNCTION_CALL) {
		tb = codexToolUseBlock(p);
		outputType = CODEX_TYPE_FUNCTION_CALL_OUTPUT;
	} else if (p.type === CODEX_TYPE_CUSTOM_TOOL_CALL) {
		tb = codexCustomToolUseBlock(p);
		outputType = CODEX_TYPE_CUSTOM_TOOL_CALL_OUTPUT;
	} else {
		return null;
	}

	while (refIdx.i + 1 < lines.length && isCodexTokenCountLine(lines[refIdx.i + 1] as CodexLine)) {
		const c = codexTokenCount((lines[refIdx.i + 1] as CodexLine).payload);
		cur.input = c.input;
		cur.output = c.output;
		refIdx.i++;
	}

	if (refIdx.i + 1 < lines.length) {
		const next = lines[refIdx.i + 1] as CodexLine;
		const { callID, typ } = codexCallIDAndType(next.payload);
		if (typ === outputType && callID === (p.call_id ?? '')) {
			const output = codexToolOutputText(next.payload, outputType);
			// Re-build tb so `result` lands BEFORE `type` (alphabetical)
			const rebuild: Record<string, unknown> = {};
			if ('id' in tb) {
				rebuild.id = tb.id;
			}
			if ('input' in tb) {
				rebuild.input = tb.input;
			}
			rebuild.name = tb.name;
			rebuild.result = { output, status: TOOL_RESULT_STATUS_SUCCESS };
			rebuild.type = tb.type;
			tb = rebuild;
			refIdx.i++;
		}
	}
	return tb;
}

/**
 * Build the compact content array from assistant text + optional tool_use
 * blocks. Text block (alphabetical: text / type) comes first when text
 * non-empty; tool blocks appended in encounter order.
 */
function codexBuildContent(
	text: string,
	toolBlocks: Record<string, unknown>[],
): Array<Record<string, unknown>> {
	const content: Array<Record<string, unknown>> = [];
	if (text !== '') {
		// alphabetical: text / type
		content.push({ text, type: CONTENT_TYPE_TEXT });
	}
	for (const tb of toolBlocks) {
		content.push(tb);
	}
	return content;
}

/** Iterate JSONL lines, dropping empty / whitespace-only lines. */
function* iterateLines(content: Uint8Array): Generator<Uint8Array> {
	let start = 0;
	for (let i = 0; i < content.length; i++) {
		if (content[i] === 0x0a /* '\n' */) {
			const slice = trimSpaceLine(content.subarray(start, i));
			if (slice.length > 0) {
				yield slice;
			}
			start = i + 1;
		}
	}
	if (start < content.length) {
		const slice = trimSpaceLine(content.subarray(start));
		if (slice.length > 0) {
			yield slice;
		}
	}
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
