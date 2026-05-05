/**
 * Claude Code-specific PostTodo hook handler.
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/hooks_claudecode_posttodo.go`.
 *
 * Creates an incremental task checkpoint when Claude executes TodoWrite
 * inside a subagent context (active pre-task file exists). Skips silently
 * for main-agent TodoWrite (this is the "Claude-specific subagent
 * checkpoint trigger").
 *
 * **Why outside `src/agent/claude-code/`**: this is NOT part of the generic
 * `HookSupport.parseHookEvent` flow. The framework dispatcher (Phase 7)
 * hands off `post-todo` → `null` → no-op. This handler is invoked directly
 * by the `story hooks claude-code post-todo` cmd handler (Phase 9.5 wires
 * it into cac).
 *
 * ## Runtime helpers (Phase 5.4 / Phase 7 surface)
 *
 * Production behavior: helpers delegate to `src/lifecycle/`
 * ({@link lifecycleGetCurrentHookAgent}, {@link lifecycleFindActivePreTaskFile},
 * {@link lifecycleDetectFileChanges}, {@link lifecycleGetNextCheckpointSequence})
 * and `ManualCommitStrategy.saveTaskStep`. Tests override via
 * {@link setPostTodoHelpersForTesting} for injection-based isolation.
 *
 * ## Failure-mode discipline (matches Go)
 *
 * - stdin parse failure → throw (caller propagates as non-zero exit)
 * - getCurrentHookAgent failure → throw
 * - all OTHER failures (no subagent context, on default branch, file
 *   detection error, git author error, saveTaskStep error) → log warn +
 *   return void. Hook MUST NEVER fail with non-zero exit, otherwise Claude
 *   UI shows an error to the user.
 *
 * @packageDocumentation
 */

import { extractSessionIdFromTranscriptPath } from '@/agent/claude-code';
import { readAndParseHookInput } from '@/agent/event';
import type { Agent } from '@/agent/interfaces';
import type { AgentType } from '@/agent/types';
import { type GitAuthor, getGitAuthor, shouldSkipOnDefaultBranch } from '@/git';
import { getNextCheckpointSequence as lifecycleGetNextCheckpointSequence } from '@/lifecycle/checkpoint-sequence';
import { detectFileChanges as lifecycleDetectFileChanges } from '@/lifecycle/file-changes';
import { getCurrentHookAgent as lifecycleGetCurrentHookAgent } from '@/lifecycle/hook-registry';
import { findActivePreTaskFile as lifecycleFindActivePreTaskFile } from '@/lifecycle/pre-task-state';
import * as log from '@/log';
import { ManualCommitStrategy } from '@/strategy/manual-commit';
import { countTodos, extractLastCompletedTodo } from '@/strategy/messages';
import type { TaskStepContext } from '@/strategy/types';

/** Subagent checkpoint hook input shape. Mirrors Go
 *  `hooks.go: SubagentCheckpointHookInput`. */
export interface SubagentCheckpointHookInput {
	sessionId: string;
	transcriptPath: string;
	toolName: string;
	toolUseId: string;
	/** Raw `tool_input` JSON (kept as Uint8Array bytes; mirrors Go `json.RawMessage`). */
	toolInput: Uint8Array;
}

/** Active pre-task file lookup result. */
export interface ActivePreTaskResult {
	found: boolean;
	toolUseId: string;
}

/** File change detection output. Mirrors Go `FileChanges` struct. */
export interface FileChanges {
	modified: string[];
	new: string[];
	deleted: string[];
}

/**
 * Production helpers required by the post-todo handler. The handler delegates
 * via these so tests can inject mocks; production wires to `src/lifecycle/*`
 * and `ManualCommitStrategy.saveTaskStep` (Phase 7).
 */
export interface PostTodoHelpers {
	getCurrentHookAgent: () => Promise<Agent>;
	findActivePreTaskFile: () => Promise<ActivePreTaskResult>;
	detectFileChanges: () => Promise<FileChanges>;
	getGitAuthor: () => Promise<GitAuthor>;
	getNextCheckpointSequence: (sessionId: string, toolUseId: string) => Promise<number>;
	saveTaskStep: (taskCtx: TaskStepInput) => Promise<void>;
}

/** Subset of `TaskStepContext` needed by the post-todo handler — kept narrow
 *  so we don't drag the full Phase 5.2 type into this stub-heavy module. */
export interface TaskStepInput {
	sessionId: string;
	toolUseId: string;
	modifiedFiles: string[];
	newFiles: string[];
	deletedFiles: string[];
	transcriptPath: string;
	authorName: string;
	authorEmail: string;
	isIncremental: true;
	incrementalSequence: number;
	incrementalType: string;
	incrementalData: Uint8Array;
	todoContent: string;
	agentType: AgentType | string;
}

const productionHelpers: PostTodoHelpers = {
	async getCurrentHookAgent(): Promise<Agent> {
		return lifecycleGetCurrentHookAgent();
	},
	async findActivePreTaskFile(): Promise<ActivePreTaskResult> {
		return lifecycleFindActivePreTaskFile();
	},
	async detectFileChanges(): Promise<FileChanges> {
		return lifecycleDetectFileChanges();
	},
	async getGitAuthor(): Promise<GitAuthor> {
		return getGitAuthor();
	},
	async getNextCheckpointSequence(sessionId: string, toolUseId: string): Promise<number> {
		return lifecycleGetNextCheckpointSequence(sessionId, toolUseId);
	},
	async saveTaskStep(taskCtx: TaskStepInput): Promise<void> {
		const strategy = new ManualCommitStrategy();
		// TaskStepInput is a narrow subset. Fill the rest of Phase 5.2
		// TaskStepContext with empty/default values — the incremental
		// path only consumes the incremental-* + file / author fields,
		// while subagent-*, agentId, checkpointUuid are only used on the
		// task-completion code path (not the TodoWrite hook).
		const fullCtx: TaskStepContext = {
			sessionId: taskCtx.sessionId,
			toolUseId: taskCtx.toolUseId,
			agentId: '',
			modifiedFiles: taskCtx.modifiedFiles,
			newFiles: taskCtx.newFiles,
			deletedFiles: taskCtx.deletedFiles,
			transcriptPath: taskCtx.transcriptPath,
			subagentTranscriptPath: '',
			checkpointUuid: '',
			authorName: taskCtx.authorName,
			authorEmail: taskCtx.authorEmail,
			isIncremental: taskCtx.isIncremental,
			incrementalSequence: taskCtx.incrementalSequence,
			incrementalType: taskCtx.incrementalType,
			incrementalData: taskCtx.incrementalData,
			subagentType: '',
			taskDescription: '',
			todoContent: taskCtx.todoContent,
			agentType: taskCtx.agentType as AgentType,
		};
		await strategy.saveTaskStep(fullCtx);
	},
};

let activeHelpers: PostTodoHelpers = productionHelpers;

/**
 * **Test-only**: read the production-helper map. Used by Phase 7 wiring
 * tests to verify each helper delegates to its `src/lifecycle/*` /
 * `ManualCommitStrategy` backend. Do NOT use outside tests.
 */
export function _productionHelpersForTesting(): PostTodoHelpers {
	return productionHelpers;
}

/**
 * **Test-only**: inject mock implementations of the runtime helpers.
 * Pass `null` to reset to production stubs.
 *
 * Mirrors Go's testable seam pattern (`hooks_claudecode_posttodo.go` exposes
 * `handleClaudeCodePostTodoFromReader` for tests).
 *
 * @example
 * setPostTodoHelpersForTesting({
 *   getCurrentHookAgent: async () => mockAgent,
 *   findActivePreTaskFile: async () => ({ found: true, toolUseId: 'toolu_x' }),
 *   detectFileChanges: async () => ({ modified: ['a.ts'], new: [], deleted: [] }),
 *   getGitAuthor: async () => ({ name: 'Test', email: 'test@test.com' }),
 *   getNextCheckpointSequence: async () => 1,
 *   saveTaskStep: async () => {},
 * });
 * // ... run handler ...
 * setPostTodoHelpersForTesting(null);  // restore in afterEach
 */
export function setPostTodoHelpersForTesting(helpers: Partial<PostTodoHelpers> | null): void {
	if (helpers === null) {
		activeHelpers = productionHelpers;
		return;
	}
	activeHelpers = { ...productionHelpers, ...helpers };
}

/**
 * Parse subagent-checkpoint hook stdin payload. Mirrors Go
 * `hooks.go: parseSubagentCheckpointHookInput`.
 *
 * @throws Error('failed to read input: ...') / Error('empty input') /
 *   Error('failed to parse JSON: ...') from {@link readAndParseHookInput}.
 */
export async function parseSubagentCheckpointHookInput(
	stdin: NodeJS.ReadableStream,
): Promise<SubagentCheckpointHookInput> {
	const raw = await readAndParseHookInput<{
		session_id?: unknown;
		transcript_path?: unknown;
		tool_name?: unknown;
		tool_use_id?: unknown;
		tool_input?: unknown;
	}>(stdin);
	const toolInputBytes =
		raw.tool_input === undefined || raw.tool_input === null
			? new Uint8Array()
			: new TextEncoder().encode(JSON.stringify(raw.tool_input));
	return {
		sessionId: typeof raw.session_id === 'string' ? raw.session_id : '',
		transcriptPath: typeof raw.transcript_path === 'string' ? raw.transcript_path : '',
		toolName: typeof raw.tool_name === 'string' ? raw.tool_name : '',
		toolUseId: typeof raw.tool_use_id === 'string' ? raw.tool_use_id : '',
		toolInput: toolInputBytes,
	};
}

/**
 * Extract the most-recently-completed todo content from a `tool_input` JSON
 * payload. The PostToolUse[TodoWrite] hook receives `{todos: [...]}` where
 * the just-completed work has `status: "completed"`.
 *
 * Mirrors Go `messages.go: ExtractLastCompletedTodoFromToolInput`. Returns
 * `''` on parse failure or if no completed item exists.
 */
export function extractLastCompletedTodoFromToolInput(toolInput: Uint8Array): string {
	const todos = extractTodosField(toolInput);
	if (todos === null) {
		return '';
	}
	return extractLastCompletedTodo(todos);
}

/**
 * Count the number of todo items in `tool_input.todos`. Returns 0 on parse
 * failure or missing `todos` field. Mirrors Go
 * `messages.go: CountTodosFromToolInput`.
 */
export function countTodosFromToolInput(toolInput: Uint8Array): number {
	const todos = extractTodosField(toolInput);
	if (todos === null) {
		return 0;
	}
	return countTodos(todos);
}

/** Extract the `todos` field from a `tool_input` JSON byte array. Returns
 *  `null` on parse failure or missing `todos`. */
function extractTodosField(toolInput: Uint8Array): Uint8Array | null {
	if (toolInput.length === 0) {
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder('utf-8').decode(toolInput));
	} catch {
		return null;
	}
	if (typeof parsed !== 'object' || parsed === null) {
		return null;
	}
	const todos = (parsed as { todos?: unknown }).todos;
	if (!Array.isArray(todos)) {
		return null;
	}
	return new TextEncoder().encode(JSON.stringify(todos));
}

/**
 * Handle PostToolUse[TodoWrite] hook for Claude Code.
 *
 * Returns `void` on all success / soft-failure paths. Throws ONLY on:
 * - stdin parse failure (`failed to parse PostToolUse[TodoWrite] input`)
 * - getCurrentHookAgent error (`failed to get agent`)
 *
 * All other failures (no subagent context / on default branch / file
 * detection failure / git author failure / saveTaskStep failure) log warn
 * and return `void` — matches Go: hook should NEVER fail with non-zero
 * exit, otherwise Claude UI shows an error to the user.
 *
 * @example
 * await handleClaudeCodePostTodo(process.stdin);
 *
 * // Side effects (when in subagent context AND file changes detected):
 * //   - new commit in <repoRoot>/.git via injected `saveTaskStep` helper
 * //   - .story/metadata/<sessionId>/... possibly updated
 * //
 * // No side effects when:
 * //   - main-agent TodoWrite (no active pre-task file)
 * //   - on default branch (skip)
 * //   - no file changes since last checkpoint
 *
 * Production helpers delegate to `src/lifecycle/` — see
 * {@link productionHelpers} for the wiring. Tests inject mocks via
 * {@link setPostTodoHelpersForTesting}.
 */
export async function handleClaudeCodePostTodo(stdin: NodeJS.ReadableStream): Promise<void> {
	let input: SubagentCheckpointHookInput;
	try {
		input = await parseSubagentCheckpointHookInput(stdin);
	} catch (err) {
		throw new Error(`failed to parse PostToolUse[TodoWrite] input: ${(err as Error).message}`, {
			cause: err as Error,
		});
	}

	let agentForLog: Agent;
	try {
		agentForLog = await activeHelpers.getCurrentHookAgent();
	} catch (err) {
		throw new Error(`failed to get agent: ${(err as Error).message}`, {
			cause: err as Error,
		});
	}

	const logCtx = { component: 'hooks', agent: agentForLog.name() } as const;
	log.info(logCtx, 'post-todo', {
		hook: 'post-todo',
		hook_type: 'subagent',
		model_session_id: input.sessionId,
		transcript_path: input.transcriptPath,
		tool_use_id: input.toolUseId,
	});

	// Subagent context check — main-agent TodoWrite is a silent skip.
	let preTaskCtx: ActivePreTaskResult;
	try {
		preTaskCtx = await activeHelpers.findActivePreTaskFile();
	} catch (err) {
		log.warn(logCtx, 'failed to find active pre-task file', { error: (err as Error).message });
		return;
	}
	if (!preTaskCtx.found) {
		return;
	}
	const taskToolUseId = preTaskCtx.toolUseId;

	// Skip on default branch (foundation backlog item #18).
	const { skip, branchName } = await shouldSkipOnDefaultBranch();
	if (skip) {
		log.info(logCtx, 'skipping incremental checkpoint on default branch', {
			branch: branchName,
		});
		return;
	}

	// Detect file changes — soft-fail on error.
	let changes: FileChanges;
	try {
		changes = await activeHelpers.detectFileChanges();
	} catch (err) {
		log.warn(logCtx, 'failed to detect changed files', { error: (err as Error).message });
		return;
	}
	if (changes.modified.length === 0 && changes.new.length === 0 && changes.deleted.length === 0) {
		log.info(logCtx, 'no file changes detected, skipping incremental checkpoint');
		return;
	}

	// Git author — soft-fail on error.
	let author: GitAuthor;
	try {
		author = await activeHelpers.getGitAuthor();
	} catch (err) {
		log.warn(logCtx, 'failed to get git author', { error: (err as Error).message });
		return;
	}

	// Resolve session ID via foundation backlog item #19.
	let sessionId = input.sessionId;
	if (sessionId === '') {
		sessionId = extractSessionIdFromTranscriptPath(input.transcriptPath);
	}

	// Sequence + todo content.
	let seq: number;
	try {
		seq = await activeHelpers.getNextCheckpointSequence(sessionId, taskToolUseId);
	} catch (err) {
		log.warn(logCtx, 'failed to get next checkpoint sequence', {
			error: (err as Error).message,
		});
		return;
	}

	let todoContent = extractLastCompletedTodoFromToolInput(input.toolInput);
	if (todoContent === '') {
		const todoCount = countTodosFromToolInput(input.toolInput);
		if (todoCount > 0) {
			todoContent = `Planning: ${todoCount} todos`;
		}
		// else fall through; saveTaskStep / formatIncrementalMessage will use 'Checkpoint #N'
	}

	// Authoritative agent type from hook context (best-effort; empty on failure).
	let agentType: AgentType | string = '';
	try {
		const ag = await activeHelpers.getCurrentHookAgent();
		agentType = ag.type();
	} catch {
		// best-effort; leave empty
	}

	const taskStepCtx: TaskStepInput = {
		sessionId,
		toolUseId: taskToolUseId,
		modifiedFiles: changes.modified,
		newFiles: changes.new,
		deletedFiles: changes.deleted,
		transcriptPath: input.transcriptPath,
		authorName: author.name,
		authorEmail: author.email,
		isIncremental: true,
		incrementalSequence: seq,
		incrementalType: input.toolName,
		incrementalData: input.toolInput,
		todoContent,
		agentType,
	};

	try {
		await activeHelpers.saveTaskStep(taskStepCtx);
	} catch (err) {
		log.warn(logCtx, 'failed to save incremental task step', {
			error: (err as Error).message,
		});
		return;
	}

	log.info(logCtx, 'created incremental checkpoint', {
		sequence: seq,
		tool_name: input.toolName,
		task: taskToolUseId.slice(0, Math.min(12, taskToolUseId.length)),
	});
}
