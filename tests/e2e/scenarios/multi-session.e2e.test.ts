/**
 * Multi-session E2E scenarios — Vogon canary only.
 *
 * 1:1 port of Go `entire-cli/e2e/tests/multi_session_test.go`. Both cases
 * cover "two prompts in the same repo, user commits" — case 1 bundles
 * both prompts' files into a single commit (1 checkpoint), case 2 has
 * the agent commit after each prompt (2 distinct checkpoints).
 */

import { afterEach, describe, it } from 'vitest';
import { captureArtifacts } from '../helpers/artifacts';
import {
	assertCheckpointAdvanced,
	assertCheckpointExists,
	assertCheckpointHasSingleSession,
	assertDistinctSessions,
	assertFileExists,
	assertHasCheckpointTrailer,
	assertNewCommits,
	waitForCheckpoint,
	waitForNoShadowBranches,
} from '../helpers/assertions';
import { listCheckpointIds } from '../helpers/metadata';
import { type RepoState, setupRepo, teardownRepo } from '../helpers/repo-state';

describe('multi-session scenarios (Vogon)', () => {
	let s: RepoState | undefined;

	afterEach(async () => {
		if (s !== undefined) {
			await teardownRepo(s);
			s = undefined;
		}
	});

	// Go: e2e/tests/multi_session_test.go:15-40 TestMultiSessionManualCommit
	it('TestMultiSessionManualCommit — two prompts, one user commit → 1 checkpoint', async (ctx) => {
		s = await setupRepo(ctx.task.name);
		ctx.onTestFailed(async () => {
			await captureArtifacts(s);
		});

		await s.runPrompt(
			'create a markdown file at docs/red.md with a paragraph about the colour red. Do not ask for confirmation, just make the change.',
		);
		await s.runPrompt(
			'create a markdown file at docs/blue.md with a paragraph about the colour blue. Do not ask for confirmation, just make the change.',
		);

		await s.git('add', '.');
		await s.git('commit', '-m', 'Add md files about red and blue');

		await assertFileExists(s.dir, 'docs/*.md');
		await assertNewCommits(s, 1);

		await waitForCheckpoint(s, 30_000);
		await assertCheckpointAdvanced(s);

		const cpId = await assertHasCheckpointTrailer(s.dir, 'HEAD');
		await assertCheckpointExists(s.dir, cpId);
		await waitForNoShadowBranches(s.dir, 10_000);
	});

	// Go: multi_session_test.go:43-78 TestMultiSessionSequential
	it('TestMultiSessionSequential — two prompts, each commits → 2 distinct checkpoints with distinct sessions', async (ctx) => {
		s = await setupRepo(ctx.task.name);
		ctx.onTestFailed(async () => {
			await captureArtifacts(s);
		});

		await s.runPrompt(
			'create a markdown file at docs/red.md about the colour red, then git add and git commit it with a short message. Do not ask for confirmation, just make the change.',
		);

		await s.runPrompt(
			'create a markdown file at docs/blue.md about the colour blue, then git add and git commit it with a short message. Do not ask for confirmation, just make the change.',
		);

		await assertFileExists(s.dir, 'docs/*.md');
		await assertNewCommits(s, 2);

		await waitForCheckpoint(s, 30_000);
		await assertCheckpointAdvanced(s);

		const cpId1 = await assertHasCheckpointTrailer(s.dir, 'HEAD');
		await assertCheckpointExists(s.dir, cpId1);
		const cpId2 = await assertHasCheckpointTrailer(s.dir, 'HEAD~1');
		await assertCheckpointExists(s.dir, cpId2);

		const cpIds = await listCheckpointIds(s.dir);
		for (const id of cpIds) {
			await assertCheckpointHasSingleSession(s.dir, id);
		}
		await assertDistinctSessions(s.dir, cpIds);
		await waitForNoShadowBranches(s.dir, 10_000);
	});
});
