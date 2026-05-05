import type { CheckpointID } from './id';
import { CHECKPOINT_ID_PATTERN, SHORT_ID_LENGTH, validate } from './id';

export const CHECKPOINT_TRAILER_KEY = 'Story-Checkpoint';
export const SESSION_TRAILER_KEY = 'Story-Session';
export const STRATEGY_TRAILER_KEY = 'Story-Strategy';
export const METADATA_TRAILER_KEY = 'Story-Metadata';
export const METADATA_TASK_TRAILER_KEY = 'Story-Metadata-Task';
export const BASE_COMMIT_TRAILER_KEY = 'Base-Commit';
export const AGENT_TRAILER_KEY = 'Story-Agent';
export const ATTRIBUTION_TRAILER_KEY = 'Story-Attribution';
/**
 * Trailer key for `Story-Source-Ref:` — links a code commit to its origin on
 * the metadata branch. Used by Phase 9.4 explain / resume.
 *
 * Mirrors Go `trailers/trailers.go` `SourceRefTrailerKey` constant family.
 */
export const STORY_SOURCE_REF_TRAILER_KEY = 'Story-Source-Ref';

const checkpointTrailerRe = new RegExp(
	`${CHECKPOINT_TRAILER_KEY}:\\s*(${CHECKPOINT_ID_PATTERN.source.slice(1, -1)})(?:\\s|$)`,
	'g',
);
const sessionTrailerRe = new RegExp(`${SESSION_TRAILER_KEY}:\\s*(.+)`, 'g');
const metadataTrailerRe = new RegExp(`${METADATA_TRAILER_KEY}:\\s*(.+)`);
const taskMetadataTrailerRe = new RegExp(`${METADATA_TASK_TRAILER_KEY}:\\s*(.+)`);
const baseCommitTrailerRe = new RegExp(`${BASE_COMMIT_TRAILER_KEY}:\\s*([a-f0-9]{40})`);
const trailerLineRe = /^[A-Za-z][A-Za-z0-9-]*: /;

/** Extract the first checkpoint ID from a commit message, or `null` if absent. */
export function parseCheckpoint(commitMessage: string): CheckpointID | null {
	for (const [, raw] of commitMessage.matchAll(checkpointTrailerRe)) {
		const id = raw?.trim();
		if (id && validate(id) === null) {
			return id as CheckpointID;
		}
	}
	return null;
}

/** Extract all checkpoint IDs from a commit message, deduplicated and order-preserving. */
export function parseAllCheckpoints(commitMessage: string): CheckpointID[] {
	const seen = new Set<string>();
	const ids: CheckpointID[] = [];
	for (const [, raw] of commitMessage.matchAll(checkpointTrailerRe)) {
		const id = raw?.trim();
		if (id && validate(id) === null && !seen.has(id)) {
			seen.add(id);
			ids.push(id as CheckpointID);
		}
	}
	return ids;
}

/**
 * Extract the first session ID from a commit message.
 *
 * Returns `null` only when **no** `Story-Session:` trailer is present.
 * Returns `''` when a trailer is present but its value is whitespace-only —
 * matching Go's `ParseSession` `(string, bool)` contract where the second
 * return is `true` even on empty trim. Earlier TS conflated "no trailer"
 * with "empty trailer" by returning `null` for both, so callers couldn't
 * distinguish.
 *
 * Go reference: trailers/trailers.go:115-125 ParseSession.
 */
export function parseSession(commitMessage: string): string | null {
	for (const [, raw] of commitMessage.matchAll(sessionTrailerRe)) {
		// Match the regex's first capture; trim. Return immediately on first
		// match (even if trimmed value is empty — Go returns found=true here).
		return (raw ?? '').trim();
	}
	return null;
}

/** Extract all session IDs from a commit message, deduplicated and order-preserving. */
export function parseAllSessions(commitMessage: string): string[] {
	const seen = new Set<string>();
	const ids: string[] = [];
	for (const [, raw] of commitMessage.matchAll(sessionTrailerRe)) {
		const id = raw?.trim();
		if (id && !seen.has(id)) {
			seen.add(id);
			ids.push(id);
		}
	}
	return ids;
}

/** Test whether a line matches git trailer format (`Key-Name: value`). */
export function isTrailerLine(line: string): boolean {
	return trailerLineRe.test(line);
}

/**
 * Append a `Story-Checkpoint` trailer to a commit message.
 *
 * Trailer-aware: appends to an existing trailer block if present,
 * otherwise adds a blank-line separator first. Skips trailing `#` comment lines.
 *
 * @example
 * ```ts
 * appendCheckpointTrailer('feat: add login\n', 'a3b2c4d5e6f7')
 * // 'feat: add login\n\nStory-Checkpoint: a3b2c4d5e6f7\n'
 * ```
 */
export function appendCheckpointTrailer(message: string, checkpointId: string): string {
	const trimmed = message.replace(/\n+$/, '');
	const trailer = `${CHECKPOINT_TRAILER_KEY}: ${checkpointId}`;

	const lines = trimmed.split('\n');
	let i = lines.length - 1;

	while (i >= 0 && lines[i]!.trimStart().startsWith('#')) {
		i--;
	}

	let hasTrailerBlock = false;
	if (i >= 0) {
		const last = lines[i]!.trim();
		if (last !== '' && isTrailerLine(last)) {
			while (i > 0) {
				i--;
				const above = lines[i]!.trim();
				if (above.startsWith('#')) {
					continue;
				}
				if (above === '') {
					hasTrailerBlock = true;
					break;
				}
				if (!isTrailerLine(above)) {
					break;
				}
			}
		}
	}

	if (hasTrailerBlock) {
		return `${trimmed}\n${trailer}\n`;
	}
	return `${trimmed}\n\n${trailer}\n`;
}

/** Format a shadow branch commit message with metadata, session, and strategy trailers. */
export function formatShadowCommit(
	message: string,
	metadataDir: string,
	sessionId: string,
): string {
	return [
		message,
		'',
		`${METADATA_TRAILER_KEY}: ${metadataDir}`,
		`${SESSION_TRAILER_KEY}: ${sessionId}`,
		`${STRATEGY_TRAILER_KEY}: manual-commit`,
		'',
	].join('\n');
}

/** Format a commit message with a `Story-Checkpoint` trailer. */
export function formatCheckpoint(message: string, cpId: CheckpointID): string {
	return `${message}\n\n${CHECKPOINT_TRAILER_KEY}: ${cpId}\n`;
}

/** Create a commit message with a Story-Metadata trailer. */
export function formatMetadata(message: string, metadataDir: string): string {
	return `${message}\n\n${METADATA_TRAILER_KEY}: ${metadataDir}\n`;
}

/** Extract metadata directory from a commit message, or null if absent. */
export function parseMetadata(commitMessage: string): string | null {
	const match = metadataTrailerRe.exec(commitMessage);
	if (match?.[1]) {
		return match[1].trim();
	}
	return null;
}

/** Create a commit message with a Story-Metadata-Task trailer. */
export function formatTaskMetadata(message: string, taskMetadataDir: string): string {
	return `${message}\n\n${METADATA_TASK_TRAILER_KEY}: ${taskMetadataDir}\n`;
}

/** Extract task metadata directory from a commit message, or null if absent. */
export function parseTaskMetadata(commitMessage: string): string | null {
	const match = taskMetadataTrailerRe.exec(commitMessage);
	if (match?.[1]) {
		return match[1].trim();
	}
	return null;
}

/** Extract the base commit SHA (40-char hex) from a commit message, or null if absent. */
export function parseBaseCommit(commitMessage: string): string | null {
	const match = baseCommitTrailerRe.exec(commitMessage);
	if (match?.[1]) {
		return match[1];
	}
	return null;
}

// Phase 5.2 — foundation backlog #15 + #16.

/**
 * Format a `<branch>@<commit-hash[:12]>` source reference, used by the
 * manual-commit strategy to link a code commit back to its origin on the
 * metadata branch. The commit hash is truncated to {@link SHORT_ID_LENGTH}
 * (12) characters; shorter inputs are passed through unchanged (no
 * zero-padding).
 *
 * Mirrors Go `trailers/trailers.go:206-214` (`FormatSourceRef`).
 *
 * @example
 * formatSourceRef('main', 'a3b2c4d5e6f7012345')   // 'main@a3b2c4d5e6f7'
 * formatSourceRef('main', 'a3b2c4')               // 'main@a3b2c4'  (短 hash 不补零)
 */
export function formatSourceRef(branch: string, commitHash: string): string {
	const shortHash =
		commitHash.length > SHORT_ID_LENGTH ? commitHash.slice(0, SHORT_ID_LENGTH) : commitHash;
	return `${branch}@${shortHash}`;
}

/**
 * Format a shadow-branch task commit message, mirroring {@link formatShadowCommit}
 * but writing `Story-Metadata-Task` instead of `Story-Metadata`. Adds
 * `Story-Session` and `Story-Strategy: manual-commit` trailers.
 *
 * Note: the existing {@link formatTaskMetadata} writes only the single
 * `Story-Metadata-Task:` trailer; this function writes the **full 3-trailer
 * block** that {@link writeTemporaryTask} (Phase 4.2) expects so committed
 * task checkpoints surface in `git log --grep` for any of the three trailers.
 *
 * Mirrors Go `trailers/trailers.go:238-248` (`FormatShadowTaskCommit`).
 *
 * @example
 * formatShadowTaskCommit('Completed task', '.story/metadata/sess-1/tasks/tool-456', 'sess-1')
 * // returns:
 * //   Completed task
 * //
 * //   Story-Metadata-Task: .story/metadata/sess-1/tasks/tool-456
 * //   Story-Session: sess-1
 * //   Story-Strategy: manual-commit
 * //
 *
 * // Side effects: none — pure string formatting.
 * // Disk / git refs / HEAD: unchanged.
 */
export function formatShadowTaskCommit(
	message: string,
	taskMetadataDir: string,
	sessionId: string,
): string {
	return [
		message,
		'',
		`${METADATA_TASK_TRAILER_KEY}: ${taskMetadataDir}`,
		`${SESSION_TRAILER_KEY}: ${sessionId}`,
		`${STRATEGY_TRAILER_KEY}: manual-commit`,
		'',
	].join('\n');
}
