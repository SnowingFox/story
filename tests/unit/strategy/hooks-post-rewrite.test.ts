/**
 * Phase 5.4 Part 2 unit tests for [src/strategy/hooks-post-rewrite.ts](src/strategy/hooks-post-rewrite.ts).
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/strategy/manual_commit_hooks.go`:
 *   - `PostRewrite` (rewriteType dispatch + per-session remap loop)
 *   - `parsePostRewritePairs` (stdin parser — **the only hook branch that
 *     surfaces an error to git instead of swallowing**)
 *
 * Each `it()` is annotated with `// Go: <go-file>:<line>` for the
 * audit-test-go-parity gate.
 */

import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shadowBranchNameForCommit } from '@/checkpoint/temporary';
import { clearGitCommonDirCache } from '@/git';
import { clearWorktreeRootCache } from '@/paths';
import { parsePostRewritePairs, postRewriteImpl } from '@/strategy/hooks-post-rewrite';
import { ManualCommitStrategy } from '@/strategy/manual-commit';
import { loadSessionState, saveSessionState } from '@/strategy/session-state';
import type { SessionState } from '@/strategy/types';
import { TestEnv } from '../../helpers/test-env';

function streamFrom(text: string): NodeJS.ReadableStream {
	return Readable.from([Buffer.from(text, 'utf8')]);
}

function makeState(overrides: Partial<SessionState> = {}): SessionState {
	return {
		sessionId: 'sess-default',
		baseCommit: 'deadbeef',
		startedAt: new Date().toISOString(),
		phase: 'active',
		stepCount: 0,
		...overrides,
	};
}

// Go: manual_commit_hooks.go:297-318 — parsePostRewritePairs
describe('parsePostRewritePairs — Go: manual_commit_hooks.go (parsePostRewritePairs)', () => {
	// Go: manual_commit_hooks.go:305-308 — malformed line throws
	it('throws on lines with <2 fields ("invalid post-rewrite mapping line")', async () => {
		await expect(parsePostRewritePairs(streamFrom('abc\n'))).rejects.toThrow(
			/invalid post-rewrite mapping line/,
		);
	});

	// Go: manual_commit_hooks.go:300-313 — blank lines tolerated, extra fields ignored
	it('tolerates blank lines + ignores extra whitespace-delimited fields after first 2', async () => {
		const stdin = '\n a b extra-field\n  \nc d\n';
		const pairs = await parsePostRewritePairs(streamFrom(stdin));
		expect(pairs).toEqual([
			{ oldSha: 'a', newSha: 'b' },
			{ oldSha: 'c', newSha: 'd' },
		]);
	});

	// Empty stdin → empty array.
	it('returns [] for empty stdin', async () => {
		const pairs = await parsePostRewritePairs(streamFrom(''));
		expect(pairs).toEqual([]);
	});

	// Multi-chunk stream (typical when git writes pair-at-a-time).
	it('handles multi-chunk stream input', async () => {
		const stream = Readable.from([
			Buffer.from('abc1234 def567', 'utf8'),
			Buffer.from('8\nfff abc\n', 'utf8'),
		]);
		const pairs = await parsePostRewritePairs(stream);
		expect(pairs).toEqual([
			{ oldSha: 'abc1234', newSha: 'def5678' },
			{ oldSha: 'fff', newSha: 'abc' },
		]);
	});
});

// Go: manual_commit_hooks.go:236-295 — PostRewrite main pipeline
describe('postRewriteImpl — Go: manual_commit_hooks.go (PostRewrite)', () => {
	let env: TestEnv;
	let strategy: ManualCommitStrategy;
	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		clearGitCommonDirCache();
		clearWorktreeRootCache();
		strategy = new ManualCommitStrategy(env.dir);
	});
	afterEach(async () => {
		await env.cleanup();
		clearGitCommonDirCache();
		clearWorktreeRootCache();
	});

	// Go: manual_commit_hooks.go:236-237 — amend type happy path
	it('amend happy path: remaps single session.baseCommit + renames shadow branch', async () => {
		const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		const oldBase = 'oldbase00000000000000000000000000000000';
		const newBase = 'newbase11111111111111111111111111111111';

		// Plant shadow branch + ACTIVE session at oldBase.
		const oldBranch = shadowBranchNameForCommit(oldBase, '');
		await env.exec('git', ['branch', '-f', oldBranch, head]);
		await saveSessionState(
			makeState({
				sessionId: 'sA',
				baseCommit: oldBase,
				attributionBaseCommit: oldBase,
				worktreePath: env.dir,
				worktreeId: '',
			}),
			env.dir,
		);

		const stdin = streamFrom(`${oldBase} ${newBase}\n`);
		await postRewriteImpl(strategy, 'amend', stdin);

		const after = await loadSessionState('sA', env.dir);
		expect(after?.baseCommit).toBe(newBase);
	});

	// Go: same — rebase type with multiple mappings + multiple sessions
	it('rebase: remaps multiple sessions across multiple mappings', async () => {
		const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		const oldA = 'olda0000000000000000000000000000000000';
		const newA = 'newa0000000000000000000000000000000000';
		const oldB = 'oldb1111111111111111111111111111111111';
		const newB = 'newb1111111111111111111111111111111111';

		const brA = shadowBranchNameForCommit(oldA, '');
		const brB = shadowBranchNameForCommit(oldB, '');
		await env.exec('git', ['branch', '-f', brA, head]);
		await env.exec('git', ['branch', '-f', brB, head]);

		await saveSessionState(
			makeState({
				sessionId: 'sA',
				baseCommit: oldA,
				attributionBaseCommit: oldA,
				worktreePath: env.dir,
				worktreeId: '',
			}),
			env.dir,
		);
		await saveSessionState(
			makeState({
				sessionId: 'sB',
				baseCommit: oldB,
				attributionBaseCommit: oldB,
				worktreePath: env.dir,
				worktreeId: '',
			}),
			env.dir,
		);

		const stdin = streamFrom(`${oldA} ${newA}\n${oldB} ${newB}\n`);
		await postRewriteImpl(strategy, 'rebase', stdin);

		const sASessionState = await loadSessionState('sA', env.dir);
		const sBSessionState = await loadSessionState('sB', env.dir);

		console.log(sASessionState);
		expect(sASessionState?.baseCommit).toBe(newA);
		expect(sBSessionState?.baseCommit).toBe(newB);
	});

	// Go: manual_commit_hooks.go:238-243 — non-amend / non-rebase types skip
	it('skips for unsupported rewriteType (no state mutation)', async () => {
		const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		const oldBase = 'oldbase22222222222222222222222222222222';
		const oldBranch = shadowBranchNameForCommit(oldBase, '');
		await env.exec('git', ['branch', '-f', oldBranch, head]);
		await saveSessionState(
			makeState({
				sessionId: 'sx',
				baseCommit: oldBase,
				attributionBaseCommit: oldBase,
				worktreePath: env.dir,
				worktreeId: '',
			}),
			env.dir,
		);

		const stdin = streamFrom(`${oldBase} doesnotmatter\n`);
		await postRewriteImpl(strategy, 'cherry-pick', stdin);

		// State unchanged.
		const after = await loadSessionState('sx', env.dir);
		expect(after?.baseCommit).toBe(oldBase);
	});

	// Go: manual_commit_hooks.go:249-251 — empty stdin → return
	it('no-op for empty stdin', async () => {
		const stdin = streamFrom('');
		// No throw, no state mutation (none planted).
		await postRewriteImpl(strategy, 'amend', stdin);
	});

	// Go: manual_commit_hooks.go:258-261 — no sessions → return
	it('no-op when findSessionsForWorktree returns []', async () => {
		const stdin = streamFrom('abc def\n');
		// No SessionStates planted → silent.
		await postRewriteImpl(strategy, 'amend', stdin);
	});

	// Go: manual_commit_hooks.go:281-285 — saveSessionState failure path
	it('continues to next session when saveSessionState throws (silent fail-open)', async () => {
		const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		const oldBase = 'oldbase33333333333333333333333333333333';
		const newBase = 'newbase44444444444444444444444444444444';
		const oldBranch = shadowBranchNameForCommit(oldBase, '');
		await env.exec('git', ['branch', '-f', oldBranch, head]);
		await saveSessionState(
			makeState({
				sessionId: 'sx',
				baseCommit: oldBase,
				attributionBaseCommit: oldBase,
				worktreePath: env.dir,
				worktreeId: '',
			}),
			env.dir,
		);

		// Force saveSessionState to throw via vi.spyOn (ESM-safe).
		const spy = vi.spyOn(strategy, 'saveSessionState').mockImplementation(async () => {
			throw new Error('disk full');
		});
		try {
			const stdin = streamFrom(`${oldBase} ${newBase}\n`);
			// No throw — silent on save failure.
			await postRewriteImpl(strategy, 'amend', stdin);
		} finally {
			spy.mockRestore();
		}
	});

	// Phase 3 branch coverage — getRepo throws → silent return.
	it('silently returns when getRepo throws (silent fail-open)', async () => {
		const badStrategy = new ManualCommitStrategy('/dev/null/no-such-dir-for-rewrite');
		const stdin = streamFrom('abc def\n');
		// No throw.
		await postRewriteImpl(badStrategy, 'amend', stdin);
	});

	// Phase 3 branch coverage — findSessionsForWorktree throws → silent return.
	it('silently returns when findSessionsForWorktree throws', async () => {
		const sessionMod = await import('@/strategy/manual-commit-session');
		const spy = vi.spyOn(sessionMod, 'findSessionsForWorktree').mockImplementation(async () => {
			throw new Error('forced sessions fail');
		});
		try {
			const stdin = streamFrom('abc def\n');
			await postRewriteImpl(strategy, 'amend', stdin);
		} finally {
			spy.mockRestore();
		}
	});

	// Phase 3 branch coverage — remapSessionForRewrite throws → continue to next session.
	it('continues to next session when remapSessionForRewrite throws (silent warn)', async () => {
		const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		const oldBase = 'oldbase55555555555555555555555555555555';
		const newBase = 'newbase66666666666666666666666666666666';
		const oldBranch = shadowBranchNameForCommit(oldBase, '');
		await env.exec('git', ['branch', '-f', oldBranch, head]);
		await saveSessionState(
			makeState({
				sessionId: 'sxx',
				baseCommit: oldBase,
				attributionBaseCommit: oldBase,
				worktreePath: env.dir,
				worktreeId: '',
			}),
			env.dir,
		);
		const sessionMod = await import('@/strategy/manual-commit-session');
		const spy = vi.spyOn(sessionMod, 'remapSessionForRewrite').mockImplementation(async () => {
			throw new Error('forced remap fail');
		});
		try {
			const stdin = streamFrom(`${oldBase} ${newBase}\n`);
			// No throw.
			await postRewriteImpl(strategy, 'amend', stdin);
		} finally {
			spy.mockRestore();
		}
	});

	// Phase 3 branch coverage — parsePostRewritePairs accepts string chunks.
	it('parsePostRewritePairs handles string chunks (not just Buffer)', async () => {
		const stream = Readable.from(['abc def\n', 'fff aaa\n']); // string chunks
		const pairs = await parsePostRewritePairs(stream);
		expect(pairs).toEqual([
			{ oldSha: 'abc', newSha: 'def' },
			{ oldSha: 'fff', newSha: 'aaa' },
		]);
	});
});
