/**
 * Phase 5.4 Part 1 unit tests for [src/strategy/hooks-prepare-commit-msg.ts](src/strategy/hooks-prepare-commit-msg.ts).
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/strategy/manual_commit_hooks.go`:
 *   - `PrepareCommitMsg` (16-step pipeline)
 *   - `handleAmendCommitMsg` (amend branch)
 *   - `tryAgentCommitFastPath` (mid-turn agent fast path)
 *   - `addTrailerForAgentCommit` (fast path inner write)
 *   - `addCheckpointTrailer` (1-line wrapper)
 *   - `addCheckpointTrailerWithComment` (3-branch string assembly)
 *
 * Each `it()` is annotated with `// Go: <go-file>:<line>` for the
 * audit-test-go-parity gate.
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generate } from '@/id';
import { storyMetadataDirForSession } from '@/paths';
import {
	addCheckpointTrailer,
	addCheckpointTrailerWithComment,
	handleAmendCommitMsg,
	prepareCommitMsgImpl,
	tryAgentCommitFastPath,
} from '@/strategy/hooks-prepare-commit-msg';
import { ManualCommitStrategy } from '@/strategy/manual-commit';
import type { SessionState } from '@/strategy/types';
import { TestEnv } from '../../helpers/test-env';

const ENV_KEYS = ['STORY_TEST_TTY', 'ENTIRE_TEST_TTY'] as const;

function makeState(overrides: Partial<SessionState> = {}): SessionState {
	return {
		sessionId: 'sess-default',
		baseCommit: 'deadbeef',
		startedAt: new Date().toISOString(),
		phase: 'active',
		stepCount: 1,
		...overrides,
	};
}

async function writeMsg(env: TestEnv, contents: string): Promise<string> {
	const file = path.join(env.dir, 'COMMIT_EDITMSG');
	await writeFile(file, contents, { mode: 0o600 });
	return file;
}

describe('addCheckpointTrailer', () => {
	// Go: manual_commit_hooks.go: addCheckpointTrailer:2108-2110 — delegates to trailers.AppendCheckpointTrailer
	it('appends Story-Checkpoint trailer to message', () => {
		const cpId = generate();
		const result = addCheckpointTrailer('feat: subject', cpId);
		expect(result).toContain(`Story-Checkpoint: ${cpId}`);
	});
});

describe('addCheckpointTrailerWithComment — 3-branch string assembly', () => {
	const cpId = '0188abcdef01';

	// Go: manual_commit_hooks.go: addCheckpointTrailerWithComment:2138-2140 — Branch A: no `#` line
	it('Branch A: no git comment block — appends trailer + comment at end', () => {
		const result = addCheckpointTrailerWithComment(
			'user content',
			cpId,
			'Claude Code',
			'rewrite README',
		);
		expect(result.startsWith('user content\n\n')).toBe(true);
		expect(result).toContain(`Story-Checkpoint: ${cpId}`);
		expect(result).toContain('# Remove the Story-Checkpoint trailer above');
		expect(result).toContain('# Last Prompt: rewrite README');
		expect(result.endsWith('\n')).toBe(true);
	});

	// Go: manual_commit_hooks.go: addCheckpointTrailerWithComment:2143-2154 — Branch B: comment block + content
	it('Branch B: git comment block present + user content non-empty — trailer in middle', () => {
		const input = 'feat: subject\n# Please enter the commit message\n# more help';
		const result = addCheckpointTrailerWithComment(input, cpId, 'Claude Code', 'rewrite README');
		// trailer + comment must come BEFORE git comment block
		const trailerIdx = result.indexOf(`Story-Checkpoint: ${cpId}`);
		const gitCommentIdx = result.indexOf('# Please enter');
		expect(trailerIdx).toBeGreaterThan(0);
		expect(gitCommentIdx).toBeGreaterThan(trailerIdx);
		expect(result.startsWith('feat: subject\n\n')).toBe(true);
	});

	// Go: manual_commit_hooks.go: addCheckpointTrailerWithComment:2148-2152 — Branch C: empty user content
	it('Branch C: git comment block + empty user content — leading 2 newlines + trailer + comment + git comments', () => {
		const input = '# Please enter the commit message';
		const result = addCheckpointTrailerWithComment(input, cpId, 'Claude Code', '');
		expect(result.startsWith('\n\n')).toBe(true);
		expect(result).toContain(`Story-Checkpoint: ${cpId}`);
		expect(result).toContain('# Please enter the commit message');
		// No "Last Prompt" line when prompt empty.
		expect(result).not.toContain('# Last Prompt:');
	});

	// Go: manual_commit_hooks.go: addCheckpointTrailerWithComment:2122-2124 — empty prompt skips Last Prompt line
	it('omits "# Last Prompt:" line when prompt is empty', () => {
		const result = addCheckpointTrailerWithComment('feat: x', cpId, 'Claude Code', '');
		expect(result).not.toContain('Last Prompt');
	});

	// rTrim helper coverage: input with multiple trailing newlines (Branch A path).
	it('rTrim strips trailing newlines from user content (Branch A)', () => {
		// "user content\n\n\n" + no `#` lines → Branch A.
		// rTrim should strip all 3 trailing newlines before adding "\n\n<trailer>".
		const result = addCheckpointTrailerWithComment('user content\n\n\n', cpId, 'Claude Code', 'p');
		expect(result.startsWith('user content\n\n')).toBe(true);
		// Should NOT have 5 newlines in a row (would mean rTrim didn't strip).
		expect(result).not.toMatch(/user content\n\n\n+/);
	});
});

describe('PrepareCommitMsg — fast skip paths', () => {
	let env: TestEnv;
	let strategy: ManualCommitStrategy;

	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		strategy = new ManualCommitStrategy(env.dir);
	});
	afterEach(async () => {
		await env.cleanup();
	});

	// Go: manual_commit_hooks.go: PrepareCommitMsg:418-425 — merge / squash skip
	it('skips for source=merge', async () => {
		const file = await writeMsg(env, 'auto-merge message\n');
		await prepareCommitMsgImpl(strategy, file, 'merge');
		expect(await readFile(file, 'utf8')).toBe('auto-merge message\n');
	});

	it('skips for source=squash', async () => {
		const file = await writeMsg(env, 'auto-squash message\n');
		await prepareCommitMsgImpl(strategy, file, 'squash');
		expect(await readFile(file, 'utf8')).toBe('auto-squash message\n');
	});

	// Go: manual_commit_hooks.go: PrepareCommitMsg:452-462 — no active sessions = silent skip
	it('silent when no active sessions for worktree', async () => {
		const file = await writeMsg(env, 'feat: subject\n');
		await prepareCommitMsgImpl(strategy, file, '');
		// No session → no trailer added.
		const after = await readFile(file, 'utf8');
		expect(after).not.toContain('Story-Checkpoint:');
	});

	// Go: manual_commit_hooks.go: PrepareCommitMsg:497-506 — trailer already present → keep + return
	it('no-op when message already has Story-Checkpoint trailer', async () => {
		const cpId = generate();
		const original = `feat: subject\n\nStory-Checkpoint: ${cpId}\n`;
		const file = await writeMsg(env, original);
		// Need a session so we don't early-return at "no active sessions".
		const state = makeState({
			sessionId: 's1',
			baseCommit: (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim(),
			worktreePath: env.dir,
			filesTouched: ['x.ts'],
		});
		await strategy.saveSessionState(state);
		await prepareCommitMsgImpl(strategy, file, '');
		expect(await readFile(file, 'utf8')).toBe(original);
	});
});

describe('PrepareCommitMsg — source=message + agent fast path (no TTY)', () => {
	let env: TestEnv;
	let strategy: ManualCommitStrategy;
	const savedEnv: Record<string, string | undefined> = {};

	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		strategy = new ManualCommitStrategy(env.dir);
		for (const k of ENV_KEYS) {
			savedEnv[k] = process.env[k];
		}
		// Force no-TTY to trigger agent fast path.
		process.env.STORY_TEST_TTY = '0';
	});
	afterEach(async () => {
		await env.cleanup();
		for (const k of ENV_KEYS) {
			if (savedEnv[k] === undefined) {
				delete process.env[k];
			} else {
				process.env[k] = savedEnv[k];
			}
		}
	});

	// Go: manual_commit_hooks.go: tryAgentCommitFastPath:2015-2068 — fires for ACTIVE non-empty session + no TTY
	it('agent fast path injects trailer when ACTIVE session has content + no TTY', async () => {
		const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		await strategy.saveSessionState(
			makeState({
				sessionId: 's1',
				baseCommit: head,
				worktreePath: env.dir,
				phase: 'active',
				transcriptPath: '/tmp/x.jsonl',
			}),
		);
		const file = await writeMsg(env, 'feat: subject\n');
		await prepareCommitMsgImpl(strategy, file, 'message');
		expect(await readFile(file, 'utf8')).toMatch(/Story-Checkpoint: [0-9a-f]{12}/);
	});

	// Go: manual_commit_hooks.go: tryAgentCommitFastPath:2040-2046 — empty active session fall-through
	it('agent fast path skips empty ACTIVE sessions (transcriptPath==="" + filesTouched===[] + stepCount===0)', async () => {
		const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		await strategy.saveSessionState(
			makeState({
				sessionId: 's-empty',
				baseCommit: head,
				worktreePath: env.dir,
				phase: 'active',
				stepCount: 0,
				transcriptPath: '',
				filesTouched: [],
			}),
		);
		const file = await writeMsg(env, 'feat: subject\n');
		await prepareCommitMsgImpl(strategy, file, 'message');
		// Fast path didn't fire (all empty), and filterSessionsWithNewContent
		// also says no content → no trailer added.
		expect(await readFile(file, 'utf8')).toBe('feat: subject\n');
	});
});

describe('PrepareCommitMsg — source=template (editor flow)', () => {
	let env: TestEnv;
	let strategy: ManualCommitStrategy;
	const savedEnv: Record<string, string | undefined> = {};

	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		strategy = new ManualCommitStrategy(env.dir);
		for (const k of ENV_KEYS) {
			savedEnv[k] = process.env[k];
		}
		// Force no-TTY (will fall through to fast path → injects trailer regardless of source).
		process.env.STORY_TEST_TTY = '0';
	});
	afterEach(async () => {
		await env.cleanup();
		for (const k of ENV_KEYS) {
			if (savedEnv[k] === undefined) {
				delete process.env[k];
			} else {
				process.env[k] = savedEnv[k];
			}
		}
	});

	// Go: manual_commit_hooks.go: PrepareCommitMsg:578-580 — default branch (editor flow) uses addCheckpointTrailerWithComment
	// Note: in CI / test mode with no-TTY, the agent fast path fires FIRST and adds the trailer
	// directly via addCheckpointTrailer (no comment). The "with comment" path requires TTY.
	it('source=template adds trailer via fast-path when no TTY (test environment)', async () => {
		const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		await strategy.saveSessionState(
			makeState({
				sessionId: 's1',
				baseCommit: head,
				worktreePath: env.dir,
				transcriptPath: '/tmp/t.jsonl',
				stepCount: 1,
				phase: 'active',
			}),
		);
		const file = await writeMsg(env, '\n# Please enter the commit message\n');
		await prepareCommitMsgImpl(strategy, file, 'template');
		const result = await readFile(file, 'utf8');
		expect(result).toMatch(/Story-Checkpoint: [0-9a-f]{12}/);
	});
});

describe('handleAmendCommitMsg', () => {
	let env: TestEnv;
	let strategy: ManualCommitStrategy;

	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		strategy = new ManualCommitStrategy(env.dir);
	});
	afterEach(async () => {
		await env.cleanup();
	});

	// Go: manual_commit_hooks.go: handleAmendCommitMsg:614-619 — preserves existing trailer
	it('preserves existing trailer unchanged', async () => {
		const original = `feat: x\n\nStory-Checkpoint: 0188abcdef01\n`;
		const file = await writeMsg(env, original);
		await handleAmendCommitMsg(strategy, file);
		expect(await readFile(file, 'utf8')).toBe(original);
	});

	// Go: manual_commit_hooks.go: handleAmendCommitMsg:649-672 — restore from lastCheckpointId when baseCommit===HEAD
	it('restores trailer from state.lastCheckpointId when baseCommit matches HEAD', async () => {
		const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		await strategy.saveSessionState(
			makeState({
				sessionId: 's1',
				baseCommit: head,
				worktreePath: env.dir,
				lastCheckpointId: '0188abcdef01',
				stepCount: 1,
			}),
		);
		const file = await writeMsg(env, 'amended subject\n');
		await handleAmendCommitMsg(strategy, file);
		const after = await readFile(file, 'utf8');
		expect(after).toContain('Story-Checkpoint: 0188abcdef01');
	});

	// Go: manual_commit_hooks.go: handleAmendCommitMsg:649-651 — does NOT restore when baseCommit !== currentHead
	it('does NOT restore trailer when baseCommit !== currentHead', async () => {
		await strategy.saveSessionState(
			makeState({
				sessionId: 's1',
				baseCommit: 'different-from-head',
				worktreePath: env.dir,
				lastCheckpointId: '0188abcdef01',
			}),
		);
		const file = await writeMsg(env, 'amended subject\n');
		await handleAmendCommitMsg(strategy, file);
		expect(await readFile(file, 'utf8')).toBe('amended subject\n');
	});

	// Go: manual_commit_hooks.go: handleAmendCommitMsg:653-655 — does NOT restore when lastCheckpointId empty
	it('does NOT restore when state.lastCheckpointId is empty', async () => {
		const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		await strategy.saveSessionState(
			makeState({
				sessionId: 's1',
				baseCommit: head,
				worktreePath: env.dir,
				lastCheckpointId: undefined,
			}),
		);
		const file = await writeMsg(env, 'amended subject\n');
		await handleAmendCommitMsg(strategy, file);
		expect(await readFile(file, 'utf8')).toBe('amended subject\n');
	});

	// Go: manual_commit_hooks.go: handleAmendCommitMsg:606-609 — silent on file read error
	it('silent when file read fails', async () => {
		await handleAmendCommitMsg(strategy, path.join(env.dir, 'no-such-file'));
		// no exception thrown
	});
});

describe('PrepareCommitMsg — TTY=true source=message branches (default-Link via test mode)', () => {
	let env: TestEnv;
	let strategy: ManualCommitStrategy;
	const savedEnv: Record<string, string | undefined> = {};

	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		strategy = new ManualCommitStrategy(env.dir);
		for (const k of ENV_KEYS) {
			savedEnv[k] = process.env[k];
		}
		// In test mode, hasTTY()=true but askConfirmTTY returns defaultYes without IO.
		process.env.STORY_TEST_TTY = '1';
	});
	afterEach(async () => {
		await env.cleanup();
		for (const k of ENV_KEYS) {
			if (savedEnv[k] === undefined) {
				delete process.env[k];
			} else {
				process.env[k] = savedEnv[k];
			}
		}
	});

	// Go: manual_commit_hooks.go: PrepareCommitMsg:553-577 — TTY + prompt → askConfirmTTY → defaultYes=Link
	it('TTY+commit_linking=prompt+source=message: askConfirmTTY default-Link adds trailer', async () => {
		const { shadowBranchNameForCommit } = await import('@/checkpoint/temporary');
		const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		// Build a real shadow branch with transcript so sessionHasNewContent returns true.
		const sDir = storyMetadataDirForSession('s');
		await env.writeFile(`${sDir}/full.jsonl`, 'real transcript content');
		await env.gitAdd(`${sDir}/full.jsonl`);
		await env.gitCommit('shadow checkpoint');
		const shadowHead = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		const branch = shadowBranchNameForCommit(head, '');
		await env.exec('git', ['branch', '-f', branch, shadowHead]);
		await env.exec('git', ['reset', '--hard', `${shadowHead}^`]);

		await strategy.saveSessionState(
			makeState({
				sessionId: 's',
				baseCommit: head,
				worktreePath: env.dir,
				phase: 'active',
				transcriptPath: '/tmp/t.jsonl',
				stepCount: 1,
			}),
		);
		const file = await writeMsg(env, 'feat: subject\n');
		await prepareCommitMsgImpl(strategy, file, 'message');
		// askConfirmTTY in test mode returns Link (defaultYes=true) → trailer added.
		expect(await readFile(file, 'utf8')).toMatch(/Story-Checkpoint: [0-9a-f]{12}/);
	});
});

describe('tryAgentCommitFastPath — direct unit', () => {
	let env: TestEnv;
	let strategy: ManualCommitStrategy;
	const savedEnv: Record<string, string | undefined> = {};

	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		strategy = new ManualCommitStrategy(env.dir);
		for (const k of ENV_KEYS) {
			savedEnv[k] = process.env[k];
		}
	});
	afterEach(async () => {
		await env.cleanup();
		for (const k of ENV_KEYS) {
			if (savedEnv[k] === undefined) {
				delete process.env[k];
			} else {
				process.env[k] = savedEnv[k];
			}
		}
	});

	// Go: manual_commit_hooks.go: tryAgentCommitFastPath:2016-2025 — TTY=true + commit_linking=prompt → fast path NOT triggered
	it('returns false when hasTTY()=true and commit_linking=prompt (default)', async () => {
		process.env.STORY_TEST_TTY = '1';
		const file = await writeMsg(env, 'feat: x\n');
		const state = makeState({
			sessionId: 's',
			baseCommit: 'deadbeef',
			worktreePath: env.dir,
			phase: 'active',
			transcriptPath: '/tmp/t.jsonl',
		});
		const result = await tryAgentCommitFastPath(strategy, file, [state], 'message');
		expect(result).toBe(false);
	});

	// Go: manual_commit_hooks.go: tryAgentCommitFastPath:2027-2050 — fires for non-empty ACTIVE + no TTY
	it('returns true and writes trailer when hasTTY()=false + ACTIVE non-empty session', async () => {
		process.env.STORY_TEST_TTY = '0';
		const file = await writeMsg(env, 'feat: x\n');
		const state = makeState({
			sessionId: 's',
			baseCommit: 'deadbeef',
			worktreePath: env.dir,
			phase: 'active',
			transcriptPath: '/tmp/t.jsonl',
		});
		const result = await tryAgentCommitFastPath(strategy, file, [state], 'message');
		expect(result).toBe(true);
		expect(await readFile(file, 'utf8')).toMatch(/Story-Checkpoint: [0-9a-f]{12}/);
	});

	// Go: manual_commit_hooks.go: tryAgentCommitFastPath:2030-2046 — all-empty ACTIVE → false (fall-through)
	it('returns false when all ACTIVE sessions are empty', async () => {
		process.env.STORY_TEST_TTY = '0';
		const file = await writeMsg(env, 'feat: x\n');
		const empty = makeState({
			sessionId: 's',
			baseCommit: 'deadbeef',
			worktreePath: env.dir,
			phase: 'active',
			transcriptPath: '',
			filesTouched: [],
			stepCount: 0,
		});
		expect(await tryAgentCommitFastPath(strategy, file, [empty], 'message')).toBe(false);
		// Message unchanged.
		expect(await readFile(file, 'utf8')).toBe('feat: x\n');
	});

	// Go: manual_commit_hooks.go: tryAgentCommitFastPath:2030 — non-ACTIVE phase ignored
	it('returns false when only non-ACTIVE sessions exist', async () => {
		process.env.STORY_TEST_TTY = '0';
		const file = await writeMsg(env, 'feat: x\n');
		const idle = makeState({
			sessionId: 's',
			baseCommit: 'deadbeef',
			worktreePath: env.dir,
			phase: 'idle',
			transcriptPath: '/tmp/t.jsonl',
		});
		expect(await tryAgentCommitFastPath(strategy, file, [idle], 'message')).toBe(false);
	});
});
