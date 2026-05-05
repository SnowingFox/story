/**
 * Phase 5.5 rewind-point listing — combines shadow checkpoints (uncommitted)
 * with logs-only commits (already committed via `Story-Checkpoint:` trailer).
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/strategy/manual_commit_rewind.go`
 * (`GetRewindPoints` / `GetLogsOnlyRewindPoints` /
 * `ResolveLatestCheckpointFromMap` / `readSessionPrompt`).
 *
 * @packageDocumentation
 */

import fsCallback from 'node:fs';
import git from 'isomorphic-git';
import { normalize } from '../agent/types';
import { listTemporaryCheckpoints } from '../checkpoint/temporary';
import type { TemporaryCheckpointInfo } from '../checkpoint/types';
import { execGit } from '../git';
import { type CheckpointID, EMPTY_CHECKPOINT_ID, isEmpty, toPath as toCheckpointPath } from '../id';
import * as log from '../log';
import { parseAllCheckpoints } from '../trailers';
import { LOGS_ONLY_SCAN_LIMIT } from './constants';
import type { ManualCommitStrategy } from './manual-commit';
import { getMetadataBranchTree, listCheckpoints } from './metadata-branch';
import {
	extractFirstPrompt,
	readAllSessionPromptsFromTree,
	readSessionPromptFromTree,
} from './prompts';
import type { CheckpointInfo, RewindPoint, SessionState } from './types';

/**
 * List rewind candidates: shadow checkpoints (uncommitted) + logs-only
 * commits (committed via `Story-Checkpoint:` trailer). Returns up to
 * `limit` points sorted by date desc; logs-only entries with the same
 * commit hash as a shadow point are deduplicated.
 *
 * Mirrors Go `manual_commit_rewind.go: GetRewindPoints`.
 *
 * Pipeline:
 *   1. open repo + read HEAD
 *   2. {@link ManualCommitStrategy.findSessionsForCommit}(headHash) (best-effort)
 *   3. for each session: {@link listTemporaryCheckpoints} → shadow checkpoints
 *   4. cache `sessionPrompt` keyed by `sessionId` (avoid re-read)
 *   5. sort by date desc, trim to limit
 *   6. {@link getLogsOnlyRewindPoints}(limit) (best-effort)
 *   7. dedupe by commit ID, merge, re-sort, re-trim
 *
 * @example
 * ```ts
 * await getRewindPointsImpl(strategy, 10);
 * // returns: RewindPoint[]   (≤ 10, mix of shadow + logs-only, sorted date desc)
 *
 * // Side effects: read-only — git ref / log / tree reads.
 * ```
 */
export async function getRewindPointsImpl(
	s: ManualCommitStrategy,
	limit: number,
): Promise<RewindPoint[]> {
	const repo = await s.getRepo();
	// Touch the checkpoint store so any setup-time error surfaces here (mirrors
	// Go `s.getCheckpointStore()` early-return on failure).
	await s.getCheckpointStore();

	let headHash: string;
	try {
		headHash = (await execGit(['rev-parse', 'HEAD'], { cwd: repo.root })).trim();
	} catch (e) {
		throw new Error(`failed to get HEAD: ${(e as Error).message}`, { cause: e as Error });
	}

	let sessions: SessionState[];
	try {
		sessions = await s.findSessionsForCommit(headHash);
	} catch (e) {
		log.debug({ component: 'rewind' }, 'getRewindPoints: findSessionsForCommit error', {
			error: (e as Error).message,
		});
		sessions = [];
	}

	const allPoints: RewindPoint[] = [];
	const sessionPrompts = new Map<string, string>();

	for (const state of sessions) {
		let cps: TemporaryCheckpointInfo[];
		try {
			cps = await listTemporaryCheckpoints(
				repo.root,
				state.baseCommit,
				state.worktreeId ?? '',
				state.sessionId,
				limit,
			);
		} catch {
			continue;
		}
		for (const cp of cps) {
			let prompt = sessionPrompts.get(cp.sessionId);
			if (prompt === undefined) {
				prompt = await readSessionPrompt(repo.root, cp.commitHash, cp.metadataDir);
				sessionPrompts.set(cp.sessionId, prompt);
			}
			allPoints.push({
				id: cp.commitHash,
				message: cp.message,
				metadataDir: cp.metadataDir,
				date: new Date(cp.timestamp),
				isTaskCheckpoint: cp.isTaskCheckpoint,
				toolUseId: cp.toolUseId,
				isLogsOnly: false,
				checkpointId: EMPTY_CHECKPOINT_ID,
				agent: normalize(state.agentType ?? ''),
				sessionId: cp.sessionId,
				sessionPrompt: prompt,
				sessionCount: 1,
				sessionIds: [cp.sessionId],
				sessionPrompts: [prompt],
			});
		}
	}

	allPoints.sort((a, b) => b.date.getTime() - a.date.getTime());
	if (allPoints.length > limit) {
		allPoints.length = limit;
	}

	let logsOnly: RewindPoint[] = [];
	try {
		logsOnly = await getLogsOnlyRewindPoints(s, limit);
	} catch (e) {
		log.debug({ component: 'rewind' }, 'getLogsOnlyRewindPoints error (silent)', {
			error: (e as Error).message,
		});
	}
	if (logsOnly.length > 0) {
		const existing = new Set(allPoints.map((p) => p.id));
		for (const p of logsOnly) {
			if (!existing.has(p.id)) {
				allPoints.push(p);
			}
		}
		allPoints.sort((a, b) => b.date.getTime() - a.date.getTime());
		if (allPoints.length > limit) {
			allPoints.length = limit;
		}
	}

	return allPoints;
}

/**
 * Find commits in the current branch's history that have condensed session
 * logs on the metadata branch. These are commits whose shadow branch has
 * been deleted (condensed away), but whose transcript is still readable
 * from `story/checkpoints/v1`.
 *
 * Mirrors Go `manual_commit_rewind.go: GetLogsOnlyRewindPoints`.
 *
 * Pipeline:
 *   1. {@link listCheckpoints} (empty list → return [])
 *   2. build `cpInfoMap[CheckpointID] → CheckpointInfo`
 *   3. {@link getMetadataBranchTree} (best-effort — null on miss)
 *   4. read HEAD; walk last `LOGS_ONLY_SCAN_LIMIT` commits via `git.log`
 *   5. for each commit: parse all `Story-Checkpoint:` trailers
 *   6. {@link resolveLatestCheckpointFromMap}(trailerIds, cpInfoMap)
 *   7. read prompt(s) from metadata tree (single-session vs multi-session)
 *   8. push `RewindPoint{ isLogsOnly: true, ... }`
 *   9. trim to limit
 *
 * @example
 * ```ts
 * await getLogsOnlyRewindPoints(strategy, 10);
 * // returns: RewindPoint[]   (logs-only commits, isLogsOnly=true, ≤ 10)
 *
 * // Side effects: read-only — listCheckpoints + git.log walk + tree reads.
 * ```
 */
export async function getLogsOnlyRewindPoints(
	s: ManualCommitStrategy,
	limit: number,
): Promise<RewindPoint[]> {
	const repo = await s.getRepo();

	let checkpoints: CheckpointInfo[];
	try {
		checkpoints = await listCheckpoints(repo.root);
	} catch {
		return [];
	}
	if (checkpoints.length === 0) {
		return [];
	}

	const cpInfoMap = new Map<string, CheckpointInfo>();
	for (const cp of checkpoints) {
		if (!isEmpty(cp.checkpointId)) {
			cpInfoMap.set(cp.checkpointId, cp);
		}
	}

	let metadataTree: string | null = null;
	try {
		metadataTree = await getMetadataBranchTree(repo.root);
	} catch {
		metadataTree = null;
	}

	let headHash: string;
	try {
		headHash = (await execGit(['rev-parse', 'HEAD'], { cwd: repo.root })).trim();
	} catch (e) {
		throw new Error(`failed to get HEAD: ${(e as Error).message}`, { cause: e as Error });
	}

	const points: RewindPoint[] = [];

	// Go: manual_commit_rewind.go: GetLogsOnlyRewindPoints walks ALL parents
	// (including merge commit side parents). isomorphic-git's `git.log` uses
	// a first-parent-only default, so we switch to `git rev-list` which
	// already traverses every parent in committer-time order. Keeping the
	// CLI fallback also means consumers on exotic object stores still get
	// git's native walker.
	let hashes: string[];
	try {
		const raw = await execGit(['rev-list', '-n', String(LOGS_ONLY_SCAN_LIMIT), headHash], {
			cwd: repo.root,
		});
		hashes = raw === '' ? [] : raw.split('\n').filter(Boolean);
	} catch {
		hashes = [];
	}

	for (const oid of hashes) {
		let c: { oid: string; commit: { message: string; author: { timestamp: number } } };
		try {
			const result = await git.readCommit({ fs: fsCallback, dir: repo.root, oid });
			c = { oid, commit: result.commit };
		} catch {
			continue;
		}
		const allCpIds = parseAllCheckpoints(c.commit.message);
		if (allCpIds.length === 0) {
			continue;
		}
		const cpInfo = resolveLatestCheckpointFromMap(allCpIds, cpInfoMap);
		if (cpInfo === null) {
			continue;
		}
		const message = c.commit.message.split('\n')[0] ?? '';
		let sessionPrompt = '';
		let sessionPrompts: string[] = [];
		if (metadataTree !== null) {
			const cpPath = toCheckpointPath(cpInfo.checkpointId);
			const sessionCount = cpInfo.sessionCount ?? 1;
			const sessionIds = cpInfo.sessionIds ?? [];
			if (sessionCount > 1 && sessionIds.length > 1) {
				sessionPrompts = await readAllSessionPromptsFromTree(
					repo.root,
					metadataTree,
					cpPath,
					sessionCount,
					sessionIds,
				);
				if (sessionPrompts.length > 0) {
					sessionPrompt = sessionPrompts[sessionPrompts.length - 1] ?? '';
				}
			} else {
				sessionPrompt = await readSessionPromptFromTree(repo.root, metadataTree, cpPath);
				if (sessionPrompt !== '') {
					sessionPrompts = [sessionPrompt];
				}
			}
		}
		points.push({
			id: c.oid,
			message,
			metadataDir: '',
			date: new Date(c.commit.author.timestamp * 1000),
			isTaskCheckpoint: false,
			toolUseId: '',
			isLogsOnly: true,
			checkpointId: cpInfo.checkpointId,
			agent: cpInfo.agent ?? normalize(''),
			sessionId: cpInfo.sessionId,
			sessionPrompt,
			sessionCount: cpInfo.sessionCount ?? 1,
			sessionIds: cpInfo.sessionIds ?? [cpInfo.sessionId],
			sessionPrompts,
		});
	}

	if (points.length > limit) {
		points.length = limit;
	}
	return points;
}

/**
 * Pick the {@link CheckpointInfo} with the latest `createdAt` from a list
 * of checkpoint IDs. Filters input to IDs present in `infoMap`, then
 * returns the one with the most recent `createdAt`. Returns `null` when
 * no input ID is in the map.
 *
 * Used by {@link getLogsOnlyRewindPoints} to handle squash-merge /
 * cherry-pick commits that may carry multiple `Story-Checkpoint:`
 * trailers from the originals.
 *
 * Mirrors Go `manual_commit_rewind.go: ResolveLatestCheckpointFromMap`.
 *
 * @example
 * ```ts
 * resolveLatestCheckpointFromMap(['cp-a', 'cp-b'], new Map([
 *   ['cp-a', { ..., createdAt: new Date('2026-04-15') }],
 *   ['cp-b', { ..., createdAt: new Date('2026-04-16') }],
 * ]));
 * // returns: CheckpointInfo (the cp-b entry — newer)
 *
 * resolveLatestCheckpointFromMap(['unknown'], new Map());
 * // returns: null
 * ```
 */
export function resolveLatestCheckpointFromMap(
	cpIds: readonly CheckpointID[],
	infoMap: ReadonlyMap<string, CheckpointInfo>,
): CheckpointInfo | null {
	let latest: CheckpointInfo | null = null;
	for (const cpId of cpIds) {
		const info = infoMap.get(cpId);
		if (info === undefined) {
			continue;
		}
		if (latest === null || info.createdAt.getTime() > latest.createdAt.getTime()) {
			latest = info;
		}
	}
	return latest;
}

/**
 * Read the first user prompt from `<metadataDir>/prompt.txt` in the given
 * commit's tree. Returns `''` on any failure (commit not found, tree not
 * found, blob missing, read error).
 *
 * Mirrors Go `manual_commit_rewind.go: readSessionPrompt`.
 *
 * @example
 * ```ts
 * await readSessionPrompt(repoDir, 'def5678...', '.story/metadata/sess-1');
 * // returns: 'rewrite the README'
 * // returns: ''   (on any failure)
 *
 * // Side effects: read-only — single git tree blob read.
 * ```
 */
export async function readSessionPrompt(
	repoDir: string,
	commitHash: string,
	metadataDir: string,
): Promise<string> {
	let treeOid: string;
	try {
		const { commit } = await git.readCommit({ fs: fsCallback, dir: repoDir, oid: commitHash });
		treeOid = commit.tree;
	} catch {
		return '';
	}
	try {
		const blob = await git.readBlob({
			fs: fsCallback,
			dir: repoDir,
			oid: treeOid,
			filepath: `${metadataDir}/prompt.txt`,
		});
		return extractFirstPrompt(blob.blob);
	} catch {
		return '';
	}
}
