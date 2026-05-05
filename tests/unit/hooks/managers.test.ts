/**
 * Tests for `src/hooks/managers.ts`.
 *
 * Mirrors Go `cmd/entire/cli/strategy/hook_managers_test.go` (18 tests).
 * Detection is pure fs.stat (no file reads) so these tests just need a
 * scratch directory + individual file/dir creations.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	checkAndWarnHookManagers,
	detectHookManagers,
	extractCommandLine,
	type HookManager,
	hookManagerWarning,
} from '@/hooks/managers';

describe('hooks/managers — Go: strategy/hook_managers.go', () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'story-mgr-'));
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	describe('detectHookManagers', () => {
		// Go: hook_managers_test.go:12 TestDetectHookManagers_None
		it('no managers — empty directory returns []', async () => {
			const result = await detectHookManagers(tmpDir);
			expect(result).toEqual([]);
		});

		// Go: hook_managers_test.go:22 TestDetectHookManagers_Husky
		it('Husky — .husky/ exists → overwritesHooks: true', async () => {
			await fs.mkdir(path.join(tmpDir, '.husky', '_'), { recursive: true });
			const result = await detectHookManagers(tmpDir);
			expect(result).toHaveLength(1);
			expect(result[0]!.name).toBe('Husky');
			expect(result[0]!.configPath).toBe('.husky/');
			expect(result[0]!.overwritesHooks).toBe(true);
		});

		// Go: hook_managers_test.go:46 TestDetectHookManagers_Lefthook
		it('Lefthook — lefthook.yml → overwritesHooks: false', async () => {
			await fs.writeFile(path.join(tmpDir, 'lefthook.yml'), '');
			const result = await detectHookManagers(tmpDir);
			expect(result).toHaveLength(1);
			expect(result[0]!.name).toBe('Lefthook');
			expect(result[0]!.configPath).toBe('lefthook.yml');
			expect(result[0]!.overwritesHooks).toBe(false);
		});

		// Go: hook_managers_test.go:69 TestDetectHookManagers_LefthookDotPrefix
		it('Lefthook dot prefix — .lefthook.yml', async () => {
			await fs.writeFile(path.join(tmpDir, '.lefthook.yml'), '');
			const result = await detectHookManagers(tmpDir);
			expect(result).toHaveLength(1);
			expect(result[0]!.name).toBe('Lefthook');
			expect(result[0]!.configPath).toBe('.lefthook.yml');
		});

		// Go: hook_managers_test.go:89 TestDetectHookManagers_LefthookToml
		it('Lefthook toml — lefthook.toml', async () => {
			await fs.writeFile(path.join(tmpDir, 'lefthook.toml'), '');
			const result = await detectHookManagers(tmpDir);
			expect(result).toHaveLength(1);
			expect(result[0]!.configPath).toBe('lefthook.toml');
		});

		// Go: hook_managers_test.go:109 TestDetectHookManagers_LefthookLocal
		it('Lefthook local — lefthook-local.yml', async () => {
			await fs.writeFile(path.join(tmpDir, 'lefthook-local.yml'), '');
			const result = await detectHookManagers(tmpDir);
			expect(result).toHaveLength(1);
			expect(result[0]!.configPath).toBe('lefthook-local.yml');
		});

		// Go: hook_managers_test.go:129 TestDetectHookManagers_LefthookDedup
		it('Lefthook dedup — both lefthook.yml and .lefthook.yml → only one entry', async () => {
			await fs.writeFile(path.join(tmpDir, 'lefthook.yml'), '');
			await fs.writeFile(path.join(tmpDir, '.lefthook.yml'), '');
			const result = await detectHookManagers(tmpDir);
			expect(result).toHaveLength(1);
			expect(result[0]!.name).toBe('Lefthook');
		});

		// Go: hook_managers_test.go:150 TestDetectHookManagers_PreCommit
		it('pre-commit — .pre-commit-config.yaml', async () => {
			await fs.writeFile(path.join(tmpDir, '.pre-commit-config.yaml'), '');
			const result = await detectHookManagers(tmpDir);
			expect(result).toHaveLength(1);
			expect(result[0]!.name).toBe('pre-commit');
			expect(result[0]!.overwritesHooks).toBe(false);
		});

		// Go: hook_managers_test.go:173 TestDetectHookManagers_Overcommit
		it('Overcommit — .overcommit.yml', async () => {
			await fs.writeFile(path.join(tmpDir, '.overcommit.yml'), '');
			const result = await detectHookManagers(tmpDir);
			expect(result).toHaveLength(1);
			expect(result[0]!.name).toBe('Overcommit');
			expect(result[0]!.overwritesHooks).toBe(false);
		});

		// Go: hook_managers_test.go:196 TestDetectHookManagers_Hk
		it('hk — hk.pkl', async () => {
			await fs.writeFile(path.join(tmpDir, 'hk.pkl'), '');
			const result = await detectHookManagers(tmpDir);
			expect(result).toHaveLength(1);
			expect(result[0]!.name).toBe('hk');
			expect(result[0]!.configPath).toBe('hk.pkl');
		});

		// Go: hook_managers_test.go:219 TestDetectHookManagers_HkConfigDir
		it('hk config dir — .config/hk.pkl', async () => {
			await fs.mkdir(path.join(tmpDir, '.config'), { recursive: true });
			await fs.writeFile(path.join(tmpDir, '.config', 'hk.pkl'), '');
			const result = await detectHookManagers(tmpDir);
			expect(result).toHaveLength(1);
			expect(result[0]!.name).toBe('hk');
			expect(result[0]!.configPath).toBe('.config/hk.pkl');
		});

		// Go: hook_managers_test.go:243 TestDetectHookManagers_HkLocal
		it('hk local — hk.local.pkl', async () => {
			await fs.writeFile(path.join(tmpDir, 'hk.local.pkl'), '');
			const result = await detectHookManagers(tmpDir);
			expect(result).toHaveLength(1);
			expect(result[0]!.configPath).toBe('hk.local.pkl');
		});

		// Go: hook_managers_test.go:263 TestDetectHookManagers_HkDedup
		it('hk dedup — both hk.pkl and hk.local.pkl → only one entry', async () => {
			await fs.writeFile(path.join(tmpDir, 'hk.pkl'), '');
			await fs.writeFile(path.join(tmpDir, 'hk.local.pkl'), '');
			const result = await detectHookManagers(tmpDir);
			expect(result).toHaveLength(1);
			expect(result[0]!.name).toBe('hk');
		});

		// Go: hook_managers_test.go:284 TestDetectHookManagers_Multiple
		it('multiple — Husky + pre-commit detected', async () => {
			await fs.mkdir(path.join(tmpDir, '.husky', '_'), { recursive: true });
			await fs.writeFile(path.join(tmpDir, '.pre-commit-config.yaml'), '');
			const result = await detectHookManagers(tmpDir);
			expect(result).toHaveLength(2);
			const names = result.map((m) => m.name).sort();
			expect(names).toEqual(['Husky', 'pre-commit']);
		});
	});

	describe('hookManagerWarning', () => {
		// Go: hook_managers_test.go:313 TestHookManagerWarning_Husky
		it('Husky (Category A) — detailed warning + per-hook command lines', () => {
			const managers: HookManager[] = [
				{ name: 'Husky', configPath: '.husky/', overwritesHooks: true },
			];
			const warning = hookManagerWarning(managers, 'story');
			expect(warning).toContain('Warning: Husky detected (.husky/)');
			expect(warning).toContain('may overwrite hooks');
			// Each hook file path listed
			for (const name of [
				'prepare-commit-msg',
				'commit-msg',
				'post-commit',
				'post-rewrite',
				'pre-push',
			]) {
				expect(warning).toContain(`.husky/${name}:`);
				expect(warning).toContain(`story hooks git ${name}`);
			}
			// Story-side red line
			expect(warning).not.toContain('entire hooks git');
		});

		// Go: hook_managers_test.go:351 TestHookManagerWarning_GitHooksManager
		it('Lefthook (Category B) — note with story enable suggestion', () => {
			const managers: HookManager[] = [
				{ name: 'Lefthook', configPath: 'lefthook.yml', overwritesHooks: false },
			];
			const warning = hookManagerWarning(managers, 'story');
			expect(warning).toContain('Note: Lefthook detected');
			expect(warning).toContain("run 'story enable'");
			expect(warning).not.toContain('entire enable');
			// Category B should NOT contain per-hook command instructions
			expect(warning).not.toContain('prepare-commit-msg:');
		});

		// Go: hook_managers_test.go:374 TestHookManagerWarning_Empty
		it('empty managers → empty string', () => {
			expect(hookManagerWarning([], 'story')).toBe('');
		});

		// Go: hook_managers_test.go:388 TestHookManagerWarning_LocalDev
		it('localDev prefix — warning uses dev entry', () => {
			const managers: HookManager[] = [
				{ name: 'Husky', configPath: '.husky/', overwritesHooks: true },
			];
			const warning = hookManagerWarning(managers, 'bun run src/cli.ts');
			expect(warning).toContain('bun run src/cli.ts hooks git');
		});

		// Go: hook_managers_test.go:403 TestHookManagerWarning_Multiple
		it('mixed Category A + B → both sections present', () => {
			const managers: HookManager[] = [
				{ name: 'Husky', configPath: '.husky/', overwritesHooks: true },
				{ name: 'Lefthook', configPath: 'lefthook.yml', overwritesHooks: false },
			];
			const warning = hookManagerWarning(managers, 'story');
			expect(warning).toContain('Warning: Husky detected');
			expect(warning).toContain('Note: Lefthook detected');
		});
	});

	describe('extractCommandLine', () => {
		// Go: hook_managers_test.go:421 TestExtractCommandLine subtests
		it('standard hook — returns first non-shebang, non-comment line', () => {
			const content = `#!/bin/sh
# Story CLI hooks
story hooks git post-commit 2>/dev/null || true
`;
			expect(extractCommandLine(content)).toBe('story hooks git post-commit 2>/dev/null || true');
		});

		it('multiple comments — skips all # lines', () => {
			const content = `#!/bin/sh
# comment 1
# comment 2
story hooks git pre-push "$1" || true
`;
			expect(extractCommandLine(content)).toBe('story hooks git pre-push "$1" || true');
		});

		it('empty content — returns ""', () => {
			expect(extractCommandLine('')).toBe('');
		});

		it('only comments — returns ""', () => {
			expect(extractCommandLine('#!/bin/sh\n# just a comment\n')).toBe('');
		});

		it('whitespace around command — trimmed', () => {
			const content = `#!/bin/sh
# comment
  story hooks git commit-msg "$1" || exit 1  
`;
			expect(extractCommandLine(content)).toBe('story hooks git commit-msg "$1" || exit 1');
		});
	});

	describe('checkAndWarnHookManagers', () => {
		// Go: hook_managers_test.go:467 TestCheckAndWarnHookManagers_NoManagers
		it('no managers detected — no output', async () => {
			const buf: string[] = [];
			const w = new PassThrough();
			w.on('data', (c) => buf.push(String(c)));

			await checkAndWarnHookManagers(tmpDir, w, false, false);

			// Give flushed buffers a chance
			await new Promise((r) => setImmediate(r));
			expect(buf.join('')).toBe('');
		});

		// Go: hook_managers_test.go:479 TestCheckAndWarnHookManagers_WithHusky
		it('Husky detected — warning written', async () => {
			await fs.mkdir(path.join(tmpDir, '.husky', '_'), { recursive: true });
			const buf: string[] = [];
			const w = new PassThrough();
			w.on('data', (c) => buf.push(String(c)));

			await checkAndWarnHookManagers(tmpDir, w, false, false);

			await new Promise((r) => setImmediate(r));
			const output = buf.join('');
			expect(output).toContain('Warning: Husky detected');
		});

		// Go: hook_managers.go:136-140 — hookCmdPrefix error → return
		// silently. Matches the Story-side A2 fix in checkAndWarnHookManagers
		// where absolutePath: true can trigger realpathSync throw.
		it('hookCmdPrefix throws (absolutePath resolution fail) → silent return, no stderr', async () => {
			// Husky present, so detectHookManagers returns a non-empty list.
			await fs.mkdir(path.join(tmpDir, '.husky', '_'), { recursive: true });

			// Point process.execPath at a non-existent path — realpathSync
			// will throw ENOENT when hookCmdPrefix(absolutePath=true) runs.
			const originalExecPath = process.execPath;
			Object.defineProperty(process, 'execPath', {
				value: path.join(tmpDir, 'nonexistent-binary-xyz'),
				configurable: true,
			});

			const buf: string[] = [];
			const w = new PassThrough();
			w.on('data', (c) => buf.push(String(c)));

			try {
				// absolutePath: true → hookCmdPrefix calls realpathSync on the
				// non-existent path → throw → checkAndWarnHookManagers catches
				// and returns silently (matches Go best-effort behavior).
				await expect(checkAndWarnHookManagers(tmpDir, w, false, true)).resolves.toBeUndefined();
			} finally {
				Object.defineProperty(process, 'execPath', {
					value: originalExecPath,
					configurable: true,
				});
			}

			await new Promise((r) => setImmediate(r));
			expect(buf.join('')).toBe('');
		});
	});
});
