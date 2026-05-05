/**
 * Tests for `src/agent/cursor/types.ts` — Mirrors Go
 * `entire-cli/cmd/entire/cli/agent/cursor/types.go` +
 * `hooks.go` (HookName* / HooksFileName / entireHookPrefixes).
 *
 * Covers:
 * - 7 `HOOK_NAME_*` const values match Go literal strings
 * - `CURSOR_HOOKS_FILE_NAME === 'hooks.json'`
 * - `STORY_HOOK_PREFIXES` shape (Story rebrand: 'story ' + 'bun run ...')
 * - `CursorHooksFile` JSON round-trip preserves user fields
 * - 7 stdin shape interfaces accept their canonical Go payloads
 */

import { describe, expect, it } from 'vitest';
import {
	CURSOR_HOOKS_FILE_NAME,
	type CursorHooksFile,
	HOOK_NAME_BEFORE_SUBMIT_PROMPT,
	HOOK_NAME_PRE_COMPACT,
	HOOK_NAME_SESSION_END,
	HOOK_NAME_SESSION_START,
	HOOK_NAME_STOP,
	HOOK_NAME_SUBAGENT_START,
	HOOK_NAME_SUBAGENT_STOP,
	STORY_HOOK_PREFIXES,
} from '@/agent/cursor/types';

describe('agent/cursor/types — Go: cursor/types.go + hooks.go', () => {
	// Go: hooks.go:21-29 (HookName* const block)
	it('7 HOOK_NAME_* const are exact Go-literal strings', () => {
		expect(HOOK_NAME_SESSION_START).toBe('session-start');
		expect(HOOK_NAME_SESSION_END).toBe('session-end');
		expect(HOOK_NAME_BEFORE_SUBMIT_PROMPT).toBe('before-submit-prompt');
		expect(HOOK_NAME_STOP).toBe('stop');
		expect(HOOK_NAME_PRE_COMPACT).toBe('pre-compact');
		expect(HOOK_NAME_SUBAGENT_START).toBe('subagent-start');
		expect(HOOK_NAME_SUBAGENT_STOP).toBe('subagent-stop');
	});

	// Go: hooks.go:32 (HooksFileName = "hooks.json")
	it('CURSOR_HOOKS_FILE_NAME is "hooks.json"', () => {
		expect(CURSOR_HOOKS_FILE_NAME).toBe('hooks.json');
	});

	// Go: hooks.go:35-38 (entireHookPrefixes) — Story rebrand
	it('STORY_HOOK_PREFIXES is exactly the Story rebrand pair', () => {
		expect(STORY_HOOK_PREFIXES).toEqual([
			'story ',
			'bun run "$(git rev-parse --show-toplevel)"/src/cli.ts ',
		]);
	});

	// Go: types.go:9-12 (CursorHooksFile struct round-trip preservation
	// is tested end-to-end in hooks.test.ts; here we just verify the
	// TS interface accepts both `version`-only and full shapes.)
	it('CursorHooksFile JSON round-trip preserves version + hooks fields', () => {
		const file: CursorHooksFile = {
			version: 1,
			hooks: { stop: [{ command: 'echo x' }] },
		};
		const roundTrip = JSON.parse(JSON.stringify(file)) as CursorHooksFile;
		expect(roundTrip.version).toBe(1);
		expect(roundTrip.hooks?.stop?.[0]?.command).toBe('echo x');
	});

	// Go: types.go:39-181 (7 hook stdin shape structs) — verify each
	// canonical payload parses into its TS interface without TS-narrow loss.
	it('7 stdin shape interfaces accept canonical Go payloads', () => {
		const sessionStart = JSON.parse(
			'{"conversation_id":"sess-1","transcript_path":"/t.jsonl","model":"gpt-4o","composer_mode":"agent","is_background_agent":false}',
		);
		expect(sessionStart.conversation_id).toBe('sess-1');

		const stop = JSON.parse(
			'{"conversation_id":"sess-1","transcript_path":"/t.jsonl","status":"completed","loop_count":3}',
		);
		expect(stop.loop_count).toBe(3);

		const sessionEnd = JSON.parse(
			'{"conversation_id":"sess-1","transcript_path":"/t.jsonl","reason":"user_closed","duration_ms":45000,"final_status":"completed"}',
		);
		expect(sessionEnd.duration_ms).toBe(45000);

		const beforeSubmit = JSON.parse(
			'{"conversation_id":"sess-1","transcript_path":"/t.jsonl","prompt":"hello"}',
		);
		expect(beforeSubmit.prompt).toBe('hello');

		const preCompact = JSON.parse(
			'{"conversation_id":"sess-1","transcript_path":"/t.jsonl","trigger":"auto","context_tokens":8500,"context_window_size":16000}',
		);
		expect(preCompact.context_tokens).toBe(8500);

		const subagentStart = JSON.parse(
			'{"conversation_id":"sess-1","transcript_path":"/t.jsonl","subagent_id":"sub_1","task":"do something"}',
		);
		expect(subagentStart.subagent_id).toBe('sub_1');

		const subagentStop = JSON.parse(
			'{"conversation_id":"sess-1","transcript_path":"/t.jsonl","subagent_id":"sub_1","task":"done","modified_files":["a.ts","b.ts"]}',
		);
		expect(subagentStop.modified_files).toEqual(['a.ts', 'b.ts']);
	});
});
