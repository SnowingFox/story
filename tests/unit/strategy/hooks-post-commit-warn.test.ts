/**
 * Phase 5.4 Part 2 unit tests for [src/strategy/hooks-post-commit-warn.ts](src/strategy/hooks-post-commit-warn.ts).
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/strategy/manual_commit_hooks.go`:
 *   - `warnStaleEndedSessions` / `warnStaleEndedSessionsTo`
 *   - constants `staleEndedSessionWarn{Threshold,Interval,File}` +
 *     `activeSessionInteractionThreshold`
 *
 * Each `it()` is annotated with `// Go: <go-file>:<line>` for the
 * audit-test-go-parity gate.
 *
 * **Story brand check**: tests assert stderr content uses `"story:"` and
 * `"story doctor"` (NOT `"entire:"` / `"entire doctor"`).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	ACTIVE_SESSION_INTERACTION_THRESHOLD_MS,
	STALE_ENDED_SESSION_WARN_FILE,
	STALE_ENDED_SESSION_WARN_INTERVAL_MS,
	STALE_ENDED_SESSION_WARN_THRESHOLD,
	warnStaleEndedSessions,
} from '@/strategy/hooks-post-commit-warn';
import { setStderrWriterForTesting } from '@/strategy/hooks-tty';
import { TestEnv } from '../../helpers/test-env';

class CaptureWriter {
	chunks: string[] = [];
	write(chunk: string | Buffer | Uint8Array): boolean {
		this.chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
		return true;
	}
	get text(): string {
		return this.chunks.join('');
	}
}

// SESSION_STATE_DIR_NAME is `story-sessions`, so sentinel lives at
// <gitCommonDir>/story-sessions/.warn-stale-ended.
const SESSION_DIR = 'story-sessions';

describe('hooks-post-commit-warn — Go: manual_commit_hooks.go (warnStaleEndedSessions / warnStaleEndedSessionsTo)', () => {
	let env: TestEnv;
	let buf: CaptureWriter;
	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		buf = new CaptureWriter();
		setStderrWriterForTesting(buf as unknown as NodeJS.WritableStream);
	});
	afterEach(async () => {
		setStderrWriterForTesting(null);
		await env.cleanup();
	});

	// Go: manual_commit_hooks.go:852-855 — constants
	it('exports STALE_ENDED_SESSION_WARN_THRESHOLD = 3', () => {
		expect(STALE_ENDED_SESSION_WARN_THRESHOLD).toBe(3);
	});

	it('exports STALE_ENDED_SESSION_WARN_INTERVAL_MS = 24h', () => {
		expect(STALE_ENDED_SESSION_WARN_INTERVAL_MS).toBe(24 * 60 * 60 * 1000);
	});

	it('exports STALE_ENDED_SESSION_WARN_FILE = ".warn-stale-ended"', () => {
		expect(STALE_ENDED_SESSION_WARN_FILE).toBe('.warn-stale-ended');
	});

	it('exports ACTIVE_SESSION_INTERACTION_THRESHOLD_MS = 24h', () => {
		expect(ACTIVE_SESSION_INTERACTION_THRESHOLD_MS).toBe(24 * 60 * 60 * 1000);
	});

	// Go: manual_commit_hooks.go:865-890 — first-warn writes sentinel + stderr
	it('writes sentinel + stderr message on first call (no sentinel exists yet)', async () => {
		const gitCommonDir = path.join(env.dir, '.git');
		await warnStaleEndedSessions(gitCommonDir, 5);

		const sentinelPath = path.join(gitCommonDir, SESSION_DIR, STALE_ENDED_SESSION_WARN_FILE);
		// Sentinel was created.
		const stat = await fs.stat(sentinelPath);
		expect(stat.isFile()).toBe(true);
		expect(stat.size).toBe(0);

		// Stderr received the prose.
		expect(buf.text).toContain('story: 5 ended session(s)');
		expect(buf.text).toContain("Run 'story doctor'");
	});

	// Go: manual_commit_hooks.go:876-880 — rate-limit window
	it('rate-limits when sentinel mtime is within 24h', async () => {
		const gitCommonDir = path.join(env.dir, '.git');
		const sentinelDir = path.join(gitCommonDir, SESSION_DIR);
		const sentinelPath = path.join(sentinelDir, STALE_ENDED_SESSION_WARN_FILE);
		await fs.mkdir(sentinelDir, { recursive: true });
		await fs.writeFile(sentinelPath, '');
		// Set mtime to 12 hours ago.
		const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000);
		await fs.utimes(sentinelPath, twelveHoursAgo, twelveHoursAgo);
		const beforeMtime = (await fs.stat(sentinelPath)).mtimeMs;

		await warnStaleEndedSessions(gitCommonDir, 5);

		// No stderr write.
		expect(buf.text).toBe('');
		// Sentinel mtime unchanged.
		expect((await fs.stat(sentinelPath)).mtimeMs).toBe(beforeMtime);
	});

	// Go: manual_commit_hooks.go:876-880 — interval elapsed → re-warn
	it('writes again after interval elapsed (sentinel >24h ago)', async () => {
		const gitCommonDir = path.join(env.dir, '.git');
		const sentinelDir = path.join(gitCommonDir, SESSION_DIR);
		const sentinelPath = path.join(sentinelDir, STALE_ENDED_SESSION_WARN_FILE);
		await fs.mkdir(sentinelDir, { recursive: true });
		await fs.writeFile(sentinelPath, '');
		// Set mtime to 25 hours ago (past the 24h threshold).
		const oldMtime = new Date(Date.now() - 25 * 60 * 60 * 1000);
		await fs.utimes(sentinelPath, oldMtime, oldMtime);
		const beforeMtimeMs = (await fs.stat(sentinelPath)).mtimeMs;

		await warnStaleEndedSessions(gitCommonDir, 7);

		expect(buf.text).toContain('story: 7 ended session(s)');
		// Sentinel mtime updated.
		const afterMtimeMs = (await fs.stat(sentinelPath)).mtimeMs;
		expect(afterMtimeMs).toBeGreaterThan(beforeMtimeMs);
	});

	// Story brand check (Go writes "entire: ... / Run 'entire doctor'"; Story replaces both).
	it('uses "story:" prose substitution (NOT "entire:")', async () => {
		const gitCommonDir = path.join(env.dir, '.git');
		await warnStaleEndedSessions(gitCommonDir, 4);
		expect(buf.text).not.toContain('entire:');
		expect(buf.text).not.toContain("'entire doctor'");
		expect(buf.text).toContain("'story doctor'");
	});

	// Go: manual_commit_hooks.go:881-884 — fail-open on file ops
	it('fail-opens: still writes stderr when sentinel directory creation fails', async () => {
		// Use a non-existent gitCommonDir so mkdir creates a new tree —
		// success path. To force a failure, point gitCommonDir at a path
		// that contains a regular file as a directory segment.
		const blocker = path.join(env.dir, 'blocker');
		await fs.writeFile(blocker, '');
		// gitCommonDir = blocker/.git so mkdir(`<blocker>/.git/<SESSION_DIR>`)
		// fails because `blocker` is a file.
		const gitCommonDir = path.join(blocker, '.git');

		await warnStaleEndedSessions(gitCommonDir, 9);

		// Stderr still written despite failed sentinel write.
		expect(buf.text).toContain('story: 9 ended session(s)');
	});

	// Verify stderr injection works.
	it('writes through setStderrWriterForTesting injected writer (not process.stderr)', async () => {
		const gitCommonDir = path.join(env.dir, '.git');
		await warnStaleEndedSessions(gitCommonDir, 8);
		// Capture buffer received the message (not process.stderr).
		expect(buf.text.length).toBeGreaterThan(0);
	});
});
