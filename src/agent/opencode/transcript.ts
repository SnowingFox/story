/**
 * OpenCode export-JSON parsing + analysis (TranscriptAnalyzer / TokenCalculator
 * / PromptExtractor capability methods).
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/agent/opencode/transcript.go`.
 *
 * **Structure** (Go-aligned):
 * - {@link parseExportSession} / {@link sliceFromMessage} / {@link extractFilePaths}
 *   are package-level pure helpers (used by transcript + compactor)
 * - {@link getTranscriptPosition} / {@link extractModifiedFilesFromOffset} /
 *   {@link calculateTokenUsage} mirror methods that are bound to OpenCodeAgent
 *   in Go via `func (a *OpenCodeAgent) ...`. In TS they're plain async
 *   functions; the {@link OpenCodeAgent} class delegates through `.call(this, ...)`
 *   when the framework dispatches via {@link TranscriptAnalyzer} /
 *   {@link TokenCalculator}.
 * - {@link extractAllUserPrompts} is the package-level entry used by Phase 5.3
 *   condensation path.
 *
 * **Story-side conventions**:
 * - Empty / null bytes → return `null` (parseExportSession), `0` (positions /
 *   counts), or `[]` (lists). Matches Go fail-safe: degrade to no-op rather
 *   than throw on corrupted transcripts.
 * - Invalid JSON DOES throw — caller decides whether to swallow.
 *
 * @packageDocumentation
 */

import fs from 'node:fs/promises';
import {
	type ExportSession,
	FILE_MODIFICATION_TOOLS,
	type Part,
	ROLE_ASSISTANT,
	ROLE_USER,
	type ToolState,
} from './types';

/**
 * Parse `opencode export` JSON bytes into an {@link ExportSession}.
 *
 * - Empty / nil bytes → `null` (matches Go `ParseExportSession`'s `nil, nil`
 *   shortcut; downstream callers treat null as "no session").
 * - Invalid JSON → throws `'failed to parse export session'`.
 *
 * @example
 * parseExportSession(new TextEncoder().encode('{"info":{"id":"x"},"messages":[]}'));
 * // returns: { info: { id: 'x' }, messages: [] }
 *
 * parseExportSession(new Uint8Array());
 * // returns: null
 *
 * parseExportSession(new TextEncoder().encode('not json'));
 * // throws: 'failed to parse export session'
 */
export function parseExportSession(data: Uint8Array): ExportSession | null {
	if (data.length === 0) {
		return null;
	}
	const text = new TextDecoder('utf-8').decode(data);
	try {
		return JSON.parse(text) as ExportSession;
	} catch (err) {
		throw new Error(`failed to parse export session: ${(err as Error).message}`, {
			cause: err as Error,
		});
	}
}

/**
 * OpenCode-specific equivalent of `transcript.sliceFromLine`. Scopes to
 * `messages[startMessageIndex:]`, marshalling back to a `{info, messages: [...]}`
 * JSON object.
 *
 * - `startMessageIndex <= 0` or empty data → returns input unchanged
 * - `startMessageIndex >= len(messages)` → `null`
 *
 * Mirrors Go `opencode.SliceFromMessage`.
 */
export function sliceFromMessage(data: Uint8Array, startMessageIndex: number): Uint8Array | null {
	if (data.length === 0 || startMessageIndex <= 0) {
		return data;
	}
	const session = parseExportSession(data);
	if (session === null) {
		return null;
	}
	if (startMessageIndex >= session.messages.length) {
		return null;
	}
	const scoped: ExportSession = {
		info: session.info,
		messages: session.messages.slice(startMessageIndex),
	};
	return new TextEncoder().encode(JSON.stringify(scoped));
}

/**
 * Read + parse an export JSON file. Returns `null` for ENOENT (matches Go
 * `parseExportSessionFromFile`'s caller pattern of `os.IsNotExist(err) → 0`).
 *
 * Other I/O errors propagate.
 */
async function parseExportSessionFromFile(p: string): Promise<ExportSession | null> {
	let buf: Buffer;
	try {
		buf = await fs.readFile(p);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			return null;
		}
		throw err;
	}
	return parseExportSession(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
}

/**
 * Number of messages in the transcript. Returns 0 for missing files (Go:
 * `os.IsNotExist(err) → 0, nil`).
 *
 * Mirrors Go `OpenCodeAgent.GetTranscriptPosition`.
 */
export async function getTranscriptPosition(p: string): Promise<number> {
	const session = await parseExportSessionFromFile(p);
	if (session === null) {
		return 0;
	}
	return session.messages.length;
}

/**
 * Files modified by tool calls in `messages[startOffset:]`. Returns
 * `currentPosition = messages.length` (NOT `startOffset` — Story convention
 * matches Go: position is the absolute current end, not the slice base).
 *
 * Returns `{ files: [], currentPosition: 0 }` for missing file (Go fail-safe).
 *
 * **File-extraction rules** (delegated to {@link extractFilePaths}):
 * - Only `assistant` messages count
 * - Only parts with `type === 'tool'` AND `tool ∈ FILE_MODIFICATION_TOOLS`
 * - Per-message: prefer `state.metadata.files[]`; fall back to
 *   `state.input.filePath || state.input.path`
 * - Files de-duplicated across messages (preserving first-seen order)
 *
 * Mirrors Go `OpenCodeAgent.ExtractModifiedFilesFromOffset`.
 */
export async function extractModifiedFilesFromOffset(
	p: string,
	startOffset: number,
): Promise<{ files: string[]; currentPosition: number }> {
	const session = await parseExportSessionFromFile(p);
	if (session === null) {
		return { files: [], currentPosition: 0 };
	}
	const seen = new Set<string>();
	const files: string[] = [];
	for (let i = startOffset; i < session.messages.length; i++) {
		const msg = session.messages[i]!;
		if (msg.info.role !== ROLE_ASSISTANT) {
			continue;
		}
		for (const part of msg.parts) {
			if (part.type !== 'tool' || part.state == null) {
				continue;
			}
			if (typeof part.tool !== 'string' || !FILE_MODIFICATION_TOOLS.includes(part.tool)) {
				continue;
			}
			for (const filePath of extractFilePaths(part.state)) {
				if (!seen.has(filePath)) {
					seen.add(filePath);
					files.push(filePath);
				}
			}
		}
	}
	return { files, currentPosition: session.messages.length };
}

/**
 * Bytes-based variant of {@link extractModifiedFilesFromOffset} starting from
 * offset 0. Used by `OpenCodeAgent.readSession` to populate `modifiedFiles`.
 *
 * Mirrors Go `opencode.ExtractModifiedFiles`.
 */
export function extractModifiedFiles(data: Uint8Array): string[] {
	const session = parseExportSession(data);
	if (session === null) {
		return [];
	}
	const seen = new Set<string>();
	const files: string[] = [];
	for (const msg of session.messages) {
		if (msg.info.role !== ROLE_ASSISTANT) {
			continue;
		}
		for (const part of msg.parts) {
			if (part.type !== 'tool' || part.state == null) {
				continue;
			}
			if (typeof part.tool !== 'string' || !FILE_MODIFICATION_TOOLS.includes(part.tool)) {
				continue;
			}
			for (const filePath of extractFilePaths(part.state)) {
				if (!seen.has(filePath)) {
					seen.add(filePath);
					files.push(filePath);
				}
			}
		}
	}
	return files;
}

/**
 * Extract file paths from an OpenCode tool's {@link ToolState}.
 *
 * Two-path resolution (matches Go `extractFilePaths`):
 * 1. If `state.metadata.files` has entries with non-empty `filePath` → use them
 *    (apply_patch / codex models populate this).
 * 2. Else fall back to `state.input.filePath || state.input.path` (edit / write
 *    tools).
 *
 * Mirrors Go `opencode.extractFilePaths`. Returns `[]` for null state.
 */
export function extractFilePaths(state: ToolState | null): string[] {
	if (state == null) {
		return [];
	}
	if (state.metadata != null && Array.isArray(state.metadata.files)) {
		const paths: string[] = [];
		for (const f of state.metadata.files) {
			if (typeof f.filePath === 'string' && f.filePath !== '') {
				paths.push(f.filePath);
			}
		}
		if (paths.length > 0) {
			return paths;
		}
	}
	const input = state.input ?? {};
	for (const key of ['filePath', 'path']) {
		const v = input[key];
		if (typeof v === 'string' && v !== '') {
			return [v];
		}
	}
	return [];
}

/** Concatenate text content from all `type === 'text'` parts (newline-joined). */
export function extractTextFromParts(parts: Part[]): string {
	const texts: string[] = [];
	for (const p of parts) {
		if (p.type === 'text' && typeof p.text === 'string' && p.text !== '') {
			texts.push(p.text);
		}
	}
	return texts.join('\n');
}

const SYSTEM_REMINDER_OPEN = '<system-reminder>';
const SYSTEM_REMINDER_CLOSE = '</system-reminder>';

/**
 * Whether `content` consists entirely of `<system-reminder>...</system-reminder>`
 * blocks (after trimming whitespace).
 *
 * Delegates to {@link stripSystemReminders} so the multi-block case
 * `'<sr>a</sr>real<sr>b</sr>'` returns `false` correctly (a naive
 * prefix/suffix check would false-positive).
 *
 * Mirrors Go `isSystemReminderOnly`.
 */
export function isSystemReminderOnly(content: string): boolean {
	if (content.trim() === '') {
		return false;
	}
	return stripSystemReminders(content) === '';
}

/**
 * Remove all `<system-reminder>...</system-reminder>` blocks from `content`
 * and return the remaining trimmed text.
 *
 * Mirrors Go `stripSystemReminders`.
 *
 * @example
 * stripSystemReminders('Fix it\n<system-reminder>ctx</system-reminder>');
 * // returns: 'Fix it'
 *
 * stripSystemReminders('<system-reminder>a</system-reminder>X<system-reminder>b</system-reminder>');
 * // returns: 'X'
 */
export function stripSystemReminders(content: string): string {
	let result = content;
	while (true) {
		const start = result.indexOf(SYSTEM_REMINDER_OPEN);
		if (start === -1) {
			break;
		}
		const closeRel = result.slice(start).indexOf(SYSTEM_REMINDER_CLOSE);
		if (closeRel === -1) {
			break;
		}
		const end = start + closeRel + SYSTEM_REMINDER_CLOSE.length;
		result = result.slice(0, start) + result.slice(end);
	}
	return result.trim();
}

/**
 * Extract all user-authored prompt texts from an export JSON transcript.
 *
 * - Skips messages whose content is entirely `<system-reminder>` blocks
 *   (oh-my-opencode injected context, NOT real user input).
 * - For mixed messages, strips system-reminder blocks then trims.
 * - Empty / null bytes → `[]` (no prompts).
 * - Invalid JSON → throws (parseExportSession propagates).
 *
 * Mirrors Go `opencode.ExtractAllUserPrompts`. Used by Phase 5.3
 * condensation path via `strategy/transcript-prompts.ts: extractUserPrompts`.
 */
export function extractAllUserPrompts(data: Uint8Array): string[] {
	const session = parseExportSession(data);
	if (session === null) {
		return [];
	}
	const prompts: string[] = [];
	for (const msg of session.messages) {
		if (msg.info.role !== ROLE_USER) {
			continue;
		}
		const content = extractTextFromParts(msg.parts);
		if (content === '') {
			continue;
		}
		if (isSystemReminderOnly(content)) {
			continue;
		}
		const stripped = stripSystemReminders(content);
		if (stripped !== '') {
			prompts.push(stripped);
		}
	}
	return prompts;
}

/**
 * Aggregate token usage from `assistant` messages with non-null `tokens` in
 * `messages[fromOffset:]`.
 *
 * - `apiCallCount` = number of contributing assistant messages
 * - All token counters sum across messages
 * - Empty bytes → `null` (matches Go nil-on-empty)
 * - Invalid JSON → throws `'failed to parse transcript for token usage'`
 *
 * Mirrors Go `OpenCodeAgent.CalculateTokenUsage`. The `this` binding is
 * not used (function is independent of OpenCodeAgent state) but the
 * `.call(this, ...)` shape lets {@link OpenCodeAgent} expose this as a
 * `TokenCalculator` capability method without a thunk wrapper.
 */
export function calculateTokenUsage(
	transcriptData: Uint8Array,
	fromOffset: number,
): {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
	apiCallCount: number;
} | null {
	let session: ExportSession | null;
	try {
		session = parseExportSession(transcriptData);
	} catch (err) {
		throw new Error(`failed to parse transcript for token usage: ${(err as Error).message}`, {
			cause: err as Error,
		});
	}
	if (session === null) {
		return null;
	}
	const usage = {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheCreationTokens: 0,
		apiCallCount: 0,
	};
	for (let i = fromOffset; i < session.messages.length; i++) {
		const msg = session.messages[i]!;
		if (msg.info.role !== ROLE_ASSISTANT || msg.info.tokens == null) {
			continue;
		}
		usage.inputTokens += msg.info.tokens.input;
		usage.outputTokens += msg.info.tokens.output;
		usage.cacheReadTokens += msg.info.tokens.cache.read;
		usage.cacheCreationTokens += msg.info.tokens.cache.write;
		usage.apiCallCount += 1;
	}
	return usage;
}
