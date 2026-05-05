/**
 * Unit tests for `tests/e2e/helpers/assertions.ts`. Validates the logic
 * of the helper functions via mocked `execa` — no real git spawn.
 *
 * Coverage targets:
 *  - Pure helpers (`assertCheckpointIdFormat`) — 1 case
 *  - Trailer helpers (`getCheckpointTrailer` uses `Story-Checkpoint` key;
 *    `assertNoCheckpointTrailer` rejects when present) — 3 cases
 *  - Shadow-branch filter excludes `story/checkpoints/*` — 2 cases
 *  - Poll-based waits resolve on state change — 2 cases
 *  - `assertCheckpointInLastN` counts commits — 2 cases
 *
 * These test the **logic** of each helper, including the naming red
 * line (trailer key, branch prefix, etc.). Real git behaviour is
 * covered by the e2e scenarios themselves.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	assertCheckpointIdFormat,
	assertCheckpointInLastN,
	assertHasCheckpointTrailer,
	assertNoCheckpointTrailer,
	getCheckpointTrailer,
	waitForCheckpointAdvanceFrom,
	waitForNoShadowBranches,
} from './assertions';

vi.mock('execa', () => ({ execa: vi.fn() }));

describe('assertCheckpointIdFormat', () => {
	// Go: testutil/assertions.go:28-30 hexIDPattern
	it('passes for 12 lowercase hex chars; fails otherwise', () => {
		expect(() => assertCheckpointIdFormat('abcdef123456')).not.toThrow();
		expect(() => assertCheckpointIdFormat('ABCDEF123456')).toThrow();
		expect(() => assertCheckpointIdFormat('short')).toThrow();
		expect(() => assertCheckpointIdFormat('abcdef123456789')).toThrow();
	});
});

describe('trailer helpers (naming red line: Story-Checkpoint)', () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	// Naming red line: Go uses --format=%(trailers:key=Entire-Checkpoint,...);
	// TS must use Story-Checkpoint.
	it('getCheckpointTrailer calls git log with Story-Checkpoint trailer key', async () => {
		const execaModule = await import('execa');
		const execaMock = vi.mocked(execaModule.execa) as unknown as ReturnType<typeof vi.fn>;
		execaMock.mockResolvedValueOnce({ stdout: 'abcdef123456\n' } as never);
		const trailer = await getCheckpointTrailer('/tmp/repo', 'HEAD');
		expect(trailer).toBe('abcdef123456');
		expect(execaMock).toHaveBeenCalledWith(
			'git',
			['log', '-1', '--format=%(trailers:key=Story-Checkpoint,valueonly)', 'HEAD'],
			expect.objectContaining({ cwd: '/tmp/repo' }),
		);
	});

	// Go: testutil/assertions.go:336-341 AssertNoCheckpointTrailer
	it('assertNoCheckpointTrailer passes when trailer is empty, fails when present', async () => {
		const execaModule = await import('execa');
		const execaMock = vi.mocked(execaModule.execa) as unknown as ReturnType<typeof vi.fn>;
		execaMock.mockResolvedValueOnce({ stdout: '' } as never);
		await expect(assertNoCheckpointTrailer('/tmp/repo', 'HEAD')).resolves.toBeUndefined();

		execaMock.mockResolvedValueOnce({ stdout: 'abcdef123456' } as never);
		await expect(assertNoCheckpointTrailer('/tmp/repo', 'HEAD')).rejects.toThrow(
			/expected no Story-Checkpoint trailer/,
		);
	});

	// Go: testutil/assertions.go:187-195 AssertHasCheckpointTrailer
	it('assertHasCheckpointTrailer passes for 12-hex, fails for invalid format', async () => {
		const execaModule = await import('execa');
		const execaMock = vi.mocked(execaModule.execa) as unknown as ReturnType<typeof vi.fn>;
		execaMock.mockResolvedValueOnce({ stdout: 'abcdef123456\n' } as never);
		await expect(assertHasCheckpointTrailer('/tmp/repo', 'HEAD')).resolves.toBe('abcdef123456');

		execaMock.mockResolvedValueOnce({ stdout: 'not-hex' } as never);
		await expect(assertHasCheckpointTrailer('/tmp/repo', 'HEAD')).rejects.toThrow();
	});
});

describe('waitForNoShadowBranches — filter excludes story/checkpoints/*', () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	// Go: testutil/assertions.go:123-135 shadowBranches filter
	it('treats "story/checkpoints/v1" as NOT a shadow branch', async () => {
		const execaModule = await import('execa');
		const execaMock = vi.mocked(execaModule.execa) as unknown as ReturnType<typeof vi.fn>;
		// Only a metadata branch is present — should immediately succeed.
		execaMock.mockResolvedValueOnce({ stdout: 'story/checkpoints/v1' } as never);
		await expect(waitForNoShadowBranches('/tmp/repo', 1_000)).resolves.toBeUndefined();
	});

	it('fails (timeout) when a real shadow branch is still present', async () => {
		const execaModule = await import('execa');
		const execaMock = vi.mocked(execaModule.execa) as unknown as ReturnType<typeof vi.fn>;
		// Mock returns the same shadow branch forever — helper should time out.
		execaMock.mockResolvedValue({
			stdout: 'story/shadow/abc1234-e3b0c4',
		} as never);
		await expect(waitForNoShadowBranches('/tmp/repo', 500)).rejects.toThrow(
			/shadow branches should be cleaned up/,
		);
	});
});

describe('waitForCheckpointAdvanceFrom — resolves on ref change', () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	// Go: testutil/assertions.go:278-291 WaitForCheckpointAdvanceFrom
	it('returns when the branch has moved past the given ref', async () => {
		const execaModule = await import('execa');
		const execaMock = vi.mocked(execaModule.execa) as unknown as ReturnType<typeof vi.fn>;
		// Returns fromRef once, then an advanced ref.
		execaMock.mockResolvedValueOnce({ stdout: 'aaaaaaaa' } as never);
		execaMock.mockResolvedValueOnce({ stdout: 'bbbbbbbb' } as never);
		await expect(
			waitForCheckpointAdvanceFrom('/tmp/repo', 'aaaaaaaa', 2_000),
		).resolves.toBeUndefined();
	});

	it('times out when branch does not advance', async () => {
		const execaModule = await import('execa');
		const execaMock = vi.mocked(execaModule.execa) as unknown as ReturnType<typeof vi.fn>;
		execaMock.mockResolvedValue({ stdout: 'aaaaaaaa' } as never);
		await expect(waitForCheckpointAdvanceFrom('/tmp/repo', 'aaaaaaaa', 500)).rejects.toThrow(
			/checkpoint branch did not advance/,
		);
	});
});

describe('assertCheckpointInLastN', () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	// Go: testutil/assertions.go:201-213 AssertCheckpointInLastN
	it('passes when ≥ N commits match the checkpoint ID', async () => {
		const execaModule = await import('execa');
		const execaMock = vi.mocked(execaModule.execa) as unknown as ReturnType<typeof vi.fn>;
		execaMock.mockResolvedValueOnce({
			stdout: 'save step abc\ncondense abc\n',
		} as never);
		await expect(assertCheckpointInLastN('/tmp/repo', 'abc', 2)).resolves.toBeUndefined();
	});

	it('fails when fewer commits match', async () => {
		const execaModule = await import('execa');
		const execaMock = vi.mocked(execaModule.execa) as unknown as ReturnType<typeof vi.fn>;
		execaMock.mockResolvedValueOnce({ stdout: 'save step abc' } as never);
		await expect(assertCheckpointInLastN('/tmp/repo', 'abc', 2)).rejects.toThrow(
			/expected at least 2 commits/,
		);
	});
});
