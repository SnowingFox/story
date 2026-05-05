/**
 * Transcript chunking + reassembly. Mirrors Go
 * `cmd/entire/cli/agent/chunking.go`.
 *
 * **Phase 4.2 ship JSONL fallback** in [`@/transcript`](../transcript.ts);
 * Phase 6.1 wraps that with agent-aware dispatch via the registry. Built-in
 * JSONL chunker (Claude Code, Cursor, Vogon) goes through {@link chunkJSONL};
 * agents that need format-aware chunking delegate to the registered agent's
 * own `chunkTranscript` implementation.
 *
 * @packageDocumentation
 */

import { chunkTranscript as chunkJSONLFallback } from '@/transcript';
import { getByAgentType } from './registry';
import type { AgentType } from './types';

/**
 * Maximum size for a single transcript chunk. GitHub blob limit is 100MB;
 * we use 50MB to be safe. Mirrors Go `agent.MaxChunkSize`.
 */
export const MAX_CHUNK_SIZE = 50 * 1024 * 1024;

/** Format for chunk file suffixes (`.001`, `.002`, ...). Mirrors Go
 *  `agent.ChunkSuffix = ".%03d"`. */
export const CHUNK_SUFFIX_FORMAT = (i: number): string => `.${i.toString().padStart(3, '0')}`;

/**
 * Split a transcript into chunks using the appropriate agent's chunker.
 * Falls back to JSONL chunking (line-based) if `agentType` is empty or the
 * agent isn't registered.
 *
 * **Single-chunk shortcut**: if `content.length` ≤ {@link MAX_CHUNK_SIZE},
 * returns `[content]` immediately (matches Go).
 *
 * Mirrors Go `agent.ChunkTranscript`.
 *
 * @example
 * ```ts
 * await chunkTranscript(claudeJSONLBytes, AGENT_TYPE_CLAUDE_CODE);
 * // returns: [Uint8Array, Uint8Array, ...]   (1+ chunks each ≤ 50MB)
 *
 * await chunkTranscript(content, AGENT_TYPE_UNKNOWN);
 * // returns: chunkJSONL fallback result
 *
 * // Side effects: none — pure (no I/O, no registry mutation).
 * ```
 */
export async function chunkTranscript(
	content: Uint8Array,
	agentType: AgentType | string,
): Promise<Uint8Array[]> {
	if (content.length <= MAX_CHUNK_SIZE) {
		return [content];
	}
	if (agentType !== '') {
		const ag = getByAgentType(agentType);
		if (ag !== null) {
			try {
				return await ag.chunkTranscript(content, MAX_CHUNK_SIZE);
			} catch (e) {
				throw new Error(`agent chunking failed: ${(e as Error).message}`, {
					cause: e as Error,
				});
			}
		}
	}
	return chunkJSONL(content, MAX_CHUNK_SIZE);
}

/**
 * Combine chunks back into a single transcript. Same dispatch + JSONL
 * fallback as {@link chunkTranscript}.
 *
 * **Edge cases** (matches Go):
 * - `chunks.length === 0` → returns `null` (Go `(nil, nil)`)
 * - `chunks.length === 1` → returns `chunks[0]` (no reassembly)
 *
 * Mirrors Go `agent.ReassembleTranscript`.
 */
export async function reassembleTranscript(
	chunks: Uint8Array[],
	agentType: AgentType | string,
): Promise<Uint8Array | null> {
	if (chunks.length === 0) {
		return null;
	}
	if (chunks.length === 1) {
		return chunks[0]!;
	}
	if (agentType !== '') {
		const ag = getByAgentType(agentType);
		if (ag !== null) {
			try {
				return await ag.reassembleTranscript(chunks);
			} catch (e) {
				throw new Error(`agent reassembly failed: ${(e as Error).message}`, {
					cause: e as Error,
				});
			}
		}
	}
	return reassembleJSONL(chunks);
}

/**
 * JSONL chunking (line-based, default). Splits at line boundaries; throws
 * if any single line exceeds `maxSize` (can't split a single JSON object).
 *
 * Mirrors Go `agent.ChunkJSONL`. Phase 4.2 already shipped the equivalent
 * in `src/transcript.ts: chunkTranscript(data, maxSize)`. This wrapper:
 * - normalizes the signature (Uint8Array vs string)
 * - re-exports under the `@/agent/chunking` namespace for consistent imports
 * - delegates to the existing `@/transcript` implementation (no duplication)
 *
 * @example
 * chunkJSONL(content, MAX_CHUNK_SIZE);
 * // returns: Uint8Array[]
 *
 * chunkJSONL(oversizedSingleLine, 100);
 * // throws: Error('JSONL line 1 exceeds maximum chunk size (...)')
 */
export function chunkJSONL(content: Uint8Array, maxSize: number): Uint8Array[] {
	const text = new TextDecoder('utf-8').decode(content);
	const stringChunks = chunkJSONLFallback(text, maxSize);
	const enc = new TextEncoder();
	return stringChunks.map((s) => enc.encode(s));
}

/**
 * JSONL reassembly (concat with `\n` between chunks; no trailing newline).
 * Mirrors Go `agent.ReassembleJSONL`.
 *
 * Implemented directly here (not via `@/transcript: reassembleTranscript`)
 * because that helper returns `null` on empty input and operates on `string`
 * — we need byte-precise concatenation that mirrors Go `strings.Builder`.
 */
export function reassembleJSONL(chunks: Uint8Array[]): Uint8Array {
	if (chunks.length === 0) {
		return new Uint8Array();
	}
	const NEWLINE = 0x0a; // '\n'
	let totalLen = 0;
	for (let i = 0; i < chunks.length; i++) {
		totalLen += chunks[i]!.length;
		if (i < chunks.length - 1) {
			totalLen += 1;
		}
	}
	const out = new Uint8Array(totalLen);
	let offset = 0;
	for (let i = 0; i < chunks.length; i++) {
		const c = chunks[i]!;
		out.set(c, offset);
		offset += c.length;
		if (i < chunks.length - 1) {
			out[offset] = NEWLINE;
			offset += 1;
		}
	}
	return out;
}

/**
 * Filename for chunk at `index`. Index 0 → base; index 1+ → base + `.NNN`.
 * Mirrors Go `agent.ChunkFileName`.
 *
 * @example
 * chunkFileName('full.jsonl', 0);    // 'full.jsonl'
 * chunkFileName('full.jsonl', 1);    // 'full.jsonl.001'
 * chunkFileName('full.jsonl', 100);  // 'full.jsonl.100'
 */
export function chunkFileName(baseName: string, index: number): string {
	if (index === 0) {
		return baseName;
	}
	return baseName + CHUNK_SUFFIX_FORMAT(index);
}

const CHUNK_INDEX_RE = /^(\d{3,})$/;

/**
 * Extract chunk index from filename. Returns `0` for base file (no suffix),
 * the chunk number for suffixed files, `-1` for non-matching filenames.
 * Mirrors Go `agent.ParseChunkIndex` (uses `fmt.Sscanf("%03d")` which
 * requires zero-padding; `.1` does NOT match).
 */
export function parseChunkIndex(filename: string, baseName: string): number {
	if (filename === baseName) {
		return 0;
	}
	const prefix = `${baseName}.`;
	if (!filename.startsWith(prefix)) {
		return -1;
	}
	const suffix = filename.slice(prefix.length);
	const m = CHUNK_INDEX_RE.exec(suffix);
	if (m === null) {
		return -1;
	}
	return Number.parseInt(m[1]!, 10);
}

/** Sort chunk filenames in chunk-index order. Mirrors Go `agent.SortChunkFiles`. */
export function sortChunkFiles(files: string[], baseName: string): string[] {
	return [...files].sort((a, b) => parseChunkIndex(a, baseName) - parseChunkIndex(b, baseName));
}

// `detectAgentTypeFromContent` was removed when Gemini was dropped from the
// roadmap — it only sniffed Gemini's JSON envelope. See
// [`docs/ts-rewrite/impl/references/dropped-agents.md`](../../docs/ts-rewrite/impl/references/dropped-agents.md).
