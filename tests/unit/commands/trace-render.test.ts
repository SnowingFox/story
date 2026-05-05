/**
 * Phase 9.6 trace-render unit tests.
 *
 * Go: `cmd/entire/cli/trace.go: parseTraceEntry + collectTraceEntries +
 * renderTraceEntries`.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
	collectTraceEntries,
	parseTraceEntry,
	renderTraceEntries,
	type TraceEntry,
} from '@/commands/trace-render';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(HERE, '..', '..', 'fixtures', 'trace');

function mkWritable(): NodeJS.WritableStream & { captured: string } {
	const stream = {
		captured: '',
		write(chunk: string | Uint8Array): boolean {
			this.captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
			return true;
		},
		end(): void {},
		on(): NodeJS.WritableStream {
			return this as unknown as NodeJS.WritableStream;
		},
		once(): NodeJS.WritableStream {
			return this as unknown as NodeJS.WritableStream;
		},
		emit(): boolean {
			return false;
		},
	};
	return stream as unknown as NodeJS.WritableStream & { captured: string };
}

describe('commands/trace-render', () => {
	// Go: trace.go:37 parseTraceEntry — happy path with all fields.
	describe('parseTraceEntry', () => {
		it('parses a well-formed perf row into a TraceEntry', () => {
			const line =
				'{"time":"2026-04-22T16:04:11Z","level":"DEBUG","msg":"perf","op":"post-commit","duration_ms":42,"steps.load-session_ms":3,"steps.write_ms":18}';
			const entry = parseTraceEntry(line);
			expect(entry).not.toBeNull();
			expect(entry?.op).toBe('post-commit');
			expect(entry?.durationMs).toBe(42);
			expect(entry?.steps.map((s) => s.name).sort()).toEqual(['load-session', 'write']);
		});

		it('returns null for non-perf msg', () => {
			const line = '{"msg":"hello","op":"post-commit"}';
			expect(parseTraceEntry(line)).toBeNull();
		});

		it('returns null for non-JSON lines', () => {
			expect(parseTraceEntry('this is plain text')).toBeNull();
		});

		it('returns null for empty lines', () => {
			expect(parseTraceEntry('')).toBeNull();
		});

		it('captures steps.<name>_err flags', () => {
			const line =
				'{"msg":"perf","op":"post-commit","duration_ms":5,"steps.a_ms":1,"steps.a_err":true}';
			const entry = parseTraceEntry(line);
			expect(entry?.steps[0]?.error).toBe(true);
		});

		it('step field ordering is stable (sorted by name)', () => {
			const line =
				'{"msg":"perf","op":"x","duration_ms":5,"steps.zeta_ms":1,"steps.alpha_ms":2,"steps.beta_ms":3}';
			const entry = parseTraceEntry(line);
			expect(entry?.steps.map((s) => s.name)).toEqual(['alpha', 'beta', 'zeta']);
		});

		it('tolerates missing op / duration / time fields (zero values)', () => {
			const line = '{"msg":"perf"}';
			const entry = parseTraceEntry(line);
			expect(entry).not.toBeNull();
			expect(entry?.op).toBe('');
			expect(entry?.durationMs).toBe(0);
			expect(entry?.time).toBe('');
		});
	});

	// Go: trace.go:195 collectTraceEntries
	describe('collectTraceEntries', () => {
		it('reads fixture log and returns 3 perf entries', async () => {
			const entries = await collectTraceEntries(path.join(FIXTURE_DIR, 'story.log'), 10);
			expect(entries.length).toBe(3);
			// Ordering: newest first
			expect(entries[0]?.op).toBe('post-commit');
		});

		it('silently skips invalid JSON lines', async () => {
			const entries = await collectTraceEntries(path.join(FIXTURE_DIR, 'corrupted-line.log'), 10);
			expect(entries.length).toBe(3);
			expect(entries.every((e) => typeof e.op === 'string')).toBe(true);
		});

		it('respects hookFilter — only matching ops included', async () => {
			const entries = await collectTraceEntries(
				path.join(FIXTURE_DIR, 'story.log'),
				10,
				'post-commit',
			);
			expect(entries.length).toBe(1);
			expect(entries[0]?.op).toBe('post-commit');
		});

		it('hookFilter with 0 matches → []', async () => {
			const entries = await collectTraceEntries(
				path.join(FIXTURE_DIR, 'story.log'),
				10,
				'pre-push',
			);
			expect(entries).toEqual([]);
		});

		it('last=1 returns the newest entry only', async () => {
			const entries = await collectTraceEntries(path.join(FIXTURE_DIR, 'story.log'), 1);
			expect(entries.length).toBe(1);
			expect(entries[0]?.op).toBe('post-commit');
		});

		it('missing file → [] (not ENOENT error)', async () => {
			const missing = path.join(os.tmpdir(), `trace-missing-${Date.now()}.log`);
			const entries = await collectTraceEntries(missing, 5);
			expect(entries).toEqual([]);
		});

		it('empty file → []', async () => {
			const tmp = path.join(os.tmpdir(), `trace-empty-${Date.now()}.log`);
			await fs.writeFile(tmp, '');
			try {
				const entries = await collectTraceEntries(tmp, 5);
				expect(entries).toEqual([]);
			} finally {
				await fs.rm(tmp, { force: true });
			}
		});
	});

	// Go: trace.go:237 renderTraceEntries
	describe('renderTraceEntries', () => {
		it('empty entries prints "No trace entries found" + DEBUG hint', () => {
			const out = mkWritable();
			renderTraceEntries(out, []);
			expect(out.captured).toMatch(/No trace entries found/);
			expect(out.captured).toMatch(/DEBUG/);
			expect(out.captured).toMatch(/story enable --log-level debug/);
		});

		it('renders a single entry as ◇ op duration + tree', () => {
			const out = mkWritable();
			const entry: TraceEntry = {
				op: 'post-commit',
				durationMs: 42,
				error: false,
				time: '2026-04-22T16:04:11Z',
				steps: [
					{ name: 'load-session', durationMs: 3, error: false },
					{ name: 'write-checkpoint', durationMs: 18, error: false },
				],
			};
			renderTraceEntries(out, [entry]);
			expect(out.captured).toMatch(/◇\s+post-commit/);
			expect(out.captured).toMatch(/42ms/);
			expect(out.captured).toMatch(/load-session/);
			expect(out.captured).toMatch(/write-checkpoint/);
		});

		it('last step uses └─ and intermediate steps use ├─', () => {
			const out = mkWritable();
			const entry: TraceEntry = {
				op: 'post-commit',
				durationMs: 10,
				error: false,
				time: '',
				steps: [
					{ name: 'a', durationMs: 1, error: false },
					{ name: 'b', durationMs: 2, error: false },
					{ name: 'c', durationMs: 3, error: false },
				],
			};
			renderTraceEntries(out, [entry]);
			expect(out.captured).toMatch(/├─ a/);
			expect(out.captured).toMatch(/├─ b/);
			expect(out.captured).toMatch(/└─ c/);
		});

		it('multi-entry output separates entries with │ bars + summary', () => {
			const out = mkWritable();
			const entry: TraceEntry = {
				op: 'post-commit',
				durationMs: 10,
				error: false,
				time: '',
				steps: [],
			};
			renderTraceEntries(out, [entry, { ...entry, op: 'pre-push', durationMs: 30 }]);
			expect(out.captured).toMatch(/│/);
			expect(out.captured).toMatch(/traces shown/);
			expect(out.captured).toMatch(/avg/);
			expect(out.captured).toMatch(/max 30ms pre-push/);
		});

		it('single-entry summary says "1 trace shown"', () => {
			const out = mkWritable();
			const entry: TraceEntry = {
				op: 'post-commit',
				durationMs: 10,
				error: false,
				time: '',
				steps: [],
			};
			renderTraceEntries(out, [entry]);
			expect(out.captured).toMatch(/1 trace shown/);
		});

		it('error=true adds an error marker row', () => {
			const out = mkWritable();
			const entry: TraceEntry = {
				op: 'post-commit',
				durationMs: 10,
				error: true,
				time: '',
				steps: [],
			};
			renderTraceEntries(out, [entry]);
			expect(out.captured).toMatch(/error: true/);
		});

		it('step error=true marks that step with "x" suffix', () => {
			const out = mkWritable();
			const entry: TraceEntry = {
				op: 'post-commit',
				durationMs: 10,
				error: false,
				time: '',
				steps: [{ name: 'broken', durationMs: 5, error: true }],
			};
			renderTraceEntries(out, [entry]);
			expect(out.captured).toMatch(/broken\s+5ms\s+x/);
		});

		it('timestamp appears in the header line when present', () => {
			const out = mkWritable();
			const entry: TraceEntry = {
				op: 'post-commit',
				durationMs: 10,
				error: false,
				time: '2026-04-22T16:04:11Z',
				steps: [],
			};
			renderTraceEntries(out, [entry]);
			expect(out.captured).toMatch(/2026-04-22T16:04:11Z/);
		});

		// Phase 9.6 naming red-line: output must have no "entire" brand leaks.
		it('output is pure ASCII-safe (no "entire" literals)', () => {
			const out = mkWritable();
			renderTraceEntries(out, []);
			expect(out.captured).not.toMatch(/\bentire\b/);
			expect(out.captured).not.toMatch(/\.entire\//);
		});
	});
});
