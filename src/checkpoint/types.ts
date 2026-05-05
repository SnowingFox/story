/**
 * Type definitions for the checkpoint subsystem + the concrete {@link GitStore}
 * facade.
 *
 * Phase 4.1 introduced all interfaces + a `GitStore` skeleton. Phase 4.2 wires
 * the temporary-checkpoint methods to delegate to the standalone functions in
 * [`temporary.ts`](./temporary.ts). Phase 4.3 has wired the `*Committed`
 * methods to standalone implementations in [`committed.ts`](./committed.ts);
 * the GitStore class is now fully wired.
 *
 * Go reference: `entire-cli/cmd/entire/cli/checkpoint/checkpoint.go`.
 */

import {
	getCheckpointAuthor as getCheckpointAuthorImpl,
	getSessionLog as getSessionLogImpl,
	getTranscript as getTranscriptImpl,
	listCommitted as listCommittedImpl,
	readCommitted as readCommittedImpl,
	readLatestSessionContent as readLatestSessionContentImpl,
	readSessionContentById as readSessionContentByIdImpl,
	readSessionContent as readSessionContentImpl,
	readSessionMetadata as readSessionMetadataImpl,
	updateCheckpointSummary as updateCheckpointSummaryImpl,
	updateCommitted as updateCommittedImpl,
	updateSummary as updateSummaryImpl,
	writeCommitted as writeCommittedImpl,
} from './committed';
import type { BlobFetchFunc } from './fetching-tree';
import {
	listTemporary as listTemporaryImpl,
	readTemporary as readTemporaryImpl,
	writeTemporary as writeTemporaryImpl,
	writeTemporaryTask as writeTemporaryTaskImpl,
} from './temporary';

/**
 * Whether a checkpoint is the in-progress shadow snapshot or the permanent
 * post-commit metadata record. Values match Go's `iota` definition.
 */
export enum CheckpointType {
	/** Shadow branch checkpoint with full code snapshot. */
	Temporary = 0,
	/** Metadata branch checkpoint, metadata only (no code). */
	Committed = 1,
}

/** A checkpoint as exposed to higher layers (commands, strategies). */
export interface Checkpoint {
	/** Unique checkpoint identifier. */
	id: string;
	/** Session that produced this checkpoint. */
	sessionId: string;
	/** ISO 8601 creation timestamp. */
	timestamp: string;
	/** Whether this is a temporary (shadow branch) or committed (metadata branch) checkpoint. */
	type: CheckpointType;
	/** Human-readable commit message describing the checkpoint. */
	message: string;
}

/** Token usage rollup associated with a session / checkpoint. */
export interface TokenUsage {
	/** Input tokens (fresh, not from cache). */
	inputTokens: number;
	/** Tokens written to cache (billable at cache-write rate). */
	cacheCreationTokens: number;
	/** Tokens read from cache (discounted rate). */
	cacheReadTokens: number;
	/** Output tokens generated. */
	outputTokens: number;
	/** Number of API calls made. */
	apiCallCount: number;
	/** Token usage of spawned subagents, if any. */
	subagentTokens?: TokenUsage;
}

/**
 * Read/write contract for checkpoint storage. The 9 methods cover the full
 * lifecycle: temporary checkpoints on shadow branches (Phase 4.2), committed
 * checkpoints on the metadata branch (Phase 4.3), and updates after PII
 * redaction. Phase 4.1 only defines the surface — implementations land later.
 */
export interface CheckpointStore {
	/** Write a temporary checkpoint to a shadow branch. Deduplicates by tree hash. */
	writeTemporary(opts: WriteTemporaryOptions): Promise<WriteTemporaryResult>;
	/** Read the latest checkpoint from a shadow branch. Returns null if not found. */
	readTemporary(baseCommit: string, worktreeId: string): Promise<ReadTemporaryResult | null>;
	/** List all shadow branches that hold temporary checkpoints. */
	listTemporary(): Promise<TemporaryInfo[]>;

	/** Write a committed (permanent) checkpoint to the metadata branch. */
	writeCommitted(opts: WriteCommittedOptions): Promise<void>;
	/** Read a committed checkpoint's summary by ID. Returns null if not found. */
	readCommitted(checkpointId: string): Promise<CheckpointSummary | null>;
	/** Read a specific session's full content (transcript + metadata) by index. */
	readSessionContent(checkpointId: string, sessionIndex: number): Promise<SessionContent | null>;
	/** Read a specific session's full content by session ID. */
	readSessionContentById(checkpointId: string, sessionId: string): Promise<SessionContent | null>;
	/** List all committed checkpoints on the metadata branch. */
	listCommitted(): Promise<CommittedInfo[]>;
	/** Update an existing committed checkpoint's transcript (e.g. after redaction). */
	updateCommitted(opts: UpdateCommittedOptions): Promise<void>;
}

/** WriteTemporary cluster */

/** Result of a `writeTemporary` call. */
export interface WriteTemporaryResult {
	/** Git commit hash of the newly created checkpoint commit. */
	commitHash: string;
	/** True when the tree hash matches the previous checkpoint — no new commit was created. */
	skipped: boolean;
}

/** Inputs to `writeTemporary`. Mirrors Go's `WriteTemporaryOptions` struct. */
export interface WriteTemporaryOptions {
	/** Session that owns this checkpoint. */
	sessionId: string;
	/** The user commit that this shadow branch is based on. */
	baseCommit: string;
	/** Git worktree identifier (determines shadow branch name). */
	worktreeId: string;
	/** Files modified since the last checkpoint. */
	modifiedFiles: string[];
	/** Newly created files since the last checkpoint. */
	newFiles: string[];
	/** Files deleted since the last checkpoint. */
	deletedFiles: string[];
	/** Relative path to the metadata directory within the tree. */
	metadataDir: string;
	/** Absolute path to the metadata directory on disk. */
	metadataDirAbs: string;
	/** Commit message for the checkpoint commit. */
	commitMessage: string;
	/** Git author name for the checkpoint commit. */
	authorName: string;
	/** Git author email for the checkpoint commit. */
	authorEmail: string;
	/** True for the first checkpoint — captures all tracked files, not just changes. */
	isFirstCheckpoint: boolean;
}

/** Result of a `readTemporary` call. */
export interface ReadTemporaryResult {
	/** Git commit hash of the latest checkpoint on the shadow branch. */
	commitHash: string;
	/** Git tree hash — used for deduplication on the next write. */
	treeHash: string;
	/** Session that owns this checkpoint. */
	sessionId: string;
	/** Relative path to the metadata directory within the tree. */
	metadataDir: string;
	/** ISO 8601 timestamp of the checkpoint commit. */
	timestamp: string;
}

/** Listing entry for a shadow branch. */
export interface TemporaryInfo {
	/** Full shadow branch ref name. */
	branchName: string;
	/** The user commit this shadow branch is based on. */
	baseCommit: string;
	/** Most recent commit on the shadow branch. */
	latestCommit: string;
	/** Session that owns this shadow branch. */
	sessionId: string;
	/** ISO 8601 timestamp of the latest checkpoint. */
	timestamp: string;
}

/** WriteCommitted cluster */

/** Inputs to `writeCommitted`. Mirrors Go's `WriteCommittedOptions` struct. */
export interface WriteCommittedOptions {
	/** Unique identifier for this committed checkpoint. */
	checkpointId: string;
	/** Session that produced this checkpoint. */
	sessionId: string;
	/** Strategy name that created this checkpoint (e.g. "push_sessions"). */
	strategy: string;
	/** Git branch the user was working on when the checkpoint was created. */
	branch: string;
	/** Redacted transcript bytes (PII-scrubbed). */
	transcript: Uint8Array;
	/** User prompts collected during this session. */
	prompts: string[];
	/** Files modified, created, or deleted during this session. */
	filesTouched: string[];
	/** Total number of temporary checkpoints condensed into this committed one. */
	checkpointsCount: number;
	/** Shadow branch ref to clean up after committing. */
	ephemeralBranch: string;
	/** Git author name for the committed checkpoint. */
	authorName: string;
	/** Git author email for the committed checkpoint. */
	authorEmail: string;
	/** Directory containing extra metadata files to include in the tree. */
	metadataDir: string;

	/** Whether this checkpoint represents a subagent task invocation. */
	isTask: boolean;
	/** Tool use ID from the parent agent that spawned the task. */
	toolUseId: string;
	/** Agent instance ID for task checkpoints. */
	agentId: string;
	/** UUID for correlating task checkpoint data. */
	checkpointUuid: string;
	/** Path to the task's transcript file on disk. */
	transcriptPath: string;
	/** Path to the subagent's transcript file on disk. */
	subagentTranscriptPath: string;

	/** Whether this is an incremental (partial) checkpoint update. */
	isIncremental: boolean;
	/** Sequence number for ordering incremental checkpoints. */
	incrementalSequence: number;
	/** Type of incremental data (e.g. "transcript", "metadata"). */
	incrementalType: string;
	/** Raw incremental data payload. */
	incrementalData: Uint8Array;

	/** One-line summary used as the git commit subject. */
	commitSubject: string;
	/** Agent display name, e.g. "Claude Code". */
	agent: string;
	/** LLM model identifier, e.g. "claude-sonnet-4-...". */
	model: string;
	/** Turn ID that produced this checkpoint. */
	turnId: string;

	/** Transcript identifier at the start of the checkpoint cycle. */
	transcriptIdentifierAtStart: string;
	/** Transcript line offset at the start of the checkpoint cycle. */
	checkpointTranscriptStart: number;
	/** Compact transcript line offset. */
	compactTranscriptStart: number;

	/** Cumulative token usage for the session, if available. */
	tokenUsage: TokenUsage | null;
	/**
	 * Session-level metrics (wall-clock duration, active turn duration, turns,
	 * context), if available.
	 */
	sessionMetrics: SessionMetrics | null;
	/** Line-level attribution data computed at session start, if available. */
	initialAttribution: InitialAttribution | null;
	/** Raw JSON of per-prompt attributions, preserved for diagnostics. */
	promptAttributionsJson: unknown;
	/** AI-generated session summary, if available. */
	summary: Summary | null;
	/** Compact transcript in v2 format, if available. */
	compactTranscript: Uint8Array | null;
}

/** Inputs to `updateCommitted`. */
export interface UpdateCommittedOptions {
	/** Checkpoint to update. */
	checkpointId: string;
	/** Session whose content is being updated. */
	sessionId: string;
	/** Updated (re-redacted) transcript bytes. */
	transcript: Uint8Array;
	/** Updated list of user prompts. */
	prompts: string[];
	/** Agent display name. */
	agent: string;
	/** Updated compact transcript in v2 format, if available. */
	compactTranscript: Uint8Array | null;
}

/** Listing entry for a committed checkpoint. */
export interface CommittedInfo {
	/** Unique identifier for this committed checkpoint. */
	checkpointId: string;
	/**
	 * Latest session ID — the one stored at the highest session index inside
	 * the checkpoint subtree. Mirrors Go `ListCommitted`, which surfaces the
	 * most recently appended session as the listing's representative.
	 */
	sessionId: string;
	/** ISO 8601 creation timestamp. */
	createdAt: string;
	/** Number of temporary checkpoints condensed into this one. */
	checkpointsCount: number;
	/** Files modified, created, or deleted across all condensed sessions. */
	filesTouched: string[];
	/** Agent display name from the latest session in this checkpoint. */
	agent: string;
	/** Whether this checkpoint is from a subagent task. */
	isTask: boolean;
	/** Tool use ID if this is a task checkpoint. */
	toolUseId: string;
	/** Number of distinct sessions condensed into this checkpoint. */
	sessionCount: number;
	/** All session IDs condensed into this checkpoint, in index order. */
	sessionIds: string[];
}

/** Full content (metadata + transcript + prompts) of a single session inside a committed checkpoint. */
export interface SessionContent {
	/** Structured metadata for this session's checkpoint. */
	metadata: CommittedMetadata;
	/** Raw transcript bytes (redacted). */
	transcript: Uint8Array;
	/** Concatenated user prompts as a single string. */
	prompts: string;
}

/** Metadata records (stored on the metadata branch) */

/** Per-session metadata stored alongside the redacted transcript on the metadata branch. */
export interface CommittedMetadata {
	/** CLI version that created this checkpoint. */
	cliVersion?: string;
	/** Unique checkpoint identifier. */
	checkpointId: string;
	/** Session that produced this checkpoint. */
	sessionId: string;
	/** Strategy name (e.g. "push_sessions"). */
	strategy: string;
	/** ISO 8601 creation timestamp. */
	createdAt: string;
	/** Git branch the user was working on. */
	branch?: string;
	/** Number of temporary checkpoints condensed. */
	checkpointsCount: number;
	/** Files modified during the session. */
	filesTouched: string[];
	/** Agent display name. */
	agent?: string;
	/** LLM model name. Always written; empty string means unknown. */
	model: string;
	/** Turn ID that produced this checkpoint. */
	turnId?: string;
	/** Whether this is a subagent task checkpoint. */
	isTask?: boolean;
	/** Tool use ID for task checkpoints. */
	toolUseId?: string;
	/** Transcript identifier at the start of the checkpoint cycle. */
	transcriptIdentifierAtStart?: string;
	/** Transcript line offset at the start of the checkpoint cycle. */
	checkpointTranscriptStart?: number;
	/** @deprecated Legacy field, kept for backward compatibility. Use checkpointTranscriptStart. */
	transcriptLinesAtStart?: number;
	/** Cumulative token usage for the session. */
	tokenUsage?: TokenUsage;
	/** Session-level metrics (wall-clock duration, active turn duration, turns, context). */
	sessionMetrics?: SessionMetrics;
	/** AI-generated session summary. */
	summary?: Summary;
	/** Line-level attribution data computed at session start. */
	initialAttribution?: InitialAttribution;
	/** Raw JSON of per-prompt attributions, preserved for diagnostics. */
	promptAttributions?: unknown;
}

/** Per-session file paths within a committed checkpoint tree. */
export interface SessionFilePaths {
	/** Relative path to the metadata JSON file within the checkpoint tree. */
	metadata: string;
	/** Relative path to the transcript file within the checkpoint tree. */
	transcript?: string;
	/** Hash of the transcript content, used for deduplication. */
	contentHash?: string;
	/** Relative path to the prompts file within the checkpoint tree. */
	prompt: string;
}

/** Top-level summary of a committed checkpoint, aggregating across all sessions. */
export interface CheckpointSummary {
	/** CLI version that created this checkpoint. */
	cliVersion?: string;
	/** Unique checkpoint identifier. */
	checkpointId: string;
	/** Strategy name. */
	strategy: string;
	/** Git branch the user was working on. */
	branch?: string;
	/** Number of temporary checkpoints condensed. */
	checkpointsCount: number;
	/** Files modified across all sessions. */
	filesTouched: string[];
	/** Per-session file paths within the checkpoint tree. */
	sessions: SessionFilePaths[];
	/** Aggregated token usage across all sessions. */
	tokenUsage?: TokenUsage;
	/** Combined attribution data across all sessions in this checkpoint. */
	combinedAttribution?: InitialAttribution;
}

/**
 * Per-turn timing captured by Story's normalized lifecycle.
 *
 * Story-led divergence: Go Entire CLI does not persist per-turn metrics. Story
 * stores them so checkpoint viewers can show response duration even when an
 * agent transcript has no per-message timestamps.
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
 * Session-level timing and context metrics.
 *
 * `durationMs` is wall-clock session span. `activeDurationMs` is the sum of
 * turn durations and represents pure agent response time.
 */
export interface SessionMetrics {
	/** Session wall-clock duration in milliseconds. */
	durationMs?: number;
	/** Sum of all known turn durations in milliseconds. */
	activeDurationMs?: number;
	/** Per-turn timing snapshots captured from Story's TurnStart → TurnEnd lifecycle. */
	turnMetrics?: TurnMetric[];
	/** Total number of agent turns in the session. */
	turnCount?: number;
	/** Number of context tokens reported by the agent. */
	contextTokens?: number;
	/** Maximum context window size reported by the agent. */
	contextWindowSize?: number;
}

/** AI-generated session summary written to the committed checkpoint metadata. */
export interface Summary {
	/** What the user asked the agent to do. */
	intent: string;
	/** What the agent actually accomplished. */
	outcome: string;
	/** Structured learnings extracted from the session. */
	learnings: {
		/** Repository-level insights (architecture, conventions). */
		repo: string[];
		/** Code-level findings tied to specific file locations. */
		code: Array<{
			path: string;
			line?: number;
			endLine?: number;
			finding: string;
		}>;
		/** Workflow and process observations. */
		workflow: string[];
	};
	/** Points of friction encountered during the session. */
	friction: string[];
	/** Unresolved items or follow-up tasks. */
	openItems: string[];
}

/** Line-level attribution snapshot computed at the start of a session. */
export interface InitialAttribution {
	/** ISO 8601 timestamp when attribution was calculated. */
	calculatedAt: string;
	/** Lines of code added by the agent. */
	agentLines: number;
	/** Lines of code removed by the agent. */
	agentRemoved: number;
	/** Lines of code added by the human. */
	humanAdded: number;
	/** Lines of code modified by the human. */
	humanModified: number;
	/** Lines of code removed by the human. */
	humanRemoved: number;
	/** Total lines committed in the final result. */
	totalCommitted: number;
	/** Total lines changed (added + removed) across all contributors. */
	totalLinesChanged: number;
	/** Percentage of changes attributed to the agent (0-100). */
	agentPercentage: number;
	/** Metric algorithm version: 0 = legacy, 2 = changed-lines. */
	metricVersion?: number;
}

/** Slim view of a checkpoint suitable for listings and CLI output. */
export interface CheckpointInfo {
	/** Unique checkpoint identifier. */
	id: string;
	/** Session that produced this checkpoint. */
	sessionId: string;
	/** Whether temporary or committed. */
	type: CheckpointType;
	/** ISO 8601 creation timestamp. */
	createdAt: string;
	/** Human-readable commit message. */
	message: string;
}

/** Task checkpoint cluster (subagent / Task tool invocations) */

/** Inputs to writing a temporary checkpoint produced by a subagent task. */
export interface WriteTemporaryTaskOptions {
	/** Session that owns this task checkpoint. */
	sessionId: string;
	/** The user commit this shadow branch is based on. */
	baseCommit: string;
	/** Git worktree identifier. */
	worktreeId: string;
	/** Tool use ID from the parent agent. */
	toolUseId: string;
	/** Agent instance ID for the subagent task. */
	agentId: string;
	/** Files modified since the last checkpoint. */
	modifiedFiles: string[];
	/** Newly created files. */
	newFiles: string[];
	/** Deleted files. */
	deletedFiles: string[];
	/** Path to the task's transcript file. */
	transcriptPath: string;
	/** Path to the subagent's transcript file. */
	subagentTranscriptPath: string;
	/** UUID for correlating task checkpoint data. */
	checkpointUuid: string;
	/** Commit message for the checkpoint. */
	commitMessage: string;
	/** Git author name. */
	authorName: string;
	/** Git author email. */
	authorEmail: string;
	/** Whether this is an incremental (partial) update. */
	isIncremental: boolean;
	/** Sequence number for ordering incremental checkpoints. */
	incrementalSequence: number;
	/** Type of incremental data. */
	incrementalType: string;
	/** Raw incremental data payload. */
	incrementalData: Uint8Array;
}

/** Listing entry for a single temporary checkpoint commit on a shadow branch. */
export interface TemporaryCheckpointInfo {
	/** Git commit hash of this temporary checkpoint. */
	commitHash: string;
	/** Commit message describing the checkpoint. */
	message: string;
	/** Session that owns this checkpoint. */
	sessionId: string;
	/** Relative path to the metadata directory within the tree. */
	metadataDir: string;
	/** Whether this checkpoint is from a subagent task. */
	isTaskCheckpoint: boolean;
	/** Tool use ID if this is a task checkpoint. */
	toolUseId: string;
	/** ISO 8601 timestamp of the checkpoint. */
	timestamp: string;
}

/** CommittedReader — narrow interface shared by v1 (GitStore) and v2 stores */

/**
 * Author of a checkpoint commit (git author triple, no email validation).
 *
 * Returned by `GitStore.getCheckpointAuthor` and the v2 equivalent. Empty
 * `name`/`email` means the checkpoint was not found.
 */
export interface CheckpointAuthor {
	name: string;
	email: string;
}

/**
 * The slim read-side surface that both the v1 `GitStore` and the (Phase 4.4)
 * `V2GitStore` implement. Used by `resolveCommittedReader` (in
 * [`committed-reader-resolve.ts`](./committed-reader-resolve.ts)) so
 * downstream callers can hold one reference and let the resolver pick which
 * store actually fielded the request.
 */
export interface CommittedReader {
	readCommitted(checkpointId: string): Promise<CheckpointSummary | null>;
	readSessionContent(checkpointId: string, sessionIndex: number): Promise<SessionContent | null>;
	readSessionContentById(checkpointId: string, sessionId: string): Promise<SessionContent | null>;
	getTranscript(checkpointId: string): Promise<Uint8Array | null>;
	getSessionLog(
		checkpointId: string,
	): Promise<{ transcript: Uint8Array; sessionId: string } | null>;
}

/** GitStore — concrete CheckpointStore implementation backed by isomorphic-git */

/**
 * The production {@link CheckpointStore} backed by a real git repository.
 *
 * Phase 4.1 fixed the constructor surface and method signatures. Phase 4.2
 * wires `writeTemporary` / `readTemporary` / `listTemporary` to delegate to
 * the matching standalone functions in [`temporary.ts`](./temporary.ts) so
 * downstream consumers can hold a `CheckpointStore` reference (they don't have
 * to import the standalone functions directly).
 *
 * Phase 4.3 wires the `*Committed` methods to standalone implementations in
 * [`committed.ts`](./committed.ts) and adds the read-side
 * {@link CommittedReader} surface (`getTranscript` / `getSessionLog`) plus a
 * {@link setBlobFetcher} hook for the (Phase 4.4) treeless-fetch flow.
 */
export class GitStore implements CheckpointStore, CommittedReader {
	/** Absolute path to the git repository root. */
	readonly repoDir: string;

	/**
	 * Optional callback used by `FetchingTree` to pull missing blobs from a
	 * remote. Phase 4.4 wires this through every `read*` helper so a single
	 * `GitStore` instance can carry the fetcher across reads — the read
	 * functions take an optional `fetcher` parameter and the wrapper passes
	 * `this.blobFetcher` straight through.
	 */
	private blobFetcher?: BlobFetchFunc;

	constructor(repoDir: string) {
		this.repoDir = repoDir;
	}

	/** Inject (or replace) the blob fetcher used by treeless-fetch reads. */
	setBlobFetcher(fetcher: BlobFetchFunc | undefined): void {
		this.blobFetcher = fetcher;
	}

	/** @internal Accessor for Phase 4.4 read-path wiring. */
	getBlobFetcher(): BlobFetchFunc | undefined {
		return this.blobFetcher;
	}

	writeTemporary(opts: WriteTemporaryOptions): Promise<WriteTemporaryResult> {
		return writeTemporaryImpl(this.repoDir, opts);
	}

	/**
	 * Write a subagent task checkpoint. Mirrors Go `GitStore.WriteTemporaryTask`
	 * (`manual_commit_git.go:212-251`).
	 *
	 * Phase 5.2 SaveTaskStep delegates to this method instead of calling the
	 * standalone `writeTemporaryTask(repoDir, ...)` directly so the task-write
	 * path threads through the same `GitStore` instance as the rest of the
	 * checkpoint API. Audit-3 Fix F wired this in to remove a "go through the
	 * store but discard the result" anti-pattern at the SaveTaskStep call site.
	 */
	writeTemporaryTask(opts: WriteTemporaryTaskOptions): Promise<string> {
		return writeTemporaryTaskImpl(this.repoDir, opts);
	}

	readTemporary(baseCommit: string, worktreeId: string): Promise<ReadTemporaryResult | null> {
		return readTemporaryImpl(this.repoDir, baseCommit, worktreeId);
	}

	listTemporary(): Promise<TemporaryInfo[]> {
		return listTemporaryImpl(this.repoDir);
	}

	writeCommitted(opts: WriteCommittedOptions): Promise<void> {
		return writeCommittedImpl(this.repoDir, opts);
	}

	readCommitted(checkpointId: string): Promise<CheckpointSummary | null> {
		return readCommittedImpl(this.repoDir, checkpointId, this.blobFetcher);
	}

	readSessionContent(checkpointId: string, sessionIndex: number): Promise<SessionContent | null> {
		return readSessionContentImpl(this.repoDir, checkpointId, sessionIndex, this.blobFetcher);
	}

	readSessionContentById(checkpointId: string, sessionId: string): Promise<SessionContent | null> {
		return readSessionContentByIdImpl(this.repoDir, checkpointId, sessionId, this.blobFetcher);
	}

	readLatestSessionContent(checkpointId: string): Promise<SessionContent | null> {
		return readLatestSessionContentImpl(this.repoDir, checkpointId, this.blobFetcher);
	}

	readSessionMetadata(
		checkpointId: string,
		sessionIndex: number,
	): Promise<CommittedMetadata | null> {
		return readSessionMetadataImpl(this.repoDir, checkpointId, sessionIndex, this.blobFetcher);
	}

	listCommitted(): Promise<CommittedInfo[]> {
		return listCommittedImpl(this.repoDir, this.blobFetcher);
	}

	updateCommitted(opts: UpdateCommittedOptions): Promise<void> {
		return updateCommittedImpl(this.repoDir, opts);
	}

	updateSummary(checkpointId: string, summary: Summary | null): Promise<void> {
		return updateSummaryImpl(this.repoDir, checkpointId, summary);
	}

	updateCheckpointSummary(
		checkpointId: string,
		combinedAttribution: InitialAttribution | null,
	): Promise<void> {
		return updateCheckpointSummaryImpl(this.repoDir, checkpointId, combinedAttribution);
	}

	getTranscript(checkpointId: string): Promise<Uint8Array | null> {
		return getTranscriptImpl(this.repoDir, checkpointId, this.blobFetcher);
	}

	getSessionLog(
		checkpointId: string,
	): Promise<{ transcript: Uint8Array; sessionId: string } | null> {
		return getSessionLogImpl(this.repoDir, checkpointId, this.blobFetcher);
	}

	getCheckpointAuthor(checkpointId: string): Promise<CheckpointAuthor> {
		return getCheckpointAuthorImpl(this.repoDir, checkpointId);
	}
}
