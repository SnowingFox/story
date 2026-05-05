/**
 * Phase 7 Part 1 `src/lifecycle/pre-task-state.ts` — 15 case.
 *
 * Go 参考：`cmd/entire/cli/state_test.go: TestPreTaskStateFile` +
 * `TestFindActivePreTaskFile`. Story 补充 cases cover null-safety,
 * parse-failure, idempotent cleanup, two `findActivePreTaskFile`
 * filtering branches (non-matching filenames; empty toolUseId), validation
 * preconditions (empty id / invalid format), Go round-trip compatibility,
 * and non-ENOENT load errors.
 *
 * Each `it()` is annotated with `// Go: <anchor>` for traceability.
 */

// `node:fs/promises` is mocked with the real module re-exported as the default
// implementation. Only `readdir` / `stat` / `readFile` get wrapped in `vi.fn()`
// so individual tests can swap them out via `vi.mocked(fs.readdir).mockRejectedValueOnce(...)`
// while every other test (capture / load / cleanup / round-trip) still hits the
// real filesystem through the spread.
vi.mock('node:fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs/promises')>();
	return {
		...actual,
		readdir: vi.fn(actual.readdir),
		stat: vi.fn(actual.stat),
		readFile: vi.fn(actual.readFile),
	};
});

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	capturePreTaskState,
	cleanupPreTaskState,
	findActivePreTaskFile,
	loadPreTaskState,
	PRE_TASK_FILE_PREFIX,
	type PreTaskState,
	preTaskUntrackedFiles,
} from '@/lifecycle/pre-task-state';
import * as log from '@/log';
import { clearWorktreeRootCache } from '@/paths';
import { TestEnv } from '../../helpers/test-env';

describe('lifecycle/pre-task-state', () => {
	let env: TestEnv;
	let tmpDirAbs: string;

	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		tmpDirAbs = path.join(env.dir, '.story/tmp');
		clearWorktreeRootCache();
		const paths = await import('@/paths');
		vi.spyOn(paths, 'worktreeRoot').mockResolvedValue(env.dir);
		const fileChanges = await import('@/lifecycle/file-changes');
		vi.spyOn(fileChanges, 'getUntrackedFilesForState').mockResolvedValue([]);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		clearWorktreeRootCache();
		await env.cleanup();
	});

	// Go: state_test.go: TestPreTaskStateFile (atomic write + 0o600 + snake_case)
	it('capturePreTaskState writes atomic JSON with mode 0o600', async () => {
		await capturePreTaskState('toolu_abc123');
		const filePath = path.join(tmpDirAbs, `${PRE_TASK_FILE_PREFIX}toolu_abc123.json`);
		const stat = await fs.stat(filePath);
		expect(stat.isFile()).toBe(true);
		if (process.platform !== 'win32') {
			expect(stat.mode & 0o777).toBe(0o600);
		}
		const parsed = JSON.parse(await fs.readFile(filePath, 'utf-8')) as Record<string, unknown>;
		// Go round-trip: tool_use_id + timestamp + untracked_files.
		// `start_time` must NOT be present (that was the pre-fix TS field name).
		expect(parsed).toHaveProperty('tool_use_id', 'toolu_abc123');
		expect(parsed).toHaveProperty('timestamp');
		expect(parsed).toHaveProperty('untracked_files');
		expect(parsed).not.toHaveProperty('start_time');

		const entries = await fs.readdir(tmpDirAbs);
		expect(entries.filter((e) => e.endsWith('.tmp'))).toEqual([]);
	});

	// Go: state_test.go: TestPreTaskStateFile (untracked seeded via getUntrackedFilesForState)
	it('capturePreTaskState seeds untracked files via getUntrackedFilesForState', async () => {
		const fileChanges = await import('@/lifecycle/file-changes');
		vi.mocked(fileChanges.getUntrackedFilesForState).mockResolvedValue(['foo.log', 'bar.tmp']);

		await capturePreTaskState('toolu_xyz');
		const parsed = JSON.parse(
			await fs.readFile(path.join(tmpDirAbs, 'pre-task-toolu_xyz.json'), 'utf-8'),
		) as { untracked_files: string[] };
		expect(parsed.untracked_files).toEqual(['foo.log', 'bar.tmp']);
	});

	// Go: state_test.go: TestPreTaskStateFile (round-trip)
	it('loadPreTaskState reads + deserializes round-trip', async () => {
		const fileChanges = await import('@/lifecycle/file-changes');
		vi.mocked(fileChanges.getUntrackedFilesForState).mockResolvedValue(['a.log']);
		await capturePreTaskState('toolu_rt');

		const loaded = await loadPreTaskState('toolu_rt');
		expect(loaded).not.toBeNull();
		expect(loaded?.toolUseId).toBe('toolu_rt');
		expect(loaded?.untrackedFiles).toEqual(['a.log']);
		expect(loaded?.startTime).toBeInstanceOf(Date);
	});

	// Go: state.go: LoadPreTaskState (missing-file; Story 补充)
	it('loadPreTaskState returns null on ENOENT', async () => {
		await expect(loadPreTaskState('does-not-exist')).resolves.toBeNull();
	});

	// Go: state.go: LoadPreTaskState (parse-failure; Story 补充)
	it('loadPreTaskState throws on corrupt JSON', async () => {
		await fs.mkdir(tmpDirAbs, { recursive: true });
		await fs.writeFile(path.join(tmpDirAbs, 'pre-task-corrupt.json'), 'not json');
		await expect(loadPreTaskState('corrupt')).rejects.toThrow(/failed to parse pre-task state:/);
	});

	// Go: state.go: CleanupPreTaskState (idempotent; Story 补充)
	it('cleanupPreTaskState is idempotent on missing file', async () => {
		await expect(cleanupPreTaskState('nope')).resolves.toBeUndefined();
		await expect(cleanupPreTaskState('nope')).resolves.toBeUndefined();
	});

	// Go: state_test.go: TestFindActivePreTaskFile (tmp dir missing → {found: false})
	it('findActivePreTaskFile returns {found: false} when tmp dir missing', async () => {
		const result = await findActivePreTaskFile();
		expect(result).toEqual({ found: false, toolUseId: '' });
	});

	// Go: state_test.go: TestFindActivePreTaskFile (most-recent-mtime wins)
	it('findActivePreTaskFile returns most-recent mtime when multiple exist', async () => {
		await fs.mkdir(tmpDirAbs, { recursive: true });
		const stalePath = path.join(tmpDirAbs, 'pre-task-stale.json');
		const middlePath = path.join(tmpDirAbs, 'pre-task-middle.json');
		const freshPath = path.join(tmpDirAbs, 'pre-task-fresh.json');
		await fs.writeFile(stalePath, '{}');
		await fs.writeFile(middlePath, '{}');
		await fs.writeFile(freshPath, '{}');

		const now = Date.now() / 1000;
		await fs.utimes(stalePath, now - 600, now - 600); // 10 min ago
		await fs.utimes(middlePath, now - 300, now - 300); // 5 min ago
		await fs.utimes(freshPath, now, now);

		const result = await findActivePreTaskFile();
		expect(result).toEqual({ found: true, toolUseId: 'fresh' });
	});

	// Go: state_test.go: TestFindActivePreTaskFile (non-matching filenames skipped)
	it('findActivePreTaskFile skips non-matching filenames', async () => {
		await fs.mkdir(tmpDirAbs, { recursive: true });
		await fs.writeFile(path.join(tmpDirAbs, 'random.json'), '{}');
		await fs.writeFile(path.join(tmpDirAbs, 'pre-task-.json'), '{}'); // empty toolUseId
		await fs.writeFile(path.join(tmpDirAbs, 'pre-task-foo.txt'), '{}'); // wrong extension
		await fs.writeFile(path.join(tmpDirAbs, 'pre-task-valid.json'), '{}');
		await fs.utimes(
			path.join(tmpDirAbs, 'pre-task-valid.json'),
			Date.now() / 1000,
			Date.now() / 1000,
		);

		const result = await findActivePreTaskFile();
		expect(result).toEqual({ found: true, toolUseId: 'valid' });
	});

	// Go: state.go: (*PreTaskState).PreUntrackedFiles (nil-safe; Story 补充)
	it('preTaskUntrackedFiles null-safe', async () => {
		expect(preTaskUntrackedFiles(null)).toEqual([]);
		expect(preTaskUntrackedFiles(undefined)).toEqual([]);
		const state: PreTaskState = {
			toolUseId: 't',
			untrackedFiles: ['a', 'b'],
			startTime: new Date(0),
		};
		expect(preTaskUntrackedFiles(state)).toEqual(['a', 'b']);
	});

	// Go: state_test.go: TestFindActivePreTaskFile (tmp dir present but no matches; Story 补充)
	it('findActivePreTaskFile returns {found: false} when dir present but no matching files', async () => {
		await fs.mkdir(tmpDirAbs, { recursive: true });
		await fs.writeFile(path.join(tmpDirAbs, 'random.json'), '{}');
		await fs.writeFile(path.join(tmpDirAbs, 'pre-task-.json'), '{}');
		await fs.writeFile(path.join(tmpDirAbs, 'pre-task-x.txt'), '{}');

		const result = await findActivePreTaskFile();
		expect(result).toEqual({ found: false, toolUseId: '' });
	});

	// Go: state.go FindActivePreTaskFile — `os.ReadDir` errors of
	// any kind (ENOENT, EACCES, EMFILE, …) silently return `("", false)`.
	// TS mirrors this: non-ENOENT readdir failures fall through the catch
	// block without logging. Subagent-context detection is a lookup
	// heuristic, not a fault signal.
	it('findActivePreTaskFile readdir non-ENOENT error silently returns {found:false} (no log)', async () => {
		await fs.mkdir(tmpDirAbs, { recursive: true });
		const eaccess = Object.assign(new Error('permission denied'), { code: 'EACCES' });
		vi.mocked(fs.readdir).mockRejectedValueOnce(eaccess);
		const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});

		const result = await findActivePreTaskFile();

		expect(result).toEqual({ found: false, toolUseId: '' });
		expect(warnSpy).not.toHaveBeenCalled();
		warnSpy.mockRestore();
	});

	// Go: state.go: FindActivePreTaskFile — entry.Info() failure for one entry
	// causes that entry to be skipped while the loop continues to evaluate the
	// rest. TS uses `fs.stat`; per-entry stat failure is `continue`.
	it('findActivePreTaskFile skips entries whose stat fails + still picks valid ones', async () => {
		await fs.mkdir(tmpDirAbs, { recursive: true });
		const failingPath = path.join(tmpDirAbs, 'pre-task-fails.json');
		const validPath = path.join(tmpDirAbs, 'pre-task-valid.json');
		await fs.writeFile(failingPath, '{}');
		await fs.writeFile(validPath, '{}');
		const now = Date.now() / 1000;
		await fs.utimes(validPath, now, now);

		// Make `fs.stat(failingPath)` reject the next call; subsequent calls
		// (the valid file's stat) hit the original spread implementation.
		vi.mocked(fs.stat).mockImplementationOnce(async () => {
			throw Object.assign(new Error('stat boom'), { code: 'EIO' });
		});

		const result = await findActivePreTaskFile();
		expect(result).toEqual({ found: true, toolUseId: 'valid' });
	});

	// Go: state.go: CapturePreTaskState — empty toolUseID hard-errors with
	// `errors.New("tool_use_id is required")` (no fallback).
	it('capturePreTaskState throws on empty toolUseID', async () => {
		await expect(capturePreTaskState('')).rejects.toThrow('tool_use_id is required');
	});

	// Go: state.go: CapturePreTaskState — `validation.ValidateToolUseID`
	// rejects non-alphanumeric/underscore/hyphen characters.
	it('capturePreTaskState throws on invalid-format toolUseID', async () => {
		await expect(capturePreTaskState('invalid!!format')).rejects.toThrow(
			/invalid tool use ID for pre-task state:/,
		);
	});

	// Go: state.go: PreTaskState JSON round-trip (Story 补充 — fixture with Go
	// field names loads correctly; ensures a Go binary can read a Story file).
	it('Go round-trip: fixture written with Go field names loads correctly', async () => {
		await fs.mkdir(tmpDirAbs, { recursive: true });
		const filePath = path.join(tmpDirAbs, 'pre-task-toolu_rt.json');
		await fs.writeFile(
			filePath,
			`${JSON.stringify(
				{
					tool_use_id: 'toolu_rt',
					timestamp: '2026-04-21T08:30:00Z',
					untracked_files: ['a.log'],
				},
				null,
				2,
			)}\n`,
		);

		const loaded = await loadPreTaskState('toolu_rt');
		expect(loaded).not.toBeNull();
		expect(loaded?.toolUseId).toBe('toolu_rt');
		expect(loaded?.untrackedFiles).toEqual(['a.log']);
		expect(loaded?.startTime.toISOString()).toBe('2026-04-21T08:30:00.000Z');
	});

	// Go: state.go: PreTaskState backward-compat — older TS-only snapshots
	// used `start_time` before the Go-alignment fix; load must still honor them.
	it('loadPreTaskState backward-compat: legacy `start_time` field still parsed', async () => {
		await fs.mkdir(tmpDirAbs, { recursive: true });
		await fs.writeFile(
			path.join(tmpDirAbs, 'pre-task-toolu_legacy.json'),
			`${JSON.stringify({
				tool_use_id: 'toolu_legacy',
				start_time: '2024-01-01T00:00:00.000Z',
				untracked_files: [],
			})}\n`,
		);
		const loaded = await loadPreTaskState('toolu_legacy');
		expect(loaded?.startTime.toISOString()).toBe('2024-01-01T00:00:00.000Z');
	});

	// Go: state.go: LoadPreTaskState — non-ENOENT read errors must propagate.
	it('loadPreTaskState rethrows non-ENOENT fs errors (EACCES)', async () => {
		const eacces = Object.assign(new Error('permission denied'), { code: 'EACCES' });
		vi.mocked(fs.readFile).mockRejectedValueOnce(eacces);
		await expect(loadPreTaskState('toolu_eacces')).rejects.toThrow('permission denied');
	});

	it('loadPreTaskState rethrows non-ENOENT fs errors (EISDIR)', async () => {
		const eisdir = Object.assign(new Error('is a directory'), { code: 'EISDIR' });
		vi.mocked(fs.readFile).mockRejectedValueOnce(eisdir);
		await expect(loadPreTaskState('toolu_eisdir')).rejects.toThrow('is a directory');
	});

	// Go: state.go LoadPreTaskState — `validation.ValidateToolUseID`
	// gate rejects invalid-format IDs (e.g. with `..` path traversal) with
	// `"invalid tool use ID for pre-task state: ..."` BEFORE any filesystem
	// access.
	it('loadPreTaskState rejects invalid-format tool use ID (path traversal guard)', async () => {
		await expect(loadPreTaskState('../evil')).rejects.toThrow(
			/invalid tool use ID for pre-task state: /,
		);
		await expect(loadPreTaskState('toolu\\evil')).rejects.toThrow(
			/invalid tool use ID for pre-task state: /,
		);
	});

	// Go: state.go CleanupPreTaskState — same validation gate with the
	// `cleanup` suffix on the wrapped error so the `defer Cleanup...`
	// callsite can disambiguate from load-time failures.
	it('cleanupPreTaskState rejects invalid-format tool use ID (path traversal guard)', async () => {
		await expect(cleanupPreTaskState('../evil')).rejects.toThrow(
			/invalid tool use ID for pre-task state cleanup: /,
		);
		await expect(cleanupPreTaskState('toolu/evil')).rejects.toThrow(
			/invalid tool use ID for pre-task state cleanup: /,
		);
	});
});
