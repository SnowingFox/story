/**
 * TurnEnd handler — fires when an agent completes a turn (Claude Code
 * `stop` hook, Codex `turn-end`, Cursor `stop`, etc.). Captures the
 * per-turn file changes, materializes a shadow-branch checkpoint via
 * `ManualCommitStrategy.saveStep`, and persists the rotated session state.
 *
 * Mirrors Go `cmd/entire/cli/lifecycle.go`
 * (`handleLifecycleTurnEnd`) — the most complex handler in Phase 7
 * (Go 310 lines).
 *
 * **8 sub-steps** (linear; failure semantics documented per step):
 *
 * 1. Validate transcript ref. Empty `sessionRef` → throw `'transcript file not specified'`.
 * 2. Optional transcript preparation (OpenCode lazy-fetch) + `fs.stat`
 *    existence check. Preparer failures `log.warn` + continue (preparer
 *    is best-effort — Claude Code's is a no-op flush). `fs.stat` failure
 *    (after the optional preparer) → throw `'transcript file not found:'`.
 * 3. Early-exit on empty repo. `git rev-parse HEAD` empty stdout OR
 *    reject → `log.info('skipping checkpoint - will activate after first
 *    commit')` + return (NOT throw). The user was already warned at
 *    session start; hooks must exit 0 so the agent continues normally.
 * 4. Copy transcript to `<sessionDir>/<TRANSCRIPT_FILE_NAME>`.
 *    `sessionDir` created with `mode 0o750 recursive`; transcript written
 *    with `mode 0o600`. `ag.readTranscript` / `fs.writeFile` failures
 *    propagate (hard-fail — without the transcript copy the checkpoint
 *    is unrecoverable).
 * 5. Load pre-prompt state (captured at `TurnStart`) → resolve transcript
 *    offset → backfill `prompt.txt` from transcript when empty (requires
 *    `PromptExtractor` capability) → extract modified files (prefer
 *    `SubagentAwareExtractor` for Claude Code Task nesting; fallback to
 *    base `TranscriptAnalyzer.extractModifiedFilesFromOffset`). All
 *    sub-steps fail-open: load/preState/prompt-write/analyzer failures
 *    `log.warn` + continue with the best-available defaults.
 * 6. Generate commit message. Single `loadSessionState` serves dual
 *    purpose — retrieve `lastPrompt` (prefer stored over backfilled) and
 *    potentially persist the backfilled prompt so `story status` reflects
 *    it even on the no-changes early-return branch.
 * 7. Detect file changes (git status) → filter & normalize to
 *    repo-relative → `mergeUnique(transcript-modified, git-modified)` →
 *    `filterToUncommittedFiles` (drops files already committed
 *    mid-turn). Total = 0 → `log.info('no files modified...')` +
 *    `transitionSessionTurnEnd` + cleanup + return (no saveStep).
 * 8. Hard-fail on `getGitAuthor`. `calculateTokenUsage` fail-open (warn +
 *    `tokenUsage = null`). Build 13-field {@link StepContext} →
 *    `strategy.saveStep(ctx)` (throw propagates). Post-save re-check
 *    session state (saveStep may reinit) + backfill `lastPrompt` again.
 *    `transitionSessionTurnEnd` + cleanup (cleanup failures swallowed).
 *
 * **TS-divergences from Go** (intentional; documented here so audit can defer):
 *
 * 1. `asTranscriptPreparer` / `asPromptExtractor` / `asTranscriptAnalyzer` /
 *    `asSubagentAwareExtractor` return `[T, true] | [null, false]`
 *    tuples (Go returns `(T, bool)` pairs); the handler destructures.
 * 2. `ManualCommitStrategy` is constructed inline (Go `GetStrategy(ctx)`
 *    picks from a registry). Matches `session-end.ts` / `turn-start.ts`.
 * 3. `loadModelHint(sessionId)` returns `''` on internal error (TS
 *    signature drift-safe); the handler still wraps the call in
 *    `try/catch` so future signature changes cannot mask step 1's throw.
 * 4. `TRANSCRIPT_FILE_NAME` resolves to `'full.jsonl'` (TS constant) —
 *    Go hard-codes `transcript.jsonl` in the log attribute but writes
 *    with `paths.TranscriptFileName`. Story uses the canonical constant
 *    on both sides.
 * 5. `calculateTokenUsage` returns `TokenUsage | null`; the
 *    {@link StepContext.tokenUsage} field is typed `TokenUsage | null`
 *    so `null` (not `undefined`) flows through on analyzer failure.
 *
 * @packageDocumentation
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
	asPromptExtractor,
	asSubagentAwareExtractor,
	asTranscriptAnalyzer,
	asTranscriptPreparer,
} from '@/agent/capabilities';
import type { Event } from '@/agent/event';
import type { Agent } from '@/agent/interfaces';
import { calculateTokenUsage } from '@/agent/token-usage';
import type { AgentType } from '@/agent/types';
import { PROMPT_FILE_NAME, TRANSCRIPT_FILE_NAME } from '@/checkpoint/constants';
import { execGit, getGitAuthor } from '@/git';
import * as log from '@/log';
import { storyMetadataDirForSession, worktreeRoot } from '@/paths';
import { ManualCommitStrategy } from '@/strategy/manual-commit';
import { loadModelHint, loadSessionState, saveSessionState } from '@/strategy/session-state';
import type { StepContext, TokenUsage } from '@/strategy/types';
import { generateCommitMessage } from '../commit-message';
import { logFileChanges, resolveTranscriptOffset, UNKNOWN_SESSION_ID } from '../dispatch-helpers';
import {
	detectFileChanges,
	filterAndNormalizePaths,
	filterToUncommittedFiles,
	mergeUnique,
} from '../file-changes';
import { cleanupPrePromptState, loadPrePromptState, preUntrackedFiles } from '../pre-prompt-state';
import { transitionSessionTurnEnd } from '../transition';

/**
 * Handle a `TurnEnd` lifecycle event. See file-level JSDoc for the full
 * 8-step orchestration + TS-divergence notes.
 *
 * @throws Error('transcript file not specified') when `event.sessionRef` is empty.
 * @throws Error('transcript file not found: ...') when `fs.stat` rejects
 *   after the optional `prepareTranscript` step.
 * @throws Error propagated from `ag.readTranscript`, `fs.mkdir`,
 *   `fs.writeFile` (step 4), `getGitAuthor` or `strategy.saveStep`
 *   (step 8). All other sub-steps are fail-open.
 *
 * @example
 * await handleTurnEnd(claudeAgent, {
 *   type: 'TurnEnd',
 *   sessionId: 'sid-1',
 *   sessionRef: '/Users/me/.claude/projects/foo/abc.jsonl',
 *   model: 'claude-sonnet-4.6',
 *   // ...zero-value other fields
 * });
 *
 * // Side effects (happy path, repo has >=1 commit, files changed):
 * //   <repoRoot>/.story/metadata/sid-1/                ← created (mode 0o750)
 * //   <repoRoot>/.story/metadata/sid-1/full.jsonl      ← transcript copy (mode 0o600)
 * //   <repoRoot>/.story/metadata/sid-1/prompt.txt      ← may be backfilled (mode 0o600)
 * //   refs/heads/story/<shadow>/...                    ← shadow-branch commit (strategy.saveStep)
 * //   .git/story-sessions/sid-1.json                   ← phase=idle + merged metrics
 * //   .story/tmp/pre-prompt-sid-1.json                 ← deleted (cleanupPrePromptState)
 * //   Worktree / index / HEAD:                         unchanged
 * //
 * // Side effects (empty repo early-exit branch):
 * //   log.info('skipping checkpoint...')               ← only side effect
 * //   Everything else: unchanged.
 * //
 * // Side effects (no-changes branch):
 * //   .git/story-sessions/sid-1.json                   ← phase=idle via transition
 * //   .story/tmp/pre-prompt-sid-1.json                 ← deleted
 * //   No shadow-branch commit (saveStep NOT called).
 */
// eslint-disable-next-line max-lines-per-function -- 8-step orchestration; Go parity requires linear flow
export async function handleTurnEnd(ag: Agent, event: Event): Promise<void> {
	const logCtx = { component: 'lifecycle', hook: 'turn-end', agent: ag.name() };
	log.info(logCtx, 'turn-end', {
		event: event.type,
		sessionId: event.sessionId,
		sessionRef: event.sessionRef,
		model: event.model,
	});

	const sessionID = event.sessionId || UNKNOWN_SESSION_ID;

	if (!event.model && sessionID !== UNKNOWN_SESSION_ID) {
		try {
			const hint = await loadModelHint(sessionID);
			if (hint) {
				event.model = hint;
				log.debug(logCtx, 'loaded model from hint file', { model: hint });
			}
		} catch {
			// Defensive: `loadModelHint` swallows internally, but guard
			// against future signature drift so a thrown error here never
			// masks step 1's throw (validation of `transcriptRef`).
		}
	}

	const transcriptRef = event.sessionRef;
	if (!transcriptRef) {
		throw new Error('transcript file not specified');
	}

	// DEFER(phase-11): perf.Start child span "prepare_and_validate_transcript"
	// blocked-by: phase-11 perf module (wraps preparer + fs.stat pair; Go `lifecycle.go`)
	const [preparer, prepOk] = asTranscriptPreparer(ag);
	if (prepOk && preparer) {
		try {
			await preparer.prepareTranscript(transcriptRef);
		} catch (err) {
			log.warn(logCtx, 'failed to prepare transcript', {
				error: (err as Error).message,
			});
		}
	}
	try {
		await fs.stat(transcriptRef);
	} catch {
		throw new Error(`transcript file not found: ${transcriptRef}`);
	}

	// Step 3: empty-repo early exit.
	//
	// **TS-divergence from Go** (detection mechanism, same happy-path outcome):
	//
	// Go `lifecycle.go` uses `strategy.OpenRepository(ctx)` +
	// `strategy.IsEmptyRepository(repo)` (go-git inspection of `refs/heads`).
	// TS uses `git rev-parse HEAD` and treats `catch`/empty-output as
	// "empty repo". The happy path (no commits yet → skip checkpoint,
	// exit 0) is identical.
	//
	// Edge-case drift (acceptable, review-2 documented): shallow clones
	// without HEAD, or partially corrupt `.git/` directories, may hit
	// different branches in go-git vs `git rev-parse`. Both paths still
	// return `nil` (log.info + return), so the hook never blocks the
	// agent regardless of which impl is more "correct" about the repo
	// being empty. Revisit only if we hit a real user-facing bug.
	try {
		const head = await execGit(['rev-parse', 'HEAD'], { cwd: await worktreeRoot() });
		if (!head.trim()) {
			log.info(logCtx, 'skipping checkpoint - will activate after first commit');
			return;
		}
	} catch {
		log.info(logCtx, 'skipping checkpoint - will activate after first commit');
		return;
	}

	const root = await worktreeRoot();
	const sessionDir = storyMetadataDirForSession(sessionID);
	const sessionDirAbs = path.join(root, sessionDir);
	await fs.mkdir(sessionDirAbs, { recursive: true, mode: 0o750 });
	const transcriptData = await ag.readTranscript(transcriptRef);
	const logFile = path.join(sessionDirAbs, TRANSCRIPT_FILE_NAME);
	await fs.writeFile(logFile, transcriptData, { mode: 0o600 });
	log.debug(logCtx, 'copied transcript', { path: `${sessionDir}/${TRANSCRIPT_FILE_NAME}` });

	// DEFER(phase-11): perf.Start child span "extract_metadata"
	// blocked-by: phase-11 perf module (covers loadPrePromptState + resolveTranscriptOffset + prompt backfill + modifiedFiles extraction; Go `lifecycle.go`)
	let preState = null;
	try {
		preState = await loadPrePromptState(sessionID);
	} catch (err) {
		log.warn(logCtx, 'failed to load pre-prompt state', {
			error: (err as Error).message,
		});
	}
	const transcriptOffset = await resolveTranscriptOffset(preState, sessionID);

	const promptPath = path.join(sessionDirAbs, PROMPT_FILE_NAME);
	let backfilledPrompt = '';
	// Go parity: `lifecycle.go` separates ENOENT (treat as empty
	// prompt → OK to backfill) from non-ENOENT errors (permission, parent
	// missing, etc. → log.warn + **skip backfill** so the real IO error
	// is not silently masked by writing a synthetic prompt from the
	// transcript). Prior TS implementation swallowed all read errors as
	// "empty" and always ran the extractor — discovered in review 2.
	let existing = '';
	let nonENOENTReadErr: Error | null = null;
	try {
		existing = await fs.readFile(promptPath, 'utf-8');
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code !== 'ENOENT') {
			log.warn(logCtx, 'failed to read prompt.txt, skipping backfill', {
				error: (err as Error).message,
			});
			nonENOENTReadErr = err as Error;
		}
	}
	if (!existing && !nonENOENTReadErr) {
		const [pe, peOk] = asPromptExtractor(ag);
		if (peOk && pe) {
			try {
				const prompts = await pe.extractPrompts(transcriptRef, transcriptOffset);
				if (prompts.length > 0) {
					try {
						await fs.writeFile(promptPath, prompts.join('\n\n---\n\n'), {
							mode: 0o600,
						});
						log.debug(logCtx, 'backfilled prompt.txt from transcript', {
							count: prompts.length,
						});
						backfilledPrompt = prompts[prompts.length - 1] ?? '';
					} catch (err) {
						log.warn(logCtx, 'failed to backfill prompt.txt', {
							error: (err as Error).message,
						});
					}
				}
			} catch (err) {
				log.warn(logCtx, 'failed to extract prompts from transcript', {
					error: (err as Error).message,
				});
			}
		}
	}

	const subagentsDir = path.join(path.dirname(transcriptRef), event.sessionId, 'subagents');

	let modifiedFiles: string[] = [];
	const [analyzer, anOk] = asTranscriptAnalyzer(ag);
	if (anOk && analyzer) {
		const [sae, saeOk] = asSubagentAwareExtractor(ag);
		try {
			if (saeOk && sae) {
				modifiedFiles = await sae.extractAllModifiedFiles(
					transcriptData,
					transcriptOffset,
					subagentsDir,
				);
			} else {
				const result = await analyzer.extractModifiedFilesFromOffset(
					transcriptRef,
					transcriptOffset,
				);
				modifiedFiles = result.files;
			}
		} catch (err) {
			log.warn(logCtx, 'failed to extract modified files', {
				error: (err as Error).message,
			});
		}
	}

	let lastPrompt = '';
	const sessionState = await loadSessionState(sessionID).catch(() => null);
	if (sessionState) {
		lastPrompt = sessionState.lastPrompt ?? '';
		if (!lastPrompt && backfilledPrompt) {
			lastPrompt = backfilledPrompt;
			sessionState.lastPrompt = backfilledPrompt;
			try {
				await saveSessionState(sessionState);
			} catch (err) {
				log.warn(logCtx, 'failed to backfill LastPrompt in session state', {
					error: (err as Error).message,
				});
			}
		}
	} else if (backfilledPrompt) {
		lastPrompt = backfilledPrompt;
	}
	const commitMessage = generateCommitMessage(lastPrompt, ag.type() as AgentType);
	log.debug(logCtx, 'using commit message', { length: commitMessage.length });

	// DEFER(phase-11): perf.Start child span "detect_file_changes"
	// blocked-by: phase-11 perf module (wraps git-status detection + downstream filter/normalize; Go `lifecycle.go`)
	const preUntracked = preUntrackedFiles(preState);
	const changes = await detectFileChanges(preUntracked).catch((err) => {
		log.warn(logCtx, 'failed to compute file changes', {
			error: (err as Error).message,
		});
		return null;
	});

	let relModifiedFiles = filterAndNormalizePaths(modifiedFiles, root);
	let relNewFiles: string[] = [];
	let relDeletedFiles: string[] = [];
	if (changes) {
		relNewFiles = filterAndNormalizePaths(changes.new, root);
		relDeletedFiles = filterAndNormalizePaths(changes.deleted, root);
		relModifiedFiles = mergeUnique(
			relModifiedFiles,
			filterAndNormalizePaths(changes.modified, root),
		);
	}
	relModifiedFiles = await filterToUncommittedFiles(relModifiedFiles, root);

	const totalChanges = relModifiedFiles.length + relNewFiles.length + relDeletedFiles.length;
	if (totalChanges === 0) {
		log.info(logCtx, 'no files modified during session, skipping checkpoint');
		await transitionSessionTurnEnd(sessionID, event);
		try {
			await cleanupPrePromptState(sessionID);
		} catch (err) {
			log.warn(logCtx, 'failed to cleanup pre-prompt state', {
				error: (err as Error).message,
			});
		}
		return;
	}

	logFileChanges(logCtx, relModifiedFiles, relNewFiles, relDeletedFiles);

	// DEFER(phase-11): perf.Start child span "save_step"
	// blocked-by: phase-11 perf module (wraps token-usage calc + StepContext assembly + strategy.saveStep; Go `lifecycle.go`)
	const author = await getGitAuthor();
	const strategy = new ManualCommitStrategy();
	const agentType = ag.type() as AgentType;

	const transcriptIdentifierAtStart = preState?.lastTranscriptIdentifier ?? '';
	const transcriptLinesAtStart = preState?.transcriptOffset ?? 0;

	let tokenUsage: TokenUsage | null = null;
	try {
		tokenUsage = await calculateTokenUsage(
			ag,
			transcriptData,
			transcriptLinesAtStart,
			subagentsDir,
		);
	} catch (err) {
		log.warn(logCtx, 'failed to calculate token usage', {
			error: (err as Error).message,
		});
	}

	const stepCtx: StepContext = {
		sessionId: sessionID,
		modifiedFiles: relModifiedFiles,
		newFiles: relNewFiles,
		deletedFiles: relDeletedFiles,
		metadataDir: sessionDir,
		metadataDirAbs: sessionDirAbs,
		commitMessage,
		transcriptPath: transcriptRef,
		authorName: author.name,
		authorEmail: author.email,
		agentType,
		stepTranscriptIdentifier: transcriptIdentifierAtStart,
		stepTranscriptStart: transcriptLinesAtStart,
		tokenUsage,
	};

	await strategy.saveStep(stepCtx);

	if (backfilledPrompt) {
		const reloaded = await loadSessionState(sessionID).catch(() => null);
		if (reloaded && !reloaded.lastPrompt) {
			reloaded.lastPrompt = backfilledPrompt;
			try {
				await saveSessionState(reloaded);
			} catch (err) {
				log.warn(logCtx, 'failed to backfill LastPrompt in session state', {
					error: (err as Error).message,
				});
			}
		}
	}

	await transitionSessionTurnEnd(sessionID, event);
	try {
		await cleanupPrePromptState(sessionID);
	} catch (err) {
		log.warn(logCtx, 'failed to cleanup pre-prompt state', {
			error: (err as Error).message,
		});
	}
}
