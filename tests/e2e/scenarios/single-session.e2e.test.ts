/**
 * Single-session E2E scenarios — Vogon canary only (real-agent matrix
 * runs in a separate CI workflow per Phase 10 plan TS-divergence #2).
 *
 * 1:1 port of Go `entire-cli/e2e/tests/single_session_test.go`. Every
 * `it` cites the Go test function it mirrors; behavior / assertions
 * follow Go exactly except for:
 *
 *  - Trailer key `Story-Checkpoint:` (Go uses `Entire-Checkpoint:`)
 *  - Checkpoint branch `story/checkpoints/v1` (Go `entire/checkpoints/v1`)
 *  - Vogon as the only agent (Go iterates all registered agents)
 */

import { afterEach, beforeEach, describe, it } from 'vitest';
import { captureArtifacts } from '../helpers/artifacts';
import {
	assertCheckpointAdvanced,
	assertCheckpointExists,
	assertCheckpointInLastN,
	assertCheckpointMetadataComplete,
	assertCheckpointNotAdvanced,
	assertFileExists,
	assertHasCheckpointTrailer,
	assertNewCommits,
	assertNoCheckpointTrailer,
	waitForCheckpoint,
	waitForNoShadowBranches,
} from '../helpers/assertions';
import { type RepoState, setupRepo, teardownRepo } from '../helpers/repo-state';

describe('single-session scenarios (Vogon)', () => {
	let s: RepoState | undefined;

	afterEach(async () => {
		if (s !== undefined) {
			await teardownRepo(s);
			s = undefined;
		}
	});

	// Go: e2e/tests/single_session_test.go:18-39 TestHumanOnlyChangesAndCommits
	it('TestHumanOnlyChangesAndCommits — human-only commit has no checkpoint trailer', async (ctx) => {
		s = await setupRepo(ctx.task.name);
		ctx.onTestFailed(async () => {
			await captureArtifacts(s);
		});

		// Human writes + commits without any agent interaction.
		await s.git('config', 'user.name', 'Human');
		const docs = `${s.dir}/docs`;
		const fs = await import('node:fs/promises');
		await fs.mkdir(docs, { recursive: true });
		await fs.writeFile(`${docs}/human.md`, '# Written by a human\n');

		await s.git('add', 'docs/');
		await s.git('commit', '-m', 'Human-only commit');

		// Give post-commit hook time to fire (if it were going to).
		await new Promise<void>((r) => setTimeout(r, 5_000));

		await assertCheckpointNotAdvanced(s);
		await assertNoCheckpointTrailer(s.dir, 'HEAD');
	});

	// Go: single_session_test.go:42-63 TestSingleSessionManualCommit
	it('TestSingleSessionManualCommit — prompt + user commit → 1 checkpoint', async (ctx) => {
		s = await setupRepo(ctx.task.name);
		ctx.onTestFailed(async () => {
			await captureArtifacts(s);
		});

		await s.runPrompt(
			'create a markdown file at docs/red.md with a paragraph about the colour red. Do not ask for confirmation, just make the change.',
		);

		await s.git('add', '.');
		await s.git('commit', '-m', 'Add md file about red');

		await assertFileExists(s.dir, 'docs/*.md');
		await assertNewCommits(s, 1);

		await waitForCheckpoint(s, 30_000);
		await assertCheckpointAdvanced(s);

		const cpId = await assertHasCheckpointTrailer(s.dir, 'HEAD');
		await assertCheckpointExists(s.dir, cpId);
		await assertCheckpointMetadataComplete(s.dir, cpId);
		await waitForNoShadowBranches(s.dir, 10_000);
	});

	// Go: single_session_test.go:69-87 TestSingleSessionAgentCommitInTurn
	it('TestSingleSessionAgentCommitInTurn — agent commits mid-turn → initial + catchup share same checkpoint ID', async (ctx) => {
		s = await setupRepo(ctx.task.name);
		ctx.onTestFailed(async () => {
			await captureArtifacts(s);
		});

		await s.runPrompt(
			'create a markdown file at docs/red.md with a paragraph about the colour red, then commit it. Do not ask for confirmation, just make the change.',
		);

		await assertFileExists(s.dir, 'docs/*.md');

		await waitForCheckpoint(s, 30_000);
		await assertCheckpointAdvanced(s);

		const cpId = await assertHasCheckpointTrailer(s.dir, 'HEAD');
		await assertCheckpointExists(s.dir, cpId);
		await assertCheckpointInLastN(s.dir, cpId, 2);
		await waitForNoShadowBranches(s.dir, 10_000);
	});

	// Go: single_session_test.go:92-114 TestSingleSessionSubagentCommitInTurn
	// (Go skipped this on `copilot-cli`; Vogon has no subagent special-casing —
	// prompt parser treats "use a subagent" as a regular prompt.)
	it('TestSingleSessionSubagentCommitInTurn — prompt w/ "subagent" wording still gets checkpoint (Vogon: no subagent path)', async (ctx) => {
		s = await setupRepo(ctx.task.name);
		ctx.onTestFailed(async () => {
			await captureArtifacts(s);
		});

		await s.runPrompt(
			'use a subagent: create a markdown file at docs/red.md with a paragraph about the colour red, then commit it. Do not ask for confirmation, just make the change.',
		);

		await assertFileExists(s.dir, 'docs/*.md');

		await waitForCheckpoint(s, 30_000);
		await assertCheckpointAdvanced(s);

		const cpId = await assertHasCheckpointTrailer(s.dir, 'HEAD');
		await assertCheckpointExists(s.dir, cpId);
		await assertCheckpointInLastN(s.dir, cpId, 2);
		await waitForNoShadowBranches(s.dir, 10_000);
	});

	// Prevent unused-binding warnings when vitest doesn't wire setup via beforeEach.
	beforeEach(() => {
		// `s` is assigned inside each `it`.
	});
});
