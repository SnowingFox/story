/**
 * Phase 5.2 Todo 2 — `save-step-helpers.ts` unit tests.
 *
 * Three small helpers consumed by SaveStep / SaveTaskStep (Phase 5.2 Todo 5)
 * and by Phase 5.5 ResetSession (`deleteShadowBranch`).
 *
 * Go references:
 * - `manual_commit_git.go:317-339` `mergeFilesTouched` (no direct *_test.go;
 *   indirectly exercised via TestSaveStep_* which constructs StepContexts and
 *   inspects `state.FilesTouched` afterwards)
 * - `manual_commit_git.go:341-372` `accumulateTokenUsage` (same — indirect)
 * - `manual_commit_git.go:378-388` `deleteShadowBranch` + Go test
 *   `manual_commit_test.go:1269-1311` `TestDeleteShadowBranch` /
 *   `:1313-1328` `TestDeleteShadowBranch_NonExistent`
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearGitCommonDirCache } from '@/git';
import { clearWorktreeRootCache } from '@/paths';
import {
	accumulateTokenUsage,
	deleteShadowBranch,
	mergeFilesTouched,
} from '@/strategy/save-step-helpers';
import type { TokenUsage } from '@/strategy/types';
import { TestEnv } from '../../helpers/test-env';

// Go: manual_commit_git.go:319-339 mergeFilesTouched
describe('mergeFilesTouched — Go: manual_commit_git.go:319-339', () => {
	// Go: manual_commit_git.go:336-337 — sort.Strings makes output deterministic
	it('dedupes and sorts lexicographically', () => {
		expect(mergeFilesTouched(['b'], ['a', 'b'], ['c'])).toEqual(['a', 'b', 'c']);
	});

	// Go: manual_commit_git.go:322-328 — filepath.ToSlash on every entry
	it('normalizes backslashes to forward slashes', () => {
		expect(mergeFilesTouched([], ['src\\foo.ts'])).toEqual(['src/foo.ts']);
	});

	// Go: manual_commit_git.go:336 — empty `seen` returns empty slice (cap 0)
	it('returns empty array for all-empty inputs', () => {
		expect(mergeFilesTouched([], [], [])).toEqual([]);
	});

	// Go: filepath.ToSlash is case-preserving — 'a/b' and 'A/B' both kept
	it('dedupes case-sensitively across normalized paths', () => {
		expect(mergeFilesTouched(['a/b'], ['A/B'])).toEqual(['A/B', 'a/b']);
	});
});

function makeUsage(overrides: Partial<TokenUsage> = {}): TokenUsage {
	return {
		inputTokens: 0,
		cacheCreationTokens: 0,
		cacheReadTokens: 0,
		outputTokens: 0,
		apiCallCount: 0,
		...overrides,
	};
}

// Go: manual_commit_git.go:343-372 accumulateTokenUsage
describe('accumulateTokenUsage — Go: manual_commit_git.go:343-372', () => {
	// Go: manual_commit_git.go:344-346 — incoming nil → return existing unchanged (no copy)
	it('returns existing unchanged when incoming is null', () => {
		const existing = makeUsage({ inputTokens: 10, outputTokens: 5 });
		const result = accumulateTokenUsage(existing, null);
		expect(result).toBe(existing);
	});

	// Go: manual_commit_git.go:347-357 — existing nil → new struct + per-field
	// copy of numeric scalars + SHALLOW assign of SubagentTokens (the Go code
	// reuses the incoming pointer; nested tree is shared with `incoming`).
	it('returns new wrapper when existing is null but shallow-shares subagentTokens reference (Go parity)', () => {
		const incomingSub = makeUsage({ inputTokens: 7 });
		const incoming = makeUsage({
			inputTokens: 5,
			outputTokens: 3,
			apiCallCount: 1,
			subagentTokens: incomingSub,
		});
		const result = accumulateTokenUsage(null, incoming);
		// Top-level wrapper is a new object (not the same reference as incoming),
		// matching Go's `return &agent.TokenUsage{...}` allocation.
		expect(result).not.toBe(incoming);
		expect(result).toMatchObject({
			inputTokens: 5,
			cacheCreationTokens: 0,
			cacheReadTokens: 0,
			outputTokens: 3,
			apiCallCount: 1,
		});
		// Top-level numeric fields are independent: mutating result does not affect incoming.
		if (result) {
			result.inputTokens = 999;
		}
		expect(incoming.inputTokens).toBe(5);
		// CRITICAL Go-parity check: `subagentTokens` is the SAME REFERENCE
		// (Go assigns `SubagentTokens: incoming.SubagentTokens` — a pointer copy,
		// not a deep recursion). Mutations on the nested struct propagate.
		expect(result?.subagentTokens).toBe(incomingSub);
		if (result?.subagentTokens) {
			result.subagentTokens.inputTokens = 1234;
		}
		expect(incomingSub.inputTokens).toBe(1234);
	});

	// Go: manual_commit_git.go:359-364 — adds field-wise into existing (mutates)
	it('adds field-wise into existing (mutates existing per Go pointer semantics)', () => {
		const existing = makeUsage({
			inputTokens: 10,
			cacheCreationTokens: 2,
			cacheReadTokens: 3,
			outputTokens: 4,
			apiCallCount: 1,
		});
		const incoming = makeUsage({
			inputTokens: 5,
			cacheCreationTokens: 1,
			cacheReadTokens: 7,
			outputTokens: 2,
			apiCallCount: 3,
		});
		const result = accumulateTokenUsage(existing, incoming);
		expect(result).toBe(existing);
		expect(existing).toEqual(
			makeUsage({
				inputTokens: 15,
				cacheCreationTokens: 3,
				cacheReadTokens: 10,
				outputTokens: 6,
				apiCallCount: 4,
			}),
		);
	});

	// Go: manual_commit_git.go:366-369 — both non-nil: recurse into subagentTokens
	// (existing has none yet → take incoming's pointer via the shallow-assign branch
	// inside the recursion). Existing’s subagentTokens ends up populated.
	it('recurses into subagentTokens when incoming has subagentTokens (existing.subagentTokens was null)', () => {
		const existing = makeUsage({ inputTokens: 10 });
		const incomingSub = makeUsage({ inputTokens: 5, outputTokens: 7 });
		const incoming = makeUsage({ inputTokens: 0, subagentTokens: incomingSub });
		accumulateTokenUsage(existing, incoming);
		expect(existing.subagentTokens).toMatchObject({ inputTokens: 5, outputTokens: 7 });
		// Go shallow-assigns when existing's nested side is null/missing — wrapper
		// is a fresh struct but shares subagentTokens with incoming via the
		// recursive call entering the `existing == nil` branch.
		expect(existing.subagentTokens).not.toBe(incoming);
	});

	// Go: manual_commit_git.go:366-369 — both subagent trees non-nil → field-wise add
	it('mutates existing.subagentTokens field-wise when both subagent trees non-null', () => {
		const existingSub = makeUsage({ inputTokens: 10, outputTokens: 20 });
		const existing = makeUsage({ inputTokens: 1, subagentTokens: existingSub });
		const incoming = makeUsage({
			inputTokens: 0,
			subagentTokens: makeUsage({ inputTokens: 5, outputTokens: 7 }),
		});
		accumulateTokenUsage(existing, incoming);
		expect(existing.subagentTokens).toBe(existingSub); // mutated in place
		expect(existingSub.inputTokens).toBe(15);
		expect(existingSub.outputTokens).toBe(27);
	});
});

// Go: manual_commit_git.go:378-388 deleteShadowBranch
// Go: manual_commit_test.go:1269-1311 TestDeleteShadowBranch
// Go: manual_commit_test.go:1313-1328 TestDeleteShadowBranch_NonExistent
describe('deleteShadowBranch — Go: manual_commit_git.go:378-388', () => {
	let env: TestEnv;
	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		clearGitCommonDirCache();
		clearWorktreeRootCache();
	});
	afterEach(async () => {
		await env.cleanup();
		clearGitCommonDirCache();
		clearWorktreeRootCache();
	});

	// Go: manual_commit_test.go:1269-1311 TestDeleteShadowBranch
	it('removes an existing shadow branch', async () => {
		const branch = 'story/abc1234-e3b0c4';
		const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		await env.exec('git', ['branch', '-f', branch, head]);
		// Sanity: branch exists
		const before = await env.exec('git', ['branch', '--list', branch]);
		expect(before.stdout.includes(branch)).toBe(true);

		await deleteShadowBranch(branch, env.dir);

		const after = await env.exec('git', ['branch', '--list', branch]);
		expect(after.stdout.trim()).toBe('');
	});

	// Go: manual_commit_test.go:1313-1328 TestDeleteShadowBranch_NonExistent
	it('is idempotent for missing branch (silently swallows ErrBranchNotFound)', async () => {
		await expect(
			deleteShadowBranch('story/nonexistent-deadbeef', env.dir),
		).resolves.toBeUndefined();
	});
});
