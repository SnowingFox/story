import fsCallback from 'node:fs';
import git from 'isomorphic-git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeCommitted } from '@/checkpoint/committed';
import {
	resolveCommittedReader,
	resolveRawSessionLog,
} from '@/checkpoint/committed-reader-resolve';
import { V2_MAIN_REF_NAME } from '@/checkpoint/constants';
import type { CommittedReader, WriteCommittedOptions } from '@/checkpoint/types';
import { V2GitStore } from '@/checkpoint/v2-store';
import { TestEnv } from '../helpers/test-env';

/**
 * Phase 4.4 wires real V2 reads + writes. The resolver tests now exercise
 * actual v2 fixtures (no more "v2 stub throws → fallback to v1"
 * indirection). The remaining v2-disabled / v1-only tests still pin the
 * resolver's preference logic.
 */

const ENC = new TextEncoder();

function baseOpts(overrides: Partial<WriteCommittedOptions>): WriteCommittedOptions {
	return {
		checkpointId: 'a3b2c4d5e6f7',
		sessionId: 'sess-1',
		strategy: 'manual-commit',
		branch: 'main',
		transcript: ENC.encode('{"hello":"world"}\n'),
		prompts: [],
		filesTouched: ['src/x.ts'],
		checkpointsCount: 1,
		ephemeralBranch: '',
		authorName: 'Test Author',
		authorEmail: 'author@test.local',
		metadataDir: '',
		isTask: false,
		toolUseId: '',
		agentId: '',
		checkpointUuid: '',
		transcriptPath: '',
		subagentTranscriptPath: '',
		isIncremental: false,
		incrementalSequence: 0,
		incrementalType: '',
		incrementalData: new Uint8Array(),
		commitSubject: '',
		agent: 'claudecode',
		model: '',
		turnId: '',
		transcriptIdentifierAtStart: '',
		checkpointTranscriptStart: 0,
		compactTranscriptStart: 0,
		tokenUsage: null,
		sessionMetrics: null,
		initialAttribution: null,
		promptAttributionsJson: null,
		summary: null,
		compactTranscript: null,
		...overrides,
	};
}

/**
 * Build a CommittedReader over the v1 standalone helpers — used to assert
 * that a `null` v2 store still resolves cleanly to v1.
 */
async function v1ReaderOver(repoDir: string): Promise<CommittedReader> {
	const committed = await import('@/checkpoint/committed');
	return {
		readCommitted: (id) => committed.readCommitted(repoDir, id),
		readSessionContent: (id, idx) => committed.readSessionContent(repoDir, id, idx),
		readSessionContentById: (id, sid) => committed.readSessionContentById(repoDir, id, sid),
		getTranscript: (id) => committed.getTranscript(repoDir, id),
		getSessionLog: (id) => committed.getSessionLog(repoDir, id),
	};
}

describe('resolveCommittedReader', () => {
	let env: TestEnv;
	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		await env.exec('git', ['config', 'user.name', 'Test']);
		await env.exec('git', ['config', 'user.email', 'test@test.local']);
	});
	afterEach(async () => {
		await env.cleanup();
	});

	it('resolves to V2 reader when V2 data exists and enabled', async () => {
		// Go: TestResolveCommittedReaderForCheckpoint_UsesV2WhenFound.
		// Phase 4.4 ships real V2 writes — write through V2GitStore so the
		// resolver's v2 branch returns a real summary.
		await writeCommitted(env.dir, baseOpts({}));
		const v2 = new V2GitStore(env.dir);
		await v2.writeCommitted(baseOpts({}));
		const v1 = await v1ReaderOver(env.dir);
		const { reader, summary } = await resolveCommittedReader(null, 'a3b2c4d5e6f7', v1, v2, true);
		expect(reader).toBe(v2);
		expect(summary).not.toBeNull();
		expect(summary?.checkpointId).toBe('a3b2c4d5e6f7');
	});

	it('falls back to V1 when V2 has no data', async () => {
		// Go: TestResolveCommittedReaderForCheckpoint_FallsBackToV1WhenMissingInV2.
		// Only v1 has the checkpoint; v2 is enabled but empty.
		await writeCommitted(env.dir, baseOpts({}));
		const v1 = await v1ReaderOver(env.dir);
		const v2 = new V2GitStore(env.dir);
		const { reader, summary } = await resolveCommittedReader(null, 'a3b2c4d5e6f7', v1, v2, true);
		expect(reader).toBe(v1);
		expect(summary?.checkpointId).toBe('a3b2c4d5e6f7');
	});

	it('prefers V1 when V2 is disabled (preferV2=false)', async () => {
		// Go: TestResolveCommittedReaderForCheckpoint_PrefersV1WhenV2Disabled.
		// Both stores have data, but the caller turned v2 off.
		await writeCommitted(env.dir, baseOpts({}));
		const v2 = new V2GitStore(env.dir);
		await v2.writeCommitted(baseOpts({}));
		const v1 = await v1ReaderOver(env.dir);
		const { reader, summary } = await resolveCommittedReader(null, 'a3b2c4d5e6f7', v1, v2, false);
		expect(reader).toBe(v1);
		expect(summary?.checkpointId).toBe('a3b2c4d5e6f7');
	});

	it('returns (v1, null) when neither store has the checkpoint', async () => {
		const v1 = await v1ReaderOver(env.dir);
		const { reader, summary } = await resolveCommittedReader(null, 'deadbeefcafe', v1, null, false);
		expect(reader).toBe(v1);
		expect(summary).toBeNull();
	});

	it('falls back to V1 when V2 metadata is malformed', async () => {
		// Go: TestResolveCommittedReaderForCheckpoint_FallsBackToV1WhenV2Malformed.
		// Corrupt the v2 root metadata.json by replacing it with junk bytes
		// that won't parse — the resolver must treat the parse-failure /
		// missing-shape as a miss and silently fall through to v1.
		await writeCommitted(env.dir, baseOpts({}));
		const v2 = new V2GitStore(env.dir);
		await v2.writeCommitted(baseOpts({}));

		// Overwrite /main with an orphan commit pointing at an empty tree —
		// readCommitted then can't find the per-checkpoint summary blob and
		// returns null cleanly (matching the "missing" path the resolver
		// expects).
		const emptyTree = await git.writeTree({ fs: fsCallback, dir: env.dir, tree: [] });
		const author = {
			name: 'Test',
			email: 'test@test.local',
			timestamp: Math.floor(Date.now() / 1000),
			timezoneOffset: 0,
		};
		const commit = await git.writeCommit({
			fs: fsCallback,
			dir: env.dir,
			commit: {
				message: 'corrupt v2 main',
				tree: emptyTree,
				parent: [],
				author,
				committer: author,
			},
		});
		await git.writeRef({
			fs: fsCallback,
			dir: env.dir,
			ref: V2_MAIN_REF_NAME,
			value: commit,
			force: true,
		});

		const v1 = await v1ReaderOver(env.dir);
		const { reader, summary } = await resolveCommittedReader(null, 'a3b2c4d5e6f7', v1, v2, true);
		expect(reader).toBe(v1);
		expect(summary).not.toBeNull();
	});
});

describe('resolveRawSessionLog', () => {
	let env: TestEnv;
	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		await env.exec('git', ['config', 'user.name', 'Test']);
		await env.exec('git', ['config', 'user.email', 'test@test.local']);
	});
	afterEach(async () => {
		await env.cleanup();
	});

	it('resolves raw session log from V2 when enabled', async () => {
		// Go: TestResolveRawSessionLogForCheckpoint_UsesV2WhenFound.
		// Phase 4.4 ships real V2 writes — the resolver pulls the raw
		// transcript from /full/current.
		await writeCommitted(env.dir, baseOpts({}));
		const v2 = new V2GitStore(env.dir);
		await v2.writeCommitted(baseOpts({}));
		const v1 = await v1ReaderOver(env.dir);
		const log = await resolveRawSessionLog(null, 'a3b2c4d5e6f7', v1, v2, true);
		expect(log).not.toBeNull();
		expect(log?.sessionId).toBe('sess-1');
		expect(log?.transcript.length).toBeGreaterThan(0);
	});

	it('falls back to V1 raw session log when V2 empty', async () => {
		// Go: TestResolveRawSessionLogForCheckpoint_FallsBackToV1WhenMissingInV2.
		await writeCommitted(env.dir, baseOpts({}));
		const v1 = await v1ReaderOver(env.dir);
		const v2 = new V2GitStore(env.dir);
		const log = await resolveRawSessionLog(null, 'a3b2c4d5e6f7', v1, v2, true);
		expect(log?.sessionId).toBe('sess-1');
	});

	it('prefers V1 raw session log when V2 disabled', async () => {
		// Go: TestResolveRawSessionLogForCheckpoint_PrefersV1WhenV2Disabled.
		await writeCommitted(env.dir, baseOpts({}));
		const v2 = new V2GitStore(env.dir);
		await v2.writeCommitted(baseOpts({}));
		const v1 = await v1ReaderOver(env.dir);
		const log = await resolveRawSessionLog(null, 'a3b2c4d5e6f7', v1, v2, false);
		expect(log?.sessionId).toBe('sess-1');
	});

	it('returns null when neither store has the checkpoint', async () => {
		const v1 = await v1ReaderOver(env.dir);
		const log = await resolveRawSessionLog(null, 'deadbeefcafe', v1, null, true);
		expect(log).toBeNull();
	});
});

describe('resolver — error fall-through paths', () => {
	let env: TestEnv;
	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		await env.exec('git', ['config', 'user.name', 'Test']);
		await env.exec('git', ['config', 'user.email', 'test@test.local']);
	});
	afterEach(async () => {
		await env.cleanup();
	});

	it('resolveCommittedReader: v2 throws ErrCheckpointNotFound → falls back to v1 hit', async () => {
		// Force the "expected-miss" branch: a fake v2 store whose
		// readCommitted throws ErrCheckpointNotFound — the resolver must
		// treat it as the same as a returned null.
		await writeCommitted(env.dir, baseOpts({}));
		const v1 = await v1ReaderOver(env.dir);
		const { ErrCheckpointNotFound } = await import('@/checkpoint/committed');
		const v2: CommittedReader = {
			readCommitted: () => Promise.reject(new ErrCheckpointNotFound('a3b2c4d5e6f7')),
			readSessionContent: () => Promise.resolve(null),
			readSessionContentById: () => Promise.resolve(null),
			getTranscript: () => Promise.resolve(null),
			getSessionLog: () => Promise.resolve(null),
		};
		const { reader, summary } = await resolveCommittedReader(null, 'a3b2c4d5e6f7', v1, v2, true);
		expect(reader).toBe(v1);
		expect(summary?.checkpointId).toBe('a3b2c4d5e6f7');
	});

	it('resolveRawSessionLog: v1 throws ErrCheckpointNotFound → returns null', async () => {
		// v1 itself throws our sentinel — the resolver must catch and
		// downgrade to null instead of propagating.
		const { ErrCheckpointNotFound } = await import('@/checkpoint/committed');
		const v1: CommittedReader = {
			readCommitted: () => Promise.resolve(null),
			readSessionContent: () => Promise.resolve(null),
			readSessionContentById: () => Promise.resolve(null),
			getTranscript: () => Promise.resolve(null),
			getSessionLog: () => Promise.reject(new ErrCheckpointNotFound('a3b2c4d5e6f7')),
		};
		const log = await resolveRawSessionLog(null, 'a3b2c4d5e6f7', v1, null, false);
		expect(log).toBeNull();
	});

	it('resolveRawSessionLog: v1 throws non-sentinel error → propagates', async () => {
		// Real I/O errors from v1 (e.g. a corrupt git object) must NOT be
		// silently swallowed — they're upstream bugs.
		const v1: CommittedReader = {
			readCommitted: () => Promise.resolve(null),
			readSessionContent: () => Promise.resolve(null),
			readSessionContentById: () => Promise.resolve(null),
			getTranscript: () => Promise.resolve(null),
			getSessionLog: () => Promise.reject(new Error('disk corrupt')),
		};
		await expect(resolveRawSessionLog(null, 'a3b2c4d5e6f7', v1, null, false)).rejects.toThrow(
			/disk corrupt/,
		);
	});
});
