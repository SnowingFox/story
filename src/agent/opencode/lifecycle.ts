/**
 * OpenCode lifecycle: hook verbs + parseHookEvent dispatch + transcript prep.
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/agent/opencode/lifecycle.go`.
 *
 * **Capabilities composed in via {@link OpenCodeAgent}**:
 * - `HookSupport.hookNames` / `HookSupport.parseHookEvent` (this module)
 * - `TranscriptPreparer.prepareTranscript` (this module — fork `opencode export`)
 *
 * **Module-level conventions**:
 * - {@link parseHookEvent} is a plain async function bound via `.call(this, ...)`
 *   from {@link OpenCodeAgent.parseHookEvent}; the `this` binding is unused
 *   (no agent-instance state) but the signature matches the framework's
 *   `HookSupport` interface for direct delegation.
 * - {@link sessionTranscriptPath} computes `<repoRoot>/.story/tmp/<sid>.json`
 *   (Story-side rebrand of Go's `<repoRoot>/.entire/tmp/<sid>.json`).
 *
 * @packageDocumentation
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import {
	EVENT_TYPE_COMPACTION,
	EVENT_TYPE_SESSION_END,
	EVENT_TYPE_SESSION_START,
	EVENT_TYPE_TURN_END,
	EVENT_TYPE_TURN_START,
	type Event,
	readAndParseHookInput,
} from '@/agent/event';
import { STORY_TMP_DIR } from '@/checkpoint/constants';
import * as log from '@/log';
import { worktreeRoot } from '@/paths';
import { validateSessionId } from '@/validation';
import { runOpenCodeExportToFile } from './cli-commands';
import {
	HOOK_NAME_COMPACTION,
	HOOK_NAME_SESSION_END,
	HOOK_NAME_SESSION_START,
	HOOK_NAME_TURN_END,
	HOOK_NAME_TURN_START,
	type SessionInfoRaw,
	type TurnEndRaw,
	type TurnStartRaw,
} from './types';

const LOG_CTX = { component: 'agent.opencode.lifecycle' } as const;

/**
 * Build a normalized {@link Event} with all string fields zero-init except
 * the ones explicitly passed. Mirrors Go's `agent.Event{}` struct literal
 * pattern where unset fields default to `""` / `null` / `0`.
 */
function makeEvent(overrides: Partial<Event>): Event {
	return {
		type: EVENT_TYPE_SESSION_START,
		sessionId: '',
		previousSessionId: '',
		sessionRef: '',
		prompt: '',
		model: '',
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
		...overrides,
	};
}

/** Returns the 5 hook verbs OpenCode supports. Mirrors Go `HookNames()`. */
export function hookNames(): string[] {
	return [
		HOOK_NAME_SESSION_START,
		HOOK_NAME_SESSION_END,
		HOOK_NAME_TURN_START,
		HOOK_NAME_TURN_END,
		HOOK_NAME_COMPACTION,
	];
}

/**
 * Translate an OpenCode hook payload (verb + stdin JSON) into a normalized
 * {@link Event}. Returns `null` for unknown verbs (no lifecycle action) —
 * matches Go's `default → nil, nil` arm.
 *
 * **Throws** (propagated from {@link readAndParseHookInput}):
 * - empty stdin → `'empty hook input'`
 * - non-JSON stdin → `'failed to parse hook input'`
 * - invalid `session_id` (path separator / empty for verbs that compute paths)
 *   → `'invalid session ID for transcript path'`
 *
 * Mirrors Go `OpenCodeAgent.ParseHookEvent`.
 */
export async function parseHookEvent(
	hookName: string,
	stdin: NodeJS.ReadableStream,
): Promise<Event | null> {
	if (hookName === HOOK_NAME_SESSION_START) {
		const raw = await readAndParseHookInput<SessionInfoRaw>(stdin);
		return makeEvent({ type: EVENT_TYPE_SESSION_START, sessionId: raw.session_id });
	}
	if (hookName === HOOK_NAME_TURN_START) {
		const raw = await readAndParseHookInput<TurnStartRaw>(stdin);
		const transcriptPath = await sessionTranscriptPath(raw.session_id);
		return makeEvent({
			type: EVENT_TYPE_TURN_START,
			sessionId: raw.session_id,
			sessionRef: transcriptPath,
			prompt: raw.prompt,
			model: raw.model,
		});
	}
	if (hookName === HOOK_NAME_TURN_END) {
		const raw = await readAndParseHookInput<TurnEndRaw>(stdin);
		const transcriptPath = await sessionTranscriptPath(raw.session_id);
		return makeEvent({
			type: EVENT_TYPE_TURN_END,
			sessionId: raw.session_id,
			sessionRef: transcriptPath,
			model: raw.model,
		});
	}
	if (hookName === HOOK_NAME_COMPACTION) {
		const raw = await readAndParseHookInput<SessionInfoRaw>(stdin);
		return makeEvent({ type: EVENT_TYPE_COMPACTION, sessionId: raw.session_id });
	}
	if (hookName === HOOK_NAME_SESSION_END) {
		const raw = await readAndParseHookInput<SessionInfoRaw>(stdin);
		return makeEvent({ type: EVENT_TYPE_SESSION_END, sessionId: raw.session_id });
	}
	return null;
}

/**
 * Compute the export-cache file path for a sessionId:
 * `<worktreeRoot>/.story/tmp/<sessionId>.json`.
 *
 * Validates `sessionId` (throws on empty / path separators). Falls back to
 * `'.'` if `worktreeRoot` fails (matches Go).
 *
 * Mirrors Go `sessionTranscriptPath`. Story rebrand: `paths.EntireTmpDir` →
 * `paths.STORY_TMP_DIR`.
 */
export async function sessionTranscriptPath(sessionId: string): Promise<string> {
	const err = validateSessionId(sessionId);
	if (err !== null) {
		throw new Error(`invalid session ID for transcript path: ${err.message}`, { cause: err });
	}
	let repoRoot: string;
	try {
		repoRoot = await worktreeRoot();
	} catch {
		repoRoot = '.';
	}
	return path.join(repoRoot, STORY_TMP_DIR, `${sessionId}.json`);
}

/**
 * Ensure the OpenCode transcript file is up-to-date by calling
 * `opencode export` (or reading a pre-written mock when test env is set).
 *
 * **Required input**: `sessionRef` must end in `.json`; the basename minus
 * `.json` is used as the OpenCode session ID.
 *
 * **Throws**:
 * - missing / non-`.json` suffix → `'invalid OpenCode transcript path'`
 * - empty session ID (path is just `.json`) → `'empty session ID in transcript path'`
 * - any underlying CLI subprocess failure (propagated from {@link fetchAndCacheExport})
 *
 * Mirrors Go `OpenCodeAgent.PrepareTranscript`. The `this` binding is unused
 * — bound via `.call(this, ...)` from `OpenCodeAgent.prepareTranscript` for
 * framework `TranscriptPreparer` dispatch.
 *
 * @example
 * await prepareTranscript.call(agent, '/repo/.story/tmp/sess_abc.json');
 *
 * // Side effects:
 * //   `opencode export sess_abc` invoked (unless STORY_TEST_OPENCODE_MOCK_EXPORT set)
 * //   <repoRoot>/.story/tmp/sess_abc.json ← stdout (mode 0o600)
 */
export async function prepareTranscript(sessionRef: string): Promise<void> {
	try {
		await fs.stat(sessionRef);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
			throw new Error(
				`failed to stat OpenCode transcript path ${sessionRef}: ${(err as Error).message}`,
				{ cause: err as Error },
			);
		}
	}
	const base = path.basename(sessionRef);
	if (!base.endsWith('.json')) {
		throw new Error(`invalid OpenCode transcript path (expected .json): ${sessionRef}`);
	}
	const sessionId = base.slice(0, -'.json'.length);
	if (sessionId === '') {
		throw new Error(`empty session ID in transcript path: ${sessionRef}`);
	}
	await fetchAndCacheExport(sessionId);
}

/**
 * Run `opencode export <sessionId>` and cache the result at
 * `<repoRoot>/.story/tmp/<sessionId>.json`. Returns the cache file path.
 *
 * **Test mode**: when `STORY_TEST_OPENCODE_MOCK_EXPORT` (preferred) or
 * `ENTIRE_TEST_OPENCODE_MOCK_EXPORT` (back-compat read fallback) is set in
 * the environment, skips the `opencode export` invocation and uses a
 * pre-written file at the cache path. Tests must seed the file before
 * triggering the hook.
 *
 * **Throws**:
 * - invalid session ID (path separator / empty) → `'invalid session ID for export'`
 * - mock env set but file missing → `'mock export file not found'`
 * - subprocess failure (timeout / non-zero exit / missing binary)
 * - file written by export contains invalid JSON → `'opencode export returned invalid JSON'`
 *
 * Mirrors Go `OpenCodeAgent.fetchAndCacheExport`. Story rebrand: env var
 * `ENTIRE_TEST_OPENCODE_MOCK_EXPORT` → `STORY_TEST_OPENCODE_MOCK_EXPORT`.
 */
export async function fetchAndCacheExport(sessionId: string): Promise<string> {
	const err = validateSessionId(sessionId);
	if (err !== null) {
		throw new Error(`invalid session ID for export: ${err.message}`, { cause: err });
	}
	let repoRoot: string;
	try {
		repoRoot = await worktreeRoot();
	} catch {
		repoRoot = '.';
	}
	const tmpDir = path.join(repoRoot, STORY_TMP_DIR);
	const tmpFile = path.join(tmpDir, `${sessionId}.json`);

	const mockEnv =
		process.env.STORY_TEST_OPENCODE_MOCK_EXPORT ?? process.env.ENTIRE_TEST_OPENCODE_MOCK_EXPORT;
	if (mockEnv !== undefined && mockEnv !== '') {
		try {
			await fs.stat(tmpFile);
			return tmpFile;
		} catch {
			throw new Error(
				`mock export file not found: ${tmpFile} (STORY_TEST_OPENCODE_MOCK_EXPORT is set)`,
			);
		}
	}

	await fs.mkdir(tmpDir, { recursive: true, mode: 0o750 });
	const ctrl = new AbortController();
	try {
		await runOpenCodeExportToFile(ctrl.signal, sessionId, tmpFile);
	} catch (err2) {
		throw new Error(`opencode export failed: ${(err2 as Error).message}`, { cause: err2 as Error });
	}

	const data = await fs.readFile(tmpFile);
	try {
		JSON.parse(new TextDecoder('utf-8').decode(data));
	} catch {
		log.debug(LOG_CTX, 'opencode export file contained invalid JSON', {
			bytes: data.byteLength,
			path: tmpFile,
		});
		throw new Error(`opencode export returned invalid JSON (${data.byteLength} bytes)`);
	}

	return tmpFile;
}
