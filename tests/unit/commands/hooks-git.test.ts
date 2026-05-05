/**
 * Tests for `src/commands/hooks-git.ts`.
 *
 * Mirrors Go `cmd/entire/cli/hooks_git_cmd_test.go` (5 tests). Go's test
 * emphasis is on `initHookLogging` + external agent discovery + subcommand
 * exposure; TS emphasis is on:
 * - `handleGitHookCommand` dispatches to the right ManualCommitStrategy method
 * - Settings-enabled gate short-circuits (see API surface decision below)
 * - parameter forwarding
 * - commit-msg propagates error, others swallow
 *
 * cac's `hooks [...args]` → `handleGitHookCommand(args.slice(1))` wiring is
 * done in `src/cli.ts` (covered by e2e), so these tests call the pure
 * function directly.
 *
 * ## API surface decision — `loadEnabledSettings` + `isSetUpAndEnabled`
 *
 * `src/commands/hooks-git.ts` gates on `loadEnabledSettings(repoRoot)`
 * (→ returns `StorySettings | null`), **not** the thin boolean wrapper
 * `isSetUpAndEnabled(repoRoot)`. The rationale is documented in
 * `src/settings/settings.ts:462-471` and `src/commands/hooks-git.ts:147`:
 *
 * - Hook entry points need both the gate decision AND the loaded settings
 *   (to route `log_level` into `log.init`). Calling `isSetUpAndEnabled`
 *   then re-reading `settings.json` via `load()` would touch disk twice
 *   and race if the file changed between reads.
 * - `isSetUpAndEnabled` is retained as a public export for callers that
 *   only need the boolean gate (doctor, docs, `initHookLogging` parity).
 *
 * Both exports are mocked below so the test module mirrors the real
 * module's surface — accidental regression to calling `isSetUpAndEnabled`
 * inside the hook dispatcher would show up here as an unexpected mock
 * hit on the boolean path.
 *
 * ## Not-ported Go tests (N/A — architectural TS divergence)
 *
 * - `TestInitHookLogging` — TS does not expose a standalone
 *   `initHookLogging` function. Hook logging context (`component: 'hooks'`,
 *   `hook: <name>`, `hook_type: 'git'`) is attached inside `runGitHook`
 *   via `log.debug` at each dispatch. Session-ID discovery + log-file
 *   opening happens at `src/log.ts` CLI initialization, not per-hook.
 * - `TestInitHookLogging_SkipsWhenNotSetUp` — absorbed into TS's
 *   settings-enabled gate test (silent return when `loadEnabledSettings`
 *   returns `null`). No separate "logs not created" assertion because
 *   TS logs go to `.story/logs/story.log` (initialized once at CLI start).
 * - `TestInitHookLogging_SkipsWhenDisabled` — same rationale as above;
 *   the gate path fully short-circuits before any dispatch.
 * - `TestHooksGitCmd_DiscoverExternalAgents_WhenEnabled` — TS eager-
 *   discovers external agents at CLI startup (`src/cli.ts: run()` calls
 *   `discoverAndRegister()` before parsing argv). Go lazy-discovers on
 *   each hook invocation via cobra `PersistentPreRunE` with a 5s
 *   timeout; TS removes that timing concern by discovering once.
 * - `TestHooksGitCmd_ExposesPostRewriteSubcommand` — cac lacks
 *   multi-word subcommands so there's no `post-rewrite` cobra command
 *   object to introspect. `GIT_HOOK_VERBS` contains the verb and
 *   dispatch test `post-rewrite forwards (type, process.stdin)` proves
 *   runtime exposure.
 */

import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StorySettings } from '@/settings/settings';

// Hoisted mocks — consumed by the dispatched runGitHook body.
// `loadEnabledSettings` is what `hooks-git.ts:147` actually calls;
// `isSetUpAndEnabled` is kept alongside to preserve the module's full
// public surface (see file-level JSDoc "API surface decision").
const loadEnabledSettingsMock = vi.hoisted(() =>
	// biome-ignore lint/suspicious/noExplicitAny: narrow at call sites
	vi.fn(async (_root: string): Promise<StorySettings | null> => ({ enabled: true }) as any),
);
const isSetUpAndEnabledMock = vi.hoisted(() => vi.fn(async (_root: string) => true));
const prepareCommitMsgMock = vi.hoisted(() => vi.fn(async (_f: string, _s: string) => {}));
const commitMsgMock = vi.hoisted(() => vi.fn(async (_f: string) => {}));
const postCommitMock = vi.hoisted(() => vi.fn(async () => {}));
const postRewriteMock = vi.hoisted(() =>
	vi.fn(async (_t: string, _stdin: NodeJS.ReadableStream) => {}),
);
const prePushMock = vi.hoisted(() => vi.fn(async (_r: string) => {}));
const worktreeRootMock = vi.hoisted(() => vi.fn(async () => '/tmp/repo'));

const manualCommitCtorMock = vi.hoisted(() =>
	vi.fn().mockImplementation(() => ({
		prepareCommitMsg: prepareCommitMsgMock,
		commitMsg: commitMsgMock,
		postCommit: postCommitMock,
		postRewrite: postRewriteMock,
		prePush: prePushMock,
	})),
);

vi.mock('@/settings/settings', async (orig) => {
	const mod = (await orig()) as Record<string, unknown>;
	return {
		...mod,
		loadEnabledSettings: loadEnabledSettingsMock,
		isSetUpAndEnabled: isSetUpAndEnabledMock,
	};
});

vi.mock('@/strategy/manual-commit', () => ({
	ManualCommitStrategy: manualCommitCtorMock,
}));

vi.mock('@/paths', async (orig) => {
	const mod = (await orig()) as Record<string, unknown>;
	return { ...mod, worktreeRoot: worktreeRootMock };
});

import { GIT_HOOK_VERBS, handleGitHookCommand } from '@/commands/hooks-git';

describe('commands/hooks-git — Go: hooks_git_cmd.go', () => {
	let originalStdin: NodeJS.ReadStream;

	beforeEach(() => {
		vi.clearAllMocks();
		// biome-ignore lint/suspicious/noExplicitAny: StorySettings minimal shape
		loadEnabledSettingsMock.mockResolvedValue({ enabled: true } as any);
		isSetUpAndEnabledMock.mockResolvedValue(true);
		worktreeRootMock.mockResolvedValue('/tmp/repo');
		originalStdin = process.stdin;
	});

	afterEach(() => {
		Object.defineProperty(process, 'stdin', { value: originalStdin, configurable: true });
	});

	// ──── registration ────────────────────────────────────────────
	// Go: hooks_git_cmd.go:91-131 newHooksGitCmd (5 subcommands)
	describe('hook verb list', () => {
		it('GIT_HOOK_VERBS lists the 5 managed git hooks', () => {
			expect(GIT_HOOK_VERBS).toEqual([
				'prepare-commit-msg',
				'commit-msg',
				'post-commit',
				'post-rewrite',
				'pre-push',
			]);
		});
	});

	// Go: hooks_git_cmd.go:97-104 PersistentPreRunE sets gitHooksDisabled.
	// TS gates on `loadEnabledSettings` (returns `null` for disabled / not
	// set up / load failure — all three funnel into the same silent-skip
	// branch at `hooks-git.ts:148-150`). See top-of-file JSDoc for why we
	// gate on the settings-loader rather than the boolean wrapper.
	describe('settings gate (loadEnabledSettings)', () => {
		it('gate null (disabled / not set up) — does not instantiate ManualCommitStrategy', async () => {
			loadEnabledSettingsMock.mockResolvedValue(null);
			await handleGitHookCommand(['post-commit']);
			expect(manualCommitCtorMock).not.toHaveBeenCalled();
			expect(postCommitMock).not.toHaveBeenCalled();
		});

		// TS-divergence (fail-closed): Go `IsEnabled(ctx)` returns
		// `(true, err)` on load failure so Go keeps running the hook
		// (fail-open). TS `loadEnabledSettings` catches all load errors
		// internally and returns `null`, matching the disabled path above.
		// We simulate the null-from-load-error condition here; in
		// production `loadEnabledSettings` itself cannot throw.
		it('gate null (simulates settings load failure) — silent skip', async () => {
			loadEnabledSettingsMock.mockResolvedValue(null);
			await handleGitHookCommand(['post-commit']);
			expect(manualCommitCtorMock).not.toHaveBeenCalled();
		});

		it('worktreeRoot throws (not in git repo) — silent', async () => {
			worktreeRootMock.mockRejectedValue(new Error('not a git repo'));
			await handleGitHookCommand(['post-commit']);
			expect(manualCommitCtorMock).not.toHaveBeenCalled();
		});
	});

	// ──── no-op on unknown / empty args ───────────────────────────
	describe('defensive dispatch', () => {
		it('empty args — no-op', async () => {
			await handleGitHookCommand([]);
			expect(manualCommitCtorMock).not.toHaveBeenCalled();
		});

		it('unknown hook name — no-op', async () => {
			await handleGitHookCommand(['not-a-hook']);
			expect(manualCommitCtorMock).not.toHaveBeenCalled();
		});

		it('prepare-commit-msg with no msgFile arg → no-op', async () => {
			await handleGitHookCommand(['prepare-commit-msg']);
			expect(prepareCommitMsgMock).not.toHaveBeenCalled();
		});

		it('commit-msg with no msgFile arg → no-op', async () => {
			await handleGitHookCommand(['commit-msg']);
			expect(commitMsgMock).not.toHaveBeenCalled();
		});

		it('post-rewrite with no type arg → no-op', async () => {
			await handleGitHookCommand(['post-rewrite']);
			expect(postRewriteMock).not.toHaveBeenCalled();
		});

		it('pre-push with no remote arg → no-op', async () => {
			await handleGitHookCommand(['pre-push']);
			expect(prePushMock).not.toHaveBeenCalled();
		});
	});

	// ──── dispatch + arg forwarding ───────────────────────────────
	describe('arg forwarding & dispatch', () => {
		it('prepare-commit-msg forwards (msgFile, source)', async () => {
			await handleGitHookCommand(['prepare-commit-msg', '/tmp/msg', 'message']);
			expect(prepareCommitMsgMock).toHaveBeenCalledWith('/tmp/msg', 'message');
		});

		it('prepare-commit-msg — source omitted → forwards ""', async () => {
			await handleGitHookCommand(['prepare-commit-msg', '/tmp/msg']);
			expect(prepareCommitMsgMock).toHaveBeenCalledWith('/tmp/msg', '');
		});

		it('commit-msg forwards msgFile and propagates error', async () => {
			commitMsgMock.mockRejectedValueOnce(new Error('empty commit'));
			await expect(handleGitHookCommand(['commit-msg', '/tmp/m'])).rejects.toThrow(/empty commit/);
			expect(commitMsgMock).toHaveBeenCalledWith('/tmp/m');
		});

		it('commit-msg success — resolves void', async () => {
			await expect(handleGitHookCommand(['commit-msg', '/tmp/m'])).resolves.toBeUndefined();
			expect(commitMsgMock).toHaveBeenCalledWith('/tmp/m');
		});

		it('post-commit invokes strategy.postCommit', async () => {
			await handleGitHookCommand(['post-commit']);
			expect(postCommitMock).toHaveBeenCalled();
		});

		it('post-commit swallows error', async () => {
			postCommitMock.mockRejectedValueOnce(new Error('kaboom'));
			await expect(handleGitHookCommand(['post-commit'])).resolves.toBeUndefined();
		});

		it('post-rewrite forwards (type, process.stdin)', async () => {
			const stdinStream = Readable.from([]);
			Object.defineProperty(process, 'stdin', {
				value: stdinStream,
				configurable: true,
			});

			await handleGitHookCommand(['post-rewrite', 'rebase']);
			expect(postRewriteMock).toHaveBeenCalledWith('rebase', stdinStream);
		});

		it('post-rewrite swallows error', async () => {
			postRewriteMock.mockRejectedValueOnce(new Error('nope'));
			await expect(handleGitHookCommand(['post-rewrite', 'amend'])).resolves.toBeUndefined();
		});

		it('pre-push forwards remote name and swallows error', async () => {
			prePushMock.mockRejectedValueOnce(new Error('network'));
			await expect(handleGitHookCommand(['pre-push', 'origin'])).resolves.toBeUndefined();
			expect(prePushMock).toHaveBeenCalledWith('origin');
		});

		it('pre-push success — resolves void', async () => {
			await handleGitHookCommand(['pre-push', 'origin']);
			expect(prePushMock).toHaveBeenCalledWith('origin');
		});
	});
});
