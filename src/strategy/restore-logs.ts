/**
 * `restoreLogsOnlyImpl` + 5 helpers wired to the Phase 6.1 agent registry.
 *
 * Reads transcripts from the metadata branch and writes them back to each
 * agent's session directory (no worktree changes). Phase 6.1 Part 2 wires
 * agent dispatch through {@link registry.getByAgentType} (5.5 callsites
 * `agentDispatch.resolve` → `registry.getByAgentType`).
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/strategy/manual_commit_rewind.go`
 * (`RestoreLogsOnly` / `classifySessionsForRestore` / `ClassifyTimestamps` /
 * `StatusToText` / `PromptOverwriteNewerLogs` / `ResolveAgentForRewind` /
 * `SessionRestoreInfo` struct + `SessionRestoreStatus` const block).
 *
 * @packageDocumentation
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { match } from 'ts-pattern';
import type { Awaitable } from '../agent/interfaces';
import * as registry from '../agent/registry';
import { normalize } from '../agent/types';
import { resolveCommittedReader } from '../checkpoint/committed-reader-resolve';
import { ErrNoTranscript } from '../checkpoint/temporary';
import type { CheckpointSummary, CommittedReader, SessionContent } from '../checkpoint/types';
import { type CheckpointID, isEmpty as isEmptyCheckpointId } from '../id';
import { getLastTimestampFromBytes, getLastTimestampFromFile, worktreeRoot } from '../paths';
import { isCheckpointsV2Enabled, readSettings } from '../settings/settings';
import { askYesNoTTY } from './hooks-tty';
import type { ManualCommitStrategy } from './manual-commit';
import { extractFirstPrompt } from './prompts';
import type { AgentType, RestoredSession, RewindPoint } from './types';

/**
 * Status of a session being restored. Mirrors Go
 * `manual_commit_rewind.go: SessionRestoreStatus`.
 */
export type SessionRestoreStatus = 'new' | 'unchanged' | 'checkpoint-newer' | 'local-newer';

/**
 * Per-session info gathered for the "newer local logs" prompt. Mirrors Go
 * `manual_commit_rewind.go: SessionRestoreInfo`.
 */
export interface SessionRestoreInfo {
	sessionId: string;
	/** First prompt preview for display. */
	prompt: string;
	status: SessionRestoreStatus;
	/** Last entry timestamp from the local agent session file (null when missing). */
	localTime: Date | null;
	/** Last entry timestamp from the checkpoint transcript (null when missing). */
	checkpointTime: Date | null;
}

/**
 * Minimum agent surface used by the restore flow. Phase 6.1 Part 2:
 * {@link resolveAgentForRewind} now returns `RewindAgent | null` (was
 * `unknown` in 5.5) and the production resolver dispatches via
 * `registry.getByAgentType` — registered Agent instances satisfy this
 * surface at runtime (the cast in `resolveAgentForRewind` is safe).
 *
 * The `writeSession` payload carries `agentName` to mirror Go's
 * `agent.AgentSession{AgentName: sessionAgent.Name(), ...}` (`manual_commit_rewind.go: RestoreLogsOnly`).
 *
 * @internal
 */
interface RewindAgent {
	getSessionDir(repoRoot: string): Promise<string>;
	resolveSessionFile(sessionDir: string, sessionId: string): Awaitable<string>;
	resolveRestoredSessionFile?: (
		sessionDir: string,
		sessionId: string,
		transcript: Uint8Array,
	) => Promise<string>;
	writeSession(input: {
		sessionId: string;
		agentName: string;
		repoRoot: string;
		sessionRef: string;
		nativeData: Uint8Array;
	}): Promise<void>;
	type(): AgentType;
	name(): string;
}

/**
 * Implements the `restore-logs-only` action: read transcripts from the
 * metadata branch and write them back to each agent's session directory.
 * Working directory is not modified.
 *
 * Mirrors Go `manual_commit_rewind.go: RestoreLogsOnly`.
 *
 * 7-step pipeline:
 *   1. validate `point.isLogsOnly` + `point.checkpointId` non-empty
 *   2. resolve committed reader (v2 first when enabled, fall back to v1)
 *   3. when `force=false` → {@link classifySessionsForRestore} + maybe TTY prompt
 *   4. count `totalSessions`; print "Restoring N sessions..." header when > 1
 *   5. loop sessions: read content → resolve agent (registry dispatch) → write
 *   6. best-effort: warn + continue per session; throw only when single-session write fails
 *   7. return {@link RestoredSession}[]
 *
 * **`force=true`**: skips the classify + prompt steps and goes straight to
 * the write loop. Used by `story resume --force`.
 *
 * Phase 6.1 Part 2 wired the 4 agent-registry call sites
 * (`resolveAgentForRewind`, `agent.getSessionDir`, `agent.resolveSessionFile`
 * + optional `RestoredSessionPathResolver`, `agent.writeSession`). Sessions
 * with unknown agents emit a warning + skip; sessions with registered agents
 * follow the full write pipeline.
 *
 * @example
 * ```ts
 * await restoreLogsOnlyImpl(strategy, process.stdout, process.stderr, point, false);
 * // returns: RestoredSession[]   (one per successfully restored session)
 *
 * // Side effects (when agent registry available, Phase 6.1+):
 * //   <agent-session-dir>/<sessionId>.<ext>      ← transcript via agent.writeSession
 * //   stdout                                       ← per-session 'Writing transcript to: <path>'
 * //   stderr                                       ← warn for skipped sessions (Phase 5.5: agent unavailable)
 * //
 * // Worktree / git refs / HEAD: unchanged.
 * ```
 */
export async function restoreLogsOnlyImpl(
	s: ManualCommitStrategy,
	out: NodeJS.WritableStream,
	err: NodeJS.WritableStream,
	point: RewindPoint,
	force: boolean,
): Promise<RestoredSession[]> {
	if (!point.isLogsOnly) {
		throw new Error('not a logs-only rewind point');
	}
	if (isEmptyCheckpointId(point.checkpointId)) {
		throw new Error('missing checkpoint ID');
	}

	const repo = await s.getRepo();

	const v1Store = await s.getCheckpointStore();
	const settings = await readSettings(repo.root);
	const preferV2 = isCheckpointsV2Enabled(settings);
	const v2Store = preferV2 ? await s.getV2CheckpointStore() : null;
	const { reader, summary } = await resolveCommittedReader(
		null,
		point.checkpointId,
		v1Store,
		v2Store,
		preferV2,
	);
	if (summary === null) {
		throw new Error(`checkpoint not found: ${point.checkpointId}`);
	}

	const repoRoot = await worktreeRoot(repo.root);

	if (!force) {
		const sessions = await classifySessionsForRestore(
			s,
			repoRoot,
			reader,
			point.checkpointId,
			summary,
		);
		const hasConflicts = sessions.some((sess) => sess.status === 'local-newer');
		if (hasConflicts) {
			const overwrite = await promptDispatch.prompt(err, sessions);
			if (!overwrite) {
				out.write('Resume cancelled. Local session logs preserved.\n');
				return [];
			}
		}
	}

	const totalSessions = summary.sessions.length;
	if (totalSessions > 1) {
		out.write(`Restoring ${totalSessions} sessions from checkpoint:\n`);
	}

	const restored: RestoredSession[] = [];
	for (let i = 0; i < totalSessions; i++) {
		let content: SessionContent | null;
		try {
			content = await reader.readSessionContent(point.checkpointId, i);
		} catch (e) {
			if (e instanceof ErrNoTranscript) {
				continue;
			}
			err.write(`  Warning: failed to read session ${i}: ${(e as Error).message}\n`);
			continue;
		}
		if (content === null || content.transcript.length === 0) {
			continue;
		}

		const sessionId = content.metadata.sessionId;
		if (sessionId === '') {
			err.write(`  Warning: session ${i} has no session ID, skipping\n`);
			continue;
		}
		const agentType = content.metadata.agent ?? '';
		if (agentType === '') {
			err.write(
				`  Warning: session ${i} (${sessionId}) has no agent metadata, ` +
					'skipping (cannot determine target directory)\n',
			);
			continue;
		}

		// Phase 6.1 Part 2: agent dispatch via registry.getByAgentType
		// (wrapped in agentDispatch.resolve for test override). Returns
		// `null` for unknown agents — replaces the Phase 5.5 try/catch
		// stub that threw on every call.
		const sessionAgent = (await agentDispatch.resolve(normalize(agentType))) as RewindAgent | null;
		if (sessionAgent === null) {
			err.write(
				`  Warning: session ${i} (${sessionId}) has unknown agent ` +
					`${JSON.stringify(agentType)}, skipping\n`,
			);
			continue;
		}

		let sessionAgentDir: string;
		try {
			sessionAgentDir = await sessionAgent.getSessionDir(repoRoot);
		} catch (e) {
			err.write(`  Warning: failed to get session dir for session ${i}: ${(e as Error).message}\n`);
			continue;
		}

		let sessionFile = await sessionAgent.resolveSessionFile(sessionAgentDir, sessionId);
		if (sessionAgent.resolveRestoredSessionFile !== undefined) {
			try {
				sessionFile = await sessionAgent.resolveRestoredSessionFile(
					sessionAgentDir,
					sessionId,
					content.transcript,
				);
			} catch (e) {
				err.write(
					`  Warning: failed to resolve restored session path for session ${i} (${sessionId}): ` +
						`${(e as Error).message} (using fallback path)\n`,
				);
			}
		}

		const promptPreview = extractFirstPrompt(content.prompts);

		if (totalSessions > 1) {
			const isLatest = i === totalSessions - 1;
			if (promptPreview !== '') {
				if (isLatest) {
					out.write(`  Session ${i + 1} (latest): ${promptPreview}\n`);
				} else {
					out.write(`  Session ${i + 1}: ${promptPreview}\n`);
				}
			}
			out.write(`    Writing to: ${sessionFile}\n`);
		} else {
			out.write(`Writing transcript to: ${sessionFile}\n`);
		}

		try {
			await fs.mkdir(path.dirname(sessionFile), { recursive: true, mode: 0o750 });
		} catch (e) {
			err.write(`    Warning: failed to create directory: ${(e as Error).message}\n`);
			continue;
		}

		try {
			await sessionAgent.writeSession({
				sessionId,
				agentName: sessionAgent.name(),
				repoRoot,
				sessionRef: sessionFile,
				nativeData: content.transcript,
			});
		} catch (writeErr) {
			if (totalSessions > 1) {
				err.write(`    Warning: failed to write session: ${(writeErr as Error).message}\n`);
				continue;
			}
			throw new Error(`failed to write session: ${(writeErr as Error).message}`, {
				cause: writeErr as Error,
			});
		}

		restored.push({
			sessionId,
			agent: agentType as AgentType,
			prompt: promptPreview,
			createdAt: new Date(content.metadata.createdAt),
		});
	}

	return restored;
}

/**
 * Classify all sessions in a checkpoint by comparing local agent session
 * file timestamps against checkpoint transcript timestamps. Returns one
 * {@link SessionRestoreInfo} per resolvable session; sessions with
 * missing metadata or unresolvable agent are silently skipped (matches
 * Go behavior — the prompt's purpose is to surface the conflict, not to
 * audit every session).
 *
 * Mirrors Go `manual_commit_rewind.go: classifySessionsForRestore`.
 *
 * @example
 * ```ts
 * await classifySessionsForRestore(strategy, repoRoot, reader, cpId, summary);
 * // returns: SessionRestoreInfo[]   (one per resolvable session)
 *
 * // Side effects: read-only — reader.readSessionContent + agent.getSessionDir +
 * //   getLastTimestampFromFile + getLastTimestampFromBytes.
 * ```
 */
export async function classifySessionsForRestore(
	s: ManualCommitStrategy,
	repoRoot: string,
	reader: CommittedReader,
	checkpointId: CheckpointID,
	summary: CheckpointSummary,
): Promise<SessionRestoreInfo[]> {
	void s;
	const out: SessionRestoreInfo[] = [];
	for (let i = 0; i < summary.sessions.length; i++) {
		let content: SessionContent | null;
		try {
			content = await reader.readSessionContent(checkpointId, i);
		} catch {
			continue;
		}
		if (content === null || content.transcript.length === 0) {
			continue;
		}
		const sessionId = content.metadata.sessionId;
		const agentType = content.metadata.agent ?? '';
		if (sessionId === '' || agentType === '') {
			continue;
		}
		// Phase 6.1 Part 2: agent dispatch — null for unknown agents.
		const sessionAgent = (await agentDispatch.resolve(normalize(agentType))) as RewindAgent | null;
		if (sessionAgent === null) {
			continue;
		}
		let sessionAgentDir: string;
		try {
			sessionAgentDir = await sessionAgent.getSessionDir(repoRoot);
		} catch {
			continue;
		}
		const localPath = await sessionAgent.resolveSessionFile(sessionAgentDir, sessionId);
		const localTime = await getLastTimestampFromFile(localPath);
		const checkpointTime = getLastTimestampFromBytes(content.transcript);
		out.push({
			sessionId,
			prompt: extractFirstPrompt(content.prompts),
			status: classifyTimestamps(localTime, checkpointTime),
			localTime,
			checkpointTime,
		});
	}
	return out;
}

/**
 * Determine restore status from local + checkpoint timestamps. 4-tuple
 * outcome — see Go `manual_commit_rewind.go: ClassifyTimestamps`.
 *
 * @example
 * ```ts
 * classifyTimestamps(null, new Date('2026-04-15'));                         // 'new'
 * classifyTimestamps(new Date('2026-04-15'), new Date('2026-04-15'));       // 'unchanged'
 * classifyTimestamps(new Date('2026-04-15'), new Date('2026-04-16'));       // 'checkpoint-newer'
 * classifyTimestamps(new Date('2026-04-16'), new Date('2026-04-15'));       // 'local-newer'
 * classifyTimestamps(new Date('2026-04-15'), null);                         // 'new'  (treat as safe)
 * ```
 */
export function classifyTimestamps(
	localTime: Date | null,
	checkpointTime: Date | null,
): SessionRestoreStatus {
	if (localTime === null) {
		return 'new';
	}
	if (checkpointTime === null) {
		return 'new';
	}
	const lt = localTime.getTime();
	const ct = checkpointTime.getTime();
	if (lt > ct) {
		return 'local-newer';
	}
	if (ct > lt) {
		return 'checkpoint-newer';
	}
	return 'unchanged';
}

/**
 * Human-readable label for a {@link SessionRestoreStatus}. Mirrors Go
 * `manual_commit_rewind.go: StatusToText`. Implemented via
 * `ts-pattern.match()` per the project convention (no `switch/case`).
 *
 * @example
 * ```ts
 * statusToText('new');               // '(new)'
 * statusToText('unchanged');         // '(unchanged)'
 * statusToText('checkpoint-newer');  // '(checkpoint is newer)'
 * statusToText('local-newer');       // '(local is newer)'
 * ```
 */
export function statusToText(status: SessionRestoreStatus): string {
	return match(status)
		.with('new', () => '(new)')
		.with('unchanged', () => '(unchanged)')
		.with('checkpoint-newer', () => '(checkpoint is newer)')
		.with('local-newer', () => '(local is newer)')
		.exhaustive();
}

/**
 * TTY prompt: "Local session log(s) have newer entries than the
 * checkpoint — overwrite?". Returns `true` when the user confirms
 * overwrite, `false` otherwise (including no-TTY default and abort).
 *
 * Mirrors Go `manual_commit_rewind.go: PromptOverwriteNewerLogs` which
 * uses `huh.NewConfirm()` — strict binary Y/n confirmation, no third
 * "always" option. Story TS uses {@link askYesNoTTY} (binary sibling of
 * `askConfirmTTY`) so user typing `a` doesn't get surprising silent
 * cancellation. Test mode (`STORY_TEST_TTY` env var) returns `false`
 * (matches Go default-confirmed=false).
 *
 * @example
 * ```ts
 * await promptOverwriteNewerLogs(process.stderr, sessions);
 * // returns: true  (user typed Y)  | false (user typed N / aborted / no-TTY default)
 *
 * // Side effects:
 * //   <errW>          ← writes warning lines + per-session conflict summary
 * //   /dev/tty        ← only when hasTTY() and not in STORY_TEST_TTY mode
 * ```
 */
export async function promptOverwriteNewerLogs(
	errW: NodeJS.WritableStream,
	sessions: readonly SessionRestoreInfo[],
): Promise<boolean> {
	const conflicting = sessions.filter((sess) => sess.status === 'local-newer');
	const nonConflicting = sessions.filter((sess) => sess.status !== 'local-newer');

	errW.write('\nWarning: Local session log(s) have newer entries than the checkpoint:\n');
	for (const info of conflicting) {
		if (info.prompt !== '') {
			errW.write(`  "${info.prompt}"\n`);
		} else {
			errW.write(`  Session: ${info.sessionId}\n`);
		}
		errW.write(`    Local last entry:      ${formatLocal(info.localTime)}\n`);
		errW.write(`    Checkpoint last entry: ${formatLocal(info.checkpointTime)}\n`);
	}
	if (nonConflicting.length > 0) {
		errW.write('\nThese other session(s) will also be restored:\n');
		for (const info of nonConflicting) {
			const label = statusToText(info.status);
			if (info.prompt !== '') {
				errW.write(`  "${info.prompt}" ${label}\n`);
			} else {
				errW.write(`  Session: ${info.sessionId} ${label}\n`);
			}
		}
	}
	errW.write('\nOverwriting will lose the newer local entries.\n\n');

	return askYesNoTTY('Overwrite local session logs with checkpoint versions?', false);
}

/**
 * Resolve an agent type string from checkpoint metadata to an `Agent`
 * instance. Throws on empty or unknown type.
 *
 * Mirrors Go `manual_commit_rewind.go: ResolveAgentForRewind`.
 *
 * Phase 6.1 Part 2: dispatches to {@link registry.getByAgentType}. Returns
 * `null` for unknown agents (Go: `agent.GetByAgentType` semantics). Callers
 * ({@link restoreLogsOnlyImpl} + {@link classifySessionsForRestore}) check the
 * `null` return and emit a warning + skip.
 *
 * **Story-side `''` early throw preserved** from Phase 5.5: callers may pass
 * `'' as AgentType` to signal "no agent metadata"; we throw early so the test
 * harness can assert against this contract. Go has no equivalent — its
 * `agent.GetByAgentType("")` would return nil silently — but Phase 5.5 tests
 * codified the throw-on-empty behavior and we keep it.
 *
 * **Test override note**: Internal callers reach this through
 * {@link agentDispatch} (a module-level namespace) so vitest tests can swap
 * the resolver in via `setAgentResolverForTesting(...)`.
 *
 * @example
 * ```ts
 * await resolveAgentForRewind('Vogon Agent');
 * // returns: VogonAgent  (registry hit)
 *
 * await resolveAgentForRewind('Nonexistent Agent');
 * // returns: null  (registry miss)
 *
 * await resolveAgentForRewind('');
 * // throws: Error('agent type is empty')   (Story-side early-throw contract)
 * ```
 */
export async function resolveAgentForRewind(agentType: AgentType): Promise<RewindAgent | null> {
	// Story-side early throw — see JSDoc above for rationale.
	if ((agentType as string) === '') {
		throw new Error('agent type is empty');
	}
	const ag = registry.getByAgentType(agentType);
	if (ag === null) {
		return null;
	}
	// Agent satisfies RewindAgent if it implements all the methods callers
	// invoke (getSessionDir / resolveSessionFile / writeSession / name); the
	// base Agent interface guarantees these so the cast is safe at runtime.
	return ag as unknown as RewindAgent;
}

/**
 * Module-level dispatch namespace so internal callers
 * ({@link restoreLogsOnlyImpl}, {@link classifySessionsForRestore}) can be
 * intercepted by tests. Production code goes through
 * {@link resolveAgentForRewind}; tests override via
 * {@link setAgentResolverForTesting}.
 *
 * @internal
 */
const agentDispatch: {
	resolve: (agentType: AgentType) => Promise<RewindAgent | null>;
} = {
	resolve: resolveAgentForRewind,
};

/**
 * Test override hook: replace the agent resolver used by
 * {@link restoreLogsOnlyImpl} and {@link classifySessionsForRestore} for
 * the duration of a test. Pass `null` to restore the production resolver
 * ({@link resolveAgentForRewind}).
 *
 * Phase 6.1 Part 2 narrowed the resolver return type from `Promise<unknown>`
 * to `Promise<RewindAgent | null>`; tests that mock by returning a
 * RewindAgent are forwards-compatible. Tests that previously mocked by
 * throwing (to simulate "agent unknown") should switch to returning `null`.
 *
 * Mirrors the Phase 5.4 `setStderrWriterForTesting` pattern from
 * [`./hooks-tty.ts`](./hooks-tty.ts).
 *
 * @example
 * ```ts
 * setAgentResolverForTesting(async (type) => fakeAgent);
 * setAgentResolverForTesting(async () => null);   // simulate registry miss
 * setAgentResolverForTesting(null);               // restore production
 * ```
 */
export function setAgentResolverForTesting(
	resolver: ((agentType: AgentType) => Promise<RewindAgent | null>) | null,
): void {
	agentDispatch.resolve = resolver ?? resolveAgentForRewind;
}

/**
 * Module-level dispatch namespace for the TTY confirmation prompt so tests
 * can swap it out without intercepting an internal call. Production code
 * uses {@link promptOverwriteNewerLogs}; tests override via
 * {@link setPromptOverwriteForTesting}.
 *
 * @internal
 */
const promptDispatch: {
	prompt: (
		errW: NodeJS.WritableStream,
		sessions: readonly SessionRestoreInfo[],
	) => Promise<boolean>;
} = {
	prompt: (errW, sessions) => promptOverwriteNewerLogs(errW, sessions),
};

/**
 * Test override hook: replace the TTY prompt used by
 * {@link restoreLogsOnlyImpl} for the duration of a test. Pass `null` to
 * restore the default {@link promptOverwriteNewerLogs}.
 */
export function setPromptOverwriteForTesting(
	prompt:
		| ((errW: NodeJS.WritableStream, sessions: readonly SessionRestoreInfo[]) => Promise<boolean>)
		| null,
): void {
	promptDispatch.prompt = prompt ?? ((errW, sessions) => promptOverwriteNewerLogs(errW, sessions));
}

/**
 * Format a Date as 'YYYY-MM-DD HH:MM:SS' in local timezone. Mirrors Go
 * `time.Local().Format("2006-01-02 15:04:05")`.
 *
 * @internal
 */
function formatLocal(d: Date | null): string {
	if (d === null) {
		return '<unknown>';
	}
	const pad = (n: number): string => String(n).padStart(2, '0');
	return (
		`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
		`${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
	);
}
