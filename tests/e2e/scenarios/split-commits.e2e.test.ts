/**
 * Split-commits E2E scenarios — Vogon canary only.
 *
 * 1:1 port of Go `entire-cli/e2e/tests/split_commits_test.go` (2 tests):
 * user splits a single prompt into two partial commits (each yields its
 * own checkpoint) and repeat-modification of a tracked file across
 * prompts.
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
	waitForCheckpointAdvanceFrom,
	waitForCheckpointExists,
	waitForNoShadowBranches,
} from '../helpers/assertions';
import { type RepoState, setupRepo, teardownRepo } from '../helpers/repo-state';

describe('split-commits scenarios (Vogon)', () => {
	let s: RepoState | undefined;

	afterEach(async () => {
		if (s !== undefined) {
			await teardownRepo(s);
			s = undefined;
		}
	});

	// Go: e2e/tests/split_commits_test.go:19-49 TestUserSplitsAgentChanges
	it('TestUserSplitsAgentChanges — 4 agent files in 2 user commits → 2 distinct checkpoints', async (ctx) => {
		s = await setupRepo(ctx.task.name);
		ctx.onTestFailed(async () => {
			await captureArtifacts(s);
		});

		await s.runPrompt(
			'create four markdown files: docs/a.md about apples, docs/b.md about bananas, docs/c.md about cherries, docs/d.md about dates. Do not ask for confirmation, just make the changes.',
		);
		await assertFileExists(s.dir, 'docs/a.md');
		await assertFileExists(s.dir, 'docs/b.md');
		await assertFileExists(s.dir, 'docs/c.md');
		await assertFileExists(s.dir, 'docs/d.md');

		await s.git('add', 'docs/a.md', 'docs/b.md');
		await s.git('commit', '-m', 'Add a.md and b.md');
		await waitForCheckpoint(s, 30_000);
		const cpId1 = await assertHasCheckpointTrailer(s.dir, 'HEAD');

		await s.git('add', '-A');
		await s.git('commit', '-m', 'Commit remaining changes (including c.md and d.md)');
		const cpId2 = await assertHasCheckpointTrailer(s.dir, 'HEAD');
		await waitForCheckpointExists(s.dir, cpId2, 30_000);

		expect(cpId1, 'checkpoint IDs should be distinct').not.toBe(cpId2);
		await assertCheckpointExists(s.dir, cpId1);
		await assertCheckpointExists(s.dir, cpId2);
		await waitForNoShadowBranches(s.dir, 10_000);
	});

	// Go: split_commits_test.go:54-150 TestPartialStaging
	it('TestPartialStaging — two prompts modifying the same file → 2 checkpoints same file', async (ctx) => {
		s = await setupRepo(ctx.task.name);
		ctx.onTestFailed(async () => {
			await captureArtifacts(s);
		});

		await fs.mkdir(path.join(s.dir, 'src'), { recursive: true });
		await fs.writeFile(path.join(s.dir, 'src', 'main.go'), 'package main\n');
		await s.git('add', 'src/');
		await s.git('commit', '-m', 'Add initial main.go');

		await s.runPrompt(
			'modify src/main.go to add a main function that prints "hello world". Do not ask for confirmation, just make the change.',
		);
		await s.git('add', 'src/main.go');
		await s.git('commit', '-m', 'Add hello world');
		await waitForCheckpoint(s, 30_000);
		const cpId1 = await assertHasCheckpointTrailer(s.dir, 'HEAD');
		const cp1Ref = await s.gitOutput('rev-parse', 'story/checkpoints/v1');

		await s.runPrompt(
			'modify src/main.go to change the printed string from "hello world" to "howdy world". Do not ask for confirmation, just make the change.',
		);
		await s.git('add', 'src/main.go');
		await s.git('commit', '-m', 'Howdy world');
		await waitForCheckpointAdvanceFrom(s.dir, cp1Ref, 30_000);
		const cpId2 = await assertHasCheckpointTrailer(s.dir, 'HEAD');

		expect(cpId1, 'checkpoint IDs should be distinct across two prompts').not.toBe(cpId2);
		await assertCheckpointExists(s.dir, cpId1);
		await assertCheckpointExists(s.dir, cpId2);
		await waitForNoShadowBranches(s.dir, 10_000);
	});

	// Go: split_commits_test.go:102-154 TestSplitModificationsToExistingFiles
	it('TestSplitModificationsToExistingFiles — modify 3 tracked files + 3 user commits → 3 distinct checkpoints', async (ctx) => {
		s = await setupRepo(ctx.task.name);
		ctx.onTestFailed(async () => {
			await captureArtifacts(s);
		});

		// Create 3 tracked files (MVC skeleton).
		await fs.mkdir(path.join(s.dir, 'src'), { recursive: true });
		for (const name of ['model.go', 'view.go', 'controller.go']) {
			await fs.writeFile(path.join(s.dir, 'src', name), `package src\n\n// ${name} placeholder.\n`);
		}
		await s.git('add', 'src/');
		await s.git('commit', '-m', 'Add MVC skeleton');

		// Agent modifies all 3 files in one prompt.
		await s.runPrompt(
			'modify these three files: src/model.go should define a User struct with Name and Email fields, src/view.go should add a RenderUser function, src/controller.go should add a HandleUser function. Do not ask for confirmation, just make the changes.',
		);

		// Commit model.go → checkpoint 1.
		await s.git('add', 'src/model.go');
		await s.git('commit', '-m', 'Update model.go');
		await waitForCheckpoint(s, 30_000);
		const cpId1 = await assertHasCheckpointTrailer(s.dir, 'HEAD');
		const cp1Ref = await s.gitOutput('rev-parse', 'story/checkpoints/v1');

		// Commit view.go → checkpoint 2.
		await s.git('add', 'src/view.go');
		await s.git('commit', '-m', 'Update view.go');
		await waitForCheckpointAdvanceFrom(s.dir, cp1Ref, 30_000);
		const cpId2 = await assertHasCheckpointTrailer(s.dir, 'HEAD');
		await waitForCheckpointExists(s.dir, cpId2, 30_000);
		const cp2Ref = await s.gitOutput('rev-parse', 'story/checkpoints/v1');

		// Commit remaining (controller.go + any extras) → checkpoint 3.
		await s.git('add', '-A');
		await s.git('commit', '-m', 'Commit remaining changes');
		await waitForCheckpointAdvanceFrom(s.dir, cp2Ref, 30_000);
		const cpId3 = await assertHasCheckpointTrailer(s.dir, 'HEAD');
		await waitForCheckpointExists(s.dir, cpId3, 30_000);

		expect(cpId1, 'checkpoint 1 and 2 should be distinct').not.toBe(cpId2);
		expect(cpId2, 'checkpoint 2 and 3 should be distinct').not.toBe(cpId3);
		expect(cpId1, 'checkpoint 1 and 3 should be distinct').not.toBe(cpId3);
		await assertCheckpointExists(s.dir, cpId1);
		await assertCheckpointExists(s.dir, cpId2);
		await assertCheckpointExists(s.dir, cpId3);
		await waitForNoShadowBranches(s.dir, 10_000);
	});
});
