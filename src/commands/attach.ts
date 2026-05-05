/**
 * `story attach <session-id>` — manually attach an existing agent
 * session to HEAD via `git commit --amend` + Story trailers.
 *
 * Mirrors Go `cmd/entire/cli/attach.go: newAttachCmd` (453-line CLI
 * shell + `attach_transcript.go` 56-line transcript metadata reader).
 *
 * Scope: this MVP port covers the git-plumbing side (clean-worktree
 * check → existing-trailer guard → confirm → `git commit --amend
 * --trailer`) + session-state write. The transcript → metadata-branch
 * write path is covered by Phase 5.3/5.4 test harnesses; here we update
 * session state with the fresh checkpoint id and DEFER the full
 * WriteCommitted call to match `attach.go:160-200` only when the
 * Phase-4.3 writer equivalence is wired (blocked by
 * `ai-elements`-style read-side which is not on 9.4's critical path).
 *
 * @packageDocumentation
 */

import type { CAC } from 'cac';
import * as registry from '@/agent/registry';
import { applyGlobalFlags, getGlobalFlags } from '@/cli/flags';
import { getRootSignal } from '@/cli/runtime';
import { resolveSessionIdPrefix } from '@/commands/_shared/session-list';
import { SilentError } from '@/errors';
import { execGit } from '@/git';
import { generate as generateCheckpointId } from '@/id';
import { worktreeRoot } from '@/paths';
import { isEnabled, isSetUpAny } from '@/settings/settings';
import { loadSessionState, saveSessionState } from '@/strategy/session-state';
import { parseCheckpoint } from '@/trailers';
import {
	barEmpty,
	barLine,
	confirm,
	footer,
	header,
	note,
	step,
	stepDone,
	warn,
	withSpinner,
} from '@/ui';
import { color } from '@/ui/theme';

/**
 * Register `story attach <session-id>` on a cac instance.
 *
 * Go: `attach.go: newAttachCmd`.
 *
 * @example
 * const cli = cac('story');
 * registerAttachCommand(cli);
 * // Now resolvable:
 * //   story attach sess_abc123
 * //   story attach sess_ab --agent Claude\ Code
 * //   story attach sess_abc123 --force --json
 *
 * // Side effects on the cac instance:
 * //   cli.commands  ← appends "attach <session-id>" with --force + --agent
 * //
 * // Unchanged: already-registered commands, flag state, process state
 * //            (no action runs until `cli.parse(argv)`).
 */
export function registerAttachCommand(cli: CAC): void {
	cli
		.command('attach <session-id>', 'Attach an existing agent session to HEAD')
		.option('-f, --force', 'Skip amend confirm; overwrite existing Story-Checkpoint trailer')
		.option('-a, --agent <name>', 'Agent name (auto-detected if omitted)')
		.action(async (sessionIdArg: string, rawFlags: Record<string, unknown>): Promise<void> => {
			applyGlobalFlags(rawFlags);
			const force = rawFlags.force === true;
			const agentFlag = typeof rawFlags.agent === 'string' ? rawFlags.agent.trim() : '';

			if (!sessionIdArg || sessionIdArg.trim() === '') {
				throw new SilentError(new Error('Usage: story attach <session-id>'));
			}

			const repoRoot = await requireGitRepo();
			if (!(await isReady(repoRoot))) {
				return;
			}
			await runAttach(repoRoot, sessionIdArg.trim(), { force, agent: agentFlag });
		});
}

/**
 * Attach pipeline. See [`attach.go:76 runAttach`](entire-cli/cmd/entire/cli/attach.go).
 *
 * 10-step flow:
 *   1. resolveSessionIdPrefix → full id
 *   2. load session state (optional — may be null for "research session")
 *   3. resolve agent (opts.agent > state.agentType > registry.detectAll)
 *   4. `git status --porcelain` → dirty → SilentError (even with --force)
 *   5. read HEAD commit message; look for existing Story-Checkpoint trailer
 *   6. unless --force, existing trailer → SilentError
 *   7. warn block ("This will run git commit --amend") + confirm (unless --force)
 *   8. generate fresh checkpoint id
 *   9. git commit --amend with 3 Story trailers
 *  10. update session state + print summary
 *
 * @example
 * await runAttach('/repo', 'sess-abc', { force: false, agent: '' });
 *
 * // Side effects on happy path:
 * //   <repo>/.git/HEAD           ← rewritten (amend → new commit object)
 * //   <repo>/.git/logs/HEAD      ← reflog entry for amend
 * //   <repo>/.story/state/sess-abc.json  ← updated `lastCheckpointId`
 * //
 * // Unchanged: worktree, index, metadata branch (full transcript write
 * // happens via Phase 5.3 `condense` on next session end — amend just
 * // plants the trailer so the committer sees the checkpoint in-place).
 */
async function runAttach(
	repoRoot: string,
	sessionPrefix: string,
	opts: { force: boolean; agent: string },
): Promise<void> {
	const flags = getGlobalFlags();
	const json = flags.json;
	if (!json) {
		header(`story attach ${sessionPrefix}`);
		barEmpty();
		step('Looking up session');
	}

	// Step 1: resolve prefix to full session ID.
	const sessionId = await resolveSessionIdPrefix(sessionPrefix, repoRoot);

	// Step 2: load session state (may be null).
	const state = await loadSessionState(repoRoot, sessionId).catch(() => null);

	// Step 3: agent resolution.
	const agent = await resolveAgent(repoRoot, opts.agent, state);

	if (!json) {
		barLine(`${color.dim('session')}   ${sessionId}`);
		barLine(`${color.dim('agent')}     ${agent}`);
		barEmpty();
	}

	// Step 4: dirty worktree (always enforced, even with --force).
	const porcelain = (await execGit(['status', '--porcelain'], { cwd: repoRoot })).trim();
	if (porcelain !== '') {
		throw new SilentError(
			new Error(
				`Working tree has uncommitted changes. Commit or stash them before attaching (--force does NOT override this guard).`,
			),
		);
	}

	// Step 5: read HEAD commit message.
	let headMsg: string;
	try {
		headMsg = await execGit(['log', '-1', '--format=%B', 'HEAD'], { cwd: repoRoot });
	} catch (e) {
		throw new SilentError(
			new Error(
				`failed to read HEAD commit message: ${(e as Error).message}. This often means the branch has no commits yet.`,
			),
		);
	}
	const existingCheckpoint = parseCheckpoint(headMsg);

	// Step 6: guard against existing trailer unless --force.
	if (existingCheckpoint !== null && !opts.force) {
		throw new SilentError(
			new Error(
				`HEAD already has Story-Checkpoint trailer: ${existingCheckpoint}. Pass --force to overwrite, or rewind to its checkpoint.`,
			),
		);
	}

	// Step 7: amend warn + confirm.
	if (!opts.force && !json) {
		note('About to amend HEAD', [
			"This runs 'git commit --amend' to add 3 Story trailers:",
			'  Story-Checkpoint: <id>',
			'  Story-Session:    <id>',
			`  Story-Agent:      ${agent}`,
			'',
			'HEAD will become a new commit (new SHA). Safe on pushed commits',
			'only when you are solely responsible for this branch.',
		]);
		barEmpty();
		const ok = await confirm({
			message: 'Amend HEAD now?',
			yesDefault: false,
			signal: getRootSignal(),
		});
		if (!ok) {
			throw new SilentError(new Error('cancelled'));
		}
	}

	// Step 8: generate checkpoint id (unless overwriting — reuse existing).
	const checkpointId = existingCheckpoint ?? generateCheckpointId();

	// Step 9: amend via git commit --amend --trailer.
	await withSpinner('Amending HEAD with Story trailers', async () => {
		await execGit(
			[
				'commit',
				'--amend',
				'--no-edit',
				'--trailer',
				`Story-Checkpoint: ${checkpointId}`,
				'--trailer',
				`Story-Session: ${sessionId}`,
				'--trailer',
				`Story-Agent: ${agent}`,
			],
			{ cwd: repoRoot },
		);
	});

	// Capture new HEAD sha (post-amend) for output.
	const newHead = (await execGit(['rev-parse', 'HEAD'], { cwd: repoRoot })).trim();

	// DEFER(phase-4.x): write redacted transcript to metadata branch (Go `attach.go: runAttach` calls WriteCommitted).
	// blocked-by: Phase 4.x NewFetchingTree TS equivalent (port `entire-cli/.../checkpoint/fetching-tree.go`) + transcript redact chain wiring.
	// Story ships amend-only for now — Phase 5.3 condense on the next session
	// end fills the transcript side of the metadata branch tree so
	// `story explain -c <id>` eventually shows the full transcript. The
	// amend trailer is the minimum committed-checkpoint signal users need
	// to navigate via `rewind` / `explain`. See
	// [phase-9.4 impl.md §7](docs/ts-rewrite/impl/phase-9-commands/phase-9.4-explain-resume/impl.md)
	// for the tracking entry.

	// Step 10: update session state with the new checkpoint id. saveSessionState's
	// TS signature takes (state, cwd?) — state first, cwd second.
	if (state !== null) {
		try {
			await saveSessionState(
				{
					...state,
					lastCheckpointId: checkpointId,
				},
				repoRoot,
			);
		} catch (e) {
			warn(`failed to update session state: ${(e as Error).message}`);
		}
	}

	if (json) {
		process.stdout.write(
			`${JSON.stringify({
				attached: {
					sessionId,
					agent,
					checkpoint: checkpointId,
					head: newHead.slice(0, 7),
				},
			})}\n`,
		);
		return;
	}

	stepDone(`Session ${sessionId} attached`);
	barEmpty();
	footer(color.dim(`Run 'story explain -c ${checkpointId}' for details.`));
}

/**
 * Resolve the agent name from three sources, in order of precedence:
 *   1. explicit `--agent` flag
 *   2. session state's `agentType` field
 *   3. `registry.detectAll(...)` auto-detection → single match or
 *      SilentError when 0 / >1 match
 *
 * @internal
 */
async function resolveAgent(
	_repoRoot: string,
	agentFlag: string,
	state: { agentType?: string } | null,
): Promise<string> {
	if (agentFlag !== '') {
		return agentFlag;
	}
	if (state?.agentType && state.agentType !== '') {
		return state.agentType;
	}
	const detected = await registry.detectAll(getRootSignal());
	if (detected.length === 0) {
		throw new SilentError(
			new Error(`could not auto-detect agent for this session. Pass --agent <name> explicitly.`),
		);
	}
	if (detected.length > 1) {
		throw new SilentError(
			new Error(
				`ambiguous agent (multiple detected: ${detected.map((a) => a.name()).join(', ')}). Pass --agent <name> to disambiguate.`,
			),
		);
	}
	const first = detected[0];
	if (first === undefined) {
		throw new SilentError(new Error('agent detection returned empty after length check'));
	}
	return first.name();
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
		header('story attach');
		barEmpty();
		barLine(`${color.dim('○')} Story is not enabled in this repository.`);
		barEmpty();
		footer(color.dim("Run 'story enable' to set it up."));
		return false;
	}
	if (!(await isEnabled(repoRoot))) {
		header('story attach');
		barEmpty();
		barLine(`${color.dim('○')} Story settings have 'enabled: false'.`);
		barEmpty();
		footer(color.dim("Run 'story configure' to re-enable."));
		return false;
	}
	return true;
}
