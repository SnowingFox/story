/**
 * `prePush` git hook entry point — pushes the v1 metadata branch alongside
 * the user's push, plus v2 refs when both `checkpoints_v2` and
 * `push_v2_refs` are enabled.
 *
 * If a `checkpoint_remote` is configured in settings, checkpoint
 * branches/refs are pushed to the derived URL instead of the user's push
 * remote.
 *
 * Configuration (stored in `.story/settings.json` under `strategy_options`):
 *   - `push_sessions: false` — disable automatic pushing of checkpoints
 *   - `checkpoint_remote: { provider: 'github', repo: 'org/repo' }` — push
 *     to a separate repo
 *   - `push_v2_refs: true` — enable pushing v2 refs (requires `checkpoints_v2`)
 *
 * **Hook contract**: this function NEVER throws. All errors are written to
 * stderr as `[story] Warning` lines and swallowed so a Story-internal
 * failure never blocks the user's `git push`.
 *
 * Mirrors Go `(s *ManualCommitStrategy) PrePush(ctx, remote)` in
 * `entire-cli/cmd/entire/cli/strategy/manual_commit_push.go`.
 */

import { METADATA_BRANCH_NAME } from '@/checkpoint/constants';
import { isPushV2RefsEnabled, readSettings, type StorySettings } from '@/settings/settings';
import { pushTarget, resolvePushSettings } from './checkpoint-remote';
import type { ManualCommitStrategy } from './manual-commit';
import { pushBranchIfNeeded } from './push-common';
import { pushV2Refs } from './push-v2';

/**
 * Push v1 metadata branch + v2 refs to the given remote at git pre-push
 * time. 4-step pipeline:
 *
 *   1. `resolvePushSettings(ctx, remote)` → `{ remote, checkpointURL, pushDisabled }`
 *      (also fetches missing v1/v2 refs from the checkpoint URL when configured)
 *   2. If `pushDisabled` → return immediately
 *   3. `pushBranchIfNeeded(pushTarget, METADATA_BRANCH_NAME)` (v1 metadata branch)
 *   4. If `isPushV2RefsEnabled(settings)` → `pushV2Refs(pushTarget)`
 *
 * @example
 * ```ts
 * await prePushImpl(strategy, 'origin');
 * // returns: void (always — silent on failure per hook contract)
 *
 * // Side effects:
 * //   - May spawn 1-5 git CLI subprocesses (fetch / push)
 * //   - May write refs/remotes/origin/story/checkpoints/v1
 * //   - May write refs/story/checkpoints/v2/* (rotation recovery)
 * //   - All errors → stderr `[story] Warning ...` lines, then resolve void
 * //   - Hook NEVER fails the user's git push (the returned promise always
 * //     resolves; it does NOT reject)
 * //
 * // Worktree / index / HEAD: unchanged.
 * ```
 */
export async function prePushImpl(s: ManualCommitStrategy, remote: string): Promise<void> {
	const repo = await s.getRepo();
	const cwd = repo.root;

	let ps: Awaited<ReturnType<typeof resolvePushSettings>>;
	try {
		ps = await resolvePushSettings(remote, { cwd });
	} catch {
		// resolvePushSettings already swallows known failure modes; this catch
		// is the absolute last-resort silent-on-failure guard.
		return;
	}
	if (ps.pushDisabled) {
		return;
	}

	const target = pushTarget(ps);

	try {
		await pushBranchIfNeeded(target, METADATA_BRANCH_NAME, { cwd });
	} catch {
		// pushBranchIfNeeded is silent-on-failure; this catch is defense-in-depth.
	}

	let settings: StorySettings;
	try {
		settings = await readSettings(cwd);
	} catch {
		return;
	}

	if (isPushV2RefsEnabled(settings)) {
		try {
			await pushV2Refs(target, { cwd });
		} catch {
			// pushV2Refs is silent-on-failure; defense-in-depth catch.
		}
	}
}
