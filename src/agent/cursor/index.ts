/**
 * Cursor agent — Identity / detection / I/O / chunking / path helpers +
 * factory.
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/agent/cursor/cursor.go`
 * (`CursorAgent` struct + 16 method + `nonAlphanumericRegex` +
 * `sanitizePathForCursor` + `PrepareTranscript` 5s polling).
 *
 * **Registration**: handled by [`src/agent/bootstrap.ts:
 * registerBuiltinAgents()`](../bootstrap.ts), called from `src/cli.ts:
 * run()` at startup. This module exports the {@link cursorAgent} factory
 * only — no module-level side effects (see [`AGENTS.md`
 * §异步/模块边界](../../../AGENTS.md)).
 *
 * **Capabilities** (6 total — see Phase 6.3 module.md):
 * - `Agent` (mandatory identity + storage + session methods)
 * - `HookSupport` — methods delegate to `./hooks` and `./lifecycle`
 * - `TranscriptAnalyzer` (`getTranscriptPosition` /
 *   `extractModifiedFilesFromOffset`) — delegate to `./transcript`
 * - `TranscriptPreparer` (`prepareTranscript` 5s polling — implemented here)
 * - `PromptExtractor` (`extractPrompts`) — delegate to `./transcript`
 * - `SessionBaseDirProvider` (`getSessionBaseDir`)
 *
 * **9 capability NOT implemented** (Cursor Go upstream doesn't): TokenCalculator,
 * SubagentAwareExtractor, TextGenerator, HookResponseWriter,
 * RestoredSessionPathResolver, FileWatcher, TestOnly. See module.md for
 * per-capability rationale.
 *
 * @packageDocumentation
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chunkJSONL, reassembleJSONL } from '@/agent/chunking';
import type { Event } from '@/agent/event';
import type {
	Agent,
	HookSupport,
	PromptExtractor,
	SessionBaseDirProvider,
	TranscriptAnalyzer,
	TranscriptPreparer,
} from '@/agent/interfaces';
import type { AgentSession, HookInput } from '@/agent/session';
import {
	AGENT_NAME_CURSOR,
	AGENT_TYPE_CURSOR,
	type AgentName,
	type AgentType,
} from '@/agent/types';
import * as log from '@/log';
import { worktreeRoot } from '@/paths';
import {
	areHooksInstalled as areHooksInstalledImpl,
	hookNames as hookNamesImpl,
	installHooks as installHooksImpl,
	uninstallHooks as uninstallHooksImpl,
} from './hooks';
import { parseHookEvent as parseHookEventImpl } from './lifecycle';
import {
	extractModifiedFilesFromOffset as extractModifiedFilesFromOffsetImpl,
	extractPrompts as extractPromptsImpl,
	extractSummary as extractSummaryImpl,
	getTranscriptPosition as getTranscriptPositionImpl,
} from './transcript';

/**
 * Regex matching any non-alphanumeric character (ASCII).
 * Mirrors Go `cursor.go: nonAlphanumericRegex = regexp.MustCompile([^a-zA-Z0-9])`.
 */
const NON_ALPHANUMERIC_REGEX = /[^a-zA-Z0-9]/g;

/** Total deadline for {@link CursorAgent.prepareTranscript} polling. */
const PREPARE_TRANSCRIPT_MAX_WAIT_MS = 5000;
/** Sleep interval between transcript-readiness checks. */
const PREPARE_TRANSCRIPT_POLL_INTERVAL_MS = 50;

/** Log component tag used by Cursor agent (matches Go
 *  `logging.WithComponent(ctx, "agent.cursor")`). */
const LOG_CTX = { component: 'agent.cursor' } as const;

/**
 * Convert a path to Cursor's project directory format.
 *
 * Cursor stores sessions under
 * `~/.cursor/projects/<sanitized-repo-path>/agent-transcripts/`, where the
 * repo path has every non-alphanumeric character (ASCII) replaced with `-`.
 *
 * Mirrors Go `cursor.go: sanitizePathForCursor`. Strips leading `/` first
 * (Go uses `strings.TrimLeft(path, "/")`); embedded `/`, spaces, dots all
 * become `-`.
 *
 * @example
 * sanitizePathForCursor('/Users/me/proj');         // 'Users-me-proj'
 * sanitizePathForCursor('/Users/me/My Proj/x');    // 'Users-me-My-Proj-x'
 * sanitizePathForCursor('simple');                 // 'simple'
 */
export function sanitizePathForCursor(p: string): string {
	const trimmed = p.replace(/^\/+/, '');
	return trimmed.replace(NON_ALPHANUMERIC_REGEX, '-');
}

/**
 * Cursor agent. Implements 6 capabilities:
 * - {@link Agent} (16 mandatory methods)
 * - {@link HookSupport} (delegates to `./hooks` + `./lifecycle`)
 * - {@link TranscriptAnalyzer} (delegates to `./transcript`)
 * - {@link PromptExtractor} (delegates to `./transcript`)
 * - {@link TranscriptPreparer} (5s polling — implemented here)
 * - {@link SessionBaseDirProvider}
 *
 * Use {@link cursorAgent} factory; do not instantiate directly.
 *
 * Mirrors Go `cursor.go: CursorAgent` struct + methods.
 */
export class CursorAgent
	implements
		Agent,
		HookSupport,
		TranscriptAnalyzer,
		PromptExtractor,
		TranscriptPreparer,
		SessionBaseDirProvider
{
	name(): AgentName {
		return AGENT_NAME_CURSOR;
	}
	type(): AgentType {
		return AGENT_TYPE_CURSOR;
	}
	description(): string {
		return 'Cursor - AI-powered code editor';
	}
	isPreview(): boolean {
		return true;
	}

	/**
	 * Detect whether Cursor is configured in the repo.
	 *
	 * Returns `true` if any filesystem entry exists at `<repoRoot>/.cursor`
	 * (directory, regular file, symlink — Go `os.Stat` returns nil error for
	 * any of them). Falls back to `false` on any other fs error (matches Go:
	 * `cursor.go:57-68` returns `(false, nil)`; never propagates errors).
	 *
	 * @example
	 * await agent.detectPresence();
	 * // Repo with `.cursor/`              → true
	 * // Repo without `.cursor`            → false
	 * // worktreeRoot fails (non-git cwd)  → falls back to '.', stat ./.cursor
	 *
	 * // Side effects: fs.stat only (read-only).
	 */
	async detectPresence(): Promise<boolean> {
		let repoRoot: string;
		try {
			repoRoot = await worktreeRoot();
		} catch {
			repoRoot = '.';
		}
		try {
			await fs.stat(path.join(repoRoot, '.cursor'));
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Repo-root-relative dirs that rewind / reset must NEVER touch.
	 */
	protectedDirs(): string[] {
		return ['.cursor'];
	}

	getSessionID(input: HookInput): string {
		return input.sessionId;
	}

	/**
	 * Where Cursor stores session data for the given repo.
	 *
	 * `~/.cursor/projects/<sanitizePathForCursor(repoPath)>/agent-transcripts/`
	 *
	 * **Test override**: `STORY_TEST_CURSOR_PROJECT_DIR` (preferred) +
	 * `ENTIRE_TEST_CURSOR_PROJECT_DIR` (read fallback for back-compat with
	 * the shared Go/TS e2e harness). When set, returns the override directly.
	 *
	 * **Asymmetric with {@link getSessionBaseDir}**: that one ignores the env
	 * override (env points at a single project; cross-project search needs
	 * the parent root).
	 */
	async getSessionDir(repoPath: string): Promise<string> {
		const override =
			process.env.STORY_TEST_CURSOR_PROJECT_DIR ?? process.env.ENTIRE_TEST_CURSOR_PROJECT_DIR;
		if (override !== undefined && override !== '') {
			return override;
		}
		const home = os.homedir();
		if (home === '' || home === undefined) {
			throw new Error('failed to get home directory');
		}
		return path.join(
			home,
			'.cursor',
			'projects',
			sanitizePathForCursor(repoPath),
			'agent-transcripts',
		);
	}

	/**
	 * Base dir containing per-project session subdirectories.
	 *
	 * Always `~/.cursor/projects/`. **Does not** read the test override — env
	 * points at a single project, not the parent of all projects (matches Go
	 * `cursor.go:111-113`).
	 */
	async getSessionBaseDir(): Promise<string> {
		const home = os.homedir();
		if (home === '' || home === undefined) {
			throw new Error('failed to get home directory');
		}
		return path.join(home, '.cursor', 'projects');
	}

	/**
	 * Resolve the actual on-disk transcript file. Cursor uses two layouts:
	 * - **IDE**: `<dir>/<id>/<id>.jsonl` (nested — directory created before
	 *   the transcript file is flushed)
	 * - **CLI**: `<dir>/<id>.jsonl` (flat)
	 *
	 * Three-step decision (matches Go `cursor.go: ResolveSessionFile`):
	 *   1. Nested file exists → return nested path.
	 *   2. Nested directory exists (file not yet flushed) → predict nested path.
	 *   3. Otherwise → return flat path (CLI mode / IDE before any creation).
	 *
	 * **Real I/O** (`fs.stat`) is the reason {@link Agent.resolveSessionFile}
	 * returns {@link Awaitable}: Cursor must hit the filesystem; pure-path
	 * agents (Claude Code, Vogon) do not.
	 *
	 * @example
	 * await cursor.resolveSessionFile('/sessions', 'abc');
	 * // <dir>/abc/abc.jsonl exists  → '/sessions/abc/abc.jsonl'
	 * // <dir>/abc/         exists  → '/sessions/abc/abc.jsonl' (predicted)
	 * // neither exists             → '/sessions/abc.jsonl'      (flat fallback)
	 *
	 * // Side effects: fs.stat ×2 at most (read-only).
	 */
	async resolveSessionFile(sessionDir: string, agentSessionId: string): Promise<string> {
		const nestedDir = path.join(sessionDir, agentSessionId);
		const nested = path.join(nestedDir, `${agentSessionId}.jsonl`);
		try {
			await fs.stat(nested);
			return nested;
		} catch {
			// fall through
		}
		try {
			const dirStat = await fs.stat(nestedDir);
			if (dirStat.isDirectory()) {
				return nested;
			}
		} catch {
			// fall through
		}
		return path.join(sessionDir, `${agentSessionId}.jsonl`);
	}

	/**
	 * Read session data from Cursor's storage (JSONL transcript file).
	 *
	 * Requires `input.sessionRef` (transcript path); throws otherwise.
	 * `startTime` is set to "now" (matches Go `time.Now()`).
	 * `modifiedFiles` is left empty — Cursor transcripts contain no `tool_use`
	 * blocks; file detection lives in git status + hook payload `modified_files`.
	 *
	 * @example
	 * await cursor.readSession({ sessionId: 'sid', sessionRef: '/path/abc.jsonl', ... });
	 * // returns: { sessionId, agentName: 'cursor', sessionRef, startTime: now,
	 * //           nativeData: <raw JSONL bytes>, modifiedFiles: [] }
	 *
	 * // Side effects: fs.readFile only (read-only).
	 */
	async readSession(input: HookInput): Promise<AgentSession> {
		if (input.sessionRef === '') {
			throw new Error('session reference (transcript path) is required');
		}
		let data: Buffer;
		try {
			data = await fs.readFile(input.sessionRef);
		} catch (err) {
			throw new Error(`failed to read transcript: ${(err as Error).message}`, {
				cause: err as Error,
			});
		}
		return {
			sessionId: input.sessionId,
			agentName: this.name(),
			repoPath: '',
			sessionRef: input.sessionRef,
			startTime: new Date(),
			nativeData: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
			modifiedFiles: [],
			newFiles: [],
			deletedFiles: [],
			entries: [],
		};
	}

	/**
	 * Write session data back to Cursor's transcript file (Phase 5.5
	 * RestoreLogsOnly path uses this).
	 *
	 * Validates: matching `agentName` (when present); non-empty `sessionRef`
	 * + non-empty `nativeData`. File mode `0o600` (matches Go).
	 *
	 * **Empty `agentName` is accepted** (Go: `cursor.go:204-211` skips the
	 * agent-mismatch check when the field is `""`) — used by cross-agent
	 * restore where the source session lost its agent label.
	 *
	 * @example
	 * await cursor.writeSession({
	 *   sessionId: 'sid', agentName: 'cursor',
	 *   sessionRef: '/path/abc.jsonl', nativeData: bytes, ...
	 * });
	 *
	 * // Side effects:
	 * //   <sessionRef>          ← overwritten with nativeData (mode 0o600)
	 * //   parent dir / index / HEAD: unchanged (caller must ensure parent exists)
	 * //
	 * // Failure modes (throw):
	 * //   - session is null
	 * //   - session.agentName non-empty AND not 'cursor'
	 * //   - empty sessionRef
	 * //   - empty nativeData
	 * //   - fs.writeFile fails
	 */
	async writeSession(session: AgentSession): Promise<void> {
		if (session === null || session === undefined) {
			throw new Error('session is nil');
		}
		if (session.agentName !== '' && session.agentName !== this.name()) {
			throw new Error(`session belongs to agent "${session.agentName}", not "${this.name()}"`);
		}
		if (session.sessionRef === '') {
			throw new Error('session reference (transcript path) is required');
		}
		if (session.nativeData.length === 0) {
			throw new Error('session has no native data to write');
		}
		try {
			await fs.writeFile(session.sessionRef, session.nativeData, { mode: 0o600 });
		} catch (err) {
			throw new Error(`failed to write transcript: ${(err as Error).message}`, {
				cause: err as Error,
			});
		}
	}

	/**
	 * Resume instruction — Cursor is a GUI IDE so there's no shell command
	 * to resume a session directly. Mirrors Go `cursor.go:230-232`.
	 */
	formatResumeCommand(_sessionID: string): string {
		return 'Open this project in Cursor to continue the session.';
	}

	/**
	 * Read raw JSONL bytes from `sessionRef` file. Wraps fs error.
	 */
	async readTranscript(sessionRef: string): Promise<Uint8Array> {
		try {
			const buf = await fs.readFile(sessionRef);
			return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
		} catch (err) {
			throw new Error(`failed to read transcript: ${(err as Error).message}`, {
				cause: err as Error,
			});
		}
	}

	/**
	 * Delegate to JSONL chunker (matches Go `cursor.ChunkTranscript = ChunkJSONL`).
	 */
	async chunkTranscript(content: Uint8Array, maxSize: number): Promise<Uint8Array[]> {
		try {
			return chunkJSONL(content, maxSize);
		} catch (err) {
			throw new Error(`failed to chunk JSONL transcript: ${(err as Error).message}`, {
				cause: err as Error,
			});
		}
	}

	/**
	 * Delegate to JSONL reassembler (always succeeds — empty chunks → empty bytes).
	 */
	async reassembleTranscript(chunks: Uint8Array[]): Promise<Uint8Array> {
		return reassembleJSONL(chunks);
	}

	hookNames(): string[] {
		return hookNamesImpl();
	}

	async parseHookEvent(
		hookName: string,
		stdin: NodeJS.ReadableStream,
		ctx?: AbortSignal,
	): Promise<Event | null> {
		return parseHookEventImpl.call(this, hookName, stdin, ctx);
	}

	async installHooks(opts: { localDev: boolean; force: boolean }): Promise<number> {
		return installHooksImpl(opts);
	}

	async uninstallHooks(): Promise<void> {
		return uninstallHooksImpl();
	}

	async areHooksInstalled(): Promise<boolean> {
		return areHooksInstalledImpl();
	}

	async getTranscriptPosition(p: string): Promise<number> {
		return getTranscriptPositionImpl(p);
	}

	async extractModifiedFilesFromOffset(
		p: string,
		startOffset: number,
	): Promise<{ files: string[]; currentPosition: number }> {
		return extractModifiedFilesFromOffsetImpl(p, startOffset);
	}

	async extractPrompts(sessionRef: string, fromOffset: number): Promise<string[]> {
		return extractPromptsImpl(sessionRef, fromOffset);
	}

	/**
	 * Last assistant text block from a transcript (Cursor-specific helper —
	 * not part of any framework capability interface). Mirrors Go
	 * `cursor/transcript.go: ExtractSummary`.
	 */
	async extractSummary(sessionRef: string): Promise<string> {
		return extractSummaryImpl(sessionRef);
	}

	/**
	 * Wait for Cursor's async transcript flush to land on disk.
	 *
	 * Polls `fs.stat(sessionRef)` every 50ms for up to 5s; returns as soon as
	 * the file exists with non-zero size. **Fail-open**: timeout warns + returns
	 * (does NOT throw) so the calling hook can proceed with whatever data is
	 * present (Go same behavior).
	 *
	 * **AbortSignal**: throws `'context ended while waiting for transcript'`
	 * when the signal aborts (Go: `errors.Is(err, context.Canceled)`).
	 *
	 * @example
	 * await cursor.prepareTranscript('/path/sess.jsonl');
	 * // file exists, size > 0      → returns immediately
	 * // file appears within 5s     → returns when found
	 * // file never appears (5s)    → log.warn + return (no throw)
	 * // signal aborted             → throw 'context ended while waiting for transcript'
	 *
	 * // Side effects: read-only fs.stat (repeated polling).
	 */
	async prepareTranscript(sessionRef: string, ctx?: AbortSignal): Promise<void> {
		const start = Date.now();
		const deadline = start + PREPARE_TRANSCRIPT_MAX_WAIT_MS;

		while (Date.now() < deadline) {
			if (ctx?.aborted === true) {
				throw new Error('context ended while waiting for transcript');
			}

			try {
				const stat = await fs.stat(sessionRef);
				if (stat.size > 0) {
					log.debug(LOG_CTX, 'transcript file ready', { size: stat.size });
					return;
				}
				// size === 0 → keep polling
			} catch (err) {
				const code = (err as NodeJS.ErrnoException).code;
				if (code !== 'ENOENT') {
					throw new Error(`failed to stat transcript "${sessionRef}": ${(err as Error).message}`, {
						cause: err as Error,
					});
				}
				// ENOENT → keep polling
			}

			const remaining = deadline - Date.now();
			const wait = Math.min(PREPARE_TRANSCRIPT_POLL_INTERVAL_MS, remaining);
			if (wait <= 0) {
				break;
			}
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => {
					ctx?.removeEventListener('abort', onAbort);
					resolve();
				}, wait);
				const onAbort = () => {
					clearTimeout(timer);
					reject(new Error('context ended while waiting for transcript'));
				};
				if (ctx?.aborted === true) {
					clearTimeout(timer);
					reject(new Error('context ended while waiting for transcript'));
					return;
				}
				ctx?.addEventListener('abort', onAbort, { once: true });
			});
		}

		log.warn(LOG_CTX, 'transcript file not ready within timeout, proceeding', {
			timeoutMs: PREPARE_TRANSCRIPT_MAX_WAIT_MS,
			path: sessionRef,
		});
	}
}

/**
 * Factory for the Cursor agent. Mirrors Go `NewCursorAgent`.
 *
 * Returns a fresh instance each call (registry holds the factory, not the
 * instance). Used by `src/agent/bootstrap.ts: registerBuiltinAgents()` to
 * wire Cursor into the registry; not auto-registered (no module-level side
 * effects — see [`AGENTS.md` §异步/模块边界](../../../AGENTS.md)).
 */
export function cursorAgent(): Agent {
	return new CursorAgent();
}
