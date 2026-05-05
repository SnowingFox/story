/**
 * `hooks-post-rewrite.ts` — `post-rewrite` git hook entry (amend / rebase).
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/strategy/manual_commit_hooks.go`:
 *   - `PostRewrite` (rewriteType dispatch + per-session remap loop)
 *   - `parsePostRewritePairs` (stdin parser — the only hook branch that
 *     surfaces an error to git instead of swallowing)
 *
 * @packageDocumentation
 */

import { createInterface } from 'node:readline';
import * as log from '@/log';
import { worktreeRoot } from '@/paths';
import { truncateHash } from './hooks-post-commit';
import type { ManualCommitStrategy } from './manual-commit';
import {
	findSessionsForWorktree,
	type RewritePair,
	remapSessionForRewrite,
} from './manual-commit-session';
import type { SessionState } from './types';

/**
 * Parse git's `post-rewrite` stdin. Each line is `<oldSha> <newSha>` (or more
 * whitespace-delimited fields, only first 2 used). Empty / whitespace-only
 * lines are skipped silently. Lines with fewer than 2 fields cause an error
 * — this is the **only** hook branch that surfaces an error to git instead
 * of swallowing.
 *
 * Mirrors Go `manual_commit_hooks.go: parsePostRewritePairs`.
 *
 * @example
 * import { Readable } from 'node:stream';
 * await parsePostRewritePairs(Readable.from(['abc def\nfff aaa\n']));
 * // returns: [{ oldSha: 'abc', newSha: 'def' }, { oldSha: 'fff', newSha: 'aaa' }]
 *
 * await parsePostRewritePairs(Readable.from(['malformed\n']));
 * // throws: Error('invalid post-rewrite mapping line: "malformed"')
 *
 * // Side effects: none — pure stream consumption.
 */
export async function parsePostRewritePairs(stream: NodeJS.ReadableStream): Promise<RewritePair[]> {
	// Go uses `bufio.Scanner` line-by-line (`manual_commit_hooks.go: parsePostRewritePairs`).
	// TS uses `readline.createInterface` for the same incremental semantics —
	// avoids buffering the entire stdin into memory (could be huge during
	// massive rebases with thousands of commits).
	const rl = createInterface({ input: stream, crlfDelay: Infinity });
	const pairs: RewritePair[] = [];
	for await (const rawLine of rl) {
		const line = rawLine.trim();
		if (line === '') {
			continue;
		}
		const fields = line.split(/\s+/);
		if (fields.length < 2) {
			throw new Error(`invalid post-rewrite mapping line: "${line}"`);
		}
		pairs.push({ oldSha: fields[0] ?? '', newSha: fields[1] ?? '' });
	}
	return pairs;
}

/**
 * `post-rewrite` git hook entry. Reads `<oldSha> <newSha>` lines from stdin,
 * remaps each active session's `baseCommit` / `attributionBaseCommit`, and
 * migrates the corresponding shadow branch ref. Hook contract: silent on
 * resolution errors (worktree / repo / save failures), but **rejects on
 * stdin parse error** — git needs to know the mapping was malformed.
 *
 * Mirrors Go `manual_commit_hooks.go: PostRewrite`. Skips for
 * `rewriteType` other than `'amend'` / `'rebase'` (Go parity).
 *
 * @example
 * import { Readable } from 'node:stream';
 * await postRewriteImpl(strategy, 'rebase', Readable.from(['abc def\n']));
 *
 * // Side effects (per remapped session):
 * //   refs/heads/story/<oldBase>-<wt6>                ← renamed to story/<newBase>-<wt6>
 * //   <repoDir>/.git/story-sessions/<sessionId>.json   ← overwritten with new baseCommit
 * //
 * // HEAD / index / worktree: unchanged.
 */
export async function postRewriteImpl(
	s: ManualCommitStrategy,
	rewriteType: string,
	mappingsStream: NodeJS.ReadableStream,
): Promise<void> {
	const logCtx = { component: 'checkpoint' };
	if (rewriteType !== 'amend' && rewriteType !== 'rebase') {
		log.debug(logCtx, 'post-rewrite: unsupported rewrite type, skipping', {
			rewriteType,
		});
		return;
	}

	// Parse stdin — REJECTS on malformed (only hook branch that surfaces
	// errors instead of swallowing). Caller's `try/catch` will see this.
	const rewrites = await parsePostRewritePairs(mappingsStream);
	if (rewrites.length === 0) {
		return;
	}

	// Resolve repo + worktreePath ONCE — Phase 5.4 review (2026-04-20) found
	// the previous version called `s.getRepo()` twice, mirroring Go's separate
	// `paths.WorktreeRoot` + `OpenRepository` calls but redundant in TS where
	// `s.getRepo()` is lazy + cached.
	let repo: Awaited<ReturnType<typeof s.getRepo>>;
	let worktreePath: string;
	try {
		repo = await s.getRepo();
		worktreePath = await worktreeRoot(repo.root);
	} catch {
		return;
	}

	let sessions: SessionState[];
	try {
		sessions = await findSessionsForWorktree(repo.root, worktreePath);
	} catch {
		return;
	}
	if (sessions.length === 0) {
		return;
	}

	for (const state of sessions) {
		let changed: boolean;
		try {
			changed = await remapSessionForRewrite(s, repo, state, rewrites);
		} catch (err) {
			log.warn(
				{ component: 'checkpoint', sessionId: state.sessionId },
				'post-rewrite: failed to remap session linkage',
				{ error: err instanceof Error ? err.message : String(err) },
			);
			continue;
		}
		if (!changed) {
			continue;
		}
		try {
			await s.saveSessionState(state);
		} catch (err) {
			log.warn(
				{ component: 'checkpoint', sessionId: state.sessionId },
				'post-rewrite: failed to save remapped session state',
				{ error: err instanceof Error ? err.message : String(err) },
			);
			continue;
		}
		log.info(
			{ component: 'checkpoint', sessionId: state.sessionId },
			'post-rewrite: remapped session linkage',
			{ rewriteType, baseCommit: truncateHash(state.baseCommit) },
		);
	}
}
