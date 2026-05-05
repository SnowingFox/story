/**
 * Strategy-package shared types.
 *
 * Mirrors:
 * - Go `entire-cli/cmd/entire/cli/strategy/strategy.go:30-260` (StepContext / TaskStepContext / RewindPoint / etc.)
 * - Go `entire-cli/cmd/entire/cli/strategy/manual_commit_types.go:27-69` (CheckpointInfo / CondenseResult / ExtractedSessionData + aliases)
 *
 * Re-exports {@link SessionState} / {@link PromptAttribution} / {@link TokenUsage} from
 * `[src/session/state-store.ts](src/session/state-store.ts)` for ergonomic
 * import within the strategy package; the actual definitions live in the
 * Phase 3 session module.
 *
 * @packageDocumentation
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentType as AgentTypeBase } from '../agent/types';
import { CHECKPOINT_FILE_NAME } from '../checkpoint/constants';
import type { CheckpointID } from '../id';
import { parseMetadataJSON } from '../jsonutil';
import type {
	PromptAttribution as SessionPromptAttribution,
	SessionState as SessionStateBase,
	TokenUsage as SessionTokenUsage,
} from '../session/state-store';

// Re-exports from Phase 3 session module.

/** Persistent session state — re-exported from `@/session/state-store`. */
export type SessionState = SessionStateBase;

/** Per-prompt attribution snapshot — re-exported from `@/session/state-store`. */
export type PromptAttribution = SessionPromptAttribution;

/** Token usage tracking — re-exported from `@/session/state-store`. */
export type TokenUsage = SessionTokenUsage;

/**
 * Agent identifier — re-exported from {@link AgentTypeBase} in `@/agent/types`.
 *
 * Phase 6.1 Part 2 narrowed this from a `string` alias to the strict 8-const
 * union from `@/agent/types`. Strategy callers that read `metadata.agent` (a
 * `string` field that may hold external-agent / hand-edited values) MUST run
 * `agent.normalize(rawString)` before passing into AgentType-typed APIs.
 *
 * Mirrors Go `types.AgentType` (newtype `string`) plus the convention that
 * unknown strings are normalized to `AGENT_TYPE_UNKNOWN`.
 */
export type AgentType = AgentTypeBase;

// Strategy-specific types.

/**
 * Trailer-level view of the current session, used to generate
 * `Story-Session:` / `Story-Reference:` trailers when committing.
 *
 * Mirrors Go `strategy.go:30-44` (`SessionInfo`).
 */
export interface SessionInfo {
	/** Session identifier extracted from the latest commit's metadata. */
	sessionId: string;
	/**
	 * Strategy-specific reference string. For manual-commit:
	 * `"story/abc1234"` (the shadow branch name). Empty for the deprecated
	 * `commit` strategy (metadata is in the same commit).
	 */
	reference: string;
	/** Full SHA of the commit containing the session metadata. Empty for `commit` strategy. */
	commitHash: string;
}

/**
 * A point to which the user can rewind. The same shape covers both shadow
 * branch checkpoints (uncommitted) and logs-only points (committed via
 * `Story-Checkpoint:` trailer).
 *
 * Mirrors Go `strategy.go:46-102` (`RewindPoint`).
 */
export interface RewindPoint {
	/** Unique identifier (commit hash, branch name, stash ref, etc.). */
	id: string;
	/** Human-readable description / summary. */
	message: string;
	/** Path to the metadata directory. */
	metadataDir: string;
	/** When this rewind point was created. */
	date: Date;
	/** True if this is a task (subagent) checkpoint, false for session checkpoint. */
	isTaskCheckpoint: boolean;
	/** Tool use ID for task checkpoints; empty for session checkpoints. */
	toolUseId: string;
	/** True for commits with session logs but no shadow-branch state (committed already). */
	isLogsOnly: boolean;
	/** Stable 12-hex-char identifier; empty for shadow-branch checkpoints (uncommitted). */
	checkpointId: CheckpointID;
	/** Human-readable name of the agent that created this checkpoint. */
	agent: AgentType;
	/** Session identifier; distinguishes checkpoints from concurrent sessions. */
	sessionId: string;
	/** Initial prompt that started this session, for user-facing context. */
	sessionPrompt: string;
	/** Number of sessions in this checkpoint (1 for single-session). */
	sessionCount: number;
	/** All session IDs when multi-session; last entry equals {@link sessionId}. */
	sessionIds: string[];
	/** First prompt for each session (parallel to {@link sessionIds}). */
	sessionPrompts: string[];
}

/**
 * Preview of files that will be touched when rewinding to a checkpoint —
 * used to warn users about destructive changes before they confirm.
 *
 * Mirrors Go `strategy.go:104-118` (`RewindPreview`).
 */
export interface RewindPreview {
	/** Files from the checkpoint that will be written / restored. */
	filesToRestore: string[];
	/** Untracked files that will be removed (post-checkpoint, not in `untrackedFilesAtStart`). */
	filesToDelete: string[];
	/** Tracked files with uncommitted changes that will be reverted. */
	trackedChanges: string[];
}

/**
 * Inputs to {@link saveStep}. All file paths are pre-filtered + normalized
 * by the CLI hook layer.
 *
 * Mirrors Go `strategy.go:120-165` (`StepContext`).
 */
export interface StepContext {
	/** Agent session identifier. */
	sessionId: string;
	/** Files modified during the session (pre-filtered, repo-relative). */
	modifiedFiles: string[];
	/** Files newly created during the session (pre-computed by CLI). */
	newFiles: string[];
	/** Files deleted during the session (tracked files no longer present). */
	deletedFiles: string[];
	/** Path to the session metadata directory (repo-relative). */
	metadataDir: string;
	/** Absolute path to the session metadata directory. */
	metadataDirAbs: string;
	/** Generated commit message for the shadow checkpoint. */
	commitMessage: string;
	/** Path to the live transcript file. */
	transcriptPath: string;
	/** Author name to use for shadow commits. */
	authorName: string;
	/** Author email to use for shadow commits. */
	authorEmail: string;
	/** Human-readable agent name (e.g., `Claude Code`). */
	agentType: AgentType;
	/** Last identifier when step started (e.g. UUID for Claude, agent-specific id for others). */
	stepTranscriptIdentifier: string;
	/** Transcript line count when this step / turn started. */
	stepTranscriptStart: number;
	/** Token usage accumulated during this step. */
	tokenUsage: TokenUsage | null;
}

/**
 * Inputs to {@link saveTaskStep} — called by `PostToolUse[Task]` when a
 * subagent completes (or by an incremental tool such as `TodoWrite`).
 *
 * Mirrors Go `strategy.go:167-243` (`TaskStepContext`).
 */
export interface TaskStepContext {
	/** Parent agent session identifier. */
	sessionId: string;
	/** Unique identifier for this Task tool invocation. */
	toolUseId: string;
	/** Subagent identifier (from `tool_response.agentId`). */
	agentId: string;
	/** Files modified by the subagent. */
	modifiedFiles: string[];
	/** Files newly created by the subagent. */
	newFiles: string[];
	/** Files deleted by the subagent. */
	deletedFiles: string[];
	/** Path to the main session transcript. */
	transcriptPath: string;
	/** Path to the subagent's transcript (if available). */
	subagentTranscriptPath: string;
	/** UUID for transcript truncation when rewinding. */
	checkpointUuid: string;
	authorName: string;
	authorEmail: string;
	/**
	 * True for incremental checkpoints during task execution (e.g., per-tool).
	 * When true: writes to `checkpoints/NNN-{tool-use-id}.json` instead of
	 * `checkpoint.json`; skips transcript handling; uses incremental message.
	 */
	isIncremental: boolean;
	/** Sequence number for incremental checkpoints (1, 2, 3, ...). */
	incrementalSequence: number;
	/** Tool that triggered the incremental checkpoint (`TodoWrite` / `Edit` / etc.). */
	incrementalType: string;
	/** Raw `tool_input` payload for the incremental checkpoint. */
	incrementalData: unknown;
	/** Subagent type extracted from `tool_input.subagent_type`. */
	subagentType: string;
	/** Task description from `tool_input.description`. */
	taskDescription: string;
	/** Content of the in-progress todo item (TodoWrite). */
	todoContent: string;
	/** Human-readable agent name. */
	agentType: AgentType;
}

/**
 * Content of `checkpoint.json` (written under the task metadata directory).
 * Mirrors Go `strategy.go:245-251` (`TaskCheckpoint`). JSON keys snake_case
 * for cross-CLI compat.
 */
export interface TaskCheckpoint {
	sessionId: string;
	toolUseId: string;
	checkpointUuid: string;
	agentId?: string;
}

/**
 * Intermediate checkpoint created during subagent execution (per-tool).
 * Mirrors Go `strategy.go:253-260` (`SubagentCheckpoint`).
 */
export interface SubagentCheckpoint {
	/** Tool name: `TodoWrite` / `Edit` / `Write` / etc. */
	type: string;
	toolUseId: string;
	timestamp: Date;
	/** Type-specific payload (the original `tool_input`). */
	data: unknown;
}

/**
 * Per-session info returned by `RestoreLogsOnly`. Each session may come from
 * a different agent, so callers use this list to print per-session resume
 * commands without re-reading the metadata tree.
 *
 * Mirrors Go `strategy.go:294-299` (`RestoredSession`).
 */
export interface RestoredSession {
	sessionId: string;
	agent: AgentType;
	prompt: string;
	/** From session metadata; used by resume to determine most recent. */
	createdAt: Date;
}

// Mirrors Go `manual_commit_types.go`.

/**
 * Checkpoint metadata stored on the metadata branch at sharded path
 * `<checkpoint_id[:2]>/<checkpoint_id[2:]>/metadata.json`.
 *
 * Mirrors Go `manual_commit_types.go:36-47` (`CheckpointInfo`). JSON keys
 * snake_case for cross-CLI compat.
 */
export interface CheckpointInfo {
	checkpointId: CheckpointID;
	sessionId: string;
	createdAt: Date;
	checkpointsCount: number;
	filesTouched: string[];
	/** Human-readable agent name (e.g., `Claude Code`). */
	agent?: AgentType;
	isTask?: boolean;
	toolUseId?: string;
	/** Number of sessions (1 if omitted). */
	sessionCount?: number;
	/** All session IDs in this checkpoint. */
	sessionIds?: string[];
}

/**
 * Result of a single `condenseSession` operation.
 * Mirrors Go `manual_commit_types.go:49-60` (`CondenseResult`).
 *
 * **Skip semantics**: when there is no transcript and no files to condense,
 * `condenseSession` returns `{ skipped: true }` early. **All callers must
 * check `skipped`** before consuming other fields.
 */
export interface CondenseResult {
	/** 12-hex-char ID from the `Story-Checkpoint:` trailer. */
	checkpointId: CheckpointID;
	sessionId: string;
	checkpointsCount: number;
	filesTouched: string[];
	/** User prompts from the condensed session. */
	prompts: string[];
	/** Total transcript units after this condensation (JSONL line count or message count by agent). */
	totalTranscriptLines: number;
	/** New compact-transcript lines added by this checkpoint (0 if v2 disabled). */
	compactTranscriptLines: number;
	/** Raw transcript bytes for downstream consumers (e.g., trail title generation). */
	transcript: Uint8Array;
	/** True if condensation was skipped (no transcript or files to condense). */
	skipped: boolean;
}

/**
 * Data extracted from a shadow branch by the condensation flow before
 * persisting to the metadata branch.
 *
 * Mirrors Go `manual_commit_types.go:62-69` (`ExtractedSessionData`).
 */
export interface ExtractedSessionData {
	transcript: Uint8Array;
	fullTranscriptLines: number;
	/** User prompts from the current checkpoint portion of the transcript. */
	prompts: string[];
	filesTouched: string[];
	/** Token usage calculated from transcript (since `checkpointTranscriptStart`). */
	tokenUsage: TokenUsage | null;
}

/**
 * Cleanup item shape produced by `ManualCommitStrategy.listOrphanedItems`
 * and consumed by `story clean` / `story doctor`. Phase 9.5 re-aligned the
 * shape to match Go `strategy/cleanup.go: CleanupItem` (Type / ID / Reason);
 * the earlier Phase 5.1 stub used `kind / identifier / reason`.
 *
 * Implementation lives in [`./cleanup.ts`](./cleanup.ts).
 */
export interface CleanupItem {
	/** Kind discriminator for the cleanable artifact. */
	type: 'session-state' | 'shadow-branch' | 'checkpoint';
	/** Identifier (session ID, branch name, etc.). */
	id: string;
	/** Human-readable reason this item was surfaced. */
	reason: string;
}

/**
 * Read the task subagent checkpoint metadata at an absolute path.
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/strategy/strategy.go:268-289`
 * (`ReadTaskCheckpoint`). Reads `<taskMetadataDirAbs>/checkpoint.json` and
 * decodes via Phase 4.4 {@link parseMetadataJSON} (snake_case → camelCase
 * Go-compat handling).
 *
 * Returns `null` when the file does not exist (`ENOENT` only); rethrows on
 * any other read error. Throws synchronously-style (rejected Promise) on
 * malformed JSON.
 *
 * @example
 * ```ts
 * await readTaskCheckpoint('/repo/.story/metadata/sess/tasks/tu_1');
 * // returns: { sessionId: 'sess', toolUseId: 'tu_1', checkpointUuid: 'uuid-1', agentId: 'a1' }
 *
 * await readTaskCheckpoint('/missing/path');
 * // returns: null  (ENOENT on the directory or the JSON file)
 *
 * await readTaskCheckpoint('/repo/.story/metadata/sess/tasks/tu_bad');
 * // throws: ZodError (when checkpoint.json contains malformed JSON)
 *
 * // Side effects: none — read-only file access.
 * //
 * // Git refs / HEAD / worktree / metadata directory contents: unchanged.
 * ```
 */
export async function readTaskCheckpoint(
	taskMetadataDirAbs: string,
): Promise<TaskCheckpoint | null> {
	const file = path.join(taskMetadataDirAbs, CHECKPOINT_FILE_NAME);
	let raw: string;
	try {
		raw = await fs.readFile(file, 'utf-8');
	} catch (err) {
		if ((err as { code?: string }).code === 'ENOENT') {
			return null;
		}
		throw err;
	}
	return parseMetadataJSON<TaskCheckpoint>(raw);
}
