/**
 * Edge-case E2E scenarios — Vogon canary only.
 *
 * 1:1 port of Go `entire-cli/e2e/tests/edge_cases_test.go` (5 tests).
 * Covers: continuing-after-commit, amend, dirty-working-tree, rapid
 * sequential commits, and mid-turn agent commit with user follow-up.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { captureArtifacts } from '../helpers/artifacts';
import {
	assertCheckpointExists,
	assertCommitLinkedToCheckpoint,
	assertFileExists,
	assertHasCheckpointTrailer,
	assertNewCommits,
	waitForCheckpoint,
	waitForCheckpointExists,
	waitForNoShadowBranches,
} from '../helpers/assertions';
import { type RepoState, setupRepo, teardownRepo } from '../helpers/repo-state';

describe('edge-case scenarios (Vogon)', () => {
	let s: RepoState | undefined;

	afterEach(async () => {
		if (s !== undefined) {
			await teardownRepo(s);
			s = undefined;
		}
	});

	// Go: e2e/tests/edge_cases_test.go:20-58 TestAgentContinuesAfterCommit
	it('TestAgentContinuesAfterCommit — second prompt after commit yields distinct checkpoint', async (ctx) => {
		s = await setupRepo(ctx.task.name);
		ctx.onTestFailed(async () => {
			await captureArtifacts(s);
		});

		await s.runPrompt(
			'create a markdown file at docs/red.md with a paragraph about the colour red, then commit it. Do not ask for confirmation, just make the change.',
		);
		await waitForCheckpoint(s, 30_000);
		const cpId1 = await assertHasCheckpointTrailer(s.dir, 'HEAD');
		const cpBranchAfterFirst = await s.gitOutput('rev-parse', 'story/checkpoints/v1');

		await s.runPrompt(
			'create a markdown file at docs/blue.md with a paragraph about the colour blue. Do not commit it, only create the file. Do not ask for confirmation, just make the change.',
		);
		await s.git('add', '.');
		await s.git('commit', '-m', 'Add blue.md');

		// Wait until the checkpoint branch advances past the first commit.
		const deadline = Date.now() + 15_000;
		while (Date.now() < deadline) {
			const after = await s.gitOutput('rev-parse', 'story/checkpoints/v1');
			if (after !== cpBranchAfterFirst) {
				break;
			}
			await new Promise<void>((r) => setTimeout(r, 200));
		}

		const cpId2 = await assertHasCheckpointTrailer(s.dir, 'HEAD');
		expect(cpId1, 'checkpoint IDs should be distinct').not.toBe(cpId2);
		await assertCheckpointExists(s.dir, cpId1);
		await assertCheckpointExists(s.dir, cpId2);
		await waitForNoShadowBranches(s.dir, 10_000);
	});

	// Go: edge_cases_test.go:64-91 TestAgentAmendsCommit
	it('TestAgentAmendsCommit — amended commit retains checkpoint trailer', async (ctx) => {
		s = await setupRepo(ctx.task.name);
		ctx.onTestFailed(async () => {
			await captureArtifacts(s);
		});

		await s.runPrompt(
			'create a markdown file at docs/red.md with a paragraph about the colour red, then git add and git commit it on the current branch. Do not ask for confirmation, just make the change. Do not use worktrees or create new branches.',
		);
		await assertFileExists(s.dir, 'docs/red.md');
		await waitForCheckpoint(s, 30_000);
		await assertHasCheckpointTrailer(s.dir, 'HEAD');

		await s.runPrompt(
			'create a markdown file at docs/blue.md with a paragraph about the colour blue, then amend the previous commit to include it using git commit --amend --no-edit. Do not ask for confirmation, just make the change. Do not use worktrees or create new branches.',
		);
		await assertFileExists(s.dir, 'docs/red.md');
		await assertFileExists(s.dir, 'docs/blue.md');

		const cpId = await assertHasCheckpointTrailer(s.dir, 'HEAD');
		await assertCheckpointExists(s.dir, cpId);
		await waitForNoShadowBranches(s.dir, 10_000);
	});

	// Go: edge_cases_test.go:95-126 TestDirtyWorkingTree
	it('TestDirtyWorkingTree — human uncommitted changes survive agent commit', async (ctx) => {
		s = await setupRepo(ctx.task.name);
		ctx.onTestFailed(async () => {
			await captureArtifacts(s);
		});

		// Human creates an uncommitted file.
		await fs.mkdir(path.join(s.dir, 'human'), { recursive: true });
		await fs.writeFile(path.join(s.dir, 'human', 'notes.md'), '# Human notes\n');

		await s.runPrompt(
			'create a markdown file at docs/red.md with a paragraph about the colour red, then commit it. Do not ask for confirmation, just make the change. Do not create the file under human/.',
		);
		await waitForCheckpoint(s, 30_000);
		await assertFileExists(s.dir, 'docs/red.md');

		const data = await fs.readFile(path.join(s.dir, 'human', 'notes.md'), 'utf-8');
		expect(data, 'human file should be untouched').toBe('# Human notes\n');

		await assertCommitLinkedToCheckpoint(s.dir, 'HEAD');
		await waitForNoShadowBranches(s.dir, 10_000);
	});

	// Go: edge_cases_test.go:130-156 TestRapidSequentialCommits
	it('TestRapidSequentialCommits — three sequential commits each get trailers', async (ctx) => {
		s = await setupRepo(ctx.task.name);
		ctx.onTestFailed(async () => {
			await captureArtifacts(s);
		});

		await s.runPrompt(
			'Do these steps in exact order: ' +
				"(1) Create docs/red.md with a paragraph about the colour red. Run: git add docs/red.md && git commit -m 'Add red.md'. " +
				"(2) Create docs/blue.md with a paragraph about the colour blue. Run: git add docs/blue.md && git commit -m 'Add blue.md'. " +
				"(3) Create docs/green.md with a paragraph about the colour green. Run: git add docs/green.md && git commit -m 'Add green.md'. " +
				'Do not ask for confirmation, just execute each step.',
			{ timeoutMs: 180_000 },
		);

		await assertFileExists(s.dir, 'docs/red.md');
		await assertFileExists(s.dir, 'docs/blue.md');
		await assertFileExists(s.dir, 'docs/green.md');
		await assertNewCommits(s, 3);
		await waitForCheckpoint(s, 30_000);

		for (let i = 0; i < 3; i++) {
			await assertHasCheckpointTrailer(s.dir, `HEAD~${i}`);
		}
		await waitForNoShadowBranches(s.dir, 10_000);
	});

	// Go: edge_cases_test.go:161-195 TestAgentCommitsMidTurnUserCommitsRemainder
	it('TestAgentCommitsMidTurnUserCommitsRemainder — mid-turn commit + user follow-up → 2 distinct checkpoints', async (ctx) => {
		s = await setupRepo(ctx.task.name);
		ctx.onTestFailed(async () => {
			await captureArtifacts(s);
		});

		await s.runPrompt(
			'Do these tasks in order: ' +
				"(1) Create file agent_mid1.go with content 'package main; func AgentMid1() {}'. " +
				"(2) Create file agent_mid2.go with content 'package main; func AgentMid2() {}'. " +
				"(3) Run: git add agent_mid1.go agent_mid2.go && git commit -m 'Agent adds mid1 and mid2'. " +
				"(4) Create file user_remainder.go with content 'package main; func UserRemainder() {}'. " +
				'Do all tasks in order. Do not ask for confirmation, just make the changes.',
		);

		await assertFileExists(s.dir, 'agent_mid1.go');
		await assertFileExists(s.dir, 'agent_mid2.go');
		await assertFileExists(s.dir, 'user_remainder.go');
		await assertNewCommits(s, 1);
		await waitForCheckpoint(s, 30_000);

		await s.git('add', 'user_remainder.go');
		await s.git('commit', '-m', 'Add user remainder');

		const userCpId = await assertHasCheckpointTrailer(s.dir, 'HEAD');
		const agentCpId = await assertHasCheckpointTrailer(s.dir, 'HEAD~1');
		await waitForCheckpointExists(s.dir, userCpId, 30_000);

		expect(userCpId, 'user and agent checkpoints should have distinct IDs').not.toBe(agentCpId);
		await assertCheckpointExists(s.dir, userCpId);
		await assertCheckpointExists(s.dir, agentCpId);
		await waitForNoShadowBranches(s.dir, 10_000);
	});
});
