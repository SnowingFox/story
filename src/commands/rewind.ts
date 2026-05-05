/**
 * `story rewind` — browse checkpoints and rewind the working tree /
 * HEAD / session refs to a selected point.
 *
 * Mirrors Go `cmd/entire/cli/rewind.go: newRewindCmd` (1226-line CLI
 * shell). All algorithm work lives in Phase 5.5
 * ({@link ../strategy/rewind}, {@link ../strategy/rewind-points},
 * {@link ../strategy/restore-logs}, {@link ../strategy/reset}); this
 * file is pure CLI orchestration — flag routing, mutex validation,
 * select / confirm UI, JSON shape.
 *
 * Flag routing (5 branches):
 *  - (no flag)             → runRewindInteractive (full 3-stage rewind)
 *  - --list                → runRewindList (bypass UI, JSON to stdout)
 *  - --to <commit>         → runRewindTo (skip select, confirm + rewind)
 *  - --logs-only           → interactive → restoreLogsOnly (no worktree touch)
 *  - --to <commit> --reset → runRewindReset (destructive git reset --hard)
 *
 * @packageDocumentation
 */

import type { CAC } from 'cac';
import { applyGlobalFlags, getGlobalFlags } from '@/cli/flags';
import { getRootSignal } from '@/cli/runtime';
import { SilentError } from '@/errors';
import { execGit } from '@/git';
import { worktreeRoot } from '@/paths';
import { isEnabled, isSetUpAny } from '@/settings/settings';
import { ManualCommitStrategy } from '@/strategy/manual-commit';
import type { RewindPoint } from '@/strategy/types';
import {
	barEmpty,
	barLine,
	confirm,
	footer,
	header,
	info,
	select,
	step,
	stepDone,
	warn,
	withSpinner,
} from '@/ui';
import { color } from '@/ui/theme';

/** Number of rewind candidates fetched in one call. Mirrors Go `rewind.go` (GetRewindPoints call site). */
const REWIND_POINT_LIMIT = 20;

/**
 * Register `story rewind` on a cac instance. Call once from
 * {@link ./index::registerCoreCommands}.
 *
 * Go: `rewind.go: newRewindCmd`.
 *
 * @example
 * registerRewindCommand(cli);
 * // Now resolvable:
 * //   story rewind
 * //   story rewind --list
 * //   story rewind --to abc1234
 * //   story rewind --logs-only
 * //   story rewind --to abc1234 --reset
 */
export function registerRewindCommand(cli: CAC): void {
	cli
		.command('rewind', 'Browse checkpoints and rewind your session')
		.option('--list', 'List available rewind points as JSON (non-interactive)')
		.option('--to <commit-id>', 'Rewind to a specific commit ID (skip select)')
		.option('--logs-only', 'Restore only session logs; leave HEAD / working tree alone')
		.option('--reset', 'git reset --hard (destructive; requires --to)')
		.action(async (rawFlags: Record<string, unknown>) => {
			applyGlobalFlags(rawFlags);

			const listFlag = rawFlags.list === true;
			const toFlag = typeof rawFlags.to === 'string' ? rawFlags.to.trim() : '';
			const logsOnlyFlag = rawFlags['logs-only'] === true || rawFlags.logsOnly === true;
			const resetFlag = rawFlags.reset === true;

			validateMutex({
				list: listFlag,
				to: toFlag,
				logsOnly: logsOnlyFlag,
				reset: resetFlag,
				json: getGlobalFlags().json,
			});

			const repoRoot = await requireGitRepo();

			// Go `rewind.go: newRewindCmd` runs `checkDisabledGuard`
			// BEFORE dispatching to runRewindList/Interactive/ToWithOptions.
			// Story matches: `--list` also respects the disabled guard so
			// scripts don't get stale JSON from a repo that's been opt'd out.
			if (!(await isReady(repoRoot))) {
				return;
			}

			if (listFlag) {
				await runRewindList(repoRoot);
				return;
			}

			if (resetFlag) {
				await runRewindReset(repoRoot, toFlag);
				return;
			}
			if (toFlag !== '') {
				await runRewindTo(repoRoot, toFlag, { logsOnly: logsOnlyFlag });
				return;
			}
			await runRewindInteractive(repoRoot, { logsOnly: logsOnlyFlag });
		});
}

/**
 * Flag combination validator — cac lacks cobra's
 * `MarkFlagsMutuallyExclusive`, so we early-exit with SilentError.
 *
 * @internal
 */
function validateMutex(flags: {
	list: boolean;
	to: string;
	logsOnly: boolean;
	reset: boolean;
	json: boolean;
}): void {
	if (flags.list && (flags.to !== '' || flags.logsOnly || flags.reset)) {
		throw new SilentError(
			new Error('--list cannot be combined with --to, --logs-only, or --reset'),
		);
	}
	if (flags.reset && flags.to === '') {
		throw new SilentError(
			new Error(
				'--reset requires --to <commit-id>. Interactive selection + hard reset is ' +
					"intentionally disabled. Run 'story rewind --list' to find a target commit.",
			),
		);
	}
	if (flags.json && !flags.list && flags.to === '') {
		throw new SilentError(
			new Error('Cannot prompt in --json mode; pass --to <commit> to choose non-interactively'),
		);
	}
}

/**
 * `--list` branch: emit rewind points as a single-line JSON blob to
 * stdout. Bypasses all `@/ui` primitives — no banner, no bar block — so
 * scripts can pipe into `jq`.
 *
 * Mirrors Go `rewind.go: runRewindList`. JSON shape tracks Go's
 * `jsonPoint` struct (snake_case keys).
 *
 * @example
 * await runRewindList('/repo');
 * // stdout: {"rewind_points":[{"id":"abc1234...","message":"...",...}, ...]}
 * //
 * // Side effects: read-only (listTemporaryCheckpoints + git.log walk).
 * // Does NOT print banner / bar / header / footer.
 */
async function runRewindList(repoRoot: string): Promise<void> {
	const strategy = new ManualCommitStrategy(repoRoot);
	const points = await strategy.getRewindPoints(REWIND_POINT_LIMIT);
	const payload = {
		rewind_points: points.map((p) => ({
			id: p.id,
			message: p.message,
			metadata_dir: p.metadataDir,
			date: p.date.toISOString(),
			is_task_checkpoint: p.isTaskCheckpoint,
			tool_use_id: p.toolUseId,
			is_logs_only: p.isLogsOnly,
			checkpoint_id: p.checkpointId,
			agent: p.agent,
			session_id: p.sessionId,
			session_prompt: p.sessionPrompt,
			session_count: p.sessionCount,
			session_ids: p.sessionIds,
			session_prompts: p.sessionPrompts,
		})),
	};
	process.stdout.write(`${JSON.stringify(payload)}\n`);
}

/**
 * Interactive rewind (no `--to`). Shows a select of up to 20 candidates,
 * confirms, then performs either `rewindImpl` (default) or
 * `restoreLogsOnlyImpl` (`--logs-only`).
 *
 * Mirrors Go `rewind.go: runRewindInteractive`.
 *
 * @example
 * await runRewindInteractive('/repo', { logsOnly: false });
 *
 * // Side effects on happy path (non-logs-only):
 * //   <repo>/.git/refs/heads/story/<base>-<6hex>   ← reset to selected commit
 * //   <repo>/<files...>                            ← restored from checkpoint tree
 * //   <repo>/.story/logs/story.log                 ← transition logged (via strategy)
 * // Unchanged: metadata branch, remote refs, settings.
 *
 * // Side effects on --logs-only:
 * //   <agent session dir>/<sess>.jsonl             ← transcript restored
 * // Unchanged: HEAD, index, working tree files.
 */
async function runRewindInteractive(repoRoot: string, opts: { logsOnly: boolean }): Promise<void> {
	const strategy = new ManualCommitStrategy(repoRoot);
	header('story rewind');
	barEmpty();

	const points = await scanRewindPoints(strategy);
	const picked = await pickPoint(points);
	renderSelectedCard(picked, { logsOnly: opts.logsOnly });

	if (!opts.logsOnly) {
		await renderDiffPreview(strategy, picked);
	}

	const confirmMessage = opts.logsOnly
		? `Restore session logs from ${shortId(picked.id)}?`
		: `Rewind to ${shortId(picked.id)}?`;
	const ok = await confirm({
		message: confirmMessage,
		yesDefault: true,
		signal: getRootSignal(),
	});
	if (!ok) {
		throw new SilentError(new Error('cancelled'));
	}

	if (opts.logsOnly) {
		await executeRestoreLogs(strategy, picked);
	} else {
		await executeRewind(strategy, picked);
	}
}

/**
 * `--to <commit>` branch: resolve the commit hash (short or full),
 * match a rewind point, confirm, then rewind (or restore logs when
 * `--logs-only` is also set).
 *
 * Mirrors Go `rewind.go: runRewindToWithOptions` → `runRewindToInternal`.
 *
 * @example
 * await runRewindTo('/repo', 'abc1234', { logsOnly: false });
 *
 * // Side effects on happy path:
 * //   <repo>/.git/refs/heads/story/<base>-<6hex>   ← reset to target commit
 * //   <repo>/<files>                               ← restored from checkpoint tree
 * //   <repo>/.story/logs/story.log                 ← transition logged
 * // Unchanged: metadata branch, remote refs.
 *
 * // Edge: when target == current HEAD → step() "HEAD is already at
 * // <short>" + return (exit 0, no SilentError).
 */
async function runRewindTo(
	repoRoot: string,
	commitRef: string,
	opts: { logsOnly: boolean },
): Promise<void> {
	const strategy = new ManualCommitStrategy(repoRoot);
	const flags = getGlobalFlags();
	if (!flags.json) {
		header('story rewind');
		barEmpty();
		step('Resolving target commit');
	}

	const sha = await resolveCommitId(repoRoot, commitRef);

	// HEAD already at target → no-op (exit 0, not an error).
	const headSha = await readHead(repoRoot);
	if (headSha === sha) {
		const msg = `HEAD is already at ${shortId(sha)}`;
		if (flags.json) {
			process.stdout.write(`${JSON.stringify({ noop: msg })}\n`);
			return;
		}
		barLine(color.dim(msg));
		barEmpty();
		footer(color.dim("Nothing to rewind. Run 'story rewind --list' to see other checkpoints."));
		return;
	}

	const points = await strategy.getRewindPoints(REWIND_POINT_LIMIT);
	const picked = points.find((p) => p.id === sha);
	if (!picked) {
		throw new SilentError(
			new Error(`No rewind point found for ${shortId(sha)} — run 'story rewind --list'`),
		);
	}

	if (!flags.json) {
		barLine(`${color.dim('commit')}   ${shortId(sha)} · ${picked.message}`);
		barLine(`${color.dim('agent')}    ${picked.agent} · session ${picked.sessionId}`);
		barEmpty();
	}

	if (!opts.logsOnly && !flags.json) {
		await renderDiffPreview(strategy, picked);
	}

	const confirmMessage = opts.logsOnly
		? `Restore session logs from ${shortId(sha)}?`
		: `Rewind to ${shortId(sha)}?`;
	const ok = await confirm({
		message: confirmMessage,
		yesDefault: true,
		signal: getRootSignal(),
	});
	if (!ok) {
		throw new SilentError(new Error('cancelled'));
	}

	if (opts.logsOnly) {
		await executeRestoreLogs(strategy, picked);
	} else {
		await executeRewind(strategy, picked);
	}

	if (flags.json) {
		process.stdout.write(
			`${JSON.stringify({ rewound: { from: shortId(headSha), to: shortId(sha), checkpoint: picked.checkpointId || null } })}\n`,
		);
	}
}

/**
 * `--to <commit> --reset` branch: destructive hard reset. Requires
 * explicit `--to`, double confirm (yesDefault: false so `--yes` alone
 * does not auto-accept). Restores session logs first (Go
 * `handleLogsOnlyResetNonInteractive`), then `git reset --hard`.
 *
 * Mirrors Go `rewind.go: handleLogsOnlyResetNonInteractive`.
 *
 * @example
 * await runRewindReset('/repo', 'abc1234');
 *
 * // Side effects (after confirmed):
 * //   <repo>/.git/HEAD                             ← points at target commit
 * //   <repo>/.git/index, <repo>/<worktree>         ← overwritten by git reset --hard
 * //   <agent session dir>/<sess>.jsonl             ← transcript restored first
 * //   stderr                                        ← 3 DESTRUCTIVE warn lines + recovery hint
 * // Unchanged: other branches, remote refs.
 */
async function runRewindReset(repoRoot: string, commitRef: string): Promise<void> {
	const strategy = new ManualCommitStrategy(repoRoot);
	header('story rewind');
	barEmpty();
	warn("DESTRUCTIVE: --reset runs 'git reset --hard'");
	warn('Any uncommitted changes will be LOST.');
	warn('Pass --yes only after reviewing the target commit.');
	barEmpty();

	step('Resolving target commit');
	const sha = await resolveCommitId(repoRoot, commitRef);
	const prevHead = await readHead(repoRoot);

	const points = await strategy.getRewindPoints(REWIND_POINT_LIMIT);
	const picked = points.find((p) => p.id === sha);
	if (!picked) {
		throw new SilentError(
			new Error(`No rewind point found for ${shortId(sha)} — run 'story rewind --list'`),
		);
	}
	barLine(`${color.dim('commit')}   ${shortId(sha)} · ${picked.message}`);
	barLine(`${color.dim('agent')}    ${picked.agent} · session ${picked.sessionId}`);
	barEmpty();

	const ok = await confirm({
		message: `Hard-reset to ${shortId(sha)} AND lose uncommitted work?`,
		yesDefault: false,
		signal: getRootSignal(),
	});
	if (!ok) {
		throw new SilentError(new Error('cancelled'));
	}

	// Restore logs first (Go parity — don't blow away transcript knowledge
	// before we've hard-reset the branch).
	try {
		await withSpinner('Restoring session logs', async () =>
			strategy.restoreLogsOnly(process.stdout, process.stderr, picked, true),
		);
	} catch (err) {
		warn(`Log restoration failed: ${(err as Error).message}`);
	}

	await withSpinner(`Running git reset --hard ${shortId(sha)}`, async () => {
		await execGit(['reset', '--hard', sha], { cwd: repoRoot });
	});

	stepDone('Rewind complete (hard reset)');
	barEmpty();
	if (prevHead !== '' && prevHead !== sha) {
		info(`To undo this reset: git reset --hard ${shortId(prevHead)}`);
	}
	footer(color.dim("Run 'story status' to verify."));
}

/**
 * Shared pre-rewind scan — reads up to {@link REWIND_POINT_LIMIT}
 * points, prints a small "Scanning" step, and returns the list.
 * Throws SilentError when nothing is found.
 *
 * @internal
 */
async function scanRewindPoints(strategy: ManualCommitStrategy): Promise<RewindPoint[]> {
	const points = await withSpinner('Scanning checkpoints', async () =>
		strategy.getRewindPoints(REWIND_POINT_LIMIT),
	);
	if (points.length === 0) {
		throw new SilentError(
			new Error(
				"No rewind points available. Make at least one checkpointed commit, or run 'story status' to verify Story is capturing sessions.",
			),
		);
	}
	return points;
}

/**
 * Shared select → returns picked RewindPoint (throws SilentError on
 * cancel via {@link select}'s clack isCancel → SilentError translation).
 *
 * @internal
 */
async function pickPoint(points: readonly RewindPoint[]): Promise<RewindPoint> {
	const options = points.map((p) => {
		const short = p.id.length >= 7 ? p.id.slice(0, 7) : p.id;
		const rel = formatRelative(p.date);
		const agentTag = p.agent ? ` · ${p.agent}` : '';
		const label = `${short}  ${truncate(p.message, 40)}  ${rel}${agentTag}`;
		return { value: p.id, label };
	});
	const pickedId = await select<string>({
		message: 'Select a rewind point',
		options,
		signal: getRootSignal(),
	});
	const picked = points.find((p) => p.id === pickedId);
	if (!picked) {
		throw new SilentError(new Error('selection not found'));
	}
	return picked;
}

/**
 * Shared selected-point info card (Selected rewind point block).
 *
 * @internal
 */
function renderSelectedCard(point: RewindPoint, opts: { logsOnly: boolean }): void {
	const label = opts.logsOnly ? 'Selected rewind point (logs-only)' : 'Selected rewind point';
	step(label);
	const short = shortId(point.id);
	barLine(`${color.dim('checkpoint')}  ${short} · ${point.message}`);
	barLine(`${color.dim('agent')}       ${point.agent} · session ${point.sessionId}`);
	if (opts.logsOnly) {
		barLine(color.dim('Working tree + HEAD will NOT change'));
	}
	barEmpty();
}

/**
 * Shared diff-preview block (first 5 files, overflow marker). Reads
 * from {@link ManualCommitStrategy.previewRewind} (Phase 5.5).
 *
 * @internal
 */
async function renderDiffPreview(
	strategy: ManualCommitStrategy,
	point: RewindPoint,
): Promise<void> {
	let preview: Awaited<ReturnType<ManualCommitStrategy['previewRewind']>>;
	try {
		preview = await strategy.previewRewind(point);
	} catch (err) {
		warn(`could not preview rewind effects: ${(err as Error).message}`);
		return;
	}
	const restore = preview.filesToRestore;
	const del = preview.filesToDelete;
	if (restore.length === 0 && del.length === 0) {
		return;
	}
	step(`Diff preview (HEAD → ${shortId(point.id)})`);
	const maxFiles = 5;
	let shown = 0;
	for (const f of restore) {
		if (shown >= maxFiles) {
			break;
		}
		barLine(`  ${color.dim('+')} ${f}`);
		shown += 1;
	}
	for (const f of del) {
		if (shown >= maxFiles) {
			break;
		}
		barLine(`  ${color.red('-')} ${f}`);
		shown += 1;
	}
	const remaining = restore.length + del.length - shown;
	if (remaining > 0) {
		barLine(color.dim(`  ... (${remaining} more)`));
	}
	barEmpty();
}

/**
 * Execute the full rewind pipeline (non-destructive). Used by
 * `runRewindInteractive` and `runRewindTo` when `--logs-only` is unset.
 *
 * @internal
 */
async function executeRewind(strategy: ManualCommitStrategy, point: RewindPoint): Promise<void> {
	await withSpinner(`Moving HEAD and restoring working tree`, async () =>
		strategy.rewind(process.stdout, process.stderr, point),
	);
	stepDone('Rewind complete');
	barEmpty();
	footer(color.dim("Run 'story status' to verify."));
}

/**
 * Execute the logs-only pipeline. Used by `runRewindInteractive` /
 * `runRewindTo` when `--logs-only` is set.
 *
 * @internal
 */
async function executeRestoreLogs(
	strategy: ManualCommitStrategy,
	point: RewindPoint,
): Promise<void> {
	await withSpinner('Restoring session logs', async () =>
		strategy.restoreLogsOnly(process.stdout, process.stderr, point, true),
	);
	stepDone('Logs restored (working tree unchanged)');
	barEmpty();
	const ckpt = point.checkpointId || shortId(point.id);
	footer(color.dim(`Run 'story explain -c ${ckpt}' to inspect.`));
}

/**
 * Resolve a user-provided commit ref (short sha / full sha / branch)
 * via `git rev-parse --verify`. Throws SilentError on git failure
 * (commit not found / ambiguous).
 *
 * @internal
 */
async function resolveCommitId(repoRoot: string, ref: string): Promise<string> {
	try {
		const out = await execGit(['rev-parse', '--verify', ref], { cwd: repoRoot });
		return out.trim();
	} catch (err) {
		throw new SilentError(new Error(`Commit not found: ${ref} (${(err as Error).message})`));
	}
}

async function readHead(repoRoot: string): Promise<string> {
	try {
		const out = await execGit(['rev-parse', 'HEAD'], { cwd: repoRoot });
		return out.trim();
	} catch {
		return '';
	}
}

function shortId(id: string): string {
	return id.length >= 7 ? id.slice(0, 7) : id;
}

function truncate(s: string, n: number): string {
	if (s.length <= n) {
		return s;
	}
	return `${s.slice(0, n - 1)}…`;
}

function formatRelative(d: Date): string {
	const diffMs = Date.now() - d.getTime();
	if (diffMs < 0) {
		return 'in the future';
	}
	const minutes = Math.floor(diffMs / 60_000);
	if (minutes < 1) {
		return 'just now';
	}
	if (minutes < 60) {
		return `${minutes}m ago`;
	}
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		return `${hours}h ago`;
	}
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}

/**
 * Resolve the repo root or throw SilentError. Kept local (not imported
 * from a shared helper) so the error message is command-specific.
 *
 * @internal
 */
async function requireGitRepo(): Promise<string> {
	try {
		return await worktreeRoot(process.cwd());
	} catch {
		throw new SilentError(new Error('Not a git repository'));
	}
}

/**
 * Short-circuit with a friendly hint (not a SilentError) when Story is
 * not set up or has `enabled: false` in settings. Returns `false` so
 * callers graceful-return; returns `true` when Story is ready for the
 * command to run.
 *
 * Mirrors Go `rewind.go: newRewindCmd` early call to
 * `checkDisabledGuard(cmd.Context(), cmd.OutOrStdout())` which prints
 * a message and returns nil (no error) when Story is disabled — TS
 * mirrors by printing the bar-block hint then returning `false`.
 *
 * @internal
 */
async function isReady(repoRoot: string): Promise<boolean> {
	const setUp = await isSetUpAny(repoRoot);
	if (!setUp) {
		header('story rewind');
		barEmpty();
		barLine(`${color.dim('○')} Story is not enabled in this repository.`);
		barEmpty();
		footer(color.dim("Run 'story enable' to set it up."));
		return false;
	}
	const enabled = await isEnabled(repoRoot);
	if (!enabled) {
		header('story rewind');
		barEmpty();
		barLine(`${color.dim('○')} Story settings have 'enabled: false'.`);
		barEmpty();
		footer(color.dim("Run 'story configure' to re-enable."));
		return false;
	}
	return true;
}
