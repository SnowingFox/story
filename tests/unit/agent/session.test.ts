import { describe, expect, it } from 'vitest';
import {
	type AgentSession,
	findToolResultUUID,
	getLastAssistantResponse,
	getLastUserPrompt,
	type SessionEntry,
	truncateAtUUID,
} from '@/agent/session';
import {
	AGENT_NAME_CLAUDE_CODE,
	ENTRY_TYPE_ASSISTANT,
	ENTRY_TYPE_TOOL,
	ENTRY_TYPE_USER,
} from '@/agent/types';

// Go: session.go (AgentSession + SessionEntry + 4 helper)

function makeEntry(overrides: Partial<SessionEntry>): SessionEntry {
	return {
		uuid: overrides.uuid ?? '',
		type: overrides.type ?? ENTRY_TYPE_USER,
		timestamp: overrides.timestamp ?? new Date(0),
		content: overrides.content ?? '',
		toolName: overrides.toolName ?? '',
		toolInput: overrides.toolInput,
		toolOutput: overrides.toolOutput,
		filesAffected: overrides.filesAffected ?? [],
	};
}

function makeSession(entries: SessionEntry[]): AgentSession {
	return {
		sessionId: 'sess-1',
		agentName: AGENT_NAME_CLAUDE_CODE,
		repoPath: '/tmp/repo',
		sessionRef: '/tmp/repo/session.jsonl',
		startTime: new Date(0),
		nativeData: new Uint8Array(),
		modifiedFiles: [],
		newFiles: [],
		deletedFiles: [],
		entries,
	};
}

describe('agent/session — Go: session.go', () => {
	describe('getLastUserPrompt', () => {
		// Go: session.go:67-75 — reverse iteration; last user message wins.
		it('returns empty when no entries', () => {
			expect(getLastUserPrompt(makeSession([]))).toBe('');
		});

		it('returns last user content when only user entries', () => {
			const s = makeSession([
				makeEntry({ uuid: 'a', type: ENTRY_TYPE_USER, content: 'first' }),
				makeEntry({ uuid: 'b', type: ENTRY_TYPE_USER, content: 'second' }),
			]);
			expect(getLastUserPrompt(s)).toBe('second');
		});

		it('skips assistant entries to find last user prompt', () => {
			const s = makeSession([
				makeEntry({ uuid: 'a', type: ENTRY_TYPE_USER, content: 'q1' }),
				makeEntry({ uuid: 'b', type: ENTRY_TYPE_ASSISTANT, content: 'a1' }),
				makeEntry({ uuid: 'c', type: ENTRY_TYPE_USER, content: 'q2' }),
				makeEntry({ uuid: 'd', type: ENTRY_TYPE_ASSISTANT, content: 'a2' }),
			]);
			expect(getLastUserPrompt(s)).toBe('q2');
		});
	});

	describe('getLastAssistantResponse', () => {
		// Go: session.go:77-85 — same algorithm as getLastUserPrompt for assistant.
		// Go: session_test.go TestGetLastAssistantResponse (5 sub-cases derived).
		it('empty session → ""', () => {
			expect(getLastAssistantResponse(makeSession([]))).toBe('');
		});

		it('returns empty when no assistant entries (only user)', () => {
			const s = makeSession([makeEntry({ uuid: 'a', type: ENTRY_TYPE_USER, content: 'q1' })]);
			expect(getLastAssistantResponse(s)).toBe('');
		});

		it('single assistant entry → its content', () => {
			const s = makeSession([
				makeEntry({ uuid: 'a', type: ENTRY_TYPE_ASSISTANT, content: 'only-reply' }),
			]);
			expect(getLastAssistantResponse(s)).toBe('only-reply');
		});

		it('multiple assistant entries with user between → returns last assistant', () => {
			const s = makeSession([
				makeEntry({ uuid: 'a', type: ENTRY_TYPE_ASSISTANT, content: 'a1' }),
				makeEntry({ uuid: 'b', type: ENTRY_TYPE_USER, content: 'q' }),
				makeEntry({ uuid: 'c', type: ENTRY_TYPE_ASSISTANT, content: 'a2' }),
			]);
			expect(getLastAssistantResponse(s)).toBe('a2');
		});

		it('returns last assistant content when mixed entries', () => {
			const s = makeSession([
				makeEntry({ uuid: 'a', type: ENTRY_TYPE_USER, content: 'q1' }),
				makeEntry({ uuid: 'b', type: ENTRY_TYPE_ASSISTANT, content: 'a1' }),
				makeEntry({ uuid: 'c', type: ENTRY_TYPE_ASSISTANT, content: 'a2' }),
			]);
			expect(getLastAssistantResponse(s)).toBe('a2');
		});
	});

	describe('truncateAtUUID', () => {
		// Go: session.go:87-120 — empty UUID returns same pointer; matched UUID
		// truncates inclusive; recomputes ModifiedFiles only (not New/Deleted).
		it('empty UUID returns input unchanged (same reference)', () => {
			const s = makeSession([makeEntry({ uuid: 'a', type: ENTRY_TYPE_USER, content: 'q1' })]);
			expect(truncateAtUUID(s, '')).toBe(s);
		});

		it('matched UUID returns new session truncated inclusive + recomputes modifiedFiles', () => {
			const s = makeSession([
				makeEntry({ uuid: 'a', type: ENTRY_TYPE_USER, filesAffected: ['f1'] }),
				makeEntry({ uuid: 'b', type: ENTRY_TYPE_TOOL, filesAffected: ['f2', 'f1'] }),
				makeEntry({ uuid: 'c', type: ENTRY_TYPE_USER, filesAffected: ['f3'] }),
			]);
			const result = truncateAtUUID(s, 'b');
			expect(result).not.toBe(s);
			expect(result.entries.map((e) => e.uuid)).toEqual(['a', 'b']);
			// Dedup + first-seen order: f1 from entry a, then f2 from entry b (f1 already seen).
			expect(result.modifiedFiles).toEqual(['f1', 'f2']);
		});

		it('UUID not found keeps all entries (Go quirk: no-op truncation)', () => {
			// Go: session.go:101-107 — forward loop appends every entry; the
			// `if entry.UUID == uuid` check only fires on match. No match →
			// loop completes with all entries.
			const s = makeSession([
				makeEntry({ uuid: 'a', type: ENTRY_TYPE_USER, filesAffected: ['f1'] }),
				makeEntry({ uuid: 'b', type: ENTRY_TYPE_USER, filesAffected: ['f2'] }),
			]);
			const result = truncateAtUUID(s, 'nonexistent');
			expect(result.entries.map((e) => e.uuid)).toEqual(['a', 'b']);
			expect(result.modifiedFiles).toEqual(['f1', 'f2']);
		});
	});

	describe('findToolResultUUID', () => {
		// Go: session.go:125-132 — forward scan; matches Type==EntryTool && UUID==toolUseID.
		it('found tool entry returns [uuid, true]', () => {
			const s = makeSession([
				makeEntry({ uuid: 'tool-1', type: ENTRY_TYPE_TOOL }),
				makeEntry({ uuid: 'tool-2', type: ENTRY_TYPE_TOOL }),
			]);
			expect(findToolResultUUID(s, 'tool-1')).toEqual(['tool-1', true]);
		});

		it("missing returns ['', false]", () => {
			const s = makeSession([makeEntry({ uuid: 'a', type: ENTRY_TYPE_USER })]);
			expect(findToolResultUUID(s, 'tool-x')).toEqual(['', false]);
		});

		it('non-tool entry with matching UUID is NOT matched (Go: requires Type==EntryTool)', () => {
			const s = makeSession([makeEntry({ uuid: 'tool-1', type: ENTRY_TYPE_USER })]);
			expect(findToolResultUUID(s, 'tool-1')).toEqual(['', false]);
		});
	});
});
