/**
 * Codex agent — main entry: identity + I/O + chunking + path helpers +
 * factory. Methods delegate to {@link import('./hooks')} /
 * {@link import('./lifecycle')} / {@link import('./transcript')}.
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/agent/codex/codex.go`
 * (`CodexAgent` struct + 16 method + `init()` self-register +
 * `resolveCodexHome` / `restoredRolloutPath` / `findRolloutBySessionID`).
 *
 * **Registration**: handled by [`src/agent/bootstrap.ts:
 * registerBuiltinAgents()`](../bootstrap.ts), called from `src/cli.ts:
 * run()` at startup. This module exports the {@link codexAgent} factory
 * only — no module-level side effects (see [`AGENTS.md`
 * §异步/模块边界](../../../AGENTS.md)). This is a deliberate divergence
 * from Go's `init()` pattern, mirroring Phase 6.3 Cursor's bootstrap fix.
 *
 * **Capabilities** (7 total — see Phase 6.5 module.md):
 * - `Agent` (mandatory identity + storage + session methods)
 * - `HookSupport` — methods delegate to `./hooks` and `./lifecycle`
 * - `TranscriptAnalyzer` (`getTranscriptPosition` /
 *   `extractModifiedFilesFromOffset`) — delegate to `./transcript`
 * - `TokenCalculator` (`calculateTokenUsage` cumulative delta) — delegate to `./transcript`
 * - `PromptExtractor` (`extractPrompts`) — delegate to `./transcript`
 * - `HookResponseWriter` (`writeHookResponse` `{systemMessage}` JSON) — delegate to `./lifecycle`
 * - `RestoredSessionPathResolver` (`resolveRestoredSessionFile` UTC date path)
 *
 * **6 capability NOT implemented**: TranscriptPreparer (Codex hook stdin
 * carries transcript_path; no polling), SubagentAwareExtractor (no Task tool),
 * TextGenerator (no `codex --print` mode), SessionBaseDirProvider
 * (`getSessionDir(_)` already returns the session root), FileWatcher (uses
 * hooks), TestOnly (production agent).
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
	PromptExtractor,
	RestoredSessionPathResolver,
	TokenCalculator,
	TranscriptAnalyzer,
} from '@/agent/interfaces';
import type { AgentSession, HookInput, TokenUsage } from '@/agent/session';
import { AGENT_NAME_CODEX, AGENT_TYPE_CODEX, type AgentName, type AgentType } from '@/agent/types';
import { validateAgentSessionID } from '@/validation';
import {
	areHooksInstalled as areHooksInstalledImpl,
	installHooks as installHooksImpl,
	uninstallHooks as uninstallHooksImpl,
} from './hooks';
import {
	hookNames as hookNamesImpl,
	parseHookEvent as parseHookEventImpl,
	writeHookResponse as writeHookResponseImpl,
} from './lifecycle';
import {
	calculateTokenUsage as calculateTokenUsageImpl,
	extractFilesFromLine,
	extractModifiedFilesFromOffset as extractModifiedFilesFromOffsetImpl,
	extractPrompts as extractPromptsImpl,
	getTranscriptPosition as getTranscriptPositionImpl,
	parseSessionStartTime,
	sanitizeRestoredTranscript,
	splitJSONL,
} from './transcript';

/**
 * Resolve the Codex home directory: `CODEX_HOME` env (highest priority) →
 * `os.homedir() + '/.codex'`. Throws when no homedir and no env override.
 *
 * Mirrors Go `codex.go: resolveCodexHome`.
 */
export async function resolveCodexHome(): Promise<string> {
	const envHome = process.env.CODEX_HOME;
	if (envHome !== undefined && envHome !== '') {
		return envHome;
	}
	const home = os.homedir();
	if (home === '' || home === undefined) {
		throw new Error('failed to get home directory');
	}
	return path.join(home, '.codex');
}

/**
 * Codex agent. Implements 7 capabilities (see file-level docs).
 * Use {@link codexAgent} factory; do not instantiate directly.
 *
 * Mirrors Go `codex.go: CodexAgent` struct + methods.
 */
export class CodexAgent
	implements
		Agent,
		HookSupport,
		TranscriptAnalyzer,
		TokenCalculator,
		PromptExtractor,
		HookResponseWriter,
		RestoredSessionPathResolver
{
	name(): AgentName {
		return AGENT_NAME_CODEX;
	}
	type(): AgentType {
		return AGENT_TYPE_CODEX;
	}
	description(): string {
		return "Codex - OpenAI's CLI coding agent";
	}
	isPreview(): boolean {
		return true;
	}

	/** Repo-root-relative dirs that rewind / reset must NEVER touch. */
	protectedDirs(): string[] {
		return ['.codex'];
	}

	getSessionID(input: HookInput): string {
		return input.sessionId;
	}

	/**
	 * Detect whether Codex hooks are installed in this repo. Delegates to
	 * {@link areHooksInstalledImpl} (checks 3 managed hook buckets).
	 */
	async detectPresence(): Promise<boolean> {
		return areHooksInstalledImpl();
	}

	/**
	 * Where Codex stores session transcripts: `~/.codex/sessions/`
	 * (or `<override>/sessions` when `CODEX_HOME` is set).
	 *
	 * **Test override priority**:
	 *   1. `STORY_TEST_CODEX_SESSION_DIR` (Story preferred)
	 *   2. `ENTIRE_TEST_CODEX_SESSION_DIR` (back-compat read fallback)
	 *   3. `CODEX_HOME` env / `~/.codex`
	 *
	 * Note: actual transcript files live under `<dir>/YYYY/MM/DD/rollout-...jsonl`,
	 * so {@link resolveSessionFile} does the date-path glob.
	 */
	async getSessionDir(_repoPath: string): Promise<string> {
		const override =
			process.env.STORY_TEST_CODEX_SESSION_DIR ?? process.env.ENTIRE_TEST_CODEX_SESSION_DIR;
		if (override !== undefined && override !== '') {
			return override;
		}
		const codexHome = await resolveCodexHome();
		return path.join(codexHome, 'sessions');
	}

	/**
	 * Resolve a session transcript file path:
	 *
	 *   1. If `agentSessionId` is absolute → return as-is (Codex hook
	 *      payloads carry full `transcript_path`)
	 *   2. Else glob 3 patterns via {@link findRolloutBySessionID}
	 *   3. Else fall back to `<sessionDir>/<id>.jsonl`
	 *
	 * Returns `agentSessionId` itself when both `sessionDir` and glob fail
	 * (matches Go `codex.go:99` `return agentSessionID`).
	 */
	async resolveSessionFile(sessionDir: string, agentSessionId: string): Promise<string> {
		if (path.isAbsolute(agentSessionId)) {
			return agentSessionId;
		}
		const found = await findRolloutBySessionID(sessionDir, agentSessionId);
		if (found !== '') {
			return found;
		}
		if (sessionDir !== '') {
			return path.join(sessionDir, `${agentSessionId}.jsonl`);
		}
		return agentSessionId;
	}

	/**
	 * Resolve the canonical rollout path for a restored session so
	 * `codex resume <id>` can rediscover it. Parses session_meta timestamp
	 * from transcript bytes and builds `<dir>/YYYY/MM/DD/rollout-<ts>-<id>.jsonl`.
	 *
	 * Mirrors Go `codex.go: ResolveRestoredSessionFile`.
	 *
	 * @throws Error when sessionId is invalid or transcript is malformed.
	 */
	async resolveRestoredSessionFile(
		sessionDir: string,
		agentSessionId: string,
		transcript: Uint8Array,
	): Promise<string> {
		const validateErr = validateAgentSessionID(agentSessionId);
		if (validateErr !== null) {
			throw new Error(`validate agent session ID: ${validateErr.message}`, {
				cause: validateErr,
			});
		}
		let startTime: Date;
		try {
			startTime = parseSessionStartTime(transcript);
		} catch (err) {
			throw new Error(`parse session start time: ${(err as Error).message}`, {
				cause: err as Error,
			});
		}
		return restoredRolloutPath(sessionDir, agentSessionId, startTime);
	}

	/**
	 * Read raw JSONL transcript bytes from `input.sessionRef`. Parses
	 * session_meta for `startTime` and scans every line for apply_patch
	 * file paths (deduplicated, first-occurrence order).
	 *
	 * @example
	 * await codex.readSession({ sessionId: 'sid', sessionRef: '/p.jsonl', ... });
	 * // returns: { sessionId, agentName: 'codex', sessionRef, startTime: <session_meta.timestamp>,
	 * //           nativeData: <raw bytes>, modifiedFiles: [...] }
	 *
	 * // Side effects: read-only fs.readFile.
	 *
	 * @throws Error when sessionRef is empty, file unreadable, or first
	 *   transcript line is not session_meta.
	 */
	async readSession(input: HookInput): Promise<AgentSession> {
		if (!input.sessionRef) {
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
		const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
		let startTime: Date;
		try {
			startTime = parseSessionStartTime(bytes);
		} catch (err) {
			throw new Error(`failed to parse session start time: ${(err as Error).message}`, {
				cause: err as Error,
			});
		}

		const seen = new Set<string>();
		const modifiedFiles: string[] = [];
		for (const lineData of splitJSONL(bytes)) {
			for (const f of extractFilesFromLine(lineData)) {
				if (!seen.has(f)) {
					seen.add(f);
					modifiedFiles.push(f);
				}
			}
		}

		return {
			sessionId: input.sessionId,
			agentName: this.name(),
			repoPath: '',
			sessionRef: input.sessionRef,
			startTime,
			nativeData: bytes,
			modifiedFiles,
			newFiles: [],
			deletedFiles: [],
			entries: [],
		};
	}

	/**
	 * Write a Codex transcript back to disk. Validates: non-null session;
	 * matching agentName; non-empty sessionRef + nativeData. Sanitizes
	 * encrypted reasoning fragments + drops compaction lines via
	 * {@link sanitizeRestoredTranscript} before writing (mode `0o600`).
	 *
	 * @example
	 * await codex.writeSession({ sessionId, agentName: 'codex',
	 *   sessionRef: '/path.jsonl', nativeData: bytes, ... });
	 *
	 * // Side effects:
	 * //   <sessionRef>  ← overwritten with sanitized bytes (mode 0o600)
	 * //   parent dir / index / HEAD: unchanged (caller must ensure parent exists)
	 *
	 * @throws Error on null session / agent mismatch / empty sessionRef /
	 *   empty nativeData / fs.writeFile failure.
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
		if (!session.nativeData || session.nativeData.length === 0) {
			throw new Error('session has no native data to write');
		}
		const dataToWrite = sanitizeRestoredTranscript(session.nativeData);
		try {
			await fs.writeFile(session.sessionRef, dataToWrite, { mode: 0o600 });
		} catch (err) {
			throw new Error(`failed to write transcript: ${(err as Error).message}`, {
				cause: err as Error,
			});
		}
	}

	/** Returns the command to resume a Codex session. */
	formatResumeCommand(sessionId: string): string {
		return `codex resume ${sessionId}`;
	}

	/** Read raw JSONL transcript bytes for a session. */
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

	async chunkTranscript(content: Uint8Array, maxSize: number): Promise<Uint8Array[]> {
		try {
			return chunkJSONL(content, maxSize);
		} catch (err) {
			throw new Error(`failed to chunk JSONL transcript: ${(err as Error).message}`, {
				cause: err as Error,
			});
		}
	}

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
		return parseHookEventImpl(hookName, stdin, ctx);
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

	async writeHookResponse(message: string): Promise<void> {
		return writeHookResponseImpl(message);
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

	calculateTokenUsage(transcriptData: Uint8Array, fromOffset: number): TokenUsage | null {
		return calculateTokenUsageImpl(transcriptData, fromOffset);
	}

	async extractPrompts(sessionRef: string, fromOffset: number): Promise<string[]> {
		return extractPromptsImpl(sessionRef, fromOffset);
	}
}

/**
 * Build the canonical rollout path for a restored session.
 * Format: `<codexHome>/YYYY/MM/DD/rollout-YYYY-MM-DDTHH-MM-SS-<sessionId>.jsonl`.
 *
 * Uses UTC components (matches Go `codex.go: restoredRolloutPath` which
 * does `startTime.UTC().Format(...)`).
 */
export function restoredRolloutPath(
	codexHome: string,
	agentSessionId: string,
	startTime: Date,
): string {
	const yyyy = startTime.getUTCFullYear().toString();
	const mm = String(startTime.getUTCMonth() + 1).padStart(2, '0');
	const dd = String(startTime.getUTCDate()).padStart(2, '0');
	const HH = String(startTime.getUTCHours()).padStart(2, '0');
	const MM = String(startTime.getUTCMinutes()).padStart(2, '0');
	const SS = String(startTime.getUTCSeconds()).padStart(2, '0');
	const ts = `${yyyy}-${mm}-${dd}T${HH}-${MM}-${SS}`;
	const datePath = path.join(codexHome, yyyy, mm, dd);
	const filename = `rollout-${ts}-${agentSessionId}.jsonl`;
	return path.join(datePath, filename);
}

/**
 * Glob 3 patterns for a session-id-tagged rollout file; return
 * lexicographically-latest match. Returns `''` if none found OR if
 * sessionID validation fails (invalid characters, etc.).
 *
 * **3 glob patterns** (matches Go `codex.go: findRolloutBySessionID`):
 *
 *   1. `<codexHome>/rollout-*-<sid>.jsonl`        — flat layout (legacy)
 *   2. `<codexHome>/* / * / * /rollout-*-<sid>.jsonl`  — date layout (current)
 *   3. `<parentOf(codexHome)>/archived_sessions/* / * / * /rollout-*-<sid>.jsonl`
 *      — Codex auto-archived sessions
 *
 * Lexicographic sort ensures newest dated path wins on multiple matches.
 *
 * @example
 * await findRolloutBySessionID('/home/.codex/sessions', 'abc123');
 * // returns: '/home/.codex/sessions/2026/04/20/rollout-2026-04-20T15-30-45-abc123.jsonl'
 *
 * await findRolloutBySessionID('/home/.codex/sessions', 'never-existed');
 * // returns: ''
 *
 * await findRolloutBySessionID('/home/.codex/sessions', '../bad/id');
 * // returns: '' (validateAgentSessionID rejection)
 *
 * // Side effects: read-only fs.readdir (recursive, up to 4 levels).
 */
export async function findRolloutBySessionID(
	codexHome: string,
	agentSessionId: string,
): Promise<string> {
	if (codexHome === '') {
		return '';
	}
	if (validateAgentSessionID(agentSessionId) !== null) {
		return '';
	}
	const suffix = `-${agentSessionId}.jsonl`;
	const filenameMatches = (name: string): boolean =>
		name.startsWith('rollout-') && name.endsWith(suffix);

	const matches: string[] = [];

	// Pattern 1: flat layout `<codexHome>/rollout-*-<sid>.jsonl`
	try {
		const entries = await fs.readdir(codexHome, { withFileTypes: true });
		for (const e of entries) {
			if (e.isFile() && filenameMatches(e.name)) {
				matches.push(path.join(codexHome, e.name));
			}
		}
	} catch {
		// readdir failure → skip this pattern
	}
	if (matches.length > 0) {
		matches.sort();
		return matches[matches.length - 1] as string;
	}

	// Pattern 2: 3-level date layout `<codexHome>/YYYY/MM/DD/rollout-*-<sid>.jsonl`
	const dateMatches = await collectGlob3(codexHome, filenameMatches);
	if (dateMatches.length > 0) {
		dateMatches.sort();
		return dateMatches[dateMatches.length - 1] as string;
	}

	// Pattern 3: archived `<parentOf(codexHome)>/archived_sessions/Y/M/D/rollout-*-<sid>.jsonl`
	const archivedRoot = path.join(path.dirname(codexHome), 'archived_sessions');
	const archivedMatches = await collectGlob3(archivedRoot, filenameMatches);
	if (archivedMatches.length > 0) {
		archivedMatches.sort();
		return archivedMatches[archivedMatches.length - 1] as string;
	}

	return '';
}

/**
 * Walk exactly 3 directory levels (`<root>/A/B/C/file`) and collect files
 * whose basename matches `predicate`. Used to implement Codex's
 * `YYYY/MM/DD/` glob without depending on `node:fs/promises.glob` (which
 * is experimental in Node ≤ 22).
 */
async function collectGlob3(root: string, predicate: (name: string) => boolean): Promise<string[]> {
	const out: string[] = [];
	let level1: string[];
	try {
		const entries = await fs.readdir(root, { withFileTypes: true });
		level1 = entries.filter((e) => e.isDirectory()).map((e) => path.join(root, e.name));
	} catch {
		return out;
	}
	for (const l1 of level1) {
		let level2: string[];
		try {
			const entries = await fs.readdir(l1, { withFileTypes: true });
			level2 = entries.filter((e) => e.isDirectory()).map((e) => path.join(l1, e.name));
		} catch {
			continue;
		}
		for (const l2 of level2) {
			let level3: string[];
			try {
				const entries = await fs.readdir(l2, { withFileTypes: true });
				level3 = entries.filter((e) => e.isDirectory()).map((e) => path.join(l2, e.name));
			} catch {
				continue;
			}
			for (const l3 of level3) {
				try {
					const files = await fs.readdir(l3, { withFileTypes: true });
					for (const f of files) {
						if (f.isFile() && predicate(f.name)) {
							out.push(path.join(l3, f.name));
						}
					}
				} catch {
					// skip
				}
			}
		}
	}
	return out;
}

/**
 * Factory for the Codex agent. Mirrors Go `NewCodexAgent`.
 *
 * Returns a fresh instance each call (registry holds the factory, not the
 * instance). Used by `src/agent/bootstrap.ts: registerBuiltinAgents()` to
 * wire Codex into the registry; not auto-registered (no module-level side
 * effects — see [`AGENTS.md` §异步/模块边界](../../../AGENTS.md)).
 */
export function codexAgent(): Agent {
	return new CodexAgent();
}
