/**
 * Session / checkpoint / task read helpers shared by `story explain`,
 * `story resume`, and `story attach`.
 *
 * Mirrors Go `strategy/manual_commit_logs.go` (165 lines). Most of the
 * work delegates to Phase 5.1 / 4.3 / 5.5 helpers:
 *
 *  - {@link getSessionInfo}       — reads HEAD + state, guards against
 *    shadow-branch HEAD (mirrors Go `GetSessionInfo`)
 *  - {@link getSessionLog}        — v1/v2 committed-reader dispatch via
 *    {@link readLatestSessionContent} (mirrors Go `GetCheckpointLog`)
 *  - {@link getTaskCheckpoint}    — thin wrapper over
 *    {@link getTaskCheckpointFromTree}
 *  - {@link getTaskCheckpointTranscript} — thin wrapper over
 *    {@link getTaskTranscriptFromTree}
 *
 * Go reference: `entire-cli/cmd/entire/cli/strategy/manual_commit_logs.go`.
 *
 * @packageDocumentation
 */

import fsCallback from 'node:fs';
import git from 'isomorphic-git';
import { readLatestSessionContent } from '@/checkpoint/committed';
import { shadowBranchNameForCommit } from '@/checkpoint/temporary';
import { execGit } from '@/git';
import * as log from '@/log';
import { ErrNoSession } from '@/strategy/errors';
import { getTaskCheckpointFromTree, getTaskTranscriptFromTree } from '@/strategy/rewind-helpers';
import { listSessionStates } from '@/strategy/session-state';
import type { RewindPoint, SessionState, TaskCheckpoint } from '@/strategy/types';

/** Go parity: shadow branches live under this prefix. */
const SHADOW_BRANCH_PREFIX = 'story/';

/** Return shape for {@link getSessionInfo} — trailer-level session view. */
export interface SessionInfoResult {
	readonly sessionId: string;
	readonly reference: string;
	readonly commitHash: string;
}

/**
 * Return shape for {@link getSessionLog} — transcript bytes + the session
 * ID the checkpoint reader used (may differ from the caller's probe when
 * a multi-session checkpoint resolves to the latest).
 */
export interface SessionLogResult {
	readonly transcript: Uint8Array;
	readonly sessionId: string;
}

/**
 * Return current session info from local state + HEAD inspection.
 *
 * Mirrors Go `manual_commit_logs.go: GetSessionInfo`. Returns:
 *   - `null` when no session state matches the current HEAD commit
 *   - {@link SessionInfoResult} for the most recently started session
 *
 * Throws:
 *   - `ErrNoSession` when HEAD is a shadow branch (Go parity — explicit
 *     refusal since shadow branches are not user-visible sessions)
 *   - Any other error from `git rev-parse` / state loading
 *
 * @example
 * await getSessionInfo('/repo');
 * // returns: { sessionId: 'sess-abc', reference: 'story/abc1234-...',
 * //           commitHash: 'deadbeef...' }
 * // returns: null                 (no matching session)
 * // throws:  ErrNoSession         (HEAD is story/xxx)
 *
 * // Side effects: read-only — git rev-parse HEAD + 1 or 2 fs reads.
 */
export async function getSessionInfo(cwd?: string): Promise<SessionInfoResult | null> {
	const opts = cwd !== undefined ? { cwd } : undefined;
	// Guard against HEAD on a shadow branch — Go parity.
	let branch: string;
	try {
		branch = (await execGit(['rev-parse', '--abbrev-ref', 'HEAD'], opts)).trim();
	} catch (e) {
		throw new Error(`failed to read HEAD: ${(e as Error).message}`, { cause: e });
	}
	if (branch !== 'HEAD' && branch.startsWith(SHADOW_BRANCH_PREFIX)) {
		throw ErrNoSession;
	}
	let headSha: string;
	try {
		headSha = (await execGit(['rev-parse', 'HEAD'], opts)).trim();
	} catch (e) {
		throw new Error(`failed to resolve HEAD: ${(e as Error).message}`, { cause: e });
	}

	// Find sessions whose baseCommit === HEAD.
	const repoRoot = cwd ?? process.cwd();
	let states: SessionState[];
	try {
		states = await listSessionStates(repoRoot);
	} catch (e) {
		log.debug({ component: 'commands/_shared/session-log' }, 'listSessionStates failed', {
			error: (e as Error).message,
		});
		return null;
	}
	const matching = states.filter((s) => s.baseCommit === headSha);
	if (matching.length === 0) {
		return null;
	}

	// Go: return the first (most recent). `listSessionStates` orders by
	// mtime desc.
	const state = matching[0]!;
	const shadowBranch = shadowBranchNameForCommit(state.baseCommit, state.worktreeId ?? '');

	let commitHash = '';
	try {
		commitHash = await git.resolveRef({
			fs: fsCallback,
			dir: repoRoot,
			ref: `refs/heads/${shadowBranch}`,
		});
	} catch {
		// Shadow branch may have been cleaned up — not fatal, return empty.
	}

	return { sessionId: state.sessionId, reference: shadowBranch, commitHash };
}

/**
 * Read the session transcript for a given checkpoint ID. Delegates to
 * {@link readLatestSessionContent} which handles v1/v2 fallback via the
 * committed-reader resolver.
 *
 * Mirrors Go `manual_commit_logs.go: GetCheckpointLog` — returns the
 * **latest** session in a multi-session checkpoint (Go's behaviour when
 * callers pass a pure `Checkpoint`).
 *
 * @example
 * await getSessionLog('/repo', 'abc1234');
 * // returns: { transcript: Uint8Array(...), sessionId: 'sess-abc' }
 * // returns: null   (checkpoint missing, or empty id)
 *
 * // Side effects: read-only — metadata-branch tree walk + blob reads.
 */
export async function getSessionLog(
	repoDir: string,
	checkpointId: string,
): Promise<SessionLogResult | null> {
	if (checkpointId === '') {
		return null;
	}
	let content: Awaited<ReturnType<typeof readLatestSessionContent>>;
	try {
		content = await readLatestSessionContent(repoDir, checkpointId);
	} catch (e) {
		// ErrCheckpointNotFound / transcript-missing → null (caller decides UX);
		// anything else → propagate.
		const name = (e as { name?: string })?.name ?? '';
		if (name === 'ErrCheckpointNotFound') {
			return null;
		}
		throw e;
	}
	if (content === null) {
		return null;
	}
	return { transcript: content.transcript, sessionId: content.metadata.sessionId };
}

/**
 * Read a task subagent checkpoint's metadata payload. Wraps
 * {@link getTaskCheckpointFromTree} with a task-only guard.
 *
 * Mirrors Go `manual_commit_logs.go: GetTaskCheckpoint`.
 *
 * @example
 * await getTaskCheckpoint('/repo', point);
 * // returns: { sessionId, toolUseId, checkpointUuid, agentId? }
 * // returns: null  (task metadata dir missing from tree)
 * // throws:  Error 'not a task checkpoint' (point.isTaskCheckpoint === false)
 */
export async function getTaskCheckpoint(
	repoDir: string,
	point: RewindPoint,
): Promise<TaskCheckpoint | null> {
	if (!point.isTaskCheckpoint) {
		throw new Error(`not a task checkpoint: ${point.id}`);
	}
	// Resolve the tree hash from the commit hash stored as point.id.
	let treeHash: string;
	try {
		const { commit } = await git.readCommit({ fs: fsCallback, dir: repoDir, oid: point.id });
		treeHash = commit.tree;
	} catch (e) {
		log.debug({ component: 'commands/_shared/session-log' }, 'readCommit failed', {
			error: (e as Error).message,
		});
		return null;
	}
	return getTaskCheckpointFromTree(repoDir, treeHash, point.metadataDir);
}

/**
 * Read the session transcript associated with a task subagent
 * checkpoint. Wraps {@link getTaskTranscriptFromTree} with a task-only
 * guard; the transcript lives at the session level (one level above the
 * `tasks/<toolUseID>` subdir).
 *
 * Mirrors Go `manual_commit_logs.go: GetTaskCheckpointTranscript`.
 *
 * @example
 * await getTaskCheckpointTranscript('/repo', point);
 * // returns: Uint8Array with transcript bytes
 * // returns: null  (session transcript missing from tree)
 * // throws:  Error 'not a task checkpoint' (point.isTaskCheckpoint === false)
 */
export async function getTaskCheckpointTranscript(
	repoDir: string,
	point: RewindPoint,
): Promise<Uint8Array | null> {
	if (!point.isTaskCheckpoint) {
		throw new Error(`not a task checkpoint: ${point.id}`);
	}
	let treeHash: string;
	try {
		const { commit } = await git.readCommit({ fs: fsCallback, dir: repoDir, oid: point.id });
		treeHash = commit.tree;
	} catch (e) {
		log.debug({ component: 'commands/_shared/session-log' }, 'readCommit failed', {
			error: (e as Error).message,
		});
		return null;
	}
	return getTaskTranscriptFromTree(repoDir, treeHash, point.metadataDir);
}
