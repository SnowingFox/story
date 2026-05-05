/**
 * Phase 5.2 SaveStep / SaveTaskStep — manual-commit's "write side" main path.
 *
 * Two standalone async functions, each taking the strategy instance as the
 * first argument (Go receiver equivalent under the thin-facade pattern set
 * by Phase 5.1 `findSessionsForCommit`). The `ManualCommitStrategy` class
 * methods (Phase 5.2 Todo 6) delegate here in one line:
 *
 *   async saveStep(step) { return saveStepImpl(this, step); }
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/strategy/manual_commit_git.go`
 * (`SaveStep` + `SaveTaskStep`).
 *
 * @packageDocumentation
 */

import path from 'node:path';
import { shadowBranchExists, shadowBranchNameForCommit } from '../checkpoint/temporary';
import type { GitStore } from '../checkpoint/types';
import { SHORT_ID_LENGTH } from '../id';
import * as log from '../log';
import { storyMetadataDirForSession } from '../paths';
import { formatShadowTaskCommit } from '../trailers';
import { resolveAgentType } from './common';
import { taskMetadataDir } from './constants';
import type { ManualCommitStrategy } from './manual-commit';
import { migrateAndPersistIfNeeded } from './manual-commit-migration';
import { formatIncrementalSubject, formatSubagentEndMessage } from './messages';
import type { Repository } from './repo';
import { accumulateTokenUsage, mergeFilesTouched } from './save-step-helpers';
import type { PromptAttribution, SessionState, StepContext, TaskStepContext } from './types';

/**
 * Save a checkpoint to the shadow branch. Triggered after each agent turn
 * (PostToolUse / Stop hook) by Phase 5.4 / Phase 6.x agents.
 *
 * 12-step main path: `openRepository` → `loadSessionState` (with empty-baseCommit
 * fallback) → `migrateAndPersistIfNeeded` → `getCheckpointStore` →
 * `shadowBranchExists` pre-check → consume `pendingPromptAttribution` →
 * `writeTemporary` → early-return on dedup hit → update state.{stepCount,
 * promptAttributions, transcriptIdentifierAtStart, tokenUsage, filesTouched} →
 * `saveSessionState` → log info.
 *
 * Mirrors Go `manual_commit_git.go` (`SaveStep`).
 *
 * @example
 * await saveStep(strategy, {
 *   sessionId: 'sess-1',
 *   modifiedFiles: ['src/app.ts'],
 *   newFiles: [],
 *   deletedFiles: [],
 *   metadataDir: '.story/metadata/sess-1',
 *   metadataDirAbs: '/abs/.story/metadata/sess-1',
 *   commitMessage: 'Checkpoint #2',
 *   transcriptPath: '/abs/.story/metadata/sess-1/transcript.jsonl',
 *   authorName: 'Story CLI',
 *   authorEmail: 'story@local',
 *   agentType: 'Claude Code',
 *   stepTranscriptIdentifier: 'msg-id-42',
 *   stepTranscriptStart: 0,
 *   tokenUsage: null,
 * });
 *
 * // Side effects:
 * //   .git/refs/heads/story/abc1234-e3b0c4 ← bumped to new commit
 * //   .git/objects/<hash>                  ← new commit + tree + blobs
 * //   .git/story-sessions/sess-1.json      ← stepCount++ / promptAttributions push /
 * //                                           filesTouched merged / tokenUsage accumulated
 * //
 * // On dedup hit (writeTemporary returns skipped: true):
 * //   - NO objects written, NO ref change
 * //   - state.stepCount NOT incremented, NO state save
 * //   - log.info "checkpoint skipped (no changes)"
 * //
 * // Worktree / index / HEAD: never touched.
 */
export async function saveStep(s: ManualCommitStrategy, step: StepContext): Promise<void> {
	let repo: Repository;
	try {
		repo = await s.getRepo();
	} catch (err) {
		// Go: manual_commit_git.go (SaveStep) — fmt.Errorf("failed to open git repository: %w", err)
		throw new Error(
			`failed to open git repository: ${err instanceof Error ? err.message : String(err)}`,
			{ cause: err as Error },
		);
	}
	const sessionId = path.basename(step.metadataDir);

	// Go: manual_commit_git.go (SaveStep) — saveStep ALSO wraps load errors with
	// `failed to load session state` (s.loadSessionState already wraps too,
	// so the error chain ends up double-wrapped — matches Go).
	// state-nil / empty-base triggers the init fallback below.
	let state: SessionState | null;
	try {
		state = await s.loadSessionState(sessionId);
	} catch (err) {
		throw new Error(
			`failed to load session state: ${err instanceof Error ? err.message : String(err)}`,
			{ cause: err as Error },
		);
	}
	if (state === null || state.baseCommit === '') {
		const agentType = resolveAgentType(step.agentType, state);
		// Phase 5.4 Part 1 wired the real initializeSession (see
		// src/strategy/hooks-initialize-session.ts) — partial-state recovery now
		// rebuilds SessionState from current HEAD + worktree info via
		// buildInitialSessionState.
		try {
			await s.initializeSession(sessionId, agentType, '', '', '');
		} catch (err) {
			// Go: manual_commit_git.go (SaveStep) — fmt.Errorf("failed to initialize session: %w", err)
			throw new Error(
				`failed to initialize session: ${err instanceof Error ? err.message : String(err)}`,
				{ cause: err as Error },
			);
		}
		state = await s.loadSessionState(sessionId);
		if (state === null || state.baseCommit === '') {
			throw new Error('failed to initialize session: state still empty after initializeSession');
		}
	}

	await migrateAndPersistIfNeeded(s, repo.root, state);

	let store: GitStore;
	try {
		store = await s.getCheckpointStore();
	} catch (err) {
		// Go: manual_commit_git.go (SaveStep) — fmt.Errorf("failed to get checkpoint store: %w", err)
		throw new Error(
			`failed to get checkpoint store: ${err instanceof Error ? err.message : String(err)}`,
			{ cause: err as Error },
		);
	}
	const worktreeId = state.worktreeId ?? '';
	const shadowBranchName = shadowBranchNameForCommit(state.baseCommit, worktreeId);
	const branchExisted = await shadowBranchExists(repo.root, state.baseCommit, worktreeId);

	let promptAttr: PromptAttribution;
	if (state.pendingPromptAttribution != null) {
		promptAttr = state.pendingPromptAttribution;
		state.pendingPromptAttribution = null;
	} else {
		promptAttr = {
			checkpointNumber: state.stepCount + 1,
			userLinesAdded: 0,
			userLinesRemoved: 0,
			agentLinesAdded: 0,
			agentLinesRemoved: 0,
		};
	}

	log.debug({ component: 'attribution', sessionId }, 'prompt attribution at checkpoint save', {
		checkpoint_number: promptAttr.checkpointNumber,
		user_added: promptAttr.userLinesAdded,
		user_removed: promptAttr.userLinesRemoved,
		agent_added: promptAttr.agentLinesAdded,
		agent_removed: promptAttr.agentLinesRemoved,
	});

	const isFirstCheckpointOfSession = state.stepCount === 0;
	let result: { commitHash: string; skipped: boolean };
	try {
		result = await store.writeTemporary({
			sessionId,
			baseCommit: state.baseCommit,
			worktreeId,
			modifiedFiles: step.modifiedFiles,
			newFiles: step.newFiles,
			deletedFiles: step.deletedFiles,
			metadataDir: step.metadataDir,
			metadataDirAbs: step.metadataDirAbs,
			commitMessage: step.commitMessage,
			authorName: step.authorName,
			authorEmail: step.authorEmail,
			isFirstCheckpoint: isFirstCheckpointOfSession,
		});
	} catch (err) {
		throw new Error(
			`failed to write temporary checkpoint: ${err instanceof Error ? err.message : String(err)}`,
			{ cause: err as Error },
		);
	}

	if (result.skipped) {
		log.info({ component: 'checkpoint', sessionId }, 'checkpoint skipped (no changes)', {
			strategy: 'manual-commit',
			checkpoint_type: 'session',
			checkpoint_count: state.stepCount,
			shadow_branch: shadowBranchName,
		});
		return;
	}

	state.stepCount++;
	// NOTE: lastCheckpointId is intentionally NOT cleared here — Phase 5.3 sets
	// it during condense, Phase 5.4 amend uses it.
	state.promptAttributions = [...(state.promptAttributions ?? []), promptAttr];
	state.filesTouched = mergeFilesTouched(
		state.filesTouched ?? [],
		step.modifiedFiles,
		step.newFiles,
		step.deletedFiles,
	);
	if (state.stepCount === 1) {
		state.transcriptIdentifierAtStart = step.stepTranscriptIdentifier;
	}
	if (step.tokenUsage != null) {
		state.tokenUsage = accumulateTokenUsage(state.tokenUsage ?? null, step.tokenUsage);
	}

	try {
		await s.saveSessionState(state);
	} catch (err) {
		throw new Error(
			`failed to save session state: ${err instanceof Error ? err.message : String(err)}`,
			{ cause: err as Error },
		);
	}

	const cpCtx = { component: 'checkpoint', sessionId };
	if (!branchExisted) {
		log.info(cpCtx, 'created shadow branch and committed changes', {
			shadow_branch: shadowBranchName,
		});
	} else {
		log.info(cpCtx, 'committed changes to shadow branch', {
			shadow_branch: shadowBranchName,
		});
	}
	log.info(cpCtx, 'checkpoint saved', {
		strategy: 'manual-commit',
		checkpoint_type: 'session',
		checkpoint_count: state.stepCount,
		modified_files: step.modifiedFiles.length,
		new_files: step.newFiles.length,
		deleted_files: step.deletedFiles.length,
		shadow_branch: shadowBranchName,
		branch_created: !branchExisted,
	});
}

/**
 * Save a subagent (Task) step checkpoint to the shadow branch. Triggered by
 * Phase 5.4 / Phase 6.x agents at subagent end / incremental progress points
 * (Claude Code Task tool, Codex `task_step`, etc.).
 *
 * Main path (mirrors {@link saveStep} but with task-specific divergences):
 * `openRepository` → `loadSessionState` (with init fallback; **load errors
 * silently fall back to init path**, unlike `saveStep` which propagates) →
 * `migrateAndPersistIfNeeded` → `getCheckpointStore` → resolve task metadata
 * dir + short tool-use id → build subject (`formatIncrementalSubject` for
 * incremental, `formatSubagentEndMessage` for terminal) → wrap with
 * `formatShadowTaskCommit` (3 trailers: `Story-Metadata-Task` /
 * `Story-Session` / `Story-Strategy: manual-commit`) → `writeTemporaryTask`
 * → merge `filesTouched` → `saveSessionState` → log info.
 *
 * Key differences vs {@link saveStep}:
 * - Subject built via `formatIncrementalSubject` / `formatSubagentEndMessage`,
 *   wrapped by `formatShadowTaskCommit` (3 trailers vs `formatShadowCommit`'s
 *   2 trailers — task adds `Story-Metadata-Task`).
 * - Calls `store.writeTemporaryTask(...)` (not `writeTemporary`); the writer
 *   itself dedupes too but never returns `skipped: true` to the caller —
 *   task commits always land if there is content to write.
 * - **Does NOT update** `stepCount` / `promptAttributions` /
 *   `transcriptIdentifierAtStart` / `tokenUsage`. Task steps are subagent
 *   work, not main-session steps; counting them would double-count the user
 *   prompt that spawned the subagent.
 * - **Does NOT consume** `state.pendingPromptAttribution` (only `saveStep`
 *   drains the pending slot — the parent turn's `saveStep` will still see
 *   it).
 * - Only merges `filesTouched` and saves state (so condense-time
 *   attribution still sees the touched paths).
 * - Load-error tolerance: a failing `loadSessionState` is treated as
 *   `state === null` and falls through to init, whereas `saveStep`
 *   propagates the load error.
 *
 * Mirrors Go `manual_commit_git.go` (`SaveTaskStep`).
 *
 * @example
 * await saveTaskStep(strategy, {
 *   sessionId: 'sess-1',
 *   toolUseId: 'tool-456789abcdef',
 *   agentId: 'agent-789',
 *   modifiedFiles: ['src/utils.ts'],
 *   newFiles: ['src/new-helper.ts'],
 *   deletedFiles: [],
 *   transcriptPath: '/abs/.story/metadata/sess-1/transcript.jsonl',
 *   subagentTranscriptPath: '/abs/.story/metadata/sess-1/tasks/tool-456/transcript.jsonl',
 *   checkpointUuid: 'cp-uuid-1',
 *   authorName: 'Story CLI',
 *   authorEmail: 'story@local',
 *   agentType: 'Claude Code',
 *   subagentType: 'general-purpose',
 *   taskDescription: 'Refactor helper module',
 *   todoContent: '',
 *   isIncremental: false,        // terminal subagent end
 *   incrementalSequence: 0,
 *   incrementalType: '',
 *   incrementalData: new Uint8Array(),
 * });
 *
 * // Side effects:
 * //   .git/refs/heads/story/abc1234-e3b0c4 ← bumped to new TASK commit
 * //                                          (subject from formatSubagentEndMessage,
 * //                                           wrapped by formatShadowTaskCommit
 * //                                           with Story-Metadata-Task trailer)
 * //   .git/objects/<hash>                  ← new commit + tree + blobs
 * //                                          (under .story/metadata/<sess>/tasks/<tool>/...)
 * //   .git/story-sessions/sess-1.json      ← filesTouched merged ONLY
 * //
 * // Explicitly NOT updated on session state:
 * //   - stepCount             (task steps don't count as main session steps)
 * //   - promptAttributions    (no attribution consumed for task work)
 * //   - pendingPromptAttribution (left for the next saveStep to consume)
 * //   - transcriptIdentifierAtStart
 * //   - tokenUsage            (subagent token usage flows back via the parent step)
 * //
 * // Worktree / index / HEAD: never touched.
 */
export async function saveTaskStep(s: ManualCommitStrategy, step: TaskStepContext): Promise<void> {
	let repo: Repository;
	try {
		repo = await s.getRepo();
	} catch (err) {
		// Go: manual_commit_git.go (SaveTaskStep) — fmt.Errorf("failed to open git repository: %w", err)
		throw new Error(
			`failed to open git repository: ${err instanceof Error ? err.message : String(err)}`,
			{ cause: err as Error },
		);
	}
	const sessionId = step.sessionId;

	// Go: manual_commit_git.go (SaveTaskStep) — saveTaskStep treats `loadSessionState`
	// errors the SAME as null state (different from saveStep, which propagates).
	// Any of: load failed / state == nil / state.BaseCommit == "" → init path.
	let state: SessionState | null = null;
	try {
		state = await s.loadSessionState(sessionId);
	} catch {
		state = null;
	}
	if (state === null || state.baseCommit === '') {
		const agentType = resolveAgentType(step.agentType, state);
		// Phase 5.4 Part 1 wired the real initializeSession (see
		// src/strategy/hooks-initialize-session.ts) — same as saveStep.
		try {
			await s.initializeSession(sessionId, agentType, '', '', '');
		} catch (err) {
			// Go: manual_commit_git.go (SaveTaskStep) — fmt.Errorf("failed to initialize session for task checkpoint: %w", err)
			throw new Error(
				`failed to initialize session for task checkpoint: ${err instanceof Error ? err.message : String(err)}`,
				{ cause: err as Error },
			);
		}
		state = await s.loadSessionState(sessionId);
		if (state === null || state.baseCommit === '') {
			throw new Error(
				'failed to initialize session for task checkpoint: state still empty after initializeSession',
			);
		}
	}

	await migrateAndPersistIfNeeded(s, repo.root, state);

	// Audit-3 Fix F (2026-04-18): GitStore now exposes writeTemporaryTask
	// as a real method (not just writeTemporary). We retrieve the store and
	// route the task write through `store.writeTemporaryTask(...)` to mirror
	// Go's `manual_commit_git.go` (SaveTaskStep) 1:1. Pre-fix TS called
	// `s.getCheckpointStore()` only for its error-propagation side effect and
	// then bypassed the store via the standalone `writeTemporaryTask(repoDir,
	// ...)`; that worked but was subtle and skipped any future blob-fetcher
	// wiring at the task-write path.
	let store: GitStore;
	try {
		store = await s.getCheckpointStore();
	} catch (err) {
		// Go: manual_commit_git.go (SaveTaskStep) — fmt.Errorf("failed to get checkpoint store: %w", err)
		throw new Error(
			`failed to get checkpoint store: ${err instanceof Error ? err.message : String(err)}`,
			{ cause: err as Error },
		);
	}
	const worktreeId = state.worktreeId ?? '';
	const shadowBranchName = shadowBranchNameForCommit(state.baseCommit, worktreeId);
	const branchExisted = await shadowBranchExists(repo.root, state.baseCommit, worktreeId);

	const sessionMetadataDir = storyMetadataDirForSession(step.sessionId);
	const taskDir = taskMetadataDir(sessionMetadataDir, step.toolUseId);

	const shortToolUseId =
		step.toolUseId.length > SHORT_ID_LENGTH
			? step.toolUseId.slice(0, SHORT_ID_LENGTH)
			: step.toolUseId;

	const messageSubject = step.isIncremental
		? formatIncrementalSubject(
				step.incrementalType,
				step.subagentType,
				step.taskDescription,
				step.todoContent,
				step.incrementalSequence,
				shortToolUseId,
			)
		: formatSubagentEndMessage(step.subagentType, step.taskDescription, shortToolUseId);

	const commitMsg = formatShadowTaskCommit(messageSubject, taskDir, step.sessionId);

	try {
		await store.writeTemporaryTask({
			sessionId: step.sessionId,
			baseCommit: state.baseCommit,
			worktreeId,
			toolUseId: step.toolUseId,
			agentId: step.agentId,
			modifiedFiles: step.modifiedFiles,
			newFiles: step.newFiles,
			deletedFiles: step.deletedFiles,
			transcriptPath: step.transcriptPath,
			subagentTranscriptPath: step.subagentTranscriptPath,
			checkpointUuid: step.checkpointUuid,
			commitMessage: commitMsg,
			authorName: step.authorName,
			authorEmail: step.authorEmail,
			isIncremental: step.isIncremental,
			incrementalSequence: step.incrementalSequence,
			incrementalType: step.incrementalType,
			// Caller responsibility: pass a Uint8Array (Go []byte equivalent).
			incrementalData: (step.incrementalData ?? new Uint8Array()) as Uint8Array,
		});
	} catch (err) {
		throw new Error(
			`failed to write task checkpoint: ${err instanceof Error ? err.message : String(err)}`,
			{ cause: err as Error },
		);
	}

	state.filesTouched = mergeFilesTouched(
		state.filesTouched ?? [],
		step.modifiedFiles,
		step.newFiles,
		step.deletedFiles,
	);

	try {
		await s.saveSessionState(state);
	} catch (err) {
		throw new Error(
			`failed to save session state: ${err instanceof Error ? err.message : String(err)}`,
			{ cause: err as Error },
		);
	}

	const cpCtx = { component: 'checkpoint', sessionId };
	if (!branchExisted) {
		log.info(cpCtx, 'created shadow branch and committed task checkpoint', {
			shadow_branch: shadowBranchName,
		});
	} else {
		log.info(cpCtx, 'committed task checkpoint to shadow branch', {
			shadow_branch: shadowBranchName,
		});
	}

	const attrs: Record<string, unknown> = {
		strategy: 'manual-commit',
		checkpoint_type: 'task',
		checkpoint_uuid: step.checkpointUuid,
		tool_use_id: step.toolUseId,
		subagent_type: step.subagentType,
		modified_files: step.modifiedFiles.length,
		new_files: step.newFiles.length,
		deleted_files: step.deletedFiles.length,
		shadow_branch: shadowBranchName,
		branch_created: !branchExisted,
	};
	if (step.isIncremental) {
		attrs.is_incremental = true;
		attrs.incremental_type = step.incrementalType;
		attrs.incremental_sequence = step.incrementalSequence;
	}
	log.info(cpCtx, 'task checkpoint saved', attrs);
}
