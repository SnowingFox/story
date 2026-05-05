/**
 * Package-level session state I/O functions, plus the `transitionAndLog`
 * helper that wires the Phase 3 state machine into the strategy package.
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/strategy/session_state.go` (full file).
 *
 * **Architecture note**: each function here builds a one-shot {@link StateStore}
 * scoped to the current repo's `.git/story-sessions/` dir. The
 * {@link ManualCommitStrategy} class (Phase 5.1 Layer 6) caches a single
 * StateStore for repeated I/O within a process, but for one-shot CLI calls
 * (`story sessions`, `story doctor`) constructing-on-demand is cheaper than
 * threading a class through.
 *
 * @packageDocumentation
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import * as log from '../log';
import { SESSION_STATE_DIR_NAME, worktreeRoot } from '../paths';
import {
	type ActionHandler,
	applyTransition,
	type Event,
	eventLabel,
	type TransitionContext,
	transition,
} from '../session/phase';
import { StateStore } from '../session/state-store';
import { validateSessionId } from '../validation';
import { getGitCommonDir } from './repo';
import type { SessionState } from './types';

/**
 * Build a StateStore for the repo containing `cwd` (or `process.cwd()`).
 * Caches per-repo would require module-level state — for now construct on demand
 * (Phase 5.1's ManualCommitStrategy class will cache one).
 */
async function makeStateStore(cwd?: string): Promise<StateStore> {
	const commonDir = await getGitCommonDir(cwd);
	return new StateStore(path.join(commonDir, SESSION_STATE_DIR_NAME));
}

/**
 * Load session state. Returns `null` for missing files, missing directory,
 * or stale sessions (auto-deleted by underlying `StateStore.load`).
 *
 * Mirrors Go `session_state.go:43-54` (`LoadSessionState`).
 *
 * @example
 * ```ts
 * await loadSessionState('sess-1', repoDir);
 * // returns: SessionState { sessionId: 'sess-1', baseCommit: 'abc1234', ... }
 * // returns: null   when the .json doesn't exist OR the session is stale
 *
 * // Side effects: usually none. **Stale sessions** trigger a best-effort
 * // delete of the .json + sidecars (auto-cleanup inside StateStore.load).
 * //
 * // Git refs / HEAD / shadow branches: unchanged.
 * ```
 */
export async function loadSessionState(
	sessionId: string,
	cwd?: string,
): Promise<SessionState | null> {
	const store = await makeStateStore(cwd);
	try {
		return await store.load(sessionId);
	} catch (err) {
		// Go: session_state.go:48-50 — `fmt.Errorf("failed to load session
		// state: %w", err)`. Audit-2 Fix C added the same wrap on the
		// class-method facade (manual-commit.ts loadSessionState); audit-3
		// Fix E mirrors it here so callers see one consistent error format
		// regardless of which entry point they used.
		throw new Error(
			`failed to load session state: ${err instanceof Error ? err.message : String(err)}`,
			{ cause: err as Error },
		);
	}
}

/**
 * Atomically save session state (temp file + rename — never leaves a
 * half-written file on disk).
 *
 * Mirrors Go `session_state.go:57-91` (`SaveSessionState`).
 *
 * @example
 * ```ts
 * await saveSessionState({
 *   sessionId: 'sess-1',
 *   baseCommit: 'abc1234',
 *   startedAt: new Date().toISOString(),
 *   phase: 'idle',
 *   stepCount: 0,
 * }, repoDir);
 * // returns: undefined
 *
 * // Side effects:
 * //   <repoDir>/.git/story-sessions/sess-1.json.<rand>   ← temp file (transient)
 * //   <repoDir>/.git/story-sessions/sess-1.json          ← atomic rename target
 * //
 * // Git refs / HEAD / worktree / index: unchanged.
 * //
 * // Failure mode: temp file is removed on rename failure; either the prior
 * // <id>.json survives intact, or the new one fully replaces it — no partial
 * // overwrite is observable.
 * ```
 */
export async function saveSessionState(state: SessionState, cwd?: string): Promise<void> {
	const store = await makeStateStore(cwd);
	await store.save(state);
}

/**
 * Remove all files for a session (`<id>.json` + sidecars like `<id>.model`).
 * No-op when the session was never persisted.
 *
 * Mirrors Go `session_state.go:271-289` (`ClearSessionState`).
 *
 * @example
 * ```ts
 * await clearSessionState('sess-1', repoDir);
 * // returns: undefined
 *
 * // Side effects (only when files existed on disk):
 * //   <repoDir>/.git/story-sessions/sess-1.json     ← removed
 * //   <repoDir>/.git/story-sessions/sess-1.model    ← removed (if present)
 * //   any other <repoDir>/.git/story-sessions/sess-1.<sidecar> ← removed
 * //
 * // Git refs / HEAD / worktree / shadow branches: unchanged.
 * ```
 */
export async function clearSessionState(sessionId: string, cwd?: string): Promise<void> {
	const store = await makeStateStore(cwd);
	await store.clear(sessionId);
}

/**
 * List all non-stale session states.
 *
 * Mirrors Go `session_state.go:95-106` (`ListSessionStates`). Note that this
 * is the **raw** list — the orphan filter (drop sessions with missing shadow
 * branches) lives in {@link listAllSessionStates}.
 *
 * @example
 * ```ts
 * await listSessionStates(repoDir);
 * // returns: SessionState[]   (every <id>.json in .git/story-sessions/, minus stale)
 * // returns: []                (no sessions, missing dir, or all stale)
 *
 * // Side effects: none aside from the auto-stale-cleanup that StateStore.list
 * // performs internally (best-effort delete of stale .json files).
 * //
 * // Git refs / HEAD / shadow branches: unchanged.
 * ```
 */
export async function listSessionStates(cwd?: string): Promise<SessionState[]> {
	const store = await makeStateStore(cwd);
	return store.list();
}

/**
 * Find the session ID with the most recent `lastInteractionTime`, scoped to
 * the current worktree. Falls back to all sessions when none match the
 * worktree (e.g., the user runs `story status` from a directory that wasn't
 * the original worktree). When `lastInteractionTime` is unset on every
 * candidate, falls back to `startedAt` ordering.
 *
 * Mirrors Go `session_state.go:112-156` (`FindMostRecentSession`). Returns
 * the empty string (`''`) when no sessions exist anywhere — callers treat
 * `''` as "no session found".
 *
 * @example
 * ```ts
 * await findMostRecentSession(repoDir);
 * // returns: 'sess-2024-01-31-abc'   (most recently active session in this worktree)
 * // returns: 'sess-other-worktree'   (fallback: when no session matches the current worktree)
 * // returns: ''                       (no sessions at all)
 *
 * // Side effects: none beyond what listSessionStates does (stale cleanup).
 * //
 * // Git refs / HEAD: unchanged.
 * ```
 */
export async function findMostRecentSession(cwd?: string): Promise<string> {
	const states = await listSessionStates(cwd);
	if (states.length === 0) {
		return '';
	}

	// Worktree filter — best-effort scope to current worktree.
	let candidates = states;
	try {
		const wt = await worktreeRoot(cwd);
		const filtered = states.filter((s) => s.worktreePath === wt);
		if (filtered.length > 0) {
			candidates = filtered;
		}
	} catch {
		// Use all states.
	}

	// Prefer lastInteractionTime; fall back to startedAt.
	let best: SessionState | undefined;
	for (const s of candidates) {
		if (!s.lastInteractionTime) {
			continue;
		}
		if (!best?.lastInteractionTime || s.lastInteractionTime > best.lastInteractionTime) {
			best = s;
		}
	}
	if (best) {
		return best.sessionId;
	}
	for (const s of candidates) {
		if (!best || s.startedAt > best.startedAt) {
			best = s;
		}
	}
	return best?.sessionId ?? '';
}

/**
 * Run a session phase {@link transition} and dispatch its actions via
 * {@link applyTransition}, then emit a single log line describing the
 * transition. Wraps and rethrows the first handler error (if any).
 *
 * Mirrors Go `session_state.go:158-198` (`TransitionAndLog`), which itself
 * delegates to `session.ApplyTransition`. Phase is set **before** any handler
 * runs (so handlers observe the new phase). Common actions
 * ({@link Action.UpdateLastInteraction}, {@link Action.ClearEndedAt}) always
 * apply, even after a strategy handler error; subsequent strategy handlers
 * are skipped on first error. See `applyTransition` for the precise
 * action-execution contract.
 *
 * **Why this is a thin shim over `applyTransition`**: Go's `TransitionAndLog`
 * is purely the logging wrapper around `ApplyTransition`. Re-implementing the
 * action loop here previously caused two divergences from Go:
 * (1) phase was mutated *after* handlers, and (2) common actions were silently
 * dropped (routed to `.otherwise(() => {})`), so `lastInteractionTime` was
 * never refreshed and `endedAt` / `fullyCondensed` were never cleared on
 * resume.
 *
 * @example
 * ```ts
 * await transitionAndLog(state, Event.GitCommit, ctx, {
 *   handleCondense: async (s) => { await strategy.condenseSession(s); },
 *   handleCondenseIfFilesTouched: async (s) => { ... },
 *   handleDiscardIfNoFiles: async (s) => { ... },
 *   handleWarnStaleSession: () => {},
 * });
 * // returns: undefined (resolves on success; throws when the first handler errors)
 *
 * // Side effects:
 * //   - state.phase mutated to result.newPhase BEFORE handlers run
 * //   - state.lastInteractionTime / endedAt / fullyCondensed mutated when the
 * //     transition emits Action.UpdateLastInteraction or Action.ClearEndedAt
 * //   - one log line: 'phase transition' (info) or 'phase unchanged' (debug)
 * //   - each scheduled strategy Action runs through the matching handler method
 * //   - on first handler error: an extra 'action handler error...' log line + rethrow
 * //
 * // **Disk / git refs / HEAD: unchanged unless the handler itself writes**
 * // (e.g., handleCondense persisting to the metadata branch).
 * ```
 */
export async function transitionAndLog(
	state: SessionState,
	event: Event,
	ctx: TransitionContext,
	handler: ActionHandler,
): Promise<void> {
	const oldPhase = state.phase;
	const result = transition(oldPhase, event, ctx);

	const logCtx = { component: 'session', sessionId: state.sessionId };

	let handlerErr: Error | null = null;
	try {
		await applyTransition(state, result, handler);
	} catch (err) {
		handlerErr = err as Error;
		log.error(logCtx, 'action handler error during transition', {
			event: eventLabel(event),
			error: handlerErr.message,
		});
	}

	if (result.newPhase !== oldPhase) {
		log.info(logCtx, 'phase transition', {
			event: eventLabel(event),
			from: oldPhase,
			to: result.newPhase,
		});
	} else {
		log.debug(logCtx, 'phase unchanged', {
			event: eventLabel(event),
			phase: result.newPhase,
			actions: result.actions,
		});
	}

	if (handlerErr !== null) {
		throw new Error(`transition ${eventLabel(event)}: ${handlerErr.message}`, {
			cause: handlerErr,
		});
	}
}

/**
 * Write the LLM model name to a sidecar file `<id>.model` so that hooks
 * which fire before SessionState exists (e.g., `SessionStart`) can stash
 * the model and `InitializeSession` can pick it up later.
 *
 * Mirrors Go `session_state.go:219-240` (`StoreModelHint`).
 *
 * Empty `model` is a silent no-op (Go parity); invalid `sessionId` throws.
 *
 * @example
 * ```ts
 * await storeModelHint('abc-123', 'claude-sonnet-4-20250514', repoDir);
 * // returns: undefined
 *
 * // Side effects:
 * //   <repoDir>/.git/story-sessions/                  ← created (mode 0750) if missing
 * //   <repoDir>/.git/story-sessions/abc-123.model     ← 'claude-sonnet-4-20250514' (mode 0600)
 * //
 * // The .json state file (`abc-123.json`), git refs, HEAD, worktree: unchanged.
 *
 * await storeModelHint('abc-123', '', repoDir);
 * // returns: undefined  (no-op, no file created)
 * ```
 */
export async function storeModelHint(
	sessionId: string,
	model: string,
	cwd?: string,
): Promise<void> {
	const err = validateSessionId(sessionId);
	if (err) {
		throw err;
	}
	if (model === '') {
		return;
	}
	const commonDir = await getGitCommonDir(cwd);
	const stateDir = path.join(commonDir, SESSION_STATE_DIR_NAME);
	await fs.mkdir(stateDir, { recursive: true, mode: 0o750 });
	const hintFile = path.join(stateDir, `${sessionId}.model`);
	await fs.writeFile(hintFile, model, { mode: 0o600 });
}

/**
 * Read the LLM model hint for a session. Returns empty string when the
 * hint file doesn't exist or `sessionId` fails validation (defensive: never
 * throws on bad input — callers always get the "no hint" sentinel).
 *
 * Mirrors Go `session_state.go:244-268` (`LoadModelHint`).
 *
 * @example
 * ```ts
 * await loadModelHint('sess-1', repoDir);
 * // returns: 'claude-sonnet-4-20250514' if the hint file exists
 * // returns: ''                          if the file is missing
 *
 * // Side effects: none — read-only access to .git/story-sessions/<id>.model
 * //
 * // Git refs / HEAD / worktree / state file (.json): unchanged.
 * ```
 */
export async function loadModelHint(sessionId: string, cwd?: string): Promise<string> {
	const err = validateSessionId(sessionId);
	if (err) {
		return '';
	}
	const commonDir = await getGitCommonDir(cwd);
	const hintFile = path.join(commonDir, SESSION_STATE_DIR_NAME, `${sessionId}.model`);
	try {
		const data = await fs.readFile(hintFile, 'utf-8');
		return data.trim();
	} catch {
		return '';
	}
}
