/**
 * Tests for `src/agent/codex/index.ts` — Mirrors Go
 * `entire-cli/cmd/entire/cli/agent/codex/codex.go` + `codex_test.go`.
 *
 * Covers:
 * - Identity (6 method) — name / type / description / isPreview / protectedDirs / getSessionID
 * - Bootstrap registration via registerBuiltinAgents() (Cursor pattern)
 * - resolveCodexHome: CODEX_HOME env / homedir fallback / no homedir → throw
 * - getSessionDir: STORY env / ENTIRE env back-compat / CODEX_HOME / default
 * - resolveSessionFile: absolute path / glob (3 pattern: flat / date / archived) / fallback
 * - restoredRolloutPath: UTC date path
 * - findRolloutBySessionID: 0 match → '' / invalid sessionId → ''
 * - readSession: round-trip + dedup modifiedFiles
 * - writeSession: 4 throw paths (nil session / mismatched agent / empty ref / empty data)
 * - formatResumeCommand
 * - chunkTranscript / reassembleTranscript round-trip
 *
 * Failure-path total: 9.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexAgent, codexAgent, findRolloutBySessionID, restoredRolloutPath } from '@/agent/codex';
import { get, getByAgentType, withTestRegistry } from '@/agent/registry';
import type { AgentSession, HookInput } from '@/agent/session';
import { AGENT_NAME_CODEX, AGENT_TYPE_CODEX, HOOK_TYPE_SESSION_START } from '@/agent/types';

function makeHookInput(overrides: Partial<HookInput> = {}): HookInput {
	return {
		hookType: HOOK_TYPE_SESSION_START,
		sessionId: 'sess',
		sessionRef: '',
		timestamp: new Date(),
		userPrompt: '',
		toolName: '',
		toolUseId: '',
		toolInput: null,
		toolResponse: null,
		rawData: {},
		...overrides,
	};
}

const SAMPLE_ROLLOUT =
	'{"timestamp":"2026-03-25T11:31:11.752Z","type":"session_meta","payload":{"id":"019d24c3","timestamp":"2026-03-25T11:31:10.922Z","cwd":"/tmp/repo","originator":"codex_exec","cli_version":"0.116.0","source":"exec"}}\n' +
	'{"timestamp":"2026-03-25T11:31:11.754Z","type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1"}}\n' +
	'{"timestamp":"2026-03-25T11:31:11.754Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Create a file called hello.txt"}]}}\n' +
	'{"timestamp":"2026-03-25T11:31:14.000Z","type":"response_item","payload":{"type":"custom_tool_call","status":"completed","call_id":"call_1","name":"apply_patch","input":"*** Begin Patch\\n*** Add File: hello.txt\\n+Hello World\\n*** End Patch\\n"}}\n' +
	'{"timestamp":"2026-03-25T11:31:17.000Z","type":"response_item","payload":{"type":"custom_tool_call","status":"completed","call_id":"call_2","name":"apply_patch","input":"*** Begin Patch\\n*** Add File: docs/readme.md\\n+# Readme\\n*** Update File: hello.txt\\n-Hello World\\n+Hello World!\\n*** End Patch\\n"}}\n';

describe('agent/codex/index — Go: codex/codex.go + codex_test.go', () => {
	let envBackup: Record<string, string | undefined> = {};

	beforeEach(() => {
		// snapshot env vars we mutate
		envBackup = {
			STORY_TEST_CODEX_SESSION_DIR: process.env.STORY_TEST_CODEX_SESSION_DIR,
			ENTIRE_TEST_CODEX_SESSION_DIR: process.env.ENTIRE_TEST_CODEX_SESSION_DIR,
			CODEX_HOME: process.env.CODEX_HOME,
			HOME: process.env.HOME,
		};
	});
	afterEach(() => {
		// restore (delete if previously unset)
		for (const [k, v] of Object.entries(envBackup)) {
			if (v === undefined) {
				delete process.env[k];
			} else {
				process.env[k] = v;
			}
		}
	});

	describe('bootstrap registration', () => {
		// Go: codex.go:21-23 init() → agent.Register(AgentNameCodex, NewCodexAgent)
		// Story: bootstrap.ts:registerBuiltinAgents() instead (no top-level side effect).
		it('Codex is registered under AGENT_NAME / AGENT_TYPE after bootstrap', async () => {
			const { registerBuiltinAgents } = await import('@/agent/bootstrap');
			await withTestRegistry(async () => {
				registerBuiltinAgents();
				expect(get(AGENT_NAME_CODEX)).toBeInstanceOf(CodexAgent);
				expect(getByAgentType(AGENT_TYPE_CODEX)).toBeInstanceOf(CodexAgent);
			});
		});

		// Go: codex.go:35-37 NewCodexAgent factory
		it('factory returns a fresh instance each call', () => {
			const a = codexAgent();
			const b = codexAgent();
			expect(a).toBeInstanceOf(CodexAgent);
			expect(b).toBeInstanceOf(CodexAgent);
			expect(a).not.toBe(b);
		});
	});

	describe('Identity', () => {
		const a = new CodexAgent();
		// Go: codex_test.go:22-26 TestCodexAgent_Name
		it('name() === "codex"', () => {
			expect(a.name()).toBe(AGENT_NAME_CODEX);
		});
		// Go: codex_test.go:28-32 TestCodexAgent_Type
		it('type() === "Codex"', () => {
			expect(a.type()).toBe(AGENT_TYPE_CODEX);
		});
		// Go: codex_test.go:34-38 TestCodexAgent_Description
		it('description() contains "Codex"', () => {
			expect(a.description()).toBe("Codex - OpenAI's CLI coding agent");
		});
		// Go: codex_test.go:40-44 TestCodexAgent_IsPreview
		it('isPreview() === true (Phase 6.5 marks Codex preview)', () => {
			expect(a.isPreview()).toBe(true);
		});
		// Go: codex_test.go:46-50 TestCodexAgent_ProtectedDirs
		it('protectedDirs() === [".codex"]', () => {
			expect(a.protectedDirs()).toEqual(['.codex']);
		});
		// Go: codex.go GetSessionID — passes through input.SessionID
		it('getSessionID(input) returns input.sessionId', () => {
			expect(a.getSessionID(makeHookInput({ sessionId: 'abc-123' }))).toBe('abc-123');
		});
	});

	describe('detectPresence', () => {
		let tmpDir: string;
		let originalCwd: string;

		beforeEach(async () => {
			tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-detect-'));
			await fs.mkdir(path.join(tmpDir, '.git'), { recursive: true });
			await fs.writeFile(path.join(tmpDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
			originalCwd = process.cwd();
			process.chdir(tmpDir);
		});
		afterEach(async () => {
			process.chdir(originalCwd);
			await fs.rm(tmpDir, { recursive: true, force: true });
		});

		// Go: codex.go:55-57 DetectPresence delegates to AreHooksInstalled
		it('detectPresence false when areHooksInstalled returns false (no hooks.json)', async () => {
			const a = new CodexAgent();
			expect(await a.detectPresence()).toBe(false);
		});

		it('detectPresence true after installHooks', async () => {
			const a = new CodexAgent();
			await a.installHooks({ localDev: false, force: false });
			expect(await a.detectPresence()).toBe(true);
		});
	});

	describe('getSessionDir env precedence', () => {
		const a = new CodexAgent();

		// Go: codex.go:73-79 GetSessionDir — STORY override (Story rebrand)
		it('uses STORY_TEST_CODEX_SESSION_DIR override (highest priority)', async () => {
			process.env.STORY_TEST_CODEX_SESSION_DIR = '/tmp/story-override';
			delete process.env.ENTIRE_TEST_CODEX_SESSION_DIR;
			expect(await a.getSessionDir('')).toBe('/tmp/story-override');
		});

		// Story-side back-compat: ENTIRE_TEST_CODEX_SESSION_DIR fallback
		it('falls back to ENTIRE_TEST_CODEX_SESSION_DIR (back-compat read)', async () => {
			delete process.env.STORY_TEST_CODEX_SESSION_DIR;
			process.env.ENTIRE_TEST_CODEX_SESSION_DIR = '/tmp/entire-fallback';
			expect(await a.getSessionDir('')).toBe('/tmp/entire-fallback');
		});

		// Go: codex.go:60-66 resolveCodexHome — CODEX_HOME env priority
		it('uses CODEX_HOME env when no test override set', async () => {
			delete process.env.STORY_TEST_CODEX_SESSION_DIR;
			delete process.env.ENTIRE_TEST_CODEX_SESSION_DIR;
			process.env.CODEX_HOME = '/custom/codex-home';
			expect(await a.getSessionDir('')).toBe(path.join('/custom/codex-home', 'sessions'));
		});

		// Go: codex_test.go:69-78 TestCodexAgent_GetSessionDir — default path
		it('defaults to ~/.codex/sessions when nothing set', async () => {
			delete process.env.STORY_TEST_CODEX_SESSION_DIR;
			delete process.env.ENTIRE_TEST_CODEX_SESSION_DIR;
			delete process.env.CODEX_HOME;
			const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-home-'));
			process.env.HOME = fakeHome;
			try {
				expect(await a.getSessionDir('')).toBe(path.join(fakeHome, '.codex', 'sessions'));
			} finally {
				await fs.rm(fakeHome, { recursive: true, force: true });
			}
		});
	});

	describe('resolveSessionFile + findRolloutBySessionID + restoredRolloutPath', () => {
		const a = new CodexAgent();
		let dir: string;

		beforeEach(async () => {
			dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-resolve-'));
		});
		afterEach(async () => {
			await fs.rm(dir, { recursive: true, force: true });
		});

		// Go: codex.go:88-96 absolute path → returns as-is
		it('absolute sessionId returned as-is', async () => {
			expect(await a.resolveSessionFile(dir, '/tmp/transcript.jsonl')).toBe(
				'/tmp/transcript.jsonl',
			);
		});

		// Go: codex_test.go:80-93 SessionTreeLayout (date-path glob)
		it('finds rollout via YYYY/MM/DD/rollout-*-{id}.jsonl glob', async () => {
			const sessionID = 'abc-123';
			const dayDir = path.join(dir, '2026', '04', '08');
			await fs.mkdir(dayDir, { recursive: true });
			const expected = path.join(dayDir, `rollout-2026-04-08T10-43-48-${sessionID}.jsonl`);
			await fs.writeFile(expected, 'placeholder');
			expect(await a.resolveSessionFile(dir, sessionID)).toBe(expected);
		});

		// Go: codex.go:97-102 fallback when no glob match
		it('falls back to <dir>/<id>.jsonl when no glob match', async () => {
			const result = await a.resolveSessionFile(dir, 'no-match-id');
			expect(result).toBe(path.join(dir, 'no-match-id.jsonl'));
		});

		// Failure path: sessionId path-traversal → glob skipped, fallback returned
		it('invalid sessionId (path traversal) → glob skipped, fallback path', async () => {
			const result = await a.resolveSessionFile(dir, '../../../etc/passwd');
			// invalid id never matches glob; falls through to fallback
			expect(result).toBe(path.join(dir, '../../../etc/passwd.jsonl'));
		});

		// Go: codex.go:194-220 findRolloutBySessionID — multiple matches → lex latest
		it('findRolloutBySessionID returns lex-latest among multiple matches', async () => {
			const sessionID = 'lex-test';
			const dayDir1 = path.join(dir, '2026', '04', '01');
			const dayDir2 = path.join(dir, '2026', '04', '15');
			await fs.mkdir(dayDir1, { recursive: true });
			await fs.mkdir(dayDir2, { recursive: true });
			const earlier = path.join(dayDir1, `rollout-2026-04-01T00-00-00-${sessionID}.jsonl`);
			const later = path.join(dayDir2, `rollout-2026-04-15T00-00-00-${sessionID}.jsonl`);
			await fs.writeFile(earlier, '');
			await fs.writeFile(later, '');
			expect(await findRolloutBySessionID(dir, sessionID)).toBe(later);
		});

		// Go: codex.go:228-231 pattern 1 — flat layout `<codexHome>/rollout-*-<sid>.jsonl`
		it('finds rollout via flat layout (pattern 1)', async () => {
			const sessionID = 'flat-123';
			const expected = path.join(dir, `rollout-2026-04-20T10-00-00-${sessionID}.jsonl`);
			await fs.writeFile(expected, 'placeholder');
			expect(await findRolloutBySessionID(dir, sessionID)).toBe(expected);
		});

		// Go: codex.go:232-236 pattern 3 — archived_sessions/<Y>/<M>/<D>/rollout-*-<sid>.jsonl
		it('finds rollout via archived_sessions (pattern 3)', async () => {
			const sessionID = 'arch-456';
			const archivedDir = path.join(path.dirname(dir), 'archived_sessions', '2026', '03', '15');
			await fs.mkdir(archivedDir, { recursive: true });
			const expected = path.join(archivedDir, `rollout-2026-03-15T12-00-00-${sessionID}.jsonl`);
			await fs.writeFile(expected, 'placeholder');
			expect(await findRolloutBySessionID(dir, sessionID)).toBe(expected);
			await fs.rm(path.join(path.dirname(dir), 'archived_sessions'), {
				recursive: true,
				force: true,
			});
		});

		// Go: codex.go:228-231 flat pattern short-circuits (pattern 1 hit → skip pattern 2/3)
		it('flat pattern wins over date pattern when both exist', async () => {
			const sessionID = 'prio-789';
			const flatFile = path.join(dir, `rollout-2026-04-20T10-00-00-${sessionID}.jsonl`);
			const dayDir = path.join(dir, '2026', '04', '20');
			await fs.mkdir(dayDir, { recursive: true });
			const dateFile = path.join(dayDir, `rollout-2026-04-20T10-00-00-${sessionID}.jsonl`);
			await fs.writeFile(flatFile, '');
			await fs.writeFile(dateFile, '');
			expect(await findRolloutBySessionID(dir, sessionID)).toBe(flatFile);
		});

		// Failure path: 0 match → ''
		it('findRolloutBySessionID returns "" on no match', async () => {
			expect(await findRolloutBySessionID(dir, 'never-existed')).toBe('');
		});

		// Failure path: invalid sessionId → '' (validateAgentSessionID rejection)
		it('findRolloutBySessionID returns "" on invalid sessionId (path traversal)', async () => {
			expect(await findRolloutBySessionID(dir, '../bad/id')).toBe('');
		});

		// Failure path: empty home → ''
		it('findRolloutBySessionID returns "" on empty codexHome', async () => {
			expect(await findRolloutBySessionID('', 'any')).toBe('');
		});

		// Go: codex_test.go:96-108 + codex.go:158-168 ResolveRestoredSessionFile
		it('resolveRestoredSessionFile builds YYYY/MM/DD/rollout-...-{id}.jsonl from session_meta timestamp', async () => {
			const result = await a.resolveRestoredSessionFile(
				dir,
				'019d24c3-1111-2222-3333-444444444444',
				new TextEncoder().encode(SAMPLE_ROLLOUT),
			);
			expect(result).toBe(
				path.join(
					dir,
					'2026',
					'03',
					'25',
					'rollout-2026-03-25T11-31-10-019d24c3-1111-2222-3333-444444444444.jsonl',
				),
			);
		});

		// Failure path: invalid sessionId throws (validateAgentSessionID Error → throw)
		it('resolveRestoredSessionFile throws on invalid sessionId', async () => {
			await expect(
				a.resolveRestoredSessionFile(dir, '../bad', new TextEncoder().encode(SAMPLE_ROLLOUT)),
			).rejects.toThrow();
		});

		// Go: codex.go:175-186 restoredRolloutPath UTC formatting
		it('restoredRolloutPath formats UTC timestamp with - separators', () => {
			// JS Date constructor uses local time; force UTC by ISO string
			const t = new Date('2026-04-20T15:30:45Z');
			expect(restoredRolloutPath('/home', 'sid-1', t)).toBe(
				path.join('/home', '2026', '04', '20', 'rollout-2026-04-20T15-30-45-sid-1.jsonl'),
			);
		});
	});

	describe('readSession + writeSession', () => {
		const a = new CodexAgent();
		let dir: string;

		beforeEach(async () => {
			dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-rw-'));
		});
		afterEach(async () => {
			await fs.rm(dir, { recursive: true, force: true });
		});

		// Go: codex_test.go:123-139 TestCodexAgent_ReadSession
		it('readSession round-trips bytes + extracts dedup modifiedFiles', async () => {
			const p = path.join(dir, 'rollout.jsonl');
			await fs.writeFile(p, SAMPLE_ROLLOUT);
			const sess = await a.readSession(makeHookInput({ sessionId: 'cs-1', sessionRef: p }));
			expect(sess.sessionId).toBe('cs-1');
			expect(sess.agentName).toBe(AGENT_NAME_CODEX);
			expect(sess.sessionRef).toBe(p);
			// startTime parsed from session_meta timestamp
			expect(sess.startTime.getUTCFullYear()).toBe(2026);
			expect(sess.startTime.getUTCMonth()).toBe(2); // March
			expect(sess.startTime.getUTCDate()).toBe(25);
			// modifiedFiles dedupe — hello.txt appears in both apply_patch lines
			expect(sess.modifiedFiles).toEqual(['hello.txt', 'docs/readme.md']);
			// nativeData round-trips
			expect(new TextDecoder().decode(sess.nativeData)).toBe(SAMPLE_ROLLOUT);
		});

		// Go: codex_test.go:141-154 TestCodexAgent_ReadSession_InvalidSessionMeta
		it('readSession throws when first line is not session_meta', async () => {
			const p = path.join(dir, 'bad.jsonl');
			await fs.writeFile(
				p,
				'{"timestamp":"2026-03-25T11:31:11.754Z","type":"response_item","payload":{"type":"message"}}',
			);
			await expect(a.readSession(makeHookInput({ sessionId: 'x', sessionRef: p }))).rejects.toThrow(
				/want session_meta/,
			);
		});

		// Failure path: empty sessionRef
		it('readSession throws when sessionRef empty', async () => {
			await expect(a.readSession(makeHookInput({ sessionRef: '' }))).rejects.toThrow(
				/session reference/,
			);
		});

		// Go: codex.go:144-167 WriteSession round-trip + sanitize
		it('writeSession round-trips + sanitizes encrypted_content', async () => {
			const p = path.join(dir, 'restored.jsonl');
			const tainted =
				'{"timestamp":"2026-04-20T15:30:45.000Z","type":"session_meta","payload":{"id":"x","timestamp":"2026-04-20T15:30:45.000Z"}}\n' +
				'{"timestamp":"2026-04-20T15:30:46.000Z","type":"response_item","payload":{"type":"reasoning","summary":[],"encrypted_content":"SECRET"}}\n';
			const session: AgentSession = {
				sessionId: 's',
				agentName: AGENT_NAME_CODEX,
				repoPath: '',
				sessionRef: p,
				startTime: new Date(),
				nativeData: new TextEncoder().encode(tainted),
				modifiedFiles: [],
				newFiles: [],
				deletedFiles: [],
				entries: [],
			};
			await a.writeSession(session);
			const written = await fs.readFile(p, 'utf-8');
			expect(written).not.toContain('SECRET');
			expect(written).not.toContain('encrypted_content');
		});

		// Failure path: nil session
		it('writeSession throws on null session', async () => {
			await expect(a.writeSession(null as unknown as AgentSession)).rejects.toThrow(
				/session is nil/,
			);
		});

		// Failure path: mismatched agentName
		it('writeSession throws when session.agentName mismatch', async () => {
			const session: AgentSession = {
				sessionId: 's',
				agentName: 'claude-code' as never,
				repoPath: '',
				sessionRef: '/x',
				startTime: new Date(),
				nativeData: new TextEncoder().encode('x'),
				modifiedFiles: [],
				newFiles: [],
				deletedFiles: [],
				entries: [],
			};
			await expect(a.writeSession(session)).rejects.toThrow(/belongs to agent/);
		});

		// Failure path: empty sessionRef
		it('writeSession throws on empty sessionRef', async () => {
			const session: AgentSession = {
				sessionId: 's',
				agentName: AGENT_NAME_CODEX,
				repoPath: '',
				sessionRef: '',
				startTime: new Date(),
				nativeData: new TextEncoder().encode('x'),
				modifiedFiles: [],
				newFiles: [],
				deletedFiles: [],
				entries: [],
			};
			await expect(a.writeSession(session)).rejects.toThrow(/session reference/);
		});

		// Failure path: empty nativeData
		it('writeSession throws on empty nativeData', async () => {
			const session: AgentSession = {
				sessionId: 's',
				agentName: AGENT_NAME_CODEX,
				repoPath: '',
				sessionRef: '/x',
				startTime: new Date(),
				nativeData: new Uint8Array(),
				modifiedFiles: [],
				newFiles: [],
				deletedFiles: [],
				entries: [],
			};
			await expect(a.writeSession(session)).rejects.toThrow(/no native data/);
		});
	});

	describe('formatResumeCommand + chunk + reassemble + readTranscript', () => {
		const a = new CodexAgent();

		// Go: codex_test.go:62-67 TestCodexAgent_FormatResumeCommand
		it('formatResumeCommand returns "codex resume " + sid', () => {
			expect(a.formatResumeCommand('uuid-1')).toBe('codex resume uuid-1');
		});

		// Go: codex.go:181-187 ReadTranscript
		it('readTranscript reads raw bytes from sessionRef', async () => {
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-readt-'));
			try {
				const p = path.join(dir, 'r.jsonl');
				await fs.writeFile(p, 'raw bytes');
				const data = await a.readTranscript(p);
				expect(new TextDecoder().decode(data)).toBe('raw bytes');
			} finally {
				await fs.rm(dir, { recursive: true, force: true });
			}
		});

		// Go: codex.go:190-198 ChunkTranscript + ReassembleTranscript
		it('chunkTranscript ↔ reassembleTranscript round-trip preserves bytes', async () => {
			const data = new TextEncoder().encode('a\nb\nc\n');
			const chunks = await a.chunkTranscript(data, 1024 * 1024);
			const reassembled = await a.reassembleTranscript(chunks);
			// chunkJSONL strips trailing \n from final chunk; single-chunk case preserves
			expect(new TextDecoder().decode(reassembled)).toBe('a\nb\nc\n');
		});
	});

	describe('error wrapping (Story 补充 — coverage)', () => {
		const a = new CodexAgent();

		// Failure path: readSession wraps fs error with "failed to read transcript"
		it('readSession wraps fs.readFile non-ENOENT error with descriptive message', async () => {
			const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-rs-'));
			try {
				// pass tmp dir itself → EISDIR on readFile
				await expect(
					a.readSession(makeHookInput({ sessionId: 's', sessionRef: tmp })),
				).rejects.toThrow(/failed to read transcript/);
			} finally {
				await fs.rm(tmp, { recursive: true, force: true });
			}
		});

		// Failure path: writeSession wraps fs error with "failed to write transcript"
		it('writeSession wraps fs.writeFile error with descriptive message', async () => {
			const session: AgentSession = {
				sessionId: 's',
				agentName: AGENT_NAME_CODEX,
				repoPath: '',
				// non-existent parent dir → ENOENT on writeFile
				sessionRef: '/nonexistent/dir/r.jsonl',
				startTime: new Date(),
				nativeData: new TextEncoder().encode(SAMPLE_ROLLOUT),
				modifiedFiles: [],
				newFiles: [],
				deletedFiles: [],
				entries: [],
			};
			await expect(a.writeSession(session)).rejects.toThrow(/failed to write transcript/);
		});

		// Failure path: readTranscript wraps fs error
		it('readTranscript wraps fs.readFile error', async () => {
			await expect(a.readTranscript('/nonexistent/x.jsonl')).rejects.toThrow(
				/failed to read transcript/,
			);
		});

		// Failure path: chunkTranscript wraps chunkJSONL error (single line over maxSize)
		it('chunkTranscript wraps chunkJSONL error when single line exceeds maxSize', async () => {
			const huge = new TextEncoder().encode(`${'x'.repeat(200)}\n`);
			await expect(a.chunkTranscript(huge, 100)).rejects.toThrow(/failed to chunk JSONL/);
		});

		// resolveSessionFile fallback when sessionDir empty + no glob match
		it('resolveSessionFile returns sessionId itself when sessionDir empty + glob fails', async () => {
			expect(await a.resolveSessionFile('', 'sid-empty-dir')).toBe('sid-empty-dir');
		});

		// Cover class-level delegation methods (uninstall / areHooks / getTranscriptPosition /
		// extractModifiedFilesFromOffset / calculateTokenUsage / extractPrompts)
		it('class delegation methods route through to module-level impls', async () => {
			const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-deleg-'));
			try {
				await fs.mkdir(path.join(tmp, '.git'), { recursive: true });
				await fs.writeFile(path.join(tmp, '.git', 'HEAD'), 'ref: refs/heads/main\n');
				const oldCwd = process.cwd();
				process.chdir(tmp);
				try {
					expect(await a.areHooksInstalled()).toBe(false);
					await a.uninstallHooks(); // no-op; doesn't throw
					const p = path.join(tmp, 't.jsonl');
					await fs.writeFile(p, SAMPLE_ROLLOUT);
					expect(await a.getTranscriptPosition(p)).toBeGreaterThan(0);
					const r = await a.extractModifiedFilesFromOffset(p, 0);
					expect(r.files.length).toBeGreaterThan(0);
					const u = await a.calculateTokenUsage(new TextEncoder().encode(SAMPLE_ROLLOUT), 0);
					expect(u).toBeNull(); // no token_count in SAMPLE_ROLLOUT
					const prompts = await a.extractPrompts(p, 0);
					expect(prompts).toEqual(['Create a file called hello.txt']);
				} finally {
					process.chdir(oldCwd);
				}
			} finally {
				await fs.rm(tmp, { recursive: true, force: true });
			}
		});
	});

	describe('resolveCodexHome no-homedir', () => {
		// Failure path: os.homedir() returns '' (Bun guarantees this only via mocking)
		it('resolveCodexHome throws when no homedir + no CODEX_HOME', async () => {
			const a = new CodexAgent();
			delete process.env.CODEX_HOME;
			delete process.env.STORY_TEST_CODEX_SESSION_DIR;
			delete process.env.ENTIRE_TEST_CODEX_SESSION_DIR;
			const spy = vi.spyOn(os, 'homedir').mockReturnValue('');
			try {
				await expect(a.getSessionDir('')).rejects.toThrow(/home directory/);
			} finally {
				spy.mockRestore();
			}
		});
	});
});
