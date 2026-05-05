/**
 * Rewind E2E scenarios — Vogon canary only.
 *
 * 1:1 port of Go `entire-cli/e2e/tests/rewind_test.go` (4 tests). Covers
 * pre-commit shadow-branch rewind, post-commit invalidation of old shadow
 * IDs, multi-file selective rewind, and squash-merge logs-only fallback.
 *
 * Naming red line (Story, not Entire):
 *  - Trailer key `Story-Checkpoint:` in the squash-merge test body
 *  - Commands invoked via `rewindList` / `rewindTo` / `rewindLogsOnly`
 *    which all target the Story CLI (`dist/cli.js`).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { captureArtifacts } from '../helpers/artifacts';
import {
	assertFileExists,
	waitForCheckpoint,
	waitForCheckpointAdvanceFrom,
	waitForNoShadowBranches,
} from '../helpers/assertions';
import { type RepoState, setupRepo, teardownRepo } from '../helpers/repo-state';
import { type RewindPoint, rewindList, rewindLogsOnly, rewindTo } from '../helpers/story';

describe('rewind scenarios (Vogon)', () => {
	let s: RepoState | undefined;

	afterEach(async () => {
		if (s !== undefined) {
			await teardownRepo(s);
			s = undefined;
		}
	});

	// Go: e2e/tests/rewind_test.go:21-57 TestRewindPreCommit
	it('TestRewindPreCommit — two pre-commit prompts, rewind to first drops file B', async (ctx) => {
		s = await setupRepo(ctx.task.name);
		ctx.onTestFailed(async () => {
			await captureArtifacts(s);
		});

		await s.runPrompt(
			'create a markdown file at docs/red.md with a paragraph about the colour red. Do not ask for confirmation, just make the change.',
		);
		await assertFileExists(s.dir, 'docs/red.md');

		const pointsAfterA = await rewindList(s.dir);
		expect(pointsAfterA.length, 'expected ≥ 1 rewind point after file A').toBeGreaterThan(0);

		await s.runPrompt(
			'create a markdown file at docs/blue.md with a paragraph about the colour blue. Do not ask for confirmation, just make the change.',
		);
		await assertFileExists(s.dir, 'docs/blue.md');

		const pointsAfterB = await rewindList(s.dir);
		expect(pointsAfterB.length, 'expected more rewind points after file B').toBeGreaterThan(
			pointsAfterA.length,
		);

		const rewindId = (pointsAfterA[0] as RewindPoint).id;
		const res = await rewindTo(s.dir, rewindId);
		expect(res.exitCode, `rewind to ${rewindId} should succeed: ${res.stderr}`).toBe(0);

		await assertFileExists(s.dir, 'docs/red.md');
		await expect(fs.stat(path.join(s.dir, 'docs', 'blue.md'))).rejects.toMatchObject({
			code: 'ENOENT',
		});
	});

	// Go: rewind_test.go:61-113 TestRewindAfterCommit
	it('TestRewindAfterCommit — old shadow IDs become invalid after user commit', async (ctx) => {
		s = await setupRepo(ctx.task.name);
		ctx.onTestFailed(async () => {
			await captureArtifacts(s);
		});

		await s.runPrompt(
			'create a markdown file at docs/red.md with a paragraph about the colour red. Do not commit the file. Do not ask for confirmation, just make the change.',
		);
		await assertFileExists(s.dir, 'docs/red.md');

		const pointsBefore = await rewindList(s.dir);
		expect(pointsBefore.length, 'expected rewind points before commit').toBeGreaterThan(0);

		// Find the first non-logs-only (shadow) point.
		const shadowPoint = pointsBefore.find((p) => !p.is_logs_only);
		expect(shadowPoint, 'expected at least one shadow-branch rewind point').toBeDefined();
		const oldId = (shadowPoint as RewindPoint).id;

		await s.git('add', '.');
		await s.git('commit', '-m', 'Add red.md');
		await waitForCheckpoint(s, 30_000);

		const pointsAfter = await rewindList(s.dir);
		const found = pointsAfter.some((p) => p.id === oldId && !p.is_logs_only);
		expect(found, `old shadow branch rewind point ${oldId} should no longer be listed`).toBe(false);

		// Attempting to rewind to the stale shadow id must fail.
		const res = await rewindTo(s.dir, oldId);
		expect(res.exitCode, 'rewind to old shadow branch ID should fail after commit').not.toBe(0);

		// File A still committed, shadow branches cleaned up.
		await assertFileExists(s.dir, 'docs/red.md');
		await waitForNoShadowBranches(s.dir, 10_000);
	});

	// Go: rewind_test.go:117-151 TestRewindMultipleFiles
	it('TestRewindMultipleFiles — rewind to first prompt drops only second prompt changes', async (ctx) => {
		s = await setupRepo(ctx.task.name);
		ctx.onTestFailed(async () => {
			await captureArtifacts(s);
		});

		await s.runPrompt(
			'create a markdown file at docs/readme.md with a paragraph about this project. Do not create any other files. Do not ask for confirmation, just make the change.',
		);
		await assertFileExists(s.dir, 'docs/readme.md');

		const pointsAfterA = await rewindList(s.dir);
		expect(pointsAfterA.length, 'expected rewind points after first prompt').toBeGreaterThan(0);

		await s.runPrompt(
			'create a markdown file at docs/changelog.md with a paragraph about recent changes. Do not create any other files. Do not ask for confirmation, just make the change.',
		);
		await assertFileExists(s.dir, 'docs/changelog.md');

		const rewindId = (pointsAfterA[0] as RewindPoint).id;
		const res = await rewindTo(s.dir, rewindId);
		expect(res.exitCode, `rewind to ${rewindId} should succeed: ${res.stderr}`).toBe(0);

		await assertFileExists(s.dir, 'docs/readme.md');
		await expect(fs.stat(path.join(s.dir, 'docs', 'changelog.md'))).rejects.toMatchObject({
			code: 'ENOENT',
		});
	});

	// Go: rewind_test.go:157-225 TestRewindSquashMergeMultipleCheckpoints
	it('TestRewindSquashMergeMultipleCheckpoints — squash merge → 1 logs-only point using latest checkpoint', async (ctx) => {
		s = await setupRepo(ctx.task.name);
		ctx.onTestFailed(async () => {
			await captureArtifacts(s);
		});

		const mainBranch = await s.gitOutput('branch', '--show-current');
		await s.git('add', '.');
		await s.git('commit', '-m', 'Enable story');

		await s.git('checkout', '-b', 'feature');

		await s.runPrompt(
			'create a file at docs/red.md with a paragraph about the colour red. Do not ask for confirmation, just make the change.',
		);
		await s.git('add', '.');
		await s.git('commit', '-m', 'Add red doc');
		await waitForCheckpoint(s, 30_000);
		const cp1Ref = await s.gitOutput('rev-parse', 'story/checkpoints/v1');

		await s.runPrompt(
			'create a file at docs/blue.md with a paragraph about the colour blue. Do not ask for confirmation, just make the change.',
		);
		await s.git('add', '.');
		await s.git('commit', '-m', 'Add blue doc');
		await waitForCheckpointAdvanceFrom(s.dir, cp1Ref, 30_000);

		// Capture both feature-branch checkpoint IDs.
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
		expect(cpId1, 'first feature commit should have trailer').not.toBe('');
		expect(cpId2, 'second feature commit should have trailer').not.toBe('');
		expect(cpId1).not.toBe(cpId2);

		// Squash merge onto main with BOTH Story-Checkpoint trailers in the message.
		await s.git('checkout', mainBranch);
		await s.git('merge', '--squash', 'feature');
		const squashMsg = `Squash merge feature (#1)\n\n* Add red doc\n\nStory-Checkpoint: ${cpId1}\n\n* Add blue doc\n\nStory-Checkpoint: ${cpId2}`;
		await s.git('commit', '-m', squashMsg);
		const squashHash = await s.gitOutput('rev-parse', 'HEAD');

		const points = await rewindList(s.dir);
		const squashPoints = points.filter((p) => p.id === squashHash && p.is_logs_only);
		expect(squashPoints.length, 'expected exactly 1 logs-only rewind point for squash commit').toBe(
			1,
		);
		// Story renames Go's `condensation_id` to `checkpoint_id` (Phase
		// 9.3). The `??` fallback keeps this test resilient if either
		// shape surfaces (Story-produced output has `checkpoint_id`).
		const squashId =
			(squashPoints[0] as RewindPoint).checkpoint_id ??
			(squashPoints[0] as RewindPoint).condensation_id;
		expect(squashId, 'squash merge rewind point should use the latest checkpoint ID').toBe(cpId2);

		const res = await rewindLogsOnly(s.dir, squashHash);
		expect(
			res.exitCode,
			`logs-only rewind of squash merge commit should succeed: ${res.stderr}`,
		).toBe(0);
	});
});
