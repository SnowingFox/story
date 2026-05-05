/**
 * Deleted-files E2E scenario — Vogon canary only.
 *
 * 1:1 port of Go `entire-cli/e2e/tests/deleted_files_test.go` (1 test).
 * Validates that a combined rm + create commit (via `git add .`) still
 * lands on the checkpoint branch — regression for the old
 * "delete without separate git-rm commit" path.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, it } from 'vitest';
import { captureArtifacts } from '../helpers/artifacts';
import {
	assertCheckpointExists,
	assertFileExists,
	assertHasCheckpointTrailer,
	waitForCheckpoint,
	waitForNoShadowBranches,
} from '../helpers/assertions';
import { type RepoState, setupRepo, teardownRepo } from '../helpers/repo-state';

describe('deleted-files scenarios (Vogon)', () => {
	let s: RepoState | undefined;

	afterEach(async () => {
		if (s !== undefined) {
			await teardownRepo(s);
			s = undefined;
		}
	});

	// Go: e2e/tests/deleted_files_test.go:20-50 TestDeletedFilesCommitDeletion
	it('TestDeletedFilesCommitDeletion — delete + create bundled in one commit lands on branch', async (ctx) => {
		s = await setupRepo(ctx.task.name);
		ctx.onTestFailed(async () => {
			await captureArtifacts(s);
		});

		await fs.writeFile(path.join(s.dir, 'to_delete.go'), 'package main\n\nfunc ToDelete() {}\n');
		await s.git('add', 'to_delete.go');
		await s.git('commit', '--no-verify', '-m', 'Add to_delete.go');

		await s.runPrompt(
			'Do two things: (1) Delete the file to_delete.go using rm. ' +
				"(2) Create a new file replacement.go with content 'package main; func Replacement() {}'. " +
				'Do both tasks. Do not commit. ' +
				'Do not ask for confirmation, just make the changes.',
		);

		await assertFileExists(s.dir, 'replacement.go');
		// `assertFileExists` doesn't support negative assertions; verify
		// deletion manually. Capture dir in a local to satisfy
		// `noUncheckedIndexedAccess` / `strictNullChecks`.
		const repoDir = s.dir;
		await new Promise<void>((resolve, reject) => {
			fs.stat(path.join(repoDir, 'to_delete.go'))
				.then(() => reject(new Error('to_delete.go should be removed')))
				.catch(() => resolve());
		});

		// `git add .` stages BOTH the deletion and the new file.
		await s.git('add', '.');
		await s.git('commit', '-m', 'Add replacement');
		await waitForCheckpoint(s, 30_000);

		const cpId = await assertHasCheckpointTrailer(s.dir, 'HEAD');
		await assertCheckpointExists(s.dir, cpId);
		await waitForNoShadowBranches(s.dir, 10_000);
	});
});
