/**
 * Tests for `src/agent/opencode/lifecycle.ts` — Mirrors Go
 * `entire-cli/cmd/entire/cli/agent/opencode/lifecycle.go` +
 * `lifecycle_test.go`.
 *
 * Covers:
 * - hookNames returns 5 verbs (Go: TestHookNames)
 * - parseHookEvent dispatches each verb to correct Event type:
 *   - session-start / session-end / compaction → bare event with sessionId
 *   - turn-start → event with sessionRef + prompt + model
 *   - turn-end → event with sessionRef + model
 *   - unknown verb → null
 * - parseHookEvent failure paths: empty stdin, invalid JSON, invalid sessionId
 * - prepareTranscript: validates path suffix, calls fetchAndCacheExport
 * - fetchAndCacheExport: STORY_TEST_OPENCODE_MOCK_EXPORT bypass + back-compat
 *   ENTIRE_TEST_OPENCODE_MOCK_EXPORT
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	EVENT_TYPE_COMPACTION,
	EVENT_TYPE_SESSION_END,
	EVENT_TYPE_SESSION_START,
	EVENT_TYPE_TURN_END,
	EVENT_TYPE_TURN_START,
} from '@/agent/event';
import { OpenCodeAgent } from '@/agent/opencode';
import {
	fetchAndCacheExport,
	hookNames,
	parseHookEvent,
	prepareTranscript,
} from '@/agent/opencode/lifecycle';
import {
	HOOK_NAME_COMPACTION,
	HOOK_NAME_SESSION_END,
	HOOK_NAME_SESSION_START,
	HOOK_NAME_TURN_END,
	HOOK_NAME_TURN_START,
} from '@/agent/opencode/types';
import { withMockProcessEnv } from '../_helpers';

function makeStdin(content: string): NodeJS.ReadableStream {
	return Readable.from([content]);
}

let restoreEnv: (() => void) | null = null;
let tmpRepo: string;
let originalCwd: string;

beforeEach(async () => {
	tmpRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-lc-'));
	originalCwd = process.cwd();
	// initialize a minimal git repo so worktreeRoot resolves
	await fs.mkdir(path.join(tmpRepo, '.git'));
	await fs.writeFile(path.join(tmpRepo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
	process.chdir(tmpRepo);
});

afterEach(async () => {
	if (restoreEnv) {
		restoreEnv();
		restoreEnv = null;
	}
	process.chdir(originalCwd);
	await fs.rm(tmpRepo, { recursive: true, force: true });
});

describe('agent/opencode/lifecycle — Go: lifecycle.go + lifecycle_test.go', () => {
	describe('hookNames', () => {
		// Go: TestHookNames (lifecycle_test.go:227-240)
		it('returns 5 verbs in stable order', () => {
			expect(hookNames()).toEqual([
				HOOK_NAME_SESSION_START,
				HOOK_NAME_SESSION_END,
				HOOK_NAME_TURN_START,
				HOOK_NAME_TURN_END,
				HOOK_NAME_COMPACTION,
			]);
		});
	});

	describe('parseHookEvent — session-start', () => {
		// Go: TestParseHookEvent_SessionStart (lifecycle_test.go:13-39)
		it('builds SessionStart event from {session_id}', async () => {
			const a = new OpenCodeAgent();
			const event = await parseHookEvent.call(
				a,
				HOOK_NAME_SESSION_START,
				makeStdin('{"session_id":"sess-1"}'),
			);
			expect(event).not.toBeNull();
			expect(event!.type).toBe(EVENT_TYPE_SESSION_START);
			expect(event!.sessionId).toBe('sess-1');
		});

		// Go: TestParseHookEvent_EmptyStdin (lifecycle_test.go:177-188)
		it('empty stdin → throws "empty hook input"', async () => {
			const a = new OpenCodeAgent();
			await expect(parseHookEvent.call(a, HOOK_NAME_SESSION_START, makeStdin(''))).rejects.toThrow(
				/empty hook input/,
			);
		});

		// Go: TestParseHookEvent_InvalidJSON (lifecycle_test.go:191-202)
		it('invalid JSON → throws "failed to parse"', async () => {
			const a = new OpenCodeAgent();
			await expect(
				parseHookEvent.call(a, HOOK_NAME_SESSION_START, makeStdin('not json')),
			).rejects.toThrow(/failed to parse/);
		});
	});

	describe('parseHookEvent — turn-start', () => {
		// Go: TestParseHookEvent_TurnStart (lifecycle_test.go:42-72)
		it('builds TurnStart with sessionRef + prompt + model', async () => {
			const a = new OpenCodeAgent();
			const event = await parseHookEvent.call(
				a,
				HOOK_NAME_TURN_START,
				makeStdin('{"session_id":"sess-1","prompt":"Fix bug","model":"claude-sonnet-4-5"}'),
			);
			expect(event!.type).toBe(EVENT_TYPE_TURN_START);
			expect(event!.sessionId).toBe('sess-1');
			expect(event!.prompt).toBe('Fix bug');
			expect(event!.model).toBe('claude-sonnet-4-5');
			expect(event!.sessionRef).toContain(path.join('.story', 'tmp', 'sess-1.json'));
		});

		// Go: TestParseHookEvent_TurnStart_InvalidSessionID (lifecycle_test.go:328-350)
		it('invalid session_id (path separator) → throws', async () => {
			const a = new OpenCodeAgent();
			await expect(
				parseHookEvent.call(
					a,
					HOOK_NAME_TURN_START,
					makeStdin('{"session_id":"../etc/passwd","prompt":"x","model":"m"}'),
				),
			).rejects.toThrow(/invalid session ID/);
		});

		// Failure path: empty session_id
		it('empty session_id → throws', async () => {
			const a = new OpenCodeAgent();
			await expect(
				parseHookEvent.call(
					a,
					HOOK_NAME_TURN_START,
					makeStdin('{"session_id":"","prompt":"x","model":"m"}'),
				),
			).rejects.toThrow(/session ID cannot be empty/);
		});
	});

	describe('parseHookEvent — turn-end', () => {
		// Go: TestParseHookEvent_TurnEnd (lifecycle_test.go:101-127)
		it('builds TurnEnd with sessionRef + model', async () => {
			const a = new OpenCodeAgent();
			const event = await parseHookEvent.call(
				a,
				HOOK_NAME_TURN_END,
				makeStdin('{"session_id":"sess-1","model":"claude-sonnet-4-5"}'),
			);
			expect(event!.type).toBe(EVENT_TYPE_TURN_END);
			expect(event!.sessionId).toBe('sess-1');
			expect(event!.model).toBe('claude-sonnet-4-5');
			expect(event!.sessionRef).toContain(path.join('.story', 'tmp', 'sess-1.json'));
			// Go: TurnEnd does NOT carry prompt
			expect(event!.prompt).toBe('');
		});

		// Failure path: empty model still parses (model is not validated)
		it('empty model → event with empty model field', async () => {
			const a = new OpenCodeAgent();
			const event = await parseHookEvent.call(
				a,
				HOOK_NAME_TURN_END,
				makeStdin('{"session_id":"sess-1","model":""}'),
			);
			expect(event!.model).toBe('');
		});

		// Go: TestParseHookEvent_TurnEnd_InvalidSessionID (lifecycle_test.go:349-363)
		it('invalid session_id (path separator) → throws "contains path separators"', async () => {
			const a = new OpenCodeAgent();
			await expect(
				parseHookEvent.call(a, HOOK_NAME_TURN_END, makeStdin('{"session_id":"../escape"}')),
			).rejects.toThrow(/contains path separators/);
		});
	});

	describe('parseHookEvent — compaction', () => {
		// Go: TestParseHookEvent_Compaction (lifecycle_test.go:130-148)
		it('builds Compaction event from {session_id}', async () => {
			const a = new OpenCodeAgent();
			const event = await parseHookEvent.call(
				a,
				HOOK_NAME_COMPACTION,
				makeStdin('{"session_id":"sess-1"}'),
			);
			expect(event!.type).toBe(EVENT_TYPE_COMPACTION);
			expect(event!.sessionId).toBe('sess-1');
		});
	});

	describe('parseHookEvent — session-end', () => {
		// Go: TestParseHookEvent_SessionEnd (lifecycle_test.go:151-170)
		it('builds SessionEnd event from {session_id}', async () => {
			const a = new OpenCodeAgent();
			const event = await parseHookEvent.call(
				a,
				HOOK_NAME_SESSION_END,
				makeStdin('{"session_id":"sess-1"}'),
			);
			expect(event!.type).toBe(EVENT_TYPE_SESSION_END);
			expect(event!.sessionId).toBe('sess-1');
		});
	});

	describe('parseHookEvent — unknown verb', () => {
		// Go: lifecycle.go:114-116 (default case → nil, nil)
		it('unknown verb → null (no lifecycle action)', async () => {
			const a = new OpenCodeAgent();
			expect(await parseHookEvent.call(a, 'totally-unknown', makeStdin('{}'))).toBeNull();
		});
	});

	describe('prepareTranscript', () => {
		// Go: lifecycle.go:131-133 (must end with .json)
		it('non-.json suffix → throws "invalid OpenCode transcript path"', async () => {
			const a = new OpenCodeAgent();
			await expect(prepareTranscript.call(a, '/tmp/notjson.txt')).rejects.toThrow(
				/invalid OpenCode transcript path/,
			);
		});

		// Go: lifecycle.go:136-138 (empty session ID throws)
		it('empty session ID (just ".json") → throws "empty session ID"', async () => {
			const a = new OpenCodeAgent();
			await expect(prepareTranscript.call(a, '/tmp/.json')).rejects.toThrow(/empty session ID/);
		});

		// Go: TestPrepareTranscript_AlwaysRefreshesTranscript (lifecycle_test.go:256-281)
		// Proves PrepareTranscript always attempts a refresh — even when the
		// transcript file already exists — by failing (no `opencode` binary on
		// PATH) rather than short-circuiting as a no-op.
		it('existing transcript file: still attempts refresh (Go: AlwaysRefreshesTranscript)', async () => {
			const transcriptPath = path.join(tmpRepo, '.story', 'tmp', 'sess-123.json');
			await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
			await fs.writeFile(transcriptPath, '{"info":{},"messages":[]}');
			// PATH pointing at empty dir → `opencode` not findable, spawn fails.
			restoreEnv = withMockProcessEnv({ PATH: tmpRepo });
			const a = new OpenCodeAgent();
			await expect(prepareTranscript.call(a, transcriptPath)).rejects.toThrow(
				/opencode export failed/,
			);
		});

		// Go: TestPrepareTranscript_ErrorOnBrokenSymlink (lifecycle_test.go:298-316)
		// Broken symlinks: Go's os.Stat (and Node's fs.stat) both follow the
		// link and surface ENOENT (IsNotExist=true), so the non-ENOENT branch
		// at lifecycle.ts:195-200 does NOT fire — the code falls through to
		// fetchAndCacheExport which fails because opencode is absent. Matches
		// Go test shape (err != nil only; no message assertion).
		it('broken symlink → throws some error (Go: ErrorOnBrokenSymlink)', async () => {
			const brokenPath = path.join(tmpRepo, '.story', 'tmp', 'broken.json');
			await fs.mkdir(path.dirname(brokenPath), { recursive: true });
			try {
				await fs.symlink('/nonexistent/target', brokenPath);
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code === 'EPERM') {
					return;
				}
				throw err;
			}
			restoreEnv = withMockProcessEnv({ PATH: tmpRepo });
			const a = new OpenCodeAgent();
			await expect(prepareTranscript.call(a, brokenPath)).rejects.toThrow();
		});

		// Coverage: closes the non-ENOENT fs.stat re-throw branch at
		// lifecycle.ts:195-200. ENOTDIR (parent is a regular file) is the most
		// reliable cross-platform way to trigger a non-ENOENT stat error.
		// Go doesn't have a direct equivalent; the branch exists because Go's
		// os.IsNotExist guard makes the non-ENOENT case a non-trivial alt path.
		it('ENOTDIR stat error → throws "failed to stat OpenCode transcript path"', async () => {
			const notDir = path.join(tmpRepo, 'plain-file');
			await fs.writeFile(notDir, 'content');
			const bogusPath = path.join(notDir, 'child.json');
			const a = new OpenCodeAgent();
			await expect(prepareTranscript.call(a, bogusPath)).rejects.toThrow(
				/failed to stat OpenCode transcript path/,
			);
		});

		// Go: lifecycle.go:140-145 — happy path delegates to fetchAndCacheExport.
		// Use STORY_TEST_OPENCODE_MOCK_EXPORT to bypass real `opencode export`.
		it('valid path + mock env: reads pre-written file (STORY env)', async () => {
			const tmpDir = path.join(tmpRepo, '.story', 'tmp');
			await fs.mkdir(tmpDir, { recursive: true });
			const mockFile = path.join(tmpDir, 'sess1.json');
			await fs.writeFile(mockFile, '{"info":{"id":"sess1"},"messages":[]}');
			restoreEnv = withMockProcessEnv({ STORY_TEST_OPENCODE_MOCK_EXPORT: '1' });
			const a = new OpenCodeAgent();
			await expect(prepareTranscript.call(a, mockFile)).resolves.toBeUndefined();
		});

		// Failure path: mock env set but no file exists
		it('mock env set but file missing → throws "mock export file not found"', async () => {
			restoreEnv = withMockProcessEnv({ STORY_TEST_OPENCODE_MOCK_EXPORT: '1' });
			const a = new OpenCodeAgent();
			await expect(
				prepareTranscript.call(a, path.join(tmpRepo, '.story', 'tmp', 'nope.json')),
			).rejects.toThrow(/mock export file not found/);
		});
	});

	describe('fetchAndCacheExport — env override behavior', () => {
		// Story-side test: STORY_TEST_OPENCODE_MOCK_EXPORT preferred over ENTIRE_*
		it('STORY env preferred over ENTIRE env (back-compat read fallback)', async () => {
			const tmpDir = path.join(tmpRepo, '.story', 'tmp');
			await fs.mkdir(tmpDir, { recursive: true });
			await fs.writeFile(path.join(tmpDir, 'sess1.json'), '{}');
			restoreEnv = withMockProcessEnv({
				STORY_TEST_OPENCODE_MOCK_EXPORT: '1',
				ENTIRE_TEST_OPENCODE_MOCK_EXPORT: undefined,
			});
			const a = new OpenCodeAgent();
			const result = await fetchAndCacheExport.call(a, 'sess1');
			expect(result).toContain(path.join('.story', 'tmp', 'sess1.json'));
		});

		// Story-side: ENTIRE_TEST_OPENCODE_MOCK_EXPORT still works as fallback
		it('ENTIRE env back-compat: still triggers mock mode', async () => {
			const tmpDir = path.join(tmpRepo, '.story', 'tmp');
			await fs.mkdir(tmpDir, { recursive: true });
			await fs.writeFile(path.join(tmpDir, 'sess1.json'), '{}');
			restoreEnv = withMockProcessEnv({
				STORY_TEST_OPENCODE_MOCK_EXPORT: undefined,
				ENTIRE_TEST_OPENCODE_MOCK_EXPORT: '1',
			});
			const a = new OpenCodeAgent();
			const result = await fetchAndCacheExport.call(a, 'sess1');
			expect(result).toContain(path.join('.story', 'tmp', 'sess1.json'));
		});

		// Failure path: invalid sessionID
		it('invalid sessionID (path separator) → throws', async () => {
			restoreEnv = withMockProcessEnv({ STORY_TEST_OPENCODE_MOCK_EXPORT: '1' });
			const a = new OpenCodeAgent();
			await expect(fetchAndCacheExport.call(a, '../escape')).rejects.toThrow(/invalid session ID/);
		});
	});

	describe('hookNames + parseHookEvent end-to-end with class delegation', () => {
		// Go: ag.HookNames() / ag.ParseHookEvent() composed via OpenCodeAgent
		it('OpenCodeAgent.hookNames matches module hookNames()', () => {
			const a = new OpenCodeAgent();
			expect(a.hookNames()).toEqual(hookNames());
		});

		it('OpenCodeAgent.parseHookEvent dispatches via class method', async () => {
			const a = new OpenCodeAgent();
			const event = await a.parseHookEvent(
				HOOK_NAME_SESSION_START,
				makeStdin('{"session_id":"x"}'),
			);
			expect(event!.type).toBe(EVENT_TYPE_SESSION_START);
		});
	});
});
