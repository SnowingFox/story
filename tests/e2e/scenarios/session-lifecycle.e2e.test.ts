/**
 * Session-lifecycle E2E scenarios — Vogon canary only.
 *
 * 1:1 port of Go `entire-cli/e2e/tests/session_lifecycle_test.go` (3
 * tests). Validates depleted-session vs still-active-session behaviour
 * and the trailer-removal bypass path.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { captureArtifacts } from '../helpers/artifacts';
import {
	assertCheckpointExists,
	assertCheckpointNotAdvanced,
	assertFileExists,
	assertHasCheckpointTrailer,
	assertNoCheckpointTrailer,
	waitForCheckpoint,
	waitForCheckpointExists,
	waitForNoShadowBranches,
} from '../helpers/assertions';
import { type RepoState, setupRepo, teardownRepo } from '../helpers/repo-state';

describe('session-lifecycle scenarios (Vogon)', () => {
	let s: RepoState | undefined;

	afterEach(async () => {
		if (s !== undefined) {
			await teardownRepo(s);
			s = undefined;
		}
	});

	// Go: e2e/tests/session_lifecycle_test.go:18-49 TestEndedSessionUserCommitsAfterExit
	it('TestEndedSessionUserCommitsAfterExit — user commits after agent exit still get trailers', async (ctx) => {
		s = await setupRepo(ctx.task.name);
		ctx.onTestFailed(async () => {
			await captureArtifacts(s);
		});

		await s.runPrompt(
			"Create three files: ended_a.go with 'package main; func EndedA() {}', " +
				"ended_b.go with 'package main; func EndedB() {}', " +
				"ended_c.go with 'package main; func EndedC() {}'. " +
				'Create all three files, nothing else. Do not commit. ' +
				'Do not ask for confirmation, just make the changes.',
		);
		await assertFileExists(s.dir, 'ended_a.go');
		await assertFileExists(s.dir, 'ended_b.go');
		await assertFileExists(s.dir, 'ended_c.go');

		await s.git('add', 'ended_a.go', 'ended_b.go');
		await s.git('commit', '-m', 'Add ended files A and B');
		await waitForCheckpoint(s, 30_000);
		const cpId1 = await assertHasCheckpointTrailer(s.dir, 'HEAD');

		await s.git('add', 'ended_c.go');
		await s.git('commit', '-m', 'Add ended file C');
		const cpId2 = await assertHasCheckpointTrailer(s.dir, 'HEAD');
		await waitForCheckpointExists(s.dir, cpId2, 30_000);

		expect(cpId1, 'each commit should have its own checkpoint ID').not.toBe(cpId2);
		await assertCheckpointExists(s.dir, cpId1);
		await assertCheckpointExists(s.dir, cpId2);
		await waitForNoShadowBranches(s.dir, 10_000);
	});

	// Go: session_lifecycle_test.go:53-86 TestSessionDepletedManualEditNoCheckpoint
	it('TestSessionDepletedManualEditNoCheckpoint — manual edit after depletion does not advance branch', async (ctx) => {
		s = await setupRepo(ctx.task.name);
		ctx.onTestFailed(async () => {
			await captureArtifacts(s);
		});

		await s.runPrompt(
			"Create a file called depleted.go with content 'package main; func Depleted() {}'. " +
				'Create only this file. Do not commit. ' +
				'Do not ask for confirmation, just make the change.',
		);
		await assertFileExists(s.dir, 'depleted.go');

		await s.git('add', '.');
		await s.git('commit', '-m', 'Add depleted.go');
		await waitForCheckpoint(s, 30_000);
		const cpId = await assertHasCheckpointTrailer(s.dir, 'HEAD');
		await assertCheckpointExists(s.dir, cpId);

		const cpBranchAfterAgent = await s.gitOutput('rev-parse', 'story/checkpoints/v1');

		// Human-edits the same file; no agent interaction → no checkpoint.
		await fs.writeFile(
			path.join(s.dir, 'depleted.go'),
			'package main\n\n// Manual user edit\nfunc Depleted() { return }\n',
		);
		await s.git('add', 'depleted.go');
		await s.git('commit', '-m', 'Manual edit to depleted.go');

		await new Promise<void>((r) => setTimeout(r, 5_000));
		const cpBranchAfterManual = await s.gitOutput('rev-parse', 'story/checkpoints/v1');
		expect(
			cpBranchAfterManual,
			'manual edit after session depletion should not advance checkpoint branch',
		).toBe(cpBranchAfterAgent);
		await assertNoCheckpointTrailer(s.dir, 'HEAD');
		await waitForNoShadowBranches(s.dir, 10_000);
	});

	// Go: session_lifecycle_test.go:90-112 TestTrailerRemovalSkipsCondensation
	it('TestTrailerRemovalSkipsCondensation — bypassing hooks skips condensation', async (ctx) => {
		s = await setupRepo(ctx.task.name);
		ctx.onTestFailed(async () => {
			await captureArtifacts(s);
		});

		await s.runPrompt(
			"Create a file called trailer_test.go with content 'package main; func TrailerTest() {}'. " +
				'Create only this file. Do not commit. ' +
				'Do not ask for confirmation, just make the change.',
		);
		await assertFileExists(s.dir, 'trailer_test.go');

		// Bypass all git hooks by pointing core.hooksPath at an empty
		// directory (matches Go `-c core.hooksPath=<empty>` pattern).
		const emptyHooksDir = await fs.mkdtemp(
			path.join(require('node:os').tmpdir(), 'story-empty-hooks-'),
		);
		await s.git('-c', `core.hooksPath=${emptyHooksDir}`, 'add', '.');
		await s.git(
			'-c',
			`core.hooksPath=${emptyHooksDir}`,
			'commit',
			'-m',
			'Add trailer_test (no checkpoint)',
		);
		await fs.rm(emptyHooksDir, { recursive: true, force: true });

		await assertNoCheckpointTrailer(s.dir, 'HEAD');

		await new Promise<void>((r) => setTimeout(r, 5_000));
		await assertCheckpointNotAdvanced(s);
		// Shadow branch legitimately persists: hooks were bypassed so
		// post-commit cleanup never ran — matches Go expectation.
	});
});
