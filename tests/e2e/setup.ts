/**
 * E2E global setup — runs once before any `tests/e2e/**\/*.e2e.test.ts`
 * scenario (wired via `vitest.config.ts::projects[e2e].globalSetup`).
 *
 * Responsibilities:
 *
 *  1. Run `bun run build` to produce both `dist/cli.js` (Story CLI) and
 *     `tests/e2e/bin/vogon.mjs` (Vogon canary binary) — see `tsup.config.ts`.
 *  2. Call `setStoryBin(path.resolve('dist/cli.js'))`.
 *  3. Call `setVogonBin(path.resolve('tests/e2e/bin/vogon.mjs'))`.
 *  4. Create the run-wide artifact root
 *     (`tests/e2e/artifacts/<ISO-timestamp>/` — override via
 *     `STORY_E2E_ARTIFACT_DIR`) and register it with
 *     `setArtifactRoot(...)`.
 *  5. Preflight: `git` must be on PATH; fail fast with actionable error.
 *
 * Vitest invokes this default export once; the returned function (if
 * any) runs once after all e2e tests finish. We skip the teardown hook
 * (artifacts persist intentionally for post-run inspection).
 *
 * @packageDocumentation
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import { artifactDirOverride } from './helpers/env';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

/**
 * Vitest global setup entry. Throws (failing the entire e2e run fast) if
 * preflight checks fail or `bun run build` doesn't produce both artifacts.
 *
 * @example
 * // vitest invokes once before any e2e test:
 * await setup();
 * // Side effects at project root:
 * //   dist/cli.js                        ← rebuilt by `bun run build`
 * //   tests/e2e/bin/vogon.mjs            ← rebuilt by `bun run build`, chmod 0o755
 * //   tests/e2e/artifacts/<timestamp>/   ← mkdir -p
 * // Module state after return:
 * //   story.ts     :: storyBin set
 * //   vogon-runner :: vogonBin set
 * //   artifacts.ts :: artifactRoot set
 */
export default async function setup(): Promise<void> {
	// Preflight: git must be on PATH — without it every scenario fails
	// inscrutably inside `setupRepo`.
	try {
		await execa('git', ['--version']);
	} catch (e) {
		throw new Error(
			`E2E preflight: 'git' is not on PATH. Install git or export it in the test env.\n${String(e)}`,
		);
	}

	// Build CLI + Vogon. `bun run build` is idempotent; if both artifacts
	// already exist and are fresher than their sources, tsup will still
	// re-bundle (cheap, keeps state deterministic).
	const buildRes = await execa('bun', ['run', 'build'], {
		cwd: REPO_ROOT,
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	if (buildRes.exitCode !== 0) {
		throw new Error(
			`E2E preflight: 'bun run build' failed (exit ${buildRes.exitCode})\n${buildRes.stderr?.toString() ?? ''}\n${buildRes.stdout?.toString() ?? ''}`,
		);
	}

	const storyBin = path.join(REPO_ROOT, 'dist', 'cli.js');
	const vogonBin = path.join(REPO_ROOT, 'tests', 'e2e', 'bin', 'vogon.mjs');

	// Verify both artifacts exist before handing control to scenarios.
	for (const bin of [storyBin, vogonBin]) {
		try {
			await fs.access(bin);
		} catch {
			throw new Error(`E2E preflight: expected built artifact missing at ${bin}`);
		}
	}

	// Installed git hooks shell out to bare `story` (and bare `git`). Make
	// sure a `story` entry resolves by creating/refreshing a symlink next
	// to the CLI binary and prepending that dir to PATH for all child
	// processes (matches Go `e2e/tests/main_test.go` pattern).
	const binDir = path.dirname(storyBin);
	const storyLink = path.join(binDir, 'story');
	try {
		await fs.unlink(storyLink);
	} catch {
		// Link didn't exist; fine.
	}
	await fs.symlink('cli.js', storyLink);
	try {
		await fs.chmod(storyLink, 0o755);
	} catch {
		// Symlinks inherit target mode on some FSes.
	}
	const currentPath = process.env.PATH ?? '';
	process.env.PATH = `${binDir}${path.delimiter}${currentPath}`;

	// Vitest globalSetup runs in a separate process context from test
	// workers, so module-level setters would not propagate across the
	// boundary. Instead we write these paths into `process.env`, which IS
	// inherited by workers (vitest spawns them with the parent's env).
	// Each helper lazy-reads via `process.env.STORY_BIN` etc.
	process.env.STORY_BIN = storyBin;
	process.env.VOGON_BIN = vogonBin;

	// Artifact root — override wins, else timestamped default.
	const override = artifactDirOverride();
	const root =
		override ??
		path.join(
			REPO_ROOT,
			'tests',
			'e2e',
			'artifacts',
			new Date().toISOString().replace(/[:.]/g, '-'),
		);
	await fs.mkdir(root, { recursive: true, mode: 0o755 });
	process.env.STORY_E2E_ARTIFACT_ROOT = root;

	// PTY / interactive E2E (`runStoryInteractive`) shells out to `expect(1)`.
	// Workers read `STORY_E2E_EXPECT_OK` to skip those cases when missing (CI
	// images without Tcl/expect).
	try {
		await execa('which', ['expect'], { cwd: REPO_ROOT });
		process.env.STORY_E2E_EXPECT_OK = '1';
	} catch {
		process.env.STORY_E2E_EXPECT_OK = '0';
	}

	// eslint-disable-next-line no-console -- intentional setup banner
	console.log(
		`[e2e setup] storyBin=${storyBin}\n[e2e setup] vogonBin=${vogonBin}\n[e2e setup] artifactRoot=${root}\n[e2e setup] expect=${process.env.STORY_E2E_EXPECT_OK === '1' ? 'yes' : 'no'}`,
	);
}
