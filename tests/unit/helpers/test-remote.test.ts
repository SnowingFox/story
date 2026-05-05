/**
 * Self-tests for the Phase 5.6 fixture helpers (TestRemote +
 * makeDisconnectedBranches). Validate that fixtures behave as documented
 * before downstream Batch 1-5 tests rely on them.
 */

import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeDisconnectedBranches } from '../../helpers/disconnected-fixture';
import { TestEnv } from '../../helpers/test-env';
import { TestRemote } from '../../helpers/test-remote';

describe('TestRemote', () => {
	let remote: TestRemote;

	beforeEach(async () => {
		remote = await TestRemote.create();
	});

	afterEach(async () => {
		await remote.cleanup();
	});

	it('creates a bare git repo at .url', async () => {
		const { stdout } = await execa('git', [
			'--git-dir',
			remote.url,
			'rev-parse',
			'--is-bare-repository',
		]);
		expect(stdout.trim()).toBe('true');
	});

	it('exposes .url and .dir as the same path', () => {
		expect(remote.url).toBe(remote.dir);
	});

	it('pushFrom sends refs into the bare repo', async () => {
		const env = await TestEnv.create({ initialCommit: true });
		try {
			await remote.pushFrom(env, 'HEAD:refs/heads/main');
			const hash = await remote.resolveRef('refs/heads/main');
			expect(hash).toMatch(/^[0-9a-f]{40}$/);
		} finally {
			await env.cleanup();
		}
	});

	it('resolveRef returns null when the ref is missing', async () => {
		expect(await remote.resolveRef('refs/heads/nonexistent')).toBeNull();
	});

	it('lsRemote returns nothing for an empty bare repo', async () => {
		const lines = await remote.lsRemote();
		expect(lines).toEqual([]);
	});

	it('lsRemote returns refs after pushFrom', async () => {
		const env = await TestEnv.create({ initialCommit: true });
		try {
			await remote.pushFrom(env, 'HEAD:refs/heads/main');
			const lines = await remote.lsRemote('refs/heads/*');
			expect(lines).toHaveLength(1);
			expect(lines[0]).toMatch(/^[0-9a-f]{40}\trefs\/heads\/main$/);
		} finally {
			await env.cleanup();
		}
	});
});

describe('makeDisconnectedBranches', () => {
	let env: TestEnv;

	beforeEach(async () => {
		env = await TestEnv.create();
	});

	afterEach(async () => {
		await env.cleanup();
	});

	it('writes both refs and they share no common ancestor', async () => {
		const { localHash, remoteHash, remoteRefName } = await makeDisconnectedBranches(env, {
			branchName: 'story/checkpoints/v1',
			localCommits: 2,
			remoteCommits: 2,
			remoteRefName: 'refs/remotes/origin/story/checkpoints/v1',
		});
		expect(localHash).toMatch(/^[0-9a-f]{40}$/);
		expect(remoteHash).toMatch(/^[0-9a-f]{40}$/);
		expect(remoteRefName).toBe('refs/remotes/origin/story/checkpoints/v1');
		expect(localHash).not.toBe(remoteHash);

		// Both refs exist
		const localRef = (
			await env.exec('git', ['rev-parse', 'refs/heads/story/checkpoints/v1'])
		).stdout.trim();
		expect(localRef).toBe(localHash);
		const remoteRef = (await env.exec('git', ['rev-parse', remoteRefName])).stdout.trim();
		expect(remoteRef).toBe(remoteHash);

		// merge-base exits 1 (no common ancestor)
		const mergeBase = await execa('git', ['merge-base', localHash, remoteHash], {
			cwd: env.dir,
			reject: false,
		});
		expect(mergeBase.exitCode).toBe(1);
	});

	it('localEmptyOrphan inserts an empty-tree commit at the chain root', async () => {
		const { localHash } = await makeDisconnectedBranches(env, {
			branchName: 'story/checkpoints/v1',
			localCommits: 2,
			remoteCommits: 1,
			remoteRefName: 'refs/remotes/origin/story/checkpoints/v1',
			localEmptyOrphan: true,
		});

		// Walk to root via first parent
		const log = (await env.exec('git', ['log', '--format=%H', localHash])).stdout
			.trim()
			.split('\n');
		expect(log).toHaveLength(3); // 2 data commits + 1 empty orphan root

		const rootHash = log[log.length - 1]!;
		const treeOid = (await env.exec('git', ['rev-parse', `${rootHash}^{tree}`])).stdout.trim();
		const treeContent = (await env.exec('git', ['ls-tree', treeOid])).stdout.trim();
		expect(treeContent).toBe(''); // empty tree
	});
});
