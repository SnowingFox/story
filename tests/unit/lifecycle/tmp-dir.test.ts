/**
 * Phase 7 Part 1 `src/lifecycle/tmp-dir.ts` — 4 case.
 *
 * Go 参考：`cmd/entire/cli/state.go: resolveTmpDir`（Go 无直接 test；
 * TS 补 4 case 覆盖字面量 + worktree OK + worktree 失败 fallback +
 * Story-side rebrand 无 `.entire/` 泄漏）。
 *
 * Each `it()` is annotated with `// Go: <anchor>` for traceability.
 */

import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveTmpDir, STORY_TMP_DIR } from '@/lifecycle/tmp-dir';
import { clearWorktreeRootCache } from '@/paths';

describe('lifecycle/tmp-dir', () => {
	beforeEach(() => {
		clearWorktreeRootCache();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		clearWorktreeRootCache();
	});

	// Go: state.go: resolveTmpDir (literal; Story rebrand)
	it('STORY_TMP_DIR literal is ".story/tmp" (Story-side rebrand)', () => {
		expect(STORY_TMP_DIR).toBe('.story/tmp');
		// Story-side rebrand asserts: must NOT be `.entire/tmp` (Go literal).
		expect(STORY_TMP_DIR as string).not.toBe('.entire/tmp');
	});

	// Go: state.go: resolveTmpDir (worktree OK branch)
	it('resolveTmpDir returns <repoRoot>/.story/tmp when worktreeRoot succeeds', async () => {
		const paths = await import('@/paths');
		vi.spyOn(paths, 'worktreeRoot').mockResolvedValue('/a/b');
		const result = await resolveTmpDir();
		expect(result).toBe(path.join('/a/b', '.story/tmp'));
	});

	// Go: state.go: resolveTmpDir (fail-safe fallback)
	it('resolveTmpDir falls back to cwd when worktreeRoot fails', async () => {
		const paths = await import('@/paths');
		vi.spyOn(paths, 'worktreeRoot').mockRejectedValue(new Error('not a git repo'));
		const result = await resolveTmpDir();
		expect(result).toBe(path.join(process.cwd(), '.story/tmp'));
	});

	// Go: state.go: resolveTmpDir (Story-side rebrand — no .entire/ leakage in output)
	it('output path contains ".story/tmp" literal and no .entire/ leakage', async () => {
		const paths = await import('@/paths');
		vi.spyOn(paths, 'worktreeRoot').mockResolvedValue('/tmp/repo');
		const result = await resolveTmpDir();
		expect(result).toContain('.story/tmp');
		expect(result).not.toContain('.entire/');
	});
});
