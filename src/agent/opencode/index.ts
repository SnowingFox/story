/**
 * OpenCode agent — Identity / detection / I/O / chunking / path helpers + factory.
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/agent/opencode/opencode.go`
 * (`OpenCodeAgent` struct + 13 mandatory `Agent` methods + `nonAlphanumericRegex`
 * + `SanitizePathForOpenCode`).
 *
 * **Registration**: handled by [`src/agent/bootstrap.ts:
 * registerBuiltinAgents()`](../bootstrap.ts), called from `src/cli.ts:
 * run()` at startup. This module exports the {@link opencodeAgent} factory
 * only — no module-level side effects (see [`AGENTS.md`
 * §异步/模块边界](../../../AGENTS.md)).
 *
 * **Capabilities composed in via separate modules** (see Phase 6.7 module.md):
 * - {@link Agent} (mandatory identity + storage + session methods, here)
 * - `HookSupport` — methods land in `./hooks` + `./lifecycle`
 * - `TranscriptAnalyzer` / `PromptExtractor` / `TokenCalculator` — `./transcript`
 *   + `./lifecycle`
 * - `TranscriptPreparer` — `./lifecycle`
 *
 * **Capabilities NOT implemented** (Go upstream doesn't): `SubagentAwareExtractor`,
 * `HookResponseWriter`, `TextGenerator`, `RestoredSessionPathResolver`,
 * `FileWatcher`, `SessionBaseDirProvider`, `TestOnly`. See module.md for
 * per-capability rationale.
 *
 * @packageDocumentation
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Event } from '@/agent/event';
import type { Agent, HookSupport, TranscriptPreparer } from '@/agent/interfaces';
import type { AgentSession, HookInput } from '@/agent/session';
import {
	AGENT_NAME_OPENCODE,
	AGENT_TYPE_OPENCODE,
	type AgentName,
	type AgentType,
} from '@/agent/types';
import * as log from '@/log';
import { worktreeRoot } from '@/paths';
import { runOpenCodeImport, runOpenCodeSessionDelete } from './cli-commands';
import {
	areHooksInstalled as areHooksInstalledImpl,
	installHooks as installHooksImpl,
	uninstallHooks as uninstallHooksImpl,
} from './hooks';
import {
	hookNames as hookNamesImpl,
	parseHookEvent as parseHookEventImpl,
	prepareTranscript as prepareTranscriptImpl,
} from './lifecycle';
import type { ExportMessage, ExportSession, SessionInfo } from './types';

const LOG_CTX = { component: 'agent.opencode' } as const;

/**
 * Regex matching any non-alphanumeric character (ASCII).
 * Mirrors Go `opencode.go: nonAlphanumericRegex = regexp.MustCompile([^a-zA-Z0-9])`.
 *
 * **Note vs Cursor**: Cursor's sanitizer trims leading `/` first; OpenCode does
 * NOT (Go: `nonAlphanumericRegex.ReplaceAllString` operates on the full path),
 * so `/Users/...` becomes `-Users-...` in OpenCode but `Users-...` in Cursor.
 */
const NON_ALPHANUMERIC_REGEX = /[^a-zA-Z0-9]/g;

/**
 * Convert a path to a safe directory name by replacing every non-alphanumeric
 * character with `-`.
 *
 * Mirrors Go `opencode.go: SanitizePathForOpenCode`. Used by {@link
 * OpenCodeAgent.getSessionDir} to compute the per-repo subdirectory under
 * `os.tmpdir() + 'story-opencode/'`.
 *
 * @example
 * sanitizePathForOpenCode('/Users/me/proj');     // '-Users-me-proj'
 * sanitizePathForOpenCode('simple');             // 'simple'
 * sanitizePathForOpenCode('/path/with spaces');  // '-path-with-spaces'
 */
export function sanitizePathForOpenCode(p: string): string {
	return p.replace(NON_ALPHANUMERIC_REGEX, '-');
}

/**
 * OpenCode agent. Implements the mandatory {@link Agent} contract; optional
 * capability methods are composed in by `./hooks`, `./lifecycle`, and
 * `./transcript` modules (see {@link opencodeAgent} factory).
 *
 * Use {@link opencodeAgent} factory; do not instantiate directly.
 *
 * Mirrors Go `opencode.go: OpenCodeAgent` struct + methods.
 */
export class OpenCodeAgent implements Agent, HookSupport, TranscriptPreparer {
	name(): AgentName {
		return AGENT_NAME_OPENCODE;
	}
	type(): AgentType {
		return AGENT_TYPE_OPENCODE;
	}
	description(): string {
		return 'OpenCode - AI-powered terminal coding agent';
	}
	isPreview(): boolean {
		return true;
	}
	protectedDirs(): string[] {
		return ['.opencode'];
	}

	/**
	 * Detect whether OpenCode is configured in the repo.
	 *
	 * Returns `true` if either `<repoRoot>/.opencode/` or `<repoRoot>/opencode.json`
	 * exists. Falls back to `false` on any other fs error (matches Go: returns
	 * `(false, nil)` from any stat error).
	 *
	 * @example
	 * await agent.detectPresence();
	 * // .opencode/ present                     → true
	 * // opencode.json present                  → true
	 * // neither present                        → false
	 * // worktreeRoot fails (non-git cwd)       → falls back to '.'; checks ./.opencode + ./opencode.json
	 *
	 * // Side effects: fs.stat ×2 at most (read-only).
	 */
	async detectPresence(): Promise<boolean> {
		let repoRoot: string;
		try {
			repoRoot = await worktreeRoot();
		} catch {
			repoRoot = '.';
		}
		try {
			await fs.stat(path.join(repoRoot, '.opencode'));
			return true;
		} catch {
			// fall through to opencode.json check
		}
		try {
			await fs.stat(path.join(repoRoot, 'opencode.json'));
			return true;
		} catch {
			return false;
		}
	}

	getSessionID(input: HookInput): string {
		return input.sessionId;
	}

	/**
	 * Where Story stores OpenCode session export JSON for the given repo.
	 *
	 * **Test override**: `STORY_TEST_OPENCODE_PROJECT_DIR` (preferred) +
	 * `ENTIRE_TEST_OPENCODE_PROJECT_DIR` (read fallback for back-compat with
	 * the shared Go/TS e2e harness). When set, returns the override directly.
	 *
	 * **Default**: `os.tmpdir() + '/story-opencode/' + sanitizePathForOpenCode(repoPath)`.
	 * OpenCode session transcripts are ephemeral handoff files between the TS
	 * plugin and the hook handler; once checkpointed, the data lives on git
	 * refs and the file is disposable. Stored under `os.tmpdir()` to avoid
	 * squatting on OpenCode's own directories.
	 *
	 * Mirrors Go `opencode.go: GetSessionDir`. Story rebrand: `entire-opencode`
	 * → `story-opencode`.
	 */
	async getSessionDir(repoPath: string): Promise<string> {
		const override =
			process.env.STORY_TEST_OPENCODE_PROJECT_DIR ?? process.env.ENTIRE_TEST_OPENCODE_PROJECT_DIR;
		if (override !== undefined && override !== '') {
			return override;
		}
		return path.join(os.tmpdir(), 'story-opencode', sanitizePathForOpenCode(repoPath));
	}

	/**
	 * Resolve the on-disk JSON export path. Pure path computation
	 * (`<sessionDir>/<agentSessionId>.json`); no fs access. Mirrors Go
	 * `opencode.go: ResolveSessionFile`.
	 */
	resolveSessionFile(sessionDir: string, agentSessionId: string): string {
		return path.join(sessionDir, `${agentSessionId}.json`);
	}

	/**
	 * Read raw bytes from the OpenCode export JSON file.
	 *
	 * @example
	 * await agent.readTranscript('/tmp/story-opencode/.../sess.json');
	 * // returns: Uint8Array of bytes
	 *
	 * await agent.readTranscript('/nonexistent.json');
	 * // throws: 'failed to read opencode transcript: ENOENT...'
	 *
	 * // Side effects: fs.readFile only (read-only).
	 */
	async readTranscript(sessionRef: string): Promise<Uint8Array> {
		try {
			const buf = await fs.readFile(sessionRef);
			return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
		} catch (err) {
			throw new Error(`failed to read opencode transcript: ${(err as Error).message}`, {
				cause: err as Error,
			});
		}
	}

	/**
	 * Distribute messages of an `opencode export` JSON object across chunks
	 * each ≤ `maxSize` bytes.
	 *
	 * **Algorithm** (Go-aligned):
	 * 1. Parse `{info, messages}`.
	 * 2. If `messages` is empty → return `[content]` as-is.
	 * 3. Compute `baseSize = '{"info":'.length + JSON.stringify(info).length +
	 *    ',"messages":[]'.length + '}'.length`.
	 * 4. For each message: marshal to JSON, add 1 byte for comma. If adding
	 *    overflows current chunk and current is non-empty, flush + reset.
	 * 5. Append last chunk.
	 *
	 * **Throws**:
	 * - invalid JSON → `'failed to parse export session for chunking'`
	 * - JSON marshal of inner data fails → `'failed to marshal ... for chunking'`
	 *
	 * Mirrors Go `opencode.go: ChunkTranscript`. Note Go does NOT error on
	 * single-message-too-large; it just flushes the previous chunk and starts
	 * a new chunk with the oversized message alone (which may exceed maxSize).
	 * Story matches this behavior — chunkers are best-effort, not strict caps.
	 */
	async chunkTranscript(content: Uint8Array, maxSize: number): Promise<Uint8Array[]> {
		const text = new TextDecoder('utf-8').decode(content);
		let session: ExportSession;
		try {
			session = JSON.parse(text) as ExportSession;
		} catch (err) {
			throw new Error(`failed to parse export session for chunking: ${(err as Error).message}`, {
				cause: err as Error,
			});
		}
		if (!Array.isArray(session.messages) || session.messages.length === 0) {
			return [content];
		}

		const enc = new TextEncoder();
		const infoStr = JSON.stringify(session.info);
		// Base structure: {"info":<info>,"messages":[]}  → 19 + len(info) base chars.
		// Match Go `len(\`{"info":\`) + len(infoBytes) + len(\`,"messages":[]}\`)`.
		const baseSize = '{"info":'.length + infoStr.length + ',"messages":[]}'.length;

		const chunks: Uint8Array[] = [];
		let currentMessages: ExportMessage[] = [];
		let currentSize = baseSize;

		const flush = (msgs: ExportMessage[]): void => {
			const chunkObj: ExportSession = { info: session.info, messages: msgs };
			chunks.push(enc.encode(JSON.stringify(chunkObj)));
		};

		for (const msg of session.messages) {
			const msgStr = JSON.stringify(msg);
			const msgSize = msgStr.length + 1; // +1 for comma
			if (currentSize + msgSize > maxSize && currentMessages.length > 0) {
				flush(currentMessages);
				currentMessages = [];
				currentSize = baseSize;
			}
			currentMessages.push(msg);
			currentSize += msgSize;
		}

		if (currentMessages.length > 0) {
			flush(currentMessages);
		}

		if (chunks.length === 0) {
			throw new Error('failed to create any chunks');
		}
		return chunks;
	}

	/**
	 * Merge OpenCode export JSON chunks back into a single object.
	 *
	 * Combines all `messages` arrays in order; uses {@link SessionInfo} from
	 * the first chunk only. Mirrors Go `opencode.go: ReassembleTranscript`.
	 *
	 * **Throws**:
	 * - empty chunks → `'no chunks to reassemble'`
	 * - invalid chunk JSON → `'failed to unmarshal chunk N'`
	 */
	async reassembleTranscript(chunks: Uint8Array[]): Promise<Uint8Array> {
		if (chunks.length === 0) {
			throw new Error('no chunks to reassemble');
		}
		const dec = new TextDecoder('utf-8');
		let sessionInfo: SessionInfo = { id: '' };
		const allMessages: ExportMessage[] = [];
		for (let i = 0; i < chunks.length; i++) {
			let parsed: ExportSession;
			try {
				parsed = JSON.parse(dec.decode(chunks[i]!)) as ExportSession;
			} catch (err) {
				throw new Error(`failed to unmarshal chunk ${i}: ${(err as Error).message}`, {
					cause: err as Error,
				});
			}
			if (i === 0) {
				sessionInfo = parsed.info;
			}
			if (Array.isArray(parsed.messages)) {
				for (const m of parsed.messages) {
					allMessages.push(m);
				}
			}
		}
		const result: ExportSession = { info: sessionInfo, messages: allMessages };
		return new TextEncoder().encode(JSON.stringify(result));
	}

	/**
	 * Read session bytes from the export JSON file. Returns an
	 * {@link AgentSession} with `nativeData` populated; `modifiedFiles` /
	 * `entries` etc. are computed by `./transcript` helpers when called via
	 * `TranscriptAnalyzer` capability dispatch.
	 *
	 * Currently leaves `modifiedFiles` empty — the bytes-based extraction
	 * helper from `./transcript` is invoked by the framework's
	 * `TranscriptAnalyzer.extractModifiedFilesFromOffset` path. Matches Go's
	 * pattern of returning the session and letting downstream callers hit
	 * `ExtractModifiedFiles(data)` separately when needed.
	 *
	 * @example
	 * await agent.readSession({ sessionId: 'sess', sessionRef: '/tmp/.../sess.json', ... });
	 * // returns: { sessionId, agentName: 'opencode', sessionRef, nativeData, ... }
	 *
	 * await agent.readSession({ sessionRef: '' });
	 * // throws: 'no session ref provided'
	 *
	 * // Side effects: fs.readFile only (read-only).
	 */
	async readSession(input: HookInput): Promise<AgentSession | null> {
		if (input.sessionRef === '') {
			throw new Error('no session ref provided');
		}
		let data: Buffer;
		try {
			data = await fs.readFile(input.sessionRef);
		} catch (err) {
			throw new Error(`failed to read session: ${(err as Error).message}`, {
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
	 * Restore a session into OpenCode's database (Phase 5.5 RestoreLogsOnly path).
	 *
	 * Strategy mirrors Go `opencode.go: WriteSession` →
	 * `importSessionIntoOpenCode`:
	 * 1. Run `opencode session delete <id>` (best-effort; missing session
	 *    swallowed by {@link runOpenCodeSessionDelete}). OpenCode's `import`
	 *    uses `ON CONFLICT DO NOTHING`, which would skip existing messages
	 *    without this step (breaking rewind).
	 * 2. Write `nativeData` to a temp file (`mkstemp 'story-opencode-export-*.json'`).
	 * 3. Run `opencode import <tmpFile>`.
	 * 4. Delete the temp file (finally).
	 *
	 * **Throws**:
	 * - null session → `'nil session'`
	 * - empty NativeData → `'no session data to write'`
	 * - any underlying CLI subprocess failure (propagated from `./cli-commands`)
	 *
	 * @example
	 * await agent.writeSession({ sessionId: 'sess', nativeData: bytes, ... });
	 *
	 * // Side effects:
	 * //   `opencode session delete sess` invoked (no-throw on missing)
	 * //   <os.tmpdir()>/story-opencode-export-XXXXXX.json ← bytes (mode 0o600)
	 * //   `opencode import <tmpFile>` invoked
	 * //   <tmpFile> ← removed in finally
	 * //
	 * // OpenCode SQLite database (~/.opencode/storage/): updated by import.
	 */
	async writeSession(session: AgentSession): Promise<void> {
		if (session === null || session === undefined) {
			throw new Error('nil session');
		}
		if (session.nativeData.length === 0) {
			throw new Error('no session data to write');
		}
		const ctrl = new AbortController();
		try {
			await runOpenCodeSessionDelete(ctrl.signal, session.sessionId);
		} catch (err) {
			// Non-fatal: session may not exist (first import) or the CLI may have
			// returned an error we don't recognize. Match Go's logging.Warn pattern.
			log.warn(LOG_CTX, 'could not delete existing opencode session', {
				sessionId: session.sessionId,
				error: (err as Error).message,
			});
		}

		// mkstemp equivalent: tmpdir + 'story-opencode-export-<rand>.json'
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'story-opencode-export-'));
		const tmpFile = path.join(tmpDir, 'export.json');
		try {
			await fs.writeFile(tmpFile, session.nativeData, { mode: 0o600 });
			await runOpenCodeImport(ctrl.signal, tmpFile);
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	}

	/**
	 * Shell command to resume an OpenCode session.
	 *
	 * Empty / whitespace sessionID → bare `'opencode'` (interactive launcher).
	 * Otherwise → `'opencode -s <id>'`.
	 *
	 * Mirrors Go `opencode.go: FormatResumeCommand`.
	 */
	formatResumeCommand(sessionID: string): string {
		if (sessionID.trim() === '') {
			return 'opencode';
		}
		return `opencode -s ${sessionID}`;
	}

	/**
	 * Hook verbs OpenCode supports — become subcommands under
	 * `story hooks opencode <verb>`.
	 *
	 * Mirrors Go `OpenCodeAgent.HookNames`.
	 */
	hookNames(): string[] {
		return hookNamesImpl();
	}

	/**
	 * Translate an OpenCode hook payload into a normalized {@link Event}.
	 * Returns `null` for unknown verbs.
	 *
	 * Mirrors Go `OpenCodeAgent.ParseHookEvent`.
	 */
	async parseHookEvent(hookName: string, stdin: NodeJS.ReadableStream): Promise<Event | null> {
		return parseHookEventImpl.call(this, hookName, stdin);
	}

	/**
	 * Install the OpenCode Story plugin to `<repoRoot>/.opencode/plugins/story.ts`.
	 * Returns count installed (`0` idempotent, `1` written or rewritten).
	 *
	 * Mirrors Go `OpenCodeAgent.InstallHooks`.
	 */
	async installHooks(opts: { localDev: boolean; force: boolean }): Promise<number> {
		return installHooksImpl(opts);
	}

	/** Remove the Story plugin file. No-op when missing. */
	async uninstallHooks(): Promise<void> {
		return uninstallHooksImpl();
	}

	/** Whether the Story plugin is installed (file exists with Story marker). */
	async areHooksInstalled(): Promise<boolean> {
		return areHooksInstalledImpl();
	}

	/**
	 * Refresh the OpenCode export cache by forking `opencode export <sid>`.
	 * Required before condensation reads the transcript (mid-turn commits +
	 * resumed sessions need fresh data).
	 *
	 * Mirrors Go `OpenCodeAgent.PrepareTranscript`.
	 */
	async prepareTranscript(sessionRef: string): Promise<void> {
		return prepareTranscriptImpl.call(this, sessionRef);
	}
}

/**
 * Factory for the OpenCode agent. Mirrors Go `NewOpenCodeAgent`.
 *
 * Returns a fresh instance each call (registry holds the factory, not the
 * instance). Wired into the registry by `src/agent/bootstrap.ts:
 * registerBuiltinAgents()`; not auto-registered (no module-level side
 * effects — see [`AGENTS.md` §异步/模块边界](../../../AGENTS.md)).
 */
export function opencodeAgent(): Agent {
	return new OpenCodeAgent();
}
