/**
 * SubagentEnd handler — fires when a subagent completes (claude-code
 * `post-task` hook; Cursor `subagentStop`). Materializes a task-level
 * checkpoint via {@link ManualCommitStrategy.saveTaskStep} when the
 * subagent actually touched files.
 *
 * Mirrors Go `cmd/entire/cli/lifecycle.go`
 * (`handleLifecycleSubagentEnd`) — an 8-step orchestration:
 *
 * 1. Fallback-parse `subagent_type` / `description` from the raw
 *    `tool_input` payload when the hook didn't supply them directly.
 * 2. Resolve the per-subagent transcript path
 *    (`<transcriptDir>/agent-<subagentId>.jsonl`) or leave `''` when the
 *    hint is missing / the file has been GC'd.
 * 3. Merge `event.modifiedFiles` with any files the
 *    {@link TranscriptAnalyzer} can scrape from the transcript tail.
 *    Analyzer failures are non-fatal (log.warn).
 * 4. Load the pre-task state snapshot (captured at `SubagentStart`),
 *    diff against current git state, and normalize all three buckets
 *    to worktree-relative paths with `.story/*` filtered out.
 * 5. Short-circuit with a cleanup + return when no files changed —
 *    avoids creating a zero-delta checkpoint that would only bloat
 *    the metadata branch.
 * 6. Best-effort resolve the `Story-Checkpoint:` UUID that the paired
 *    main-agent turn carries (for rewind-style transcript truncation).
 *    Failures fall open to `''`.
 * 7. Hard-fail on `getGitAuthor` (need an author for the commit);
 *    build the 14-field Go-parity {@link TaskStepContext} (plus the 5
 *    incremental / todoContent defaults); invoke `saveTaskStep`.
 *    Either failure propagates.
 * 8. Best-effort cleanup of the pre-task tmp file. Failures are
 *    swallowed — the next `findActivePreTaskFile` / manual
 *    `story doctor` run will GC any survivor.
 *
 * TS-divergence from Go (documented inline):
 *
 * 1. `asTranscriptAnalyzer` returns a `[T, true] | [null, false]`
 *    destructurable tuple (Go `(T, bool)`).
 * 2. `ManualCommitStrategy` is constructed inline (Go `GetStrategy(ctx)`
 *    picks from a registry — Story only has the one strategy).
 * 3. The `TaskStepContext` interface is broader than the 14 fields Go
 *    populates; we supply defaults for the 5 incremental / todo fields
 *    (`isIncremental: false`, `incrementalSequence: 0`,
 *    `incrementalType: ''`, `incrementalData: null`, `todoContent: ''`)
 *    so the Go-path stays a pure subset.
 *
 * @packageDocumentation
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { asTranscriptAnalyzer } from '@/agent/capabilities';
import { findCheckpointUUID } from '@/agent/claude-code/transcript';
import type { Event } from '@/agent/event';
import type { Agent } from '@/agent/interfaces';
import { getGitAuthor } from '@/git';
import * as log from '@/log';
import { worktreeRoot } from '@/paths';
import { ManualCommitStrategy } from '@/strategy/manual-commit';
import type { AgentType, TaskStepContext } from '@/strategy/types';
import { agentTranscriptPath } from '../agent-transcript-path';
import { parseTranscriptForCheckpointUUID } from '../dispatch-helpers';
import { detectFileChanges, filterAndNormalizePaths, mergeUnique } from '../file-changes';
import { cleanupPreTaskState, loadPreTaskState, preTaskUntrackedFiles } from '../pre-task-state';
import { parseSubagentTypeAndDescription } from '../subagent-input';

/**
 * Handle a `SubagentEnd` lifecycle event. See the module-level JSDoc for
 * the 8-step orchestration + TS-divergence notes.
 *
 * Mirrors Go `lifecycle.go handleLifecycleSubagentEnd`.
 *
 * @throws Error propagated from `worktreeRoot`, `getGitAuthor`, or
 *   `strategy.saveTaskStep`. All other sub-steps are fail-open
 *   (analyzer / pre-task state / file-change detect / checkpoint-UUID
 *   lookup / cleanup).
 *
 * @example
 * await handleSubagentEnd(claudeAgent, {
 *   type: 'SubagentEnd',
 *   sessionId: 'sid-1',
 *   toolUseId: 'toolu_abc',
 *   subagentId: 'sub-1',
 *   sessionRef: '/tmp/sessions/sid-1.jsonl',
 *   modifiedFiles: ['src/a.ts'],
 *   // ...zero-value other fields
 * });
 *
 * // Side effects (assumes file changes exist):
 * //   shadow branch <repoRoot>/.git/refs/heads/story/<base>-<6hex>
 * //     ← task-checkpoint commit appended (via ManualCommitStrategy.saveTaskStep)
 * //   <repoRoot>/.story/tmp/pre-task-toolu_abc.json ← deleted (best-effort)
 * //   HEAD / index / worktree: unchanged
 * //
 * // Side effects (no changes branch):
 * //   <repoRoot>/.story/tmp/pre-task-toolu_abc.json ← deleted (best-effort)
 * //   Everything else: unchanged.
 */
// eslint-disable-next-line max-lines-per-function -- 8-sub-step orchestration
export async function handleSubagentEnd(ag: Agent, event: Event): Promise<void> {
	const logCtx = { component: 'lifecycle', hook: 'subagent-end', agent: ag.name() };

	// Step 1: fallback-parse subagent type / description from tool_input
	// when the hook didn't supply them as top-level fields.
	if (!event.subagentType && !event.taskDescription) {
		const [t, d] = parseSubagentTypeAndDescription(event.toolInput);
		event.subagentType = t;
		event.taskDescription = d;
	}

	// Step 2: resolve the subagent-specific transcript path. Empty string
	// signals "no per-subagent transcript available" — downstream
	// analyzer calls fall back to the main transcript.
	const transcriptDir = path.dirname(event.sessionRef);
	let subagentTranscriptPath = '';
	if (event.subagentId) {
		const candidate = agentTranscriptPath(transcriptDir, event.subagentId);
		if (candidate && fs.existsSync(candidate)) {
			subagentTranscriptPath = candidate;
		}
	}

	// Go parity: `lifecycle.go` logs `slog.String("event", event.Type.String())`
	// plus session / tool / agent / subagent_transcript. Review 2 found the
	// TS version was missing the `event` key (structured-log correlation).
	log.info(logCtx, 'subagent completed', {
		event: event.type,
		sessionId: event.sessionId,
		toolUseId: event.toolUseId,
		agentId: event.subagentId,
		subagentTranscript: subagentTranscriptPath,
	});

	// Step 3: seed with hook-provided modifiedFiles then merge analyzer
	// output when the agent implements TranscriptAnalyzer. Analyzer
	// errors are non-fatal (log.warn + continue).
	let modifiedFiles: string[] = [...event.modifiedFiles];
	const [analyzer, hasAnalyzer] = asTranscriptAnalyzer(ag);
	if (hasAnalyzer && analyzer) {
		const transcriptToScan = subagentTranscriptPath || event.sessionRef;
		try {
			const result = await analyzer.extractModifiedFilesFromOffset(transcriptToScan, 0);
			modifiedFiles = mergeUnique(modifiedFiles, result.files);
		} catch (err) {
			log.warn(logCtx, 'failed to extract modified files from subagent', {
				error: (err as Error).message,
			});
		}
	}

	// Step 4a: pre-task state — seeded at SubagentStart, used to subtract
	// pre-existing untracked files from the "new files" bucket.
	const preState = await loadPreTaskState(event.toolUseId).catch((err: unknown) => {
		log.warn(logCtx, 'failed to load pre-task state', {
			error: (err as Error).message,
		});
		return null;
	});
	const preUntracked = preTaskUntrackedFiles(preState);

	// Step 4b: diff against the current worktree. `null` means the
	// porcelain call failed — we treat the bucket as "no detected
	// changes" and keep Step 3's modifiedFiles as-is.
	const changes = await detectFileChanges(preUntracked).catch((err: unknown) => {
		log.warn(logCtx, 'failed to compute file changes', {
			error: (err as Error).message,
		});
		return null;
	});

	// Step 4c: normalize every path to worktree-relative and drop
	// `.story/*` entries (Story's own infrastructure must never appear
	// as a user change).
	const repoRoot = await worktreeRoot();
	let relModifiedFiles = filterAndNormalizePaths(modifiedFiles, repoRoot);
	let relNewFiles: string[] = [];
	let relDeletedFiles: string[] = [];
	if (changes) {
		relNewFiles = filterAndNormalizePaths(changes.new, repoRoot);
		relDeletedFiles = filterAndNormalizePaths(changes.deleted, repoRoot);
		relModifiedFiles = mergeUnique(
			relModifiedFiles,
			filterAndNormalizePaths(changes.modified, repoRoot),
		);
	}

	// Step 5: short-circuit when nothing changed. Go: same fast-path to
	// avoid creating a zero-delta task checkpoint.
	if (relModifiedFiles.length === 0 && relNewFiles.length === 0 && relDeletedFiles.length === 0) {
		log.info(logCtx, 'no file changes detected, skipping task checkpoint');
		await cleanupPreTaskState(event.toolUseId).catch(() => {});
		return;
	}

	// Step 6: best-effort checkpoint UUID lookup. Failures fall open to
	// the empty string — the commit still lands, just without an
	// associated `Story-Checkpoint:` trailer for transcript trimming.
	let checkpointUuid = '';
	const mainLines = await parseTranscriptForCheckpointUUID(event.sessionRef).catch(() => null);
	if (mainLines) {
		// `parseTranscriptForCheckpointUUID` returns `unknown[] | null` to keep
		// the dispatch helper agent-agnostic (not every agent uses Claude
		// Code's `TranscriptLine` shape). `findCheckpointUUID` consumes the
		// Claude-Code-specific shape directly; the cast is safe because
		// this handler is only wired for claude-code subagents.
		const lines = mainLines as import('@/transcript').TranscriptLine[];
		checkpointUuid = findCheckpointUUID(lines, event.toolUseId) ?? '';
	}

	// Step 7: hard-fail on getGitAuthor (need an author for the commit),
	// then build the 14-field Go-parity TaskStepContext plus 5 defaults
	// for the incremental / todoContent fields that Go omits entirely.
	const author = await getGitAuthor();
	const strategy = new ManualCommitStrategy();

	const taskStepCtx: TaskStepContext = {
		sessionId: event.sessionId,
		toolUseId: event.toolUseId,
		agentId: event.subagentId,
		modifiedFiles: relModifiedFiles,
		newFiles: relNewFiles,
		deletedFiles: relDeletedFiles,
		transcriptPath: event.sessionRef,
		subagentTranscriptPath,
		checkpointUuid,
		authorName: author.name,
		authorEmail: author.email,
		isIncremental: false,
		incrementalSequence: 0,
		incrementalType: '',
		incrementalData: null,
		subagentType: event.subagentType,
		taskDescription: event.taskDescription,
		todoContent: '',
		agentType: ag.type() as AgentType,
	};

	await strategy.saveTaskStep(taskStepCtx);

	// Step 8: best-effort cleanup of the pre-task tmp file. Swallowing
	// failure is intentional — `findActivePreTaskFile` / `story doctor`
	// GC stale files on the next pass.
	await cleanupPreTaskState(event.toolUseId).catch(() => {});
}
