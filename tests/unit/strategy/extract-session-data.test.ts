import fsCallback from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import git from 'isomorphic-git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AGENT_TYPE_CLAUDE_CODE } from '@/agent/types';
import {
	PROMPT_FILE_NAME,
	TRANSCRIPT_FILE_NAME,
	TRANSCRIPT_FILE_NAME_LEGACY,
} from '@/checkpoint/constants';
import {
	extractOrCreateSessionData,
	extractSessionData,
	extractSessionDataFromLiveTranscript,
} from '@/strategy/extract-session-data';
import { ManualCommitStrategy } from '@/strategy/manual-commit';
import type { SessionState } from '@/strategy/types';
import { TestEnv } from '../../helpers/test-env';

const SESSION_ID = '2026-04-19-test-session';
const METADATA_DIR = `.story/metadata/${SESSION_ID}`;

function baseState(overrides: Partial<SessionState> = {}): SessionState {
	return {
		sessionId: SESSION_ID,
		baseCommit: '0000000000000000000000000000000000000000',
		startedAt: new Date().toISOString(),
		phase: 'idle',
		stepCount: 0,
		agentType: AGENT_TYPE_CLAUDE_CODE,
		...overrides,
	};
}

// Build a tree containing `<METADATA_DIR>/<filename>` blobs as specified.
async function buildShadowTree(env: TestEnv, files: Record<string, string>): Promise<string> {
	// We build a deeply nested tree mirroring `.story/metadata/<sessionId>/<file>`.
	// isomorphic-git's writeTree only takes a flat list, so we build leaves up.
	const sessionEntries: Array<{ mode: string; path: string; oid: string; type: 'blob' }> = [];
	for (const [name, content] of Object.entries(files)) {
		const blobOid = await git.writeBlob({
			fs: fsCallback,
			dir: env.dir,
			blob: new TextEncoder().encode(content),
		});
		sessionEntries.push({ mode: '100644', path: name, oid: blobOid, type: 'blob' });
	}
	const sessionTree = await git.writeTree({
		fs: fsCallback,
		dir: env.dir,
		tree: sessionEntries,
	});
	const metadataTree = await git.writeTree({
		fs: fsCallback,
		dir: env.dir,
		tree: [{ mode: '040000', path: SESSION_ID, oid: sessionTree, type: 'tree' }],
	});
	const storyTree = await git.writeTree({
		fs: fsCallback,
		dir: env.dir,
		tree: [{ mode: '040000', path: 'metadata', oid: metadataTree, type: 'tree' }],
	});
	const rootTree = await git.writeTree({
		fs: fsCallback,
		dir: env.dir,
		tree: [{ mode: '040000', path: '.story', oid: storyTree, type: 'tree' }],
	});
	// Wrap in a commit so callers can pass the commit OID.
	const commitOid = await git.commit({
		fs: fsCallback,
		dir: env.dir,
		tree: rootTree,
		parent: [],
		message: 'fixture',
		author: { name: 'test', email: 't@e.t', timestamp: 0, timezoneOffset: 0 },
	});
	return commitOid;
}

// Go: cmd/entire/cli/strategy/manual_commit_condensation.go extractOrCreateSessionData
describe('extract-session-data.extractOrCreateSessionData', () => {
	let env: TestEnv;
	let strategy: ManualCommitStrategy;

	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		strategy = new ManualCommitStrategy(env.dir);
	});

	afterEach(async () => {
		await env.cleanup();
	});

	it('routes to extractSessionData when shadow branch exists', async () => {
		// Behavior-based dispatch tests (vi.spyOn cannot intercept ESM
		// module-internal closure references; verify routing via OUTPUT shape).
		const shadowOid = await buildShadowTree(env, {
			[TRANSCRIPT_FILE_NAME]: 'shadow-content\n',
		});
		const out = await extractOrCreateSessionData(strategy, shadowOid, true, baseState());
		expect(new TextDecoder().decode(out.transcript)).toBe('shadow-content\n');
	});

	it('routes to extractSessionDataFromLiveTranscript when only live path is set', async () => {
		const livePath = path.join(env.dir, 'route-live.jsonl');
		await writeFile(livePath, 'live-content\n');
		const out = await extractOrCreateSessionData(
			strategy,
			null,
			false,
			baseState({ transcriptPath: livePath }),
		);
		expect(new TextDecoder().decode(out.transcript)).toBe('live-content\n');
	});

	it('returns empty data with state.filesTouched when neither available', async () => {
		const out = await extractOrCreateSessionData(
			strategy,
			null,
			false,
			baseState({ filesTouched: ['from-state.ts'] }),
		);
		expect(out.transcript.length).toBe(0);
		expect(out.filesTouched).toEqual(['from-state.ts']);
		expect(out.prompts).toEqual([]);
		expect(out.tokenUsage).toBeNull();
	});
});

// Go: cmd/entire/cli/strategy/manual_commit_condensation.go extractSessionData
describe('extract-session-data.extractSessionData', () => {
	let env: TestEnv;
	let strategy: ManualCommitStrategy;

	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		strategy = new ManualCommitStrategy(env.dir);
	});

	afterEach(async () => {
		await env.cleanup();
	});

	it('reads transcript / prompts from shadow tree (Claude Code)', async () => {
		const transcriptContent = 'l1\nl2\n';
		const promptContent = 'first prompt\n\n---\n\nsecond prompt';
		const shadowOid = await buildShadowTree(env, {
			[TRANSCRIPT_FILE_NAME]: transcriptContent,
			[PROMPT_FILE_NAME]: promptContent,
		});

		const out = await extractSessionData(
			strategy,
			shadowOid,
			SESSION_ID,
			['src/app.ts'],
			AGENT_TYPE_CLAUDE_CODE,
			'',
			0,
			false,
		);
		expect(new TextDecoder().decode(out.transcript)).toBe(transcriptContent);
		expect(out.prompts).toEqual(['first prompt', 'second prompt']);
		expect(out.filesTouched).toEqual(['src/app.ts']);
		// Phase 5.3 stub: tokenUsage is null (agent registry deferred to Phase 6.x).
		expect(out.tokenUsage).toBeNull();
	});

	it('prefers live transcript file over shadow tree copy', async () => {
		const shadowOid = await buildShadowTree(env, {
			[TRANSCRIPT_FILE_NAME]: 'shadow-stale\n',
		});
		const liveDir = path.join(env.dir, 'live-dir');
		await mkdir(liveDir, { recursive: true });
		const livePath = path.join(liveDir, 'live.jsonl');
		await writeFile(livePath, 'live-fresh\n');

		const out = await extractSessionData(
			strategy,
			shadowOid,
			SESSION_ID,
			[],
			AGENT_TYPE_CLAUDE_CODE,
			livePath,
			0,
			false,
		);
		expect(new TextDecoder().decode(out.transcript)).toBe('live-fresh\n');
	});

	it('falls back to shadow tree when live transcript missing (ENOENT)', async () => {
		const shadowOid = await buildShadowTree(env, {
			[TRANSCRIPT_FILE_NAME]: 'shadow-content\n',
		});
		const out = await extractSessionData(
			strategy,
			shadowOid,
			SESSION_ID,
			[],
			AGENT_TYPE_CLAUDE_CODE,
			'/tmp/no-such-path.jsonl',
			0,
			false,
		);
		expect(new TextDecoder().decode(out.transcript)).toBe('shadow-content\n');
	});

	it('falls back to legacy transcript.log when transcript.jsonl missing', async () => {
		const shadowOid = await buildShadowTree(env, {
			[TRANSCRIPT_FILE_NAME_LEGACY]: 'legacy-content\n',
		});
		const out = await extractSessionData(
			strategy,
			shadowOid,
			SESSION_ID,
			[],
			AGENT_TYPE_CLAUDE_CODE,
			'',
			0,
			false,
		);
		expect(new TextDecoder().decode(out.transcript)).toBe('legacy-content\n');
	});

	it('falls back to readPromptsFromFilesystem when prompt.txt missing in tree', async () => {
		const shadowOid = await buildShadowTree(env, {
			[TRANSCRIPT_FILE_NAME]: 'l1\n',
		});
		// Write prompt.txt into the live filesystem so the fallback finds it.
		const promptDir = path.join(env.dir, METADATA_DIR);
		await mkdir(promptDir, { recursive: true });
		await writeFile(path.join(promptDir, 'prompt.txt'), 'fs-prompt');

		// Resolution uses the current working directory, so chdir into env.dir for
		// readPromptsFromFilesystem to find the .story/metadata/<id>/prompt.txt.
		const restore = process.cwd();
		process.chdir(env.dir);
		try {
			const out = await extractSessionData(
				strategy,
				shadowOid,
				SESSION_ID,
				[],
				AGENT_TYPE_CLAUDE_CODE,
				'',
				0,
				false,
			);
			expect(out.prompts).toEqual(['fs-prompt']);
		} finally {
			process.chdir(restore);
		}
	});

	// Phase 6.1 Part 2: replaced the Phase 5.3 stub with agent dispatch.
	it('returns null tokenUsage when agent is unknown (no registry entry)', async () => {
		// Same end-state as Go condensation_test.go::CursorReturnsNil (token
		// usage = null) but the **mechanism differs**: Go tests a registered
		// Cursor agent whose calculateTokenUsage is implemented to return nil;
		// here we test the framework dispatch path when no agent is registered
		// at all (ag === null short-circuit). Both code paths land at null;
		// covering both dispatch arms is intentional. Real Cursor agent
		// registration is a Phase 6.3 concern.
		const shadowOid = await buildShadowTree(env, {
			[TRANSCRIPT_FILE_NAME]: 'l1\nl2\n',
		});
		const out = await extractSessionData(
			strategy,
			shadowOid,
			SESSION_ID,
			[],
			AGENT_TYPE_CLAUDE_CODE,
			'',
			0,
			false,
		);
		// No real Claude agent registered yet ⇒ calculateTokenUsage returns null.
		expect(out.tokenUsage).toBeNull();
		expect(out.fullTranscriptLines).toBe(2);
	});

	it('dispatches to agent.calculateTokenUsage when registered (Phase 6.1 Part 2)', async () => {
		// Mock TokenCalculator agent that returns hard-coded token counts.
		const { register, withTestRegistry } = await import('@/agent/registry');
		const { mockTokenCalcAgent } = await import('../agent/_helpers');
		const expected = {
			inputTokens: 100,
			outputTokens: 50,
			cacheCreationTokens: 0,
			cacheReadTokens: 0,
			apiCallCount: 1,
		};
		await withTestRegistry(async () => {
			register('mock-claude' as never, () =>
				mockTokenCalcAgent(expected, {
					name: () => 'mock-claude' as never,
					type: () => 'mock-claude',
				}),
			);
			const shadowOid = await buildShadowTree(env, {
				[TRANSCRIPT_FILE_NAME]: 'l1\nl2\n',
			});
			const out = await extractSessionData(
				strategy,
				shadowOid,
				SESSION_ID,
				[],
				'mock-claude' as never,
				'',
				0,
				false,
			);
			expect(out.tokenUsage).toEqual({
				inputTokens: 100,
				outputTokens: 50,
				cacheCreationTokens: 0,
				cacheReadTokens: 0,
				apiCallCount: 1,
			});
		});
	});

	it('passes checkpointTranscriptStart offset through to the calculator', async () => {
		// Phase 6.1 Part 2: condensation_test.go::ClaudeCodeWithOffset — offset
		// changes the slice boundary so calculator returns different counts.
		const { register, withTestRegistry } = await import('@/agent/registry');
		const { mockTokenCalcAgent } = await import('../agent/_helpers');
		const seenOffsets: number[] = [];
		await withTestRegistry(async () => {
			register('mock-offset' as never, () =>
				mockTokenCalcAgent(null, {
					name: () => 'mock-offset' as never,
					type: () => 'mock-offset',
					calculateTokenUsage: async (_data, offset) => {
						seenOffsets.push(offset);
						return {
							inputTokens: offset === 0 ? 20 : 10,
							outputTokens: 5,
							cacheCreationTokens: 0,
							cacheReadTokens: 0,
							apiCallCount: 1,
						};
					},
				}),
			);
			const shadowOid = await buildShadowTree(env, {
				[TRANSCRIPT_FILE_NAME]: 'l1\nl2\nl3\n',
			});
			const outZero = await extractSessionData(
				strategy,
				shadowOid,
				SESSION_ID,
				[],
				'mock-offset' as never,
				'',
				0,
				false,
			);
			const outFive = await extractSessionData(
				strategy,
				shadowOid,
				SESSION_ID,
				[],
				'mock-offset' as never,
				'',
				5,
				false,
			);
			expect(seenOffsets).toEqual([0, 5]);
			expect(outZero.tokenUsage?.inputTokens).toBe(20);
			expect(outFive.tokenUsage?.inputTokens).toBe(10);
		});
	});

	it('returns empty transcript + state.filesTouched when shadow tree has neither file', async () => {
		const shadowOid = await buildShadowTree(env, {
			'unrelated.txt': 'noise',
		});
		const out = await extractSessionData(
			strategy,
			shadowOid,
			SESSION_ID,
			['carry.ts'],
			AGENT_TYPE_CLAUDE_CODE,
			'',
			0,
			false,
		);
		expect(out.transcript.length).toBe(0);
		expect(out.filesTouched).toEqual(['carry.ts']);
	});
});

// Go: cmd/entire/cli/strategy/manual_commit_condensation.go extractSessionDataFromLiveTranscript
describe('extract-session-data.extractSessionDataFromLiveTranscript', () => {
	let env: TestEnv;
	let strategy: ManualCommitStrategy;

	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		strategy = new ManualCommitStrategy(env.dir);
	});

	afterEach(async () => {
		await env.cleanup();
	});

	it('reads from disk and returns full data', async () => {
		const livePath = path.join(env.dir, 'live.jsonl');
		await writeFile(livePath, 'l1\nl2\n');
		const state = baseState({ transcriptPath: livePath, filesTouched: ['x.ts'] });
		const out = await extractSessionDataFromLiveTranscript(strategy, state);
		expect(new TextDecoder().decode(out.transcript)).toBe('l1\nl2\n');
		expect(out.filesTouched).toEqual(['x.ts']);
	});

	it('throws on transcript read failure (ENOENT)', async () => {
		const state = baseState({ transcriptPath: '/tmp/no-such.jsonl' });
		await expect(extractSessionDataFromLiveTranscript(strategy, state)).rejects.toThrow(
			/transcript not found at|failed to access transcript/,
		);
	});

	it('throws on empty transcript', async () => {
		const livePath = path.join(env.dir, 'empty.jsonl');
		await writeFile(livePath, '');
		const state = baseState({ transcriptPath: livePath });
		await expect(extractSessionDataFromLiveTranscript(strategy, state)).rejects.toThrow(/empty/);
	});
});
