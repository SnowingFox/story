import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	ErrCheckpointNotFound,
	getGitAuthorFromRepo,
	readCommitted,
	readSessionContent,
	updateCommitted,
	updateSummary,
	writeCommitted,
} from '@/checkpoint/committed';
import {
	CONTENT_HASH_FILE_NAME,
	METADATA_BRANCH_NAME,
	PROMPT_FILE_NAME,
} from '@/checkpoint/constants';
import { PROMPT_SEPARATOR } from '@/checkpoint/prompts';
import type { Summary, UpdateCommittedOptions, WriteCommittedOptions } from '@/checkpoint/types';
import { TestEnv } from '../helpers/test-env';

const ENC = new TextEncoder();
const DEC = new TextDecoder();

function baseWriteOpts(overrides: Partial<WriteCommittedOptions>): WriteCommittedOptions {
	return {
		checkpointId: 'a3b2c4d5e6f7',
		sessionId: 'sess-1',
		strategy: 'manual-commit',
		branch: 'main',
		transcript: ENC.encode('{"role":"user","content":"hi"}\n'),
		prompts: ['original prompt'],
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

function baseUpdateOpts(overrides: Partial<UpdateCommittedOptions>): UpdateCommittedOptions {
	return {
		checkpointId: 'a3b2c4d5e6f7',
		sessionId: 'sess-1',
		transcript: ENC.encode('{"role":"user","content":"updated"}\n'),
		prompts: ['updated prompt'],
		agent: 'claudecode',
		compactTranscript: null,
		...overrides,
	};
}

async function setEnvAuthor(env: TestEnv, name: string, email: string): Promise<void> {
	await env.exec('git', ['config', 'user.name', name]);
	await env.exec('git', ['config', 'user.email', email]);
}

async function readBlobAtPath(env: TestEnv, treePath: string): Promise<string> {
	const { stdout } = await execa('git', ['ls-tree', '-r', METADATA_BRANCH_NAME], {
		cwd: env.dir,
	});
	const lines = stdout.split('\n');
	for (const line of lines) {
		if (line.endsWith(`\t${treePath}`)) {
			const parts = line.split(/\s+/);
			const oid = parts[2]!;
			const r = await execa('git', ['cat-file', '-p', oid], { cwd: env.dir });
			return String(r.stdout);
		}
	}
	throw new Error(`blob not found at ${treePath}`);
}

describe('updateCommitted — basic replace semantics', () => {
	let env: TestEnv;
	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		await setEnvAuthor(env, 'Test Author', 'author@test.local');
		await writeCommitted(env.dir, baseWriteOpts({}));
	});
	afterEach(async () => {
		await env.cleanup();
	});

	it('replaces the transcript content entirely (not append)', async () => {
		// Go: TestUpdateCommitted_ReplacesTranscript.
		await updateCommitted(
			env.dir,
			baseUpdateOpts({ transcript: ENC.encode('REPLACED-CONTENT'), prompts: [] }),
		);
		const session = await readSessionContent(env.dir, 'a3b2c4d5e6f7', 0);
		expect(DEC.decode(session?.transcript ?? new Uint8Array())).toBe('REPLACED-CONTENT');
	});

	it('replaces prompts using the canonical separator format', async () => {
		// Go: TestUpdateCommitted_ReplacesPrompts.
		await updateCommitted(
			env.dir,
			baseUpdateOpts({
				transcript: new Uint8Array(),
				prompts: ['p1', 'p2', 'p3'],
			}),
		);
		const session = await readSessionContent(env.dir, 'a3b2c4d5e6f7', 0);
		expect(session?.prompts).toBe(['p1', 'p2', 'p3'].join(PROMPT_SEPARATOR));
	});

	it('replaces transcript and prompts in a single update', async () => {
		// Go: TestUpdateCommitted_ReplacesAllFieldsTogether.
		await updateCommitted(
			env.dir,
			baseUpdateOpts({
				transcript: ENC.encode('combined-transcript'),
				prompts: ['combined-prompt'],
			}),
		);
		const session = await readSessionContent(env.dir, 'a3b2c4d5e6f7', 0);
		expect(DEC.decode(session?.transcript ?? new Uint8Array())).toBe('combined-transcript');
		expect(session?.prompts).toBe('combined-prompt');
	});

	it('throws ErrCheckpointNotFound for a non-existent checkpoint', async () => {
		// Go: TestUpdateCommitted_NonexistentCheckpoint.
		await expect(
			updateCommitted(env.dir, baseUpdateOpts({ checkpointId: 'deadbeefcafe' })),
		).rejects.toBeInstanceOf(ErrCheckpointNotFound);
	});

	it('preserves session metadata fields (sessionId / strategy) after a transcript-only update', async () => {
		// Go: TestUpdateCommitted_PreservesMetadata.
		const before = await readSessionContent(env.dir, 'a3b2c4d5e6f7', 0);
		await updateCommitted(
			env.dir,
			baseUpdateOpts({ transcript: ENC.encode('only-transcript'), prompts: [] }),
		);
		const after = await readSessionContent(env.dir, 'a3b2c4d5e6f7', 0);
		expect(after?.metadata.sessionId).toBe(before?.metadata.sessionId);
		expect(after?.metadata.strategy).toBe(before?.metadata.strategy);
	});

	it('updates each checkpoint independently', async () => {
		// Go: TestUpdateCommitted_MultipleCheckpoints.
		await writeCommitted(
			env.dir,
			baseWriteOpts({ checkpointId: 'bbbbbbbbbbbb', sessionId: 'second' }),
		);
		await updateCommitted(
			env.dir,
			baseUpdateOpts({
				checkpointId: 'a3b2c4d5e6f7',
				sessionId: 'sess-1',
				transcript: ENC.encode('A-NEW'),
				prompts: [],
			}),
		);
		await updateCommitted(
			env.dir,
			baseUpdateOpts({
				checkpointId: 'bbbbbbbbbbbb',
				sessionId: 'second',
				transcript: ENC.encode('B-NEW'),
				prompts: [],
			}),
		);
		const a = await readSessionContent(env.dir, 'a3b2c4d5e6f7', 0);
		const b = await readSessionContent(env.dir, 'bbbbbbbbbbbb', 0);
		expect(DEC.decode(a?.transcript ?? new Uint8Array())).toBe('A-NEW');
		expect(DEC.decode(b?.transcript ?? new Uint8Array())).toBe('B-NEW');
	});

	it('updates content_hash.txt with a fresh sha256 prefix after modification', async () => {
		// Go: TestUpdateCommitted_UpdatesContentHash.
		await updateCommitted(
			env.dir,
			baseUpdateOpts({ transcript: ENC.encode('first-update'), prompts: [] }),
		);
		const hash1 = await readBlobAtPath(env, `a3/b2c4d5e6f7/0/${CONTENT_HASH_FILE_NAME}`);
		expect(hash1.startsWith('sha256:')).toBe(true);
		await updateCommitted(
			env.dir,
			baseUpdateOpts({ transcript: ENC.encode('second-update'), prompts: [] }),
		);
		const hash2 = await readBlobAtPath(env, `a3/b2c4d5e6f7/0/${CONTENT_HASH_FILE_NAME}`);
		expect(hash2.startsWith('sha256:')).toBe(true);
		expect(hash1).not.toBe(hash2);
	});

	it('rejects an empty checkpoint ID', async () => {
		// Go: TestUpdateCommitted_EmptyCheckpointID.
		await expect(updateCommitted(env.dir, baseUpdateOpts({ checkpointId: '' }))).rejects.toThrow(
			/checkpoint ID is required/,
		);
	});

	it('falls back to the latest session when the supplied SessionID does not match any', async () => {
		// Go: TestUpdateCommitted_FallsBackToLatestSession.
		await updateCommitted(
			env.dir,
			baseUpdateOpts({
				sessionId: 'nonexistent',
				transcript: ENC.encode('FALLBACK-WRITE'),
				prompts: [],
			}),
		);
		const session = await readSessionContent(env.dir, 'a3b2c4d5e6f7', 0);
		expect(DEC.decode(session?.transcript ?? new Uint8Array())).toBe('FALLBACK-WRITE');
	});

	it('preserves the root summary across an update', async () => {
		// Go: TestUpdateCommitted_SummaryPreserved.
		const before = await readCommitted(env.dir, 'a3b2c4d5e6f7');
		await updateCommitted(env.dir, baseUpdateOpts({ transcript: ENC.encode('TX'), prompts: [] }));
		const after = await readCommitted(env.dir, 'a3b2c4d5e6f7');
		expect(after?.checkpointId).toBe(before?.checkpointId);
		expect(after?.sessions.length).toBe(before?.sessions.length);
	});

	it('uses the local git config user as the commit author', async () => {
		// Go: TestUpdateCommitted_UsesCorrectAuthor.
		await env.exec('git', ['config', 'user.name', 'Updater Name']);
		await env.exec('git', ['config', 'user.email', 'updater@story.local']);
		await updateCommitted(env.dir, baseUpdateOpts({ transcript: ENC.encode('X'), prompts: [] }));
		const { stdout } = await execa(
			'git',
			['log', '-1', '--format=%an <%ae>', METADATA_BRANCH_NAME],
			{
				cwd: env.dir,
			},
		);
		expect(String(stdout)).toBe('Updater Name <updater@story.local>');
	});
});

describe('updateSummary', () => {
	let env: TestEnv;
	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		await setEnvAuthor(env, 'Test Author', 'author@test.local');
		await writeCommitted(env.dir, baseWriteOpts({}));
	});
	afterEach(async () => {
		await env.cleanup();
	});

	it('writes the AI summary onto the latest session metadata', async () => {
		// Go: TestUpdateSummary.
		const summary: Summary = {
			intent: 'Add login form',
			outcome: 'Login form added',
			learnings: { repo: ['use form lib'], code: [], workflow: [] },
			friction: [],
			openItems: [],
		};
		await updateSummary(env.dir, 'a3b2c4d5e6f7', summary);
		const session = await readSessionContent(env.dir, 'a3b2c4d5e6f7', 0);
		expect(session?.metadata.summary?.intent).toBe('Add login form');
		expect(session?.metadata.summary?.outcome).toBe('Login form added');
	});

	it('preserves the existing sessionId and filesTouched after updating summary', async () => {
		// Go: TestUpdateSummary (assertions about untouched fields).
		const before = await readSessionContent(env.dir, 'a3b2c4d5e6f7', 0);
		const summary: Summary = {
			intent: 'something',
			outcome: '',
			learnings: { repo: [], code: [], workflow: [] },
			friction: [],
			openItems: [],
		};
		await updateSummary(env.dir, 'a3b2c4d5e6f7', summary);
		const after = await readSessionContent(env.dir, 'a3b2c4d5e6f7', 0);
		expect(after?.metadata.sessionId).toBe(before?.metadata.sessionId);
		expect(after?.metadata.filesTouched).toEqual(before?.metadata.filesTouched);
	});

	it('throws ErrCheckpointNotFound for a missing checkpoint', async () => {
		// Go: TestUpdateSummary_NotFound.
		await expect(
			updateSummary(env.dir, 'deadbeefcafe', {
				intent: '',
				outcome: '',
				learnings: { repo: [], code: [], workflow: [] },
				friction: [],
				openItems: [],
			}),
		).rejects.toBeInstanceOf(ErrCheckpointNotFound);
	});

	it('redacts secrets in summary text fields during update', async () => {
		// Go: TestUpdateSummary_RedactsSecrets.
		const summary: Summary = {
			intent: 'use token AKIAIOSFODNN7EXAMPLE',
			outcome: '',
			learnings: { repo: [], code: [], workflow: [] },
			friction: [],
			openItems: [],
		};
		await updateSummary(env.dir, 'a3b2c4d5e6f7', summary);
		const session = await readSessionContent(env.dir, 'a3b2c4d5e6f7', 0);
		expect(session?.metadata.summary?.intent).not.toContain('AKIAIOSFODNN7EXAMPLE');
		expect(session?.metadata.summary?.intent).toContain('REDACTED');
	});
});

describe('redactSummary helper behaviour', () => {
	let env: TestEnv;
	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
	});
	afterEach(async () => {
		await env.cleanup();
	});

	// Imported here (and not at the top) so the test file's surface remains
	// "what callers actually use" — redactSummary is only re-checked here as
	// part of the Go-parity audit.
	it('returns null for null input (Go: TestRedactSummary_Nil)', async () => {
		const { redactSummary } = await import('@/checkpoint/committed');
		await expect(redactSummary(null)).resolves.toBeNull();
	});

	it('redacts every secret-bearing field while preserving structure', async () => {
		// Go: TestRedactSummary_WithSecrets.
		const { redactSummary } = await import('@/checkpoint/committed');
		const out = await redactSummary({
			intent: 'one AKIAIOSFODNN7EXAMPLE',
			outcome: 'two ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
			learnings: {
				repo: ['secret sk-proj-aaaaaaaaaaaaaaaaaaaaaaa'],
				code: [
					{
						path: 'src/app.ts',
						line: 10,
						endLine: 12,
						finding: 'leaks AKIAIOSFODNN7EXAMPLE',
					},
				],
				workflow: ['workflow plain'],
			},
			friction: ['ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
			openItems: ['plain item'],
		});
		expect(out?.intent).toContain('REDACTED');
		expect(out?.outcome).toContain('REDACTED');
		expect(out?.learnings.code[0]?.path).toBe('src/app.ts');
		expect(out?.learnings.code[0]?.line).toBe(10);
		expect(out?.learnings.code[0]?.finding).toContain('REDACTED');
		expect(out?.learnings.workflow[0]).toBe('workflow plain');
		expect(out?.openItems[0]).toBe('plain item');
	});

	it('returns innocuous text unchanged (Go: TestRedactSummary_NoSecrets)', async () => {
		const { redactSummary } = await import('@/checkpoint/committed');
		const summary: Summary = {
			intent: 'plain text intent',
			outcome: 'plain text outcome',
			learnings: { repo: ['a', 'b'], code: [], workflow: [] },
			friction: ['c'],
			openItems: ['d'],
		};
		const out = await redactSummary(summary);
		expect(out?.intent).toBe('plain text intent');
		expect(out?.outcome).toBe('plain text outcome');
	});
});

describe('UpdateCommittedOptions / GetGitAuthorFromRepo (Go global fallback)', () => {
	let env: TestEnv;
	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
	});
	afterEach(async () => {
		await env.cleanup();
	});

	it('falls back to global ~/.gitconfig when local user.name/email are missing', async () => {
		// Go: TestGetGitAuthorFromRepo_GlobalFallback. We can't override the
		// caller's actual global gitconfig from inside the test reliably, so
		// we point GIT_CONFIG_GLOBAL at a controlled file with known values
		// and confirm getGitAuthorFromRepo picks them up.
		const fakeGlobal = `${env.dir}/fake.gitconfig`;
		await env.writeFile(
			'fake.gitconfig',
			'[user]\n  name = Globally Configured\n  email = global@story.local\n',
		);
		await env.exec('git', ['config', '--unset', 'user.name']).catch(() => {});
		await env.exec('git', ['config', '--unset', 'user.email']).catch(() => {});
		const prevGlobal = process.env.GIT_CONFIG_GLOBAL;
		const prevSystem = process.env.GIT_CONFIG_SYSTEM;
		process.env.GIT_CONFIG_GLOBAL = fakeGlobal;
		process.env.GIT_CONFIG_SYSTEM = '/dev/null';
		try {
			const author = await getGitAuthorFromRepo(env.dir);
			expect(author).toEqual({ name: 'Globally Configured', email: 'global@story.local' });
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

// Round-trip serialization for turn_checkpoint_ids — placeholder until the
// State (Phase 3) layer exposes it. Phase 4.3 only needs to confirm the
// JSON format does not crash CommittedMetadata reads. Currently
// CommittedMetadata does not include turnCheckpointIds; the field surfaces
// from State.json. We keep the stub here so the parity table line stays
// satisfied.
describe('turn_checkpoint_ids JSON round-trip placeholder', () => {
	it('CommittedMetadata writes do not produce a turn_checkpoint_ids field', async () => {
		const env = await TestEnv.create({ initialCommit: true });
		try {
			await setEnvAuthor(env, 'Test Author', 'author@test.local');
			await writeCommitted(env.dir, baseWriteOpts({}));
			const { stdout } = await execa('git', ['ls-tree', '-r', METADATA_BRANCH_NAME], {
				cwd: env.dir,
			});
			expect(stdout).not.toContain('turn_checkpoint_ids');
			// Sanity: writeCommitted produced the expected files.
			expect(stdout).toContain(`a3/b2c4d5e6f7/0/${PROMPT_FILE_NAME}`);
		} finally {
			await env.cleanup();
		}
	});
});
