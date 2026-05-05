import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asHookResponseWriter, asHookSupport } from '@/agent/capabilities';
import {
	EVENT_TYPE_SESSION_END,
	EVENT_TYPE_SESSION_START,
	EVENT_TYPE_TURN_END,
	EVENT_TYPE_TURN_START,
} from '@/agent/event';
import { clearForTesting, get, getByAgentType } from '@/agent/registry';
import type { AgentSession, HookInput } from '@/agent/session';
import { AGENT_NAME_VOGON, AGENT_TYPE_VOGON, VogonAgent } from '@/agent/vogon';
import { captureStdout, makeFakeStdin, withMockProcessEnv } from './_helpers';

// Go: vogon/vogon.go (Identity + Storage + Session methods)
// Go: vogon/hooks.go (HookSupport + HookResponseWriter)

describe('agent/vogon — Go: vogon/vogon.go + vogon/hooks.go', () => {
	let restoreEnv: (() => void) | null = null;

	afterEach(() => {
		if (restoreEnv) {
			restoreEnv();
			restoreEnv = null;
		}
	});

	describe('bootstrap registration', () => {
		// Go: vogon/vogon.go:18-21 (init() → agent.Register).
		// Phase 6.3 polish: TS no longer self-registers at module load (AGENTS.md
		// §异步/模块边界); registration is centralized in `src/agent/bootstrap.ts`.
		it('Vogon is registered under AGENT_NAME_VOGON / AGENT_TYPE_VOGON after bootstrap', async () => {
			const { registerBuiltinAgents } = await import('@/agent/bootstrap');
			const { withTestRegistry } = await import('@/agent/registry');
			await withTestRegistry(async () => {
				registerBuiltinAgents();
				expect(get(AGENT_NAME_VOGON)).toBeInstanceOf(VogonAgent);
				expect(getByAgentType(AGENT_TYPE_VOGON)).toBeInstanceOf(VogonAgent);
			});
		});
	});

	describe('Identity', () => {
		// Go: vogon/vogon.go:36-48
		it('name / type / description / isPreview / detectPresence / protectedDirs / isTestOnly', async () => {
			const v = new VogonAgent();
			expect(v.name()).toBe(AGENT_NAME_VOGON);
			expect(v.type()).toBe(AGENT_TYPE_VOGON);
			expect(v.description()).toBe('Vogon Agent - deterministic E2E canary (no API calls)');
			expect(v.isPreview()).toBe(false);
			await expect(v.detectPresence()).resolves.toBe(false);
			expect(v.protectedDirs()).toEqual(['.vogon']);
			expect(v.isTestOnly()).toBe(true);
		});
	});

	describe('Transcript Storage', () => {
		// Go: vogon/vogon.go:60-69 (chunk → ChunkJSONL; reassemble → ReassembleJSONL).
		it('chunkTranscript delegates to JSONL chunker; small content → [content]', async () => {
			const v = new VogonAgent();
			const content = new TextEncoder().encode('{"a":1}\n{"b":2}\n');
			expect(await v.chunkTranscript(content, 1024)).toHaveLength(1);
		});
		it('reassembleTranscript joins chunks with newline', async () => {
			const v = new VogonAgent();
			const a = new TextEncoder().encode('a');
			const b = new TextEncoder().encode('b');
			const r = await v.reassembleTranscript([a, b]);
			expect(new TextDecoder().decode(r)).toBe('a\nb');
		});
	});

	describe('getSessionDir env override', () => {
		// Go: vogon/vogon.go:76-85 (GetSessionDir reads ENTIRE_TEST_VOGON_PROJECT_DIR,
		// then defaults to ~/.vogon/sessions).
		// Story-side divergence: STORY_TEST_VOGON_PROJECT_DIR preferred +
		// ENTIRE_TEST_VOGON_PROJECT_DIR back-compat fallback.
		it('respects STORY_TEST_VOGON_PROJECT_DIR (Story-canonical)', async () => {
			restoreEnv = withMockProcessEnv({
				STORY_TEST_VOGON_PROJECT_DIR: '/tmp/story-vogon',
				ENTIRE_TEST_VOGON_PROJECT_DIR: undefined,
			});
			const v = new VogonAgent();
			expect(await v.getSessionDir('/repo')).toBe('/tmp/story-vogon');
		});

		it('falls back to ENTIRE_TEST_VOGON_PROJECT_DIR when STORY_ unset (back-compat)', async () => {
			restoreEnv = withMockProcessEnv({
				STORY_TEST_VOGON_PROJECT_DIR: undefined,
				ENTIRE_TEST_VOGON_PROJECT_DIR: '/tmp/legacy-vogon',
			});
			const v = new VogonAgent();
			expect(await v.getSessionDir('/repo')).toBe('/tmp/legacy-vogon');
		});

		it('defaults to ~/.vogon/sessions when both env vars are unset', async () => {
			restoreEnv = withMockProcessEnv({
				STORY_TEST_VOGON_PROJECT_DIR: undefined,
				ENTIRE_TEST_VOGON_PROJECT_DIR: undefined,
			});
			const v = new VogonAgent();
			expect(await v.getSessionDir('/repo')).toBe(path.join(os.homedir(), '.vogon', 'sessions'));
		});
	});

	describe('writeSession', () => {
		// Go: vogon/vogon.go:115-129 (mkdir 0o750 + writeFile 0o600).
		let tmpDir: string;
		beforeEach(async () => {
			tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vogon-test-'));
		});
		afterEach(async () => {
			await fs.rm(tmpDir, { recursive: true, force: true });
		});

		it('creates dir + writes nativeData with mode 0o600', async () => {
			const v = new VogonAgent();
			const sessionRef = path.join(tmpDir, 'subdir', 'sess.jsonl');
			const data = new TextEncoder().encode('{"x":1}\n');
			const session: AgentSession = {
				sessionId: 'sess-1',
				agentName: AGENT_NAME_VOGON,
				repoPath: '/repo',
				sessionRef,
				startTime: new Date(0),
				nativeData: data,
				modifiedFiles: [],
				newFiles: [],
				deletedFiles: [],
				entries: [],
			};
			await v.writeSession(session);
			const written = await fs.readFile(sessionRef);
			expect(written).toEqual(Buffer.from(data));
			const stat = await fs.stat(sessionRef);
			// Mode-bits: file should be 0o600 (octal 384). On some platforms
			// (Windows / weird umask) modes vary; assert the user bits only.
			if (process.platform !== 'win32') {
				expect(stat.mode & 0o777).toBe(0o600);
			}
		});

		it('throws when sessionRef is empty', async () => {
			const v = new VogonAgent();
			const session: AgentSession = {
				sessionId: 'sess-1',
				agentName: AGENT_NAME_VOGON,
				repoPath: '/repo',
				sessionRef: '',
				startTime: new Date(0),
				nativeData: new Uint8Array(),
				modifiedFiles: [],
				newFiles: [],
				deletedFiles: [],
				entries: [],
			};
			await expect(v.writeSession(session)).rejects.toThrow(/session reference/);
		});
	});

	describe('parseHookEvent (4 hook routing)', () => {
		// Go: vogon/hooks.go:37-94
		const v = new VogonAgent();

		it('session-start → SessionStart event', async () => {
			const stdin = makeFakeStdin(
				JSON.stringify({
					session_id: 'sid',
					transcript_path: '/tmp/sess.jsonl',
					model: 'm',
				}),
			);
			const ev = await v.parseHookEvent('session-start', stdin);
			expect(ev?.type).toBe(EVENT_TYPE_SESSION_START);
			expect(ev?.sessionId).toBe('sid');
			expect(ev?.sessionRef).toBe('/tmp/sess.jsonl');
			expect(ev?.model).toBe('m');
		});

		it('user-prompt-submit → TurnStart with prompt', async () => {
			const stdin = makeFakeStdin(
				JSON.stringify({
					session_id: 'sid',
					transcript_path: '/tmp/sess.jsonl',
					prompt: 'hello',
				}),
			);
			const ev = await v.parseHookEvent('user-prompt-submit', stdin);
			expect(ev?.type).toBe(EVENT_TYPE_TURN_START);
			expect(ev?.prompt).toBe('hello');
		});

		it('stop → TurnEnd', async () => {
			const stdin = makeFakeStdin(
				JSON.stringify({ session_id: 'sid', transcript_path: '/tmp/sess.jsonl' }),
			);
			const ev = await v.parseHookEvent('stop', stdin);
			expect(ev?.type).toBe(EVENT_TYPE_TURN_END);
		});

		it('session-end → SessionEnd', async () => {
			const stdin = makeFakeStdin(
				JSON.stringify({ session_id: 'sid', transcript_path: '/tmp/sess.jsonl' }),
			);
			const ev = await v.parseHookEvent('session-end', stdin);
			expect(ev?.type).toBe(EVENT_TYPE_SESSION_END);
		});

		it('unknown hook → null (silent skip)', async () => {
			const ev = await v.parseHookEvent('unknown-verb', makeFakeStdin('{}'));
			expect(ev).toBeNull();
		});
	});

	describe('HookSupport conformance', () => {
		// Go: vogon/hooks.go:14-17 (compile-time HookSupport + HookResponseWriter).
		it('asHookSupport returns Vogon as HookSupport', () => {
			const v = new VogonAgent();
			const [hs, ok] = asHookSupport(v);
			expect(ok).toBe(true);
			expect(hs).toBe(v);
		});

		it('hookNames returns 4 verbs in Go order', () => {
			expect(new VogonAgent().hookNames()).toEqual([
				'session-start',
				'session-end',
				'stop',
				'user-prompt-submit',
			]);
		});

		it('installHooks() returns 0; uninstallHooks() resolves; areHooksInstalled() = false', async () => {
			const v = new VogonAgent();
			expect(await v.installHooks({ localDev: false, force: false })).toBe(0);
			await expect(v.uninstallHooks()).resolves.toBeUndefined();
			expect(await v.areHooksInstalled()).toBe(false);
		});
	});

	describe('writeHookResponse', () => {
		// Go: vogon/hooks.go:112-117 (fmt.Fprintln to stdout — single line + \n).
		it('writes message + newline to stdout', async () => {
			const v = new VogonAgent();
			const out = await captureStdout(async () => {
				await v.writeHookResponse('hello vogon');
			});
			expect(out).toBe('hello vogon\n');
		});

		it('asHookResponseWriter returns Vogon as HookResponseWriter', () => {
			const v = new VogonAgent();
			const [hrw, ok] = asHookResponseWriter(v);
			expect(ok).toBe(true);
			expect(hrw).toBe(v);
		});
	});

	describe('formatResumeCommand / readSession / readTranscript', () => {
		it('formatResumeCommand returns Go-aligned literal', () => {
			expect(new VogonAgent().formatResumeCommand('sid')).toBe('vogon --session-id sid');
		});

		it('readSession with empty SessionRef rejects', async () => {
			const v = new VogonAgent();
			const input: HookInput = {
				hookType: 'session_start',
				sessionId: 's',
				sessionRef: '',
				timestamp: new Date(),
				userPrompt: '',
				toolName: '',
				toolUseId: '',
				toolInput: null,
				toolResponse: null,
				rawData: {},
			};
			await expect(v.readSession(input)).rejects.toThrow(/session reference/);
		});

		it('readTranscript reads file bytes', async () => {
			const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vogon-rt-'));
			const file = path.join(tmp, 'rt.jsonl');
			await fs.writeFile(file, '{"x":1}\n');
			try {
				expect(new TextDecoder().decode(await new VogonAgent().readTranscript(file))).toBe(
					'{"x":1}\n',
				);
			} finally {
				await fs.rm(tmp, { recursive: true, force: true });
			}
		});

		it('readTranscript missing file → throws "read transcript: ..."', async () => {
			await expect(new VogonAgent().readTranscript('/nonexistent/path.jsonl')).rejects.toThrow(
				/read transcript:/,
			);
		});

		it('readSession ENOENT → returns empty session (Go: vogon.go:97-104)', async () => {
			// Go quirk: missing transcript is NOT an error — returns empty session
			// with only sessionId / agentName / sessionRef populated.
			const v = new VogonAgent();
			const input: HookInput = {
				hookType: 'session_start',
				sessionId: 's-empty',
				sessionRef: '/nonexistent/path.jsonl',
				timestamp: new Date(),
				userPrompt: '',
				toolName: '',
				toolUseId: '',
				toolInput: null,
				toolResponse: null,
				rawData: {},
			};
			const session = await v.readSession(input);
			expect(session).not.toBeNull();
			expect(session?.sessionId).toBe('s-empty');
			expect(session?.agentName).toBe(AGENT_NAME_VOGON);
			expect(session?.sessionRef).toBe('/nonexistent/path.jsonl');
			expect(session?.nativeData.length).toBe(0);
		});

		it('readSession populated transcript → returns session with nativeData', async () => {
			const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vogon-rs-'));
			const file = path.join(tmp, 'rs.jsonl');
			await fs.writeFile(file, '{"x":1}\n');
			try {
				const v = new VogonAgent();
				const input: HookInput = {
					hookType: 'session_start',
					sessionId: 's-real',
					sessionRef: file,
					timestamp: new Date(),
					userPrompt: '',
					toolName: '',
					toolUseId: '',
					toolInput: null,
					toolResponse: null,
					rawData: {},
				};
				const session = await v.readSession(input);
				expect(new TextDecoder().decode(session?.nativeData)).toBe('{"x":1}\n');
			} finally {
				await fs.rm(tmp, { recursive: true, force: true });
			}
		});

		it('writeSession on read-only parent dir → wraps "write session: ..."', async () => {
			// Use an unwritable mount point (root /) to force EACCES on writeFile.
			// On most CI / dev machines, attempting to write to /vogon-test/* fails
			// with either EACCES (write to root) or some EBUSY/EROFS variant.
			if (process.platform === 'win32') {
				return; // skip on Windows
			}
			const v = new VogonAgent();
			const session: AgentSession = {
				sessionId: 'sess-1',
				agentName: AGENT_NAME_VOGON,
				repoPath: '/repo',
				sessionRef: '/forbidden-vogon-write-test/sess.jsonl',
				startTime: new Date(0),
				nativeData: new Uint8Array(),
				modifiedFiles: [],
				newFiles: [],
				deletedFiles: [],
				entries: [],
			};
			// Either mkdir fails ("create session dir") or writeFile fails ("write session"). Both are valid Go-aligned errors.
			await expect(v.writeSession(session)).rejects.toThrow(/(create session dir|write session):/);
		});
	});
});

// `clearForTesting` is exported but should not be called between Vogon tests
// (Vogon's self-register on import is a one-shot side-effect; clearing would
// erase it from this module-level singleton). Reference here keeps biome calm.
void clearForTesting;
