/**
 * OpenCode transcript compactor — converts OpenCode's single-JSON-object
 * export format into the compact `transcript.jsonl` format.
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/transcript/compact/opencode.go`.
 *
 * OpenCode transcripts are NOT JSONL — they are a single JSON object:
 *   `{"info":{...},"messages":[{info:{role,time,...},parts:[...]}, ...]}`
 *
 * Parts use `type` values: `"text"`, `"tool"`, `"step-start"`, `"step-finish"`.
 * Tool parts store the tool name in `"tool"` (string) and call details in
 * `"state"`.
 *
 * @packageDocumentation
 */

import { stripIDEContextTags } from '../../textutil';
import type { CompactMetadataFields } from './types';

const TYPE_USER = 'user';
const TYPE_ASSISTANT = 'assistant';
const CONTENT_TYPE_TEXT = 'text';
const CONTENT_TYPE_TOOL_USE = 'tool_use';
const TOOL_RESULT_STATUS_ERROR = 'error';

interface OpenCodeMessage {
	info: OpenCodeMessageInfo;
	parts: Array<Record<string, unknown>>;
}

interface OpenCodeMessageInfo {
	id: string;
	role: string;
	time: { created: number; completed?: number };
	tokens?: { input: number; output: number };
}

interface TranscriptLine {
	v: number;
	agent: string;
	cli_version: string;
	type?: string;
	ts?: unknown;
	id?: string;
	input_tokens?: number;
	output_tokens?: number;
	content?: unknown;
}

interface UserTextBlock {
	id?: string;
	text: string;
}

interface ToolResultJSON {
	output: string;
	status: string;
}

/**
 * Detect whether `content` is an OpenCode single-JSON-object transcript
 * (top-level `info` + `messages` keys).
 *
 * Mirrors Go `isOpenCodeFormat`.
 */
export function isOpenCodeFormat(content: Uint8Array): boolean {
	const trimmed = new TextDecoder().decode(content).trim();
	if (trimmed.length === 0 || trimmed[0] !== '{') {
		return false;
	}
	let probe: { info?: unknown; messages?: unknown };
	try {
		probe = JSON.parse(trimmed) as { info?: unknown; messages?: unknown };
	} catch {
		return false;
	}
	return probe.info != null && probe.messages != null;
}

/**
 * Convert an OpenCode session JSON into compact transcript lines.
 *
 * `opts.startLine` is treated as a message-index offset (not a newline offset)
 * because the OpenCode transcript is a single JSON object.
 *
 * Mirrors Go `compactOpenCode`.
 *
 * @example
 * compactOpenCode(sessionBytes, { agent: 'opencode', cliVersion: '0.1.0', startLine: 0 });
 * // → Uint8Array of compact transcript lines, or null on parse failure / empty
 * //
 * // Side effects: none (pure transformation)
 */
export function compactOpenCode(
	content: Uint8Array,
	opts: CompactMetadataFields,
): Uint8Array | null {
	const trimmed = new TextDecoder().decode(content).trim();
	let session: { messages: OpenCodeMessage[] };
	try {
		session = JSON.parse(trimmed) as { messages: OpenCodeMessage[] };
	} catch {
		return null;
	}

	let messages = session.messages;
	if (!Array.isArray(messages)) {
		return null;
	}

	if (opts.startLine > 0) {
		if (opts.startLine >= messages.length) {
			return new Uint8Array();
		}
		messages = messages.slice(opts.startLine);
	}

	const base: TranscriptLine = {
		v: 1,
		agent: opts.agent,
		cli_version: opts.cliVersion,
	};

	const out: string[] = [];

	for (const msg of messages) {
		const ts = msToTimestamp(msg.info?.time?.created ?? 0);

		if (msg.info?.role === TYPE_USER) {
			emitOpenCodeUser(out, base, msg, ts);
		} else if (msg.info?.role === TYPE_ASSISTANT) {
			emitOpenCodeAssistant(out, base, msg, ts);
		}
	}

	const result = new TextEncoder().encode(out.join(''));
	return result.length === 0 ? null : result;
}

function emitOpenCodeUser(
	out: string[],
	base: TranscriptLine,
	msg: OpenCodeMessage,
	ts: string | null,
): void {
	const blocks: unknown[] = [];

	for (const part of msg.parts ?? []) {
		if (unquote(part.type) !== CONTENT_TYPE_TEXT) {
			continue;
		}
		const text = stripIDEContextTags(unquote(part.text));
		if (text === '') {
			continue;
		}
		const tb: UserTextBlock = { text };
		if (part.id != null && typeof part.id === 'string') {
			tb.id = part.id;
		}
		blocks.push(tb);
	}

	const line: Record<string, unknown> = {
		v: base.v,
		agent: base.agent,
		cli_version: base.cli_version,
		type: TYPE_USER,
	};
	if (ts !== null) {
		line.ts = ts;
	}
	line.content = blocks;
	appendLine(out, line);
}

function emitOpenCodeAssistant(
	out: string[],
	base: TranscriptLine,
	msg: OpenCodeMessage,
	ts: string | null,
): void {
	const content: Record<string, unknown>[] = [];

	for (const part of msg.parts ?? []) {
		const partType = unquote(part.type);

		if (partType === CONTENT_TYPE_TEXT) {
			content.push({
				type: CONTENT_TYPE_TEXT,
				text: part.text,
			});
		} else if (partType === 'tool') {
			const toolBlock: Record<string, unknown> = {
				type: CONTENT_TYPE_TOOL_USE,
			};
			if (part.callID != null) {
				toolBlock.id = part.callID;
			}
			if (part.tool != null) {
				toolBlock.name = part.tool;
			}
			if (part.state != null && typeof part.state === 'object') {
				const state = part.state as Record<string, unknown>;
				if (state.input != null) {
					toolBlock.input = state.input;
				}
				toolBlock.result = openCodeToolResult(state);
			}
			content.push(toolBlock);
		}
	}

	const line: Record<string, unknown> = {
		v: base.v,
		agent: base.agent,
		cli_version: base.cli_version,
		type: TYPE_ASSISTANT,
	};
	if (ts !== null) {
		line.ts = ts;
	}
	if (msg.info?.id) {
		line.id = msg.info.id;
	}
	if (msg.info?.tokens) {
		if (msg.info.tokens.input > 0) {
			line.input_tokens = msg.info.tokens.input;
		}
		if (msg.info.tokens.output > 0) {
			line.output_tokens = msg.info.tokens.output;
		}
	}
	line.content = content;
	appendLine(out, line);
}

/**
 * Build the compact `{output, status}` from an OpenCode tool state map.
 *
 * Mirrors Go `openCodeToolResult`.
 */
function openCodeToolResult(state: Record<string, unknown>): ToolResultJSON {
	const r: ToolResultJSON = {
		output: unquote(state.output),
		status: 'success',
	};
	const s = unquote(state.status);
	if (s !== '' && s !== 'completed') {
		r.status = TOOL_RESULT_STATUS_ERROR;
	}
	return r;
}

/**
 * Convert a Unix millisecond timestamp to an RFC3339 JSON string, or `null`
 * when `ms === 0`.
 *
 * Mirrors Go `msToTimestamp`.
 *
 * ### Format divergence vs Go (deliberate, documented)
 *
 * Go emits with `time.RFC3339Nano` (via `t.UTC().Format(time.RFC3339Nano)`),
 * which **strips trailing zeros** from the fractional-second field and drops
 * the decimal point entirely for whole-second timestamps:
 *
 * | Input (ms)          | Go (`RFC3339Nano`)              | TS (`toISOString()`)            |
 * | ------------------- | ------------------------------- | ------------------------------- |
 * | `1704163205000`     | `"2024-01-02T03:20:05Z"`        | `"2024-01-02T03:20:05.000Z"`    |
 * | `1704163205500`     | `"2024-01-02T03:20:05.5Z"`      | `"2024-01-02T03:20:05.500Z"`    |
 * | `1704163205123`     | `"2024-01-02T03:20:05.123Z"`    | `"2024-01-02T03:20:05.123Z"`    |
 *
 * We intentionally keep `toISOString()` (fixed 3-digit millisecond form)
 * because:
 *   1. The Node/Bun stdlib has no zero-trimming variant — reproducing Go's
 *      exact byte sequence would require custom formatting.
 *   2. Both representations are valid RFC3339 and parse to identical `Date`
 *      instances in every JSON consumer (including the Go reader).
 *   3. The compact transcript is consumed, not byte-diffed, across the
 *      Go→TS cutover — consumers normalize timestamps before comparison.
 *
 * If a future audit requires byte-identical parity with Go, replace this with
 * a custom formatter that trims trailing `0` from the fractional second and
 * drops the decimal point when the fraction is empty.
 */
function msToTimestamp(ms: number): string | null {
	if (ms === 0) {
		return null;
	}
	return new Date(ms).toISOString();
}

function appendLine(out: string[], line: Record<string, unknown>): void {
	try {
		out.push(JSON.stringify(line));
		out.push('\n');
	} catch {
		// best-effort, matches Go silent skip on marshal error
	}
}

function unquote(raw: unknown): string {
	return typeof raw === 'string' ? raw : '';
}
