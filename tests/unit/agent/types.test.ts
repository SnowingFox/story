import { describe, expect, it } from 'vitest';
import {
	AGENT_NAME_CLAUDE_CODE,
	AGENT_NAME_CODEX,
	AGENT_NAME_CURSOR,
	AGENT_NAME_OPENCODE,
	AGENT_TYPE_CLAUDE_CODE,
	AGENT_TYPE_CODEX,
	AGENT_TYPE_CURSOR,
	AGENT_TYPE_OPENCODE,
	AGENT_TYPE_UNKNOWN,
	type AgentType,
	DEFAULT_AGENT_NAME,
	ENTRY_TYPE_ASSISTANT,
	ENTRY_TYPE_SYSTEM,
	ENTRY_TYPE_TOOL,
	ENTRY_TYPE_USER,
	HOOK_TYPE_POST_TOOL_USE,
	HOOK_TYPE_PRE_TOOL_USE,
	HOOK_TYPE_SESSION_END,
	HOOK_TYPE_SESSION_START,
	HOOK_TYPE_STOP,
	HOOK_TYPE_USER_PROMPT_SUBMIT,
	normalize,
} from '@/agent/types';

// Go: registry.go:102-109 (AgentName const block)
// Go: registry.go:113-122 (AgentType const block)
// Go: registry.go:125 (DefaultAgentName)
// Go: types.go:8-14 (HookType const block)
// Go: session.go:60-65 (EntryType const block)

describe('agent/types — Go: registry.go + types.go + session.go const blocks', () => {
	describe('AGENT_NAME_* constants', () => {
		it('match Go registry keys 1:1 (Gemini + Copilot + Droid dropped — see references/dropped-agents.md)', () => {
			// Go: registry.go:102-109 — registry-key strings (kebab-case).
			expect(AGENT_NAME_CLAUDE_CODE).toBe('claude-code');
			expect(AGENT_NAME_CODEX).toBe('codex');
			expect(AGENT_NAME_CURSOR).toBe('cursor');
			expect(AGENT_NAME_OPENCODE).toBe('opencode');
		});
	});

	describe('AGENT_TYPE_* constants', () => {
		it('match Go display strings 1:1 (Gemini + Copilot + Droid dropped — see references/dropped-agents.md)', () => {
			// Go: registry.go:113-121 — display strings stored in metadata / trailers.
			expect(AGENT_TYPE_CLAUDE_CODE).toBe('Claude Code');
			expect(AGENT_TYPE_CODEX).toBe('Codex');
			expect(AGENT_TYPE_CURSOR).toBe('Cursor');
			expect(AGENT_TYPE_OPENCODE).toBe('OpenCode');
			expect(AGENT_TYPE_UNKNOWN).toBe('Unknown');
		});
	});

	describe('6 HOOK_TYPE_* constants', () => {
		it('match Go strings 1:1', () => {
			// Go: types.go:8-14 — hook lifecycle event kinds (snake_case).
			expect(HOOK_TYPE_SESSION_START).toBe('session_start');
			expect(HOOK_TYPE_SESSION_END).toBe('session_end');
			expect(HOOK_TYPE_USER_PROMPT_SUBMIT).toBe('user_prompt_submit');
			expect(HOOK_TYPE_STOP).toBe('stop');
			expect(HOOK_TYPE_PRE_TOOL_USE).toBe('pre_tool_use');
			expect(HOOK_TYPE_POST_TOOL_USE).toBe('post_tool_use');
		});
	});

	describe('4 ENTRY_TYPE_* constants', () => {
		it('match Go strings 1:1', () => {
			// Go: session.go:60-65 — session entry kinds (lowercase).
			expect(ENTRY_TYPE_USER).toBe('user');
			expect(ENTRY_TYPE_ASSISTANT).toBe('assistant');
			expect(ENTRY_TYPE_TOOL).toBe('tool');
			expect(ENTRY_TYPE_SYSTEM).toBe('system');
		});
	});

	describe('DEFAULT_AGENT_NAME', () => {
		it('equals AGENT_NAME_CLAUDE_CODE', () => {
			// Go: registry.go:125 — DefaultAgentName = AgentNameClaudeCode.
			expect(DEFAULT_AGENT_NAME).toBe(AGENT_NAME_CLAUDE_CODE);
		});
	});

	describe('normalize()', () => {
		it('table-driven: known agent strings → narrowed value; unknown → AGENT_TYPE_UNKNOWN', () => {
			// Story-side helper (no Go anchor — Go callers manually compare against
			// the 8 const block to validate metadata.agent values).
			const cases: Array<{ input: string; expected: AgentType }> = [
				{ input: 'Claude Code', expected: AGENT_TYPE_CLAUDE_CODE },
				{ input: 'Codex', expected: AGENT_TYPE_CODEX },
				{ input: 'Cursor', expected: AGENT_TYPE_CURSOR },
				{ input: 'OpenCode', expected: AGENT_TYPE_OPENCODE },
				{ input: 'Unknown', expected: AGENT_TYPE_UNKNOWN },
				// Unknown → AGENT_TYPE_UNKNOWN (case-sensitive matches Go).
				{ input: 'My Custom Agent', expected: AGENT_TYPE_UNKNOWN },
				{ input: '', expected: AGENT_TYPE_UNKNOWN },
				{ input: 'claude code', expected: AGENT_TYPE_UNKNOWN },
				{ input: 'Vogon Agent', expected: AGENT_TYPE_UNKNOWN }, // Vogon excluded from union
				// Dropped from roadmap — see references/dropped-agents.md.
				{ input: 'Gemini CLI', expected: AGENT_TYPE_UNKNOWN },
				{ input: 'Copilot CLI', expected: AGENT_TYPE_UNKNOWN },
				{ input: 'Factory AI Droid', expected: AGENT_TYPE_UNKNOWN },
			];
			for (const { input, expected } of cases) {
				expect(normalize(input)).toBe(expected);
			}
		});
	});
});
