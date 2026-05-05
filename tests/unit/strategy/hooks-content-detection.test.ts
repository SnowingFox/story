/**
 * Phase 5.4 Part 1 unit tests for [src/strategy/hooks-content-detection.ts](src/strategy/hooks-content-detection.ts).
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/strategy/manual_commit_hooks.go`:
 *   - `getStagedFiles`
 *   - `sessionHasNewContent` (the 9-branch decision tree)
 *   - `sessionHasNewContentFromLiveTranscript`
 *   - `resolveFilesTouched`
 *   - `hasNewTranscriptWork` — Phase 5.4 stub (full impl in Phase 6.1)
 *   - `extractModifiedFilesFromLiveTranscript` — Phase 5.4 stub (full impl in Phase 6.1)
 *   - `filterSessionsWithNewContent`
 *   - `getLastPrompt`
 *   - `extractLastPrompt`
 *   - `readPromptsFromShadowBranch`
 *
 * Each `it()` is annotated with `// Go: <go-file>:<line>` for the
 * audit-test-go-parity gate.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shadowBranchNameForCommit } from '@/checkpoint/temporary';
import { clearGitCommonDirCache } from '@/git';
import { clearWorktreeRootCache, storyMetadataDirForSession } from '@/paths';
import {
	extractLastPrompt,
	extractModifiedFilesFromLiveTranscript,
	filterSessionsWithNewContent,
	getLastPrompt,
	getStagedFiles,
	hasNewTranscriptWork,
	readPromptsFromShadowBranch,
	resolveFilesTouched,
	sessionHasNewContent,
	sessionHasNewContentFromLiveTranscript,
} from '@/strategy/hooks-content-detection';
import { saveSessionState } from '@/strategy/session-state';
import type { SessionState } from '@/strategy/types';
import { TestEnv } from '../../helpers/test-env';

function makeState(overrides: Partial<SessionState> = {}): SessionState {
	return {
		sessionId: 'sess-default',
		baseCommit: 'deadbeef',
		startedAt: new Date().toISOString(),
		phase: 'idle',
		stepCount: 0,
		...overrides,
	};
}

/**
 * Shadow branch with a metadata directory containing prompt.txt + full.jsonl
 * (per Phase 4.2 layout — `TRANSCRIPT_FILE_NAME` constant). Pointed at HEAD
 * with a fresh commit so the shadow branch has its own tree.
 */
async function makeShadowBranchWith(
	env: TestEnv,
	state: SessionState,
	files: { 'prompt.txt'?: string; 'full.jsonl'?: string; 'full.log'?: string },
): Promise<void> {
	const metadataDir = storyMetadataDirForSession(state.sessionId);
	const wrote: string[] = [];
	for (const [name, content] of Object.entries(files)) {
		if (content !== undefined) {
			await env.writeFile(`${metadataDir}/${name}`, content);
			await env.gitAdd(`${metadataDir}/${name}`);
			wrote.push(name);
		}
	}
	if (wrote.length === 0) {
		// Empty shadow tree placeholder so git commit succeeds; .gitkeep is a
		// non-metadata file so the metadataDir tree-walk still finds nothing.
		await env.writeFile(`${metadataDir}/.gitkeep`, '');
		await env.gitAdd(`${metadataDir}/.gitkeep`);
	}
	await env.gitCommit(`shadow checkpoint for ${state.sessionId}`);
	const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
	const branch = shadowBranchNameForCommit(state.baseCommit, state.worktreeId ?? '');
	await env.exec('git', ['branch', '-f', branch, head]);
	// Reset HEAD to before the shadow commit so the shadow branch is a side branch.
	await env.exec('git', ['reset', '--hard', `${head}^`]);
}

describe('extractLastPrompt', () => {
	// Go: manual_commit_hooks.go: extractLastPrompt:2459-2461 — empty content
	it('returns empty string for empty content', () => {
		expect(extractLastPrompt('')).toBe('');
	});

	// Go: manual_commit_hooks.go: extractLastPrompt:2463-2470 — single prompt no separators
	it('returns single prompt content as-is when no separators', () => {
		expect(extractLastPrompt('single prompt')).toBe('single prompt');
	});

	// Go: manual_commit_hooks.go: extractLastPrompt:2463-2470 — last of multiple
	it('returns the last prompt from \\n\\n---\\n\\n separated content', () => {
		const text = 'first prompt\n\n---\n\nsecond prompt\n\n---\n\nthird prompt';
		expect(extractLastPrompt(text)).toBe('third prompt');
	});

	// Go: manual_commit_hooks.go: extractLastPrompt:2466-2470 — skip trailing separator-only entry
	it('skips trailing only-separators entry to find the last real prompt', () => {
		const text = 'real prompt\n\n---\n\n---';
		expect(extractLastPrompt(text)).toBe('real prompt');
	});

	// Go: manual_commit_hooks.go: extractLastPrompt:2466-2470 — skip trailing empty entry
	it('skips trailing empty entry to find the last real prompt', () => {
		const text = 'real prompt\n\n---\n\n   \n\t';
		expect(extractLastPrompt(text)).toBe('real prompt');
	});
});

describe('getStagedFiles', () => {
	let env: TestEnv;
	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		clearGitCommonDirCache();
		clearWorktreeRootCache();
	});
	afterEach(async () => {
		await env.cleanup();
		clearGitCommonDirCache();
		clearWorktreeRootCache();
	});

	// Go: manual_commit_hooks.go: getStagedFiles:2405-2414 — non-nil empty when nothing staged
	it('returns empty array (non-null) when nothing staged', async () => {
		const result = await getStagedFiles(env.dir);
		expect(result).toEqual([]);
	});

	// Go: manual_commit_hooks.go: getStagedFiles:2398-2414 — multiple staged files
	it('returns POSIX-normalized paths for multiple staged files', async () => {
		await env.writeFile('a.txt', 'a');
		await env.writeFile('subdir/b.txt', 'b');
		await env.gitAdd('a.txt');
		await env.gitAdd('subdir/b.txt');
		const result = await getStagedFiles(env.dir);
		expect(result?.sort()).toEqual(['a.txt', 'subdir/b.txt']);
	});

	// Go: manual_commit_hooks.go: getStagedFiles:2400-2403 — git CLI failure → null
	it('returns null when git CLI fails (not a git repo)', async () => {
		const tmp = await TestEnv.create({ initialCommit: false });
		await tmp.exec('rm', ['-rf', '.git']); // destroy the repo
		const result = await getStagedFiles(tmp.dir);
		expect(result).toBeNull();
		await tmp.cleanup();
	});
});

describe('readPromptsFromShadowBranch', () => {
	let env: TestEnv;
	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
	});
	afterEach(async () => {
		await env.cleanup();
	});

	// Go: manual_commit_hooks.go: readPromptsFromShadowBranch:2480-2483 — no shadow ref
	it('returns null when shadow branch ref does not exist', async () => {
		const state = makeState({ sessionId: 'sess1', baseCommit: 'no-branch' });
		expect(await readPromptsFromShadowBranch(env.dir, state)).toBeNull();
	});

	// Go: manual_commit_hooks.go: readPromptsFromShadowBranch:2497-2500 — shadow exists but no prompt.txt
	it('returns null when prompt.txt is missing from the shadow tree', async () => {
		const state = makeState({ sessionId: 'sess2', baseCommit: 'has-shadow' });
		await makeShadowBranchWith(env, state, { 'full.jsonl': '{}' });
		expect(await readPromptsFromShadowBranch(env.dir, state)).toBeNull();
	});

	// Go: manual_commit_hooks.go: readPromptsFromShadowBranch:2502-2507 — splits on \\n\\n---\\n\\n
	it('returns prompts split on \\n\\n---\\n\\n separator', async () => {
		const state = makeState({ sessionId: 'sess3', baseCommit: 'has-shadow' });
		const text = 'first\n\n---\n\nsecond\n\n---\n\nthird';
		await makeShadowBranchWith(env, state, { 'prompt.txt': text });
		const prompts = await readPromptsFromShadowBranch(env.dir, state);
		expect(prompts).toEqual(['first', 'second', 'third']);
	});
});

describe('getLastPrompt', () => {
	let env: TestEnv;
	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
	});
	afterEach(async () => {
		await env.cleanup();
	});

	// Go: manual_commit_hooks.go: getLastPrompt:2425-2426 — no shadow → empty string
	it('returns empty string when shadow branch ref missing', async () => {
		const state = makeState({ sessionId: 'sess', baseCommit: 'none' });
		expect(await getLastPrompt(env.dir, state)).toBe('');
	});

	// Go: manual_commit_hooks.go: getLastPrompt:2453 — extractLastPrompt result
	it('returns the last prompt extracted via extractLastPrompt', async () => {
		const state = makeState({ sessionId: 'sess-last', baseCommit: 'has-shadow' });
		await makeShadowBranchWith(env, state, {
			'prompt.txt': 'first\n\n---\n\nsecond\n\n---\n\nthird real prompt',
		});
		expect(await getLastPrompt(env.dir, state)).toBe('third real prompt');
	});
});

describe('sessionHasNewContent', () => {
	let env: TestEnv;
	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
	});
	afterEach(async () => {
		await env.cleanup();
	});

	// Go: manual_commit_hooks.go: sessionHasNewContent:1606-1617 — no shadow → falls back to live transcript
	it('falls back to live transcript when no shadow branch (no transcriptPath → false)', async () => {
		const state = makeState({ sessionId: 's', baseCommit: 'no-shadow' });
		// No transcriptPath, so live-transcript fallback returns false.
		expect(await sessionHasNewContent(env.dir, state, {})).toBe(false);
	});

	// Go: manual_commit_hooks.go: sessionHasNewContent:1690-1714 — transcript blob > stored → growth=true,
	// no staged files + IDLE recent → returns true via growth path
	it('returns true when shadow transcript blob size > state.checkpointTranscriptSize (growth detected)', async () => {
		const state = makeState({
			sessionId: 'sgrow',
			baseCommit: 'has-shadow',
			checkpointTranscriptSize: 5,
		});
		await makeShadowBranchWith(env, state, { 'full.jsonl': 'a much longer transcript content' });
		// In PostCommit context (no staged files), growth alone is enough when no carry-forward pending.
		expect(await sessionHasNewContent(env.dir, state, { stagedFiles: null })).toBe(true);
	});

	// Go: manual_commit_hooks.go: sessionHasNewContent:1692-1697 — legacy state w/ start>0 + size===0 → assume growth
	it('assumes growth when checkpointTranscriptStart > 0 and checkpointTranscriptSize === 0 (legacy state)', async () => {
		const state = makeState({
			sessionId: 'slegacy',
			baseCommit: 'has-shadow',
			checkpointTranscriptStart: 100,
			// no checkpointTranscriptSize
		});
		await makeShadowBranchWith(env, state, { 'full.jsonl': 'x' });
		expect(await sessionHasNewContent(env.dir, state, { stagedFiles: null })).toBe(true);
	});

	// Go: manual_commit_hooks.go: sessionHasNewContent:1712-1714 — no growth + no carry-forward → false
	it('returns false when no transcript growth AND no carry-forward files', async () => {
		const state = makeState({
			sessionId: 'sno',
			baseCommit: 'has-shadow',
			checkpointTranscriptSize: 100, // larger than the small fixture below
		});
		await makeShadowBranchWith(env, state, { 'full.jsonl': 'x' });
		expect(await sessionHasNewContent(env.dir, state, { stagedFiles: null })).toBe(false);
	});

	// Go: manual_commit_hooks.go: sessionHasNewContent:1647-1668 — no transcript file but has filesTouched + PostCommit context → return true
	it('returns true in PostCommit context when shadow has no transcript but session has filesTouched', async () => {
		const state = makeState({
			sessionId: 'scarry',
			baseCommit: 'has-shadow',
			filesTouched: ['src/main.ts'],
		});
		await makeShadowBranchWith(env, state, {}); // no transcript
		expect(await sessionHasNewContent(env.dir, state, { stagedFiles: null })).toBe(true);
	});

	// Go: manual_commit_hooks.go: sessionHasNewContent:1670-1674 — no transcript + no filesTouched → live fallback
	it('falls back to live transcript when shadow has no transcript AND no filesTouched', async () => {
		const state = makeState({ sessionId: 'sempty', baseCommit: 'has-shadow' });
		await makeShadowBranchWith(env, state, {}); // no transcript
		// No transcriptPath → live fallback returns false.
		expect(await sessionHasNewContent(env.dir, state, {})).toBe(false);
	});

	// Go: manual_commit_hooks.go: sessionHasNewContent:1739-1747 — recent IDLE + carry-forward + no staged → true
	it('returns true for recent IDLE phase with carry-forward when no staged files (PostCommit recent-idle path)', async () => {
		const state = makeState({
			sessionId: 'sridle',
			baseCommit: 'has-shadow',
			phase: 'idle',
			lastInteractionTime: new Date().toISOString(), // recent
			filesTouched: ['src/x.ts'],
			checkpointTranscriptSize: 1000, // no growth
		});
		await makeShadowBranchWith(env, state, { 'full.jsonl': 'x' });
		expect(await sessionHasNewContent(env.dir, state, { stagedFiles: null })).toBe(true);
	});

	// Go: manual_commit_hooks.go: sessionHasNewContent:1736-1745 — stale IDLE → does NOT take recent-idle path
	it('does NOT return true for stale IDLE (last interaction > 24h ago) — falls through to growth check', async () => {
		const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
		const state = makeState({
			sessionId: 'sstale',
			baseCommit: 'has-shadow',
			phase: 'idle',
			lastInteractionTime: oldTime,
			filesTouched: ['src/x.ts'],
			checkpointTranscriptSize: 1000, // no growth
		});
		await makeShadowBranchWith(env, state, { 'full.jsonl': 'x' });
		// hasGrowth=false, hasUncommitted=true, stale → not recent-idle path → returns hasGrowth (false)
		expect(await sessionHasNewContent(env.dir, state, { stagedFiles: null })).toBe(false);
	});
});

describe('sessionHasNewContentFromLiveTranscript', () => {
	// Go: manual_commit_hooks.go: sessionHasNewContentFromLiveTranscript:1777-1779 — no work → false
	it('returns false when hasNewTranscriptWork returns false (Phase 5.4: always — no agent registry)', async () => {
		const state = makeState({
			sessionId: 's',
			transcriptPath: '/tmp/no-such',
			agentType: 'Claude Code',
		});
		expect(await sessionHasNewContentFromLiveTranscript(state, ['src/x.ts'])).toBe(false);
	});
});

describe('resolveFilesTouched', () => {
	// Go: manual_commit_hooks.go: resolveFilesTouched:1820-1824 — prefers state.filesTouched
	it('prefers state.filesTouched when non-empty (returns a copy)', async () => {
		const original = ['src/a.ts', 'src/b.ts'];
		const state = makeState({ filesTouched: original });
		const result = await resolveFilesTouched(state);
		expect(result).toEqual(['src/a.ts', 'src/b.ts']);
		expect(result).not.toBe(original); // shallow copy, not aliased
	});

	// Go: manual_commit_hooks.go: resolveFilesTouched:1826-1829 — fallback to live extract.
	// Phase 5.4 stub returns [] (Phase 6.1 wires actual extraction).
	it('falls back to extractModifiedFilesFromLiveTranscript when state.filesTouched is empty (Phase 5.4 stub returns [])', async () => {
		const state = makeState({
			filesTouched: [],
			transcriptPath: '/tmp/no-such',
			agentType: 'Claude Code',
		});
		const result = await resolveFilesTouched(state);
		expect(result).toEqual([]);
	});
});

describe('hasNewTranscriptWork (Phase 6.1 Part 2: agent dispatch)', () => {
	// Go: manual_commit_hooks.go:1840-1898 hasNewTranscriptWork — full 5-step
	// dispatch via @/agent/registry + @/agent/capabilities.
	it('returns false when transcriptPath is empty (Go fail-safe)', async () => {
		const state = makeState({ transcriptPath: '', agentType: 'Claude Code' });
		expect(await hasNewTranscriptWork(state)).toBe(false);
	});

	it('returns false when agentType is empty (Go fail-safe)', async () => {
		const state = makeState({ transcriptPath: '/tmp/x', agentType: '' });
		expect(await hasNewTranscriptWork(state)).toBe(false);
	});

	it('returns false when agent is unknown to registry (Go fail-safe)', async () => {
		const state = makeState({ transcriptPath: '/tmp/x', agentType: 'Claude Code' });
		expect(await hasNewTranscriptWork(state)).toBe(false);
	});

	// Phase 6.1 Part 2 #108: Vogon (registered, no TranscriptAnalyzer) → false.
	it('returns false when registered agent does not implement TranscriptAnalyzer (Vogon)', async () => {
		await import('@/agent/vogon');
		const state = makeState({ transcriptPath: '/tmp/x', agentType: 'Vogon Agent' });
		expect(await hasNewTranscriptWork(state)).toBe(false);
	});

	// Phase 6.1 Part 2 review: 3 throw-path tests verifying Go-aligned
	// fail-safe semantics (Go: manual_commit_hooks.go:1848-1898 — every
	// failure point logs debug + returns false, never throws to the caller).
	it('returns false + logs debug when resolveTranscriptPath throws (file missing, no resolver)', async () => {
		const log = await import('@/log');
		const debugSpy = vi.spyOn(log, 'debug').mockImplementation(() => {});
		// `/tmp/nonexistent-...` triggers ENOENT in fs.stat → resolveTranscriptPath
		// throws → hasNewTranscriptWork catches + returns false.
		const state = makeState({
			transcriptPath: '/tmp/story-hcd-throw-resolve-nope.jsonl',
			agentType: 'Claude Code',
		});
		expect(await hasNewTranscriptWork(state)).toBe(false);
		expect(debugSpy).toHaveBeenCalledWith(
			expect.objectContaining({ component: 'checkpoint' }),
			expect.stringContaining('transcript path resolution failed'),
			expect.objectContaining({ error: expect.any(String) }),
		);
		debugSpy.mockRestore();
	});

	it('returns false + logs debug when analyzer.getTranscriptPosition throws', async () => {
		const log = await import('@/log');
		const debugSpy = vi.spyOn(log, 'debug').mockImplementation(() => {});
		const { register, withTestRegistry } = await import('@/agent/registry');
		const { mockTranscriptAnalyzerAgent } = await import('../agent/_helpers');
		const fs = await import('node:fs/promises');
		const os = await import('node:os');
		const path = await import('node:path');
		const tmpFile = path.join(
			await fs.mkdtemp(path.join(os.tmpdir(), 'story-hcd-throw-pos-')),
			'transcript.jsonl',
		);
		await fs.writeFile(tmpFile, 'l1\n');
		try {
			await withTestRegistry(async () => {
				register('throw-pos' as never, () =>
					mockTranscriptAnalyzerAgent({
						name: () => 'throw-pos' as never,
						type: () => 'throw-pos',
						getTranscriptPosition: async () => {
							throw new Error('disk read failed');
						},
					}),
				);
				const state = makeState({
					transcriptPath: tmpFile,
					agentType: 'throw-pos',
				});
				expect(await hasNewTranscriptWork(state)).toBe(false);
				expect(debugSpy).toHaveBeenCalledWith(
					expect.objectContaining({ component: 'checkpoint' }),
					expect.stringContaining('GetTranscriptPosition failed'),
					expect.objectContaining({ error: 'disk read failed' }),
				);
			});
		} finally {
			await fs.rm(path.dirname(tmpFile), { recursive: true, force: true });
			debugSpy.mockRestore();
		}
	});

	it('continues + logs debug when active-phase prepareTranscript throws (does NOT short-circuit)', async () => {
		const log = await import('@/log');
		const debugSpy = vi.spyOn(log, 'debug').mockImplementation(() => {});
		const { register, withTestRegistry } = await import('@/agent/registry');
		const { mockBaseAgent } = await import('../agent/_helpers');
		const fs = await import('node:fs/promises');
		const os = await import('node:os');
		const path = await import('node:path');
		const tmpFile = path.join(
			await fs.mkdtemp(path.join(os.tmpdir(), 'story-hcd-throw-prep-')),
			'transcript.jsonl',
		);
		await fs.writeFile(tmpFile, 'l1\n');
		try {
			await withTestRegistry(async () => {
				// Agent implements BOTH TranscriptPreparer (throws) AND
				// TranscriptAnalyzer (returns pos > start). Go semantics: prepare
				// failure is debug-logged + swallowed; analyzer still runs and
				// drives the boolean result.
				register('throw-prep-ok-analyze' as never, () => ({
					...mockBaseAgent({
						name: () => 'throw-prep-ok-analyze' as never,
						type: () => 'throw-prep-ok-analyze',
					}),
					prepareTranscript: async () => {
						throw new Error('flush failed');
					},
					getTranscriptPosition: async () => 100,
					extractModifiedFilesFromOffset: async () => ({ files: [], currentPosition: 100 }),
				}));
				const state = makeState({
					transcriptPath: tmpFile,
					agentType: 'throw-prep-ok-analyze',
					phase: 'active',
					checkpointTranscriptStart: 50,
				});
				expect(await hasNewTranscriptWork(state)).toBe(true);
				expect(debugSpy).toHaveBeenCalledWith(
					expect.objectContaining({ component: 'checkpoint' }),
					expect.stringContaining('prepare transcript failed'),
					expect.objectContaining({
						agentType: 'throw-prep-ok-analyze',
						error: 'flush failed',
					}),
				);
			});
		} finally {
			await fs.rm(path.dirname(tmpFile), { recursive: true, force: true });
			debugSpy.mockRestore();
		}
	});

	// Phase 6.1 Part 2 #109: registered agent with TranscriptAnalyzer →
	// dispatched, returns pos > checkpointTranscriptStart.
	it('dispatches to analyzer.getTranscriptPosition and compares against checkpointTranscriptStart', async () => {
		const { register, withTestRegistry } = await import('@/agent/registry');
		const { mockTranscriptAnalyzerAgent } = await import('../agent/_helpers');
		const fs = await import('node:fs/promises');
		const os = await import('node:os');
		const path = await import('node:path');
		const tmpFile = path.join(
			await fs.mkdtemp(path.join(os.tmpdir(), 'story-hcd-')),
			'transcript.jsonl',
		);
		await fs.writeFile(tmpFile, 'l1\nl2\n');
		try {
			await withTestRegistry(async () => {
				register('analyzer-mock' as never, () =>
					mockTranscriptAnalyzerAgent({
						name: () => 'analyzer-mock' as never,
						type: () => 'analyzer-mock',
						getTranscriptPosition: async () => 100,
					}),
				);
				expect(
					await hasNewTranscriptWork(
						makeState({
							transcriptPath: tmpFile,
							agentType: 'analyzer-mock',
							checkpointTranscriptStart: 50,
						}),
					),
				).toBe(true);
				expect(
					await hasNewTranscriptWork(
						makeState({
							transcriptPath: tmpFile,
							agentType: 'analyzer-mock',
							checkpointTranscriptStart: 100,
						}),
					),
				).toBe(false);
			});
		} finally {
			await fs.rm(path.dirname(tmpFile), { recursive: true, force: true });
		}
	});
});

describe('extractModifiedFilesFromLiveTranscript (Phase 6.1 Part 2: analyzer dispatch)', () => {
	// Go: manual_commit_hooks.go:1909-2003 extractModifiedFilesFromLiveTranscript.
	it('returns [] when transcriptPath is empty (Go fail-safe)', async () => {
		const state = makeState({ transcriptPath: '', agentType: 'Claude Code' });
		expect(await extractModifiedFilesFromLiveTranscript(state, 0, '/repo')).toEqual([]);
	});

	it('returns [] when agent is unknown to registry', async () => {
		const state = makeState({ transcriptPath: '/tmp/x', agentType: 'Claude Code' });
		expect(await extractModifiedFilesFromLiveTranscript(state, 0, '/repo')).toEqual([]);
	});

	// Phase 6.1 Part 2 #110: dispatches + normalizes abs paths to repo-relative POSIX.
	it('dispatches to analyzer.extractModifiedFilesFromOffset and normalizes to repo-relative POSIX', async () => {
		const { register, withTestRegistry } = await import('@/agent/registry');
		const { mockTranscriptAnalyzerAgent } = await import('../agent/_helpers');
		const fs = await import('node:fs/promises');
		const os = await import('node:os');
		const path = await import('node:path');
		const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'story-hcd-files-'));
		const tmpFile = path.join(repoDir, 'transcript.jsonl');
		await fs.writeFile(tmpFile, 'l1\n');
		try {
			await withTestRegistry(async () => {
				register('analyzer-files' as never, () =>
					mockTranscriptAnalyzerAgent({
						name: () => 'analyzer-files' as never,
						type: () => 'analyzer-files',
						extractModifiedFilesFromOffset: async () => ({
							files: [`${repoDir}/src/main.ts`, `${repoDir}/src/util.ts`, '/elsewhere/leak.ts'],
							currentPosition: 100,
						}),
					}),
				);
				const state = makeState({ transcriptPath: tmpFile, agentType: 'analyzer-files' });
				const result = await extractModifiedFilesFromLiveTranscript(state, 0, repoDir);
				// Abs paths inside repo are normalized; abs paths outside repo are dropped.
				expect(result).toEqual(['src/main.ts', 'src/util.ts']);
			});
		} finally {
			await fs.rm(repoDir, { recursive: true, force: true });
		}
	});
});

describe('filterSessionsWithNewContent', () => {
	let env: TestEnv;
	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		clearGitCommonDirCache();
		clearWorktreeRootCache();
	});
	afterEach(async () => {
		await env.cleanup();
		clearGitCommonDirCache();
		clearWorktreeRootCache();
	});

	// Go: manual_commit_hooks.go: filterSessionsWithNewContent:1551-1557 — fully-condensed ENDED skipped
	it('skips fullyCondensed ENDED sessions', async () => {
		const fc = makeState({
			sessionId: 'fc',
			baseCommit: 'has-shadow',
			phase: 'ended',
			fullyCondensed: true,
			stepCount: 5,
			checkpointTranscriptSize: 1,
		});
		await makeShadowBranchWith(env, fc, { 'full.jsonl': 'x' });
		await saveSessionState(fc, env.dir);

		const result = await filterSessionsWithNewContent(env.dir, [fc]);
		expect(result).toHaveLength(0);
	});

	// Go: manual_commit_hooks.go: filterSessionsWithNewContent:1573-1575 — sessions with new content kept
	it('keeps sessions whose sessionHasNewContent returns true (carry-forward path)', async () => {
		const carry = makeState({
			sessionId: 'carry',
			baseCommit: 'has-shadow',
			filesTouched: ['src/x.ts'],
		});
		await makeShadowBranchWith(env, carry, {});
		await saveSessionState(carry, env.dir);

		const result = await filterSessionsWithNewContent(env.dir, [carry]);
		expect(result.map((s) => s.sessionId)).toEqual(['carry']);
	});
});
