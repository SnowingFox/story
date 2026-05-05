/**
 * Story-owned PTY coverage (`expect` + Clack) plus Go-aligned non-interactive CLI checks.
 *
 * `pit` cases skip when globalSetup did not find `expect` on PATH
 * (`STORY_E2E_EXPECT_OK !== '1'`). `it` (Go parity) always runs — no PTY required.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';
import { captureArtifacts } from '../helpers/artifacts';
import { assertFileExists, waitForCheckpoint } from '../helpers/assertions';
import { isExpectAvailableFromSetup, isolatedSpawnEnv } from '../helpers/env';
import { runStoryInteractive } from '../helpers/pty-runner';
import { type RepoState, setupRepo, teardownRepo } from '../helpers/repo-state';
import { rewindList, rewindTo, runStory } from '../helpers/story';
import { stripAnsi } from '../helpers/strip-ansi';
import { getVogonBin } from '../helpers/vogon-runner';

/** Fails fast when Vogon left nothing to commit (avoids `nothing to commit` + checkpoint timeout). */
async function assertPorcelainNonEmpty(s: RepoState, msg: string): Promise<void> {
	const out = await s.gitOutput('status', '--porcelain');
	expect(out.trim(), msg).not.toBe('');
}

/**
 * Poll until any `*.json` session state under `.git/story-sessions/` has
 * the given `phase` (JSON key `phase`, snake_case file body).
 */
async function waitForSessionPhase(
	repoDir: string,
	wantPhase: string,
	timeoutMs: number,
): Promise<void> {
	const sessionsDir = path.join(repoDir, '.git', 'story-sessions');
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		let entries: string[] = [];
		try {
			entries = await fs.readdir(sessionsDir);
		} catch {
			await new Promise<void>((r) => {
				setTimeout(r, 150);
			});
			continue;
		}
		const jsonFiles = entries.filter((e) => e.endsWith('.json') && !e.endsWith('.tmp'));
		for (const name of jsonFiles) {
			const raw = await fs.readFile(path.join(sessionsDir, name), 'utf8');
			const parsed = JSON.parse(raw) as { phase?: string; ended_at?: string | null };
			if (parsed.ended_at !== undefined && parsed.ended_at !== null && parsed.ended_at !== '') {
				continue;
			}
			const effective = parsed.phase === undefined || parsed.phase === '' ? 'idle' : parsed.phase;
			if (effective === wantPhase) {
				return;
			}
		}
		await new Promise<void>((r) => {
			setTimeout(r, 150);
		});
	}
	throw new Error(`timeout waiting for session phase=${wantPhase}`);
}

/**
 * Run Vogon stdin-loop with one prompt, invoke `during()` while the process
 * is still alive (so `session-end` has not fired), then send `exit`.
 */
async function withVogonInteractiveMidSession(
	repoDir: string,
	firstPrompt: string,
	during: () => Promise<void>,
): Promise<void> {
	const child = execa(getVogonBin(), [], {
		cwd: repoDir,
		env: isolatedSpawnEnv(),
		stdio: ['pipe', 'pipe', 'pipe'],
		reject: false,
		timeout: 300_000,
	});
	const stdin = child.stdin;
	if (stdin === undefined || stdin === null) {
		throw new Error('vogon subprocess has no stdin');
	}
	try {
		stdin.write(`${firstPrompt}\n`);
		await waitForSessionPhase(repoDir, 'idle', 90_000);
		await during();
	} finally {
		stdin.write('exit\n');
		stdin.end();
	}
	const done = await child;
	if ((done.exitCode ?? 1) !== 0) {
		throw new Error(
			`vogon interactive failed: exit=${String(done.exitCode)}\n${done.stdout ?? ''}\n${done.stderr ?? ''}`,
		);
	}
}

describe('interactive prompts (PTY + expect)', () => {
	/** `globalSetup` sets `STORY_E2E_EXPECT_OK` when `which expect` succeeds. */
	const pit = isExpectAvailableFromSetup() ? it : it.skip;

	let s: RepoState | undefined;

	afterEach(async () => {
		if (s !== undefined) {
			await teardownRepo(s);
			s = undefined;
		}
	});

	/**
	 * Go parity: `integration_test/explain_test.go` drives explain via non-interactive
	 * CLI (`--checkpoint` …), not a PTY picker. Same two-commit fixture as the PTY test below.
	 */
	it('story explain --checkpoint <HEAD Story-Checkpoint trailer> --full (Go parity)', async (ctx) => {
		s = await setupRepo(ctx.task.name);
		ctx.onTestFailed(async () => {
			await captureArtifacts(s);
		});

		await s.runPrompt(
			'create a markdown file at docs/a.md with a short paragraph about alpha. Do not ask for confirmation, just make the change.',
		);
		await assertPorcelainNonEmpty(s, 'vogon should create docs/a.md before c1');
		await s.git('add', '.');
		await s.git('commit', '-m', 'c1');
		await waitForCheckpoint(s, 60_000);

		await s.runPrompt(
			'create a markdown file at docs/b.md with a short paragraph about beta. Do not ask for confirmation, just make the change.',
		);
		await assertPorcelainNonEmpty(s, 'vogon should create docs/b.md before c2');
		await s.git('add', '.');
		await s.git('commit', '-m', 'c2');
		await waitForCheckpoint(s, 60_000);

		const msg = await s.gitOutput('log', '-1', '--format=%B');
		const m = msg.match(/Story-Checkpoint:\s*([0-9a-f]+)/i);
		expect(m, 'HEAD commit should carry Story-Checkpoint trailer').not.toBeNull();
		const cpId = m![1]!;
		const res = await runStory(s.dir, ['explain', '--checkpoint', cpId, '--full']);
		expect(res.exitCode, `${res.stderr}\n${res.stdout}`).toBe(0);
		const out = stripAnsi(`${res.stdout}\n${res.stderr}`);
		expect(out).toMatch(/\(full transcript\)/i);
		expect(out).toMatch(/[0-9a-f]{12}/);
	}, 120_000);

	/**
	 * Go parity: `e2e/tests/rewind_test.go:TestRewindMultipleFiles` — prompts and assertions aligned
	 * with `tests/e2e/scenarios/rewind.e2e.test.ts` (Vogon phrasing matters for harness file content).
	 */
	it('story rewind --to first-turn snapshot drops second file (Go parity: TestRewindMultipleFiles)', async (ctx) => {
		s = await setupRepo(ctx.task.name);
		ctx.onTestFailed(async () => {
			await captureArtifacts(s);
		});

		await s.runPrompt(
			'create a markdown file at docs/rw-go-a.md with a paragraph about this project. Do not create any other files. Do not ask for confirmation, just make the change.',
		);
		await assertFileExists(s.dir, 'docs/rw-go-a.md');

		const pointsAfterA = await rewindList(s.dir);
		expect(pointsAfterA.length, 'expected ≥1 rewind point after first turn').toBeGreaterThan(0);
		const rewindId = pointsAfterA[0]!.id;

		await s.runPrompt(
			'create a markdown file at docs/rw-go-b.md with a paragraph about recent changes. Do not create any other files. Do not ask for confirmation, just make the change.',
		);
		await assertFileExists(s.dir, 'docs/rw-go-b.md');

		const res = await rewindTo(s.dir, rewindId);
		expect(res.exitCode, `${res.stderr}\n${res.stdout}`).toBe(0);

		await assertFileExists(s.dir, 'docs/rw-go-a.md');
		await expect(fs.stat(path.join(s.dir, 'docs', 'rw-go-b.md'))).rejects.toMatchObject({
			code: 'ENOENT',
		});
	}, 120_000);

	pit(
		'story explain — PTY+TTY --commit HEAD + --full shows Turn 1 + checkpoint id (repo has ≥2 checkpoints)',
		async (ctx) => {
			s = await setupRepo(ctx.task.name);
			ctx.onTestFailed(async () => {
				await captureArtifacts(s);
			});

			await s.runPrompt(
				'create a markdown file at docs/a.md with a short paragraph about alpha. Do not ask for confirmation, just make the change.',
			);
			await assertPorcelainNonEmpty(s, 'vogon should create docs/a.md before c1');
			await s.git('add', '.');
			await s.git('commit', '-m', 'c1');
			await waitForCheckpoint(s, 60_000);

			await s.runPrompt(
				'create a markdown file at docs/b.md with a short paragraph about beta. Do not ask for confirmation, just make the change.',
			);
			await assertPorcelainNonEmpty(s, 'vogon should create docs/b.md before c2');
			await s.git('add', '.');
			await s.git('commit', '-m', 'c2');
			await waitForCheckpoint(s, 60_000);

			const r = await runStoryInteractive(
				s.dir,
				['--no-color', 'explain', '--full', '--commit', 'HEAD'],
				[{ waitFor: 'Turn 1', input: '', waitOnly: true }],
				{ timeoutMs: 240_000 },
			);
			expect(r.timedOutAt, `${r.stdout}\n${r.stderr}`).toBeUndefined();
			expect(r.exitCode, `${r.stdout}\n${r.stderr}`).toBe(0);
			const out = stripAnsi(`${r.stdout}\n${r.stderr}`);
			expect(out).toMatch(/Turn\s+1/i);
			expect(out).toMatch(/[0-9a-f]{12}/);
		},
		300_000,
	);

	pit(
		'story rewind — --to rw-v1 + confirm y restores VERSION_ONE (PTY confirm)',
		async (ctx) => {
			s = await setupRepo(ctx.task.name);
			ctx.onTestFailed(async () => {
				await captureArtifacts(s);
			});

			const VERSION_ONE = 'E2E_RW_VERSION_ONE_7f3a91bc';
			const VERSION_TWO = 'E2E_RW_VERSION_TWO_2c8e4d01';

			await s.runPrompt(
				`create a markdown file at docs/rw.md with a short paragraph that includes the token ${VERSION_ONE}. Do not ask for confirmation, just make the change.`,
			);
			await assertPorcelainNonEmpty(s, 'vogon should create docs/rw.md before rw-v1');
			await s.git('add', '.');
			await s.git('commit', '-m', 'rw-v1');
			await waitForCheckpoint(s, 60_000);
			const snapshotRwV1 = await fs.readFile(path.join(s.dir, 'docs', 'rw.md'), 'utf8');
			expect(snapshotRwV1.trim().length, 'vogon should materialize rw.md at rw-v1').toBeGreaterThan(
				0,
			);

			await s.runPrompt('modify docs/rw.md — bump file so the session has edits before rw-v2.');
			await assertPorcelainNonEmpty(s, 'vogon should touch rw.md before rw-v2 content');
			await fs.writeFile(path.join(s.dir, 'docs', 'rw.md'), `${VERSION_TWO}\n`, 'utf8');
			await assertPorcelainNonEmpty(s, 'rw.md should show VERSION_TWO before rw-v2');
			await s.git('add', 'docs/rw.md');
			await s.git('commit', '-m', 'rw-v2');
			await waitForCheckpoint(s, 60_000);

			const points = await rewindList(s.dir);
			expect(points.length, 'need ≥2 rewind points').toBeGreaterThanOrEqual(2);
			const v1 = points.find((p) => p.message.includes('rw-v1'));
			expect(v1, 'rewind list should include rw-v1 commit').toBeDefined();
			const targetId = v1!.id;
			const r = await runStoryInteractive(
				s.dir,
				['--no-color', 'rewind', '--to', targetId],
				[{ waitFor: 'Rewind to', input: 'y' }],
				{ timeoutMs: 240_000 },
			);
			expect(r.exitCode, `${r.stdout}\n${r.stderr}`).toBe(0);

			const body = await fs.readFile(path.join(s.dir, 'docs', 'rw.md'), 'utf8');
			expect(body).toBe(snapshotRwV1);
			expect(body).not.toContain(VERSION_TWO);
		},
		300_000,
	);

	pit('story rewind — confirm n cancels (non-zero exit)', async (ctx) => {
		s = await setupRepo(ctx.task.name);
		ctx.onTestFailed(async () => {
			await captureArtifacts(s);
		});

		await s.runPrompt(
			'create a markdown file at docs/rw2.md with a short paragraph about rewind cancel. Do not ask for confirmation, just make the change.',
		);
		await assertPorcelainNonEmpty(s, 'vogon should create docs/rw2.md before rw2');
		await s.git('add', '.');
		await s.git('commit', '-m', 'rw2');
		await waitForCheckpoint(s, 60_000);

		const headSha = await s.gitOutput('rev-parse', 'HEAD');
		const before = await fs.readFile(path.join(s.dir, 'docs/rw2.md'), 'utf8');

		const r = await runStoryInteractive(
			s.dir,
			['rewind'],
			[
				{ waitFor: 'Select a rewind point', input: '' },
				{ waitFor: 'Rewind', input: 'n' },
			],
			{ timeoutMs: 120_000 },
		);
		expect(r.exitCode).not.toBe(0);
		expect(await s.gitOutput('rev-parse', 'HEAD')).toBe(headSha);
		expect(await fs.readFile(path.join(s.dir, 'docs/rw2.md'), 'utf8')).toBe(before);
	});

	pit('story attach — confirm y amends trailers', async (ctx) => {
		s = await setupRepo(ctx.task.name);
		ctx.onTestFailed(async () => {
			await captureArtifacts(s);
		});

		await s.runPrompt(
			'create a markdown file at docs/at.md with a short paragraph about attach. Do not ask for confirmation, just make the change.',
		);
		await assertPorcelainNonEmpty(s, 'vogon should create docs/at.md before no-hook commit');
		const emptyHooksDir = await fs.mkdtemp(path.join(os.tmpdir(), 'story-empty-hooks-'));
		await s.git('-c', `core.hooksPath=${emptyHooksDir}`, 'add', '.');
		await s.git('-c', `core.hooksPath=${emptyHooksDir}`, 'commit', '-m', 'no-hook');
		await fs.rm(emptyHooksDir, { recursive: true, force: true });

		const sessionsDir = path.join(s.dir, '.git', 'story-sessions');
		const entries = await fs.readdir(sessionsDir);
		const sessionFile = entries.find((e) => e.endsWith('.json') && !e.endsWith('.tmp'));
		expect(sessionFile).toBeDefined();
		const sessionId = (sessionFile as string).replace(/\.json$/, '');

		const r = await runStoryInteractive(
			s.dir,
			['attach', sessionId, '--agent', 'vogon'],
			[{ waitFor: 'Amend HEAD now?', input: 'y' }],
			{ timeoutMs: 120_000 },
		);
		expect(r.exitCode, `${r.stdout}\n${r.stderr}`).toBe(0);
		const trailers = await s.gitOutput('log', '-1', '--format=%(trailers)', 'HEAD');
		expect(trailers).toContain('Story-Checkpoint:');
	});

	pit('story attach — confirm n cancels', async (ctx) => {
		s = await setupRepo(ctx.task.name);
		ctx.onTestFailed(async () => {
			await captureArtifacts(s);
		});

		await s.runPrompt(
			'create a markdown file at docs/at2.md with a short paragraph. Do not ask for confirmation, just make the change.',
		);
		await assertPorcelainNonEmpty(s, 'vogon should create docs/at2.md before no-hook-2 commit');
		const emptyHooksDir = await fs.mkdtemp(path.join(os.tmpdir(), 'story-empty-hooks-2-'));
		await s.git('-c', `core.hooksPath=${emptyHooksDir}`, 'add', '.');
		await s.git('-c', `core.hooksPath=${emptyHooksDir}`, 'commit', '-m', 'no-hook-2');
		await fs.rm(emptyHooksDir, { recursive: true, force: true });

		const sessionsDir = path.join(s.dir, '.git', 'story-sessions');
		const entries = await fs.readdir(sessionsDir);
		const sessionFile = entries.find((e) => e.endsWith('.json') && !e.endsWith('.tmp'));
		expect(sessionFile).toBeDefined();
		const sessionId = (sessionFile as string).replace(/\.json$/, '');

		const r = await runStoryInteractive(
			s.dir,
			['attach', sessionId, '--agent', 'vogon'],
			[{ waitFor: 'Amend HEAD now?', input: 'n' }],
			{ timeoutMs: 120_000 },
		);
		expect(r.exitCode).not.toBe(0);
		const trailers = await s.gitOutput('log', '-1', '--format=%(trailers)', 'HEAD');
		expect(trailers).not.toContain('Story-Checkpoint:');
	});

	pit('story sessions stop — confirm y ends session', async (ctx) => {
		s = await setupRepo(ctx.task.name);
		const repoDir = s.dir;
		ctx.onTestFailed(async () => {
			await captureArtifacts(s);
		});

		await withVogonInteractiveMidSession(
			repoDir,
			'create a markdown file at docs/st.md with a short paragraph. Do not commit the file. Do not ask for confirmation, just make the change.',
			async () => {
				const r = await runStoryInteractive(
					repoDir,
					['sessions', 'stop'],
					[{ waitFor: 'Stop session', input: 'y' }],
					{ timeoutMs: 120_000 },
				);
				expect(r.exitCode, `${r.stdout}\n${r.stderr}`).toBe(0);
			},
		);
	});

	pit('story sessions stop — confirm n cancels', async (ctx) => {
		s = await setupRepo(ctx.task.name);
		const repoDir = s.dir;
		ctx.onTestFailed(async () => {
			await captureArtifacts(s);
		});

		await withVogonInteractiveMidSession(
			repoDir,
			'create a markdown file at docs/st2.md with a short paragraph. Do not commit the file. Do not ask for confirmation, just make the change.',
			async () => {
				const r = await runStoryInteractive(
					repoDir,
					['sessions', 'stop'],
					[{ waitFor: 'Stop session', input: 'n' }],
					{ timeoutMs: 120_000 },
				);
				expect(r.exitCode).not.toBe(0);
			},
		);
	});
});
