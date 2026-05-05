/**
 * Existing-files E2E scenarios — Vogon canary only.
 *
 * 1:1 port of Go `entire-cli/e2e/tests/existing_files_test.go` (4
 * tests). Covers tracked-file modification, mixed-new-and-modified
 * commits, content-overlap skip on new-file revert, and the
 * "modified files always checkpoint" invariant.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { captureArtifacts } from '../helpers/artifacts';
import {
	assertCheckpointAdvanced,
	assertCheckpointExists,
	assertCheckpointNotAdvanced,
	assertFileExists,
	assertHasCheckpointTrailer,
	assertHasShadowBranches,
	assertNoCheckpointTrailer,
	waitForCheckpoint,
	waitForCheckpointExists,
	waitForNoShadowBranches,
} from '../helpers/assertions';
import { type RepoState, setupRepo, teardownRepo } from '../helpers/repo-state';

describe('existing-files scenarios (Vogon)', () => {
	let s: RepoState | undefined;

	afterEach(async () => {
		if (s !== undefined) {
			await teardownRepo(s);
			s = undefined;
		}
	});

	// Go: e2e/tests/existing_files_test.go:18-47 TestModifyExistingTrackedFile
	it('TestModifyExistingTrackedFile — modify tracked file + commit → checkpoint', async (ctx) => {
		s = await setupRepo(ctx.task.name);
		ctx.onTestFailed(async () => {
			await captureArtifacts(s);
		});

		// Create tracked file.
		await fs.mkdir(path.join(s.dir, 'src'), { recursive: true });
		await fs.writeFile(
			path.join(s.dir, 'src', 'config.go'),
			'package src\n\n// Config placeholder.\n',
		);
		await s.git('add', 'src/');
		await s.git('commit', '-m', 'Add initial config.go');

		await s.runPrompt(
			'modify src/config.go to add a function GetPort() int that returns 8080. Do not ask for confirmation, just make the change.',
		);

		await s.git('add', '.');
		await s.git('commit', '-m', 'Update config.go');

		await waitForCheckpoint(s, 30_000);
		await assertCheckpointAdvanced(s);

		const cpId = await assertHasCheckpointTrailer(s.dir, 'HEAD');
		await assertCheckpointExists(s.dir, cpId);
		await waitForNoShadowBranches(s.dir, 10_000);
	});

	// Go: existing_files_test.go:52-89 TestMixedNewAndModifiedFiles
	it('TestMixedNewAndModifiedFiles — modify + create across two commits → 2 checkpoints', async (ctx) => {
		s = await setupRepo(ctx.task.name);
		ctx.onTestFailed(async () => {
			await captureArtifacts(s);
		});

		await fs.mkdir(path.join(s.dir, 'src'), { recursive: true });
		await fs.writeFile(path.join(s.dir, 'src', 'main.go'), 'package main\n');
		await s.git('add', 'src/');
		await s.git('commit', '-m', 'Add initial main.go');

		await s.runPrompt(
			'modify src/main.go to add a main function, and also create exactly two new files: src/utils.go with a helper function and src/types.go with a User type definition. Put them directly in the src/ directory, not in any subdirectory. Do not ask for confirmation, just make the changes.',
		);

		await s.git('add', 'src/main.go');
		await s.git('commit', '-m', 'Update main.go');
		await waitForCheckpoint(s, 30_000);
		const cpId1 = await assertHasCheckpointTrailer(s.dir, 'HEAD');

		await s.git('add', '.');
		await s.git('commit', '-m', 'Add utils.go and types.go');
		const cpId2 = await assertHasCheckpointTrailer(s.dir, 'HEAD');
		await waitForCheckpointExists(s.dir, cpId2, 30_000);

		expect(cpId1, 'checkpoint IDs should be distinct').not.toBe(cpId2);
		await assertCheckpointExists(s.dir, cpId1);
		await assertCheckpointExists(s.dir, cpId2);
		await waitForNoShadowBranches(s.dir, 10_000);
	});

	// Go: existing_files_test.go:95-135 TestInteractiveContentOverlapRevertNewFile
	//
	// Originally `.skip`-ed because Go uses an interactive tmux session
	// that stays "idle" (not "ended") between turns while Vogon headless
	// immediately fires session-end. After the Phase 5.x bug fixes
	// (`git status --porcelain -uall` + `execGit trim: false`),
	// `stagedFilesOverlapWithContent` correctly compares blob hashes and
	// finds no overlap when the user overwrites file content — the
	// negative-case assertions (no trailer + no checkpoint advance +
	// shadow persists because no condensation occurred) now hold for
	// headless Vogon too, since they depend on content-overlap logic
	// rather than session-phase-alive semantics.
	it('TestInteractiveContentOverlapRevertNewFile — user overwrites agent file → no checkpoint', async (ctx) => {
		s = await setupRepo(ctx.task.name);
		ctx.onTestFailed(async () => {
			await captureArtifacts(s);
		});

		await s.runPrompt(
			"create a markdown file at docs/red.md with a paragraph about the colour red. Don't commit, I want to make more changes.",
		);
		await assertFileExists(s.dir, 'docs/red.md');

		// User replaces the content entirely (different blob hash from
		// what the agent wrote).
		await fs.writeFile(
			path.join(s.dir, 'docs', 'red.md'),
			'# Completely different content\n\nNothing about red here.\n',
		);
		await s.git('add', 'docs/red.md');
		await s.git('commit', '-m', 'Replace red.md content');

		// Give post-commit hook time to fire.
		await new Promise<void>((r) => setTimeout(r, 5_000));

		await assertNoCheckpointTrailer(s.dir, 'HEAD');
		await assertCheckpointNotAdvanced(s);
		// Shadow branch persists: content mismatch → no condensation
		// → post-commit hook's cleanup path never runs.
		await assertHasShadowBranches(s.dir);
	});

	// Go: existing_files_test.go:141-176 TestModifiedFileAlwaysGetsCheckpoint
	it('TestModifiedFileAlwaysGetsCheckpoint — rewriting modified file still yields checkpoint', async (ctx) => {
		s = await setupRepo(ctx.task.name);
		ctx.onTestFailed(async () => {
			await captureArtifacts(s);
		});

		await fs.mkdir(path.join(s.dir, 'src'), { recursive: true });
		await fs.writeFile(
			path.join(s.dir, 'src', 'config.go'),
			'package src\n\n// Config placeholder.\n',
		);
		await s.git('add', 'src/');
		await s.git('commit', '-m', 'Add initial config.go');

		await s.runPrompt(
			'modify src/config.go to add a function GetPort() int that returns 8080. Do not ask for confirmation, just make the change.',
		);

		// User overwrites with completely different content.
		await fs.writeFile(
			path.join(s.dir, 'src', 'config.go'),
			'package src\n\n// User rewrote this entirely.\nfunc GetHost() string { return "localhost" }\n',
		);

		await s.git('add', '.');
		await s.git('commit', '-m', 'Rewrite config.go');

		await waitForCheckpoint(s, 30_000);
		await assertCheckpointAdvanced(s);

		const cpId = await assertHasCheckpointTrailer(s.dir, 'HEAD');
		await assertCheckpointExists(s.dir, cpId);
		await waitForNoShadowBranches(s.dir, 10_000);
	});
});
