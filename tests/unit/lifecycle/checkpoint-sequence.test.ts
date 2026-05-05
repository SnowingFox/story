/**
 * Phase 7 Part 1 `src/lifecycle/checkpoint-sequence.ts` — 5 case.
 *
 * Go 参考：`cmd/entire/cli/state.go: GetNextCheckpointSequence`（Go 无直接
 * unit test；tests.md 定义 5 个 TS-side scenarios mirror the Go algorithm and
 * its fail-safe branch.）
 */

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getNextCheckpointSequence } from '@/lifecycle/checkpoint-sequence';
import { clearWorktreeRootCache, storyMetadataDirForSession } from '@/paths';
import { taskMetadataDir } from '@/strategy/constants';
import { TestEnv } from '../../helpers/test-env';

async function checkpointsDir(
	env: TestEnv,
	sessionID: string,
	taskToolUseID: string,
): Promise<string> {
	const sessionDir = storyMetadataDirForSession(sessionID);
	return path.join(env.dir, taskMetadataDir(sessionDir, taskToolUseID), 'checkpoints');
}

describe('lifecycle/checkpoint-sequence', () => {
	let env: TestEnv;

	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		clearWorktreeRootCache();
		const paths = await import('@/paths');
		vi.spyOn(paths, 'worktreeRoot').mockResolvedValue(env.dir);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		clearWorktreeRootCache();
		await env.cleanup();
	});

	// Go: state.go: GetNextCheckpointSequence (missing dir branch)
	it('returns 1 when checkpoints dir missing', async () => {
		expect(await getNextCheckpointSequence('sid', 'toolu')).toBe(1);
	});

	// Go: state.go: GetNextCheckpointSequence (empty dir branch)
	it('returns 1 when checkpoints dir empty', async () => {
		await mkdir(await checkpointsDir(env, 'sid', 'toolu'), { recursive: true });
		expect(await getNextCheckpointSequence('sid', 'toolu')).toBe(1);
	});

	// Go: state.go: GetNextCheckpointSequence (max+1 computation)
	it('returns max + 1 when checkpoint files exist', async () => {
		const dir = await checkpointsDir(env, 'sid', 'toolu');
		await mkdir(dir, { recursive: true });
		await writeFile(path.join(dir, '001-a.json'), '{}');
		await writeFile(path.join(dir, '003-c.json'), '{}');
		await writeFile(path.join(dir, '002-b.json'), '{}');
		expect(await getNextCheckpointSequence('sid', 'toolu')).toBe(4);
	});

	// Go: state.go: GetNextCheckpointSequence (SEQUENCE_PATTERN filter)
	it('ignores non-matching filenames', async () => {
		const dir = await checkpointsDir(env, 'sid', 'toolu');
		await mkdir(dir, { recursive: true });
		await writeFile(path.join(dir, '001-a.json'), '{}');
		await writeFile(path.join(dir, 'foo.json'), '{}');
		await writeFile(path.join(dir, 'abc-x.json'), '{}');
		expect(await getNextCheckpointSequence('sid', 'toolu')).toBe(2);
	});

	// Go: state.go: GetNextCheckpointSequence (fail-safe on read error)
	it('fail-safe: returns 1 on worktreeRoot failure', async () => {
		const paths = await import('@/paths');
		vi.spyOn(paths, 'worktreeRoot').mockRejectedValue(new Error('no repo'));

		const prev = process.cwd();
		const tmpCwd = await mkdtemp(path.join(os.tmpdir(), 'story-ckptseq-'));
		process.chdir(tmpCwd);
		try {
			expect(await getNextCheckpointSequence('sid', 'toolu')).toBe(1);
		} finally {
			process.chdir(prev);
		}
	});
});
