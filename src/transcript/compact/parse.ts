/**
 * Reverse-direction reader for the compact `transcript.jsonl` format.
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/transcript/compact/parse.go` (the
 * `parseLines` / `BuildCondensedEntries` / `extractToolDetail` functions plus
 * the `CondensedEntry` shape). Used by Phase 9.x explain commands; not on the
 * Phase 5.3 condense write-path.
 *
 * @packageDocumentation
 */

import type { CompactTranscriptLine } from './types';

/**
 * One condensed entry derived from a compact transcript line. `tool` entries
 * carry `toolName` + `toolDetail`; `user` / `assistant` entries carry
 * `content` only.
 */
export interface CondensedEntry {
	type: 'user' | 'assistant' | 'tool';
	content: string;
	toolName?: string;
	toolDetail?: string;
}

const decoder = new TextDecoder();

/**
 * Parse a compact `transcript.jsonl` payload into typed lines.
 *
 * Each non-empty line must be a JSON object with `v != 0` and a non-empty
 * `cli_version`; otherwise the entire parse fails with `'not compact
 * transcript format'`. Empty / whitespace-only payloads return `[]`.
 *
 * @example
 *   parseLines(new TextEncoder().encode(`{"v":1,"agent":"claude-code","cli_version":"0.5.1","type":"user","content":[{"text":"hi"}]}\n`));
 *   // [{ v: 1, agent: 'claude-code', cli_version: '0.5.1', type: 'user', content: [{ text: 'hi' }] }]
 *   //
 *   // Side effects: none (pure parsing)
 */
export function parseLines(content: Uint8Array): CompactTranscriptLine[] {
	const trimmed = decoder.decode(content).trim();
	if (trimmed === '') {
		return [];
	}

	const rawLines = trimmed.split('\n');
	const parsed: CompactTranscriptLine[] = [];

	for (const rawLine of rawLines) {
		const lineText = rawLine.trim();
		if (lineText === '') {
			continue;
		}

		let line: CompactTranscriptLine;
		try {
			line = JSON.parse(lineText) as CompactTranscriptLine;
		} catch (err) {
			throw new Error(`parsing compact transcript line: ${(err as Error).message}`);
		}

		if (!line.v || line.v === 0 || !line.cli_version) {
			throw new Error('not compact transcript format');
		}

		parsed.push(line);
	}

	return parsed;
}

/**
 * Build a flat list of condensed entries from a compact transcript payload.
 *
 * - `user` lines: join all non-empty `text` blocks with `'\n'` into one
 *   `{ type: 'user', content }` entry. Lines with no text blocks contribute
 *   nothing.
 * - `assistant` lines: each `text` block becomes its own
 *   `{ type: 'assistant', content }` entry; each `tool_use` block becomes a
 *   `{ type: 'tool', toolName, toolDetail }` entry where `toolDetail` is
 *   resolved via {@link extractToolDetail}.
 *
 * Lines whose `content` fails to decode as a block array are silently skipped
 * (mirrors Go best-effort behaviour). Throws `'no parseable compact transcript
 * entries'` when the resulting list is empty.
 */
export function buildCondensedEntries(content: Uint8Array): CondensedEntry[] {
	const lines = parseLines(content);
	const entries: CondensedEntry[] = [];

	for (const line of lines) {
		const blocks = parseContentBlocks(line.content);
		if (blocks === null) {
			continue;
		}

		switch (line.type) {
			case 'user': {
				const parts: string[] = [];
				for (const block of blocks) {
					const text = block.text;
					if (typeof text === 'string' && text !== '') {
						parts.push(text);
					}
				}
				if (parts.length > 0) {
					entries.push({ type: 'user', content: parts.join('\n') });
				}
				break;
			}
			case 'assistant': {
				for (const block of blocks) {
					const blockType = block.type;
					if (typeof blockType !== 'string') {
						continue;
					}

					if (blockType === 'text') {
						const text = block.text;
						if (typeof text === 'string' && text !== '') {
							entries.push({ type: 'assistant', content: text });
						}
					} else if (blockType === 'tool_use') {
						const toolName = block.name;
						if (typeof toolName !== 'string') {
							continue;
						}
						let input: Record<string, unknown> = {};
						const rawInput = block.input;
						if (rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)) {
							input = rawInput as Record<string, unknown>;
						}
						entries.push({
							type: 'tool',
							content: '',
							toolName,
							toolDetail: extractToolDetail(input),
						});
					}
				}
				break;
			}
		}
	}

	if (entries.length === 0) {
		throw new Error('no parseable compact transcript entries');
	}

	return entries;
}

/**
 * Resolve the most-informative single-line description of a tool_use block's
 * `input` object. Scan order: `description → command → file_path → filePath →
 * path → pattern`. Returns the first non-empty string match; `''` when none.
 */
export function extractToolDetail(input: Record<string, unknown>): string {
	const keys = ['description', 'command', 'file_path', 'filePath', 'path', 'pattern'];
	for (const key of keys) {
		const v = input[key];
		if (typeof v === 'string' && v !== '') {
			return v;
		}
	}
	return '';
}

/**
 * Decode a transcript line's `content` field into a list of block objects.
 *
 * Returns `null` when the field is absent / empty / not an array, signalling
 * the caller to skip the line (mirrors Go's silent-skip on `json.Unmarshal`
 * error).
 */
function parseContentBlocks(content: unknown): Array<Record<string, unknown>> | null {
	if (content === undefined || content === null) {
		return null;
	}
	if (!Array.isArray(content)) {
		return null;
	}
	return content as Array<Record<string, unknown>>;
}
