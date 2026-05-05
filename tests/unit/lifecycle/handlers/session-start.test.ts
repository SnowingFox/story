/**
 * Phase 7 Part 1 `src/lifecycle/handlers/session-start.ts` — 8 case.
 *
 * Go 参考：`cmd/entire/cli/lifecycle.go`:
 * - `TestHandleLifecycleSessionStart_EmptySessionID`
 * - `TestHandleLifecycleSessionStart_EmptyRepoWarning`
 * - `TestHandleLifecycleSessionStart_DefaultMessageWithCommits`
 * - `TestSessionStartMessage_CodexUsesSingleLineBanner` (+ emptyRepo variant)
 * - `TestHandleLifecycleSessionStart_CodexConcurrentSessionsStaySingleLine`
 *
 * Story-side layout:
 * - `@/strategy/repo.isEmptyRepository` and `@/strategy/session-state.*` are
 *   module-mocked so the handler can be exercised without touching disk /
 *   running git commands.
 * - Minimal `Agent` stubs (with / without `HookResponseWriter`) cover the
 *   capability-gating branches.
 *
 * TS-divergence from Go (documented inline in handler source):
 * 1. Empty `event.sessionId` → falls back to `UNKNOWN_SESSION_ID` (Go throws).
 * 2. Empty repo → banner is NOT written (Go writes empty-repo variant).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Event } from '@/agent/event';
import type { Agent, HookResponseWriter } from '@/agent/interfaces';
import { AGENT_NAME_CLAUDE_CODE, AGENT_NAME_CODEX, type AgentName } from '@/agent/types';
import { handleSessionStart, sessionStartMessage } from '@/lifecycle/handlers/session-start';
import * as log from '@/log';
import type { SessionState } from '@/session/state-store';

const countOtherMock = vi.hoisted(() => vi.fn(async (_sid: string) => 0));

vi.mock('@/strategy/repo', () => ({
	isEmptyRepository: vi.fn(),
	getGitCommonDir: vi.fn(async () => '/fake/.git'),
}));
vi.mock('@/strategy/session-state', () => ({
	loadSessionState: vi.fn(async () => null),
	saveSessionState: vi.fn(async () => {}),
	storeModelHint: vi.fn(async () => {}),
	transitionAndLog: vi.fn(async () => {}),
}));
vi.mock('@/strategy/manual-commit', () => ({
	ManualCommitStrategy: vi.fn().mockImplementation(() => ({
		countOtherActiveSessionsWithCheckpoints: countOtherMock,
	})),
}));

import { isEmptyRepository } from '@/strategy/repo';
import {
	loadSessionState,
	saveSessionState,
	storeModelHint,
	transitionAndLog,
} from '@/strategy/session-state';

function makeEvent(overrides: Partial<Event> = {}): Event {
	return {
		type: 'SessionStart',
		sessionId: 'sid-1',
		previousSessionId: '',
		sessionRef: '',
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

/** Minimal Agent with no optional capabilities. */
function makeAgent(name: AgentName = AGENT_NAME_CLAUDE_CODE): Agent {
	return { name: () => name } as Agent;
}

/** Agent implementing HookResponseWriter — `writeHookResponse` is a Vi spy. */
function makeWriterAgent(name: AgentName = AGENT_NAME_CLAUDE_CODE): Agent & HookResponseWriter {
	const writer = vi.fn(async (_msg: string) => {});
	return {
		name: () => name,
		writeHookResponse: writer,
	} as unknown as Agent & HookResponseWriter;
}

describe('lifecycle/handlers/session-start', () => {
	beforeEach(() => {
		vi.mocked(isEmptyRepository).mockReset().mockResolvedValue(false);
		vi.mocked(loadSessionState).mockReset().mockResolvedValue(null);
		vi.mocked(saveSessionState).mockReset().mockResolvedValue();
		vi.mocked(storeModelHint).mockReset().mockResolvedValue();
		vi.mocked(transitionAndLog).mockReset().mockResolvedValue();
		countOtherMock.mockReset().mockResolvedValue(0);
	});

	// Go: TestHandleLifecycleSessionStart_EmptySessionID
	it('fallback to UNKNOWN_SESSION_ID when event.sessionId empty', async () => {
		const ag = makeAgent();
		const ev = makeEvent({ sessionId: '', model: 'sonnet' });

		await handleSessionStart(ag, ev);

		// When sessionId is empty, handler should still progress and pass
		// 'unknown' through for cross-step correlation (TS-divergence 1).
		expect(vi.mocked(storeModelHint)).toHaveBeenCalledWith('unknown', 'sonnet');
		expect(vi.mocked(loadSessionState)).toHaveBeenCalledWith('unknown');
	});

	// Go: TestHandleLifecycleSessionStart_EmptyRepoWarning
	it('does NOT write banner in empty repository', async () => {
		vi.mocked(isEmptyRepository).mockResolvedValue(true);
		const ag = makeWriterAgent();
		await handleSessionStart(ag, makeEvent());

		expect(ag.writeHookResponse).not.toHaveBeenCalled();
	});

	// Go: TestHandleLifecycleSessionStart_DefaultMessageWithCommits
	it('writes default banner in non-empty repo with HookResponseWriter agent', async () => {
		vi.mocked(isEmptyRepository).mockResolvedValue(false);
		const ag = makeWriterAgent();
		await handleSessionStart(ag, makeEvent());

		expect(ag.writeHookResponse).toHaveBeenCalledTimes(1);
		const [msg] = vi.mocked(ag.writeHookResponse).mock.calls[0] as [string];
		expect(msg).toContain('Story');
		expect(msg).not.toContain('Entire');
	});

	// Go: lifecycle_test.go TestSessionStartMessage_CodexUsesSingleLineBanner
	// byte-exact assertion (Story-rebranded): the Codex single-line banner
	// must be `'Powered by Story: This conversation will be linked to your
	// next commit.'` with NO surrounding newlines; the non-Codex banner
	// must start with `'\n\n'` and contain an indent-block `'\n  '` prefix.
	it('Codex banner is byte-exact single line; non-Codex banner is byte-exact multi-line block', () => {
		expect(sessionStartMessage(AGENT_NAME_CODEX, false)).toBe(
			'Powered by Story: This conversation will be linked to your next commit.',
		);

		expect(sessionStartMessage(AGENT_NAME_CLAUDE_CODE, false)).toBe(
			'\n\nPowered by Story:\n  This conversation will be linked to your next commit.',
		);
	});

	// Go: lifecycle_test.go TestSessionStartMessage_CodexUsesSingleLineBannerForEmptyRepo
	// byte-exact assertion (Story-rebranded): empty-repo variants use
	// `'No commits yet — checkpoints will activate after your first commit.'`
	// (note the Unicode em-dash `—`, not ASCII `-`).
	it('empty-repo banners are byte-exact (single-line Codex / multi-line non-Codex, em-dash literal)', () => {
		expect(sessionStartMessage(AGENT_NAME_CODEX, true)).toBe(
			'Powered by Story: No commits yet — checkpoints will activate after your first commit.',
		);

		expect(sessionStartMessage(AGENT_NAME_CLAUDE_CODE, true)).toBe(
			'\n\nPowered by Story:\n  No commits yet — checkpoints will activate after your first commit.',
		);
	});

	// Go: TestHandleLifecycleSessionStart_CodexConcurrentSessionsStaySingleLine
	it('banner output remains single line across concurrent session-start invocations', async () => {
		vi.mocked(isEmptyRepository).mockResolvedValue(false);
		const a1 = makeWriterAgent();
		const a2 = makeWriterAgent();

		await Promise.all([
			handleSessionStart(a1, makeEvent({ sessionId: 'sid-a' })),
			handleSessionStart(a2, makeEvent({ sessionId: 'sid-b' })),
		]);

		expect(a1.writeHookResponse).toHaveBeenCalledTimes(1);
		expect(a2.writeHookResponse).toHaveBeenCalledTimes(1);
	});

	// Story 补充: writeHookResponse failure logged + not re-thrown
	it('writeHookResponse failure logged + not re-thrown', async () => {
		vi.mocked(isEmptyRepository).mockResolvedValue(false);
		const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
		const ag = makeWriterAgent();
		vi.mocked(ag.writeHookResponse).mockRejectedValueOnce(new Error('boom'));

		await expect(handleSessionStart(ag, makeEvent())).resolves.toBeUndefined();

		expect(warnSpy).toHaveBeenCalledWith(
			expect.any(Object),
			'failed to write session-start banner',
			expect.objectContaining({ error: 'boom' }),
		);
		warnSpy.mockRestore();
	});

	// Story 补充: isEmptyRepository failure defaults to non-empty + continues to write banner
	it('isEmptyRepository failure defaults to non-empty + continues to write banner', async () => {
		vi.mocked(isEmptyRepository).mockRejectedValue(new Error('git boom'));
		const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
		const ag = makeWriterAgent();

		await handleSessionStart(ag, makeEvent());

		expect(ag.writeHookResponse).toHaveBeenCalledTimes(1);
		expect(warnSpy).toHaveBeenCalledWith(
			expect.any(Object),
			'failed to determine empty-repo state',
			expect.objectContaining({ error: 'git boom' }),
		);
		warnSpy.mockRestore();
	});

	// Story 补充: state-loaded happy path runs transition + save
	it('when state is loaded, runs persistEventMetadataToState + transitionAndLog + saveSessionState', async () => {
		const state: SessionState = {
			sessionId: 'sid-1',
			baseCommit: 'abc123',
			startedAt: new Date().toISOString(),
			phase: 'idle',
			stepCount: 0,
		};
		vi.mocked(loadSessionState).mockResolvedValue(state);
		const ag = makeWriterAgent();

		await handleSessionStart(ag, makeEvent({ sessionId: 'sid-1', model: 'sonnet' }));

		expect(vi.mocked(transitionAndLog)).toHaveBeenCalledTimes(1);
		expect(vi.mocked(saveSessionState)).toHaveBeenCalledTimes(1);
		expect(vi.mocked(saveSessionState).mock.calls[0]?.[0]?.sessionId).toBe('sid-1');
		expect(vi.mocked(saveSessionState).mock.calls[0]?.[0]?.modelName).toBe('sonnet');
	});

	// Story 补充: transitionAndLog failure logged + saveSessionState still runs
	it('transitionAndLog failure is logged + saveSessionState still runs', async () => {
		const state: SessionState = {
			sessionId: 'sid-1',
			baseCommit: 'abc123',
			startedAt: new Date().toISOString(),
			phase: 'idle',
			stepCount: 0,
		};
		vi.mocked(loadSessionState).mockResolvedValue(state);
		vi.mocked(transitionAndLog).mockRejectedValue(new Error('bad transition'));
		const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
		const ag = makeAgent();

		await handleSessionStart(ag, makeEvent({ sessionId: 'sid-1' }));

		expect(warnSpy).toHaveBeenCalledWith(
			expect.any(Object),
			'session start transition failed',
			expect.objectContaining({ error: 'bad transition' }),
		);
		expect(vi.mocked(saveSessionState)).toHaveBeenCalledTimes(1);
		warnSpy.mockRestore();
	});

	// Story 补充: saveSessionState failure is logged + does not propagate
	it('saveSessionState failure is logged + does not propagate', async () => {
		const state: SessionState = {
			sessionId: 'sid-1',
			baseCommit: 'abc123',
			startedAt: new Date().toISOString(),
			phase: 'idle',
			stepCount: 0,
		};
		vi.mocked(loadSessionState).mockResolvedValue(state);
		vi.mocked(saveSessionState).mockRejectedValue(new Error('disk full'));
		const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
		const ag = makeAgent();

		await expect(
			handleSessionStart(ag, makeEvent({ sessionId: 'sid-1' })),
		).resolves.toBeUndefined();

		expect(warnSpy).toHaveBeenCalledWith(
			expect.any(Object),
			'failed to update session state on start',
			expect.objectContaining({ error: 'disk full' }),
		);
		warnSpy.mockRestore();
	});

	// Story 补充: loadSessionState failure is logged + handler continues
	it('loadSessionState failure is logged + handler continues without state mutations', async () => {
		vi.mocked(loadSessionState).mockRejectedValue(new Error('load boom'));
		const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
		const ag = makeAgent();

		await expect(
			handleSessionStart(ag, makeEvent({ sessionId: 'sid-1' })),
		).resolves.toBeUndefined();

		expect(warnSpy).toHaveBeenCalledWith(
			expect.any(Object),
			'failed to load session state on start',
			expect.objectContaining({ error: 'load boom' }),
		);
		expect(vi.mocked(transitionAndLog)).not.toHaveBeenCalled();
		expect(vi.mocked(saveSessionState)).not.toHaveBeenCalled();
		warnSpy.mockRestore();
	});

	// Story 补充: storeModelHint failure is logged + handler continues
	it('storeModelHint failure is logged + handler continues', async () => {
		vi.mocked(storeModelHint).mockRejectedValue(new Error('hint fail'));
		const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
		const ag = makeAgent();

		await expect(
			handleSessionStart(ag, makeEvent({ sessionId: 'sid-1', model: 'opus' })),
		).resolves.toBeUndefined();

		expect(warnSpy).toHaveBeenCalledWith(
			expect.any(Object),
			'failed to store model hint on session start',
			expect.objectContaining({ error: 'hint fail' }),
		);
		warnSpy.mockRestore();
	});

	// Go: lifecycle.go — concurrent session count gets appended to banner.
	// Non-Codex: newline + two-space indent block (Story-rebranded: `story status`).
	it('appends concurrent-session block for non-Codex agents (newline + indent)', async () => {
		vi.mocked(isEmptyRepository).mockResolvedValue(false);
		countOtherMock.mockResolvedValue(2);
		const ag = makeWriterAgent(AGENT_NAME_CLAUDE_CODE);

		await handleSessionStart(ag, makeEvent({ sessionId: 'sid-1' }));

		expect(ag.writeHookResponse).toHaveBeenCalledTimes(1);
		const [msg] = vi.mocked(ag.writeHookResponse).mock.calls[0] as [string];
		expect(msg).toContain(
			'2 other active conversation(s) in this workspace will also be included.',
		);
		expect(msg).toContain("Use 'story status' for more information.");
		expect(msg).not.toContain("'entire status'");
		expect(msg).toMatch(/\n {2}2 other active/);
		expect(countOtherMock).toHaveBeenCalledWith('sid-1');
	});

	// Go: lifecycle.go — Codex gets the single-line variant
	// (space-prefixed, no newline). Byte-exact assertion: the full banner
	// emitted for a Codex agent with 1 concurrent checkpoint session must
	// be the single-line golden string (base banner + space-delimited
	// suffix + story-rebranded `'story status'` hint). No `\n` anywhere.
	it('appends concurrent-session hint on a single line for Codex (byte-exact)', async () => {
		vi.mocked(isEmptyRepository).mockResolvedValue(false);
		countOtherMock.mockResolvedValue(1);
		const ag = makeWriterAgent(AGENT_NAME_CODEX);

		await handleSessionStart(ag, makeEvent({ sessionId: 'sid-codex' }));

		const [msg] = vi.mocked(ag.writeHookResponse).mock.calls[0] as [string];
		expect(msg).toBe(
			"Powered by Story: This conversation will be linked to your next commit. 1 other active conversation(s) in this workspace will also be included. Use 'story status' for more information.",
		);
		expect(msg).not.toContain('\n');
	});

	// Story 补充: count query failure falls back to 0 (no suffix appended) + log.warn.
	it('countOtherActiveSessionsWithCheckpoints failure logs warn + skips the suffix', async () => {
		vi.mocked(isEmptyRepository).mockResolvedValue(false);
		countOtherMock.mockRejectedValue(new Error('git boom'));
		const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
		const ag = makeWriterAgent();

		await handleSessionStart(ag, makeEvent({ sessionId: 'sid-1' }));

		const [msg] = vi.mocked(ag.writeHookResponse).mock.calls[0] as [string];
		expect(msg).not.toContain('other active conversation');
		expect(warnSpy).toHaveBeenCalledWith(
			expect.any(Object),
			'failed to count other active sessions',
			expect.objectContaining({ error: 'git boom' }),
		);
		warnSpy.mockRestore();
	});

	// Go: lifecycle.go — Go calls validation.ValidateSessionID and returns error
	// on non-empty but invalid sessionId. TS handler does NOT validate: it passes the
	// raw value through, continues to banner + state-load + storeModelHint. This
	// recovery path is intentional — the CLI top-level catches hard errors; banner
	// printing and hint storage stay best-effort.
	it('non-empty but invalid sessionId: TS passes it through (no validate) + still emits banner', async () => {
		vi.mocked(isEmptyRepository).mockResolvedValue(false);
		const ag = makeWriterAgent();

		const badId = 'has spaces and UPPER!';
		await handleSessionStart(ag, makeEvent({ sessionId: badId, model: 'sonnet' }));

		expect(ag.writeHookResponse).toHaveBeenCalledTimes(1);
		expect(vi.mocked(storeModelHint)).toHaveBeenCalledWith(badId, 'sonnet');
		expect(vi.mocked(loadSessionState)).toHaveBeenCalledWith(badId);
	});

	// Go: lifecycle.go — event.responseMessage overrides the entire composed message
	// (including any concurrent-sessions suffix).
	it('event.responseMessage overrides both base banner and concurrent-sessions suffix', async () => {
		vi.mocked(isEmptyRepository).mockResolvedValue(false);
		countOtherMock.mockResolvedValue(5);
		const ag = makeWriterAgent();

		await handleSessionStart(
			ag,
			makeEvent({ sessionId: 'sid-1', responseMessage: 'custom override' }),
		);

		const [msg] = vi.mocked(ag.writeHookResponse).mock.calls[0] as [string];
		expect(msg).toBe('custom override');
	});
});
