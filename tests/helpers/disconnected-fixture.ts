import fsCallback from 'node:fs';
import git from 'isomorphic-git';
import type { TestEnv } from './test-env';

export interface DisconnectedFixture {
	/** Local branch hash (orphan commit chain with N data commits). */
	localHash: string;
	/** Remote ref hash (orphan commit chain with M data commits, no shared history with local). */
	remoteHash: string;
	/** Full ref name written into `srcEnv.dir/.git/refs/...` to simulate a remote-tracking ref. */
	remoteRefName: string;
}

/**
 * Construct a "disconnected" branch pair to simulate the empty-orphan bug
 * scenario for {@link reconcileDisconnectedMetadataBranch} / disconnect tests.
 *
 * Writes two completely independent orphan commit chains into `env`:
 *   - `refs/heads/<branchName>` ← local chain (`localCommits` data commits)
 *   - `<remoteRefName>` ← remote-tracking-style chain (`remoteCommits` data commits)
 *
 * The two chains share no common ancestor, so `git merge-base local remote`
 * exits 1 (no common ancestor) — exactly the disconnect scenario the
 * empty-orphan bug produces in production.
 *
 * @example
 * ```ts
 * const env = await TestEnv.create();
 * const { localHash, remoteHash, remoteRefName } = await makeDisconnectedBranches(env, {
 *   branchName: 'story/checkpoints/v1',
 *   localCommits: 3,
 *   remoteCommits: 2,
 *   remoteRefName: 'refs/remotes/origin/story/checkpoints/v1',
 * });
 *
 * // Side effects in env.dir/.git/:
 * //   refs/heads/story/checkpoints/v1                    ← local orphan tip
 * //   refs/remotes/origin/story/checkpoints/v1           ← remote orphan tip
 * //   objects/...                                        ← 5 commit objects + trees + blobs
 * //
 * // git merge-base local remote → exit 1 (no common ancestor)
 * ```
 */
export async function makeDisconnectedBranches(
	env: TestEnv,
	opts: {
		branchName: string;
		localCommits: number;
		remoteCommits: number;
		remoteRefName: string;
		/** Insert one empty-tree commit at the root of the local chain (mimics empty-orphan bug). */
		localEmptyOrphan?: boolean;
	},
): Promise<DisconnectedFixture> {
	const localHash = await writeOrphanChain(env, {
		commitCount: opts.localCommits,
		emptyOrphan: opts.localEmptyOrphan === true,
		fileNamePrefix: 'local',
	});
	const remoteHash = await writeOrphanChain(env, {
		commitCount: opts.remoteCommits,
		emptyOrphan: false,
		fileNamePrefix: 'remote',
	});
	await git.writeRef({
		fs: fsCallback,
		dir: env.dir,
		ref: `refs/heads/${opts.branchName}`,
		value: localHash,
		force: true,
	});
	await git.writeRef({
		fs: fsCallback,
		dir: env.dir,
		ref: opts.remoteRefName,
		value: remoteHash,
		force: true,
	});
	return { localHash, remoteHash, remoteRefName: opts.remoteRefName };
}

async function writeOrphanChain(
	env: TestEnv,
	opts: { commitCount: number; emptyOrphan: boolean; fileNamePrefix: string },
): Promise<string> {
	const author = {
		name: 'Test',
		email: 'test@test.com',
		timestamp: Math.floor(Date.now() / 1000),
		timezoneOffset: 0,
	};

	let parent: string[] = [];

	if (opts.emptyOrphan) {
		const emptyTree = await git.writeTree({ fs: fsCallback, dir: env.dir, tree: [] });
		const emptyCommit = await git.writeCommit({
			fs: fsCallback,
			dir: env.dir,
			commit: {
				tree: emptyTree,
				parent: [],
				author,
				committer: author,
				message: 'orphan: empty\n',
			},
		});
		parent = [emptyCommit];
	}

	let head = parent[0] ?? '';
	for (let i = 0; i < opts.commitCount; i++) {
		const blobOid = await git.writeBlob({
			fs: fsCallback,
			dir: env.dir,
			blob: new TextEncoder().encode(`${opts.fileNamePrefix} commit ${i}\n`),
		});
		const tree = await git.writeTree({
			fs: fsCallback,
			dir: env.dir,
			tree: [
				{ mode: '100644', path: `${opts.fileNamePrefix}-${i}.txt`, oid: blobOid, type: 'blob' },
			],
		});
		const commit = await git.writeCommit({
			fs: fsCallback,
			dir: env.dir,
			commit: {
				tree,
				parent: head ? [head] : [],
				author,
				committer: author,
				message: `${opts.fileNamePrefix} data commit ${i}\n`,
			},
		});
		head = commit;
	}

	return head;
}
