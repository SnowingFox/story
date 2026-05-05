import fsCallback from 'node:fs';
import git from 'isomorphic-git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	COMPACT_TRANSCRIPT_FILE_NAME,
	COMPACT_TRANSCRIPT_HASH_FILE_NAME,
	CONTENT_HASH_FILE_NAME,
	METADATA_FILE_NAME,
	PROMPT_FILE_NAME,
	TRANSCRIPT_FILE_NAME,
	V2_FULL_CURRENT_REF_NAME,
	V2_MAIN_REF_NAME,
	V2_RAW_TRANSCRIPT_FILE_NAME,
	V2_RAW_TRANSCRIPT_HASH_FILE_NAME,
} from '@/checkpoint/constants';
import type {
	CheckpointSummary,
	CommittedMetadata,
	WriteCommittedOptions,
} from '@/checkpoint/types';
import { listArchivedGenerations } from '@/checkpoint/v2-generation';
import { V2GitStore } from '@/checkpoint/v2-store';
import { parseMetadataJSON } from '@/jsonutil';
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
		authorName: 'V2 Author',
		authorEmail: 'v2@test.local',
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
		model: 'claude-sonnet-4',
		turnId: '',
		transcriptIdentifierAtStart: '',
		checkpointTranscriptStart: 0,
		compactTranscriptStart: 7,
		tokenUsage: null,
		sessionMetrics: null,
		initialAttribution: null,
		promptAttributionsJson: null,
		summary: null,
		compactTranscript: ENC.encode('{"role":"compact","content":"summary"}\n'),
		...overrides,
	};
}

async function setEnvAuthor(env: TestEnv, name: string, email: string): Promise<void> {
	await env.exec('git', ['config', 'user.name', name]);
	await env.exec('git', ['config', 'user.email', email]);
}

async function readBlobAt(
	env: TestEnv,
	rootTreeHash: string,
	subpath: string,
): Promise<Uint8Array | null> {
	try {
		const { blob } = await git.readBlob({
			fs: fsCallback,
			dir: env.dir,
			oid: rootTreeHash,
			filepath: subpath,
		});
		return blob;
	} catch {
		return null;
	}
}

async function getRefTree(env: TestEnv, ref: string): Promise<string> {
	const tip = await git.resolveRef({ fs: fsCallback, dir: env.dir, ref });
	const { commit } = await git.readCommit({ fs: fsCallback, dir: env.dir, oid: tip });
	return commit.tree;
}

async function commitCount(env: TestEnv, ref: string): Promise<number> {
	try {
		const tip = await git.resolveRef({ fs: fsCallback, dir: env.dir, ref });
		const log = await git.log({ fs: fsCallback, dir: env.dir, ref: tip });
		return log.length;
	} catch {
		return 0;
	}
}

describe('NewV2GitStore + ref management', () => {
	let env: TestEnv;
	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		await setEnvAuthor(env, 'Test', 'test@test.local');
	});
	afterEach(async () => {
		await env.cleanup();
	});

	it('initializes with default fetch remote "origin" when none supplied', async () => {
		const v2 = new V2GitStore(env.dir);
		expect(v2.fetchRemote).toBe('origin');
		expect(v2.repoDir).toBe(env.dir);
	});

	it('treats empty fetchRemote argument as "origin"', async () => {
		const v2 = new V2GitStore(env.dir, '');
		expect(v2.fetchRemote).toBe('origin');
	});

	it('honours an explicit fetch remote URL', async () => {
		const v2 = new V2GitStore(env.dir, 'https://example.com/repo.git');
		expect(v2.fetchRemote).toBe('https://example.com/repo.git');
	});

	it('ensureRef creates a new orphan ref with empty tree', async () => {
		const v2 = new V2GitStore(env.dir);
		await v2.ensureRef(V2_MAIN_REF_NAME);
		const tip = await git.resolveRef({ fs: fsCallback, dir: env.dir, ref: V2_MAIN_REF_NAME });
		const { commit } = await git.readCommit({ fs: fsCallback, dir: env.dir, oid: tip });
		expect(commit.parent).toEqual([]);
		expect(commit.message).toContain('Initialize v2 ref');
		const tree = await git.readTree({ fs: fsCallback, dir: env.dir, oid: commit.tree });
		expect(tree.tree).toEqual([]);
	});

	it('ensureRef is idempotent for an existing ref (hash unchanged)', async () => {
		const v2 = new V2GitStore(env.dir);
		await v2.ensureRef(V2_MAIN_REF_NAME);
		const tip1 = await git.resolveRef({ fs: fsCallback, dir: env.dir, ref: V2_MAIN_REF_NAME });
		await v2.ensureRef(V2_MAIN_REF_NAME);
		const tip2 = await git.resolveRef({ fs: fsCallback, dir: env.dir, ref: V2_MAIN_REF_NAME });
		expect(tip1).toBe(tip2);
	});

	it('ensureRef handles different ref names independently', async () => {
		const v2 = new V2GitStore(env.dir);
		await v2.ensureRef(V2_MAIN_REF_NAME);
		await v2.ensureRef(V2_FULL_CURRENT_REF_NAME);
		const main = await git.resolveRef({ fs: fsCallback, dir: env.dir, ref: V2_MAIN_REF_NAME });
		const full = await git.resolveRef({
			fs: fsCallback,
			dir: env.dir,
			ref: V2_FULL_CURRENT_REF_NAME,
		});
		// Different timestamps → different commit hashes (even with empty trees).
		expect(main).not.toBe('');
		expect(full).not.toBe('');
	});

	it('getRefState returns parent commit and tree hash for an ensured ref', async () => {
		const v2 = new V2GitStore(env.dir);
		await v2.ensureRef(V2_MAIN_REF_NAME);
		const { parentHash, treeHash } = await v2.getRefState(V2_MAIN_REF_NAME);
		expect(parentHash).toMatch(/^[0-9a-f]{40}$/);
		expect(treeHash).toMatch(/^[0-9a-f]{40}$/);
	});

	it('getRefState errors on a missing ref', async () => {
		const v2 = new V2GitStore(env.dir);
		await expect(v2.getRefState(V2_MAIN_REF_NAME)).rejects.toThrow();
	});
});

describe('writeCommitted — /main side', () => {
	let env: TestEnv;
	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		await setEnvAuthor(env, 'Test', 'test@test.local');
	});
	afterEach(async () => {
		await env.cleanup();
	});

	it('writes session metadata under <id[:2]>/<id[2:]>/0/metadata.json', async () => {
		const v2 = new V2GitStore(env.dir);
		await v2.writeCommitted(baseOpts({}));
		const tree = await getRefTree(env, V2_MAIN_REF_NAME);
		const metaBlob = await readBlobAt(env, tree, 'a3/b2c4d5e6f7/0/metadata.json');
		expect(metaBlob).not.toBeNull();
		// On-disk JSON must be snake_case for Go interop (foundation-backlog
		// #25 fix). Assert the raw text has snake_case keys, then parse via
		// the Go-compatible helper for camelCase TS field access.
		const text = DEC.decode(metaBlob!);
		expect(text).toContain('"session_id": "sess-1"');
		expect(text).not.toContain('"sessionId"');
		const meta = parseMetadataJSON<CommittedMetadata>(text);
		expect(meta.sessionId).toBe('sess-1');
		expect(meta.strategy).toBe('manual-commit');
		expect(meta.agent).toBe('claudecode');
	});

	it('writes prompts file with redacted joined content', async () => {
		const v2 = new V2GitStore(env.dir);
		await v2.writeCommitted(baseOpts({ prompts: ['first prompt', 'second prompt'] }));
		const tree = await getRefTree(env, V2_MAIN_REF_NAME);
		const promptBlob = await readBlobAt(env, tree, `a3/b2c4d5e6f7/0/${PROMPT_FILE_NAME}`);
		expect(promptBlob).not.toBeNull();
		const text = DEC.decode(promptBlob!);
		expect(text).toContain('first prompt');
		expect(text).toContain('second prompt');
	});

	it('excludes raw_transcript / full.jsonl from /main', async () => {
		const v2 = new V2GitStore(env.dir);
		await v2.writeCommitted(baseOpts({}));
		const tree = await getRefTree(env, V2_MAIN_REF_NAME);
		expect(
			await readBlobAt(env, tree, `a3/b2c4d5e6f7/0/${V2_RAW_TRANSCRIPT_FILE_NAME}`),
		).toBeNull();
		expect(await readBlobAt(env, tree, `a3/b2c4d5e6f7/0/${TRANSCRIPT_FILE_NAME}`)).toBeNull();
		expect(await readBlobAt(env, tree, `a3/b2c4d5e6f7/0/${CONTENT_HASH_FILE_NAME}`)).toBeNull();
	});

	it('writes compact transcript + transcript_hash when supplied', async () => {
		const v2 = new V2GitStore(env.dir);
		const compact = ENC.encode('{"compact":true}\n');
		await v2.writeCommitted(baseOpts({ compactTranscript: compact }));
		const tree = await getRefTree(env, V2_MAIN_REF_NAME);
		const compactBlob = await readBlobAt(
			env,
			tree,
			`a3/b2c4d5e6f7/0/${COMPACT_TRANSCRIPT_FILE_NAME}`,
		);
		const hashBlob = await readBlobAt(
			env,
			tree,
			`a3/b2c4d5e6f7/0/${COMPACT_TRANSCRIPT_HASH_FILE_NAME}`,
		);
		expect(compactBlob).not.toBeNull();
		expect(hashBlob).not.toBeNull();
		expect(DEC.decode(compactBlob!)).toBe('{"compact":true}\n');
		expect(DEC.decode(hashBlob!)).toMatch(/^sha256:[0-9a-f]{64}$/);
	});

	it('skips compact transcript when missing (null) — only metadata + prompts written', async () => {
		const v2 = new V2GitStore(env.dir);
		await v2.writeCommitted(baseOpts({ compactTranscript: null }));
		const tree = await getRefTree(env, V2_MAIN_REF_NAME);
		expect(
			await readBlobAt(env, tree, `a3/b2c4d5e6f7/0/${COMPACT_TRANSCRIPT_FILE_NAME}`),
		).toBeNull();
		expect(
			await readBlobAt(env, tree, `a3/b2c4d5e6f7/0/${COMPACT_TRANSCRIPT_HASH_FILE_NAME}`),
		).toBeNull();
		expect(await readBlobAt(env, tree, `a3/b2c4d5e6f7/0/${METADATA_FILE_NAME}`)).not.toBeNull();
	});

	it('records compact_transcript_start in session metadata', async () => {
		const v2 = new V2GitStore(env.dir);
		await v2.writeCommitted(baseOpts({ compactTranscriptStart: 42 }));
		const tree = await getRefTree(env, V2_MAIN_REF_NAME);
		const metaBlob = await readBlobAt(env, tree, 'a3/b2c4d5e6f7/0/metadata.json');
		// On v2 /main, the field NAMED `checkpointTranscriptStart` (TS) /
		// `checkpoint_transcript_start` (on-disk JSON; Go-compatible)
		// SEMANTICALLY tracks the COMPACT transcript starting line.
		const text = DEC.decode(metaBlob!);
		expect(text).toContain('"checkpoint_transcript_start": 42');
		const meta = parseMetadataJSON<CommittedMetadata>(text);
		expect(meta.checkpointTranscriptStart).toBe(42);
	});
});

describe('writeCommitted — multi-session', () => {
	let env: TestEnv;
	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		await setEnvAuthor(env, 'Test', 'test@test.local');
	});
	afterEach(async () => {
		await env.cleanup();
	});

	it('places multiple sessions under /0/, /1/ subdirectories', async () => {
		const v2 = new V2GitStore(env.dir);
		await v2.writeCommitted(baseOpts({ sessionId: 'sess-1' }));
		await v2.writeCommitted(baseOpts({ sessionId: 'sess-2' }));
		const tree = await getRefTree(env, V2_MAIN_REF_NAME);
		const m0 = await readBlobAt(env, tree, 'a3/b2c4d5e6f7/0/metadata.json');
		const m1 = await readBlobAt(env, tree, 'a3/b2c4d5e6f7/1/metadata.json');
		expect(m0).not.toBeNull();
		expect(m1).not.toBeNull();
		expect(parseMetadataJSON<CommittedMetadata>(DEC.decode(m0!)).sessionId).toBe('sess-1');
		expect(parseMetadataJSON<CommittedMetadata>(DEC.decode(m1!)).sessionId).toBe('sess-2');
	});
});

describe('writeCommitted — /full/current side', () => {
	let env: TestEnv;
	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		await setEnvAuthor(env, 'Test', 'test@test.local');
	});
	afterEach(async () => {
		await env.cleanup();
	});

	it('writes raw_transcript + raw_transcript_hash to /full/current', async () => {
		const v2 = new V2GitStore(env.dir);
		const transcript = ENC.encode('{"role":"raw"}\n');
		await v2.writeCommitted(baseOpts({ transcript }));
		const tree = await getRefTree(env, V2_FULL_CURRENT_REF_NAME);
		const rawBlob = await readBlobAt(env, tree, `a3/b2c4d5e6f7/0/${V2_RAW_TRANSCRIPT_FILE_NAME}`);
		const hashBlob = await readBlobAt(
			env,
			tree,
			`a3/b2c4d5e6f7/0/${V2_RAW_TRANSCRIPT_HASH_FILE_NAME}`,
		);
		expect(DEC.decode(rawBlob!)).toBe('{"role":"raw"}\n');
		expect(DEC.decode(hashBlob!)).toMatch(/^sha256:[0-9a-f]{64}$/);
	});

	it('excludes metadata.json / prompt.txt from /full/current', async () => {
		const v2 = new V2GitStore(env.dir);
		await v2.writeCommitted(baseOpts({}));
		const tree = await getRefTree(env, V2_FULL_CURRENT_REF_NAME);
		expect(await readBlobAt(env, tree, `a3/b2c4d5e6f7/0/${METADATA_FILE_NAME}`)).toBeNull();
		expect(await readBlobAt(env, tree, `a3/b2c4d5e6f7/0/${PROMPT_FILE_NAME}`)).toBeNull();
		expect(await readBlobAt(env, tree, 'a3/b2c4d5e6f7/metadata.json')).toBeNull();
	});

	it('is a noop when transcript is empty (and no transcriptPath)', async () => {
		const v2 = new V2GitStore(env.dir);
		await v2.writeCommitted(baseOpts({ transcript: new Uint8Array() }));
		// /full/current should not have been ensured / committed.
		expect(await commitCount(env, V2_FULL_CURRENT_REF_NAME)).toBe(0);
	});

	it('accumulates checkpoints across multiple writes', async () => {
		const v2 = new V2GitStore(env.dir);
		await v2.writeCommitted(baseOpts({ checkpointId: 'aaaaaaaaaaaa' }));
		await v2.writeCommitted(baseOpts({ checkpointId: 'bbbbbbbbbbbb' }));
		const tree = await getRefTree(env, V2_FULL_CURRENT_REF_NAME);
		expect(
			await readBlobAt(env, tree, `aa/aaaaaaaaaa/0/${V2_RAW_TRANSCRIPT_FILE_NAME}`),
		).not.toBeNull();
		expect(
			await readBlobAt(env, tree, `bb/bbbbbbbbbb/0/${V2_RAW_TRANSCRIPT_FILE_NAME}`),
		).not.toBeNull();
	});
});

describe('writeCommitted — dual-write semantics', () => {
	let env: TestEnv;
	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		await setEnvAuthor(env, 'Test', 'test@test.local');
	});
	afterEach(async () => {
		env.cleanup();
	});

	it('writes both /main and /full/current commits (one per ref)', async () => {
		const v2 = new V2GitStore(env.dir);
		await v2.writeCommitted(baseOpts({}));
		expect(await commitCount(env, V2_MAIN_REF_NAME)).toBe(2); // ensureRef + checkpoint
		expect(await commitCount(env, V2_FULL_CURRENT_REF_NAME)).toBe(2);
	});

	it('writes only /main when transcript is empty', async () => {
		const v2 = new V2GitStore(env.dir);
		await v2.writeCommitted(baseOpts({ transcript: new Uint8Array() }));
		expect(await commitCount(env, V2_MAIN_REF_NAME)).toBe(2);
		expect(await commitCount(env, V2_FULL_CURRENT_REF_NAME)).toBe(0);
	});

	it('keeps the same session index across /main and /full/current', async () => {
		const v2 = new V2GitStore(env.dir);
		await v2.writeCommitted(baseOpts({ sessionId: 'sess-1' }));
		await v2.writeCommitted(baseOpts({ sessionId: 'sess-2' }));

		const mainTree = await getRefTree(env, V2_MAIN_REF_NAME);
		const fullTree = await getRefTree(env, V2_FULL_CURRENT_REF_NAME);
		// Both /0 and /1 sessions should exist on both refs.
		expect(await readBlobAt(env, mainTree, 'a3/b2c4d5e6f7/0/metadata.json')).not.toBeNull();
		expect(await readBlobAt(env, mainTree, 'a3/b2c4d5e6f7/1/metadata.json')).not.toBeNull();
		expect(
			await readBlobAt(env, fullTree, `a3/b2c4d5e6f7/0/${V2_RAW_TRANSCRIPT_FILE_NAME}`),
		).not.toBeNull();
		expect(
			await readBlobAt(env, fullTree, `a3/b2c4d5e6f7/1/${V2_RAW_TRANSCRIPT_FILE_NAME}`),
		).not.toBeNull();
	});
});

describe('updateCommitted — dual updates', () => {
	let env: TestEnv;
	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		await setEnvAuthor(env, 'Test', 'test@test.local');
	});
	afterEach(async () => {
		env.cleanup();
	});

	it('updates both /main and /full/current with the new transcript + compact transcript', async () => {
		const v2 = new V2GitStore(env.dir);
		await v2.writeCommitted(baseOpts({}));

		const newRaw = ENC.encode('{"updated":"raw"}\n');
		const newCompact = ENC.encode('{"updated":"compact"}\n');
		await v2.updateCommitted({
			checkpointId: 'a3b2c4d5e6f7',
			sessionId: 'sess-1',
			transcript: newRaw,
			prompts: ['updated prompt'],
			agent: 'claudecode',
			compactTranscript: newCompact,
		});

		const mainTree = await getRefTree(env, V2_MAIN_REF_NAME);
		const fullTree = await getRefTree(env, V2_FULL_CURRENT_REF_NAME);
		const compact = await readBlobAt(
			env,
			mainTree,
			`a3/b2c4d5e6f7/0/${COMPACT_TRANSCRIPT_FILE_NAME}`,
		);
		const raw = await readBlobAt(env, fullTree, `a3/b2c4d5e6f7/0/${V2_RAW_TRANSCRIPT_FILE_NAME}`);
		expect(DEC.decode(compact!)).toBe('{"updated":"compact"}\n');
		expect(DEC.decode(raw!)).toBe('{"updated":"raw"}\n');
	});

	it('only updates /main when transcript is empty', async () => {
		const v2 = new V2GitStore(env.dir);
		await v2.writeCommitted(baseOpts({}));

		const fullCommitsBefore = await commitCount(env, V2_FULL_CURRENT_REF_NAME);
		await v2.updateCommitted({
			checkpointId: 'a3b2c4d5e6f7',
			sessionId: 'sess-1',
			transcript: new Uint8Array(),
			prompts: ['only-prompt'],
			agent: 'claudecode',
			compactTranscript: null,
		});

		expect(await commitCount(env, V2_FULL_CURRENT_REF_NAME)).toBe(fullCommitsBefore);
	});

	it('errors with ErrCheckpointNotFound for a missing checkpoint', async () => {
		const v2 = new V2GitStore(env.dir);
		await v2.writeCommitted(baseOpts({}));
		await expect(
			v2.updateCommitted({
				checkpointId: 'deadbeefcafe',
				sessionId: 'sess-1',
				transcript: ENC.encode('hi'),
				prompts: [],
				agent: 'claudecode',
				compactTranscript: null,
			}),
		).rejects.toThrow(/checkpoint not found/);
	});

	it('preserves task subagent metadata in /full/current after an update', async () => {
		// Seed /full/current with the standard write, then add a sibling
		// task-style file at the session path so we can prove it survives
		// the transcript replacement.
		const v2 = new V2GitStore(env.dir);
		await v2.writeCommitted(baseOpts({}));

		// Inject a task metadata blob directly into /full/current via tree
		// surgery — this models what a downstream task-checkpoint write
		// would have left behind.
		const taskBlob = await git.writeBlob({
			fs: fsCallback,
			dir: env.dir,
			blob: ENC.encode('task metadata payload'),
		});
		const fullTip = await git.resolveRef({
			fs: fsCallback,
			dir: env.dir,
			ref: V2_FULL_CURRENT_REF_NAME,
		});
		const { commit: fullCommit } = await git.readCommit({
			fs: fsCallback,
			dir: env.dir,
			oid: fullTip,
		});
		// Build the new tree: add a `task.json` blob alongside raw_transcript
		// at sessionPath.
		const sessionTree = await git.readTree({
			fs: fsCallback,
			dir: env.dir,
			oid: fullCommit.tree,
			filepath: 'a3/b2c4d5e6f7/0',
		});
		const updatedSession = await git.writeTree({
			fs: fsCallback,
			dir: env.dir,
			tree: [
				...sessionTree.tree,
				{ mode: '100644', path: 'task.json', oid: taskBlob, type: 'blob' },
			],
		});
		// Re-attach into the parent tree.
		const cpTree = await git.readTree({
			fs: fsCallback,
			dir: env.dir,
			oid: fullCommit.tree,
			filepath: 'a3/b2c4d5e6f7',
		});
		const cpEntries = cpTree.tree.map((e) =>
			e.path === '0'
				? { ...e, oid: updatedSession }
				: { mode: e.mode, path: e.path, oid: e.oid, type: e.type },
		);
		const newCpTree = await git.writeTree({ fs: fsCallback, dir: env.dir, tree: cpEntries });
		const bucket = await git.readTree({
			fs: fsCallback,
			dir: env.dir,
			oid: fullCommit.tree,
			filepath: 'a3',
		});
		const bucketEntries = bucket.tree.map((e) =>
			e.path === 'b2c4d5e6f7'
				? { ...e, oid: newCpTree }
				: { mode: e.mode, path: e.path, oid: e.oid, type: e.type },
		);
		const newBucketTree = await git.writeTree({
			fs: fsCallback,
			dir: env.dir,
			tree: bucketEntries,
		});
		const root = await git.readTree({ fs: fsCallback, dir: env.dir, oid: fullCommit.tree });
		const rootEntries = root.tree.map((e) =>
			e.path === 'a3'
				? { ...e, oid: newBucketTree }
				: { mode: e.mode, path: e.path, oid: e.oid, type: e.type },
		);
		const newRoot = await git.writeTree({ fs: fsCallback, dir: env.dir, tree: rootEntries });
		const newCommit = await git.writeCommit({
			fs: fsCallback,
			dir: env.dir,
			commit: {
				message: 'inject task',
				tree: newRoot,
				parent: [fullTip],
				author: {
					name: 'T',
					email: 't@t',
					timestamp: Math.floor(Date.now() / 1000),
					timezoneOffset: 0,
				},
				committer: {
					name: 'T',
					email: 't@t',
					timestamp: Math.floor(Date.now() / 1000),
					timezoneOffset: 0,
				},
			},
		});
		await git.writeRef({
			fs: fsCallback,
			dir: env.dir,
			ref: V2_FULL_CURRENT_REF_NAME,
			value: newCommit,
			force: true,
		});

		// Now update — task.json must still be there afterwards.
		await v2.updateCommitted({
			checkpointId: 'a3b2c4d5e6f7',
			sessionId: 'sess-1',
			transcript: ENC.encode('{"updated":"raw"}\n'),
			prompts: [],
			agent: 'claudecode',
			compactTranscript: null,
		});

		const fullTree = await getRefTree(env, V2_FULL_CURRENT_REF_NAME);
		const survived = await readBlobAt(env, fullTree, 'a3/b2c4d5e6f7/0/task.json');
		expect(survived).not.toBeNull();
		expect(DEC.decode(survived!)).toBe('task metadata payload');
	});
});

describe('writeCommitted — generation rotation', () => {
	let env: TestEnv;
	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		await setEnvAuthor(env, 'Test', 'test@test.local');
	});
	afterEach(async () => {
		env.cleanup();
	});

	it('triggers rotation once the threshold is crossed (max=2 → 2nd write archives)', async () => {
		const v2 = new V2GitStore(env.dir);
		v2.maxCheckpointsPerGeneration = 2;
		// 1st write: count → 1, no rotation.
		await v2.writeCommitted(baseOpts({ checkpointId: 'aaaaaaaaaaaa' }));
		// 2nd write: count → 2 (== threshold) → rotation runs after the
		// write completes. Both checkpoints land in archive 1; /full/current
		// resets to an empty orphan.
		await v2.writeCommitted(baseOpts({ checkpointId: 'bbbbbbbbbbbb' }));
		const archived = await listArchivedGenerations(v2);
		expect(archived).toEqual(['0000000000001']);
		const tree = await getRefTree(env, V2_FULL_CURRENT_REF_NAME);
		const root = await git.readTree({ fs: fsCallback, dir: env.dir, oid: tree });
		expect(root.tree).toEqual([]);
		// Confirm the archive contains both checkpoints by looking at the archived ref.
		const archiveTip = await git.resolveRef({
			fs: fsCallback,
			dir: env.dir,
			ref: 'refs/story/checkpoints/v2/full/0000000000001',
		});
		const { commit: archiveCommit } = await git.readCommit({
			fs: fsCallback,
			dir: env.dir,
			oid: archiveTip,
		});
		const archiveRoot = await git.readTree({
			fs: fsCallback,
			dir: env.dir,
			oid: archiveCommit.tree,
		});
		const shardNames = archiveRoot.tree.filter((e) => e.type === 'tree').map((e) => e.path);
		expect(shardNames).toEqual(expect.arrayContaining(['aa', 'bb']));
	});

	it('does not rotate below the threshold', async () => {
		const v2 = new V2GitStore(env.dir);
		v2.maxCheckpointsPerGeneration = 5;
		await v2.writeCommitted(baseOpts({ checkpointId: 'aaaaaaaaaaaa' }));
		await v2.writeCommitted(baseOpts({ checkpointId: 'bbbbbbbbbbbb' }));
		const archived = await listArchivedGenerations(v2);
		expect(archived).toEqual([]);
	});
});

describe('updateCheckpointSummary + updateSummary error paths', () => {
	let env: TestEnv;
	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		await setEnvAuthor(env, 'Test', 'test@test.local');
	});
	afterEach(async () => env.cleanup());

	it('updateSummary errors when /main ref has not been initialised', async () => {
		const v2 = new V2GitStore(env.dir);
		// No writeCommitted yet → no /main ref. updateSummary surfaces
		// ErrCheckpointNotFound instead of an isomorphic-git "ref not found".
		await expect(v2.updateSummary('a3b2c4d5e6f7', null)).rejects.toThrow(/checkpoint not found/);
	});

	it('updateCheckpointSummary errors when /main ref has not been initialised', async () => {
		const v2 = new V2GitStore(env.dir);
		await expect(v2.updateCheckpointSummary('a3b2c4d5e6f7', null)).rejects.toThrow(
			/checkpoint not found/,
		);
	});

	it('updateCheckpointSummary errors when the checkpoint is missing on /main', async () => {
		const v2 = new V2GitStore(env.dir);
		await v2.writeCommitted(baseOpts({}));
		await expect(v2.updateCheckpointSummary('deadbeefcafe', null)).rejects.toThrow(
			/checkpoint not found/,
		);
	});

	it('updateCommitted falls back to latest session when sessionId does not match any session', async () => {
		const v2 = new V2GitStore(env.dir);
		await v2.writeCommitted(baseOpts({ sessionId: 'sess-1' }));
		await v2.writeCommitted(baseOpts({ sessionId: 'sess-2' }));
		// Pass a sessionId that doesn't exist; updateCommitted falls back
		// to the latest (index 1).
		await v2.updateCommitted({
			checkpointId: 'a3b2c4d5e6f7',
			sessionId: 'no-such-session',
			transcript: ENC.encode('updated raw'),
			prompts: [],
			agent: 'claudecode',
			compactTranscript: ENC.encode('updated compact'),
		});
		// Index 1 should now have the new compact transcript.
		const tree = await getRefTree(env, V2_MAIN_REF_NAME);
		const compact = await readBlobAt(env, tree, `a3/b2c4d5e6f7/1/${COMPACT_TRANSCRIPT_FILE_NAME}`);
		expect(DEC.decode(compact!)).toBe('updated compact');
	});
});

describe('writeCommitted — root summary aggregation', () => {
	let env: TestEnv;
	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		await setEnvAuthor(env, 'Test', 'test@test.local');
	});
	afterEach(async () => {
		env.cleanup();
	});

	it('writes a CheckpointSummary at <id[:2]>/<id[2:]>/metadata.json with one session entry', async () => {
		const v2 = new V2GitStore(env.dir);
		await v2.writeCommitted(baseOpts({}));
		const tree = await getRefTree(env, V2_MAIN_REF_NAME);
		const summaryBlob = await readBlobAt(env, tree, 'a3/b2c4d5e6f7/metadata.json');
		expect(summaryBlob).not.toBeNull();
		// On-disk JSON must be Go-compatible snake_case (foundation-backlog
		// #25 fix); parse via the helper for camelCase TS field access.
		const text = DEC.decode(summaryBlob!);
		expect(text).toContain('"checkpoint_id": "a3b2c4d5e6f7"');
		const summary = parseMetadataJSON<CheckpointSummary>(text);
		expect(summary.checkpointId).toBe('a3b2c4d5e6f7');
		expect(summary.sessions).toHaveLength(1);
	});
});
