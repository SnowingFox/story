/**
 * `hooks-commit-msg.ts` — `commit-msg` git hook entry for the manual-commit
 * strategy.
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/strategy/manual_commit_hooks.go`:
 *   - `CommitMsg` (the hook entry method)
 *   - `hasUserContent` (predicate for trailer-only messages)
 *   - `stripCheckpointTrailer` (line filter)
 *
 * @packageDocumentation
 */

import { readFile, writeFile } from 'node:fs/promises';
import { CHECKPOINT_TRAILER_KEY, parseCheckpoint } from '@/trailers';
import type { ManualCommitStrategy } from './manual-commit';

/**
 * Implements the `commit-msg` git hook. If the commit message contains only
 * the `Story-Checkpoint:` trailer (no user content), strip the trailer so git
 * aborts the commit due to empty message. Otherwise no-op.
 *
 * Hook contract: silent on any error (always resolves; never throws to git).
 *
 * Mirrors Go `manual_commit_hooks.go: CommitMsg`.
 *
 * @example
 * await commitMsgImpl(strategy, '/repo/.git/COMMIT_EDITMSG');
 *
 * // Side effects (only when message has trailer + no user content):
 * //   <msgFile>  ← rewritten with trailer line removed (git then aborts on empty message)
 * //
 * // Other state: unchanged. Read errors / write errors swallowed.
 */
export async function commitMsgImpl(_s: ManualCommitStrategy, msgFile: string): Promise<void> {
	let message: string;
	try {
		message = await readFile(msgFile, 'utf8');
	} catch {
		return; // hook contract: silent on file read error
	}

	// No trailer → nothing to do.
	if (parseCheckpoint(message) === null) {
		return;
	}

	// Has trailer + has user content → keep as-is.
	if (hasUserContent(message)) {
		return;
	}

	// Trailer-only → strip so git aborts.
	const stripped = stripCheckpointTrailer(message);
	try {
		await writeFile(msgFile, stripped, { mode: 0o600 });
	} catch {
		// silent on write error
	}
}

/**
 * Returns true when `message` has any line that is **not** empty, **not** a
 * git comment (`#` prefix after trim), and **not** the `Story-Checkpoint:`
 * trailer. Used by {@link commitMsgImpl} to decide whether to strip the trailer.
 *
 * Mirrors Go `manual_commit_hooks.go: hasUserContent`.
 *
 * @example
 * hasUserContent('')                                          // false
 * hasUserContent('# only a comment')                          // false
 * hasUserContent('Story-Checkpoint: 0188...')                 // false (only trailer)
 * hasUserContent('feat: subject\nStory-Checkpoint: 0188...')  // true (user content present)
 */
export function hasUserContent(message: string): boolean {
	const trailerPrefix = `${CHECKPOINT_TRAILER_KEY}:`;
	for (const line of message.split('\n')) {
		const trimmed = line.trim();
		if (trimmed === '') {
			continue;
		}
		if (trimmed.startsWith('#')) {
			continue;
		}
		if (trimmed.startsWith(trailerPrefix)) {
			continue;
		}
		return true;
	}
	return false;
}

/**
 * Returns `message` with every `Story-Checkpoint:` line removed (line filter).
 * Other trailers / comments / user content are preserved verbatim.
 *
 * Mirrors Go `manual_commit_hooks.go: stripCheckpointTrailer`.
 *
 * @example
 * stripCheckpointTrailer('feat: x\n\nStory-Checkpoint: 0188\n# comment\n');
 * // returns: 'feat: x\n\n# comment\n'
 */
export function stripCheckpointTrailer(message: string): string {
	const trailerPrefix = `${CHECKPOINT_TRAILER_KEY}:`;
	return message
		.split('\n')
		.filter((line) => !line.trim().startsWith(trailerPrefix))
		.join('\n');
}
