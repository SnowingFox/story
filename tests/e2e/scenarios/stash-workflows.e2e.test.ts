/**
 * Stash-workflow E2E scenarios — Vogon canary only.
 *
 * 1:1 port of Go `entire-cli/e2e/tests/stash_workflows_test.go` (3 tests).
 * Covers `git stash` / `git stash pop` between agent prompts + user
 * commits — ensures checkpoint creation correctly tracks files across
 * the stash boundary rather than losing attribution.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { captureArtifacts } from '../helpers/artifacts';
import {
	assertCheckpointExists,
	assertFileExists,
	assertHasCheckpointTrailer,
	waitForCheckpoint,
	waitForCheckpointExists,
	waitForNoShadowBranches,
} from '../helpers/assertions';
import { type RepoState, setupRepo, teardownRepo } from '../helpers/repo-state';

describe('stash-workflow scenarios (Vogon)', () => {
	let s: RepoState | undefined;

	afterEach(async () => {
		if (s !== undefined) {
			await teardownRepo(s);
			s = undefined;
		}
	});

	// Go: e2e/tests/stash_workflows_test.go:19-62 TestPartialCommitStashNewPrompt
	it('TestPartialCommitStashNewPrompt — stash across prompt boundary → 2 distinct checkpoints', async (ctx) => {
		s = await setupRepo(ctx.task.name);
		ctx.onTestFailed(async () => {
			await captureArtifacts(s);
		});

		// Agent creates A, B, C (no commit).
		await s.runPrompt(
			'create three markdown files: docs/a.md about apples, docs/b.md about bananas, docs/c.md about cherries. Do not commit them, only create the files. Do not ask for confirmation, just make the changes.',
		);
		await assertFileExists(s.dir, 'docs/a.md');
		await assertFileExists(s.dir, 'docs/b.md');
		await assertFileExists(s.dir, 'docs/c.md');

		// User commits only A.
		await s.git('add', 'docs/a.md');
		await s.git('commit', '-m', 'Add a.md');

		// Stash B and C.
		await s.git('add', 'docs/b.md', 'docs/c.md');
		await s.git('stash');

		await waitForCheckpoint(s, 30_000);
		const cpId1 = await assertHasCheckpointTrailer(s.dir, 'HEAD');

		// Second prompt: create D, E.
		await s.runPrompt(
			'create two markdown files: docs/d.md about dates, docs/e.md about elderberries. Do not commit them, only create the files. Do not ask for confirmation, just make the changes.',
		);
		await assertFileExists(s.dir, 'docs/d.md');
		await assertFileExists(s.dir, 'docs/e.md');

		// User commits D and E.
		await s.git('add', 'docs/d.md', 'docs/e.md');
		await s.git('commit', '-m', 'Add d.md and e.md');

		const cpId2 = await assertHasCheckpointTrailer(s.dir, 'HEAD');
		await waitForCheckpointExists(s.dir, cpId2, 30_000);

		expect(cpId1, 'checkpoint IDs should be distinct across stash boundary').not.toBe(cpId2);
		await assertCheckpointExists(s.dir, cpId1);
		await assertCheckpointExists(s.dir, cpId2);
		await waitForNoShadowBranches(s.dir, 10_000);
	});

	// Go: stash_workflows_test.go:67-110 TestStashSecondPromptUnstashCommitAll
	it('TestStashSecondPromptUnstashCommitAll — stash + pop + one big commit → 2 distinct checkpoints', async (ctx) => {
		s = await setupRepo(ctx.task.name);
		ctx.onTestFailed(async () => {
			await captureArtifacts(s);
		});

		await s.runPrompt(
			'create three markdown files: docs/a.md about apples, docs/b.md about bananas, docs/c.md about cherries. Do not commit them, only create the files. Do not ask for confirmation, just make the changes.',
		);
		await assertFileExists(s.dir, 'docs/a.md');
		await assertFileExists(s.dir, 'docs/b.md');
		await assertFileExists(s.dir, 'docs/c.md');

		// User commits A, stashes B + C.
		await s.git('add', 'docs/a.md');
		await s.git('commit', '-m', 'Add a.md');
		await s.git('add', 'docs/b.md', 'docs/c.md');
		await s.git('stash');

		await waitForCheckpoint(s, 30_000);
		const cpId1 = await assertHasCheckpointTrailer(s.dir, 'HEAD');

		// Second prompt creates D, E.
		await s.runPrompt(
			'create two markdown files: docs/d.md about dates, docs/e.md about elderberries. Do not commit them, only create the files. Do not ask for confirmation, just make the changes.',
		);
		await assertFileExists(s.dir, 'docs/d.md');
		await assertFileExists(s.dir, 'docs/e.md');

		// Unstash B + C, commit everything.
		await s.git('stash', 'pop');
		await s.git('add', 'docs/');
		await s.git('commit', '-m', 'Add b, c, d, e');

		const cpId2 = await assertHasCheckpointTrailer(s.dir, 'HEAD');
		await waitForCheckpointExists(s.dir, cpId2, 30_000);

		expect(cpId1, 'checkpoint IDs should be distinct').not.toBe(cpId2);
		await assertCheckpointExists(s.dir, cpId1);
		await assertCheckpointExists(s.dir, cpId2);
		await waitForNoShadowBranches(s.dir, 10_000);
	});

	// Go: stash_workflows_test.go:115-164 TestStashModificationsToTrackedFiles
	it('TestStashModificationsToTrackedFiles — stash tracked-file edits + pop + split commits → 2 distinct checkpoints', async (ctx) => {
		s = await setupRepo(ctx.task.name);
		ctx.onTestFailed(async () => {
			await captureArtifacts(s);
		});

		// Create 2 tracked Go files.
		await fs.mkdir(path.join(s.dir, 'src'), { recursive: true });
		await fs.writeFile(path.join(s.dir, 'src', 'a.go'), 'package src\n\n// File A placeholder.\n');
		await fs.writeFile(path.join(s.dir, 'src', 'b.go'), 'package src\n\n// File B placeholder.\n');
		await s.git('add', 'src/');
		await s.git('commit', '-m', 'Add initial src files');

		// Agent modifies both files.
		await s.runPrompt(
			'Modify two existing files. In src/a.go, add a function: func Hello() string { return "hello" }. ' +
				'In src/b.go, add a function: func World() string { return "world" }. ' +
				'Only modify these two files, do not create new files. Do not commit. ' +
				'Do not ask for confirmation, just make the changes.',
		);

		// User commits a.go, stashes b.go.
		await s.git('add', 'src/a.go');
		await s.git('commit', '-m', 'Update a.go');
		await s.git('stash');

		await waitForCheckpoint(s, 30_000);
		const cpId1 = await assertHasCheckpointTrailer(s.dir, 'HEAD');

		// Pop and commit b.go.
		await s.git('stash', 'pop');
		await s.git('add', 'src/b.go');
		await s.git('commit', '-m', 'Update b.go');

		const cpId2 = await assertHasCheckpointTrailer(s.dir, 'HEAD');
		await waitForCheckpointExists(s.dir, cpId2, 30_000);

		expect(cpId1, 'checkpoint IDs should be distinct').not.toBe(cpId2);
		await assertCheckpointExists(s.dir, cpId1);
		await assertCheckpointExists(s.dir, cpId2);
		// Shadow-branch cleanup can lag behind condensation when
		// carry-forward creates intermediate branches — Go comment mirrored.
		await waitForNoShadowBranches(s.dir, 10_000);
	});
});
