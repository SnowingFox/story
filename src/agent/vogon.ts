/**
 * Vogon — deterministic test-only canary agent. Named after the Vogons from
 * The Hitchhiker's Guide to the Galaxy: bureaucratic, procedural, and
 * deterministic to a fault.
 *
 * Implements `Agent` + `HookSupport` + `HookResponseWriter` + `TestOnly`.
 * Self-registers via top-level side-effect (TS equivalent of Go `init()`).
 *
 * **Excluded from production**:
 * - {@link VogonAgent.detectPresence} returns `false` always → never auto-detected
 * - {@link VogonAgent.isTestOnly} returns `true` → excluded from
 *   `registry.stringList()` so `story enable` candidate list doesn't show it
 *
 * **Test session dir**: respects `STORY_TEST_VOGON_PROJECT_DIR` env var
 * (with `ENTIRE_TEST_VOGON_PROJECT_DIR` back-compat fallback). Default is
 * `~/.vogon/sessions` (Vogon dir kept as-is — not a brand).
 *
 * Mirrors Go `cmd/entire/cli/agent/vogon/{vogon,hooks}.go`.
 *
 * @packageDocumentation
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { match } from 'ts-pattern';
import { chunkJSONL, reassembleJSONL } from './chunking';
import {
	EVENT_TYPE_SESSION_END,
	EVENT_TYPE_SESSION_START,
	EVENT_TYPE_TURN_END,
	EVENT_TYPE_TURN_START,
	type Event,
	readAndParseHookInput,
} from './event';
import type { Agent, HookResponseWriter, HookSupport, TestOnly } from './interfaces';
import type { AgentSession, HookInput } from './session';
import type { AgentName, AgentType } from './types';

/** Vogon registry key. Mirrors Go `vogon.AgentNameVogon`. */
export const AGENT_NAME_VOGON = 'vogon' as AgentName;

/** Vogon display type. Mirrors Go `vogon.AgentTypeVogon`. */
export const AGENT_TYPE_VOGON = 'Vogon Agent' as AgentType;

/** Vogon hook verbs — same names as Go (`vogon/hooks.go:19-24`). */
export const HOOK_NAME_SESSION_START = 'session-start' as const;
export const HOOK_NAME_SESSION_END = 'session-end' as const;
export const HOOK_NAME_STOP = 'stop' as const;
export const HOOK_NAME_USER_PROMPT_SUBMIT = 'user-prompt-submit' as const;

/** Hook input JSON shape for session-start / stop / session-end. Mirrors Go
 *  `vogon/hooks.go: sessionInfoRaw`. */
interface SessionInfoRaw {
	session_id: string;
	transcript_path: string;
	model?: string;
}

/** Hook input JSON shape for user-prompt-submit. Mirrors Go
 *  `vogon/hooks.go: userPromptSubmitRaw`. */
interface UserPromptSubmitRaw extends SessionInfoRaw {
	prompt: string;
}

/**
 * Vogon test-only agent. Implements 4 interfaces (compile-time guards via
 * `implements`):
 * - {@link Agent} (mandatory)
 * - {@link HookSupport} (4-hook routing)
 * - {@link HookResponseWriter} (writes plain stdout)
 * - {@link TestOnly} (`isTestOnly() === true`)
 *
 * Mirrors Go `vogon.Agent` struct + methods.
 */
export class VogonAgent implements Agent, HookSupport, HookResponseWriter, TestOnly {
	name(): AgentName {
		return AGENT_NAME_VOGON;
	}
	type(): AgentType {
		return AGENT_TYPE_VOGON;
	}
	description(): string {
		return 'Vogon Agent - deterministic E2E canary (no API calls)';
	}
	isPreview(): boolean {
		return false;
	}
	async detectPresence(): Promise<boolean> {
		// Never auto-detected (Go: vogon.go:45).
		return false;
	}
	protectedDirs(): string[] {
		return ['.vogon'];
	}
	isTestOnly(): boolean {
		return true;
	}

	async readTranscript(sessionRef: string): Promise<Uint8Array> {
		try {
			const data = await fs.readFile(sessionRef);
			return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
		} catch (e) {
			throw new Error(`read transcript: ${(e as Error).message}`, {
				cause: e as Error,
			});
		}
	}

	async chunkTranscript(content: Uint8Array, maxSize: number): Promise<Uint8Array[]> {
		try {
			return chunkJSONL(content, maxSize);
		} catch (e) {
			throw new Error(`chunk transcript: ${(e as Error).message}`, {
				cause: e as Error,
			});
		}
	}

	async reassembleTranscript(chunks: Uint8Array[]): Promise<Uint8Array> {
		return reassembleJSONL(chunks);
	}

	getSessionID(input: HookInput): string {
		return input.sessionId;
	}

	/**
	 * Where Vogon stores session data. Story-side env override:
	 * `STORY_TEST_VOGON_PROJECT_DIR` (preferred) →
	 * `ENTIRE_TEST_VOGON_PROJECT_DIR` (back-compat) →
	 * `~/.vogon/sessions` (Go default).
	 *
	 * Mirrors Go `vogon.go:76-85` with brand rebrand for the env var.
	 */
	async getSessionDir(_repoPath: string): Promise<string> {
		const override =
			process.env.STORY_TEST_VOGON_PROJECT_DIR ?? process.env.ENTIRE_TEST_VOGON_PROJECT_DIR;
		if (override !== undefined && override !== '') {
			return override;
		}
		return path.join(os.homedir(), '.vogon', 'sessions');
	}

	resolveSessionFile(sessionDir: string, agentSessionId: string): string {
		return path.join(sessionDir, `${agentSessionId}.jsonl`);
	}

	async readSession(input: HookInput): Promise<AgentSession | null> {
		if (input.sessionRef === '') {
			throw new Error('session reference (transcript path) is required');
		}
		try {
			const data = await fs.readFile(input.sessionRef);
			return {
				sessionId: input.sessionId,
				agentName: this.name(),
				repoPath: '',
				sessionRef: input.sessionRef,
				startTime: new Date(0),
				nativeData: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
				modifiedFiles: [],
				newFiles: [],
				deletedFiles: [],
				entries: [],
			};
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
				// Transcript may not exist yet — return empty session (Go: vogon.go:97-104).
				return {
					sessionId: input.sessionId,
					agentName: this.name(),
					repoPath: '',
					sessionRef: input.sessionRef,
					startTime: new Date(0),
					nativeData: new Uint8Array(),
					modifiedFiles: [],
					newFiles: [],
					deletedFiles: [],
					entries: [],
				};
			}
			throw new Error(`read transcript: ${(e as Error).message}`, {
				cause: e as Error,
			});
		}
	}

	async writeSession(session: AgentSession): Promise<void> {
		if (session.sessionRef === '') {
			throw new Error('session reference is required');
		}
		try {
			await fs.mkdir(path.dirname(session.sessionRef), { recursive: true, mode: 0o750 });
		} catch (e) {
			throw new Error(`create session dir: ${(e as Error).message}`, {
				cause: e as Error,
			});
		}
		try {
			await fs.writeFile(session.sessionRef, session.nativeData, { mode: 0o600 });
		} catch (e) {
			throw new Error(`write session: ${(e as Error).message}`, {
				cause: e as Error,
			});
		}
	}

	formatResumeCommand(sessionId: string): string {
		return `vogon --session-id ${sessionId}`;
	}

	hookNames(): string[] {
		return [
			HOOK_NAME_SESSION_START,
			HOOK_NAME_SESSION_END,
			HOOK_NAME_STOP,
			HOOK_NAME_USER_PROMPT_SUBMIT,
		];
	}

	/**
	 * Translate Vogon hook JSON → normalized {@link Event}. Mirrors Go
	 * `vogon/hooks.go: ParseHookEvent`. Uses `ts-pattern.match` to enforce
	 * exhaustive routing (Go uses switch + default → nil).
	 */
	async parseHookEvent(hookName: string, stdin: NodeJS.ReadableStream): Promise<Event | null> {
		return match(hookName)
			.with(HOOK_NAME_SESSION_START, async () => {
				const raw = await readAndParseHookInput<SessionInfoRaw>(stdin);
				return makeEvent(EVENT_TYPE_SESSION_START, raw);
			})
			.with(HOOK_NAME_USER_PROMPT_SUBMIT, async () => {
				const raw = await readAndParseHookInput<UserPromptSubmitRaw>(stdin);
				const ev = makeEvent(EVENT_TYPE_TURN_START, raw);
				ev.prompt = raw.prompt;
				return ev;
			})
			.with(HOOK_NAME_STOP, async () => {
				const raw = await readAndParseHookInput<SessionInfoRaw>(stdin);
				return makeEvent(EVENT_TYPE_TURN_END, raw);
			})
			.with(HOOK_NAME_SESSION_END, async () => {
				const raw = await readAndParseHookInput<SessionInfoRaw>(stdin);
				return makeEvent(EVENT_TYPE_SESSION_END, raw);
			})
			.otherwise(async () => null);
	}

	/** No-op: vogon binary fires hooks directly. Returns 0 (Go: hooks.go:97-100). */
	async installHooks(_opts: { localDev: boolean; force: boolean }): Promise<number> {
		return 0;
	}

	/** No-op (Go: hooks.go:103). */
	async uninstallHooks(): Promise<void> {
		// no-op
	}

	/** Vogon binary fires hooks directly via `story hooks vogon <verb>`;
	 *  no external installation required. Returns false (Go: hooks.go:107-109). */
	async areHooksInstalled(): Promise<boolean> {
		return false;
	}

	/**
	 * Write `message` + newline to stdout. Mirrors Go
	 * `vogon/hooks.go:112-117 (fmt.Fprintln(os.Stdout, message))`.
	 */
	async writeHookResponse(message: string): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			process.stdout.write(`${message}\n`, (err) => {
				if (err) {
					reject(new Error(`write hook response: ${err.message}`, { cause: err }));
				} else {
					resolve();
				}
			});
		});
	}
}

function makeEvent(type: Event['type'], raw: SessionInfoRaw): Event {
	return {
		type,
		sessionId: raw.session_id,
		previousSessionId: '',
		sessionRef: raw.transcript_path,
		prompt: '',
		model: raw.model ?? '',
		timestamp: new Date(),
		toolUseId: '',
		subagentId: '',
		toolInput: null,
		subagentType: '',
		taskDescription: '',
		modifiedFiles: [],
		responseMessage: '',
		durationMs: 0,
		turnCount: 0,
		contextTokens: 0,
		contextWindowSize: 0,
		metadata: {},
	};
}

/**
 * Factory for the Vogon test-only agent. Mirrors Go `vogon.NewAgent`.
 * Used by `src/agent/bootstrap.ts: registerBuiltinAgents()` to wire Vogon
 * into the registry; not auto-registered (no module-level side effects —
 * see [`AGENTS.md` §异步/模块边界](../../AGENTS.md)).
 */
export function vogonAgent(): Agent {
	return new VogonAgent();
}
