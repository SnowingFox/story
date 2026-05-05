/**
 * Checkpoint / session metadata types + readers.
 *
 * Mirrors Go `entire-cli/e2e/testutil/metadata.go` (60 lines) type shapes
 * + `testutil/repo.go:579-619` readers.
 *
 * JSON fields use `snake_case` to preserve cross-language parity with Go
 * — per AGENTS.md rule "JSON 字段用 snake_case（与 Go 兼容），不做 camelCase
 * 转换". All readers target the Story metadata branch
 * `story/checkpoints/v1` (NOT `entire/checkpoints/v1`).
 *
 * @packageDocumentation
 */

import { type ExecaError, execa } from 'execa';
import { isolatedSpawnEnv } from './env';

// ---------------------------------------------------------------------------
// Type shapes — 1:1 with Go testutil/metadata.go
// ---------------------------------------------------------------------------

export interface TokenUsage {
	input_tokens: number;
	cache_creation_tokens: number;
	cache_read_tokens: number;
	output_tokens: number;
	api_call_count: number;
}

export interface Attribution {
	calculated_at: string;
	agent_lines: number;
	human_added: number;
	human_modified: number;
	human_removed: number;
	total_committed: number;
	agent_percentage: number;
}

/**
 * Per-turn timing snapshot stored under `session_metrics.turn_metrics` when
 * Story records a normalized TurnStart -> TurnEnd span.
 */
export interface TurnMetric {
	turn_id: string;
	started_at: string;
	ended_at: string;
	duration_ms: number;
}

/**
 * Session-level timing and context metrics. `duration_ms` is wall-clock,
 * `active_duration_ms` is the sum of `turn_metrics`.
 */
export interface SessionMetrics {
	duration_ms?: number;
	active_duration_ms?: number;
	turn_metrics?: TurnMetric[];
	turn_count?: number;
	context_tokens?: number;
	context_window_size?: number;
}

export interface SessionRef {
	metadata: string;
	transcript: string;
	context: string;
	content_hash: string;
	prompt: string;
}

export interface CheckpointMetadata {
	cli_version: string;
	checkpoint_id: string;
	strategy: string;
	branch: string;
	checkpoints_count: number;
	files_touched: string[];
	sessions: SessionRef[];
	token_usage: TokenUsage;
}

export interface SessionMetadata {
	cli_version: string;
	checkpoint_id: string;
	session_id: string;
	strategy: string;
	created_at: string;
	branch: string;
	agent: string;
	model: string;
	checkpoints_count: number;
	files_touched: string[];
	token_usage: TokenUsage;
	initial_attribution: Attribution;
	transcript_path: string;
	session_metrics?: SessionMetrics;
}

/**
 * Sharded checkpoint path: `{id[0:2]}/{id[2:]}`. 1:1 match with Go
 * `testutil.CheckpointPath` (`id[:2] + "/" + id[2:]`) — no defensive
 * short-ID handling; production IDs are always 12-hex.
 *
 * @example
 * checkpointPath('ab12cdef3456') // 'ab/12cdef3456'
 * checkpointPath('ab')            // 'ab/'   (Go-parity: trailing '/' on zero-length tail)
 */
export function checkpointPath(id: string): string {
	return `${id.slice(0, 2)}/${id.slice(2)}`;
}

/**
 * Read + parse `story/checkpoints/v1:<sharded>/metadata.json` via
 * `git show`. Throws when the blob is missing or JSON is invalid.
 * Mirrors Go `testutil.ReadCheckpointMetadata`.
 */
export async function readCheckpointMetadata(
	dir: string,
	checkpointId: string,
): Promise<CheckpointMetadata> {
	const blob = `story/checkpoints/v1:${checkpointPath(checkpointId)}/metadata.json`;
	const raw = await gitShowBlob(dir, blob);
	try {
		return JSON.parse(raw) as CheckpointMetadata;
	} catch (e) {
		throw new Error(`unmarshal checkpoint metadata from ${blob}: ${String(e)}`);
	}
}

/**
 * Read + parse `<sharded>/<sessionIndex>/metadata.json`. Mirrors Go
 * `testutil.ReadSessionMetadata`.
 */
export async function readSessionMetadata(
	dir: string,
	checkpointId: string,
	sessionIndex: number,
): Promise<SessionMetadata> {
	const blob = `story/checkpoints/v1:${checkpointPath(checkpointId)}/${sessionIndex}/metadata.json`;
	const raw = await gitShowBlob(dir, blob);
	try {
		return JSON.parse(raw) as SessionMetadata;
	} catch (e) {
		throw new Error(`unmarshal session metadata from ${blob}: ${String(e)}`);
	}
}

/**
 * Poll variant of `readSessionMetadata`: tolerates the race where the
 * checkpoint branch advances before the session metadata blob has been
 * written. Polls every 200ms up to `timeoutMs`. Mirrors Go
 * `testutil.WaitForSessionMetadata`.
 */
export async function waitForSessionMetadata(
	dir: string,
	checkpointId: string,
	sessionIndex: number,
	timeoutMs: number,
): Promise<SessionMetadata> {
	const blob = `story/checkpoints/v1:${checkpointPath(checkpointId)}/${sessionIndex}/metadata.json`;
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const raw = await gitShowBlobOrEmpty(dir, blob);
		if (raw !== '') {
			try {
				return JSON.parse(raw) as SessionMetadata;
			} catch (e) {
				throw new Error(`unmarshal session metadata from ${blob}: ${String(e)}`);
			}
		}
		await sleep(200);
	}
	throw new Error(`session metadata ${blob} did not appear within ${timeoutMs}ms`);
}

/**
 * List every checkpoint ID present in the current
 * `story/checkpoints/v1` tree. Parses the two-level sharded layout
 * `{prefix}/{rest}/metadata.json`. Order = `ls-tree` insertion order;
 * deduplicated. Mirrors Go `testutil.CheckpointIDs`.
 */
export async function listCheckpointIds(dir: string): Promise<string[]> {
	const out = await gitOutputSafe(dir, 'ls-tree', '-r', '--name-only', 'story/checkpoints/v1');
	if (out === '') {
		return [];
	}
	const seen = new Set<string>();
	const ids: string[] = [];
	for (const line of out.split('\n')) {
		const parts = line.split('/');
		// Top-level checkpoint metadata is `{prefix}/{rest}/metadata.json` (length 3).
		if (parts.length === 3 && parts[2] === 'metadata.json') {
			const id = `${parts[0]}${parts[1]}`;
			if (!seen.has(id)) {
				seen.add(id);
				ids.push(id);
			}
		}
	}
	return ids;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function gitShowBlob(dir: string, blob: string): Promise<string> {
	const res = await execa('git', ['show', blob], {
		cwd: dir,
		env: isolatedSpawnEnv(),
	});
	return (res.stdout?.toString() ?? '').trim();
}

async function gitShowBlobOrEmpty(dir: string, blob: string): Promise<string> {
	try {
		return await gitShowBlob(dir, blob);
	} catch {
		return '';
	}
}

async function gitOutputSafe(dir: string, ...args: string[]): Promise<string> {
	try {
		const res = await execa('git', args, { cwd: dir, env: isolatedSpawnEnv() });
		return (res.stdout?.toString() ?? '').trim();
	} catch (e) {
		// Mirrors Go `gitOutputSafe` — swallow error, return empty string.
		void (e as ExecaError);
		return '';
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}
