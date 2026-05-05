/**
 * E2E: `story explain` reads committed Cursor multimodal transcript + custom prompts.
 *
 * Uses `updateCommitted` to replace v1 transcript after a real Vogon commit so
 * explain surfaces known needles without depending on Vogon JSONL shape.
 *
 * Go: TS-only supplement to Phase 9.4 transcript-shape discipline (no dedicated Go e2e).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { updateCommitted } from '@/checkpoint/committed';
import {
	buildCleanShapeTranscriptUtf8,
	buildPurePagedTranscriptUtf8,
	E2E_PURE_T1_NEEDLE,
	E2E_PURE_T2_NEEDLE,
	E2E_PURE_T3_NEEDLE,
	E2E_PURE_TOOL_INPUT_NEEDLE,
	E2E_PURE_TOOL_RESULT_NEEDLE,
	E2E_SHAPE_MM_NEEDLE,
} from '../fixtures/transcript-e2e';
import { captureArtifacts } from '../helpers/artifacts';
import { assertHasCheckpointTrailer, waitForCheckpoint } from '../helpers/assertions';
import { readSessionMetadata } from '../helpers/metadata';
import { type RepoState, setupRepo, teardownRepo } from '../helpers/repo-state';
import { runStory } from '../helpers/story';
import { stripAnsi } from '../helpers/strip-ansi';

describe('explain — committed transcript shapes (Cursor multimodal)', () => {
	let s: RepoState | undefined;

	afterEach(async () => {
		if (s !== undefined) {
			await teardownRepo(s);
			s = undefined;
		}
	});

	// Go: e2e/tests/ (none) — Story explain + committed v1 transcript fixture (multimodal JSONL).
	it('explain --raw-transcript / default / --full surface fixture needle + Turn 1 in --full', async (ctx) => {
		s = await setupRepo(ctx.task.name);
		ctx.onTestFailed(async () => {
			await captureArtifacts(s);
		});

		await s.runPrompt(
			'create a markdown file at docs/e2e-shape.md with a short paragraph about testing. Do not ask for confirmation, just make the change.',
		);
		await s.git('add', '.');
		await s.git('commit', '-m', 'e2e explain shape commit');
		await waitForCheckpoint(s, 60_000);

		const cpId = await assertHasCheckpointTrailer(s.dir, 'HEAD');
		const sm = await readSessionMetadata(s.dir, cpId, 0);

		await updateCommitted(s.dir, {
			checkpointId: cpId,
			sessionId: sm.session_id,
			transcript: buildCleanShapeTranscriptUtf8(),
			prompts: ['fixture-prompt-e2e-shape'],
			agent: 'vogon',
			compactTranscript: null,
		});

		const raw = await runStory(s.dir, ['explain', '--checkpoint', cpId, '--raw-transcript']);
		expect(raw.exitCode, `${raw.stderr}\n${raw.stdout}`).toBe(0);
		expect(raw.stdout).toContain(E2E_SHAPE_MM_NEEDLE);

		const def = await runStory(s.dir, ['explain', '--checkpoint', cpId]);
		expect(def.exitCode, `${def.stderr}\n${def.stdout}`).toBe(0);
		expect(`${def.stdout}\n${def.stderr}`).toContain(E2E_SHAPE_MM_NEEDLE);

		const full = await runStory(s.dir, ['explain', '--checkpoint', cpId, '--full']);
		expect(full.exitCode, `${full.stderr}\n${full.stdout}`).toBe(0);
		const fullCombined = `${full.stdout}\n${full.stderr}`;
		expect(fullCombined).toContain(E2E_SHAPE_MM_NEEDLE);
		const stripped = stripAnsi(fullCombined);
		expect(stripped).toMatch(/Turn\s+1/i);
	});

	// Phase 9.4 post-ship: AI-facing `--pure --page <n>` / `--pure --full`
	// pagination on a real committed transcript. Asserts:
	//   - tool inputs surface in plain-text output
	//   - tool results never leak into plain-text output
	//   - paged output is bounded to PURE_PAGE_SIZE turns and trailers
	//     advertise the next-page command
	it('explain --pure --page / --full surfaces tool inputs and paginates correctly', async (ctx) => {
		s = await setupRepo(ctx.task.name);
		ctx.onTestFailed(async () => {
			await captureArtifacts(s);
		});

		await s.runPrompt(
			'create a markdown file at docs/e2e-pure.md with a short paragraph about pagination. Do not ask for confirmation, just make the change.',
		);
		await s.git('add', '.');
		await s.git('commit', '-m', 'e2e explain pure commit');
		await waitForCheckpoint(s, 60_000);

		const cpId = await assertHasCheckpointTrailer(s.dir, 'HEAD');
		const sm = await readSessionMetadata(s.dir, cpId, 0);

		await updateCommitted(s.dir, {
			checkpointId: cpId,
			sessionId: sm.session_id,
			transcript: buildPurePagedTranscriptUtf8(),
			prompts: [E2E_PURE_T1_NEEDLE, E2E_PURE_T2_NEEDLE, E2E_PURE_T3_NEEDLE],
			agent: 'vogon',
			compactTranscript: null,
		});

		// `--pure --page 1`: turns 1+2 + tool input, NOT turn 3, NOT tool result.
		const p1 = await runStory(s.dir, ['explain', '--checkpoint', cpId, '--pure', '--page', '1']);
		expect(p1.exitCode, `${p1.stderr}\n${p1.stdout}`).toBe(0);
		expect(p1.stdout).toContain(E2E_PURE_T1_NEEDLE);
		expect(p1.stdout).toContain(E2E_PURE_T2_NEEDLE);
		expect(p1.stdout).not.toContain(E2E_PURE_T3_NEEDLE);
		expect(p1.stdout).toContain(E2E_PURE_TOOL_INPUT_NEEDLE);
		expect(p1.stdout).not.toContain(E2E_PURE_TOOL_RESULT_NEEDLE);
		expect(p1.stdout).toMatch(/--pure\s+--page\s+2/);
		expect(p1.stdout).toBe(stripAnsi(p1.stdout));
		expect(p1.stdout).not.toMatch(/┌|│|└|◇|●|■|○/);

		// `--pure --page 2`: only turn 3, no next-page hint.
		const p2 = await runStory(s.dir, ['explain', '--checkpoint', cpId, '--pure', '--page', '2']);
		expect(p2.exitCode, `${p2.stderr}\n${p2.stdout}`).toBe(0);
		expect(p2.stdout).toContain(E2E_PURE_T3_NEEDLE);
		expect(p2.stdout).not.toContain(E2E_PURE_T1_NEEDLE);
		expect(p2.stdout).not.toContain(E2E_PURE_T2_NEEDLE);
		expect(p2.stdout).not.toMatch(/--pure\s+--page\s+3/);

		// `--pure --full`: all 3 turns + tool input, no tool result.
		const pf = await runStory(s.dir, ['explain', '--checkpoint', cpId, '--pure', '--full']);
		expect(pf.exitCode, `${pf.stderr}\n${pf.stdout}`).toBe(0);
		expect(pf.stdout).toContain(E2E_PURE_T1_NEEDLE);
		expect(pf.stdout).toContain(E2E_PURE_T2_NEEDLE);
		expect(pf.stdout).toContain(E2E_PURE_T3_NEEDLE);
		expect(pf.stdout).toContain(E2E_PURE_TOOL_INPUT_NEEDLE);
		expect(pf.stdout).not.toContain(E2E_PURE_TOOL_RESULT_NEEDLE);
		expect(pf.stdout).toBe(stripAnsi(pf.stdout));
		expect(pf.stdout).not.toMatch(/┌|│|└|◇|●|■|○/);
	});
});
