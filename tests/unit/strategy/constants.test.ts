/**
 * Phase 5.1 strategy/constants.ts unit tests.
 *
 * **TS-only**: Go does not ship dedicated `Test*` functions for these constants
 * — they're production-file declarations (`messages.go` / `manual_commit_types.go`
 * / `common.go`) verified by their consumers in Go. The TS tests below are
 * value-parity checks that pin the Story-side numeric / string contract to the
 * matching Go declaration line; treat them as **const-parity**, not test-port.
 *
 * `taskMetadataDir` (the only function in this module) likewise has no Go
 * `Test*`; the TS tests here serve as the function's own behavioral spec.
 */

import { describe, expect, it } from 'vitest';
import {
	LOGS_ONLY_SCAN_LIMIT,
	MAX_COMMIT_TRAVERSAL_DEPTH,
	MAX_DESCRIPTION_LENGTH,
	MAX_LAST_PROMPT_RUNES,
	STRATEGY_NAME_MANUAL_COMMIT,
	taskMetadataDir,
} from '@/strategy/constants';

// TS-only: const parity checks against Go production-file declarations
// (no Go `Test*` exists for these constants — they're verified by consumers).
describe('strategy/constants — Go contract values', () => {
	// Go: messages.go:13 MaxDescriptionLength (production declaration)
	it('MAX_DESCRIPTION_LENGTH matches Go messages.go:13', () => {
		expect(MAX_DESCRIPTION_LENGTH).toBe(60);
	});

	// Go: manual_commit_types.go:15 logsOnlyScanLimit (production declaration)
	it('LOGS_ONLY_SCAN_LIMIT matches Go manual_commit_types.go:15', () => {
		expect(LOGS_ONLY_SCAN_LIMIT).toBe(50);
	});

	// Go: manual_commit_types.go:18 maxLastPromptRunes (production declaration)
	it('MAX_LAST_PROMPT_RUNES matches Go manual_commit_types.go:18', () => {
		expect(MAX_LAST_PROMPT_RUNES).toBe(100);
	});

	// Go: common.go:39 StrategyNameManualCommit (production declaration)
	it('STRATEGY_NAME_MANUAL_COMMIT is the manual-commit literal', () => {
		expect(STRATEGY_NAME_MANUAL_COMMIT).toBe('manual-commit');
	});

	// Go: common.go:42-44 MaxCommitTraversalDepth (production declaration)
	it('MAX_COMMIT_TRAVERSAL_DEPTH matches Go common.go:42-44', () => {
		expect(MAX_COMMIT_TRAVERSAL_DEPTH).toBe(1000);
	});
});

// Go: strategy.go:262-265 TaskMetadataDir — TS-only test (no dedicated Go Test*;
// exercised transitively in Go integration tests via `TaskMetadataDir(...)` calls).
describe('taskMetadataDir — Go: strategy.go:262-265 TaskMetadataDir (no dedicated Go Test*)', () => {
	it('joins session metadata dir + tasks/<id>', () => {
		expect(taskMetadataDir('.story/metadata/abc-123', 'tool-use-456')).toBe(
			'.story/metadata/abc-123/tasks/tool-use-456',
		);
	});

	it('handles deep session dirs', () => {
		expect(taskMetadataDir('.story/metadata/some/nested/sess', 'tu_xyz')).toBe(
			'.story/metadata/some/nested/sess/tasks/tu_xyz',
		);
	});

	it('does not normalize empty strings (caller responsibility)', () => {
		expect(taskMetadataDir('', 'tu_x')).toBe('/tasks/tu_x');
		expect(taskMetadataDir('.story/metadata/abc', '')).toBe('.story/metadata/abc/tasks/');
	});
});
