/**
 * Integration tests — verify Phase 5.x dispatch fallbacks now work end-to-end
 * through the real Cursor agent (Phase 6.3 brings 4 dispatch sites alive).
 *
 * Each `it()` exercises a real strategy callsite with `agentType: 'Cursor'`,
 * confirming `registry.getByAgentType('Cursor')` returns a real
 * {@link import('@/agent/cursor').CursorAgent} and the capability dispatch
 * lands on real implementation.
 *
 * Sites covered:
 * - `prepareTranscriptForState` → `caps.asTranscriptPreparer(cursor)` →
 *   real 5s polling
 * - `calculateTokenUsage(cursor, ...)` → `caps.asTokenCalculator` returns
 *   `[null, false]` (Cursor doesn't implement) → returns `null`
 * - `extractModifiedFilesFromOffset` via `caps.asTranscriptAnalyzer(cursor)`
 *   → returns `{ files: [], currentPosition: 0 }` → caller's git-status
 *   fallback path engages
 * - `restoreLogsOnly` writes Cursor session via `cursor.writeSession` →
 *   verify nested-layout path resolution works end-to-end
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerBuiltinAgents } from '@/agent/bootstrap';
import * as caps from '@/agent/capabilities';
import { CursorAgent } from '@/agent/cursor';
import { clearForTesting, getByAgentType } from '@/agent/registry';
import type { AgentSession } from '@/agent/session';
import { calculateTokenUsage } from '@/agent/token-usage';
import { AGENT_NAME_CURSOR, AGENT_TYPE_CURSOR } from '@/agent/types';

describe('agent/cursor — Phase 5.x dispatch integration', () => {
	let tmpDir: string;
	// Bootstrap once for the whole describe — tests below verify dispatch
	// against the registered Cursor agent.
	beforeAll(() => {
		registerBuiltinAgents();
	});
	afterAll(() => {
		clearForTesting();
	});
	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cursor-int-'));
	});
	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	// Site 1: prepareTranscriptForState dispatches to cursor.prepareTranscript
	it('prepareTranscript dispatches via caps.asTranscriptPreparer to real Cursor 5s polling', async () => {
		const ag = getByAgentType(AGENT_TYPE_CURSOR);
		expect(ag).toBeInstanceOf(CursorAgent);
		const [prep, hasPrep] = caps.asTranscriptPreparer(ag);
		expect(hasPrep).toBe(true);
		if (prep === null) {
			throw new Error('expected TranscriptPreparer capability on Cursor agent');
		}

		const transcript = path.join(tmpDir, 'sess.jsonl');
		await fs.writeFile(transcript, '{"role":"user"}\n');
		// File already exists with content → should return immediately.
		await expect(prep.prepareTranscript(transcript)).resolves.toBeUndefined();
	});

	// Site 2: calculateTokenUsage with cursor returns null (Cursor doesn't
	// implement TokenCalculator nor SubagentAwareExtractor)
	it('calculateTokenUsage(cursorAgent, ...) returns null (Cursor declines both capabilities)', async () => {
		const ag = getByAgentType(AGENT_TYPE_CURSOR);
		expect(ag).toBeInstanceOf(CursorAgent);
		const [, hasTokenCalc] = caps.asTokenCalculator(ag);
		const [, hasSubagent] = caps.asSubagentAwareExtractor(ag);
		expect(hasTokenCalc).toBe(false);
		expect(hasSubagent).toBe(false);
		// And the framework-level dispatcher returns null.
		const result = await calculateTokenUsage(ag, new Uint8Array(), 0, '');
		expect(result).toBeNull();
	});

	// Site 3: extractModifiedFilesFromOffset via caps.asTranscriptAnalyzer
	// returns empty for Cursor (caller falls through to git status)
	it('extractModifiedFilesFromOffset via caps.asTranscriptAnalyzer returns empty for Cursor', async () => {
		const ag = getByAgentType(AGENT_TYPE_CURSOR);
		const [analyzer, hasAnalyzer] = caps.asTranscriptAnalyzer(ag);
		expect(hasAnalyzer).toBe(true);
		if (analyzer === null) {
			throw new Error('expected TranscriptAnalyzer capability on Cursor agent');
		}
		const result = await analyzer.extractModifiedFilesFromOffset('/anything.jsonl', 0);
		expect(result).toEqual({ files: [], currentPosition: 0 });
	});

	// Site 4: writeSession round-trip with cursor agent (used by restoreLogsOnly)
	it('cursorAgent.writeSession round-trips a Cursor session to disk', async () => {
		const ag = getByAgentType(AGENT_TYPE_CURSOR);
		expect(ag).toBeInstanceOf(CursorAgent);
		const out = path.join(tmpDir, 'restored.jsonl');
		const payload =
			'{"role":"user","message":{"content":[{"type":"text","text":"<user_query>\\nhi\\n</user_query>"}]}}\n';
		const session: AgentSession = {
			sessionId: 'restored-1',
			agentName: AGENT_NAME_CURSOR,
			repoPath: '',
			sessionRef: out,
			startTime: new Date(),
			nativeData: new TextEncoder().encode(payload),
			modifiedFiles: [],
			newFiles: [],
			deletedFiles: [],
			entries: [],
		};
		await ag!.writeSession(session);
		expect(await fs.readFile(out, 'utf-8')).toBe(payload);
	});
});
