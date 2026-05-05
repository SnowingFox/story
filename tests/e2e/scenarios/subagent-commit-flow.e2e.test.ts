/**
 * Subagent commit-flow E2E scenario — Vogon canary only.
 *
 * 1:1 port of Go `entire-cli/e2e/tests/subagent_commit_flow_test.go`
 * (1 test). Validates the full checkpoint flow for a "subagent" prompt
 * with deep metadata assertions beyond what `TestSingleSessionSubagent
 * CommitInTurn` covers (checkpoint metadata: cli_version / strategy /
 * sessions; session metadata: agent / session_id fields).
 *
 * **TS-divergence**: Vogon has no dedicated subagent path — the word
 * "subagent" in the prompt is treated as a regular prompt. The Go test
 * shape applies uniformly to Vogon because the assertions are about
 * checkpoint metadata shape, not subagent-specific behaviour.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { captureArtifacts } from '../helpers/artifacts';
import {
	assertCheckpointAdvanced,
	assertCheckpointExists,
	assertFileExists,
	assertHasCheckpointTrailer,
	waitForCheckpoint,
	waitForNoShadowBranches,
} from '../helpers/assertions';
import { readCheckpointMetadata, readSessionMetadata } from '../helpers/metadata';
import { type RepoState, setupRepo, teardownRepo } from '../helpers/repo-state';

describe('subagent commit-flow scenarios (Vogon)', () => {
	let s: RepoState | undefined;

	afterEach(async () => {
		if (s !== undefined) {
			await teardownRepo(s);
			s = undefined;
		}
	});

	// Go: e2e/tests/subagent_commit_flow_test.go:17-47 TestSubagentCommitFlow
	it('TestSubagentCommitFlow — deep metadata validation (cli_version / strategy / sessions / agent field)', async (ctx) => {
		s = await setupRepo(ctx.task.name);
		ctx.onTestFailed(async () => {
			await captureArtifacts(s);
		});

		await s.runPrompt(
			'use a subagent: create a markdown file at docs/red.md with a paragraph about the colour red. Do not commit the file. Do not ask for confirmation, just make the change.',
		);
		await assertFileExists(s.dir, 'docs/red.md');

		await s.git('add', '.');
		await s.git('commit', '-m', 'Add red.md via subagent');

		await waitForCheckpoint(s, 30_000);
		await assertCheckpointAdvanced(s);

		const cpId = await assertHasCheckpointTrailer(s.dir, 'HEAD');
		await assertCheckpointExists(s.dir, cpId);

		// Checkpoint metadata completeness (Go: asserts cli_version /
		// strategy / sessions non-empty).
		const meta = await readCheckpointMetadata(s.dir, cpId);
		expect(meta.cli_version, 'cli_version should be set').not.toBe('');
		expect(meta.strategy, 'strategy should be set').not.toBe('');
		expect(meta.sessions.length, 'checkpoint should have at least 1 session').toBeGreaterThan(0);

		// Session metadata — agent field populated.
		const sm = await readSessionMetadata(s.dir, cpId, 0);
		expect(sm.agent, 'session agent field should be populated').not.toBe('');
		expect(sm.session_id, 'session_id should be set').not.toBe('');
		await waitForNoShadowBranches(s.dir, 10_000);
	});
});
