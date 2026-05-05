/**
 * External agent adapter — bridges `story-agent-*` binaries on `$PATH` to
 * the {@link Agent} interface via a subcommand-based JSON protocol.
 *
 * Each method invocation forks a new process of the external binary with
 * the appropriate subcommand and arguments, pipes JSON over stdin/stdout,
 * and parses the response.
 *
 * Mirrors Go `cmd/entire/cli/agent/external/external.go`.
 *
 * **Story-side divergences from Go**:
 * - Env vars: `STORY_PROTOCOL_VERSION` / `STORY_REPO_ROOT` (Go: `ENTIRE_*`)
 * - Binary prefix: `story-agent-` (Go: `entire-agent-`)
 * - Uses `node:child_process` instead of `os/exec`
 *
 * @packageDocumentation
 */

import { spawn, spawnSync } from 'node:child_process';
import { worktreeRoot } from '@/paths';
import type { Event, EventType } from '../event';
import {
	EVENT_TYPE_COMPACTION,
	EVENT_TYPE_MODEL_UPDATE,
	EVENT_TYPE_SESSION_END,
	EVENT_TYPE_SESSION_START,
	EVENT_TYPE_SUBAGENT_END,
	EVENT_TYPE_SUBAGENT_START,
	EVENT_TYPE_TURN_END,
	EVENT_TYPE_TURN_START,
} from '../event';
import type { Agent, Awaitable } from '../interfaces';
import type { AgentSession, HookInput, TokenUsage } from '../session';
import type { AgentName, AgentType } from '../types';
import { marshalHookInput, readLimited } from './helpers';
import type {
	AgentSessionJSON,
	AreHooksInstalledResponse,
	ChunkResponse,
	DetectResponse,
	EventJSON,
	ExtractFilesResponse,
	ExtractPromptsResponse,
	ExtractSummaryResponse,
	GenerateTextResponse,
	HooksInstalledCountResponse,
	InfoResponse,
	ResumeCommandResponse,
	SessionDirResponse,
	SessionFileResponse,
	SessionIDResponse,
	TokenUsageResponse,
	TranscriptPositionResponse,
} from './types';
import { MAX_OUTPUT_BYTES, PROTOCOL_VERSION } from './types';

const DEFAULT_RUN_TIMEOUT_MS = 30_000;
const PARSE_HOOK_MAX_BYTES = 10 * 1024 * 1024;

const EVENT_TYPE_NUM_MAP: Record<number, EventType> = {
	1: EVENT_TYPE_SESSION_START,
	2: EVENT_TYPE_TURN_START,
	3: EVENT_TYPE_TURN_END,
	4: EVENT_TYPE_COMPACTION,
	5: EVENT_TYPE_SESSION_END,
	6: EVENT_TYPE_SUBAGENT_START,
	7: EVENT_TYPE_SUBAGENT_END,
	8: EVENT_TYPE_MODEL_UPDATE,
};

/**
 * External agent backed by a `story-agent-*` binary. Implements the full
 * {@link Agent} interface by delegating each method to a subprocess call.
 */
export class ExternalAgent {
	readonly binaryPath: string;
	readonly info: InfoResponse;

	private constructor(binaryPath: string, info: InfoResponse) {
		this.binaryPath = binaryPath;
		this.info = info;
	}

	/**
	 * Create an ExternalAgent by calling the binary's `info` subcommand.
	 * Validates protocol version compatibility.
	 */
	static async create(binaryPath: string, ctx?: AbortSignal): Promise<ExternalAgent> {
		const ea = new ExternalAgent(binaryPath, null as unknown as InfoResponse);
		(ea as { binaryPath: string }).binaryPath = binaryPath;

		const stdout = await ea.run(ctx, null, 'info');
		let info: InfoResponse;
		try {
			info = JSON.parse(new TextDecoder().decode(stdout)) as InfoResponse;
		} catch (e) {
			throw new Error(`info: invalid JSON: ${(e as Error).message}`);
		}

		if (info.protocol_version !== PROTOCOL_VERSION) {
			throw new Error(
				`protocol version mismatch: binary reports ${info.protocol_version}, expected ${PROTOCOL_VERSION}`,
			);
		}

		return new ExternalAgent(binaryPath, info);
	}

	// --- Agent interface: Identity ---

	name(): AgentName {
		return this.info.name as AgentName;
	}

	type(): AgentType | string {
		return this.info.type;
	}

	description(): string {
		return this.info.description;
	}

	isPreview(): boolean {
		return this.info.is_preview;
	}

	async detectPresence(ctx?: AbortSignal): Promise<boolean> {
		const stdout = await this.run(ctx, null, 'detect');
		const resp = JSON.parse(new TextDecoder().decode(stdout)) as DetectResponse;
		return resp.present;
	}

	protectedDirs(): string[] {
		return this.info.protected_dirs ?? [];
	}

	// --- Agent interface: Transcript Storage ---

	async readTranscript(sessionRef: string): Promise<Uint8Array> {
		return this.run(undefined, null, 'read-transcript', '--session-ref', sessionRef);
	}

	async chunkTranscript(content: Uint8Array, maxSize: number): Promise<Uint8Array[]> {
		const stdout = await this.run(
			undefined,
			content,
			'chunk-transcript',
			'--max-size',
			String(maxSize),
		);
		const resp = JSON.parse(new TextDecoder().decode(stdout)) as ChunkResponse;
		return (resp.chunks ?? []).map((c) =>
			typeof c === 'string'
				? new TextEncoder().encode(c)
				: new Uint8Array(c as unknown as ArrayBuffer),
		);
	}

	async reassembleTranscript(chunks: Uint8Array[]): Promise<Uint8Array> {
		const input = JSON.stringify({
			chunks: chunks.map((c) => new TextDecoder().decode(c)),
		});
		return this.run(undefined, new TextEncoder().encode(input), 'reassemble-transcript');
	}

	// --- Agent interface: Legacy Session ---

	getSessionID(input: HookInput): string {
		let data: Uint8Array;
		try {
			data = new TextEncoder().encode(JSON.stringify(marshalHookInput(input)));
		} catch {
			return '';
		}
		try {
			const stdout = runSync(this.binaryPath, data, 'get-session-id');
			const resp = JSON.parse(new TextDecoder().decode(stdout)) as SessionIDResponse;
			return resp.session_id;
		} catch {
			return '';
		}
	}

	async getSessionDir(repoPath: string): Promise<string> {
		const stdout = await this.run(undefined, null, 'get-session-dir', '--repo-path', repoPath);
		const resp = JSON.parse(new TextDecoder().decode(stdout)) as SessionDirResponse;
		return resp.session_dir;
	}

	resolveSessionFile(sessionDir: string, agentSessionId: string): Awaitable<string> {
		try {
			const stdout = runSync(
				this.binaryPath,
				null,
				'resolve-session-file',
				'--session-dir',
				sessionDir,
				'--session-id',
				agentSessionId,
			);
			const resp = JSON.parse(new TextDecoder().decode(stdout)) as SessionFileResponse;
			return resp.session_file;
		} catch {
			return '';
		}
	}

	async readSession(input: HookInput): Promise<AgentSession | null> {
		const data = new TextEncoder().encode(JSON.stringify(marshalHookInput(input)));
		const stdout = await this.run(undefined, data, 'read-session');
		const resp = JSON.parse(new TextDecoder().decode(stdout)) as AgentSessionJSON;
		return unmarshalAgentSession(resp);
	}

	async writeSession(session: AgentSession): Promise<void> {
		const data = new TextEncoder().encode(JSON.stringify(marshalAgentSession(session)));
		await this.run(undefined, data, 'write-session');
	}

	formatResumeCommand(sessionID: string): string {
		try {
			const stdout = runSync(
				this.binaryPath,
				null,
				'format-resume-command',
				'--session-id',
				sessionID,
			);
			const resp = JSON.parse(new TextDecoder().decode(stdout)) as ResumeCommandResponse;
			return resp.command;
		} catch {
			return '';
		}
	}

	// --- HookSupport methods ---

	hookNames(): string[] {
		return this.info.hook_names ?? [];
	}

	async parseHookEvent(
		hookName: string,
		stdin: NodeJS.ReadableStream,
		ctx?: AbortSignal,
	): Promise<Event | null> {
		const chunks: Buffer[] = [];
		let totalBytes = 0;
		for await (const chunk of stdin) {
			const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
			totalBytes += buf.length;
			if (totalBytes <= PARSE_HOOK_MAX_BYTES) {
				chunks.push(buf);
			}
		}
		const stdinData = new Uint8Array(
			Buffer.concat(chunks).buffer,
			Buffer.concat(chunks).byteOffset,
			Buffer.concat(chunks).byteLength,
		);

		const stdout = await this.run(ctx, stdinData, 'parse-hook', '--hook', hookName);
		const text = new TextDecoder().decode(stdout).trim();
		if (text === 'null') {
			return null;
		}
		const ej = JSON.parse(text) as EventJSON;
		return convertEventJSON(ej);
	}

	async installHooks(
		opts: { localDev: boolean; force: boolean },
		ctx?: AbortSignal,
	): Promise<number> {
		const args = ['install-hooks'];
		if (opts.localDev) {
			args.push('--local-dev');
		}
		if (opts.force) {
			args.push('--force');
		}
		const stdout = await this.run(ctx, null, ...args);
		const resp = JSON.parse(new TextDecoder().decode(stdout)) as HooksInstalledCountResponse;
		return resp.hooks_installed;
	}

	async uninstallHooks(ctx?: AbortSignal): Promise<void> {
		await this.run(ctx, null, 'uninstall-hooks');
	}

	async areHooksInstalled(ctx?: AbortSignal): Promise<boolean> {
		try {
			const stdout = await this.run(ctx, null, 'are-hooks-installed');
			const resp = JSON.parse(new TextDecoder().decode(stdout)) as AreHooksInstalledResponse;
			return resp.installed;
		} catch {
			return false;
		}
	}

	// --- TranscriptAnalyzer methods ---

	async getTranscriptPosition(path: string): Promise<number> {
		const stdout = await this.run(undefined, null, 'get-transcript-position', '--path', path);
		const resp = JSON.parse(new TextDecoder().decode(stdout)) as TranscriptPositionResponse;
		return resp.position;
	}

	async extractModifiedFilesFromOffset(
		path: string,
		startOffset: number,
	): Promise<{ files: string[]; currentPosition: number }> {
		const stdout = await this.run(
			undefined,
			null,
			'extract-modified-files',
			'--path',
			path,
			'--offset',
			String(startOffset),
		);
		const resp = JSON.parse(new TextDecoder().decode(stdout)) as ExtractFilesResponse;
		return { files: resp.files ?? [], currentPosition: resp.current_position };
	}

	async extractPrompts(sessionRef: string, fromOffset: number): Promise<string[]> {
		const stdout = await this.run(
			undefined,
			null,
			'extract-prompts',
			'--session-ref',
			sessionRef,
			'--offset',
			String(fromOffset),
		);
		const resp = JSON.parse(new TextDecoder().decode(stdout)) as ExtractPromptsResponse;
		return resp.prompts ?? [];
	}

	async extractSummary(sessionRef: string): Promise<string> {
		const stdout = await this.run(undefined, null, 'extract-summary', '--session-ref', sessionRef);
		const resp = JSON.parse(new TextDecoder().decode(stdout)) as ExtractSummaryResponse;
		return resp.summary;
	}

	// --- TranscriptPreparer methods ---

	async prepareTranscript(sessionRef: string, ctx?: AbortSignal): Promise<void> {
		await this.run(ctx, null, 'prepare-transcript', '--session-ref', sessionRef);
	}

	// --- TokenCalculator methods ---

	async calculateTokenUsage(
		transcriptData: Uint8Array,
		fromOffset: number,
	): Promise<TokenUsage | null> {
		const stdout = await this.run(
			undefined,
			transcriptData,
			'calculate-tokens',
			'--offset',
			String(fromOffset),
		);
		const resp = JSON.parse(new TextDecoder().decode(stdout)) as TokenUsageResponse;
		return convertTokenUsage(resp);
	}

	// --- TextGenerator methods ---

	async generateText(prompt: string, model: string, ctx?: AbortSignal): Promise<string> {
		const stdout = await this.run(
			ctx,
			new TextEncoder().encode(prompt),
			'generate-text',
			'--model',
			model,
		);
		const resp = JSON.parse(new TextDecoder().decode(stdout)) as GenerateTextResponse;
		return resp.text;
	}

	// --- HookResponseWriter methods ---

	async writeHookResponse(message: string): Promise<void> {
		await this.run(undefined, null, 'write-hook-response', '--message', message);
	}

	// --- SubagentAwareExtractor methods ---

	async extractAllModifiedFiles(
		transcriptData: Uint8Array,
		fromOffset: number,
		subagentsDir: string,
	): Promise<string[]> {
		const stdout = await this.run(
			undefined,
			transcriptData,
			'extract-all-modified-files',
			'--offset',
			String(fromOffset),
			'--subagents-dir',
			subagentsDir,
		);
		const resp = JSON.parse(new TextDecoder().decode(stdout)) as ExtractFilesResponse;
		return resp.files ?? [];
	}

	async calculateTotalTokenUsage(
		transcriptData: Uint8Array,
		fromOffset: number,
		subagentsDir: string,
	): Promise<TokenUsage | null> {
		const stdout = await this.run(
			undefined,
			transcriptData,
			'calculate-total-tokens',
			'--offset',
			String(fromOffset),
			'--subagents-dir',
			subagentsDir,
		);
		const resp = JSON.parse(new TextDecoder().decode(stdout)) as TokenUsageResponse;
		return convertTokenUsage(resp);
	}

	// --- Core process runner ---

	/**
	 * Execute a subcommand on the external binary and return stdout bytes.
	 * Enforces a default 30s timeout, 10MB output cap, and environment injection.
	 */
	async run(
		ctx: AbortSignal | undefined,
		stdin: Uint8Array | null,
		...args: string[]
	): Promise<Uint8Array> {
		const signal =
			ctx !== undefined
				? AbortSignal.any([ctx, AbortSignal.timeout(DEFAULT_RUN_TIMEOUT_MS)])
				: AbortSignal.timeout(DEFAULT_RUN_TIMEOUT_MS);

		const env: Record<string, string> = {
			...process.env,
			STORY_PROTOCOL_VERSION: String(PROTOCOL_VERSION),
		} as Record<string, string>;

		let cwd: string | undefined;
		try {
			const root = await worktreeRoot();
			env.STORY_REPO_ROOT = root;
			cwd = root;
		} catch {
			// no repo root available
		}

		const child = spawn(this.binaryPath, args, {
			stdio: ['pipe', 'pipe', 'pipe'],
			env,
			cwd,
			signal,
		});

		if (child.stdin !== null) {
			if (stdin !== null) {
				child.stdin.end(stdin);
			} else {
				child.stdin.end();
			}
		}

		const [stdoutBytes, stderrBytes, exitCode] = await Promise.all([
			readLimited(child.stdout, MAX_OUTPUT_BYTES),
			readLimited(child.stderr, MAX_OUTPUT_BYTES),
			waitForExit(child, args[0] ?? '', signal),
		]);

		if (exitCode !== 0) {
			const errMsg = new TextDecoder().decode(stderrBytes).trim();
			if (errMsg !== '') {
				throw new Error(`${args[0]}: ${errMsg}`);
			}
			throw new Error(`${args[0]}: process exited with code ${exitCode}`);
		}

		if (stdoutBytes.length >= MAX_OUTPUT_BYTES) {
			throw new Error(`${args[0]}: output exceeded ${MAX_OUTPUT_BYTES} byte limit`);
		}

		return stdoutBytes;
	}
}

/**
 * Wait for a Node child process to exit. Rejects when the caller's
 * {@link AbortSignal} fires (caller observes abort reason) or when the
 * process is killed by an OS signal (e.g., SIGTERM from abort propagation).
 */
function waitForExit(
	child: import('node:child_process').ChildProcess,
	cmd: string,
	signal: AbortSignal,
): Promise<number> {
	return new Promise((resolve, reject) => {
		const onError = (err: Error): void => reject(err);
		child.once('error', onError);
		child.once('exit', (code, sig) => {
			child.removeListener('error', onError);
			if (signal.aborted) {
				const reason = signal.reason;
				reject(reason instanceof Error ? reason : new Error(String(reason ?? 'aborted')));
				return;
			}
			if (sig !== null) {
				reject(new Error(`${cmd}: terminated by signal ${sig}`));
				return;
			}
			resolve(code ?? 0);
		});
	});
}

/**
 * Synchronous subprocess execution for methods that must return synchronously
 * (getSessionID, resolveSessionFile, formatResumeCommand).
 * Uses `node:child_process.spawnSync`.
 */
function runSync(binaryPath: string, stdin: Uint8Array | null, ...args: string[]): Uint8Array {
	const env: Record<string, string> = {
		...process.env,
		STORY_PROTOCOL_VERSION: String(PROTOCOL_VERSION),
	} as Record<string, string>;

	const root = worktreeRootSync();
	let cwd: string | undefined;
	if (root !== null) {
		env.STORY_REPO_ROOT = root;
		cwd = root;
	}

	const result = spawnSync(binaryPath, args, {
		input: stdin !== null ? Buffer.from(stdin) : undefined,
		stdio: ['pipe', 'pipe', 'pipe'],
		env,
		cwd,
	});

	if (result.error !== undefined) {
		throw result.error;
	}

	if (result.status !== 0) {
		const stderrBuf = (result.stderr ?? Buffer.alloc(0)) as Buffer;
		const errMsg = stderrBuf.toString('utf8').trim();
		throw new Error(
			errMsg !== '' ? `${args[0]}: ${errMsg}` : `${args[0]}: exit code ${result.status}`,
		);
	}

	const stdoutBuf = (result.stdout ?? Buffer.alloc(0)) as Buffer;
	return new Uint8Array(stdoutBuf.buffer, stdoutBuf.byteOffset, stdoutBuf.byteLength);
}

/**
 * Synchronous variant of {@link worktreeRoot} — runs `git rev-parse
 * --show-toplevel` via `node:child_process.spawnSync`. Used by
 * {@link runSync} so that external agents receive `STORY_REPO_ROOT` +
 * correct `cwd` (Go parity — `paths.WorktreeRoot(ctx)` is naturally
 * synchronous in Go).
 *
 * Returns `null` when the worktree root cannot be determined (not inside a
 * git repo, git unavailable). Not cached — this is only called from the
 * three sync methods (`getSessionID`, `resolveSessionFile`,
 * `formatResumeCommand`) which are low-frequency.
 */
function worktreeRootSync(): string | null {
	try {
		const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		if (result.error !== undefined || result.status !== 0) {
			return null;
		}
		const stdoutBuf = (result.stdout ?? Buffer.alloc(0)) as Buffer;
		const out = stdoutBuf.toString('utf8').trim();
		return out !== '' ? out : null;
	} catch {
		return null;
	}
}

// --- Helpers ---

function marshalAgentSession(s: AgentSession): AgentSessionJSON {
	return {
		session_id: s.sessionId,
		agent_name: s.agentName as string,
		repo_path: s.repoPath,
		session_ref: s.sessionRef,
		start_time: s.startTime.toISOString(),
		native_data: s.nativeData.length > 0 ? Buffer.from(s.nativeData).toString('base64') : null,
		modified_files: s.modifiedFiles,
		new_files: s.newFiles,
		deleted_files: s.deletedFiles,
	};
}

function unmarshalAgentSession(j: AgentSessionJSON): AgentSession {
	return {
		sessionId: j.session_id,
		agentName: j.agent_name as AgentName,
		repoPath: j.repo_path,
		sessionRef: j.session_ref,
		startTime: j.start_time ? new Date(j.start_time) : new Date(0),
		nativeData:
			j.native_data !== null
				? new Uint8Array(Buffer.from(j.native_data, 'base64'))
				: new Uint8Array(),
		modifiedFiles: j.modified_files ?? [],
		newFiles: j.new_files ?? [],
		deletedFiles: j.deleted_files ?? [],
		entries: [],
	};
}

export function convertTokenUsage(r: TokenUsageResponse | null): TokenUsage | null {
	if (r === null) {
		return null;
	}
	const usage: TokenUsage = {
		inputTokens: r.input_tokens,
		cacheCreationTokens: r.cache_creation_tokens,
		cacheReadTokens: r.cache_read_tokens,
		outputTokens: r.output_tokens,
		apiCallCount: r.api_call_count,
	};
	if (r.subagent_tokens != null) {
		usage.subagentTokens = convertTokenUsage(r.subagent_tokens);
	}
	return usage;
}

export function convertEventJSON(ej: EventJSON): Event {
	const eventType = EVENT_TYPE_NUM_MAP[ej.type];
	if (eventType === undefined) {
		throw new Error(`unknown event type: ${ej.type}`);
	}

	return {
		type: eventType,
		sessionId: ej.session_id ?? '',
		previousSessionId: ej.previous_session_id ?? '',
		sessionRef: ej.session_ref ?? '',
		prompt: ej.prompt ?? '',
		model: ej.model ?? '',
		timestamp: ej.timestamp ? new Date(ej.timestamp) : new Date(0),
		toolUseId: ej.tool_use_id ?? '',
		subagentId: ej.subagent_id ?? '',
		toolInput:
			ej.tool_input !== undefined ? new TextEncoder().encode(JSON.stringify(ej.tool_input)) : null,
		subagentType: ej.subagent_type ?? '',
		taskDescription: ej.task_description ?? '',
		modifiedFiles: [],
		responseMessage: ej.response_message ?? '',
		durationMs: 0,
		turnCount: 0,
		contextTokens: 0,
		contextWindowSize: 0,
		metadata: ej.metadata ?? {},
	};
}
