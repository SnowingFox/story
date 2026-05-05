/**
 * Phase 7 Part 1 `src/lifecycle/pre-prompt-state.ts` — 20 case.
 *
 * Go 参考：`cmd/entire/cli/state_test.go: TestPrePromptState_*`
 * (`BackwardCompat_LastTranscriptLineCount` / `WithTranscriptPosition` /
 * `WithEmptyTranscriptPath` / `WithSummaryOnlyTranscript`) plus Story-補充
 * cases for null-safety, parse-failure, idempotent cleanup, and 4-level
 * migration priority, and the Go round-trip compatibility tests added
 * alongside the Part 1 review fixes.
 *
 * Each `it()` is annotated with `// Go: <anchor>` for traceability.
 */

// `node:fs/promises` is mocked with the real module re-exported as the default
// implementation. Only `readFile` gets wrapped in `vi.fn()` so individual
// tests can inject non-ENOENT errors via `vi.mocked(fs.readFile).mockRejectedValueOnce(...)`
// while every other test still hits the real filesystem through the spread.
vi.mock('node:fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs/promises')>();
	return {
		...actual,
		readFile: vi.fn(actual.readFile),
	};
});

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent, TranscriptAnalyzer } from '@/agent/interfaces';
import {
	capturePrePromptState,
	cleanupPrePromptState,
	loadPrePromptState,
	normalizePrePromptState,
	type PrePromptState,
	preUntrackedFiles,
} from '@/lifecycle/pre-prompt-state';
import { clearWorktreeRootCache } from '@/paths';
import { TestEnv } from '../../helpers/test-env';

/**
 * Minimal agent stub that only implements {@link TranscriptAnalyzer}'s
 * `getTranscriptPosition`. `asTranscriptAnalyzer` duck-types on that
 * marker, so the other `Agent` methods can be left undefined — the `as Agent`
 * cast is safe because the capability gate never invokes them.
 */
function makeAnalyzerAgent(impl: Partial<TranscriptAnalyzer>): Agent {
	return {
		getTranscriptPosition: impl.getTranscriptPosition ?? (async () => 0),
	} as unknown as Agent;
}

/** Agent that does NOT implement TranscriptAnalyzer. */
function makeBareAgent(): Agent {
	return {} as unknown as Agent;
}

describe('lifecycle/pre-prompt-state', () => {
	let env: TestEnv;
	let tmpDirAbs: string;

	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		tmpDirAbs = path.join(env.dir, '.story/tmp');
		clearWorktreeRootCache();
		const paths = await import('@/paths');
		vi.spyOn(paths, 'worktreeRoot').mockResolvedValue(env.dir);
		// Stub out getUntrackedFilesForState so tests don't depend on real
		// `git status` output inside the TestEnv. Individual tests override
		// this for test #2 where the mock return value matters.
		const fileChanges = await import('@/lifecycle/file-changes');
		vi.spyOn(fileChanges, 'getUntrackedFilesForState').mockResolvedValue([]);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		clearWorktreeRootCache();
		await env.cleanup();
	});

	// Go: state_test.go: TestPrePromptState_WithTranscriptPosition (atomic write + 0o600)
	it('capturePrePromptState writes atomic JSON with mode 0o600 + snake_case keys', async () => {
		const agent = makeAnalyzerAgent({ getTranscriptPosition: async () => 0 });
		await capturePrePromptState(agent, 'sid-1', '/some/transcript');

		const filePath = path.join(tmpDirAbs, 'pre-prompt-sid-1.json');
		const stat = await fs.stat(filePath);
		expect(stat.isFile()).toBe(true);
		if (process.platform !== 'win32') {
			expect(stat.mode & 0o777).toBe(0o600);
		}

		const raw = await fs.readFile(filePath, 'utf-8');
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		// Go round-trip: session_id + timestamp + untracked_files present;
		// transcript_offset omitted when 0 (Go `omitempty`).
		expect(parsed).toHaveProperty('session_id', 'sid-1');
		expect(parsed).toHaveProperty('timestamp');
		expect(parsed).toHaveProperty('untracked_files');
		expect(parsed).not.toHaveProperty('transcript_offset');
		expect(parsed).not.toHaveProperty('start_time');
		expect(raw.endsWith('\n')).toBe(true);

		// No leftover .tmp file after atomic rename.
		const entries = await fs.readdir(tmpDirAbs);
		expect(entries.filter((e) => e.endsWith('.tmp'))).toEqual([]);
	});

	// Go: state_test.go: TestPrePromptState_WithTranscriptPosition
	it('capturePrePromptState queries TranscriptAnalyzer when agent supports it', async () => {
		const getPos = vi.fn<() => Promise<number>>().mockResolvedValue(42);
		const agent = makeAnalyzerAgent({ getTranscriptPosition: getPos });
		const fileChanges = await import('@/lifecycle/file-changes');
		vi.mocked(fileChanges.getUntrackedFilesForState).mockResolvedValue(['untracked.log']);

		await capturePrePromptState(agent, 'sid-2', '/some/transcript.jsonl');

		expect(getPos).toHaveBeenCalledTimes(1);
		expect(getPos).toHaveBeenCalledWith('/some/transcript.jsonl');

		const raw = await fs.readFile(path.join(tmpDirAbs, 'pre-prompt-sid-2.json'), 'utf-8');
		const parsed = JSON.parse(raw) as { transcript_offset: number; untracked_files: string[] };
		expect(parsed.transcript_offset).toBe(42);
		expect(parsed.untracked_files).toEqual(['untracked.log']);
	});

	// Go: state_test.go: TestPrePromptState_WithTranscriptPosition (error branch; Story 补充)
	it('capturePrePromptState with TranscriptAnalyzer error → offset 0 + log.warn', async () => {
		const log = await import('@/log');
		const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
		const agent = makeAnalyzerAgent({
			getTranscriptPosition: async () => {
				throw new Error('analyzer kaput');
			},
		});

		await capturePrePromptState(agent, 'sid-3', '/x.jsonl');

		const raw = await fs.readFile(path.join(tmpDirAbs, 'pre-prompt-sid-3.json'), 'utf-8');
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		// Offset 0 → omitempty drops the key entirely.
		expect(parsed).not.toHaveProperty('transcript_offset');
		expect(warnSpy).toHaveBeenCalledWith(
			expect.objectContaining({ component: 'lifecycle' }),
			'failed to get transcript position',
			expect.objectContaining({ error: 'analyzer kaput' }),
		);
	});

	// Go: state_test.go: TestPrePromptState_WithEmptyTranscriptPath
	it('capturePrePromptState with empty sessionRef → skips analyzer call → offset 0', async () => {
		const getPos = vi.fn<() => Promise<number>>().mockResolvedValue(99);
		const agent = makeAnalyzerAgent({ getTranscriptPosition: getPos });

		await capturePrePromptState(agent, 'sid-4', '');

		expect(getPos).not.toHaveBeenCalled();
		const raw = await fs.readFile(path.join(tmpDirAbs, 'pre-prompt-sid-4.json'), 'utf-8');
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		expect(parsed).not.toHaveProperty('transcript_offset');
	});

	// Go: state_test.go: TestPrePromptState_BackwardCompat_LastTranscriptLineCount
	it('normalizePrePromptState migrates lastTranscriptLineCount into transcriptOffset', async () => {
		const state: PrePromptState = {
			sessionId: 'sid-migrate',
			untrackedFiles: ['a.log'],
			transcriptOffset: 0,
			startTime: new Date(0),
			lastTranscriptLineCount: 55,
		};
		const result = normalizePrePromptState(state);
		expect(result.transcriptOffset).toBe(55);
		expect(result.untrackedFiles).toEqual(['a.log']);
		expect(result.sessionId).toBe('sid-migrate');
		// Deprecated fields are cleared in the normalized output.
		expect(result.lastTranscriptLineCount).toBeUndefined();
		expect(result.stepTranscriptStart).toBeUndefined();
		expect(result.startMessageIndex).toBeUndefined();
	});

	// Go: state.go: normalizePrePromptState priority order (Story 补充 — 覆盖 2-of-3 tie)
	it('normalizePrePromptState priority: stepTranscriptStart beats lastTranscriptLineCount', async () => {
		const state: PrePromptState = {
			sessionId: 'sid-prio',
			untrackedFiles: [],
			transcriptOffset: 0,
			startTime: new Date(0),
			stepTranscriptStart: 20,
			lastTranscriptLineCount: 99,
			startMessageIndex: 5,
		};
		const result = normalizePrePromptState(state);
		expect(result.transcriptOffset).toBe(20);
	});

	// Go: state.go: normalizePrePromptState (already-canonical branch; Story 补充)
	it('normalizePrePromptState does NOT migrate when transcriptOffset already set', async () => {
		const state: PrePromptState = {
			sessionId: 'sid-canon',
			untrackedFiles: [],
			transcriptOffset: 20,
			startTime: new Date(0),
			lastTranscriptLineCount: 99,
			stepTranscriptStart: 40,
		};
		const result = normalizePrePromptState(state);
		expect(result.transcriptOffset).toBe(20);
	});

	// Go: state_test.go TestPrePromptState_WithSummaryOnlyTranscript
	// Go asserts `loaded.TranscriptOffset == 2` for a 2-line summary-only
	// transcript — the analyzer returns the JSONL line count (including
	// summary-type entries), and the offset is persisted verbatim.
	it('summary-only transcript yields offset === JSONL line count (matches Go TestPrePromptState_WithSummaryOnlyTranscript)', async () => {
		const fixturePath = path.join(env.dir, 'transcript-summary.jsonl');
		const lines = [
			'{"type":"summary","leafUuid":"leaf-1","summary":"Previous context"}',
			'{"type":"summary","leafUuid":"leaf-2","summary":"More context"}',
		];
		await fs.writeFile(fixturePath, `${lines.join('\n')}\n`);
		const agent = makeAnalyzerAgent({
			getTranscriptPosition: async (p: string) => {
				const raw = await fs.readFile(p, 'utf-8');
				return raw.split('\n').filter(Boolean).length;
			},
		});

		await capturePrePromptState(agent, 'sid-6', fixturePath);

		const loaded = await loadPrePromptState('sid-6');
		expect(loaded?.transcriptOffset).toBe(2);
	});

	// Go: state.go: LoadPrePromptState (missing-file branch; Story 补充)
	it('loadPrePromptState returns null on ENOENT', async () => {
		await expect(loadPrePromptState('nonexistent')).resolves.toBeNull();
	});

	// Go: state.go: LoadPrePromptState (corrupt JSON; Story 补充)
	it('loadPrePromptState throws on corrupt JSON', async () => {
		await fs.mkdir(tmpDirAbs, { recursive: true });
		await fs.writeFile(path.join(tmpDirAbs, 'pre-prompt-corrupt.json'), 'not json');
		await expect(loadPrePromptState('corrupt')).rejects.toThrow(
			/failed to parse pre-prompt state:/,
		);
	});

	// Go: state.go: CleanupPrePromptState (missing-file branch; Story 补充)
	it('cleanupPrePromptState is idempotent on missing file', async () => {
		await expect(cleanupPrePromptState('nonexistent-1')).resolves.toBeUndefined();
		await expect(cleanupPrePromptState('nonexistent-1')).resolves.toBeUndefined();
	});

	// Go: state.go: (*PrePromptState).PreUntrackedFiles (nil-safe; Story 补充)
	it('preUntrackedFiles handles null/undefined state → []', async () => {
		expect(preUntrackedFiles(null)).toEqual([]);
		expect(preUntrackedFiles(undefined)).toEqual([]);
		const state: PrePromptState = {
			sessionId: 'sid-accessor',
			untrackedFiles: ['a', 'b'],
			transcriptOffset: 0,
			startTime: new Date(0),
		};
		expect(preUntrackedFiles(state)).toEqual(['a', 'b']);
	});

	// Go: state.go: LoadPrePromptState (round-trip preserves capture output; agent without TranscriptAnalyzer)
	it('capturePrePromptState with bare agent (no TranscriptAnalyzer) leaves offset = 0', async () => {
		await capturePrePromptState(makeBareAgent(), 'sid-bare', '/path.jsonl');
		const loaded = await loadPrePromptState('sid-bare');
		expect(loaded?.transcriptOffset).toBe(0);
		expect(loaded?.sessionId).toBe('sid-bare');
	});

	// Go: state.go: normalizePrePromptState (startMessageIndex-only fallback; Story 补充)
	it('normalizePrePromptState falls back to startMessageIndex when siblings are 0', async () => {
		const state: PrePromptState = {
			sessionId: 'sid-fallback',
			untrackedFiles: [],
			transcriptOffset: 0,
			startTime: new Date(0),
			stepTranscriptStart: 0,
			lastTranscriptLineCount: 0,
			startMessageIndex: 7,
		};
		const result = normalizePrePromptState(state);
		expect(result.transcriptOffset).toBe(7);
	});

	// Go: state.go: CapturePrePromptState — validation precondition. Empty
	// sessionID falls back to unknownSessionID (also written to disk by Go),
	// not an immediate throw.
	it('capturePrePromptState with empty sessionID → falls back to UNKNOWN_SESSION_ID on disk', async () => {
		await capturePrePromptState(makeBareAgent(), '', '/x.jsonl');
		const raw = await fs.readFile(path.join(tmpDirAbs, 'pre-prompt-unknown.json'), 'utf-8');
		const parsed = JSON.parse(raw) as { session_id: string };
		expect(parsed.session_id).toBe('unknown');
	});

	// Go: state.go: CapturePrePromptState — `validation.ValidateSessionID`
	// rejects path separators with "invalid session ID ...".
	it('capturePrePromptState with path-separator sessionID → throws validate error', async () => {
		await expect(capturePrePromptState(makeBareAgent(), 'sid/evil', '')).rejects.toThrow(
			/invalid session ID for pre-prompt state:/,
		);
		await expect(capturePrePromptState(makeBareAgent(), 'sid\\evil', '')).rejects.toThrow(
			/invalid session ID for pre-prompt state:/,
		);
	});

	// Go: state.go: PrePromptState JSON round-trip (Story 补充 — capture → disk bytes → load).
	// The on-disk bytes must use Go field names (`session_id`, `timestamp`,
	// `untracked_files`, `transcript_offset` omitempty) so a Go binary can
	// read a Story-written file and vice versa.
	it('Go round-trip: fixture written with Go field names loads correctly', async () => {
		await fs.mkdir(tmpDirAbs, { recursive: true });
		const filePath = path.join(tmpDirAbs, 'pre-prompt-sid-rt.json');
		await fs.writeFile(
			filePath,
			`${JSON.stringify(
				{
					session_id: 'sid-rt',
					timestamp: '2026-04-21T08:30:00Z',
					untracked_files: ['a.log'],
					transcript_offset: 42,
					last_transcript_identifier: 'uuid-abc',
				},
				null,
				2,
			)}\n`,
		);

		const loaded = await loadPrePromptState('sid-rt');
		expect(loaded).not.toBeNull();
		expect(loaded?.sessionId).toBe('sid-rt');
		expect(loaded?.untrackedFiles).toEqual(['a.log']);
		expect(loaded?.transcriptOffset).toBe(42);
		expect(loaded?.lastTranscriptIdentifier).toBe('uuid-abc');
		expect(loaded?.startTime.toISOString()).toBe('2026-04-21T08:30:00.000Z');
	});

	// Go: state.go: PrePromptState — `last_transcript_identifier` is an
	// optional metadata field preserved across load (Part 2 TurnEnd uses it).
	it('loadPrePromptState preserves last_transcript_identifier through normalize', async () => {
		await fs.mkdir(tmpDirAbs, { recursive: true });
		await fs.writeFile(
			path.join(tmpDirAbs, 'pre-prompt-sid-lti.json'),
			`${JSON.stringify({
				session_id: 'sid-lti',
				timestamp: '2026-04-21T00:00:00Z',
				untracked_files: [],
				last_transcript_line_count: 10,
				last_transcript_identifier: 'msg-9',
			})}\n`,
		);
		const loaded = await loadPrePromptState('sid-lti');
		expect(loaded?.lastTranscriptIdentifier).toBe('msg-9');
		// normalize should migrate last_transcript_line_count into transcriptOffset
		expect(loaded?.transcriptOffset).toBe(10);
	});

	// Go: state.go: PrePromptState backward-compat — older TS-only snapshots
	// used `start_time` before the Go-alignment fix; load must still honor them.
	it('loadPrePromptState backward-compat: legacy `start_time` field still parsed', async () => {
		await fs.mkdir(tmpDirAbs, { recursive: true });
		await fs.writeFile(
			path.join(tmpDirAbs, 'pre-prompt-sid-legacy.json'),
			`${JSON.stringify({
				session_id: 'sid-legacy',
				start_time: '2024-01-01T00:00:00.000Z',
				untracked_files: [],
			})}\n`,
		);
		const loaded = await loadPrePromptState('sid-legacy');
		expect(loaded?.startTime.toISOString()).toBe('2024-01-01T00:00:00.000Z');
	});

	// Go: state.go: LoadPrePromptState — non-ENOENT read errors must propagate
	// (Go `os.IsNotExist` gate only swallows "not found"; any other error
	// returns `fmt.Errorf("failed to read state file: %w")`).
	it('loadPrePromptState rethrows non-ENOENT fs errors (EACCES)', async () => {
		const eacces = Object.assign(new Error('permission denied'), { code: 'EACCES' });
		vi.mocked(fs.readFile).mockRejectedValueOnce(eacces);
		await expect(loadPrePromptState('sid-eacces')).rejects.toThrow('permission denied');
	});

	it('loadPrePromptState rethrows non-ENOENT fs errors (EISDIR)', async () => {
		const eisdir = Object.assign(new Error('is a directory'), { code: 'EISDIR' });
		vi.mocked(fs.readFile).mockRejectedValueOnce(eisdir);
		await expect(loadPrePromptState('sid-eisdir')).rejects.toThrow('is a directory');
	});

	// Go: state.go LoadPrePromptState — `validation.ValidateSessionID`
	// gate rejects path-separator IDs with `"invalid session ID for
	// pre-prompt state: ..."` BEFORE any filesystem access. Prevents path
	// traversal via crafted IDs like `../../etc/passwd`.
	it('loadPrePromptState rejects path-separator session ID (path traversal guard)', async () => {
		await expect(loadPrePromptState('../evil')).rejects.toThrow(
			/invalid session ID for pre-prompt state: /,
		);
		await expect(loadPrePromptState('sid\\evil')).rejects.toThrow(
			/invalid session ID for pre-prompt state: /,
		);
	});

	it('loadPrePromptState rejects empty session ID', async () => {
		await expect(loadPrePromptState('')).rejects.toThrow(
			/invalid session ID for pre-prompt state: /,
		);
	});

	// Go: state.go CleanupPrePromptState — same validation gate with
	// the `cleanup` suffix on the wrapped error so the call site (which uses
	// `defer Cleanup...(sessionID)`) can disambiguate.
	it('cleanupPrePromptState rejects path-separator session ID (path traversal guard)', async () => {
		await expect(cleanupPrePromptState('../evil')).rejects.toThrow(
			/invalid session ID for pre-prompt state cleanup: /,
		);
		await expect(cleanupPrePromptState('sid/evil')).rejects.toThrow(
			/invalid session ID for pre-prompt state cleanup: /,
		);
	});

	it('cleanupPrePromptState rejects empty session ID', async () => {
		await expect(cleanupPrePromptState('')).rejects.toThrow(
			/invalid session ID for pre-prompt state cleanup: /,
		);
	});
});
