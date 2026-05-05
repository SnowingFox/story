/**
 * strategy/transcript-prep.ts unit tests.
 *
 * **TS-only**: Go's `prepareTranscriptForState` / `prepareTranscriptIfNeeded`
 * (`common.go:1636-1669`) have no dedicated `Test*` — they're integration-
 * tested via the agent registry consumers.
 *
 * Phase 6.1 Part 2: dispatches to `caps.asTranscriptPreparer(ag).prepareTranscript`
 * for the agent matched by `state.agentType`; active phase only; warns + swallows
 * unknown-agent / preparer-throw cases.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerBuiltinAgents } from '@/agent/bootstrap';
import * as registry from '@/agent/registry';
import { AGENT_NAME_CLAUDE_CODE, AGENT_TYPE_CLAUDE_CODE, type AgentName } from '@/agent/types';
import * as log from '@/log';
import { setAgentSessionFileResolver } from '@/strategy/resolve-transcript';
import { prepareTranscriptForState, prepareTranscriptIfNeeded } from '@/strategy/transcript-prep';
import type { SessionState } from '@/strategy/types';

function makeState(overrides: Partial<SessionState> = {}): SessionState {
	return {
		sessionId: 'abc',
		baseCommit: 'deadbeef',
		startedAt: new Date().toISOString(),
		phase: 'idle',
		stepCount: 0,
		...overrides,
	};
}

// Go: common.go:1636-1669 — prepareTranscriptForState / prepareTranscriptIfNeeded
// TS-only: no dedicated Go Test* — production behavior verified through
// integration. Tests below cover the Phase 6.1 Part 2 dispatch + fallback contract.
describe('strategy/transcript-prep — Go: common.go:1636-1669 (production; no dedicated Go Test*)', () => {
	let tmpDir: string;

	// Phase 6.3 polish: bootstrap explicitly so getByAgentType('Vogon Agent')
	// returns the registered agent in the "no TranscriptPreparer" fallthrough case.
	beforeAll(() => {
		registerBuiltinAgents();
	});
	afterAll(() => {
		registry.clearForTesting();
	});

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'story-prep-'));
		setAgentSessionFileResolver(null);
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
		setAgentSessionFileResolver(null);
		vi.restoreAllMocks();
	});

	describe('prepareTranscriptForState', () => {
		// Go: common.go:1640 — early return for non-active phase.
		it('returns silently when phase is not active', async () => {
			const state = makeState({
				phase: 'idle',
				agentType: 'Claude Code',
				transcriptPath: '/anywhere',
			});
			await expect(prepareTranscriptForState(state)).resolves.toBeUndefined();
		});

		it('returns silently when state.transcriptPath / agentType is empty', async () => {
			await expect(
				prepareTranscriptForState(makeState({ phase: 'active' })),
			).resolves.toBeUndefined();
		});

		it('logs warn when agent is unknown (registry miss)', async () => {
			// Go: common.go:1643-1649 — Phase 6.1 Part 2 narrows to log.warn instead of debug.
			// Use withTestRegistry to isolate from real Vogon registration; the
			// "Claude Code" agent type is unknown in this scope.
			await registry.withTestRegistry(async () => {
				const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
				const state = makeState({
					phase: 'active',
					agentType: 'Claude Code',
					transcriptPath: '/anywhere',
				});
				await prepareTranscriptForState(state);
				expect(warnSpy).toHaveBeenCalledWith(
					expect.objectContaining({ component: 'strategy.transcript-prep' }),
					expect.stringContaining('unknown agent'),
					expect.objectContaining({ agentType: 'Claude Code' }),
				);
			});
		});

		it('silently returns when agent is registered but does NOT implement TranscriptPreparer (e.g., Vogon)', async () => {
			// Go: common.go:1666 — `if preparer, ok := agent.AsTranscriptPreparer(ag); ok`
			//   non-implementing agents fall through silently.
			const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
			// Vogon is auto-registered via @/agent/vogon import (Part 1).
			// Use Vogon's actual type; it implements Agent + HookSupport but NOT TranscriptPreparer.
			const state = makeState({
				phase: 'active',
				agentType: 'Vogon Agent',
				transcriptPath: '/anywhere',
			});
			await prepareTranscriptForState(state);
			expect(warnSpy).not.toHaveBeenCalled();
		});

		it('dispatches to agent.prepareTranscript when registered', async () => {
			await registry.withTestRegistry(async () => {
				let calledWith: string | null = null;
				registry.register(AGENT_NAME_CLAUDE_CODE, () => ({
					name: () => AGENT_NAME_CLAUDE_CODE,
					type: () => AGENT_TYPE_CLAUDE_CODE,
					description: () => 'mock claude',
					isPreview: () => false,
					detectPresence: async () => false,
					protectedDirs: () => [],
					readTranscript: async () => new Uint8Array(),
					chunkTranscript: async (c) => [c],
					reassembleTranscript: async (c) => c[0] ?? new Uint8Array(),
					getSessionID: (i) => i.sessionId,
					getSessionDir: async () => '/tmp',
					resolveSessionFile: (d, id) => `${d}/${id}`,
					readSession: async () => null,
					writeSession: async () => {},
					formatResumeCommand: (id) => `claude --resume ${id}`,
					prepareTranscript: async (path: string) => {
						calledWith = path;
					},
				}));
				const state = makeState({
					phase: 'active',
					agentType: AGENT_TYPE_CLAUDE_CODE,
					transcriptPath: '/repo/.story/sessions/x.jsonl',
				});
				await prepareTranscriptForState(state);
				expect(calledWith).toBe('/repo/.story/sessions/x.jsonl');
			});
		});

		it('logs warn when prepareTranscript throws (does NOT re-throw)', async () => {
			const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
			await registry.withTestRegistry(async () => {
				registry.register('throwing-prep' as AgentName, () => ({
					name: () => 'throwing-prep' as AgentName,
					type: () => 'ThrowingPrep',
					description: () => 'mock throwing prep',
					isPreview: () => false,
					detectPresence: async () => false,
					protectedDirs: () => [],
					readTranscript: async () => new Uint8Array(),
					chunkTranscript: async (c) => [c],
					reassembleTranscript: async (c) => c[0] ?? new Uint8Array(),
					getSessionID: (i) => i.sessionId,
					getSessionDir: async () => '/tmp',
					resolveSessionFile: (d, id) => `${d}/${id}`,
					readSession: async () => null,
					writeSession: async () => {},
					formatResumeCommand: (id) => id,
					prepareTranscript: async () => {
						throw new Error('boom');
					},
				}));
				const state = makeState({
					phase: 'active',
					agentType: 'ThrowingPrep',
					transcriptPath: '/anywhere',
				});
				await expect(prepareTranscriptForState(state)).resolves.toBeUndefined();
				expect(warnSpy).toHaveBeenCalledWith(
					expect.objectContaining({ component: 'strategy.transcript-prep' }),
					expect.stringContaining('transcript preparer failed'),
					expect.objectContaining({ agentType: 'ThrowingPrep', error: 'boom' }),
				);
			});
		});
	});

	describe('prepareTranscriptIfNeeded', () => {
		it('returns silently when state.transcriptPath is empty', async () => {
			await expect(prepareTranscriptIfNeeded(makeState())).resolves.toBeUndefined();
		});

		it('returns silently when transcript file is missing (no resolver)', async () => {
			const state = makeState({
				transcriptPath: path.join(tmpDir, 'missing.jsonl'),
				agentType: 'Claude Code',
			});
			await expect(prepareTranscriptIfNeeded(state)).resolves.toBeUndefined();
		});

		it('runs prep (dispatches to agent.prepareTranscript) when transcript exists + active phase', async () => {
			// Phase 6.1 Part 2: prepareTranscriptIfNeeded → resolveTranscriptPath
			// + stat → prepareTranscriptForState which dispatches via the registry.
			// Use a real on-disk file + active phase + registered TranscriptPreparer
			// so the full pipeline actually invokes the agent (Plan B2 fix:
			// previous test used phase: 'idle' which short-circuits in the
			// dispatch core and never proves the dispatch happens).
			const tp = path.join(tmpDir, 'present.jsonl');
			await fs.writeFile(tp, 'hi');
			let calledWith: string | null = null;
			await registry.withTestRegistry(async () => {
				registry.register(AGENT_NAME_CLAUDE_CODE, () => ({
					name: () => AGENT_NAME_CLAUDE_CODE,
					type: () => AGENT_TYPE_CLAUDE_CODE,
					description: () => 'mock claude',
					isPreview: () => false,
					detectPresence: async () => false,
					protectedDirs: () => [],
					readTranscript: async () => new Uint8Array(),
					chunkTranscript: async (c) => [c],
					reassembleTranscript: async (c) => c[0] ?? new Uint8Array(),
					getSessionID: (i) => i.sessionId,
					getSessionDir: async () => '/tmp',
					resolveSessionFile: (d, id) => `${d}/${id}`,
					readSession: async () => null,
					writeSession: async () => {},
					formatResumeCommand: (id) => `claude --resume ${id}`,
					prepareTranscript: async (p: string) => {
						calledWith = p;
					},
				}));
				const state = makeState({
					transcriptPath: tp,
					phase: 'active',
					agentType: AGENT_TYPE_CLAUDE_CODE,
				});
				await expect(prepareTranscriptIfNeeded(state)).resolves.toBeUndefined();
			});
			expect(calledWith).toBe(tp);
		});

		it('returns silently when transcript exists but state.phase is idle (Go common.go:1640-1641)', async () => {
			// Go: prepareTranscriptForState early-returns for non-active phase.
			// This guards against accidentally re-flushing already-finalized transcripts.
			const tp = path.join(tmpDir, 'idle.jsonl');
			await fs.writeFile(tp, 'hi');
			const state = makeState({ transcriptPath: tp, phase: 'idle', agentType: 'Claude Code' });
			await expect(prepareTranscriptIfNeeded(state)).resolves.toBeUndefined();
		});
	});
});
