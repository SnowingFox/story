/**
 * `hooks-post-commit-warn.ts` — Stale ENDED session warning subsystem for the
 * `post-commit` git hook.
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/strategy/manual_commit_hooks.go`:
 *   - `staleEndedSessionWarn{Threshold,Interval,File}` constants
 *   - `activeSessionInteractionThreshold` constant
 *   - `warnStaleEndedSessions` / `warnStaleEndedSessionsTo`
 *
 * **Story-side prose substitution**: Go writes `entire: N ended session(s)
 * are accumulating ... Run 'entire doctor' ...`. Story replaces both `entire`
 * tokens with `story`. The behavior is otherwise identical.
 *
 * Stderr writer is shared with [`./hooks-tty.ts`](./hooks-tty.ts) — both
 * Phase 5.4 warning paths (Part 1 prepare-commit-msg + Part 2 post-commit)
 * write through `getStderrWriter()` so a single `setStderrWriterForTesting`
 * call in tests captures everything.
 *
 * @packageDocumentation
 */

import { mkdir, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SESSION_STATE_DIR_NAME } from '@/paths';
import { getStderrWriter, setStderrWriterForTesting } from './hooks-tty';

/** Re-export so callers can write through one stderr injection point regardless
 *  of which Phase 5.4 hook is firing. */
export { getStderrWriter, setStderrWriterForTesting };

/**
 * Warn threshold — number of stale ENDED sessions required before PostCommit
 * emits the warning. Mirrors Go `staleEndedSessionWarnThreshold = 3`.
 */
export const STALE_ENDED_SESSION_WARN_THRESHOLD = 3;

/**
 * Rate-limit window — minimum interval between two warnings (24 hours).
 * Tracked via mtime on the sentinel file. Mirrors Go
 * `staleEndedSessionWarnInterval = 24 * time.Hour`.
 */
export const STALE_ENDED_SESSION_WARN_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Sentinel filename inside `<gitCommonDir>/<SESSION_STATE_DIR_NAME>/` whose
 * mtime is read to enforce {@link STALE_ENDED_SESSION_WARN_INTERVAL_MS}.
 * Mirrors Go `staleEndedSessionWarnFile = ".warn-stale-ended"`.
 */
export const STALE_ENDED_SESSION_WARN_FILE = '.warn-stale-ended';

/**
 * Maximum age of `lastInteractionTime` for an ACTIVE session to be considered
 * genuinely active. 24h is generous because LastInteractionTime only updates
 * at TurnStart, not per-tool-call. Mirrors Go
 * `activeSessionInteractionThreshold = 24 * time.Hour`.
 *
 * Used by `isRecentInteraction` in [`./hooks-post-commit.ts`](./hooks-post-commit.ts).
 */
export const ACTIVE_SESSION_INTERACTION_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/**
 * Emit a rate-limited warning to stderr when too many non-FullyCondensed
 * ENDED sessions are accumulating in this repo. Best-effort — file-system
 * errors during sentinel touch are swallowed (fail-open: stderr write still
 * happens so the user sees the message even if the rate-limit window can't be
 * persisted).
 *
 * Mirrors Go `manual_commit_hooks.go: warnStaleEndedSessions` +
 * `warnStaleEndedSessionsTo`. The two-function split exists so Go tests can
 * inject a `io.Writer`; in TS the same purpose is served by the module-level
 * `getStderrWriter()` from [`./hooks-tty.ts`](./hooks-tty.ts).
 *
 * **Story brand**: prose contains `"story:"` and `"story doctor"` (Go uses
 * `"entire:"` and `"entire doctor"`).
 *
 * @example
 * await warnStaleEndedSessions('/repo/.git', 5);
 *
 * // Side effects (only when sentinel mtime is missing or > 24h old):
 * //   /repo/.git/story-sessions/                           ← created if missing
 * //   /repo/.git/story-sessions/.warn-stale-ended          ← touched (mtime updated)
 * //   stderr                                                ← "story: 5 ended session(s) ..."
 * //
 * // Side effects (rate-limited — sentinel mtime within 24h):
 * //   none.
 * //
 * // HEAD / index / worktree / git refs: unchanged.
 */
export async function warnStaleEndedSessions(gitCommonDir: string, count: number): Promise<void> {
	const warnDir = path.join(gitCommonDir, SESSION_STATE_DIR_NAME);
	const warnFile = path.join(warnDir, STALE_ENDED_SESSION_WARN_FILE);

	// Rate-limit: skip if sentinel exists AND its mtime is within the window.
	try {
		const info = await stat(warnFile);
		if (Date.now() - info.mtimeMs < STALE_ENDED_SESSION_WARN_INTERVAL_MS) {
			return;
		}
	} catch {
		// File doesn't exist — fall through to write.
	}

	// Best-effort sentinel touch — fail-open if mkdir / write fails.
	try {
		await mkdir(warnDir, { recursive: true, mode: 0o750 });
		await writeFile(warnFile, '', { mode: 0o644 });
		// Explicitly bump mtime to "now" — covers the case where the file
		// already existed (rate-limit-elapsed path): writeFile() doesn't
		// always update mtime when the content is unchanged on some
		// platforms / fs implementations.
		const now = new Date();
		await utimes(warnFile, now, now);
	} catch {
		/* fail-open per Go */
	}

	// Story-side prose substitution: "entire" → "story".
	const msg =
		`\nstory: ${count} ended session(s) are accumulating and slowing down commits.\n` +
		`Run 'story doctor' to condense them and restore commit performance.\n\n`;
	getStderrWriter().write(msg);
}
