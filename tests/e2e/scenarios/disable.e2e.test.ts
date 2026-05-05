/**
 * Disable E2E scenario — Vogon canary only.
 *
 * 1:1 port of Go `entire-cli/e2e/tests/disable_test.go`. After running
 * `story disable` (renamed from Go `entire disable`), subsequent commits
 * must not produce checkpoints or trailers.
 */

import { afterEach, describe, it } from 'vitest';
import { captureArtifacts } from '../helpers/artifacts';
import { assertCheckpointNotAdvanced, assertNoCheckpointTrailer } from '../helpers/assertions';
import { type RepoState, setupRepo, teardownRepo } from '../helpers/repo-state';
import { storyDisable } from '../helpers/story';

describe('disable scenario (Vogon)', () => {
	let s: RepoState | undefined;

	afterEach(async () => {
		if (s !== undefined) {
			await teardownRepo(s);
			s = undefined;
		}
	});

	// Go: e2e/tests/disable_test.go:19-41 TestEntireDisable — renamed TS-side:
	// "TestStoryDisable" (only the test title changes; assertions identical).
	it('TestStoryDisable — commit after disable has no checkpoint or trailer', async (ctx) => {
		s = await setupRepo(ctx.task.name);
		ctx.onTestFailed(async () => {
			await captureArtifacts(s);
		});

		await storyDisable(s.dir);

		const fs = await import('node:fs/promises');
		const path = await import('node:path');
		await fs.mkdir(path.join(s.dir, 'docs'), { recursive: true });
		await fs.writeFile(path.join(s.dir, 'docs', 'manual.md'), '# Manual\n');

		await s.git('add', 'docs/');
		await s.git('commit', '-m', 'Commit after disable');

		// Give post-commit hook time to fire (if it were going to).
		await new Promise<void>((r) => setTimeout(r, 5_000));

		await assertCheckpointNotAdvanced(s);
		await assertNoCheckpointTrailer(s.dir, 'HEAD');
	});
});
