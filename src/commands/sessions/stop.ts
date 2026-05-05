/**
 * `story sessions stop [session-id]` — mark session(s) as ended. Writes
 * state only; never deletes checkpoints, transcripts, or shadow
 * branches.
 *
 * Go: `cmd/entire/cli/sessions.go: newStopCmd` / `runStop` /
 * `runStopSession` / `runStopAll` / `runStopMultiSelect` /
 * `stopSelectedSessions` / `stopSessionAndPrint` +
 * `cmd/entire/cli/lifecycle.go: markSessionEnded`.
 *
 * Story-side divergence from Go: partial failures under `--all` / `--all
 * --force` do NOT abort the batch — failed sessions are collected and
 * summarized, exit code flips to 1. Matches the CI "clean-slate"
 * expectation for `stop --all` (see `TS-divergences from Go` §7 in
 * [impl.md](../../../docs/ts-rewrite/impl/phase-9-commands/phase-9.2-status-sessions/impl.md)).
 *
 * @packageDocumentation
 */

import { getGlobalFlags } from '@/cli/flags';
import { getRootSignal } from '@/cli/runtime';
import type { EnrichedSession } from '@/commands/_shared/session-list';
import {
	findActiveSessions,
	getSession,
	markSessionEnded,
	resolveSessionIdPrefix,
} from '@/commands/_shared/session-list';
import { SilentError } from '@/errors';
import { worktreeRoot } from '@/paths';
import { isEnabled, isSetUpAny } from '@/settings/settings';
import { barEmpty, barLine, footer, header, step, stepDone, stepError, warn } from '@/ui';
import { confirm, select } from '@/ui/prompts';
import { color } from '@/ui/theme';

export interface SessionsStopFlags {
	readonly all?: boolean;
	readonly force?: boolean;
}

/**
 * Entry point for `story sessions stop`. Routing matrix (from
 * [impl.md §6](../../../docs/ts-rewrite/impl/phase-9-commands/phase-9.2-status-sessions/impl.md#6-srccommandssessionsstopts)):
 *
 *  | id?  | --all | --force | 0 active | 1 active | 2+ active | behavior |
 *  |------|-------|---------|----------|----------|-----------|----------|
 *  | yes  | yes   | any     | n/a      | n/a      | n/a       | mutex err |
 *  | yes  | no    | no      | n/a      | n/a      | n/a       | confirm + stop |
 *  | yes  | no    | yes     | n/a      | n/a      | n/a       | stop |
 *  | no   | yes   | no      | empty-state | confirm + loop | confirm + loop | |
 *  | no   | yes   | yes     | empty-state | loop | loop | |
 *  | no   | no    | any     | empty-state | confirm + stop | select + confirm + stop | |
 *
 * Go: `sessions.go: runStop` — mirrors the above table one-for-one.
 */
export async function handleSessionsStop(
	args: readonly string[],
	rawFlags: Record<string, unknown> = {},
): Promise<void> {
	const flags = readFlags(rawFlags);
	const id = args[0];

	if (id !== undefined && id !== '' && flags.all) {
		throw new SilentError(
			new Error(
				'<session-id> and --all cannot be used together | Pick one: `story sessions stop <id>` or `story sessions stop --all`',
			),
		);
	}

	const repoRoot = await requireGitRepo();
	await requireEnabled(repoRoot);

	if (id !== undefined && id !== '') {
		await runStopSingle(repoRoot, id, flags);
		return;
	}
	if (flags.all) {
		await runStopAll(repoRoot, flags);
		return;
	}
	await runStopInteractive(repoRoot, flags);
}

interface StopFlags {
	readonly all: boolean;
	readonly force: boolean;
}

function readFlags(raw: Record<string, unknown>): StopFlags {
	return {
		all: raw.all === true,
		force: raw.force === true || raw.f === true,
	};
}

async function runStopSingle(repoRoot: string, prefix: string, flags: StopFlags): Promise<void> {
	const fullId = await resolveSessionIdPrefix(prefix, repoRoot);
	const session = await getSession(fullId, repoRoot);

	if (session.status !== 'active') {
		throw new SilentError(
			new Error(
				`Session ${session.id} is not active | Status: ${session.status}. Already-ended sessions cannot be stopped again.`,
			),
		);
	}

	if (!getGlobalFlags().json) {
		header(`story sessions stop ${session.id}`);
		barEmpty();
		renderSessionCard(session);
	}

	if (!flags.force) {
		const ok = await confirm({
			message: `Stop session ${session.id}?`,
			initialValue: false,
			yesDefault: false,
			signal: getRootSignal(),
		});
		if (!ok) {
			throw new SilentError(new Error('Cancelled'));
		}
	}

	const failures = await runMark([session.id], repoRoot);
	await emitResult([session.id], failures);
}

async function runStopAll(repoRoot: string, flags: StopFlags): Promise<void> {
	const active = await findActiveSessions(repoRoot);
	if (!getGlobalFlags().json) {
		header('story sessions stop --all');
		barEmpty();
	}
	if (active.length === 0) {
		if (!getGlobalFlags().json) {
			step(color.dim('○ No active sessions in this repository'));
			barLine('Nothing to stop.');
			barEmpty();
			footer(color.dim("Run 'story sessions list' to see ended sessions."));
		} else {
			emitJsonResult([], []);
		}
		return;
	}

	if (!getGlobalFlags().json) {
		step(`Active sessions (${active.length})`);
		for (const s of active) {
			barLine(`${color.green('●')} ${s.id}  ${color.dim(s.agentType)}`);
		}
		barEmpty();
		warn(`--all will stop ${active.length} active session${active.length === 1 ? '' : 's'}.`);
		barEmpty();
	}

	if (!flags.force) {
		const ok = await confirm({
			message: `Stop all ${active.length} active sessions?`,
			initialValue: false,
			yesDefault: false,
			signal: getRootSignal(),
		});
		if (!ok) {
			throw new SilentError(new Error('Cancelled'));
		}
	}

	const ids = active.map((s) => s.id);
	const failures = await runMark(ids, repoRoot);
	await emitResult(ids, failures);
}

async function runStopInteractive(repoRoot: string, flags: StopFlags): Promise<void> {
	const active = await findActiveSessions(repoRoot);

	if (!getGlobalFlags().json) {
		header('story sessions stop');
		barEmpty();
	}

	if (active.length === 0) {
		if (!getGlobalFlags().json) {
			step(color.dim('○ No active sessions'));
			barEmpty();
			footer(color.dim("Run 'story sessions list' to see ended sessions."));
		} else {
			emitJsonResult([], []);
		}
		return;
	}

	let target: EnrichedSession;
	if (active.length === 1) {
		target = active[0]!;
	} else {
		const choice = await select<string>({
			message: 'Which session to stop?',
			options: active.map((s) => ({
				value: s.id,
				label: `${s.id}  ${s.agentType}  (turns ${s.tokens.turns})`,
			})),
			signal: getRootSignal(),
		});
		const picked = active.find((s) => s.id === choice);
		if (picked === undefined) {
			throw new SilentError(new Error('Cancelled'));
		}
		target = picked;
	}

	if (!getGlobalFlags().json) {
		renderSessionCard(target);
	}

	if (!flags.force) {
		const ok = await confirm({
			message: `Stop session ${target.id}?`,
			initialValue: false,
			yesDefault: false,
			signal: getRootSignal(),
		});
		if (!ok) {
			throw new SilentError(new Error('Cancelled'));
		}
	}

	const failures = await runMark([target.id], repoRoot);
	await emitResult([target.id], failures);
}

interface StopFailure {
	readonly id: string;
	readonly error: string;
}

async function runMark(ids: readonly string[], repoRoot: string): Promise<StopFailure[]> {
	const failures: StopFailure[] = [];
	for (const id of ids) {
		try {
			await markSessionEnded(id, repoRoot);
		} catch (err) {
			failures.push({ id, error: err instanceof Error ? err.message : String(err) });
		}
	}
	return failures;
}

async function emitResult(ids: readonly string[], failures: readonly StopFailure[]): Promise<void> {
	const failedIds = new Set(failures.map((f) => f.id));
	const stopped = ids.filter((id) => !failedIds.has(id));

	if (getGlobalFlags().json) {
		emitJsonResult(stopped, failures);
	} else {
		renderResultBlock(ids, stopped, failures);
	}

	if (failures.length > 0) {
		process.exitCode = 1;
	}
}

function emitJsonResult(stopped: readonly string[], failures: readonly StopFailure[]): void {
	process.stdout.write(
		`${JSON.stringify({
			stopped,
			failed: failures.map((f) => ({ id: f.id, error: f.error })),
		})}\n`,
	);
}

function renderResultBlock(
	ids: readonly string[],
	stopped: readonly string[],
	failures: readonly StopFailure[],
): void {
	step('Marking session(s) ended');
	for (const id of ids) {
		if (failures.some((f) => f.id === id)) {
			const failure = failures.find((f) => f.id === id)!;
			stepError(`${id}: ${failure.error}`);
		} else {
			barLine(`${color.green('●')} ${id}: active → ended`);
		}
	}
	barEmpty();
	if (failures.length === 0) {
		if (stopped.length === 1) {
			stepDone(`Session ${stopped[0]} stopped`);
		} else {
			stepDone(`Stopped ${stopped.length} sessions`);
		}
	} else {
		stepError(`Stopped ${stopped.length} / ${ids.length} sessions, ${failures.length} failed`);
	}
	barEmpty();
	footer(color.dim("Run 'story sessions list' to verify."));
}

function renderSessionCard(s: EnrichedSession): void {
	step('Session');
	barLine(`  ${color.dim('id:')}      ${s.id}`);
	barLine(`  ${color.dim('agent:')}   ${s.agentType}`);
	if (s.model !== undefined && s.model !== '') {
		barLine(`  ${color.dim('model:')}   ${s.model}`);
	}
	barLine(`  ${color.dim('started:')} ${s.startedAt}`);
	barLine(`  ${color.dim('turns:')}   ${s.tokens.turns}`);
	barLine(`  ${color.dim('files:')}   ${s.filesChanged} touched`);
	barEmpty();
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
