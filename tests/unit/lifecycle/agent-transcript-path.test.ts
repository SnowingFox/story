/**
 * Phase 7 Part 1 `src/lifecycle/agent-transcript-path.ts` — 3 case.
 *
 * Go 参考：`cmd/entire/cli/transcript.go AgentTranscriptPath`（Go 无直接
 * test；Go 侧 `filepath.Join` 无条件拼接，对空输入会产出 `agent-.jsonl`）。
 * TS 补 3 case 覆盖 happy path + 2 empty-input fail-safe 分支（**TS-divergence**
 * vs Go — Story 提前返回 `''`，详见实现 JSDoc）。
 *
 * Each `it()` is annotated with `// Go: <anchor>`.
 */

import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentTranscriptPath } from '@/lifecycle/agent-transcript-path';

describe('lifecycle/agent-transcript-path', () => {
	// Go: transcript.go AgentTranscriptPath (happy path)
	it('joins subagentsDir + agent-<id>.jsonl', () => {
		expect(agentTranscriptPath('/tmp/tasks/abc', 'ac66d4b')).toBe(
			path.join('/tmp/tasks/abc', 'agent-ac66d4b.jsonl'),
		);
	});

	// TS-divergence: Go returns 'agent-ac66d4b.jsonl' for empty subagentsDir
	// (filepath.Join swallows empty prefix); TS returns '' early. See
	// `src/lifecycle/agent-transcript-path.ts` JSDoc TS-divergence block.
	it('empty subagentsDir returns "" (TS-divergence)', () => {
		expect(agentTranscriptPath('', 'ac66d4b')).toBe('');
	});

	// TS-divergence: Go returns '/tmp/agent-.jsonl' for empty agentID
	// (unconditional filepath.Join + fmt.Sprintf); TS returns '' early to
	// avoid callers silently tailing a garbage path. See
	// `src/lifecycle/agent-transcript-path.ts` JSDoc TS-divergence block.
	it('empty agentId returns "" (TS-divergence)', () => {
		expect(agentTranscriptPath('/tmp/', '')).toBe('');
	});
});
