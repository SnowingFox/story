/**
 * Claude Code agent — main entry: identity / detect / I/O / chunking + path
 * helpers + factory.
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/agent/claudecode/claude.go`
 * (algorithms) + `paths/paths.go: SanitizePathForClaude /
 * ExtractSessionIDFromTranscriptPath` (Phase 1 foundation backlog #19 ports
 * the latter into this file rather than a generic paths module — Claude is
 * the only consumer).
 *
 * **Registration**: handled by [`src/agent/bootstrap.ts:
 * registerBuiltinAgents()`](../bootstrap.ts), called from `src/cli.ts:
 * run()` at startup. This module exports the {@link claudeCodeAgent}
 * factory only — no module-level side effects (see [`AGENTS.md`
 * §异步/模块边界](../../../AGENTS.md)).
 *
 * **Capabilities** (Part 1 + Part 2 combined):
 * - `Agent` (mandatory identity + storage + session methods)
 * - `HookSupport` (hookNames / parseHookEvent / install / uninstall / areInstalled)
 *   — methods delegate to `./hooks` and `./lifecycle`
 * - `TranscriptAnalyzer` (`getTranscriptPosition` + `extractModifiedFilesFromOffset`)
 * - `TranscriptPreparer` (`prepareTranscript` → waitForTranscriptFlush)
 * - `TokenCalculator` (`calculateTokenUsage` → `transcript.calculateTotalTokenUsage(data, offset, '')`)
 * - `SubagentAwareExtractor` (delegates to `./transcript`)
 * - `HookResponseWriter` (delegates to `./lifecycle.writeHookResponse`)
 * - `TextGenerator` (delegates to `./generate`)
 * - `SessionBaseDirProvider`
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
	HookResponseWriter,
	HookSupport,
	SessionBaseDirProvider,
	SubagentAwareExtractor,
	TextGenerator,
	TokenCalculator,
	TranscriptAnalyzer,
	TranscriptPreparer,
} from '@/agent/interfaces';
import type { AgentSession, HookInput, TokenUsage } from '@/agent/session';
import {
	AGENT_NAME_CLAUDE_CODE,
	AGENT_TYPE_CLAUDE_CODE,
	type AgentName,
	type AgentType,
} from '@/agent/types';
import { worktreeRoot } from '@/paths';
import { parseFromBytes } from '@/transcript';
import { generateText as generateTextImpl } from './generate';
import {
	areHooksInstalled as areHooksInstalledImpl,
	installHooks as installHooksImpl,
	uninstallHooks as uninstallHooksImpl,
} from './hooks';
import {
	calculateTokenUsage as calculateTokenUsageImpl,
	hookNames as hookNamesImpl,
	parseHookEvent as parseHookEventImpl,
	prepareTranscript as prepareTranscriptImpl,
	writeHookResponse as writeHookResponseImpl,
} from './lifecycle';
import {
	calculateTotalTokenUsage,
	extractAllModifiedFiles,
	extractModifiedFiles,
	findCheckpointUUID,
	serializeTranscript,
	truncateAtUUID,
} from './transcript';
import { CLAUDE_SETTINGS_FILE_NAME } from './types';

/**
 * Regex matching any non-alphanumeric character (ASCII).
 * Mirrors Go `nonAlphanumericRegex = regexp.MustCompile([^a-zA-Z0-9])`.
 */
const NON_ALPHANUMERIC_REGEX = /[^a-zA-Z0-9]/g;

/**
 * Convert a path to Claude's project directory format.
 *
 * Claude stores sessions under `~/.claude/projects/<sanitized-repo-path>/`,
 * where the repo path has every non-alphanumeric character (ASCII) replaced
 * with `-`.
 *
 * @example
 * sanitizePathForClaude('/Users/me/proj');         // 'Users-me-proj'
 * sanitizePathForClaude('/Users/me/My Proj/x');    // 'Users-me-My-Proj-x'
 * sanitizePathForClaude('alphaNUM123');            // 'alphaNUM123' (unchanged)
 */
export function sanitizePathForClaude(p: string): string {
	return p.replace(NON_ALPHANUMERIC_REGEX, '-');
}

/**
 * Extract the Claude session ID from a transcript path.
 *
 * Claude transcripts live at `~/.claude/projects/<project>/sessions/<id>.jsonl`
 * — this helper finds the `sessions/` segment and returns the next segment
 * with `.jsonl` stripped. Foundation backlog item #19 (ported here rather
 * than `paths.ts` because Claude is the only agent with this layout).
 *
 * Mirrors Go `paths.go: ExtractSessionIDFromTranscriptPath`. Normalizes
 * Windows-style backslashes to `/` first so the same parser works on both
 * platforms.
 *
 * @example
 * extractSessionIdFromTranscriptPath('/Users/me/.claude/projects/foo/sessions/abc-123.jsonl');
 * // → 'abc-123'
 *
 * extractSessionIdFromTranscriptPath('C:\\Users\\me\\.claude\\projects\\foo\\sessions\\abc.jsonl');
 * // → 'abc'   (Windows-style backslashes normalized)
 *
 * extractSessionIdFromTranscriptPath('/some/other/path.txt');
 * // → ''   (no `sessions/` segment found)
 *
 * extractSessionIdFromTranscriptPath('');
 * // → ''
 */
export function extractSessionIdFromTranscriptPath(transcriptPath: string): string {
	const parts = transcriptPath.replace(/\\/g, '/').split('/');
	for (let i = 0; i < parts.length; i++) {
		if (parts[i] === 'sessions' && i + 1 < parts.length) {
			const filename = parts[i + 1] ?? '';
			if (filename.endsWith('.jsonl')) {
				return filename.slice(0, -'.jsonl'.length);
			}
			return filename;
		}
	}
	return '';
}

/**
 * Claude Code agent. Implements `Agent` plus the 4 capability sub-interfaces
 * Part 1 ships:
 * - {@link TranscriptAnalyzer} (`getTranscriptPosition` /
 *   `extractModifiedFilesFromOffset`)
 * - {@link SubagentAwareExtractor} (`extractAllModifiedFiles` /
 *   `calculateTotalTokenUsage`)
 * - {@link TextGenerator} (`generateText`)
 * - {@link SessionBaseDirProvider} (`getSessionBaseDir`)
 *
 * Part 2 will mix in `HookSupport` / `TranscriptPreparer` / `TokenCalculator` /
 * `HookResponseWriter` via `Object.assign(ClaudeCodeAgent.prototype, ...)`.
 *
 * Use {@link claudeCodeAgent} factory; do not instantiate directly (registry
 * stores a factory, not an instance).
 *
 * Mirrors Go `claude.go: ClaudeCodeAgent` struct + methods.
 */
export class ClaudeCodeAgent
	implements
		Agent,
		HookSupport,
		TranscriptAnalyzer,
		TranscriptPreparer,
		TokenCalculator,
		SubagentAwareExtractor,
		HookResponseWriter,
		TextGenerator,
		SessionBaseDirProvider
{
	name(): AgentName {
		return AGENT_NAME_CLAUDE_CODE;
	}
	type(): AgentType {
		return AGENT_TYPE_CLAUDE_CODE;
	}
	description(): string {
		return "Claude Code - Anthropic's CLI coding assistant";
	}
	isPreview(): boolean {
		return false;
	}

	/**
	 * Detect whether Claude Code is configured in the repo.
	 *
	 * Returns `true` if **any** filesystem entry exists at `<repoRoot>/.claude`
	 * (directory, regular file, symlink — Go `os.Stat` returns nil error for
	 * any of them) OR `<repoRoot>/.claude/settings.json` exists. Falls back to
	 * `false` on any other fs error (matches Go: `claude.go:58-78` returns
	 * `(false, nil)` after both checks fail; never propagates).
	 *
	 * **Go-parity note**: do NOT use `stat.isDirectory()` — Go merely checks
	 * `err == nil`. A regular file at `.claude` (rare but possible if a user
	 * accidentally `touch .claude`d) counts as presence in Go. The second
	 * `.claude/settings.json` stat is defense-in-depth (when `.claude` is a
	 * regular file, `.claude/settings.json` returns ENOTDIR — same false).
	 *
	 * @example
	 * await agent.detectPresence();
	 * // Repo with `.claude/`                            → true
	 * // Repo with `.claude` as a regular file (rare)   → true (Go-parity)
	 * // Repo with `.claude/settings.json` only          → true (defense-in-depth)
	 * // Empty repo                                      → false
	 *
	 * // Side effects: read-only fs.stat (×2 at most).
	 */
	async detectPresence(): Promise<boolean> {
		let repoRoot: string;
		try {
			repoRoot = await worktreeRoot();
		} catch {
			repoRoot = '.';
		}

		try {
			// Go: claude.go:69 — `os.Stat(claudeDir)` success returns true
			// regardless of file type (dir / regular file / symlink target).
			await fs.stat(path.join(repoRoot, '.claude'));
			return true;
		} catch {
			// not present; fall through to settings.json check
		}

		try {
			await fs.stat(path.join(repoRoot, '.claude', CLAUDE_SETTINGS_FILE_NAME));
			return true;
		} catch {
			return false;
		}
	}

	/** Repo-root-relative dirs that rewind / reset must NEVER touch. */
	protectedDirs(): string[] {
		return ['.claude'];
	}

	getSessionID(input: HookInput): string {
		return input.sessionId;
	}

	/**
	 * Where Claude stores session data for the given repo.
	 *
	 * `~/.claude/projects/<sanitizePathForClaude(repoPath)>/`
	 *
	 * **Test override**: `STORY_TEST_CLAUDE_PROJECT_DIR` (preferred) +
	 * `ENTIRE_TEST_CLAUDE_PROJECT_DIR` (read fallback for back-compat with
	 * shared Go/TS e2e harness) — when set, returns the override directly,
	 * skipping homedir lookup and sanitization.
	 *
	 * **Asymmetric with {@link getSessionBaseDir}**: that one ignores the
	 * env var by design (env points at a single project; cross-project
	 * search needs the parent root).
	 */
	async getSessionDir(repoPath: string): Promise<string> {
		const override =
			process.env.STORY_TEST_CLAUDE_PROJECT_DIR ?? process.env.ENTIRE_TEST_CLAUDE_PROJECT_DIR;
		if (override !== undefined && override !== '') {
			return override;
		}

		const home = os.homedir();
		if (home === '' || home === undefined) {
			throw new Error('failed to get home directory');
		}
		return path.join(home, '.claude', 'projects', sanitizePathForClaude(repoPath));
	}

	/**
	 * Base dir containing per-project session subdirectories.
	 *
	 * Always `~/.claude/projects/`. **Does not** read the
	 * `STORY_TEST_CLAUDE_PROJECT_DIR` override (test env points at a single
	 * project, not the parent of all projects — see Go source comment in
	 * `claude.go:111-113`).
	 */
	async getSessionBaseDir(): Promise<string> {
		const home = os.homedir();
		if (home === '' || home === undefined) {
			throw new Error('failed to get home directory');
		}
		return path.join(home, '.claude', 'projects');
	}

	/** Session file path: `<sessionDir>/<agentSessionId>.jsonl`. Pure path
	 *  computation — no `async` needed (interface returns {@link Awaitable}). */
	resolveSessionFile(sessionDir: string, agentSessionId: string): string {
		return path.join(sessionDir, `${agentSessionId}.jsonl`);
	}

	/**
	 * Read session data from Claude's JSONL transcript file.
	 *
	 * Requires `input.sessionRef` (transcript path); throws otherwise.
	 * `startTime` is set to "now" (matches Go `time.Now()` — not derived
	 * from file mtime). `nativeData` holds raw JSONL bytes; `modifiedFiles`
	 * is computed via {@link extractModifiedFiles}.
	 *
	 * @example
	 * await agent.readSession({ sessionId: 'sid', sessionRef: '/path/abc.jsonl', ... });
	 * // returns: { sessionId, agentName: 'claude-code', sessionRef, startTime: now,
	 * //           nativeData: <raw JSONL bytes>, modifiedFiles: ['src/a.ts', ...] }
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
		const text = data.toString('utf-8');
		const lines = parseFromBytes(text);
		return {
			sessionId: input.sessionId,
			agentName: this.name(),
			repoPath: '',
			sessionRef: input.sessionRef,
			startTime: new Date(),
			nativeData: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
			modifiedFiles: extractModifiedFiles(lines),
			newFiles: [],
			deletedFiles: [],
			entries: [],
		};
	}

	/**
	 * Write session data back to disk for resumption (Phase 5.5
	 * RestoreLogsOnly path uses this).
	 *
	 * Validates: matching `agentName` (when present); non-empty `sessionRef`
	 * + non-empty `nativeData`. File mode `0o600` (matches Go `os.WriteFile(..., 0o600)`).
	 *
	 * @example
	 * await agent.writeSession({
	 *   sessionId: 'sid', agentName: 'claude-code',
	 *   sessionRef: '/path/abc.jsonl', nativeData: bytes, ...
	 * });
	 *
	 * // Side effects:
	 * //   <sessionRef>          ← overwritten with nativeData (mode 0o600)
	 * //   parent dir / index / HEAD: unchanged (caller must ensure parent exists)
	 * //
	 * // Failure modes (throw):
	 * //   - session.agentName non-empty AND not 'claude-code'
	 * //   - empty sessionRef
	 * //   - empty nativeData
	 * //   - fs.writeFile fails
	 */
	async writeSession(session: AgentSession): Promise<void> {
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

	/** Shell command to resume: `'claude -r ' + sessionID` (literal — note space). */
	formatResumeCommand(sessionID: string): string {
		return `claude -r ${sessionID}`;
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

	/** Delegate to JSONL chunker (matches Go: claude.ChunkTranscript = ChunkJSONL wrap). */
	async chunkTranscript(content: Uint8Array, maxSize: number): Promise<Uint8Array[]> {
		try {
			return chunkJSONL(content, maxSize);
		} catch (err) {
			throw new Error(`failed to chunk JSONL transcript: ${(err as Error).message}`, {
				cause: err as Error,
			});
		}
	}

	/** Delegate to JSONL reassembler (always succeeds — empty chunks → empty bytes). */
	async reassembleTranscript(chunks: Uint8Array[]): Promise<Uint8Array> {
		return reassembleJSONL(chunks);
	}

	/**
	 * Current transcript position (line count). Mirrors Go
	 * `claude.go: GetTranscriptPosition` — JSONL counts lines, not parsed
	 * messages. Lightweight: byte-level newline scan, no JSON.parse.
	 *
	 * **Asymmetric with {@link extractModifiedFilesFromOffset}**:
	 * - empty `path` → `0`
	 * - file does not exist → `0` (success, NOT an error)
	 * - other read errors → throw `'failed to open transcript file: ...'`
	 *
	 * If the file ends without a trailing newline, the final partial line
	 * still counts.
	 *
	 * @example
	 * await agent.getTranscriptPosition('');                   // 0
	 * await agent.getTranscriptPosition('/missing/file');      // 0 (silent ENOENT)
	 * await agent.getTranscriptPosition('/path/3-line.jsonl'); // 3
	 *
	 * // Side effects: read-only fs.readFile (1 file).
	 */
	async getTranscriptPosition(p: string): Promise<number> {
		if (p === '') {
			return 0;
		}
		let data: Buffer;
		try {
			data = await fs.readFile(p);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === 'ENOENT') {
				return 0;
			}
			throw new Error(`failed to open transcript file: ${(err as Error).message}`, {
				cause: err as Error,
			});
		}
		if (data.length === 0) {
			return 0;
		}
		let n = 0;
		for (let i = 0; i < data.length; i++) {
			if (data[i] === 0x0a /* \n */) {
				n++;
			}
		}
		// Final partial line without trailing newline (Go: bufio EOF + len(line)>0).
		if (data[data.length - 1] !== 0x0a) {
			n++;
		}
		return n;
	}

	/**
	 * Extract files modified since `startOffset` (line number).
	 *
	 * **Asymmetric with {@link getTranscriptPosition}**: missing file →
	 * throws (matches Go `failed to open transcript file`). Caller knew
	 * there was a transcript when it asked; missing file is a real error.
	 *
	 * Returns `{ files, currentPosition }` where `currentPosition` is the
	 * total non-empty line count after the read. Lines `lineNum > startOffset`
	 * are JSON-parsed; malformed lines are silently skipped (matches Go:
	 * `if parseErr := json.Unmarshal(...); parseErr == nil`).
	 *
	 * @example
	 * await agent.extractModifiedFilesFromOffset('/path/transcript.jsonl', 5);
	 * // returns: { files: ['src/foo.ts'], currentPosition: 12 }
	 *
	 * // Side effects: read-only fs.readFile.
	 */
	async extractModifiedFilesFromOffset(
		p: string,
		startOffset: number,
	): Promise<{ files: string[]; currentPosition: number }> {
		if (p === '') {
			return { files: [], currentPosition: 0 };
		}
		let data: Buffer;
		try {
			data = await fs.readFile(p);
		} catch (err) {
			throw new Error(`failed to open transcript file: ${(err as Error).message}`, {
				cause: err as Error,
			});
		}
		const text = data.toString('utf-8');
		const collected: import('@/transcript').TranscriptLine[] = [];
		let lineNum = 0;
		// Iterate every newline-terminated chunk + the trailing partial line if any.
		// Go uses bufio.Reader; we simulate by splitting on '\n' but only counting
		// non-empty raw lines (matches `if len(lineData) > 0 { lineNum++ }`).
		const rawLines = text.split('\n');
		for (let i = 0; i < rawLines.length; i++) {
			const raw = rawLines[i] ?? '';
			// Go counts the line if `len(lineData) > 0` — `lineData` includes the
			// trailing newline byte that bufio returned. The split('\n') here strips
			// the trailing newline from each segment, so a non-empty `raw` plus the
			// implicit `\n` (for all but the last segment) means Go would count it.
			// For the final segment, Go counts iff `len(raw) > 0`.
			const isFinalPartial = i === rawLines.length - 1;
			const lineHadBytes = isFinalPartial ? raw.length > 0 : true;
			if (!lineHadBytes) {
				continue;
			}
			lineNum++;
			if (lineNum > startOffset) {
				try {
					const parsed = JSON.parse(raw) as import('@/transcript').TranscriptLine;
					collected.push(parsed);
				} catch {
					// skip malformed lines (Go: parseErr == nil → skip)
				}
			}
		}
		return { files: extractModifiedFiles(collected), currentPosition: lineNum };
	}

	/**
	 * Truncate session transcript at the line with given UUID. Empty UUID
	 * returns a copy with same nativeData (no parse). UUID not found returns
	 * full transcript.
	 *
	 * Re-extracts `modifiedFiles` after truncation (a tool_use block past
	 * the truncation point should NOT be reported as modified).
	 *
	 * @example
	 * await agent.truncateAtUUID(session, 'tool-result-uuid');
	 * // returns: new AgentSession with nativeData truncated + modifiedFiles recomputed
	 *
	 * // Side effects: none — pure (returns new object).
	 */
	async truncateAtUUID(session: AgentSession, uuid: string): Promise<AgentSession> {
		if (session.nativeData.length === 0) {
			throw new Error('session has no native data');
		}
		// Go (claude.go:201-209 / 225-233) explicitly returns a new struct with
		// only the identity / data / modifiedFiles fields populated, leaving
		// newFiles / deletedFiles / entries at zero values. Mirror by zero-init
		// rather than spread — preserves Go-parity semantics for downstream
		// callers that rely on the truncated session having empty aux fields.
		if (uuid === '') {
			return {
				sessionId: session.sessionId,
				agentName: session.agentName,
				repoPath: session.repoPath,
				sessionRef: session.sessionRef,
				startTime: session.startTime,
				nativeData: session.nativeData,
				modifiedFiles: session.modifiedFiles,
				newFiles: [],
				deletedFiles: [],
				entries: [],
			};
		}
		const text = new TextDecoder().decode(session.nativeData);
		const lines = parseFromBytes(text);
		const truncated = truncateAtUUID(lines, uuid);
		const newData = serializeTranscript(truncated);
		return {
			sessionId: session.sessionId,
			agentName: session.agentName,
			repoPath: session.repoPath,
			sessionRef: session.sessionRef,
			startTime: session.startTime,
			nativeData: newData,
			modifiedFiles: extractModifiedFiles(truncated),
			newFiles: [],
			deletedFiles: [],
			entries: [],
		};
	}

	/** Find UUID of message containing tool_result for given toolUseId. Returns
	 *  `null` on miss or parse failure (matches Go `("", false)`). */
	async findCheckpointUUID(session: AgentSession, toolUseId: string): Promise<string | null> {
		if (session.nativeData.length === 0) {
			return null;
		}
		try {
			const text = new TextDecoder().decode(session.nativeData);
			const lines = parseFromBytes(text);
			return findCheckpointUUID(lines, toolUseId);
		} catch {
			return null;
		}
	}

	/** Convenience: read session by transcript path + sessionId. Mirrors Go
	 *  `claude.go: ReadSessionFromPath`. */
	async readSessionFromPath(transcriptPath: string, sessionId: string): Promise<AgentSession> {
		return this.readSession({
			hookType: 'session_start',
			sessionId,
			sessionRef: transcriptPath,
			timestamp: new Date(),
			userPrompt: '',
			toolName: '',
			toolUseId: '',
			toolInput: null,
			toolResponse: null,
			rawData: {},
		});
	}

	async extractAllModifiedFiles(
		transcriptData: Uint8Array,
		fromOffset: number,
		subagentsDir: string,
	): Promise<string[]> {
		return extractAllModifiedFiles(transcriptData, fromOffset, subagentsDir);
	}

	async calculateTotalTokenUsage(
		transcriptData: Uint8Array,
		fromOffset: number,
		subagentsDir: string,
	): Promise<TokenUsage | null> {
		return calculateTotalTokenUsage(transcriptData, fromOffset, subagentsDir);
	}

	async generateText(prompt: string, model: string, ctx?: AbortSignal): Promise<string> {
		return generateTextImpl(prompt, model, ctx);
	}

	hookNames(): string[] {
		return hookNamesImpl();
	}

	async parseHookEvent(verb: string, stdin: NodeJS.ReadableStream): Promise<Event | null> {
		return parseHookEventImpl(verb, stdin);
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

	async prepareTranscript(sessionRef: string): Promise<void> {
		return prepareTranscriptImpl(sessionRef);
	}

	async calculateTokenUsage(
		transcriptData: Uint8Array,
		fromOffset: number,
	): Promise<TokenUsage | null> {
		return calculateTokenUsageImpl(transcriptData, fromOffset);
	}

	async writeHookResponse(message: string): Promise<void> {
		return writeHookResponseImpl(message);
	}
}

/**
 * Factory for the Claude Code agent. Mirrors Go `NewClaudeCodeAgent`.
 *
 * Returns a fresh instance each call (registry holds the factory, not the
 * instance). Used by `src/agent/bootstrap.ts: registerBuiltinAgents()` to
 * wire Claude Code into the registry; not auto-registered (no module-level
 * side effects — see [`AGENTS.md` §异步/模块边界](../../../AGENTS.md)).
 */
export function claudeCodeAgent(): Agent {
	return new ClaudeCodeAgent();
}
