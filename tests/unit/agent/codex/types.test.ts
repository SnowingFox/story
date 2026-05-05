/**
 * Tests for `src/agent/codex/types.ts` — Mirrors Go
 * `entire-cli/cmd/entire/cli/agent/codex/types.go` + `lifecycle.go` (4 verb consts) +
 * `hooks.go` (HooksFileName + entireHookPrefixes Story rebrand).
 *
 * Covers:
 * - 4 HOOK_NAME_* verb const literals (Go parity)
 * - HOOKS_FILE_NAME / CONFIG_FILE_NAME / FEATURE_LINE constants
 * - STORY_HOOK_PREFIXES (Story-side rebrand of Go entireHookPrefixes)
 * - HookEntry / HookEvents / MatcherGroup interface shape (round-trip)
 * - derefString helper (3 sub-case)
 */

import { describe, expect, it } from 'vitest';
import {
	CONFIG_FILE_NAME,
	derefString,
	FEATURE_LINE,
	HOOK_NAME_PRE_TOOL_USE,
	HOOK_NAME_SESSION_START,
	HOOK_NAME_STOP,
	HOOK_NAME_USER_PROMPT_SUBMIT,
	HOOKS_FILE_NAME,
	type HookEntry,
	type HookEvents,
	type HooksFile,
	type MatcherGroup,
	STORY_HOOK_PREFIXES,
} from '@/agent/codex/types';

describe('agent/codex/types — Go: codex/types.go + lifecycle.go (HookName*) + hooks.go (HooksFileName, prefixes)', () => {
	// Go: lifecycle.go:24-28 const HookName*
	it('4 HOOK_NAME_* verb constants match Go strings', () => {
		expect(HOOK_NAME_SESSION_START).toBe('session-start');
		expect(HOOK_NAME_USER_PROMPT_SUBMIT).toBe('user-prompt-submit');
		expect(HOOK_NAME_STOP).toBe('stop');
		expect(HOOK_NAME_PRE_TOOL_USE).toBe('pre-tool-use');
	});

	// Go: hooks.go:14 const HooksFileName = "hooks.json"
	it('HOOKS_FILE_NAME === "hooks.json"', () => {
		expect(HOOKS_FILE_NAME).toBe('hooks.json');
	});

	// Go: hooks.go:295,298 const configFileName + featureLine
	it('CONFIG_FILE_NAME === "config.toml" and FEATURE_LINE === "codex_hooks = true"', () => {
		expect(CONFIG_FILE_NAME).toBe('config.toml');
		expect(FEATURE_LINE).toBe('codex_hooks = true');
	});

	// Go: hooks.go:17-20 entireHookPrefixes (Story rebrand of "entire " / "go run ...")
	// Story divergence: 'story ' + 'bun run "$(git rev-parse --show-toplevel)"/src/cli.ts '
	it('STORY_HOOK_PREFIXES contains the 2 Story-rebranded prefixes', () => {
		expect(STORY_HOOK_PREFIXES).toEqual([
			'story ',
			'bun run "$(git rev-parse --show-toplevel)"/src/cli.ts ',
		]);
	});

	// Go: types.go:24-29 HookEntry struct
	it('HookEntry round-trip preserves type/command/timeout shape', () => {
		const entry: HookEntry = { type: 'command', command: 'foo', timeout: 30 };
		const round = JSON.parse(JSON.stringify(entry)) as HookEntry;
		expect(round).toEqual({ type: 'command', command: 'foo', timeout: 30 });

		// HookEvents allows any of 4 known hook type keys + each is array of MatcherGroup
		const matcher: string | null = null;
		const evts: HookEvents = {
			SessionStart: [{ matcher, hooks: [entry] }],
			UserPromptSubmit: [{ matcher, hooks: [entry] }],
			Stop: [{ matcher, hooks: [entry] }],
			PreToolUse: [{ matcher: '^Bash$', hooks: [entry] }],
		};
		const file: HooksFile = { hooks: evts };
		expect(file.hooks.SessionStart?.[0]?.hooks?.[0]?.command).toBe('foo');

		// MatcherGroup matcher is nullable (Go *string)
		const g: MatcherGroup = { matcher: null, hooks: [] };
		expect(g.matcher).toBeNull();
	});

	// Go: types.go:64-69 derefString
	it('derefString(null|undefined) returns "" and unwraps strings', () => {
		expect(derefString(null)).toBe('');
		expect(derefString(undefined)).toBe('');
		expect(derefString('foo')).toBe('foo');
	});
});
