/**
 * Checkpoint metadata E2E scenario — Vogon canary only.
 *
 * 1:1 port of Go `entire-cli/e2e/tests/checkpoint_metadata_test.go`.
 * Exercises the `validateCheckpointDeep` helper's full contract:
 * metadata fields complete, files_touched exact match, transcript JSONL
 * valid, SHA-256 content-hash match.
 */

import { afterEach, describe, it } from 'vitest';
import { captureArtifacts } from '../helpers/artifacts';
import {
	assertFileExists,
	assertHasCheckpointTrailer,
	validateCheckpointDeep,
	waitForCheckpoint,
	waitForNoShadowBranches,
} from '../helpers/assertions';
import { type RepoState, setupRepo, teardownRepo } from '../helpers/repo-state';

describe('checkpoint-metadata deep validation (Vogon)', () => {
	let s: RepoState | undefined;

	afterEach(async () => {
		if (s !== undefined) {
			await teardownRepo(s);
			s = undefined;
		}
	});

	// Go: e2e/tests/checkpoint_metadata_test.go:15-40 TestCheckpointMetadataDeepValidation
	it('TestCheckpointMetadataDeepValidation — metadata + files_touched + transcript hash all check out', async (ctx) => {
		s = await setupRepo(ctx.task.name);
		ctx.onTestFailed(async () => {
			await captureArtifacts(s);
		});

		await s.runPrompt(
			"create a file called validated.go with content 'package main; func Validated() {}'. Create only this file. Do not commit. Do not ask for confirmation, just make the change.",
		);

		await assertFileExists(s.dir, 'validated.go');
		await s.git('add', '.');
		await s.git('commit', '-m', 'Add validated.go');
		await waitForCheckpoint(s, 30_000);

		const cpId = await assertHasCheckpointTrailer(s.dir, 'HEAD');
		await validateCheckpointDeep(s.dir, {
			checkpointId: cpId,
			strategy: 'manual-commit',
			filesTouched: ['validated.go'],
		});
		await waitForNoShadowBranches(s.dir, 10_000);
	});
});
