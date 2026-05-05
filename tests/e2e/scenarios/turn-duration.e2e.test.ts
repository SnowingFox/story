/**
 * Turn duration metrics E2E scenario — Vogon canary.
 *
 * Story-led divergence: Go Entire CLI does not persist per-turn metrics. This
 * scenario locks the contract that Story records `session_metrics.duration_ms`
 * (wall-clock), `active_duration_ms` (sum of turn metrics), and at least one
 * `turn_metrics[]` entry into the v1 metadata branch when an agent runs a
 * full normalized lifecycle (TurnStart -> TurnEnd) and the user commits.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { captureArtifacts } from '../helpers/artifacts';
import {
	assertFileExists,
	assertHasCheckpointTrailer,
	waitForCheckpoint,
	waitForNoShadowBranches,
} from '../helpers/assertions';
import { readSessionMetadata } from '../helpers/metadata';
import { type RepoState, setupRepo, teardownRepo } from '../helpers/repo-state';

describe('turn-duration metrics scenario (Vogon)', () => {
	let s: RepoState | undefined;

	afterEach(async () => {
		if (s !== undefined) {
			await teardownRepo(s);
			s = undefined;
		}
	});

	it('records wall-clock + active + turn metrics in v1 session metadata', async (ctx) => {
		s = await setupRepo(ctx.task.name);
		ctx.onTestFailed(async () => {
			await captureArtifacts(s);
		});

		await s.runPrompt(
			'create a markdown file at docs/duration.md with a paragraph about wall-clock vs active time. Do not ask for confirmation, just make the change.',
		);

		await assertFileExists(s.dir, 'docs/duration.md');

		await s.git('add', '.');
		await s.git('commit', '-m', 'Add duration.md');

		await waitForCheckpoint(s, 30_000);
		const cpId = await assertHasCheckpointTrailer(s.dir, 'HEAD');

		const metadata = await readSessionMetadata(s.dir, cpId, 0);
		const metrics = metadata.session_metrics;
		expect(metrics, 'session_metrics should be populated by Story lifecycle').toBeDefined();
		expect(metrics?.duration_ms ?? 0).toBeGreaterThan(0);
		expect(metrics?.active_duration_ms ?? 0).toBeGreaterThan(0);
		expect(metrics?.turn_metrics?.length ?? 0).toBeGreaterThanOrEqual(1);

		const firstTurn = metrics?.turn_metrics?.[0];
		expect(firstTurn?.duration_ms ?? 0).toBeGreaterThan(0);
		expect(firstTurn?.started_at ?? '').toMatch(/T/);
		expect(firstTurn?.ended_at ?? '').toMatch(/T/);

		const sumTurns = (metrics?.turn_metrics ?? []).reduce(
			(sum, turn) => sum + (turn.duration_ms ?? 0),
			0,
		);
		expect(metrics?.active_duration_ms ?? 0).toBe(sumTurns);

		await waitForNoShadowBranches(s.dir, 10_000);
	});
});
