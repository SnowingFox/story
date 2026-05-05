/**
 * Phase 7 Part 2 `src/lifecycle/handlers/subagent-end.ts` — 18 case.
 *
 * Go 参考：`cmd/entire/cli/lifecycle.go handleLifecycleSubagentEnd`.
 * Go has no direct unit test; the 18 cases cover the 8-step orchestration
 * mirrored by the TS handler (fallback parse → subagent transcript path →
 * analyzer merge → pre-task state + change detection → no-change skip →
 * checkpoint UUID → saveTaskStep → cleanup) and gate ≥ 6 failure paths.
 *
 * TS-divergence from Go (documented inline in handler source):
 *
 * 1. `asTranscriptAnalyzer` returns the `[T, true] | [null, false]` tuple
 *    (Go returns `(T, bool)`). The handler destructures and gates on the
 *    boolean; the mock here supplies the same shape.
 * 2. `ManualCommitStrategy` is `new ManualCommitStrategy()` (Go
 *    `GetStrategy(ctx)`) — hoisted `saveTaskStepMock` is injected onto the
 *    constructed instance.
 * 3. `filterAndNormalizePaths` and `mergeUnique` run through their REAL
 *    implementations (partial mock with `vi.importActual`) so case 10 can
 *    assert that `.story/*` paths are actually dropped end-to-end.
 * 4. `parseTranscriptForCheckpointUUID` is Part 1's `null`-return stub;
 *    Part 2 upgrades are covered under `dispatch.test.ts`. Tests mock it
 *    as needed for cases 12-13.
 *
 * @packageDocumentation
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Event } from '@/agent/event';
import type { Agent, TranscriptAnalyzer } from '@/agent/interfaces';
import { AGENT_NAME_CLAUDE_CODE, AGENT_TYPE_CLAUDE_CODE, type AgentName } from '@/agent/types';
import * as log from '@/log';

// Hoisted mocks so `vi.mock` factories (hoisted above imports) can reference
// them. Matches the `transition.test.ts` / `session-end.test.ts` pattern.
const saveTaskStepMock = vi.hoisted(() => vi.fn(async () => {}));
// TS-divergence from Go: `vi.spyOn(fs, 'existsSync')` fails in ESM
// ('Module namespace is not configurable'). Mock the whole `node:fs`
// module instead, preserving real exports via `vi.importActual` for
// any fs util the handler / its deps may touch.
const existsSyncMock = vi.hoisted(() => vi.fn((_path: unknown): boolean => true));
vi.mock('node:fs', async () => {
	const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
	return {
		...actual,
		existsSync: existsSyncMock,
		default: { ...actual, existsSync: existsSyncMock },
	};
});

vi.mock('@/lifecycle/subagent-input', () => ({
	parseSubagentTypeAndDescription: vi.fn(() => ['', '']),
}));
vi.mock('@/lifecycle/agent-transcript-path', () => ({
	agentTranscriptPath: vi.fn((dir: string, id: string) => `${dir}/agent-${id}.jsonl`),
}));
vi.mock('@/lifecycle/pre-task-state', () => ({
	loadPreTaskState: vi.fn(async () => null),
	cleanupPreTaskState: vi.fn(async () => {}),
	preTaskUntrackedFiles: vi.fn(() => []),
}));
vi.mock('@/lifecycle/file-changes', async () => {
	const actual = await vi.importActual<typeof import('@/lifecycle/file-changes')>(
		'@/lifecycle/file-changes',
	);
	return {
		...actual,
		detectFileChanges: vi.fn(async () => ({ modified: [], new: [], deleted: [] })),
	};
});
vi.mock('@/lifecycle/dispatch-helpers', async () => {
	const actual = await vi.importActual<typeof import('@/lifecycle/dispatch-helpers')>(
		'@/lifecycle/dispatch-helpers',
	);
	return {
		...actual,
		parseTranscriptForCheckpointUUID: vi.fn(async () => null),
	};
});
vi.mock('@/agent/claude-code/transcript', () => ({
	findCheckpointUUID: vi.fn(() => null),
}));
vi.mock('@/agent/capabilities', () => ({
	asTranscriptAnalyzer: vi.fn(() => [null, false]),
}));
vi.mock('@/git', () => ({
	getGitAuthor: vi.fn(async () => ({ name: 'Test User', email: 'test@example.com' })),
}));
vi.mock('@/paths', async () => {
	const actual = await vi.importActual<typeof import('@/paths')>('@/paths');
	return {
		...actual,
		worktreeRoot: vi.fn(async () => '/tmp/test-repo'),
	};
});
vi.mock('@/strategy/manual-commit', () => ({
	ManualCommitStrategy: vi.fn().mockImplementation(() => ({ saveTaskStep: saveTaskStepMock })),
}));

import { asTranscriptAnalyzer } from '@/agent/capabilities';
import { findCheckpointUUID } from '@/agent/claude-code/transcript';
import { getGitAuthor } from '@/git';
import { agentTranscriptPath } from '@/lifecycle/agent-transcript-path';
import { parseTranscriptForCheckpointUUID } from '@/lifecycle/dispatch-helpers';
import { detectFileChanges } from '@/lifecycle/file-changes';
import { handleSubagentEnd } from '@/lifecycle/handlers/subagent-end';
import {
	cleanupPreTaskState,
	loadPreTaskState,
	preTaskUntrackedFiles,
} from '@/lifecycle/pre-task-state';
import { parseSubagentTypeAndDescription } from '@/lifecycle/subagent-input';

function makeEvent(overrides: Partial<Event> = {}): Event {
	return {
		type: 'SubagentEnd',
		sessionId: 'sid-1',
		previousSessionId: '',
		sessionRef: '/tmp/session.jsonl',
		prompt: '',
		model: '',
		timestamp: new Date(0),
		toolUseId: 'toolu_abc',
		subagentId: 'sub-1',
		toolInput: null,
		subagentType: '',
		taskDescription: '',
		modifiedFiles: [],
		responseMessage: '',
		durationMs: 0,
		turnCount: 0,
		contextTokens: 0,
		contextWindowSize: 0,
		metadata: {},
		...overrides,
	};
}

function makeAgent(name: AgentName = AGENT_NAME_CLAUDE_CODE): Agent {
	return {
		name: () => name,
		type: () => AGENT_TYPE_CLAUDE_CODE,
	} as Agent;
}

/** Tiny analyzer stub — only implements the one method the handler calls. */
function makeAnalyzer(files: string[] | Error): TranscriptAnalyzer {
	return {
		extractModifiedFilesFromOffset: vi.fn(async (_path: string, _offset: number) => {
			if (files instanceof Error) {
				throw files;
			}
			return { files, currentPosition: 0 };
		}),
	} as unknown as TranscriptAnalyzer;
}

describe('lifecycle/handlers/subagent-end', () => {
	beforeEach(() => {
		vi.mocked(parseSubagentTypeAndDescription).mockReset().mockReturnValue(['', '']);
		vi.mocked(agentTranscriptPath)
			.mockReset()
			.mockImplementation((dir: string, id: string) =>
				dir && id ? `${dir}/agent-${id}.jsonl` : '',
			);
		vi.mocked(loadPreTaskState).mockReset().mockResolvedValue(null);
		vi.mocked(cleanupPreTaskState).mockReset().mockResolvedValue();
		vi.mocked(preTaskUntrackedFiles).mockReset().mockReturnValue([]);
		vi.mocked(detectFileChanges)
			.mockReset()
			.mockResolvedValue({ modified: [], new: [], deleted: [] });
		vi.mocked(parseTranscriptForCheckpointUUID).mockReset().mockResolvedValue(null);
		vi.mocked(findCheckpointUUID).mockReset().mockReturnValue(null);
		vi.mocked(asTranscriptAnalyzer).mockReset().mockReturnValue([null, false]);
		vi.mocked(getGitAuthor)
			.mockReset()
			.mockResolvedValue({ name: 'Test User', email: 'test@example.com' });
		saveTaskStepMock.mockReset().mockResolvedValue(undefined);
		existsSyncMock.mockReset().mockReturnValue(true);
	});

	afterEach(() => {
		// Use `clearAllMocks` (not `restoreAllMocks`) so hoisted factory
		// bindings — `ManualCommitStrategy` → `saveTaskStepMock`,
		// `node:fs` → `existsSyncMock` — survive across tests. Beforeach
		// re-arms each mock's implementation.
		vi.clearAllMocks();
	});

	// Case 1 — Step 1 fallback. When both subagentType + taskDescription are
	// empty, parseSubagentTypeAndDescription is invoked with `event.toolInput`
	// and its tuple is written back onto the event.
	// Go: lifecycle.go handleLifecycleSubagentEnd Step 1 (fallback parse)
	it('fallback parses subagent_type + description when both empty', async () => {
		const toolInput = new TextEncoder().encode(
			JSON.stringify({ subagent_type: 'coder', description: 'fix lint' }),
		);
		vi.mocked(parseSubagentTypeAndDescription).mockReturnValue(['coder', 'fix lint']);
		const ev = makeEvent({
			subagentType: '',
			taskDescription: '',
			toolInput,
			modifiedFiles: ['src/a.ts'],
		});

		await handleSubagentEnd(makeAgent(), ev);

		expect(parseSubagentTypeAndDescription).toHaveBeenCalledTimes(1);
		expect(parseSubagentTypeAndDescription).toHaveBeenCalledWith(toolInput);
		expect(ev.subagentType).toBe('coder');
		expect(ev.taskDescription).toBe('fix lint');
	});

	// Case 2 — Step 1 skip when already populated.
	// Go: lifecycle.go handleLifecycleSubagentEnd Step 1 (skip branch)
	it('no fallback when already set', async () => {
		const ev = makeEvent({
			subagentType: 'coder',
			taskDescription: 'existing',
			modifiedFiles: ['src/a.ts'],
		});

		await handleSubagentEnd(makeAgent(), ev);

		expect(parseSubagentTypeAndDescription).not.toHaveBeenCalled();
		expect(ev.subagentType).toBe('coder');
		expect(ev.taskDescription).toBe('existing');
	});

	// Case 3 — Step 2 transcript resolution (file exists).
	// Go: lifecycle.go handleLifecycleSubagentEnd Step 2 (subagent transcript path)
	it('subagent transcript resolved when file exists', async () => {
		existsSyncMock.mockReturnValue(true);
		const ev = makeEvent({
			sessionRef: '/tmp/session.jsonl',
			subagentId: 'sub-1',
			modifiedFiles: ['src/a.ts'],
		});

		await handleSubagentEnd(makeAgent(), ev);

		expect(saveTaskStepMock).toHaveBeenCalledTimes(1);
		const [ctx] = (saveTaskStepMock.mock.calls[0] ?? []) as unknown as [
			{ subagentTranscriptPath: string },
		];
		expect(ctx.subagentTranscriptPath).toBe('/tmp/agent-sub-1.jsonl');
	});

	// Case 4 — Step 2 empty when agentId blank.
	// Go: lifecycle.go `if event.SubagentID != ""` guard (else branch)
	it('subagent transcript empty when agentId empty', async () => {
		const ev = makeEvent({
			sessionRef: '/tmp/session.jsonl',
			subagentId: '',
			modifiedFiles: ['src/a.ts'],
		});

		await handleSubagentEnd(makeAgent(), ev);

		expect(saveTaskStepMock).toHaveBeenCalledTimes(1);
		const [ctx] = (saveTaskStepMock.mock.calls[0] ?? []) as unknown as [
			{ subagentTranscriptPath: string },
		];
		expect(ctx.subagentTranscriptPath).toBe('');
	});

	// Case 5 — Step 2 empty when candidate file missing on disk.
	// Go: lifecycle.go `if !fileExists(subagentTranscriptPath)` fallthrough
	it('subagent transcript empty when file missing', async () => {
		existsSyncMock.mockReturnValue(false);
		const ev = makeEvent({
			sessionRef: '/tmp/session.jsonl',
			subagentId: 'sub-1',
			modifiedFiles: ['src/a.ts'],
		});

		await handleSubagentEnd(makeAgent(), ev);

		expect(saveTaskStepMock).toHaveBeenCalledTimes(1);
		const [ctx] = (saveTaskStepMock.mock.calls[0] ?? []) as unknown as [
			{ subagentTranscriptPath: string },
		];
		expect(ctx.subagentTranscriptPath).toBe('');
	});

	// Case 6 — Step 3 analyzer merge keeps event.modifiedFiles order first
	// then appends only analyzer-unique entries (mergeUnique contract).
	// Go: lifecycle.go handleLifecycleSubagentEnd Step 3 (analyzer merge)
	it('modifiedFiles seeded from event + merged with analyzer output', async () => {
		const analyzer = makeAnalyzer(['b', 'a']);
		vi.mocked(asTranscriptAnalyzer).mockReturnValue([analyzer, true]);
		const ev = makeEvent({ modifiedFiles: ['a'] });

		await handleSubagentEnd(makeAgent(), ev);

		expect(saveTaskStepMock).toHaveBeenCalledTimes(1);
		const [ctx] = (saveTaskStepMock.mock.calls[0] ?? []) as unknown as [
			{ modifiedFiles: string[] },
		];
		expect(ctx.modifiedFiles).toEqual(['a', 'b']);
	});

	// Case 7 — Step 3 analyzer failure leaves event.modifiedFiles untouched
	// Go: lifecycle.go handleLifecycleSubagentEnd Step 3 (log.warn + keep)
	// and emits a `log.warn`.
	it('analyzer failure → modifiedFiles from event only + log.warn', async () => {
		const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
		const analyzer = makeAnalyzer(new Error('analyzer boom'));
		vi.mocked(asTranscriptAnalyzer).mockReturnValue([analyzer, true]);
		const ev = makeEvent({ modifiedFiles: ['a'] });

		await handleSubagentEnd(makeAgent(), ev);

		expect(saveTaskStepMock).toHaveBeenCalledTimes(1);
		const [ctx] = (saveTaskStepMock.mock.calls[0] ?? []) as unknown as [
			{ modifiedFiles: string[] },
		];
		expect(ctx.modifiedFiles).toEqual(['a']);
		expect(warnSpy).toHaveBeenCalledWith(
			expect.any(Object),
			'failed to extract modified files from subagent',
			expect.objectContaining({ error: 'analyzer boom' }),
		);
	});

	// Case 8 — Step 4 `loadPreTaskState` rejection → `preState === null`
	// Go: lifecycle.go handleLifecycleSubagentEnd Step 4 (load swallow)
	// + warn-log + handler still reaches `saveTaskStep`.
	it('loadPreTaskState failure → preState null + log.warn + continues', async () => {
		const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
		vi.mocked(loadPreTaskState).mockRejectedValue(new Error('load crash'));
		const ev = makeEvent({ modifiedFiles: ['src/a.ts'] });

		await handleSubagentEnd(makeAgent(), ev);

		expect(warnSpy).toHaveBeenCalledWith(
			expect.any(Object),
			'failed to load pre-task state',
			expect.objectContaining({ error: 'load crash' }),
		);
		expect(saveTaskStepMock).toHaveBeenCalledTimes(1);
	});

	// Case 9 — Step 4 `detectFileChanges` rejection → `changes === null`;
	// Go: lifecycle.go handleLifecycleSubagentEnd Step 4 (detect swallow)
	// modifiedFiles fall back to Step 3; relNewFiles + relDeletedFiles empty.
	it('detectFileChanges null → modifiedFiles from Step 3 only; new/deleted empty', async () => {
		const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
		vi.mocked(detectFileChanges).mockRejectedValue(new Error('status crash'));
		const ev = makeEvent({ modifiedFiles: ['src/a.ts'] });

		await handleSubagentEnd(makeAgent(), ev);

		expect(warnSpy).toHaveBeenCalledWith(
			expect.any(Object),
			'failed to compute file changes',
			expect.objectContaining({ error: 'status crash' }),
		);
		expect(saveTaskStepMock).toHaveBeenCalledTimes(1);
		const [ctx] = (saveTaskStepMock.mock.calls[0] ?? []) as unknown as [
			{ modifiedFiles: string[]; newFiles: string[]; deletedFiles: string[] },
		];
		expect(ctx.modifiedFiles).toEqual(['src/a.ts']);
		expect(ctx.newFiles).toEqual([]);
		expect(ctx.deletedFiles).toEqual([]);
	});

	// Case 10 — Step 4 `filterAndNormalizePaths` actually drops `.story/*`
	// Go: lifecycle.go handleLifecycleSubagentEnd Step 4 (filter+normalize)
	// entries from all three buckets (real implementation via partial mock).
	it('all 3 arrays filterAndNormalizePaths-ed', async () => {
		vi.mocked(detectFileChanges).mockResolvedValue({
			modified: ['.story/m', 'src/b.ts'],
			new: ['.story/n', 'src/c.ts'],
			deleted: ['.story/d', 'src/e.ts'],
		});
		const ev = makeEvent({ modifiedFiles: ['.story/foo', 'src/a.ts'] });

		await handleSubagentEnd(makeAgent(), ev);

		expect(saveTaskStepMock).toHaveBeenCalledTimes(1);
		const [ctx] = (saveTaskStepMock.mock.calls[0] ?? []) as unknown as [
			{ modifiedFiles: string[]; newFiles: string[]; deletedFiles: string[] },
		];
		expect(ctx.modifiedFiles).toEqual(['src/a.ts', 'src/b.ts']);
		expect(ctx.newFiles).toEqual(['src/c.ts']);
		expect(ctx.deletedFiles).toEqual(['src/e.ts']);
	});

	// Case 11 — Step 5 no-changes skip.
	// Go: lifecycle.go handleLifecycleSubagentEnd Step 5 (skip branch)
	// All three buckets empty → info-log + cleanup + return early.
	// `saveTaskStep` must NOT be invoked.
	it('no-changes → cleanup + return; saveTaskStep NOT called', async () => {
		const infoSpy = vi.spyOn(log, 'info').mockImplementation(() => {});
		const ev = makeEvent({ modifiedFiles: [] });

		await handleSubagentEnd(makeAgent(), ev);

		expect(saveTaskStepMock).not.toHaveBeenCalled();
		expect(cleanupPreTaskState).toHaveBeenCalledWith('toolu_abc');
		expect(infoSpy).toHaveBeenCalledWith(
			expect.any(Object),
			'no file changes detected, skipping task checkpoint',
		);
	});

	// Case 12 — Step 6 UUID success path.
	// Go: lifecycle.go handleLifecycleSubagentEnd Step 6 (parseTranscript + FindCheckpointUUID)
	// `parseTranscriptForCheckpointUUID` returns scanned lines; `findCheckpointUUID`
	// matches the toolUseId and returns `'uuid-1'`.
	it('checkpoint UUID resolves via parseTranscript + findCheckpointUUID', async () => {
		const mainLines = [{ uuid: 'uuid-1' }] as unknown[];
		vi.mocked(parseTranscriptForCheckpointUUID).mockResolvedValue(mainLines);
		vi.mocked(findCheckpointUUID).mockReturnValue('uuid-1');
		const ev = makeEvent({ modifiedFiles: ['src/a.ts'] });

		await handleSubagentEnd(makeAgent(), ev);

		expect(saveTaskStepMock).toHaveBeenCalledTimes(1);
		const [ctx] = (saveTaskStepMock.mock.calls[0] ?? []) as unknown as [{ checkpointUuid: string }];
		expect(ctx.checkpointUuid).toBe('uuid-1');
	});

	// Case 13 — Step 6 fail-open: parseTranscript reject AND findCheckpointUUID
	// Go: lifecycle.go `mainLines, _ := parseTranscriptForCheckpointUUID(...)` errcheck nolint
	// null both fall through to `checkpointUuid === ''` without throwing.
	it('checkpoint UUID fails open → empty string', async () => {
		vi.mocked(parseTranscriptForCheckpointUUID).mockRejectedValue(new Error('parse crash'));
		const ev = makeEvent({ modifiedFiles: ['src/a.ts'] });

		await expect(handleSubagentEnd(makeAgent(), ev)).resolves.toBeUndefined();

		expect(saveTaskStepMock).toHaveBeenCalledTimes(1);
		const [ctx] = (saveTaskStepMock.mock.calls[0] ?? []) as unknown as [{ checkpointUuid: string }];
		expect(ctx.checkpointUuid).toBe('');
	});

	// Case 14 — Step 7 hard-fail: `getGitAuthor` rejection propagates
	// Go: lifecycle.go handleLifecycleSubagentEnd Step 7 (GetGitAuthor error wrap)
	// (Go parity; `return fmt.Errorf("failed to get git author: %w", err)`).
	it('getGitAuthor failure → throw propagates', async () => {
		vi.mocked(getGitAuthor).mockRejectedValue(new Error('git config crash'));
		const ev = makeEvent({ modifiedFiles: ['src/a.ts'] });

		await expect(handleSubagentEnd(makeAgent(), ev)).rejects.toThrow(/git config crash/);
		expect(saveTaskStepMock).not.toHaveBeenCalled();
	});

	// Case 15 — Step 7 happy path: saveTaskStep receives the 14-field
	// Go: lifecycle.go handleLifecycleSubagentEnd Step 7 (TaskStepContext assembly)
	// TaskStepContext. Asserted via `expect.objectContaining`; only locks
	// the Go-parity fields (incremental-* / todoContent defaults are
	// structurally present but not pinned here — see src JSDoc).
	it('saveTaskStep called with 14-field TaskStepContext', async () => {
		const ev = makeEvent({
			sessionId: 'sid-42',
			toolUseId: 'toolu_42',
			subagentId: 'sub-42',
			sessionRef: '/tmp/session-42.jsonl',
			subagentType: 'coder',
			taskDescription: 'fix stuff',
			modifiedFiles: ['src/a.ts'],
		});

		await handleSubagentEnd(makeAgent(), ev);

		expect(saveTaskStepMock).toHaveBeenCalledTimes(1);
		expect(saveTaskStepMock).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: 'sid-42',
				toolUseId: 'toolu_42',
				agentId: 'sub-42',
				modifiedFiles: ['src/a.ts'],
				newFiles: [],
				deletedFiles: [],
				transcriptPath: '/tmp/session-42.jsonl',
				subagentTranscriptPath: '/tmp/agent-sub-42.jsonl',
				checkpointUuid: '',
				authorName: 'Test User',
				authorEmail: 'test@example.com',
				subagentType: 'coder',
				taskDescription: 'fix stuff',
				agentType: AGENT_TYPE_CLAUDE_CODE,
			}),
		);
	});

	// Case 16 — Step 7 saveTaskStep failure propagates (Go parity).
	// Go: lifecycle.go `if err := strat.SaveTaskStep(...); err != nil { return ... }`
	it('saveTaskStep failure → throws', async () => {
		saveTaskStepMock.mockRejectedValue(new Error('save crash'));
		const ev = makeEvent({ modifiedFiles: ['src/a.ts'] });

		await expect(handleSubagentEnd(makeAgent(), ev)).rejects.toThrow(/save crash/);
	});

	// Case 17 — Step 8 cleanup failure is swallowed so the overall handler
	// Go: lifecycle.go `_ = CleanupPreTaskState(ctx, event.ToolUseID)` best-effort
	// resolves even when the tmp file has already been GC'd. Matches Go
	// `_ = CleanupPreTaskState(ctx, event.ToolUseID)` (best-effort).
	it('cleanupPreTaskState called at end + failure swallowed', async () => {
		vi.mocked(cleanupPreTaskState).mockRejectedValue(new Error('unlink crash'));
		const ev = makeEvent({ modifiedFiles: ['src/a.ts'] });

		await expect(handleSubagentEnd(makeAgent(), ev)).resolves.toBeUndefined();

		expect(cleanupPreTaskState).toHaveBeenCalledWith('toolu_abc');
		expect(saveTaskStepMock).toHaveBeenCalledTimes(1);
	});

	// Case 18 — n/a: log.info emitted once per invocation carrying the 4
	// Go: lifecycle.go handleLifecycleSubagentEnd log.info with conditional attrs
	// most operator-useful fields (sessionId / toolUseId / agentId /
	// subagentTranscript). Ensures the subagent-end trail is searchable.
	it('log.info fired with key fields', async () => {
		const infoSpy = vi.spyOn(log, 'info').mockImplementation(() => {});
		const ev = makeEvent({
			sessionId: 'sid-key',
			toolUseId: 'toolu_key',
			subagentId: 'sub-key',
			sessionRef: '/tmp/key.jsonl',
			modifiedFiles: ['src/a.ts'],
		});

		await handleSubagentEnd(makeAgent(), ev);

		const subagentCompletedCall = infoSpy.mock.calls.find((c) => c[1] === 'subagent completed');
		expect(subagentCompletedCall).toBeDefined();
		expect(subagentCompletedCall?.[2]).toEqual(
			expect.objectContaining({
				// Go parity: lifecycle.go `slog.String("event", event.Type.String())`.
				// Review 2 added this key to TS.
				event: 'SubagentEnd',
				sessionId: 'sid-key',
				toolUseId: 'toolu_key',
				agentId: 'sub-key',
				subagentTranscript: '/tmp/agent-sub-key.jsonl',
			}),
		);
	});
});
