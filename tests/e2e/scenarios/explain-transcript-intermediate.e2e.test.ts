/**
 * E2E: committed transcript with garbage prefix line + multimodal needle;
 * `validateCheckpointDeep` + `story explain` all densities.
 *
 * Go: TS-only supplement — garbled JSONL prefix + `validateCheckpointDeep` (no Go e2e mirror).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { updateCommitted } from '@/checkpoint/committed';
import {
	buildGarbledPrefixTranscriptUtf8,
	E2E_GARBAGE_PREFIX_LINE,
	E2E_INTERMEDIATE_NEEDLE,
} from '../fixtures/transcript-e2e';
import { captureArtifacts } from '../helpers/artifacts';
import {
	assertHasCheckpointTrailer,
	validateCheckpointDeep,
	waitForCheckpoint,
} from '../helpers/assertions';
import { checkpointPath, readCheckpointMetadata, readSessionMetadata } from '../helpers/metadata';
import { type RepoState, setupRepo, teardownRepo } from '../helpers/repo-state';
import { runStory } from '../helpers/story';
import { stripAnsi } from '../helpers/strip-ansi';

describe('explain — garbled-prefix committed transcript + deep validation', () => {
	let s: RepoState | undefined;

	afterEach(async () => {
		if (s !== undefined) {
			await teardownRepo(s);
			s = undefined;
		}
	});

	// Go: e2e/tests/ (none) — committed v1 transcript w/ non-JSON first line + multimodal user line.
	it('git show full.jsonl retains garbage + needle; explain modes; validateCheckpointDeep', async (ctx) => {
		s = await setupRepo(ctx.task.name);
		ctx.onTestFailed(async () => {
			await captureArtifacts(s);
		});

		await s.runPrompt(
			'create a markdown file at docs/e2e-intermediate.md with a short paragraph about testing. Do not ask for confirmation, just make the change.',
		);
		await s.git('add', '.');
		await s.git('commit', '-m', 'e2e explain intermediate commit');
		await waitForCheckpoint(s, 60_000);

		const cpId = await assertHasCheckpointTrailer(s.dir, 'HEAD');
		const sm = await readSessionMetadata(s.dir, cpId, 0);
		const ck = await readCheckpointMetadata(s.dir, cpId);

		await updateCommitted(s.dir, {
			checkpointId: cpId,
			sessionId: sm.session_id,
			transcript: buildGarbledPrefixTranscriptUtf8(),
			prompts: ['e2e-int-prompt'],
			agent: 'vogon',
			compactTranscript: null,
		});

		const blobPath = `story/checkpoints/v1:${checkpointPath(cpId)}/0/full.jsonl`;
		const shown = await s.gitOutput('show', blobPath);
		expect(shown).toContain(E2E_GARBAGE_PREFIX_LINE);
		expect(shown).toContain(E2E_INTERMEDIATE_NEEDLE);

		await validateCheckpointDeep(s.dir, {
			checkpointId: cpId,
			strategy: ck.strategy,
			filesTouched: [...ck.files_touched],
			expectedTranscriptContent: [E2E_GARBAGE_PREFIX_LINE, E2E_INTERMEDIATE_NEEDLE],
			expectedPrompts: ['e2e-int-prompt'],
		});

		const raw = await runStory(s.dir, ['explain', '--checkpoint', cpId, '--raw-transcript']);
		expect(raw.exitCode, `${raw.stderr}\n${raw.stdout}`).toBe(0);
		expect(raw.stdout).toContain(E2E_INTERMEDIATE_NEEDLE);

		const def = await runStory(s.dir, ['explain', '--checkpoint', cpId]);
		expect(def.exitCode, `${def.stderr}\n${def.stdout}`).toBe(0);
		expect(`${def.stdout}\n${def.stderr}`).toContain(E2E_INTERMEDIATE_NEEDLE);

		const full = await runStory(s.dir, ['explain', '--checkpoint', cpId, '--full']);
		expect(full.exitCode, `${full.stderr}\n${full.stdout}`).toBe(0);
		const fullCombined = `${full.stdout}\n${full.stderr}`;
		expect(fullCombined).toContain(E2E_INTERMEDIATE_NEEDLE);
		expect(stripAnsi(fullCombined)).toMatch(/Turn\s+1/i);
	});
});
