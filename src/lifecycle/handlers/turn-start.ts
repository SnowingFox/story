/**
 * TurnStart handler — fires when the agent is about to send a new user
 * prompt to the model (Claude Code `user-prompt-submit` hook, Codex
 * `turn-start`, Vogon `PreTurn`). Captures the pre-prompt filesystem
 * snapshot, persists the prompt text for per-turn diagnostics, bootstraps
 * strategy setup lazily, and re-seeds the session state in case prior
 * hooks missed it.
 *
 * Mirrors Go `cmd/entire/cli/lifecycle.go: handleLifecycleTurnStart`.
 *
 * **Seven sub-steps** (linear; only step 4 is hard-fail):
 *
 * 1. `log.info('turn-start', …)` — breadcrumb with sessionId / sessionRef / model.
 * 2. Validate `event.sessionId` — empty → throw `'no session_id in TurnStart event'`;
 *    non-empty but `validateSessionId` rejects (path separators etc.) → throw
 *    `'invalid TurnStart event: <reason>'`. Unlike `session-end` /
 *    `session-start` this handler does NOT fall back to `UNKNOWN_SESSION_ID` —
 *    turn-scoped snapshots require a real session anchor.
 * 3. `loadModelHint(sessionId)` fallback when `event.model === ''`. Populates
 *    `event.model` **in-place** so downstream steps (and later handlers in
 *    the same dispatch) see the resolved model. Go silently no-ops on load
 *    error; TS wraps the await in `try/catch` as a defensive guard against
 *    future signature drift.
 * 4. **HARD FAIL point**: `capturePrePromptState(ag, sessionId, sessionRef)` —
 *    any error propagates (corrupt pre-prompt snapshot means `TurnEnd` would
 *    compute wrong file-changes; bail loudly). Matches Go `if err := ...; err != nil { return err }`.
 * 5. `prompt.txt` persistence — when `event.prompt` is non-empty, create
 *    `<worktreeRoot>/.story/metadata/<sid>/` (mode `0o750` recursive) and
 *    write `prompt.txt` (mode `0o600`). If the file already exists, append
 *    with literal `\n\n---\n\n` separator so per-turn ordering is preserved
 *    for later diagnostics. Any filesystem error `log.warn`-s and is
 *    swallowed (fail-open — the hook still proceeds so strategy setup runs).
 * 6. `ensureSetup(worktreeRoot())` — first-turn bootstrap of `.gitignore`,
 *    redaction config, metadata branch. Failures `log.warn` and are swallowed
 *    (Go `logging.Warn(..., "failed to ensure strategy setup", ...)`) — a
 *    later hook will retry; the session can still record even without full
 *    setup.
 * 7. `new ManualCommitStrategy().initializeSession(...)` — creates / updates
 *    the `SessionState` on disk (Phase 5.1 ships this API). Failures
 *    `log.warn` and are swallowed.
 *
 * **TS-divergences from Go** (intentional, documented here so audit-deferrals
 * picks them up):
 *
 * 1. `ensureSetup` requires a `repoDir` argument (Story plumbs it
 *    explicitly via `worktreeRoot()`); Go reads the dir from
 *    `strategy.ctx`-bound state.
 * 2. `ManualCommitStrategy` is constructed locally (`new ManualCommitStrategy()`);
 *    Go uses `GetStrategy(ctx)` singleton. Story's strategy is stateless so
 *    construction is effectively free — matches `session-end.ts`,
 *    `compaction.ts` pattern.
 * 3. `ag.type()` returns `AgentType | string` (to allow external plugin
 *    agents, Phase 6.7); `initializeSession` expects `AgentType`. Cast via
 *    `as AgentType` matches `session-end.ts` convention — the downstream
 *    impl treats the value as an opaque string and `AgentType`'s union has
 *    the `ExternalAgent` tail, so the runtime value is always valid.
 *
 * @packageDocumentation
 */

import * as fs from 'node:fs/promises';
import path from 'node:path';
import type { Event } from '@/agent/event';
import type { Agent } from '@/agent/interfaces';
import type { AgentType } from '@/agent/types';
import { PROMPT_FILE_NAME } from '@/checkpoint/constants';
import * as log from '@/log';
import { storyMetadataDirForSession, worktreeRoot } from '@/paths';
import { ManualCommitStrategy } from '@/strategy/manual-commit';
import { loadModelHint } from '@/strategy/session-state';
import { ensureSetup } from '@/strategy/setup';
import { validateSessionId } from '@/validation';
import { capturePrePromptState } from '../pre-prompt-state';

/**
 * Handle a `TurnStart` lifecycle event. See file-level JSDoc for the full
 * 7-step orchestration and TS-divergence notes.
 *
 * @example
 * await handleTurnStart(claudeAgent, {
 *   type: 'TurnStart',
 *   sessionId: 'sid-1',
 *   sessionRef: '/Users/me/.claude/projects/foo/abc.jsonl',
 *   prompt: 'refactor the lifecycle handlers',
 *   model: 'claude-sonnet-4',
 *   // ...zero-value other fields
 * });
 *
 * // Side effects (fresh session, no existing prompt.txt):
 * //   <repoRoot>/.story/tmp/pre-prompt-sid-1.json     ← new snapshot (mode 0o600)
 * //   <repoRoot>/.story/metadata/sid-1/               ← created (mode 0o750)
 * //   <repoRoot>/.story/metadata/sid-1/prompt.txt     ← event.prompt (mode 0o600)
 * //   <repoRoot>/.git/story-sessions/sid-1.json       ← state re-seeded
 * //   .gitignore / redaction config / metadata branch ← ensureSetup may touch
 * //   Worktree / index / HEAD:                         unchanged
 */
export async function handleTurnStart(ag: Agent, event: Event): Promise<void> {
	const logCtx = { component: 'lifecycle', hook: 'turn-start', agent: ag.name() };
	log.info(logCtx, 'turn-start', {
		event: event.type,
		sessionId: event.sessionId,
		sessionRef: event.sessionRef,
		model: event.model,
	});

	const sessionID = event.sessionId;
	if (!sessionID) {
		throw new Error(`no session_id in ${event.type} event`);
	}
	const vErr = validateSessionId(sessionID);
	if (vErr !== null) {
		throw new Error(`invalid ${event.type} event: ${vErr.message}`);
	}

	if (!event.model) {
		try {
			const hint = await loadModelHint(sessionID);
			if (hint) {
				event.model = hint;
				log.debug(logCtx, 'loaded model from hint file', { model: hint });
			}
		} catch {
			// Defensive: loadModelHint swallows internally, but guard against
			// future signature drift so a thrown error here never masks the
			// hard-fail in step 4.
		}
	}

	await capturePrePromptState(ag, sessionID, event.sessionRef);

	if (event.prompt) {
		try {
			const root = await worktreeRoot();
			const sessionDirAbs = path.join(root, storyMetadataDirForSession(sessionID));
			await fs.mkdir(sessionDirAbs, { recursive: true, mode: 0o750 });
			const promptPath = path.join(sessionDirAbs, PROMPT_FILE_NAME);
			let existing = '';
			try {
				existing = await fs.readFile(promptPath, 'utf-8');
			} catch {
				// Missing file is the happy path for a fresh turn — the outer
				// try/catch still covers permission / parent-missing errors.
			}
			const content = existing ? `${existing}\n\n---\n\n${event.prompt}` : event.prompt;
			await fs.writeFile(promptPath, content, { mode: 0o600 });
		} catch (err) {
			log.warn(logCtx, 'failed to write prompt.txt', {
				error: (err as Error).message,
			});
		}
	}

	try {
		const root = await worktreeRoot();
		await ensureSetup(root);
	} catch (err) {
		log.warn(logCtx, 'failed to ensure strategy setup', {
			error: (err as Error).message,
		});
	}

	try {
		const strategy = new ManualCommitStrategy();
		await strategy.initializeSession(
			sessionID,
			ag.type() as AgentType,
			event.sessionRef,
			event.prompt,
			event.model,
		);
	} catch (err) {
		log.warn(logCtx, 'failed to initialize session state', {
			error: (err as Error).message,
		});
	}
}
