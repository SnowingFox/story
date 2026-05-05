/**
 * Phase 5.6 push-helpers unit tests.
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/strategy/push_common.go` —
 * `isURL` / `startProgressDots` / `createMergeCommitCommon`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMergeCommitCommon, isURL, startProgressDots } from '@/strategy/push-helpers';
import { TestEnv } from '../../helpers/test-env';

describe('strategy/push-helpers — Go: push_common.go', () => {
	// Go: push_common.go: isURL
	describe('isURL', () => {
		it('detects URL form by "://" or "@"', () => {
			// Go: push_common.go: isURL
			expect(isURL('origin')).toBe(false);
			expect(isURL('https://github.com/o/r.git')).toBe(true);
			expect(isURL('ssh://git@github.com/o/r.git')).toBe(true);
			expect(isURL('git@github.com:o/r.git')).toBe(true);
		});
	});

	// Go: push_common.go: startProgressDots
	describe('startProgressDots', () => {
		it('writes "." every second to writer and stop callback prints suffix + newline', async () => {
			// Go: push_common.go: startProgressDots
			let captured = '';
			const w: NodeJS.WritableStream = {
				write(chunk): boolean {
					captured += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
					return true;
				},
			} as NodeJS.WritableStream;

			const stop = startProgressDots(w);
			// Wait long enough for at least 2 dots (two ticks).
			await new Promise((r) => setTimeout(r, 2200));
			stop(' done');
			// Allow any in-flight tick to complete (stop awaits internally).
			await new Promise((r) => setTimeout(r, 50));

			expect(captured).toMatch(/^\.{2,}/);
			expect(captured).toContain(' done\n');
		});

		it('stop callback writes suffix and newline even when called immediately', () => {
			let captured = '';
			const w: NodeJS.WritableStream = {
				write(chunk): boolean {
					captured += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
					return true;
				},
			} as NodeJS.WritableStream;

			const stop = startProgressDots(w);
			stop(' immediate');
			expect(captured).toBe(' immediate\n');
		});
	});

	// Go: push_common.go: createMergeCommitCommon
	describe('createMergeCommitCommon', () => {
		let env: TestEnv;

		beforeEach(async () => {
			env = await TestEnv.create({ initialCommit: true });
		});

		afterEach(async () => {
			await env.cleanup();
		});

		it('creates a merge commit with multiple parents and returns its hash', async () => {
			// Go: push_common.go: createMergeCommitCommon
			const head1 = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			await env.writeFile('extra.txt', 'extra');
			await env.gitAdd('extra.txt');
			const head2 = await env.gitCommit('extra commit');

			const treeOid = (await env.exec('git', ['rev-parse', `${head2}^{tree}`])).stdout.trim();
			const merged = await createMergeCommitCommon(
				env.dir,
				treeOid,
				[head1, head2],
				'Merge for test',
			);

			expect(merged).toMatch(/^[0-9a-f]{40}$/);
			const parents = (await env.exec('git', ['rev-list', '--parents', '-n', '1', merged])).stdout
				.trim()
				.split(/\s+/);
			// Format: <commit> <parent1> <parent2>
			expect(parents).toHaveLength(3);
			expect(parents[1]).toBe(head1);
			expect(parents[2]).toBe(head2);
		});

		it('uses local git config user.name + user.email for author and committer', async () => {
			await env.exec('git', ['config', 'user.name', 'MergeTester']);
			await env.exec('git', ['config', 'user.email', 'merge@x.test']);
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			const treeOid = (await env.exec('git', ['rev-parse', `${head}^{tree}`])).stdout.trim();
			const merged = await createMergeCommitCommon(env.dir, treeOid, [head], 'Single-parent merge');

			const author = (
				await env.exec('git', ['log', '-1', '--format=%an <%ae>', merged])
			).stdout.trim();
			expect(author).toBe('MergeTester <merge@x.test>');
		});
	});
});
