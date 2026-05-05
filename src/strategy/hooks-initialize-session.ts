/**
 * `hooks-initialize-session.ts` — `UserPromptSubmit` agent hook entry for the
 * manual-commit strategy.
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/strategy/manual_commit_hooks.go`:
 *   - `InitializeSession` (the public hook entry method)
 *   - `calculatePromptAttributionAtStart` (baseline attribution capture)
 * Plus Go `manual_commit_session.go: initializeSession` (private constructor).
 *
 * @packageDocumentation
 */

import fsCallback from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import git from 'isomorphic-git';
import { shadowBranchNameForCommit } from '@/checkpoint/temporary';
import { execGit } from '@/git';
import { generate } from '@/id';
import * as log from '@/log';
import { getWorktreeID, STORY_METADATA_DIR_NAME, worktreeRoot } from '@/paths';
import { Event, NoOpActionHandler } from '@/session/phase';
import type { AgentType } from '@/strategy/types';
import { VERSION as CLI_VERSION } from '@/versioninfo';
import { calculatePromptAttribution } from './attribution';
import type { ManualCommitStrategy } from './manual-commit';
import { migrateShadowBranchIfNeeded } from './manual-commit-migration';
import { truncatePromptForStorage } from './messages';
import { collectUntrackedFiles } from './rewind-helpers';
import { transitionAndLog } from './session-state';
import type { PromptAttribution, SessionState } from './types';

/**
 * Implements the `UserPromptSubmit` agent hook entry. Two branches:
 *
 *   1. **New session** (state == null OR `state.baseCommit === ''`): build a
 *      fresh state via {@link buildInitialSessionState}, run `EventTurnStart`
 *      transition, capture baseline attribution, save state.
 *   2. **Existing session** (state.baseCommit != ''): run `EventTurnStart`
 *      transition, generate new `turnId`, sticky/overwrite-on-empty field
 *      updates, clear `lastCheckpointId` + `turnCheckpointIds`, capture
 *      baseline attribution, run shadow-branch migration, save state.
 *
 * Mirrors Go `manual_commit_hooks.go: InitializeSession`.
 *
 * @example
 * await initializeSessionImpl(strategy, 'sess', 'Claude Code',
 *   '/tmp/transcript.jsonl', 'rewrite the README', 'claude-sonnet-4');
 *
 * // Side effects:
 * //   <repoDir>/.git/story-sessions/<sessionId>.json   ← written (new or overwritten)
 * //   shadow branch ref                                ← may be renamed (HEAD drift)
 * //   state.pendingPromptAttribution                   ← populated with baseline diff
 * //
 * // HEAD / index / worktree: unchanged.
 */
export async function initializeSessionImpl(
	s: ManualCommitStrategy,
	sessionId: string,
	agentType: AgentType,
	transcriptPath: string,
	userPrompt: string,
	model: string,
): Promise<void> {
	const repo = await s.getRepo();

	let state: SessionState | null;
	try {
		state = await s.loadSessionState(sessionId);
	} catch (err) {
		throw new Error(
			`failed to check session state: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	if (state !== null && state.baseCommit !== '') {
		// === Existing session branch ===

		// 1. EventTurnStart phase transition (idle/ended → active).
		try {
			await transitionAndLog(
				state,
				Event.TurnStart,
				{
					hasFilesTouched: false,
					isRebaseInProgress: false,
				},
				new NoOpActionHandler(),
			);
		} catch (err) {
			log.warn({ component: 'hooks', sessionId }, 'turn start transition failed', {
				error: err instanceof Error ? err.message : String(err),
			});
		}

		// 2. New TurnID for each turn (correlates carry-forward checkpoints).
		state.turnId = generate();

		// 3. Sticky agentType (set only if currently empty).
		// Callers may pass `'' as AgentType` to mean "no override" (Go semantics
		// where AgentType is a `string` newtype that allows zero value).
		if ((!state.agentType || state.agentType === '') && (agentType as string) !== '') {
			state.agentType = agentType;
		}

		// 4. Overwrite-when-provided modelName.
		if (model !== '') {
			state.modelName = model;
		}

		// 5. Overwrite-when-provided lastPrompt.
		if (userPrompt !== '') {
			state.lastPrompt = truncatePromptForStorage(userPrompt);
		}

		// 6. Overwrite-when-changed transcriptPath.
		if (transcriptPath !== '' && state.transcriptPath !== transcriptPath) {
			state.transcriptPath = transcriptPath;
		}

		// 7. Clear checkpoint IDs.
		state.lastCheckpointId = undefined;
		state.turnCheckpointIds = [];

		// 8. Capture baseline attribution.
		state.pendingPromptAttribution = await calculatePromptAttributionAtStart(repo.root, state);

		// 9. Migrate shadow branch if HEAD moved (Phase 5.2 already shipped).
		try {
			await migrateShadowBranchIfNeeded(s, repo.root, state);
		} catch (err) {
			throw new Error(
				`failed to check/migrate shadow branch: ${err instanceof Error ? err.message : String(err)}`,
			);
		}

		// 10. Save.
		try {
			await s.saveSessionState(state);
		} catch (err) {
			throw new Error(
				`failed to update session state: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		return;
	}

	// === New session branch (state == null OR partial state) ===
	const newState = await buildInitialSessionState(
		s,
		sessionId,
		agentType,
		transcriptPath,
		userPrompt,
		model,
	);

	// EventTurnStart transitions phase to 'active'.
	try {
		await transitionAndLog(
			newState,
			Event.TurnStart,
			{
				hasFilesTouched: false,
				isRebaseInProgress: false,
			},
			new NoOpActionHandler(),
		);
	} catch (err) {
		log.warn({ component: 'hooks', sessionId }, 'turn start transition failed', {
			error: err instanceof Error ? err.message : String(err),
		});
	}

	newState.pendingPromptAttribution = await calculatePromptAttributionAtStart(repo.root, newState);

	try {
		await s.saveSessionState(newState);
	} catch (err) {
		throw new Error(
			`failed to save attribution: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	log.info({ component: 'hooks', sessionId }, 'initialized shadow session');
}

/**
 * Build a fresh {@link SessionState} from current HEAD + worktree info. Used
 * when state.json is missing or has empty `baseCommit` (partial-state
 * recovery from concurrent-warning placeholder).
 *
 * Mirrors Go `manual_commit_session.go: initializeSession` (private; same
 * name as the public hook entry but different scope).
 *
 * @example
 * const state = await buildInitialSessionState(strategy, 'sess', 'Claude Code',
 *   '/tmp/t.jsonl', 'first prompt', 'claude-sonnet-4');
 *
 * // Side effects:
 * //   <repoDir>/.git/story-sessions/<sessionId>.json  ← written via saveSessionState
 * //
 * // Other state: unchanged.
 */
export async function buildInitialSessionState(
	s: ManualCommitStrategy,
	sessionId: string,
	agentType: AgentType,
	transcriptPath: string,
	userPrompt: string,
	model: string,
): Promise<SessionState> {
	const repo = await s.getRepo();

	let headHash: string;
	try {
		headHash = (await execGit(['rev-parse', 'HEAD'], { cwd: repo.root })).trim();
	} catch (err) {
		throw new Error(`failed to get HEAD: ${err instanceof Error ? err.message : String(err)}`);
	}

	let wtPath: string;
	try {
		wtPath = await worktreeRoot(repo.root);
	} catch (err) {
		throw new Error(
			`failed to get worktree path: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	let worktreeId: string;
	try {
		worktreeId = getWorktreeID(wtPath) ?? '';
	} catch (err) {
		throw new Error(
			`failed to get worktree ID: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	// Best-effort untracked-file capture (non-fatal).
	let untrackedFilesAtStart: string[] = [];
	try {
		untrackedFilesAtStart = await collectUntrackedFiles(repo.root);
	} catch {
		untrackedFilesAtStart = [];
	}

	const turnId = generate();
	const now = new Date().toISOString();

	const state = createSessionState({
		sessionId,
		headHash,
		worktreePath: wtPath,
		worktreeId,
		now,
		turnId,
		untrackedFilesAtStart,
		agentType,
		model,
		transcriptPath,
		userPrompt,
	});

	await s.saveSessionState(state);
	return state;
}

interface CreateSessionStateInput {
	sessionId: string;
	headHash: string;
	worktreePath: string;
	worktreeId: string;
	now: string;
	turnId: string;
	untrackedFilesAtStart: string[];
	agentType: AgentType;
	model: string;
	transcriptPath: string;
	userPrompt: string;
}

/**
 * Build the first persisted snapshot for a newly observed agent turn.
 *
 * @example
 * ```ts
 * const state = createSessionState({
 *   sessionId: '2026-04-27-6f4c...',
 *   headHash: '3f8c2a...',
 *   worktreePath: '/repo',
 *   worktreeId: '', // non-empty only for linked git worktrees
 *   now: '2026-04-27T04:39:00.000Z',
 *   turnId: '01HX...',
 *   untrackedFilesAtStart: ['notes.md'],
 *   agentType: 'cursor',
 *   model: 'gpt-5.5',
 *   transcriptPath: '/path/to/full.jsonl',
 *   userPrompt: 'Implement checkpoint fetch...',
 * });
 * // returns: SessionState {
 * //   sessionId: '2026-04-27-6f4c...',
 * //   cliVersion: '0.1.0',
 * //   baseCommit: '3f8c2a...',
 * //   attributionBaseCommit: '3f8c2a...',
 * //   worktreePath: '/repo',
 * //   startedAt: '2026-04-27T04:39:00.000Z',
 * //   lastInteractionTime: '2026-04-27T04:39:00.000Z',
 * //   stepCount: 0,
 * //   modelName: 'gpt-5.5',
 * //   lastPrompt: 'Implement checkpoint fetch...',
 * //   phase: 'idle',
 * // }
 * ```
 */
function createSessionState(input: CreateSessionStateInput): SessionState {
	return {
		sessionId: input.sessionId,
		// Go: manual_commit_session.go:316 — state.CLIVersion = versioninfo.Version.
		cliVersion: CLI_VERSION,
		baseCommit: input.headHash,
		attributionBaseCommit: input.headHash,
		worktreePath: input.worktreePath,
		worktreeId: input.worktreeId,
		startedAt: input.now,
		lastInteractionTime: input.now,
		turnId: input.turnId,
		stepCount: 0,
		untrackedFilesAtStart: input.untrackedFilesAtStart,
		agentType: input.agentType,
		modelName: input.model,
		transcriptPath: input.transcriptPath,
		lastPrompt: truncatePromptForStorage(input.userPrompt),
		// pre-transition; EventTurnStart promotes to 'active' on the caller's side.
		phase: 'idle',
	};
}

/**
 * Capture baseline attribution at prompt start (BEFORE the agent runs).
 * Reads the worktree (NOT staging area) so attribution matches what
 * `WriteTemporary` will later capture in checkpoints.
 *
 * - For new sessions (`stepCount === 0`): `lastCheckpointTreeOid` stays `null`
 *   so the inner {@link calculatePromptAttribution} falls back to `baseTree`.
 *   This ensures pre-session worktree dirt (e.g., `.claude/settings.json`)
 *   gets captured even when the shadow branch already has other sessions' data.
 * - For existing sessions (`stepCount > 0`): use the shadow branch tree as
 *   the reference.
 *
 * Filters paths starting with `.story/metadata/` (= `STORY_METADATA_DIR_NAME`).
 * Story-side variant of Go which filters both `.entire/` + `.entire/metadata/`;
 * Story drops the `.entire/` filter since Story never writes to that directory.
 * **Does NOT filter `.claude/`** — that filter only applies in the cross-session
 * attribution merge (impl-2.md).
 *
 * Mirrors Go `manual_commit_hooks.go: calculatePromptAttributionAtStart`.
 *
 * @example
 * await calculatePromptAttributionAtStart(repoDir, state);
 * // returns: PromptAttribution { checkpointNumber, userLinesAdded, ... }
 *
 * // Side effects: read-only — git status + blob lookups + worktree file reads.
 */
export async function calculatePromptAttributionAtStart(
	repoDir: string,
	state: SessionState,
): Promise<PromptAttribution> {
	const nextCheckpointNum = state.stepCount + 1;

	// Resolve last checkpoint tree only if stepCount > 0.
	let lastCheckpointTreeOid: string | null = null;
	if (state.stepCount > 0) {
		const branch = shadowBranchNameForCommit(state.baseCommit, state.worktreeId ?? '');
		try {
			const refOid = await git.resolveRef({
				fs: fsCallback,
				dir: repoDir,
				ref: `refs/heads/${branch}`,
			});
			const commit = await git.readCommit({ fs: fsCallback, dir: repoDir, oid: refOid });
			lastCheckpointTreeOid = commit.commit.tree;
		} catch {
			log.debug({ component: 'attribution' }, 'prompt attribution: no shadow branch', {
				shadow_branch: branch,
			});
		}
	}

	// Resolve base tree.
	let baseTreeOid: string | null = null;
	try {
		const commit = await git.readCommit({ fs: fsCallback, dir: repoDir, oid: state.baseCommit });
		baseTreeOid = commit.commit.tree;
	} catch (err) {
		log.debug({ component: 'attribution' }, 'prompt attribution: base commit unavailable', {
			base_commit: state.baseCommit,
			error: (err as Error).message,
		});
	}

	// Get changed files via `git status --porcelain -z`.
	const changedFiles = new Map<string, string>();
	let statusOut = '';
	try {
		const result = await execa('git', ['status', '--porcelain', '-z', '-uall'], { cwd: repoDir });
		statusOut = result.stdout;
	} catch (err) {
		log.debug(
			{ component: 'attribution' },
			'prompt attribution skipped: failed to get worktree status',
			{
				error: (err as Error).message,
			},
		);
		return zeroAttribution(nextCheckpointNum);
	}

	for (const filePath of parseStatusZ(statusOut)) {
		// Filter `.story/metadata/` (= STORY_METADATA_DIR_NAME) — Story's own
		// session data, not user code. Go also filters `.entire/` (Entire's
		// metadata dir), which Story never writes to, so we don't filter that
		// prefix here. `.claude/` is intentionally NOT filtered (only in
		// cross-attribution merge — see hooks-post-commit-attribution.ts in Part 2).
		if (filePath.startsWith(`${STORY_METADATA_DIR_NAME}/`)) {
			continue;
		}
		const fullPath = path.join(repoDir, filePath);
		let content = '';
		try {
			const data = await fs.readFile(fullPath);
			if (!isBinary(data)) {
				content = new TextDecoder('utf-8', { fatal: false }).decode(data);
			}
			// binary → empty string (excluded from line-based attribution)
		} catch {
			// deleted / unreadable → empty string
		}
		changedFiles.set(filePath, content);
	}

	return calculatePromptAttribution(
		repoDir,
		baseTreeOid,
		lastCheckpointTreeOid,
		changedFiles,
		nextCheckpointNum,
	);
}

/**
 * Parse `git status --porcelain -z -uall` output into a list of changed file
 * paths. Handles R/C (rename/copy) records that occupy two NUL segments —
 * we keep the new name and skip the old one. Private helper.
 *
 * Mirrors Go's worktree.Status() iteration semantics for our needs (we don't
 * need staging vs worktree distinction here — both contribute to attribution).
 */
function parseStatusZ(stdout: string): string[] {
	const out: string[] = [];
	const entries = stdout.split('\0');
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (entry === undefined || entry.length < 3) {
			continue;
		}
		const staging = entry[0]!;
		const wtStatus = entry[1]!;
		const filename = entry.slice(3);
		// Skip unmodified (shouldn't appear in --porcelain output but defensive).
		if (staging === ' ' && wtStatus === ' ') {
			continue;
		}
		out.push(filename);
		// R/C: consume the old name in the next slot.
		if (staging === 'R' || staging === 'C') {
			i++;
		}
	}
	return out;
}

/**
 * Detect whether a buffer is binary by scanning the first 8 KiB for a NULL byte.
 * Matches the heuristic used in `attribution.ts: getFileContent` (Phase 5.3).
 */
function isBinary(data: Uint8Array): boolean {
	const limit = Math.min(data.length, 8192);
	for (let i = 0; i < limit; i++) {
		if (data[i] === 0) {
			return true;
		}
	}
	return false;
}

/**
 * Returns a zero-initialized {@link PromptAttribution} for early-return paths
 * where the worktree status fetch failed. Matches the Go `result :=
 * PromptAttribution{CheckpointNumber: nextCheckpointNum}` semantics —
 * remaining numeric fields default to 0.
 */
function zeroAttribution(checkpointNumber: number): PromptAttribution {
	return {
		checkpointNumber,
		userLinesAdded: 0,
		userLinesRemoved: 0,
		agentLinesAdded: 0,
		agentLinesRemoved: 0,
	};
}
