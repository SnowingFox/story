/**
 * Cursor agent — TranscriptAnalyzer + PromptExtractor implementation +
 * `extractSummary` helper.
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/agent/cursor/transcript.go`
 * (`GetTranscriptPosition` / `ExtractPrompts` / `ExtractSummary` /
 * `ExtractModifiedFilesFromOffset`).
 *
 * Four concerns:
 * 1. Line counting (`getTranscriptPosition`) — byte-level newline scan;
 *    tolerates arbitrarily long lines + missing trailing newline.
 * 2. Prompt extraction (`extractPrompts`) — JSONL parse from line offset,
 *    `role:'user'` filter; `extractUserContent` already strips
 *    `<user_query>` / `<ide_*>` tags via {@link stripIDEContextTags}.
 * 3. Summary extraction (`extractSummary`) — reverse scan to find last
 *    assistant text block.
 * 4. Modified-files extraction — always returns `{ files: [], currentPosition: 0 }`
 *    (Cursor JSONL has no `tool_use` blocks; file detection lives in git
 *    status + hook payload `modified_files`).
 *
 * @packageDocumentation
 */

import fs from 'node:fs/promises';
import { extractUserContent, parseFromBytes, parseFromFileAtLine } from '@/transcript';

/**
 * Line count of a JSONL transcript file. Lightweight byte-level scan, no
 * JSON.parse. Lines without a trailing newline still count.
 *
 * **Asymmetric with {@link extractModifiedFilesFromOffset}**: missing file
 * here → `0` (success), there → `{ files: [], currentPosition: 0 }` (also
 * success — Cursor never extracts files anyway).
 *
 * @example
 * await getTranscriptPosition('');                  // 0
 * await getTranscriptPosition('/missing/file');     // 0 (silent ENOENT)
 * await getTranscriptPosition('/path/4-line.jsonl'); // 4
 *
 * // Side effects: read-only fs.readFile.
 */
export async function getTranscriptPosition(p: string): Promise<number> {
	if (p === '') {
		return 0;
	}
	let data: Buffer;
	try {
		data = await fs.readFile(p);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === 'ENOENT') {
			return 0;
		}
		throw new Error(`failed to open transcript file: ${(err as Error).message}`, {
			cause: err as Error,
		});
	}
	if (data.length === 0) {
		return 0;
	}
	let n = 0;
	for (let i = 0; i < data.length; i++) {
		if (data[i] === 0x0a /* \n */) {
			n++;
		}
	}
	if (data[data.length - 1] !== 0x0a) {
		n++;
	}
	return n;
}

/**
 * Extract user prompts from the transcript starting at `fromOffset` (line
 * number, 0-indexed). Cursor uses JSONL with `role:'user'` (normalized to
 * `type:'user'` by {@link import('@/transcript').parseFromBytes}); user
 * content is wrapped in `<user_query>` tags which {@link extractUserContent}
 * → {@link import('@/textutil').stripIDEContextTags} already removes.
 *
 * @example
 * await extractPrompts('/path/sample.jsonl', 0);
 * // returns: ['hello', "add 'one' to a file and commit"]
 *
 * await extractPrompts('/path/sample.jsonl', 2);
 * // returns: ["add 'one' to a file and commit"]   (skip first 2 lines)
 *
 * await extractPrompts('/path/empty.jsonl', 0);
 * // returns: []
 *
 * // Side effects: read-only fs.readFile (via parseFromFileAtLine).
 */
export async function extractPrompts(sessionRef: string, fromOffset: number): Promise<string[]> {
	let lines: import('@/transcript').TranscriptLine[];
	try {
		lines = await parseFromFileAtLine(sessionRef, fromOffset);
	} catch (err) {
		throw new Error(`failed to parse transcript: ${(err as Error).message}`, {
			cause: err as Error,
		});
	}
	const prompts: string[] = [];
	for (const line of lines) {
		if (line.type !== 'user') {
			continue;
		}
		const message = (line as { message?: unknown }).message;
		if (typeof message !== 'object' || message === null) {
			continue;
		}
		const content = extractUserContent(message as Record<string, unknown>);
		if (content !== '') {
			prompts.push(content);
		}
	}
	return prompts;
}

/**
 * Last assistant message text — used as a session summary.
 *
 * Walks the transcript backwards looking for the most recent `type:'assistant'`
 * line; for each, takes the first `content` block of `type:'text'` with
 * non-empty `text`. Returns `''` when none found (matches Go: `transcript.go`
 * returns `("", nil)` rather than an error).
 *
 * @example
 * await extractSummary('/path/sample.jsonl');
 * // returns: 'Created one.txt with one and committed.'   (last assistant text)
 *
 * await extractSummary('/path/empty.jsonl');               // ''
 * await extractSummary('/path/only-user.jsonl');           // ''
 *
 * // Side effects: read-only fs.readFile.
 */
export async function extractSummary(sessionRef: string): Promise<string> {
	let data: Buffer;
	try {
		data = await fs.readFile(sessionRef);
	} catch (err) {
		throw new Error(`failed to read transcript: ${(err as Error).message}`, {
			cause: err as Error,
		});
	}
	let lines: import('@/transcript').TranscriptLine[];
	try {
		lines = parseFromBytes(data.toString('utf-8'));
	} catch (err) {
		throw new Error(`failed to parse transcript: ${(err as Error).message}`, {
			cause: err as Error,
		});
	}
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i];
		if (!line || line.type !== 'assistant') {
			continue;
		}
		const message = (line as { message?: unknown }).message;
		if (typeof message !== 'object' || message === null) {
			continue;
		}
		const content = (message as { content?: unknown }).content;
		if (!Array.isArray(content)) {
			continue;
		}
		for (const block of content) {
			if (typeof block !== 'object' || block === null) {
				continue;
			}
			const t = (block as { type?: unknown }).type;
			const text = (block as { text?: unknown }).text;
			if (t === 'text' && typeof text === 'string' && text !== '') {
				return text;
			}
		}
	}
	return '';
}

/**
 * Cursor transcripts contain no `tool_use` blocks, so file detection from
 * the transcript is impossible. Always returns `{ files: [], currentPosition: 0 }`
 * (matches Go `transcript.go: ExtractModifiedFilesFromOffset → return nil, 0, nil`).
 *
 * Callers (e.g. `strategy/hooks-content-detection.ts`) fall through to git
 * status + hook payload `modified_files` for the actual file list.
 */
export async function extractModifiedFilesFromOffset(
	_p: string,
	_startOffset: number,
): Promise<{ files: string[]; currentPosition: number }> {
	return { files: [], currentPosition: 0 };
}
