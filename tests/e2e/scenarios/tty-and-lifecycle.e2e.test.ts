/**
 * TTY + lifecycle E2E scenarios — coverage for the paths the default
 * `setupRepo` helper shortcuts past (empty repo, no-commit turns,
 * `clearFilesystemPrompt` partial vs full branches, default
 * `commit_linking: "prompt"` with no-content session).
 *
 * These three paths were the root cause of every "why do I see X but not Y?"
 * question in the March 2026 triage of `~/dev/story-e2e`:
 *
 *  - `setupRepo()` forces `--allow-empty` initial commit → never exercises
 *    the empty-repo bootstrap where `git rev-parse HEAD` fails
 *  - `setupRepo()` forces `commit_linking: "always"` → never exercises the
 *    default interactive / content-detection path
 *  - No existing scenario asserts on `.story/metadata/<sid>/prompt.txt`
 *    being unlinked by `clearFilesystemPrompt` or preserved on partial commit
 *
 * Each assertion maps to a specific TS implementation path, so if someone
 * refactors condense / carry-forward and accidentally breaks the clear /
 * preserve semantics this test will fail.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { captureArtifacts } from '../helpers/artifacts';
import {
	assertHasCheckpointTrailer,
	assertNoShadowBranches,
	readPromptTxtFromCheckpointTree,
	readPromptTxtOrNull,
} from '../helpers/assertions';
import { type RepoState, setupRepo, setupRepoEmpty, teardownRepo } from '../helpers/repo-state';
import { runVogonInteractive } from '../helpers/vogon-runner';

/**
 * Resolve the lone session id under `.git/story-sessions/`.
 * Prefer `<id>.json`; when HEAD is still unborn, init may only write `<id>.model` (model hint sidecar).
 * Multiple `*.json` or multiple `*.model` without a single json is ambiguous — throws.
 */
async function getSingleSessionId(dir: string): Promise<string> {
	const sessionsDir = path.join(dir, '.git', 'story-sessions');
	const entries = await fs.readdir(sessionsDir);
	const jsonFiles = entries.filter((e) => e.endsWith('.json') && !e.includes('.tmp'));
	const modelFiles = entries.filter((e) => e.endsWith('.model') && !e.includes('.tmp'));

	if (jsonFiles.length > 1) {
		throw new Error(
			`ambiguous session state in ${sessionsDir}: multiple json files: ${jsonFiles.join(', ')}`,
		);
	}
	if (jsonFiles.length === 1) {
		return jsonFiles[0]!.replace(/\.json$/, '');
	}

	if (modelFiles.length === 0) {
		throw new Error(`no session state in ${sessionsDir}: ${entries.join(', ')}`);
	}
	if (modelFiles.length > 1) {
		throw new Error(
			`ambiguous session state in ${sessionsDir}: multiple model sidecars: ${modelFiles.join(', ')}`,
		);
	}
	return modelFiles[0]!.replace(/\.model$/, '');
}

async function readSessionStateJSON(
	dir: string,
	sessionId: string,
): Promise<Record<string, unknown>> {
	const p = path.join(dir, '.git', 'story-sessions', `${sessionId}.json`);
	const raw = await fs.readFile(p, 'utf8');
	return JSON.parse(raw) as Record<string, unknown>;
}

async function readStoryLog(dir: string): Promise<string> {
	try {
		return await fs.readFile(path.join(dir, '.story', 'logs', 'story.log'), 'utf8');
	} catch {
		return '';
	}
}

describe('TTY + lifecycle scenarios (Vogon)', () => {
	let s: RepoState | undefined;

	afterEach(async () => {
		if (s !== undefined) {
			await teardownRepo(s);
			s = undefined;
		}
	});

	// Repro of user's 2026-03 report: fresh `git init` + `story enable`, then
	// agent turn fires → turn-start "failed to get HEAD" warn + turn-end
	// skips checkpoint. No shadow branch. prompt.txt written (turn-start runs
	// before the HEAD check), but full.jsonl absent (turn-end early-exits
	// before `ag.readTranscript` copies the transcript).
	it('empty repo bootstrap — fresh init without HEAD skips checkpoint, re-activates after first commit', async (ctx) => {
		s = await setupRepoEmpty(ctx.task.name);
		ctx.onTestFailed(async () => {
			await captureArtifacts(s);
		});

		await s.runPrompt('hi there'); // pure chat — Vogon parser yields 0 actions

		// Log must carry the diagnostic breadcrumbs we assert root-cause on.
		const log1 = await readStoryLog(s.dir);
		expect(log1, 'turn-start should warn about empty HEAD').toContain(
			'failed to initialize session state',
		);
		expect(log1, 'turn-end should skip the checkpoint').toContain(
			'skipping checkpoint - will activate after first commit',
		);

		// prompt.txt was written by turn-start (which runs before the
		// HEAD check); full.jsonl is NOT written because turn-end early-exits.
		const sid = await getSingleSessionId(s.dir);
		const promptFs = await readPromptTxtOrNull(s.dir, sid);
		expect(
			promptFs,
			'turn-start should have written prompt.txt before the empty-HEAD early-exit',
		).toBe('hi there');
		await expect(
			fs.stat(path.join(s.dir, '.story', 'metadata', sid, 'full.jsonl')),
			'turn-end must early-exit BEFORE copying the transcript when HEAD is unborn',
		).rejects.toMatchObject({ code: 'ENOENT' });

		// No shadow branch built — saveStep is never called.
		await assertNoShadowBranches(s.dir);

		// Once the user does the first commit, the next turn must succeed:
		// session state gets a non-empty baseCommit. Still no shadow branch
		// (second turn is pure chat again, no file modifications) but the
		// init path must now write a full session state JSON.
		await s.git('commit', '--allow-empty', '-m', 'feat: init');
		await s.runPrompt('hello again');

		const sid2 = await getSingleSessionId(s.dir);
		const state2 = await readSessionStateJSON(s.dir, sid2);
		expect(
			state2.base_commit,
			'after first commit, new turn must record HEAD as base_commit',
		).not.toBe('');
		expect(typeof state2.base_commit).toBe('string');
		expect(((state2.base_commit as string) ?? '').length).toBeGreaterThan(0);

		// Still no shadow branch (no files were modified in either turn).
		await assertNoShadowBranches(s.dir);
	}, 120_000);

	// Repro of "why does prompt.txt only have one line?" — the answer was
	// clearFilesystemPrompt fires after full-commit condensation. Here we
	// run two pure-chat turns with NO commit between them; prompt.txt must
	// accumulate with the canonical `\n\n---\n\n` separator.
	it('prompt.txt accumulation — two no-commit turns in one session append with \\n\\n---\\n\\n', async (ctx) => {
		s = await setupRepo(ctx.task.name);
		ctx.onTestFailed(async () => {
			await captureArtifacts(s);
		});

		// Two prompts, one subprocess → same session-id, no commit in between.
		// Both prompts are pure chat (no create/modify/delete keywords
		// Vogon's parser recognizes) so turn-end sees no modified files and
		// skips saveStep on both turns.
		await runVogonInteractive(s.dir, ['first thing to say', 'second thing to say']);

		const sid = await getSingleSessionId(s.dir);
		const promptFs = await readPromptTxtOrNull(s.dir, sid);
		expect(promptFs, 'prompt.txt should accumulate both turns until the next condense').toBe(
			'first thing to say\n\n---\n\nsecond thing to say',
		);

		// Both turns had no agent file writes → no shadow branch built.
		await assertNoShadowBranches(s.dir);
	}, 180_000);

	// Covers the TWO clearFilesystemPrompt branches in
	// hooks-post-commit.ts:732-739. Full commit → filesTouched=[] →
	// unlink prompt.txt; partial commit → remaining files stay → prompt.txt
	// MUST persist for the next condense to read.
	it('clearFilesystemPrompt — full commit unlinks prompt.txt and archives it into checkpoints/v1', async (ctx) => {
		s = await setupRepo(ctx.task.name);
		ctx.onTestFailed(async () => {
			await captureArtifacts(s);
		});

		// Vogon writes the file; we (the "user") commit it ourselves so
		// the post-commit hook gets to condense + carry-forward.
		await s.runPrompt('create a markdown file at hello.md about greetings. Do not commit.');
		const sid = await getSingleSessionId(s.dir);

		// Sanity: prompt.txt is present on disk BEFORE we commit.
		expect(
			await readPromptTxtOrNull(s.dir, sid),
			'prompt.txt must be on disk before the user-driven commit triggers condense',
		).not.toBeNull();

		await s.git('add', '-A');
		await s.git('commit', '-m', 'land the greetings note');

		// Trailer is injected on commit (commit_linking=always fast path).
		const cpId = await assertHasCheckpointTrailer(s.dir, 'HEAD');

		// Full branch: everything committed → prompt.txt unlinked.
		expect(
			await readPromptTxtOrNull(s.dir, sid),
			'prompt.txt must be unlinked after full commit (clearFilesystemPrompt)',
		).toBeNull();

		// The prompt is still recoverable from the permanent v1 checkpoint
		// tree — that's the whole point of the clear: in-flight buffer is
		// redundant once the content has been archived.
		const archived = await readPromptTxtFromCheckpointTree(s.dir, cpId, 0);
		expect(archived, 'prompt should be archived inside story/checkpoints/v1 tree').not.toBe('');
		expect(archived, 'archived prompt should contain the original prompt').toContain('greetings');
	}, 180_000);

	it('clearFilesystemPrompt — partial commit preserves prompt.txt so next condense can read it', async (ctx) => {
		s = await setupRepo(ctx.task.name);
		ctx.onTestFailed(async () => {
			await captureArtifacts(s);
		});

		// Two files created in one turn. "Do not commit." keeps vogon from
		// committing; the user partial-commits just one of them below.
		await s.runPrompt(
			'create two markdown files: alpha.md about alpha, beta.md about beta. Do not commit.',
		);
		const sid = await getSingleSessionId(s.dir);

		// Both files should be on disk.
		await fs.stat(path.join(s.dir, 'alpha.md'));
		await fs.stat(path.join(s.dir, 'beta.md'));

		// Partial commit: stage only alpha.md.
		await s.git('add', 'alpha.md');
		await s.git('commit', '-m', 'partial: only alpha');

		// After partial commit, `state.filesTouched` should still
		// contain beta.md → clearFilesystemPrompt branch is NOT taken.
		const promptFs = await readPromptTxtOrNull(s.dir, sid);
		expect(
			promptFs,
			'prompt.txt must persist after partial commit — the NEXT condense still needs it',
		).not.toBeNull();
		expect(promptFs, 'persisted prompt.txt should still carry the original prompt').toContain(
			'alpha',
		);
	}, 180_000);
});
