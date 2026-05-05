/**
 * Strategy-package constants and small pure helpers.
 *
 * Mirrors:
 * - Go `messages.go:13` (`MaxDescriptionLength`)
 * - Go `manual_commit_types.go:13-19` (`logsOnlyScanLimit`, `maxLastPromptRunes`)
 * - Go `strategy.go:262-265` (`TaskMetadataDir`)
 *
 * @packageDocumentation
 */

/**
 * Maximum length for descriptions in commit messages before truncation.
 * Go: `messages.go:13` (`MaxDescriptionLength`).
 */
export const MAX_DESCRIPTION_LENGTH = 60;

/**
 * Maximum number of commits to scan for logs-only points (rewind / explain).
 * Bounded scan keeps `findSessionsByTrailerWalk` (commit-history walk) and
 * `getLogsOnlyRewindPoints` (logs-only commit collection) at O(LIMIT) per
 * call — `findSessionsForCommit` itself is a session-state filter and does
 * not walk commits.
 * Go: `manual_commit_types.go:15` (`logsOnlyScanLimit`).
 */
export const LOGS_ONLY_SCAN_LIMIT = 50;

/**
 * Maximum rune length for `LastPrompt` stored in session state.
 * Truncates long prompts to keep state.json small.
 * Go: `manual_commit_types.go:18` (`maxLastPromptRunes`).
 */
export const MAX_LAST_PROMPT_RUNES = 100;

/**
 * Strategy name constant used in `Story-Strategy:` commit trailers.
 * Currently the only strategy implemented; `commit` strategy is deprecated.
 */
export const STRATEGY_NAME_MANUAL_COMMIT = 'manual-commit';

/**
 * Safety limit for walking git commit history. Prevents unbounded traversal
 * in repositories with very long histories.
 *
 * Mirrors Go `common.go:42-44` (`MaxCommitTraversalDepth = 1000`). Phase 5.1
 * `isAncestorOf` does not currently use this bound (it delegates to `git
 * merge-base --is-ancestor` which is bounded by git internally), but the
 * constant is exported for future pure-JS commit walkers and to match Go's
 * public contract.
 */
export const MAX_COMMIT_TRAVERSAL_DEPTH = 1000;

/**
 * Returns the path to a task's metadata directory within the session metadata directory.
 * Mirrors Go `strategy.go:262-265` (`TaskMetadataDir`).
 *
 * @example
 * taskMetadataDir('.story/metadata/abc-123', 'tool-use-456')
 * // => '.story/metadata/abc-123/tasks/tool-use-456'
 */
export function taskMetadataDir(sessionMetadataDir: string, toolUseId: string): string {
	return `${sessionMetadataDir}/tasks/${toolUseId}`;
}
