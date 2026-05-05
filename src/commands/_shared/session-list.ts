/**
 * Shared session-list helper — the primary data source for `story status`
 * + the `story sessions {list,info,stop}` command trio. Layers
 * checkpoint-metadata enrichment + registry-sourced agent display info on
 * top of {@link listSessionStates}.
 *
 * Mirrors Go `cmd/entire/cli/strategy/session.go` (ListSessions / GetSession
 * / findSessionByID) and the filter / markSessionEnded bits in
 * `cmd/entire/cli/sessions.go` + `cmd/entire/cli/lifecycle.go`. The Go upstream
 * is split across three files because of package layering (cli → strategy
 * one-way); TS consolidates because the data flow is all one way.
 *
 * **Architecture boundary**:
 *  - `src/strategy/session-state.ts` owns single-session I/O (load / save
 *    / list / transitionAndLog).
 *  - This module owns the **cross-session** aggregation + enrichment used
 *    by user-facing commands: checkpoint-count roll-up, files-touched
 *    union, registry-sourced agent metadata, prefix resolution.
 *
 * @packageDocumentation
 */

import { getByAgentType } from '@/agent/registry';
import { SilentError } from '@/errors';
import * as log from '@/log';
import { Event, NoOpActionHandler } from '@/session/phase';
import { isStuckActive } from '@/session/state-store';
import { listCheckpoints } from '@/strategy/metadata-branch';
import {
	listSessionStates,
	loadSessionState,
	saveSessionState,
	transitionAndLog,
} from '@/strategy/session-state';
import type { CheckpointInfo, SessionState } from '@/strategy/types';

/**
 * Enriched session view for list / info / status UI.
 *
 * Combines the raw {@link SessionState} with derived fields that render
 * poorly or not at all when read individually:
 *  - agent description + preview flag — looked up via
 *    {@link getByAgentType} (registry module)
 *  - checkpointCount / filesChanged / lastCheckpointId / lastCheckpointAt
 *    — rolled up from the metadata branch (`story/checkpoints/v1`)
 *  - status — distilled from `phase` + `endedAt` (mirrors Go
 *    `sessionPhaseLabel` in sessions.go, with an extra `'orphaned'`
 *    kind reserved for Phase 9.5 when we detect missing shadow branches)
 *
 * Go: mirrors the `sessionInfoJSON` struct in sessions.go that drives
 * `entire sessions info --json`, plus the runtime-computed aggregates
 * from `strategy/session.go: ListSessions`.
 */
export interface EnrichedSession {
	readonly id: string;
	readonly agentType: string;
	/** Description text from {@link getByAgentType}; `''` for unknown agents. */
	readonly agentDescription: string;
	/** Whether the agent is a preview / beta entry in the registry. */
	readonly agentIsPreview: boolean;
	readonly model: string | undefined;
	/** High-level status: 'active' (idle or mid-turn), 'ended', or 'orphaned'. */
	readonly status: 'active' | 'ended' | 'orphaned';
	/** RFC3339 start timestamp (copied from {@link SessionState.startedAt}). */
	readonly startedAt: string;
	readonly endedAt: string | undefined;
	/** Most recent user prompt, already truncated for status-style display. */
	readonly lastPrompt: string | undefined;
	/** RFC3339 timestamp of the last agent lifecycle interaction. */
	readonly lastInteractionTime: string | undefined;
	/** True when an ACTIVE session has had no interaction for the stuck threshold. */
	readonly isStuckActive: boolean;
	readonly worktree: string;
	readonly branch: string | undefined;
	readonly tokens: {
		readonly input: number;
		readonly output: number;
		readonly turns: number;
	};
	/** Count of checkpoints on the metadata branch that reference this session. */
	readonly checkpointCount: number;
	/** Unique files touched across all checkpoints for this session. */
	readonly filesChanged: number;
	/** Checkpoint id of the most recent metadata-branch entry for this session. */
	readonly lastCheckpointId: string | undefined;
	/** ISO-8601 timestamp of the most recent checkpoint (RFC3339). */
	readonly lastCheckpointAt: string | undefined;
}

/**
 * List every session state in the repo, enriched with metadata-branch-
 * derived fields + registry-sourced agent info. Sorted by `startedAt`
 * descending (newest first).
 *
 * Go: `strategy/session.go: ListSessions`. The Go upstream also merges
 * "additional sessions" from strategies implementing SessionSource —
 * Story's Phase 5.1 `manual-commit-session` reconciles these inbound
 * automatically so the TS list from {@link listSessionStates} already
 * contains every active/ended session.
 *
 * @example
 * await listSessions('/repo');
 * // returns: [
 * //   { id: 'sess-new', status: 'active', startedAt: '…', checkpointCount: 2, … },
 * //   { id: 'sess-old', status: 'ended',  startedAt: '…', checkpointCount: 5, … },
 * // ]
 *
 * // Side effects: none — reads `.git/story-sessions/` + metadata branch
 * // tree. Registry lookup is an in-memory map hit.
 */
export async function listSessions(cwd?: string): Promise<EnrichedSession[]> {
	const [states, checkpoints] = await Promise.all([
		listSessionStates(cwd),
		loadCheckpointsSafe(cwd),
	]);

	const byId = new Map<string, CheckpointInfo[]>();
	for (const cp of checkpoints) {
		const list = byId.get(cp.sessionId) ?? [];
		list.push(cp);
		byId.set(cp.sessionId, list);
	}

	const sessions = states.map((s) => enrich(s, byId.get(s.sessionId) ?? []));
	sessions.sort((a, b) => {
		if (a.startedAt === b.startedAt) {
			return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
		}
		return a.startedAt < b.startedAt ? 1 : -1;
	});
	return sessions;
}

/**
 * Load a single session by exact id and return its enriched view.
 *
 * Go: `strategy/session.go: GetSession`. Use {@link resolveSessionIdPrefix}
 * first if the caller only has a prefix.
 *
 * @example
 * await getSession('sess-abc123', '/repo');
 * // returns: { id: 'sess-abc123', status: 'active', … }
 *
 * await getSession('nope', '/repo');
 * // throws SilentError('Session not found: nope')
 */
export async function getSession(sessionId: string, cwd?: string): Promise<EnrichedSession> {
	const state = await loadSessionState(sessionId, cwd);
	if (state === null) {
		throw new SilentError(new Error(`Session not found: ${sessionId}`));
	}
	const checkpoints = await loadCheckpointsSafe(cwd);
	const matching = checkpoints.filter((cp) => cp.sessionId === sessionId);
	return enrich(state, matching);
}

/**
 * Resolve a possibly-prefix session id to its full form. Returns the full
 * id on a unique match.
 *
 * Go: `sessions.go: resolveSessionIDPrefix` + `strategy/session.go:
 * findSessionByID` (prefix matching semantics).
 *
 * @example
 * await resolveSessionIdPrefix('sess-abc', '/repo');
 * // returns: 'sess-abc123'                (unique prefix match)
 *
 * await resolveSessionIdPrefix('sess-ab', '/repo');
 * // throws SilentError('Ambiguous session id: sess-ab | Matches 2 sessions: sess-ab001, sess-ab002')
 *
 * await resolveSessionIdPrefix('', '/repo');
 * // throws SilentError('Missing argument: <session-id>')
 */
export async function resolveSessionIdPrefix(prefix: string, cwd?: string): Promise<string> {
	if (prefix === '') {
		throw new SilentError(new Error('Missing argument: <session-id>'));
	}
	const states = await listSessionStates(cwd);
	const exact = states.find((s) => s.sessionId === prefix);
	if (exact) {
		return exact.sessionId;
	}
	const matches = states.filter((s) => s.sessionId.startsWith(prefix));
	if (matches.length === 0) {
		throw new SilentError(new Error(`Session not found: ${prefix}`));
	}
	if (matches.length > 1) {
		const listed = matches.map((s) => s.sessionId).join(', ');
		throw new SilentError(
			new Error(`Ambiguous session id: ${prefix} | Matches ${matches.length} sessions: ${listed}`),
		);
	}
	return matches[0]!.sessionId;
}

/**
 * Return only the sessions that are still "active" (neither Phase=ended
 * nor endedAt set). Sorted newest-first, matching {@link listSessions}.
 *
 * Go: `sessions.go: filterActiveSessions` (which filters by
 * `phase !== ended && endedAt == null`). Story folds that predicate
 * behind {@link EnrichedSession.status}.
 */
export async function findActiveSessions(cwd?: string): Promise<EnrichedSession[]> {
	const sessions = await listSessions(cwd);
	return sessions.filter((s) => s.status === 'active');
}

/**
 * Mark a session as ended: fire `Event.SessionStop` through the state
 * machine, stamp `endedAt = now`, and persist. Does NOT delete
 * checkpoints, transcripts, or shadow branches.
 *
 * Non-existent sessions are a **silent no-op** (matches Go
 * `lifecycle.go: markSessionEnded` line 892-894: `if state == nil { return nil }`).
 * Callers that need a hard error should pre-check via
 * {@link resolveSessionIdPrefix}.
 *
 * Go: `cmd/entire/cli/lifecycle.go: markSessionEnded`.
 *
 * @example
 * await markSessionEnded('sess-abc123', '/repo');
 * // Side effects:
 * //   <repo>/.git/story-sessions/sess-abc123.json  ← phase='ended', endedAt=now (atomic rename)
 * //   <repo>/.story/logs/story.log                 ← 'phase transition' info line
 * // Unchanged on: checkpoints, transcripts, shadow branches, HEAD, worktree.
 *
 * await markSessionEnded('sess-never-existed', '/repo');
 * // returns: undefined (no-op — silent).
 */
export async function markSessionEnded(sessionId: string, cwd?: string): Promise<void> {
	const state = await loadSessionState(sessionId, cwd);
	if (state === null) {
		log.debug({ component: 'session-list', sessionId }, 'markSessionEnded: no state, noop');
		return;
	}

	await transitionAndLog(
		state,
		Event.SessionStop,
		{ hasFilesTouched: false, isRebaseInProgress: false },
		new NoOpActionHandler(),
	);

	state.endedAt = new Date().toISOString();
	await saveSessionState(state, cwd);
}

function enrich(state: SessionState, checkpoints: CheckpointInfo[]): EnrichedSession {
	const status = statusFromState(state);
	const agent = state.agentType ? getByAgentType(state.agentType) : null;

	let lastCheckpoint: CheckpointInfo | undefined;
	const filesUnion = new Set<string>();
	for (const cp of checkpoints) {
		for (const f of cp.filesTouched) {
			filesUnion.add(f);
		}
		if (!lastCheckpoint || cp.createdAt.getTime() > lastCheckpoint.createdAt.getTime()) {
			lastCheckpoint = cp;
		}
	}

	return {
		id: state.sessionId,
		agentType: state.agentType ?? '',
		agentDescription: agent?.description() ?? '',
		agentIsPreview: agent?.isPreview() ?? false,
		model: state.modelName,
		status,
		startedAt: state.startedAt,
		endedAt: state.endedAt ?? undefined,
		lastPrompt: state.lastPrompt,
		lastInteractionTime: state.lastInteractionTime,
		isStuckActive: isStuckActive(state),
		worktree: state.worktreePath ?? '',
		branch: undefined,
		tokens: {
			input: state.tokenUsage?.inputTokens ?? 0,
			output: state.tokenUsage?.outputTokens ?? 0,
			turns: state.sessionTurnCount ?? 0,
		},
		checkpointCount: checkpoints.length,
		filesChanged: filesUnion.size,
		lastCheckpointId: lastCheckpoint?.checkpointId,
		lastCheckpointAt: lastCheckpoint?.createdAt.toISOString(),
	};
}

/**
 * Distill {@link EnrichedSession.status} from the raw state. Matches
 * Go `sessions.go: sessionPhaseLabel` with `'idle'` folded into
 * `'active'` (UI-level simplification — idle is just "active but no
 * current turn" which the user-facing card doesn't need to distinguish).
 *
 * The `'orphaned'` branch is wired here so Phase 9.5 `doctor` can flip
 * it on when shadow-branch reconciliation is added.
 */
function statusFromState(state: SessionState): EnrichedSession['status'] {
	if (state.phase === 'ended' || state.endedAt) {
		return 'ended';
	}
	return 'active';
}

async function loadCheckpointsSafe(cwd?: string): Promise<CheckpointInfo[]> {
	if (cwd === undefined) {
		return safeListCheckpoints(process.cwd());
	}
	return safeListCheckpoints(cwd);
}

/**
 * Wrap {@link listCheckpoints} so a missing / mis-initialized metadata
 * branch degrades to "no checkpoints" rather than crashing `story status`
 * on a freshly-enabled repo. Matches Go `ListSessions` which reads the
 * branch tree and silently continues when the ref does not exist.
 */
async function safeListCheckpoints(cwd: string): Promise<CheckpointInfo[]> {
	try {
		return await listCheckpoints(cwd);
	} catch (err) {
		log.debug(
			{ component: 'session-list' },
			'listCheckpoints failed; treating repo as no-metadata-branch',
			{ error: err instanceof Error ? err.message : String(err) },
		);
		return [];
	}
}
