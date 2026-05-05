/**
 * Interactive multi-step E2E scenario — Vogon canary only.
 *
 * 1:1 port of Go `entire-cli/e2e/tests/interactive_test.go::
 * TestInteractiveMultiStep`. Exercises Vogon's stdin interactive mode
 * (no `-p` flag) via the `runVogonInteractive` helper to drive two
 * prompts in a single Vogon subprocess — session phase transitions
 * ACTIVE → IDLE per turn, then ends when `exit` closes stdin.
 *
 * The Go version uses tmux + PromptPattern waits; TS collapses to a
 * single `execa` call that pipes `"<prompt1>\n<prompt2>\nexit\n"` to
 * stdin, keeping the test shape deterministic without a TUI emulator.
 */

import { afterEach, describe, it } from 'vitest';
import { captureArtifacts } from '../helpers/artifacts';
import {
	assertCommitLinkedToCheckpoint,
	assertNewCommitsWithTimeout,
	waitForCheckpoint,
	waitForFileExists,
	waitForNoShadowBranches,
	waitForSessionIdle,
} from '../helpers/assertions';
import { type RepoState, setupRepo, teardownRepo } from '../helpers/repo-state';
import { runVogonInteractive } from '../helpers/vogon-runner';

describe('interactive multi-step scenarios (Vogon)', () => {
	let s: RepoState | undefined;

	afterEach(async () => {
		if (s !== undefined) {
			await teardownRepo(s);
			s = undefined;
		}
	});

	// Go: e2e/tests/interactive_test.go:13-41 TestInteractiveMultiStep
	it('TestInteractiveMultiStep — 2 prompts in one interactive session → 1 commit + checkpoint advance', async (ctx) => {
		s = await setupRepo(ctx.task.name);
		ctx.onTestFailed(async () => {
			await captureArtifacts(s);
		});

		// Drive two prompts through Vogon's stdin loop. Second prompt
		// includes "commit" so Vogon's parsePrompt emits a `commit`
		// action mid-turn while the session is ACTIVE.
		await runVogonInteractive(s.dir, [
			'create a markdown file at docs/red.md with a paragraph about the colour red. Do not ask for confirmation, just make the change.',
			'now commit it',
		]);

		await waitForFileExists(s.dir, 'docs/*.md', 30_000);
		await assertNewCommitsWithTimeout(s, 1, 60_000);

		// Go waits for session-end (which fires on Vogon exit) — TS
		// `waitForSessionIdle` matches semantics: no sessions in ACTIVE
		// phase. Headless Vogon transitions through idle → ended quickly.
		await waitForSessionIdle(s.dir, 15_000);
		await waitForCheckpoint(s, 30_000);
		await assertCommitLinkedToCheckpoint(s.dir, 'HEAD');
		await waitForNoShadowBranches(s.dir, 10_000);
	});
});
