/**
 * `story explain` — inspect a checkpoint / session / commit and render
 * its summary / transcript / files as human-readable output.
 *
 * Mirrors Go `cmd/entire/cli/explain.go: newExplainCmd` (1903-line CLI
 * shell). Story collapses Go's pager + Unicode rendering:
 *   - `--no-pager` on by default (TS doesn't ship a pager; users can
 *     pipe through `less` manually)
 *   - Uses Phase 9.0 UI primitives (bar block, `note`, `select`)
 *     instead of charmbracelet/huh
 *
 * Flag routing:
 *   - Locator (pick one — default to interactive select):
 *       --commit <ref>     → read the commit's Story-Checkpoint trailer
 *       --checkpoint <id>  → direct (prefix match supported)
 *       --session <id>     → filter + select
 *   - Density (mutually exclusive):
 *       --short            → 2-3 lines
 *       (default)          → Summary + Prompt + Files card
 *       --full             → per-turn transcript with dividers
 *       --raw-transcript   → raw JSONL, bypass UI
 *   - Side:
 *       --generate         → generate summary via LLM (Phase 11)
 *       --force            → rewrite existing summary (requires --generate)
 *       --search-all       → full git DAG walk when scanning for commits
 *                             referencing a checkpoint (default: bounded
 *                             500-commit walk). Mirrors Go
 *                             `getAssociatedCommits` searchAll toggle.
 *
 * TS-divergence vs Go `--search-all`: Go's default uses a **first-parent**
 * walk bounded to `commitScanLimit = 500` (skips merge-parent histories).
 * Story's default is a **depth-limited** (500) DAG walk via
 * `isomorphic-git.log` which follows all parents. Cross-branch leakage
 * is acceptable because the user gets a "Associated commits" list
 * regardless; `--search-all` removes the depth cap for long histories.
 * Porting Go's `computeReachableFromMain` filter is deferred (see
 * [phase-9.5 doctor](../../docs/ts-rewrite/impl/phase-9-commands/phase-9.5-clean-doctor-others/)).
 *
 * @packageDocumentation
 */

import type { CAC } from 'cac';
import { applyGlobalFlags, getGlobalFlags } from '@/cli/flags';
import { getRootSignal } from '@/cli/runtime';
import { type AssociatedCommit, getAssociatedCommits } from '@/commands/_shared/associated-commits';
import { getSessionLog } from '@/commands/_shared/session-log';
import {
	paginateTurns,
	parseTranscriptTurns,
	type TranscriptTurn,
} from '@/commands/_shared/transcript-display';
import { SilentError } from '@/errors';
import { execGit } from '@/git';
import { worktreeRoot } from '@/paths';
import { isEnabled, isSetUpAny } from '@/settings/settings';
import { listCheckpoints } from '@/strategy/metadata-branch';
import { generateSummary } from '@/strategy/summary-stub';
import { extractUserPromptsFromLines } from '@/strategy/transcript-prompts';
import type { CheckpointInfo, SessionState } from '@/strategy/types';
import { parseCheckpoint } from '@/trailers';
import { barEmpty, barLine, footer, header, note, select, step, stepDone, withSpinner } from '@/ui';
import { color } from '@/ui/theme';

type Density = 'short' | 'default' | 'full' | 'raw';

/**
 * Page size for `--pure --page <n>` rendering. Two turns per page
 * keeps each page small enough for context-window-conscious AI tools
 * (one user question + one assistant reply × 2 ≈ ≤2 KB plain text).
 */
const PURE_PAGE_SIZE = 2;

/**
 * Register `story explain` on a cac instance. Call once from
 * {@link ./index::registerCoreCommands}.
 *
 * Go: `explain.go: newExplainCmd`.
 *
 * @example
 * const cli = cac('story');
 * registerExplainCommand(cli);
 *
 * // Side effects on the cac instance:
 * //   cli.commands  ← appends an "explain" entry with 8 flags
 * //                   (session / commit / checkpoint / no-pager /
 * //                    short / full / raw-transcript / generate / force)
 * //
 * // Unchanged: already-registered commands, global flag state,
 * //            process state (no action runs until `cli.parse(argv)`).
 */
export function registerExplainCommand(cli: CAC): void {
	cli
		.command('explain', 'Explain a session / commit / checkpoint')
		.option('--session <id>', 'Filter checkpoints to this session id (prefix ok)')
		.option('--commit <ref>', 'Read the Story-Checkpoint trailer of this commit')
		.option('-c, --checkpoint <id>', 'Checkpoint id (prefix ok)')
		.option('--no-pager', 'Disable pager (default: on — pager not implemented)')
		.option('-s, --short', '2-3 line summary per checkpoint')
		.option('--full', 'Full transcript rendering (all turns)')
		.option('--raw-transcript', 'Raw JSONL to stdout (bypass UI)')
		.option('--generate', 'Generate AI summary (requires --checkpoint)')
		.option('--force', 'Rewrite existing summary (requires --generate)')
		.option('--search-all', 'Full git DAG walk for associated-commits scan (may be slow)')
		.option(
			'--page <n>',
			'AI plain-text page index (1-based). Only effective with --pure; pairs with --pure --page <n>.',
		)
		.action(async (rawFlags: Record<string, unknown>) => {
			applyGlobalFlags(rawFlags);

			const sessionFilter = typeof rawFlags.session === 'string' ? rawFlags.session.trim() : '';
			const commitFlag = typeof rawFlags.commit === 'string' ? rawFlags.commit.trim() : '';
			const checkpointFlag =
				typeof rawFlags.checkpoint === 'string' ? rawFlags.checkpoint.trim() : '';
			const short = rawFlags.short === true;
			const full = rawFlags.full === true;
			const rawTranscript = rawFlags['raw-transcript'] === true || rawFlags.rawTranscript === true;
			const generateFlag = rawFlags.generate === true;
			const forceFlag = rawFlags.force === true;
			const searchAll = rawFlags['search-all'] === true || rawFlags.searchAll === true;
			const pure = getGlobalFlags().pure;
			const pageRaw = rawFlags.page;

			validateDensityMutex({ short, full, rawTranscript });
			validateGenerateMutex({ generateFlag, checkpointFlag, forceFlag, rawTranscript });
			validatePureMutex({ pure, short, rawTranscript });

			// `--pure` is a no-op without one of `--page <n>` or `--full`.
			// Same for `--page <n>` without `--pure`. Both fall through to
			// the regular density routing below.
			const pureWithFull = pure && full;
			const pureWithPage = pure && pageRaw !== undefined;
			const pureMode: 'full' | 'page' | null = pureWithPage ? 'page' : pureWithFull ? 'full' : null;

			let pageNumber: number | null = null;
			if (pureMode === 'page') {
				pageNumber = parsePageFlag(pageRaw);
			}

			const density: Density = short ? 'short' : full ? 'full' : rawTranscript ? 'raw' : 'default';

			const repoRoot = await requireGitRepo();
			if (!(await isReady(repoRoot))) {
				return;
			}

			if (pureMode !== null) {
				await runExplainPure(repoRoot, {
					sessionFilter,
					commitFlag,
					checkpointFlag,
					mode: pureMode,
					page: pageNumber,
				});
				return;
			}

			await runExplain(repoRoot, {
				sessionFilter,
				commitFlag,
				checkpointFlag,
				density,
				generateFlag,
				forceFlag,
				searchAll,
			});
		});
}

function validateDensityMutex(flags: {
	short: boolean;
	full: boolean;
	rawTranscript: boolean;
}): void {
	const set = [flags.short, flags.full, flags.rawTranscript].filter(Boolean);
	if (set.length > 1) {
		throw new SilentError(
			new Error('--short, --full, --raw-transcript are mutually exclusive (density flags)'),
		);
	}
}

function validateGenerateMutex(flags: {
	generateFlag: boolean;
	checkpointFlag: string;
	forceFlag: boolean;
	rawTranscript: boolean;
}): void {
	if (flags.generateFlag && flags.checkpointFlag === '') {
		throw new SilentError(new Error('--generate requires --checkpoint <id>'));
	}
	if (flags.forceFlag && !flags.generateFlag) {
		throw new SilentError(new Error('--force requires --generate'));
	}
	if (flags.generateFlag && flags.rawTranscript) {
		throw new SilentError(new Error('--generate and --raw-transcript are mutually exclusive'));
	}
}

function validatePureMutex(flags: { pure: boolean; short: boolean; rawTranscript: boolean }): void {
	if (!flags.pure) {
		return;
	}
	if (flags.short) {
		throw new SilentError(new Error('--pure and --short are mutually exclusive'));
	}
	if (flags.rawTranscript) {
		throw new SilentError(new Error('--pure and --raw-transcript are mutually exclusive'));
	}
}

/**
 * Parse `--page <n>` to a positive integer. Surfaces `SilentError`
 * with a clear message on `0` / negative / non-integer / non-numeric
 * input. cac may pass strings or numbers depending on whether the
 * flag was declared with `<n>`; both are accepted.
 */
function parsePageFlag(raw: unknown): number {
	const reject = (): never => {
		throw new SilentError(new Error('--page must be a positive integer'));
	};
	let n: number;
	if (typeof raw === 'number') {
		n = raw;
	} else if (typeof raw === 'string') {
		const trimmed = raw.trim();
		if (trimmed === '' || !/^-?\d+$/.test(trimmed)) {
			reject();
		}
		n = Number(trimmed);
	} else {
		reject();
		// Unreachable; reject() throws.
		return 0 as never;
	}
	if (!Number.isInteger(n) || n <= 0) {
		reject();
	}
	return n;
}

interface ExplainOpts {
	sessionFilter: string;
	commitFlag: string;
	checkpointFlag: string;
	density: Density;
	generateFlag: boolean;
	forceFlag: boolean;
	searchAll: boolean;
}

/**
 * Main explain pipeline.
 *
 * @example
 * await runExplain('/repo', { checkpointFlag: 'ckpt_abc', density: 'default', ... });
 *
 * // Side effects: read-only — metadata-branch tree walks. --generate
 * // (Phase 11) would write back to the metadata branch, but Phase 9.4
 * // currently surfaces the stub with SilentError pointing at Phase 11.
 */
async function runExplain(repoRoot: string, opts: ExplainOpts): Promise<void> {
	const json = getGlobalFlags().json;

	// Step 1: gather candidate checkpoints.
	let checkpoints = await listCheckpoints(repoRoot);

	if (checkpoints.length === 0) {
		throw new SilentError(new Error('No checkpoints found on metadata branch'));
	}

	// Apply --session filter.
	if (opts.sessionFilter !== '') {
		checkpoints = checkpoints.filter(
			(c) => c.sessionId === opts.sessionFilter || c.sessionId.startsWith(opts.sessionFilter),
		);
		if (checkpoints.length === 0) {
			throw new SilentError(new Error(`No checkpoints found for session '${opts.sessionFilter}'`));
		}
	}

	// Step 2: pick the checkpoint.
	//   - --commit <ref>     → direct (trailer)
	//   - --checkpoint <id>  → direct (prefix match)
	//   - --session <id>     → always select (even if filtered down to 1 —
	//                          user asked for a list)
	//   - default            → direct if single match, else interactive select
	let picked: CheckpointInfo;
	if (opts.commitFlag !== '') {
		picked = await resolveFromCommit(repoRoot, opts.commitFlag, checkpoints);
	} else if (opts.checkpointFlag !== '') {
		picked = resolveFromPrefix(opts.checkpointFlag, checkpoints);
	} else if (opts.sessionFilter !== '') {
		picked = await pickInteractive(checkpoints);
	} else if (checkpoints.length === 1) {
		picked = checkpoints[0]!;
	} else {
		picked = await pickInteractive(checkpoints);
	}

	// Step 3: --generate path.
	if (opts.generateFlag) {
		await runGenerate(repoRoot, picked, opts.forceFlag);
		return;
	}

	// Step 4: load transcript + metadata.
	const log = await getSessionLog(repoRoot, picked.checkpointId);

	// Step 5: render.
	if (opts.density === 'raw') {
		if (log === null) {
			throw new SilentError(new Error(`no transcript found for ${picked.checkpointId}`));
		}
		process.stdout.write(`${new TextDecoder().decode(log.transcript)}`);
		return;
	}

	// Step 6: associated-commits scan. Go `explain.go:623
	// getAssociatedCommits(..., searchAll)` runs on the picked checkpoint
	// regardless of density. `--search-all` toggles the depth cap.
	const associated = await getAssociatedCommits(repoRoot, picked.checkpointId, opts.searchAll);

	if (json) {
		process.stdout.write(
			`${JSON.stringify({
				checkpoint: picked.checkpointId,
				sessionId: picked.sessionId,
				transcript: log !== null ? new TextDecoder().decode(log.transcript) : null,
				associatedCommits: associated.map((c) => ({
					sha: c.sha,
					shortSha: c.shortSha,
					message: c.message,
					author: c.author,
					date: c.date.toISOString(),
				})),
			})}\n`,
		);
		return;
	}

	header('story explain');
	barEmpty();

	switch (opts.density) {
		case 'short':
			renderShort(picked);
			break;
		case 'full':
			renderFull(picked, log?.transcript ?? null);
			break;
		default:
			renderDefault(picked, log?.transcript ?? null);
			break;
	}

	renderAssociatedCommits(associated, opts.searchAll);

	barEmpty();
	stepDone('Loaded');
	barEmpty();
	footer(
		color.dim(
			opts.density === 'full'
				? `Run 'story rewind --list' to find a target commit, then 'story rewind --to <commit>' to travel back.`
				: `Run 'story explain -c ${picked.checkpointId} --full' for transcript.`,
		),
	);
}

/** Resolve checkpoint via commit's Story-Checkpoint trailer. */
async function resolveFromCommit(
	repoRoot: string,
	ref: string,
	checkpoints: CheckpointInfo[],
): Promise<CheckpointInfo> {
	let msg: string;
	try {
		msg = await execGit(['log', '-1', '--format=%B', ref], { cwd: repoRoot });
	} catch (e) {
		throw new SilentError(new Error(`failed to read commit ${ref}: ${(e as Error).message}`));
	}
	const cpId = parseCheckpoint(msg);
	if (cpId === null) {
		throw new SilentError(new Error(`Commit ${ref} has no Story-Checkpoint trailer`));
	}
	const found = checkpoints.find((c) => c.checkpointId === cpId);
	if (!found) {
		throw new SilentError(
			new Error(`Commit trailer points at checkpoint ${cpId} but it is not on the metadata branch`),
		);
	}
	return found;
}

/** Resolve checkpoint via exact or prefix match. */
function resolveFromPrefix(prefix: string, checkpoints: CheckpointInfo[]): CheckpointInfo {
	const exact = checkpoints.find((c) => c.checkpointId === prefix);
	if (exact !== undefined) {
		return exact;
	}
	const matches = checkpoints.filter((c) => c.checkpointId.startsWith(prefix));
	if (matches.length === 0) {
		throw new SilentError(new Error(`Checkpoint '${prefix}' not found`));
	}
	if (matches.length > 1) {
		throw new SilentError(
			new Error(
				`Ambiguous checkpoint prefix '${prefix}' (matches ${matches.length}: ${matches.map((m) => m.checkpointId).join(', ')})`,
			),
		);
	}
	return matches[0]!;
}

/** Interactive picker (default branch). */
async function pickInteractive(checkpoints: CheckpointInfo[]): Promise<CheckpointInfo> {
	const options = checkpoints.map((c) => ({
		value: c.checkpointId,
		label: `${c.checkpointId}  ${c.sessionId}  ${c.agent ?? ''}`,
	}));
	const pickedId = await select<string>({
		message: 'Select a checkpoint to explain',
		options,
		signal: getRootSignal(),
	});
	const picked = checkpoints.find((c) => c.checkpointId === pickedId);
	if (!picked) {
		throw new SilentError(new Error('selection not found'));
	}
	return picked;
}

/** `--generate` branch — surfaces Phase 11 stub. */
async function runGenerate(
	repoRoot: string,
	picked: CheckpointInfo,
	_force: boolean,
): Promise<void> {
	await withSpinner('Generating summary via AI', async () => {
		const log = await getSessionLog(repoRoot, picked.checkpointId);
		if (log === null) {
			throw new SilentError(new Error(`no transcript available for ${picked.checkpointId}`));
		}
		// Phase 5.3 stub returns null; Phase 11 replaces body with real LLM.
		// Construct a minimally-typed SessionState — only the required fields
		// on `SessionState` (sessionId / baseCommit / startedAt / phase /
		// stepCount per `src/session/state-store.ts`). Phase 11's real
		// `generateSummary` will read `agentType` + `filesTouched` to scope
		// the LLM prompt; other fields are not read by the current stub.
		const state: SessionState = {
			sessionId: picked.sessionId,
			baseCommit: '',
			startedAt: new Date().toISOString(),
			phase: 'ended',
			stepCount: 0,
			agentType: picked.agent,
		};
		try {
			const summary = await generateSummary({ component: 'explain' }, log.transcript, [], state);
			if (summary === null) {
				// Phase 5.3 permanent stub — body is a no-op returning null.
				// When Phase 11 lands, a non-null Summary is returned and we
				// fall through without error.
				throw new SilentError(
					new Error(
						'--generate: Phase 11 (AI summarize) not yet implemented — see docs/ts-rewrite/impl/phase-11-summarize/module.md',
					),
				);
			}
		} catch (e) {
			// Phase 5.3 stub ships with `NOT_IMPLEMENTED` throws as an
			// alternate failure mode (in case Phase 11 wiring half-lands);
			// translate to the same Phase-11 SilentError so UX is stable.
			if (e instanceof SilentError) {
				throw e;
			}
			const msg = (e as Error).message ?? '';
			if (msg.includes('NOT_IMPLEMENTED') || msg.includes('Phase 11')) {
				throw new SilentError(
					new Error(
						'--generate: Phase 11 (AI summarize) not yet implemented — see docs/ts-rewrite/impl/phase-11-summarize/module.md',
					),
				);
			}
			throw e;
		}
	});
}

// Renderers

/**
 * Render the "Associated commits" block after the checkpoint card.
 * Shows which git commits reference this checkpoint via their
 * `Story-Checkpoint:` trailer.
 *
 * Mirrors Go `explain.go` tail section that lists associated commits
 * when `getAssociatedCommits` returns non-empty. Prints "(0 found)"
 * only when the user explicitly asked via `--search-all` (otherwise we
 * silently skip the block to keep the card compact).
 *
 * @internal
 */
function renderAssociatedCommits(commits: AssociatedCommit[], searchAll: boolean): void {
	if (commits.length === 0) {
		if (searchAll) {
			barEmpty();
			step('Associated commits');
			barLine(color.dim('  (none found — checkpoint not referenced in any reachable commit)'));
		}
		return;
	}
	barEmpty();
	step(`Associated commits (${commits.length})${searchAll ? color.dim(' — full DAG') : ''}`);
	// Show up to 10; overflow marker for the rest (matches Go's card-size sensibility).
	const maxShown = 10;
	for (let i = 0; i < Math.min(commits.length, maxShown); i += 1) {
		const c = commits[i]!;
		barLine(
			`  ${color.cyan(c.shortSha)} ${truncateDisplay(c.message, 60)} ${color.dim(`— ${c.author}`)}`,
		);
	}
	if (commits.length > maxShown) {
		barLine(color.dim(`  ... (${commits.length - maxShown} more)`));
	}
}

function renderShort(picked: CheckpointInfo): void {
	step(`Checkpoint ${picked.checkpointId}`);
	barLine(
		`${color.dim('session')}  ${picked.sessionId} · ${color.dim('agent')} ${picked.agent ?? '(unknown)'}`,
	);
	barLine(`${color.dim('created')} ${picked.createdAt.toISOString()}`);
}

function renderDefault(picked: CheckpointInfo, transcript: Uint8Array | null): void {
	step(`Checkpoint ${picked.checkpointId}`);
	barLine(`${color.dim('session')}  ${picked.sessionId}`);
	barLine(`${color.dim('agent')}    ${picked.agent ?? '(unknown)'}`);
	barLine(`${color.dim('created')}  ${picked.createdAt.toISOString()}`);
	barEmpty();

	if (transcript !== null) {
		const decoded = new TextDecoder().decode(transcript);
		const prompts = extractUserPromptsFromLines(decoded.split('\n'));
		const first = prompts[0] ?? '';
		if (first !== '') {
			note('First prompt', [truncateDisplay(first, 300)]);
		}
	}
}

/**
 * Render the full transcript as aggregated turns. Each turn collapses
 * its multiple assistant entries into one `assistant:` block and any
 * `tool_use` blocks render as a `tool: <name>` line followed by JSON
 * `input`. Tool results are intentionally dropped — they're noise for
 * "what did the AI try to do" reading.
 *
 * Story-side TS extension; Go's `explain.go` renders one line per
 * JSONL entry, which is harder to skim once a turn has many
 * intermediate assistant chunks.
 */
function renderFull(picked: CheckpointInfo, transcript: Uint8Array | null): void {
	step(`Checkpoint ${picked.checkpointId}  (full transcript)`);
	barLine(`${color.dim('session')}  ${picked.sessionId}`);
	barEmpty();

	if (transcript === null) {
		barLine(color.dim('(no transcript available)'));
		return;
	}
	const turns = parseTranscriptTurns(new TextDecoder().decode(transcript).split('\n'));
	if (turns.length === 0) {
		barLine(color.dim('(empty transcript)'));
		return;
	}
	for (const turn of turns) {
		barEmpty();
		barLine(color.cyan(`── Turn ${turn.index} ──`));
		emitTurnIntoBarBlock(turn);
	}
}

/**
 * Emit one aggregated turn into the bar block (`│  ...` lines).
 * Each multi-line text body is split so every line gets its own bar
 * prefix; otherwise long assistant bodies break the bar visual.
 */
function emitTurnIntoBarBlock(turn: TranscriptTurn): void {
	if (turn.userText !== '') {
		emitLabeledBlock('user', turn.userText);
	}
	if (turn.assistantText !== '') {
		emitLabeledBlock('assistant', turn.assistantText);
	}
	for (const tool of turn.toolCalls) {
		barLine(`${color.dim('tool')}: ${tool.name}`);
		const json = safeStringifyForDisplay(tool.input);
		for (const line of json.split('\n')) {
			barLine(`  ${color.dim(line)}`);
		}
	}
}

function emitLabeledBlock(label: string, body: string): void {
	const lines = body.split('\n');
	const first = lines[0] ?? '';
	barLine(`${color.dim(label)}: ${truncateDisplay(first, 200)}`);
	for (let i = 1; i < lines.length; i += 1) {
		barLine(`  ${truncateDisplay(lines[i] ?? '', 200)}`);
	}
}

/**
 * Stringify a tool call's `input` for display. Falls back to
 * `String(value)` if the input contains a non-serializable value
 * (e.g. circular ref) so the renderer never throws.
 */
function safeStringifyForDisplay(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		return String(value);
	}
}

interface PureOpts {
	sessionFilter: string;
	commitFlag: string;
	checkpointFlag: string;
	mode: 'full' | 'page';
	page: number | null;
}

/**
 * AI-facing plain-text pipeline. Reuses checkpoint resolution from
 * the regular pipeline but bypasses the bar-block UI entirely:
 *   - No banner / no `┌ │ └` glyphs / no ANSI color
 *   - Aggregated turns from `parseTranscriptTurns` so output is
 *     deterministic per page
 *   - Trailer with the next-page command (or omitted on the last page)
 */
async function runExplainPure(repoRoot: string, opts: PureOpts): Promise<void> {
	let checkpoints = await listCheckpoints(repoRoot);
	if (checkpoints.length === 0) {
		throw new SilentError(new Error('No checkpoints found on metadata branch'));
	}
	if (opts.sessionFilter !== '') {
		checkpoints = checkpoints.filter(
			(c) => c.sessionId === opts.sessionFilter || c.sessionId.startsWith(opts.sessionFilter),
		);
		if (checkpoints.length === 0) {
			throw new SilentError(new Error(`No checkpoints found for session '${opts.sessionFilter}'`));
		}
	}

	let picked: CheckpointInfo;
	if (opts.commitFlag !== '') {
		picked = await resolveFromCommit(repoRoot, opts.commitFlag, checkpoints);
	} else if (opts.checkpointFlag !== '') {
		picked = resolveFromPrefix(opts.checkpointFlag, checkpoints);
	} else if (opts.sessionFilter !== '') {
		picked = await pickInteractive(checkpoints);
	} else if (checkpoints.length === 1) {
		picked = checkpoints[0]!;
	} else {
		picked = await pickInteractive(checkpoints);
	}

	const log = await getSessionLog(repoRoot, picked.checkpointId);
	const lines = log === null ? [] : new TextDecoder().decode(log.transcript).split('\n');
	const turns = parseTranscriptTurns(lines);

	const out = renderPureTranscript(picked, turns, opts);
	process.stdout.write(out);
}

/**
 * Build the AI plain-text payload. Deterministic — no I/O, no
 * timestamps, no ANSI. Returns the full string so callers can write
 * it to stdout in one shot (helpful for stable test diffs).
 */
function renderPureTranscript(
	picked: CheckpointInfo,
	turns: TranscriptTurn[],
	opts: PureOpts,
): string {
	const buf: string[] = [];
	buf.push(`# story explain ${picked.checkpointId}\n`);
	buf.push(`session: ${picked.sessionId}\n`);
	if (picked.agent) {
		buf.push(`agent: ${picked.agent}\n`);
	}
	buf.push(`turns: ${turns.length}\n`);

	let visible: TranscriptTurn[];
	let trailer: string | null = null;

	if (opts.mode === 'page' && opts.page !== null) {
		const { items, hasNext, totalPages } = paginateTurns(turns, opts.page, PURE_PAGE_SIZE);
		buf.push(`page: ${opts.page}/${Math.max(totalPages, 1)}\n`);
		visible = items;
		if (hasNext) {
			trailer = `next: story explain -c ${picked.checkpointId} --pure --page ${opts.page + 1}\n`;
		}
	} else {
		visible = turns;
	}

	buf.push('\n');

	if (visible.length === 0) {
		buf.push('(no turns to display)\n');
	} else {
		for (const turn of visible) {
			buf.push(`## Turn ${turn.index}\n`);
			if (turn.userText !== '') {
				buf.push('user:\n');
				buf.push(`${turn.userText}\n`);
			}
			if (turn.assistantText !== '') {
				buf.push('assistant:\n');
				buf.push(`${turn.assistantText}\n`);
			}
			for (const tool of turn.toolCalls) {
				buf.push(`tool: ${tool.name}\n`);
				const json = safeStringifyForDisplay(tool.input);
				buf.push(`${json}\n`);
			}
			buf.push('\n');
		}
	}

	if (trailer !== null) {
		buf.push(trailer);
	}
	return buf.join('');
}

/**
 * Truncate a string for card / transcript display. Coerces non-strings so a
 * bad upstream shape cannot throw at `.slice` (regression guard for
 * multimodal transcript objects mistaken for strings).
 */
export function truncateDisplay(s: unknown, n: number): string {
	const str = typeof s === 'string' ? s : String(s);
	if (str.length <= n) {
		return str;
	}
	return `${str.slice(0, n - 1)}…`;
}

async function requireGitRepo(): Promise<string> {
	try {
		return await worktreeRoot(process.cwd());
	} catch {
		throw new SilentError(new Error('Not a git repository'));
	}
}

async function isReady(repoRoot: string): Promise<boolean> {
	if (!(await isSetUpAny(repoRoot))) {
		header('story explain');
		barEmpty();
		barLine(`${color.dim('○')} Story is not enabled in this repository.`);
		barEmpty();
		footer(color.dim("Run 'story enable' to set it up."));
		return false;
	}
	if (!(await isEnabled(repoRoot))) {
		header('story explain');
		barEmpty();
		barLine(`${color.dim('○')} Story settings have 'enabled: false'.`);
		barEmpty();
		footer(color.dim("Run 'story configure' to re-enable."));
		return false;
	}
	return true;
}
