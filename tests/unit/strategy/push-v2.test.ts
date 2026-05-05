/**
 * Phase 5.6 push-v2 unit tests.
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/strategy/push_v2.go` —
 * `pushRefIfNeeded` / `pushV2Refs` / `tryPushRef` / `doPushRef` /
 * `fetchAndMergeRef` / `detectRemoteOnlyArchives` /
 * `handleRotationConflict` / `updateGenerationTimestamps` / `shortRefName`.
 */

import fsCallback from 'node:fs';
import git from 'isomorphic-git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	GENERATION_FILE_NAME,
	V2_FULL_CURRENT_REF_NAME,
	V2_FULL_REF_PREFIX,
	V2_MAIN_REF_NAME,
} from '@/checkpoint/constants';
import { execGit } from '@/git';
import { setStderrWriterForTesting } from '@/strategy/hooks-tty';
import { resetSettingsHintForTesting } from '@/strategy/push-common';
import { pushRefIfNeeded, pushV2Refs, shortRefName } from '@/strategy/push-v2';
import { TestEnv } from '../../helpers/test-env';
import { TestRemote } from '../../helpers/test-remote';

interface Captured {
	captured: string;
}

function makeWritable(): NodeJS.WritableStream & Captured {
	const stream = {
		captured: '',
		write(chunk: string | Uint8Array): boolean {
			stream.captured += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
			return true;
		},
	} as unknown as NodeJS.WritableStream & Captured;
	return stream;
}

async function writeOrphanCommit(env: TestEnv, files: Record<string, string>): Promise<string> {
	const treeEntries: Array<{ mode: string; path: string; oid: string; type: 'blob' }> = [];
	for (const [path, content] of Object.entries(files)) {
		const oid = await git.writeBlob({
			fs: fsCallback,
			dir: env.dir,
			blob: new TextEncoder().encode(content),
		});
		treeEntries.push({ mode: '100644', path, oid, type: 'blob' });
	}
	const treeOid = await git.writeTree({ fs: fsCallback, dir: env.dir, tree: treeEntries });
	const author = {
		name: 'Test',
		email: 'test@test.com',
		timestamp: Math.floor(Date.now() / 1000),
		timezoneOffset: 0,
	};
	return git.writeCommit({
		fs: fsCallback,
		dir: env.dir,
		commit: {
			tree: treeOid,
			parent: [],
			author,
			committer: author,
			message: 'orphan commit\n',
		},
	});
}

describe('strategy/push-v2 — Go: push_v2.go', () => {
	let env: TestEnv;
	let remote: TestRemote;
	let stderrCapture: NodeJS.WritableStream & Captured;

	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		remote = await TestRemote.create();
		stderrCapture = makeWritable();
		setStderrWriterForTesting(stderrCapture);
		resetSettingsHintForTesting();
	});

	afterEach(async () => {
		await env.cleanup();
		await remote.cleanup();
		setStderrWriterForTesting(null);
		resetSettingsHintForTesting();
	});

	// Story-side naming red line.
	describe('shortRefName', () => {
		it('strips refs/story/checkpoints/ prefix', () => {
			// Go: push_v2.go: shortRefName
			expect(shortRefName('refs/story/checkpoints/v2/main')).toBe('v2/main');
			expect(shortRefName('refs/story/checkpoints/v2/full/current')).toBe('v2/full/current');
		});

		it('returns ref unchanged when prefix does not match', () => {
			expect(shortRefName('refs/heads/main')).toBe('refs/heads/main');
			expect(shortRefName('refs/tags/v1.0')).toBe('refs/tags/v1.0');
		});

		it('does NOT match refs/entire/ prefix (Story naming red line)', () => {
			// Go: push_v2.go: shortRefName (Story-side prefix differs from Go)
			expect(shortRefName('refs/entire/checkpoints/v2/main')).toBe(
				'refs/entire/checkpoints/v2/main',
			);
		});
	});

	// Go: push_v2.go: pushRefIfNeeded
	describe('pushRefIfNeeded', () => {
		// Go: push_v2.go: pushRefIfNeeded (silent on openRepository fail)
		it('silent return when not a git repo', async () => {
			await expect(
				pushRefIfNeeded(remote.url, V2_MAIN_REF_NAME, { cwd: '/tmp' }),
			).resolves.toBeUndefined();
		});

		// Go: push_v2.go: pushRefIfNeeded (silent return when local ref missing)
		it('silent return when local ref missing', async () => {
			await pushRefIfNeeded(remote.url, V2_MAIN_REF_NAME, { cwd: env.dir });
			expect(await remote.resolveRef(V2_MAIN_REF_NAME)).toBeNull();
		});

		// Go: push_v2.go: pushRefIfNeeded (happy path)
		it('happy path: pushes ref to remote and prints v2/main short name', async () => {
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			await env.exec('git', ['update-ref', V2_MAIN_REF_NAME, head]);

			await pushRefIfNeeded(remote.url, V2_MAIN_REF_NAME, { cwd: env.dir });

			expect(await remote.resolveRef(V2_MAIN_REF_NAME)).toBe(head);
			expect(stderrCapture.captured).toContain('v2/main');
			expect(stderrCapture.captured).toContain('[story]');
			expect(stderrCapture.captured).not.toContain('[entire]');
		});

		// Go: push_v2.go: pushRefIfNeeded (silent on push failure)
		it('silent on failure: push to bogus URL → stderr warning, no throw', async () => {
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			await env.exec('git', ['update-ref', V2_MAIN_REF_NAME, head]);

			await expect(
				pushRefIfNeeded('https://nonexistent.invalid/o/r.git', V2_MAIN_REF_NAME, {
					cwd: env.dir,
				}),
			).resolves.toBeUndefined();
			expect(stderrCapture.captured).toMatch(/\[story\] Warning/);
		});

		// Go: push_v2.go: pushRefIfNeeded (uses checkpoint remote display when target is URL)
		it('uses "checkpoint remote" display when target is URL', async () => {
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			await env.exec('git', ['update-ref', V2_MAIN_REF_NAME, head]);

			await pushRefIfNeeded(remote.fileURL, V2_MAIN_REF_NAME, { cwd: env.dir });

			expect(stderrCapture.captured).toContain('checkpoint remote');
		});
	});

	// Go: push_v2.go: pushV2Refs
	describe('pushV2Refs', () => {
		// Go: push_v2.go: pushV2Refs (no archived generations)
		it('skips archived push when no archived generations exist', async () => {
			// Seed only /main + /full/current locally.
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			await env.exec('git', ['update-ref', V2_MAIN_REF_NAME, head]);
			await env.exec('git', ['update-ref', V2_FULL_CURRENT_REF_NAME, head]);

			await pushV2Refs(remote.url, { cwd: env.dir });

			expect(await remote.resolveRef(V2_MAIN_REF_NAME)).toBe(head);
			expect(await remote.resolveRef(V2_FULL_CURRENT_REF_NAME)).toBe(head);
			// No archived ref pushed.
			const archived = await remote.lsRemote(`${V2_FULL_REF_PREFIX}*`);
			expect(archived.filter((l) => !l.includes('full/current'))).toEqual([]);
		});

		// Go: push_v2.go: pushV2Refs (only latest archived gen pushed)
		it('pushes /main + /full/current + only the latest archived generation', async () => {
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			await env.exec('git', ['update-ref', V2_MAIN_REF_NAME, head]);
			await env.exec('git', ['update-ref', V2_FULL_CURRENT_REF_NAME, head]);
			// Two archived generations; only the lexicographically latest should push.
			await env.exec('git', ['update-ref', `${V2_FULL_REF_PREFIX}1700000000000`, head]);
			await env.exec('git', ['update-ref', `${V2_FULL_REF_PREFIX}1700000005000`, head]);

			await pushV2Refs(remote.url, { cwd: env.dir });

			expect(await remote.resolveRef(`${V2_FULL_REF_PREFIX}1700000005000`)).toBe(head);
			expect(await remote.resolveRef(`${V2_FULL_REF_PREFIX}1700000000000`)).toBeNull();
		});

		// Go: push_v2.go: pushV2Refs (silent when openRepository fails)
		it('silent return when not a git repo', async () => {
			await expect(pushV2Refs(remote.url, { cwd: '/tmp' })).resolves.toBeUndefined();
		});
	});

	// Go: push_v2.go: fetchAndMergeRef + handleRotationConflict
	describe('rotation conflict handling', () => {
		// Go: push_v2.go: fetchAndMergeRef (standard tree merge when no rotation)
		it('non-fast-forward push for /main → fetch + tree merge → second push succeeds', async () => {
			// Local: orphan A with file 'local.txt'.
			const localHead = await writeOrphanCommit(env, { 'local.txt': 'local content\n' });
			await env.exec('git', ['update-ref', V2_MAIN_REF_NAME, localHead]);

			// Remote: a different orphan with file 'remote.txt'.
			const seed = await TestEnv.create({ initialCommit: true });
			try {
				const seedHead = await writeOrphanCommit(seed, { 'remote.txt': 'remote content\n' });
				await execGit(['update-ref', V2_MAIN_REF_NAME, seedHead], { cwd: seed.dir });
				await execGit(['push', remote.url, `+${seedHead}:${V2_MAIN_REF_NAME}`], {
					cwd: seed.dir,
				});

				// Push from env — first push fails non-fast-forward, fetchAndMergeRef
				// merges the trees, second push succeeds.
				await pushRefIfNeeded(remote.fileURL, V2_MAIN_REF_NAME, { cwd: env.dir });

				expect(stderrCapture.captured).toContain('Syncing');
				const finalRemote = await remote.resolveRef(V2_MAIN_REF_NAME);
				expect(finalRemote).toMatch(/^[0-9a-f]{40}$/);

				// Merged tree contains both files.
				const mergedCommit = await git.readCommit({
					fs: fsCallback,
					dir: env.dir,
					oid: finalRemote ?? '',
				});
				const mergedTree = await git.readTree({
					fs: fsCallback,
					dir: env.dir,
					oid: mergedCommit.commit.tree,
				});
				const names = mergedTree.tree.map((e) => e.path).sort();
				expect(names).toContain('local.txt');
				expect(names).toContain('remote.txt');
			} finally {
				await seed.cleanup();
			}
		});

		// Go: push_v2.go: detectRemoteOnlyArchives + handleRotationConflict
		it('rotation conflict: remote /full/current diverged + has new archived → adopts remote /full/current', async () => {
			// Local: /full/current = orphan with local entries.
			const localCurrentHead = await writeOrphanCommit(env, {
				'local-cp.txt': 'local checkpoint\n',
			});
			await env.exec('git', ['update-ref', V2_FULL_CURRENT_REF_NAME, localCurrentHead]);

			// Remote: an archived generation (with shared entries) + diverged /full/current.
			const seed = await TestEnv.create({ initialCommit: true });
			try {
				const archivedSeq = '1700000005000';
				const archivedTreeHead = await writeOrphanCommit(seed, {
					'archived-cp.txt': 'archived checkpoint\n',
				});
				await execGit(['update-ref', `${V2_FULL_REF_PREFIX}${archivedSeq}`, archivedTreeHead], {
					cwd: seed.dir,
				});
				await execGit(
					['push', remote.url, `+${archivedTreeHead}:${V2_FULL_REF_PREFIX}${archivedSeq}`],
					{ cwd: seed.dir },
				);

				const newCurrent = await writeOrphanCommit(seed, {
					'new-current.txt': 'new generation\n',
				});
				await execGit(['update-ref', V2_FULL_CURRENT_REF_NAME, newCurrent], { cwd: seed.dir });
				await execGit(['push', remote.url, `+${newCurrent}:${V2_FULL_CURRENT_REF_NAME}`], {
					cwd: seed.dir,
				});

				await pushRefIfNeeded(remote.fileURL, V2_FULL_CURRENT_REF_NAME, { cwd: env.dir });

				// Local /full/current now matches remote (adopted).
				const localFinal = await execGit(['rev-parse', V2_FULL_CURRENT_REF_NAME], {
					cwd: env.dir,
				});
				expect(localFinal).toBe(newCurrent);
				expect(stderrCapture.captured).toContain('Syncing');
			} finally {
				await seed.cleanup();
			}
		});

		// Go: push_v2.go: handleRotationConflict (updates generation.json timestamps)
		it('rotation conflict: updates generation.json newest_checkpoint_at to local commit time', async () => {
			// Build local /full/current with a generation.json + extra entries.
			// Local commit time intentionally newer than what's in archive.
			const genJsonContent = JSON.stringify({ newest_checkpoint_at: '2026-01-01T00:00:00Z' });
			const genBlobOid = await git.writeBlob({
				fs: fsCallback,
				dir: env.dir,
				blob: new TextEncoder().encode(genJsonContent),
			});
			const localBlobOid = await git.writeBlob({
				fs: fsCallback,
				dir: env.dir,
				blob: new TextEncoder().encode('local data\n'),
			});
			const localTreeOid = await git.writeTree({
				fs: fsCallback,
				dir: env.dir,
				tree: [
					{ mode: '100644', path: GENERATION_FILE_NAME, oid: genBlobOid, type: 'blob' },
					{ mode: '100644', path: 'local.txt', oid: localBlobOid, type: 'blob' },
				],
			});
			const localTime = Math.floor(Date.parse('2026-04-15T12:00:00Z') / 1000);
			const localCurrent = await git.writeCommit({
				fs: fsCallback,
				dir: env.dir,
				commit: {
					tree: localTreeOid,
					parent: [],
					author: {
						name: 'Test',
						email: 'test@test.com',
						timestamp: localTime,
						timezoneOffset: 0,
					},
					committer: {
						name: 'Test',
						email: 'test@test.com',
						timestamp: localTime,
						timezoneOffset: 0,
					},
					message: 'local current\n',
				},
			});
			await git.writeRef({
				fs: fsCallback,
				dir: env.dir,
				ref: V2_FULL_CURRENT_REF_NAME,
				value: localCurrent,
				force: true,
			});

			// Remote: archived generation + diverged /full/current.
			const seed = await TestEnv.create({ initialCommit: true });
			try {
				const archivedSeq = '1700000005000';
				const archivedGenJsonOid = await git.writeBlob({
					fs: fsCallback,
					dir: seed.dir,
					blob: new TextEncoder().encode(genJsonContent),
				});
				const archivedBlobOid = await git.writeBlob({
					fs: fsCallback,
					dir: seed.dir,
					blob: new TextEncoder().encode('archived data\n'),
				});
				const archivedTree = await git.writeTree({
					fs: fsCallback,
					dir: seed.dir,
					tree: [
						{ mode: '100644', path: GENERATION_FILE_NAME, oid: archivedGenJsonOid, type: 'blob' },
						{ mode: '100644', path: 'archived.txt', oid: archivedBlobOid, type: 'blob' },
					],
				});
				const archivedHead = await git.writeCommit({
					fs: fsCallback,
					dir: seed.dir,
					commit: {
						tree: archivedTree,
						parent: [],
						author: {
							name: 'Test',
							email: 'test@test.com',
							timestamp: Math.floor(Date.now() / 1000),
							timezoneOffset: 0,
						},
						committer: {
							name: 'Test',
							email: 'test@test.com',
							timestamp: Math.floor(Date.now() / 1000),
							timezoneOffset: 0,
						},
						message: 'archived gen\n',
					},
				});
				await git.writeRef({
					fs: fsCallback,
					dir: seed.dir,
					ref: `${V2_FULL_REF_PREFIX}${archivedSeq}`,
					value: archivedHead,
					force: true,
				});
				await execGit(
					['push', remote.url, `+${archivedHead}:${V2_FULL_REF_PREFIX}${archivedSeq}`],
					{
						cwd: seed.dir,
					},
				);

				// Diverged remote /full/current (different orphan).
				const newCurrent = await writeOrphanCommit(seed, { 'new-cp.txt': 'new generation\n' });
				await execGit(['update-ref', V2_FULL_CURRENT_REF_NAME, newCurrent], { cwd: seed.dir });
				await execGit(['push', remote.url, `+${newCurrent}:${V2_FULL_CURRENT_REF_NAME}`], {
					cwd: seed.dir,
				});

				await pushRefIfNeeded(remote.fileURL, V2_FULL_CURRENT_REF_NAME, { cwd: env.dir });

				// Updated archived ref: read generation.json + verify newest_checkpoint_at >= local time.
				const archivedRefHash = await execGit(
					['rev-parse', `${V2_FULL_REF_PREFIX}${archivedSeq}`],
					{
						cwd: env.dir,
					},
				);
				const archivedCommitObj = await git.readCommit({
					fs: fsCallback,
					dir: env.dir,
					oid: archivedRefHash,
				});
				const archivedTreeObj = await git.readTree({
					fs: fsCallback,
					dir: env.dir,
					oid: archivedCommitObj.commit.tree,
				});
				const genEntry = archivedTreeObj.tree.find((e) => e.path === GENERATION_FILE_NAME);
				expect(genEntry).toBeDefined();
				const blobResult = await git.readBlob({
					fs: fsCallback,
					dir: env.dir,
					oid: genEntry?.oid ?? '',
				});
				const blobText = new TextDecoder().decode(blobResult.blob);
				const parsed = JSON.parse(blobText) as { newest_checkpoint_at: string };
				const updatedTs = Date.parse(parsed.newest_checkpoint_at);
				expect(updatedTs).toBeGreaterThanOrEqual(localTime * 1000);
			} finally {
				await seed.cleanup();
			}
		});

		// Go: push_v2.go: detectRemoteOnlyArchives (filters non-13-digit refs)
		it('detectRemoteOnlyArchives ignores remote refs that do not match 13-digit pattern', async () => {
			// Locally: /full/current.
			const localHead = await writeOrphanCommit(env, { 'local.txt': 'local\n' });
			await env.exec('git', ['update-ref', V2_FULL_CURRENT_REF_NAME, localHead]);

			// Remote: only /full/current (no real archived gen). Push should succeed
			// without rotation handling.
			await execGit(['push', remote.url, `+${localHead}:${V2_FULL_CURRENT_REF_NAME}`], {
				cwd: env.dir,
			});

			// No-op push (already up-to-date).
			await pushRefIfNeeded(remote.fileURL, V2_FULL_CURRENT_REF_NAME, { cwd: env.dir });

			expect(stderrCapture.captured).toContain('already up-to-date');
		});
	});

	// Regression for P0 #2 — `finishPushRef` MUST call `printSettingsCommitHint`
	// after a successful URL push (not just print "done"). Mirrors Go's shared
	// `finishPush` being reused across v1 + v2 paths.
	describe('finishPushRef emits settings-commit hint', () => {
		it('after a successful v2 ref push to a URL, fires the once-per-process hint', async () => {
			// No checkpoint_remote committed in HEAD → hint should fire.
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			await env.exec('git', ['update-ref', V2_MAIN_REF_NAME, head]);

			await pushRefIfNeeded(remote.fileURL, V2_MAIN_REF_NAME, { cwd: env.dir });

			expect(stderrCapture.captured).toMatch(/Note: Checkpoints were pushed/);
			expect(stderrCapture.captured).toContain('.story/settings.json');
		});

		it('does NOT fire the hint when target is a remote name (not URL)', async () => {
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			await env.exec('git', ['update-ref', V2_MAIN_REF_NAME, head]);
			await env.exec('git', ['remote', 'add', 'origin', remote.url]);

			await pushRefIfNeeded('origin', V2_MAIN_REF_NAME, { cwd: env.dir });

			expect(stderrCapture.captured).not.toMatch(/Note: Checkpoints were pushed/);
		});
	});
});
