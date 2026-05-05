/**
 * `src/commands/_shared/associated-commits.ts` — finds git commits with
 * matching `Story-Checkpoint:` trailer for `story explain`'s
 * `--search-all` flag.
 *
 * Go: `cmd/entire/cli/explain.go: getAssociatedCommits` +
 * `commitScanLimit = 500`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COMMIT_SCAN_LIMIT, getAssociatedCommits } from '@/commands/_shared/associated-commits';
import { TestEnv } from '../../../helpers/test-env';

describe('commands/_shared/associated-commits — Go: explain.go:1088-1163', () => {
	let env: TestEnv;

	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
	});

	afterEach(async () => {
		await env.cleanup();
	});

	// Checkpoint IDs are 12 lowercase hex chars per src/id.ts CHECKPOINT_ID_PATTERN.
	const CP1 = 'abcdef123456';
	const CP_DIFFERENT = 'deadbeef0000';
	const CP_SHARED = 'a1b2c3d4e5f6';

	// Go: explain.go:1094-1110 collectCommit + trailer match.
	it('returns empty array when no commit matches the checkpoint id', async () => {
		const result = await getAssociatedCommits(env.dir, CP1, false);
		expect(result).toEqual([]);
	});

	it('returns empty array for empty checkpoint id (no git work done)', async () => {
		const result = await getAssociatedCommits(env.dir, '', false);
		expect(result).toEqual([]);
	});

	// Go: explain.go:1129-1134 ForEach + ParseCheckpoint trailer.
	it('collects a single matching commit on default walk', async () => {
		await env.writeFile('a.txt', 'a');
		await env.gitAdd('a.txt');
		const sha = await env.gitCommit(
			`feat: add a\n\nStory-Checkpoint: ${CP1}\nStory-Session: sess-1\n`,
		);
		const result = await getAssociatedCommits(env.dir, CP1, false);
		expect(result).toHaveLength(1);
		expect(result[0]?.sha).toBe(sha);
		expect(result[0]?.shortSha).toBe(sha.slice(0, 7));
		expect(result[0]?.message).toBe('feat: add a');
		expect(result[0]?.author).toBe('Test');
		expect(result[0]?.email).toBe('test@test.com');
		expect(result[0]?.date).toBeInstanceOf(Date);
	});

	// Go: explain.go:1095-1096 targetID match — non-matching trailers excluded.
	it('filters out commits with non-matching trailer', async () => {
		await env.writeFile('a.txt', 'a');
		await env.gitAdd('a.txt');
		await env.gitCommit(
			`feat: add a\n\nStory-Checkpoint: ${CP_DIFFERENT}\nStory-Session: sess-1\n`,
		);
		const result = await getAssociatedCommits(env.dir, CP1, false);
		expect(result).toEqual([]);
	});

	// Go: explain.go:1129-1133 — commits without trailer are skipped.
	it('skips commits with no Story-Checkpoint trailer', async () => {
		await env.writeFile('a.txt', 'a');
		await env.gitAdd('a.txt');
		await env.gitCommit('feat: no trailer here');
		const result = await getAssociatedCommits(env.dir, CP1, false);
		expect(result).toEqual([]);
	});

	// Go: explain.go:1113 searchAll=true — full DAG walk.
	// Tests the shape invariant that search-all returns a superset of (or equal to)
	// the default walk for the same history.
	it('searchAll=true returns at least as many matches as default walk', async () => {
		// Create two commits both referencing the same checkpoint.
		await env.writeFile('a.txt', 'a');
		await env.gitAdd('a.txt');
		await env.gitCommit(`feat: a\n\nStory-Checkpoint: ${CP_SHARED}\nStory-Session: sess-1\n`);
		await env.writeFile('b.txt', 'b');
		await env.gitAdd('b.txt');
		await env.gitCommit(`feat: b\n\nStory-Checkpoint: ${CP_SHARED}\nStory-Session: sess-1\n`);

		const fast = await getAssociatedCommits(env.dir, CP_SHARED, false);
		const slow = await getAssociatedCommits(env.dir, CP_SHARED, true);
		expect(slow.length).toBeGreaterThanOrEqual(fast.length);
		// Both should find both commits on linear history.
		expect(fast).toHaveLength(2);
		expect(slow).toHaveLength(2);
	});

	// Go: explain.go:1453 commitScanLimit = 500.
	it('exports the COMMIT_SCAN_LIMIT constant matching Go (500)', () => {
		expect(COMMIT_SCAN_LIMIT).toBe(500);
	});

	// Go: explain.go:1088-1095 — git error tolerance (returns empty rather than throw).
	it('returns empty array on invalid repo (no HEAD)', async () => {
		const bare = await TestEnv.create({ bare: true });
		try {
			const result = await getAssociatedCommits(bare.dir, CP1, false);
			expect(result).toEqual([]);
		} finally {
			await bare.cleanup();
		}
	});
});
