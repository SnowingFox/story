/**
 * Phase 5.1 types.ts unit tests — ported 1:1 from Go
 * `entire-cli/cmd/entire/cli/strategy/session_test.go` (Session/Checkpoint
 * struct shape tests) +
 * `manual_commit_test.go` (CheckpointInfo/SessionState JSON round-trip).
 *
 * Each `it()` is annotated with `// Go: <file>:<line> <TestName>` for traceability.
 *
 * **Phase boundary**: Go's `Session` and `Checkpoint` types belong to the
 * `ListSessions`/`GetSession` API which is **Phase 9.2** (status/sessions
 * commands), not Phase 5.1. The 4 struct-shape tests are ported here as
 * `describe.skip` documenting the expected shapes; they will activate when
 * Phase 9.2 introduces the TS counterparts.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
	AgentType,
	CheckpointInfo,
	CleanupItem,
	CondenseResult,
	ExtractedSessionData,
	PromptAttribution,
	RestoredSession,
	RewindPoint,
	RewindPreview,
	SessionInfo,
	SessionState,
	StepContext,
	SubagentCheckpoint,
	TaskCheckpoint,
	TaskStepContext,
	TokenUsage,
} from '@/strategy/types';
import { readTaskCheckpoint } from '@/strategy/types';

// Go: session_test.go:27-69 TestSessionStruct
// Go: session_test.go:71-123 TestCheckpointStruct
// Go: session_test.go:125-149 TestSessionCheckpointCount
// Go: session_test.go:151-163 TestEmptySession
//
// These 4 tests cover the `Session` and `Checkpoint` types which are part
// of the ListSessions/GetSession API (Phase 9.2). TS does not yet have these
// types; they're tracked as a forward marker.
describe.skip('Session / Checkpoint struct tests — DEFERRED to Phase 9.2', () => {
	it('TestSessionStruct — Go: session_test.go:27-69 (Phase 9.2)', () => {
		// Will activate when src/strategy/session.ts (or 9.2 equivalent) introduces:
		//   interface Session { id, description, strategy, startTime, checkpoints[] }
		// Go fixture: ID = "2025-12-01-8f76b0e8-...", Strategy = "manual-commit", 2 checkpoints
	});

	it('TestCheckpointStruct — Go: session_test.go:71-123 (Phase 9.2)', () => {
		// Will activate when src/strategy/session.ts (or 9.2 equivalent) introduces:
		//   interface Checkpoint { checkpointId, message, timestamp, isTaskCheckpoint, toolUseId }
		// Go covers session checkpoint (toolUseId="") + task checkpoint (toolUseId="toolu_abc123")
	});

	it('TestSessionCheckpointCount — Go: session_test.go:125-149 (Phase 9.2)', () => {
		// Verifies Session with 3 checkpoints is correctly accessed.
	});

	it('TestEmptySession — Go: session_test.go:151-163 (Phase 9.2)', () => {
		// Verifies zero-value Session has empty ID, empty Description, nil Checkpoints
	});
});

// Go: manual_commit_test.go:1005-1030 TestCheckpointInfo_JSONRoundTrip
describe('TestCheckpointInfo_JSONRoundTrip — Go: manual_commit_test.go:1005-1030', () => {
	it('JSON round-trip preserves CheckpointID and SessionID', () => {
		const original: CheckpointInfo = {
			checkpointId: 'a1b2c3d4e5f6',
			sessionId: 'session-123',
			createdAt: new Date('2025-12-02T10:00:00Z'),
			checkpointsCount: 5,
			filesTouched: ['file1.go', 'file2.go'],
		};

		// Serialize to JSON (Go: json.Marshal)
		const json = JSON.stringify(original);

		// Deserialize (Go: json.Unmarshal)
		const parsed = JSON.parse(json) as Omit<CheckpointInfo, 'createdAt'> & {
			createdAt: string;
		};
		const loaded: CheckpointInfo = {
			...parsed,
			createdAt: new Date(parsed.createdAt),
		};

		expect(loaded.checkpointId).toBe(original.checkpointId);
		expect(loaded.sessionId).toBe(original.sessionId);
	});
});

// Go: manual_commit_test.go:1032-1059 TestSessionState_JSONRoundTrip
describe('TestSessionState_JSONRoundTrip — Go: manual_commit_test.go:1032-1059', () => {
	it('JSON round-trip preserves SessionID, BaseCommit, StepCount', () => {
		const original: SessionState = {
			sessionId: 'session-123',
			baseCommit: 'abc123def456',
			startedAt: new Date('2025-12-02T10:00:00Z').toISOString(),
			phase: 'idle',
			stepCount: 10,
		};

		const json = JSON.stringify(original);
		const loaded = JSON.parse(json) as SessionState;

		expect(loaded.sessionId).toBe(original.sessionId);
		expect(loaded.baseCommit).toBe(original.baseCommit);
		expect(loaded.stepCount).toBe(original.stepCount);
	});

	it('JSON round-trip preserves null endedAt for active session', () => {
		const original: SessionState = {
			sessionId: 'session-active',
			baseCommit: 'abc123',
			startedAt: new Date().toISOString(),
			phase: 'active',
			stepCount: 1,
			endedAt: null,
		};

		const json = JSON.stringify(original);
		const loaded = JSON.parse(json) as SessionState;
		expect(loaded.endedAt).toBeNull();
	});
});

/**
 * TS supplemental: type-only smoke tests for re-exports + strategy interfaces
 * to ensure the `@/strategy/types` import surface compiles. These mirror the
 * Go pattern of using `var _ Type` to assert struct shapes at compile time.
 */
// Go: strategy.go:30-260 + manual_commit_types.go:27-69 — type definitions
describe('strategy/types — re-export smoke tests (Go: strategy.go:30-260, manual_commit_types.go:27-69)', () => {
	it('SessionState shape from @/session/state-store is reachable', () => {
		const state: SessionState = {
			sessionId: 'abc',
			baseCommit: 'deadbeef',
			startedAt: new Date().toISOString(),
			phase: 'idle',
			stepCount: 0,
		};
		expect(state.sessionId).toBe('abc');
	});

	it('PromptAttribution shape is reachable', () => {
		const attr: PromptAttribution = {
			checkpointNumber: 1,
			userLinesAdded: 0,
			userLinesRemoved: 0,
			agentLinesAdded: 0,
			agentLinesRemoved: 0,
		};
		expect(attr.checkpointNumber).toBe(1);
	});

	it('TokenUsage shape is reachable', () => {
		const tu: TokenUsage = {
			inputTokens: 1,
			cacheCreationTokens: 0,
			cacheReadTokens: 0,
			outputTokens: 1,
			apiCallCount: 1,
		};
		expect(tu.inputTokens + tu.outputTokens).toBe(2);
	});

	it('AgentType is a string alias (Phase 5.1 stub; replaced in 6.1)', () => {
		const a: AgentType = 'Claude Code';
		expect(typeof a).toBe('string');
	});

	it('SessionInfo shape', () => {
		const info: SessionInfo = {
			sessionId: 's1',
			reference: 'story/abc1234',
			commitHash: 'deadbeef',
		};
		expect(info.reference.startsWith('story/')).toBe(true);
	});

	it('RewindPoint shape (logs-only checkpoint)', () => {
		const point: RewindPoint = {
			id: 'a1b2c3d4e5f6',
			message: 'feat: add x',
			metadataDir: '.story/metadata/sess',
			date: new Date(),
			isTaskCheckpoint: false,
			toolUseId: '',
			isLogsOnly: true,
			checkpointId: 'a1b2c3d4e5f6',
			agent: 'Claude Code',
			sessionId: 'sess',
			sessionPrompt: 'do x',
			sessionCount: 1,
			sessionIds: ['sess'],
			sessionPrompts: ['do x'],
		};
		expect(point.isLogsOnly).toBe(true);
	});

	it('RewindPreview shape', () => {
		const preview: RewindPreview = {
			filesToRestore: ['src/a.ts'],
			filesToDelete: ['tmp.txt'],
			trackedChanges: ['src/b.ts'],
		};
		expect(preview.filesToRestore.length).toBe(1);
	});

	it('StepContext shape', () => {
		const step: StepContext = {
			sessionId: 's1',
			modifiedFiles: [],
			newFiles: [],
			deletedFiles: [],
			metadataDir: '.story/metadata/s1',
			metadataDirAbs: '/repo/.story/metadata/s1',
			commitMessage: '',
			transcriptPath: '/tmp/transcript.jsonl',
			authorName: 'a',
			authorEmail: 'a@b',
			agentType: 'Claude Code',
			stepTranscriptIdentifier: '',
			stepTranscriptStart: 0,
			tokenUsage: null,
		};
		expect(step.tokenUsage).toBeNull();
	});

	it('TaskStepContext shape (incremental)', () => {
		const task: TaskStepContext = {
			sessionId: 's1',
			toolUseId: 'tu_1',
			agentId: 'a1',
			modifiedFiles: [],
			newFiles: [],
			deletedFiles: [],
			transcriptPath: '/tmp/transcript.jsonl',
			subagentTranscriptPath: '',
			checkpointUuid: 'uuid-1',
			authorName: 'a',
			authorEmail: 'a@b',
			isIncremental: true,
			incrementalSequence: 1,
			incrementalType: 'TodoWrite',
			incrementalData: { todos: [] },
			subagentType: 'dev',
			taskDescription: 'fix bug',
			todoContent: 'do x',
			agentType: 'Claude Code',
		};
		expect(task.isIncremental).toBe(true);
	});

	it('TaskCheckpoint shape', () => {
		const cp: TaskCheckpoint = {
			sessionId: 's1',
			toolUseId: 'tu_1',
			checkpointUuid: 'uuid-1',
		};
		expect(cp.toolUseId).toBe('tu_1');
	});

	it('SubagentCheckpoint shape', () => {
		const sc: SubagentCheckpoint = {
			type: 'TodoWrite',
			toolUseId: 'tu_1',
			timestamp: new Date(),
			data: { foo: 'bar' },
		};
		expect(sc.type).toBe('TodoWrite');
	});

	it('RestoredSession shape', () => {
		const rs: RestoredSession = {
			sessionId: 's1',
			agent: 'Claude Code',
			prompt: 'do x',
			createdAt: new Date(),
		};
		expect(rs.agent).toBe('Claude Code');
	});

	it('CheckpointInfo shape', () => {
		const ci: CheckpointInfo = {
			checkpointId: 'a1b2c3d4e5f6',
			sessionId: 's1',
			createdAt: new Date(),
			checkpointsCount: 3,
			filesTouched: ['a.ts'],
		};
		expect(ci.checkpointsCount).toBe(3);
	});

	it('CondenseResult shape — skipped case', () => {
		const result: CondenseResult = {
			checkpointId: '',
			sessionId: 's1',
			checkpointsCount: 0,
			filesTouched: [],
			prompts: [],
			totalTranscriptLines: 0,
			compactTranscriptLines: 0,
			transcript: new Uint8Array(0),
			skipped: true,
		};
		expect(result.skipped).toBe(true);
	});

	it('ExtractedSessionData shape', () => {
		const data: ExtractedSessionData = {
			transcript: new Uint8Array([1, 2, 3]),
			fullTranscriptLines: 10,
			prompts: ['p1'],
			filesTouched: ['a.ts'],
			tokenUsage: null,
		};
		expect(data.transcript.length).toBe(3);
	});

	it('CleanupItem shape (Phase 9.5 — type / id / reason)', () => {
		const item: CleanupItem = {
			type: 'session-state',
			id: 'sess-orphan',
			reason: 'no shadow branch',
		};
		expect(item.type).toBe('session-state');
	});
});

/**
 * readTaskCheckpoint — TS-only: Go production lives at `strategy.go:268-289`
 * (`ReadTaskCheckpoint`). No dedicated Go `Test*` exists in `strategy/*_test.go`
 * — Go covers it transitively via the rewind / restoreLogsOnly suites in
 * `manual_commit_rewind_test.go`. The TS tests below pin the file-missing
 * (`null`) vs malformed-JSON (throws) split.
 */
describe('readTaskCheckpoint — Go: strategy.go:268-289 (production; no dedicated Go Test*)', () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'story-task-cp-'));
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it('returns parsed TaskCheckpoint when checkpoint.json exists', async () => {
		const taskDir = path.join(tmpDir, 'tu_1');
		await fs.mkdir(taskDir, { recursive: true });
		await fs.writeFile(
			path.join(taskDir, 'checkpoint.json'),
			JSON.stringify({
				session_id: 'sess-1',
				tool_use_id: 'tu_1',
				checkpoint_uuid: 'uuid-abc',
				agent_id: 'agent-1',
			}),
		);
		const result = await readTaskCheckpoint(taskDir);
		expect(result).not.toBeNull();
		expect(result?.sessionId).toBe('sess-1');
		expect(result?.toolUseId).toBe('tu_1');
		expect(result?.checkpointUuid).toBe('uuid-abc');
		expect(result?.agentId).toBe('agent-1');
	});

	it('returns null when checkpoint.json missing', async () => {
		const result = await readTaskCheckpoint(path.join(tmpDir, 'no-such-task'));
		expect(result).toBeNull();
	});

	it('throws on parse failure (malformed JSON)', async () => {
		const taskDir = path.join(tmpDir, 'tu_bad');
		await fs.mkdir(taskDir, { recursive: true });
		await fs.writeFile(path.join(taskDir, 'checkpoint.json'), 'not-valid-json');
		await expect(readTaskCheckpoint(taskDir)).rejects.toThrow();
	});
});
