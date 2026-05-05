/**
 * Phase 5.5 restoreLogsOnly + 5 helpers + DEFER(phase-6.1) unit tests.
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/strategy/manual_commit_rewind.go`
 * (`RestoreLogsOnly` + `classifySessionsForRestore` + `ClassifyTimestamps` +
 * `StatusToText` + `PromptOverwriteNewerLogs` + `ResolveAgentForRewind`).
 *
 * Each `it()` is annotated with `// Go: <go-file>:<line>` for the
 * audit-test-go-parity gate.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrNoTranscript } from '@/checkpoint/temporary';
import type {
	CheckpointSummary,
	CommittedMetadata,
	CommittedReader,
	SessionContent,
} from '@/checkpoint/types';
import { clearGitCommonDirCache } from '@/git';
import type { CheckpointID } from '@/id';
import { clearWorktreeRootCache } from '@/paths';
import { ManualCommitStrategy } from '@/strategy/manual-commit';
import {
	classifyTimestamps,
	promptOverwriteNewerLogs,
	resolveAgentForRewind,
	restoreLogsOnlyImpl,
	type SessionRestoreInfo,
	setAgentResolverForTesting,
	setPromptOverwriteForTesting,
	statusToText,
} from '@/strategy/restore-logs';
import type { RewindPoint } from '@/strategy/types';
import { TestEnv } from '../../helpers/test-env';

interface CapturedWritable extends NodeJS.WritableStream {
	captured: string;
}

function makeWritable(): CapturedWritable {
	const stream: CapturedWritable = {
		captured: '',
		write(chunk: string | Uint8Array): boolean {
			stream.captured += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
			return true;
		},
		end(): void {},
		on(): NodeJS.WritableStream {
			return stream;
		},
		once(): NodeJS.WritableStream {
			return stream;
		},
		emit(): boolean {
			return false;
		},
	} as unknown as CapturedWritable;
	return stream;
}

function makeMetadata(overrides: Partial<CommittedMetadata> = {}): CommittedMetadata {
	return {
		checkpointId: 'aabbccddeeff',
		sessionId: 'sess-1',
		strategy: 'manual-commit',
		createdAt: '2026-04-15T10:00:00Z',
		checkpointsCount: 1,
		filesTouched: [],
		agent: 'Claude Code',
		model: '',
		...overrides,
	};
}

function makeSessionContent(
	transcript: string | Uint8Array,
	metaOverrides: Partial<CommittedMetadata> = {},
	prompts = 'first prompt\n\n---\n\nsecond prompt',
): SessionContent {
	const transcriptBytes =
		typeof transcript === 'string' ? new TextEncoder().encode(transcript) : transcript;
	return {
		metadata: makeMetadata(metaOverrides),
		transcript: transcriptBytes,
		prompts,
	};
}

function makeSummary(sessionCount: number): CheckpointSummary {
	const sessions = [];
	for (let i = 0; i < sessionCount; i++) {
		sessions.push({ metadata: `${i}/metadata.json`, prompt: `${i}/prompt.txt` });
	}
	return {
		checkpointId: 'aabbccddeeff',
		strategy: 'manual-commit',
		checkpointsCount: sessionCount,
		filesTouched: [],
		sessions,
	};
}

function makePoint(overrides: Partial<RewindPoint> = {}): RewindPoint {
	return {
		id: 'irrelevant',
		message: 'cp',
		metadataDir: '',
		date: new Date(),
		isTaskCheckpoint: false,
		toolUseId: '',
		isLogsOnly: true,
		checkpointId: 'aabbccddeeff' as CheckpointID,
		agent: 'Claude Code',
		sessionId: 'sess-1',
		sessionPrompt: '',
		sessionCount: 1,
		sessionIds: ['sess-1'],
		sessionPrompts: [],
		...overrides,
	};
}

interface FakeReaderOpts {
	summary: CheckpointSummary | null;
	contents: ReadonlyArray<SessionContent | null | Error>;
}

function makeFakeReader(opts: FakeReaderOpts): CommittedReader {
	return {
		readCommitted: async (_id: string) => opts.summary,
		readSessionContent: async (_id: string, idx: number) => {
			const item = opts.contents[idx];
			if (item instanceof Error) {
				throw item;
			}
			return item ?? null;
		},
		readSessionContentById: async () => null,
		getTranscript: async () => null,
		getSessionLog: async () => null,
	};
}

/**
 * Mock the agent dispatch so happy-path tests can exercise the full 7
 * steps. Replaces the in-module agent resolver with a function returning
 * a fake agent that writes the transcript into a temp dir we control.
 */
function withMockAgent(opts: {
	sessionDir: string;
	resolvedFile?: (sessionDir: string, sessionId: string, transcript: Uint8Array) => string;
	writeImpl?: (input: {
		sessionId: string;
		agentName: string;
		repoRoot: string;
		sessionRef: string;
		nativeData: Uint8Array;
	}) => Promise<void>;
}): void {
	setAgentResolverForTesting(async () => ({
		getSessionDir: async (_repoRoot: string) => opts.sessionDir,
		resolveSessionFile: (dir: string, id: string) => path.join(dir, `${id}.jsonl`),
		resolveRestoredSessionFile: opts.resolvedFile
			? async (dir: string, id: string, transcript: Uint8Array) =>
					opts.resolvedFile!(dir, id, transcript)
			: undefined,
		writeSession: async (input: {
			sessionId: string;
			agentName: string;
			repoRoot: string;
			sessionRef: string;
			nativeData: Uint8Array;
		}) => {
			if (opts.writeImpl) {
				await opts.writeImpl(input);
				return;
			}
			await fs.writeFile(input.sessionRef, input.nativeData);
		},
		type: () => 'Claude Code',
		name: () => 'claude-code',
	}));
}

// Go: manual_commit_rewind.go: RestoreLogsOnly + helpers
describe('strategy/restore-logs — Go: manual_commit_rewind.go', () => {
	let env: TestEnv;

	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		clearGitCommonDirCache();
		clearWorktreeRootCache();
	});

	afterEach(async () => {
		await env.cleanup();
		clearGitCommonDirCache();
		clearWorktreeRootCache();
		vi.restoreAllMocks();
		setAgentResolverForTesting(null);
		setPromptOverwriteForTesting(null);
	});

	// Go: manual_commit_rewind.go: RestoreLogsOnly (main path)
	describe('restoreLogsOnly main path (6 cases)', () => {
		// Go: manual_commit_rewind.go: RestoreLogsOnly (single-session happy path)
		it('happy path single session writes transcript + returns RestoredSession[1] (asserts agentName passed)', async () => {
			const sessDir = await fs.mkdtemp('/tmp/story-restore-logs-');
			try {
				// Capture writeSession input so we can assert agentName parity with Go.
				let captured: {
					sessionId: string;
					agentName: string;
					repoRoot: string;
					sessionRef: string;
					nativeData: Uint8Array;
				} | null = null;
				withMockAgent({
					sessionDir: sessDir,
					writeImpl: async (input) => {
						captured = input;
						await fs.writeFile(input.sessionRef, input.nativeData);
					},
				});
				const reader = makeFakeReader({
					summary: makeSummary(1),
					contents: [makeSessionContent('{"timestamp":"2026-04-15T10:30:00Z"}\n')],
				});
				vi.spyOn(ManualCommitStrategy.prototype, 'getCheckpointStore').mockResolvedValue(
					reader as never,
				);

				const out = makeWritable();
				const err = makeWritable();
				const strategy = new ManualCommitStrategy(env.dir);
				const restored = await restoreLogsOnlyImpl(strategy, out, err, makePoint(), false);

				expect(restored).toHaveLength(1);
				expect(restored[0]?.sessionId).toBe('sess-1');
				expect(out.captured).toContain('Writing transcript to:');
				const written = await fs.readFile(path.join(sessDir, 'sess-1.jsonl'), 'utf-8');
				expect(written).toContain('"2026-04-15T10:30:00Z"');
				// Phase 5.5 review fix: writeSession payload must carry `agentName` (Go
				// `agent.AgentSession.AgentName: sessionAgent.Name()` parity).
				expect(captured).not.toBeNull();
				expect(captured!.agentName).toBe('claude-code');
				expect(captured!.sessionId).toBe('sess-1');
			} finally {
				await fs.rm(sessDir, { recursive: true, force: true });
			}
		});

		// Go: manual_commit_rewind.go: RestoreLogsOnly (multi-session announce)
		it('multi-session writes all + announces "Restoring N sessions from checkpoint:"', async () => {
			const sessDir = await fs.mkdtemp('/tmp/story-restore-logs-');
			try {
				withMockAgent({ sessionDir: sessDir });
				const reader = makeFakeReader({
					summary: makeSummary(3),
					contents: [
						makeSessionContent('a\n', { sessionId: 'sess-a' }),
						makeSessionContent('b\n', { sessionId: 'sess-b' }),
						makeSessionContent('c\n', { sessionId: 'sess-c' }),
					],
				});
				vi.spyOn(ManualCommitStrategy.prototype, 'getCheckpointStore').mockResolvedValue(
					reader as never,
				);

				const out = makeWritable();
				const err = makeWritable();
				const strategy = new ManualCommitStrategy(env.dir);
				const restored = await restoreLogsOnlyImpl(strategy, out, err, makePoint(), false);

				expect(restored).toHaveLength(3);
				expect(out.captured).toContain('Restoring 3 sessions from checkpoint:');
			} finally {
				await fs.rm(sessDir, { recursive: true, force: true });
			}
		});

		// Go: manual_commit_rewind.go: RestoreLogsOnly (validation: !isLogsOnly)
		it('throws "not a logs-only rewind point" when point.isLogsOnly=false', async () => {
			const out = makeWritable();
			const err = makeWritable();
			const strategy = new ManualCommitStrategy(env.dir);
			await expect(
				restoreLogsOnlyImpl(strategy, out, err, makePoint({ isLogsOnly: false }), false),
			).rejects.toThrow('not a logs-only rewind point');
		});

		// Go: manual_commit_rewind.go: RestoreLogsOnly (validation: empty checkpoint id)
		it('throws "missing checkpoint ID" when checkpointId empty', async () => {
			const out = makeWritable();
			const err = makeWritable();
			const strategy = new ManualCommitStrategy(env.dir);
			await expect(
				restoreLogsOnlyImpl(
					strategy,
					out,
					err,
					makePoint({ checkpointId: '' as CheckpointID }),
					false,
				),
			).rejects.toThrow('missing checkpoint ID');
		});

		// Go: manual_commit_rewind.go: RestoreLogsOnly (both stores miss)
		it('throws "checkpoint not found: <cpId>" when both readers return null', async () => {
			const reader = makeFakeReader({ summary: null, contents: [] });
			vi.spyOn(ManualCommitStrategy.prototype, 'getCheckpointStore').mockResolvedValue(
				reader as never,
			);

			const out = makeWritable();
			const err = makeWritable();
			const strategy = new ManualCommitStrategy(env.dir);
			await expect(restoreLogsOnlyImpl(strategy, out, err, makePoint(), false)).rejects.toThrow(
				/checkpoint not found: aabbccddeeff/,
			);
		});

		// Go: manual_commit_rewind.go: RestoreLogsOnly (v2 preference)
		it('prefers v2 reader when isCheckpointsV2Enabled and v2 has checkpoint', async () => {
			const sessDir = await fs.mkdtemp('/tmp/story-restore-logs-');
			try {
				withMockAgent({ sessionDir: sessDir });

				// Force v2-enabled settings.
				const settingsModule = await import('@/settings/settings');
				vi.spyOn(settingsModule, 'isCheckpointsV2Enabled').mockReturnValue(true);

				const v2Reader = makeFakeReader({
					summary: makeSummary(1),
					contents: [makeSessionContent('v2-data\n')],
				});
				const v1Reader = makeFakeReader({
					summary: null,
					contents: [],
				});
				vi.spyOn(ManualCommitStrategy.prototype, 'getCheckpointStore').mockResolvedValue(
					v1Reader as never,
				);
				vi.spyOn(ManualCommitStrategy.prototype, 'getV2CheckpointStore').mockResolvedValue(
					v2Reader as never,
				);

				const v2Spy = vi.spyOn(v2Reader, 'readSessionContent');
				const v1Spy = vi.spyOn(v1Reader, 'readSessionContent');

				const out = makeWritable();
				const err = makeWritable();
				const strategy = new ManualCommitStrategy(env.dir);
				const restored = await restoreLogsOnlyImpl(strategy, out, err, makePoint(), true);
				expect(restored).toHaveLength(1);
				// v2 was the picked reader.
				expect(v2Spy).toHaveBeenCalled();
				expect(v1Spy).not.toHaveBeenCalled();
			} finally {
				await fs.rm(sessDir, { recursive: true, force: true });
			}
		});
	});

	// Go: manual_commit_rewind.go: RestoreLogsOnly (force gate + TTY prompt)
	describe('force=false / TTY prompt (3 cases)', () => {
		it('force=true skips classify + prompt', async () => {
			const sessDir = await fs.mkdtemp('/tmp/story-restore-logs-');
			try {
				withMockAgent({ sessionDir: sessDir });

				const reader = makeFakeReader({
					summary: makeSummary(1),
					contents: [makeSessionContent('a\n')],
				});
				vi.spyOn(ManualCommitStrategy.prototype, 'getCheckpointStore').mockResolvedValue(
					reader as never,
				);
				let promptCalled = false;
				setPromptOverwriteForTesting(async () => {
					promptCalled = true;
					return false;
				});

				const out = makeWritable();
				const err = makeWritable();
				const strategy = new ManualCommitStrategy(env.dir);
				await restoreLogsOnlyImpl(strategy, out, err, makePoint(), true);
				expect(promptCalled).toBe(false);
			} finally {
				await fs.rm(sessDir, { recursive: true, force: true });
			}
		});

		it('force=false + LocalNewer + user picks N → returns [] and prints "Resume cancelled."', async () => {
			const sessDir = await fs.mkdtemp('/tmp/story-restore-logs-');
			try {
				// Local file has newer timestamp than the checkpoint transcript.
				await fs.writeFile(
					path.join(sessDir, 'sess-1.jsonl'),
					'{"timestamp":"2026-04-15T10:45:00Z"}\n',
				);
				withMockAgent({ sessionDir: sessDir });
				setPromptOverwriteForTesting(async () => false);

				const reader = makeFakeReader({
					summary: makeSummary(1),
					contents: [makeSessionContent('{"timestamp":"2026-04-15T10:30:00Z"}\n')],
				});
				vi.spyOn(ManualCommitStrategy.prototype, 'getCheckpointStore').mockResolvedValue(
					reader as never,
				);

				const out = makeWritable();
				const err = makeWritable();
				const strategy = new ManualCommitStrategy(env.dir);
				const restored = await restoreLogsOnlyImpl(strategy, out, err, makePoint(), false);
				expect(restored).toEqual([]);
				expect(out.captured).toContain('Resume cancelled. Local session logs preserved.');
			} finally {
				await fs.rm(sessDir, { recursive: true, force: true });
			}
		});

		it('force=false + LocalNewer + user picks Y → continues to write', async () => {
			const sessDir = await fs.mkdtemp('/tmp/story-restore-logs-');
			try {
				await fs.writeFile(
					path.join(sessDir, 'sess-1.jsonl'),
					'{"timestamp":"2026-04-15T10:45:00Z"}\n',
				);
				withMockAgent({ sessionDir: sessDir });
				setPromptOverwriteForTesting(async () => true);

				const reader = makeFakeReader({
					summary: makeSummary(1),
					contents: [makeSessionContent('{"timestamp":"2026-04-15T10:30:00Z"}\n')],
				});
				vi.spyOn(ManualCommitStrategy.prototype, 'getCheckpointStore').mockResolvedValue(
					reader as never,
				);

				const out = makeWritable();
				const err = makeWritable();
				const strategy = new ManualCommitStrategy(env.dir);
				const restored = await restoreLogsOnlyImpl(strategy, out, err, makePoint(), false);
				expect(restored).toHaveLength(1);
			} finally {
				await fs.rm(sessDir, { recursive: true, force: true });
			}
		});
	});

	// Go: manual_commit_rewind.go: RestoreLogsOnly (best-effort error handling)
	describe('best-effort error handling + DEFER (4 cases)', () => {
		it('skips session with ErrNoTranscript without warning', async () => {
			const sessDir = await fs.mkdtemp('/tmp/story-restore-logs-');
			try {
				withMockAgent({ sessionDir: sessDir });
				const reader = makeFakeReader({
					summary: makeSummary(2),
					contents: [
						new ErrNoTranscript('missing transcript'),
						makeSessionContent('a\n', { sessionId: 'sess-2' }),
					],
				});
				vi.spyOn(ManualCommitStrategy.prototype, 'getCheckpointStore').mockResolvedValue(
					reader as never,
				);

				const out = makeWritable();
				const err = makeWritable();
				const strategy = new ManualCommitStrategy(env.dir);
				const restored = await restoreLogsOnlyImpl(strategy, out, err, makePoint(), true);
				expect(restored).toHaveLength(1);
				expect(restored[0]?.sessionId).toBe('sess-2');
				expect(err.captured).not.toContain('Warning: failed to read session');
			} finally {
				await fs.rm(sessDir, { recursive: true, force: true });
			}
		});

		it('skips session with empty transcript', async () => {
			const sessDir = await fs.mkdtemp('/tmp/story-restore-logs-');
			try {
				withMockAgent({ sessionDir: sessDir });
				const reader = makeFakeReader({
					summary: makeSummary(2),
					contents: [
						makeSessionContent(new Uint8Array(0), { sessionId: 'sess-1' }),
						makeSessionContent('content\n', { sessionId: 'sess-2' }),
					],
				});
				vi.spyOn(ManualCommitStrategy.prototype, 'getCheckpointStore').mockResolvedValue(
					reader as never,
				);

				const out = makeWritable();
				const err = makeWritable();
				const strategy = new ManualCommitStrategy(env.dir);
				const restored = await restoreLogsOnlyImpl(strategy, out, err, makePoint(), true);
				// Only sess-2 has content.
				expect(restored).toHaveLength(1);
				expect(restored[0]?.sessionId).toBe('sess-2');
			} finally {
				await fs.rm(sessDir, { recursive: true, force: true });
			}
		});

		it('warns and skips session with empty agent metadata', async () => {
			withMockAgent({ sessionDir: '/tmp' });
			const reader = makeFakeReader({
				summary: makeSummary(1),
				contents: [makeSessionContent('a\n', { agent: '' })],
			});
			vi.spyOn(ManualCommitStrategy.prototype, 'getCheckpointStore').mockResolvedValue(
				reader as never,
			);

			const out = makeWritable();
			const err = makeWritable();
			const strategy = new ManualCommitStrategy(env.dir);
			const restored = await restoreLogsOnlyImpl(strategy, out, err, makePoint(), true);
			expect(restored).toEqual([]);
			expect(err.captured).toContain('has no agent metadata, skipping');
		});

		// Go: manual_commit_rewind.go: RestoreLogsOnly (DEFER stub behavior)
		it('DEFER path: agent registry unavailable → all sessions skipped with warn', async () => {
			// NO mockAgent — let the real Phase 5.5 stub throw.
			const reader = makeFakeReader({
				summary: makeSummary(2),
				contents: [
					makeSessionContent('a\n', { sessionId: 'sess-a' }),
					makeSessionContent('b\n', { sessionId: 'sess-b' }),
				],
			});
			vi.spyOn(ManualCommitStrategy.prototype, 'getCheckpointStore').mockResolvedValue(
				reader as never,
			);

			const out = makeWritable();
			const err = makeWritable();
			const strategy = new ManualCommitStrategy(env.dir);
			const restored = await restoreLogsOnlyImpl(strategy, out, err, makePoint(), true);
			expect(restored).toEqual([]);
			expect(err.captured).toContain('has unknown agent');
			// Both sessions report.
			expect(err.captured.match(/has unknown agent/g)?.length).toBe(2);
		});
	});

	// Go: manual_commit_rewind.go (helpers)
	describe('helper functions (3 cases)', () => {
		// Go: rewind_test.go:206 TestResolveAgentForRewind. Note: the Go test
		// table verifies registered agents (ClaudeCode/Cursor) succeed; this TS
		// case asserts the **complementary** path — Story-side `''` early throw
		// + production registry-miss → null. The success path is exercised by
		// the "registered agent (Vogon)" case below.
		it('resolveAgentForRewind: empty throws, unknown agent returns null', async () => {
			await expect(resolveAgentForRewind('' as never)).rejects.toThrow('agent type is empty');
			expect(await resolveAgentForRewind('Nonexistent Agent' as never)).toBeNull();
			expect(await resolveAgentForRewind('Claude Code')).toBeNull();
		});

		// Phase 6.1 Part 2 #99: Vogon (registered via bootstrap) → returns the agent.
		// Phase 6.3 polish: bootstrap explicitly (was: side-effect import).
		it('resolveAgentForRewind: registered agent (Vogon) returns the RewindAgent', async () => {
			const { registerBuiltinAgents } = await import('@/agent/bootstrap');
			const { withTestRegistry } = await import('@/agent/registry');
			await withTestRegistry(async () => {
				registerBuiltinAgents();
				// 'Vogon Agent' is excluded from the strict AgentType union (it's a
				// test-only label), so cast to AgentType for the dispatch call.
				const ag = await resolveAgentForRewind('Vogon Agent' as never);
				expect(ag).not.toBeNull();
				// Vogon's name() is 'vogon' (lowercase) and type() is 'Vogon Agent';
				// resolveAgentForRewind dispatches by type, returns the agent.
				expect(ag?.type()).toBe('Vogon Agent');
				expect(ag?.name()).toBe('vogon');
			});
		});

		// Phase 6.1 Part 2 #100: empty registry (withTestRegistry) → null.
		it('resolveAgentForRewind: empty registry returns null for any agent type', async () => {
			const { withTestRegistry } = await import('@/agent/registry');
			await withTestRegistry(async () => {
				expect(await resolveAgentForRewind('Vogon Agent' as never)).toBeNull();
				expect(await resolveAgentForRewind('Claude Code')).toBeNull();
			});
		});

		// Go: manual_commit_rewind.go: ClassifyTimestamps (4 outcomes table-driven)
		it('classifyTimestamps 4 outcomes', () => {
			expect(classifyTimestamps(null, new Date('2026-04-15'))).toBe('new');
			expect(classifyTimestamps(new Date('2026-04-15'), null)).toBe('new');
			expect(classifyTimestamps(new Date('2026-04-15'), new Date('2026-04-15'))).toBe('unchanged');
			expect(classifyTimestamps(new Date('2026-04-16'), new Date('2026-04-15'))).toBe(
				'local-newer',
			);
			expect(classifyTimestamps(new Date('2026-04-15'), new Date('2026-04-16'))).toBe(
				'checkpoint-newer',
			);
		});

		// Go: manual_commit_rewind.go: StatusToText (4 cases via ts-pattern)
		it('statusToText uses ts-pattern.match (no switch) and returns Go-equivalent labels', () => {
			expect(statusToText('new')).toBe('(new)');
			expect(statusToText('unchanged')).toBe('(unchanged)');
			expect(statusToText('checkpoint-newer')).toBe('(checkpoint is newer)');
			expect(statusToText('local-newer')).toBe('(local is newer)');
		});
	});

	// Go: manual_commit_rewind.go: RestoreLogsOnly — RestoredSessionPathResolver branch
	it('multi-session uses resolveRestoredSessionFile when provided + writes per-session announce', async () => {
		const sessDir = await fs.mkdtemp('/tmp/story-restore-logs-');
		try {
			withMockAgent({
				sessionDir: sessDir,
				resolvedFile: (dir: string, id: string) => path.join(dir, `${id}.resolved.jsonl`),
			});

			const reader = makeFakeReader({
				summary: makeSummary(2),
				contents: [
					makeSessionContent('a\n', { sessionId: 'sess-a' }),
					makeSessionContent('b\n', { sessionId: 'sess-b' }),
				],
			});
			vi.spyOn(ManualCommitStrategy.prototype, 'getCheckpointStore').mockResolvedValue(
				reader as never,
			);

			const out = makeWritable();
			const err = makeWritable();
			const strategy = new ManualCommitStrategy(env.dir);
			const restored = await restoreLogsOnlyImpl(strategy, out, err, makePoint(), true);
			expect(restored).toHaveLength(2);
			// Multi-session announce + per-session prompt + Writing to lines.
			expect(out.captured).toContain('Restoring 2 sessions from checkpoint:');
			expect(out.captured).toContain('Session 1:');
			expect(out.captured).toContain('Session 2 (latest):');
			expect(out.captured).toContain('.resolved.jsonl');
		} finally {
			await fs.rm(sessDir, { recursive: true, force: true });
		}
	});

	// Go: manual_commit_rewind.go: RestoreLogsOnly (multi-session write failure → warn + continue)
	it('multi-session write failure: warns and continues to next session', async () => {
		const sessDir = await fs.mkdtemp('/tmp/story-restore-logs-');
		try {
			let attempt = 0;
			withMockAgent({
				sessionDir: sessDir,
				writeImpl: async () => {
					attempt++;
					if (attempt === 1) {
						throw new Error('disk full');
					}
				},
			});

			const reader = makeFakeReader({
				summary: makeSummary(2),
				contents: [
					makeSessionContent('a\n', { sessionId: 'sess-fail' }),
					makeSessionContent('b\n', { sessionId: 'sess-ok' }),
				],
			});
			vi.spyOn(ManualCommitStrategy.prototype, 'getCheckpointStore').mockResolvedValue(
				reader as never,
			);

			const out = makeWritable();
			const err = makeWritable();
			const strategy = new ManualCommitStrategy(env.dir);
			const restored = await restoreLogsOnlyImpl(strategy, out, err, makePoint(), true);
			// Only the second one succeeded.
			expect(restored).toHaveLength(1);
			expect(restored[0]?.sessionId).toBe('sess-ok');
			expect(err.captured).toContain('Warning: failed to write session: disk full');
		} finally {
			await fs.rm(sessDir, { recursive: true, force: true });
		}
	});

	// Go: manual_commit_rewind.go: RestoreLogsOnly (single-session write failure → throw)
	it('single-session write failure: throws wrapped error', async () => {
		withMockAgent({
			sessionDir: '/tmp',
			writeImpl: async () => {
				throw new Error('disk full');
			},
		});

		const reader = makeFakeReader({
			summary: makeSummary(1),
			contents: [makeSessionContent('a\n', { sessionId: 'sess-1' })],
		});
		vi.spyOn(ManualCommitStrategy.prototype, 'getCheckpointStore').mockResolvedValue(
			reader as never,
		);

		const out = makeWritable();
		const err = makeWritable();
		const strategy = new ManualCommitStrategy(env.dir);
		await expect(restoreLogsOnlyImpl(strategy, out, err, makePoint(), true)).rejects.toThrow(
			/failed to write session: disk full/,
		);
	});

	// Go: manual_commit_rewind.go: RestoreLogsOnly (read session content non-ErrNoTranscript err)
	it('warns and skips on non-ErrNoTranscript readSessionContent failure', async () => {
		withMockAgent({ sessionDir: '/tmp' });
		const reader = makeFakeReader({
			summary: makeSummary(1),
			contents: [new Error('git read failed')],
		});
		vi.spyOn(ManualCommitStrategy.prototype, 'getCheckpointStore').mockResolvedValue(
			reader as never,
		);

		const out = makeWritable();
		const err = makeWritable();
		const strategy = new ManualCommitStrategy(env.dir);
		const restored = await restoreLogsOnlyImpl(strategy, out, err, makePoint(), true);
		expect(restored).toEqual([]);
		expect(err.captured).toContain('Warning: failed to read session 0: git read failed');
	});

	// Go: manual_commit_rewind.go: PromptOverwriteNewerLogs (format)
	it('promptOverwriteNewerLogs writes warning lines + per-session conflict summary', async () => {
		const conflicting: SessionRestoreInfo = {
			sessionId: 'sess-conflict',
			prompt: 'edit foo',
			status: 'local-newer',
			localTime: new Date('2026-04-15T10:45:00Z'),
			checkpointTime: new Date('2026-04-15T10:30:00Z'),
		};
		const newSession: SessionRestoreInfo = {
			sessionId: 'sess-new',
			prompt: 'add bar',
			status: 'new',
			localTime: null,
			checkpointTime: new Date('2026-04-15T10:30:00Z'),
		};

		// Default test mode → askYesNoTTY returns defaultYes (false) → don't overwrite.
		process.env.STORY_TEST_TTY = '1';
		try {
			const err = makeWritable();
			const result = await promptOverwriteNewerLogs(err, [conflicting, newSession]);
			expect(result).toBe(false);
			expect(err.captured).toContain(
				'Warning: Local session log(s) have newer entries than the checkpoint:',
			);
			expect(err.captured).toContain('"edit foo"');
			expect(err.captured).toContain('Local last entry:');
			expect(err.captured).toContain('Checkpoint last entry:');
			expect(err.captured).toContain('These other session(s) will also be restored:');
			expect(err.captured).toContain('"add bar" (new)');
			expect(err.captured).toContain('Overwriting will lose the newer local entries.');
			// Phase 5.5 review fix: TTY prompt is binary Y/n (no [a]lways option) to
			// match Go `huh.NewConfirm()`. The pre-fix `askConfirmTTY` exposed
			// `[a]lways` which silently mapped to "don't overwrite" — surprising UX.
			expect(err.captured).not.toContain('[a]lways');
			expect(err.captured).not.toContain('always');
		} finally {
			delete process.env.STORY_TEST_TTY;
		}
	});
});
