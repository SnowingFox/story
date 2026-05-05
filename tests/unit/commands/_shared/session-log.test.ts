/**
 * `src/commands/_shared/session-log.ts` — port of
 * `strategy/manual_commit_logs.go` (165 lines). Four helpers surfaced to
 * `story explain` / `story resume` / `story attach`:
 *
 *   - `getSessionInfo(cwd?)`            — HEAD trailers + state merge
 *   - `getSessionLog(repo, ckptId)`     — v1/v2 fallback via resolveCommittedReader
 *   - `getTaskCheckpoint(repo, pt)`     — wraps getTaskCheckpointFromTree
 *   - `getTaskCheckpointTranscript`     — wraps getTaskTranscriptFromTree
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	getSessionInfo,
	getSessionLog,
	getTaskCheckpoint,
	getTaskCheckpointTranscript,
} from '@/commands/_shared/session-log';
import { ErrNoSession } from '@/strategy/errors';
import type { RewindPoint } from '@/strategy/types';
import { TestEnv } from '../../../helpers/test-env';

const readLatestSessionContentMock = vi.hoisted(() =>
	vi.fn(async (_repo: string, _cpId: string) => null as unknown),
);
const getTaskCheckpointFromTreeMock = vi.hoisted(() =>
	vi.fn(async (_repo: string, _tree: string, _dir: string) => null as unknown),
);
const getTaskTranscriptFromTreeMock = vi.hoisted(() =>
	vi.fn(async (_repo: string, _tree: string, _dir: string) => null as unknown),
);

vi.mock('@/checkpoint/committed', async (orig) => {
	const mod = (await orig()) as Record<string, unknown>;
	return { ...mod, readLatestSessionContent: readLatestSessionContentMock };
});

vi.mock('@/strategy/rewind-helpers', async (orig) => {
	const mod = (await orig()) as Record<string, unknown>;
	return {
		...mod,
		getTaskCheckpointFromTree: getTaskCheckpointFromTreeMock,
		getTaskTranscriptFromTree: getTaskTranscriptFromTreeMock,
	};
});

// Stub isomorphic-git's readCommit so tests can pass synthetic commit
// hashes without needing a real git object.
vi.mock('isomorphic-git', async (orig) => {
	const mod = (await orig()) as Record<string, unknown>;
	return {
		...mod,
		default: {
			...((mod as { default?: Record<string, unknown> }).default ?? mod),
			readCommit: vi.fn(async (opts: { oid: string }) => ({
				commit: { tree: `tree-${opts.oid.slice(0, 7)}` },
			})),
			resolveRef: vi.fn(async () => 'shadow-ref-hash'),
		},
	};
});

function makePoint(overrides: Partial<RewindPoint> = {}): RewindPoint {
	return {
		id: 'a'.repeat(40),
		message: 'task checkpoint',
		metadataDir: '.story/metadata/sess-abc/tasks/tu_1',
		date: new Date(),
		isTaskCheckpoint: true,
		toolUseId: 'tu_1',
		isLogsOnly: false,
		checkpointId: '',
		agent: 'Claude Code' as unknown as RewindPoint['agent'],
		sessionId: 'sess-abc',
		sessionPrompt: '',
		sessionCount: 1,
		sessionIds: ['sess-abc'],
		sessionPrompts: [],
		...overrides,
	};
}

describe('commands/_shared/session-log — Go: strategy/manual_commit_logs.go:14-103', () => {
	let env: TestEnv;
	let origCwd: string;

	beforeEach(async () => {
		readLatestSessionContentMock.mockReset();
		getTaskCheckpointFromTreeMock.mockReset();
		getTaskTranscriptFromTreeMock.mockReset();
		env = await TestEnv.create({ initialCommit: true });
		origCwd = process.cwd();
		process.chdir(env.dir);
	});

	afterEach(async () => {
		process.chdir(origCwd);
		await env.cleanup();
	});

	// Go: manual_commit_logs.go:25-65 GetSessionInfo
	describe('getSessionInfo', () => {
		it('returns null when the repo has no sessions', async () => {
			const info = await getSessionInfo(env.dir);
			expect(info).toBeNull();
		});

		it('throws when cwd is not a git repo', async () => {
			const os = await import('node:os');
			const fs = await import('node:fs/promises');
			const path = await import('node:path');
			const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'story-notgit-'));
			try {
				await expect(getSessionInfo(tmp)).rejects.toThrow();
			} finally {
				await fs.rm(tmp, { recursive: true, force: true });
			}
		});

		it('propagates ErrNoSession when HEAD is on a shadow branch', async () => {
			// Create a branch with the shadow prefix and check it out.
			await env.exec('git', ['checkout', '-b', 'story/shadow-test']);
			await expect(getSessionInfo(env.dir)).rejects.toBe(ErrNoSession);
		});
	});

	// Go: manual_commit_logs.go:96-103 GetCheckpointLog (v1/v2 via resolve)
	describe('getSessionLog', () => {
		it('returns transcript + sessionId on v1 hit', async () => {
			readLatestSessionContentMock.mockResolvedValue({
				transcript: new TextEncoder().encode('hello transcript'),
				metadata: { sessionId: 'sess-abc' },
			});
			const result = await getSessionLog(env.dir, 'ckpt_abc12345');
			expect(result).not.toBeNull();
			expect(result?.sessionId).toBe('sess-abc');
			expect(new TextDecoder().decode(result?.transcript ?? new Uint8Array())).toBe(
				'hello transcript',
			);
		});

		it('returns null when neither v1 nor v2 has the checkpoint', async () => {
			readLatestSessionContentMock.mockResolvedValue(null);
			const result = await getSessionLog(env.dir, 'ckpt_missing');
			expect(result).toBeNull();
		});

		it('throws on corrupt metadata (propagates committed-reader error)', async () => {
			readLatestSessionContentMock.mockRejectedValue(new Error('bad metadata JSON'));
			await expect(getSessionLog(env.dir, 'ckpt_corrupt')).rejects.toThrow(/bad metadata/i);
		});

		it('empty checkpointId → null (Go: ErrNoMetadata short-circuit)', async () => {
			const result = await getSessionLog(env.dir, '');
			expect(result).toBeNull();
			expect(readLatestSessionContentMock).not.toHaveBeenCalled();
		});

		it('handles Claude-Code-style JSONL transcripts', async () => {
			const claudeLog = '{"type":"user","message":"hello"}\n{"type":"assistant","message":"hi"}\n';
			readLatestSessionContentMock.mockResolvedValue({
				transcript: new TextEncoder().encode(claudeLog),
				metadata: { sessionId: 'sess-claude' },
			});
			const result = await getSessionLog(env.dir, 'ckpt_claude');
			expect(result?.sessionId).toBe('sess-claude');
			expect(new TextDecoder().decode(result?.transcript ?? new Uint8Array())).toContain(
				'assistant',
			);
		});

		it('handles Cursor-style transcripts', async () => {
			const cursorLog = '{"role":"user","content":"question"}\n';
			readLatestSessionContentMock.mockResolvedValue({
				transcript: new TextEncoder().encode(cursorLog),
				metadata: { sessionId: 'sess-cursor' },
			});
			const result = await getSessionLog(env.dir, 'ckpt_cursor');
			expect(result?.sessionId).toBe('sess-cursor');
		});

		it('handles large transcripts (100 KB) without crashing', async () => {
			const big = 'x'.repeat(100_000);
			readLatestSessionContentMock.mockResolvedValue({
				transcript: new TextEncoder().encode(big),
				metadata: { sessionId: 'sess-big' },
			});
			const result = await getSessionLog(env.dir, 'ckpt_big');
			expect(result?.transcript.length).toBe(100_000);
		});
	});

	// Go: manual_commit_logs.go:14-22 GetTaskCheckpoint / Transcript
	describe('getTaskCheckpoint', () => {
		it('returns checkpoint payload when tree read succeeds', async () => {
			getTaskCheckpointFromTreeMock.mockResolvedValue({
				sessionId: 'sess-abc',
				toolUseId: 'tu_1',
				checkpointUuid: 'uuid-1',
			});
			const result = await getTaskCheckpoint(env.dir, makePoint());
			expect(result).not.toBeNull();
			expect(result?.sessionId).toBe('sess-abc');
		});

		it('returns null when the task tree blob is missing', async () => {
			getTaskCheckpointFromTreeMock.mockResolvedValue(null);
			const result = await getTaskCheckpoint(env.dir, makePoint());
			expect(result).toBeNull();
		});

		it('rejects non-task RewindPoint early (isTaskCheckpoint === false)', async () => {
			const pt = makePoint({ isTaskCheckpoint: false });
			await expect(getTaskCheckpoint(env.dir, pt)).rejects.toThrow(/task/i);
			expect(getTaskCheckpointFromTreeMock).not.toHaveBeenCalled();
		});

		it('returns null when readCommit itself fails (invalid commit id)', async () => {
			const git = (await import('isomorphic-git')).default;
			const spy = vi.spyOn(git, 'readCommit').mockRejectedValue(new Error('bad oid'));
			try {
				const result = await getTaskCheckpoint(env.dir, makePoint());
				expect(result).toBeNull();
			} finally {
				spy.mockRestore();
			}
		});
	});

	describe('getTaskCheckpointTranscript', () => {
		it('returns transcript bytes when tree walk succeeds', async () => {
			const bytes = new TextEncoder().encode('[task transcript]');
			getTaskTranscriptFromTreeMock.mockResolvedValue(bytes);
			const result = await getTaskCheckpointTranscript(env.dir, makePoint());
			expect(result).not.toBeNull();
			expect(new TextDecoder().decode(result!)).toBe('[task transcript]');
		});

		it('returns null when the transcript blob is missing', async () => {
			getTaskTranscriptFromTreeMock.mockResolvedValue(null);
			const result = await getTaskCheckpointTranscript(env.dir, makePoint());
			expect(result).toBeNull();
		});

		it('rejects non-task RewindPoint early', async () => {
			const pt = makePoint({ isTaskCheckpoint: false });
			await expect(getTaskCheckpointTranscript(env.dir, pt)).rejects.toThrow(/task/i);
			expect(getTaskTranscriptFromTreeMock).not.toHaveBeenCalled();
		});

		it('returns null when readCommit fails', async () => {
			const git = (await import('isomorphic-git')).default;
			const spy = vi.spyOn(git, 'readCommit').mockRejectedValue(new Error('bad oid'));
			try {
				const result = await getTaskCheckpointTranscript(env.dir, makePoint());
				expect(result).toBeNull();
			} finally {
				spy.mockRestore();
			}
		});
	});
});
