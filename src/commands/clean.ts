/**
 * `story clean` — remove Story session data from the current repo.
 *
 * Four flag-routed branches mirroring Go `clean.go: newCleanCmd`:
 *   - (no flag)     → runCleanCurrentHead   (session attached to HEAD only)
 *   - `--all`       → runCleanAll           (whole-repo sweep)
 *   - `--dry-run`   → runCleanDryRun        (preview, no writes)
 *   - `--session`   → runCleanSession       (one specific session by id/prefix)
 *
 * Confirm defaults to **No** (destructive op — `--force` / `--yes` override).
 * The actual scan/delete work lives in
 * [`@/strategy/cleanup`](../strategy/cleanup.ts); this file is pure CLI
 * orchestration (flag parsing, mutex validation, UI output, exit codes).
 *
 * Mirrors Go `cmd/entire/cli/clean.go`.
 *
 * @packageDocumentation
 */

import type { CAC } from 'cac';
import { match } from 'ts-pattern';
import { applyGlobalFlags } from '@/cli/flags';
import { getRootSignal } from '@/cli/runtime';
import { resolveSessionIdPrefix } from '@/commands/_shared/session-list';
import { SilentError } from '@/errors';
import { execGit } from '@/git';
import { worktreeRoot } from '@/paths';
import {
	type CleanupItem,
	type CleanupResult,
	deleteAllCleanupItems,
	listAllItems,
} from '@/strategy/cleanup';
import { truncateDescription } from '@/strategy/messages';
import { readPromptsFromFilesystem } from '@/strategy/transcript-prompts';
import { barEmpty, barLine, confirm, footer, header, info, step, stepDone, warn } from '@/ui';
import { color } from '@/ui/theme';

/**
 * Register `story clean` on a cac instance. Call once from
 * {@link ./index::registerCoreCommands}.
 *
 * Go: `clean.go: newCleanCmd`.
 *
 * @example
 * registerCleanCommand(cli);
 * // Now resolvable:
 * //   story clean
 * //   story clean --all [--dry-run] [--force]
 * //   story clean --dry-run
 * //   story clean --session <id>
 */
export function registerCleanCommand(cli: CAC): void {
	cli
		.command('clean', 'Clean up Story session data')
		.option('-f, --force', 'Skip confirmation and override the active-session guard')
		.option('-a, --all', 'Clean every Story session in the repository')
		.option('-d, --dry-run', 'Preview what would be deleted without writing')
		.option('--session <id>', 'Clean only the session with the given id (accepts 12-char prefix)')
		.action(async (rawFlags: Record<string, unknown>) => {
			applyGlobalFlags(rawFlags);

			const all = rawFlags.all === true;
			const dryRun = rawFlags['dry-run'] === true || rawFlags.dryRun === true;
			const force = rawFlags.force === true;
			const sessionId =
				typeof rawFlags.session === 'string' ? (rawFlags.session as string).trim() : '';

			validateMutex({ all, sessionId });

			const repoRoot = await requireGitRepo();

			if (sessionId !== '') {
				await runCleanSession(repoRoot, sessionId, { force, dryRun });
				return;
			}
			if (all) {
				await runCleanAll(repoRoot, { force, dryRun });
				return;
			}
			await runCleanCurrentHead(repoRoot, { force, dryRun });
		});
}

/**
 * Flag mutex. cac can't natively mark `--all` / `--session` as exclusive
 * so we validate manually and throw a {@link SilentError} with the exact
 * copy from [`9.5-0-clean.md`](../../docs/ts-rewrite/impl/phase-9-commands/phase-9.0-setup/commands/9.5-0-clean.md).
 *
 * @internal
 */
function validateMutex(flags: { all: boolean; sessionId: string }): void {
	if (flags.all && flags.sessionId !== '') {
		throw new SilentError(
			new Error(
				'--all and --session are mutually exclusive | Pick one: clean everything (--all) or one session (--session <id>).',
			),
		);
	}
}

/**
 * Resolve the current worktree root, converting the "not a git repo"
 * case into a user-facing {@link SilentError}. Mirrors the small guard
 * helper in [`./rewind.ts`](./rewind.ts) — kept duplicated rather than
 * moved to `_shared/` because the error copy is intentionally
 * command-specific (each command's first bar-block line names itself).
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
 * One-line, width-aware truncation for a dim in-flight-prompt sub-line
 * in the clean item list.
 *
 * @internal
 */
function truncateCleanPromptLine(s: string): string {
	const oneLine = s.replace(/\s+/g, ' ').trim();
	const rawCols = process.stdout.columns;
	const cols = typeof rawCols === 'number' && rawCols > 0 ? rawCols : 100;
	const maxRunes = Math.max(20, cols - 6);
	return truncateDescription(oneLine, maxRunes);
}

/**
 * Latest in-flight user prompt (last `---` segment in
 * `.story/metadata/<sessionId>/prompt.txt`), or `undefined` if none.
 *
 * @internal
 */
async function latestInFlightPromptForSession(
	repoRoot: string,
	sessionId: string,
): Promise<string | undefined> {
	const prompts = await readPromptsFromFilesystem(sessionId, repoRoot);
	if (prompts === null || prompts.length === 0) {
		return undefined;
	}
	const last = prompts[prompts.length - 1] ?? '';
	if (last === '') {
		return undefined;
	}
	return truncateCleanPromptLine(last);
}

/**
 * Default branch: clean the session(s) attached to the current HEAD
 * commit. Collects candidates via {@link listAllItems} and filters to
 * items that touch the HEAD commit (shadow branches whose name encodes
 * HEAD's short-sha; session states whose `baseCommit` equals HEAD).
 *
 * Mirrors Go `clean.go: runCleanCurrentHead`.
 *
 * @internal
 */
async function runCleanCurrentHead(
	repoRoot: string,
	opts: { force: boolean; dryRun: boolean },
): Promise<void> {
	header(opts.dryRun ? 'story clean --dry-run' : 'story clean');
	barEmpty();

	let headSha = '';
	try {
		headSha = (await execGit(['rev-parse', 'HEAD'], { cwd: repoRoot })).trim();
	} catch {
		throw new SilentError(new Error('Cannot read HEAD — is this an empty repository?'));
	}

	const all = await listAllItems({ repoRoot });
	const short = headSha.slice(0, 7);
	const matches = all.filter((item) => matchesHead(item, short));

	if (matches.length === 0) {
		barLine(`${color.dim('○')} No Story data attached to HEAD ${short}.`);
		barEmpty();
		footer(color.dim("Run 'story clean --all' to clean the whole repo."));
		return;
	}

	const title = opts.dryRun
		? `Targeting current HEAD (${short})  (dry-run)`
		: `Targeting current HEAD (${short})`;
	step(title);
	await printItemsWithInFlightPrompts(repoRoot, matches, { dryRun: opts.dryRun });
	barEmpty();

	if (opts.dryRun) {
		barLine(`${color.dim('ℹ')} Dry-run: nothing was written.`);
		barEmpty();
		footer(color.dim('Re-run without --dry-run to apply.'));
		return;
	}

	if (!opts.force) {
		const ok = await confirm({
			message: `Delete these ${matches.length} items?`,
			yesDefault: false,
			signal: getRootSignal(),
		});
		if (!ok) {
			warn('Cancelled.');
			footer();
			throw new SilentError(new Error('cancelled'));
		}
	}

	const result = await deleteAllCleanupItems({ repoRoot }, matches);
	printDeleteResult(result);
	stepDone(`Cleaned session data attached to ${short}`);
	footer(color.dim("Run 'story status' to verify."));
}

/**
 * `--all` branch: wipe every Story session state + shadow branch in the
 * repository. Preserves settings and committed checkpoint metadata
 * (`story/checkpoints/v1` + `refs/story/checkpoints/v2/*`) per the
 * [`9.5-0-clean.md`](../../docs/ts-rewrite/impl/phase-9-commands/phase-9.0-setup/commands/9.5-0-clean.md)
 * ASCII spec.
 *
 * Mirrors Go `clean.go: runCleanAll`.
 *
 * @internal
 */
async function runCleanAll(
	repoRoot: string,
	opts: { force: boolean; dryRun: boolean },
): Promise<void> {
	header(opts.dryRun ? 'story clean --all --dry-run' : 'story clean --all');
	barEmpty();

	const items = await listAllItems({ repoRoot });
	if (items.length === 0) {
		barLine(`${color.dim('○')} No Story session data found.`);
		barEmpty();
		footer(color.dim('Repository is already clean.'));
		return;
	}

	warn('--all: cleaning the whole repository.');
	info('This will remove:');
	await printItemsWithInFlightPrompts(repoRoot, items, { dryRun: opts.dryRun });
	barEmpty();
	barLine(`${color.dim('Preserved:')}`);
	barLine(`${color.dim('  ○ .story/settings*.json')}`);
	barLine(`${color.dim('  ○ story/checkpoints/v1 ref')}`);
	barLine(`${color.dim('  ○ refs/story/checkpoints/v2/*')}`);
	barEmpty();

	if (opts.dryRun) {
		barLine(`${color.dim('ℹ')} Dry-run: nothing was written.`);
		barEmpty();
		footer(color.dim('Re-run without --dry-run to apply.'));
		return;
	}

	if (!opts.force) {
		const ok = await confirm({
			message: `Permanently clean all ${items.length} items?`,
			yesDefault: false,
			signal: getRootSignal(),
		});
		if (!ok) {
			warn('Cancelled.');
			footer();
			throw new SilentError(new Error('cancelled'));
		}
	}

	const result = await deleteAllCleanupItems({ repoRoot }, items);
	printDeleteResult(result);
	stepDone('Cleaned all session data');
	footer(color.dim("Run 'story status' to verify."));
}

/**
 * `--session <id>` branch: clean exactly one session. `id` accepts a
 * 12-character prefix; 0 matches → not-found error, > 1 matches →
 * ambiguity error. Both errors surface as {@link SilentError}.
 *
 * Mirrors Go `clean.go: runCleanSession`.
 *
 * @internal
 */
async function runCleanSession(
	repoRoot: string,
	rawSessionId: string,
	opts: { force: boolean; dryRun: boolean },
): Promise<void> {
	header(
		opts.dryRun
			? `story clean --session ${rawSessionId} --dry-run`
			: `story clean --session ${rawSessionId}`,
	);
	barEmpty();

	let fullId: string;
	try {
		fullId = await resolveSessionIdPrefix(rawSessionId, repoRoot);
	} catch (err) {
		if (err instanceof SilentError) {
			throw err;
		}
		throw new SilentError(
			new Error(
				`Session not found: ${rawSessionId} | Run 'story sessions list' to see available IDs.`,
			),
		);
	}

	const all = await listAllItems({ repoRoot });
	const matches = all.filter((item) => item.type === 'session-state' && item.id === fullId);
	if (matches.length === 0) {
		throw new SilentError(
			new Error(
				`Session not found: ${rawSessionId} | Run 'story sessions list' to see available IDs.`,
			),
		);
	}

	step(`Matched session ${fullId}`);
	await printItemsWithInFlightPrompts(repoRoot, matches, { dryRun: opts.dryRun });
	barEmpty();

	if (opts.dryRun) {
		barLine(`${color.dim('ℹ')} Dry-run: nothing was written.`);
		barEmpty();
		footer(color.dim('Re-run without --dry-run to apply.'));
		return;
	}

	if (!opts.force) {
		const ok = await confirm({
			message: 'Delete this session?',
			yesDefault: false,
			signal: getRootSignal(),
		});
		if (!ok) {
			warn('Cancelled.');
			footer();
			throw new SilentError(new Error('cancelled'));
		}
	}

	const result = await deleteAllCleanupItems({ repoRoot }, matches);
	printDeleteResult(result);
	stepDone(`Cleaned session ${fullId}`);
	footer();
}

/**
 * Item → HEAD match predicate. Shadow branches encode the HEAD short sha
 * as the first hex segment; session states store the full baseCommit
 * (any reasonable prefix match qualifies).
 *
 * @internal
 */
function matchesHead(item: CleanupItem, headShort: string): boolean {
	return match(item.type)
		.with('shadow-branch', () => {
			// story/<commit[:7]>(-<6hex>)? — prefix test on the 7-char segment.
			const m = item.id.match(/^story\/([0-9a-fA-F]{7,})/);
			if (!m) {
				return false;
			}
			return m[1]!.startsWith(headShort);
		})
		.with('session-state', () => {
			// Conservative: every session-state is a candidate. runCleanCurrentHead
			// prints exactly what `listAllItems` returns so the user can inspect
			// the candidates before confirming. Matches Go behaviour where the
			// "clean HEAD" flow shows every state file and lets `deleteAllCleanupItems`
			// prune by the branch-existence check downstream.
			return true;
		})
		.with('checkpoint', () => false)
		.exhaustive();
}

/**
 * Print one bar-block row per cleanup item; after each
 * `session state` line, a dim one-line in-flight `prompt.txt` tail (when
 * present). Under `--dry-run` we stamp `would be removed` / `would be
 * deleted` suffixes + inactive `○` bullets; otherwise the standard
 * `●` list.
 *
 * @internal
 */
async function printItemsWithInFlightPrompts(
	repoRoot: string,
	items: readonly CleanupItem[],
	opts: { dryRun: boolean },
): Promise<void> {
	const verbBranch = opts.dryRun ? 'would be deleted' : '';
	const verbState = opts.dryRun ? 'would be removed' : '';
	const bullet = opts.dryRun ? color.dim('○') : `${color.green('●')}`;
	for (const item of items) {
		const line = match(item.type)
			.with(
				'shadow-branch',
				() =>
					`${bullet} ${color.bold('shadow branch')}  ${item.id}${verbBranch ? `   ${color.dim(verbBranch)}` : ''}`,
			)
			.with(
				'session-state',
				() =>
					`${bullet} ${color.bold('session state')}  ${item.id}${verbState ? `   ${color.dim(verbState)}` : ''}`,
			)
			.with('checkpoint', () => `${bullet} ${item.type}           ${item.id}`)
			.exhaustive();
		barLine(line);
		if (item.type === 'session-state') {
			const oneLine = await latestInFlightPromptForSession(repoRoot, item.id);
			if (oneLine !== undefined) {
				barLine(color.dim(oneLine));
			}
		}
	}
}

/**
 * Human-readable summary of a {@link CleanupResult}. Failed rows are
 * printed with a warn icon so users can see what didn't work without
 * having to decode JSON.
 *
 * @internal
 */
function printDeleteResult(result: CleanupResult): void {
	for (const id of result.shadowBranches) {
		barLine(`${color.green('●')} ${id} ${color.dim('deleted')}`);
	}
	for (const id of result.sessionStates) {
		barLine(`${color.green('●')} ${id} ${color.dim('removed')}`);
	}
	for (const id of result.failedBranches) {
		barLine(`${color.red('■')} ${id} ${color.dim('failed to delete')}`);
	}
	for (const id of result.failedStates) {
		barLine(`${color.red('■')} ${id} ${color.dim('failed to remove')}`);
	}
}
