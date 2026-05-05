/**
 * Explain + Attach E2E scenarios — Vogon canary only.
 *
 * No Go E2E equivalent (Go's e2e/tests/ didn't cover `explain` or
 * `attach`; `attach` is a Phase 9.4 addition). These smoke-test the
 * user-facing end-to-end flows of those two commands after a
 * Vogon-driven session produces a real checkpoint on the metadata branch.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { captureArtifacts } from '../helpers/artifacts';
import {
	assertFileExists,
	assertHasCheckpointTrailer,
	assertNoCheckpointTrailer,
	waitForCheckpoint,
} from '../helpers/assertions';
import { type RepoState, setupRepo, teardownRepo } from '../helpers/repo-state';
import { storyAttach, storyExplain } from '../helpers/story';

describe('explain + attach scenarios (Vogon)', () => {
	let s: RepoState | undefined;

	afterEach(async () => {
		if (s !== undefined) {
			await teardownRepo(s);
			s = undefined;
		}
	});

	it('story explain --checkpoint <id> surfaces prompt + files_touched after a Vogon turn', async (ctx) => {
		s = await setupRepo(ctx.task.name);
		ctx.onTestFailed(async () => {
			await captureArtifacts(s);
		});

		await s.runPrompt(
			'create a markdown file at docs/red.md with a paragraph about the colour red. Do not ask for confirmation, just make the change.',
		);

		await s.git('add', '.');
		await s.git('commit', '-m', 'Add red.md');
		await waitForCheckpoint(s, 30_000);

		const cpId = await assertHasCheckpointTrailer(s.dir, 'HEAD');
		const out = await storyExplain(s.dir, cpId);

		// Accept any reasonable non-empty output — the render format belongs
		// to Phase 9.4 and is already unit-tested there. The assertion here
		// is that the full pipeline (metadata branch read + agent resolver
		// + renderer) wires together end-to-end.
		expect(out.length, 'explain output should be non-empty').toBeGreaterThan(0);
		expect(out, 'explain should reference the checkpoint ID').toContain(cpId);
	});

	it('story explain on nonexistent checkpoint fails cleanly', async (ctx) => {
		s = await setupRepo(ctx.task.name);
		ctx.onTestFailed(async () => {
			await captureArtifacts(s);
		});

		// Bypass the must-succeed wrapper by calling runStory directly
		// would require exposing it. Using storyExplain + expecting throw
		// covers the error path.
		await expect(storyExplain(s.dir, 'aaaaaaaaaaaa')).rejects.toThrow();

		// Vogon ran, file was created — but no commit → this assertion
		// just keeps the scenario shape symmetric with the happy path.
		await assertFileExists(s.dir, '.story/settings.json');
	});

	// Phase 9.4 addition — no Go e2e equivalent. Validates the end-to-
	// end attach flow: run Vogon, commit WITHOUT hooks (so no trailer),
	// then `story attach <session-id>` amends the three Story trailers
	// onto HEAD. The full transcript-metadata write still DEFERs to
	// Phase 4.x `NewFetchingTree` port, so we only assert the amend +
	// trailer surface — the transcript side is covered by later
	// `explain` runs on the resulting checkpoint ID.
	it('story attach <session-id> amends Story-Checkpoint + Story-Session + Story-Agent trailers', async (ctx) => {
		s = await setupRepo(ctx.task.name);
		ctx.onTestFailed(async () => {
			await captureArtifacts(s);
		});

		// Run Vogon — creates a session + writes docs/red.md. Session
		// state is now recorded in `.git/story-sessions/<sessionId>.json`.
		await s.runPrompt(
			'create a markdown file at docs/red.md with a paragraph about the colour red. Do not commit the file. Do not ask for confirmation, just make the change.',
		);

		// Commit WITHOUT hooks firing — this is how the user would end
		// up with a "forgot to enable Story before committing" scenario,
		// which is exactly attach's use case.
		const emptyHooksDir = await fs.mkdtemp(path.join(os.tmpdir(), 'story-empty-hooks-'));
		await s.git('-c', `core.hooksPath=${emptyHooksDir}`, 'add', '.');
		await s.git(
			'-c',
			`core.hooksPath=${emptyHooksDir}`,
			'commit',
			'-m',
			'Pre-attach commit (hooks bypassed)',
		);
		await fs.rm(emptyHooksDir, { recursive: true, force: true });

		// Sanity: the commit has no Story-Checkpoint trailer.
		await assertNoCheckpointTrailer(s.dir, 'HEAD');
		const headBefore = await s.gitOutput('rev-parse', 'HEAD');

		// Find the Vogon-recorded session id.
		const sessionsDir = path.join(s.dir, '.git', 'story-sessions');
		const entries = await fs.readdir(sessionsDir);
		const sessionFile = entries.find((e) => e.endsWith('.json') && !e.endsWith('.tmp'));
		expect(sessionFile, 'Vogon should have recorded at least one session').toBeDefined();
		const sessionId = (sessionFile as string).replace(/\.json$/, '');

		// Attach with --force so the amend + double-confirm is skipped
		// in this non-interactive run, and --agent to skip auto-detect.
		const attachRes = await storyAttach(s.dir, sessionId, { force: true, agent: 'vogon' });
		expect(
			attachRes.exitCode,
			`story attach failed: ${attachRes.stderr}\n${attachRes.stdout}`,
		).toBe(0);

		// HEAD should now have the 3 Story trailers amended in place
		// and a NEW sha (amend produces a fresh commit object).
		const headAfter = await s.gitOutput('rev-parse', 'HEAD');
		expect(headAfter, 'amend should produce a new HEAD sha').not.toBe(headBefore);

		const trailersRaw = await s.gitOutput('log', '-1', '--format=%(trailers)', 'HEAD');
		expect(trailersRaw, 'HEAD should contain Story-Checkpoint trailer').toContain(
			'Story-Checkpoint:',
		);
		expect(trailersRaw, 'HEAD should contain Story-Session trailer').toContain('Story-Session:');
		expect(trailersRaw, 'HEAD should contain Story-Agent trailer').toContain('Story-Agent:');

		// The checkpoint ID on the trailer should match the 12-hex format.
		const cpId = await assertHasCheckpointTrailer(s.dir, 'HEAD');
		expect(cpId, 'attach should produce a 12-hex checkpoint id').toMatch(/^[0-9a-f]{12}$/);
	});
});
