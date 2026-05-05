/**
 * Phase 5.6 push-common unit tests.
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/strategy/push_common.go` —
 * `pushBranchIfNeeded` / `parsePushResult` / `hasUnpushedSessionsCommon` /
 * `doPushBranch` / `tryPushSessionsCommon` / `fetchAndRebaseSessionsCommon` /
 * `printSettingsCommitHint` / `isCheckpointRemoteCommitted`.
 */

import fsCallback from 'node:fs';
import fs from 'node:fs/promises';
import git from 'isomorphic-git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { METADATA_BRANCH_NAME } from '@/checkpoint/constants';
import { execGit } from '@/git';
import { setStderrWriterForTesting } from '@/strategy/hooks-tty';
import {
	parsePushResult,
	pushBranchIfNeeded,
	resetSettingsHintForTesting,
} from '@/strategy/push-common';
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
		end(): void {},
		on(): NodeJS.WritableStream {
			return stream;
		},
		once(): NodeJS.WritableStream {
			return stream;
		},
		emit(): boolean {
			return false;
		},
	} as unknown as NodeJS.WritableStream & Captured;
	return stream;
}

describe('strategy/push-common — Go: push_common.go', () => {
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

	// Go: push_common.go: parsePushResult
	describe('parsePushResult', () => {
		it('returns upToDate:true when "=" status flag present', () => {
			// Go: push_common.go: parsePushResult (= flag)
			const out = 'To origin\n=\trefs/heads/main:refs/heads/main\t[up to date]\nDone';
			expect(parsePushResult(out)).toEqual({ upToDate: true });
		});

		it('returns upToDate:false on any other flag', () => {
			// Go: push_common.go: parsePushResult (other flag)
			expect(
				parsePushResult('To origin\n*\trefs/heads/main:refs/heads/main\t[new branch]\nDone'),
			).toEqual({ upToDate: false });
			expect(parsePushResult('')).toEqual({ upToDate: false });
		});
	});

	// Go: push_common.go: pushBranchIfNeeded
	describe('pushBranchIfNeeded', () => {
		// Go: push_common.go: pushBranchIfNeeded (no local branch)
		it('silent return when local branch missing', async () => {
			// No git push attempted because branch doesn't exist.
			await expect(
				pushBranchIfNeeded(remote.url, METADATA_BRANCH_NAME, { cwd: env.dir }),
			).resolves.toBeUndefined();
			expect(await remote.resolveRef(`refs/heads/${METADATA_BRANCH_NAME}`)).toBeNull();
		});

		// Go: push_common.go: pushBranchIfNeeded (openRepository fail)
		it('silent return when not a git repo', async () => {
			// pushBranchIfNeeded should not throw when cwd is not a git repo.
			await expect(
				pushBranchIfNeeded(remote.url, METADATA_BRANCH_NAME, { cwd: '/tmp' }),
			).resolves.toBeUndefined();
		});

		// Go: push_common.go: pushBranchIfNeeded (URL target — no hasUnpushed optimization)
		it('with URL target always attempts push (no hasUnpushed optimization)', async () => {
			// Seed local branch.
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			await env.exec('git', ['update-ref', `refs/heads/${METADATA_BRANCH_NAME}`, head]);

			await pushBranchIfNeeded(remote.url, METADATA_BRANCH_NAME, { cwd: env.dir });

			// Push happened — remote received the ref.
			const remoteHash = await remote.resolveRef(`refs/heads/${METADATA_BRANCH_NAME}`);
			expect(remoteHash).toBe(head);
		});

		// Go: push_common.go: hasUnpushedSessionsCommon (skips push when local==remote tracking ref)
		it('with remote name skips push when local hash equals remote tracking ref', async () => {
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			await env.exec('git', ['update-ref', `refs/heads/${METADATA_BRANCH_NAME}`, head]);
			// Configure a remote and a tracking ref pointing at the same hash.
			await env.exec('git', ['remote', 'add', 'origin', remote.url]);
			await env.exec('git', ['update-ref', `refs/remotes/origin/${METADATA_BRANCH_NAME}`, head]);

			await pushBranchIfNeeded('origin', METADATA_BRANCH_NAME, { cwd: env.dir });

			// No push happened — remote does NOT have the ref.
			expect(await remote.resolveRef(`refs/heads/${METADATA_BRANCH_NAME}`)).toBeNull();
		});

		// Story-side naming red line: brand on stderr.
		it('writes [story] brand to stderr on success path', async () => {
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			await env.exec('git', ['update-ref', `refs/heads/${METADATA_BRANCH_NAME}`, head]);

			await pushBranchIfNeeded(remote.url, METADATA_BRANCH_NAME, { cwd: env.dir });

			expect(stderrCapture.captured).toContain('[story]');
			expect(stderrCapture.captured).not.toContain('[entire]');
		});

		// Go: push_common.go: doPushBranch (URL display name)
		it('uses "checkpoint remote" as display target when target is URL', async () => {
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			await env.exec('git', ['update-ref', `refs/heads/${METADATA_BRANCH_NAME}`, head]);

			await pushBranchIfNeeded(remote.fileURL, METADATA_BRANCH_NAME, { cwd: env.dir });

			expect(stderrCapture.captured).toContain('checkpoint remote');
		});

		// Go: push_common.go: doPushBranch (remote name display)
		it('uses remote name as display target when target is remote name', async () => {
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			await env.exec('git', ['update-ref', `refs/heads/${METADATA_BRANCH_NAME}`, head]);
			await env.exec('git', ['remote', 'add', 'origin', remote.url]);

			await pushBranchIfNeeded('origin', METADATA_BRANCH_NAME, { cwd: env.dir });

			expect(stderrCapture.captured).toContain('to origin');
			expect(stderrCapture.captured).not.toContain('to checkpoint remote');
		});

		// Go: push_common.go: pushBranchIfNeeded (silent-on-failure)
		it('silent on failure: push to bogus URL → stderr warning, no throw', async () => {
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			await env.exec('git', ['update-ref', `refs/heads/${METADATA_BRANCH_NAME}`, head]);

			await expect(
				pushBranchIfNeeded('https://nonexistent.invalid/o/r.git', METADATA_BRANCH_NAME, {
					cwd: env.dir,
				}),
			).resolves.toBeUndefined();
			expect(stderrCapture.captured).toMatch(/\[story\] Warning/);
		});
	});

	// Go: push_common.go: fetchAndRebaseSessionsCommon (cherry-picks local-only commits)
	describe('fetchAndRebaseSessionsCommon (via pushBranchIfNeeded retry)', () => {
		it('cherry-picks local-only commits onto remote tip after non-fast-forward (URL target)', async () => {
			// Set up: local branch has 1 commit; push it.
			const baseHead = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			await env.exec('git', ['update-ref', `refs/heads/${METADATA_BRANCH_NAME}`, baseHead]);
			await execGit(
				[
					'push',
					remote.url,
					`+refs/heads/${METADATA_BRANCH_NAME}:refs/heads/${METADATA_BRANCH_NAME}`,
				],
				{ cwd: env.dir },
			);

			// Add 2 local commits on metadata branch (sharded paths style — unique).
			let metaTip = baseHead;
			for (let i = 0; i < 2; i++) {
				const blobOid = await git.writeBlob({
					fs: fsCallback,
					dir: env.dir,
					blob: new TextEncoder().encode(`local-only-${i}\n`),
				});
				const treeOid = await git.writeTree({
					fs: fsCallback,
					dir: env.dir,
					tree: [{ mode: '100644', path: `local-${i}.txt`, oid: blobOid, type: 'blob' }],
				});
				metaTip = await git.writeCommit({
					fs: fsCallback,
					dir: env.dir,
					commit: {
						tree: treeOid,
						parent: [metaTip],
						author: {
							name: 'Test',
							email: 'test@test.com',
							timestamp: Math.floor(Date.now() / 1000) + i,
							timezoneOffset: 0,
						},
						committer: {
							name: 'Test',
							email: 'test@test.com',
							timestamp: Math.floor(Date.now() / 1000) + i,
							timezoneOffset: 0,
						},
						message: `local commit ${i}\n`,
					},
				});
			}
			await git.writeRef({
				fs: fsCallback,
				dir: env.dir,
				ref: `refs/heads/${METADATA_BRANCH_NAME}`,
				value: metaTip,
				force: true,
			});

			// Force-push a divergent commit to the remote (no shared history).
			const seed = await TestEnv.create({ initialCommit: true });
			try {
				const blobOid = await git.writeBlob({
					fs: fsCallback,
					dir: seed.dir,
					blob: new TextEncoder().encode('remote-side-commit\n'),
				});
				const treeOid = await git.writeTree({
					fs: fsCallback,
					dir: seed.dir,
					tree: [{ mode: '100644', path: 'remote.txt', oid: blobOid, type: 'blob' }],
				});
				const remoteCommit = await git.writeCommit({
					fs: fsCallback,
					dir: seed.dir,
					commit: {
						tree: treeOid,
						parent: [],
						author: {
							name: 'Test',
							email: 'test@test.com',
							timestamp: Math.floor(Date.now() / 1000) + 100,
							timezoneOffset: 0,
						},
						committer: {
							name: 'Test',
							email: 'test@test.com',
							timestamp: Math.floor(Date.now() / 1000) + 100,
							timezoneOffset: 0,
						},
						message: 'remote-side commit\n',
					},
				});
				await execGit(['push', remote.url, `+${remoteCommit}:refs/heads/${METADATA_BRANCH_NAME}`], {
					cwd: seed.dir,
				});

				// Use file:// URL form so isURL() is true and the URL temp-ref branch is exercised.
				await pushBranchIfNeeded(remote.fileURL, METADATA_BRANCH_NAME, { cwd: env.dir });

				expect(stderrCapture.captured).toContain('Syncing');
				const finalRemote = await remote.resolveRef(`refs/heads/${METADATA_BRANCH_NAME}`);
				expect(finalRemote).toMatch(/^[0-9a-f]{40}$/);
			} finally {
				await seed.cleanup();
			}
		});

		it('fast-forwards when local is ancestor of remote', async () => {
			const baseHead = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			await env.exec('git', ['update-ref', `refs/heads/${METADATA_BRANCH_NAME}`, baseHead]);
			await execGit(
				[
					'push',
					remote.url,
					`+refs/heads/${METADATA_BRANCH_NAME}:refs/heads/${METADATA_BRANCH_NAME}`,
				],
				{ cwd: env.dir },
			);

			// Extend remote with a descendant commit.
			const blobOid = await git.writeBlob({
				fs: fsCallback,
				dir: env.dir,
				blob: new TextEncoder().encode('descendant\n'),
			});
			const treeOid = await git.writeTree({
				fs: fsCallback,
				dir: env.dir,
				tree: [{ mode: '100644', path: 'desc.txt', oid: blobOid, type: 'blob' }],
			});
			const descendant = await git.writeCommit({
				fs: fsCallback,
				dir: env.dir,
				commit: {
					tree: treeOid,
					parent: [baseHead],
					author: {
						name: 'Test',
						email: 'test@test.com',
						timestamp: Math.floor(Date.now() / 1000) + 50,
						timezoneOffset: 0,
					},
					committer: {
						name: 'Test',
						email: 'test@test.com',
						timestamp: Math.floor(Date.now() / 1000) + 50,
						timezoneOffset: 0,
					},
					message: 'descendant\n',
				},
			});
			await execGit(['push', remote.url, `+${descendant}:refs/heads/${METADATA_BRANCH_NAME}`], {
				cwd: env.dir,
			});

			// Local branch back to baseHead (ancestor of descendant).
			await git.writeRef({
				fs: fsCallback,
				dir: env.dir,
				ref: `refs/heads/${METADATA_BRANCH_NAME}`,
				value: baseHead,
				force: true,
			});

			await pushBranchIfNeeded(remote.fileURL, METADATA_BRANCH_NAME, { cwd: env.dir });

			// After fast-forward, local should be at descendant.
			const finalLocal = await execGit(['rev-parse', `refs/heads/${METADATA_BRANCH_NAME}`], {
				cwd: env.dir,
			});
			expect(finalLocal).toBe(descendant);
		});

		it('reports remote rejected/protected branch instead of misclassifying it as non-fast-forward', async () => {
			const baseHead = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			await env.exec('git', ['update-ref', `refs/heads/${METADATA_BRANCH_NAME}`, baseHead]);
			await execGit(
				[
					'push',
					remote.url,
					`+refs/heads/${METADATA_BRANCH_NAME}:refs/heads/${METADATA_BRANCH_NAME}`,
				],
				{ cwd: env.dir },
			);

			const blobOid = await git.writeBlob({
				fs: fsCallback,
				dir: env.dir,
				blob: new TextEncoder().encode('local protected update\n'),
			});
			const treeOid = await git.writeTree({
				fs: fsCallback,
				dir: env.dir,
				tree: [{ mode: '100644', path: 'protected.txt', oid: blobOid, type: 'blob' }],
			});
			const localTip = await git.writeCommit({
				fs: fsCallback,
				dir: env.dir,
				commit: {
					tree: treeOid,
					parent: [baseHead],
					author: {
						name: 'Test',
						email: 'test@test.com',
						timestamp: Math.floor(Date.now() / 1000) + 1,
						timezoneOffset: 0,
					},
					committer: {
						name: 'Test',
						email: 'test@test.com',
						timestamp: Math.floor(Date.now() / 1000) + 1,
						timezoneOffset: 0,
					},
					message: 'local protected update\n',
				},
			});
			await env.exec('git', ['update-ref', `refs/heads/${METADATA_BRANCH_NAME}`, localTip]);

			await fs.writeFile(
				`${remote.dir}/hooks/pre-receive`,
				'#!/bin/sh\necho "remote: Error | branch is protected" >&2\nexit 1\n',
				{ mode: 0o755 },
			);
			await fs.chmod(`${remote.dir}/hooks/pre-receive`, 0o755);

			await pushBranchIfNeeded(remote.fileURL, METADATA_BRANCH_NAME, { cwd: env.dir });

			expect(stderrCapture.captured).toContain('branch is protected');
			expect(stderrCapture.captured).not.toContain(
				`failed to push ${METADATA_BRANCH_NAME} after sync: non-fast-forward`,
			);
		});

		it('warns when fetch+rebase fails (URL unreachable) and prints checkpoint-remote hint', async () => {
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			await env.exec('git', ['update-ref', `refs/heads/${METADATA_BRANCH_NAME}`, head]);

			// Push first to bogus URL → push fails → fetch+rebase also fails → hint prints.
			await pushBranchIfNeeded('https://nonexistent.invalid/o/r.git', METADATA_BRANCH_NAME, {
				cwd: env.dir,
			});

			expect(stderrCapture.captured).toContain('[story]');
			// Should mention the .story/settings.local.json hint when target is URL.
			expect(stderrCapture.captured).toMatch(
				/\.story\/settings\.local\.json|checkpoint remote is configured/,
			);
		});

		// Go: push_common.go: doPushBranch (TestDoPushBranch_UnreachableTarget_ReturnsNil)
		// Regression for P0 #1: Go ALWAYS proceeds to "Syncing..." after any first-push
		// failure. TS used to skip fetch+rebase on non-NFF errors → never showed Syncing.
		// This test asserts the full sequence: Pushing → (fail) → Syncing → (fail) → Warning.
		it('on first-push failure (any error) proceeds to Syncing... before giving up', async () => {
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			await env.exec('git', ['update-ref', `refs/heads/${METADATA_BRANCH_NAME}`, head]);

			await pushBranchIfNeeded('https://nonexistent.invalid/o/r.git', METADATA_BRANCH_NAME, {
				cwd: env.dir,
			});

			// Stderr should show: Pushing... → Syncing... → Warning (couldn't sync) →
			// checkpoint-remote hint. Critical regression: "Syncing" must appear.
			expect(stderrCapture.captured).toContain('Pushing');
			expect(stderrCapture.captured).toContain('Syncing');
			expect(stderrCapture.captured).toMatch(/\[story\] Warning: couldn't sync/);
		});
	});

	// Go: push_common.go: printSettingsCommitHint (sync.Once + .story/ path)
	describe('printSettingsCommitHint via successful URL push', () => {
		it('emits hint only once per process across multiple push calls', async () => {
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			await env.exec('git', ['update-ref', `refs/heads/${METADATA_BRANCH_NAME}`, head]);

			await pushBranchIfNeeded(remote.fileURL, METADATA_BRANCH_NAME, { cwd: env.dir });
			await pushBranchIfNeeded(remote.fileURL, METADATA_BRANCH_NAME, { cwd: env.dir });
			await pushBranchIfNeeded(remote.fileURL, METADATA_BRANCH_NAME, { cwd: env.dir });

			const hintMatches = stderrCapture.captured.match(/Note: Checkpoints were pushed/g) ?? [];
			expect(hintMatches.length).toBeLessThanOrEqual(1);
		});

		it('skips hint when target is not URL (remote name)', async () => {
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			await env.exec('git', ['update-ref', `refs/heads/${METADATA_BRANCH_NAME}`, head]);
			await env.exec('git', ['remote', 'add', 'origin', remote.url]);

			await pushBranchIfNeeded('origin', METADATA_BRANCH_NAME, { cwd: env.dir });

			expect(stderrCapture.captured).not.toContain('Note: Checkpoints were pushed');
		});

		// Story-side naming red line.
		it('hint reads .story/settings.json (NOT .entire/settings.json)', async () => {
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			await env.exec('git', ['update-ref', `refs/heads/${METADATA_BRANCH_NAME}`, head]);

			await pushBranchIfNeeded(remote.fileURL, METADATA_BRANCH_NAME, { cwd: env.dir });

			// Hint should print (no committed checkpoint_remote) and reference .story/.
			expect(stderrCapture.captured).toContain('Note: Checkpoints were pushed');
			expect(stderrCapture.captured).toContain('.story/settings.json');
			expect(stderrCapture.captured).not.toContain('.entire/settings.json');
		});

		it('skips hint when committed .story/settings.json contains checkpoint_remote', async () => {
			await env.writeFile(
				'.story/settings.json',
				JSON.stringify({
					enabled: true,
					strategy_options: {
						checkpoint_remote: { provider: 'github', repo: 'a/b' },
					},
				}),
			);
			await env.gitAdd('.story/settings.json');
			await env.gitCommit('add story settings with checkpoint_remote');

			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			await env.exec('git', ['update-ref', `refs/heads/${METADATA_BRANCH_NAME}`, head]);

			await pushBranchIfNeeded(remote.fileURL, METADATA_BRANCH_NAME, { cwd: env.dir });

			expect(stderrCapture.captured).not.toContain('Note: Checkpoints were pushed');
		});
	});

	// Silent-on-failure invariant audit.
	describe('silent-on-failure invariant', () => {
		it('never throws on any error path', async () => {
			// 4 fault scenarios — none should throw:
			//   (a) cwd not a git repo
			await expect(
				pushBranchIfNeeded(remote.url, METADATA_BRANCH_NAME, { cwd: '/tmp' }),
			).resolves.toBeUndefined();

			//   (b) local branch missing
			await expect(
				pushBranchIfNeeded(remote.url, METADATA_BRANCH_NAME, { cwd: env.dir }),
			).resolves.toBeUndefined();

			//   (c) push to nonexistent URL
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			await env.exec('git', ['update-ref', `refs/heads/${METADATA_BRANCH_NAME}`, head]);
			await expect(
				pushBranchIfNeeded('https://nonexistent.invalid/o/r.git', METADATA_BRANCH_NAME, {
					cwd: env.dir,
				}),
			).resolves.toBeUndefined();

			//   (d) push to nonexistent remote name
			await expect(
				pushBranchIfNeeded('nonexistent-remote', METADATA_BRANCH_NAME, { cwd: env.dir }),
			).resolves.toBeUndefined();
		});
	});
});
