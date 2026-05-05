/**
 * Phase 5.5 reset / resetSession unit tests.
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/strategy/manual_commit_reset.go` —
 * `Reset` / `ResetSession` / `isAccessibleMode`.
 *
 * Each `it()` is annotated with `// Go: <go-file>:<line>` for the
 * audit-test-go-parity gate.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shadowBranchNameForCommit } from '@/checkpoint/temporary';
import { clearGitCommonDirCache } from '@/git';
import { clearWorktreeRootCache } from '@/paths';
import { ManualCommitStrategy } from '@/strategy/manual-commit';
import { isAccessibleMode, resetImpl, resetSessionImpl } from '@/strategy/reset';
import { saveSessionState } from '@/strategy/session-state';
import type { SessionState } from '@/strategy/types';
import { TestEnv } from '../../helpers/test-env';

interface CapturedWritable extends NodeJS.WritableStream {
	captured: string;
}

function makeWritable(): CapturedWritable {
	const stream: CapturedWritable = {
		captured: '',
		write(chunk: string | Uint8Array): boolean {
			stream.captured += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
			return true;
		},
		end(): void {},
		on(): NodeJS.WritableStream {
			return stream;
		},
		once(): NodeJS.WritableStream {
			return stream;
		},
		emit(): boolean {
			return false;
		},
	} as unknown as CapturedWritable;
	return stream;
}

function makeState(overrides: Partial<SessionState> = {}): SessionState {
	return {
		sessionId: 'sess-default',
		baseCommit: 'deadbeef',
		startedAt: new Date().toISOString(),
		phase: 'idle',
		stepCount: 0,
		...overrides,
	};
}

async function createShadowBranch(env: TestEnv, baseCommit: string): Promise<string> {
	const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
	const branch = shadowBranchNameForCommit(baseCommit, '');
	await env.exec('git', ['branch', '-f', branch, head]);
	return branch;
}

// Go: manual_commit_reset.go: Reset / ResetSession / isAccessibleMode
describe('strategy/reset — Go: manual_commit_reset.go', () => {
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

	// Go: manual_commit_reset.go: Reset (nothing-to-clean branch)
	describe('resetImpl — Go: manual_commit_reset.go: Reset', () => {
		it('prints "Nothing to clean for <branch>" when no shadow + no sessions', async () => {
			const out = makeWritable();
			const err = makeWritable();
			const strategy = new ManualCommitStrategy(env.dir);
			await resetImpl(strategy, out, err);
			expect(out.captured).toMatch(/^Nothing to clean for story\//);
			expect(err.captured).toBe('');
		});

		// Go: manual_commit_reset.go: Reset (clear sessions + delete shadow)
		it('clears all sessions + deletes shadow branch when both present', async () => {
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			const shadowBranch = await createShadowBranch(env, head);
			await saveSessionState(
				makeState({ sessionId: 'sess-a', baseCommit: head, stepCount: 1 }),
				env.dir,
			);
			await saveSessionState(
				makeState({ sessionId: 'sess-b', baseCommit: head, stepCount: 2 }),
				env.dir,
			);

			const out = makeWritable();
			const err = makeWritable();
			const strategy = new ManualCommitStrategy(env.dir);
			await resetImpl(strategy, out, err);
			expect(out.captured).toContain('✓ Cleared session state for sess-a');
			expect(out.captured).toContain('✓ Cleared session state for sess-b');
			expect(out.captured).toContain(`✓ Deleted shadow branch ${shadowBranch}`);
			// Verify the shadow branch was actually deleted.
			await expect(
				env.exec('git', ['show-ref', '--verify', `refs/heads/${shadowBranch}`]),
			).rejects.toThrow();
		});

		// Go: manual_commit_reset.go: Reset (warn-and-continue on per-session failure)
		it('partial session-clear failure: warns and continues, only succeeded printed', async () => {
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			await createShadowBranch(env, head);
			await saveSessionState(
				makeState({ sessionId: 'sess-ok', baseCommit: head, stepCount: 1 }),
				env.dir,
			);
			await saveSessionState(
				makeState({ sessionId: 'sess-fail', baseCommit: head, stepCount: 1 }),
				env.dir,
			);

			const strategy = new ManualCommitStrategy(env.dir);
			const orig = strategy.clearSessionState.bind(strategy);
			const spy = vi
				.spyOn(strategy, 'clearSessionState')
				.mockImplementation(async (sid: string) => {
					if (sid === 'sess-fail') {
						throw new Error('boom');
					}
					return orig(sid);
				});

			const out = makeWritable();
			const err = makeWritable();
			await resetImpl(strategy, out, err);
			expect(out.captured).toContain('✓ Cleared session state for sess-ok');
			expect(out.captured).not.toContain('✓ Cleared session state for sess-fail');
			expect(err.captured).toContain('Warning: failed to clear session state for sess-fail: boom');
			spy.mockRestore();
		});

		// Go: manual_commit_reset.go: Reset (shadow branch deletion failure → wrap + throw)
		it('throws when shadow branch deletion fails', async () => {
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			const shadowBranch = await createShadowBranch(env, head);

			// Make the branch unreachable mid-pipeline by deleting it after the
			// existence probe but before deleteBranchCli runs. The simplest way
			// is to spy on findSessionsForCommit so the probe path runs first
			// and then delete the ref via raw git, then have deleteBranchCli
			// hit "not found" → wrapped throw.
			const strategy = new ManualCommitStrategy(env.dir);
			const orig = strategy.findSessionsForCommit.bind(strategy);
			const spy = vi
				.spyOn(strategy, 'findSessionsForCommit')
				.mockImplementation(async (sha: string) => {
					await env.exec('git', ['branch', '-D', shadowBranch]);
					return orig(sha);
				});

			const out = makeWritable();
			const err = makeWritable();
			await expect(resetImpl(strategy, out, err)).rejects.toThrow(/failed to delete shadow branch/);
			spy.mockRestore();
		});

		// Go: manual_commit_reset.go: Reset (findSessionsForCommit error swallowed)
		it('findSessionsForCommit error swallowed: still cleans shadow branch when present', async () => {
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			const shadowBranch = await createShadowBranch(env, head);

			const strategy = new ManualCommitStrategy(env.dir);
			const spy = vi.spyOn(strategy, 'findSessionsForCommit').mockRejectedValue(new Error('boom'));

			const out = makeWritable();
			const err = makeWritable();
			await resetImpl(strategy, out, err);
			expect(out.captured).toContain(`✓ Deleted shadow branch ${shadowBranch}`);
			spy.mockRestore();
		});
	});

	// Go: manual_commit_reset.go: ResetSession
	describe('resetSessionImpl — Go: manual_commit_reset.go: ResetSession', () => {
		// Go: manual_commit_reset.go: ResetSession (success path)
		it('success path: clears + cleanup + deletion confirmed', async () => {
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			const shadowBranch = shadowBranchNameForCommit(head, '');
			await env.exec('git', ['branch', '-f', shadowBranch, head]);
			await saveSessionState(
				makeState({ sessionId: 'sess-1', baseCommit: head, stepCount: 1 }),
				env.dir,
			);

			const out = makeWritable();
			const err = makeWritable();
			const strategy = new ManualCommitStrategy(env.dir);
			await resetSessionImpl(strategy, out, err, 'sess-1');
			expect(out.captured).toContain('✓ Cleared session state for sess-1');
			expect(out.captured).toContain(`✓ Deleted shadow branch ${shadowBranch}`);
			await expect(
				env.exec('git', ['show-ref', '--verify', `refs/heads/${shadowBranch}`]),
			).rejects.toThrow();
		});

		// Go: manual_commit_reset.go: ResetSession (state missing)
		it('throws "session not found: <id>" when state missing', async () => {
			const out = makeWritable();
			const err = makeWritable();
			const strategy = new ManualCommitStrategy(env.dir);
			await expect(resetSessionImpl(strategy, out, err, 'no-such-id')).rejects.toThrow(
				'session not found: no-such-id',
			);
		});

		// Go: manual_commit_reset.go: ResetSession (other session uses branch)
		it('does NOT delete shadow branch when other session uses it', async () => {
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			const shadowBranch = shadowBranchNameForCommit(head, '');
			await env.exec('git', ['branch', '-f', shadowBranch, head]);
			await saveSessionState(
				makeState({ sessionId: 'sess-1', baseCommit: head, stepCount: 1 }),
				env.dir,
			);
			await saveSessionState(
				makeState({ sessionId: 'sess-2', baseCommit: head, stepCount: 2 }),
				env.dir,
			);

			const out = makeWritable();
			const err = makeWritable();
			const strategy = new ManualCommitStrategy(env.dir);
			await resetSessionImpl(strategy, out, err, 'sess-1');
			expect(out.captured).toContain('✓ Cleared session state for sess-1');
			expect(out.captured).not.toContain('✓ Deleted shadow branch');
			// Branch must still exist since sess-2 references it.
			await env.exec('git', ['show-ref', '--verify', `refs/heads/${shadowBranch}`]);
		});

		// Go: manual_commit_reset.go: ResetSession (cleanup throws → warn-and-continue)
		it('warn-only when cleanupShadowBranchIfUnused fails', async () => {
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			await saveSessionState(
				makeState({ sessionId: 'sess-1', baseCommit: head, stepCount: 1 }),
				env.dir,
			);

			// Make cleanup throw by using a baseCommit that yields a branch we can't
			// delete (shadow branch missing → ErrBranchNotFound is silenced).
			// Simulate a real failure by overriding cleanupShadowBranchIfUnused via
			// mocking the module — but since the impl imports it directly we
			// instead break it by ensuring listAllSessionStates throws under it.
			// Easier: make the ref name invalid by writing weird state worktreeId
			// won't trigger; the cleanest reproducible path is to use a state
			// with worktreeId that points the branch to refs/heads/main itself
			// (cannot be deleted while HEAD points there). Instead: create a
			// shadow branch ref AND have it identical to HEAD's current branch
			// via update-ref hack — far too brittle. Use module-level mock:

			// Easiest reliable trigger: invoke resetSessionImpl after deleting
			// the .git/story-sessions dir mid-flight. Use a spy on
			// strategy.loadSessionState path.
			// Actually the cleanest: inject failure via vi.mock of condense-helpers.
			// Skipping full mocking and instead asserting via a module monkeypatch
			// is overkill; we use a manual approach:
			const out = makeWritable();
			const err = makeWritable();
			const strategy = new ManualCommitStrategy(env.dir);

			// Mock listAllSessionStates indirectly by simulating a corrupt session
			// dir: set a state file where worktreeId triggers a really long branch
			// name. Easier path is to spy on the strategy.getRepo to return an
			// invalid root that breaks deleteBranchCli:
			const origGetRepo = strategy.getRepo.bind(strategy);
			let firstCall = true;
			vi.spyOn(strategy, 'getRepo').mockImplementation(async () => {
				const repo = await origGetRepo();
				if (firstCall) {
					firstCall = false;
					return repo;
				}
				// Subsequent (cleanup) call gets a bogus root → cleanup will throw.
				return { ...repo, root: '/nonexistent/path/that/does/not/exist' };
			});

			await resetSessionImpl(strategy, out, err, 'sess-1');
			expect(out.captured).toContain('✓ Cleared session state for sess-1');
			expect(err.captured).toMatch(/Warning: failed to clean up shadow branch/);
			vi.restoreAllMocks();
		});
	});

	// Go: manual_commit_reset.go: isAccessibleMode (4 cases table-driven)
	describe('isAccessibleMode — Go: manual_commit_reset.go: isAccessibleMode', () => {
		const original = process.env.ACCESSIBLE;
		afterEach(() => {
			if (original === undefined) {
				delete process.env.ACCESSIBLE;
			} else {
				process.env.ACCESSIBLE = original;
			}
		});

		it('4 cases: unset / empty / "1" / "yes"', () => {
			delete process.env.ACCESSIBLE;
			expect(isAccessibleMode()).toBe(false);
			process.env.ACCESSIBLE = '';
			expect(isAccessibleMode()).toBe(false);
			process.env.ACCESSIBLE = '1';
			expect(isAccessibleMode()).toBe(true);
			process.env.ACCESSIBLE = 'yes';
			expect(isAccessibleMode()).toBe(true);
		});
	});
});
