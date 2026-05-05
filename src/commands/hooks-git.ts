/**
 * Dispatcher for `story hooks git <name> [args...]` — the git-hook
 * CLI entry point.
 *
 * Each of the 5 `.git/hooks/` shell shims invokes
 * `story hooks git <name>` with the hook-specific args. This module
 * translates those arg lists into {@link ManualCommitStrategy} method
 * calls, minus three non-negotiables:
 *
 * 1. **Worktree gate** — silent exit when `worktreeRoot()` throws
 *    (i.e., not in a git repo). Hooks must never block an agent or a
 *    user's git command.
 * 2. **Enabled gate** — silent exit when `isSetUpAndEnabled(repoRoot)`
 *    returns `false` or throws. Matches Go's `hooks_git_cmd.go:
 *    PersistentPreRunE` setting `gitHooksDisabled = true`.
 * 3. **Error policy** — `commit-msg` propagates (git aborts the commit
 *    on non-zero exit, which is the *correct* behavior when the
 *    message becomes empty after trailer stripping). All 4 other
 *    hooks swallow errors (`log.debug` + void return).
 *
 * Mirrors Go `cmd/entire/cli/hooks_git_cmd.go` (5 × `RunE` handlers).
 *
 * cac doesn't support multi-word command names (e.g. `hooks git
 * post-commit`), so the top-level wiring in `src/cli.ts` uses a single
 * `hooks [...args]` catch-all and dispatches here via
 * {@link handleGitHookCommand}.
 *
 * @packageDocumentation
 */

import * as log from '@/log';
import { worktreeRoot } from '@/paths';
import { loadEnabledSettings } from '@/settings/settings';
import { ManualCommitStrategy } from '@/strategy/manual-commit';

/** The 5 git hook names that Story handles. */
const GIT_HOOK_NAMES = new Set([
	'prepare-commit-msg',
	'commit-msg',
	'post-commit',
	'post-rewrite',
	'pre-push',
]);

/**
 * Entry point for the `story hooks git <name> [args...]` path. `args`
 * is the list of positional args AFTER `git` (e.g.
 * `['prepare-commit-msg', '/tmp/COMMIT_EDITMSG', 'message']`).
 *
 * Silently no-ops when `args` is empty or `args[0]` is not a known git
 * hook. Silently no-ops when not in a git repo / Story is disabled.
 * Rethrows only errors that originate from `strategy.commitMsg(...)`
 * — every other branch swallows.
 *
 * Mirrors Go `hooks_git_cmd.go: newHooksGit*Cmd` (the collective
 * RunE action code).
 *
 * @example
 * // From cac action in src/cli.ts:
 * await handleGitHookCommand(['post-commit']);
 * // Side effects: invokes ManualCommitStrategy.postCommit() with the
 * // repo root from worktreeRoot(); any thrown error is log.debug-ged
 * // and swallowed.
 *
 * // commit-msg with empty message file → ManualCommitStrategy.commitMsg
 * // throws → this function rethrows so cac exits non-zero and git aborts
 * // the commit.
 * await handleGitHookCommand(['commit-msg', '/tmp/msg']);
 */
export async function handleGitHookCommand(args: string[]): Promise<void> {
	const hookName = args[0];
	if (hookName === undefined || !GIT_HOOK_NAMES.has(hookName)) {
		return;
	}

	switch (hookName) {
		case 'prepare-commit-msg': {
			const msgFile = args[1];
			if (msgFile === undefined) {
				return;
			}
			const source = args[2] ?? '';
			await runGitHook(hookName, false, async (strategy) => {
				await strategy.prepareCommitMsg(msgFile, source);
			});
			return;
		}
		case 'commit-msg': {
			const msgFile = args[1];
			if (msgFile === undefined) {
				return;
			}
			await runGitHook(hookName, true, async (strategy) => {
				await strategy.commitMsg(msgFile);
			});
			return;
		}
		case 'post-commit': {
			await runGitHook(hookName, false, async (strategy) => {
				await strategy.postCommit();
			});
			return;
		}
		case 'post-rewrite': {
			const rewriteType = args[1];
			if (rewriteType === undefined) {
				return;
			}
			await runGitHook(hookName, false, async (strategy) => {
				await strategy.postRewrite(rewriteType, process.stdin);
			});
			return;
		}
		case 'pre-push': {
			const remote = args[1];
			if (remote === undefined) {
				return;
			}
			await runGitHook(hookName, false, async (strategy) => {
				await strategy.prePush(remote);
			});
			return;
		}
	}
}

/**
 * Common orchestration for all git-hook dispatch paths: resolve repo
 * root → gate on `isSetUpAndEnabled` → construct strategy → run the
 * supplied `body` → structured-log any failure. Only the `propagate`
 * branch rethrows; every other hook swallows errors because the
 * shell shim uses `2>/dev/null || true` and we must never block
 * git operations.
 */
async function runGitHook(
	hookName: string,
	propagate: boolean,
	body: (strategy: ManualCommitStrategy) => Promise<void>,
): Promise<void> {
	let repoRoot: string;
	try {
		repoRoot = await worktreeRoot();
	} catch {
		return;
	}

	const settings = await loadEnabledSettings(repoRoot);
	if (settings === null) {
		return;
	}

	// Wire `.story/logs/story.log` so prepare-commit-msg / post-commit /
	// post-rewrite / pre-push logs land on disk. Git hook shim swallows
	// stderr via `2>/dev/null` so without this, all Story log output
	// from git-hook paths is silently lost.
	try {
		await log.init(repoRoot, settings.log_level ? { level: settings.log_level } : undefined);
	} catch {
		// Never block a hook on logger setup failure.
	}

	const logCtx = { component: 'hooks', hook: hookName };
	log.debug(logCtx, `${hookName} hook invoked`, {
		hook_type: 'git',
		strategy: 'manual-commit',
	});

	const strategy = new ManualCommitStrategy(repoRoot);

	try {
		await body(strategy);
	} catch (err) {
		if (propagate) {
			throw err;
		}
		log.debug(logCtx, `${hookName} hook error`, { error: (err as Error).message });
	}
}

/**
 * The 5 git hook names Story manages. Exported for CLI help / registry
 * introspection and test assertions.
 */
export const GIT_HOOK_VERBS = [
	'prepare-commit-msg',
	'commit-msg',
	'post-commit',
	'post-rewrite',
	'pre-push',
] as const;
