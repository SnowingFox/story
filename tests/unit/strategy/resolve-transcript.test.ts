/**
 * Phase 5.1 resolve-transcript.ts unit tests — ported 1:1 from Go
 * `entire-cli/cmd/entire/cli/strategy/resolve_transcript_test.go`.
 *
 * Each `it()` is annotated with `// Go: <file>:<line> <TestName>` for traceability.
 *
 * In Go these tests register `cursor` and `claudecode` agents via blank-import.
 * In TS Phase 5.1, the agent registry doesn't exist yet, so we install a
 * minimal `AgentSessionFileResolver` that mirrors the Cursor flat→nested
 * behavior; the resolver is reset between tests.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	type AgentSessionFileResolver,
	resolveTranscriptPath,
	setAgentSessionFileResolver,
} from '@/strategy/resolve-transcript';
import type { SessionState } from '@/strategy/types';

/** Cursor agent type label (Go: agent.AgentTypeCursor). */
const AGENT_TYPE_CURSOR = 'Cursor';
/** Claude Code agent type label (Go: agent.AgentTypeClaudeCode). */
const AGENT_TYPE_CLAUDE_CODE = 'Claude Code';

/**
 * Cursor flat→nested resolver matching Go `cursor.ResolveSessionFile` behavior.
 * Returns nested layout `<dir>/<id>/<id>.jsonl` when given a flat layout path.
 */
const cursorResolver: AgentSessionFileResolver = (agentType, sessionDir, agentSessionId) => {
	if (agentType !== AGENT_TYPE_CURSOR) {
		return null;
	}
	return path.join(sessionDir, agentSessionId, `${agentSessionId}.jsonl`);
};

/** Claude Code resolver: stays flat (no relocation). */
const claudeCodeResolver: AgentSessionFileResolver = (agentType, sessionDir, agentSessionId) => {
	if (agentType !== AGENT_TYPE_CLAUDE_CODE) {
		return null;
	}
	return path.join(sessionDir, `${agentSessionId}.jsonl`);
};

/** Combined resolver matching Go test fixture (cursor + claudecode registered). */
const combinedResolver: AgentSessionFileResolver = (agentType, sessionDir, agentSessionId) => {
	const cursor = cursorResolver(agentType, sessionDir, agentSessionId);
	if (cursor !== null) {
		return cursor;
	}
	return claudeCodeResolver(agentType, sessionDir, agentSessionId);
};

function makeState(overrides: Partial<SessionState> = {}): SessionState {
	return {
		sessionId: 'sess',
		baseCommit: 'deadbeef',
		startedAt: new Date().toISOString(),
		phase: 'idle',
		stepCount: 0,
		...overrides,
	};
}

describe('resolveTranscriptPath', () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'story-resolve-'));
		// Install resolver mirroring Go's `_ "agent/cursor"` + `_ "agent/claudecode"` blank imports.
		setAgentSessionFileResolver(combinedResolver);
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
		setAgentSessionFileResolver(null);
	});

	// Go: resolve_transcript_test.go:16-42 TestResolveTranscriptPath_FileExists
	it('FileExists — Go: resolve_transcript_test.go:16-42', async () => {
		const transcriptFile = path.join(tmpDir, 'session-123.jsonl');
		await fs.writeFile(transcriptFile, '{"test":true}');

		const state = makeState({
			transcriptPath: transcriptFile,
			agentType: AGENT_TYPE_CURSOR,
		});

		const resolved = await resolveTranscriptPath(state);
		expect(resolved).toBe(transcriptFile);
		expect(state.transcriptPath).toBe(transcriptFile);
	});

	// Go: resolve_transcript_test.go:44-85 TestResolveTranscriptPath_ReResolvesToNestedLayout
	it('ReResolvesToNestedLayout — Go: resolve_transcript_test.go:44-85', async () => {
		const sessionDir = path.join(tmpDir, 'agent-transcripts');
		await fs.mkdir(sessionDir, { recursive: true });

		const agentSessionId = '87874108-eff2-47a0-b260-183961dd6cb0';
		const flatPath = path.join(sessionDir, `${agentSessionId}.jsonl`);

		const nestedDir = path.join(sessionDir, agentSessionId);
		await fs.mkdir(nestedDir, { recursive: true });
		const nestedPath = path.join(nestedDir, `${agentSessionId}.jsonl`);
		await fs.writeFile(nestedPath, '{"role":"user"}');

		const state = makeState({
			transcriptPath: flatPath,
			agentType: AGENT_TYPE_CURSOR,
		});

		const resolved = await resolveTranscriptPath(state);
		expect(resolved).toBe(nestedPath);
		// State should be updated to the resolved path
		expect(state.transcriptPath).toBe(nestedPath);
	});

	// Go: resolve_transcript_test.go:87-114 TestResolveTranscriptPath_FileNotFoundAndCannotResolve
	it('FileNotFoundAndCannotResolve — Go: resolve_transcript_test.go:87-114', async () => {
		const sessionDir = path.join(tmpDir, 'agent-transcripts');
		await fs.mkdir(sessionDir, { recursive: true });

		const agentSessionId = 'nonexistent-uuid';
		const flatPath = path.join(sessionDir, `${agentSessionId}.jsonl`);

		const state = makeState({
			transcriptPath: flatPath,
			agentType: AGENT_TYPE_CURSOR,
		});

		await expect(resolveTranscriptPath(state)).rejects.toThrow();
		// State should not change
		expect(state.transcriptPath).toBe(flatPath);
	});

	// Go: resolve_transcript_test.go:116-133 TestResolveTranscriptPath_UnknownAgentFallsThrough
	it('UnknownAgentFallsThrough — Go: resolve_transcript_test.go:116-133', async () => {
		const missingPath = path.join(tmpDir, 'nonexistent.jsonl');

		const state = makeState({
			transcriptPath: missingPath,
			agentType: 'Unknown Agent',
		});

		await expect(resolveTranscriptPath(state)).rejects.toThrow();
	});

	// Go: resolve_transcript_test.go:135-147 TestResolveTranscriptPath_EmptyPath
	it('EmptyPath — Go: resolve_transcript_test.go:135-147', async () => {
		const state = makeState({
			transcriptPath: '',
			agentType: AGENT_TYPE_CURSOR,
		});

		await expect(resolveTranscriptPath(state)).rejects.toThrow();
	});

	// Go: resolve_transcript_test.go:149-173 TestResolveTranscriptPath_DirectoryPathReturnsAsIs
	it('DirectoryPathReturnsAsIs — Go: resolve_transcript_test.go:149-173', async () => {
		// When the path is a directory (not a file), Go's os.Stat succeeds so
		// resolveTranscriptPath returns the path as-is. TS impl uses fs.stat
		// which behaves identically — `stat` succeeds on directories.
		const dirPath = path.join(tmpDir, 'adir');
		await fs.mkdir(dirPath, { recursive: true });

		const state = makeState({
			transcriptPath: dirPath,
			agentType: AGENT_TYPE_CURSOR,
		});

		const resolved = await resolveTranscriptPath(state);
		expect(resolved).toBe(dirPath);
	});

	// Go: resolve_transcript_test.go:175-202 TestResolveTranscriptPath_ClaudeCodeNoReResolution
	it('ClaudeCodeNoReResolution — Go: resolve_transcript_test.go:175-202', async () => {
		const sessionDir = path.join(tmpDir, 'projects', 'sessions');
		await fs.mkdir(sessionDir, { recursive: true });

		const missingPath = path.join(sessionDir, 'session-abc.jsonl');

		const state = makeState({
			transcriptPath: missingPath,
			agentType: AGENT_TYPE_CLAUDE_CODE,
		});

		await expect(resolveTranscriptPath(state)).rejects.toThrow();
		// Path should remain unchanged since re-resolution also fails
		expect(state.transcriptPath).toBe(missingPath);
	});

	// Phase 6.1 Part 2 #101: registry-backed resolver succeeds when an agent
	// is registered with `resolveSessionFile` that knows the nested layout.
	it('registry-backed resolver: Cursor agent registered → re-resolution succeeds', async () => {
		// Install a resolver that delegates to registry.getByAgentType — this
		// mirrors what @/cli wires at startup (Phase 6.1 Part 1).
		const registryModule = await import('@/agent/registry');
		const { mockBaseAgent } = await import('../agent/_helpers');
		await registryModule.withTestRegistry(async () => {
			registryModule.register('Cursor' as never, () =>
				mockBaseAgent({
					name: () => 'cursor' as never,
					type: () => 'Cursor',
					resolveSessionFile: (sessionDir, sessionId) =>
						path.join(sessionDir, sessionId, `${sessionId}.jsonl`),
				}),
			);
			setAgentSessionFileResolver((agentType, sessionDir, agentSessionId) => {
				const ag = registryModule.getByAgentType(agentType);
				return ag === null ? null : ag.resolveSessionFile(sessionDir, agentSessionId);
			});

			const sessionDir = path.join(tmpDir, 'cursor-sess');
			await fs.mkdir(sessionDir, { recursive: true });
			const id = 'reg-id-001';
			const flatPath = path.join(sessionDir, `${id}.jsonl`);
			const nestedDir = path.join(sessionDir, id);
			await fs.mkdir(nestedDir, { recursive: true });
			const nestedPath = path.join(nestedDir, `${id}.jsonl`);
			await fs.writeFile(nestedPath, '{}');

			const state = makeState({ transcriptPath: flatPath, agentType: 'Cursor' });
			expect(await resolveTranscriptPath(state)).toBe(nestedPath);
			expect(state.transcriptPath).toBe(nestedPath);
		});
	});

	// Phase 6.1 Part 2 #102: registry-backed resolver — empty registry / unknown
	// agent → ENOENT (re-resolution returns null, treat as missing).
	it('registry-backed resolver: empty registry → ENOENT for missing transcript', async () => {
		const registryModule = await import('@/agent/registry');
		await registryModule.withTestRegistry(async () => {
			setAgentSessionFileResolver((agentType, sessionDir, agentSessionId) => {
				const ag = registryModule.getByAgentType(agentType);
				return ag === null ? null : ag.resolveSessionFile(sessionDir, agentSessionId);
			});
			const missing = path.join(tmpDir, 'missing.jsonl');
			const state = makeState({ transcriptPath: missing, agentType: 'Cursor' });
			await expect(resolveTranscriptPath(state)).rejects.toThrow();
		});
	});
});
