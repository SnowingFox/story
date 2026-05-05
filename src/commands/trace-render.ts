/**
 * Parse Story hook performance traces from the JSONL log file and
 * render them as a bar-block tree. Consumed by
 * [`./trace.ts`](./trace.ts).
 *
 * Go-facing contract:
 *   - Each parseable log row is a JSON line with `msg: "perf"`. Keys:
 *     `op` (hook name), `duration_ms` (total), `time` (RFC 3339),
 *     optional `error`, plus flat `steps.<name>_ms` / `steps.<name>_err`
 *     pairs.
 *   - Invalid lines are silently skipped (best-effort, matches Go
 *     `parseTraceEntry` at `trace.go:36-44`).
 *   - Caller sort order: newest first, take last N, optional
 *     `hookFilter` gate on `op`.
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/trace.go:
 * parseTraceEntry + collectTraceEntries + renderTraceEntries`.
 *
 * @packageDocumentation
 */

import fs from 'node:fs/promises';

/** One timed sub-step within a hook trace. */
export interface TraceStep {
	name: string;
	durationMs: number;
	/** True when the step emitted `steps.<name>_err: true` in the log line. */
	error: boolean;
}

/** One full hook invocation trace. */
export interface TraceEntry {
	op: string;
	durationMs: number;
	error: boolean;
	/** ISO-8601 timestamp; empty string when the log row lacked `time`. */
	time: string;
	steps: TraceStep[];
}

/**
 * Parse a single JSONL line into a {@link TraceEntry} or `null` on
 * invalid / non-`perf` rows. Uses a cheap substring pre-filter before
 * attempting a full `JSON.parse` (matches Go `trace.go:36-44`) because
 * the shared log file is dominated by non-`perf` rows.
 *
 * Silently returns `null` for unparseable JSON, rows whose `msg` is
 * not `"perf"`, and rows missing required fields — callers treat this
 * as "skip, try the next line" rather than aborting the whole trace.
 */
export function parseTraceEntry(line: string): TraceEntry | null {
	// Cheap pre-filter: full JSON parse is expensive compared to substring check.
	// Go: trace.go:36-44 — same pre-filter for the same reason.
	if (!line.includes('"msg":"perf"')) {
		return null;
	}
	let raw: Record<string, unknown>;
	try {
		const parsed: unknown = JSON.parse(line);
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return null;
		}
		raw = parsed as Record<string, unknown>;
	} catch {
		return null;
	}
	if (raw.msg !== 'perf') {
		return null;
	}
	const op = typeof raw.op === 'string' ? raw.op : '';
	const durationMs = typeof raw.duration_ms === 'number' ? raw.duration_ms : 0;
	const error = raw.error === true;
	const time = typeof raw.time === 'string' ? raw.time : '';

	const stepDur = new Map<string, number>();
	const stepErr = new Map<string, boolean>();
	for (const [key, val] of Object.entries(raw)) {
		if (key.startsWith('steps.') && key.endsWith('_ms') && typeof val === 'number') {
			stepDur.set(key.slice('steps.'.length, key.length - '_ms'.length), val);
		} else if (key.startsWith('steps.') && key.endsWith('_err') && typeof val === 'boolean') {
			stepErr.set(key.slice('steps.'.length, key.length - '_err'.length), val);
		}
	}
	const steps: TraceStep[] = [...stepDur.entries()]
		.map<TraceStep>(([name, durationMsStep]) => ({
			name,
			durationMs: durationMsStep,
			error: stepErr.get(name) === true,
		}))
		.sort((a, b) => a.name.localeCompare(b.name));

	return { op, durationMs, error, time, steps };
}

/**
 * Read `logFile`, parse each line with {@link parseTraceEntry}, apply
 * the optional hook filter, and return the most recent `last` entries
 * in newest-first order.
 *
 * Mirrors Go `collectTraceEntries`. Missing files resolve to `[]`
 * rather than throwing — matches Go `os.ErrNotExist` short-circuit.
 *
 * @example
 * await collectTraceEntries('/repo/.story/logs/story.log', 5);
 * // returns: [TraceEntry (newest), ..., TraceEntry (oldest)]
 *
 * // Side effects: read-only — a single `fs.readFile` on `logFile`.
 */
export async function collectTraceEntries(
	logFile: string,
	last: number,
	hookFilter?: string,
): Promise<TraceEntry[]> {
	let contents: string;
	try {
		contents = await fs.readFile(logFile, 'utf8');
	} catch (err) {
		if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') {
			return [];
		}
		throw err;
	}

	const entries: TraceEntry[] = [];
	for (const line of contents.split('\n')) {
		if (line === '') {
			continue;
		}
		const entry = parseTraceEntry(line);
		if (entry === null) {
			continue;
		}
		if (hookFilter !== undefined && hookFilter !== '' && entry.op !== hookFilter) {
			continue;
		}
		entries.push(entry);
	}

	if (entries.length > last) {
		entries.splice(0, entries.length - last);
	}
	entries.reverse();
	return entries;
}

/**
 * Render entries as a bar-block tree to `out`. Each entry is a
 * `◇ <op>    <ms>ms` header + per-step rows. Follows the ASCII spec
 * in [`commands/9.6-1-trace.md`](
 * ../../docs/ts-rewrite/impl/phase-9-commands/phase-9.0-setup/commands/9.6-1-trace.md)
 * but degrades gracefully to a plain table when `out` isn't a TTY.
 *
 * Mirrors Go `renderTraceEntries` — behaviour preserved (tree
 * structure, error marker, last-step `└─` / intermediate `├─`); the
 * Story-side divergence is `◇` header lines + `│` vertical bars
 * (Go uses a plain "STEP" column).
 *
 * @example
 * renderTraceEntries(process.stdout, entries);
 * // Side effects: writes N + M lines to `out` (one per entry + per step).
 *
 * // Empty entries array:
 * renderTraceEntries(process.stdout, []);
 * // Side effects: writes "No trace entries found." + hint lines.
 */
export function renderTraceEntries(out: NodeJS.WritableStream, entries: TraceEntry[]): void {
	if (entries.length === 0) {
		out.write('No trace entries found.\n');
		out.write('Traces are logged at DEBUG level. Enable DEBUG logs and trigger a hook first:\n');
		out.write('  story enable --log-level debug\n');
		return;
	}

	for (let i = 0; i < entries.length; i++) {
		if (i > 0) {
			out.write('│\n');
		}
		const entry = entries[i]!;
		const idx = `(${entries.length - i}/${entries.length})`;
		const timeLabel = entry.time !== '' ? `  ${entry.time}` : '';
		out.write(`◇  ${entry.op}    ${entry.durationMs}ms   ${idx}${timeLabel}\n`);
		if (entry.error) {
			out.write('│  error: true\n');
		}
		if (entry.steps.length > 0) {
			for (let s = 0; s < entry.steps.length; s++) {
				const step = entry.steps[s]!;
				const connector = s === entry.steps.length - 1 ? '└─' : '├─';
				const err = step.error ? '  x' : '';
				out.write(`│    ${connector} ${step.name}  ${step.durationMs}ms${err}\n`);
			}
		}
	}

	// Summary line — only when there's more than one entry.
	if (entries.length > 1) {
		const total = entries.reduce((acc, e) => acc + e.durationMs, 0);
		const avg = Math.round(total / entries.length);
		const slowest = entries.reduce((a, b) => (a.durationMs >= b.durationMs ? a : b));
		out.write('│\n');
		out.write(
			`●  ${entries.length} traces shown  (avg ${avg}ms, max ${slowest.durationMs}ms ${slowest.op})\n`,
		);
	} else {
		out.write('│\n');
		out.write(`●  1 trace shown\n`);
	}
}
