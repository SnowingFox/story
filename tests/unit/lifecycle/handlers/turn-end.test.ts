/**
 * Phase 7 Part 2 `src/lifecycle/handlers/turn-end.ts` — 32 case covering
 * the 8-step orchestration.
 *
 * Go 参考：`cmd/entire/cli/lifecycle.go`
 * (`handleLifecycleTurnEnd`) — 7 `TestHandleLifecycleTurnEnd_*` Go tests
 * covering Step 1 / 2 / 3 / 5 / 6; Step 4 / 7 / 8 are Story-补充 1:1.
 *
 * 32 cases spread across the 8 sub-steps: 1 (Step 1) + 3 (Step 2) + 2
 * (Step 3) + 3 (Step 4) + 8 (Step 5) + 4 (Step 6) + 5 (Step 7) + 5 (Step 8);
 * 11 failure-path cases ≥ 1/3 of 32 (tests.md §2.2 red line).
 *
 * TS-divergences from Go (documented inline in handler + here):
 *
 * 1. `asTranscriptPreparer` / `asPromptExtractor` / `asTranscriptAnalyzer`
 *    / `asSubagentAwareExtractor` return `[T, ok]` tuples (Go returns
 *    two-value pairs). Tests mock all four as `[null, false]` by default.
 * 2. `ManualCommitStrategy` is `new ManualCommitStrategy()` (Go
 *    `GetStrategy(ctx)`); hoisted `saveStepMock` injected onto the
 *    constructed instance.
 * 3. `afterEach` uses `vi.clearAllMocks()` (NOT `restoreAllMocks`) so
 *    hoisted factory `mockImplementation`s (`manualCommitCtorMock` →
 *    `saveStepMock`, node:fs/promises spies) survive the reset between
 *    tests. `beforeEach` re-arms implementations for the next case.
 * 4. `TokenUsage` is `TokenUsage | null` (not `undefined`) on the
 *    {@link StepContext.tokenUsage} field — the `calculateTokenUsage`
 *    failure branch stores `null`.
 *
 * @packageDocumentation
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Event } from '@/agent/event';
import type { Agent } from '@/agent/interfaces';
import { AGENT_NAME_CLAUDE_CODE, AGENT_TYPE_CLAUDE_CODE, type AgentName } from '@/agent/types';
import * as log from '@/log';
import type { SessionState } from '@/session/state-store';

const saveStepMock = vi.hoisted(() => vi.fn(async () => {}));
const manualCommitCtorMock = vi.hoisted(() =>
	vi.fn().mockImplementation(() => ({ saveStep: saveStepMock })),
);

// Typed mock signatures let the tuple-indexed asserts (`call?.[0]`,
// `call?.[1]`) compile under `--strict` — otherwise `mock.calls[0]` is
// typed as the empty tuple and every positional lookup fails.
const mkdirMock = vi.hoisted(() =>
	vi.fn(async (_p: string, _opts?: { recursive?: boolean; mode?: number }) => undefined),
);
const writeFileMock = vi.hoisted(() =>
	vi.fn(async (_p: string, _data: unknown, _opts?: { mode?: number }) => undefined),
);
const readFileMock = vi.hoisted(() => vi.fn(async (_p: string, _enc?: string) => ''));
const statMock = vi.hoisted(() => vi.fn(async (_p: string) => ({}) as unknown));

vi.mock('node:fs/promises', async () => {
	const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
	return {
		...actual,
		default: {
			...actual,
			mkdir: mkdirMock,
			writeFile: writeFileMock,
			readFile: readFileMock,
			stat: statMock,
		},
		mkdir: mkdirMock,
		writeFile: writeFileMock,
		readFile: readFileMock,
		stat: statMock,
	};
});

vi.mock('@/strategy/manual-commit', () => ({ ManualCommitStrategy: manualCommitCtorMock }));
vi.mock('@/strategy/session-state', () => ({
	loadSessionState: vi.fn(async () => null),
	saveSessionState: vi.fn(async () => {}),
	loadModelHint: vi.fn(async () => ''),
}));
vi.mock('@/agent/token-usage', () => ({ calculateTokenUsage: vi.fn(async () => null) }));
vi.mock('@/git', () => ({
	execGit: vi.fn(async () => 'abc123\n'),
	getGitAuthor: vi.fn(async () => ({ name: 'Tester', email: 't@t.com' })),
}));
vi.mock('@/lifecycle/pre-prompt-state', () => ({
	loadPrePromptState: vi.fn(async () => null),
	cleanupPrePromptState: vi.fn(async () => {}),
	preUntrackedFiles: vi.fn(
		(s: { untrackedFiles?: string[] } | null | undefined) => s?.untrackedFiles ?? [],
	),
}));
vi.mock('@/lifecycle/file-changes', () => ({
	detectFileChanges: vi.fn(async () => ({ modified: [], new: [], deleted: [] })),
	filterAndNormalizePaths: vi.fn((files: string[]) => files),
	filterToUncommittedFiles: vi.fn(async (files: string[]) => files),
	mergeUnique: vi.fn((a: string[], b: string[]) => [...a, ...b.filter((x) => !a.includes(x))]),
}));
vi.mock('@/lifecycle/transition', () => ({
	transitionSessionTurnEnd: vi.fn(async () => {}),
}));
vi.mock('@/lifecycle/commit-message', () => ({
	generateCommitMessage: vi.fn(() => 'MSG'),
}));
// Mock `dispatch-helpers` (the new home of `resolveTranscriptOffset` +
// `logFileChanges` + `UNKNOWN_SESSION_ID` + `persistEventMetadataToState`
// + `parseTranscriptForCheckpointUUID`) — `dispatch.ts` re-exports these,
// but the handler itself imports directly from `dispatch-helpers` to
// avoid a module-init cycle through every sibling handler.
vi.mock('@/lifecycle/dispatch-helpers', async () => {
	const actual = await vi.importActual<typeof import('@/lifecycle/dispatch-helpers')>(
		'@/lifecycle/dispatch-helpers',
	);
	return {
		...actual,
		resolveTranscriptOffset: vi.fn(
			async (s: { transcriptOffset?: number } | null) => s?.transcriptOffset ?? 0,
		),
		logFileChanges: vi.fn(),
	};
});
vi.mock('@/agent/capabilities', () => ({
	asTranscriptAnalyzer: vi.fn(() => [null, false]),
	asTranscriptPreparer: vi.fn(() => [null, false]),
	asSubagentAwareExtractor: vi.fn(() => [null, false]),
	asPromptExtractor: vi.fn(() => [null, false]),
}));
vi.mock('@/paths', async () => {
	const actual = await vi.importActual<typeof import('@/paths')>('@/paths');
	return { ...actual, worktreeRoot: vi.fn(async () => '/tmp/test-repo') };
});

import {
	asPromptExtractor,
	asSubagentAwareExtractor,
	asTranscriptAnalyzer,
	asTranscriptPreparer,
} from '@/agent/capabilities';
import { calculateTokenUsage } from '@/agent/token-usage';
import { execGit, getGitAuthor } from '@/git';
import { generateCommitMessage } from '@/lifecycle/commit-message';
import { logFileChanges, resolveTranscriptOffset } from '@/lifecycle/dispatch-helpers';
import {
	detectFileChanges,
	filterAndNormalizePaths,
	filterToUncommittedFiles,
	mergeUnique,
} from '@/lifecycle/file-changes';
import { handleTurnEnd } from '@/lifecycle/handlers/turn-end';
import {
	cleanupPrePromptState,
	loadPrePromptState,
	preUntrackedFiles,
} from '@/lifecycle/pre-prompt-state';
import { transitionSessionTurnEnd } from '@/lifecycle/transition';
import { loadModelHint, loadSessionState, saveSessionState } from '@/strategy/session-state';

function makeEvent(overrides: Partial<Event> = {}): Event {
	return {
		type: 'TurnEnd',
		sessionId: 'sid-1',
		previousSessionId: '',
		sessionRef: '/tmp/transcript.jsonl',
		prompt: '',
		model: '',
		timestamp: new Date(0),
		toolUseId: '',
		subagentId: '',
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
		readTranscript: vi.fn(async () => new Uint8Array([1, 2, 3])),
	} as unknown as Agent;
}

function makeState(overrides: Partial<SessionState> = {}): SessionState {
	return {
		sessionId: 'sid-1',
		baseCommit: 'abc1234',
		startedAt: new Date(0).toISOString(),
		phase: 'active',
		stepCount: 0,
		...overrides,
	};
}

describe('lifecycle/handlers/turn-end', () => {
	beforeEach(() => {
		manualCommitCtorMock.mockClear();
		manualCommitCtorMock.mockImplementation(() => ({ saveStep: saveStepMock }));
		saveStepMock.mockReset().mockImplementation(async () => {});

		mkdirMock.mockReset().mockResolvedValue(undefined);
		writeFileMock.mockReset().mockResolvedValue(undefined);
		readFileMock.mockReset().mockImplementation(async () => '');
		statMock.mockReset().mockResolvedValue({} as unknown);

		vi.mocked(loadSessionState).mockReset().mockResolvedValue(null);
		vi.mocked(saveSessionState).mockReset().mockResolvedValue();
		vi.mocked(loadModelHint).mockReset().mockResolvedValue('');
		vi.mocked(execGit).mockReset().mockResolvedValue('abc123\n');
		vi.mocked(getGitAuthor).mockReset().mockResolvedValue({ name: 'Tester', email: 't@t.com' });
		vi.mocked(calculateTokenUsage).mockReset().mockResolvedValue(null);
		vi.mocked(loadPrePromptState).mockReset().mockResolvedValue(null);
		vi.mocked(cleanupPrePromptState).mockReset().mockResolvedValue();
		vi.mocked(preUntrackedFiles)
			.mockReset()
			.mockImplementation(
				(s: unknown) =>
					(s as { untrackedFiles?: string[] } | null | undefined)?.untrackedFiles ?? [],
			);
		vi.mocked(detectFileChanges)
			.mockReset()
			.mockResolvedValue({ modified: [], new: [], deleted: [] });
		vi.mocked(filterAndNormalizePaths)
			.mockReset()
			.mockImplementation((f: string[]) => f);
		vi.mocked(filterToUncommittedFiles)
			.mockReset()
			.mockImplementation(async (f: string[]) => f);
		vi.mocked(mergeUnique)
			.mockReset()
			.mockImplementation((a: string[], b: string[]) => [...a, ...b.filter((x) => !a.includes(x))]);
		vi.mocked(transitionSessionTurnEnd).mockReset().mockResolvedValue();
		vi.mocked(generateCommitMessage).mockReset().mockReturnValue('MSG');
		vi.mocked(resolveTranscriptOffset)
			.mockReset()
			.mockImplementation(
				async (s: { transcriptOffset?: number } | null) => s?.transcriptOffset ?? 0,
			);
		vi.mocked(logFileChanges).mockReset();
		vi.mocked(asTranscriptAnalyzer)
			.mockReset()
			.mockReturnValue([null, false] as ReturnType<typeof asTranscriptAnalyzer>);
		vi.mocked(asTranscriptPreparer)
			.mockReset()
			.mockReturnValue([null, false] as ReturnType<typeof asTranscriptPreparer>);
		vi.mocked(asSubagentAwareExtractor)
			.mockReset()
			.mockReturnValue([null, false] as ReturnType<typeof asSubagentAwareExtractor>);
		vi.mocked(asPromptExtractor)
			.mockReset()
			.mockReturnValue([null, false] as ReturnType<typeof asPromptExtractor>);
	});

	afterEach(() => {
		// TS-divergence: use `clearAllMocks` (not `restoreAllMocks`) so
		// hoisted factory bindings — `manualCommitCtorMock` →
		// `saveStepMock`, the `node:fs/promises` tuple — survive. The
		// next `beforeEach` re-arms each mock's implementation. This
		// pattern was burned in at `subagent-end.test.ts`;
		// `restoreAllMocks` wiped the hoisted factories.
		vi.clearAllMocks();
	});

	// Case 1 — Step 1 throw on empty transcript ref.
	// Go: lifecycle.go TestHandleLifecycleTurnEnd_EmptyTranscriptRef
	it('throws on empty transcript ref', async () => {
		const ev = makeEvent({ sessionRef: '' });
		await expect(handleTurnEnd(makeAgent(), ev)).rejects.toThrow(/transcript file not specified/);
	});

	// Case 2 — Step 2 preparer path writes file + stat validates.
	// Go: lifecycle.go TestHandleLifecycleTurnEnd_PreparerCreatesFile
	it('TranscriptPreparer creates file that fs.stat validates', async () => {
		const prepareTranscript = vi.fn(async () => {});
		vi.mocked(asTranscriptPreparer).mockReturnValue([
			{ prepareTranscript } as unknown as never,
			true,
		] as ReturnType<typeof asTranscriptPreparer>);

		const ev = makeEvent();
		await handleTurnEnd(makeAgent(), ev);

		expect(prepareTranscript).toHaveBeenCalledTimes(1);
		expect(prepareTranscript).toHaveBeenCalledWith('/tmp/transcript.jsonl');
		expect(statMock).toHaveBeenCalledWith('/tmp/transcript.jsonl');
		// Proceeded past Step 3 (execGit) into Step 4 (writeFile for transcript).
		expect(execGit).toHaveBeenCalled();
	});

	// Case 3 — Story 补充：preparer failure is best-effort — `log.warn` then
	// fallback to the naked `fs.stat` check; the handler must not abort.
	it('preparer failure → log.warn + still validates fs.stat', async () => {
		const prepareTranscript = vi.fn(async () => {
			throw new Error('prep disk full');
		});
		vi.mocked(asTranscriptPreparer).mockReturnValue([
			{ prepareTranscript } as unknown as never,
			true,
		] as ReturnType<typeof asTranscriptPreparer>);
		const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});

		await handleTurnEnd(makeAgent(), makeEvent());

		expect(warnSpy).toHaveBeenCalledWith(
			expect.any(Object),
			'failed to prepare transcript',
			expect.objectContaining({ error: 'prep disk full' }),
		);
		expect(statMock).toHaveBeenCalled();
		expect(execGit).toHaveBeenCalled();
		warnSpy.mockRestore();
	});

	// Case 4 — Step 2 throw when transcript file missing after optional preparer.
	// Go: lifecycle.go TestHandleLifecycleTurnEnd_NonexistentTranscript
	it('throws when fs.stat missing (after optional preparer)', async () => {
		statMock.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

		await expect(
			handleTurnEnd(makeAgent(), makeEvent({ sessionRef: '/tmp/missing.jsonl' })),
		).rejects.toThrow(/transcript file not found: \/tmp\/missing\.jsonl/);
	});

	// Case 5 — Step 3 empty repo early-exit (rev-parse HEAD empty stdout).
	// Go: lifecycle.go TestHandleLifecycleTurnEnd_EmptyRepository
	it('empty repo → early exit', async () => {
		vi.mocked(execGit).mockResolvedValueOnce('');
		const infoSpy = vi.spyOn(log, 'info').mockImplementation(() => {});

		await handleTurnEnd(makeAgent(), makeEvent());

		expect(infoSpy).toHaveBeenCalledWith(
			expect.any(Object),
			'skipping checkpoint - will activate after first commit',
		);
		expect(saveStepMock).not.toHaveBeenCalled();
		infoSpy.mockRestore();
	});

	// Case 6 — Story 补充：Step 3 rev-parse reject treated identically to
	// empty stdout (Go `OpenRepository` error). Does NOT throw.
	it('rev-parse HEAD error → early exit (不抛)', async () => {
		vi.mocked(execGit).mockRejectedValueOnce(new Error('fatal: not a git repo'));
		const infoSpy = vi.spyOn(log, 'info').mockImplementation(() => {});

		await expect(handleTurnEnd(makeAgent(), makeEvent())).resolves.toBeUndefined();

		expect(infoSpy).toHaveBeenCalledWith(
			expect.any(Object),
			'skipping checkpoint - will activate after first commit',
		);
		expect(saveStepMock).not.toHaveBeenCalled();
		infoSpy.mockRestore();
	});

	// Case 7 — Story 补充：Step 4 transcript write uses 0o600 + sits under
	// the session metadata dir with `TRANSCRIPT_FILE_NAME` ('full.jsonl').
	it('transcript copied to sessionDir/<TRANSCRIPT_FILE_NAME> with mode 0o600', async () => {
		const ev = makeEvent({ sessionId: 'sid-copy' });
		await handleTurnEnd(makeAgent(), ev);

		// Transcript write is the first writeFile call (prompt.txt would be
		// the second, but no PromptExtractor is registered → skipped).
		expect(writeFileMock).toHaveBeenCalled();
		const firstCall = writeFileMock.mock.calls[0];
		const filePath = firstCall?.[0];
		const mode = (firstCall?.[2] as { mode?: number } | undefined)?.mode;
		expect(typeof filePath).toBe('string');
		expect(filePath as string).toMatch(/\.story\/metadata\/sid-copy\/full\.jsonl$/);
		expect(mode).toBe(0o600);
	});

	// Case 8 — Story 补充：Step 4 readTranscript failures are HARD-FAIL
	// (transcript copy is mandatory for a recoverable checkpoint).
	it('readTranscript error → throw propagates', async () => {
		const ag = makeAgent();
		(ag.readTranscript as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('read fail'));

		await expect(handleTurnEnd(ag, makeEvent())).rejects.toThrow(/read fail/);
	});

	// Case 9 — Story 补充：Step 4 session dir creation must include
	// `{recursive: true, mode: 0o750}` so parent dirs stitch up cleanly.
	it('sessionDir created with mode 0o750 recursive', async () => {
		await handleTurnEnd(makeAgent(), makeEvent({ sessionId: 'sid-mkdir' }));

		expect(mkdirMock).toHaveBeenCalled();
		const firstCall = mkdirMock.mock.calls[0];
		const callPath = firstCall?.[0];
		const opts = firstCall?.[1] as { recursive?: boolean; mode?: number } | undefined;
		expect(typeof callPath).toBe('string');
		expect(callPath as string).toMatch(/\.story\/metadata\/sid-mkdir$/);
		expect(opts).toEqual({ recursive: true, mode: 0o750 });
	});

	// Case 10 — Story 补充：Step 5 `loadPrePromptState` failure swallowed
	// → preState null + log.warn + continues into Step 6.
	it('loadPrePromptState failure → preState = null + log.warn + continues', async () => {
		vi.mocked(loadPrePromptState).mockRejectedValueOnce(new Error('load fail'));
		const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});

		await handleTurnEnd(makeAgent(), makeEvent());

		expect(warnSpy).toHaveBeenCalledWith(
			expect.any(Object),
			'failed to load pre-prompt state',
			expect.objectContaining({ error: 'load fail' }),
		);
		expect(generateCommitMessage).toHaveBeenCalled();
		warnSpy.mockRestore();
	});

	// Case 11 — Story 补充：Step 5 resolveTranscriptOffset is invoked with
	// the loaded `preState` so the per-turn offset drives both
	// extractPrompts + the token-usage start line.
	it('resolveTranscriptOffset uses preState.transcriptOffset', async () => {
		vi.mocked(loadPrePromptState).mockResolvedValueOnce({
			sessionId: 'sid-1',
			untrackedFiles: [],
			transcriptOffset: 42,
			startTime: new Date(0),
		});
		vi.mocked(resolveTranscriptOffset).mockImplementationOnce(
			async (s: { transcriptOffset?: number } | null) => s?.transcriptOffset ?? 0,
		);

		await handleTurnEnd(makeAgent(), makeEvent());

		expect(resolveTranscriptOffset).toHaveBeenCalledTimes(1);
		const resolveCall = vi.mocked(resolveTranscriptOffset).mock.calls[0];
		const passedState = resolveCall?.[0] as { transcriptOffset?: number } | null;
		expect(passedState?.transcriptOffset).toBe(42);
		// Review 2 C1: lock the second arg too so a future refactor can't silently
		// pass `UNKNOWN_SESSION_ID` or a stale variable to `resolveTranscriptOffset`
		// and still pass this test.
		const passedSessionID = resolveCall?.[1] as string | undefined;
		expect(passedSessionID).toBe('sid-1');
	});

	// Case 12 — Step 5 backfill prompt.txt when empty + PromptExtractor present.
	// Go: lifecycle.go TestHandleLifecycleTurnEnd_BackfillsPromptFromTranscript
	it('backfills prompt.txt from transcript when empty + PromptExtractor exists', async () => {
		// First readFile is for `prompt.txt` (existing content).
		readFileMock.mockResolvedValueOnce('');
		const extractPrompts = vi.fn(async () => ['p1', 'p2']);
		vi.mocked(asPromptExtractor).mockReturnValue([
			{ extractPrompts } as unknown as never,
			true,
		] as ReturnType<typeof asPromptExtractor>);

		await handleTurnEnd(makeAgent(), makeEvent());

		expect(extractPrompts).toHaveBeenCalledWith('/tmp/transcript.jsonl', 0);
		// writeFile[0] = transcript; writeFile[1] = prompt.txt.
		expect(writeFileMock.mock.calls.length).toBeGreaterThanOrEqual(2);
		const promptCall = writeFileMock.mock.calls[1];
		const promptPath = promptCall?.[0] as string;
		const promptBody = promptCall?.[1] as string;
		const promptMode = (promptCall?.[2] as { mode?: number } | undefined)?.mode;
		expect(promptPath).toMatch(/prompt\.txt$/);
		expect(promptBody).toBe('p1\n\n---\n\np2');
		expect(promptMode).toBe(0o600);

		// backfilledPrompt === 'p2' propagated into generateCommitMessage.
		expect(generateCommitMessage).toHaveBeenCalledWith('p2', AGENT_TYPE_CLAUDE_CODE);
	});

	// Case 13 — Step 5 no backfill when `prompt.txt` already populated.
	// Go: lifecycle.go TestHandleLifecycleTurnEnd_NoBackfillWhenPromptFileHasContent
	it('no backfill when prompt.txt already has content', async () => {
		readFileMock.mockResolvedValueOnce('existing');
		const extractPrompts = vi.fn(async () => ['p1', 'p2']);
		vi.mocked(asPromptExtractor).mockReturnValue([
			{ extractPrompts } as unknown as never,
			true,
		] as ReturnType<typeof asPromptExtractor>);

		await handleTurnEnd(makeAgent(), makeEvent());

		expect(extractPrompts).not.toHaveBeenCalled();
		// Only the transcript write should have landed (no prompt write).
		for (const call of writeFileMock.mock.calls) {
			expect(call[0]).not.toMatch(/prompt\.txt$/);
		}
	});

	// Case 14 — Story 补充：Step 5 `asPromptExtractor` returns `[null, false]`
	// → whole branch short-circuits, no `extractPrompts` invocation.
	it('no backfill when agent lacks PromptExtractor', async () => {
		readFileMock.mockResolvedValueOnce('');
		// asPromptExtractor already defaulted to [null, false].

		await handleTurnEnd(makeAgent(), makeEvent());

		for (const call of writeFileMock.mock.calls) {
			expect(call[0]).not.toMatch(/prompt\.txt$/);
		}
	});

	// Case 15 — Story 补充：Step 5 `extractPrompts` reject → log.warn +
	// continue (no backfill but handler still resolves).
	it('extractPrompts failure → log.warn + continues', async () => {
		readFileMock.mockResolvedValueOnce('');
		const extractPrompts = vi.fn(async () => {
			throw new Error('extract boom');
		});
		vi.mocked(asPromptExtractor).mockReturnValue([
			{ extractPrompts } as unknown as never,
			true,
		] as ReturnType<typeof asPromptExtractor>);
		const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});

		await expect(handleTurnEnd(makeAgent(), makeEvent())).resolves.toBeUndefined();

		expect(warnSpy).toHaveBeenCalledWith(
			expect.any(Object),
			'failed to extract prompts from transcript',
			expect.objectContaining({ error: 'extract boom' }),
		);
		warnSpy.mockRestore();
	});

	// Case 15.5 — Story 补充：Step 5 `prompt.txt` read failure **non-ENOENT**
	// (e.g. EACCES) → `log.warn('failed to read prompt.txt, skipping backfill')`
	// + **skip** the PromptExtractor branch so the real IO error is not
	// silently masked by synthetic backfill from transcript. Go parity:
	// `lifecycle.go`.
	// Go: lifecycle.go handleLifecycleTurnEnd Step 5 (non-ENOENT readFile)
	it('non-ENOENT read failure on prompt.txt → log.warn + skip backfill', async () => {
		const eaccesErr = Object.assign(new Error('permission denied'), {
			code: 'EACCES',
		});
		readFileMock.mockRejectedValueOnce(eaccesErr);
		const extractPrompts = vi.fn(async () => ['p1', 'p2']);
		vi.mocked(asPromptExtractor).mockReturnValue([
			{ extractPrompts } as unknown as never,
			true,
		] as ReturnType<typeof asPromptExtractor>);
		const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});

		await expect(handleTurnEnd(makeAgent(), makeEvent())).resolves.toBeUndefined();

		expect(warnSpy).toHaveBeenCalledWith(
			expect.any(Object),
			'failed to read prompt.txt, skipping backfill',
			expect.objectContaining({ error: 'permission denied' }),
		);
		// Extractor must NOT run when the non-ENOENT read failed — unlike the
		// ENOENT path in case 12.
		expect(extractPrompts).not.toHaveBeenCalled();
		warnSpy.mockRestore();
	});

	// Case 16 — Story 补充：Step 5 `SubagentAwareExtractor` takes priority
	// over base analyzer when both are declared (Claude Code Task nesting).
	it('SubagentAwareExtractor takes priority over base Analyzer', async () => {
		const baseExtract = vi.fn(async () => ({ files: ['from-base.ts'], currentPosition: 0 }));
		const subExtract = vi.fn(async () => ['from-sub.ts']);
		vi.mocked(asTranscriptAnalyzer).mockReturnValue([
			{ extractModifiedFilesFromOffset: baseExtract } as unknown as never,
			true,
		] as ReturnType<typeof asTranscriptAnalyzer>);
		vi.mocked(asSubagentAwareExtractor).mockReturnValue([
			{ extractAllModifiedFiles: subExtract } as unknown as never,
			true,
		] as ReturnType<typeof asSubagentAwareExtractor>);
		vi.mocked(detectFileChanges).mockResolvedValueOnce({
			modified: [],
			new: ['from-sub.ts'],
			deleted: [],
		});

		await handleTurnEnd(makeAgent(), makeEvent());

		expect(subExtract).toHaveBeenCalledTimes(1);
		expect(baseExtract).not.toHaveBeenCalled();
		// Go parity: `lifecycle.go`
		//   subagentsDir := filepath.Join(filepath.Dir(transcriptRef), event.SessionID, "subagents")
		// With sessionRef='/tmp/transcript.jsonl' + sessionId='sid-1' →
		// '/tmp/sid-1/subagents'. Assert the third arg explicitly so a future
		// refactor can't silently drift from Go's path convention.
		const [, , subagentsDirArg] = (subExtract.mock.calls[0] ?? []) as unknown as [
			Uint8Array,
			number,
			string,
		];
		expect(subagentsDirArg).toBe('/tmp/sid-1/subagents');
	});

	// Case 17 — Story 补充：Step 5 falls back to `TranscriptAnalyzer` when
	// `SubagentAwareExtractor` is unavailable. Returned files flow through
	// into the saveStep modifiedFiles.
	it('fallback to base Analyzer.extractModifiedFilesFromOffset when SubagentAware missing', async () => {
		const baseExtract = vi.fn(async () => ({
			files: ['src/base-only.ts'],
			currentPosition: 0,
		}));
		vi.mocked(asTranscriptAnalyzer).mockReturnValue([
			{ extractModifiedFilesFromOffset: baseExtract } as unknown as never,
			true,
		] as ReturnType<typeof asTranscriptAnalyzer>);
		vi.mocked(filterToUncommittedFiles).mockImplementationOnce(async (f) => f);

		await handleTurnEnd(makeAgent(), makeEvent());

		expect(baseExtract).toHaveBeenCalledWith('/tmp/transcript.jsonl', 0);
		expect(saveStepMock).toHaveBeenCalledTimes(1);
		const [ctx] = saveStepMock.mock.calls[0] as unknown as [{ modifiedFiles: string[] }];
		expect(ctx.modifiedFiles).toContain('src/base-only.ts');
	});

	// Case 18 — Story 补充：Step 5 analyzer failure → `log.warn` and
	// modifiedFiles = [] (Go: silent fall-through with empty slice).
	it('analyzer failure → modifiedFiles empty + log.warn', async () => {
		const baseExtract = vi.fn(async () => {
			throw new Error('analyzer boom');
		});
		vi.mocked(asTranscriptAnalyzer).mockReturnValue([
			{ extractModifiedFilesFromOffset: baseExtract } as unknown as never,
			true,
		] as ReturnType<typeof asTranscriptAnalyzer>);
		vi.mocked(detectFileChanges).mockResolvedValueOnce({
			modified: [],
			new: ['new-only.ts'],
			deleted: [],
		});
		const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});

		await handleTurnEnd(makeAgent(), makeEvent());

		expect(warnSpy).toHaveBeenCalledWith(
			expect.any(Object),
			'failed to extract modified files',
			expect.objectContaining({ error: 'analyzer boom' }),
		);
		expect(saveStepMock).toHaveBeenCalledTimes(1);
		const [ctx] = saveStepMock.mock.calls[0] as unknown as [{ modifiedFiles: string[] }];
		expect(ctx.modifiedFiles).toEqual([]);
		warnSpy.mockRestore();
	});

	// Case 19 — Story 补充：Step 6 `generateCommitMessage` receives the
	// stored `lastPrompt` when session state carries one.
	it('generateCommitMessage called with state.lastPrompt when present', async () => {
		vi.mocked(loadSessionState).mockResolvedValueOnce(makeState({ lastPrompt: 'refactor X' }));
		vi.mocked(detectFileChanges).mockResolvedValueOnce({
			modified: ['a.ts'],
			new: [],
			deleted: [],
		});

		await handleTurnEnd(makeAgent(), makeEvent());

		expect(generateCommitMessage).toHaveBeenCalledWith('refactor X', AGENT_TYPE_CLAUDE_CODE);
	});

	// Case 20 — Step 6 backfills `state.lastPrompt` when empty + extracted
	// a prompt from the transcript.
	// Go: lifecycle.go TestHandleLifecycleTurnEnd_BackfillUpdatesSessionState
	it('backfills lastPrompt into session state when empty', async () => {
		readFileMock.mockResolvedValueOnce('');
		const extractPrompts = vi.fn(async () => ['p1', 'p2']);
		vi.mocked(asPromptExtractor).mockReturnValue([
			{ extractPrompts } as unknown as never,
			true,
		] as ReturnType<typeof asPromptExtractor>);
		const state = makeState({ lastPrompt: '' });
		vi.mocked(loadSessionState).mockResolvedValueOnce(state);

		await handleTurnEnd(makeAgent(), makeEvent());

		// saveSessionState called with the mutated state (lastPrompt=p2).
		expect(saveSessionState).toHaveBeenCalled();
		const savedArg = vi.mocked(saveSessionState).mock.calls[0]?.[0] as SessionState;
		expect(savedArg.lastPrompt).toBe('p2');
		// Downstream: generateCommitMessage sees the backfilled value.
		expect(generateCommitMessage).toHaveBeenCalledWith('p2', AGENT_TYPE_CLAUDE_CODE);
	});

	// Case 21 — Story 补充：Step 6 falls back to `backfilledPrompt` when
	// session state is missing entirely (no state on disk yet).
	it('uses backfilledPrompt when session state missing', async () => {
		readFileMock.mockResolvedValueOnce('');
		const extractPrompts = vi.fn(async () => ['p1', 'p2']);
		vi.mocked(asPromptExtractor).mockReturnValue([
			{ extractPrompts } as unknown as never,
			true,
		] as ReturnType<typeof asPromptExtractor>);
		// loadSessionState already defaults to null.

		await handleTurnEnd(makeAgent(), makeEvent());

		expect(generateCommitMessage).toHaveBeenCalledWith('p2', AGENT_TYPE_CLAUDE_CODE);
	});

	// Case 22 — Story 补充：Step 6 `saveSessionState` reject is swallowed
	// with a `log.warn`; the handler continues to Step 7.
	it('saveSessionState failure during backfill → log.warn + continues', async () => {
		readFileMock.mockResolvedValueOnce('');
		const extractPrompts = vi.fn(async () => ['p1']);
		vi.mocked(asPromptExtractor).mockReturnValue([
			{ extractPrompts } as unknown as never,
			true,
		] as ReturnType<typeof asPromptExtractor>);
		vi.mocked(loadSessionState).mockResolvedValueOnce(makeState({ lastPrompt: '' }));
		vi.mocked(saveSessionState).mockRejectedValueOnce(new Error('save boom'));
		const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});

		await expect(handleTurnEnd(makeAgent(), makeEvent())).resolves.toBeUndefined();

		expect(warnSpy).toHaveBeenCalledWith(
			expect.any(Object),
			'failed to backfill LastPrompt in session state',
			expect.objectContaining({ error: 'save boom' }),
		);
		warnSpy.mockRestore();
	});

	// Case 23 — Story 补充：Step 7 `detectFileChanges` failure → null →
	// relNewFiles/relDeletedFiles both []; modifiedFiles still seeded
	// from the transcript analyzer.
	it('detectFileChanges null → defaults to modifiedFiles from transcript only', async () => {
		vi.mocked(detectFileChanges).mockRejectedValueOnce(new Error('detect boom'));
		const baseExtract = vi.fn(async () => ({ files: ['src/t.ts'], currentPosition: 0 }));
		vi.mocked(asTranscriptAnalyzer).mockReturnValue([
			{ extractModifiedFilesFromOffset: baseExtract } as unknown as never,
			true,
		] as ReturnType<typeof asTranscriptAnalyzer>);
		// Review 2 C2: also spy on log.warn so the structured-log message
		// is byte-locked — a future refactor could drop the warn and the
		// behavior-only assertions would still pass, silently losing
		// operator visibility into the detectFileChanges failure.
		const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});

		await handleTurnEnd(makeAgent(), makeEvent());

		expect(saveStepMock).toHaveBeenCalledTimes(1);
		const [ctx] = saveStepMock.mock.calls[0] as unknown as [
			{ modifiedFiles: string[]; newFiles: string[]; deletedFiles: string[] },
		];
		expect(ctx.modifiedFiles).toEqual(['src/t.ts']);
		expect(ctx.newFiles).toEqual([]);
		expect(ctx.deletedFiles).toEqual([]);
		expect(warnSpy).toHaveBeenCalledWith(
			expect.any(Object),
			'failed to compute file changes',
			expect.objectContaining({ error: 'detect boom' }),
		);
		warnSpy.mockRestore();
	});

	// Case 24 — Story 补充：Step 7 `mergeUnique` unions transcript-analyzer
	// modified with git-status modified (git-status as fallback
	// for tools the transcript parser didn't capture).
	it('mergeUnique combines transcript + git status modified files', async () => {
		const baseExtract = vi.fn(async () => ({ files: ['a'], currentPosition: 0 }));
		vi.mocked(asTranscriptAnalyzer).mockReturnValue([
			{ extractModifiedFilesFromOffset: baseExtract } as unknown as never,
			true,
		] as ReturnType<typeof asTranscriptAnalyzer>);
		vi.mocked(detectFileChanges).mockResolvedValueOnce({
			modified: ['b', 'a'],
			new: [],
			deleted: [],
		});

		await handleTurnEnd(makeAgent(), makeEvent());

		expect(saveStepMock).toHaveBeenCalledTimes(1);
		const [ctx] = saveStepMock.mock.calls[0] as unknown as [{ modifiedFiles: string[] }];
		expect(ctx.modifiedFiles).toEqual(['a', 'b']);
	});

	// Case 25 — Story 补充：Step 7 `filterToUncommittedFiles` drops paths
	// already committed to HEAD during mid-turn commits.
	it('filterToUncommittedFiles drops already-committed files', async () => {
		const baseExtract = vi.fn(async () => ({
			files: ['committed.ts', 'uncommitted.ts'],
			currentPosition: 0,
		}));
		vi.mocked(asTranscriptAnalyzer).mockReturnValue([
			{ extractModifiedFilesFromOffset: baseExtract } as unknown as never,
			true,
		] as ReturnType<typeof asTranscriptAnalyzer>);
		vi.mocked(filterToUncommittedFiles).mockResolvedValueOnce(['uncommitted.ts']);

		await handleTurnEnd(makeAgent(), makeEvent());

		expect(saveStepMock).toHaveBeenCalledTimes(1);
		const [ctx] = saveStepMock.mock.calls[0] as unknown as [{ modifiedFiles: string[] }];
		expect(ctx.modifiedFiles).toEqual(['uncommitted.ts']);
	});

	// Case 26 — Story 补充：Step 7 no-changes fast path — all three
	// buckets empty → `transitionSessionTurnEnd` + `cleanupPrePromptState`
	// + return; `strategy.saveStep` is NEVER called.
	it('no-changes → transitionSessionTurnEnd + cleanup + return; saveStep NOT called', async () => {
		vi.mocked(detectFileChanges).mockResolvedValueOnce({
			modified: [],
			new: [],
			deleted: [],
		});

		await handleTurnEnd(makeAgent(), makeEvent());

		expect(saveStepMock).not.toHaveBeenCalled();
		expect(transitionSessionTurnEnd).toHaveBeenCalledTimes(1);
		expect(cleanupPrePromptState).toHaveBeenCalledTimes(1);
	});

	// Case 27 — Story 补充：Step 7 `logFileChanges` emits counts when at
	// least one file changed in any bucket.
	it('logFileChanges called with counts when changes exist', async () => {
		const baseExtract = vi.fn(async () => ({ files: ['m.ts'], currentPosition: 0 }));
		vi.mocked(asTranscriptAnalyzer).mockReturnValue([
			{ extractModifiedFilesFromOffset: baseExtract } as unknown as never,
			true,
		] as ReturnType<typeof asTranscriptAnalyzer>);
		vi.mocked(detectFileChanges).mockResolvedValueOnce({
			modified: [],
			new: ['n.ts'],
			deleted: ['d.ts'],
		});

		await handleTurnEnd(makeAgent(), makeEvent());

		expect(logFileChanges).toHaveBeenCalledTimes(1);
		const call = vi.mocked(logFileChanges).mock.calls[0];
		// (logCtx, modified, new, deleted)
		expect(call?.[1]).toEqual(['m.ts']);
		expect(call?.[2]).toEqual(['n.ts']);
		expect(call?.[3]).toEqual(['d.ts']);
	});

	// Case 28 — Story 补充：Step 8 `getGitAuthor` failure is HARD-FAIL
	// (cannot commit without an author). Propagates.
	it('getGitAuthor failure → throws', async () => {
		vi.mocked(detectFileChanges).mockResolvedValueOnce({
			modified: ['a.ts'],
			new: [],
			deleted: [],
		});
		vi.mocked(getGitAuthor).mockRejectedValueOnce(new Error('no author'));

		await expect(handleTurnEnd(makeAgent(), makeEvent())).rejects.toThrow(/no author/);
	});

	// Case 29 — Story 补充：Step 8 `calculateTokenUsage` failure swallowed
	// → StepContext.tokenUsage === null (not undefined); saveStep still
	// called with the rest of the 13-field StepContext.
	it('calculateTokenUsage failure → tokenUsage null + log.warn + continues', async () => {
		vi.mocked(detectFileChanges).mockResolvedValueOnce({
			modified: ['a.ts'],
			new: [],
			deleted: [],
		});
		vi.mocked(calculateTokenUsage).mockRejectedValueOnce(new Error('tok boom'));
		const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});

		await handleTurnEnd(makeAgent(), makeEvent());

		expect(saveStepMock).toHaveBeenCalledTimes(1);
		const [ctx] = saveStepMock.mock.calls[0] as unknown as [{ tokenUsage: unknown }];
		expect(ctx.tokenUsage).toBeNull();
		expect(warnSpy).toHaveBeenCalledWith(
			expect.any(Object),
			'failed to calculate token usage',
			expect.objectContaining({ error: 'tok boom' }),
		);
		warnSpy.mockRestore();
	});

	// Case 30 — Story 补充：Step 8 full 13-field StepContext assertion.
	// All Go-parity fields must be populated; verifies the handler
	// assembles the exact contract `manual-commit.saveStep` expects.
	it('strategy.saveStep called with 13-field StepContext', async () => {
		vi.mocked(loadPrePromptState).mockResolvedValueOnce({
			sessionId: 'sid-1',
			untrackedFiles: [],
			transcriptOffset: 7,
			startTime: new Date(0),
			lastTranscriptIdentifier: 'uuid-42',
		});
		const baseExtract = vi.fn(async () => ({ files: ['src/a.ts'], currentPosition: 0 }));
		vi.mocked(asTranscriptAnalyzer).mockReturnValue([
			{ extractModifiedFilesFromOffset: baseExtract } as unknown as never,
			true,
		] as ReturnType<typeof asTranscriptAnalyzer>);
		vi.mocked(detectFileChanges).mockResolvedValueOnce({
			modified: [],
			new: ['n.ts'],
			deleted: ['d.ts'],
		});

		await handleTurnEnd(makeAgent(), makeEvent({ sessionId: 'sid-ctx' }));

		expect(saveStepMock).toHaveBeenCalledTimes(1);
		const [ctx] = saveStepMock.mock.calls[0] as unknown as [Record<string, unknown>];
		expect(ctx).toEqual(
			expect.objectContaining({
				sessionId: 'sid-ctx',
				modifiedFiles: ['src/a.ts'],
				newFiles: ['n.ts'],
				deletedFiles: ['d.ts'],
				metadataDir: '.story/metadata/sid-ctx',
				commitMessage: 'MSG',
				transcriptPath: '/tmp/transcript.jsonl',
				authorName: 'Tester',
				authorEmail: 't@t.com',
				agentType: AGENT_TYPE_CLAUDE_CODE,
				stepTranscriptIdentifier: 'uuid-42',
				stepTranscriptStart: 7,
				tokenUsage: null,
			}),
		);
		// `metadataDirAbs` must join `/tmp/test-repo` (mocked worktreeRoot)
		// with `.story/metadata/sid-ctx`.
		expect(ctx.metadataDirAbs).toMatch(/\/tmp\/test-repo\/\.story\/metadata\/sid-ctx$/);
	});

	// Case 31 — Story 补充：Step 8 post-save backfill re-checks state
	// (saveStep may reinitialize); when reloaded state lacks `lastPrompt`
	// the handler writes the backfilled value back.
	it('post-save backfill re-checks session state (saveStep may reinit)', async () => {
		readFileMock.mockResolvedValueOnce('');
		const extractPrompts = vi.fn(async () => ['p1']);
		vi.mocked(asPromptExtractor).mockReturnValue([
			{ extractPrompts } as unknown as never,
			true,
		] as ReturnType<typeof asPromptExtractor>);
		vi.mocked(detectFileChanges).mockResolvedValueOnce({
			modified: ['a.ts'],
			new: [],
			deleted: [],
		});

		// 1st load (step 6): null → falls through to backfill-only branch
		//   → `lastPrompt = 'p1'`, no saveSessionState yet.
		// 2nd load (step 8 post-save): state with empty lastPrompt →
		//   handler mutates + saves.
		vi.mocked(loadSessionState)
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(makeState({ lastPrompt: '' }));

		await handleTurnEnd(makeAgent(), makeEvent());

		expect(saveStepMock).toHaveBeenCalledTimes(1);
		expect(saveSessionState).toHaveBeenCalledTimes(1);
		const saved = vi.mocked(saveSessionState).mock.calls[0]?.[0] as SessionState;
		expect(saved.lastPrompt).toBe('p1');
	});

	// Case 32 — Story 补充：Step 8 final `cleanupPrePromptState` failure
	// MUST be swallowed — cleanup is best-effort and the shadow commit
	// has already landed.
	it('cleanupPrePromptState called at end + failure swallowed', async () => {
		vi.mocked(detectFileChanges).mockResolvedValueOnce({
			modified: ['a.ts'],
			new: [],
			deleted: [],
		});
		vi.mocked(cleanupPrePromptState).mockRejectedValueOnce(new Error('cleanup boom'));
		const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});

		await expect(handleTurnEnd(makeAgent(), makeEvent())).resolves.toBeUndefined();

		expect(cleanupPrePromptState).toHaveBeenCalledTimes(1);
		expect(warnSpy).toHaveBeenCalledWith(
			expect.any(Object),
			'failed to cleanup pre-prompt state',
			expect.objectContaining({ error: 'cleanup boom' }),
		);
		warnSpy.mockRestore();
	});

	// Case 33 — Review 2 C3 补充：Step 7 的 **no-changes 分支** 也调
	// `cleanupPrePromptState`（turn-end.ts:335-341）；Case 32 只覆盖
	// has-changes 分支（Step 8 末尾）。补独立 case 锁定 no-changes 路径
	// 的 cleanup 失败同样 swallow 不 throw，并确认 transitionSessionTurnEnd
	// 仍按 no-changes 流程调。
	// Go: lifecycle.go handleLifecycleTurnEnd no-changes branch cleanup
	it('no-changes path: cleanupPrePromptState failure swallowed + transition still called', async () => {
		// All 3 change-arrays empty → no-changes branch.
		vi.mocked(detectFileChanges).mockResolvedValueOnce({
			modified: [],
			new: [],
			deleted: [],
		});
		vi.mocked(cleanupPrePromptState).mockRejectedValueOnce(new Error('cleanup no-changes boom'));
		const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});

		await expect(handleTurnEnd(makeAgent(), makeEvent())).resolves.toBeUndefined();

		// No-changes branch entered: transition called, saveStep NOT called.
		expect(transitionSessionTurnEnd).toHaveBeenCalledTimes(1);
		expect(saveStepMock).not.toHaveBeenCalled();
		expect(cleanupPrePromptState).toHaveBeenCalledTimes(1);
		expect(warnSpy).toHaveBeenCalledWith(
			expect.any(Object),
			'failed to cleanup pre-prompt state',
			expect.objectContaining({ error: 'cleanup no-changes boom' }),
		);
		warnSpy.mockRestore();
	});
});
