/**
 * `hooks-prepare-commit-msg.ts` — `prepare-commit-msg` git hook entry for the
 * manual-commit strategy.
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/strategy/manual_commit_hooks.go`:
 *   - `PrepareCommitMsg` (16-step pipeline)
 *   - `handleAmendCommitMsg` (amend branch — preserve / restore from lastCheckpointId)
 *   - `tryAgentCommitFastPath` (mid-turn agent commit fast path)
 *   - `addTrailerForAgentCommit` (fast path inner write)
 *   - `addCheckpointTrailer` (1-line wrapper around appendCheckpointTrailer)
 *   - `addCheckpointTrailerWithComment` (3-branch string assembly for editor flow)
 *
 * @packageDocumentation
 */

import { readFile, writeFile } from 'node:fs/promises';
import { execGit, hasTTY, isGitSequenceOperation } from '@/git';
import { type CheckpointID, generate, isEmpty } from '@/id';
import * as log from '@/log';
import { worktreeRoot } from '@/paths';
import { getCommitLinking, load as loadSettings } from '@/settings/settings';
import { collapseWhitespace, truncateRunes } from '@/stringutil';
import { appendCheckpointTrailer, CHECKPOINT_TRAILER_KEY, parseCheckpoint } from '@/trailers';
import { filterSessionsWithNewContent, getLastPrompt } from './hooks-content-detection';
import { askConfirmTTY, saveCommitLinkingAlways, TtyResult } from './hooks-tty';
import type { ManualCommitStrategy } from './manual-commit';
import { findSessionsForWorktree } from './manual-commit-session';
import type { SessionState } from './types';

/**
 * Implements the `prepare-commit-msg` git hook entry. 16-step pipeline; see
 * [impl-1.md](docs/ts-rewrite/impl/phase-5-strategy/phase-5.4-hooks-handler/impl-1.md#preparecommitmsg)
 * for the full algorithm.
 *
 * Hook contract: silent on any error (always resolves; never throws to git).
 *
 * Mirrors Go `manual_commit_hooks.go: PrepareCommitMsg`.
 *
 * @example
 * await prepareCommitMsgImpl(strategy, '/repo/.git/COMMIT_EDITMSG', 'message');
 *
 * // Side effects:
 * //   <msgFile>                              ← may append "Story-Checkpoint: <id>" trailer
 * //                                            and (editor flow) explanatory # comment
 * //   .story/settings.local.json             ← may write commit_linking="always" if user picked [a]
 * //   /dev/tty                               ← may write prompt + read response (TTY only)
 * //
 * // Git refs / index / HEAD: unchanged.
 */
export async function prepareCommitMsgImpl(
	s: ManualCommitStrategy,
	msgFile: string,
	source: string,
): Promise<void> {
	const logCtx = { component: 'checkpoint' };

	// Step 1: skip during git sequence operations (rebase / cherry-pick / revert).
	if (await isGitSequenceOperation()) {
		log.debug(logCtx, 'prepare-commit-msg: skipped during git sequence operation', {
			strategy: 'manual-commit',
			source,
		});
		return;
	}

	// Step 2: skip merge / squash sources (auto-generated messages).
	if (source === 'merge' || source === 'squash') {
		log.debug(logCtx, 'prepare-commit-msg: skipped for source', {
			strategy: 'manual-commit',
			source,
		});
		return;
	}

	// Step 3: amend (source==="commit") branch.
	if (source === 'commit') {
		await handleAmendCommitMsg(s, msgFile);
		return;
	}

	// Step 4: open repo (silent on err — hook contract).
	let repo: Awaited<ReturnType<ManualCommitStrategy['getRepo']>>;
	try {
		repo = await s.getRepo();
	} catch {
		return;
	}

	// Step 5: worktreeRoot.
	let wtPath: string;
	try {
		wtPath = await worktreeRoot(repo.root);
	} catch {
		return;
	}

	// Step 6: find sessions for this worktree (match by worktree, not BaseCommit).
	let sessions: SessionState[];
	try {
		sessions = await findSessionsForWorktree(repo.root, wtPath);
	} catch {
		log.debug(logCtx, 'prepare-commit-msg: no active sessions', {
			strategy: 'manual-commit',
			source,
		});
		return;
	}
	if (sessions.length === 0) {
		log.debug(logCtx, 'prepare-commit-msg: no active sessions', {
			strategy: 'manual-commit',
			source,
		});
		return;
	}

	// Step 7: agent fast path — if !TTY OR commit_linking="always", inject and return.
	if (await tryAgentCommitFastPath(s, msgFile, sessions, source)) {
		return;
	}

	// Step 8: filter sessions to those with new content.
	const sessionsWithContent = await filterSessionsWithNewContent(repo.root, sessions);
	if (sessionsWithContent.length === 0) {
		log.debug(logCtx, 'prepare-commit-msg: no content to link', {
			strategy: 'manual-commit',
			source,
			sessions_found: sessions.length,
		});
		return;
	}

	// Step 9: read commit message file (silent on err).
	let message: string;
	try {
		message = await readFile(msgFile, 'utf8');
	} catch {
		return;
	}

	// Step 10: trailer already exists? → keep + return.
	const existing = parseCheckpoint(message);
	if (existing !== null) {
		log.debug(logCtx, 'prepare-commit-msg: trailer already exists', {
			strategy: 'manual-commit',
			source,
			existing_checkpoint_id: existing,
		});
		return;
	}

	// Step 11: generate fresh checkpoint ID.
	const checkpointId = generate();

	// Step 12: resolve display metadata (agent type + last prompt) from first session.
	const firstSession = sessionsWithContent[0]!;
	const agentType = firstSession.agentType ?? '';
	const lastPrompt = await getLastPrompt(repo.root, firstSession);
	// rune-safe truncation (Go: stringutil.TruncateRunes(CollapseWhitespace(...), 80, "...")).
	const displayPrompt = truncateRunes(collapseWhitespace(lastPrompt), 80, '...');

	// Step 13: load commit_linking setting (default "prompt").
	let commitLinking = 'prompt';
	try {
		const settings = await loadSettings(repo.root);
		commitLinking = getCommitLinking(settings);
	} catch {
		// keep default
	}

	// Step 14: source-based action.
	if (source === 'message') {
		// Using -m or -F: behavior depends on TTY availability and commit_linking.
		if (!hasTTY()) {
			// No TTY — auto-link.
			message = addCheckpointTrailer(message, checkpointId);
		} else if (commitLinking === 'always') {
			// User previously chose "always" — auto-link.
			message = addCheckpointTrailer(message, checkpointId);
		} else {
			// Human at terminal — prompt interactively.
			const header = `Story: Active ${agentType} session detected`;
			const details: string[] = [];
			if (displayPrompt !== '') {
				details.push(`Last prompt: ${displayPrompt}`);
			}
			const result = await askConfirmTTY(
				header,
				details,
				'Link this commit to session context?',
				true,
			);
			if (result === TtyResult.Skip) {
				log.debug(logCtx, 'prepare-commit-msg: user declined trailer', {
					strategy: 'manual-commit',
					source,
				});
				return;
			}
			if (result === TtyResult.LinkAlways) {
				try {
					await saveCommitLinkingAlways(repo.root);
				} catch (err) {
					log.warn(logCtx, 'prepare-commit-msg: failed to save commit_linking=always', {
						error: (err as Error).message,
					});
				}
			}
			message = addCheckpointTrailer(message, checkpointId);
		}
	} else {
		// Default branch (source === "" / "template" / unknown): editor flow.
		message = addCheckpointTrailerWithComment(message, checkpointId, agentType, displayPrompt);
	}

	log.info(logCtx, 'prepare-commit-msg: trailer added', {
		strategy: 'manual-commit',
		source,
		checkpoint_id: checkpointId,
	});

	// Step 15: write back.
	try {
		await writeFile(msgFile, message, { mode: 0o600 });
	} catch {
		// silent on write error
	}
}

/**
 * Handles `prepare-commit-msg` for amend operations (source=`"commit"`).
 * Preserves an existing trailer; otherwise restores from `state.lastCheckpointId`
 * **only when** `state.baseCommit === currentHead` (the commit being amended).
 * This prevents stale sessions from injecting unrelated checkpoint IDs.
 *
 * Mirrors Go `manual_commit_hooks.go: handleAmendCommitMsg`.
 *
 * @example
 * await handleAmendCommitMsg(strategy, '/repo/.git/COMMIT_EDITMSG');
 *
 * // Side effects (only when restoring):
 * //   <msgFile>  ← rewritten with restored Story-Checkpoint: <state.lastCheckpointId> trailer
 */
export async function handleAmendCommitMsg(
	s: ManualCommitStrategy,
	msgFile: string,
): Promise<void> {
	const logCtx = { component: 'checkpoint' };

	let message: string;
	try {
		message = await readFile(msgFile, 'utf8');
	} catch {
		return; // silent on read error
	}

	// Existing trailer → keep unchanged.
	const existing = parseCheckpoint(message);
	if (existing !== null) {
		log.debug(logCtx, 'prepare-commit-msg: amend preserves existing trailer', {
			strategy: 'manual-commit',
			checkpoint_id: existing,
		});
		return;
	}

	// No trailer — check if any session has lastCheckpointId to restore.
	let repo: Awaited<ReturnType<ManualCommitStrategy['getRepo']>>;
	let wtPath: string;
	try {
		repo = await s.getRepo();
		wtPath = await worktreeRoot(repo.root);
	} catch {
		return;
	}

	let sessions: SessionState[];
	try {
		sessions = await findSessionsForWorktree(repo.root, wtPath);
	} catch {
		return;
	}
	if (sessions.length === 0) {
		return;
	}

	let currentHead: string;
	try {
		currentHead = (await execGit(['rev-parse', 'HEAD'], { cwd: repo.root })).trim();
	} catch {
		return;
	}

	// Find first matching session with lastCheckpointId to restore.
	for (const state of sessions) {
		if (state.baseCommit !== currentHead) {
			continue;
		}
		const cp = state.lastCheckpointId;
		if (cp === undefined || isEmpty(cp)) {
			continue;
		}

		const restored = addCheckpointTrailer(message, cp);
		try {
			await writeFile(msgFile, restored, { mode: 0o600 });
		} catch {
			return; // silent on write error
		}
		log.info(logCtx, 'prepare-commit-msg: restored trailer on amend', {
			strategy: 'manual-commit',
			checkpoint_id: cp,
			session_id: state.sessionId,
			source: 'lastCheckpointId',
		});
		return;
	}

	log.debug(logCtx, 'prepare-commit-msg: amend with no checkpoint to restore', {
		strategy: 'manual-commit',
	});
}

/**
 * Mid-turn agent commit fast path: when `!hasTTY()` OR
 * `commit_linking === 'always'`, find the first non-empty ACTIVE session and
 * inject a fresh checkpoint trailer **without content detection**.
 *
 * Returns `true` when the fast path **fired** (trailer added — caller skips
 * the rest of {@link prepareCommitMsgImpl}). Returns `false` when neither
 * condition holds OR when **all** ACTIVE sessions are empty
 * (`transcriptPath==='' && filesTouched===[] && stepCount===0`); caller
 * falls through to the content-detection main path.
 *
 * Mirrors Go `manual_commit_hooks.go: tryAgentCommitFastPath`.
 */
export async function tryAgentCommitFastPath(
	s: ManualCommitStrategy,
	msgFile: string,
	sessions: readonly SessionState[],
	source: string,
): Promise<boolean> {
	const noTTY = !hasTTY();
	let skipContentDetection = noTTY;
	if (!skipContentDetection) {
		try {
			const repo = await s.getRepo();
			const settings = await loadSettings(repo.root);
			skipContentDetection = getCommitLinking(settings) === 'always';
		} catch {
			// keep skipContentDetection=false
		}
	}
	if (!skipContentDetection) {
		return false;
	}

	const logCtx = { component: 'checkpoint' };
	let activeSessions = 0;
	let emptyActiveSessions = 0;
	for (const state of sessions) {
		if (state.phase !== 'active') {
			continue;
		}
		activeSessions++;
		// Skip "empty" sessions: no transcript / no filesTouched / no stepCount.
		// Conservative approximation of CondenseSession's skip gate.
		const filesTouched = state.filesTouched ?? [];
		if (
			(state.transcriptPath === undefined || state.transcriptPath === '') &&
			filesTouched.length === 0 &&
			state.stepCount === 0
		) {
			emptyActiveSessions++;
			log.debug(logCtx, 'prepare-commit-msg: fast path skipping empty session', {
				session_id: state.sessionId,
				agent_type: state.agentType,
			});
			continue;
		}
		await addTrailerForAgentCommit(msgFile, state, source);
		return true;
	}

	const phases: string[] = sessions.map((s) => s.phase);
	let message = 'prepare-commit-msg: fast path found no ACTIVE sessions';
	if (activeSessions > 0 && emptyActiveSessions === activeSessions) {
		message = 'prepare-commit-msg: fast path skipped all ACTIVE sessions as empty';
	}
	log.debug(logCtx, message, {
		no_tty: noTTY,
		sessions: sessions.length,
		active_sessions: activeSessions,
		empty_active_sessions: emptyActiveSessions,
		session_phases: phases,
	});
	return false;
}

/**
 * Inner write-back used by {@link tryAgentCommitFastPath} after deciding to
 * inject a trailer. Always returns silently on file errors (hook contract).
 *
 * Mirrors Go `manual_commit_hooks.go: addTrailerForAgentCommit`.
 */
export async function addTrailerForAgentCommit(
	msgFile: string,
	state: SessionState,
	source: string,
): Promise<void> {
	const logCtx = { component: 'checkpoint' };
	const cpId = generate();

	let message: string;
	try {
		message = await readFile(msgFile, 'utf8');
	} catch {
		return;
	}

	// Don't add if trailer already exists.
	if (parseCheckpoint(message) !== null) {
		return;
	}

	const updated = addCheckpointTrailer(message, cpId);
	log.info(logCtx, 'prepare-commit-msg: agent commit trailer added', {
		strategy: 'manual-commit',
		source,
		checkpoint_id: cpId,
		session_id: state.sessionId,
	});

	try {
		await writeFile(msgFile, updated, { mode: 0o600 });
	} catch {
		// silent
	}
}

/**
 * Adds the `Story-Checkpoint:` trailer to a commit message. 1-line wrapper
 * around {@link appendCheckpointTrailer} from [src/trailers.ts](../trailers.ts)
 * (Phase 1.2 ship). DO NOT re-implement trailer formatting here.
 *
 * Mirrors Go `manual_commit_hooks.go: addCheckpointTrailer`.
 */
export function addCheckpointTrailer(message: string, checkpointId: CheckpointID): string {
	return appendCheckpointTrailer(message, checkpointId);
}

/**
 * Editor-flow trailer injection: place the trailer **above** git's auto-comment
 * block with an explanatory `# Remove ...` comment. **3 layout branches**:
 *
 *   - **Branch A** (no `#` line found at all — rare, e.g. `commit.cleanup=verbatim`):
 *     `<userContent>\n\n<trailer>\n<comment>\n`
 *   - **Branch B** (git comment block + user content present): typical editor path:
 *     `<userContent>\n\n<trailer>\n<comment>\n\n<gitComments>`
 *   - **Branch C** (git comment block + empty user content — bare `git commit` opens editor):
 *     `\n\n<trailer>\n<comment>\n\n<gitComments>`
 *     (two leading newlines = "blank line user types into" + "blank separator before trailer")
 *
 * Mirrors Go `manual_commit_hooks.go: addCheckpointTrailerWithComment`.
 *
 * @example
 * addCheckpointTrailerWithComment('feat: x', '0188...', 'Claude Code', 'rewrite README');
 * // returns: 'feat: x\n\nStory-Checkpoint: 0188...\n# Remove the Story-Checkpoint trailer above ...\n# Last Prompt: rewrite README\n# The trailer will be added to your next commit ...\n'
 */
export function addCheckpointTrailerWithComment(
	message: string,
	checkpointId: CheckpointID,
	agentName: string,
	prompt: string,
): string {
	const trailer = `${CHECKPOINT_TRAILER_KEY}: ${checkpointId}`;

	const commentLines: string[] = [
		`# Remove the ${CHECKPOINT_TRAILER_KEY} trailer above if you don't want to link this commit to ${agentName} session context.`,
	];
	if (prompt !== '') {
		commentLines.push(`# Last Prompt: ${prompt}`);
	}
	commentLines.push('# The trailer will be added to your next commit based on this branch.');
	const comment = commentLines.join('\n');

	const lines = message.split('\n');

	// Find the first line beginning with `#` (start of git's comment block).
	let commentStart = -1;
	for (let i = 0; i < lines.length; i++) {
		if (lines[i]!.startsWith('#')) {
			commentStart = i;
			break;
		}
	}

	// Branch A: no `#` line found.
	if (commentStart === -1) {
		return `${rTrim(message, '\n')}\n\n${trailer}\n${comment}\n`;
	}

	const userContent = rTrim(lines.slice(0, commentStart).join('\n'), '\n');
	const gitComments = lines.slice(commentStart).join('\n');

	// Branch C: empty user content.
	if (userContent === '') {
		return `\n\n${trailer}\n${comment}\n\n${gitComments}`;
	}

	// Branch B: user content + git comments.
	return `${userContent}\n\n${trailer}\n${comment}\n\n${gitComments}`;
}

function rTrim(s: string, ch: string): string {
	let end = s.length;
	while (end > 0 && s[end - 1] === ch) {
		end--;
	}
	return s.slice(0, end);
}
