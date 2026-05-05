import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	AGENT_TYPE_CLAUDE_CODE,
	AGENT_TYPE_CODEX,
	AGENT_TYPE_CURSOR,
	AGENT_TYPE_OPENCODE,
	AGENT_TYPE_UNKNOWN,
} from '@/agent/types';
import {
	clearFilesystemPrompt,
	countTranscriptItems,
	extractUserPrompts,
	extractUserPromptsFromLines,
	flattenTranscriptEntryToText,
	parseTranscriptDisplayLine,
	readPromptsFromFilesystem,
	splitPromptContent,
} from '@/strategy/transcript-prompts';
import { TestEnv } from '../../helpers/test-env';

// Cursor sample fixture mirrors the Go test corpus
// (manual_commit_condensation_test.go: cursorSampleTranscript).
// Go: cmd/entire/cli/strategy/manual_commit_condensation_test.go (cursorSampleTranscript)
const CURSOR_SAMPLE = `${[
	`{"role":"user","message":{"content":[{"type":"text","text":"<user_query>\\ncreate a file with contents 'a' and commit, then create another file with contents 'b' and commit\\n</user_query>"}]}}`,
	`{"role":"assistant","message":{"content":[{"type":"text","text":"Creating two files (contents 'a' and 'b') and committing each."}]}}`,
	`{"role":"assistant","message":{"content":[{"type":"text","text":"Both files are tracked and the working tree is clean."}]}}`,
	`{"role":"user","message":{"content":[{"type":"text","text":"<user_query>\\ncreate a file with contents 'c' and commit\\n</user_query>"}]}}`,
	`{"role":"assistant","message":{"content":[{"type":"text","text":"Created c.txt with contents c and committed it."}]}}`,
	`{"role":"user","message":{"content":[{"type":"text","text":"<user_query>\\nadd a file called bingo and commit\\n</user_query>"}]}}`,
	`{"role":"assistant","message":{"content":[{"type":"text","text":"Created bingo and committed it."}]}}`,
].join('\n')}\n`;

describe('transcript-prompts.countTranscriptItems', () => {
	// Go: cmd/entire/cli/strategy/manual_commit_condensation.go countTranscriptItems
	it('returns 0 for empty content', () => {
		expect(countTranscriptItems(AGENT_TYPE_CLAUDE_CODE, '')).toBe(0);
	});

	it('counts JSONL lines for Claude Code (trims trailing empty lines)', () => {
		expect(countTranscriptItems(AGENT_TYPE_CLAUDE_CODE, 'l1\nl2\nl3\n')).toBe(3);
		expect(countTranscriptItems(AGENT_TYPE_CLAUDE_CODE, 'l1\nl2\nl3')).toBe(3);
		// Trailing whitespace / blank lines absorbed.
		expect(countTranscriptItems(AGENT_TYPE_CLAUDE_CODE, 'l1\n\n\n')).toBe(1);
	});

	// Go: cmd/entire/cli/strategy/manual_commit_condensation_test.go TestCountTranscriptItems_Cursor
	it('counts JSONL lines for Cursor (same as Claude path)', () => {
		expect(countTranscriptItems(AGENT_TYPE_CURSOR, CURSOR_SAMPLE)).toBe(7);
	});

	// Go: cmd/entire/cli/strategy/manual_commit_condensation_test.go TestCountTranscriptItems_CursorEmpty
	it('returns 0 for Cursor empty content', () => {
		expect(countTranscriptItems(AGENT_TYPE_CURSOR, '')).toBe(0);
	});

	// Go: manual_commit_condensation.go:826-848 — Codex uses the generic JSONL
	// line count (its format is JSONL-compatible). Cursor already covered by
	// the dedicated tests above.
	// Note: Gemini CLI, Copilot CLI, and Factory AI Droid dropped from the
	// roadmap — see references/dropped-agents.md.
	it.each([AGENT_TYPE_CODEX])('uses JSONL line count for %s (Claude-compatible JSONL)', (agent) => {
		expect(countTranscriptItems(agent, 'l1\nl2\nl3\n')).toBe(3);
	});

	// OpenCode uses a native parser (parseExportSession) — counts messages
	// from the parsed `messages` array, NOT JSONL lines.
	it('counts messages via native parser for OpenCode', () => {
		const session = JSON.stringify({
			info: { id: 'test' },
			messages: [
				{ info: { role: 'user' }, parts: [{ type: 'text', text: 'hello' }] },
				{ info: { role: 'assistant' }, parts: [{ type: 'text', text: 'hi' }] },
				{ info: { role: 'user' }, parts: [{ type: 'text', text: 'bye' }] },
			],
		});
		expect(countTranscriptItems(AGENT_TYPE_OPENCODE, session)).toBe(3);
	});

	it('returns 0 for OpenCode with invalid JSON', () => {
		expect(countTranscriptItems(AGENT_TYPE_OPENCODE, 'not-json')).toBe(0);
	});

	it('returns 0 for OpenCode with empty messages array', () => {
		const session = JSON.stringify({ info: { id: 'test' }, messages: [] });
		expect(countTranscriptItems(AGENT_TYPE_OPENCODE, session)).toBe(0);
	});

	it('uses JSONL fallback for Unknown agent', () => {
		expect(countTranscriptItems(AGENT_TYPE_UNKNOWN, 'a\nb\n')).toBe(2);
	});
});

describe('transcript-prompts.extractUserPrompts', () => {
	// Go: cmd/entire/cli/strategy/manual_commit_condensation.go extractUserPrompts
	it('returns empty array for empty content', () => {
		expect(extractUserPrompts(AGENT_TYPE_CLAUDE_CODE, '')).toEqual([]);
	});

	// Go: cmd/entire/cli/strategy/manual_commit_condensation_test.go TestExtractUserPrompts_Cursor
	it('handles Cursor role-based JSONL and strips <user_query> tags', () => {
		const prompts = extractUserPrompts(AGENT_TYPE_CURSOR, CURSOR_SAMPLE);
		expect(prompts).toHaveLength(3);
		expect(prompts[0]).toContain("create a file with contents 'a'");
		expect(prompts[2]).toContain('bingo');
		for (const p of prompts) {
			expect(p).not.toContain('<user_query>');
			expect(p).not.toContain('</user_query>');
		}
	});

	// Go: cmd/entire/cli/strategy/manual_commit_condensation_test.go TestExtractUserPrompts_CursorEmpty
	it('returns empty array for Cursor empty content', () => {
		expect(extractUserPrompts(AGENT_TYPE_CURSOR, '')).toEqual([]);
	});

	it('handles Claude string content', () => {
		const line = JSON.stringify({
			type: 'user',
			message: { content: 'hello world' },
		});
		expect(extractUserPrompts(AGENT_TYPE_CLAUDE_CODE, `${line}\n`)).toEqual(['hello world']);
	});

	it('handles Claude array content (multiple text blocks)', () => {
		const line = JSON.stringify({
			type: 'user',
			message: {
				content: [
					{ type: 'text', text: 'block one' },
					{ type: 'text', text: 'block two' },
				],
			},
		});
		// Go: joined with `"\n\n"` then strip IDE tags.
		expect(extractUserPrompts(AGENT_TYPE_CLAUDE_CODE, `${line}\n`)).toEqual([
			'block one\n\nblock two',
		]);
	});

	// OpenCode uses native parser (extractAllUserPrompts) — extracts user
	// prompts from the parsed messages, strips <system-reminder> blocks.
	it('extracts prompts via native parser for OpenCode', () => {
		const session = JSON.stringify({
			info: { id: 'test' },
			messages: [
				{ info: { role: 'user' }, parts: [{ type: 'text', text: 'first prompt' }] },
				{ info: { role: 'assistant' }, parts: [{ type: 'text', text: 'response' }] },
				{ info: { role: 'user' }, parts: [{ type: 'text', text: 'second prompt' }] },
			],
		});
		expect(extractUserPrompts(AGENT_TYPE_OPENCODE, session)).toEqual([
			'first prompt',
			'second prompt',
		]);
	});

	it('returns [] for OpenCode with invalid JSON', () => {
		expect(extractUserPrompts(AGENT_TYPE_OPENCODE, 'not-json')).toEqual([]);
	});

	it('strips system-reminder blocks in OpenCode prompts', () => {
		const session = JSON.stringify({
			info: { id: 'test' },
			messages: [
				{
					info: { role: 'user' },
					parts: [{ type: 'text', text: 'real prompt<system-reminder>ctx</system-reminder>' }],
				},
			],
		});
		expect(extractUserPrompts(AGENT_TYPE_OPENCODE, session)).toEqual(['real prompt']);
	});

	it('skips system-reminder-only messages in OpenCode', () => {
		const session = JSON.stringify({
			info: { id: 'test' },
			messages: [
				{
					info: { role: 'user' },
					parts: [{ type: 'text', text: '<system-reminder>ctx</system-reminder>' }],
				},
				{ info: { role: 'user' }, parts: [{ type: 'text', text: 'real' }] },
			],
		});
		expect(extractUserPrompts(AGENT_TYPE_OPENCODE, session)).toEqual(['real']);
	});

	// Codex IS JSONL-compatible (Go: same JSONL extractor branch).
	// Note: Copilot CLI + Factory AI Droid dropped from the roadmap — see
	// references/dropped-agents.md.
	it.each([
		AGENT_TYPE_CODEX,
	])('extracts prompts via Claude JSONL parser for %s (Claude-compatible JSONL)', (agent) => {
		const line = JSON.stringify({ type: 'user', message: { content: 'hi' } });
		expect(extractUserPrompts(agent, `${line}\n`)).toEqual(['hi']);
	});
});

describe('transcript-prompts.extractUserPromptsFromLines', () => {
	// Go: cmd/entire/cli/strategy/manual_commit_condensation.go extractUserPromptsFromLines
	it('skips malformed JSON lines', () => {
		const lines = ['not json', JSON.stringify({ type: 'user', message: { content: 'kept' } })];
		expect(extractUserPromptsFromLines(lines)).toEqual(['kept']);
	});

	it("accepts both 'human' and 'user' types", () => {
		const lines = [
			JSON.stringify({ type: 'human', message: { content: 'human-text' } }),
			JSON.stringify({ type: 'user', message: { content: 'user-text' } }),
			JSON.stringify({ role: 'user', message: { content: 'role-user-text' } }),
		];
		expect(extractUserPromptsFromLines(lines)).toEqual([
			'human-text',
			'user-text',
			'role-user-text',
		]);
	});

	it('strips IDE context tags from prompts', () => {
		const lines = [
			JSON.stringify({
				type: 'user',
				message: {
					content: 'real prompt<ide_opened_file>foo.ts</ide_opened_file>',
				},
			}),
		];
		expect(extractUserPromptsFromLines(lines)).toEqual(['real prompt']);
	});

	it('extracts Vogon-style user prompt when message is a plain string', () => {
		const lines = [JSON.stringify({ type: 'user', message: 'plain-vogon-msg' })];
		expect(extractUserPromptsFromLines(lines)).toEqual(['plain-vogon-msg']);
	});
});

describe('transcript-prompts.flattenTranscriptEntryToText', () => {
	it('handles Claude flat content string', () => {
		expect(flattenTranscriptEntryToText({ type: 'user', content: 'hi' })).toBe('hi');
	});

	it('handles top-level content[] multimodal blocks', () => {
		expect(
			flattenTranscriptEntryToText({
				type: 'user',
				content: [
					{ type: 'text', text: 'a' },
					{ type: 'text', text: 'b' },
				],
			}),
		).toBe('a\n\nb');
	});

	it('handles Cursor nested message.content[]', () => {
		expect(
			flattenTranscriptEntryToText({
				role: 'assistant',
				message: { content: [{ type: 'text', text: 'reply' }] },
			}),
		).toBe('reply');
	});

	it('handles Vogon string message', () => {
		expect(flattenTranscriptEntryToText({ type: 'user', message: 'vogon' })).toBe('vogon');
	});

	it('returns empty for non-objects', () => {
		expect(flattenTranscriptEntryToText(null)).toBe('');
		expect(flattenTranscriptEntryToText(3)).toBe('');
	});
});

describe('transcript-prompts.parseTranscriptDisplayLine', () => {
	it('strips IDE tags for user role only', () => {
		const line = JSON.stringify({
			role: 'user',
			message: { content: [{ type: 'text', text: '<user_query>inside</user_query>' }] },
		});
		const r = parseTranscriptDisplayLine(line);
		expect(r?.role).toBe('user');
		expect(r?.text).toBe('inside');
	});

	it('does not strip user_query markers from assistant bodies', () => {
		const line = JSON.stringify({
			role: 'assistant',
			message: { content: [{ type: 'text', text: '<user_query>keep</user_query>' }] },
		});
		const r = parseTranscriptDisplayLine(line);
		expect(r?.text).toContain('<user_query>');
	});

	it('returns null for blank / invalid JSON', () => {
		expect(parseTranscriptDisplayLine('')).toBeNull();
		expect(parseTranscriptDisplayLine('not-json')).toBeNull();
	});
});

describe('transcript-prompts.splitPromptContent', () => {
	// Go: cmd/entire/cli/strategy/manual_commit_condensation.go splitPromptContent
	it('returns null for empty content', () => {
		expect(splitPromptContent('')).toBeNull();
	});

	it('splits on \\n\\n---\\n\\n separator', () => {
		expect(splitPromptContent('A\n\n---\n\nB\n\n---\n\nC')).toEqual(['A', 'B', 'C']);
	});

	it('trims and drops empty / whitespace-only segments', () => {
		expect(splitPromptContent('A\n\n---\n\n   \n\n---\n\nB')).toEqual(['A', 'B']);
	});
});

describe('transcript-prompts.readPromptsFromFilesystem + clearFilesystemPrompt', () => {
	let env: TestEnv;
	const sessionId = '2026-04-19-test-session';
	let sessionDirAbs: string;
	let promptPath: string;

	beforeEach(async () => {
		env = await TestEnv.create();
		sessionDirAbs = path.join(env.dir, '.story', 'metadata', sessionId);
		await mkdir(sessionDirAbs, { recursive: true });
		promptPath = path.join(sessionDirAbs, 'prompt.txt');
	});

	afterEach(async () => {
		await env.cleanup();
	});

	// Go: cmd/entire/cli/strategy/manual_commit_condensation.go readPromptsFromFilesystem
	it('reads <sessionMetadataDirAbs>/prompt.txt and splits content', async () => {
		await writeFile(promptPath, 'first\n\n---\n\nsecond');
		expect(await readPromptsFromFilesystem(sessionId, env.dir)).toEqual(['first', 'second']);
	});

	it('returns null when file is missing (ENOENT)', async () => {
		expect(await readPromptsFromFilesystem(sessionId, env.dir)).toBeNull();
	});

	it('returns null when file is empty', async () => {
		await writeFile(promptPath, '');
		expect(await readPromptsFromFilesystem(sessionId, env.dir)).toBeNull();
	});

	// Go: cmd/entire/cli/strategy/manual_commit_condensation.go clearFilesystemPrompt
	it('removes prompt.txt', async () => {
		await writeFile(promptPath, 'something');
		await clearFilesystemPrompt(sessionId, env.dir);
		await expect(rm(promptPath)).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('is silent when file is missing', async () => {
		await expect(clearFilesystemPrompt(sessionId, env.dir)).resolves.toBeUndefined();
	});
});
