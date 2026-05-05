/**
 * External agent protocol types — JSON-serializable request/response shapes
 * for the subcommand-based protocol between Story CLI and `story-agent-*`
 * binaries.
 *
 * Mirrors Go `cmd/entire/cli/agent/external/types.go`.
 *
 * All JSON field names use snake_case to match the Go protocol schema.
 *
 * @packageDocumentation
 */

import type { DeclaredCaps } from '../capabilities';

/** Current protocol version expected by the CLI. */
export const PROTOCOL_VERSION = 1;

/** Max bytes to read from external process stdout/stderr (10 MB). */
export const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

/** JSON returned by the `info` subcommand. */
export interface InfoResponse {
	protocol_version: number;
	name: string;
	type: string;
	description: string;
	is_preview: boolean;
	protected_dirs: string[];
	hook_names: string[];
	capabilities: DeclaredCaps;
}

/** JSON returned by the `detect` subcommand. */
export interface DetectResponse {
	present: boolean;
}

/** JSON returned by the `get-session-id` subcommand. */
export interface SessionIDResponse {
	session_id: string;
}

/** JSON returned by the `get-session-dir` subcommand. */
export interface SessionDirResponse {
	session_dir: string;
}

/** JSON returned by the `resolve-session-file` subcommand. */
export interface SessionFileResponse {
	session_file: string;
}

/** JSON returned by the `chunk-transcript` subcommand. */
export interface ChunkResponse {
	chunks: string[];
}

/** JSON returned by the `format-resume-command` subcommand. */
export interface ResumeCommandResponse {
	command: string;
}

/** JSON returned by the `install-hooks` subcommand. */
export interface HooksInstalledCountResponse {
	hooks_installed: number;
}

/** JSON returned by the `are-hooks-installed` subcommand. */
export interface AreHooksInstalledResponse {
	installed: boolean;
}

/** JSON returned by the `get-transcript-position` subcommand. */
export interface TranscriptPositionResponse {
	position: number;
}

/** JSON returned by file-extraction subcommands. */
export interface ExtractFilesResponse {
	files: string[];
	current_position: number;
}

/** JSON returned by the `extract-prompts` subcommand. */
export interface ExtractPromptsResponse {
	prompts: string[];
}

/** JSON returned by the `extract-summary` subcommand. */
export interface ExtractSummaryResponse {
	summary: string;
	has_summary: boolean;
}

/** JSON returned by token calculation subcommands. Recursive for subagents. */
export interface TokenUsageResponse {
	input_tokens: number;
	cache_creation_tokens: number;
	cache_read_tokens: number;
	output_tokens: number;
	api_call_count: number;
	subagent_tokens?: TokenUsageResponse;
}

/** JSON returned by the `generate-text` subcommand. */
export interface GenerateTextResponse {
	text: string;
}

/** JSON representation of `AgentSession` for protocol transfer. */
export interface AgentSessionJSON {
	session_id: string;
	agent_name: string;
	repo_path: string;
	session_ref: string;
	start_time: string;
	native_data: string | null;
	modified_files: string[];
	new_files: string[];
	deleted_files: string[];
}

/**
 * JSON representation of `Event` for protocol transfer.
 * `type` is a numeric value mapping to Go's iota-based `EventType`.
 */
export interface EventJSON {
	type: number;
	session_id: string;
	previous_session_id?: string;
	session_ref?: string;
	prompt?: string;
	model?: string;
	timestamp?: string;
	tool_use_id?: string;
	subagent_id?: string;
	tool_input?: unknown;
	subagent_type?: string;
	task_description?: string;
	response_message?: string;
	metadata?: Record<string, string>;
}

/** JSON representation of `HookInput` for protocol transfer. */
export interface HookInputJSON {
	hook_type: string;
	session_id: string;
	session_ref: string;
	timestamp: string;
	user_prompt?: string;
	tool_name?: string;
	tool_use_id?: string;
	tool_input?: unknown;
	raw_data?: Record<string, unknown>;
}
