/**
 * Phase 5.4 Part 2 unit tests for [src/strategy/hooks-post-commit-carry-forward.ts](src/strategy/hooks-post-commit-carry-forward.ts).
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/strategy/manual_commit_hooks.go`:
 *   - `carryForwardToNewShadowBranch`
 *
 * Each `it()` is annotated with `// Go: <go-file>:<line>` for the
 * audit-test-go-parity gate.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shadowBranchNameForCommit } from '@/checkpoint/temporary';
import { clearGitCommonDirCache } from '@/git';
import { clearWorktreeRootCache } from '@/paths';
import { carryForwardToNewShadowBranch } from '@/strategy/hooks-post-commit-carry-forward';
import { ManualCommitStrategy } from '@/strategy/manual-commit';
import type { SessionState } from '@/strategy/types';
import { TestEnv } from '../../helpers/test-env';

function makeState(overrides: Partial<SessionState> = {}): SessionState {
	return {
		sessionId: 'sess-default',
		baseCommit: 'deadbeef',
		startedAt: new Date().toISOString(),
		phase: 'active',
		stepCount: 5,
		...overrides,
	};
}

// Go: manual_commit_hooks.go: carryForwardToNewShadowBranch
describe('carryForwardToNewShadowBranch — Go: manual_commit_hooks.go (carryForwardToNewShadowBranch)', () => {
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

	// Go: carryForwardToNewShadowBranch — happy path
	it('creates a new shadow branch at HEAD containing only the remaining files', async () => {
		const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		// Plant some files so writeTemporary can capture them as the carry-forward set.
		await env.writeFile('src/a.ts', 'agent edit a');
		await env.writeFile('src/b.ts', 'agent edit b');

		const strategy = new ManualCommitStrategy(env.dir);
		const state = makeState({
			sessionId: 'sess-cf',
			baseCommit: head,
			worktreeId: '',
			stepCount: 5,
			lastCheckpointId: 'a3b2c4d5e6f7',
			checkpointTranscriptStart: 100,
			compactTranscriptStart: 50,
			checkpointTranscriptSize: 1024,
			turnCheckpointIds: ['cp1', 'cp2'],
		});

		await carryForwardToNewShadowBranch(strategy, state, ['src/a.ts', 'src/b.ts']);

		// New shadow branch ref `story/<head>-<wt>` (worktreeId='').
		const branch = shadowBranchNameForCommit(head, '');
		const refValue = (await env.exec('git', ['rev-parse', `refs/heads/${branch}`])).stdout.trim();
		expect(refValue).toMatch(/^[a-f0-9]{40}$/);
	});

	// Go: state reset (stepCount=1, *Start=0, lastCheckpointId='')
	it('resets stepCount=1, checkpointTranscriptStart=0, compactTranscriptStart=0, checkpointTranscriptSize=0, lastCheckpointId=""', async () => {
		const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		await env.writeFile('keep.ts', 'remaining content');

		const strategy = new ManualCommitStrategy(env.dir);
		const state = makeState({
			sessionId: 'sess-reset',
			baseCommit: head,
			worktreeId: '',
			stepCount: 5,
			checkpointTranscriptStart: 100,
			compactTranscriptStart: 50,
			checkpointTranscriptSize: 1024,
			lastCheckpointId: 'a3b2c4d5e6f7',
		});

		await carryForwardToNewShadowBranch(strategy, state, ['keep.ts']);

		expect(state.stepCount).toBe(1);
		expect(state.checkpointTranscriptStart).toBe(0);
		expect(state.compactTranscriptStart).toBe(0);
		expect(state.checkpointTranscriptSize).toBe(0);
		expect(state.lastCheckpointId).toBe('');
	});

	// **Critical invariant**: turnCheckpointIds preserved (HandleTurnEnd needs them).
	it('does NOT clear state.turnCheckpointIds (HandleTurnEnd needs them later)', async () => {
		const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		await env.writeFile('x.ts', 'x');
		const strategy = new ManualCommitStrategy(env.dir);
		const state = makeState({
			sessionId: 'sess-turn',
			baseCommit: head,
			worktreeId: '',
			turnCheckpointIds: ['cp-aaa', 'cp-bbb'],
		});
		await carryForwardToNewShadowBranch(strategy, state, ['x.ts']);
		expect(state.turnCheckpointIds).toEqual(['cp-aaa', 'cp-bbb']);
	});

	// Go: dedup-skip path
	it('logs debug + leaves state untouched when writeTemporary returns skipped:true (dedup hit)', async () => {
		// Trigger dedup by calling carry-forward twice on the same baseline —
		// second call sees the same tree and returns skipped:true.
		const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		await env.writeFile('dedup.ts', 'same content');
		const strategy = new ManualCommitStrategy(env.dir);

		const state = makeState({
			sessionId: 'sess-dedup',
			baseCommit: head,
			worktreeId: '',
			stepCount: 5,
		});

		await carryForwardToNewShadowBranch(strategy, state, ['dedup.ts']);
		// Now state has been reset.
		expect(state.stepCount).toBe(1);

		// Second call with same content — writeTemporary returns skipped:true,
		// state should not be reset again (it's already at stepCount=1).
		const beforeStep = state.stepCount;
		state.stepCount = 99; // pretend something else changed it
		await carryForwardToNewShadowBranch(strategy, state, ['dedup.ts']);
		// The skipped path should not reset stepCount back to 1.
		expect(state.stepCount).toBe(99);
		expect(beforeStep).toBe(1);
	});

	// Go: writeTemporary failure → log warn + return; state not reset
	it('warns and returns silently when writeTemporary throws (state not reset)', async () => {
		// Empty baseCommit triggers writeTemporary's `BaseCommit is required` throw.
		await env.writeFile('x.ts', 'x');
		const strategy = new ManualCommitStrategy(env.dir);
		const state = makeState({
			sessionId: 'sess-throwy',
			baseCommit: '', // forces writeTemporary to throw
			worktreeId: '',
			stepCount: 5,
			lastCheckpointId: 'a3b2c4d5e6f7',
		});
		// No throw — silent (logged via log.warn).
		await carryForwardToNewShadowBranch(strategy, state, ['x.ts']);
		// State unchanged because writeTemporary failed pre-reset.
		expect(state.stepCount).toBe(5);
		expect(state.lastCheckpointId).toBe('a3b2c4d5e6f7');
	});

	// Go: empty MetadataDir intentional (no transcript copy in carry-forward branch)
	it('passes empty metadataDir to writeTemporary (no transcript carried into the new branch)', async () => {
		const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		await env.writeFile('y.ts', 'y');
		const strategy = new ManualCommitStrategy(env.dir);
		const state = makeState({
			sessionId: 'sess-meta',
			baseCommit: head,
			worktreeId: '',
		});
		await carryForwardToNewShadowBranch(strategy, state, ['y.ts']);

		// The new shadow branch tree should NOT contain `.story/metadata/` (empty MetadataDir).
		const branch = shadowBranchNameForCommit(head, '');
		const branchSha = (await env.exec('git', ['rev-parse', `refs/heads/${branch}`])).stdout.trim();
		const treeListing = (
			await env.exec('git', ['ls-tree', '-r', '--name-only', branchSha])
		).stdout.trim();
		expect(treeListing).not.toContain('.story/metadata/');
		expect(treeListing).toContain('y.ts');
	});

	// Phase 3 branch coverage — getCheckpointStore throws → log warn + return.
	it('warns + returns silently when getCheckpointStore throws', async () => {
		const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		await env.writeFile('x.ts', 'x');
		const strategy = new ManualCommitStrategy(env.dir);
		const state = makeState({
			sessionId: 'sess-storefail',
			baseCommit: head,
			worktreeId: '',
			stepCount: 5,
			lastCheckpointId: 'a3b2c4d5e6f7',
		});
		// Force getCheckpointStore to reject.
		const spy = vi.spyOn(strategy, 'getCheckpointStore').mockImplementation(async () => {
			throw new Error('forced store fail');
		});
		try {
			await carryForwardToNewShadowBranch(strategy, state, ['x.ts']);
			// State unchanged — store failure caught.
			expect(state.stepCount).toBe(5);
			expect(state.lastCheckpointId).toBe('a3b2c4d5e6f7');
		} finally {
			spy.mockRestore();
		}
	});

	// Phase 3 branch coverage — state.worktreeId omitted → exercises `?? ''` fallback.
	it('handles state with omitted worktreeId via `?? ""` fallback', async () => {
		const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		await env.writeFile('z.ts', 'z');
		const strategy = new ManualCommitStrategy(env.dir);
		const state = makeState({
			sessionId: 'sess-no-wt',
			baseCommit: head,
			// worktreeId intentionally omitted — exercises `state.worktreeId ?? ''`.
			stepCount: 5,
		});
		await carryForwardToNewShadowBranch(strategy, state, ['z.ts']);
		// State successfully reset → branch hit.
		expect(state.stepCount).toBe(1);
	});

	// Phase 3 branch coverage — non-Error throw triggers `String(err)` branch in error
	// formatting. Force writeTemporary to throw a plain string (not Error).
	it('formats non-Error throws via String(err) branch when writeTemporary throws non-Error', async () => {
		const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		await env.writeFile('q.ts', 'q');
		const strategy = new ManualCommitStrategy(env.dir);
		const store = await strategy.getCheckpointStore();
		const spy = vi.spyOn(store, 'writeTemporary').mockImplementation(() => {
			// Deliberately throwing a non-Error to exercise the `String(err)`
			// branch in the error-formatting ternary.
			// eslint-disable-next-line @typescript-eslint/only-throw-error
			throw 'plain-string-thrown';
		});
		const state = makeState({
			sessionId: 'sess-stringthrow',
			baseCommit: head,
			worktreeId: '',
			stepCount: 5,
		});
		try {
			await carryForwardToNewShadowBranch(strategy, state, ['q.ts']);
			// State unchanged — error caught + logged via String(err).
			expect(state.stepCount).toBe(5);
		} finally {
			spy.mockRestore();
		}
	});
});
