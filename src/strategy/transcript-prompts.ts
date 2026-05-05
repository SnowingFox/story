/**
 * Transcript prompt extraction + line counting helpers used by the
 * condensation pipeline.
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/strategy/manual_commit_condensation.go`
 * (`countTranscriptItems` / `extractUserPrompts` / `extractUserPromptsFromLines`
 * / `splitPromptContent` / `readPromptsFromFilesystem` / `clearFilesystemPrompt`).
 *
 * **Phase 5.3 dispatch contract** (Go-aligned):
 *
 * | Agent | Format | Behavior |
 * | --- | --- | --- |
 * | Claude Code | JSONL | Claude JSONL parser (this file) |
 * | Cursor | JSONL (role-based) | Claude-compatible JSONL parser |
 * | Codex | JSONL | Claude-compatible JSONL parser |
 * | OpenCode | JSON (export) | Native parser (opencode.ParseExportSession) |
 * | Unknown | JSONL fallback | Claude JSONL parser |
 *
 * **Why OpenCode short-circuits instead of falling through**: its format is
 * a single-line JSON object `{"info": ..., "messages": [...]}`, NOT
 * Claude-compatible JSONL. Parsing as JSONL would report "1 message"
 * regardless of `messages.length`. Go's behavior is to `return nil` when the
 * agent-specific parser fails
 * ([Go: manual_commit_condensation.go:889-925] —
 * `extractUserPrompts` `if agentType == agent.AgentTypeOpenCode { ... return nil }`).
 * TS mirrors this by dispatching to the native parser before the JSONL
 * fallback.
 *
 * Cursor / Codex are JSONL-compatible enough to extract user prompts via
 * the generic Claude JSONL parser; their per-agent extraction
 * specializations (Phase 6.x) are refinements, not corrections.
 *
 * **Dropped**: Gemini CLI, Copilot CLI, and Factory AI Droid were removed
 * from the built-in roadmap — see
 * [`references/dropped-agents.md`](../../docs/ts-rewrite/impl/references/dropped-agents.md).
 * Third parties can still ship these as external `story-agent-*` plugins.
 *
 * @packageDocumentation
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import {
	extractAllUserPrompts as extractOpenCodeUserPrompts,
	parseExportSession,
} from '../agent/opencode/transcript';
import { AGENT_TYPE_OPENCODE } from '../agent/types';
import { absPath, storyMetadataDirForSession } from '../paths';
import { stripIDEContextTags } from '../textutil';
import type { AgentType } from './types';

const PROMPT_SEPARATOR = '\n\n---\n\n';
const PROMPT_FILE_NAME = 'prompt.txt';

/**
 * Count items in a transcript. Empty input returns 0.
 *
 * See file-level docstring for the per-agent dispatch matrix.
 *
 * @example
 * countTranscriptItems('Claude Code', 'l1\nl2\nl3\n')   // 3
 * countTranscriptItems('Claude Code', 'l1\n\n\n')       // 1 (trailing blank lines trimmed)
 * countTranscriptItems('Cursor', '')                    // 0
 * countTranscriptItems('OpenCode', '{"info":{},"messages":[{},{}]}\n')  // 2 (native parser via parseExportSession)
 *
 * // Side effects: none — pure function over the input string.
 */
export function countTranscriptItems(agentType: AgentType, content: string): number {
	if (content === '') {
		return 0;
	}

	if (agentType === AGENT_TYPE_OPENCODE) {
		try {
			const session = parseExportSession(new TextEncoder().encode(content));
			return session?.messages?.length ?? 0;
		} catch {
			return 0;
		}
	}

	return countNonEmptyJSONLLines(content);
}

/**
 * Count JSONL lines, trimming trailing whitespace-only entries (Go parity:
 * `strings.Split + trim trailing` loop in `countTranscriptItems`).
 */
function countNonEmptyJSONLLines(content: string): number {
	const lines = content.split('\n');
	while (lines.length > 0 && (lines[lines.length - 1] ?? '').trim() === '') {
		lines.pop();
	}
	return lines.length;
}

/**
 * Extract every user prompt from the transcript. IDE-injected context tags
 * (`<ide_opened_file>...`, `<user_query>...`) are stripped via
 * {@link stripIDEContextTags}. Empty input returns `[]` (Go returns nil; TS
 * normalizes to empty array because callers iterate either way).
 *
 * See file-level docstring for the per-agent dispatch matrix. OpenCode's
 * native parser short-circuits before the JSONL fallback and returns `[]`
 * on parse failure, mirroring Go's `return nil`.
 *
 * @example
 * extractUserPrompts('Claude Code', '{"type":"user","message":{"content":"hi"}}\n')
 * // ['hi']
 * extractUserPrompts('Cursor', '')   // []
 * extractUserPrompts('OpenCode', '{"info":{},"messages":[...]}\n')   // [...user prompts] (native parser)
 *
 * // Side effects: none — pure function over the input string.
 */
export function extractUserPrompts(agentType: AgentType, content: string): string[] {
	if (content === '') {
		return [];
	}

	if (agentType === AGENT_TYPE_OPENCODE) {
		try {
			return extractOpenCodeUserPrompts(new TextEncoder().encode(content));
		} catch {
			return [];
		}
	}

	return extractUserPromptsFromLines(content.split('\n'));
}

interface UserMessageLine {
	type?: string;
	role?: string;
	message?: {
		content?: string | Array<{ type?: string; text?: string }>;
	};
}

/**
 * Flatten a single JSONL transcript object to plain text for display or
 * downstream parsing. Covers:
 *
 * - Claude flat: top-level `content` string (user / assistant)
 * - Vogon-style: `message` is a string (not `{ content: ... }`)
 * - Claude / Cursor multimodal: `message.content` string or
 *   `[{ type: 'text', text: string }, ...]` (non-`text` blocks ignored)
 *
 * Does **not** apply {@link stripIDEContextTags} — callers that extract user
 * prompts should strip after flattening.
 *
 * @example
 * ```ts
 * flattenTranscriptEntryToText({ type: 'user', content: 'hi' }) // 'hi'
 * flattenTranscriptEntryToText({
 *   role: 'user',
 *   message: { content: [{ type: 'text', text: '改一行' }] },
 * }) // '改一行'
 * flattenTranscriptEntryToText({ type: 'user', message: 'plain' }) // 'plain'
 * ```
 */
export function flattenTranscriptEntryToText(entry: unknown): string {
	if (entry === null || typeof entry !== 'object') {
		return '';
	}
	const o = entry as Record<string, unknown>;

	if (typeof o.content === 'string') {
		return o.content;
	}

	if (Array.isArray(o.content)) {
		return joinTextBlocksFromContentArray(o.content);
	}

	const msg = o.message;
	if (typeof msg === 'string') {
		return msg;
	}
	if (msg !== null && typeof msg === 'object') {
		const m = msg as Record<string, unknown>;
		const c = m.content;
		if (typeof c === 'string') {
			return c;
		}
		if (Array.isArray(c)) {
			return joinTextBlocksFromContentArray(c);
		}
	}

	return '';
}

function joinTextBlocksFromContentArray(items: unknown[]): string {
	const texts: string[] = [];
	for (const item of items) {
		if (item !== null && typeof item === 'object') {
			const it = item as Record<string, unknown>;
			if (it.type === 'text' && typeof it.text === 'string') {
				texts.push(it.text);
			}
		}
	}
	return texts.join('\n\n');
}

/**
 * Parse one JSONL line into a display role + flattened text for `story explain
 * --full` and similar read-only views. Returns `null` when the line is blank,
 * not JSON, or not an object.
 *
 * User / human lines are passed through {@link stripIDEContextTags}; assistant
 * and other roles are left as-is so assistant bodies are not stripped of
 * incidental markup that only applies to user prompts.
 *
 * @example
 * ```ts
 * parseTranscriptDisplayLine(
 *   '{"role":"user","message":{"content":[{"type":"text","text":"hi"}]}}',
 * );
 * // { role: 'user', text: 'hi' }
 * ```
 */
export function parseTranscriptDisplayLine(rawLine: string): { role: string; text: string } | null {
	const line = rawLine.trim();
	if (line === '') {
		return null;
	}
	let entry: unknown;
	try {
		entry = JSON.parse(line) as unknown;
	} catch {
		return null;
	}
	if (entry === null || typeof entry !== 'object') {
		return null;
	}
	const o = entry as Record<string, unknown>;
	const roleRaw = o.type ?? o.role ?? 'message';
	const role = typeof roleRaw === 'string' ? roleRaw : 'message';
	const text = flattenTranscriptEntryToText(entry);
	const isUser = o.type === 'user' || o.type === 'human' || o.role === 'user';
	const outText = isUser ? stripIDEContextTags(text) : text;
	return { role, text: outText };
}

/**
 * Parse JSONL transcript lines and extract each user prompt's text. Handles:
 *
 * - Claude Code (`type: 'user'` or `type: 'human'`)
 * - Cursor (`role: 'user'`)
 * - String content (`message.content` is a string)
 * - Array content (VSCode multi text block: `message.content` is an array of
 *   `{type:'text', text:string}` blocks; non-text blocks ignored)
 * - Vogon-style string `message` (flat string, not nested `content`)
 *
 * Each prompt is passed through {@link stripIDEContextTags}; empty results
 * (whitespace-only / pure tag) are dropped.
 */
export function extractUserPromptsFromLines(lines: string[]): string[] {
	const prompts: string[] = [];
	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (line === '') {
			continue;
		}

		let entry: UserMessageLine;
		try {
			entry = JSON.parse(line) as UserMessageLine;
		} catch {
			continue;
		}

		const isUser = entry.type === 'user' || entry.type === 'human' || entry.role === 'user';
		if (!isUser) {
			continue;
		}

		const rawText = flattenTranscriptEntryToText(entry);
		if (rawText === '') {
			continue;
		}
		const cleaned = stripIDEContextTags(rawText);
		if (cleaned !== '') {
			prompts.push(cleaned);
		}
	}
	return prompts;
}

/**
 * Split `prompt.txt` content on the canonical `\n\n---\n\n` separator.
 * Trims each segment, drops empty / whitespace-only segments. Empty input
 * returns `null` (Go: nil — preserved for caller `if prompts == nil` patterns).
 *
 * @example
 * splitPromptContent('A\n\n---\n\nB')   // ['A', 'B']
 * splitPromptContent('')                 // null
 *
 * // Side effects: none — pure string parsing.
 */
export function splitPromptContent(content: string): string[] | null {
	if (content === '') {
		return null;
	}
	const parts = content.split(PROMPT_SEPARATOR);
	const result: string[] = [];
	for (const part of parts) {
		const trimmed = part.trim();
		if (trimmed !== '') {
			result.push(trimmed);
		}
	}
	return result.length > 0 ? result : null;
}

/**
 * Read `<sessionMetadataDirAbs>/prompt.txt` from disk (NOT from the shadow
 * tree). This filesystem fallback handles mid-turn commits where the shadow
 * tree hasn't been refreshed yet but `prompt.txt` was written by the hook.
 *
 * Returns `null` when the file is missing (ENOENT), unreadable, or empty.
 * Other errors propagate so the caller (`extractSessionData*`) can surface
 * them.
 *
 * @example
 * await readPromptsFromFilesystem('2026-04-19-sess-1');
 * // ['first prompt', 'second prompt']  OR  null when missing/empty
 *
 * // Side effects: none — read-only file access.
 */
export async function readPromptsFromFilesystem(
	sessionId: string,
	cwd?: string,
): Promise<string[] | null> {
	const sessionDir = storyMetadataDirForSession(sessionId);
	let dirAbs: string;
	try {
		dirAbs = await absPath(sessionDir, cwd);
	} catch {
		return null;
	}
	const promptPath = path.join(dirAbs, PROMPT_FILE_NAME);
	let data: string;
	try {
		data = await fs.readFile(promptPath, 'utf-8');
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			return null;
		}
		throw err;
	}
	if (data === '') {
		return null;
	}
	return splitPromptContent(data);
}

/**
 * Remove `<sessionMetadataDirAbs>/prompt.txt` after condensation so the next
 * turn starts with a fresh prompt buffer. ENOENT is silently swallowed (the
 * file may not exist yet); other errors are also swallowed (Go uses
 * `_ = os.Remove(...)` — best-effort cleanup, never blocks the condense path).
 *
 * @example
 * await clearFilesystemPrompt('2026-04-19-sess-1');
 *
 * // Side effects: removes <session>/prompt.txt when present; no-op otherwise.
 * // Disk for unrelated files / git refs / HEAD: unchanged.
 */
export async function clearFilesystemPrompt(sessionId: string, cwd?: string): Promise<void> {
	const sessionDir = storyMetadataDirForSession(sessionId);
	let dirAbs: string;
	try {
		dirAbs = await absPath(sessionDir, cwd);
	} catch {
		return;
	}
	const promptPath = path.join(dirAbs, PROMPT_FILE_NAME);
	try {
		await fs.unlink(promptPath);
	} catch {
		// best-effort, ignore all errors (Go: _ = os.Remove)
	}
}
