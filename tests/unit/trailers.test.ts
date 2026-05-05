import { describe, expect, it } from 'vitest';
import type { CheckpointID } from '@/id';
import {
	appendCheckpointTrailer,
	CHECKPOINT_TRAILER_KEY,
	formatCheckpoint,
	formatMetadata,
	formatShadowCommit,
	formatShadowTaskCommit,
	formatSourceRef,
	formatTaskMetadata,
	isTrailerLine,
	parseAllCheckpoints,
	parseAllSessions,
	parseBaseCommit,
	parseCheckpoint,
	parseMetadata,
	parseSession,
	parseTaskMetadata,
	STORY_SOURCE_REF_TRAILER_KEY,
} from '@/trailers';

describe('parseCheckpoint', () => {
	it('parses valid checkpoint trailer', () => {
		const msg = 'Add feature\n\nStory-Checkpoint: a1b2c3d4e5f6\n';
		expect(parseCheckpoint(msg)).toBe('a1b2c3d4e5f6');
	});

	it('returns null for no trailer', () => {
		expect(parseCheckpoint('Simple commit message')).toBeNull();
	});

	it('ignores invalid checkpoint ID format', () => {
		expect(parseCheckpoint('Msg\n\nStory-Checkpoint: tooshort\n')).toBeNull();
		expect(parseCheckpoint('Msg\n\nStory-Checkpoint: A1B2C3D4E5F6\n')).toBeNull();
		expect(parseCheckpoint('Msg\n\nStory-Checkpoint: a1b2c3d4e5gg\n')).toBeNull();
	});

	it('extracts first match only', () => {
		const msg = 'Merge\n\nStory-Checkpoint: a1b2c3d4e5f6\nStory-Checkpoint: b2c3d4e5f6a1\n';
		expect(parseCheckpoint(msg)).toBe('a1b2c3d4e5f6');
	});

	it('handles trailer at end without newline', () => {
		const msg = 'Add feature\n\nStory-Checkpoint: a1b2c3d4e5f6';
		expect(parseCheckpoint(msg)).toBe('a1b2c3d4e5f6');
	});

	it('rejects too long ID', () => {
		// 13 chars is too long
		const msg = 'Add\n\nStory-Checkpoint: a1b2c3d4e5f6a\n';
		expect(parseCheckpoint(msg)).toBeNull();
	});

	it('handles extra spaces around id', () => {
		const msg = 'Add\n\nStory-Checkpoint:   a1b2c3d4e5f6   \n';
		expect(parseCheckpoint(msg)).toBe('a1b2c3d4e5f6');
	});
});

describe('parseAllCheckpoints', () => {
	it('parses multiple checkpoint trailers', () => {
		const msg = 'Add feature\n\nStory-Checkpoint: a1b2c3d4e5f6\nStory-Checkpoint: b2c3d4e5f6a1\n';
		expect(parseAllCheckpoints(msg)).toEqual(['a1b2c3d4e5f6', 'b2c3d4e5f6a1']);
	});

	it('deduplicates checkpoint IDs', () => {
		const msg =
			'Merge\n\nStory-Checkpoint: a1b2c3d4e5f6\nStory-Checkpoint: b2c3d4e5f6a1\nStory-Checkpoint: a1b2c3d4e5f6\n';
		expect(parseAllCheckpoints(msg)).toEqual(['a1b2c3d4e5f6', 'b2c3d4e5f6a1']);
	});

	it('preserves order', () => {
		const msg = 'Merge\n\nStory-Checkpoint: b2c3d4e5f6a1\nStory-Checkpoint: a1b2c3d4e5f6\n';
		expect(parseAllCheckpoints(msg)).toEqual(['b2c3d4e5f6a1', 'a1b2c3d4e5f6']);
	});

	it('returns empty array for no trailers', () => {
		expect(parseAllCheckpoints('Simple commit message')).toEqual([]);
	});

	it('handles squash merge message format', () => {
		const msg = [
			'Soph/test branch (#2)',
			'',
			'* random_letter script',
			'',
			'Story-Checkpoint: 0aa0814d9839',
			'',
			'* random color',
			'',
			'Story-Checkpoint: 33fb587b6fbb',
			'',
		].join('\n');
		expect(parseAllCheckpoints(msg)).toEqual(['0aa0814d9839', '33fb587b6fbb']);
	});
});

describe('parseSession', () => {
	it('parses session ID', () => {
		const msg = 'Update logic\n\nStory-Session: 2025-12-10-abc123def\n';
		expect(parseSession(msg)).toBe('2025-12-10-abc123def');
	});

	it('returns null when absent', () => {
		expect(parseSession('Simple commit message')).toBeNull();
	});

	it('trims extra spaces', () => {
		const msg = 'Message\n\nStory-Session:   2025-12-10-xyz789   \n';
		expect(parseSession(msg)).toBe('2025-12-10-xyz789');
	});

	it('returns first match when multiple exist', () => {
		const msg = 'Merge\n\nStory-Session: session-1\nStory-Session: session-2\n';
		expect(parseSession(msg)).toBe('session-1');
	});

	// E.3 Go parity: when a Story-Session: line is present but its value is
	// whitespace-only, return '' (empty string), NOT null. Earlier TS used
	// `if (id) return id` which conflated "no trailer" with "empty trailer";
	// callers that need to distinguish "has trailer / empty" vs "no trailer"
	// (e.g. for tooling that wants to flag malformed commits) couldn't.
	//
	// Go reference: trailers/trailers.go:115-125 ParseSession returns
	// (TrimSpace(matches[1]), true) — second return is true even on empty trim.
	it('returns empty string for whitespace-only value (matches Go found=true)', () => {
		const msg = 'Subject\n\nStory-Session:    \n';
		// regex requires at least one non-newline char after the colon — verify
		// it still matches our whitespace-only value (the regex uses `(.+)` so
		// a single space matches).
		expect(parseSession(msg)).toBe('');
	});

	it('still returns null when no Story-Session line at all', () => {
		expect(parseSession('Subject only\n')).toBeNull();
	});
});

describe('parseAllSessions', () => {
	it('parses multiple session IDs', () => {
		const msg =
			'Merge commit\n\nStory-Session: session-1\nStory-Session: session-2\nStory-Session: session-3\n';
		expect(parseAllSessions(msg)).toEqual(['session-1', 'session-2', 'session-3']);
	});

	it('deduplicates sessions', () => {
		const msg =
			'Merge\n\nStory-Session: session-1\nStory-Session: session-2\nStory-Session: session-1\n';
		expect(parseAllSessions(msg)).toEqual(['session-1', 'session-2']);
	});

	it('returns empty array for no trailers', () => {
		expect(parseAllSessions('Simple commit message')).toEqual([]);
	});

	it('handles mixed trailers', () => {
		const msg =
			'Merge\n\nStory-Session: session-1\nStory-Metadata: .story/metadata/xyz\nStory-Session: session-2\n';
		expect(parseAllSessions(msg)).toEqual(['session-1', 'session-2']);
	});

	it('handles extra spaces around session ID', () => {
		const msg = 'Merge\n\nStory-Session:   session-1   \nStory-Session:  session-2  \n';
		expect(parseAllSessions(msg)).toEqual(['session-1', 'session-2']);
	});
});

describe('isTrailerLine', () => {
	it('recognizes trailer format', () => {
		expect(isTrailerLine('Signed-off-by: User <user@example.com>')).toBe(true);
		expect(isTrailerLine('Story-Checkpoint: abc123def456')).toBe(true);
		expect(isTrailerLine('error: connection refused')).toBe(true);
	});

	it('rejects non-trailer lines', () => {
		expect(isTrailerLine('not a trailer')).toBe(false);
		expect(isTrailerLine('')).toBe(false);
	});
});

describe('appendCheckpointTrailer', () => {
	it('adds trailer with blank line to plain message', () => {
		expect(appendCheckpointTrailer('feat: add attach command\n', 'abc123def456')).toBe(
			'feat: add attach command\n\nStory-Checkpoint: abc123def456\n',
		);
	});

	it('appends to existing trailer block without extra blank line', () => {
		const msg = 'feat: add attach command\n\nSigned-off-by: Test User <test@example.com>\n';
		expect(appendCheckpointTrailer(msg, 'abc123def456')).toBe(
			'feat: add attach command\n\nSigned-off-by: Test User <test@example.com>\nStory-Checkpoint: abc123def456\n',
		);
	});

	it('appends to existing checkpoint trailer block', () => {
		const msg = 'feat: add attach command\n\nStory-Checkpoint: deadbeefcafe\n';
		expect(appendCheckpointTrailer(msg, 'abc123def456')).toBe(
			'feat: add attach command\n\nStory-Checkpoint: deadbeefcafe\nStory-Checkpoint: abc123def456\n',
		);
	});

	it('subject with colon is not trailer block', () => {
		expect(appendCheckpointTrailer('docs: update readme\n', 'abc123def456')).toBe(
			'docs: update readme\n\nStory-Checkpoint: abc123def456\n',
		);
	});

	it('body text containing colon-space is not trailer block', () => {
		const msg = 'fix: login\n\nThis fixes the error: connection refused\n';
		expect(appendCheckpointTrailer(msg, 'abc123def456')).toBe(
			'fix: login\n\nThis fixes the error: connection refused\n\nStory-Checkpoint: abc123def456\n',
		);
	});

	it('handles empty message', () => {
		expect(appendCheckpointTrailer('', 'abc123def456')).toBe(
			'\n\nStory-Checkpoint: abc123def456\n',
		);
	});

	it('skips trailing # comment lines', () => {
		const msg = 'feat: add feature\n\n# Please enter the commit message\n';
		expect(appendCheckpointTrailer(msg, 'abc123def456')).toBe(
			'feat: add feature\n\n# Please enter the commit message\n\nStory-Checkpoint: abc123def456\n',
		);
	});

	it('appends to trailer block with # comment lines interleaved', () => {
		const msg = 'feat: add feature\n\nSigned-off-by: Test <test@test.com>\n# comment\n';
		expect(appendCheckpointTrailer(msg, 'abc123def456')).toBe(
			'feat: add feature\n\nSigned-off-by: Test <test@test.com>\n# comment\nStory-Checkpoint: abc123def456\n',
		);
	});

	it('does not treat non-trailer body text above trailer as trailer block', () => {
		const msg = 'feat: login\n\nsome body text\nSigned-off-by: Test <test@test.com>\n';
		expect(appendCheckpointTrailer(msg, 'abc123def456')).toBe(
			'feat: login\n\nsome body text\nSigned-off-by: Test <test@test.com>\n\nStory-Checkpoint: abc123def456\n',
		);
	});
});

describe('formatShadowCommit', () => {
	it('formats with metadata, session, and strategy trailers', () => {
		const result = formatShadowCommit('checkpoint', '.story/meta/dir', 'session-123');
		expect(result).toBe(
			'checkpoint\n\nStory-Metadata: .story/meta/dir\nStory-Session: session-123\nStory-Strategy: manual-commit\n',
		);
	});
});

describe('formatCheckpoint', () => {
	it('formats with checkpoint trailer', () => {
		const result = formatCheckpoint('Add login feature', 'a3b2c4d5e6f7' as CheckpointID);
		expect(result).toBe(`Add login feature\n\n${CHECKPOINT_TRAILER_KEY}: a3b2c4d5e6f7\n`);
	});
});

describe('formatMetadata', () => {
	it('formatMetadata appends metadata trailer', () => {
		const result = formatMetadata('checkpoint message', '.story/metadata/abc123');
		expect(result).toBe('checkpoint message\n\nStory-Metadata: .story/metadata/abc123\n');
	});
});

describe('parseMetadata', () => {
	it('parseMetadata extracts metadata dir', () => {
		const msg = 'checkpoint\n\nStory-Metadata: .story/metadata/abc123\n';
		expect(parseMetadata(msg)).toBe('.story/metadata/abc123');
	});

	it('parseMetadata returns null when absent', () => {
		expect(parseMetadata('Simple message')).toBeNull();
	});

	it('parseMetadata trims whitespace', () => {
		const msg = 'msg\n\nStory-Metadata:   .story/metadata/abc123   \n';
		expect(parseMetadata(msg)).toBe('.story/metadata/abc123');
	});
});

describe('formatTaskMetadata', () => {
	it('formatTaskMetadata appends task metadata trailer', () => {
		const result = formatTaskMetadata('task checkpoint', '.story/task-metadata/def456');
		expect(result).toBe('task checkpoint\n\nStory-Metadata-Task: .story/task-metadata/def456\n');
	});
});

describe('parseTaskMetadata', () => {
	it('parseTaskMetadata extracts task metadata dir', () => {
		const msg = 'checkpoint\n\nStory-Metadata-Task: .story/task-metadata/def456\n';
		expect(parseTaskMetadata(msg)).toBe('.story/task-metadata/def456');
	});

	it('parseTaskMetadata returns null when absent', () => {
		expect(parseTaskMetadata('Simple message')).toBeNull();
	});

	it('parseTaskMetadata trims whitespace', () => {
		const msg = 'msg\n\nStory-Metadata-Task:   .story/task-metadata/def456   \n';
		expect(parseTaskMetadata(msg)).toBe('.story/task-metadata/def456');
	});
});

describe('parseBaseCommit', () => {
	it('parseBaseCommit extracts 40-char hex SHA', () => {
		const sha = 'a'.repeat(40);
		const msg = `checkpoint\n\nBase-Commit: ${sha}\n`;
		expect(parseBaseCommit(msg)).toBe(sha);
	});

	it('parseBaseCommit returns null when absent', () => {
		expect(parseBaseCommit('Simple message')).toBeNull();
	});

	it('parseBaseCommit rejects short hash', () => {
		const msg = 'msg\n\nBase-Commit: abcdef1234\n';
		expect(parseBaseCommit(msg)).toBeNull();
	});

	it('parseBaseCommit rejects non-hex', () => {
		const badSha = 'g'.repeat(40);
		const msg = `msg\n\nBase-Commit: ${badSha}\n`;
		expect(parseBaseCommit(msg)).toBeNull();
	});

	it('handles multiple Base-Commit trailers (returns first)', () => {
		const sha1 = 'a'.repeat(40);
		const sha2 = 'b'.repeat(40);
		const msg = `msg\n\nBase-Commit: ${sha1}\nBase-Commit: ${sha2}\n`;
		expect(parseBaseCommit(msg)).toBe(sha1);
	});
});

// ─── Phase 5.2 — foundation backlog #15 + #16 ─────────────────────────────────
// Go: trailers/trailers.go:206-214 FormatSourceRef
// Go: trailers/trailers.go:238-248 FormatShadowTaskCommit
// (No direct Go *_test.go coverage — Go relies on integration via SaveTaskStep
//  and manual_commit_logs.go consumers.)

// Go: trailers/trailers.go:206-214 FormatSourceRef
describe('formatSourceRef — Go: trailers.go:206-214', () => {
	// Go: trailers.go:209-212 — len(shortHash) > ShortIDLength → truncate
	it('truncates commit hash to SHORT_ID_LENGTH (12 chars)', () => {
		expect(formatSourceRef('main', 'a3b2c4d5e6f7012345')).toBe('main@a3b2c4d5e6f7');
	});

	// Go: trailers.go:209-212 — len ≤ ShortIDLength → preserved
	it('leaves short commit hash unchanged (no zero-padding)', () => {
		expect(formatSourceRef('main', 'a3b2c4')).toBe('main@a3b2c4');
	});

	// Go: trailers.go:213 — fmt.Sprintf("%s@%s") accepts empty branch
	it('accepts empty branch name', () => {
		expect(formatSourceRef('', 'a3b2c4d5e6f7')).toBe('@a3b2c4d5e6f7');
	});

	// Go: trailers.go:213 — empty hash too
	it('accepts empty commit hash', () => {
		expect(formatSourceRef('main', '')).toBe('main@');
	});

	// Go: trailers.go:209-212 — exactly 12 chars passes through
	it('preserves a hash exactly 12 chars long without truncation', () => {
		expect(formatSourceRef('feat/x', 'abcdef012345')).toBe('feat/x@abcdef012345');
	});
});

// Go: trailers/trailers.go:238-248 FormatShadowTaskCommit
describe('formatShadowTaskCommit — Go: trailers.go:238-248', () => {
	// Go: trailers.go:240-247 — emits Story-Metadata-Task / Story-Session / Story-Strategy
	it('emits all 3 trailers in canonical order', () => {
		const result = formatShadowTaskCommit(
			'Completed task',
			'.story/metadata/sess-1/tasks/tool-456',
			'sess-1',
		);
		expect(result).toBe(
			'Completed task\n\nStory-Metadata-Task: .story/metadata/sess-1/tasks/tool-456\nStory-Session: sess-1\nStory-Strategy: manual-commit\n',
		);
	});

	// Go: trailers.go:241-242 — message preserved verbatim before blank line + trailers
	it('preserves a multi-line message body before the trailer block', () => {
		const result = formatShadowTaskCommit('Line 1\nLine 2', 'task-dir', 'sess-2');
		expect(result.startsWith('Line 1\nLine 2\n\n')).toBe(true);
		expect(result).toContain('Story-Metadata-Task: task-dir\n');
		expect(result).toContain('Story-Session: sess-2\n');
		expect(result).toContain('Story-Strategy: manual-commit\n');
	});

	// Go: trailers.go:240-247 — empty session id still produces well-formed trailer
	it('handles empty session id', () => {
		const result = formatShadowTaskCommit('msg', 'task-dir', '');
		expect(result).toContain('Story-Session: \n');
	});

	// Hardcoded literal "manual-commit" must use Story- prefix family
	it('exports STORY_SOURCE_REF_TRAILER_KEY as "Story-Source-Ref"', () => {
		expect(STORY_SOURCE_REF_TRAILER_KEY).toBe('Story-Source-Ref');
	});
});
