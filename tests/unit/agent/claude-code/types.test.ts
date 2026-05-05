/**
 * Tests for `src/agent/claude-code/types.ts` — Mirrors Go
 * `entire-cli/cmd/entire/cli/agent/claudecode/types.go` constants +
 * `hooks.go: HookName* / metadataDenyRule / entireHookPrefixes`.
 */

import { describe, expect, it } from 'vitest';
import {
	CLAUDE_SETTINGS_FILE_NAME,
	type ClaudeSettings,
	FILE_MODIFICATION_TOOLS,
	HOOK_NAME_POST_TASK,
	HOOK_NAME_POST_TODO,
	HOOK_NAME_PRE_TASK,
	HOOK_NAME_SESSION_END,
	HOOK_NAME_SESSION_START,
	HOOK_NAME_STOP,
	HOOK_NAME_USER_PROMPT_SUBMIT,
	METADATA_DENY_RULE,
	STORY_HOOK_PREFIXES,
	TOOL_EDIT,
	TOOL_MCP_EDIT,
	TOOL_MCP_WRITE,
	TOOL_NOTEBOOK_EDIT,
	TOOL_WRITE,
} from '@/agent/claude-code/types';

describe('agent/claude-code/types — Go: types.go + hooks.go', () => {
	describe('tool name constants', () => {
		// Go: types.go:67-74 (5 tool name const)
		it('match Go literals exactly', () => {
			expect(TOOL_WRITE).toBe('Write');
			expect(TOOL_EDIT).toBe('Edit');
			expect(TOOL_NOTEBOOK_EDIT).toBe('NotebookEdit');
			expect(TOOL_MCP_WRITE).toBe('mcp__acp__Write');
			expect(TOOL_MCP_EDIT).toBe('mcp__acp__Edit');
		});
	});

	describe('FILE_MODIFICATION_TOOLS', () => {
		// Go: types.go:76-83 (FileModificationTools array order)
		it('contains all 5 tool names in Go order', () => {
			expect(FILE_MODIFICATION_TOOLS).toEqual([
				TOOL_WRITE,
				TOOL_EDIT,
				TOOL_NOTEBOOK_EDIT,
				TOOL_MCP_WRITE,
				TOOL_MCP_EDIT,
			]);
		});
	});

	describe('7 HOOK_NAME_* verb constants', () => {
		// Go: hooks.go:20-28 (7 HookName* const)
		it('match Go strings (subcommand verbs under `story hooks claude-code`)', () => {
			expect(HOOK_NAME_SESSION_START).toBe('session-start');
			expect(HOOK_NAME_SESSION_END).toBe('session-end');
			expect(HOOK_NAME_STOP).toBe('stop');
			expect(HOOK_NAME_USER_PROMPT_SUBMIT).toBe('user-prompt-submit');
			expect(HOOK_NAME_PRE_TASK).toBe('pre-task');
			expect(HOOK_NAME_POST_TASK).toBe('post-task');
			expect(HOOK_NAME_POST_TODO).toBe('post-todo');
		});
	});

	describe('Story-side rebranded constants', () => {
		// Go: hooks.go:32 (ClaudeSettingsFileName, no rebrand) +
		// Go: hooks.go:35 (metadataDenyRule, Story divergence: `.entire/` → `.story/`)
		it('CLAUDE_SETTINGS_FILE_NAME unchanged from Go', () => {
			expect(CLAUDE_SETTINGS_FILE_NAME).toBe('settings.json');
		});

		it('METADATA_DENY_RULE uses `.story/` (NOT `.entire/`)', () => {
			expect(METADATA_DENY_RULE).toBe('Read(./.story/metadata/**)');
			expect(METADATA_DENY_RULE).not.toContain('.entire');
		});
	});

	describe('STORY_HOOK_PREFIXES', () => {
		// Go: hooks.go:38-41 (entireHookPrefixes — Story divergence: `entire ` → `story `,
		// `go run ${CLAUDE_PROJECT_DIR}/cmd/entire/main.go ` → `bun run ${CLAUDE_PROJECT_DIR}/src/cli.ts `)
		it('contains Story prefix + bun run localDev prefix', () => {
			expect(STORY_HOOK_PREFIXES).toEqual([
				'story ',
				// biome-ignore lint/suspicious/noTemplateCurlyInString: literal Claude shell variable, not a JS template
				'bun run ${CLAUDE_PROJECT_DIR}/src/cli.ts ',
			]);
			// Negative assertions — make sure no Go literal leaked through.
			expect(STORY_HOOK_PREFIXES).not.toContain('entire ');
			expect(STORY_HOOK_PREFIXES.some((p) => p.includes('go run '))).toBe(false);
			expect(STORY_HOOK_PREFIXES.some((p) => p.includes('cmd/entire/main.go'))).toBe(false);
		});
	});

	describe('ClaudeSettings JSON round-trip', () => {
		// Go: types.go:6-30 (ClaudeSettings struct + 4 sub-types)
		it('preserves ClaudeHookMatcher / ClaudeHookEntry shape through JSON', () => {
			const original: ClaudeSettings = {
				hooks: {
					Stop: [
						{
							matcher: '',
							hooks: [{ type: 'command', command: 'story hooks claude-code stop' }],
						},
					],
					PostToolUse: [
						{
							matcher: 'TodoWrite',
							hooks: [{ type: 'command', command: 'story hooks claude-code post-todo' }],
						},
					],
				},
			};
			const restored: ClaudeSettings = JSON.parse(JSON.stringify(original));
			expect(restored.hooks?.Stop?.[0]?.matcher).toBe('');
			expect(restored.hooks?.Stop?.[0]?.hooks[0]?.type).toBe('command');
			expect(restored.hooks?.Stop?.[0]?.hooks[0]?.command).toBe('story hooks claude-code stop');
			expect(restored.hooks?.PostToolUse?.[0]?.matcher).toBe('TodoWrite');
		});
	});
});
