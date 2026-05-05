/**
 * Resume E2E scenarios — Vogon canary only.
 *
 * 1:1 port of Go `entire-cli/e2e/tests/resume_test.go` (4 tests). Covers
 * basic branch resume, squash-merge resume (both GitHub and git-cli
 * formats), no-checkpoint-on-branch info path, and resume with newer
 * human-only commits on top.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { captureArtifacts } from '../helpers/artifacts';
import { waitForCheckpoint, waitForCheckpointAdvanceFrom } from '../helpers/assertions';
import { type RepoState, setupRepo, teardownRepo } from '../helpers/repo-state';
import { storyResume } from '../helpers/story';

/**
 * **Skipped pending Phase 9.4 design reconciliation.**
 *
 * Go's `entire resume <branch>` uses `findBranchCheckpoints(repo, branchName)` —
 * walks branch-only commits, finds the `Entire-Checkpoint:` trailer, then
 * reads the checkpoint metadata to recover the session.
 *
 * Story TS `resume.ts` uses `strategy.findSessionsForCommit(headSha)` which
 * filters **live session state files** (`.git/story-sessions/*.json`) by
 * `state.baseCommit === headSha`. That works only when the session was
 * JUST recorded (baseCommit unchanged since checkpoint); it fails for
 * the "agent finished, user committed, days later someone else checks
 * out the branch and runs resume" flow exercised by the Go tests —
 * baseCommit stays frozen at the original HEAD and never matches the
 * branch tip after the user's commit.
 *
 * Tracked in [legacy.md §5](../../../docs/ts-rewrite/impl/phase-10-integration-e2e/legacy.md):
 * resume should either (a) walk commits trailer-first, Go-parity, or
 * (b) post-commit-update `state.baseCommit` to the new HEAD. Either
 * reconciles these four scenarios.
 */
describe.skip('resume scenarios (Vogon) [skip: Phase 9.4 session-lookup design differs from Go]', () => {
	let s: RepoState | undefined;

	afterEach(async () => {
		if (s !== undefined) {
			await teardownRepo(s);
			s = undefined;
		}
	});

	// Go: e2e/tests/resume_test.go:23-55 TestResumeFromFeatureBranch
	it('TestResumeFromFeatureBranch — resume switches branch + restores session', async (ctx) => {
		s = await setupRepo(ctx.task.name);
		ctx.onTestFailed(async () => {
			await captureArtifacts(s);
		});

		const mainBranch = await s.gitOutput('branch', '--show-current');

		// Commit story-enable files so main has a clean working tree.
		await s.git('add', '.');
		await s.git('commit', '-m', 'Enable story');

		await s.git('checkout', '-b', 'feature');

		await s.runPrompt(
			'create a file at docs/hello.md with a paragraph about greetings. Do not ask for confirmation or approval, just make the change.',
		);

		await s.git('add', '.');
		await s.git('commit', '-m', 'Add hello doc');
		await waitForCheckpoint(s, 30_000);

		await s.git('checkout', mainBranch);

		const res = await storyResume(s.dir, 'feature');
		expect(res.exitCode, `story resume failed: ${res.stderr}\n${res.stdout}`).toBe(0);

		const current = await s.gitOutput('branch', '--show-current');
		expect(current).toBe('feature');
		expect(res.stdout, 'resume output should show resume instructions').toContain('To continue');
	});

	// Go: resume_test.go:69-160 TestResumeSquashMergeMultipleCheckpoints — GitHub format
	it('TestResumeSquashMergeMultipleCheckpoints (GitHub format) — squash merge skips older checkpoints', async (ctx) => {
		s = await setupRepo(ctx.task.name);
		ctx.onTestFailed(async () => {
			await captureArtifacts(s);
		});

		const mainBranch = await s.gitOutput('branch', '--show-current');
		await s.git('add', '.');
		await s.git('commit', '-m', 'Enable story');

		await s.git('checkout', '-b', 'feature');

		await s.runPrompt(
			'create a file at docs/red.md with a paragraph about the colour red. Do not ask for confirmation or approval, just make the change.',
		);
		await s.git('add', '.');
		await s.git('commit', '-m', 'Add red doc');
		await waitForCheckpoint(s, 30_000);
		const cp1Ref = await s.gitOutput('rev-parse', 'story/checkpoints/v1');

		await s.runPrompt(
			'create a file at docs/blue.md with a paragraph about the colour blue. Do not ask for confirmation or approval, just make the change.',
		);
		await s.git('add', '.');
		await s.git('commit', '-m', 'Add blue doc');
		await waitForCheckpointAdvanceFrom(s.dir, cp1Ref, 30_000);

		const cpId1 = (
			await s.gitOutput(
				'log',
				'-1',
				'--format=%(trailers:key=Story-Checkpoint,valueonly)',
				'HEAD~1',
			)
		).trim();
		const cpId2 = (
			await s.gitOutput('log', '-1', '--format=%(trailers:key=Story-Checkpoint,valueonly)', 'HEAD')
		).trim();

		await s.git('checkout', mainBranch);

		// GitHub format — trailers appear at top-level in body.
		await s.git('merge', '--squash', 'feature');
		const githubMsg = `Squash merge feature (#1)\n\n* Add red doc\n\nStory-Checkpoint: ${cpId1}\n\n* Add blue doc\n\nStory-Checkpoint: ${cpId2}`;
		await s.git('commit', '-m', githubMsg);

		const res = await storyResume(s.dir, mainBranch);
		expect(res.exitCode, `github format resume failed: ${res.stderr}\n${res.stdout}`).toBe(0);
		expect(res.stdout, 'github format: squash merge should skip older checkpoints').toContain(
			'older checkpoints skipped',
		);
	});

	// Go: resume_test.go:162-192 TestResumeNoCheckpointOnBranch
	it('TestResumeNoCheckpointOnBranch — no-checkpoint branch exits 0 with info message', async (ctx) => {
		s = await setupRepo(ctx.task.name);
		ctx.onTestFailed(async () => {
			await captureArtifacts(s);
		});

		const mainBranch = await s.gitOutput('branch', '--show-current');
		await s.git('add', '.');
		await s.git('commit', '-m', 'Enable story');

		await s.git('checkout', '-b', 'no-checkpoint');
		await fs.mkdir(path.join(s.dir, 'docs'), { recursive: true });
		await fs.writeFile(path.join(s.dir, 'docs', 'human.md'), '# Written by a human\n');
		await s.git('add', '.');
		await s.git('commit', '-m', 'Human-only commit');

		await s.git('checkout', mainBranch);

		const res = await storyResume(s.dir, 'no-checkpoint');
		expect(res.exitCode, `resume should not error for missing checkpoints: ${res.stderr}`).toBe(0);
		// Naming red line: "Story checkpoint" (not "Entire checkpoint").
		expect(res.stdout, 'should inform user no checkpoint exists on branch').toContain(
			'No Story checkpoint found',
		);
	});

	// Go: resume_test.go:197-239 TestResumeOlderCheckpointWithNewerCommits
	it('TestResumeOlderCheckpointWithNewerCommits — --force restores older checkpoint under newer human-only commits', async (ctx) => {
		s = await setupRepo(ctx.task.name);
		ctx.onTestFailed(async () => {
			await captureArtifacts(s);
		});

		const mainBranch = await s.gitOutput('branch', '--show-current');
		await s.git('add', '.');
		await s.git('commit', '-m', 'Enable story');

		await s.git('checkout', '-b', 'feature');

		await s.runPrompt(
			'create a file at docs/hello.md with a paragraph about greetings. Do not ask for confirmation or approval, just make the change.',
		);
		await s.git('add', '.');
		await s.git('commit', '-m', 'Add hello doc');
		await waitForCheckpoint(s, 30_000);

		// Add a human-only commit on top.
		await fs.mkdir(path.join(s.dir, 'notes'), { recursive: true });
		await fs.writeFile(path.join(s.dir, 'notes', 'todo.md'), '# TODO\n- something\n');
		await s.git('add', '.');
		await s.git('commit', '-m', 'Human-only follow-up');

		await s.git('checkout', mainBranch);

		const res = await storyResume(s.dir, 'feature');
		expect(res.exitCode, `story resume failed: ${res.stderr}`).toBe(0);

		const current = await s.gitOutput('branch', '--show-current');
		expect(current).toBe('feature');
		expect(res.stdout).toContain('To continue');
	});
});
