import fs from 'node:fs/promises';
import { stripIDEContextTags } from './textutil';

export interface TranscriptLine {
	type?: string;
	role?: string;
	[key: string]: unknown;
}

/** Normalize Cursor's `role` field into `type` so downstream code can use `type` uniformly. */
function normalizeLineType(line: TranscriptLine): void {
	if (!line.type && line.role) {
		line.type = line.role;
	}
}

/** Parse JSONL content into transcript lines. Malformed lines are silently skipped. */
export function parseFromBytes(data: string): TranscriptLine[] {
	if (!data) {
		return [];
	}

	const lines: TranscriptLine[] = [];
	for (const rawLine of data.split('\n')) {
		const trimmed = rawLine.trim();
		if (!trimmed) {
			continue;
		}
		try {
			const parsed = JSON.parse(trimmed) as TranscriptLine;
			normalizeLineType(parsed);
			lines.push(parsed);
		} catch {
			// skip malformed lines
		}
	}
	return lines;
}

/**
 * Parse a JSONL file starting from a specific line (0-indexed).
 *
 * Raw lines (including malformed ones) count toward the line offset,
 * matching Go's `ParseFromFileAtLine` behavior.
 */
export async function parseFromFileAtLine(
	filePath: string,
	startLine: number,
): Promise<TranscriptLine[]> {
	const content = await fs.readFile(filePath, 'utf-8');
	const rawLines = content.split('\n');
	const lines: TranscriptLine[] = [];

	for (let i = 0; i < rawLines.length; i++) {
		if (i < startLine) {
			continue;
		}
		const trimmed = rawLines[i]!.trim();
		if (!trimmed) {
			continue;
		}
		try {
			const parsed = JSON.parse(trimmed) as TranscriptLine;
			normalizeLineType(parsed);
			lines.push(parsed);
		} catch {
			// skip malformed lines
		}
	}
	return lines;
}

/**
 * Return content starting from the `startLine`-th line (0-indexed).
 *
 * Finds the N-th newline and returns everything after it.
 * Returns `null` if `startLine` exceeds the number of lines.
 */
export function sliceFromLine(data: string, startLine: number): string | null {
	if (startLine <= 0) {
		return data;
	}
	if (!data) {
		return data;
	}

	let lineCount = 0;
	for (let i = 0; i < data.length; i++) {
		if (data[i] === '\n') {
			lineCount++;
			if (lineCount === startLine) {
				const rest = data.slice(i + 1);
				if (rest.length === 0) {
					return null;
				}
				return rest;
			}
		}
	}

	return null;
}

/**
 * Split JSONL content into chunks at line boundaries, each at most `maxSize`
 * UTF-8 bytes (NOT JS string length / UTF-16 code units).
 *
 * Throws if any single line exceeds `maxSize`.
 *
 * Go reference: `entire-cli/cmd/entire/cli/agent/chunking.go: ChunkJSONL` — uses
 * `len(string)` which is UTF-8 byte length. JS `.length` is UTF-16 code units;
 * for non-ASCII content the two diverge (e.g. one Chinese char = 1 unit but 3
 * bytes; one emoji = 2 units but 4 bytes). Using `.length` would let chunks
 * silently exceed git blob limits + produce different chunk boundaries than Go.
 */
export function chunkTranscript(data: string, maxSize: number): string[] {
	if (!data) {
		return [];
	}

	const lines = data.split('\n');
	const chunks: string[] = [];
	let current = '';
	let currentByteLen = 0;
	const newlineByteLen = 1; // '\n' in UTF-8 is always 1 byte

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const lineByteLen = Buffer.byteLength(line, 'utf8');
		const lineWithNewlineByteLen = lineByteLen + newlineByteLen;

		if (lineWithNewlineByteLen > maxSize) {
			throw new Error(
				`JSONL line ${i + 1} exceeds maximum chunk size (${lineWithNewlineByteLen} bytes > ${maxSize} bytes)`,
			);
		}

		if (currentByteLen + lineWithNewlineByteLen > maxSize && currentByteLen > 0) {
			chunks.push(current.replace(/\n$/, ''));
			current = '';
			currentByteLen = 0;
		}
		current += `${line}\n`;
		currentByteLen += lineWithNewlineByteLen;
	}

	if (currentByteLen > 0) {
		chunks.push(current.replace(/\n$/, ''));
	}

	return chunks;
}

/**
 * Reassemble JSONL chunks back into a single string. Returns `null` for empty
 * input — matches Go `ReassembleJSONL` contract via `agent.ReassembleTranscript`'s
 * `(nil, nil)` shortcut. Callers that want an empty string can do
 * `reassembleTranscript(chunks) ?? ''`.
 *
 * Phase 6.1: agent-aware dispatch lives in `@/agent/chunking.reassembleTranscript`;
 * **this remains the JSONL fallback** used internally by that module when the
 * agent isn't registered or the format is JSONL. The `_agentType` parameter is
 * accepted for API symmetry but ignored — agent dispatch happens in the
 * `@/agent/chunking` wrapper.
 *
 * Go reference: `entire-cli/.../agent/chunking.go: ReassembleJSONL`.
 */
export function reassembleTranscript(chunks: string[], _agentType?: string): string | null {
	if (chunks.length === 0) {
		return null;
	}
	return chunks.join('\n');
}

/** Extract user-facing text content from a transcript message, stripping IDE context tags. */
export function extractUserContent(message: Record<string, unknown>): string {
	const content = message.content;
	if (content === undefined || content === null) {
		return '';
	}

	if (typeof content === 'string') {
		return stripIDEContextTags(content);
	}

	if (Array.isArray(content)) {
		const texts: string[] = [];
		for (const item of content) {
			if (
				typeof item === 'object' &&
				item !== null &&
				(item as Record<string, unknown>).type === 'text'
			) {
				const text = (item as Record<string, unknown>).text;
				if (typeof text === 'string') {
					texts.push(text);
				}
			}
		}
		if (texts.length > 0) {
			return stripIDEContextTags(texts.join('\n\n'));
		}
	}

	return '';
}
