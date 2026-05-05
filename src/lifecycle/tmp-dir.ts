/**
 * Filesystem helpers for Story's per-worktree temp directory (state snapshots
 * for pre-prompt / pre-task state).
 *
 * Mirrors Go `state.go: resolveTmpDir` + `paths.EntireTmpDir`.
 *
 * **Story-side rebrand**: Go uses `.entire/tmp`. Story uses `.story/tmp`.
 * This is the only Story rebrand point in Phase 7 Part 1.
 *
 * @packageDocumentation
 */

import * as path from 'node:path';
import { worktreeRoot } from '@/paths';

/**
 * Repo-relative directory name for Story's transient state snapshots.
 * Mirrors Go `paths.EntireTmpDir` (literal `.entire/tmp`).
 *
 * **Story-side divergence**: `.story/tmp` instead of `.entire/tmp`.
 */
export const STORY_TMP_DIR = '.story/tmp' as const;

/**
 * Resolve the absolute path to Story's temp dir (`<repoRoot>/.story/tmp`).
 *
 * On any error (not in a git repo, `git rev-parse` fails), falls back to
 * `path.join(process.cwd(), STORY_TMP_DIR)` — matches Go `resolveTmpDir`
 * fail-safe behavior: always return a path, never throw.
 *
 * Mirrors Go `state.go: resolveTmpDir`.
 *
 * @example
 * await resolveTmpDir();
 * // Inside a git worktree: '/Users/me/proj/.story/tmp'
 * // Not in a git repo:     '<cwd>/.story/tmp'
 *
 * // Side effects: read-only git CLI call (`git rev-parse --show-toplevel`
 * //              via `worktreeRoot`).
 */
export async function resolveTmpDir(): Promise<string> {
	try {
		const root = await worktreeRoot();
		return path.join(root, STORY_TMP_DIR);
	} catch {
		return path.join(process.cwd(), STORY_TMP_DIR);
	}
}
