/**
 * `story sessions list` — render all sessions (active + ended), newest first.
 *
 * Go: `cmd/entire/cli/sessions.go: newSessionsListCmd / runSessionList`.
 * Story's bar-block rendering diverges from Go's lipgloss card format —
 * the data fields are identical, we just use Phase 9.0 primitives to
 * match the rest of the Story CLI visual.
 *
 * @packageDocumentation
 */

import { getGlobalFlags } from '@/cli/flags';
import type { EnrichedSession } from '@/commands/_shared/session-list';
import { listSessions } from '@/commands/_shared/session-list';
import { SilentError } from '@/errors';
import { worktreeRoot } from '@/paths';
import { isEnabled, isSetUpAny } from '@/settings/settings';
import { barEmpty, barLine, footer, header, step, stepDone } from '@/ui';
import { color } from '@/ui/theme';

/**
 * Entry point for `story sessions list`. Called by the catch-all router
 * in {@link ../sessions.ts}; the `args` slice is currently unused (no
 * subcommand-specific positional args) but kept in the signature to
 * match the sibling handlers.
 *
 * Go: `sessions.go: runSessionList`.
 */
export async function handleSessionsList(_args: readonly string[]): Promise<void> {
	const repoRoot = await requireGitRepo();
	await requireEnabled(repoRoot);

	const sessions = await listSessions(repoRoot);

	if (getGlobalFlags().json) {
		emitJson(sessions);
		return;
	}

	renderBarBlock(repoRoot, sessions);
}

function renderBarBlock(repoRoot: string, sessions: readonly EnrichedSession[]): void {
	header('story sessions list');
	barEmpty();
	step('Repository');
	barLine(color.dim(repoRoot));
	barEmpty();

	step(`Sessions (${sessions.length})`);
	if (sessions.length === 0) {
		barLine(`${color.dim('○')} No sessions yet.`);
		barEmpty();
		footer(color.dim('Start an agent run; a session will be recorded on first commit.'));
		return;
	}

	barEmpty();
	for (const s of sessions) {
		const glyph = s.status === 'active' ? color.green('●') : color.dim('○');
		const agentSuffix = s.agentIsPreview ? ' (preview)' : '';
		barLine(`${glyph} ${s.id}  ${s.status}${agentSuffix}`);
		barLine(`  ${color.dim('agent:')}      ${s.agentType}`);
		barLine(`  ${color.dim('started:')}    ${formatTime(s.startedAt)}`);
		if (s.endedAt !== undefined) {
			barLine(`  ${color.dim('ended:')}      ${formatTime(s.endedAt)}`);
		}
		barLine(
			`  ${color.dim('files:')}      ${s.filesChanged}    ${color.dim('checkpoints:')} ${s.checkpointCount}`,
		);
		barEmpty();
	}

	const active = sessions.filter((s) => s.status === 'active').length;
	const ended = sessions.length - active;
	stepDone(`${sessions.length} sessions  (${active} active, ${ended} ended)`);
	barEmpty();
	footer(color.dim("Run 'story sessions info <id>' for details."));
}

function emitJson(sessions: readonly EnrichedSession[]): void {
	const payload = sessions.map((s) => ({
		id: s.id,
		agent: s.agentType,
		status: s.status,
		startedAt: s.startedAt,
		endedAt: s.endedAt ?? null,
		filesChanged: s.filesChanged,
		checkpointCount: s.checkpointCount,
	}));
	process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function formatTime(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) {
		return iso;
	}
	const local = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
		d.getHours(),
	)}:${pad(d.getMinutes())}`;
	return `${local}  (${relative(d)})`;
}

function pad(n: number): string {
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
