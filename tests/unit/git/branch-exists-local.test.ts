/**
 * `branchExistsLocally(name, cwd?)` unit tests.
 *
 * Go: `cmd/entire/cli/git_operations.go:304-320 BranchExistsLocally` —
 * probes `refs/heads/<name>` via `git rev-parse --verify --quiet`.
 * Exit 0 → true; any other exit → false (no error propagation).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { branchExistsLocally } from '@/git';
import { clearWorktreeRootCache } from '@/paths';
import { TestEnv } from '../../helpers/test-env';

describe('git/branchExistsLocally — Go: git_operations.go:304-320', () => {
	let env: TestEnv;

	beforeEach(async () => {
		clearWorktreeRootCache();
		env = await TestEnv.create({ initialCommit: true });
	});

	afterEach(async () => {
		await env.cleanup();
	});

	// Go: git_operations.go:312 repo.Reference(NewBranchReferenceName(name))
	it('returns true when the branch exists (HEAD default branch)', async () => {
		const current = (await env.exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
		expect(await branchExistsLocally(current, env.dir)).toBe(true);
	});

	it('returns false when the branch does not exist', async () => {
		expect(await branchExistsLocally('nope-not-there', env.dir)).toBe(false);
	});

	it('returns false on a brand-new bare repo with no refs', async () => {
		const bare = await TestEnv.create({ bare: true });
		try {
			expect(await branchExistsLocally('main', bare.dir)).toBe(false);
		} finally {
			await bare.cleanup();
		}
	});

	it('treats arbitrary input (containing slashes) as a plain ref lookup', async () => {
		// `git rev-parse --verify refs/heads/feat/foo` with no such branch → exit 128 → false.
		expect(await branchExistsLocally('feat/foo', env.dir)).toBe(false);
		await env.exec('git', ['branch', 'feat/foo']);
		expect(await branchExistsLocally('feat/foo', env.dir)).toBe(true);
	});
});
