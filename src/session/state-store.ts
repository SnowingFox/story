/**
 * Session state persistence.
 *
 * Mirrors `entire-cli/cmd/entire/cli/session/state.go`. Provides a {@link StateStore}
 * for atomic, traversal-resistant load/save/clear/list/removeAll operations on session
 * state files (`<sessionId>.json`) inside `.git/story-sessions/`.
 *
 * @packageDocumentation
 */

import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { match, P } from 'ts-pattern';
import { z } from 'zod';
import { type CheckpointID, deserialize, EMPTY_CHECKPOINT_ID, serialize } from '../id';
import { isSubpath, SESSION_STATE_DIR_NAME } from '../paths';
import { validateSessionId } from '../validation';
import { normalizePhase, type Phase } from './phase';

// Re-export so callers wiring up a {@link StateStore} can stay within the
// `@/session` namespace without reaching into `@/paths` for the dir name.
export { SESSION_STATE_DIR_NAME };

/** True when `err` is a Node fs error with the given code (ENOENT, EACCES, etc.). */
function isFsError(err: unknown, code: string): boolean {
	return match(err)
		.with({ code: P.string }, (e) => e.code === code)
		.otherwise(() => false);
}

/** Sessions older than this without interaction are considered stale. */
export const STALE_SESSION_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * ACTIVE sessions older than this without interaction are "stuck" — used by
 * `story doctor` and `story status`.
 */
export const STUCK_ACTIVE_THRESHOLD_MS = 60 * 60 * 1000;

/** Token usage tracking, accumulated across all checkpoints in a session. */
export interface TokenUsage {
	/** Input tokens (fresh, not from cache). */
	inputTokens: number;
	/** Tokens written to cache (billable at cache write rate). */
	cacheCreationTokens: number;
	/** Tokens read from cache (discounted rate). */
	cacheReadTokens: number;
	/** Output tokens generated. */
	outputTokens: number;
	/** Number of API calls made. */
	apiCallCount: number;
	/** Token usage from spawned subagents (if any). */
	subagentTokens?: TokenUsage | null;
}

/**
 * Line-level attribution data captured at the start of each prompt. Recording
 * what changed since the last checkpoint *before* the agent works enables
 * accurate separation of user edits from agent contributions.
 */
export interface PromptAttribution {
	/** Which checkpoint this was recorded before (1-indexed). */
	checkpointNumber: number;
	/** Lines added by user since the last checkpoint. */
	userLinesAdded: number;
	/** Lines removed by user since the last checkpoint. */
	userLinesRemoved: number;
	/** Total agent lines added so far (base → last checkpoint). 0 for checkpoint 1. */
	agentLinesAdded: number;
	/** Total agent lines removed so far (base → last checkpoint). 0 for checkpoint 1. */
	agentLinesRemoved: number;
	/** Per-file user additions for accurate modification tracking. */
	userAddedPerFile?: Record<string, number>;
	/** Per-file user removals for accurate agent deletion attribution. */
	userRemovedPerFile?: Record<string, number>;
}

/**
 * Per-turn timing captured by Story's normalized lifecycle.
 *
 * Story-led divergence: Go Entire CLI does not persist per-turn metrics. Story
 * records them so agents whose transcripts lack message timestamps (notably
 * Cursor) can still show per-turn response durations.
 */
export interface TurnMetric {
	/** Stable turn identifier when the agent provides one; otherwise Story derives one. */
	turnId: string;
	/** RFC 3339 timestamp captured at normalized TurnStart. */
	startedAt: string;
	/** RFC 3339 timestamp captured at normalized TurnEnd. */
	endedAt: string;
	/** Elapsed agent response time for this turn, in milliseconds. */
	durationMs: number;
}

/**
 * Persistent state of an active session, stored in
 * `.git/story-sessions/<session-id>.json`.
 *
 * Field names use camelCase in TS but JSON serializes to snake_case for
 * cross-language compatibility with the Go implementation.
 */
export interface SessionState {
	/** Unique session identifier. */
	sessionId: string;
	/** CLI version that created this session. */
	cliVersion?: string;
	/**
	 * Current shadow branch base. Initially HEAD; updated on migration (pull/rebase)
	 * and after condensation. Used for shadow branch naming and checkpoint storage —
	 * NOT for attribution.
	 */
	baseCommit: string;
	/**
	 * Reference point for attribution calculations. Unlike {@link baseCommit} (which
	 * tracks the shadow branch and moves with migration), this preserves the original
	 * base so deferred condensation can correctly calculate agent vs human attribution.
	 * Updated only after successful condensation.
	 */
	attributionBaseCommit?: string;
	/** Absolute path to the worktree root. */
	worktreePath?: string;
	/** Internal git worktree identifier (empty for main worktree). */
	worktreeId?: string;
	/** ISO-8601 timestamp when the session was started. */
	startedAt: string;
	/** ISO-8601 timestamp when the session was explicitly closed (null = still active). */
	endedAt?: string | null;
	/** Lifecycle stage. Empty defaults to `idle` (backward compat). */
	phase: Phase;
	/** Unique identifier for the current agent turn. */
	turnId?: string;
	/** Checkpoint IDs condensed during the current turn. */
	turnCheckpointIds?: string[];
	/** ISO-8601 timestamp of last agent-interaction event (TurnStart, TurnEnd, etc.). */
	lastInteractionTime?: string;
	/** Number of checkpoints created in this session. JSON key is `checkpoint_count`. */
	stepCount: number;
	/** Transcript line offset where the current checkpoint cycle began. */
	checkpointTranscriptStart?: number;
	/** Byte size of transcript at last condensation (fast "has new content" check). */
	checkpointTranscriptSize?: number;
	/** transcript.jsonl line offset where the current checkpoint cycle began. */
	compactTranscriptStart?: number;
	/** Files modified/created/deleted during this session. */
	filesTouched?: string[];
	/** Files that existed at session start (preserved during rewind). */
	untrackedFilesAtStart?: string[];
	/** Most recent checkpoint ID from condensation (cleared on new prompt). */
	lastCheckpointId?: CheckpointID;
	/** Session has been condensed and has no remaining carry-forward files. */
	fullyCondensed?: boolean;
	/** Imported via `story attach` rather than captured by hooks. */
	attachedManually?: boolean;
	/** Agent that created this session (e.g., `Claude Code`). */
	agentType?: string;
	/** LLM model used in this session (e.g., `claude-sonnet-4-20250514`). */
	modelName?: string;
	/** Accumulated token usage across all checkpoints. */
	tokenUsage?: TokenUsage | null;
	/** Hook-provided session metrics. */
	sessionDurationMs?: number;
	sessionTurnCount?: number;
	/** Sum of all known turn durations; pure agent active time, excluding user idle time. */
	activeDurationMs?: number;
	/** Per-turn timing snapshots captured from Story's TurnStart → TurnEnd lifecycle. */
	turnMetrics?: TurnMetric[];
	contextTokens?: number;
	contextWindowSize?: number;
	/**
	 * Transcript-line position recorded at the last phase boundary (session
	 * start, compaction, resume). Phase 7 handlers re-anchor this so
	 * subsequent TurnEnd / subagent events only see lines added **after**
	 * the boundary — independent of {@link checkpointTranscriptStart} which
	 * is owned by the condensation pipeline.
	 *
	 * Added by Phase 7 Part 1 (compaction handler). JSON key
	 * `transcript_offset` mirrors Go `PrePromptState.TranscriptOffset` (Go
	 * stores the same signal on the pre-prompt side, TS lifts it onto
	 * SessionState so compaction's re-snapshot survives across processes).
	 */
	transcriptOffset?: number;
	/**
	 * Number of times the agent has compacted its transcript during this
	 * session. Used by Phase 7 compaction handler + Phase 9 analytics to
	 * surface "frequently-compacting" sessions.
	 *
	 * Added by Phase 7 Part 1 (compaction handler). JSON key
	 * `compaction_count`; Go has no equivalent field yet (TS-led design).
	 */
	compactionCount?: number;
	/** Last transcript identifier (e.g. UUID for Claude, agent-specific id for others). */
	transcriptIdentifierAtStart?: string;
	/** Path to the live transcript file (mid-session commit detection). */
	transcriptPath?: string;
	/** Most recent user prompt (truncated for display). JSON key is `last_prompt`. */
	lastPrompt?: string;
	/** Per-prompt attribution snapshots. */
	promptAttributions?: PromptAttribution[];
	/** Attribution calculated at prompt start (before agent runs). */
	pendingPromptAttribution?: PromptAttribution | null;

	// Deprecated (kept for backward-compat normalization).
	/** @deprecated Use {@link checkpointTranscriptStart}. */
	condensedTranscriptLines?: number;
	/** @deprecated Use {@link checkpointTranscriptStart}. */
	transcriptLinesAtStart?: number;
}

// Zod schemas — snake_case JSON keys mirror Go struct tags for cross-implementation
// byte-compatibility; the .transform() steps reshape into camelCase TS objects.

const tokenUsageSchema: z.ZodType<TokenUsage> = z.lazy(() =>
	z
		.object({
			input_tokens: z.number().default(0),
			cache_creation_tokens: z.number().default(0),
			cache_read_tokens: z.number().default(0),
			output_tokens: z.number().default(0),
			api_call_count: z.number().default(0),
			subagent_tokens: tokenUsageSchema.nullable().optional(),
		})
		.transform((d) => ({
			inputTokens: d.input_tokens,
			cacheCreationTokens: d.cache_creation_tokens,
			cacheReadTokens: d.cache_read_tokens,
			outputTokens: d.output_tokens,
			apiCallCount: d.api_call_count,
			subagentTokens: d.subagent_tokens ?? undefined,
		})),
);

const promptAttributionSchema = z
	.object({
		checkpoint_number: z.number().default(0),
		user_lines_added: z.number().default(0),
		user_lines_removed: z.number().default(0),
		agent_lines_added: z.number().default(0),
		agent_lines_removed: z.number().default(0),
		user_added_per_file: z.record(z.string(), z.number()).optional(),
		user_removed_per_file: z.record(z.string(), z.number()).optional(),
	})
	.transform(
		(d): PromptAttribution => ({
			checkpointNumber: d.checkpoint_number,
			userLinesAdded: d.user_lines_added,
			userLinesRemoved: d.user_lines_removed,
			agentLinesAdded: d.agent_lines_added,
			agentLinesRemoved: d.agent_lines_removed,
			userAddedPerFile: d.user_added_per_file,
			userRemovedPerFile: d.user_removed_per_file,
		}),
	);

const turnMetricSchema = z
	.object({
		turn_id: z.string().default(''),
		started_at: z.string(),
		ended_at: z.string(),
		duration_ms: z.number().default(0),
	})
	.transform(
		(d): TurnMetric => ({
			turnId: d.turn_id,
			startedAt: d.started_at,
			endedAt: d.ended_at,
			durationMs: d.duration_ms,
		}),
	);

const sessionStateSchema = z
	.object({
		session_id: z.string(),
		cli_version: z.string().optional(),
		base_commit: z.string().default(''),
		attribution_base_commit: z.string().optional(),
		worktree_path: z.string().optional(),
		worktree_id: z.string().optional(),
		started_at: z.string(),
		ended_at: z.string().nullable().optional(),
		phase: z.string().default(''),
		turn_id: z.string().optional(),
		turn_checkpoint_ids: z.array(z.string()).optional(),
		last_interaction_time: z.string().optional(),
		checkpoint_count: z.number().default(0),
		checkpoint_transcript_start: z.number().optional(),
		checkpoint_transcript_size: z.number().optional(),
		compact_transcript_start: z.number().optional(),
		files_touched: z.array(z.string()).optional(),
		untracked_files_at_start: z.array(z.string()).optional(),
		last_checkpoint_id: z.string().optional(),
		fully_condensed: z.boolean().optional(),
		attached_manually: z.boolean().optional(),
		agent_type: z.string().optional(),
		model_name: z.string().optional(),
		token_usage: tokenUsageSchema.nullable().optional(),
		session_duration_ms: z.number().optional(),
		session_turn_count: z.number().optional(),
		active_duration_ms: z.number().optional(),
		turn_metrics: z.array(turnMetricSchema).optional(),
		context_tokens: z.number().optional(),
		context_window_size: z.number().optional(),
		transcript_offset: z.number().optional(),
		compaction_count: z.number().optional(),
		transcript_identifier_at_start: z.string().optional(),
		transcript_path: z.string().optional(),
		last_prompt: z.string().optional(),
		prompt_attributions: z.array(promptAttributionSchema).optional(),
		pending_prompt_attribution: promptAttributionSchema.nullable().optional(),
		condensed_transcript_lines: z.number().optional(),
		transcript_lines_at_start: z.number().optional(),
	})
	.transform((d): SessionState => {
		const lastCheckpointId =
			d.last_checkpoint_id !== undefined ? deserialize(d.last_checkpoint_id) : undefined;
		return {
			sessionId: d.session_id,
			cliVersion: d.cli_version,
			baseCommit: d.base_commit,
			attributionBaseCommit: d.attribution_base_commit,
			worktreePath: d.worktree_path,
			worktreeId: d.worktree_id,
			startedAt: d.started_at,
			endedAt: d.ended_at ?? undefined,
			phase: normalizePhase(d.phase),
			turnId: d.turn_id,
			turnCheckpointIds: d.turn_checkpoint_ids,
			lastInteractionTime: d.last_interaction_time,
			stepCount: d.checkpoint_count,
			checkpointTranscriptStart: d.checkpoint_transcript_start,
			checkpointTranscriptSize: d.checkpoint_transcript_size,
			compactTranscriptStart: d.compact_transcript_start,
			filesTouched: d.files_touched,
			untrackedFilesAtStart: d.untracked_files_at_start,
			lastCheckpointId,
			fullyCondensed: d.fully_condensed,
			attachedManually: d.attached_manually,
			agentType: d.agent_type,
			modelName: d.model_name,
			tokenUsage: d.token_usage ?? undefined,
			sessionDurationMs: d.session_duration_ms,
			sessionTurnCount: d.session_turn_count,
			activeDurationMs: d.active_duration_ms,
			turnMetrics: d.turn_metrics,
			contextTokens: d.context_tokens,
			contextWindowSize: d.context_window_size,
			transcriptOffset: d.transcript_offset,
			compactionCount: d.compaction_count,
			transcriptIdentifierAtStart: d.transcript_identifier_at_start,
			transcriptPath: d.transcript_path,
			lastPrompt: d.last_prompt,
			promptAttributions: d.prompt_attributions,
			pendingPromptAttribution: d.pending_prompt_attribution ?? undefined,
			condensedTranscriptLines: d.condensed_transcript_lines,
			transcriptLinesAtStart: d.transcript_lines_at_start,
		};
	});

/**
 * Serialize a {@link TokenUsage} to its JSON shape (snake_case keys, matching Go).
 */
function tokenUsageToJSON(t: TokenUsage): Record<string, unknown> {
	return {
		input_tokens: t.inputTokens,
		cache_creation_tokens: t.cacheCreationTokens,
		cache_read_tokens: t.cacheReadTokens,
		output_tokens: t.outputTokens,
		api_call_count: t.apiCallCount,
		...(t.subagentTokens ? { subagent_tokens: tokenUsageToJSON(t.subagentTokens) } : {}),
	};
}

function promptAttributionToJSON(a: PromptAttribution): Record<string, unknown> {
	const out: Record<string, unknown> = {
		checkpoint_number: a.checkpointNumber,
		user_lines_added: a.userLinesAdded,
		user_lines_removed: a.userLinesRemoved,
		agent_lines_added: a.agentLinesAdded,
		agent_lines_removed: a.agentLinesRemoved,
	};
	if (a.userAddedPerFile) {
		out.user_added_per_file = a.userAddedPerFile;
	}
	if (a.userRemovedPerFile) {
		out.user_removed_per_file = a.userRemovedPerFile;
	}
	return out;
}

function turnMetricToJSON(t: TurnMetric): Record<string, unknown> {
	return {
		turn_id: t.turnId,
		started_at: t.startedAt,
		ended_at: t.endedAt,
		duration_ms: t.durationMs,
	};
}

/**
 * Serialize a {@link SessionState} to its JSON shape (snake_case keys, matching Go).
 *
 * `omitempty` fields in Go are omitted here when undefined/null/empty so the disk
 * format stays byte-compatible across implementations.
 */
function sessionStateToJSON(s: SessionState): Record<string, unknown> {
	const out: Record<string, unknown> = {
		session_id: s.sessionId,
		base_commit: s.baseCommit,
		started_at: s.startedAt,
		checkpoint_count: s.stepCount,
	};
	if (s.cliVersion) {
		out.cli_version = s.cliVersion;
	}
	if (s.attributionBaseCommit) {
		out.attribution_base_commit = s.attributionBaseCommit;
	}
	if (s.worktreePath) {
		out.worktree_path = s.worktreePath;
	}
	if (s.worktreeId) {
		out.worktree_id = s.worktreeId;
	}
	if (s.endedAt) {
		out.ended_at = s.endedAt;
	}
	if (s.phase && s.phase !== 'idle') {
		out.phase = s.phase;
	}
	if (s.turnId) {
		out.turn_id = s.turnId;
	}
	if (s.turnCheckpointIds && s.turnCheckpointIds.length > 0) {
		out.turn_checkpoint_ids = s.turnCheckpointIds;
	}
	if (s.lastInteractionTime) {
		out.last_interaction_time = s.lastInteractionTime;
	}
	if (s.checkpointTranscriptStart) {
		out.checkpoint_transcript_start = s.checkpointTranscriptStart;
	}
	if (s.checkpointTranscriptSize) {
		out.checkpoint_transcript_size = s.checkpointTranscriptSize;
	}
	if (s.compactTranscriptStart) {
		out.compact_transcript_start = s.compactTranscriptStart;
	}
	if (s.filesTouched && s.filesTouched.length > 0) {
		out.files_touched = s.filesTouched;
	}
	if (s.untrackedFilesAtStart && s.untrackedFilesAtStart.length > 0) {
		out.untracked_files_at_start = s.untrackedFilesAtStart;
	}
	if (s.lastCheckpointId && s.lastCheckpointId !== EMPTY_CHECKPOINT_ID) {
		out.last_checkpoint_id = serialize(s.lastCheckpointId);
	}
	if (s.fullyCondensed) {
		out.fully_condensed = s.fullyCondensed;
	}
	if (s.attachedManually) {
		out.attached_manually = s.attachedManually;
	}
	if (s.agentType) {
		out.agent_type = s.agentType;
	}
	if (s.modelName) {
		out.model_name = s.modelName;
	}
	if (s.tokenUsage) {
		out.token_usage = tokenUsageToJSON(s.tokenUsage);
	}
	if (s.sessionDurationMs) {
		out.session_duration_ms = s.sessionDurationMs;
	}
	if (s.sessionTurnCount) {
		out.session_turn_count = s.sessionTurnCount;
	}
	if (s.activeDurationMs) {
		out.active_duration_ms = s.activeDurationMs;
	}
	if (s.turnMetrics && s.turnMetrics.length > 0) {
		out.turn_metrics = s.turnMetrics.map(turnMetricToJSON);
	}
	if (s.contextTokens) {
		out.context_tokens = s.contextTokens;
	}
	if (s.contextWindowSize) {
		out.context_window_size = s.contextWindowSize;
	}
	if (s.transcriptOffset) {
		out.transcript_offset = s.transcriptOffset;
	}
	if (s.compactionCount) {
		out.compaction_count = s.compactionCount;
	}
	if (s.transcriptIdentifierAtStart) {
		out.transcript_identifier_at_start = s.transcriptIdentifierAtStart;
	}
	if (s.transcriptPath) {
		out.transcript_path = s.transcriptPath;
	}
	if (s.lastPrompt) {
		out.last_prompt = s.lastPrompt;
	}
	if (s.promptAttributions && s.promptAttributions.length > 0) {
		out.prompt_attributions = s.promptAttributions.map(promptAttributionToJSON);
	}
	if (s.pendingPromptAttribution) {
		out.pending_prompt_attribution = promptAttributionToJSON(s.pendingPromptAttribution);
	}
	return out;
}

/**
 * Apply backward-compatible migrations after deserializing from JSON. Mutates `s`.
 *
 * Migrations:
 * - Legacy `active_committed` phase normalizes to `active`.
 * - Empty/unknown phase normalizes to `idle`.
 * - `condensedTranscriptLines` and `transcriptLinesAtStart` migrate to
 *   `checkpointTranscriptStart` (only when the new field is unset / 0).
 * - Deprecated fields are zeroed so they aren't re-persisted.
 * - `attributionBaseCommit` is backfilled from `baseCommit` if empty.
 */
export function normalizeAfterLoad(s: SessionState): void {
	// Defensive renormalization: callers may construct SessionState directly and
	// bypass the zod transform that already runs on load().
	s.phase = normalizePhase(s.phase);

	if (!s.checkpointTranscriptStart || s.checkpointTranscriptStart === 0) {
		if (s.condensedTranscriptLines && s.condensedTranscriptLines > 0) {
			s.checkpointTranscriptStart = s.condensedTranscriptLines;
		} else if (s.transcriptLinesAtStart && s.transcriptLinesAtStart > 0) {
			s.checkpointTranscriptStart = s.transcriptLinesAtStart;
		}
	}
	s.condensedTranscriptLines = 0;
	s.transcriptLinesAtStart = 0;

	if (!s.attributionBaseCommit && s.baseCommit) {
		s.attributionBaseCommit = s.baseCommit;
	}
}

/**
 * True when the session has not seen interaction for longer than
 * {@link STALE_SESSION_THRESHOLD_MS}. Falls back to `startedAt` when
 * `lastInteractionTime` is absent.
 */
export function isStale(s: SessionState): boolean {
	const ref = s.lastInteractionTime ?? s.startedAt;
	const elapsed = Date.now() - new Date(ref).getTime();
	return elapsed > STALE_SESSION_THRESHOLD_MS;
}

/**
 * True when the session is in `active` phase but has had no interaction for longer
 * than {@link STUCK_ACTIVE_THRESHOLD_MS}. Falls back to `startedAt` when
 * `lastInteractionTime` is absent.
 */
export function isStuckActive(s: SessionState): boolean {
	if (s.phase !== 'active') {
		return false;
	}
	const ref = s.lastInteractionTime ?? s.startedAt;
	const elapsed = Date.now() - new Date(ref).getTime();
	return elapsed > STUCK_ACTIVE_THRESHOLD_MS;
}

/**
 * Low-level operations for managing session state files.
 *
 * Constructor takes `stateDir` directly so tests can inject a temp directory.
 * Production callers should pass `path.join(await getGitCommonDir(), SESSION_STATE_DIR_NAME)`.
 *
 * All session ID inputs are validated via {@link validateSessionId} to prevent
 * path traversal. File IO uses {@link isSubpath}-guarded resolution to mirror
 * the Go `osroot` behavior.
 */
export class StateStore {
	constructor(private readonly stateDir: string) {}

	/** Resolve a path relative to `stateDir`, guarding against traversal. */
	private resolveInside(name: string): string {
		const target = path.join(this.stateDir, name);
		if (!isSubpath(this.stateDir, path.normalize(target))) {
			throw new Error(`path escapes state dir: ${name}`);
		}
		return target;
	}

	/** State file path for a session ID. Validates the ID first. */
	private filePath(sessionId: string): string {
		const err = validateSessionId(sessionId);
		if (err) {
			throw err;
		}
		return this.resolveInside(`${sessionId}.json`);
	}

	/**
	 * Load session state. Returns `null` for missing files, missing directory,
	 * or stale sessions (which are also auto-deleted as a side effect).
	 *
	 * Throws on invalid session ID or unreadable/corrupted state files.
	 */
	async load(sessionId: string): Promise<SessionState | null> {
		const file = this.filePath(sessionId);

		if (!existsSync(this.stateDir)) {
			return null;
		}

		let raw: Buffer;
		try {
			raw = await fs.readFile(file);
		} catch (err) {
			if (isFsError(err, 'ENOENT')) {
				return null;
			}
			throw new Error(`failed to read session state: ${(err as Error).message}`);
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(raw.toString('utf-8'));
		} catch (err) {
			throw new Error(`failed to parse session state: ${(err as Error).message}`);
		}

		const state = sessionStateSchema.parse(parsed);
		normalizeAfterLoad(state);

		if (isStale(state)) {
			// Best-effort cleanup of stale session.
			try {
				await this.clear(sessionId);
			} catch {
				// Ignore cleanup failure.
			}
			return null;
		}

		return state;
	}

	/**
	 * Save session state atomically (write to `.tmp`, then rename).
	 *
	 * Creates the state directory if missing. Validates session ID. Writes with
	 * `0o600` permissions to keep state files private.
	 */
	async save(state: SessionState): Promise<void> {
		const file = this.filePath(state.sessionId);

		await fs.mkdir(this.stateDir, { recursive: true, mode: 0o750 });

		const json = `${JSON.stringify(sessionStateToJSON(state), null, 2)}\n`;
		const tmp = `${file}.tmp`;
		await fs.writeFile(tmp, json, { mode: 0o600 });
		await fs.rename(tmp, file);
	}

	/**
	 * Remove all files for a session (`<id>.json` plus any sidecars like `<id>.model`).
	 * Best-effort: missing files / missing directory are silently ignored.
	 */
	async clear(sessionId: string): Promise<void> {
		const err = validateSessionId(sessionId);
		if (err) {
			throw err;
		}

		if (!existsSync(this.stateDir)) {
			return;
		}

		let entries: string[];
		try {
			entries = await fs.readdir(this.stateDir);
		} catch {
			return;
		}

		const prefix = `${sessionId}.`;
		await Promise.all(
			entries
				.filter((name) => name.startsWith(prefix))
				.map(async (name) => {
					try {
						await fs.rm(this.resolveInside(name), { force: true });
					} catch {
						// Best-effort.
					}
				}),
		);
	}

	/** Remove the entire state directory. Used during uninstall. */
	async removeAll(): Promise<void> {
		await fs.rm(this.stateDir, { recursive: true, force: true });
	}

	/**
	 * List all non-stale sessions. Stale sessions are auto-deleted as a side effect.
	 * Corrupted / unparseable state files are silently skipped.
	 */
	async list(): Promise<SessionState[]> {
		let entries: string[];
		try {
			entries = await fs.readdir(this.stateDir);
		} catch (err) {
			if (isFsError(err, 'ENOENT')) {
				return [];
			}
			throw err;
		}

		const result: SessionState[] = [];
		for (const name of entries) {
			if (!name.endsWith('.json') || name.endsWith('.tmp')) {
				continue;
			}
			const sessionId = name.slice(0, -'.json'.length);
			let state: SessionState | null;
			try {
				state = await this.load(sessionId);
			} catch {
				continue;
			}
			if (state) {
				result.push(state);
			}
		}
		return result;
	}
}
