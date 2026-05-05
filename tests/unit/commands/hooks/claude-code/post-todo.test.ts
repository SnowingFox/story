/**
 * Tests for `src/commands/hooks/claude-code/post-todo.ts` — Story-specific
 * orchestration coverage (Go has only a high-level integration test for
 * `hooks_claudecode_posttodo.go`; coverage relies on mocking each Phase 5.4/7
 * helper to drive the 11-step pipeline).
 *
 * Go references covered by `// Go:` annotations below:
 * - hooks_claudecode_posttodo.go (handleClaudeCodePostTodo / handleClaudeCodePostTodoFromReader)
 * - hooks.go (parseSubagentCheckpointHookInput + SubagentCheckpointHookInput)
 * - messages.go (extractLastCompletedTodo + countTodos — wrapped by *FromToolInput)
 *
 * Mock strategy: inject all 6 helpers via {@link setPostTodoHelpersForTesting},
 * verify the orchestration through `expect(saveTaskStep).toHaveBeenCalled...`.
 * Production helpers (Phase 7) delegate to `src/lifecycle/*` +
 * `ManualCommitStrategy.saveTaskStep`; the `production helpers — Phase 7
 * wired` describe block mocks those modules at the top of this file and
 * verifies each helper calls through to its backend.
 */

import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '@/agent/interfaces';

// Phase 7 wiring: productionHelpers now delegates to these lifecycle
// modules + ManualCommitStrategy. Mock them at the top so E2E tests can
// drive productionHelpers without touching real fs / git / ALS state.
// Injection-based tests (31 existing cases) set `activeHelpers` via
// `setPostTodoHelpersForTesting(happyHelpers)` and never hit these mocks.
const saveTaskStepMock = vi.hoisted(() => vi.fn(async (_ctx: unknown) => {}));
const manualCommitCtorMock = vi.hoisted(() =>
	vi.fn().mockImplementation(() => ({ saveTaskStep: saveTaskStepMock })),
);

vi.mock('@/lifecycle/hook-registry', () => ({
	getCurrentHookAgent: vi.fn(async () => ({
		name: () => 'claude-code',
		type: () => 'Claude Code',
	})),
}));
vi.mock('@/lifecycle/pre-task-state', () => ({
	findActivePreTaskFile: vi.fn(async () => ({ found: false, toolUseId: '' })),
}));
vi.mock('@/lifecycle/file-changes', () => ({
	detectFileChanges: vi.fn(async () => ({ modified: [], new: [], deleted: [] })),
}));
vi.mock('@/lifecycle/checkpoint-sequence', () => ({
	getNextCheckpointSequence: vi.fn(async () => 1),
}));
vi.mock('@/strategy/manual-commit', () => ({
	ManualCommitStrategy: manualCommitCtorMock,
}));

import {
	_productionHelpersForTesting,
	type ActivePreTaskResult,
	countTodosFromToolInput,
	extractLastCompletedTodoFromToolInput,
	type FileChanges,
	handleClaudeCodePostTodo,
	type PostTodoHelpers,
	parseSubagentCheckpointHookInput,
	setPostTodoHelpersForTesting,
	type TaskStepInput,
} from '@/commands/hooks/claude-code/post-todo';
import * as gitMod from '@/git';

const mockAgent: Agent = {
	name: () => 'claude-code' as never,
	type: () => 'Claude Code',
	description: () => 'mock',
	isPreview: () => false,
	detectPresence: async () => false,
	protectedDirs: () => [],
	readTranscript: async () => new Uint8Array(),
	chunkTranscript: async (c) => [c],
	reassembleTranscript: async (c) => (c.length === 0 ? new Uint8Array() : c[0]!),
	getSessionID: (i) => i.sessionId,
	getSessionDir: async () => '/tmp',
	resolveSessionFile: (d, s) => `${d}/${s}`,
	readSession: async () => null,
	writeSession: async () => {},
	formatResumeCommand: (id) => `mock ${id}`,
};

const happyHelpers: PostTodoHelpers = {
	getCurrentHookAgent: async () => mockAgent,
	findActivePreTaskFile: async (): Promise<ActivePreTaskResult> => ({
		found: true,
		toolUseId: 'toolu_task123abc',
	}),
	detectFileChanges: async (): Promise<FileChanges> => ({
		modified: ['src/a.ts'],
		new: [],
		deleted: [],
	}),
	getGitAuthor: async () => ({ name: 'Tester', email: 'test@test.com' }),
	getNextCheckpointSequence: async () => 7,
	saveTaskStep: async () => {},
};

function stdinFrom(payload: string): NodeJS.ReadableStream {
	return Readable.from([Buffer.from(payload)]);
}

function happyStdin(): NodeJS.ReadableStream {
	return stdinFrom(
		JSON.stringify({
			session_id: 'sid-1',
			transcript_path: '/Users/me/.claude/projects/foo/sessions/abc.jsonl',
			tool_name: 'TodoWrite',
			tool_use_id: 'toolu_x',
			tool_input: {
				todos: [
					{ content: 'wrote a test', status: 'completed' },
					{ content: 'next step', status: 'pending' },
				],
			},
		}),
	);
}

describe('handleClaudeCodePostTodo — Go: hooks_claudecode_posttodo.go', () => {
	beforeEach(() => {
		// Default: not on default branch (let the handler proceed past skip check).
		vi.spyOn(gitMod, 'shouldSkipOnDefaultBranch').mockResolvedValue({
			skip: false,
			branchName: 'feature/x',
		});
		setPostTodoHelpersForTesting(happyHelpers);
	});
	afterEach(() => {
		setPostTodoHelpersForTesting(null);
		vi.restoreAllMocks();
	});

	// 1. Go: L31-34 (parse failure throws)
	it('throws when stdin is empty (parse failure)', async () => {
		await expect(handleClaudeCodePostTodo(stdinFrom(''))).rejects.toThrow(
			/failed to parse PostToolUse\[TodoWrite\] input/,
		);
	});

	it('throws on non-JSON stdin', async () => {
		await expect(handleClaudeCodePostTodo(stdinFrom('garbage'))).rejects.toThrow(
			/failed to parse PostToolUse\[TodoWrite\] input/,
		);
	});

	// 2. Go: L36-40 (getCurrentHookAgent failure throws)
	it('throws when getCurrentHookAgent fails (first call)', async () => {
		setPostTodoHelpersForTesting({
			...happyHelpers,
			getCurrentHookAgent: async () => {
				throw new Error('hook agent unknown');
			},
		});
		await expect(handleClaudeCodePostTodo(happyStdin())).rejects.toThrow(/failed to get agent/);
	});

	// 3. Go: L52-56 (no active pre-task → silent return; saveTaskStep NOT called)
	it('returns void (skip) when no active pre-task file', async () => {
		const saveSpy = vi.fn(async () => {});
		setPostTodoHelpersForTesting({
			...happyHelpers,
			findActivePreTaskFile: async () => ({ found: false, toolUseId: '' }),
			saveTaskStep: saveSpy,
		});
		await expect(handleClaudeCodePostTodo(happyStdin())).resolves.toBeUndefined();
		expect(saveSpy).not.toHaveBeenCalled();
	});

	// 4. Go: L58-63 (default branch → silent return)
	it('returns void (skip) when on default branch', async () => {
		vi.spyOn(gitMod, 'shouldSkipOnDefaultBranch').mockResolvedValue({
			skip: true,
			branchName: 'main',
		});
		const saveSpy = vi.fn(async () => {});
		setPostTodoHelpersForTesting({ ...happyHelpers, saveTaskStep: saveSpy });
		await expect(handleClaudeCodePostTodo(happyStdin())).resolves.toBeUndefined();
		expect(saveSpy).not.toHaveBeenCalled();
	});

	// 5. Go: L66-71 (detectFileChanges error → swallow)
	it('swallows detectFileChanges error and returns void', async () => {
		const saveSpy = vi.fn(async () => {});
		setPostTodoHelpersForTesting({
			...happyHelpers,
			detectFileChanges: async () => {
				throw new Error('git status crashed');
			},
			saveTaskStep: saveSpy,
		});
		await expect(handleClaudeCodePostTodo(happyStdin())).resolves.toBeUndefined();
		expect(saveSpy).not.toHaveBeenCalled();
	});

	// 6. Go: L73-77 (no file changes → silent return)
	it('returns void (skip) when no file changes detected', async () => {
		const saveSpy = vi.fn(async () => {});
		setPostTodoHelpersForTesting({
			...happyHelpers,
			detectFileChanges: async () => ({ modified: [], new: [], deleted: [] }),
			saveTaskStep: saveSpy,
		});
		await expect(handleClaudeCodePostTodo(happyStdin())).resolves.toBeUndefined();
		expect(saveSpy).not.toHaveBeenCalled();
	});

	// 7. Go: L80-85 (git author error → swallow)
	it('swallows getGitAuthor error and returns void', async () => {
		const saveSpy = vi.fn(async () => {});
		setPostTodoHelpersForTesting({
			...happyHelpers,
			getGitAuthor: async () => {
				throw new Error('git config missing');
			},
			saveTaskStep: saveSpy,
		});
		await expect(handleClaudeCodePostTodo(happyStdin())).resolves.toBeUndefined();
		expect(saveSpy).not.toHaveBeenCalled();
	});

	// 8. Go: L91-94 (sessionId fallback to extractSessionIdFromTranscriptPath)
	it('falls back to extractSessionIdFromTranscriptPath when input.sessionId empty', async () => {
		const saveSpy = vi.fn(async () => {});
		setPostTodoHelpersForTesting({ ...happyHelpers, saveTaskStep: saveSpy });
		const stdin = stdinFrom(
			JSON.stringify({
				session_id: '', // empty → fallback
				transcript_path: '/Users/me/.claude/projects/foo/sessions/abc-123.jsonl',
				tool_name: 'TodoWrite',
				tool_use_id: 'toolu_x',
				tool_input: { todos: [{ content: 'a', status: 'completed' }] },
			}),
		);
		await handleClaudeCodePostTodo(stdin);
		expect(saveSpy).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'abc-123' }));
	});

	// 9. Go: L99-113 (todoContent extraction — uses last completed todo)
	it('uses last completed todo content when present', async () => {
		const saveSpy = vi.fn(async () => {});
		setPostTodoHelpersForTesting({ ...happyHelpers, saveTaskStep: saveSpy });
		await handleClaudeCodePostTodo(happyStdin());
		expect(saveSpy).toHaveBeenCalledWith(expect.objectContaining({ todoContent: 'wrote a test' }));
	});

	// 10. Go: L103-110 (fallback to "Planning: N todos" when no completed item)
	it('falls back to "Planning: N todos" when no completed item', async () => {
		const saveSpy = vi.fn(async () => {});
		setPostTodoHelpersForTesting({ ...happyHelpers, saveTaskStep: saveSpy });
		const stdin = stdinFrom(
			JSON.stringify({
				session_id: 'sid',
				transcript_path: '/p',
				tool_name: 'TodoWrite',
				tool_use_id: 'toolu_x',
				tool_input: {
					todos: [
						{ content: 'a', status: 'pending' },
						{ content: 'b', status: 'pending' },
						{ content: 'c', status: 'pending' },
					],
				},
			}),
		);
		await handleClaudeCodePostTodo(stdin);
		expect(saveSpy).toHaveBeenCalledWith(
			expect.objectContaining({ todoContent: 'Planning: 3 todos' }),
		);
	});

	// 11. Go: L139-144 (saveTaskStep error → swallow)
	it('swallows saveTaskStep error and returns void', async () => {
		setPostTodoHelpersForTesting({
			...happyHelpers,
			saveTaskStep: async () => {
				throw new Error('disk full');
			},
		});
		await expect(handleClaudeCodePostTodo(happyStdin())).resolves.toBeUndefined();
	});

	// 12. Go: L146-149 (happy path — saveTaskStep called with full context + log)
	it('happy path: saveTaskStep called with TaskStepContext containing all fields', async () => {
		const captured: TaskStepInput[] = [];
		setPostTodoHelpersForTesting({
			...happyHelpers,
			saveTaskStep: async (ctx) => {
				captured.push(ctx);
			},
		});
		await handleClaudeCodePostTodo(happyStdin());
		expect(captured).toHaveLength(1);
		const ctx = captured[0]!;
		expect(ctx.sessionId).toBe('sid-1');
		expect(ctx.toolUseId).toBe('toolu_task123abc'); // from findActivePreTaskFile
		expect(ctx.modifiedFiles).toEqual(['src/a.ts']);
		expect(ctx.transcriptPath).toBe('/Users/me/.claude/projects/foo/sessions/abc.jsonl');
		expect(ctx.authorName).toBe('Tester');
		expect(ctx.authorEmail).toBe('test@test.com');
		expect(ctx.isIncremental).toBe(true);
		expect(ctx.incrementalSequence).toBe(7);
		expect(ctx.incrementalType).toBe('TodoWrite');
		expect(ctx.todoContent).toBe('wrote a test');
		expect(ctx.agentType).toBe('Claude Code');
	});

	// Story 补充：short toolUseId boundary (Go: taskToolUseID[:min(12, len(...))])
	it('handles short toolUseId without panic (slice min(12, length))', async () => {
		const captured: TaskStepInput[] = [];
		setPostTodoHelpersForTesting({
			...happyHelpers,
			findActivePreTaskFile: async () => ({ found: true, toolUseId: 'short' }),
			saveTaskStep: async (ctx) => {
				captured.push(ctx);
			},
		});
		await handleClaudeCodePostTodo(happyStdin());
		// No panic; saveTaskStep called.
		expect(captured).toHaveLength(1);
	});
});

// Cover productionHelpers directly so single-file coverage doesn't dip on
// the Phase 7 wired helpers. Each assertion verifies the helper delegates
// to its backend (`src/lifecycle/*` or `ManualCommitStrategy`).
describe('production helpers — Phase 7 wired', () => {
	beforeEach(() => {
		// The previous `describe` block runs `vi.restoreAllMocks()` in its
		// afterEach, which wipes the `mockImplementation` off the hoisted
		// `manualCommitCtorMock` + `saveTaskStepMock`. Re-arm both here so
		// `new ManualCommitStrategy()` returns `{ saveTaskStep: <mock> }`
		// in this suite.
		manualCommitCtorMock.mockImplementation(() => ({ saveTaskStep: saveTaskStepMock }));
		saveTaskStepMock.mockImplementation(async () => {});
	});
	afterEach(() => {
		setPostTodoHelpersForTesting(null);
		saveTaskStepMock.mockClear();
		manualCommitCtorMock.mockClear();
	});

	it('getGitAuthor (production) returns name/email from git config (or default)', async () => {
		const helpers = _productionHelpersForTesting();
		const author = await helpers.getGitAuthor();
		expect(typeof author.name).toBe('string');
		expect(typeof author.email).toBe('string');
	});

	// E2E-1: Go: hook_registry.go (GetCurrentHookAgent)
	it('production getCurrentHookAgent delegates to lifecycle hook-registry', async () => {
		const helpers = _productionHelpersForTesting();
		const { getCurrentHookAgent } = await import('@/lifecycle/hook-registry');
		const ag = await helpers.getCurrentHookAgent();
		expect(ag).toBeDefined();
		expect(ag.name()).toBe('claude-code');
		expect(ag.type()).toBe('Claude Code');
		expect(vi.mocked(getCurrentHookAgent)).toHaveBeenCalled();
	});

	// E2E-2: Go: state.go (FindActivePreTaskFile)
	it('production findActivePreTaskFile delegates to lifecycle pre-task-state', async () => {
		const helpers = _productionHelpersForTesting();
		const { findActivePreTaskFile } = await import('@/lifecycle/pre-task-state');
		vi.mocked(findActivePreTaskFile).mockResolvedValueOnce({
			found: true,
			toolUseId: 'toolu_test',
		});
		const r = await helpers.findActivePreTaskFile();
		expect(r).toEqual({ found: true, toolUseId: 'toolu_test' });
		expect(vi.mocked(findActivePreTaskFile)).toHaveBeenCalled();
	});

	// E2E-3: Go: state.go (DetectFileChanges)
	it('production detectFileChanges delegates to lifecycle file-changes', async () => {
		const helpers = _productionHelpersForTesting();
		const { detectFileChanges } = await import('@/lifecycle/file-changes');
		vi.mocked(detectFileChanges).mockResolvedValueOnce({
			modified: ['src/a.ts'],
			new: ['src/b.ts'],
			deleted: [],
		});
		const r = await helpers.detectFileChanges();
		expect(r).toEqual({ modified: ['src/a.ts'], new: ['src/b.ts'], deleted: [] });
		expect(vi.mocked(detectFileChanges)).toHaveBeenCalled();
	});

	// E2E-4: Go: state.go (GetNextCheckpointSequence)
	it('production getNextCheckpointSequence delegates to lifecycle checkpoint-sequence', async () => {
		const helpers = _productionHelpersForTesting();
		const { getNextCheckpointSequence } = await import('@/lifecycle/checkpoint-sequence');
		vi.mocked(getNextCheckpointSequence).mockResolvedValueOnce(42);
		const r = await helpers.getNextCheckpointSequence('sid-1', 'toolu_x');
		expect(r).toBe(42);
		expect(vi.mocked(getNextCheckpointSequence)).toHaveBeenCalledWith('sid-1', 'toolu_x');
	});

	// E2E-5: Go: manual_commit_git.go (ManualCommitStrategy.SaveTaskStep)
	it('production saveTaskStep delegates to ManualCommitStrategy.saveTaskStep with mapped fields', async () => {
		const helpers = _productionHelpersForTesting();
		const taskCtx: TaskStepInput = {
			sessionId: 'sid-1',
			toolUseId: 'toolu_x',
			modifiedFiles: ['a.ts'],
			newFiles: ['b.ts'],
			deletedFiles: [],
			transcriptPath: '/tmp/x.jsonl',
			authorName: 'Test',
			authorEmail: 't@t.com',
			isIncremental: true,
			incrementalSequence: 1,
			incrementalType: 'TodoWrite',
			incrementalData: new Uint8Array([1, 2]),
			todoContent: 'do X',
			agentType: 'Claude Code',
		};
		await helpers.saveTaskStep(taskCtx);
		expect(manualCommitCtorMock).toHaveBeenCalledOnce();
		expect(saveTaskStepMock).toHaveBeenCalledOnce();
		expect(saveTaskStepMock).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: 'sid-1',
				toolUseId: 'toolu_x',
				modifiedFiles: ['a.ts'],
				newFiles: ['b.ts'],
				deletedFiles: [],
				transcriptPath: '/tmp/x.jsonl',
				authorName: 'Test',
				authorEmail: 't@t.com',
				isIncremental: true,
				incrementalSequence: 1,
				incrementalType: 'TodoWrite',
				incrementalData: new Uint8Array([1, 2]),
				todoContent: 'do X',
				agentType: 'Claude Code',
				// Narrow → full mapping fills these with empty defaults:
				agentId: '',
				subagentTranscriptPath: '',
				checkpointUuid: '',
				subagentType: '',
				taskDescription: '',
			}),
		);
	});
});

// Go: hooks_claudecode_posttodo.go (full file mirrored — orchestration above)

describe('parseSubagentCheckpointHookInput', () => {
	// Go: hooks_test.go (TestParseSubagentCheckpointHookInput)
	// Go: hooks.go (parseSubagentCheckpointHookInput implementation)
	it('parses TodoWrite stdin into typed shape', async () => {
		const stdin = Readable.from([
			Buffer.from(
				JSON.stringify({
					session_id: 'abc123',
					tool_name: 'TodoWrite',
					tool_use_id: 'toolu_xyz',
					tool_input: { todos: [{ content: 'Task 1', status: 'pending' }] },
					tool_response: { success: true },
				}),
			),
		]);
		const out = await parseSubagentCheckpointHookInput(stdin);
		expect(out.sessionId).toBe('abc123');
		expect(out.toolName).toBe('TodoWrite');
		expect(out.toolUseId).toBe('toolu_xyz');
		// toolInput re-serialized as bytes.
		const parsed = JSON.parse(new TextDecoder().decode(out.toolInput));
		expect(parsed).toEqual({ todos: [{ content: 'Task 1', status: 'pending' }] });
	});

	it('throws on empty stdin', async () => {
		const stdin = Readable.from([Buffer.from('')]);
		await expect(parseSubagentCheckpointHookInput(stdin)).rejects.toThrow(/empty hook input/);
	});

	it('throws on malformed JSON', async () => {
		const stdin = Readable.from([Buffer.from('not json')]);
		await expect(parseSubagentCheckpointHookInput(stdin)).rejects.toThrow(
			/failed to parse hook input/,
		);
	});
});

// Go: messages.go (ExtractLastCompletedTodo / CountTodos via *FromToolInput wrappers)

describe('extractLastCompletedTodoFromToolInput / countTodosFromToolInput', () => {
	const enc = new TextEncoder();

	it('extracts last completed todo from tool_input.todos', () => {
		const bytes = enc.encode(
			JSON.stringify({
				todos: [
					{ content: 'a', status: 'completed' },
					{ content: 'b', status: 'pending' },
					{ content: 'c', status: 'completed' },
				],
			}),
		);
		expect(extractLastCompletedTodoFromToolInput(bytes)).toBe('c');
	});

	it('returns empty string when no completed item', () => {
		const bytes = enc.encode(JSON.stringify({ todos: [{ content: 'a', status: 'pending' }] }));
		expect(extractLastCompletedTodoFromToolInput(bytes)).toBe('');
	});

	it('returns empty string when tool_input has no todos field', () => {
		const bytes = enc.encode(JSON.stringify({ other: 'thing' }));
		expect(extractLastCompletedTodoFromToolInput(bytes)).toBe('');
	});

	// Go: hooks_test.go (TestExtractLastCompletedTodoFromToolInput "empty todos array")
	it('returns empty string when todos array is empty', () => {
		const bytes = enc.encode(JSON.stringify({ todos: [] }));
		expect(extractLastCompletedTodoFromToolInput(bytes)).toBe('');
	});

	// Go: hooks_test.go (TestExtractLastCompletedTodoFromToolInput "empty input bytes")
	it('returns empty string for empty Uint8Array input', () => {
		expect(extractLastCompletedTodoFromToolInput(new Uint8Array())).toBe('');
	});

	it('returns 0 from countTodosFromToolInput for missing/empty todos', () => {
		expect(countTodosFromToolInput(new Uint8Array())).toBe(0);
		expect(countTodosFromToolInput(enc.encode('not json'))).toBe(0);
		expect(countTodosFromToolInput(enc.encode(JSON.stringify({ other: 'thing' })))).toBe(0);
		expect(countTodosFromToolInput(enc.encode(JSON.stringify({ todos: [] })))).toBe(0);
	});

	it('counts todo items', () => {
		const bytes = enc.encode(
			JSON.stringify({
				todos: [
					{ content: 'a', status: 'pending' },
					{ content: 'b', status: 'pending' },
					{ content: 'c', status: 'completed' },
				],
			}),
		);
		expect(countTodosFromToolInput(bytes)).toBe(3);
	});
});
