/**
 * Session data types — agent-specific transcript bytes wrapped with
 * normalized metadata. Mirrors Go `cmd/entire/cli/agent/session.go` +
 * `agent/types.go` (`HookInput` / `SessionChange` / `TokenUsage`).
 *
 * **Design**: sessions are NOT interoperable between agents. A session
 * created by Claude Code can only be read/written by Claude Code. This
 * simplifies the implementation — no format conversion needed.
 *
 * @packageDocumentation
 */

import type { TokenUsage } from '@/session/state-store';
import {
	type AgentName,
	ENTRY_TYPE_ASSISTANT,
	ENTRY_TYPE_TOOL,
	ENTRY_TYPE_USER,
	type EntryType,
	type HookType,
} from './types';

/**
 * Token usage tracking. Mirrors Go `agent.TokenUsage`. JSON keys snake_case
 * for cross-CLI compat (matches existing `src/session/state-store.ts: TokenUsage`).
 *
 * Re-exported from `@/session/state-store` to avoid duplicate type definition;
 * this file just adds the JSDoc + Go anchor.
 */
export type { TokenUsage };

/**
 * Hook callback input. Mirrors Go `agent.HookInput`.
 *
 * `rawData` preserves agent-specific fields for extension; standardized
 * fields (`hookType`, `sessionId`, etc.) are first-class for typed access.
 */
export interface HookInput {
	hookType: HookType;
	sessionId: string;
	/** Agent-specific session reference (file path / db key / ...). */
	sessionRef: string;
	timestamp: Date;
	/** User prompt text — populated on `UserPromptSubmit`. */
	userPrompt: string;
	/** Tool name — populated on `PreToolUse` / `PostToolUse`. */
	toolName: string;
	/** Tool invocation ID. */
	toolUseId: string;
	/** Raw tool_input JSON bytes. */
	toolInput: Uint8Array | null;
	/** Raw tool_response JSON bytes (PostToolUse only). */
	toolResponse: Uint8Array | null;
	/** Agent-specific extension fields. */
	rawData: Record<string, unknown>;
}

/** File-watcher-detected session activity. Mirrors Go `agent.SessionChange`. */
export interface SessionChange {
	sessionId: string;
	sessionRef: string;
	eventType: HookType;
	timestamp: Date;
}

/** Single transcript entry — optional normalized view. Most agents skip this
 *  and only populate `nativeData` on {@link AgentSession}. Mirrors Go
 *  `agent.SessionEntry`. */
export interface SessionEntry {
	uuid: string;
	type: EntryType;
	timestamp: Date;
	content: string;
	toolName: string;
	toolInput: unknown;
	toolOutput: unknown;
	filesAffected: string[];
}

/**
 * Coding session data. Each agent stores its bytes in `nativeData` and only
 * the originating agent can interpret them.
 *
 * Mirrors Go `agent.AgentSession`.
 */
export interface AgentSession {
	sessionId: string;
	agentName: AgentName;
	repoPath: string;
	/** Path/reference to session in agent's storage. */
	sessionRef: string;
	startTime: Date;
	/** Native bytes — only the originating agent can interpret. */
	nativeData: Uint8Array;
	/** Computed by the agent when reading. */
	modifiedFiles: string[];
	newFiles: string[];
	deletedFiles: string[];
	/** Optional normalized entries. Most agents leave this empty. */
	entries: SessionEntry[];
}

/**
 * Last user prompt content from a session. Walks `entries` in reverse and
 * returns the first {@link ENTRY_TYPE_USER} content. Returns `''` when none.
 *
 * Mirrors Go `(*AgentSession).GetLastUserPrompt`.
 */
export function getLastUserPrompt(s: AgentSession): string {
	for (let i = s.entries.length - 1; i >= 0; i--) {
		const entry = s.entries[i]!;
		if (entry.type === ENTRY_TYPE_USER) {
			return entry.content;
		}
	}
	return '';
}

/**
 * Return the most recent `ENTRY_TYPE_ASSISTANT` entry's content, or `''` if
 * no assistant entry exists.
 *
 * Mirrors Go `(*AgentSession).GetLastAssistantResponse`.
 */
export function getLastAssistantResponse(s: AgentSession): string {
	for (let i = s.entries.length - 1; i >= 0; i--) {
		const entry = s.entries[i]!;
		if (entry.type === ENTRY_TYPE_ASSISTANT) {
			return entry.content;
		}
	}
	return '';
}

/**
 * Return a new {@link AgentSession} truncated at the given UUID (inclusive).
 * Recomputes `modifiedFiles` from truncated entries. UUID `''` returns the
 * input unchanged (same reference, matches Go pointer return).
 *
 * **Go quirk** (`session.go:101-107`): when UUID never matches any entry, the
 * forward loop completes with **all** entries appended (no second pass to
 * trim). `modifiedFiles` is recomputed from the full set.
 *
 * Only `modifiedFiles` is recomputed; `newFiles` / `deletedFiles` are left
 * empty (matches Go behavior — the truncated session struct only initializes
 * identity fields, `entries` is built up, and only `ModifiedFiles` is filled).
 *
 * Mirrors Go `(*AgentSession).TruncateAtUUID`.
 *
 * @example
 * truncateAtUUID(session, 'entry-3');
 * // returns: new AgentSession with entries [..., 'entry-3'] + recomputed modifiedFiles
 *
 * truncateAtUUID(session, '');
 * // returns: session   (same reference)
 *
 * // Side effects: none — pure function returning a new object.
 * // Original session: unchanged.
 */
export function truncateAtUUID(s: AgentSession, uuid: string): AgentSession {
	if (uuid === '') {
		return s;
	}
	const truncated: AgentSession = {
		sessionId: s.sessionId,
		agentName: s.agentName,
		repoPath: s.repoPath,
		sessionRef: s.sessionRef,
		startTime: s.startTime,
		nativeData: new Uint8Array(),
		modifiedFiles: [],
		newFiles: [],
		deletedFiles: [],
		entries: [],
	};
	const collected: SessionEntry[] = [];
	let matchedIndex = -1;
	for (let i = 0; i < s.entries.length; i++) {
		const entry = s.entries[i]!;
		collected.push(entry);
		if (entry.uuid === uuid) {
			matchedIndex = i;
			break;
		}
	}
	truncated.entries = matchedIndex === -1 ? collected : s.entries.slice(0, matchedIndex + 1);

	const seen = new Set<string>();
	for (const entry of truncated.entries) {
		for (const f of entry.filesAffected) {
			if (!seen.has(f)) {
				seen.add(f);
				truncated.modifiedFiles.push(f);
			}
		}
	}
	return truncated;
}

/**
 * Find the UUID of the entry containing the tool result for `toolUseId`.
 * Returns `[uuid, true]` on hit, `['', false]` on miss.
 *
 * **Go nuance**: matches require both `Type === ENTRY_TYPE_TOOL` and
 * `UUID === toolUseId`. A non-tool entry with matching UUID is NOT a hit.
 *
 * Mirrors Go `(*AgentSession).FindToolResultUUID`.
 */
export function findToolResultUUID(
	s: AgentSession,
	toolUseId: string,
): [string, true] | ['', false] {
	for (const entry of s.entries) {
		if (entry.type === ENTRY_TYPE_TOOL && entry.uuid === toolUseId) {
			return [entry.uuid, true];
		}
	}
	return ['', false];
}
