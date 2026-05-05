/**
 * Resolve the per-subagent transcript file path.
 *
 * Go anchor: `entire-cli/cmd/entire/cli/transcript.go: AgentTranscriptPath`.
 *
 * Story-side rebrand: same file naming (`agent-<agentId>.jsonl`) under the
 * subagent dir — no string literal rebrand needed for this helper.
 *
 * @packageDocumentation
 */

import * as path from 'node:path';

/**
 * Compute `<subagentsDir>/agent-<agentId>.jsonl`.
 *
 * TS-divergence: returns `''` when either input is empty to avoid producing
 * a garbage path like `'agent-.jsonl'` that callers would silent-skip on
 * anyway. Go `AgentTranscriptPath` unconditionally calls `filepath.Join`
 * (see `entire-cli/cmd/entire/cli/transcript.go` and its
 * `transcript_test.go: TestAgentTranscriptPath`); Story callers normalize
 * to `''` one level up so the observable behavior is equivalent.
 *
 * @example
 * agentTranscriptPath('/tmp/tasks/abc', 'ac66d4b');
 * // → '/tmp/tasks/abc/agent-ac66d4b.jsonl'
 *
 * agentTranscriptPath('', 'ac66d4b');   // → ''  (TS-divergence)
 * agentTranscriptPath('/tmp/', '');     // → ''  (TS-divergence)
 */
export function agentTranscriptPath(subagentsDir: string, agentId: string): string {
	if (!subagentsDir || !agentId) {
		return '';
	}
	return path.join(subagentsDir, `agent-${agentId}.jsonl`);
}
