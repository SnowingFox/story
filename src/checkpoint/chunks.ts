/**
 * Chunk filename helpers for chunked transcripts.
 *
 * The naming convention matches Go upstream byte-for-byte so chunked
 * transcripts written by either CLI round-trip cleanly:
 *
 * - Chunk 0 uses the bare base filename (`full.jsonl`).
 * - Chunk N (N ≥ 1) uses `<base>.NNN` zero-padded to at least 3 digits
 *   (`full.jsonl.001`, `.002`, ..., `.999`, `.1000`, ...).
 *
 * Three-digit zero padding keeps the lexical and numeric orders aligned for
 * the realistic range; for the pathological 1000+ case both Go's `%03d` and
 * our `parseChunkIndex` switch to numeric ordering, so wider names sort
 * correctly anyway.
 *
 * Go reference: `entire-cli/cmd/entire/cli/agent/chunking.go`.
 */

/**
 * Build the chunk filename for `index`. Chunk 0 returns the base name as-is;
 * chunk N (N ≥ 1) returns `<base>.NNN` zero-padded to three digits.
 *
 * @example
 * ```ts
 * chunkFileName('full.jsonl', 0)    // 'full.jsonl'
 * chunkFileName('full.jsonl', 1)    // 'full.jsonl.001'
 * chunkFileName('full.jsonl', 42)   // 'full.jsonl.042'
 * chunkFileName('full.jsonl', 1000) // 'full.jsonl.1000'
 * ```
 */
export function chunkFileName(baseName: string, index: number): string {
	if (index === 0) {
		return baseName;
	}
	return `${baseName}.${index.toString().padStart(3, '0')}`;
}

/**
 * Inverse of {@link chunkFileName}: extract the chunk index from `filename`
 * relative to `baseName`. Returns `0` for the bare base file, `N ≥ 1` for a
 * suffixed file, and `-1` for any name that doesn't match the pattern.
 *
 * @example
 * ```ts
 * parseChunkIndex('full.jsonl', 'full.jsonl')        // 0
 * parseChunkIndex('full.jsonl.001', 'full.jsonl')    // 1
 * parseChunkIndex('full.jsonl.042', 'full.jsonl')    // 42
 * parseChunkIndex('full.jsonl.1000', 'full.jsonl')   // 1000
 * parseChunkIndex('something-else', 'full.jsonl')    // -1
 * parseChunkIndex('full.jsonl.bad', 'full.jsonl')    // -1
 * ```
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
	if (!/^\d+$/.test(suffix)) {
		return -1;
	}
	const idx = Number.parseInt(suffix, 10);
	if (Number.isNaN(idx)) {
		return -1;
	}
	return idx;
}

/**
 * Sort chunk filenames numerically by chunk index (chunk 0 first, then 1,
 * 2, ... ascending). Non-matching names sort to the front (index -1) but
 * callers should pre-filter so this never happens in practice.
 *
 * Returns a new array; the input is not mutated.
 *
 * @example
 * ```ts
 * sortChunkFiles(
 *   ['full.jsonl.002', 'full.jsonl', 'full.jsonl.001'],
 *   'full.jsonl',
 * )
 * // ['full.jsonl', 'full.jsonl.001', 'full.jsonl.002']
 * ```
 */
export function sortChunkFiles(files: string[], baseName: string): string[] {
	const sorted = [...files];
	sorted.sort((a, b) => parseChunkIndex(a, baseName) - parseChunkIndex(b, baseName));
	return sorted;
}
