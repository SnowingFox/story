/**
 * Tests for `src/agent/claude-code/index.ts` — Mirrors Go
 * `entire-cli/cmd/entire/cli/agent/claudecode/claude.go` +
 * `paths/paths.go: SanitizePathForClaude / ExtractSessionIDFromTranscriptPath`.
 *
 * Covers:
 * - Identity (5 method)
 * - detectPresence (3 case)
 * - getSessionDir env override + asymmetry with getSessionBaseDir (5 case)
 * - sanitizePathForClaude (3 case)
 * - extractSessionIdFromTranscriptPath (5 case incl. Windows-style)
 * - resolveSessionFile (1 case)
 * - formatResumeCommand (1 case)
 * - readSession + writeSession round-trip + 4 failure paths
 * - readSessionFromPath (1 case)
 * - chunkTranscript / reassembleTranscript / readTranscript (3 case)
 * - getTranscriptPosition (5 case incl. ENOENT/empty/missing-trailing-nl)
 * - extractModifiedFilesFromOffset (3 case incl. ENOENT throws)
 * - truncateAtUUID + findCheckpointUUID on session (4 case)
 * - self-register (1 case)
 *
 * Imports `@/agent/claude-code` triggers the module-level
 * `register(AGENT_NAME_CLAUDE_CODE, ...)`. Tests use {@link withMockProcessEnv}
 * to scope `STORY_TEST_CLAUDE_PROJECT_DIR` overrides.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	ClaudeCodeAgent,
	claudeCodeAgent,
	extractSessionIdFromTranscriptPath,
	sanitizePathForClaude,
} from '@/agent/claude-code';
import { get, getByAgentType } from '@/agent/registry';
import { AGENT_NAME_CLAUDE_CODE, AGENT_TYPE_CLAUDE_CODE } from '@/agent/types';
import { withMockProcessEnv } from '../_helpers';

// --- module-level self-register (importing @/agent/claude-code did this) ---

describe('agent/claude-code/index — Go: claude.go + paths.go', () => {
	let restoreEnv: (() => void) | null = null;
	afterEach(() => {
		if (restoreEnv) {
			restoreEnv();
			restoreEnv = null;
		}
	});

	describe('bootstrap registration', () => {
		// Go: claude.go:23-26 (init() → agent.Register).
		// Phase 6.3 polish: TS no longer self-registers at module load (AGENTS.md
		// §异步/模块边界); registration is centralized in `src/agent/bootstrap.ts`.
		it('Claude Code is registered under AGENT_NAME / AGENT_TYPE after bootstrap', async () => {
			const { registerBuiltinAgents } = await import('@/agent/bootstrap');
			const { withTestRegistry } = await import('@/agent/registry');
			await withTestRegistry(async () => {
				registerBuiltinAgents();
				expect(get(AGENT_NAME_CLAUDE_CODE)).toBeInstanceOf(ClaudeCodeAgent);
				expect(getByAgentType(AGENT_TYPE_CLAUDE_CODE)).toBeInstanceOf(ClaudeCodeAgent);
			});
		});

		// Go: claude.go:36-38 (NewClaudeCodeAgent factory)
		it('factory returns a fresh instance each call', () => {
			const a = claudeCodeAgent();
			const b = claudeCodeAgent();
			expect(a).toBeInstanceOf(ClaudeCodeAgent);
			expect(b).toBeInstanceOf(ClaudeCodeAgent);
			expect(a).not.toBe(b);
		});
	});

	describe('Identity', () => {
		// Go: claude.go:41-55
		it('name / type / description / isPreview / protectedDirs', () => {
			const a = new ClaudeCodeAgent();
			expect(a.name()).toBe(AGENT_NAME_CLAUDE_CODE);
			expect(a.type()).toBe(AGENT_TYPE_CLAUDE_CODE);
			expect(a.description()).toBe("Claude Code - Anthropic's CLI coding assistant");
			expect(a.isPreview()).toBe(false);
			expect(a.protectedDirs()).toEqual(['.claude']);
		});
	});

	describe('detectPresence', () => {
		// Go: claude.go:57-78
		let tmp: string;
		beforeEach(async () => {
			tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-detect-'));
		});
		afterEach(async () => {
			await fs.rm(tmp, { recursive: true, force: true });
		});

		// Use a spy-on worktreeRoot to point to the tmp dir.
		async function detectIn(repo: string): Promise<boolean> {
			// Cwd to the repo so the (worktreeRoot or '.') fallback resolves there.
			const orig = process.cwd();
			try {
				process.chdir(repo);
				return await new ClaudeCodeAgent().detectPresence();
			} finally {
				process.chdir(orig);
			}
		}

		// Go: claude.go:67-71 (.claude dir exists → true).
		it('true when .claude/ directory exists', async () => {
			await fs.mkdir(path.join(tmp, '.claude'));
			expect(await detectIn(tmp)).toBe(true);
		});

		// Go: claude.go:69 — `os.Stat(claudeDir)` returns true on ANY filesystem
		// entry (dir / regular file / symlink target). This Story-side test
		// catches a real Go-parity bug: an earlier TS impl gated on
		// `stat.isDirectory()` and returned false for the regular-file case,
		// which Go would have called true. Rare in practice (a user would
		// have to `touch .claude` accidentally) but a real divergence.
		it('true when .claude is a regular file (Go-parity edge case)', async () => {
			await fs.writeFile(path.join(tmp, '.claude'), 'accidental file');
			expect(await detectIn(tmp)).toBe(true);
		});

		// Go: claude.go:73-76 — defense-in-depth fallback. In practice, when
		// the first stat fails, the second usually fails too (ENOENT or
		// ENOTDIR). The "dir + settings.json" fixture exercises the dir branch
		// (first stat success short-circuits to true), so this case overlaps
		// with the first; kept for documentation of the fallback's existence.
		it('true when .claude/settings.json file exists (dir + file fixture)', async () => {
			await fs.mkdir(path.join(tmp, '.claude'));
			await fs.writeFile(path.join(tmp, '.claude', 'settings.json'), '{}');
			expect(await detectIn(tmp)).toBe(true);
		});

		// Go: claude.go:77 (neither → false).
		it('false when neither .claude dir nor settings.json exists', async () => {
			expect(await detectIn(tmp)).toBe(false);
		});
	});

	describe('getSessionDir env override (Story-side rebrand)', () => {
		// Go: claude.go:94-108 + Story-side STORY_/ENTIRE_ env precedence (mirrors vogon).
		it('respects STORY_TEST_CLAUDE_PROJECT_DIR (Story-canonical)', async () => {
			restoreEnv = withMockProcessEnv({
				STORY_TEST_CLAUDE_PROJECT_DIR: '/tmp/story-claude',
				ENTIRE_TEST_CLAUDE_PROJECT_DIR: undefined,
			});
			expect(await new ClaudeCodeAgent().getSessionDir('/repo')).toBe('/tmp/story-claude');
		});

		it('falls back to ENTIRE_TEST_CLAUDE_PROJECT_DIR when STORY_ unset (back-compat)', async () => {
			restoreEnv = withMockProcessEnv({
				STORY_TEST_CLAUDE_PROJECT_DIR: undefined,
				ENTIRE_TEST_CLAUDE_PROJECT_DIR: '/tmp/legacy-claude',
			});
			expect(await new ClaudeCodeAgent().getSessionDir('/repo')).toBe('/tmp/legacy-claude');
		});

		it('computes ~/.claude/projects/<sanitized> when no env override (leading / → -)', async () => {
			restoreEnv = withMockProcessEnv({
				STORY_TEST_CLAUDE_PROJECT_DIR: undefined,
				ENTIRE_TEST_CLAUDE_PROJECT_DIR: undefined,
			});
			const result = await new ClaudeCodeAgent().getSessionDir('/Users/me/proj');
			// Go: nonAlphanumericRegex replaces every non-alphanumeric, including
			// leading `/` → `-`. Mirrors Go regex `[^a-zA-Z0-9]`.
			expect(result).toBe(path.join(os.homedir(), '.claude', 'projects', '-Users-me-proj'));
		});

		// Go: claude.go:101-104 (failed homedir → error).
		it('throws when homedir is empty (mocked)', async () => {
			restoreEnv = withMockProcessEnv({
				STORY_TEST_CLAUDE_PROJECT_DIR: undefined,
				ENTIRE_TEST_CLAUDE_PROJECT_DIR: undefined,
			});
			const spy = vi.spyOn(os, 'homedir').mockReturnValue('');
			try {
				await expect(new ClaudeCodeAgent().getSessionDir('/repo')).rejects.toThrow(
					/failed to get home directory/,
				);
			} finally {
				spy.mockRestore();
			}
		});
	});

	describe('getSessionBaseDir asymmetry', () => {
		// Go: claude.go:110-119 — explicitly does NOT read ENTIRE_TEST_CLAUDE_PROJECT_DIR.
		// Story preserves the asymmetry (does not read STORY_TEST_* either).
		it('does NOT read STORY_TEST_CLAUDE_PROJECT_DIR (intentional asymmetry vs getSessionDir)', async () => {
			restoreEnv = withMockProcessEnv({
				STORY_TEST_CLAUDE_PROJECT_DIR: '/tmp/should-be-ignored',
				ENTIRE_TEST_CLAUDE_PROJECT_DIR: undefined,
			});
			const result = await new ClaudeCodeAgent().getSessionBaseDir();
			expect(result).toBe(path.join(os.homedir(), '.claude', 'projects'));
			expect(result).not.toContain('should-be-ignored');
		});

		it('returns ~/.claude/projects', async () => {
			const result = await new ClaudeCodeAgent().getSessionBaseDir();
			expect(result).toBe(path.join(os.homedir(), '.claude', 'projects'));
		});

		it('throws when homedir is empty', async () => {
			const spy = vi.spyOn(os, 'homedir').mockReturnValue('');
			try {
				await expect(new ClaudeCodeAgent().getSessionBaseDir()).rejects.toThrow(
					/failed to get home directory/,
				);
			} finally {
				spy.mockRestore();
			}
		});
	});

	describe('sanitizePathForClaude', () => {
		// Go: claude.go:262-267 (regex replace [^a-zA-Z0-9] → '-').
		it('replaces non-alphanumeric with -', () => {
			expect(sanitizePathForClaude('/Users/me/proj')).toBe('-Users-me-proj');
			expect(sanitizePathForClaude('/Users/me/My Proj/x')).toBe('-Users-me-My-Proj-x');
			expect(sanitizePathForClaude('alphaNUM123')).toBe('alphaNUM123');
		});
	});

	describe('extractSessionIdFromTranscriptPath (foundation backlog #19)', () => {
		// Go: paths.go: ExtractSessionIDFromTranscriptPath
		it('standard path → strip .jsonl suffix', () => {
			expect(
				extractSessionIdFromTranscriptPath('/Users/me/.claude/projects/foo/sessions/abc-123.jsonl'),
			).toBe('abc-123');
		});

		it('without sessions/ segment → empty string', () => {
			expect(extractSessionIdFromTranscriptPath('/foo/bar/baz.jsonl')).toBe('');
		});

		it('without .jsonl suffix → returns filename as-is', () => {
			expect(extractSessionIdFromTranscriptPath('/path/sessions/abc')).toBe('abc');
		});

		it('empty input → empty string', () => {
			expect(extractSessionIdFromTranscriptPath('')).toBe('');
		});

		// Story 补充 (testing-discipline 7 类盲区 #5: 平台分支不跑) — Windows-style path.
		it('Windows-style backslash path → normalized and parsed', () => {
			expect(
				extractSessionIdFromTranscriptPath(
					'C:\\Users\\me\\.claude\\projects\\foo\\sessions\\abc.jsonl',
				),
			).toBe('abc');
		});
	});

	describe('resolveSessionFile + formatResumeCommand', () => {
		// Go: claude_test.go:9-17 (TestResolveSessionFile)
		it('joins dir + sid + .jsonl', async () => {
			expect(
				await new ClaudeCodeAgent().resolveSessionFile(
					'/home/user/.claude/projects/foo',
					'abc-123-def',
				),
			).toBe('/home/user/.claude/projects/foo/abc-123-def.jsonl');
		});

		// Go: claude.go:181-183 (FormatResumeCommand → "claude -r " + id).
		it('formatResumeCommand produces literal "claude -r <id>"', () => {
			expect(new ClaudeCodeAgent().formatResumeCommand('sid-1')).toBe('claude -r sid-1');
		});
	});

	describe('readSession / writeSession round-trip', () => {
		let tmp: string;
		beforeEach(async () => {
			tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-rs-'));
		});
		afterEach(async () => {
			await fs.rm(tmp, { recursive: true, force: true });
		});

		// Go: claude.go:121-149 + 151-178 (Read/Write round-trip preserves bytes).
		it('reads then writes preserves transcript bytes + computes modifiedFiles', async () => {
			const ag = new ClaudeCodeAgent();
			const src = path.join(tmp, 'in.jsonl');
			const original = Buffer.from(
				`{"type":"user","uuid":"u1","message":{"content":"hi"}}\n` +
					`{"type":"assistant","uuid":"a1","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"x.ts"}}]}}\n`,
			);
			await fs.writeFile(src, original);
			const session = await ag.readSession({
				hookType: 'session_start',
				sessionId: 'sid',
				sessionRef: src,
				timestamp: new Date(),
				userPrompt: '',
				toolName: '',
				toolUseId: '',
				toolInput: null,
				toolResponse: null,
				rawData: {},
			});
			expect(session.modifiedFiles).toEqual(['x.ts']);
			expect(Buffer.from(session.nativeData).equals(original)).toBe(true);

			const dst = path.join(tmp, 'out.jsonl');
			await ag.writeSession({ ...session, sessionRef: dst });
			const written = await fs.readFile(dst);
			expect(written.equals(original)).toBe(true);
			// Mode 0o600 (Go: WriteFile mode 0o600).
			const st = await fs.stat(dst);
			expect((st.mode & 0o777).toString(8)).toBe('600');
		});

		// Go: claude.go:125-127 (empty SessionRef → error).
		it('readSession throws when sessionRef is empty', async () => {
			const ag = new ClaudeCodeAgent();
			await expect(
				ag.readSession({
					hookType: 'session_start',
					sessionId: 'sid',
					sessionRef: '',
					timestamp: new Date(),
					userPrompt: '',
					toolName: '',
					toolUseId: '',
					toolInput: null,
					toolResponse: null,
					rawData: {},
				}),
			).rejects.toThrow(/session reference/);
		});

		// Go: claude.go:160-162 (mismatched agentName → error).
		it('writeSession throws when agentName mismatches', async () => {
			const ag = new ClaudeCodeAgent();
			await expect(
				ag.writeSession({
					sessionId: 'sid',
					agentName: 'cursor' as never,
					repoPath: '',
					sessionRef: path.join(tmp, 'a.jsonl'),
					startTime: new Date(0),
					nativeData: new Uint8Array([1]),
					modifiedFiles: [],
					newFiles: [],
					deletedFiles: [],
					entries: [],
				}),
			).rejects.toThrow(/cursor/);
		});

		// Go: claude.go:168-170 (empty NativeData → error).
		it('writeSession throws when nativeData is empty', async () => {
			const ag = new ClaudeCodeAgent();
			await expect(
				ag.writeSession({
					sessionId: 'sid',
					agentName: AGENT_NAME_CLAUDE_CODE,
					repoPath: '',
					sessionRef: path.join(tmp, 'a.jsonl'),
					startTime: new Date(0),
					nativeData: new Uint8Array(),
					modifiedFiles: [],
					newFiles: [],
					deletedFiles: [],
					entries: [],
				}),
			).rejects.toThrow(/no native data/);
		});

		// Go: claude.go:164-166 (empty SessionRef → error).
		it('writeSession throws when sessionRef is empty', async () => {
			const ag = new ClaudeCodeAgent();
			await expect(
				ag.writeSession({
					sessionId: 'sid',
					agentName: '' as never,
					repoPath: '',
					sessionRef: '',
					startTime: new Date(0),
					nativeData: new Uint8Array([1]),
					modifiedFiles: [],
					newFiles: [],
					deletedFiles: [],
					entries: [],
				}),
			).rejects.toThrow(/session reference/);
		});

		it('readSessionFromPath delegates to readSession', async () => {
			const ag = new ClaudeCodeAgent();
			const src = path.join(tmp, 'rsp.jsonl');
			await fs.writeFile(src, '{"type":"user","uuid":"u1","message":{}}\n');
			const session = await ag.readSessionFromPath(src, 'sid-rsp');
			expect(session.sessionId).toBe('sid-rsp');
			expect(session.sessionRef).toBe(src);
		});
	});

	describe('Transcript Storage (read / chunk / reassemble)', () => {
		let tmp: string;
		beforeEach(async () => {
			tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-ts-'));
		});
		afterEach(async () => {
			await fs.rm(tmp, { recursive: true, force: true });
		});

		it('readTranscript returns raw bytes', async () => {
			const ag = new ClaudeCodeAgent();
			const src = path.join(tmp, 'r.jsonl');
			await fs.writeFile(src, '{"a":1}\n');
			const out = await ag.readTranscript(src);
			expect(new TextDecoder().decode(out)).toBe('{"a":1}\n');
		});

		it('readTranscript wraps fs error', async () => {
			const ag = new ClaudeCodeAgent();
			await expect(ag.readTranscript(path.join(tmp, 'missing.jsonl'))).rejects.toThrow(
				/failed to read transcript/,
			);
		});

		it('chunkTranscript / reassembleTranscript round-trip small content', async () => {
			const ag = new ClaudeCodeAgent();
			const content = new TextEncoder().encode('{"a":1}\n{"b":2}\n');
			const chunks = await ag.chunkTranscript(content, 1024);
			expect(chunks).toHaveLength(1);
			const reassembled = await ag.reassembleTranscript(chunks);
			expect(new TextDecoder().decode(reassembled)).toBe('{"a":1}\n{"b":2}\n');
		});
	});

	describe('getTranscriptPosition (TranscriptAnalyzer)', () => {
		let tmp: string;
		beforeEach(async () => {
			tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-pos-'));
		});
		afterEach(async () => {
			await fs.rm(tmp, { recursive: true, force: true });
		});

		// Go: claude.go:277-279
		it('empty path returns 0 (success, not error)', async () => {
			expect(await new ClaudeCodeAgent().getTranscriptPosition('')).toBe(0);
		});

		// Go: claude.go:283-285 (ENOENT → 0).
		it('non-existent file returns 0 (success, not error)', async () => {
			expect(
				await new ClaudeCodeAgent().getTranscriptPosition(path.join(tmp, 'missing.jsonl')),
			).toBe(0);
		});

		// Go: claude.go:296-300 (final partial line counted).
		it('counts lines + final partial line without trailing newline', async () => {
			const ag = new ClaudeCodeAgent();
			const file = path.join(tmp, 'p.jsonl');
			await fs.writeFile(file, '{"a":1}\n{"b":2}\n{"c":3}'); // 3 lines, last without \n
			expect(await ag.getTranscriptPosition(file)).toBe(3);
		});

		it('empty file returns 0', async () => {
			const ag = new ClaudeCodeAgent();
			const file = path.join(tmp, 'e.jsonl');
			await fs.writeFile(file, '');
			expect(await ag.getTranscriptPosition(file)).toBe(0);
		});

		it('counts lines with trailing newline correctly', async () => {
			const ag = new ClaudeCodeAgent();
			const file = path.join(tmp, 't.jsonl');
			await fs.writeFile(file, '{"a":1}\n{"b":2}\n');
			expect(await ag.getTranscriptPosition(file)).toBe(2);
		});
	});

	describe('extractModifiedFilesFromOffset (TranscriptAnalyzer)', () => {
		let tmp: string;
		beforeEach(async () => {
			tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-emf-'));
		});
		afterEach(async () => {
			await fs.rm(tmp, { recursive: true, force: true });
		});

		// Go: claude.go:317-319 (empty path → empty result, no error).
		it('empty path returns empty result', async () => {
			const r = await new ClaudeCodeAgent().extractModifiedFilesFromOffset('', 0);
			expect(r).toEqual({ files: [], currentPosition: 0 });
		});

		// Go: claude.go:322-326 — asymmetric with getTranscriptPosition.
		// Missing file throws (NOT silent 0).
		it('missing file throws (asymmetric with getTranscriptPosition)', async () => {
			await expect(
				new ClaudeCodeAgent().extractModifiedFilesFromOffset(path.join(tmp, 'missing.jsonl'), 0),
			).rejects.toThrow(/failed to open transcript file/);
		});

		// Go: claude.go:339-353 — files filtered to lineNum > startOffset.
		it('extracts modifiedFiles and skips lines ≤ startOffset', async () => {
			const ag = new ClaudeCodeAgent();
			const file = path.join(tmp, 'em.jsonl');
			await fs.writeFile(
				file,
				`{"type":"assistant","uuid":"a1","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"old.ts"}}]}}\n` +
					`{"type":"assistant","uuid":"a2","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"new.ts"}}]}}\n`,
			);
			// Only line 2 considered (startOffset=1).
			const r = await ag.extractModifiedFilesFromOffset(file, 1);
			expect(r.files).toEqual(['new.ts']);
			expect(r.currentPosition).toBe(2);
		});
	});

	describe('truncateAtUUID + findCheckpointUUID on AgentSession', () => {
		const sample = (): import('@/agent/session').AgentSession => ({
			sessionId: 'sid',
			agentName: AGENT_NAME_CLAUDE_CODE,
			repoPath: '',
			sessionRef: '/x',
			startTime: new Date(0),
			nativeData: new TextEncoder().encode(
				`{"type":"user","uuid":"u1","message":{"content":[{"type":"tool_result","tool_use_id":"tool1"}]}}\n` +
					`{"type":"assistant","uuid":"a1","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"a.ts"}}]}}\n` +
					`{"type":"user","uuid":"u2","message":{"content":[{"type":"tool_result","tool_use_id":"tool2"}]}}\n`,
			),
			modifiedFiles: ['a.ts'],
			newFiles: [],
			deletedFiles: [],
			entries: [],
		});

		// Go: claude.go:188-234
		it('truncateAtUUID at u1 returns single-line transcript (no tool_use → no modifiedFiles)', async () => {
			const ag = new ClaudeCodeAgent();
			const out = await ag.truncateAtUUID(sample(), 'u1');
			expect(new TextDecoder().decode(out.nativeData).split('\n').filter(Boolean)).toHaveLength(1);
			expect(out.modifiedFiles).toEqual([]);
		});

		it('truncateAtUUID with empty UUID returns session with same nativeData', async () => {
			const ag = new ClaudeCodeAgent();
			const s = sample();
			const out = await ag.truncateAtUUID(s, '');
			expect(out.nativeData).toBe(s.nativeData);
		});

		it('truncateAtUUID throws when nativeData is empty', async () => {
			const ag = new ClaudeCodeAgent();
			const s = sample();
			s.nativeData = new Uint8Array();
			await expect(ag.truncateAtUUID(s, 'u1')).rejects.toThrow(/no native data/);
		});

		// Go: claude.go:201-209 / 225-233 — truncated session zero-initializes
		// auxiliary fields (NewFiles / DeletedFiles / Entries) regardless of
		// the input session's values. Mirrors that contract.
		it('truncateAtUUID zero-initializes newFiles/deletedFiles/entries (Go-parity)', async () => {
			const ag = new ClaudeCodeAgent();
			const s = sample();
			// Pre-populate aux fields to verify they get cleared.
			s.newFiles = ['n1.ts', 'n2.ts'];
			s.deletedFiles = ['d1.ts'];
			s.entries = [
				{
					uuid: 'e1',
					type: 'user',
					timestamp: new Date(0),
					content: 'x',
					toolName: '',
					toolInput: null,
					toolOutput: null,
					filesAffected: [],
				},
			];

			// Truncated path
			const truncated = await ag.truncateAtUUID(s, 'u1');
			expect(truncated.newFiles).toEqual([]);
			expect(truncated.deletedFiles).toEqual([]);
			expect(truncated.entries).toEqual([]);

			// Empty-UUID path
			const samePath = await ag.truncateAtUUID(s, '');
			expect(samePath.newFiles).toEqual([]);
			expect(samePath.deletedFiles).toEqual([]);
			expect(samePath.entries).toEqual([]);
			// nativeData reference preserved on the empty-UUID branch.
			expect(samePath.nativeData).toBe(s.nativeData);
		});

		// Go: claude.go:236-249
		it('findCheckpointUUID maps tool_use_id to user UUID', async () => {
			const ag = new ClaudeCodeAgent();
			expect(await ag.findCheckpointUUID(sample(), 'tool1')).toBe('u1');
			expect(await ag.findCheckpointUUID(sample(), 'tool2')).toBe('u2');
			expect(await ag.findCheckpointUUID(sample(), 'unknown')).toBeNull();
		});

		it('findCheckpointUUID returns null for empty nativeData', async () => {
			const ag = new ClaudeCodeAgent();
			const s = sample();
			s.nativeData = new Uint8Array();
			expect(await ag.findCheckpointUUID(s, 'tool1')).toBeNull();
		});
	});

	describe('TextGenerator delegate', () => {
		// Verify the delegate threads through to ./generate (full behavior tested in generate.test.ts).
		it('generateText property exists and is callable', () => {
			const ag = new ClaudeCodeAgent();
			expect(typeof ag.generateText).toBe('function');
		});
	});
});
