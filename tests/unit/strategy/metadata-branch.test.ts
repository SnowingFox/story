/**
 * Phase 5.1 metadata-branch.ts unit tests — ported 1:1 from Go
 * `entire-cli/cmd/entire/cli/strategy/common_test.go` (EnsureMetadataBranch
 * subtests + helpers).
 *
 * Each `it()` is annotated with `// Go: <file>:<line> <TestName>` for traceability.
 *
 * Known impl-gap previews (will fail under current TS impl):
 * - Missing `readCheckpointMetadata` / `readCheckpointMetadataFromSubtree` reader exports
 *   (Go's `common.go:493-608`); TS only exposes `decodeCheckpointInfo(blob)`.
 *
 * Branch name: Go uses `paths.MetadataBranchName` = `"entire/checkpoints/v1"`,
 * TS uses `METADATA_BRANCH_NAME` = `"story/checkpoints/v1"` (Story rebrand).
 * Tests reference the TS constant; the Go-vs-TS rebrand is intentional.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { METADATA_BRANCH_NAME } from '@/checkpoint/constants';
import { execGit } from '@/git';
import {
	decodeCheckpointInfo,
	ensureMetadataBranch,
	getMetadataBranchTree,
	getRemoteMetadataBranchTree,
	getV2MetadataBranchTree,
	listCheckpoints,
} from '@/strategy/metadata-branch';
import { TestEnv } from '../../helpers/test-env';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/**
 * Mirror Go test helper `initBareWithMetadataBranch` (common_test.go:1003-1040).
 * Creates a bare repo with a `main` branch + a `<METADATA_BRANCH_NAME>` orphan branch
 * containing one checkpoint metadata.json file.
 */
async function initBareWithMetadataBranch(): Promise<{
	bareDir: string;
	cleanup: () => Promise<void>;
}> {
	const bareBase = await fs.mkdtemp(path.join(os.tmpdir(), 'story-bare-'));
	const bareDir = path.join(bareBase, 'bare.git');
	const workBase = await fs.mkdtemp(path.join(os.tmpdir(), 'story-work-'));
	const workDir = path.join(workBase, 'work');

	await execGit(['init', '--bare', '-b', 'main', bareDir]);
	await execGit(['clone', bareDir, workDir]);
	await execGit(['config', 'user.email', 'test@test.com'], { cwd: workDir });
	await execGit(['config', 'user.name', 'Test User'], { cwd: workDir });
	await execGit(['config', 'commit.gpgsign', 'false'], { cwd: workDir });
	await fs.writeFile(path.join(workDir, 'README.md'), '# Test');
	await execGit(['add', '.'], { cwd: workDir });
	await execGit(['commit', '-m', 'init'], { cwd: workDir });
	await execGit(['push', 'origin', 'main'], { cwd: workDir });

	// Create orphan metadata branch with data
	await execGit(['checkout', '--orphan', METADATA_BRANCH_NAME], { cwd: workDir });
	await execGit(['rm', '-rf', '.'], { cwd: workDir });
	await fs.writeFile(path.join(workDir, 'metadata.json'), '{"checkpoint_id":"test123"}');
	await execGit(['add', '.'], { cwd: workDir });
	await execGit(['commit', '-m', 'Checkpoint: test123'], { cwd: workDir });
	await execGit(['push', 'origin', METADATA_BRANCH_NAME], { cwd: workDir });

	return {
		bareDir,
		cleanup: async () => {
			await fs.rm(bareBase, { recursive: true, force: true });
			await fs.rm(workBase, { recursive: true, force: true });
		},
	};
}

describe('strategy/metadata-branch — ported from common_test.go', () => {
	describe('TestEnsureMetadataBranch — Go: common_test.go:1042-1165', () => {
		// Go: common_test.go:1045-1078 "creates from remote on fresh clone"
		it('creates from remote on fresh clone (Go: common_test.go:1045-1078)', async () => {
			const { bareDir, cleanup } = await initBareWithMetadataBranch();
			const cloneBase = await fs.mkdtemp(path.join(os.tmpdir(), 'story-clone-'));
			const cloneDir = path.join(cloneBase, 'clone');
			try {
				await execGit(['clone', bareDir, cloneDir]);

				await ensureMetadataBranch(cloneDir);

				// Local branch should exist with data (not empty)
				const refExists = await execGit(
					['rev-parse', '--verify', `refs/heads/${METADATA_BRANCH_NAME}`],
					{ cwd: cloneDir },
				).catch(() => null);
				expect(refExists).not.toBeNull();

				// Tree should not be empty (Go fetched real data, not empty orphan)
				const tree = await getMetadataBranchTree(cloneDir);
				expect(tree).not.toBeNull();
				const lsTree = await execGit(['ls-tree', tree as string], { cwd: cloneDir });
				expect(lsTree).not.toBe('');
			} finally {
				await fs.rm(cloneBase, { recursive: true, force: true });
				await cleanup();
			}
		});

		// Go: common_test.go:1080-1134 — when local is an empty orphan
		// (placeholder from old enable behavior) AND remote has real data,
		// ensureMetadataBranch lifts local to remote.hash (branch 2 of the
		// 5-branch logic in src/strategy/metadata-branch.ts).
		it('updates empty orphan from remote (Go: common_test.go:1080-1134)', async () => {
			const { bareDir, cleanup } = await initBareWithMetadataBranch();
			const cloneBase = await fs.mkdtemp(path.join(os.tmpdir(), 'story-clone-empty-'));
			const cloneDir = path.join(cloneBase, 'clone');
			try {
				await execGit(['clone', bareDir, cloneDir]);
				await execGit(['config', 'user.email', 'test@test.com'], { cwd: cloneDir });
				await execGit(['config', 'user.name', 'Test User'], { cwd: cloneDir });
				await execGit(['config', 'commit.gpgsign', 'false'], { cwd: cloneDir });

				// Create an empty orphan ref directly via well-known empty tree SHA.
				// Avoids `git checkout --orphan` interactive prompts when the worktree
				// has files (HEAD would still need to be detached).
				const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
				const emptyCommit = (
					await execGit(['commit-tree', EMPTY_TREE, '-m', 'Initialize metadata branch'], {
						cwd: cloneDir,
					})
				).trim();
				await execGit(['update-ref', `refs/heads/${METADATA_BRANCH_NAME}`, emptyCommit], {
					cwd: cloneDir,
				});
				const orphanHash = (
					await execGit(['rev-parse', `refs/heads/${METADATA_BRANCH_NAME}`], {
						cwd: cloneDir,
					})
				).trim();

				await ensureMetadataBranch(cloneDir);

				// Local should be lifted to remote.hash (no longer empty)
				const after = (
					await execGit(['rev-parse', `refs/heads/${METADATA_BRANCH_NAME}`], {
						cwd: cloneDir,
					})
				).trim();
				expect(after).not.toBe(orphanHash);

				const remoteHash = (
					await execGit(['rev-parse', `refs/remotes/origin/${METADATA_BRANCH_NAME}`], {
						cwd: cloneDir,
					})
				).trim();
				expect(after).toBe(remoteHash);
			} finally {
				await fs.rm(cloneBase, { recursive: true, force: true });
				await cleanup();
			}
		});

		// Go: common_test.go:1136-1164 "creates empty orphan when no remote"
		it('creates empty orphan when no remote (Go: common_test.go:1136-1164)', async () => {
			const env = await TestEnv.create({ initialCommit: true });
			try {
				await ensureMetadataBranch(env.dir);

				const ref = await execGit(['rev-parse', '--verify', `refs/heads/${METADATA_BRANCH_NAME}`], {
					cwd: env.dir,
				});
				expect(ref).not.toBe('');

				// Tree should be empty (no remote to fetch from)
				const tree = await getMetadataBranchTree(env.dir);
				expect(tree).not.toBeNull();
				const lsTree = (await execGit(['ls-tree', tree as string], { cwd: env.dir })).trim();
				expect(lsTree).toBe('');
			} finally {
				await env.cleanup();
			}
		});
	});

	// ─── audit-3 Fix C + D (2026-04-18): Go-aligned stderr messages ──────────
	// Go: common.go:343 / 366 / 413 emit user-facing stderr lines on each of
	// branches 2 / 4 / 5. Pre-fix TS branch 5 was silent and branches 2/4 had
	// different wording. Audit-3 aligned all three. The `vi.spyOn(process.stderr, 'write')`
	// captures the writes without polluting test output.

	describe('audit-3: Go-aligned stderr messages — Go: common.go:343,366,413', () => {
		// Go: common.go:413 — Branch 5 prints "✓ Created orphan branch '%s' for session metadata"
		it('Branch 5 (no local + no remote) emits "✓ Created orphan branch" stderr', async () => {
			const env = await TestEnv.create({ initialCommit: true });
			const writes: string[] = [];
			const spy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
				if (typeof chunk === 'string') {
					writes.push(chunk);
				} else if (chunk instanceof Uint8Array) {
					writes.push(new TextDecoder().decode(chunk));
				}
				return true;
			}) as typeof process.stderr.write);
			try {
				await ensureMetadataBranch(env.dir);
				const stderrOutput = writes.join('');
				expect(stderrOutput).toContain('✓ Created orphan branch');
				expect(stderrOutput).toContain(METADATA_BRANCH_NAME);
				expect(stderrOutput).toContain('for session metadata');
			} finally {
				spy.mockRestore();
				await env.cleanup();
			}
		});

		// Go: common.go:366 — Branch 4 prints "✓ Created local branch '%s' from origin"
		it('Branch 4 (no local + remote exists) emits "✓ Created local branch" stderr', async () => {
			const { bareDir, cleanup } = await initBareWithMetadataBranch();
			const cloneBase = await fs.mkdtemp(path.join(os.tmpdir(), 'story-clone-stderr-b4-'));
			const cloneDir = path.join(cloneBase, 'clone');
			const writes: string[] = [];
			const spy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
				if (typeof chunk === 'string') {
					writes.push(chunk);
				} else if (chunk instanceof Uint8Array) {
					writes.push(new TextDecoder().decode(chunk));
				}
				return true;
			}) as typeof process.stderr.write);
			try {
				await execGit(['clone', bareDir, cloneDir]);
				await ensureMetadataBranch(cloneDir);
				const stderrOutput = writes.join('');
				expect(stderrOutput).toContain('✓ Created local branch');
				expect(stderrOutput).toContain(METADATA_BRANCH_NAME);
				expect(stderrOutput).toContain('from origin');
			} finally {
				spy.mockRestore();
				await fs.rm(cloneBase, { recursive: true, force: true });
				await cleanup();
			}
		});

		// Go: common.go:343 — Branch 2 prints "[entire] Updated local branch '%s' from origin"
		// (TS drops the [entire] prefix per story-vs-entire rebrand.)
		it('Branch 2 (local empty placeholder + remote exists) emits "Updated local branch" stderr', async () => {
			const { bareDir, cleanup } = await initBareWithMetadataBranch();
			const cloneBase = await fs.mkdtemp(path.join(os.tmpdir(), 'story-clone-stderr-b2-'));
			const cloneDir = path.join(cloneBase, 'clone');
			try {
				await execGit(['clone', bareDir, cloneDir]);
				await execGit(['config', 'user.email', 'test@test.com'], { cwd: cloneDir });
				await execGit(['config', 'user.name', 'Test User'], { cwd: cloneDir });
				await execGit(['config', 'commit.gpgsign', 'false'], { cwd: cloneDir });
				// Plant an empty-orphan local that DIFFERS from remote (Branch 2).
				const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
				const emptyCommit = (
					await execGit(['commit-tree', EMPTY_TREE, '-m', 'placeholder'], { cwd: cloneDir })
				).trim();
				await execGit(['update-ref', `refs/heads/${METADATA_BRANCH_NAME}`, emptyCommit], {
					cwd: cloneDir,
				});

				// Spy *after* setup so the placeholder prints don't pollute capture.
				const writes: string[] = [];
				const spy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
					if (typeof chunk === 'string') {
						writes.push(chunk);
					} else if (chunk instanceof Uint8Array) {
						writes.push(new TextDecoder().decode(chunk));
					}
					return true;
				}) as typeof process.stderr.write);
				try {
					await ensureMetadataBranch(cloneDir);
					const stderrOutput = writes.join('');
					expect(stderrOutput).toContain('Updated local branch');
					expect(stderrOutput).toContain(METADATA_BRANCH_NAME);
					expect(stderrOutput).toContain('from origin');
				} finally {
					spy.mockRestore();
				}
			} finally {
				await fs.rm(cloneBase, { recursive: true, force: true });
				await cleanup();
			}
		});
	});

	// Go: common_test.go:1189-1238 TestEnsureMetadataBranch_DisconnectedBranchesNotReconciledInEnable
	it('TestEnsureMetadataBranch_DisconnectedBranchesNotReconciledInEnable — Go: common_test.go:1189-1238', async () => {
		const { bareDir, cleanup } = await initBareWithMetadataBranch();
		const cloneBase = await fs.mkdtemp(path.join(os.tmpdir(), 'story-disconnected-'));
		const cloneDir = path.join(cloneBase, 'clone');
		try {
			await execGit(['clone', bareDir, cloneDir]);
			await execGit(['config', 'user.email', 'test@test.com'], { cwd: cloneDir });
			await execGit(['config', 'user.name', 'Test User'], { cwd: cloneDir });
			await execGit(['config', 'commit.gpgsign', 'false'], { cwd: cloneDir });

			// Create a disconnected local branch with different checkpoint data
			await execGit(['checkout', '--orphan', 'temp-orphan'], { cwd: cloneDir });
			await execGit(['rm', '-rf', '.'], { cwd: cloneDir });
			const localCheckpointDir = path.join(cloneDir, 'ab', 'cdef012345');
			await fs.mkdir(localCheckpointDir, { recursive: true });
			await fs.writeFile(
				path.join(localCheckpointDir, 'metadata.json'),
				'{"checkpoint_id":"abcdef012345"}',
			);
			await execGit(['add', '.'], { cwd: cloneDir });
			await execGit(['commit', '-m', 'Checkpoint: abcdef012345'], { cwd: cloneDir });
			await execGit(['branch', '-f', METADATA_BRANCH_NAME, 'temp-orphan'], { cwd: cloneDir });

			// Get local ref hash before EnsureMetadataBranch
			const localRefBefore = (
				await execGit(['rev-parse', `refs/heads/${METADATA_BRANCH_NAME}`], { cwd: cloneDir })
			).trim();

			await ensureMetadataBranch(cloneDir);

			// EnsureMetadataBranch should NOT reconcile disconnected branches.
			const localRefAfter = (
				await execGit(['rev-parse', `refs/heads/${METADATA_BRANCH_NAME}`], { cwd: cloneDir })
			).trim();
			expect(localRefAfter).toBe(localRefBefore);
		} finally {
			await fs.rm(cloneBase, { recursive: true, force: true });
			await cleanup();
		}
	});

	// Go: common_test.go:1240-1304 TestEnsureMetadataBranch_DoesNotFastForwardWhenBehind
	it('TestEnsureMetadataBranch_DoesNotFastForwardWhenBehind — Go: common_test.go:1240-1304', async () => {
		const { bareDir, cleanup } = await initBareWithMetadataBranch();
		const cloneBase = await fs.mkdtemp(path.join(os.tmpdir(), 'story-noff-'));
		const cloneDir = path.join(cloneBase, 'clone');
		try {
			await execGit(['clone', bareDir, cloneDir]);
			await execGit(['config', 'user.email', 'test@test.com'], { cwd: cloneDir });
			await execGit(['config', 'user.name', 'Test User'], { cwd: cloneDir });
			await execGit(['config', 'commit.gpgsign', 'false'], { cwd: cloneDir });

			// First call: bring local in sync with remote
			await ensureMetadataBranch(cloneDir);

			// Remember current local hash
			const localBefore = (
				await execGit(['rev-parse', `refs/heads/${METADATA_BRANCH_NAME}`], { cwd: cloneDir })
			).trim();

			// Add a second checkpoint to the remote (simulates another machine pushing)
			await execGit(['checkout', METADATA_BRANCH_NAME], { cwd: cloneDir });
			const secondDir = path.join(cloneDir, 'cd', 'ef01234567');
			await fs.mkdir(secondDir, { recursive: true });
			await fs.writeFile(path.join(secondDir, 'metadata.json'), '{"checkpoint_id":"cdef01234567"}');
			await execGit(['add', '.'], { cwd: cloneDir });
			await execGit(['commit', '-m', 'Checkpoint: cdef01234567'], { cwd: cloneDir });
			await execGit(['push', 'origin', METADATA_BRANCH_NAME], { cwd: cloneDir });

			// Reset local branch back to old commit (local is now behind remote)
			await execGit(['update-ref', `refs/heads/${METADATA_BRANCH_NAME}`, localBefore], {
				cwd: cloneDir,
			});

			await ensureMetadataBranch(cloneDir);

			// EnsureMetadataBranch no longer fast-forwards diverged branches.
			const localAfter = (
				await execGit(['rev-parse', `refs/heads/${METADATA_BRANCH_NAME}`], { cwd: cloneDir })
			).trim();
			expect(localAfter).toBe(localBefore);
		} finally {
			await fs.rm(cloneBase, { recursive: true, force: true });
			await cleanup();
		}
	});
});

/**
 * TS supplemental: tree readers + decodeCheckpointInfo unit tests
 * (Go tests live in different files; these are TS-side coverage to verify
 * the thin facade works against Phase 4.3 helpers).
 */
describe('strategy/metadata-branch — TS supplemental', () => {
	let env: TestEnv;
	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
	});
	afterEach(async () => {
		await env.cleanup();
	});

	it('getMetadataBranchTree returns null when metadata branch missing', async () => {
		expect(await getMetadataBranchTree(env.dir)).toBeNull();
	});

	it('getV2MetadataBranchTree returns null when v2 main ref missing', async () => {
		expect(await getV2MetadataBranchTree(env.dir)).toBeNull();
	});

	// Go: common.go:841-858 GetRemoteMetadataBranchTree
	// (no dedicated Go Test*; covered via resume_test.go in CLI package)
	it('getRemoteMetadataBranchTree returns null when refs/remotes/origin/<metadata> missing', async () => {
		expect(await getRemoteMetadataBranchTree(env.dir)).toBeNull();
	});

	it('getRemoteMetadataBranchTree resolves to remote tree hash when origin/<metadata> exists', async () => {
		// Set up: clone-style repo with origin/<METADATA_BRANCH_NAME> ref.
		const { bareDir, cleanup } = await initBareWithMetadataBranch();
		const cloneBase = await fs.mkdtemp(path.join(os.tmpdir(), 'story-clone-remote-'));
		const cloneDir = path.join(cloneBase, 'clone');
		try {
			await execGit(['clone', bareDir, cloneDir]);
			// fetch the metadata branch into refs/remotes/origin/<...> without
			// creating a local branch tracking it.
			await execGit(
				[
					'fetch',
					'origin',
					`+refs/heads/${METADATA_BRANCH_NAME}:refs/remotes/origin/${METADATA_BRANCH_NAME}`,
				],
				{ cwd: cloneDir },
			);

			const tree = await getRemoteMetadataBranchTree(cloneDir);
			expect(tree).not.toBeNull();
			// The remote branch had `metadata.json` written in initBareWithMetadataBranch().
			const lsTree = await execGit(['ls-tree', tree as string], { cwd: cloneDir });
			expect(lsTree).toContain('metadata.json');
		} finally {
			await fs.rm(cloneBase, { recursive: true, force: true });
			await cleanup();
		}
	});

	it('listCheckpoints returns empty array on empty metadata branch', async () => {
		await ensureMetadataBranch(env.dir);
		expect(await listCheckpoints(env.dir)).toEqual([]);
	});

	it('decodeCheckpointInfo parses snake_case JSON (Go-compat)', () => {
		const raw = enc(
			'{"checkpoint_id":"a3b2c4d5e6f7","session_id":"s1","created_at":"2026-01-01T00:00:00Z","checkpoints_count":3,"files_touched":["a.ts","b.ts"]}',
		);
		const info = decodeCheckpointInfo(raw);
		expect(info.checkpointId).toBe('a3b2c4d5e6f7');
		expect(info.sessionId).toBe('s1');
		expect(info.checkpointsCount).toBe(3);
		expect(info.filesTouched).toEqual(['a.ts', 'b.ts']);
	});

	it('decodeCheckpointInfo parses legacy camelCase JSON', () => {
		const raw = enc(
			'{"checkpointId":"abc","sessionId":"s","createdAt":"2026-01-01T00:00:00Z","checkpointsCount":0,"filesTouched":[]}',
		);
		const info = decodeCheckpointInfo(raw);
		expect(info.checkpointId).toBe('abc');
		expect(info.sessionId).toBe('s');
		expect(info.checkpointsCount).toBe(0);
	});

	it('decodeCheckpointInfo reads optional agent / isTask / sessionCount / sessionIds', () => {
		const raw = enc(
			'{"checkpoint_id":"a","session_id":"s","created_at":"2026-01-01T00:00:00Z","checkpoints_count":1,"files_touched":[],"agent":"Claude Code","is_task":true,"tool_use_id":"tu_1","session_count":2,"session_ids":["s","other"]}',
		);
		const info = decodeCheckpointInfo(raw);
		expect(info.agent).toBe('Claude Code');
		expect(info.isTask).toBe(true);
		expect(info.toolUseId).toBe('tu_1');
		expect(info.sessionCount).toBe(2);
		expect(info.sessionIds).toEqual(['s', 'other']);
	});
});

/**
 * `readCheckpointMetadata` / `readCheckpointMetadataFromSubtree` — Go
 * `common.go:493-608`. Tree-based readers that walk a `CheckpointSummary`
 * blob's session entries to build a complete `CheckpointInfo` (in contrast
 * to `decodeCheckpointInfo(blob)` which only handles the inline-legacy form).
 */
describe('strategy/metadata-branch — readCheckpointMetadata / FromSubtree', () => {
	let env: TestEnv;
	beforeEach(async () => {
		env = await TestEnv.create();
	});
	afterEach(async () => {
		await env.cleanup();
	});

	/**
	 * Build a tree containing summary + per-session metadata blobs that match
	 * Go `CheckpointSummary` shape (sessions[].metadata uses absolute "/<path>"
	 * form so normalizeSessionPath strips the leading "/").
	 */
	async function buildSummaryTree(opts: {
		checkpointId: string;
		sessions: Array<{ sessionId: string; agent?: string; createdAt?: string }>;
	}): Promise<{ rootTree: string; cpPath: string }> {
		const { MODE_DIR, MODE_FILE } = await import('@/checkpoint/tree-ops');
		type TreeEntry = { mode: string; path: string; oid: string; type: 'blob' | 'tree' };

		const cpPath = `${opts.checkpointId.slice(0, 2)}/${opts.checkpointId.slice(2)}`;
		const sessionsArray: { metadata: string }[] = [];
		const cpEntries: TreeEntry[] = [];

		for (let i = 0; i < opts.sessions.length; i++) {
			const sess = opts.sessions[i];
			// `noUncheckedIndexedAccess` requires the explicit guard.
			if (!sess) {
				continue;
			}
			const sessionMetaJson = JSON.stringify({
				session_id: sess.sessionId,
				agent: sess.agent,
				created_at: sess.createdAt ?? '2026-01-01T00:00:00Z',
			});
			const sessionBlob = await env.writeBlob(sessionMetaJson);
			const sessionTree = await env.writeTree([
				{ mode: MODE_FILE, path: 'metadata.json', oid: sessionBlob, type: 'blob' },
			]);
			cpEntries.push({ mode: MODE_DIR, path: String(i), oid: sessionTree, type: 'tree' });
			sessionsArray.push({ metadata: `/${cpPath}/${i}/metadata.json` });
		}

		const summaryBlob = await env.writeBlob(
			JSON.stringify({
				checkpoint_id: opts.checkpointId,
				sessions: sessionsArray,
				files_touched: ['src/foo.ts'],
				checkpoints_count: opts.sessions.length,
			}),
		);
		cpEntries.push({ mode: MODE_FILE, path: 'metadata.json', oid: summaryBlob, type: 'blob' });

		const cpInner = await env.writeTree(cpEntries);
		const bbTree = await env.writeTree([
			{
				mode: MODE_DIR,
				path: opts.checkpointId.slice(2),
				oid: cpInner,
				type: 'tree',
			},
		]);
		const rootTree = await env.writeTree([
			{ mode: MODE_DIR, path: opts.checkpointId.slice(0, 2), oid: bbTree, type: 'tree' },
		]);
		return { rootTree, cpPath };
	}

	it('readCheckpointMetadata reads summary + walks first session for representative fields', async () => {
		const { readCheckpointMetadata } = await import('@/strategy/metadata-branch');
		const { rootTree, cpPath } = await buildSummaryTree({
			checkpointId: 'a3b2c4d5e6f7',
			sessions: [
				{ sessionId: 'sess-1', agent: 'Claude Code', createdAt: '2026-01-01T00:00:00Z' },
				{ sessionId: 'sess-2', agent: 'Claude Code', createdAt: '2026-01-02T00:00:00Z' },
			],
		});
		const info = await readCheckpointMetadata(env.dir, rootTree, cpPath);
		expect(info).not.toBeNull();
		expect(info?.checkpointId).toBe('a3b2c4d5e6f7');
		expect(info?.sessionId).toBe('sess-1');
		expect(info?.agent).toBe('Claude Code');
		expect(info?.sessionIds).toEqual(['sess-1', 'sess-2']);
		expect(info?.sessionCount).toBe(2);
		expect(info?.filesTouched).toEqual(['src/foo.ts']);
	});

	it('readCheckpointMetadata returns null when checkpointPath missing', async () => {
		const { readCheckpointMetadata } = await import('@/strategy/metadata-branch');
		const empty = await env.writeTree([]);
		expect(await readCheckpointMetadata(env.dir, empty, 'zz/missing')).toBeNull();
	});

	it('readCheckpointMetadataFromSubtree reads from a checkpoint subtree directly', async () => {
		const { readCheckpointMetadataFromSubtree } = await import('@/strategy/metadata-branch');
		const { rootTree, cpPath } = await buildSummaryTree({
			checkpointId: 'a3b2c4d5e6f7',
			sessions: [{ sessionId: 'sess-1', agent: 'Cursor' }],
		});
		// Walk down to the checkpoint subtree (a3 / b2c4d5e6f7)
		const fsCb = await import('node:fs');
		const git = (await import('isomorphic-git')).default;
		const aaTree = await git.readTree({ fs: fsCb.default, dir: env.dir, oid: rootTree });
		const aaEntry = aaTree.tree.find((e) => e.path === cpPath.slice(0, 2));
		const bbTree = await git.readTree({ fs: fsCb.default, dir: env.dir, oid: aaEntry?.oid ?? '' });
		const bbEntry = bbTree.tree.find((e) => e.path === cpPath.slice(3));
		const subtreeHash = bbEntry?.oid ?? '';

		const info = await readCheckpointMetadataFromSubtree(env.dir, subtreeHash, cpPath);
		expect(info).not.toBeNull();
		expect(info?.checkpointId).toBe('a3b2c4d5e6f7');
		expect(info?.agent).toBe('Cursor');
	});
});
