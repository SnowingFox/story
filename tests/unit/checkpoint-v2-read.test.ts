import fsCallback from 'node:fs';
import git from 'isomorphic-git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ErrCheckpointNotFound, ErrNoTranscript } from '@/checkpoint/committed';
import { V2_FULL_CURRENT_REF_NAME, V2_MAIN_REF_NAME } from '@/checkpoint/constants';
import type { Summary, WriteCommittedOptions } from '@/checkpoint/types';
import { V2GitStore } from '@/checkpoint/v2-store';
import { TestEnv } from '../helpers/test-env';

const ENC = new TextEncoder();
const DEC = new TextDecoder();

function baseOpts(overrides: Partial<WriteCommittedOptions>): WriteCommittedOptions {
	return {
		checkpointId: 'a3b2c4d5e6f7',
		sessionId: 'sess-1',
		strategy: 'manual-commit',
		branch: 'main',
		transcript: ENC.encode('{"role":"raw"}\n'),
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
		compactTranscriptStart: 0,
		tokenUsage: null,
		sessionMetrics: null,
		initialAttribution: null,
		promptAttributionsJson: null,
		summary: null,
		compactTranscript: ENC.encode('{"compact":true}\n'),
		...overrides,
	};
}

async function setEnvAuthor(env: TestEnv, name: string, email: string): Promise<void> {
	await env.exec('git', ['config', 'user.name', name]);
	await env.exec('git', ['config', 'user.email', email]);
}

describe('readCommitted', () => {
	let env: TestEnv;
	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		await setEnvAuthor(env, 'Test', 'test@test.local');
	});
	afterEach(async () => env.cleanup());

	it('returns the CheckpointSummary written via writeCommitted', async () => {
		const v2 = new V2GitStore(env.dir);
		await v2.writeCommitted(baseOpts({}));
		const summary = await v2.readCommitted('a3b2c4d5e6f7');
		expect(summary).not.toBeNull();
		expect(summary?.checkpointId).toBe('a3b2c4d5e6f7');
		expect(summary?.sessions).toHaveLength(1);
	});

	it('returns null for a missing checkpoint (no error)', async () => {
		const v2 = new V2GitStore(env.dir);
		await v2.writeCommitted(baseOpts({}));
		const summary = await v2.readCommitted('deadbeefcafe');
		expect(summary).toBeNull();
	});
});

describe('readSessionContent', () => {
	let env: TestEnv;
	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		await setEnvAuthor(env, 'Test', 'test@test.local');
	});
	afterEach(async () => env.cleanup());

	it('returns metadata + raw transcript for a freshly-written checkpoint', async () => {
		const v2 = new V2GitStore(env.dir);
		const transcript = ENC.encode('{"role":"raw","content":"hello"}\n');
		await v2.writeCommitted(baseOpts({ transcript }));
		const content = await v2.readSessionContent('a3b2c4d5e6f7', 0);
		expect(content).not.toBeNull();
		expect(content?.metadata.sessionId).toBe('sess-1');
		expect(DEC.decode(content!.transcript)).toBe('{"role":"raw","content":"hello"}\n');
	});

	it('reads transcript from an archived generation after rotation', async () => {
		const v2 = new V2GitStore(env.dir);
		v2.maxCheckpointsPerGeneration = 2;
		await v2.writeCommitted(baseOpts({ checkpointId: 'aaaaaaaaaaaa' }));
		await v2.writeCommitted(baseOpts({ checkpointId: 'bbbbbbbbbbbb' }));
		// Rotation has now archived both. /full/current is empty; the raw
		// transcript for either checkpoint must come from the archive.
		const content = await v2.readSessionContent('aaaaaaaaaaaa', 0);
		expect(content).not.toBeNull();
		expect(content?.transcript.length).toBeGreaterThan(0);
	});

	it('throws ErrNoTranscript when raw transcript is missing for an existing checkpoint', async () => {
		const v2 = new V2GitStore(env.dir);
		await v2.writeCommitted(baseOpts({ transcript: new Uint8Array() }));
		await expect(v2.readSessionContent('a3b2c4d5e6f7', 0)).rejects.toThrow(ErrNoTranscript);
	});

	it('reassembles a chunked raw transcript across raw_transcript + .001 chunks', async () => {
		const v2 = new V2GitStore(env.dir);
		// Hand-build a /full/current tree containing two chunk blobs at the
		// session path so we don't have to allocate a 50 MB buffer just to
		// exercise the reassembly branch.
		await v2.writeCommitted(baseOpts({ transcript: ENC.encode('placeholder') }));

		const tip = await git.resolveRef({
			fs: fsCallback,
			dir: env.dir,
			ref: V2_FULL_CURRENT_REF_NAME,
		});
		// Build session subtree with raw_transcript (chunk 0) and
		// raw_transcript.001 (chunk 1) blobs explicitly.
		const chunk0 = await git.writeBlob({
			fs: fsCallback,
			dir: env.dir,
			blob: ENC.encode('part-zero\n'),
		});
		const chunk1 = await git.writeBlob({
			fs: fsCallback,
			dir: env.dir,
			blob: ENC.encode('part-one\n'),
		});
		const sessionTree = await git.writeTree({
			fs: fsCallback,
			dir: env.dir,
			tree: [
				{ mode: '100644', path: 'raw_transcript', oid: chunk0, type: 'blob' },
				{ mode: '100644', path: 'raw_transcript.001', oid: chunk1, type: 'blob' },
			],
		});
		const cpTree = await git.writeTree({
			fs: fsCallback,
			dir: env.dir,
			tree: [{ mode: '040000', path: '0', oid: sessionTree, type: 'tree' }],
		});
		const bucketTree = await git.writeTree({
			fs: fsCallback,
			dir: env.dir,
			tree: [{ mode: '040000', path: 'b2c4d5e6f7', oid: cpTree, type: 'tree' }],
		});
		const rootTree = await git.writeTree({
			fs: fsCallback,
			dir: env.dir,
			tree: [{ mode: '040000', path: 'a3', oid: bucketTree, type: 'tree' }],
		});
		const author = {
			name: 'T',
			email: 't@t',
			timestamp: Math.floor(Date.now() / 1000),
			timezoneOffset: 0,
		};
		const newCommit = await git.writeCommit({
			fs: fsCallback,
			dir: env.dir,
			commit: {
				message: 'chunked',
				tree: rootTree,
				parent: [tip],
				author,
				committer: author,
			},
		});
		await git.writeRef({
			fs: fsCallback,
			dir: env.dir,
			ref: V2_FULL_CURRENT_REF_NAME,
			value: newCommit,
			force: true,
		});

		// Make sure /main still points at a3b2c4d5e6f7 with the original
		// session metadata; readSessionContent reuses it for metadata.
		const content = await v2.readSessionContent('a3b2c4d5e6f7', 0);
		expect(content).not.toBeNull();
		expect(DEC.decode(content!.transcript)).toBe('part-zero\npart-one\n');
	});
});

describe('readSessionMetadataAndPrompts', () => {
	let env: TestEnv;
	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		await setEnvAuthor(env, 'Test', 'test@test.local');
	});
	afterEach(async () => env.cleanup());

	it('returns metadata + prompts (and compact transcript) without touching /full/*', async () => {
		const v2 = new V2GitStore(env.dir);
		await v2.writeCommitted(baseOpts({ prompts: ['p1', 'p2'] }));
		const result = await v2.readSessionMetadataAndPrompts('a3b2c4d5e6f7', 0);
		expect(result).not.toBeNull();
		expect(result?.metadata.sessionId).toBe('sess-1');
		expect(result?.prompts).toContain('p1');
		// Compact transcript is bundled with /main; raw is not loaded.
		expect(result?.transcript.length).toBeGreaterThan(0);
	});

	it('throws ErrCheckpointNotFound when the checkpoint does not exist', async () => {
		const v2 = new V2GitStore(env.dir);
		await v2.ensureRef(V2_MAIN_REF_NAME);
		await expect(v2.readSessionMetadataAndPrompts('deadbeefcafe', 0)).rejects.toThrow(
			ErrCheckpointNotFound,
		);
	});
});

describe('readSessionCompactTranscript', () => {
	let env: TestEnv;
	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		await setEnvAuthor(env, 'Test', 'test@test.local');
	});
	afterEach(async () => env.cleanup());

	it('returns the compact transcript bytes for an existing session', async () => {
		const v2 = new V2GitStore(env.dir);
		const compact = ENC.encode('{"compact":"v2"}\n');
		await v2.writeCommitted(baseOpts({ compactTranscript: compact }));
		const got = await v2.readSessionCompactTranscript('a3b2c4d5e6f7', 0);
		expect(got).not.toBeNull();
		expect(DEC.decode(got!)).toBe('{"compact":"v2"}\n');
	});

	it('throws ErrNoTranscript when compact transcript was not written', async () => {
		const v2 = new V2GitStore(env.dir);
		await v2.writeCommitted(baseOpts({ compactTranscript: null }));
		await expect(v2.readSessionCompactTranscript('a3b2c4d5e6f7', 0)).rejects.toThrow(
			ErrNoTranscript,
		);
	});

	it('throws ErrCheckpointNotFound when the checkpoint or session is missing', async () => {
		const v2 = new V2GitStore(env.dir);
		await v2.ensureRef(V2_MAIN_REF_NAME);
		await expect(v2.readSessionCompactTranscript('deadbeefcafe', 0)).rejects.toThrow(
			ErrCheckpointNotFound,
		);
	});
});

describe('updateSummary', () => {
	let env: TestEnv;
	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		await setEnvAuthor(env, 'Test', 'test@test.local');
	});
	afterEach(async () => env.cleanup());

	it('persists Summary fields onto the latest session metadata (with redaction)', async () => {
		const v2 = new V2GitStore(env.dir);
		await v2.writeCommitted(baseOpts({}));
		const summary: Summary = {
			intent: 'add login',
			outcome: 'shipped login flow',
			learnings: { repo: ['monorepo'], code: [], workflow: [] },
			friction: [],
			openItems: [],
		};
		await v2.updateSummary('a3b2c4d5e6f7', summary);
		const content = await v2.readSessionMetadataAndPrompts('a3b2c4d5e6f7', 0);
		expect(content?.metadata.summary?.intent).toBe('add login');
		expect(content?.metadata.summary?.outcome).toBe('shipped login flow');
	});

	it('throws ErrCheckpointNotFound when the checkpoint does not exist', async () => {
		const v2 = new V2GitStore(env.dir);
		await v2.ensureRef(V2_MAIN_REF_NAME);
		await expect(v2.updateSummary('deadbeefcafe', null)).rejects.toThrow(ErrCheckpointNotFound);
	});
});

describe('listCommitted + getSessionLog', () => {
	let env: TestEnv;
	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		await setEnvAuthor(env, 'Test', 'test@test.local');
	});
	afterEach(async () => env.cleanup());

	it('listCommitted returns entries sorted newest-first by createdAt', async () => {
		const v2 = new V2GitStore(env.dir);
		await v2.writeCommitted(baseOpts({ checkpointId: 'aaaaaaaaaaaa' }));
		// Force a different timestamp by waiting >1 second so createdAt differs.
		await new Promise((resolve) => setTimeout(resolve, 1100));
		await v2.writeCommitted(baseOpts({ checkpointId: 'bbbbbbbbbbbb' }));

		const list = await v2.listCommitted();
		expect(list).toHaveLength(2);
		expect(list[0]!.checkpointId).toBe('bbbbbbbbbbbb');
		expect(list[1]!.checkpointId).toBe('aaaaaaaaaaaa');
	});

	it('getSessionLog returns transcript + sessionId for the latest session', async () => {
		const v2 = new V2GitStore(env.dir);
		await v2.writeCommitted(baseOpts({}));
		const log = await v2.getSessionLog('a3b2c4d5e6f7');
		expect(log).not.toBeNull();
		expect(log?.sessionId).toBe('sess-1');
		expect(log?.transcript.length).toBeGreaterThan(0);
	});
});

describe('getCheckpointAuthor', () => {
	let env: TestEnv;
	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		await setEnvAuthor(env, 'Test', 'test@test.local');
	});
	afterEach(async () => env.cleanup());

	it('returns the author used to write the /main commit', async () => {
		const v2 = new V2GitStore(env.dir);
		await v2.writeCommitted(baseOpts({ authorName: 'Alice', authorEmail: 'alice@example.com' }));
		const author = await v2.getCheckpointAuthor('a3b2c4d5e6f7');
		expect(author).toEqual({ name: 'Alice', email: 'alice@example.com' });
	});

	it('returns empty author when the checkpoint cannot be found', async () => {
		const v2 = new V2GitStore(env.dir);
		await v2.writeCommitted(baseOpts({}));
		const author = await v2.getCheckpointAuthor('deadbeefcafe');
		expect(author).toEqual({ name: '', email: '' });
	});
});

describe('class-method coverage (delegation surface)', () => {
	let env: TestEnv;
	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		await setEnvAuthor(env, 'Test', 'test@test.local');
	});
	afterEach(async () => env.cleanup());

	it('class.getTranscript returns the latest session transcript bytes', async () => {
		const v2 = new V2GitStore(env.dir);
		await v2.writeCommitted(baseOpts({}));
		const t = await v2.getTranscript('a3b2c4d5e6f7');
		expect(t).not.toBeNull();
		expect(t!.length).toBeGreaterThan(0);
	});

	it('class.getTranscript throws when latest session has zero-length transcript (empty raw)', async () => {
		// Force readSessionContent to surface a populated metadata + empty
		// transcript via a manual fixture: write a checkpoint, then prune
		// /full/current's raw_transcript blob entry.
		const v2 = new V2GitStore(env.dir);
		await v2.writeCommitted(baseOpts({}));
		// Reach into /full/current and rewrite the session subtree without
		// the raw_transcript blob.
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
		// Strip everything → empty root.
		const emptyTree = await git.writeTree({ fs: fsCallback, dir: env.dir, tree: [] });
		const author = {
			name: 'T',
			email: 't@t',
			timestamp: Math.floor(Date.now() / 1000),
			timezoneOffset: 0,
		};
		const newCommit = await git.writeCommit({
			fs: fsCallback,
			dir: env.dir,
			commit: {
				message: 'strip raw',
				tree: emptyTree,
				parent: [fullCommit.tree],
				author,
				committer: author,
			},
		});
		await git.writeRef({
			fs: fsCallback,
			dir: env.dir,
			ref: V2_FULL_CURRENT_REF_NAME,
			value: newCommit,
			force: true,
		});

		// readSessionContent now hits the "no raw transcript" branch and
		// throws ErrNoTranscript inside readLatestSessionContent → bubbles up.
		await expect(v2.getTranscript('a3b2c4d5e6f7')).rejects.toThrow(ErrNoTranscript);
	});

	it('class.readSessionContentById returns the matching session', async () => {
		const v2 = new V2GitStore(env.dir);
		await v2.writeCommitted(baseOpts({ sessionId: 'sess-A' }));
		await v2.writeCommitted(baseOpts({ sessionId: 'sess-B' }));
		const result = await v2.readSessionContentById('a3b2c4d5e6f7', 'sess-A');
		expect(result).not.toBeNull();
		expect(result?.metadata.sessionId).toBe('sess-A');
	});

	it('class.readSessionContentById throws when the sessionId is unknown', async () => {
		const v2 = new V2GitStore(env.dir);
		await v2.writeCommitted(baseOpts({ sessionId: 'sess-A' }));
		await expect(v2.readSessionContentById('a3b2c4d5e6f7', 'not-here')).rejects.toThrow(
			/not found in checkpoint/,
		);
	});

	it('class.readLatestSessionContent + class.readSessionMetadata round-trip', async () => {
		const v2 = new V2GitStore(env.dir);
		await v2.writeCommitted(baseOpts({}));
		const latest = await v2.readLatestSessionContent('a3b2c4d5e6f7');
		expect(latest?.metadata.sessionId).toBe('sess-1');
		const meta = await v2.readSessionMetadata('a3b2c4d5e6f7', 0);
		expect(meta?.sessionId).toBe('sess-1');
	});

	it('class.readGeneration / readGenerationFromRef / countCheckpointsInTree / listArchivedGenerations all work', async () => {
		const v2 = new V2GitStore(env.dir);
		await v2.writeCommitted(baseOpts({}));
		// Generation methods on /full/current — empty since no rotation.
		const tip = await git.resolveRef({
			fs: fsCallback,
			dir: env.dir,
			ref: V2_FULL_CURRENT_REF_NAME,
		});
		const { commit } = await git.readCommit({ fs: fsCallback, dir: env.dir, oid: tip });
		const gen = await v2.readGeneration(commit.tree);
		// /full/current has no generation.json → zero-value.
		expect(gen).toEqual({ oldestCheckpointAt: '', newestCheckpointAt: '' });
		const fromRef = await v2.readGenerationFromRef(V2_FULL_CURRENT_REF_NAME);
		expect(fromRef).toEqual({ oldestCheckpointAt: '', newestCheckpointAt: '' });
		const count = await v2.countCheckpointsInTree(commit.tree);
		expect(count).toBe(1);
		const archived = await v2.listArchivedGenerations();
		expect(archived).toEqual([]);
	});

	it('class.updateCheckpointSummary updates the combinedAttribution field', async () => {
		const v2 = new V2GitStore(env.dir);
		await v2.writeCommitted(baseOpts({}));
		const attribution = {
			calculatedAt: '2026-04-17T00:00:00Z',
			agentLines: 100,
			agentRemoved: 0,
			humanAdded: 50,
			humanModified: 0,
			humanRemoved: 0,
			totalCommitted: 150,
			totalLinesChanged: 150,
			agentPercentage: 67,
			metricVersion: 2,
		};
		await v2.updateCheckpointSummary('a3b2c4d5e6f7', attribution);
		const summary = await v2.readCommitted('a3b2c4d5e6f7');
		expect(summary?.combinedAttribution?.agentLines).toBe(100);
	});
});

describe('readTranscriptFromFullRefs — remote fetch fallback', () => {
	let env: TestEnv;
	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		await setEnvAuthor(env, 'Test', 'test@test.local');
	});
	afterEach(async () => env.cleanup());

	it('uses git fetch from store.fetchRemote when /full/* is not local', async () => {
		// Two-repo fixture: origin has a fresh v2 checkpoint, local clones
		// without v2 refs and tries to read the raw transcript.
		const origin = env;
		const v2Origin = new V2GitStore(origin.dir);
		await v2Origin.writeCommitted(baseOpts({}));

		const local = await origin.cloneTo();
		try {
			// Configure `origin` as the remote on the clone (cloneTo sets it
			// up by default — verify quickly).
			await local.exec('git', ['config', 'user.name', 'L']);
			await local.exec('git', ['config', 'user.email', 'l@l.local']);
			// Local does NOT have refs/story/checkpoints/v2/* yet — clone's
			// default refspec only pulls heads. Confirm by trying to read.
			const v2Local = new V2GitStore(local.dir);
			// readSessionContent first asks /main; since /main isn't local
			// either, this throws ErrCheckpointNotFound — to exercise the
			// /full fetch path, copy /main first.
			await local.exec('git', ['fetch', 'origin', `+${V2_MAIN_REF_NAME}:${V2_MAIN_REF_NAME}`]);
			// Now /main is local but /full/current is not. readSessionContent
			// must fetch /full/* refs from origin to read the raw transcript.
			const content = await v2Local.readSessionContent('a3b2c4d5e6f7', 0);
			expect(content).not.toBeNull();
			expect(content?.transcript.length).toBeGreaterThan(0);
		} finally {
			await local.cleanup();
		}
	});

	it('returns null when fetchRemote yields no /full/* refs at all', async () => {
		// Local has /main but origin has no /full/* refs (we strip them).
		const v2 = new V2GitStore(env.dir);
		await v2.writeCommitted(baseOpts({}));
		// Clone, then strip all v2 full refs from local.
		const local = await env.cloneTo();
		try {
			await local.exec('git', ['fetch', 'origin', `+${V2_MAIN_REF_NAME}:${V2_MAIN_REF_NAME}`]);
			// Origin has /full/current too; remove it so the fetch finds nothing.
			await env.exec('git', ['update-ref', '-d', V2_FULL_CURRENT_REF_NAME]);
			const v2Local = new V2GitStore(local.dir);
			await expect(v2Local.readSessionContent('a3b2c4d5e6f7', 0)).rejects.toThrow(ErrNoTranscript);
		} finally {
			await local.cleanup();
		}
	});
});

// Sanity check: a v2 read should never accidentally consult the /main ref's
// raw transcript layout (regression guard for the v1/v2 file-name overlap).
describe('error / fallback paths', () => {
	let env: TestEnv;
	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		await setEnvAuthor(env, 'Test', 'test@test.local');
	});
	afterEach(async () => env.cleanup());

	it('readCommitted returns null when /main exists but the checkpoint subtree is missing', async () => {
		const v2 = new V2GitStore(env.dir);
		await v2.ensureRef(V2_MAIN_REF_NAME);
		const summary = await v2.readCommitted('a3b2c4d5e6f7');
		expect(summary).toBeNull();
	});

	it('listCommitted returns [] when /main is uninitialised', async () => {
		const v2 = new V2GitStore(env.dir);
		const list = await v2.listCommitted();
		expect(list).toEqual([]);
	});

	it('listCommitted returns [] when /main exists but empty', async () => {
		const v2 = new V2GitStore(env.dir);
		await v2.ensureRef(V2_MAIN_REF_NAME);
		const list = await v2.listCommitted();
		expect(list).toEqual([]);
	});

	it('readSessionContent throws ErrCheckpointNotFound when only /main exists but no checkpoint shard', async () => {
		const v2 = new V2GitStore(env.dir);
		await v2.ensureRef(V2_MAIN_REF_NAME);
		await expect(v2.readSessionContent('a3b2c4d5e6f7', 0)).rejects.toThrow(ErrCheckpointNotFound);
	});

	it('readSessionContent throws when sessionIndex points at a non-existent session subtree', async () => {
		const v2 = new V2GitStore(env.dir);
		await v2.writeCommitted(baseOpts({}));
		// Session 0 exists; session 99 does not.
		await expect(v2.readSessionContent('a3b2c4d5e6f7', 99)).rejects.toThrow(/session 99/);
	});

	it('readSessionMetadata returns null when the per-session metadata file is missing', async () => {
		const v2 = new V2GitStore(env.dir);
		await v2.writeCommitted(baseOpts({}));
		// session 99 doesn't exist on /main → resolveTreeFile yields '' → null.
		const meta = await v2.readSessionMetadata('a3b2c4d5e6f7', 99);
		expect(meta).toBeNull();
	});

	it('readLatestSessionContent throws ErrCheckpointNotFound when checkpoint missing', async () => {
		const v2 = new V2GitStore(env.dir);
		await v2.writeCommitted(baseOpts({}));
		await expect(v2.readLatestSessionContent('deadbeefcafe')).rejects.toThrow(
			ErrCheckpointNotFound,
		);
	});

	it('readSessionContentById throws ErrCheckpointNotFound when checkpoint missing', async () => {
		const v2 = new V2GitStore(env.dir);
		await v2.writeCommitted(baseOpts({}));
		await expect(v2.readSessionContentById('deadbeefcafe', 'sess-1')).rejects.toThrow(
			ErrCheckpointNotFound,
		);
	});

	it('getSessionLog returns null for a missing checkpoint (no throw)', async () => {
		const v2 = new V2GitStore(env.dir);
		await v2.writeCommitted(baseOpts({}));
		const log = await v2.getSessionLog('deadbeefcafe');
		expect(log).toBeNull();
	});

	it('getCheckpointAuthor returns empty for an uninitialised /main ref', async () => {
		const v2 = new V2GitStore(env.dir);
		const author = await v2.getCheckpointAuthor('a3b2c4d5e6f7');
		expect(author).toEqual({ name: '', email: '' });
	});

	it('readSessionMetadataAndPrompts throws ErrCheckpointNotFound when /main missing', async () => {
		const v2 = new V2GitStore(env.dir);
		await expect(v2.readSessionMetadataAndPrompts('a3b2c4d5e6f7', 0)).rejects.toThrow(
			ErrCheckpointNotFound,
		);
	});
});

describe('regression guards', () => {
	let env: TestEnv;
	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		await setEnvAuthor(env, 'Test', 'test@test.local');
	});
	afterEach(async () => env.cleanup());

	it('readSessionContent fails when /full/current is missing the raw transcript even if /main has compact one', async () => {
		const v2 = new V2GitStore(env.dir);
		await v2.writeCommitted(baseOpts({ transcript: new Uint8Array() }));
		// /main has the metadata + compact transcript, but /full/current was
		// never created → readSessionContent must throw ErrNoTranscript.
		await expect(v2.readSessionContent('a3b2c4d5e6f7', 0)).rejects.toThrow(ErrNoTranscript);
	});

	it('keeps /full/current root tree clean (no metadata.json / generation.json)', async () => {
		const v2 = new V2GitStore(env.dir);
		await v2.writeCommitted(baseOpts({}));
		const tip = await git.resolveRef({
			fs: fsCallback,
			dir: env.dir,
			ref: V2_FULL_CURRENT_REF_NAME,
		});
		const { commit } = await git.readCommit({ fs: fsCallback, dir: env.dir, oid: tip });
		const root = await git.readTree({ fs: fsCallback, dir: env.dir, oid: commit.tree });
		const blobNames = root.tree.filter((e) => e.type === 'blob').map((e) => e.path);
		expect(blobNames).toEqual([]);
	});
});
