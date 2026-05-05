/**
 * Unified re-exports for the lifecycle sub-package — Phase 7 (Part 1 +
 * Part 2) complete surface.
 *
 * Mirrors Go `cmd/entire/cli/` top-level exports for the lifecycle /
 * state-helper layer that sits between agent hooks and
 * `strategy.ManualCommitStrategy`.
 *
 * Surface:
 *
 * - `dispatch.ts` — {@link dispatchLifecycleEvent} + constants + shared
 *   helpers (`resolveTranscriptOffset`, `parseTranscriptForCheckpointUUID`,
 *   `logFileChanges`, `persistEventMetadataToState`, `UNKNOWN_SESSION_ID`).
 * - `transition.ts` — {@link transitionSessionTurnEnd}.
 * - `hook-registry.ts` — `executeAgentHook`, `getCurrentHookAgent`,
 *   `getCurrentHookName`, `getHookType`, `HookRegistrar` (Phase 8 extension point).
 * - 8 lifecycle handlers: `session-start`, `model-update`, `compaction`,
 *   `session-end`, `turn-start`, `turn-end`, `subagent-start`, `subagent-end`.
 * - CLI-level helpers: pre-prompt / pre-task state snapshots, file-changes
 *   detection, commit-message generation, checkpoint sequence, subagent-
 *   input parsing, agent-transcript path, Story tmp directory.
 *
 * @packageDocumentation
 */

export { agentTranscriptPath } from './agent-transcript-path';
export { getNextCheckpointSequence } from './checkpoint-sequence';
export { cleanPromptForCommit, generateCommitMessage } from './commit-message';
export {
	dispatchLifecycleEvent,
	logFileChanges,
	parseTranscriptForCheckpointUUID,
	persistEventMetadataToState,
	resolveTranscriptOffset,
	UNKNOWN_SESSION_ID,
} from './dispatch';
export {
	detectFileChanges,
	type FileChanges,
	filterAndNormalizePaths,
	filterToUncommittedFiles,
	getUntrackedFilesForState,
	mergeUnique,
} from './file-changes';
export { handleCompaction } from './handlers/compaction';
export { handleModelUpdate } from './handlers/model-update';
export { handleSessionEnd, markSessionEnded } from './handlers/session-end';
export { handleSessionStart, sessionStartMessage } from './handlers/session-start';
export { handleSubagentEnd } from './handlers/subagent-end';
export { handleSubagentStart } from './handlers/subagent-start';
export { handleTurnEnd } from './handlers/turn-end';
export { handleTurnStart } from './handlers/turn-start';
export {
	executeAgentHook,
	getCurrentHookAgent,
	getCurrentHookName,
	getHookType,
	type HookRegistrar,
} from './hook-registry';
export {
	capturePrePromptState,
	cleanupPrePromptState,
	loadPrePromptState,
	normalizePrePromptState,
	type PrePromptState,
	preUntrackedFiles,
} from './pre-prompt-state';
export {
	capturePreTaskState,
	cleanupPreTaskState,
	findActivePreTaskFile,
	loadPreTaskState,
	PRE_TASK_FILE_PREFIX,
	type PreTaskState,
	preTaskUntrackedFiles,
} from './pre-task-state';
export { parseSubagentTypeAndDescription } from './subagent-input';
export { resolveTmpDir, STORY_TMP_DIR } from './tmp-dir';
export { transitionSessionTurnEnd } from './transition';
