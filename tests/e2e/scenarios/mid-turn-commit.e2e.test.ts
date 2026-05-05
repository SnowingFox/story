/**
 * Mid-turn-commit E2E scenario — Vogon canary only.
 *
 * 1:1 port of Go `entire-cli/e2e/tests/mid_turn_commit_test.go` (1 test).
 * Regression test: the mid-turn commit must trigger condensation even
 * when committed files don't overlap with the previous turn's
 * `filesTouched` snapshot (matches Go's fix for a
 * `shouldCondenseWithOverlapCheck` early-skip bug).
 */

import { afterEach, describe, it } from 'vitest';
import { captureArtifacts } from '../helpers/artifacts';
import {
	assertCheckpointAdvanced,
	assertCheckpointExists,
	assertFileExists,
	assertHasCheckpointTrailer,
	assertNewCommits,
	waitForCheckpoint,
	waitForNoShadowBranches,
} from '../helpers/assertions';
import { type RepoState, setupRepo, teardownRepo } from '../helpers/repo-state';

describe('mid-turn-commit scenarios (Vogon)', () => {
	let s: RepoState | undefined;

	afterEach(async () => {
		if (s !== undefined) {
			await teardownRepo(s);
			s = undefined;
		}
	});

	// Go: e2e/tests/mid_turn_commit_test.go:28-62
	// TestMidTurnCommit_DifferentFilesThanPreviousTurn
	it('mid-turn commit with different files than previous turn still condenses', async (ctx) => {
		s = await setupRepo(ctx.task.name);
		ctx.onTestFailed(async () => {
			await captureArtifacts(s);
		});

		// Turn 1 — agent creates a file (tracked as touched), no commit.
		await s.runPrompt(
			'create a markdown file at docs/turn1.md with a paragraph about apples. Do not commit the file. Do not ask for confirmation, just make the change.',
		);
		await assertFileExists(s.dir, 'docs/turn1.md');

		// Turn 2 — agent creates DIFFERENT files and commits them mid-turn.
		await s.runPrompt(
			'create two markdown files: docs/turn2a.md about bananas and docs/turn2b.md about cherries. Then git add and git commit both files with a short message. Do not commit any other files. Do not ask for confirmation, just make the changes. Do not add Co-authored-by or Signed-off-by trailers. Do not use worktrees.',
		);
		await assertFileExists(s.dir, 'docs/turn2a.md');
		await assertFileExists(s.dir, 'docs/turn2b.md');
		await assertNewCommits(s, 1);

		// CRITICAL: mid-turn commit must advance the checkpoint branch
		// even though the committed files don't overlap with turn 1's
		// tracked set — regression assertion for the
		// `shouldCondenseWithOverlapCheck` Go fix.
		await waitForCheckpoint(s, 30_000);
		await assertCheckpointAdvanced(s);

		const cpId = await assertHasCheckpointTrailer(s.dir, 'HEAD');
		await assertCheckpointExists(s.dir, cpId);
		await waitForNoShadowBranches(s.dir, 10_000);
	});
});
