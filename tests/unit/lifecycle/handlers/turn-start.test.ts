/**
 * Phase 7 Part 2 `src/lifecycle/handlers/turn-start.ts` — 14 case.
 *
 * Go 参考：`cmd/entire/cli/lifecycle.go: handleLifecycleTurnStart` +
 * `lifecycle_test.go: TestHandleLifecycleTurnStart_EmptySessionID` +
 * `TestHandleLifecycleTurnStart_WritesPromptContent`.
 *
 * 覆盖 7 子步骤（log.info / sessionId validation / loadModelHint fallback /
 * capturePrePromptState hard-fail / prompt.txt append 语义 / ensureSetup /
 * ManualCommitStrategy.initializeSession）+ 7 条失败路径（1/2/4/5/9/10/11 →
 * 7/14 case，满足 ≥ 1/3 失败路径红线）。
 *
 * 测试策略：
 * - `worktreeRoot` 指向 per-test `os.tmpdir()` 子目录，handler 走**真实 fs** 写
 *   `.story/metadata/<sid>/prompt.txt`；test 9 / 13 则选择性 `vi.mocked(fs.*)`
 *   注入错误或抓调用参数。
 * - `capturePrePromptState` / `loadModelHint` / `ensureSetup` /
 *   `ManualCommitStrategy` / `validateSessionId` 模块级全 mock。
 *
 * @packageDocumentation
 */

import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Event } from '@/agent/event';
import type { Agent } from '@/agent/interfaces';
import { AGENT_NAME_CLAUDE_CODE, AGENT_TYPE_CLAUDE_CODE, type AgentName } from '@/agent/types';
import { PROMPT_FILE_NAME } from '@/checkpoint/constants';
import { handleTurnStart } from '@/lifecycle/handlers/turn-start';
import * as log from '@/log';
import { storyMetadataDirForSession } from '@/paths';

const initializeSessionMock = vi.hoisted(() =>
	vi.fn(
		async (_sid: string, _agentType: string, _ref: string, _prompt: string, _model: string) => {},
	),
);

vi.mock('node:fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs/promises')>();
	return {
		...actual,
		mkdir: vi.fn(actual.mkdir),
		writeFile: vi.fn(actual.writeFile),
		readFile: vi.fn(actual.readFile),
	};
});

vi.mock('@/validation', () => ({
	validateSessionId: vi.fn(() => null),
}));
vi.mock('@/strategy/session-state', () => ({
	loadModelHint: vi.fn(async () => ''),
}));
vi.mock('@/strategy/setup', () => ({
	ensureSetup: vi.fn(async () => {}),
}));
vi.mock('@/strategy/manual-commit', () => ({
	ManualCommitStrategy: vi.fn().mockImplementation(() => ({
		initializeSession: initializeSessionMock,
	})),
}));
vi.mock('@/lifecycle/pre-prompt-state', () => ({
	capturePrePromptState: vi.fn(async () => {}),
}));
vi.mock('@/paths', async () => {
	const actual = await vi.importActual<typeof import('@/paths')>('@/paths');
	return {
		...actual,
		worktreeRoot: vi.fn(async () => ''),
	};
});

import { capturePrePromptState } from '@/lifecycle/pre-prompt-state';
import { worktreeRoot } from '@/paths';
import { loadModelHint } from '@/strategy/session-state';
import { ensureSetup } from '@/strategy/setup';
import { validateSessionId } from '@/validation';

function makeEvent(overrides: Partial<Event> = {}): Event {
	return {
		type: 'TurnStart',
		sessionId: 'sid-1',
		previousSessionId: '',
		sessionRef: '/transcript/ref.jsonl',
		prompt: '',
		model: '',
		timestamp: new Date('2026-04-21T13:00:00.000Z'),
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
	} as Agent;
}

describe('lifecycle/handlers/turn-start', () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'story-turn-start-'));

		vi.mocked(validateSessionId).mockReset().mockReturnValue(null);
		vi.mocked(loadModelHint).mockReset().mockResolvedValue('');
		vi.mocked(ensureSetup).mockReset().mockResolvedValue();
		vi.mocked(capturePrePromptState).mockReset().mockResolvedValue();
		vi.mocked(worktreeRoot).mockReset().mockResolvedValue(tmpDir);
		initializeSessionMock.mockReset().mockResolvedValue(undefined);

		const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
		vi.mocked(fs.mkdir).mockReset().mockImplementation(actual.mkdir);
		vi.mocked(fs.writeFile).mockReset().mockImplementation(actual.writeFile);
		vi.mocked(fs.readFile).mockReset().mockImplementation(actual.readFile);
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	// Go: lifecycle.go TestHandleLifecycleTurnStart_EmptySessionID —
	// Go `if sessionID == "" { return fmt.Errorf("no session_id in %s event", event.Type) }`.
	// TS mirrors Go exactly (NO `UNKNOWN_SESSION_ID` fallback here unlike
	// session-end / session-start — TurnStart requires a real session).
	it('throws when sessionId empty', async () => {
		const ev = makeEvent({ sessionId: '' });
		await expect(handleTurnStart(makeAgent(), ev)).rejects.toThrow(
			/no session_id in TurnStart event/,
		);
	});

	// Go: lifecycle.go — `validation.ValidateSessionID(sessionID)` rejects
	// path-separator / empty / unsafe IDs. TS wraps the error message with
	// `'invalid <EventType> event: '` prefix (Go `fmt.Errorf("invalid %s event: %w", ...)`).
	// Covers the "validateSessionId fails" failure branch (tests.md §2.1 case 2).
	it('throws when validateSessionId fails', async () => {
		vi.mocked(validateSessionId).mockReturnValueOnce(new Error('contains path separators'));
		const ev = makeEvent({ sessionId: '../bad/path' });
		await expect(handleTurnStart(makeAgent(), ev)).rejects.toThrow(
			/invalid TurnStart event:.*contains path separators/,
		);
	});

	// Go: lifecycle.go — `LoadModelHint` fallback populates `event.Model`
	// when the hook didn't carry one. Covers the hint-file happy branch
	// (tests.md §2.1 case 3). `log.debug` fires once with `'loaded model from hint file'`.
	it('loads model from hint file when event.model empty', async () => {
		vi.mocked(loadModelHint).mockResolvedValueOnce('sonnet');
		const debugSpy = vi.spyOn(log, 'debug').mockImplementation(() => {});
		const ev = makeEvent({ model: '' });

		await handleTurnStart(makeAgent(), ev);

		expect(ev.model).toBe('sonnet');
		expect(debugSpy).toHaveBeenCalledWith(
			expect.any(Object),
			'loaded model from hint file',
			expect.objectContaining({ model: 'sonnet' }),
		);
		debugSpy.mockRestore();
	});

	// Story 补充：`loadModelHint` 抛错 → swallow + event.model 保持空；
	// Go 的 `LoadModelHint` 本身不抛（内部静默）；TS 出于 defensive programming
	// 在 handler 侧再 try/catch 一次以防未来签名演进。（tests.md §2.1 case 4 / 失败路径 #1）
	it('loadModelHint failure swallowed + no throw', async () => {
		vi.mocked(loadModelHint).mockRejectedValueOnce(new Error('hint fail'));
		const ev = makeEvent({ model: '' });

		await expect(handleTurnStart(makeAgent(), ev)).resolves.toBeUndefined();

		expect(ev.model).toBe('');
	});

	// Go: lifecycle.go — `CapturePrePromptState` is the **single HARD FAIL**
	// point in this handler; any other step swallow-logs. Matches tests.md §2.1 case 5
	// / 失败路径 #2 — hard-fail regression guard.
	it('capturePrePromptState throws → handleTurnStart throws (hard-fail)', async () => {
		vi.mocked(capturePrePromptState).mockRejectedValueOnce(new Error('capture disk full'));
		const ev = makeEvent({ sessionId: 'sid-hardfail' });

		await expect(handleTurnStart(makeAgent(), ev)).rejects.toThrow(/capture disk full/);
	});

	// Go: lifecycle.go TestHandleLifecycleTurnStart_WritesPromptContent —
	// `event.Prompt != ""` + no existing `prompt.txt` → write event.prompt verbatim
	// under `<metadataDir>/prompt.txt` with mode `0o600`. `prompt.txt` is read
	// back to verify content round-trip.
	it('writes prompt.txt when event.prompt non-empty + no existing file', async () => {
		const sid = 'sid-write';
		const ev = makeEvent({ sessionId: sid, prompt: 'hello world' });

		await handleTurnStart(makeAgent(), ev);

		const promptPath = path.join(tmpDir, storyMetadataDirForSession(sid), PROMPT_FILE_NAME);
		const body = await fs.readFile(promptPath, 'utf-8');
		expect(body).toBe('hello world');

		const stat = await fs.stat(promptPath);
		expect((stat.mode & 0o777).toString(8)).toBe('600');
	});

	// Go: lifecycle.go — existing `prompt.txt` → append with literal
	// `\n\n---\n\n` separator (preserves per-turn ordering for later diagnostics).
	// Covers tests.md §2.1 case 7.
	it('appends to existing prompt.txt with separator', async () => {
		const sid = 'sid-append';
		const dir = path.join(tmpDir, storyMetadataDirForSession(sid));
		await fs.mkdir(dir, { recursive: true, mode: 0o750 });
		await fs.writeFile(path.join(dir, PROMPT_FILE_NAME), 'prev', { mode: 0o600 });

		const ev = makeEvent({ sessionId: sid, prompt: 'next' });
		await handleTurnStart(makeAgent(), ev);

		const body = await fs.readFile(path.join(dir, PROMPT_FILE_NAME), 'utf-8');
		expect(body).toBe('prev\n\n---\n\nnext');
	});

	// Go: lifecycle.go branch — empty `event.Prompt` short-circuits the
	// entire prompt-persist block; no `.story/metadata/` dir is created and no
	// file is written. tests.md §2.1 case 8.
	it('skips prompt write when event.prompt empty', async () => {
		const sid = 'sid-noprompt';
		const ev = makeEvent({ sessionId: sid, prompt: '' });

		await handleTurnStart(makeAgent(), ev);

		const promptPath = path.join(tmpDir, storyMetadataDirForSession(sid), PROMPT_FILE_NAME);
		await expect(fs.stat(promptPath)).rejects.toThrow(/ENOENT/);
	});

	// Go: lifecycle.go — any failure writing `prompt.txt` is
	// `log.warn`-ed and swallowed (Go `logging.Warn(..., "failed to write prompt.txt", ...)`).
	// Covers tests.md §2.1 case 9 / 失败路径 #3 — fail-open I/O.
	it('swallows prompt.txt write error', async () => {
		vi.mocked(fs.writeFile).mockRejectedValueOnce(new Error('EACCES: denied'));
		const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
		const ev = makeEvent({ prompt: 'boom' });

		await expect(handleTurnStart(makeAgent(), ev)).resolves.toBeUndefined();

		expect(warnSpy).toHaveBeenCalledWith(
			expect.any(Object),
			'failed to write prompt.txt',
			expect.objectContaining({ error: expect.stringContaining('EACCES') }),
		);
		warnSpy.mockRestore();
	});

	// Go: lifecycle.go — `strategy.EnsureSetup(ctx)` failure is
	// `log.warn`-ed and swallowed. Story requires the worktree-root param that
	// Go's context-bound strategy picks up implicitly. tests.md §2.1 case 10 /
	// 失败路径 #4.
	it('ensureSetup failure swallowed', async () => {
		vi.mocked(ensureSetup).mockRejectedValueOnce(new Error('setup broke'));
		const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});

		await expect(handleTurnStart(makeAgent(), makeEvent())).resolves.toBeUndefined();

		expect(warnSpy).toHaveBeenCalledWith(
			expect.any(Object),
			'failed to ensure strategy setup',
			expect.objectContaining({ error: 'setup broke' }),
		);
		warnSpy.mockRestore();
	});

	// Go: lifecycle.go — `strat.InitializeSession` failure is
	// `log.warn`-ed and swallowed (per-turn `InitializeSession` is idempotent;
	// an error here usually means the session file race-wrote from another
	// hook). tests.md §2.1 case 11 / 失败路径 #5.
	it('initializeSession failure swallowed', async () => {
		initializeSessionMock.mockRejectedValueOnce(new Error('init broke'));
		const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});

		await expect(handleTurnStart(makeAgent(), makeEvent())).resolves.toBeUndefined();

		expect(warnSpy).toHaveBeenCalledWith(
			expect.any(Object),
			'failed to initialize session state',
			expect.objectContaining({ error: 'init broke' }),
		);
		warnSpy.mockRestore();
	});

	// Go: lifecycle.go — `strat.InitializeSession(ctx, sessionID, ag.Type(),
	// event.SessionRef, event.Prompt, event.Model)` — 5 positional args in that
	// order (ctx is TS-side dropped). Regression-guard for argument-order drift.
	// tests.md §2.1 case 12.
	it('calls initializeSession with 5 ordered args', async () => {
		const ev = makeEvent({
			sessionId: 'sid-ordered',
			sessionRef: '/some/ref.jsonl',
			prompt: 'ordered prompt',
			model: 'opus',
		});

		await handleTurnStart(makeAgent(), ev);

		expect(initializeSessionMock).toHaveBeenCalledTimes(1);
		expect(initializeSessionMock).toHaveBeenCalledWith(
			'sid-ordered',
			AGENT_TYPE_CLAUDE_CODE,
			'/some/ref.jsonl',
			'ordered prompt',
			'opus',
		);
	});

	// Go: lifecycle.go — `os.MkdirAll(sessionDirAbs, 0o750)`. Story
	// Node API uses `fs.mkdir(..., {recursive: true, mode: 0o750})`; mode
	// parity is user-visible (group-readable for team-shared repos). tests.md
	// §2.1 case 13.
	it('sessionMetadataDir created with mode 0o750', async () => {
		const sid = 'sid-mode';
		const ev = makeEvent({ sessionId: sid, prompt: 'anything' });

		await handleTurnStart(makeAgent(), ev);

		const expectedDir = path.join(tmpDir, storyMetadataDirForSession(sid));
		const mkdirCall = vi.mocked(fs.mkdir).mock.calls.find((c) => c[0] === expectedDir);
		expect(mkdirCall).toBeDefined();
		expect(mkdirCall?.[1]).toEqual(expect.objectContaining({ recursive: true, mode: 0o750 }));
	});

	// Go: lifecycle.go — `logging.Info(..., "turn-start", slog.String("event",...),
	// slog.String("session_id",...), slog.String("session_ref",...), slog.String("model",...))`.
	// Verifies the single log.info emission carries the 4 canonical fields.
	// tests.md §2.1 case 14.
	it('log.info fired with sessionId / sessionRef / model', async () => {
		const infoSpy = vi.spyOn(log, 'info').mockImplementation(() => {});

		await handleTurnStart(
			makeAgent(),
			makeEvent({
				sessionId: 'sid-log',
				sessionRef: '/log/ref.jsonl',
				model: 'sonnet',
			}),
		);

		const match = infoSpy.mock.calls.find((c) => c[1] === 'turn-start');
		expect(match).toBeDefined();
		expect(match?.[2]).toEqual(
			expect.objectContaining({
				event: 'TurnStart',
				sessionId: 'sid-log',
				sessionRef: '/log/ref.jsonl',
				model: 'sonnet',
			}),
		);
		infoSpy.mockRestore();
	});
});
