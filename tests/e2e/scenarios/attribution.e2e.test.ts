/**
 * Attribution E2E scenarios — Vogon canary only.
 *
 * 1:1 port of Go `entire-cli/e2e/tests/attribution_test.go` (5 tests).
 * Validates that `InitialAttribution` metadata is populated reasonably:
 * agent-authored content registers as agent lines, human-authored content
 * registers as human-added, and mixed sessions split correctly.
 *
 * **TS-divergence (Go interactive mode)**: Go tests 2-4 use
 * `s.StartSession()` (tmux-driven multi-turn interactive shell). Vogon
 * supports stdin interactive mode but `tests/e2e/helpers/vogon-runner.ts`
 * exposes only headless `-p <prompt>` spawns. We approximate interactive
 * multi-commit behaviour by chaining `s.runPrompt('... then commit')` +
 * `s.runPrompt('... then commit')` — the assertion surface
 * (`agent_lines`, `total_committed`, `agent_percentage`) is unchanged.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { captureArtifacts } from '../helpers/artifacts';
import {
	assertFileExists,
	assertHasCheckpointTrailer,
	waitForCheckpoint,
	waitForCheckpointAdvanceFrom,
	waitForCheckpointExists,
	waitForNoShadowBranches,
} from '../helpers/assertions';
import { readSessionMetadata, waitForSessionMetadata } from '../helpers/metadata';
import { type RepoState, setupRepo, teardownRepo } from '../helpers/repo-state';

describe('attribution scenarios (Vogon)', () => {
	let s: RepoState | undefined;

	afterEach(async () => {
		if (s !== undefined) {
			await teardownRepo(s);
			s = undefined;
		}
	});

	// Go: e2e/tests/attribution_test.go:20-45 TestLineAttributionReasonable
	it('TestLineAttributionReasonable — agent writes 100% of a file → agent_percentage > 50', async (ctx) => {
		s = await setupRepo(ctx.task.name);
		ctx.onTestFailed(async () => {
			await captureArtifacts(s);
		});

		await s.runPrompt(
			'create a single markdown file at docs/example.md with a few paragraphs about software testing. Do not ask for confirmation, just make the change.',
		);
		await assertFileExists(s.dir, 'docs/example.md');

		await s.git('add', 'docs/');
		await s.git('commit', '-m', 'Add example.md');
		await waitForCheckpoint(s, 30_000);

		const cpId = await assertHasCheckpointTrailer(s.dir, 'HEAD');
		const sm = await readSessionMetadata(s.dir, cpId, 0);

		expect(sm.initial_attribution.agent_lines, 'agent lines should be > 0').toBeGreaterThan(0);
		expect(sm.initial_attribution.total_committed, 'total committed should be > 0').toBeGreaterThan(
			0,
		);
		expect(
			sm.initial_attribution.agent_percentage,
			'agent wrote ~100% of content, percentage should be > 50',
		).toBeGreaterThan(50);
		await waitForNoShadowBranches(s.dir, 10_000);
	});

	// Go: attribution_test.go:50-75 TestInteractiveAttributionOnAgentCommit
	// (TS-divergence: headless single-turn with mid-turn commit.)
	it('TestInteractiveAttributionOnAgentCommit — agent-commits-in-turn records initial_attribution', async (ctx) => {
		s = await setupRepo(ctx.task.name);
		ctx.onTestFailed(async () => {
			await captureArtifacts(s);
		});

		// Vogon commits mid-turn so the session is still ACTIVE when
		// prepare-commit-msg fires (matches Go's interactive-session flow).
		await s.runPrompt(
			"create a file called hello.txt with content 'hello world', then commit it. Do not ask for confirmation.",
		);

		await waitForCheckpoint(s, 30_000);
		const cpId = await assertHasCheckpointTrailer(s.dir, 'HEAD');
		const sm = await readSessionMetadata(s.dir, cpId, 0);

		expect(
			sm.initial_attribution.agent_lines,
			'agent lines should be > 0 on first agent commit',
		).toBeGreaterThan(0);
		expect(
			sm.initial_attribution.total_committed,
			'total committed should be > 0 on first agent commit',
		).toBeGreaterThan(0);
		await waitForNoShadowBranches(s.dir, 10_000);
	});

	// Go: attribution_test.go:80-115 TestInteractiveAttributionMultiCommitSameSession
	it('TestInteractiveAttributionMultiCommitSameSession — second commit also records agent lines', async (ctx) => {
		s = await setupRepo(ctx.task.name);
		ctx.onTestFailed(async () => {
			await captureArtifacts(s);
		});

		// First turn: create poem + commit.
		await s.runPrompt(
			'create a file called poem.txt with a short poem about coding, then commit it. Do not ask for confirmation.',
		);
		await waitForCheckpoint(s, 30_000);
		const cp1Ref = await s.gitOutput('rev-parse', 'story/checkpoints/v1');

		// Second turn: modify same file + commit again.
		await s.runPrompt(
			'add another stanza to poem.txt about debugging, then commit it. Do not ask for confirmation.',
		);
		await waitForCheckpointAdvanceFrom(s.dir, cp1Ref, 30_000);

		const cpId2 = await assertHasCheckpointTrailer(s.dir, 'HEAD');
		await waitForCheckpointExists(s.dir, cpId2, 30_000);
		const sm = await waitForSessionMetadata(s.dir, cpId2, 0, 10_000);

		expect(
			sm.initial_attribution.agent_lines,
			'agent lines should be > 0 on second commit',
		).toBeGreaterThan(0);
		expect(
			sm.initial_attribution.total_committed,
			'total committed should be > 0 on second commit',
		).toBeGreaterThan(0);
		await waitForNoShadowBranches(s.dir, 10_000);
	});

	// Go: attribution_test.go:120-139 TestInteractiveShadowBranchCleanedAfterAgentCommit
	it('TestInteractiveShadowBranchCleanedAfterAgentCommit — shadow branches cleaned up after agent commit', async (ctx) => {
		s = await setupRepo(ctx.task.name);
		ctx.onTestFailed(async () => {
			await captureArtifacts(s);
		});

		await s.runPrompt(
			"create a file called hello.txt with content 'hello world', then commit it. Do not ask for confirmation.",
		);
		await waitForCheckpoint(s, 30_000);
		await waitForNoShadowBranches(s.dir, 10_000);
	});

	// Go: attribution_test.go:144-191 TestAttributionMixedHumanAndAgent
	it('TestAttributionMixedHumanAndAgent — agent + human files split correctly', async (ctx) => {
		s = await setupRepo(ctx.task.name);
		ctx.onTestFailed(async () => {
			await captureArtifacts(s);
		});

		await s.runPrompt(
			'create a file called agent.txt with a few lines about software testing. Do not create any other files. Do not ask for confirmation, just make the change.',
		);
		await assertFileExists(s.dir, 'agent.txt');

		// Count agent-written lines before adding human content.
		const agentContent = await fs.readFile(path.join(s.dir, 'agent.txt'), 'utf-8');
		const agentLines = agentContent.replace(/\n+$/, '').split('\n').length;

		// Human writes a known 3-line file.
		const humanContent = 'line one\nline two\nline three\n';
		const humanLines = 3;
		await fs.writeFile(path.join(s.dir, 'human.txt'), humanContent);

		// Stage exactly the two files we control so attribution counters
		// line up (Go comment: "stage only intended files — attribution
		// checks exact line counts").
		await s.git('add', 'agent.txt', 'human.txt');
		await s.git('commit', '-m', 'Add agent and human files');
		await waitForCheckpoint(s, 30_000);

		const cpId = await assertHasCheckpointTrailer(s.dir, 'HEAD');
		const sm = await readSessionMetadata(s.dir, cpId, 0);

		expect(
			sm.initial_attribution.agent_lines,
			'agent_lines should match actual lines in agent.txt',
		).toBe(agentLines);
		expect(sm.initial_attribution.human_added, 'human_added should match lines in human.txt').toBe(
			humanLines,
		);
		expect(
			sm.initial_attribution.total_committed,
			'total_committed should be sum of agent + human lines',
		).toBe(agentLines + humanLines);
		expect(
			sm.initial_attribution.agent_percentage,
			'agent_percentage should be > 0 when agent wrote content',
		).toBeGreaterThan(0);
		expect(
			sm.initial_attribution.agent_percentage,
			'agent_percentage should be < 100 when human also wrote content',
		).toBeLessThan(100);
	});
});
