/**
 * Tests for `src/commands/hooks-agent.ts`.
 *
 * Mirrors Go `cmd/entire/cli/hook_registry_test.go` + the agent-fallback
 * `RunE` in `hooks_cmd.go`. TS design uses a single pure
 * `handleAgentHookCommand` function that dispatches through
 * `executeAgentHook` — the underlying lifecycle / agent-registry /
 * capability-check machinery is shipped in Phase 7 Part 2 at
 * `src/lifecycle/hook-registry.ts`.
 *
 * cac registration (a catch-all `hooks [...args]` command) lives in
 * `src/cli.ts`; this file exercises the dispatch function directly.
 *
 * ## Not-ported Go tests (N/A — architectural TS divergence)
 *
 * Go has per-agent concrete subcommands (`newAgentHookVerbCmdWithLogging`,
 * `ClaudeCodeHooksCmd`, `GeminiCLIHooksCmd`) each with cobra
 * `PersistentPreRunE` + `PostRunE` wiring logging around the hook. TS
 * uses a single catch-all `hooks [...args]` cac command because cac
 * lacks multi-word command trees. The following Go tests have no TS
 * 1:1 counterpart by design — logging attribution happens inside
 * `executeAgentHook` (`src/lifecycle/hook-registry.ts`) via
 * `log.debug({ component: 'hooks', agent, hook, ... }, 'hook invoked')`:
 *
 * - `TestNewAgentHookVerbCmd_LogsInvocation` — logging is tested in
 *   `tests/unit/lifecycle/hook-registry.test.ts` at the
 *   `executeAgentHook` level, not per-verb cmd level.
 * - `TestClaudeCodeHooksCmd_HasLoggingHooks` — no per-agent cmd factory
 *   in TS.
 * - `TestGeminiCLIHooksCmd_HasLoggingHooks` — no per-agent cmd factory
 *   in TS.
 *
 * `TestHookCommand_SetsCurrentHookAgentName` IS ported — see
 * `tests/unit/lifecycle/hook-registry.test.ts` (ALS-based current hook
 * agent tracking).
 */

import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const executeAgentHookMock = vi.hoisted(() =>
	vi.fn(async (_agent: string, _hook: string, _stdin: NodeJS.ReadableStream) => {}),
);

vi.mock('@/lifecycle/hook-registry', async (orig) => {
	const mod = (await orig()) as Record<string, unknown>;
	return { ...mod, executeAgentHook: executeAgentHookMock };
});

import { handleAgentHookCommand } from '@/commands/hooks-agent';

describe('commands/hooks-agent — Go: hook_registry.go + hooks_cmd.go', () => {
	let originalStdin: NodeJS.ReadStream;

	beforeEach(() => {
		vi.clearAllMocks();
		originalStdin = process.stdin;
	});

	afterEach(() => {
		Object.defineProperty(process, 'stdin', { value: originalStdin, configurable: true });
	});

	// ──── defensive input handling ────────────────────────────────
	describe('defensive dispatch', () => {
		it('empty args → no-op', async () => {
			await handleAgentHookCommand([]);
			expect(executeAgentHookMock).not.toHaveBeenCalled();
		});

		it('single arg (agent only, no hook) → no-op', async () => {
			await handleAgentHookCommand(['claude-code']);
			expect(executeAgentHookMock).not.toHaveBeenCalled();
		});
	});

	// ──── dispatch ────────────────────────────────────────────────
	// Go: hook_registry.go:95-165 executeAgentHook (delegated)
	describe('dispatch', () => {
		it('handleAgentHookCommand(["claude-code", "session-start"]) → executeAgentHook', async () => {
			const stdinStream = Readable.from([]);
			Object.defineProperty(process, 'stdin', {
				value: stdinStream,
				configurable: true,
			});
			await handleAgentHookCommand(['claude-code', 'session-start']);

			expect(executeAgentHookMock).toHaveBeenCalledTimes(1);
			expect(executeAgentHookMock).toHaveBeenCalledWith(
				'claude-code',
				'session-start',
				stdinStream,
			);
		});

		it('external agent — forwards arbitrary agent name', async () => {
			await handleAgentHookCommand(['my-external-agent', 'turn-end']);
			expect(executeAgentHookMock).toHaveBeenCalledWith(
				'my-external-agent',
				'turn-end',
				expect.anything(),
			);
		});

		it('cursor before-submit-prompt forwards correctly', async () => {
			await handleAgentHookCommand(['cursor', 'before-submit-prompt']);
			expect(executeAgentHookMock).toHaveBeenCalledWith(
				'cursor',
				'before-submit-prompt',
				expect.anything(),
			);
		});

		it('codex stop forwards correctly', async () => {
			await handleAgentHookCommand(['codex', 'stop']);
			expect(executeAgentHookMock).toHaveBeenCalledWith('codex', 'stop', expect.anything());
		});

		it('opencode session-start forwards correctly', async () => {
			await handleAgentHookCommand(['opencode', 'session-start']);
			expect(executeAgentHookMock).toHaveBeenCalledWith(
				'opencode',
				'session-start',
				expect.anything(),
			);
		});

		it('ignores extra args beyond agent+hook', async () => {
			await handleAgentHookCommand(['claude-code', 'post-todo', 'extra', 'args']);
			expect(executeAgentHookMock).toHaveBeenCalledWith(
				'claude-code',
				'post-todo',
				expect.anything(),
			);
		});
	});

	// ──── error propagation (Go parity) ───────────────────────────
	// Go: hook_registry.go:176 — `return executeAgentHook(cmd, agent, hook, false)`
	// propagates the error to cobra's `RunE`, which exits non-zero. Matching
	// Go parity means TS must NOT swallow errors — agent CLIs rely on the
	// hook shim's exit code to detect failures.
	describe('error propagation', () => {
		it('propagates executeAgentHook errors (matches Go RunE returning error)', async () => {
			executeAgentHookMock.mockRejectedValueOnce(new Error('dispatch failed'));
			await expect(handleAgentHookCommand(['claude-code', 'turn-end'])).rejects.toThrow(
				/dispatch failed/,
			);
		});

		it('propagates synchronously-rejected promise', async () => {
			executeAgentHookMock.mockImplementationOnce(() => Promise.reject(new Error('boom')));
			await expect(handleAgentHookCommand(['codex', 'stop'])).rejects.toThrow(/boom/);
		});

		it('propagates Error with agent-specific context (agent not found)', async () => {
			executeAgentHookMock.mockRejectedValueOnce(
				new Error('failed to get agent "unknown": agent not found in registry'),
			);
			await expect(handleAgentHookCommand(['unknown', 'session-start'])).rejects.toThrow(
				/agent not found in registry/,
			);
		});
	});
});
