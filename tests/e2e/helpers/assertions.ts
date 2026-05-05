/**
 * E2E assertion helpers — file / commit / checkpoint / trailer /
 * metadata / session-state.
 *
 * Mirrors Go `entire-cli/e2e/testutil/assertions.go` (~445 lines, 20+
 * helpers). Naming red line (Story, not Entire):
 *
 *  - Trailer key `Story-Checkpoint:` (Go uses `Entire-Checkpoint:`)
 *  - Metadata branch `story/checkpoints/v1` (Go `entire/checkpoints/v1`)
 *  - Shadow branches under `refs/heads/story/*` (exclude `story/checkpoints/*`)
 *  - Session-state dir `.git/story-sessions/` (Go `.git/entire-sessions/`)
 *
 * @packageDocumentation
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fg from 'node:fs/promises';
import path from 'node:path';
import { type ExecaError, execa } from 'execa';
import { expect } from 'vitest';
import { isolatedSpawnEnv } from './env';
import { checkpointPath, readCheckpointMetadata, readSessionMetadata } from './metadata';
import type { RepoState } from './repo-state';

// ---------------------------------------------------------------------------
// Regex constants
// ---------------------------------------------------------------------------

/** Mirrors Go `testutil/assertions.go:28 hexIDPattern`. */
const HEX_ID_PATTERN = /^[0-9a-f]{12}$/;

// ---------------------------------------------------------------------------
// File / commit assertions
// ---------------------------------------------------------------------------

/**
 * Assert at least one file matches `globPat` (relative to `dir`).
 * Mirrors Go `testutil.AssertFileExists`. Uses Node 22 `fs.glob` (stable).
 */
export async function assertFileExists(dir: string, globPat: string): Promise<void> {
	const matches = await globFiles(dir, globPat);
	expect(matches, `expected files matching ${globPat} in ${dir}`).not.toHaveLength(0);
}

/**
 * Poll until `globPat` matches; fail after `timeoutMs`. Mirrors Go
 * `testutil.WaitForFileExists`.
 */
export async function waitForFileExists(
	dir: string,
	globPat: string,
	timeoutMs: number,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const matches = await globFiles(dir, globPat);
		if (matches.length > 0) {
			return;
		}
		await sleep(500);
	}
	throw new Error(`expected files matching ${globPat} in ${dir} within ${timeoutMs}ms`);
}

/**
 * Assert at least `atLeast` new commits since `s.headBefore`. Polls up
 * to 20s (Go default). Mirrors Go `testutil.AssertNewCommits`.
 */
export async function assertNewCommits(s: RepoState, atLeast: number): Promise<void> {
	await assertNewCommitsWithTimeout(s, atLeast, 20_000);
}

/**
 * Configurable-timeout variant. Mirrors Go
 * `testutil.AssertNewCommitsWithTimeout` (useful when WaitFor pane could
 * settle on stale TUI content).
 */
export async function assertNewCommitsWithTimeout(
	s: RepoState,
	atLeast: number,
	timeoutMs: number,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let lastCount = 0;
	while (Date.now() < deadline) {
		const out = await s.gitOutput('log', '--oneline', `${s.headBefore}..HEAD`);
		const lines = out === '' ? [] : out.split('\n').filter((l) => l !== '');
		lastCount = lines.length;
		if (lastCount >= atLeast) {
			return;
		}
		await sleep(500);
	}
	throw new Error(
		`expected at least ${atLeast} new commit(s), got ${lastCount} after ${timeoutMs}ms`,
	);
}

// ---------------------------------------------------------------------------
// Checkpoint branch
// ---------------------------------------------------------------------------

/**
 * Poll `story/checkpoints/v1` until it advances from `s.checkpointBefore`;
 * fail after `timeoutMs`. Mirrors Go `testutil.WaitForCheckpoint`.
 */
export async function waitForCheckpoint(s: RepoState, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const after = await gitRevParseOrEmpty(s.dir, 'story/checkpoints/v1');
		if (after !== s.checkpointBefore) {
			return;
		}
		await sleep(200);
	}
	throw new Error(`checkpoint branch did not advance within ${timeoutMs}ms`);
}

/** Poll until the branch advances from the given ref. Mirrors Go `testutil.WaitForCheckpointAdvanceFrom`. */
export async function waitForCheckpointAdvanceFrom(
	dir: string,
	fromRef: string,
	timeoutMs: number,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const after = await gitRevParseOrEmpty(dir, 'story/checkpoints/v1');
		if (after !== '' && after !== fromRef) {
			return;
		}
		await sleep(200);
	}
	throw new Error(
		`checkpoint branch did not advance from ${fromRef.slice(0, 8)} within ${timeoutMs}ms`,
	);
}

/** Assert the branch moved. Mirrors Go `testutil.AssertCheckpointAdvanced`. */
export async function assertCheckpointAdvanced(s: RepoState): Promise<void> {
	const after = await gitRevParseOrEmpty(s.dir, 'story/checkpoints/v1');
	expect(after, 'checkpoint branch did not advance').not.toBe(s.checkpointBefore);
}

/** Assert the branch did NOT move. Mirrors Go `testutil.AssertCheckpointNotAdvanced`. */
export async function assertCheckpointNotAdvanced(s: RepoState): Promise<void> {
	const after = await gitRevParseOrEmpty(s.dir, 'story/checkpoints/v1');
	expect(after, 'checkpoint branch advanced unexpectedly').toBe(s.checkpointBefore);
}

/**
 * Poll until every shadow branch (`refs/heads/story/*` excluding
 * `refs/heads/story/checkpoints/*`) is cleaned up. Mirrors Go
 * `testutil.WaitForNoShadowBranches`.
 */
export async function waitForNoShadowBranches(dir: string, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let lastShadow: string[] = [];
	while (Date.now() < deadline) {
		lastShadow = await listShadowBranches(dir);
		if (lastShadow.length === 0) {
			return;
		}
		await sleep(200);
	}
	throw new Error(
		`shadow branches should be cleaned up within ${timeoutMs}ms, found: ${lastShadow.join(', ')}`,
	);
}

/** Opposite: session still active, shadow must persist. Mirrors Go `testutil.AssertHasShadowBranches`. */
export async function assertHasShadowBranches(dir: string): Promise<void> {
	const shadow = await listShadowBranches(dir);
	expect(shadow, 'expected at least one shadow branch to persist').not.toHaveLength(0);
}

/**
 * Synchronous (one-shot) assertion that no shadow branches exist — use when
 * the session finished well before the assertion (turn-end has already run,
 * no polling needed). `waitForNoShadowBranches` is the polling sibling for
 * cases where condensation may still be in flight.
 */
export async function assertNoShadowBranches(dir: string): Promise<void> {
	const shadow = await listShadowBranches(dir);
	expect(shadow, `expected no shadow branches, found: ${shadow.join(', ')}`).toHaveLength(0);
}

// ---------------------------------------------------------------------------
// Trailer / ID
// ---------------------------------------------------------------------------

/**
 * Extract the `Story-Checkpoint:` trailer value (first occurrence) from
 * commit `ref`. Empty string when absent. Mirrors Go
 * `testutil.GetCheckpointTrailer` with the trailer key rewritten from
 * `Entire-Checkpoint` to `Story-Checkpoint` (**naming red line**).
 */
export async function getCheckpointTrailer(dir: string, ref: string): Promise<string> {
	const out = await gitOutputSafe(dir, [
		'log',
		'-1',
		'--format=%(trailers:key=Story-Checkpoint,valueonly)',
		ref,
	]);
	return out.trim();
}

/**
 * Assert `ref` has a `Story-Checkpoint:` trailer matching the 12-hex ID
 * regex; return its value. Mirrors Go `testutil.AssertHasCheckpointTrailer`.
 */
export async function assertHasCheckpointTrailer(dir: string, ref: string): Promise<string> {
	const trailer = await getCheckpointTrailer(dir, ref);
	expect(trailer, `no Story-Checkpoint trailer on ${ref}`).not.toBe('');
	assertCheckpointIdFormat(trailer);
	return trailer;
}

/** Assert commit has no such trailer. Mirrors Go `testutil.AssertNoCheckpointTrailer`. */
export async function assertNoCheckpointTrailer(dir: string, ref: string): Promise<void> {
	const trailer = await getCheckpointTrailer(dir, ref);
	expect(trailer, `expected no Story-Checkpoint trailer on ${ref}, got "${trailer}"`).toBe('');
}

/**
 * Assert the argument matches `/^[0-9a-f]{12}$/`. Mirrors Go
 * `testutil.AssertCheckpointIDFormat`.
 */
export function assertCheckpointIdFormat(id: string): void {
	expect(id, `checkpoint ID "${id}" should be 12 lowercase hex chars`).toMatch(HEX_ID_PATTERN);
}

// ---------------------------------------------------------------------------
// Metadata branch
// ---------------------------------------------------------------------------

/**
 * Assert the checkpoint ID appears on the branch AND its metadata.json
 * blob is readable. Mirrors Go `testutil.AssertCheckpointExists`.
 */
export async function assertCheckpointExists(dir: string, checkpointId: string): Promise<void> {
	const logOut = await gitOutputSafe(dir, [
		'log',
		'story/checkpoints/v1',
		`--grep=${checkpointId}`,
		'--oneline',
	]);
	expect(logOut, `checkpoint ${checkpointId} not found on checkpoint branch`).not.toBe('');

	const blobPath = `${checkpointPath(checkpointId)}/metadata.json`;
	const blob = `story/checkpoints/v1:${blobPath}`;
	const raw = await gitOutputSafe(dir, ['show', blob]);
	expect(raw, `checkpoint ${checkpointId} metadata not found at ${blobPath}`).not.toBe('');
}

/** Poll variant. Mirrors Go `testutil.WaitForCheckpointExists`. */
export async function waitForCheckpointExists(
	dir: string,
	checkpointId: string,
	timeoutMs: number,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const logOut = await gitOutputSafe(dir, [
			'log',
			'story/checkpoints/v1',
			`--grep=${checkpointId}`,
			'--oneline',
		]);
		if (logOut !== '') {
			const blobPath = `${checkpointPath(checkpointId)}/metadata.json`;
			const blob = `story/checkpoints/v1:${blobPath}`;
			const raw = await gitOutputSafe(dir, ['show', blob]);
			if (raw !== '') {
				return;
			}
		}
		await sleep(200);
	}
	throw new Error(
		`checkpoint ${checkpointId} not found on checkpoint branch within ${timeoutMs}ms`,
	);
}

/**
 * Assert the checkpoint ID appears in ≥ `n` commit subjects via `git log
 * --grep=<id>`. Used to verify both the initial post-commit condensation
 * AND the end-of-turn catch-up reference the same ID. Mirrors Go
 * `testutil.AssertCheckpointInLastN`.
 */
export async function assertCheckpointInLastN(
	dir: string,
	checkpointId: string,
	n: number,
): Promise<void> {
	const out = await gitOutputSafe(dir, [
		'log',
		`--grep=${checkpointId}`,
		'--format=%s',
		'story/checkpoints/v1',
	]);
	const lines = out.split('\n').filter((l) => l !== '');
	expect(
		lines.length,
		`expected at least ${n} commits mentioning ${checkpointId} on checkpoint branch, got ${lines.length}`,
	).toBeGreaterThanOrEqual(n);
}

/** Assert required metadata fields non-empty. Mirrors Go `testutil.AssertCheckpointMetadataComplete`. */
export async function assertCheckpointMetadataComplete(
	dir: string,
	checkpointId: string,
): Promise<void> {
	const meta = await readCheckpointMetadata(dir, checkpointId);
	expect(meta.cli_version, `checkpoint ${checkpointId}: cli_version should be set`).not.toBe('');
	expect(meta.strategy, `checkpoint ${checkpointId}: strategy should be set`).not.toBe('');
	expect(
		meta.sessions.length,
		`checkpoint ${checkpointId}: should have at least 1 session`,
	).toBeGreaterThan(0);
	expect(meta.checkpoint_id, 'checkpoint metadata ID should match expected').toBe(checkpointId);
}

/** Exact-match files_touched. Mirrors Go `testutil.AssertCheckpointFilesTouched`. */
export async function assertCheckpointFilesTouched(
	dir: string,
	checkpointId: string,
	expected: readonly string[],
): Promise<void> {
	const meta = await readCheckpointMetadata(dir, checkpointId);
	expect(new Set(meta.files_touched), `checkpoint ${checkpointId}: files_touched mismatch`).toEqual(
		new Set(expected),
	);
}

/** Contains-match. Mirrors Go `testutil.AssertCheckpointFilesTouchedContains`. */
export async function assertCheckpointFilesTouchedContains(
	dir: string,
	checkpointId: string,
	file: string,
): Promise<void> {
	const meta = await readCheckpointMetadata(dir, checkpointId);
	expect(
		meta.files_touched,
		`checkpoint ${checkpointId}: files_touched should contain ${file}`,
	).toContain(file);
}

/** Assert checkpoint metadata has exactly one session. Mirrors Go `testutil.AssertCheckpointHasSingleSession`. */
export async function assertCheckpointHasSingleSession(
	dir: string,
	checkpointId: string,
): Promise<void> {
	const meta = await readCheckpointMetadata(dir, checkpointId);
	expect(meta.sessions.length, `expected 1 session in checkpoint ${checkpointId}`).toBe(1);
}

/** Assert commit's trailer is valid AND corresponding metadata exists. Mirrors Go `testutil.AssertCommitLinkedToCheckpoint`. */
export async function assertCommitLinkedToCheckpoint(dir: string, ref: string): Promise<void> {
	const trailer = await assertHasCheckpointTrailer(dir, ref);
	await assertCheckpointExists(dir, trailer);
}

/** Assert across multiple checkpoint IDs that session IDs are unique. Mirrors Go `testutil.AssertDistinctSessions`. */
export async function assertDistinctSessions(
	dir: string,
	checkpointIds: readonly string[],
): Promise<void> {
	const seen = new Set<string>();
	for (const cpId of checkpointIds) {
		const sm = await readSessionMetadata(dir, cpId, 0);
		expect(
			seen.has(sm.session_id),
			`duplicate session_id ${sm.session_id} across checkpoints`,
		).toBe(false);
		seen.add(sm.session_id);
	}
}

// ---------------------------------------------------------------------------
// Prompt buffer helpers
// ---------------------------------------------------------------------------

/**
 * Read the filesystem-layer `prompt.txt` for a session. Returns `null` when
 * the file does not exist (which is the state
 * [`src/strategy/hooks-post-commit.ts`](src/strategy/hooks-post-commit.ts)
 * leaves it in after `clearFilesystemPrompt` runs: commit condensed +
 * `state.filesTouched.length === 0`).
 *
 * This is NOT the permanent copy — use
 * {@link readPromptTxtFromCheckpointTree} to read the archived prompt inside
 * `refs/heads/story/checkpoints/v1`.
 *
 * @example
 * await readPromptTxtOrNull('/repo', 'sess-abc');
 * // → "first prompt\n\n---\n\nsecond prompt"   (two turns, not yet condensed)
 * // → null                                     (condensed away)
 */
export async function readPromptTxtOrNull(
	repoDir: string,
	sessionId: string,
): Promise<string | null> {
	const p = path.join(repoDir, '.story', 'metadata', sessionId, 'prompt.txt');
	try {
		return await fs.readFile(p, 'utf8');
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
			return null;
		}
		throw e;
	}
}

/**
 * Read `prompt.txt` from the archived tree on `refs/heads/story/checkpoints/v1`
 * (the permanent per-checkpoint copy) at
 * `<checkpointPath>/<sessionIndex>/prompt.txt`. Returns `''` when the blob is
 * missing (no matching session index, or the file was never written).
 *
 * Mirrors the read path in
 * [`src/strategy/prompts.ts`](src/strategy/prompts.ts) `readSessionPromptFromTree`
 * — helpful for asserting that a prompt removed from the filesystem via
 * `clearFilesystemPrompt` still exists in the checkpoint tree.
 *
 * @example
 * await readPromptTxtFromCheckpointTree('/repo', '069fe90da33a', 0);
 * // → "generate a README"   (archived from the first session)
 */
export async function readPromptTxtFromCheckpointTree(
	repoDir: string,
	checkpointId: string,
	sessionIndex = 0,
): Promise<string> {
	const blob = `story/checkpoints/v1:${checkpointPath(checkpointId)}/${sessionIndex}/prompt.txt`;
	return gitOutputSafe(repoDir, ['show', blob]);
}

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

/**
 * Poll `.git/story-sessions/*.json` until no session has `phase:
 * "active"`; fail after `timeoutMs`. Mirrors Go
 * `testutil.WaitForSessionIdle` (which reads `.git/entire-sessions/`).
 */
export async function waitForSessionIdle(dir: string, timeoutMs: number): Promise<void> {
	const stateDir = path.join(dir, '.git', 'story-sessions');
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		let entries: string[] = [];
		try {
			entries = await fs.readdir(stateDir);
		} catch {
			// Directory may not exist yet — keep polling.
			await sleep(200);
			continue;
		}
		let anyActive = false;
		for (const entry of entries) {
			if (!entry.endsWith('.json') || entry.endsWith('.tmp')) {
				continue;
			}
			let data = '';
			try {
				data = await fs.readFile(path.join(stateDir, entry), 'utf-8');
			} catch {
				continue;
			}
			try {
				const parsed = JSON.parse(data) as { phase?: string };
				if (parsed.phase === 'active') {
					anyActive = true;
					break;
				}
			} catch {
				// Bad JSON — skip silently (may be mid-write).
			}
		}
		if (!anyActive) {
			return;
		}
		await sleep(200);
	}
	throw new Error(`session(s) did not transition to idle within ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// Deep validation
// ---------------------------------------------------------------------------

export interface DeepCheckpointValidation {
	checkpointId: string;
	strategy?: string;
	filesTouched?: readonly string[];
	expectedPrompts?: readonly string[];
	expectedTranscriptContent?: readonly string[];
}

/**
 * Multi-field checkpoint validation. Mirrors Go
 * `testutil.ValidateCheckpointDeep`: metadata.json completeness +
 * optional strategy/files_touched match + transcript JSONL validity +
 * SHA-256 content-hash match (`sha256:` + hex(transcript bytes)) +
 * prompt.txt content contains.
 */
export async function validateCheckpointDeep(
	dir: string,
	v: DeepCheckpointValidation,
): Promise<void> {
	await assertCheckpointExists(dir, v.checkpointId);
	await assertCheckpointMetadataComplete(dir, v.checkpointId);

	if (v.strategy !== undefined && v.strategy !== '') {
		const meta = await readCheckpointMetadata(dir, v.checkpointId);
		expect(meta.strategy, `checkpoint ${v.checkpointId}: strategy mismatch`).toBe(v.strategy);
	}

	if (v.filesTouched !== undefined && v.filesTouched.length > 0) {
		await assertCheckpointFilesTouched(dir, v.checkpointId, v.filesTouched);
	}

	const base = checkpointPath(v.checkpointId);

	// Session metadata
	const sessionBlob = `story/checkpoints/v1:${base}/0/metadata.json`;
	const sessionRaw = await gitOutputSafe(dir, ['show', sessionBlob]);
	expect(sessionRaw, `session metadata should exist at ${sessionBlob}`).not.toBe('');
	const sessionMeta = JSON.parse(sessionRaw) as Record<string, unknown>;
	expect(sessionMeta.checkpoint_id, 'session metadata checkpoint_id should match').toBe(
		v.checkpointId,
	);
	expect(sessionMeta.created_at, 'session metadata should have created_at').toBeDefined();

	// Transcript JSONL — read as raw bytes (NOT the trimmed-stdout
	// helper) so SHA-256 matches what the hook actually hashed.
	const transcriptBlob = `story/checkpoints/v1:${base}/0/full.jsonl`;
	const transcriptBytes = await gitShowBytes(dir, transcriptBlob);
	const transcriptRaw = new TextDecoder().decode(transcriptBytes);
	expect(transcriptRaw, `transcript should exist at ${transcriptBlob}`).not.toBe('');

	const nonEmpty = transcriptRaw.split('\n').filter((l) => l.trim() !== '').length;
	expect(nonEmpty, 'transcript should have at least one line').toBeGreaterThan(0);

	if (v.expectedTranscriptContent !== undefined) {
		for (const needle of v.expectedTranscriptContent) {
			expect(transcriptRaw, `transcript should contain "${needle}"`).toContain(needle);
		}
	}

	// Content hash — compare against the bytes-level SHA-256 that the
	// hook produced (see `src/checkpoint/*` for the writer).
	const hashBlob = `story/checkpoints/v1:${base}/0/content_hash.txt`;
	const hashRaw = await gitOutputSafe(dir, ['show', hashBlob]);
	if (hashRaw !== '') {
		const expected = `sha256:${crypto.createHash('sha256').update(transcriptBytes).digest('hex')}`;
		expect(hashRaw.trim(), 'content hash should match transcript SHA-256').toBe(expected);
	}

	// Prompt content
	if (v.expectedPrompts !== undefined && v.expectedPrompts.length > 0) {
		const promptBlob = `story/checkpoints/v1:${base}/0/prompt.txt`;
		const promptRaw = await gitOutputSafe(dir, ['show', promptBlob]);
		for (const needle of v.expectedPrompts) {
			expect(promptRaw, `prompt.txt should contain "${needle}"`).toContain(needle);
		}
	}
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function gitOutputSafe(dir: string, args: readonly string[]): Promise<string> {
	try {
		const res = await execa('git', [...args], { cwd: dir, env: isolatedSpawnEnv() });
		return (res.stdout?.toString() ?? '').trim();
	} catch (e) {
		void (e as ExecaError);
		return '';
	}
}

/**
 * Read a git blob as raw bytes — unlike {@link gitOutputSafe} this does
 * NOT trim trailing newlines, because SHA-256 comparisons must hash the
 * exact bytes the hook wrote.
 *
 * Uses `node:child_process.execFile` with a `Buffer` stdout instead of
 * execa — execa v9 auto-decodes stdout to UTF-8 by default and the
 * `encoding: 'buffer'` option doesn't round-trip cleanly for us here.
 */
async function gitShowBytes(dir: string, blob: string): Promise<Uint8Array> {
	const { execFile } = await import('node:child_process');
	return new Promise<Uint8Array>((resolve) => {
		execFile(
			'git',
			['show', blob],
			{
				cwd: dir,
				env: isolatedSpawnEnv(),
				encoding: 'buffer',
				maxBuffer: 50 * 1024 * 1024,
			},
			(err, stdout) => {
				if (err) {
					resolve(new Uint8Array());
					return;
				}
				const buf = stdout instanceof Buffer ? stdout : Buffer.from(String(stdout));
				resolve(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
			},
		);
	});
}

async function gitRevParseOrEmpty(dir: string, ref: string): Promise<string> {
	try {
		const res = await execa('git', ['rev-parse', '--verify', ref], {
			cwd: dir,
			env: isolatedSpawnEnv(),
		});
		return (res.stdout?.toString() ?? '').trim();
	} catch {
		return '';
	}
}

async function listShadowBranches(dir: string): Promise<string[]> {
	const out = await gitOutputSafe(dir, [
		'for-each-ref',
		'--format=%(refname:short)',
		'refs/heads/story/',
	]);
	if (out === '') {
		return [];
	}
	const shadow: string[] = [];
	for (const raw of out.split('\n')) {
		const b = raw.trim();
		if (b === '' || b.startsWith('story/checkpoints')) {
			continue;
		}
		shadow.push(b);
	}
	return shadow;
}

async function globFiles(dir: string, globPat: string): Promise<string[]> {
	// Use the standard `glob` method from fs/promises (Node 22 stable).
	const matches: string[] = [];
	const iterable = fg.glob(globPat, { cwd: dir });
	for await (const m of iterable) {
		matches.push(path.isAbsolute(m) ? m : path.join(dir, m));
	}
	return matches;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}
