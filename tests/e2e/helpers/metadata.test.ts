/**
 * Unit tests for `tests/e2e/helpers/metadata.ts`. Covers the pure helper
 * `checkpointPath` (sharding) + git-show wrappers via execa mocks.
 *
 * No real git spawns — every check mocks `execa` so these tests stay in
 * the `unit` project.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	checkpointPath,
	listCheckpointIds,
	readCheckpointMetadata,
	readSessionMetadata,
	waitForSessionMetadata,
} from './metadata';

vi.mock('execa', () => ({ execa: vi.fn() }));

describe('metadata.checkpointPath', () => {
	// Go: testutil/metadata.go:58-60 CheckpointPath
	it('shards 12-hex ID into {prefix}/{rest}', () => {
		expect(checkpointPath('ab12cdef3456')).toBe('ab/12cdef3456');
	});

	// Go-parity: `id[:2] + "/" + id[2:]` always — no defensive branch.
	it('short IDs produce Go-shape strings with trailing empty tail', () => {
		expect(checkpointPath('ab')).toBe('ab/');
		expect(checkpointPath('a')).toBe('a/');
		expect(checkpointPath('')).toBe('/');
	});
});

describe('metadata readers (mocked execa)', () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	// Go: testutil/repo.go:616-632 ReadCheckpointMetadata
	it('readCheckpointMetadata parses JSON from git show output', async () => {
		const execaModule = await import('execa');
		const execaMock = vi.mocked(execaModule.execa) as unknown as ReturnType<typeof vi.fn>;
		const meta = {
			cli_version: '0.1.0',
			checkpoint_id: 'ab12cdef3456',
			strategy: 'manual-commit',
			branch: 'master',
			checkpoints_count: 1,
			files_touched: ['foo.md'],
			sessions: [],
			token_usage: {
				input_tokens: 0,
				cache_creation_tokens: 0,
				cache_read_tokens: 0,
				output_tokens: 0,
				api_call_count: 0,
			},
		};
		execaMock.mockResolvedValueOnce({ stdout: JSON.stringify(meta) } as never);
		const result = await readCheckpointMetadata('/tmp/repo', 'ab12cdef3456');
		expect(result).toEqual(meta);
		expect(execaMock).toHaveBeenCalledWith(
			'git',
			['show', 'story/checkpoints/v1:ab/12cdef3456/metadata.json'],
			expect.objectContaining({ cwd: '/tmp/repo' }),
		);
	});

	// Go: testutil/repo.go:634-650 ReadSessionMetadata
	it('readSessionMetadata targets <sharded>/<index>/metadata.json', async () => {
		const execaModule = await import('execa');
		const execaMock = vi.mocked(execaModule.execa) as unknown as ReturnType<typeof vi.fn>;
		execaMock.mockResolvedValueOnce({
			stdout: '{"session_id":"s1","checkpoint_id":"abc","agent":"vogon"}',
		} as never);
		const result = await readSessionMetadata('/tmp/repo', 'ab12cdef3456', 2);
		expect(result.session_id).toBe('s1');
		expect(execaMock).toHaveBeenCalledWith(
			'git',
			['show', 'story/checkpoints/v1:ab/12cdef3456/2/metadata.json'],
			expect.objectContaining({ cwd: '/tmp/repo' }),
		);
	});

	// Go: testutil/repo.go:656-676 WaitForSessionMetadata — tolerates late arrival
	it('waitForSessionMetadata polls on ENOENT/failure and resolves when blob arrives', async () => {
		const execaModule = await import('execa');
		const execaMock = vi.mocked(execaModule.execa) as unknown as ReturnType<typeof vi.fn>;
		execaMock.mockRejectedValueOnce(new Error('unknown ref'));
		execaMock.mockRejectedValueOnce(new Error('unknown ref'));
		execaMock.mockResolvedValueOnce({
			stdout: '{"session_id":"s2","checkpoint_id":"abc"}',
		} as never);
		const result = await waitForSessionMetadata('/tmp/repo', 'ab12cdef3456', 0, 3_000);
		expect(result.session_id).toBe('s2');
	});

	// Go: testutil/repo.go:593-614 CheckpointIDs — sharded layout dedup
	it('listCheckpointIds parses two-level sharded layout and dedups', async () => {
		const execaModule = await import('execa');
		const execaMock = vi.mocked(execaModule.execa) as unknown as ReturnType<typeof vi.fn>;
		execaMock.mockResolvedValueOnce({
			stdout: [
				'ab/12cdef3456/metadata.json',
				'ab/12cdef3456/0/metadata.json',
				'ab/12cdef3456/0/full.jsonl',
				'cd/56789abcdef0/metadata.json',
			].join('\n'),
		} as never);
		const ids = await listCheckpointIds('/tmp/repo');
		expect(ids).toEqual(['ab12cdef3456', 'cd56789abcdef0']);
	});

	it('listCheckpointIds returns [] when ls-tree fails or branch missing', async () => {
		const execaModule = await import('execa');
		const execaMock = vi.mocked(execaModule.execa) as unknown as ReturnType<typeof vi.fn>;
		execaMock.mockRejectedValueOnce(new Error('unknown ref story/checkpoints/v1'));
		const ids = await listCheckpointIds('/tmp/repo');
		expect(ids).toEqual([]);
	});
});
