/**
 * `story sessions info <session-id>` — detailed card view for a single
 * session. Supports unique-prefix matching via
 * {@link resolveSessionIdPrefix}.
 *
 * Go: `cmd/entire/cli/sessions.go: newInfoCmd / runSessionInfo` +
 * `resolveSessionIDPrefix`.
 *
 * The card layout (Session / Tokens / Checkpoints / Files touched) is
 * Story's bar-block adaptation of Go's lipgloss vertical list; the data
 * fields are byte-for-byte compatible.
 *
 * @packageDocumentation
 */

import { getGlobalFlags } from '@/cli/flags';
import type { EnrichedSession } from '@/commands/_shared/session-list';
import { getSession, resolveSessionIdPrefix } from '@/commands/_shared/session-list';
import { SilentError } from '@/errors';
import { worktreeRoot } from '@/paths';
import { isEnabled, isSetUpAny } from '@/settings/settings';
import { listCheckpoints } from '@/strategy/metadata-branch';
import type { CheckpointInfo } from '@/strategy/types';
import { barEmpty, barLine, footer, header, step, stepDone } from '@/ui';
import { color } from '@/ui/theme';

/** Number of checkpoints printed in the bar-block card (older ones collapsed). */
const BAR_BLOCK_CHECKPOINT_LIMIT = 3;
/** Number of files printed in the bar-block card. */
const BAR_BLOCK_FILE_LIMIT = 8;

/**
 * Entry point for `story sessions info <prefix>`.
 *
 * Go: `sessions.go: runSessionInfo`.
 */
export async function handleSessionsInfo(args: readonly string[]): Promise<void> {
	if (args.length === 0 || args[0] === undefined || args[0] === '') {
		throw new SilentError(
			new Error(
				'Missing argument: <session-id> | Usage: story sessions info <session-id> [--json]',
			),
		);
	}

	const repoRoot = await requireGitRepo();
	await requireEnabled(repoRoot);

	// Go: resolveSessionIDPrefix (prefix match)
	const fullId = await resolveSessionIdPrefix(args[0], repoRoot);
	const session = await getSession(fullId, repoRoot);

	// Pull per-checkpoint detail directly (the enriched session only carries
	// roll-up stats). Missing metadata branch → empty list; `getSession`
	// already succeeded so we know the session exists.
	const checkpoints = await safeListCheckpointsForSession(repoRoot, session.id);

	if (getGlobalFlags().json) {
		emitJson(session, checkpoints);
		return;
	}

	renderBarBlock(session, checkpoints);
}

function renderBarBlock(session: EnrichedSession, checkpoints: CheckpointInfo[]): void {
	header(`story sessions info ${session.id}`);
	barEmpty();

	step('Session');
	barLine(`${pad('id:', 11)} ${session.id}`);
	barLine(`${pad('status:', 11)} ${session.status}`);
	barLine(`${pad('agent:', 11)} ${session.agentType}${session.agentIsPreview ? ' (preview)' : ''}`);
	if (session.model !== undefined && session.model !== '') {
		barLine(`${pad('model:', 11)} ${session.model}`);
	}
	if (session.worktree !== '') {
		barLine(`${pad('worktree:', 11)} ${session.worktree}`);
	}
	if (session.branch !== undefined && session.branch !== '') {
		barLine(`${pad('branch:', 11)} ${session.branch}`);
	}
	barLine(`${pad('started:', 11)} ${formatTimeWithRelative(session.startedAt)}`);
	if (session.endedAt !== undefined) {
		const durationMs = new Date(session.endedAt).getTime() - new Date(session.startedAt).getTime();
		const durationSuffix = Number.isFinite(durationMs)
			? `  (${formatDuration(durationMs)} duration)`
			: '';
		barLine(`${pad('ended:', 11)} ${formatTimeNoRelative(session.endedAt)}${durationSuffix}`);
	} else {
		barLine(`${pad('ended:', 11)} —`);
	}
	barEmpty();

	step('Tokens');
	barLine(`${pad('input:', 11)} ${formatInt(session.tokens.input)}`);
	barLine(`${pad('output:', 11)} ${formatInt(session.tokens.output)}`);
	barLine(`${pad('turns:', 11)} ${formatInt(session.tokens.turns)}`);
	barEmpty();

	step(`Checkpoints (${session.checkpointCount})`);
	const shownCp = checkpoints.slice(0, BAR_BLOCK_CHECKPOINT_LIMIT);
	for (const cp of shownCp) {
		barLine(`${color.green('●')} ${cp.checkpointId}  ${relative(cp.createdAt)}`);
	}
	if (checkpoints.length > BAR_BLOCK_CHECKPOINT_LIMIT) {
		const more = checkpoints.length - BAR_BLOCK_CHECKPOINT_LIMIT;
		barLine(color.dim(`... (${more} more, run with --json for full list)`));
	}
	barEmpty();

	const files = uniqueFiles(checkpoints);
	step(`Files touched (${files.length})`);
	const shownFiles = files.slice(0, BAR_BLOCK_FILE_LIMIT);
	for (const f of shownFiles) {
		barLine(`${color.green('●')} ${f}`);
	}
	if (files.length > BAR_BLOCK_FILE_LIMIT) {
		const more = files.length - BAR_BLOCK_FILE_LIMIT;
		barLine(color.dim(`... (${more} more)`));
	}
	barEmpty();

	stepDone('OK');
	barEmpty();
	if (session.status === 'ended') {
		footer(color.dim(`Run 'story resume ${session.branch ?? ''}' to reopen this trail.`.trimEnd()));
	} else {
		footer(color.dim(`Run 'story explain --session ${session.id}' to unpack the trail.`));
	}
}

function emitJson(session: EnrichedSession, checkpoints: CheckpointInfo[]): void {
	const files = uniqueFiles(checkpoints);
	const payload = {
		id: session.id,
		status: session.status,
		agent: session.agentType,
		model: session.model,
		worktree: session.worktree,
		branch: session.branch ?? null,
		startedAt: session.startedAt,
		endedAt: session.endedAt ?? null,
		tokens: session.tokens,
		checkpoints: checkpoints.map((cp) => ({
			id: cp.checkpointId,
			at: cp.createdAt.toISOString(),
			checkpointsCount: cp.checkpointsCount,
			filesTouched: cp.filesTouched,
		})),
		filesTouched: files,
	};
	process.stdout.write(`${JSON.stringify(payload)}\n`);
}

async function safeListCheckpointsForSession(
	repoRoot: string,
	sessionId: string,
): Promise<CheckpointInfo[]> {
	try {
		const all = await listCheckpoints(repoRoot);
		return all
			.filter((cp) => cp.sessionId === sessionId)
			.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
	} catch {
		return [];
	}
}

function uniqueFiles(checkpoints: CheckpointInfo[]): string[] {
	const seen = new Set<string>();
	for (const cp of checkpoints) {
		for (const f of cp.filesTouched) {
			seen.add(f);
		}
	}
	return [...seen];
}

function pad(s: string, len: number): string {
	if (s.length >= len) {
		return color.dim(s);
	}
	return color.dim(s + ' '.repeat(len - s.length));
}

function formatTimeWithRelative(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) {
		return iso;
	}
	return `${formatLocal(d)}  (${relative(d)})`;
}

function formatTimeNoRelative(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) {
		return iso;
	}
	return formatLocal(d);
}

function formatLocal(d: Date): string {
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(
		d.getHours(),
	)}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function pad2(n: number): string {
	return n < 10 ? `0${n}` : String(n);
}

function relative(d: Date): string {
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

function formatDuration(ms: number): string {
	if (ms < 0) {
		return '0s';
	}
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 60) {
		return `${minutes}m`;
	}
	const hours = Math.floor(minutes / 60);
	const remMin = minutes % 60;
	if (remMin === 0) {
		return `${hours}h`;
	}
	return `${hours}h ${remMin}m`;
}

function formatInt(n: number): string {
	return n.toLocaleString('en-US');
}

async function requireGitRepo(): Promise<string> {
	try {
		return await worktreeRoot(process.cwd());
	} catch {
		throw new SilentError(new Error('Not a git repository'));
	}
}

async function requireEnabled(repoRoot: string): Promise<void> {
	if (!(await isSetUpAny(repoRoot))) {
		throw new SilentError(new Error("Story is not enabled. Run 'story enable' to set it up."));
	}
	if (!(await isEnabled(repoRoot))) {
		throw new SilentError(new Error("Story is not enabled. Run 'story enable' to set it up."));
	}
}
