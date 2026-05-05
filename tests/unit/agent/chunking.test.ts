import { afterEach, describe, expect, it } from 'vitest';
import {
	chunkFileName,
	chunkJSONL,
	chunkTranscript,
	MAX_CHUNK_SIZE,
	parseChunkIndex,
	reassembleJSONL,
	reassembleTranscript,
	sortChunkFiles,
} from '@/agent/chunking';
import { clearForTesting, register, withTestRegistry } from '@/agent/registry';
import {
	AGENT_NAME_CODEX,
	AGENT_TYPE_CODEX,
	AGENT_TYPE_UNKNOWN,
	type AgentName,
} from '@/agent/types';
import { mockBaseAgent } from './_helpers';

const enc = new TextEncoder();
const dec = new TextDecoder();

describe('agent/chunking — Go: chunking.go', () => {
	afterEach(() => clearForTesting());

	describe('chunkTranscript', () => {
		// Go: chunking.go:24-43 (ChunkTranscript dispatch).
		it('content <= MAX_CHUNK_SIZE → returns [content] (single-chunk shortcut)', async () => {
			// Go: chunking_test.go TestChunkTranscript_SmallContent_NoAgent
			const content = enc.encode('{"a":1}\n{"b":2}\n');
			const chunks = await chunkTranscript(content, '');
			expect(chunks).toEqual([content]);
		});

		it('large content + unknown agent type → JSONL fallback', async () => {
			// Build content > MAX_CHUNK_SIZE worth of small JSONL lines.
			const line = `${'x'.repeat(1024)}\n`;
			const content = enc.encode(line.repeat(60_000)); // ~60MB > 50MB
			const chunks = await chunkTranscript(content, AGENT_TYPE_UNKNOWN);
			expect(chunks.length).toBeGreaterThan(1);
		});

		it('large content + known agent type → dispatches to agent.chunkTranscript', async () => {
			await withTestRegistry(async () => {
				let dispatchedTo = '';
				register(AGENT_NAME_CODEX, () =>
					mockBaseAgent({
						name: () => AGENT_NAME_CODEX,
						type: () => AGENT_TYPE_CODEX,
						chunkTranscript: async (content) => {
							dispatchedTo = 'codex';
							return [content.slice(0, content.length / 2), content.slice(content.length / 2)];
						},
					}),
				);
				const big = new Uint8Array(MAX_CHUNK_SIZE + 1);
				const result = await chunkTranscript(big, AGENT_TYPE_CODEX);
				expect(dispatchedTo).toBe('codex');
				expect(result).toHaveLength(2);
			});
		});

		it('large content + agent throws → wrap with "agent chunking failed"', async () => {
			await withTestRegistry(async () => {
				register('boom' as AgentName, () =>
					mockBaseAgent({
						name: () => 'boom' as AgentName,
						type: () => 'BoomType',
						chunkTranscript: async () => {
							throw new Error('inner');
						},
					}),
				);
				const big = new Uint8Array(MAX_CHUNK_SIZE + 1);
				await expect(chunkTranscript(big, 'BoomType')).rejects.toThrow('agent chunking failed');
			});
		});
	});

	describe('reassembleTranscript', () => {
		// Go: chunking.go:47-69
		it('empty array → null (Go: nil, nil)', async () => {
			expect(await reassembleTranscript([], 'Claude Code')).toBeNull();
		});
		it('single chunk → returns chunks[0]', async () => {
			const c = enc.encode('only');
			expect(await reassembleTranscript([c], 'Claude Code')).toBe(c);
		});
		it('multi chunks + unknown agent → JSONL reassembly fallback', async () => {
			const a = enc.encode('line1');
			const b = enc.encode('line2');
			const result = await reassembleTranscript([a, b], '');
			expect(dec.decode(result!)).toBe('line1\nline2');
		});

		it('multi chunks + known agent type → dispatches to agent.reassembleTranscript', async () => {
			// Go: chunking.go:55-65 — when agentType is set and registry hit,
			// dispatch to ag.ReassembleTranscript instead of JSONL fallback.
			await withTestRegistry(async () => {
				let dispatched = false;
				register(AGENT_NAME_CODEX, () =>
					mockBaseAgent({
						name: () => AGENT_NAME_CODEX,
						type: () => AGENT_TYPE_CODEX,
						reassembleTranscript: async (chunks) => {
							dispatched = true;
							return enc.encode(`agent-joined:${chunks.length}`);
						},
					}),
				);
				const a = enc.encode('x');
				const b = enc.encode('y');
				const result = await reassembleTranscript([a, b], AGENT_TYPE_CODEX);
				expect(dispatched).toBe(true);
				expect(dec.decode(result!)).toBe('agent-joined:2');
			});
		});

		it('agent reassembleTranscript throws → wrap with "agent reassembly failed"', async () => {
			// Go: chunking.go:60-62 — `agent reassembly failed: %w`.
			await withTestRegistry(async () => {
				register('boom-r' as AgentName, () =>
					mockBaseAgent({
						name: () => 'boom-r' as AgentName,
						type: () => 'BoomReassembleType',
						reassembleTranscript: async () => {
							throw new Error('inner-r');
						},
					}),
				);
				await expect(
					reassembleTranscript([enc.encode('a'), enc.encode('b')], 'BoomReassembleType'),
				).rejects.toThrow('agent reassembly failed');
			});
		});
	});

	describe('chunkJSONL', () => {
		// Go: chunking_test.go TestChunkJSONL_*
		it('small content → single chunk', () => {
			expect(chunkJSONL(enc.encode('{"a":1}\n{"b":2}'), 1024)).toHaveLength(1);
		});

		it('empty content → []', () => {
			expect(chunkJSONL(new Uint8Array(), 1024)).toEqual([]);
		});

		it('multiple lines split when total exceeds maxSize', () => {
			// Each line is ~50 bytes; maxSize = 100 should split into multiple.
			const line = `${'x'.repeat(48)}\n`;
			const chunks = chunkJSONL(enc.encode(line.repeat(5)), 100);
			expect(chunks.length).toBeGreaterThan(1);
		});

		it('oversized single line → throws "JSONL line N exceeds maximum chunk size"', () => {
			expect(() => chunkJSONL(enc.encode(`${'x'.repeat(200)}\n`), 100)).toThrow(
				/JSONL line 1 exceeds maximum chunk size/,
			);
		});

		it('oversized line in MIDDLE → error mentions correct line number (Go: TestChunkJSONL_OversizedLineInMiddle)', () => {
			// Go: chunking_test.go TestChunkJSONL_OversizedLineInMiddle.
			// First line is fine (~30B), second line exceeds maxSize → must report `line 2`.
			const content = enc.encode(`${'a'.repeat(30)}\n${'x'.repeat(200)}\n${'b'.repeat(30)}\n`);
			expect(() => chunkJSONL(content, 100)).toThrow(/JSONL line 2 exceeds maximum chunk size/);
		});

		it('large content roundtrip via reassembleJSONL == original (Go: TestChunkJSONL_LargeContent)', () => {
			// Go: chunking_test.go TestChunkJSONL_LargeContent — chunk large
			// content, verify each chunk ≤ maxSize, and roundtrip equals original.
			// Use no-trailing-newline original to avoid newline ambiguity (the
			// underlying chunker treats trailing '\n' as an empty final line).
			const original = enc.encode(Array.from({ length: 20 }, () => 'x'.repeat(48)).join('\n'));
			const maxSize = 200;
			const chunks = chunkJSONL(original, maxSize);
			expect(chunks.length).toBeGreaterThan(1);
			for (const chunk of chunks) {
				expect(chunk.length).toBeLessThanOrEqual(maxSize);
			}
			expect(dec.decode(reassembleJSONL(chunks))).toBe(dec.decode(original));
		});
	});

	describe('reassembleJSONL', () => {
		// Go: chunking_test.go TestReassembleJSONL_*
		it('single chunk roundtrip', () => {
			const c = enc.encode('only');
			expect(dec.decode(reassembleJSONL([c]))).toBe('only');
		});
		it('multiple chunks joined with single \\n', () => {
			const a = enc.encode('a');
			const b = enc.encode('b');
			const c = enc.encode('c');
			expect(dec.decode(reassembleJSONL([a, b, c]))).toBe('a\nb\nc');
		});
	});

	describe('chunkFileName', () => {
		// Go: chunking_test.go TestChunkFileName (5 sub-cases).
		it('index 0 → baseName; 1+ → padded zero', () => {
			expect(chunkFileName('full.jsonl', 0)).toBe('full.jsonl');
			expect(chunkFileName('full.jsonl', 1)).toBe('full.jsonl.001');
			expect(chunkFileName('full.jsonl', 10)).toBe('full.jsonl.010');
			expect(chunkFileName('full.jsonl', 100)).toBe('full.jsonl.100');
		});
	});

	describe('parseChunkIndex', () => {
		// Go: chunking_test.go TestParseChunkIndex (7 sub-cases).
		it('matches base / .001 / .100; non-match → -1; non-numeric suffix → -1', () => {
			expect(parseChunkIndex('full.jsonl', 'full.jsonl')).toBe(0);
			expect(parseChunkIndex('full.jsonl.001', 'full.jsonl')).toBe(1);
			expect(parseChunkIndex('full.jsonl.010', 'full.jsonl')).toBe(10);
			expect(parseChunkIndex('full.jsonl.100', 'full.jsonl')).toBe(100);
			expect(parseChunkIndex('other.jsonl', 'full.jsonl')).toBe(-1);
			expect(parseChunkIndex('full.jsonl.abc', 'full.jsonl')).toBe(-1);
			expect(parseChunkIndex('full.jsonl.1', 'full.jsonl')).toBe(-1); // no zero-pad
		});
	});

	describe('sortChunkFiles', () => {
		// Go: chunking_test.go TestSortChunkFiles
		it('sorts by chunk-index order (base first, then numbered)', () => {
			expect(
				sortChunkFiles(
					['full.jsonl.003', 'full.jsonl.001', 'full.jsonl', 'full.jsonl.002'],
					'full.jsonl',
				),
			).toEqual(['full.jsonl', 'full.jsonl.001', 'full.jsonl.002', 'full.jsonl.003']);
		});
	});

	// `describe('detectAgentTypeFromContent', ...)` was removed when Gemini was
	// dropped from the roadmap — see references/dropped-agents.md.
});
