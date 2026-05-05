import { describe, expect, it } from 'vitest';
import { chunkFileName, parseChunkIndex, sortChunkFiles } from '@/checkpoint/chunks';
import {
	CHUNK_SUFFIX,
	MAX_CHUNK_SIZE,
	METADATA_BRANCH_NAME,
	METADATA_FILE_NAME,
	STORY_DIR,
	STORY_METADATA_DIR,
	TRANSCRIPT_FILE_NAME,
	TRANSCRIPT_FILE_NAME_LEGACY,
	V2_FULL_REF_PREFIX,
	V2_MAIN_REF_NAME,
} from '@/checkpoint/constants';

describe('checkpoint constants', () => {
	it('uses .story / story rebrand for all repo paths and branches', () => {
		expect(STORY_DIR).toBe('.story');
		expect(STORY_METADATA_DIR).toBe('.story/metadata');
		expect(METADATA_BRANCH_NAME).toBe('story/checkpoints/v1');
		expect(V2_MAIN_REF_NAME).toBe('refs/story/checkpoints/v2/main');
		expect(V2_FULL_REF_PREFIX).toBe('refs/story/checkpoints/v2/full/');
	});

	it('matches Go file-name constants byte-for-byte', () => {
		// Go: paths.go MetadataFileName / TranscriptFileName / TranscriptFileNameLegacy.
		expect(METADATA_FILE_NAME).toBe('metadata.json');
		expect(TRANSCRIPT_FILE_NAME).toBe('full.jsonl');
		expect(TRANSCRIPT_FILE_NAME_LEGACY).toBe('full.log');
	});

	it('uses Go MaxChunkSize and ChunkSuffix literals', () => {
		// Go: agent/chunking.go MaxChunkSize = 50 * 1024 * 1024.
		expect(MAX_CHUNK_SIZE).toBe(50 * 1024 * 1024);
		// Stored as the literal printf template; consumers do their own padding.
		expect(CHUNK_SUFFIX).toBe('.%03d');
	});
});

describe('chunkFileName', () => {
	it('returns the base name for index 0', () => {
		// Go: ChunkFileName("full.jsonl", 0) → "full.jsonl".
		expect(chunkFileName('full.jsonl', 0)).toBe('full.jsonl');
	});

	it('zero-pads index to three digits for index 1-999', () => {
		// Go: ChunkFileName uses fmt.Sprintf("%03d") padding.
		expect(chunkFileName('full.jsonl', 1)).toBe('full.jsonl.001');
		expect(chunkFileName('full.jsonl', 42)).toBe('full.jsonl.042');
		expect(chunkFileName('full.jsonl', 999)).toBe('full.jsonl.999');
	});

	it('switches to natural width for index >= 1000', () => {
		// Go: %03d does not truncate; widths > 3 are emitted as-is.
		expect(chunkFileName('full.jsonl', 1000)).toBe('full.jsonl.1000');
		expect(chunkFileName('full.jsonl', 12345)).toBe('full.jsonl.12345');
	});

	it('respects custom base names', () => {
		expect(chunkFileName('transcript.jsonl', 5)).toBe('transcript.jsonl.005');
	});
});

describe('parseChunkIndex', () => {
	it('returns 0 for the bare base file', () => {
		expect(parseChunkIndex('full.jsonl', 'full.jsonl')).toBe(0);
	});

	it('round-trips chunkFileName for indices >= 1', () => {
		for (const idx of [1, 7, 99, 100, 999, 1000, 5432]) {
			const name = chunkFileName('full.jsonl', idx);
			expect(parseChunkIndex(name, 'full.jsonl')).toBe(idx);
		}
	});

	it('returns -1 when the prefix does not match', () => {
		expect(parseChunkIndex('other.jsonl', 'full.jsonl')).toBe(-1);
		expect(parseChunkIndex('something-else', 'full.jsonl')).toBe(-1);
	});

	it('returns -1 for non-numeric suffixes', () => {
		expect(parseChunkIndex('full.jsonl.bad', 'full.jsonl')).toBe(-1);
		expect(parseChunkIndex('full.jsonl.0a1', 'full.jsonl')).toBe(-1);
		expect(parseChunkIndex('full.jsonl.', 'full.jsonl')).toBe(-1);
	});
});

describe('sortChunkFiles', () => {
	it('places chunk 0 first and sorts the rest numerically', () => {
		const sorted = sortChunkFiles(
			['full.jsonl.002', 'full.jsonl', 'full.jsonl.010', 'full.jsonl.001'],
			'full.jsonl',
		);
		expect(sorted).toEqual(['full.jsonl', 'full.jsonl.001', 'full.jsonl.002', 'full.jsonl.010']);
	});

	it('does not mutate the input array', () => {
		const input = ['full.jsonl.002', 'full.jsonl.001'];
		const out = sortChunkFiles(input, 'full.jsonl');
		expect(input).toEqual(['full.jsonl.002', 'full.jsonl.001']);
		expect(out).toEqual(['full.jsonl.001', 'full.jsonl.002']);
	});

	it('handles 4+ digit chunks alongside 3-digit chunks', () => {
		// Go's sort uses ParseChunkIndex (numeric), so wider names sort by value.
		const sorted = sortChunkFiles(
			['full.jsonl.1000', 'full.jsonl.999', 'full.jsonl.001', 'full.jsonl'],
			'full.jsonl',
		);
		expect(sorted).toEqual(['full.jsonl', 'full.jsonl.001', 'full.jsonl.999', 'full.jsonl.1000']);
	});
});
