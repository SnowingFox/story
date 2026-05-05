/**
 * Phase 5.1 strategy/rewind-helpers.ts unit tests.
 *
 * **TS-only**: Go's rewind helpers (`common.go:1011-1413`) have no dedicated
 * `Test*` in `strategy/*_test.go` — Go covers them transitively through the
 * `manual_commit_rewind_test.go` end-to-end suite. Phase 5.5 will port the
 * full Go-rich `checkCanRewindWithWarning` (per-file +/- diff stats) +
 * end-to-end rewind tests; the unit tests below pin the helper-level
 * contracts so 5.5 can rely on them.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MODE_DIR, MODE_FILE } from '@/checkpoint/tree-ops';
import {
	checkCanRewindWithWarning,
	collectUntrackedFiles,
	computeDiffStats,
	countLines,
	getTaskCheckpointFromTree,
	getTaskTranscriptFromTree,
	isProtectedPath,
	parseNullDelimited,
	protectedDirs,
	splitLines,
} from '@/strategy/rewind-helpers';
import { type FixtureTreeEntry, TestEnv } from '../../helpers/test-env';

// TS-only: Go production lives at common.go:1011-1413; no dedicated `Test*`
// (Go uses end-to-end rewind tests in manual_commit_rewind_test.go).
describe('strategy/rewind-helpers — Go: common.go:1011-1413 (production; e2e-only Go coverage)', () => {
	let env: TestEnv;

	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
	});

	afterEach(async () => {
		await env.cleanup();
	});

	// Phase 5.5 — Go: common.go: checkCanRewindWithWarning (Go-rich diff stats).
	describe('checkCanRewindWithWarning (Go-rich diff stats)', () => {
		// Go: common.go: checkCanRewindWithWarning (clean repo branch)
		it('returns empty message on clean worktree', async () => {
			const { canRewind, message } = await checkCanRewindWithWarning(env.dir);
			expect(canRewind).toBe(true);
			expect(message).toBe('');
		});

		// Go: common.go: checkCanRewindWithWarning (no HEAD branch)
		it('returns empty message on no HEAD (empty repo)', async () => {
			const empty = await TestEnv.create({ initialCommit: false });
			try {
				const { canRewind, message } = await checkCanRewindWithWarning(empty.dir);
				expect(canRewind).toBe(true);
				expect(message).toBe('');
			} finally {
				await empty.cleanup();
			}
		});

		// Go: common.go: checkCanRewindWithWarning (paths.IsInfrastructurePath skip)
		it('skips .story/ paths', async () => {
			await env.writeFile('.story/foo.json', '{}');
			const { message } = await checkCanRewindWithWarning(env.dir);
			expect(message).not.toContain('.story');
		});

		// Go: common.go: checkCanRewindWithWarning (Untracked skip)
		it('skips untracked files', async () => {
			await env.writeFile('untracked.txt', 'x');
			const { canRewind, message } = await checkCanRewindWithWarning(env.dir);
			expect(canRewind).toBe(true);
			expect(message).toBe('');
		});

		// Go: common.go: checkCanRewindWithWarning (added + modified path with stats + Total footer)
		it('shows per-file +/- stats and total footer', async () => {
			// Modify the existing tracked file (.gitkeep is empty) — adds lines.
			await env.writeFile('.gitkeep', 'a\nb\nc\n');
			// Add a new file via index.
			await env.writeFile('new.ts', 'one\ntwo\nthree\n');
			await env.gitAdd('new.ts');
			const { canRewind, message } = await checkCanRewindWithWarning(env.dir);
			expect(canRewind).toBe(true);
			expect(message).toContain('The following uncommitted changes will be reverted:');
			expect(message).toContain('.gitkeep');
			expect(message).toContain('new.ts');
			expect(message).toContain('Total: ');
			expect(message).toMatch(/Total: \+\d+\/-\d+ lines/);
		});

		// Go: common.go: checkCanRewindWithWarning + computeDiffStats + splitLines (CRLF)
		it('normalizes Windows CRLF before diffing', async () => {
			// initial commit content is empty .gitkeep; replace with CRLF-only content
			// equivalent to LF version → diff stats should be 0/0.
			await env.writeFile('a.txt', 'line one\nline two\n');
			await env.gitAdd('a.txt');
			await env.gitCommit('add a.txt');
			// Now overwrite a.txt with CRLF version; diff should still report no
			// added / removed lines (CRLF normalized).
			await env.writeFile('a.txt', 'line one\r\nline two\r\n');
			const { message } = await checkCanRewindWithWarning(env.dir);
			// Either skipped (no diff) or modified with +0/-0 (no stats appended).
			if (message !== '') {
				expect(message).toContain('a.txt');
				expect(message).not.toMatch(/a\.txt\s+\(\+/);
			}
		});

		// Go: common.go: checkCanRewindWithWarning (sort by filename for stable output)
		it('sorts changes by filename for stable output', async () => {
			await env.writeFile('z.ts', 'z\n');
			await env.gitAdd('z.ts');
			await env.gitCommit('add z.ts');
			await env.writeFile('a.ts', 'a\n');
			await env.gitAdd('a.ts');
			await env.gitCommit('add a.ts');
			// Modify both.
			await env.writeFile('z.ts', 'z\nz2\n');
			await env.writeFile('a.ts', 'a\na2\n');
			const { message } = await checkCanRewindWithWarning(env.dir);
			const aIdx = message.indexOf('a.ts');
			const zIdx = message.indexOf('z.ts');
			expect(aIdx).toBeGreaterThanOrEqual(0);
			expect(zIdx).toBeGreaterThanOrEqual(0);
			expect(aIdx).toBeLessThan(zIdx);
		});
	});

	// Phase 5.5 — Go: common.go: countLines / computeDiffStats / splitLines.
	describe('countLines / computeDiffStats / splitLines', () => {
		const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

		// Go: common.go: countLines (4 cases)
		it('countLines: empty / single line / trailing newline / multiline', () => {
			expect(countLines(enc(''))).toBe(0);
			expect(countLines(enc('a'))).toBe(1);
			expect(countLines(enc('a\n'))).toBe(1);
			expect(countLines(enc('a\nb'))).toBe(2);
			expect(countLines(enc('a\nb\nc\n'))).toBe(3);
		});

		// Go: common.go: computeDiffStats (identical / all added / all removed)
		it('computeDiffStats: identical / all added / all removed', () => {
			expect(computeDiffStats(enc('a\nb'), enc('a\nb'))).toEqual([0, 0]);
			expect(computeDiffStats(enc(''), enc('a\nb'))).toEqual([2, 0]);
			expect(computeDiffStats(enc('a\nb'), enc(''))).toEqual([0, 2]);
		});

		// Go: common.go: computeDiffStats (1 line modified)
		it('computeDiffStats: 1 line modified', () => {
			expect(computeDiffStats(enc('a\nb\nc'), enc('a\nb\nd'))).toEqual([1, 1]);
		});

		// Go: common.go: computeDiffStats + splitLines (CRLF normalize)
		it('computeDiffStats: CRLF normalized before diff', () => {
			expect(computeDiffStats(enc('a\r\nb'), enc('a\nb'))).toEqual([0, 0]);
		});

		// Go: common.go: splitLines (3 cases)
		it('splitLines: empty / trailing newline / CRLF normalized / preserves middle empty', () => {
			expect(splitLines(enc(''))).toEqual([]);
			expect(splitLines(enc('a\nb'))).toEqual(['a', 'b']);
			expect(splitLines(enc('a\nb\n'))).toEqual(['a', 'b']);
			expect(splitLines(enc('a\r\nb\r\nc'))).toEqual(['a', 'b', 'c']);
			expect(splitLines(enc('a\n\nb'))).toEqual(['a', '', 'b']);
		});
	});

	describe('collectUntrackedFiles', () => {
		it('returns empty array for clean worktree', async () => {
			expect(await collectUntrackedFiles(env.dir)).toEqual([]);
		});

		it('lists untracked files', async () => {
			await env.writeFile('a.txt', 'a');
			await env.writeFile('b.txt', 'b');
			const result = await collectUntrackedFiles(env.dir);
			expect(result.sort()).toEqual(['a.txt', 'b.txt']);
		});

		it('does not include modified-but-tracked files', async () => {
			await env.writeFile('.gitkeep', 'modified content');
			expect(await collectUntrackedFiles(env.dir)).toEqual([]);
		});

		// Go: common.go:1408 — defense-in-depth filter against `.git/...` and
		// `.story/...` even though git's `--exclude-standard` should already
		// drop them. Required so `collectUntrackedFiles` never reports paths
		// the rewind cleanup could destroy.
		it('filters protected paths (.git / .story) even when git would otherwise leak them', async () => {
			// Simulate a path leaking through by writing into .story/ which
			// might or might not be in .gitignore yet. Either way, the
			// post-filter must drop it.
			await env.writeFile('.story/foo.json', '{}');
			await env.writeFile('keep.txt', 'k');
			const result = await collectUntrackedFiles(env.dir);
			expect(result).toContain('keep.txt');
			expect(result.some((p) => p.startsWith('.story/'))).toBe(false);
			expect(result.some((p) => p.startsWith('.git/'))).toBe(false);
		});
	});

	// Go: common.go:238-266 isProtectedPath / protectedDirs (no dedicated Go Test*
	// in the cited range; functions are unexported helpers used by collectUntrackedFiles).
	describe('isProtectedPath / protectedDirs — Go: common.go:238-266', () => {
		it('protectedDirs always includes .git and .story (Phase 5.1 base)', () => {
			const dirs = protectedDirs();
			expect(dirs).toContain('.git');
			expect(dirs).toContain('.story');
		});

		it('protectedDirs includes Vogon `.vogon` after Part 1 self-register (Phase 6.1 Part 2)', async () => {
			// Go: common.go:266 — `append([]string{gitDir, entireDir}, agent.AllProtectedDirs()...)`.
			// Vogon (Part 1 ship) declares `.vogon` via `protectedDirs()`.
			const { register, withTestRegistry } = await import('@/agent/registry');
			const { mockBaseAgent } = await import('../agent/_helpers');
			await withTestRegistry(async () => {
				register('vogon-test' as never, () =>
					mockBaseAgent({
						name: () => 'vogon-test' as never,
						protectedDirs: () => ['.vogon'],
					}),
				);
				const dirs = protectedDirs();
				expect(dirs).toEqual(['.git', '.story', '.vogon']);
			});
		});

		it('protectedDirs returns sorted+deduped union of base + every agent (Phase 6.1 Part 2)', async () => {
			// Multi-agent: 2 agents declare `.shared`; result must dedupe + sort.
			const { register, withTestRegistry } = await import('@/agent/registry');
			const { mockBaseAgent } = await import('../agent/_helpers');
			await withTestRegistry(async () => {
				register('a' as never, () =>
					mockBaseAgent({ name: () => 'a' as never, protectedDirs: () => ['.shared', '.a-only'] }),
				);
				register('b' as never, () =>
					mockBaseAgent({ name: () => 'b' as never, protectedDirs: () => ['.shared', '.b-only'] }),
				);
				const dirs = protectedDirs();
				expect(dirs).toEqual(['.a-only', '.b-only', '.git', '.shared', '.story']);
			});
		});

		it('isProtectedPath returns true for paths under .git/', () => {
			expect(isProtectedPath('.git/HEAD')).toBe(true);
			expect(isProtectedPath('.git/refs/heads/main')).toBe(true);
		});

		it('isProtectedPath returns true for paths under .story/', () => {
			expect(isProtectedPath('.story/metadata/sess/0/prompt.txt')).toBe(true);
			expect(isProtectedPath('.story/.gitignore')).toBe(true);
		});

		it('isProtectedPath returns true for the protected dir itself (boundary)', () => {
			expect(isProtectedPath('.git')).toBe(true);
			expect(isProtectedPath('.story')).toBe(true);
		});

		it('isProtectedPath returns false for ordinary repo paths', () => {
			expect(isProtectedPath('src/foo.ts')).toBe(false);
			expect(isProtectedPath('README.md')).toBe(false);
			expect(isProtectedPath('.gitignore')).toBe(false);
		});
	});

	describe('getTaskCheckpointFromTree', () => {
		it('reads parsed checkpoint.json from a tree path', async () => {
			// Write tree: <root>/.story/metadata/sess/tasks/tu_1/checkpoint.json
			const cpJson = JSON.stringify({
				session_id: 'sess',
				tool_use_id: 'tu_1',
				checkpoint_uuid: 'uuid-1',
			});
			const cpBlob = await env.writeBlob(cpJson);
			const tu1Tree = await env.writeTree([
				{ mode: MODE_FILE, path: 'checkpoint.json', oid: cpBlob, type: 'blob' },
			] satisfies FixtureTreeEntry[]);
			const tasksTree = await env.writeTree([
				{ mode: MODE_DIR, path: 'tu_1', oid: tu1Tree, type: 'tree' },
			]);
			const sessTree = await env.writeTree([
				{ mode: MODE_DIR, path: 'tasks', oid: tasksTree, type: 'tree' },
			]);
			const metaTree = await env.writeTree([
				{ mode: MODE_DIR, path: 'sess', oid: sessTree, type: 'tree' },
			]);
			const dotStoryTree = await env.writeTree([
				{ mode: MODE_DIR, path: 'metadata', oid: metaTree, type: 'tree' },
			]);
			const root = await env.writeTree([
				{ mode: MODE_DIR, path: '.story', oid: dotStoryTree, type: 'tree' },
			]);

			const checkpoint = await getTaskCheckpointFromTree(
				env.dir,
				root,
				'.story/metadata/sess/tasks/tu_1',
			);
			expect(checkpoint).not.toBeNull();
			expect(checkpoint?.sessionId).toBe('sess');
			expect(checkpoint?.toolUseId).toBe('tu_1');
			expect(checkpoint?.checkpointUuid).toBe('uuid-1');
		});

		it('returns null when checkpoint.json missing', async () => {
			const root = await env.writeTree([]);
			expect(
				await getTaskCheckpointFromTree(env.dir, root, '.story/metadata/sess/tasks/tu_1'),
			).toBeNull();
		});
	});

	describe('getTaskTranscriptFromTree', () => {
		it('returns null when transcript missing', async () => {
			const root = await env.writeTree([]);
			// taskMetadataDir = parent/tasks/tu_1 → sessionDir lookup at "parent"
			expect(await getTaskTranscriptFromTree(env.dir, root, 'parent/tasks/tu_1')).toBeNull();
		});

		it('falls back to legacy filename (full.log) when full.jsonl missing — Go: common.go:1271-1313', async () => {
			// Tree:
			//   sess/                   <-- session dir (Dir(Dir(metadataDir)))
			//     full.log              <-- legacy transcript (modern missing)
			//     tasks/tu_1/           <-- task metadata dir
			//       checkpoint.json
			const legacyContent = 'legacy transcript content';
			const legacyBlob = await env.writeBlob(legacyContent);
			const cpBlob = await env.writeBlob('{"sessionId":"sess","toolUseId":"tu_1"}');
			const tu1Tree = await env.writeTree([
				{ mode: MODE_FILE, path: 'checkpoint.json', oid: cpBlob, type: 'blob' },
			] satisfies FixtureTreeEntry[]);
			const tasksTree = await env.writeTree([
				{ mode: MODE_DIR, path: 'tu_1', oid: tu1Tree, type: 'tree' },
			]);
			const sessTree = await env.writeTree([
				{ mode: MODE_FILE, path: 'full.log', oid: legacyBlob, type: 'blob' },
				{ mode: MODE_DIR, path: 'tasks', oid: tasksTree, type: 'tree' },
			]);
			const root = await env.writeTree([
				{ mode: MODE_DIR, path: 'sess', oid: sessTree, type: 'tree' },
			]);

			const result = await getTaskTranscriptFromTree(env.dir, root, 'sess/tasks/tu_1');
			expect(result).not.toBeNull();
			expect(new TextDecoder().decode(result!)).toBe(legacyContent);
		});

		// Go: common.go:1292-1313 getTaskTranscriptFromTree reads the SESSION-level
		// transcript (one or two directories above the task metadata dir), not the
		// task-level transcript. Go path: Dir(Dir(metadataDir))/<TRANSCRIPT_FILE_NAME>
		//
		// IMPL GAP: TS reads <taskMetadataDir>/<TRANSCRIPT_FILE_NAME>. This test
		// builds the Go-expected layout and verifies the session transcript is read
		// (not the task one). Will fail until impl matches Go.
		it('reads session-level transcript at Dir(Dir(metadataDir))/full.jsonl — Go: common.go:1292-1313', async () => {
			// Layout (Go):
			//   .story/metadata/sess/                     <-- two-up = session dir
			//     full.jsonl                               <-- session transcript (Go reads this)
			//     tasks/tu_1/                              <-- task metadata dir
			//       checkpoint.json
			//       full.jsonl                             <-- task-level (TS currently reads this)
			const sessionTranscript = 'session-level transcript';
			const taskTranscript = 'task-level transcript (TS wrongly reads this)';

			const sessionTranscriptBlob = await env.writeBlob(sessionTranscript);
			const taskTranscriptBlob = await env.writeBlob(taskTranscript);
			const checkpointBlob = await env.writeBlob('{"session_id":"sess","tool_use_id":"tu_1"}');

			const tu1Tree = await env.writeTree([
				{ mode: MODE_FILE, path: 'checkpoint.json', oid: checkpointBlob, type: 'blob' },
				{ mode: MODE_FILE, path: 'full.jsonl', oid: taskTranscriptBlob, type: 'blob' },
			] satisfies FixtureTreeEntry[]);
			const tasksTree = await env.writeTree([
				{ mode: MODE_DIR, path: 'tu_1', oid: tu1Tree, type: 'tree' },
			]);
			const sessTree = await env.writeTree([
				{ mode: MODE_FILE, path: 'full.jsonl', oid: sessionTranscriptBlob, type: 'blob' },
				{ mode: MODE_DIR, path: 'tasks', oid: tasksTree, type: 'tree' },
			]);
			const metaTree = await env.writeTree([
				{ mode: MODE_DIR, path: 'sess', oid: sessTree, type: 'tree' },
			]);
			const dotStoryTree = await env.writeTree([
				{ mode: MODE_DIR, path: 'metadata', oid: metaTree, type: 'tree' },
			]);
			const root = await env.writeTree([
				{ mode: MODE_DIR, path: '.story', oid: dotStoryTree, type: 'tree' },
			]);

			// Pass the task metadata dir; Go reads SESSION-level (Dir(Dir(metadataDir)))
			const result = await getTaskTranscriptFromTree(
				env.dir,
				root,
				'.story/metadata/sess/tasks/tu_1',
			);
			expect(result).not.toBeNull();
			// Go expects session-level content; TS currently returns task-level
			expect(new TextDecoder().decode(result!)).toBe(sessionTranscript);
		});
	});

	// Phase 9.5 hardening: `-z` parsing + shared NUL-split helper.
	// Go: common.go:1377-1407 ls-files + status use `-z` + NUL split.
	describe('parseNullDelimited + -z hardening (Phase 9.5)', () => {
		it('parseNullDelimited: basic multi-entry input', () => {
			expect(parseNullDelimited('a\x00b\x00c\x00')).toEqual(['a', 'b', 'c']);
		});

		it('parseNullDelimited: strips only the trailing empty entry from ls-files -z output', () => {
			expect(parseNullDelimited('x\x00y\x00')).toEqual(['x', 'y']);
		});

		it('parseNullDelimited: empty input returns []', () => {
			expect(parseNullDelimited('')).toEqual([]);
		});

		it('parseNullDelimited: preserves interior empty segments (required for porcelain -z)', () => {
			expect(parseNullDelimited('a\x00\x00b\x00')).toEqual(['a', '', 'b']);
		});

		it('collectUntrackedFiles: filenames with non-ASCII unicode survive the -z round-trip', async () => {
			await env.writeFile('中文.txt', 'chinese');
			await env.writeFile('emoji-🚀.txt', 'rocket');
			const result = await collectUntrackedFiles(env.dir);
			expect(result).toContain('中文.txt');
			expect(result).toContain('emoji-🚀.txt');
			// C-quoted form must NOT appear (would start with quote chars).
			expect(result.some((p) => p.startsWith('"'))).toBe(false);
		});

		it('collectUntrackedFiles: filenames with spaces stay single-entry (not split on whitespace)', async () => {
			await env.writeFile('name with space.txt', 'x');
			const result = await collectUntrackedFiles(env.dir);
			expect(result).toContain('name with space.txt');
		});

		it('checkCanRewindWithWarning: non-ASCII tracked file path appears verbatim in warning message', async () => {
			// Track an ASCII file first so commit succeeds, then mutate it.
			await env.writeFile('中文.ts', 'export const a = 1;\n');
			await env.gitAdd('中文.ts');
			await env.gitCommit('add unicode-named file');
			await env.writeFile('中文.ts', 'export const a = 2;\n');
			const { message } = await checkCanRewindWithWarning(env.dir);
			expect(message).toContain('中文.ts');
		});
	});
});
