import fsCallback from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import git from 'isomorphic-git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { V2_MAIN_REF_NAME } from '@/checkpoint/constants';
import type { WriteCommittedOptions } from '@/checkpoint/types';
import { getV2MetadataTree } from '@/checkpoint/v2-resolve';
import { V2GitStore } from '@/checkpoint/v2-store';
import { TestEnv } from '../helpers/test-env';

const ENC = new TextEncoder();

function baseOpts(overrides: Partial<WriteCommittedOptions>): WriteCommittedOptions {
	return {
		checkpointId: 'a3b2c4d5e6f7',
		sessionId: 'sess-1',
		strategy: 'manual-commit',
		branch: 'main',
		transcript: ENC.encode('{"role":"raw"}\n'),
		prompts: [],
		filesTouched: [],
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

/**
 * Create a fresh empty repo (just `git init` + identity), used as the
 * "local" side of the fetch fixture.
 */
async function createBareLocal(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
	const raw = await mkdtemp(path.join(os.tmpdir(), 'story-v2-resolve-local-'));
	const dir = await realpath(raw);
	const env: Record<string, string> = {
		...(process.env as Record<string, string>),
		GIT_CONFIG_GLOBAL: '/dev/null',
		GIT_CONFIG_SYSTEM: '/dev/null',
	};
	await execa('git', ['init', dir], { env });
	await execa('git', ['config', 'user.name', 'L'], { cwd: dir, env });
	await execa('git', ['config', 'user.email', 'l@l.local'], { cwd: dir, env });
	return {
		dir,
		cleanup: () => rm(dir, { recursive: true, force: true }),
	};
}

describe('getV2MetadataTree', () => {
	let env: TestEnv;
	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		await setEnvAuthor(env, 'Test', 'test@test.local');
	});
	afterEach(async () => env.cleanup());

	it('reads the tree from the local /main ref when present (no fetch needed)', async () => {
		const v2 = new V2GitStore(env.dir);
		await v2.writeCommitted(baseOpts({}));
		const result = await getV2MetadataTree(env.dir, null, null);
		expect(result).not.toBeNull();
		expect(result?.treeHash).toMatch(/^[0-9a-f]{40}$/);
		// Sanity: the returned tree hash matches what we'd get directly.
		const tip = await git.resolveRef({
			fs: fsCallback,
			dir: env.dir,
			ref: V2_MAIN_REF_NAME,
		});
		const { commit } = await git.readCommit({ fs: fsCallback, dir: env.dir, oid: tip });
		expect(result?.treeHash).toBe(commit.tree);
	});

	it('returns null when no ref exists and no fetcher is supplied', async () => {
		// Fresh repo, no v2 ref ever created → all 3 tiers fail.
		const result = await getV2MetadataTree(env.dir, null, null);
		expect(result).toBeNull();
	});

	it('succeeds via the treeless fetch fallback (tier 1)', async () => {
		const v2 = new V2GitStore(env.dir);
		await v2.writeCommitted(baseOpts({}));
		const local = await createBareLocal();
		try {
			let treelessCalls = 0;
			const treelessFetch = async () => {
				treelessCalls += 1;
				await execa(
					'git',
					['fetch', '--no-tags', env.dir, `+${V2_MAIN_REF_NAME}:${V2_MAIN_REF_NAME}`],
					{ cwd: local.dir },
				);
			};
			const result = await getV2MetadataTree(local.dir, treelessFetch, null);
			expect(result).not.toBeNull();
			expect(treelessCalls).toBe(1);
		} finally {
			await local.cleanup();
		}
	});

	it('falls through to full fetch (tier 3) when treeless and local both fail', async () => {
		const v2 = new V2GitStore(env.dir);
		await v2.writeCommitted(baseOpts({}));
		const local = await createBareLocal();
		try {
			let treelessCalls = 0;
			let fullCalls = 0;
			const treelessFetch = async () => {
				treelessCalls += 1;
				throw new Error('simulated treeless failure');
			};
			const fullFetch = async () => {
				fullCalls += 1;
				await execa(
					'git',
					['fetch', '--no-tags', env.dir, `+${V2_MAIN_REF_NAME}:${V2_MAIN_REF_NAME}`],
					{ cwd: local.dir },
				);
			};
			const result = await getV2MetadataTree(local.dir, treelessFetch, fullFetch);
			expect(result).not.toBeNull();
			expect(treelessCalls).toBe(1);
			expect(fullCalls).toBe(1);
		} finally {
			await local.cleanup();
		}
	});
});
