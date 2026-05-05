/**
 * Pure helpers used by Phase 5.2 SaveStep / SaveTaskStep, plus the
 * idempotent `deleteShadowBranch` that Phase 5.5 ResetSession also calls.
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/strategy/manual_commit_git.go`
 * (functions at the file tail: `mergeFilesTouched` 317-339,
 * `accumulateTokenUsage` 341-372, `deleteShadowBranch` 378-388).
 *
 * Mutation policy (matches Go): `accumulateTokenUsage` mutates `existing`
 * in place when both inputs are non-null; the user explicitly chose Go
 * parity over an immutable rewrite (see [`phase-5.2/impl.md` 边缘场景
 * §accumulateTokenUsage](../../docs/ts-rewrite/impl/phase-5-strategy/phase-5.2-save-step/impl.md)).
 *
 * @packageDocumentation
 */

import { deleteBranchCli, ErrBranchNotFound } from './branches';
import type { TokenUsage } from './types';

/**
 * Merge multiple file lists into the existing `filesTouched` set, normalizing
 * paths to forward slashes (cross-platform parity with Go `filepath.ToSlash`),
 * deduping via `Set`, and sorting lexicographically for deterministic output.
 *
 * Mirrors Go `manual_commit_git.go:319-339` (`mergeFilesTouched`).
 *
 * @example
 * mergeFilesTouched(['a.ts'], ['b.ts', 'a.ts'], ['c.ts'])
 * // => ['a.ts', 'b.ts', 'c.ts']
 *
 * mergeFilesTouched([], ['src\\foo.ts'])
 * // => ['src/foo.ts']
 */
export function mergeFilesTouched(existing: string[], ...fileLists: string[][]): string[] {
	const seen = new Set<string>();
	for (const f of existing) {
		seen.add(toForwardSlash(f));
	}
	for (const list of fileLists) {
		for (const f of list) {
			seen.add(toForwardSlash(f));
		}
	}
	return [...seen].sort();
}

/**
 * Replace `\` with `/` for cross-platform path normalization. Equivalent to
 * Go `filepath.ToSlash` (no-op on Linux/macOS; Windows turns `\` into `/`).
 * Does **not** resolve `..` / `.` segments — pure character replacement.
 */
function toForwardSlash(p: string): string {
	return p.replace(/\\/g, '/');
}

/**
 * Accumulate token usage. Three branches:
 * - `incoming === null` → return `existing` unchanged (no copy)
 * - `existing === null && incoming != null` → allocate a new wrapper, copy the
 *   numeric scalar fields, and **shallow-assign** `subagentTokens` (Go
 *   `manual_commit_git.go:347-356` constructs `&agent.TokenUsage{...,
 *   SubagentTokens: incoming.SubagentTokens}` — a pointer copy, NOT a deep
 *   recursion). Mutations on the nested struct propagate to / from `incoming`.
 * - both non-null → field-wise add into `existing` (mutates), recurse into
 *   `subagentTokens` when present.
 *
 * Mirrors Go `manual_commit_git.go:343-372` (`accumulateTokenUsage`).
 *
 * @example
 * accumulateTokenUsage(null, null)                      // null
 * accumulateTokenUsage({ inputTokens: 10, ... }, null)  // same reference, unchanged
 * accumulateTokenUsage(null, t)                         // new wrapper, t.subagentTokens shared
 * accumulateTokenUsage({ inputTokens: 10, ... }, { inputTokens: 5, ... })
 * //                                                    // existing.inputTokens === 15 (mutated)
 */
export function accumulateTokenUsage(
	existing: TokenUsage | null,
	incoming: TokenUsage | null,
): TokenUsage | null {
	if (incoming == null) {
		return existing;
	}
	if (existing == null) {
		// Shallow-assign subagentTokens (Go pointer copy semantics; see header).
		return {
			inputTokens: incoming.inputTokens,
			cacheCreationTokens: incoming.cacheCreationTokens,
			cacheReadTokens: incoming.cacheReadTokens,
			outputTokens: incoming.outputTokens,
			apiCallCount: incoming.apiCallCount,
			subagentTokens: incoming.subagentTokens ?? null,
		};
	}
	existing.inputTokens += incoming.inputTokens;
	existing.cacheCreationTokens += incoming.cacheCreationTokens;
	existing.cacheReadTokens += incoming.cacheReadTokens;
	existing.outputTokens += incoming.outputTokens;
	existing.apiCallCount += incoming.apiCallCount;
	if (incoming.subagentTokens != null) {
		existing.subagentTokens = accumulateTokenUsage(
			existing.subagentTokens ?? null,
			incoming.subagentTokens,
		);
	}
	return existing;
}

/**
 * Idempotent shadow-branch delete. Wraps {@link deleteBranchCli} (Phase 5.1)
 * and silently absorbs the `ErrBranchNotFound` sentinel; all other errors
 * propagate. Used by SaveStep cleanup paths and Phase 5.5 ResetSession.
 *
 * Mirrors Go `manual_commit_git.go:378-388` (`deleteShadowBranch`).
 *
 * @example
 * await deleteShadowBranch('story/abc1234-e3b0c4', '/path/to/repo');
 *
 * // Side effects (when the branch existed):
 * //   .git/refs/heads/story/abc1234-e3b0c4 ← removed
 * //   .git/packed-refs                     ← updated when the ref was packed
 * //
 * // When the branch is absent: no side effects, resolves successfully.
 * // Worktree / index / HEAD: never touched.
 */
export async function deleteShadowBranch(branchName: string, repoDir?: string): Promise<void> {
	try {
		await deleteBranchCli(branchName, repoDir);
	} catch (err) {
		if (err === ErrBranchNotFound) {
			return;
		}
		throw err;
	}
}
