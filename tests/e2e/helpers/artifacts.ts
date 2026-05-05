/**
 * Failure-artifact capture.
 *
 * Mirrors Go `entire-cli/e2e/testutil/artifacts.go` (~157 lines).
 *
 * The artifact root (`tests/e2e/artifacts/<ISO-timestamp>/`) is created
 * eagerly at `beforeAll` by `tests/e2e/setup.ts` so that console-log
 * streams land on disk incrementally — even if the global vitest timeout
 * kills the process, partial output survives.
 *
 * @packageDocumentation
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { RepoState } from './repo-state';

let artifactRootPath: string | null = null;

/** Set the run-wide artifact root. Called once by setup.ts::beforeAll. */
export function setArtifactRoot(absPath: string): void {
	artifactRootPath = absPath;
}

/**
 * Read the artifact root. Returns in-process cache if `setArtifactRoot`
 * was called; otherwise falls back to
 * `process.env.STORY_E2E_ARTIFACT_ROOT` (set by `tests/e2e/setup.ts`
 * globalSetup, which runs in a separate process context from workers).
 */
export function getArtifactRoot(): string {
	if (artifactRootPath !== null) {
		return artifactRootPath;
	}
	const fromEnv = process.env.STORY_E2E_ARTIFACT_ROOT;
	if (fromEnv !== undefined && fromEnv !== '') {
		artifactRootPath = fromEnv;
		return fromEnv;
	}
	throw new Error(
		'Artifact root not set — tests/e2e/setup.ts globalSetup must run first (exports STORY_E2E_ARTIFACT_ROOT env var)',
	);
}

/**
 * Derive a per-test artifact dir slug from the vitest task name — lowercase,
 * non-alphanumeric to hyphen, trimmed to 100 chars. Mirrors Go
 * `testutil.artifactDir(t)` slugging.
 */
export function testArtifactDir(testName: string): string {
	const slug = testName
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 100);
	return slug === '' ? 'anonymous' : slug;
}

/**
 * Capture artifacts for a failed test: copies console.log, git-log.txt,
 * git-tree.txt, `.story/logs/`, checkpoint-tree dump, settings
 * (`.story/settings*.json`), and (when `STORY_E2E_KEEP_REPOS=1`) a
 * symlink to the preserved repo. Best-effort — swallows individual
 * errors so one missing source doesn't mask the original test failure.
 *
 * Mirrors Go `testutil.CaptureArtifacts`.
 *
 * @example
 * afterEach(async (ctx) => {
 *   ctx.onTestFailed(async () => {
 *     await captureArtifacts(s);
 *   });
 *   await teardownRepo(s);
 * });
 * // On failure, writes to <artifactRoot>/<test-slug>/:
 * //   console.log                 (already streamed during test)
 * //   git-log.txt                 (full git log from HEAD)
 * //   git-tree.txt                (ls-tree -r HEAD)
 * //   story-logs/                 (copied from <repo>/.story/logs/)
 * //   checkpoint-tree.txt         (ls-tree -r story/checkpoints/v1)
 * //   settings-local.json         (copied from .story/settings.local.json)
 * //   repo (symlink)              (only when STORY_E2E_KEEP_REPOS=1)
 * // Unchanged: repo working tree (capture is read-only).
 */
export async function captureArtifacts(s: RepoState | undefined): Promise<void> {
	if (s === undefined) {
		// setupRepo itself failed — nothing to capture.
		return;
	}
	await fs.mkdir(s.artifactDir, { recursive: true, mode: 0o755 });

	await Promise.allSettled([
		captureGitLog(s),
		captureGitTree(s),
		captureStoryLogs(s),
		captureCheckpointTree(s),
		captureSettings(s),
		captureRepoSymlink(s),
	]);
}

// ---------------------------------------------------------------------------
// Per-artifact capture helpers (best-effort; each swallows its own errors)
// ---------------------------------------------------------------------------

async function captureGitLog(s: RepoState): Promise<void> {
	try {
		const out = await s.gitOutput('log', '--all', '--oneline', '--graph');
		await fs.writeFile(path.join(s.artifactDir, 'git-log.txt'), out, { mode: 0o644 });
	} catch {
		// Best-effort
	}
}

async function captureGitTree(s: RepoState): Promise<void> {
	try {
		const out = await s.gitOutput('ls-tree', '-r', 'HEAD');
		await fs.writeFile(path.join(s.artifactDir, 'git-tree.txt'), out, { mode: 0o644 });
	} catch {
		// Best-effort
	}
}

async function captureStoryLogs(s: RepoState): Promise<void> {
	const src = path.join(s.dir, '.story', 'logs');
	const dst = path.join(s.artifactDir, 'story-logs');
	try {
		await fs.cp(src, dst, { recursive: true, force: true });
	} catch {
		// Best-effort
	}
}

async function captureCheckpointTree(s: RepoState): Promise<void> {
	try {
		const out = await s.gitOutput('ls-tree', '-r', 'story/checkpoints/v1');
		await fs.writeFile(path.join(s.artifactDir, 'checkpoint-tree.txt'), out, {
			mode: 0o644,
		});
	} catch {
		// Branch may not exist yet — skip.
	}
}

async function captureSettings(s: RepoState): Promise<void> {
	for (const name of ['settings.json', 'settings.local.json']) {
		const src = path.join(s.dir, '.story', name);
		try {
			const data = await fs.readFile(src);
			await fs.writeFile(path.join(s.artifactDir, name), data, { mode: 0o644 });
		} catch {
			// Either file is optional.
		}
	}
}

async function captureRepoSymlink(s: RepoState): Promise<void> {
	const keep =
		(process.env.STORY_E2E_KEEP_REPOS !== undefined && process.env.STORY_E2E_KEEP_REPOS !== '') ||
		(process.env.ENTIRE_E2E_KEEP_REPOS !== undefined && process.env.ENTIRE_E2E_KEEP_REPOS !== '');
	if (!keep) {
		return;
	}
	const link = path.join(s.artifactDir, 'repo');
	try {
		await fs.unlink(link);
	} catch {
		// Not there — fine.
	}
	try {
		await fs.symlink(s.dir, link);
	} catch {
		// Best-effort
	}
}
