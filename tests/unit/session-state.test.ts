import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	isStale,
	isStuckActive,
	normalizeAfterLoad,
	type SessionState,
	StateStore,
} from '@/session/state-store';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;

function newState(overrides: Partial<SessionState> = {}): SessionState {
	return {
		sessionId: 'test-session',
		baseCommit: 'abc1234567890',
		startedAt: new Date().toISOString(),
		phase: 'idle',
		stepCount: 0,
		...overrides,
	};
}

describe('normalizeAfterLoad', () => {
	it('migrates all legacy fields', () => {
		// Legacy: condensed_transcript_lines + active_committed phase + missing attribution_base_commit.
		const state = newState({
			phase: 'active_committed' as SessionState['phase'],
			baseCommit: 'def456',
			// Cast to allow legacy field access:
			...({ condensedTranscriptLines: 150 } as unknown as Partial<SessionState>),
		});
		normalizeAfterLoad(state);
		expect(state.phase).toBe('active');
		expect(state.checkpointTranscriptStart).toBe(150);
		expect((state as unknown as Record<string, unknown>).condensedTranscriptLines).toBe(0);
		expect(state.attributionBaseCommit).toBe('def456');
	});

	it('JSON roundtrip — old condensed_transcript_lines migrates', () => {
		const json =
			'{"session_id":"x","base_commit":"abc","started_at":"2026-01-01T00:00:00.000Z","phase":"idle","checkpoint_count":0,"condensed_transcript_lines":42}';
		const parsed = JSON.parse(json) as Record<string, unknown>;
		// Map snake_case → camelCase manually for this minimal fixture (impl will use zod).
		const state: SessionState = {
			sessionId: parsed.session_id as string,
			baseCommit: parsed.base_commit as string,
			startedAt: parsed.started_at as string,
			phase: parsed.phase as SessionState['phase'],
			stepCount: parsed.checkpoint_count as number,
			...({ condensedTranscriptLines: parsed.condensed_transcript_lines } as Partial<SessionState>),
		};
		normalizeAfterLoad(state);
		expect(state.checkpointTranscriptStart).toBe(42);
	});

	it('does not override checkpointTranscriptStart when already set', () => {
		const state = newState({
			checkpointTranscriptStart: 200,
			...({ condensedTranscriptLines: 150 } as unknown as Partial<SessionState>),
		});
		normalizeAfterLoad(state);
		expect(state.checkpointTranscriptStart).toBe(200);
	});

	it('migrates transcriptLinesAtStart when condensedTranscriptLines is absent', () => {
		const state = newState({
			...({ transcriptLinesAtStart: 75 } as unknown as Partial<SessionState>),
		});
		normalizeAfterLoad(state);
		expect(state.checkpointTranscriptStart).toBe(75);
	});

	it('preserves compactTranscriptStart', () => {
		const state = newState({ compactTranscriptStart: 9 });
		normalizeAfterLoad(state);
		expect(state.compactTranscriptStart).toBe(9);
	});
});

describe('isStale', () => {
	it('falls back to startedAt when lastInteractionTime is absent', () => {
		const old = new Date(Date.now() - 48 * ONE_DAY_MS).toISOString();
		const state = newState({ startedAt: old });
		expect(isStale(state)).toBe(true);
	});

	it('recent startedAt with no lastInteraction is not stale', () => {
		const recent = new Date(Date.now() - ONE_HOUR_MS).toISOString();
		const state = newState({ startedAt: recent });
		expect(isStale(state)).toBe(false);
	});

	it('recent lastInteraction is not stale', () => {
		const state = newState({
			startedAt: new Date(Date.now() - 30 * ONE_DAY_MS).toISOString(),
			lastInteractionTime: new Date(Date.now() - ONE_HOUR_MS).toISOString(),
		});
		expect(isStale(state)).toBe(false);
	});

	it('old lastInteraction is stale (overrides recent startedAt)', () => {
		const state = newState({
			startedAt: new Date().toISOString(),
			lastInteractionTime: new Date(Date.now() - 14 * ONE_DAY_MS).toISOString(),
		});
		expect(isStale(state)).toBe(true);
	});

	it('just under threshold (7 days minus 1 hour) is not stale', () => {
		const state = newState({
			lastInteractionTime: new Date(Date.now() - (7 * ONE_DAY_MS - ONE_HOUR_MS)).toISOString(),
		});
		expect(isStale(state)).toBe(false);
	});
});

describe('isStuckActive', () => {
	it('returns true for active + >1h since interaction', () => {
		const state = newState({
			phase: 'active',
			lastInteractionTime: new Date(Date.now() - 2 * ONE_HOUR_MS).toISOString(),
		});
		expect(isStuckActive(state)).toBe(true);
	});

	it('returns false for recent interaction', () => {
		const state = newState({
			phase: 'active',
			lastInteractionTime: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
		});
		expect(isStuckActive(state)).toBe(false);
	});

	it('returns false for non-active phase', () => {
		const state = newState({
			phase: 'idle',
			lastInteractionTime: new Date(Date.now() - 10 * ONE_HOUR_MS).toISOString(),
		});
		expect(isStuckActive(state)).toBe(false);
	});

	it('falls back to startedAt for active session without lastInteraction', () => {
		const state = newState({
			phase: 'active',
			startedAt: new Date(Date.now() - 2 * ONE_HOUR_MS).toISOString(),
		});
		expect(isStuckActive(state)).toBe(true);
	});
});

describe('StateStore', () => {
	let stateDir: string;
	let store: StateStore;

	beforeEach(async () => {
		const raw = await fs.mkdtemp(path.join(os.tmpdir(), 'story-state-'));
		stateDir = await fs.realpath(raw);
		store = new StateStore(stateDir);
	});

	afterEach(async () => {
		await fs.rm(stateDir, { recursive: true, force: true });
	});

	describe('Load', () => {
		it('returns null for missing session', async () => {
			const result = await store.load('does-not-exist');
			expect(result).toBeNull();
		});

		it('returns null for nonexistent state directory', async () => {
			const fakeStore = new StateStore('/nonexistent/path/that/does/not/exist');
			const result = await fakeStore.load('some-session');
			expect(result).toBeNull();
		});

		it('rejects path traversal session IDs', async () => {
			await expect(store.load('../escape')).rejects.toThrow();
			await expect(store.load('foo/bar')).rejects.toThrow();
		});

		it('deletes stale session and returns null', async () => {
			const state = newState({
				sessionId: 'stale-one',
				lastInteractionTime: new Date(Date.now() - 14 * ONE_DAY_MS).toISOString(),
			});
			await store.save(state);
			const result = await store.load('stale-one');
			expect(result).toBeNull();
			// File should be removed.
			await expect(fs.access(path.join(stateDir, 'stale-one.json'))).rejects.toThrow();
		});

		it('deletes stale session with nil lastInteraction (uses startedAt)', async () => {
			const state = newState({
				sessionId: 'stale-no-interaction',
				startedAt: new Date(Date.now() - 48 * ONE_DAY_MS).toISOString(),
			});
			await store.save(state);
			const result = await store.load('stale-no-interaction');
			expect(result).toBeNull();
		});
	});

	describe('Save', () => {
		it('writes a session state file (atomic)', async () => {
			const state = newState({ sessionId: 'fresh' });
			await store.save(state);
			const filePath = path.join(stateDir, 'fresh.json');
			const content = await fs.readFile(filePath, 'utf-8');
			expect(content).toContain('fresh');
		});

		it('round-trips save/load', async () => {
			const original = newState({
				sessionId: 'roundtrip',
				baseCommit: 'aaa111',
				phase: 'active',
				stepCount: 3,
				filesTouched: ['src/a.ts', 'src/b.ts'],
			});
			await store.save(original);
			const loaded = await store.load('roundtrip');
			expect(loaded).not.toBeNull();
			expect(loaded?.sessionId).toBe('roundtrip');
			expect(loaded?.baseCommit).toBe('aaa111');
			expect(loaded?.phase).toBe('active');
			expect(loaded?.stepCount).toBe(3);
			expect(loaded?.filesTouched).toEqual(['src/a.ts', 'src/b.ts']);
		});

		it('round-trips Story turn duration metrics', async () => {
			const original = newState({
				sessionId: 'turn-metrics',
				activeDurationMs: 45_000,
				turnMetrics: [
					{
						turnId: 'turn-1',
						startedAt: '2026-04-27T10:00:00.000Z',
						endedAt: '2026-04-27T10:00:30.000Z',
						durationMs: 30_000,
					},
					{
						turnId: 'turn-2',
						startedAt: '2026-04-27T10:01:00.000Z',
						endedAt: '2026-04-27T10:01:15.000Z',
						durationMs: 15_000,
					},
				],
			});

			await store.save(original);

			const content = await fs.readFile(path.join(stateDir, 'turn-metrics.json'), 'utf-8');
			expect(content).toContain('"active_duration_ms": 45000');
			expect(content).toContain('"turn_metrics"');
			expect(content).not.toContain('activeDurationMs');
			const loaded = await store.load('turn-metrics');
			expect(loaded?.activeDurationMs).toBe(45_000);
			expect(loaded?.turnMetrics).toEqual(original.turnMetrics);
		});

		it('uses checkpoint_count as JSON key for stepCount (Go compat)', async () => {
			const state = newState({ sessionId: 'json-keys', stepCount: 7 });
			await store.save(state);
			const content = await fs.readFile(path.join(stateDir, 'json-keys.json'), 'utf-8');
			expect(content).toContain('checkpoint_count');
			expect(content).not.toContain('stepCount');
		});

		it('rejects path traversal session IDs', async () => {
			const bad = newState({ sessionId: '../escape' });
			await expect(store.save(bad)).rejects.toThrow();
		});

		it('creates state directory if missing', async () => {
			await fs.rm(stateDir, { recursive: true, force: true });
			const state = newState({ sessionId: 'new-dir' });
			await store.save(state);
			const content = await fs.readFile(path.join(stateDir, 'new-dir.json'), 'utf-8');
			expect(content).toBeTruthy();
		});
	});

	describe('Clear', () => {
		it('removes session file', async () => {
			const state = newState({ sessionId: 'to-clear' });
			await store.save(state);
			await store.clear('to-clear');
			await expect(fs.access(path.join(stateDir, 'to-clear.json'))).rejects.toThrow();
		});

		it('removes sidecar files (.model hint, etc.)', async () => {
			const state = newState({ sessionId: 'with-sidecar' });
			await store.save(state);
			// Drop a sidecar manually:
			await fs.writeFile(path.join(stateDir, 'with-sidecar.model'), 'gpt-4');
			await store.clear('with-sidecar');
			await expect(fs.access(path.join(stateDir, 'with-sidecar.json'))).rejects.toThrow();
			await expect(fs.access(path.join(stateDir, 'with-sidecar.model'))).rejects.toThrow();
		});

		it('does not throw for nonexistent session or directory', async () => {
			await expect(store.clear('never-existed')).resolves.toBeUndefined();
			const fakeStore = new StateStore('/nonexistent/path');
			await expect(fakeStore.clear('any')).resolves.toBeUndefined();
		});
	});

	describe('List', () => {
		it('returns empty array for empty directory', async () => {
			const list = await store.list();
			expect(list).toEqual([]);
		});

		it('returns empty array for nonexistent directory', async () => {
			const fakeStore = new StateStore('/nonexistent/path/x');
			const list = await fakeStore.list();
			expect(list).toEqual([]);
		});

		it('lists all session states', async () => {
			await store.save(newState({ sessionId: 's1' }));
			await store.save(newState({ sessionId: 's2' }));
			const list = await store.list();
			expect(list.map((s) => s.sessionId).sort()).toEqual(['s1', 's2']);
		});

		it('auto-deletes stale sessions during list', async () => {
			await store.save(
				newState({
					sessionId: 'stale-list',
					lastInteractionTime: new Date(Date.now() - 14 * ONE_DAY_MS).toISOString(),
				}),
			);
			await store.save(newState({ sessionId: 'fresh-list' }));
			const list = await store.list();
			expect(list.map((s) => s.sessionId)).toEqual(['fresh-list']);
			await expect(fs.access(path.join(stateDir, 'stale-list.json'))).rejects.toThrow();
		});

		it('skips .tmp temp files', async () => {
			await fs.writeFile(path.join(stateDir, 'partial.json.tmp'), '{}');
			await store.save(newState({ sessionId: 'real-one' }));
			const list = await store.list();
			expect(list.map((s) => s.sessionId)).toEqual(['real-one']);
		});

		it('skips corrupted JSON files', async () => {
			await fs.writeFile(path.join(stateDir, 'broken.json'), '{not valid json');
			await store.save(newState({ sessionId: 'good-one' }));
			const list = await store.list();
			expect(list.map((s) => s.sessionId)).toEqual(['good-one']);
		});
	});

	describe('RemoveAll', () => {
		it('removes the entire state directory', async () => {
			await store.save(newState({ sessionId: 's' }));
			await store.removeAll();
			await expect(fs.access(stateDir)).rejects.toThrow();
		});

		it('does not throw if directory missing', async () => {
			await fs.rm(stateDir, { recursive: true, force: true });
			await expect(store.removeAll()).resolves.toBeUndefined();
		});
	});

	describe('full-fidelity roundtrip', () => {
		it('serializes and re-parses every field', async () => {
			const original: SessionState = {
				sessionId: 'full',
				cliVersion: '0.1.0',
				baseCommit: 'aaaaaaaa',
				attributionBaseCommit: 'bbbbbbbb',
				worktreePath: '/path/to/repo',
				worktreeId: 'wt-1',
				startedAt: new Date().toISOString(),
				endedAt: new Date().toISOString(),
				phase: 'active',
				turnId: 't-1',
				turnCheckpointIds: ['ck1', 'ck2'],
				lastInteractionTime: new Date().toISOString(),
				stepCount: 5,
				checkpointTranscriptStart: 100,
				checkpointTranscriptSize: 12345,
				compactTranscriptStart: 50,
				filesTouched: ['a.ts', 'b.ts'],
				untrackedFilesAtStart: ['x.tmp'],
				lastCheckpointId: 'a3b2c4d5e6f7',
				fullyCondensed: true,
				attachedManually: true,
				agentType: 'Claude Code',
				modelName: 'claude-sonnet-4',
				tokenUsage: {
					inputTokens: 100,
					cacheCreationTokens: 50,
					cacheReadTokens: 200,
					outputTokens: 300,
					apiCallCount: 7,
					subagentTokens: {
						inputTokens: 10,
						cacheCreationTokens: 0,
						cacheReadTokens: 0,
						outputTokens: 5,
						apiCallCount: 1,
					},
				},
				sessionDurationMs: 60000,
				sessionTurnCount: 3,
				contextTokens: 5000,
				contextWindowSize: 100000,
				transcriptIdentifierAtStart: 'uuid-123',
				transcriptPath: '/path/to/transcript.jsonl',
				lastPrompt: 'fix the bug',
				promptAttributions: [
					{
						checkpointNumber: 1,
						userLinesAdded: 0,
						userLinesRemoved: 0,
						agentLinesAdded: 0,
						agentLinesRemoved: 0,
					},
					{
						checkpointNumber: 2,
						userLinesAdded: 10,
						userLinesRemoved: 5,
						agentLinesAdded: 100,
						agentLinesRemoved: 20,
						userAddedPerFile: { 'a.ts': 5 },
						userRemovedPerFile: { 'b.ts': 2 },
					},
				],
				pendingPromptAttribution: {
					checkpointNumber: 3,
					userLinesAdded: 1,
					userLinesRemoved: 0,
					agentLinesAdded: 0,
					agentLinesRemoved: 0,
				},
			};

			await store.save(original);
			const loaded = await store.load('full');
			expect(loaded).not.toBeNull();
			expect(loaded?.cliVersion).toBe('0.1.0');
			expect(loaded?.attributionBaseCommit).toBe('bbbbbbbb');
			expect(loaded?.worktreePath).toBe('/path/to/repo');
			expect(loaded?.turnCheckpointIds).toEqual(['ck1', 'ck2']);
			expect(loaded?.lastCheckpointId).toBe('a3b2c4d5e6f7');
			expect(loaded?.fullyCondensed).toBe(true);
			expect(loaded?.attachedManually).toBe(true);
			expect(loaded?.tokenUsage?.outputTokens).toBe(300);
			expect(loaded?.tokenUsage?.subagentTokens?.outputTokens).toBe(5);
			expect(loaded?.contextWindowSize).toBe(100000);
			expect(loaded?.lastPrompt).toBe('fix the bug');
			expect(loaded?.promptAttributions?.length).toBe(2);
			expect(loaded?.promptAttributions?.[1]?.userAddedPerFile?.['a.ts']).toBe(5);
			expect(loaded?.pendingPromptAttribution?.checkpointNumber).toBe(3);
		});

		it('skips directory entries during list', async () => {
			await fs.mkdir(path.join(stateDir, 'subdir.json'), { recursive: true });
			await store.save(newState({ sessionId: 'real' }));
			const list = await store.list();
			// `subdir.json` is a directory not a file — readFile will error and load returns null;
			// either way the list should contain only "real".
			expect(list.map((s) => s.sessionId)).toContain('real');
		});

		it('rejects path-traversal name in clear', async () => {
			await expect(store.clear('../escape')).rejects.toThrow();
		});
	});

	describe('symlinked state directory', () => {
		it('save/load/clear works through a symlink', async () => {
			const link = `${stateDir}-link`;
			await fs.symlink(stateDir, link, 'dir');
			try {
				const linkedStore = new StateStore(link);
				await linkedStore.save(newState({ sessionId: 'via-link' }));
				const loaded = await linkedStore.load('via-link');
				expect(loaded?.sessionId).toBe('via-link');
				await linkedStore.clear('via-link');
				await expect(fs.access(path.join(stateDir, 'via-link.json'))).rejects.toThrow();
			} finally {
				await fs.unlink(link);
			}
		});
	});
});
