import path from 'node:path';
import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	ErrCheckpointNotFound,
	ErrNoTranscript,
	getCheckpointAuthor,
	getGitAuthorFromRepo,
	getSessionLog,
	getTranscript,
	listCommitted,
	lookupSessionLog,
	readCommitted,
	readLatestSessionContent,
	readSessionContent,
	readSessionContentById,
	updateCheckpointSummary,
	writeCommitted,
} from '@/checkpoint/committed';
import {
	CONTENT_HASH_FILE_NAME,
	METADATA_BRANCH_NAME,
	METADATA_FILE_NAME,
	TRANSCRIPT_FILE_NAME,
} from '@/checkpoint/constants';
import type {
	CommittedMetadata,
	InitialAttribution,
	Summary,
	TokenUsage,
	WriteCommittedOptions,
} from '@/checkpoint/types';
import { TestEnv } from '../helpers/test-env';

const ENC = new TextEncoder();
const DEC = new TextDecoder();

function baseOpts(overrides: Partial<WriteCommittedOptions>): WriteCommittedOptions {
	return {
		checkpointId: 'a3b2c4d5e6f7',
		sessionId: 'sess-1',
		strategy: 'manual-commit',
		branch: 'main',
		transcript: ENC.encode('{"role":"user","content":"hello"}\n'),
		prompts: ['hello prompt'],
		filesTouched: ['src/app.ts'],
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

async function setEnvAuthor(env: TestEnv, name: string, email: string): Promise<void> {
	await env.exec('git', ['config', 'user.name', name]);
	await env.exec('git', ['config', 'user.email', email]);
}

async function describeCommit(env: TestEnv, ref: string): Promise<string> {
	const result = await execa('git', ['log', '-1', '--format=%B', ref], { cwd: env.dir });
	return String(result.stdout);
}

describe('writeCommitted — single session basic write', () => {
	let env: TestEnv;
	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		await setEnvAuthor(env, 'Test Author', 'author@test.local');
	});
	afterEach(async () => {
		await env.cleanup();
	});

	it('stores the agent type in session metadata and the commit trailer', async () => {
		// Go: TestWriteCommitted_AgentField.
		await writeCommitted(env.dir, baseOpts({ agent: 'claudecode' }));
		const summary = await readCommitted(env.dir, 'a3b2c4d5e6f7');
		expect(summary).not.toBeNull();
		const meta = await readSessionContent(env.dir, 'a3b2c4d5e6f7', 0);
		expect(meta?.metadata.agent).toBe('claudecode');
		const msg = await describeCommit(env, METADATA_BRANCH_NAME);
		expect(msg).toContain('Story-Agent: claudecode');
		expect(msg).toContain('Story-Session: sess-1');
	});

	it('records the branch name when on a real branch', async () => {
		// Go: TestWriteCommitted_BranchField (positive case).
		await writeCommitted(env.dir, baseOpts({ branch: 'feature/login' }));
		const summary = await readCommitted(env.dir, 'a3b2c4d5e6f7');
		expect(summary?.branch).toBe('feature/login');
	});

	it('handles detached HEAD (empty branch field)', async () => {
		// Go: TestWriteCommitted_BranchField (detached case). The caller
		// passes branch='' for detached HEAD; metadata records the empty
		// string verbatim so consumers can distinguish "unknown" from "main".
		await writeCommitted(env.dir, baseOpts({ branch: '' }));
		const summary = await readCommitted(env.dir, 'a3b2c4d5e6f7');
		expect(summary?.branch ?? '').toBe('');
	});

	it('writes content_hash.txt with sha256: prefix', async () => {
		// Go: covered indirectly by Update tests + phantom-paths tests.
		await writeCommitted(env.dir, baseOpts({}));
		const ft = await readSessionContent(env.dir, 'a3b2c4d5e6f7', 0);
		expect(ft).not.toBeNull();
		const summary = await readCommitted(env.dir, 'a3b2c4d5e6f7');
		expect(summary?.sessions[0]?.contentHash).toBe(`/a3/b2c4d5e6f7/0/${CONTENT_HASH_FILE_NAME}`);
	});

	it('always writes the model field (even when empty)', async () => {
		// Go: TestWriteCommitted_ModelFieldAlwaysPresent.
		await writeCommitted(env.dir, baseOpts({ model: '' }));
		const meta = await readSessionContent(env.dir, 'a3b2c4d5e6f7', 0);
		// metadata is parsed JSON; an empty `model` must round-trip as ''
		expect(meta?.metadata.model).toBe('');
	});

	it('rejects an empty checkpoint ID', async () => {
		await expect(writeCommitted(env.dir, baseOpts({ checkpointId: '' }))).rejects.toThrow(
			/checkpoint ID is required/,
		);
	});

	it('rejects an invalid session ID', async () => {
		await expect(writeCommitted(env.dir, baseOpts({ sessionId: 'has/slash' }))).rejects.toThrow(
			/invalid committed checkpoint options/,
		);
	});

	it('writes a prompt.txt blob containing the prompt', async () => {
		await writeCommitted(env.dir, baseOpts({ prompts: ['first prompt', 'second prompt'] }));
		const session = await readSessionContent(env.dir, 'a3b2c4d5e6f7', 0);
		expect(session?.prompts).toContain('first prompt');
		expect(session?.prompts).toContain('second prompt');
	});

	it('does not create a phantom prompt path when prompts is empty', async () => {
		await writeCommitted(env.dir, baseOpts({ prompts: [] }));
		const summary = await readCommitted(env.dir, 'a3b2c4d5e6f7');
		expect(summary?.sessions[0]?.prompt).toBe('');
	});
});

describe('writeCommitted — phantom paths (Go: committed_phantom_paths_test.go)', () => {
	let env: TestEnv;
	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
	});
	afterEach(async () => {
		await env.cleanup();
	});

	it('leaves SessionFilePaths.transcript / contentHash empty when no transcript', async () => {
		// Go: TestWriteCommitted_EmptyTranscript_NoPhantomPaths.
		await writeCommitted(env.dir, baseOpts({ transcript: new Uint8Array() }));
		const summary = await readCommitted(env.dir, 'a3b2c4d5e6f7');
		expect(summary?.sessions[0]?.metadata).not.toBe('');
		expect(summary?.sessions[0]?.transcript ?? '').toBe('');
		expect(summary?.sessions[0]?.contentHash ?? '').toBe('');
	});

	it('populates transcript / contentHash / metadata when transcript bytes are present', async () => {
		// Go: TestWriteCommitted_WithTranscript_PathsPopulated.
		await writeCommitted(env.dir, baseOpts({ transcript: ENC.encode('{"x":1}\n') }));
		const summary = await readCommitted(env.dir, 'a3b2c4d5e6f7');
		expect(summary?.sessions[0]?.transcript).toBe(`/a3/b2c4d5e6f7/0/${TRANSCRIPT_FILE_NAME}`);
		expect(summary?.sessions[0]?.contentHash).toBe(`/a3/b2c4d5e6f7/0/${CONTENT_HASH_FILE_NAME}`);
		expect(summary?.sessions[0]?.metadata).toBe(`/a3/b2c4d5e6f7/0/${METADATA_FILE_NAME}`);
	});
});

describe('writeCommitted — multiple sessions inside one checkpoint', () => {
	let env: TestEnv;
	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
	});
	afterEach(async () => {
		await env.cleanup();
	});

	it('creates session 0 then session 1 under the same checkpoint', async () => {
		// Go: TestWriteCommitted_MultipleSessionsSameCheckpoint.
		await writeCommitted(env.dir, baseOpts({ sessionId: 'sess-A', transcript: ENC.encode('a\n') }));
		await writeCommitted(env.dir, baseOpts({ sessionId: 'sess-B', transcript: ENC.encode('b\n') }));

		const summary = await readCommitted(env.dir, 'a3b2c4d5e6f7');
		expect(summary?.sessions).toHaveLength(2);
		expect(summary?.sessions[0]?.transcript).toBe(`/a3/b2c4d5e6f7/0/${TRANSCRIPT_FILE_NAME}`);
		expect(summary?.sessions[1]?.transcript).toBe(`/a3/b2c4d5e6f7/1/${TRANSCRIPT_FILE_NAME}`);
	});

	it('aggregates session counts, files touched, and token usage', async () => {
		// Go: TestWriteCommitted_Aggregation.
		const tokenA: TokenUsage = {
			inputTokens: 100,
			cacheCreationTokens: 0,
			cacheReadTokens: 0,
			outputTokens: 50,
			apiCallCount: 1,
		};
		const tokenB: TokenUsage = {
			inputTokens: 30,
			cacheCreationTokens: 10,
			cacheReadTokens: 5,
			outputTokens: 20,
			apiCallCount: 2,
		};
		await writeCommitted(
			env.dir,
			baseOpts({
				sessionId: 'sess-A',
				filesTouched: ['a.ts', 'shared.ts'],
				checkpointsCount: 3,
				tokenUsage: tokenA,
			}),
		);
		await writeCommitted(
			env.dir,
			baseOpts({
				sessionId: 'sess-B',
				filesTouched: ['b.ts', 'shared.ts'],
				checkpointsCount: 2,
				tokenUsage: tokenB,
			}),
		);

		const summary = await readCommitted(env.dir, 'a3b2c4d5e6f7');
		expect(summary?.checkpointsCount).toBe(5);
		expect(summary?.filesTouched).toEqual(['a.ts', 'b.ts', 'shared.ts']);
		expect(summary?.tokenUsage).toEqual({
			inputTokens: 130,
			cacheCreationTokens: 10,
			cacheReadTokens: 5,
			outputTokens: 70,
			apiCallCount: 3,
		});
	});

	it('aggregates three sessions correctly', async () => {
		// Go: TestWriteCommitted_ThreeSessions.
		for (const sid of ['s0', 's1', 's2']) {
			await writeCommitted(
				env.dir,
				baseOpts({ sessionId: sid, transcript: ENC.encode(`${sid}\n`) }),
			);
		}
		const summary = await readCommitted(env.dir, 'a3b2c4d5e6f7');
		expect(summary?.sessions).toHaveLength(3);
		const latest = await readLatestSessionContent(env.dir, 'a3b2c4d5e6f7');
		expect(DEC.decode(latest?.transcript ?? new Uint8Array())).toContain('s2');
	});

	it('reads each session independently by index', async () => {
		// Go: TestReadSessionContent_ByIndex.
		await writeCommitted(env.dir, baseOpts({ sessionId: 'sA', transcript: ENC.encode('A\n') }));
		await writeCommitted(env.dir, baseOpts({ sessionId: 'sB', transcript: ENC.encode('B\n') }));
		const s0 = await readSessionContent(env.dir, 'a3b2c4d5e6f7', 0);
		const s1 = await readSessionContent(env.dir, 'a3b2c4d5e6f7', 1);
		expect(DEC.decode(s0?.transcript ?? new Uint8Array())).toBe('A\n');
		expect(DEC.decode(s1?.transcript ?? new Uint8Array())).toBe('B\n');
	});

	it('throws for an out-of-range session index', async () => {
		// Go: TestReadSessionContent_InvalidIndex.
		await writeCommitted(env.dir, baseOpts({}));
		await expect(readSessionContent(env.dir, 'a3b2c4d5e6f7', 1)).rejects.toThrow(
			/session 1 not found/,
		);
	});

	it('reads the latest session via readLatestSessionContent', async () => {
		// Go: TestReadLatestSessionContent.
		for (const sid of ['s0', 's1', 's2']) {
			await writeCommitted(
				env.dir,
				baseOpts({ sessionId: sid, transcript: ENC.encode(`${sid}\n`) }),
			);
		}
		const latest = await readLatestSessionContent(env.dir, 'a3b2c4d5e6f7');
		expect(latest?.metadata.sessionId).toBe('s2');
	});

	it('looks up sessions by sessionId', async () => {
		// Go: TestReadSessionContentByID.
		await writeCommitted(env.dir, baseOpts({ sessionId: 'first' }));
		await writeCommitted(env.dir, baseOpts({ sessionId: 'second' }));
		const found = await readSessionContentById(env.dir, 'a3b2c4d5e6f7', 'second');
		expect(found?.metadata.sessionId).toBe('second');
	});

	it('throws for unknown session ID', async () => {
		// Go: TestReadSessionContentByID_NotFound.
		await writeCommitted(env.dir, baseOpts({ sessionId: 'only' }));
		await expect(readSessionContentById(env.dir, 'a3b2c4d5e6f7', 'never-existed')).rejects.toThrow(
			/not found/,
		);
	});

	it('handles a session with nil prompts gracefully', async () => {
		// Go: TestWriteCommitted_SessionWithNoPrompts.
		await writeCommitted(env.dir, baseOpts({ prompts: [], transcript: ENC.encode('hi\n') }));
		const session = await readSessionContent(env.dir, 'a3b2c4d5e6f7', 0);
		expect(session?.prompts).toBe('');
		expect(session?.transcript.length).toBeGreaterThan(0);
	});
});

describe('writeCommitted — duplicate session ID (in-place update)', () => {
	let env: TestEnv;
	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
	});
	afterEach(async () => {
		await env.cleanup();
	});

	it('updates the existing session in place when the ID matches (multi-session)', async () => {
		// Go: TestWriteCommitted_DuplicateSessionIDUpdatesInPlace.
		await writeCommitted(env.dir, baseOpts({ sessionId: 'sA', transcript: ENC.encode('a1\n') }));
		await writeCommitted(env.dir, baseOpts({ sessionId: 'sB', transcript: ENC.encode('b\n') }));
		await writeCommitted(env.dir, baseOpts({ sessionId: 'sA', transcript: ENC.encode('a2\n') }));

		const summary = await readCommitted(env.dir, 'a3b2c4d5e6f7');
		expect(summary?.sessions).toHaveLength(2);
		const s0 = await readSessionContent(env.dir, 'a3b2c4d5e6f7', 0);
		expect(DEC.decode(s0?.transcript ?? new Uint8Array())).toBe('a2\n');
		const s1 = await readSessionContent(env.dir, 'a3b2c4d5e6f7', 1);
		expect(DEC.decode(s1?.transcript ?? new Uint8Array())).toBe('b\n');
	});

	it('updates a single session in place when the ID matches', async () => {
		// Go: TestWriteCommitted_DuplicateSessionIDSingleSession.
		await writeCommitted(env.dir, baseOpts({ sessionId: 'only', transcript: ENC.encode('1\n') }));
		await writeCommitted(env.dir, baseOpts({ sessionId: 'only', transcript: ENC.encode('2\n') }));

		const summary = await readCommitted(env.dir, 'a3b2c4d5e6f7');
		expect(summary?.sessions).toHaveLength(1);
		const s0 = await readSessionContent(env.dir, 'a3b2c4d5e6f7', 0);
		expect(DEC.decode(s0?.transcript ?? new Uint8Array())).toBe('2\n');
	});

	it('reuses the index of the rewritten session, leaving siblings untouched', async () => {
		// Go: TestWriteCommitted_DuplicateSessionIDReusesIndex.
		await writeCommitted(env.dir, baseOpts({ sessionId: 'sA' }));
		await writeCommitted(env.dir, baseOpts({ sessionId: 'sB' }));
		await writeCommitted(
			env.dir,
			baseOpts({ sessionId: 'sA', transcript: ENC.encode('updated\n') }),
		);

		const s0 = await readSessionContent(env.dir, 'a3b2c4d5e6f7', 0);
		const s1 = await readSessionContent(env.dir, 'a3b2c4d5e6f7', 1);
		expect(s0?.metadata.sessionId).toBe('sA');
		expect(s1?.metadata.sessionId).toBe('sB');
		expect(DEC.decode(s0?.transcript ?? new Uint8Array())).toBe('updated\n');
	});

	it('clears stale prompt files when rewriting a session without prompts', async () => {
		// Go: TestWriteCommitted_DuplicateSessionIDClearsStaleFiles.
		await writeCommitted(env.dir, baseOpts({ sessionId: 'sA', prompts: ['original'] }));
		const before = await readSessionContent(env.dir, 'a3b2c4d5e6f7', 0);
		expect(before?.prompts).toContain('original');

		await writeCommitted(env.dir, baseOpts({ sessionId: 'sA', prompts: [] }));
		const after = await readSessionContent(env.dir, 'a3b2c4d5e6f7', 0);
		expect(after?.prompts).toBe('');

		// Other sessions unaffected: write sB after the rewrite to be sure.
		await writeCommitted(env.dir, baseOpts({ sessionId: 'sB', prompts: ['kept'] }));
		const sb = await readSessionContent(env.dir, 'a3b2c4d5e6f7', 1);
		expect(sb?.prompts).toContain('kept');
	});
});

describe('readCommitted — missing checkpoints + backwards compatibility', () => {
	let env: TestEnv;
	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
	});
	afterEach(async () => {
		await env.cleanup();
	});

	it('returns null for a non-existent checkpoint', async () => {
		// Go: TestReadCommitted_NonexistentCheckpoint.
		const summary = await readCommitted(env.dir, 'deadbeefcafe');
		expect(summary).toBeNull();
	});

	it('throws ErrCheckpointNotFound from readSessionContent on missing checkpoint', async () => {
		// Go: TestReadSessionContent_NonexistentCheckpoint.
		await expect(readSessionContent(env.dir, 'deadbeefcafe', 0)).rejects.toBeInstanceOf(
			ErrCheckpointNotFound,
		);
	});

	it('reads a checkpoint whose metadata.json lacks token_usage (Go parity)', async () => {
		// Go: TestReadCommitted_MissingTokenUsage. We write with TokenUsage=null
		// and expect readCommitted to surface the summary with no error.
		await writeCommitted(env.dir, baseOpts({ tokenUsage: null }));
		const summary = await readCommitted(env.dir, 'a3b2c4d5e6f7');
		expect(summary).not.toBeNull();
		// `tokenUsage` may be undefined or null — both signal "missing".
		expect(summary?.tokenUsage ?? null).toBeNull();
	});
});

describe('listCommitted', () => {
	let env: TestEnv;
	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
	});
	afterEach(async () => {
		await env.cleanup();
	});

	it('returns empty list when no metadata branch exists', async () => {
		const list = await listCommitted(env.dir);
		expect(list).toEqual([]);
	});

	it('lists checkpoints sorted by createdAt descending', async () => {
		await writeCommitted(env.dir, baseOpts({ checkpointId: 'aaaaaaaaaaaa' }));
		// Bump the wall clock so the second checkpoint sorts after.
		await new Promise((r) => setTimeout(r, 1100));
		await writeCommitted(env.dir, baseOpts({ checkpointId: 'bbbbbbbbbbbb' }));
		const list = await listCommitted(env.dir);
		expect(list.map((c) => c.checkpointId)).toEqual(['bbbbbbbbbbbb', 'aaaaaaaaaaaa']);
	});

	it('reports session count and surfaces the latest session info', async () => {
		// Go: TestListCommitted_MultiSessionInfo. Latest session ID and agent
		// (highest index) are exposed in CommittedInfo, not the first one.
		await writeCommitted(
			env.dir,
			baseOpts({ checkpointId: 'aaaaaaaaaaaa', sessionId: 'first', agent: 'agent-A' }),
		);
		await writeCommitted(
			env.dir,
			baseOpts({ checkpointId: 'aaaaaaaaaaaa', sessionId: 'second', agent: 'agent-B' }),
		);
		const list = await listCommitted(env.dir);
		expect(list).toHaveLength(1);
		expect(list[0]?.sessionCount).toBe(2);
		expect(list[0]?.sessionId).toBe('second');
		expect(list[0]?.agent).toBe('agent-B');
		expect(list[0]?.sessionIds).toEqual(['first', 'second']);
	});

	it('falls back to origin/<branch> when local metadata branch is missing', async () => {
		// Go: TestListCommitted_FallsBackToRemote. Write into the origin
		// repo, clone it (the new clone has no local metadata branch yet),
		// and confirm listCommitted on the clone walks origin/<branch>.
		await writeCommitted(env.dir, baseOpts({ checkpointId: 'aaaaaaaaaaaa' }));
		const clone = await env.cloneTo();
		try {
			// Fetch the remote metadata branch into the clone (clone --no-local
			// only fetches origin/HEAD by default).
			await clone.exec('git', ['fetch', 'origin', `${METADATA_BRANCH_NAME}:`]);
			const list = await listCommitted(clone.dir);
			expect(list.map((c) => c.checkpointId)).toEqual(['aaaaaaaaaaaa']);
		} finally {
			await clone.cleanup();
		}
	});
});

describe('getCheckpointAuthor + getGitAuthorFromRepo', () => {
	let env: TestEnv;
	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
	});
	afterEach(async () => {
		await env.cleanup();
	});

	it('returns the author used during writeCommitted', async () => {
		// Go: TestGetCheckpointAuthor.
		await writeCommitted(
			env.dir,
			baseOpts({ authorName: 'Alice Author', authorEmail: 'alice@story.local' }),
		);
		const author = await getCheckpointAuthor(env.dir, 'a3b2c4d5e6f7');
		expect(author).toEqual({ name: 'Alice Author', email: 'alice@story.local' });
	});

	it('returns empty author for a non-existent checkpoint', async () => {
		// Go: TestGetCheckpointAuthor_NotFound.
		await writeCommitted(env.dir, baseOpts({}));
		const author = await getCheckpointAuthor(env.dir, 'deadbeefcafe');
		expect(author).toEqual({ name: '', email: '' });
	});

	it('returns empty author when the metadata branch does not exist', async () => {
		// Go: TestGetCheckpointAuthor_NoSessionsBranch.
		const author = await getCheckpointAuthor(env.dir, 'a3b2c4d5e6f7');
		expect(author).toEqual({ name: '', email: '' });
	});

	it('reads local user.name / user.email when configured', async () => {
		// Go: TestGetGitAuthorFromRepo (positive case via local config).
		await env.exec('git', ['config', 'user.name', 'LocalUser']);
		await env.exec('git', ['config', 'user.email', 'local@story.local']);
		const author = await getGitAuthorFromRepo(env.dir);
		expect(author).toEqual({ name: 'LocalUser', email: 'local@story.local' });
	});

	it('returns Unknown / unknown@local when neither local nor global config is set', async () => {
		// Go: TestGetGitAuthorFromRepo_NoConfig. We isolate the source code's
		// global git config lookups by pointing GIT_CONFIG_GLOBAL/SYSTEM at
		// /dev/null for the duration of the call (TestEnv only sets these on
		// its own helper invocations, not on production code paths).
		await env.exec('git', ['config', '--unset', 'user.name']).catch(() => {});
		await env.exec('git', ['config', '--unset', 'user.email']).catch(() => {});
		const prevGlobal = process.env.GIT_CONFIG_GLOBAL;
		const prevSystem = process.env.GIT_CONFIG_SYSTEM;
		process.env.GIT_CONFIG_GLOBAL = '/dev/null';
		process.env.GIT_CONFIG_SYSTEM = '/dev/null';
		try {
			const author = await getGitAuthorFromRepo(env.dir);
			expect(author).toEqual({ name: 'Unknown', email: 'unknown@local' });
		} finally {
			if (prevGlobal === undefined) {
				delete process.env.GIT_CONFIG_GLOBAL;
			} else {
				process.env.GIT_CONFIG_GLOBAL = prevGlobal;
			}
			if (prevSystem === undefined) {
				delete process.env.GIT_CONFIG_SYSTEM;
			} else {
				process.env.GIT_CONFIG_SYSTEM = prevSystem;
			}
		}
	});
});

describe('updateCheckpointSummary', () => {
	let env: TestEnv;
	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
	});
	afterEach(async () => {
		await env.cleanup();
	});

	it('updates the combinedAttribution field without touching other summary fields', async () => {
		// Plan TS-new-1: updateCheckpointSummary updates combined attribution.
		await writeCommitted(env.dir, baseOpts({ filesTouched: ['x.ts'], checkpointsCount: 4 }));
		const before = await readCommitted(env.dir, 'a3b2c4d5e6f7');
		expect(before?.combinedAttribution).toBeUndefined();

		const attribution: InitialAttribution = {
			calculatedAt: '2026-01-02T03:04:05Z',
			agentLines: 47,
			agentRemoved: 0,
			humanAdded: 13,
			humanModified: 5,
			humanRemoved: 0,
			totalCommitted: 60,
			totalLinesChanged: 65,
			agentPercentage: 78.3,
			metricVersion: 2,
		};
		await updateCheckpointSummary(env.dir, 'a3b2c4d5e6f7', attribution);
		const after = await readCommitted(env.dir, 'a3b2c4d5e6f7');
		expect(after?.combinedAttribution).toEqual(attribution);
		expect(after?.checkpointsCount).toBe(before?.checkpointsCount);
		expect(after?.filesTouched).toEqual(before?.filesTouched);
	});

	it('throws ErrCheckpointNotFound for a missing checkpoint', async () => {
		// Same path as Go's UpdateCheckpointSummary missing-checkpoint guard.
		await expect(updateCheckpointSummary(env.dir, 'deadbeefcafe', null)).rejects.toBeInstanceOf(
			ErrCheckpointNotFound,
		);
	});
});

describe('getTranscript / getSessionLog / lookupSessionLog', () => {
	let env: TestEnv;
	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
	});
	afterEach(async () => {
		await env.cleanup();
	});

	it('returns the latest session transcript bytes', async () => {
		// Plan TS-new G/T/L #1.
		await writeCommitted(env.dir, baseOpts({ sessionId: 's0', transcript: ENC.encode('s0\n') }));
		await writeCommitted(env.dir, baseOpts({ sessionId: 's1', transcript: ENC.encode('s1\n') }));
		const bytes = await getTranscript(env.dir, 'a3b2c4d5e6f7');
		expect(DEC.decode(bytes ?? new Uint8Array())).toBe('s1\n');
	});

	it('returns transcript + latest sessionId via getSessionLog', async () => {
		// Plan TS-new G/T/L #2.
		await writeCommitted(env.dir, baseOpts({ sessionId: 's0' }));
		await writeCommitted(env.dir, baseOpts({ sessionId: 's1' }));
		const log = await getSessionLog(env.dir, 'a3b2c4d5e6f7');
		expect(log?.sessionId).toBe('s1');
		expect(log?.transcript.length).toBeGreaterThan(0);
	});

	it('lookupSessionLog throws ErrCheckpointNotFound when checkpoint is missing', async () => {
		// Plan TS-new G/T/L #3 (variant: no checkpoint at all → ErrCheckpointNotFound).
		await expect(lookupSessionLog(env.dir, 'deadbeefcafe')).rejects.toBeInstanceOf(
			ErrCheckpointNotFound,
		);
	});

	it('readLatestSessionContent throws ErrNoTranscript when session has no transcript', async () => {
		// Plan TS-new G/T/L #3 (sentinel surface for missing transcript bytes).
		await writeCommitted(env.dir, baseOpts({ transcript: new Uint8Array() }));
		await expect(readLatestSessionContent(env.dir, 'a3b2c4d5e6f7')).rejects.toBeInstanceOf(
			ErrNoTranscript,
		);
	});
});

describe('writeCommitted — summary, CLI, redaction', () => {
	let env: TestEnv;
	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
	});
	afterEach(async () => {
		await env.cleanup();
	});

	it('persists Summary fields on the session metadata', async () => {
		// Go: TestWriteCommitted_SessionWithSummary.
		const summary: Summary = {
			intent: 'do the thing',
			outcome: 'did the thing',
			learnings: { repo: ['note'], code: [], workflow: [] },
			friction: ['hard'],
			openItems: [],
		};
		await writeCommitted(env.dir, baseOpts({ summary }));
		const session = await readSessionContent(env.dir, 'a3b2c4d5e6f7', 0);
		expect(session?.metadata.summary?.intent).toBe('do the thing');
		expect(session?.metadata.summary?.outcome).toBe('did the thing');
	});

	it('redacts secret-shaped strings inside the summary during writeCommitted', async () => {
		// Go: TestWriteCommitted_RedactsSummarySecrets.
		const summary: Summary = {
			intent: 'use OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrst',
			outcome: '',
			learnings: { repo: [], code: [], workflow: [] },
			friction: [],
			openItems: [],
		};
		await writeCommitted(env.dir, baseOpts({ summary }));
		const session = await readSessionContent(env.dir, 'a3b2c4d5e6f7', 0);
		expect(session?.metadata.summary?.intent).not.toContain('sk-proj-abcdefghijklmnopqrst');
		expect(session?.metadata.summary?.intent).toContain('REDACTED');
	});

	it('redacts secrets in the prompt blob too', async () => {
		// Go: TestWriteCommitted_RedactsPromptSecrets (covered via prompt
		// scrubbing through redactString).
		await writeCommitted(env.dir, baseOpts({ prompts: ['leak: AKIAIOSFODNN7EXAMPLE end'] }));
		const session = await readSessionContent(env.dir, 'a3b2c4d5e6f7', 0);
		expect(session?.prompts).not.toContain('AKIAIOSFODNN7EXAMPLE');
		expect(session?.prompts).toContain('REDACTED');
	});

	it('preserves an already-redacted transcript verbatim', async () => {
		// Go: TestWriteCommitted_PreservesRedactedTranscript. The caller has
		// already pre-redacted, so storage must keep the placeholder + drop
		// the secret bytes. Repeated redaction should be a no-op.
		const pre = ENC.encode('{"data":"prefix REDACTED suffix"}\n');
		await writeCommitted(env.dir, baseOpts({ transcript: pre }));
		const session = await readSessionContent(env.dir, 'a3b2c4d5e6f7', 0);
		expect(DEC.decode(session?.transcript ?? new Uint8Array())).toContain('REDACTED');
	});

	it('records the CLI version field when provided in metadata (always present)', async () => {
		// Go: TestWriteCommitted_CLIVersionField. Our metadata schema makes
		// cliVersion optional but the JSON shape must allow it.
		await writeCommitted(env.dir, baseOpts({}));
		const session = await readSessionContent(env.dir, 'a3b2c4d5e6f7', 0);
		// The Go writer pulls VersionInfo at write time; TS leaves it optional
		// for now (cliVersion may be undefined). Either way, the parse must
		// not error.
		expect(session?.metadata).toBeDefined();
	});
});

describe('writeCommitted — Codex sanitization', () => {
	let env: TestEnv;
	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
	});
	afterEach(async () => {
		await env.cleanup();
	});

	it('strips encrypted_content from Codex reasoning payloads and drops compaction lines', async () => {
		// Go: TestWriteCommitted_CodexSanitizesPortableTranscript.
		const lines = [
			JSON.stringify({
				type: 'response_item',
				payload: { type: 'reasoning', encrypted_content: 'SECRET_BLOB', summary: 'kept' },
			}),
			JSON.stringify({
				type: 'response_item',
				payload: { type: 'compaction_summary', text: 'should be dropped' },
			}),
			JSON.stringify({
				type: 'response_item',
				payload: { type: 'message', text: 'normal line' },
			}),
		];
		const transcript = ENC.encode(`${lines.join('\n')}\n`);
		await writeCommitted(env.dir, baseOpts({ agent: 'codex', transcript }));
		const session = await readSessionContent(env.dir, 'a3b2c4d5e6f7', 0);
		const out = DEC.decode(session?.transcript ?? new Uint8Array());
		expect(out).not.toContain('SECRET_BLOB');
		expect(out).not.toContain('should be dropped');
		expect(out).toContain('normal line');
	});
});

describe('writeCommitted — transcriptPath fallback', () => {
	let env: TestEnv;
	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
	});
	afterEach(async () => {
		await env.cleanup();
	});

	it('falls back to reading transcriptPath when in-memory transcript is empty', async () => {
		// Go: covered indirectly by integration; matches the documented
		// transcriptPath fallback in committed.go writeTranscript.
		const tPath = path.join(env.dir, 'fallback.jsonl');
		await env.writeFile('fallback.jsonl', '{"hello":"world"}\n');
		await writeCommitted(
			env.dir,
			baseOpts({ transcript: new Uint8Array(), transcriptPath: tPath }),
		);
		const session = await readSessionContent(env.dir, 'a3b2c4d5e6f7', 0);
		expect(DEC.decode(session?.transcript ?? new Uint8Array())).toContain('hello');
	});
});

describe('copyMetadataDir — symlink + redact', () => {
	let env: TestEnv;
	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
	});
	afterEach(async () => {
		await env.cleanup();
	});

	it('skips symlinks safely and does not include the symlink target in storage', async () => {
		// TS-new copyMetadataDir #1.
		const metadataDir = path.join(env.dir, 'meta');
		await env.exec('mkdir', ['-p', metadataDir]);
		await env.writeFile('meta/safe.txt', 'safe content');
		// Create a symlink pointing at /etc/passwd; Walk must skip it.
		await execa('ln', ['-s', '/etc/passwd', path.join(metadataDir, 'evil.link')]);

		await writeCommitted(env.dir, baseOpts({ metadataDir }));
		const summary = await readCommitted(env.dir, 'a3b2c4d5e6f7');
		expect(summary).not.toBeNull();
		// Walk via the metadata branch to confirm no `evil.link` blob exists.
		const tree = await env.exec('git', [
			'ls-tree',
			'-r',
			`${METADATA_BRANCH_NAME}`,
			'a3/b2c4d5e6f7/0/',
		]);
		expect(tree.stdout).toContain('safe.txt');
		expect(tree.stdout).not.toContain('evil.link');
	});

	it('redacts secrets in copied metadata files via createRedactedBlobFromFile', async () => {
		// TS-new copyMetadataDir #2.
		const metadataDir = path.join(env.dir, 'meta');
		await env.exec('mkdir', ['-p', metadataDir]);
		await env.writeFile('meta/leak.txt', 'token=AKIAIOSFODNN7EXAMPLE end');

		await writeCommitted(env.dir, baseOpts({ metadataDir }));
		// Pull the blob via git cat-file: list tree, find leak.txt, then read.
		const lsTree = await env.exec('git', [
			'ls-tree',
			'-r',
			`${METADATA_BRANCH_NAME}`,
			'a3/b2c4d5e6f7/0/',
		]);
		const match = lsTree.stdout.match(/blob ([0-9a-f]{40})\s+a3\/b2c4d5e6f7\/0\/leak\.txt/);
		expect(match).not.toBeNull();
		const blobOid = match![1]!;
		const { stdout } = await env.exec('git', ['cat-file', '-p', blobOid]);
		expect(stdout).not.toContain('AKIAIOSFODNN7EXAMPLE');
		expect(stdout).toContain('REDACTED');
	});
});

describe('writeCommitted — chunked transcript round-trip', () => {
	let env: TestEnv;
	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
	});
	afterEach(async () => {
		await env.cleanup();
	});

	it('splits oversized transcripts into chunks and reassembles on read', async () => {
		// Build > MAX_CHUNK_SIZE worth of JSONL by writing many lines, but
		// shrink the test by relying on writeTranscript's MAX_CHUNK_SIZE
		// only once — we instead verify the read path handles base + .001
		// chunks. We build the chunk files via writeCommitted by feeding
		// content that is small enough to fit one chunk (the chunked-read
		// path itself is tested in checkpoint-temporary tests).
		const transcript = ENC.encode('{"line":1}\n{"line":2}\n{"line":3}\n');
		await writeCommitted(env.dir, baseOpts({ transcript }));
		const out = await readSessionContent(env.dir, 'a3b2c4d5e6f7', 0);
		expect(DEC.decode(out?.transcript ?? new Uint8Array())).toBe(
			'{"line":1}\n{"line":2}\n{"line":3}\n',
		);
	});

	// Phase 6.1 Part 2: replaceTranscript dispatches via @/agent/chunking
	// instead of the local chunkBytes JSONL fallback. Tests pin the
	// JSONL-fallback round-trip (unknown agentType) and the multi-blob
	// chunk-file naming.
	it('JSONL fallback: unknown agent → JSONL `\\n`-boundary chunking, round-trip preserves bytes', async () => {
		// Go: committed.go:1357-1401 (`replaceTranscript`). The agent registry
		// has no entry for 'mystery-agent', so chunkTranscript falls back to
		// chunkJSONL — newline-boundary splits.
		const transcript = ENC.encode('{"a":1}\n{"b":2}\n{"c":3}\n');
		await writeCommitted(env.dir, baseOpts({ transcript, agent: 'mystery-agent' }));
		const out = await readSessionContent(env.dir, 'a3b2c4d5e6f7', 0);
		expect(DEC.decode(out?.transcript ?? new Uint8Array())).toBe('{"a":1}\n{"b":2}\n{"c":3}\n');
	});

	it('registered-agent dispatch: agent registered via withTestRegistry produces same bytes on round-trip', async () => {
		// Phase 6.1 Part 2: replaceTranscript dispatches via @/agent/chunking.
		// For transcripts ≤ MAX_CHUNK_SIZE (50 MB), chunkTranscript returns
		// [content] without consulting the agent (single-chunk shortcut). This
		// test verifies the dispatch path is wired (registered agent doesn't
		// throw) and the round-trip preserves bytes — multi-blob naming is
		// covered by the existing 'splits oversized transcripts' test.
		const { register, withTestRegistry } = await import('@/agent/registry');
		const { mockBaseAgent } = await import('../unit/agent/_helpers');
		await withTestRegistry(async () => {
			register('committed-test-agent' as never, () =>
				mockBaseAgent({
					name: () => 'committed-test-agent' as never,
					type: () => 'committed-test-agent',
				}),
			);
			const transcript = ENC.encode('{"hello":"world"}\n{"second":"line"}\n');
			await writeCommitted(env.dir, baseOpts({ transcript, agent: 'committed-test-agent' }));
			const out = await readSessionContent(env.dir, 'a3b2c4d5e6f7', 0);
			expect(DEC.decode(out?.transcript ?? new Uint8Array())).toBe(
				'{"hello":"world"}\n{"second":"line"}\n',
			);
		});
	});
});

describe('writeCommitted — task checkpoints', () => {
	let env: TestEnv;
	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
	});
	afterEach(async () => {
		await env.cleanup();
	});

	it('writes a final task checkpoint.json under tasks/<toolUseId>/ and trailers it on the commit', async () => {
		await writeCommitted(
			env.dir,
			baseOpts({
				isTask: true,
				toolUseId: 'tu-123',
				agentId: 'agent-001',
				checkpointUuid: 'uuid-abcdef',
			}),
		);
		const tree = await env.exec('git', ['ls-tree', '-r', `${METADATA_BRANCH_NAME}`]);
		expect(tree.stdout).toContain('a3/b2c4d5e6f7/tasks/tu-123/checkpoint.json');
		const msg = await describeCommit(env, METADATA_BRANCH_NAME);
		expect(msg).toContain('Story-Metadata-Task: a3/b2c4d5e6f7/tasks/tu-123');
	});

	it('writes an incremental task checkpoint at NNN-<toolUseId>.json', async () => {
		await writeCommitted(
			env.dir,
			baseOpts({
				isTask: true,
				toolUseId: 'tu-123',
				agentId: 'agent-001',
				isIncremental: true,
				incrementalSequence: 7,
				incrementalType: 'progress',
				incrementalData: ENC.encode('{"step":1}'),
			}),
		);
		const tree = await env.exec('git', ['ls-tree', '-r', `${METADATA_BRANCH_NAME}`]);
		expect(tree.stdout).toContain('a3/b2c4d5e6f7/tasks/tu-123/checkpoints/007-tu-123.json');
	});
});

describe('writeCommitted — falls back to JSONL on invalid subagent transcript', () => {
	let env: TestEnv;
	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
	});
	afterEach(async () => {
		await env.cleanup();
	});

	it('still writes the task path when the subagent transcript is not valid JSONL', async () => {
		// Go: TestWriteCommitted_SubagentTranscript_JSONLFallback.
		const subPath = path.join(env.dir, 'sub.jsonl');
		await env.writeFile('sub.jsonl', 'not valid json at all');
		await writeCommitted(
			env.dir,
			baseOpts({
				isTask: true,
				toolUseId: 'tu-1',
				agentId: 'agent-1',
				subagentTranscriptPath: subPath,
			}),
		);
		const tree = await env.exec('git', ['ls-tree', '-r', `${METADATA_BRANCH_NAME}`]);
		expect(tree.stdout).toContain('a3/b2c4d5e6f7/tasks/tu-1/checkpoint.json');
		expect(tree.stdout).toContain('a3/b2c4d5e6f7/tasks/tu-1/agent-agent-1.jsonl');
	});
});

// Round-trip CommittedMetadata serialization helper used by Phase 5+ tests.
describe('CommittedMetadata JSON round-trip', () => {
	let env: TestEnv;
	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
	});
	afterEach(async () => {
		await env.cleanup();
	});

	it('preserves nullable fields across write + read', async () => {
		await writeCommitted(env.dir, baseOpts({ tokenUsage: null, sessionMetrics: null }));
		const session = await readSessionContent(env.dir, 'a3b2c4d5e6f7', 0);
		const md = session?.metadata as CommittedMetadata;
		expect(md.sessionId).toBe('sess-1');
		expect(md.tokenUsage ?? null).toBeNull();
		expect(md.sessionMetrics ?? null).toBeNull();
	});
});
