/**
 * `story resume <branch>` — check out a branch (fetching from origin if
 * only the remote has it), find the latest session on that branch, and
 * restore the working tree from the session's most recent checkpoint.
 *
 * Mirrors Go `cmd/entire/cli/resume.go: newResumeCmd` (1032-line CLI
 * shell). Compared to Go's behaviour, Story:
 *   - Pre-checks `git status --porcelain` so a dirty worktree hits a
 *     friendly error before `git checkout` wipes it (Go tolerates this
 *     path because go-git is stricter; TS divergence documented in
 *     [phase-9.4 impl.md TS-divergence #4](docs/ts-rewrite/impl/phase-9-commands/phase-9.4-explain-resume/impl.md))
 *   - Uses Phase 9.0 UI primitives (bar block / `withSpinner` /
 *     `confirm`) instead of charmbracelet/huh
 *
 * @packageDocumentation
 */

import type { CAC } from 'cac';
import { applyGlobalFlags, getGlobalFlags } from '@/cli/flags';
import { getRootSignal } from '@/cli/runtime';
import { SilentError } from '@/errors';
import { branchExistsLocally, branchExistsOnRemote, execGit } from '@/git';
import { fetchAndCheckoutRemoteBranch } from '@/git/fetch';
import { worktreeRoot } from '@/paths';
import { isEnabled, isSetUpAny } from '@/settings/settings';
import { ManualCommitStrategy } from '@/strategy/manual-commit';
import { listCheckpoints } from '@/strategy/metadata-branch';
import type { CheckpointInfo, SessionState } from '@/strategy/types';
import {
	barEmpty,
	barLine,
	confirm,
	footer,
	header,
	step,
	stepDone,
	warn,
	withSpinner,
} from '@/ui';
import { color } from '@/ui/theme';
import { validateBranchName } from '@/validation';

/** Stale-checkpoint threshold (ms). >24h → confirm prompt unless `--force`. */
const STALE_CHECKPOINT_MS = 24 * 60 * 60 * 1000;

/**
 * Register `story resume <branch>` on a cac instance.
 *
 * Go: `resume.go: newResumeCmd`.
 *
 * @example
 * const cli = cac('story');
 * registerResumeCommand(cli);
 * // Now resolvable:
 * //   story resume main
 * //   story resume feat/dark-mode --force
 * //   story resume main --json
 *
 * // Side effects on the cac instance:
 * //   cli.commands  ← appends "resume <branch>" with --force / -f flag
 * //
 * // Unchanged: already-registered commands, flag state, process state
 * //            (no action runs until `cli.parse(argv)`).
 */
export function registerResumeCommand(cli: CAC): void {
	cli
		.command('resume <branch>', 'Checkout a branch and restore its last session')
		.option('-f, --force', 'Skip confirm when the last checkpoint is >24h old')
		.action(async (branch: string, rawFlags: Record<string, unknown>) => {
			applyGlobalFlags(rawFlags);
			const force = rawFlags.force === true;

			if (!branch || typeof branch !== 'string' || branch.trim() === '') {
				throw new SilentError(new Error('Usage: story resume <branch>'));
			}

			const repoRoot = await requireGitRepo();
			if (!(await isReady(repoRoot))) {
				return;
			}

			await runResume(repoRoot, branch.trim(), { force });
		});
}

/**
 * Full resume pipeline.
 *
 * 8-step flow (mirrors Go `resume.go: runResume`):
 *   1. validateBranchName → SilentError on invalid
 *   2. resolve: local? / remote? / neither → SilentError
 *   3. git status --porcelain → SilentError if dirty
 *   4. git checkout <branch>
 *   5. find latest session via findSessionsForCommit(HEAD)
 *   6. stale? (>24h) + !--force → confirm
 *   7. restore via ManualCommitStrategy.rewind(point)
 *   8. stepDone + footer hint
 *
 * @example
 * await runResume('/repo', 'feat/dark-mode', { force: false });
 *
 * // Side effects (happy path):
 * //   <repo>/.git/HEAD                           ← points at feat/dark-mode
 * //   <repo>/.git/refs/heads/feat/dark-mode      ← created or unchanged
 * //   <repo>/.git/refs/heads/story/<base>-<hex>  ← reset by strategy.rewind
 * //   <repo>/<worktree>                          ← files restored from checkpoint tree
 * //   <agent session dir>/<sess>.jsonl           ← transcript restored
 * // Unchanged: other local branches, .story/settings.json, remote refs (except optional origin/<branch> ref fetched when local missing).
 */
async function runResume(
	repoRoot: string,
	branch: string,
	opts: { force: boolean },
): Promise<void> {
	const flags = getGlobalFlags();
	const json = flags.json;
	if (!json) {
		header(`story resume ${branch}`);
		barEmpty();
	}

	// Step 1: validate branch name (foundation #22).
	const err = await validateBranchName(branch, repoRoot);
	if (err !== null) {
		throw new SilentError(err);
	}

	// Step 2: resolve local vs remote.
	if (!json) {
		step(`Resolving branch ${branch}`);
	}
	const hasLocal = await branchExistsLocally(branch, repoRoot);
	if (!hasLocal) {
		const hasRemote = await branchExistsOnRemote(branch, repoRoot);
		if (!hasRemote) {
			throw new SilentError(new Error(`Branch '${branch}' not found locally or on origin`));
		}
		if (!json) {
			warn(`no local branch · origin/${branch} found`);
			barEmpty();
		}
		await withSpinner(`Fetching origin/${branch}`, async () => {
			await fetchAndCheckoutRemoteBranch(repoRoot, 'origin', branch);
		});
	}

	// Step 3: dirty worktree guard.
	const porcelain = (await execGit(['status', '--porcelain'], { cwd: repoRoot })).trim();
	if (porcelain !== '') {
		throw new SilentError(
			new Error(
				`Working tree has uncommitted changes. Commit or stash them before resuming to avoid data loss.`,
			),
		);
	}

	// Step 4: checkout (skipped when already on target).
	let currentBranch = '';
	try {
		currentBranch = (
			await execGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot })
		).trim();
	} catch {
		currentBranch = '';
	}
	if (currentBranch !== branch && hasLocal) {
		// fetchAndCheckoutRemoteBranch already runs `git checkout`; local-only
		// path runs it here.
		await withSpinner(`Switching to ${branch}`, async () => {
			await execGit(['checkout', branch], { cwd: repoRoot });
		});
	}

	// Step 5: find latest session for HEAD (the branch tip after checkout).
	const headSha = (await execGit(['rev-parse', branch], { cwd: repoRoot })).trim();

	if (!json) {
		step(`Looking up session on ${branch}`);
	}

	const strategy = new ManualCommitStrategy(repoRoot);
	let sessions: SessionState[];
	try {
		sessions = await strategy.findSessionsForCommit(headSha);
	} catch {
		sessions = [];
	}
	if (sessions.length === 0) {
		throw new SilentError(
			new Error(`No session found on '${branch}' (no Story-Session trailer on branch tip)`),
		);
	}
	const state = sessions[0]!;

	// Step 6: find latest checkpoint for this session.
	let checkpoints: CheckpointInfo[] = [];
	try {
		checkpoints = await listCheckpoints(repoRoot);
	} catch {
		checkpoints = [];
	}
	const sessionCps = checkpoints
		.filter((c) => c.sessionId === state.sessionId)
		.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
	if (sessionCps.length === 0) {
		throw new SilentError(
			new Error(`No checkpoints found for session '${state.sessionId}' on metadata branch`),
		);
	}
	const latest = sessionCps[0]!;

	if (!json) {
		barLine(
			`${color.dim('session')}   ${state.sessionId} · ${color.dim('agent')} ${state.agentType ?? '(unknown)'}`,
		);
		barLine(`${color.dim('checkpoint')}  ${latest.checkpointId}`);
		barEmpty();
	}

	// Step 7: stale checkpoint confirm.
	const ageMs = Date.now() - latest.createdAt.getTime();
	if (ageMs > STALE_CHECKPOINT_MS && !opts.force && !json) {
		warn(`Latest checkpoint is ${formatAge(ageMs)} old. Workspace state may be stale.`);
		barEmpty();
		const ok = await confirm({
			message: `Restore working tree from ${latest.checkpointId}?`,
			yesDefault: true,
			signal: getRootSignal(),
		});
		if (!ok) {
			throw new SilentError(new Error('cancelled'));
		}
	}

	// Step 8: restore via strategy.rewind. CheckpointInfo doesn't carry the
	// commit hash, so we use HEAD as the restore point — the branch tip is
	// what the user wants to resume to anyway (Go also falls back to HEAD
	// via `resume.go` when metadata doesn't carry per-checkpoint commit).
	await withSpinner(`Restoring working tree from ${latest.checkpointId}`, async () => {
		await strategy.rewind(process.stdout, process.stderr, {
			id: headSha,
			message: latest.checkpointId,
			metadataDir: `.story/metadata/${state.sessionId}`,
			date: latest.createdAt,
			isTaskCheckpoint: false,
			toolUseId: '',
			isLogsOnly: false,
			checkpointId: latest.checkpointId,
			agent: state.agentType ?? 'Unknown',
			sessionId: state.sessionId,
			sessionPrompt: '',
			sessionCount: 1,
			sessionIds: [state.sessionId],
			sessionPrompts: [],
		});
	});

	if (json) {
		process.stdout.write(
			`${JSON.stringify({
				resumed: {
					branch,
					sessionId: state.sessionId,
					checkpoint: latest.checkpointId,
				},
			})}\n`,
		);
		return;
	}

	stepDone(`Resumed ${state.sessionId} on ${branch}`);
	barEmpty();
	footer(color.dim(`Run 'story explain -c ${latest.checkpointId}' for details.`));
}

function formatAge(ms: number): string {
	const hours = Math.floor(ms / 3600_000);
	if (hours < 24) {
		return `${hours}h`;
	}
	const days = Math.floor(hours / 24);
	return `${days}d`;
}

async function requireGitRepo(): Promise<string> {
	try {
		return await worktreeRoot(process.cwd());
	} catch {
		throw new SilentError(new Error('Not a git repository'));
	}
}

async function isReady(repoRoot: string): Promise<boolean> {
	const setUp = await isSetUpAny(repoRoot);
	if (!setUp) {
		header('story resume');
		barEmpty();
		barLine(`${color.dim('○')} Story is not enabled in this repository.`);
		barEmpty();
		footer(color.dim("Run 'story enable' to set it up."));
		return false;
	}
	if (!(await isEnabled(repoRoot))) {
		header('story resume');
		barEmpty();
		barLine(`${color.dim('○')} Story settings have 'enabled: false'.`);
		barEmpty();
		footer(color.dim("Run 'story configure' to re-enable."));
		return false;
	}
	return true;
}
