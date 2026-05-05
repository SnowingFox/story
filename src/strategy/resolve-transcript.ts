/**
 * Agent-aware transcript path resolution. Handles the case where an agent
 * relocates its transcript file mid-session (e.g., Cursor switching from
 * flat `<dir>/<id>.jsonl` to nested `<dir>/<id>/<id>.jsonl`).
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/strategy/resolve_transcript.go:23-62`.
 *
 * **Wiring**: a module-level resolver hook ({@link setAgentSessionFileResolver})
 * is installed at CLI startup by [`@/cli`](../cli.ts) — the resolver delegates
 * to the agent registry (`registry.getByAgentType(agentType)?.resolveSessionFile`).
 * In tests / non-CLI entry points without that wiring, the resolver remains
 * `null` and re-resolution attempts throw ENOENT (test fixtures that need
 * agent-aware resolution must call `setAgentSessionFileResolver(...)` directly).
 *
 * @packageDocumentation
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { Awaitable } from '@/agent/interfaces';
import type { SessionState } from './types';

/**
 * Function signature Phase 6.1 must satisfy to wire agent-aware path
 * resolution into this module. Given a session directory + agent session ID
 * (extracted from the original transcript path), returns the path the agent
 * **currently** stores its transcript at.
 *
 * Returns {@link Awaitable} because some agents (Cursor) need to stat the
 * filesystem; others (Claude Code, Vogon) compute the path purely. Sync
 * resolvers just `return path.join(...)` without `async`; the call site
 * always uses `await`.
 *
 * @example
 * // Phase 6.3 Cursor resolver (real I/O):
 * const cursorResolver: AgentSessionFileResolver = async (agentType, dir, id) => {
 *   if (agentType !== 'Cursor') return null;
 *   const stat = await fs.stat(...);
 *   return ...;
 * };
 *
 * // Phase 6.2 Claude Code resolver (pure):
 * const claudeResolver: AgentSessionFileResolver = (agentType, dir, id) =>
 *   agentType === 'Claude Code' ? path.join(dir, `${id}.jsonl`) : null;
 */
export type AgentSessionFileResolver = (
	agentType: string,
	sessionDir: string,
	agentSessionId: string,
) => Awaitable<string | null>;

let agentResolver: AgentSessionFileResolver | null = null;

/**
 * Install the global agent session file resolver. Called by `@/cli` at
 * startup (Phase 6.1 Part 1 wired the call site); subsequent calls replace
 * the previous resolver. Pass `null` to clear (tests).
 *
 * When unset, attempts to re-resolve a missing transcript throw ENOENT
 * instead of doing agent-aware path lookup.
 */
export function setAgentSessionFileResolver(resolver: AgentSessionFileResolver | null): void {
	agentResolver = resolver;
}

/**
 * Returns the current path to the session's transcript file, doing
 * agent-aware re-resolution on ENOENT.
 *
 * Algorithm:
 * 1. **Fast path**: if `state.transcriptPath` exists on disk, return it.
 * 2. **Re-resolve on ENOENT**: derive `sessionDir` + `agentSessionId` from
 *    the stored path, call {@link AgentSessionFileResolver}; if it returns a
 *    different existing path, **mutate `state.transcriptPath`** to that path
 *    (so subsequent reads skip resolution) and return.
 * 3. **Non-ENOENT errors propagate** without re-resolving.
 *
 * Mirrors Go `resolve_transcript.go:23-62` (`ResolveTranscriptPath`).
 *
 * @example
 * ```ts
 * // Resolver not wired (tests / standalone entry points):
 * await resolveTranscriptPath({ transcriptPath: '/exists.jsonl', ... });
 * // returns: '/exists.jsonl'   (fast path, no resolver consulted)
 *
 * await resolveTranscriptPath({ transcriptPath: '/missing.jsonl', agentType: 'Cursor', ... });
 * // throws: Error with code='ENOENT'   (no resolver installed)
 *
 * // Side effects (fast path / no-resolver throw branch): none — stat() only.
 * //
 * // Disk / git refs / HEAD / state.transcriptPath: unchanged.
 * ```
 *
 * @example
 * ```ts
 * // Resolver wired for Cursor (Phase 6.1+ via @/cli or test setup):
 * setAgentSessionFileResolver((agent, dir, id) =>
 *   agent === 'Cursor' ? `${dir}/${id}/${id}.jsonl` : null,
 * );
 * const state = { transcriptPath: '/sessions/abc.jsonl', agentType: 'Cursor', ... };
 * await resolveTranscriptPath(state);
 * // returns: '/sessions/abc/abc.jsonl' (re-resolved)
 *
 * // Side effects (re-resolution branch):
 * //   - state.transcriptPath ← '/sessions/abc/abc.jsonl'   (in-memory mutation)
 * //
 * // Disk / git refs / HEAD: unchanged. The transcript file itself is NEVER
 * // moved or rewritten by this function — it only updates the in-memory
 * // pointer to where the file already lives.
 * ```
 */
export async function resolveTranscriptPath(state: SessionState): Promise<string> {
	if (!state.transcriptPath || state.transcriptPath === '') {
		throw new Error('no transcript path in session state');
	}

	// Fast path: file exists at stored location.
	try {
		await fs.stat(state.transcriptPath);
		return state.transcriptPath;
	} catch (err) {
		if ((err as { code?: string }).code !== 'ENOENT') {
			throw new Error(
				`failed to access transcript: ${err instanceof Error ? err.message : String(err)}`,
				{ cause: err as Error },
			);
		}
		// Fall through to re-resolution.
	}

	// Re-resolution requires both a resolver (wired by @/cli at startup) and
	// a non-empty agentType. When either is missing, treat as a genuine ENOENT.
	if (agentResolver === null || !state.agentType) {
		const err = new Error(`transcript not found at ${state.transcriptPath}`);
		(err as NodeJS.ErrnoException).code = 'ENOENT';
		throw err;
	}

	const sessionDir = path.dirname(state.transcriptPath);
	const base = path.basename(state.transcriptPath);
	const agentSessionId = base.replace(/\.[^.]+$/, '');

	const resolved = await agentResolver(state.agentType, sessionDir, agentSessionId);
	if (resolved === null || resolved === state.transcriptPath) {
		// Resolver doesn't know the agent OR returned the same path → genuine ENOENT.
		const err = new Error(`transcript not found at ${state.transcriptPath}`);
		(err as NodeJS.ErrnoException).code = 'ENOENT';
		throw err;
	}

	try {
		await fs.stat(resolved);
	} catch {
		const err = new Error(
			`transcript not found at ${state.transcriptPath} (also tried ${resolved})`,
		);
		(err as NodeJS.ErrnoException).code = 'ENOENT';
		throw err;
	}

	// Side effect: update state so subsequent reads use the new path.
	state.transcriptPath = resolved;
	return resolved;
}
