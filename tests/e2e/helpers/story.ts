/**
 * Story CLI wrapper — runs the built Story binary (`dist/cli.js`) as a
 * subprocess and returns parsed results.
 *
 * Mirrors Go `entire-cli/e2e/entire/entire.go` (166 lines): `BinPath` /
 * `Enable` / `Disable` / `RewindList` / `Rewind` / `RewindLogsOnly` /
 * `Explain` / `ExplainGenerate` / `ExplainCommit` / `Resume`, plus a new
 * `storyAttach` for Phase 9.4 `story attach`.
 *
 * Naming red line: all string literals / argv / branch names / file paths
 * align with Story (`story enable`, `Story-Checkpoint:`, `.story/...`),
 * NOT Entire.
 *
 * @packageDocumentation
 */

import { type ExecaError, execa } from 'execa';
import { isolatedSpawnEnv } from './env';

/**
 * Module-level cache for the Story CLI binary path. Populated lazily
 * from `process.env.STORY_BIN` (set by `tests/e2e/setup.ts::beforeAll`)
 * since vitest global setup runs in a separate process context from
 * test workers — module-level `setStoryBin()` mutations would not
 * propagate across the boundary.
 */
let storyBinPath: string | null = null;

/**
 * One entry from `story rewind --list` JSON output. Snake_case fields
 * preserve cross-language parity with Go `entire.RewindPoint`.
 *
 * **TS-divergence from Go**: Story renames Go's `condensation_id` to
 * `checkpoint_id` in the JSON output (Phase 9.3 chose the clearer name);
 * both are preserved here as **optional** so callers working with either
 * shape (Go-compatible fixtures or Story's own output) type-check. See
 * `rewindList` for the wrapper-vs-array parsing.
 */
export interface RewindPoint {
	id: string;
	message: string;
	metadata_dir: string;
	date: string;
	is_task_checkpoint: boolean;
	tool_use_id: string;
	is_logs_only: boolean;
	session_id: string;
	/** Story naming. Populated for logs-only (squash-merge) rewind points. */
	checkpoint_id?: string;
	/** Go naming (retained for compat; matches Go's `RewindPoint.CondensationID`). */
	condensation_id?: string;
	agent?: string;
	session_prompt?: string;
	session_count?: number;
	session_ids?: string[];
	session_prompts?: string[];
}

/** Captured result from any Story CLI invocation. */
export interface StoryRunResult {
	command: string;
	stdout: string;
	stderr: string;
	exitCode: number;
	error: Error | null;
}

/** Call once from setup.ts::beforeAll once `bun run build` produces `dist/cli.js`. */
export function setStoryBin(absPath: string): void {
	storyBinPath = absPath;
}

/**
 * Read the Story CLI binary path. Returns the in-process cache if
 * `setStoryBin` was called; otherwise falls back to
 * `process.env.STORY_BIN` (set by `tests/e2e/setup.ts` globalSetup,
 * which runs in a separate process context from test workers).
 */
export function getStoryBin(): string {
	if (storyBinPath !== null) {
		return storyBinPath;
	}
	const fromEnv = process.env.STORY_BIN;
	if (fromEnv !== undefined && fromEnv !== '') {
		storyBinPath = fromEnv;
		return fromEnv;
	}
	throw new Error(
		'Story CLI binary path not set — tests/e2e/setup.ts globalSetup must run first (exports STORY_BIN env var)',
	);
}

/**
 * Run a Story subcommand in `dir`, capturing output. Does NOT throw on
 * non-zero exit — returns a `StoryRunResult` with `.error` populated so
 * callers can assert failure or success.
 *
 * Intentionally invokes via `node <bin>` so we don't rely on the binary's
 * executable bit or shebang interpretation on every CI runner.
 */
export async function runStory(dir: string, args: readonly string[]): Promise<StoryRunResult> {
	const bin = getStoryBin();
	const command = `node ${bin} ${args.join(' ')}`;
	try {
		const res = await execa(process.execPath, [bin, ...args], {
			cwd: dir,
			env: isolatedSpawnEnv(),
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		return {
			command,
			stdout: res.stdout?.toString() ?? '',
			stderr: res.stderr?.toString() ?? '',
			exitCode: res.exitCode ?? 0,
			error: null,
		};
	} catch (e) {
		const err = e as ExecaError;
		return {
			command,
			stdout: err.stdout?.toString() ?? '',
			stderr: err.stderr?.toString() ?? '',
			exitCode: err.exitCode ?? -1,
			error: err,
		};
	}
}

/**
 * `story enable --agent <agent> --local --telemetry=false`. Throws on
 * non-zero exit. Mirrors Go `entire.Enable`.
 *
 * @example
 * await storyEnable('/tmp/story-e2e-abc', 'vogon');
 * // Side effects in the repo:
 * //   .story/settings.local.json    ← { enabled: true, agents: [...] }
 * //   .git/hooks/prepare-commit-msg  ← installed
 * //   .git/hooks/commit-msg          ← installed
 * //   .git/hooks/post-commit         ← installed
 * //   .git/hooks/post-rewrite        ← installed
 * //   .git/hooks/pre-push            ← installed
 * // Unchanged: HEAD, working-tree contents, stage.
 */
export async function storyEnable(dir: string, agent: string): Promise<void> {
	// NOTE: we do NOT pass `--local`. Phase 9.1 `--local` writes only
	// `.story/settings.local.json`, but `loadEnabledSettings` in
	// `src/settings/settings.ts` gates on `isSetUp()` which requires the
	// project-scope `.story/settings.json`. Without the project file the
	// agent-hook path silently skips at Layer 2 and no checkpoints ever
	// land — exactly the E2E hang we saw while wiring Phase 10. Using the
	// project scope is the simplest way to exercise the same hook path
	// production users hit. Documented as TS-divergence #11 in the Phase 10
	// impl.md `setupRepo` patchSettings notes.
	const res = await runStory(dir, ['enable', '--agent', agent, '--telemetry=false']);
	if (res.exitCode !== 0) {
		throw new Error(`storyEnable failed (exit ${res.exitCode}): ${res.stderr}\n${res.stdout}`);
	}
}

/** `story disable`. Throws on non-zero exit. Mirrors Go `entire.Disable`. */
export async function storyDisable(dir: string): Promise<void> {
	const res = await runStory(dir, ['disable']);
	if (res.exitCode !== 0) {
		throw new Error(`storyDisable failed (exit ${res.exitCode}): ${res.stderr}\n${res.stdout}`);
	}
}

/**
 * `story rewind --list` → parsed `RewindPoint[]`. Accepts both shapes:
 *
 *  - Go-compatible bare array: `[{id, ...}, ...]`
 *  - Story's wrapped form: `{"rewind_points": [{...}, ...]}` (Phase 9.3)
 *
 * Throws on non-zero exit or unparseable output. Mirrors Go
 * `entire.RewindList` with the extra unwrap step.
 */
export async function rewindList(dir: string): Promise<RewindPoint[]> {
	const res = await runStory(dir, ['rewind', '--list']);
	if (res.exitCode !== 0) {
		throw new Error(`rewindList failed (exit ${res.exitCode}): ${res.stderr}\n${res.stdout}`);
	}
	const raw = res.stdout.trim();
	if (raw === '') {
		return [];
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (e) {
		throw new Error(`rewindList: failed to parse JSON: ${String(e)}\nraw: ${raw}`);
	}
	if (Array.isArray(parsed)) {
		return parsed as RewindPoint[];
	}
	if (
		typeof parsed === 'object' &&
		parsed !== null &&
		Array.isArray((parsed as { rewind_points?: unknown }).rewind_points)
	) {
		return (parsed as { rewind_points: RewindPoint[] }).rewind_points;
	}
	throw new Error(
		`rewindList: expected array or {rewind_points:[...]} object, got: ${raw.slice(0, 200)}`,
	);
}

/**
 * `story rewind --to <id> --yes`. Returns captured result (including
 * non-null `.error` on failure) — does NOT throw. `--yes` bypasses
 * Phase 9.3's interactive confirm prompt (which would otherwise hang
 * in a test harness without a TTY). Mirrors Go `entire.Rewind`.
 */
export async function rewindTo(dir: string, id: string): Promise<StoryRunResult> {
	return runStory(dir, ['rewind', '--to', id, '--yes']);
}

/**
 * `story rewind --to <id> --logs-only --yes`. Returns captured result.
 * Mirrors Go `entire.RewindLogsOnly`.
 */
export async function rewindLogsOnly(dir: string, id: string): Promise<StoryRunResult> {
	return runStory(dir, ['rewind', '--to', id, '--logs-only', '--yes']);
}

/**
 * `story explain --checkpoint <id>` → stdout text. Throws on non-zero
 * exit. Mirrors Go `entire.Explain`.
 */
export async function storyExplain(dir: string, checkpointId: string): Promise<string> {
	const res = await runStory(dir, ['explain', '--checkpoint', checkpointId]);
	if (res.exitCode !== 0) {
		throw new Error(`storyExplain failed (exit ${res.exitCode}): ${res.stderr}\n${res.stdout}`);
	}
	return res.stdout;
}

/**
 * `story resume <branch> --force`. Returns captured result (may fail
 * legitimately when branch is missing / working tree dirty / etc.).
 * Mirrors Go `entire.Resume`.
 */
export async function storyResume(dir: string, branch: string): Promise<StoryRunResult> {
	return runStory(dir, ['resume', branch, '--force']);
}

export interface StoryAttachOptions {
	force?: boolean;
	agent?: string;
}

/**
 * `story attach <session-id> [--force] [--agent <name>]`. New in Phase
 * 9.4 — no Go e2e equivalent. Returns captured result so callers can
 * assert success / failure.
 */
export async function storyAttach(
	dir: string,
	sessionId: string,
	opts?: StoryAttachOptions,
): Promise<StoryRunResult> {
	const args: string[] = ['attach', sessionId];
	if (opts?.force === true) {
		args.push('--force');
	}
	if (opts?.agent !== undefined && opts.agent !== '') {
		args.push('--agent', opts.agent);
	}
	return runStory(dir, args);
}
