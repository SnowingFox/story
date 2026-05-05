/**
 * Tests for `src/hooks/install.ts`.
 *
 * Mirrors Go `cmd/entire/cli/strategy/hooks_test.go` (36 tests — 6
 * `TestIsGitSequenceOperation_*` tests skipped; that function is not in
 * Phase 8 scope).
 *
 * Most of these tests need a real git repository for the `git rev-parse
 * --git-path hooks` call chain; we use {@link TestEnv} which handles
 * isolation + fixture setup. `getHooksDir` caching is reset per test via
 * {@link clearHooksDirCache}.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	BACKUP_SUFFIX,
	buildHookSpecs,
	clearHooksDirCache,
	getHooksDir,
	hookCmdPrefix,
	hookSettingsFromConfig,
	installGitHooks,
	isGitHookInstalled,
	isGitHookInstalledInDir,
	MANAGED_GIT_HOOK_NAMES,
	removeGitHooks,
	STORY_HOOK_MARKER,
	shellQuote,
} from '@/hooks/install';
import { TestEnv } from '../../helpers/test-env';

async function fileExists(p: string): Promise<boolean> {
	try {
		await fs.stat(p);
		return true;
	} catch {
		return false;
	}
}

describe('hooks/install — Go: strategy/hooks.go', () => {
	let env: TestEnv;

	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: false });
		clearHooksDirCache();
	});

	afterEach(async () => {
		await env.cleanup();
		clearHooksDirCache();
	});

	// Go: strategy/hooks.go:117-131 getHooksDirInPath
	// ────────────────────────────────────────────────────────────
	describe('getHooksDir', () => {
		// Go: hooks_test.go:184 TestGetHooksDirInPath_RegularRepo
		it('regular repo — returns <repoDir>/.git/hooks', async () => {
			const result = await getHooksDir(env.dir);
			const expected = path.join(env.dir, '.git', 'hooks');
			const resolved = await fs.realpath(result).catch(async () => {
				await fs.mkdir(result, { recursive: true });
				return fs.realpath(result);
			});
			const expectedResolved = await fs.realpath(expected).catch(async () => {
				await fs.mkdir(expected, { recursive: true });
				return fs.realpath(expected);
			});
			expect(resolved).toBe(expectedResolved);
		});

		// Go: hooks_test.go:218 TestGetHooksDirInPath_Worktree
		it('linked worktree — returns common hooks dir (main repo .git/hooks)', async () => {
			// Need initial commit in main repo for worktree add to work
			await env.writeFile('README.md', 'test');
			await env.gitAdd('README.md');
			await env.gitCommit('init');

			const wtDir = path.join(os.tmpdir(), `story-wt-${Date.now()}`);
			await env.exec('git', ['worktree', 'add', wtDir, '-b', 'feature']);
			try {
				clearHooksDirCache();
				const result = await getHooksDir(wtDir);
				const expected = path.join(env.dir, '.git', 'hooks');
				const resolved = await fs.realpath(result).catch(() => result);
				const expectedResolved = await fs.realpath(expected).catch(() => expected);
				expect(resolved).toBe(expectedResolved);
			} finally {
				await env.exec('git', ['worktree', 'remove', '--force', wtDir]).catch(() => {});
				await fs.rm(wtDir, { recursive: true, force: true }).catch(() => {});
			}
		});

		// Go: hooks_test.go:245 TestGetHooksDirInPath_CoreHooksPath
		it('core.hooksPath (relative) — returns configured path resolved against repo root', async () => {
			await env.exec('git', ['config', 'core.hooksPath', '.githooks']);
			clearHooksDirCache();
			const result = await getHooksDir(env.dir);
			expect(path.resolve(result)).toBe(path.resolve(env.dir, '.githooks'));
		});

		it('core.hooksPath (absolute) — returned unchanged', async () => {
			const absDir = path.join(env.dir, 'abs-hooks');
			await env.exec('git', ['config', 'core.hooksPath', absDir]);
			clearHooksDirCache();
			const result = await getHooksDir(env.dir);
			expect(path.resolve(result)).toBe(path.resolve(absDir));
		});

		// TS-specific: cache behavior (Go has global mutex test baked in)
		it('caches result per repoDir — second call does not re-exec git', async () => {
			const first = await getHooksDir(env.dir);
			// Delete .git to break subsequent resolution — if caching works,
			// second call still returns the first value.
			const gitDir = path.join(env.dir, '.git');
			// Move .git away temporarily to prove caching works.
			const gitDirBak = `${gitDir}.bak`;
			await fs.rename(gitDir, gitDirBak);
			try {
				const second = await getHooksDir(env.dir);
				expect(second).toBe(first);
			} finally {
				await fs.rename(gitDirBak, gitDir);
			}
		});

		it('clearHooksDirCache resets — next call re-resolves', async () => {
			const first = await getHooksDir(env.dir);
			clearHooksDirCache();
			const second = await getHooksDir(env.dir);
			expect(second).toBe(first); // semantically same, re-resolved
		});

		it('throws when not a git repository', async () => {
			const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'story-notgit-'));
			try {
				await expect(getHooksDir(tmp)).rejects.toThrow(/not a git repository/);
			} finally {
				await fs.rm(tmp, { recursive: true, force: true });
			}
		});
	});

	// Go: strategy/hooks.go:219-276 InstallGitHook
	// ────────────────────────────────────────────────────────────
	describe('installGitHooks', () => {
		// Go: hooks_test.go:547 TestInstallGitHook_Idempotent
		it('fresh install — creates 5 hook files with marker + correct content', async () => {
			const count = await installGitHooks(env.dir, { silent: true });
			expect(count).toBe(5);

			const hooksDir = path.join(env.dir, '.git', 'hooks');
			for (const name of MANAGED_GIT_HOOK_NAMES) {
				const content = await fs.readFile(path.join(hooksDir, name), 'utf-8');
				expect(content).toContain(STORY_HOOK_MARKER);
				expect(content).toContain(`story hooks git ${name}`);
				// Story-side red line: no "Entire" branding
				expect(content).not.toContain('Entire CLI hooks');
				expect(content).not.toContain('entire hooks git');
			}
		});

		// Go: hooks_test.go:547 TestInstallGitHook_Idempotent
		it('idempotent — second install returns 0 + byte-level content unchanged', async () => {
			const first = await installGitHooks(env.dir, { silent: true });
			expect(first).toBe(5);

			// Capture hook contents after first install (Go's parity: first
			// snapshot then verify second install doesn't perturb them)
			const hooksDir = path.join(env.dir, '.git', 'hooks');
			const firstContents: Record<string, string> = {};
			for (const name of MANAGED_GIT_HOOK_NAMES) {
				firstContents[name] = await fs.readFile(path.join(hooksDir, name), 'utf-8');
				expect(firstContents[name]).toContain(STORY_HOOK_MARKER);
			}

			const second = await installGitHooks(env.dir, { silent: true });
			expect(second).toBe(0);

			for (const name of MANAGED_GIT_HOOK_NAMES) {
				const content = await fs.readFile(path.join(hooksDir, name), 'utf-8');
				expect(content).toBe(firstContents[name]);
			}
		});

		// Go: hooks_test.go:593 TestInstallGitHook_LocalDevCommandPrefix
		it('localDev — hooks use bun run src/cli.ts prefix', async () => {
			await installGitHooks(env.dir, { silent: true, localDev: true });
			const hooksDir = path.join(env.dir, '.git', 'hooks');
			for (const name of MANAGED_GIT_HOOK_NAMES) {
				const content = await fs.readFile(path.join(hooksDir, name), 'utf-8');
				expect(content).toContain('bun run src/cli.ts');
				expect(content).not.toMatch(/\nstory hooks/);
			}

			// Reinstall with localDev=false updates content.
			const count = await installGitHooks(env.dir, { silent: true });
			expect(count).toBe(5);
			for (const name of MANAGED_GIT_HOOK_NAMES) {
				const content = await fs.readFile(path.join(hooksDir, name), 'utf-8');
				expect(content).not.toContain('bun run src/cli.ts');
				expect(content).toMatch(/\nstory hooks/);
			}
		});

		// Go: hooks_test.go:643 TestInstallGitHook_AbsoluteGitHookPath
		it('absolutePath — hooks use shell-quoted absolute binary path', async () => {
			await installGitHooks(env.dir, { silent: true, absolutePath: true });
			const resolved = await fs.realpath(process.execPath);
			const quoted = shellQuote(resolved);
			const hooksDir = path.join(env.dir, '.git', 'hooks');
			for (const name of MANAGED_GIT_HOOK_NAMES) {
				const content = await fs.readFile(path.join(hooksDir, name), 'utf-8');
				expect(content).toContain(quoted);
				expect(content).not.toMatch(/\nstory hooks/);
			}
		});

		// Go: hooks_test.go:888 TestInstallGitHook_BacksUpCustomHook +
		// hooks_test.go:1199 TestGenerateChainedContent (4-field assertions
		// merged into one fixture — since `generateChainedContent` is
		// internal to install.ts, we assert its output shape via the
		// backup-plus-chain install path)
		it('backup custom hook — renames to .pre-story + generates full chain content', async () => {
			const hooksDir = path.join(env.dir, '.git', 'hooks');
			await fs.mkdir(hooksDir, { recursive: true });
			const customHook = path.join(hooksDir, 'prepare-commit-msg');
			const customContent = "#!/bin/sh\necho 'my custom'\n";
			await fs.writeFile(customHook, customContent, { mode: 0o755 });

			const count = await installGitHooks(env.dir, { silent: true });
			expect(count).toBeGreaterThan(0);

			// Backup exists with original content
			const backup = customHook + BACKUP_SUFFIX;
			const backupContent = await fs.readFile(backup, 'utf-8');
			expect(backupContent).toBe(customContent);

			// Installed hook has marker + chain call (Go parity on 4 fields)
			const installed = await fs.readFile(customHook, 'utf-8');
			expect(installed).toContain(STORY_HOOK_MARKER);
			// field 1: chain comment present
			expect(installed).toContain('# Chain: run pre-existing hook');
			// field 2: resolve hook directory from $0
			expect(installed).toContain('_story_hook_dir="$(dirname "$0")"');
			// field 3: -x executable check on backup path
			expect(installed).toContain(`[ -x "$_story_hook_dir/prepare-commit-msg${BACKUP_SUFFIX}" ]`);
			// field 4: forward all args via "$@" to backup
			expect(installed).toContain(`"$_story_hook_dir/prepare-commit-msg${BACKUP_SUFFIX}" "$@"`);
		});

		// Go: hooks_test.go:968 TestInstallGitHook_DoesNotOverwriteExistingBackup
		it('does not overwrite existing .pre-story backup — warns instead', async () => {
			const hooksDir = path.join(env.dir, '.git', 'hooks');
			await fs.mkdir(hooksDir, { recursive: true });

			const firstBackupContent = "#!/bin/sh\necho 'first'\n";
			const backup = path.join(hooksDir, `prepare-commit-msg${BACKUP_SUFFIX}`);
			await fs.writeFile(backup, firstBackupContent, { mode: 0o755 });

			const secondCustom = "#!/bin/sh\necho 'second'\n";
			const hookPath = path.join(hooksDir, 'prepare-commit-msg');
			await fs.writeFile(hookPath, secondCustom, { mode: 0o755 });

			await installGitHooks(env.dir, { silent: true });

			const backupContent = await fs.readFile(backup, 'utf-8');
			// Backup NOT overwritten by second custom
			expect(backupContent).toBe(firstBackupContent);

			// Installed hook still has marker + chain
			const installed = await fs.readFile(hookPath, 'utf-8');
			expect(installed).toContain(STORY_HOOK_MARKER);
			expect(installed).toContain('# Chain: run pre-existing hook');
		});

		// Go: hooks_test.go:1012 TestInstallGitHook_IdempotentWithChaining
		it('idempotent even when chaining is active', async () => {
			const hooksDir = path.join(env.dir, '.git', 'hooks');
			await fs.mkdir(hooksDir, { recursive: true });
			const hookPath = path.join(hooksDir, 'prepare-commit-msg');
			await fs.writeFile(hookPath, '#!/bin/sh\necho custom\n', { mode: 0o755 });

			const first = await installGitHooks(env.dir, { silent: true });
			expect(first).toBeGreaterThan(0);

			const second = await installGitHooks(env.dir, { silent: true });
			expect(second).toBe(0);
		});

		// Go: hooks_test.go:1039 TestInstallGitHook_NoBackupWhenNoExistingHook
		it('no .pre-story backup created for fresh install', async () => {
			await installGitHooks(env.dir, { silent: true });
			const hooksDir = path.join(env.dir, '.git', 'hooks');
			for (const name of MANAGED_GIT_HOOK_NAMES) {
				const backup = path.join(hooksDir, name + BACKUP_SUFFIX);
				expect(await fileExists(backup)).toBe(false);

				const content = await fs.readFile(path.join(hooksDir, name), 'utf-8');
				expect(content).not.toContain('# Chain: run pre-existing hook');
			}
		});

		// Go: hooks_test.go:1065 TestInstallGitHook_MixedHooks
		it('mixed hooks — only pre-existing ones get backup + chain', async () => {
			const hooksDir = path.join(env.dir, '.git', 'hooks');
			await fs.mkdir(hooksDir, { recursive: true });

			const custom = {
				'prepare-commit-msg': "#!/bin/sh\necho 'custom pcm'\n",
				'pre-push': "#!/bin/sh\necho 'custom prepush'\n",
			};
			for (const [name, content] of Object.entries(custom)) {
				await fs.writeFile(path.join(hooksDir, name), content, { mode: 0o755 });
			}

			await installGitHooks(env.dir, { silent: true });

			for (const name of Object.keys(custom)) {
				const backup = path.join(hooksDir, name + BACKUP_SUFFIX);
				expect(await fileExists(backup)).toBe(true);
				const content = await fs.readFile(path.join(hooksDir, name), 'utf-8');
				expect(content).toContain('# Chain: run pre-existing hook');
			}

			for (const name of ['commit-msg', 'post-commit'] as const) {
				const backup = path.join(hooksDir, name + BACKUP_SUFFIX);
				expect(await fileExists(backup)).toBe(false);
				const content = await fs.readFile(path.join(hooksDir, name), 'utf-8');
				expect(content).not.toContain('# Chain: run pre-existing hook');
			}
		});

		// Go: hooks_test.go:288 TestInstallGitHook_WorktreeInstallsInCommonHooks
		// Full parity: asserts hooks land in common hooks dir (positive) AND
		// the worktree-local `<gitdir>/hooks/<name>` files do NOT carry the
		// Story marker (negative — Go's `strings.HasPrefix` loop).
		it('worktree installs in common hooks dir, not worktree-local', async () => {
			await env.writeFile('README.md', 'test');
			await env.gitAdd('README.md');
			await env.gitCommit('init');

			const wtDir = path.join(os.tmpdir(), `story-wt-inst-${Date.now()}`);
			await env.exec('git', ['worktree', 'add', wtDir, '-b', 'feature']);
			try {
				clearHooksDirCache();
				const count = await installGitHooks(wtDir, { silent: true });
				expect(count).toBeGreaterThan(0);

				// Positive: common `.git/hooks` has marker on all 5 hooks.
				const commonHooksDir = path.join(env.dir, '.git', 'hooks');
				for (const name of MANAGED_GIT_HOOK_NAMES) {
					const content = await fs.readFile(path.join(commonHooksDir, name), 'utf-8');
					expect(content).toContain(STORY_HOOK_MARKER);
				}

				// Negative: worktree-specific git dir's `hooks/` must NOT
				// contain Story-branded content (Go: strategy/hooks_test.go:324-329).
				const { stdout: gitDirOut } = await execa('git', ['rev-parse', '--git-dir'], {
					cwd: wtDir,
				});
				let worktreeGitDir = gitDirOut.trim();
				if (!path.isAbsolute(worktreeGitDir)) {
					worktreeGitDir = path.join(wtDir, worktreeGitDir);
				}
				const worktreeHooksDir = path.join(worktreeGitDir, 'hooks');
				for (const name of MANAGED_GIT_HOOK_NAMES) {
					const wtHookPath = path.join(worktreeHooksDir, name);
					if (await fileExists(wtHookPath)) {
						const content = await fs.readFile(wtHookPath, 'utf-8');
						expect(content).not.toContain(STORY_HOOK_MARKER);
					}
				}

				clearHooksDirCache();
				expect(await isGitHookInstalled(wtDir)).toBe(true);
			} finally {
				await env.exec('git', ['worktree', 'remove', '--force', wtDir]).catch(() => {});
				await fs.rm(wtDir, { recursive: true, force: true }).catch(() => {});
			}
		});

		// Go: hooks_test.go:702 TestInstallGitHook_CoreHooksPathRelative
		it('core.hooksPath set — hooks installed in configured path', async () => {
			await env.exec('git', ['config', 'core.hooksPath', '.husky/_']);
			clearHooksDirCache();

			const count = await installGitHooks(env.dir, { silent: true });
			expect(count).toBeGreaterThan(0);

			const configured = path.join(env.dir, '.husky', '_');
			for (const name of MANAGED_GIT_HOOK_NAMES) {
				const content = await fs.readFile(path.join(configured, name), 'utf-8');
				expect(content).toContain(STORY_HOOK_MARKER);
			}

			// Should NOT write into .git/hooks
			const defaultHooks = path.join(env.dir, '.git', 'hooks');
			for (const name of MANAGED_GIT_HOOK_NAMES) {
				const exists = await fileExists(path.join(defaultHooks, name));
				if (exists) {
					const content = await fs.readFile(path.join(defaultHooks, name), 'utf-8');
					expect(content).not.toContain(STORY_HOOK_MARKER);
				}
			}

			expect(await isGitHookInstalledInDir(configured)).toBe(true);
		});

		// Go: hooks_test.go:1233 TestGenerateChainedContent_PostRewritePreservesStdinForBackup
		it('post-rewrite chained content — uses tmpfile for stdin replay', async () => {
			const hooksDir = path.join(env.dir, '.git', 'hooks');
			await fs.mkdir(hooksDir, { recursive: true });
			// Pre-existing post-rewrite triggers chain generation
			await fs.writeFile(path.join(hooksDir, 'post-rewrite'), "#!/bin/sh\necho 'existing'\n", {
				mode: 0o755,
			});

			await installGitHooks(env.dir, { silent: true });

			const content = await fs.readFile(path.join(hooksDir, 'post-rewrite'), 'utf-8');
			expect(content).toContain('_story_stdin="$(mktemp');
			expect(content).toContain('story-post-rewrite.XXXXXX');
			expect(content).toContain('cat > "$_story_stdin"');
			expect(content).toContain(`story hooks git post-rewrite "$1" < "$_story_stdin"`);
			expect(content).toContain(
				`"$_story_hook_dir/post-rewrite${BACKUP_SUFFIX}" "$@" < "$_story_stdin"`,
			);
			// Story red line
			expect(content).not.toContain('_entire_stdin');
			expect(content).not.toContain('entire-post-rewrite');
		});

		// Go: hooks_test.go:1253 TestInstallGitHook_InstallRemoveReinstall
		it('install-remove-reinstall cycle preserves backup+chain', async () => {
			const hooksDir = path.join(env.dir, '.git', 'hooks');
			await fs.mkdir(hooksDir, { recursive: true });
			const hookPath = path.join(hooksDir, 'prepare-commit-msg');
			const customContent = "#!/bin/sh\necho 'user hook'\n";
			await fs.writeFile(hookPath, customContent, { mode: 0o755 });

			// Install: creates backup + chain
			await installGitHooks(env.dir, { silent: true });
			const backup = hookPath + BACKUP_SUFFIX;
			expect(await fileExists(backup)).toBe(true);

			// Remove: restores backup
			await removeGitHooks(env.dir);
			expect(await fs.readFile(hookPath, 'utf-8')).toBe(customContent);
			expect(await fileExists(backup)).toBe(false);

			// Reinstall: backup + chain again
			const count = await installGitHooks(env.dir, { silent: true });
			expect(count).toBeGreaterThan(0);
			expect(await fileExists(backup)).toBe(true);
			const content = await fs.readFile(hookPath, 'utf-8');
			expect(content).toContain(STORY_HOOK_MARKER);
			expect(content).toContain('# Chain: run pre-existing hook');
		});

		// Go: hooks_test.go:942 TestInstallGitHook_InstallsPostRewrite +
		// hooks_test.go:933 TestManagedGitHookNames_IncludesPostRewrite
		it('post-rewrite is in managed hook list + fresh install has exact command line', async () => {
			// Managed hook list assertion
			expect(MANAGED_GIT_HOOK_NAMES).toContain('post-rewrite');

			// Fresh install → post-rewrite file has Story marker + exact shim
			// command line matching Go hooks_test.go:963 (adjusted for Story
			// branding).
			const count = await installGitHooks(env.dir, { silent: true });
			expect(count).toBe(5);

			const hookPath = path.join(env.dir, '.git', 'hooks', 'post-rewrite');
			const content = await fs.readFile(hookPath, 'utf-8');
			expect(content).toContain(STORY_HOOK_MARKER);
			expect(content).toContain(`story hooks git post-rewrite "$1" 2>/dev/null || true`);
			// Fresh install → no chain wrapping (stdin replay only triggered
			// when a .pre-story backup exists).
			expect(content).not.toContain('_story_stdin');
			expect(content).not.toContain('# Chain: run pre-existing hook');
		});

		// TS-specific: hook files must be executable (Go implied by writeHookFile mode 0o755)
		it('hook files have execute mode (0o755)', async () => {
			await installGitHooks(env.dir, { silent: true });
			const hooksDir = path.join(env.dir, '.git', 'hooks');
			for (const name of MANAGED_GIT_HOOK_NAMES) {
				const st = await fs.stat(path.join(hooksDir, name));
				// Owner execute bit must be set
				expect(st.mode & 0o100).toBe(0o100);
			}
		});
	});

	// Go: strategy/hooks.go:297-340 RemoveGitHook
	// ────────────────────────────────────────────────────────────
	describe('removeGitHooks', () => {
		// Go: hooks_test.go:794 TestRemoveGitHook_RemovesInstalledHooks
		it('removes all installed Story hooks', async () => {
			await installGitHooks(env.dir, { silent: true });
			expect(await isGitHookInstalled(env.dir)).toBe(true);

			const removed = await removeGitHooks(env.dir);
			expect(removed).toBe(5);
			expect(await isGitHookInstalled(env.dir)).toBe(false);

			const hooksDir = path.join(env.dir, '.git', 'hooks');
			for (const name of MANAGED_GIT_HOOK_NAMES) {
				expect(await fileExists(path.join(hooksDir, name))).toBe(false);
			}
		});

		// Go: hooks_test.go:835 TestRemoveGitHook_NoHooksInstalled
		it('no hooks installed — returns 0', async () => {
			const removed = await removeGitHooks(env.dir);
			expect(removed).toBe(0);
		});

		// Go: hooks_test.go:848 TestRemoveGitHook_IgnoresNonEntireHooks
		it('ignores non-Story hooks (no marker → not removed)', async () => {
			const hooksDir = path.join(env.dir, '.git', 'hooks');
			await fs.mkdir(hooksDir, { recursive: true });
			const customHook = path.join(hooksDir, 'pre-commit'); // not managed by Story
			await fs.writeFile(customHook, "#!/bin/sh\necho 'custom'\n", { mode: 0o755 });

			const removed = await removeGitHooks(env.dir);
			expect(removed).toBe(0);
			expect(await fileExists(customHook)).toBe(true);
		});

		// Go: hooks_test.go:1119 TestRemoveGitHook_RestoresBackup
		it('restores .pre-story backup after remove', async () => {
			const hooksDir = path.join(env.dir, '.git', 'hooks');
			await fs.mkdir(hooksDir, { recursive: true });
			const hookPath = path.join(hooksDir, 'prepare-commit-msg');
			const customContent = "#!/bin/sh\necho 'my custom'\n";
			await fs.writeFile(hookPath, customContent, { mode: 0o755 });

			await installGitHooks(env.dir, { silent: true });
			const removed = await removeGitHooks(env.dir);
			expect(removed).toBeGreaterThan(0);

			expect(await fs.readFile(hookPath, 'utf-8')).toBe(customContent);
			expect(await fileExists(hookPath + BACKUP_SUFFIX)).toBe(false);
		});

		// Go: hooks_test.go:1158 TestRemoveGitHook_RestoresBackupWhenHookAlreadyGone
		it('restores backup even when hook is already deleted', async () => {
			const hooksDir = path.join(env.dir, '.git', 'hooks');
			await fs.mkdir(hooksDir, { recursive: true });
			const hookPath = path.join(hooksDir, 'prepare-commit-msg');
			const customContent = "#!/bin/sh\necho 'original'\n";
			await fs.writeFile(hookPath, customContent, { mode: 0o755 });

			await installGitHooks(env.dir, { silent: true });
			await fs.unlink(hookPath); // another tool deleted our hook

			await removeGitHooks(env.dir);

			expect(await fs.readFile(hookPath, 'utf-8')).toBe(customContent);
			expect(await fileExists(hookPath + BACKUP_SUFFIX)).toBe(false);
		});

		// Go: hooks_test.go:1315 TestRemoveGitHook_DoesNotOverwriteReplacedHook
		it('does not restore backup when hook was replaced (third-party)', async () => {
			const hooksDir = path.join(env.dir, '.git', 'hooks');
			await fs.mkdir(hooksDir, { recursive: true });
			const hookPath = path.join(hooksDir, 'prepare-commit-msg');
			const hookA = "#!/bin/sh\necho 'hook A'\n";
			await fs.writeFile(hookPath, hookA, { mode: 0o755 });

			await installGitHooks(env.dir, { silent: true });

			const hookB = "#!/bin/sh\necho 'hook B'\n";
			await fs.writeFile(hookPath, hookB, { mode: 0o755 });

			await removeGitHooks(env.dir);
			expect(await fs.readFile(hookPath, 'utf-8')).toBe(hookB);

			const backup = hookPath + BACKUP_SUFFIX;
			expect(await fileExists(backup)).toBe(true);
		});

		// Go: hooks_test.go:747 TestRemoveGitHook_CoreHooksPathRelative
		it('core.hooksPath — removes from configured path + isGitHookInstalledInDir false after', async () => {
			await env.exec('git', ['config', 'core.hooksPath', '.husky/_']);
			clearHooksDirCache();

			const installCount = await installGitHooks(env.dir, { silent: true });
			expect(installCount).toBe(5);

			const removed = await removeGitHooks(env.dir);
			expect(removed).toBe(5);

			const configured = path.join(env.dir, '.husky', '_');
			for (const name of MANAGED_GIT_HOOK_NAMES) {
				expect(await fileExists(path.join(configured, name))).toBe(false);
			}

			// Go parity: `IsGitHookInstalledInDir` must report false after
			// removal in the configured path (hooks_test.go:789).
			expect(await isGitHookInstalledInDir(configured)).toBe(false);
		});

		// Go: hooks_test.go:873 TestRemoveGitHook_NotAGitRepo
		it('not a git repo — throws error', async () => {
			const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'story-removenotgit-'));
			try {
				await expect(removeGitHooks(tmp)).rejects.toThrow(/not a git repository/);
			} finally {
				await fs.rm(tmp, { recursive: true, force: true });
			}
		});

		// Go: hooks_test.go:1359 TestRemoveGitHook_PermissionDenied
		// Skip on root (chmod bypass) and on Windows (no POSIX perms).
		const canRunPermissionTest =
			typeof process.getuid === 'function' &&
			process.getuid() !== 0 &&
			process.platform !== 'win32';
		(canRunPermissionTest ? it : it.skip)(
			'permission denied on hooks dir — throws + removed=0',
			async () => {
				// Install first (hooks dir at default .git/hooks)
				await installGitHooks(env.dir, { silent: true });

				const hooksDir = path.join(env.dir, '.git', 'hooks');
				// Remove write permissions to trigger unlink EACCES
				await fs.chmod(hooksDir, 0o555);
				try {
					await expect(removeGitHooks(env.dir)).rejects.toThrow(/failed to remove hooks/);
				} finally {
					// Restore for cleanup (afterEach -> env.cleanup)
					await fs.chmod(hooksDir, 0o755);
				}
			},
		);
	});

	// Go: strategy/hooks.go:168-211 buildHookSpecs
	// ────────────────────────────────────────────────────────────
	describe('buildHookSpecs', () => {
		it('returns 5 specs with Story-branded content', () => {
			const specs = buildHookSpecs('story');
			expect(specs).toHaveLength(5);

			const names = specs.map((s) => s.name);
			expect(names).toEqual([
				'prepare-commit-msg',
				'commit-msg',
				'post-commit',
				'post-rewrite',
				'pre-push',
			]);

			for (const spec of specs) {
				expect(spec.content.startsWith('#!/bin/sh\n')).toBe(true);
				expect(spec.content).toContain(`# ${STORY_HOOK_MARKER}`);
				expect(spec.content).toContain(`story hooks git ${spec.name}`);
			}
		});

		it('commit-msg is the only hook that propagates error (|| exit 1)', () => {
			const specs = buildHookSpecs('story');
			const byName = new Map(specs.map((s) => [s.name, s.content]));
			expect(byName.get('commit-msg')).toMatch(/\|\| exit 1\s*$/m);
			expect(byName.get('prepare-commit-msg')).toMatch(/\|\| true\s*$/m);
			expect(byName.get('post-commit')).toMatch(/\|\| true\s*$/m);
			expect(byName.get('post-rewrite')).toMatch(/\|\| true\s*$/m);
			expect(byName.get('pre-push')).toMatch(/\|\| true\s*$/m);
		});

		it('hook comments reference Story-Checkpoint trailer (not Entire-Checkpoint)', () => {
			const specs = buildHookSpecs('story');
			const postCommit = specs.find((s) => s.name === 'post-commit')!;
			expect(postCommit.content).toContain('Story-Checkpoint');
			expect(postCommit.content).not.toContain('Entire-Checkpoint');
		});
	});

	// Go: strategy/hooks.go:401-403 shellQuote
	// ────────────────────────────────────────────────────────────
	describe('shellQuote', () => {
		// Go: hooks_test.go:681 TestShellQuote
		it('simple path — wraps in single quotes', () => {
			expect(shellQuote('/usr/local/bin/story')).toBe("'/usr/local/bin/story'");
		});

		it('path with apostrophe — escapes correctly', () => {
			expect(shellQuote("/Users/John O'Brien/bin/story")).toBe(
				"'/Users/John O'\\''Brien/bin/story'",
			);
		});

		it('path with spaces — preserves literally', () => {
			expect(shellQuote('/path with spaces/story')).toBe("'/path with spaces/story'");
		});
	});

	// Go: strategy/hooks.go:380-396 hookCmdPrefix
	// ────────────────────────────────────────────────────────────
	describe('hookCmdPrefix', () => {
		it('default → "story"', () => {
			expect(hookCmdPrefix(false, false)).toBe('story');
		});

		it('localDev → dev entry', () => {
			expect(hookCmdPrefix(true, false)).toBe('bun run src/cli.ts');
		});

		it('absolutePath → shell-quoted runtime + STORY_BIN when it points at a .mjs file', async () => {
			const fakeCli = path.join(os.tmpdir(), `story-hook-prefix-${process.pid}.mjs`);
			await fs.writeFile(fakeCli, 'export {}\n');
			const prev = process.env.STORY_BIN;
			process.env.STORY_BIN = fakeCli;
			try {
				const result = hookCmdPrefix(false, true);
				expect(result).toContain(' ');
				expect(result).toContain(path.basename(fakeCli));
			} finally {
				if (prev === undefined) {
					delete process.env.STORY_BIN;
				} else {
					process.env.STORY_BIN = prev;
				}
				await fs.unlink(fakeCli).catch(() => {});
			}
		});
	});

	// Go: strategy/hooks.go:407-413 hookSettingsFromConfig
	// ────────────────────────────────────────────────────────────
	describe('hookSettingsFromConfig', () => {
		it('no settings file → defaults to { localDev: false, absoluteHookPath: false }', async () => {
			const result = await hookSettingsFromConfig(env.dir);
			expect(result).toEqual({ localDev: false, absoluteHookPath: false });
		});

		it('settings with local_dev + absolute_git_hook_path → read through', async () => {
			const storyDir = path.join(env.dir, '.story');
			await fs.mkdir(storyDir, { recursive: true });
			await fs.writeFile(
				path.join(storyDir, 'settings.json'),
				JSON.stringify({ enabled: true, local_dev: true, absolute_git_hook_path: true }),
				'utf-8',
			);
			const result = await hookSettingsFromConfig(env.dir);
			expect(result).toEqual({ localDev: true, absoluteHookPath: true });
		});

		it('malformed settings → defaults (fail-safe)', async () => {
			const storyDir = path.join(env.dir, '.story');
			await fs.mkdir(storyDir, { recursive: true });
			await fs.writeFile(path.join(storyDir, 'settings.json'), '{ not valid json', 'utf-8');
			const result = await hookSettingsFromConfig(env.dir);
			expect(result).toEqual({ localDev: false, absoluteHookPath: false });
		});
	});

	// Go: strategy/hooks.go:133-150 IsGitHookInstalled*
	// ────────────────────────────────────────────────────────────
	describe('isGitHookInstalled / isGitHookInstalledInDir', () => {
		it('all 5 hooks present + marker → true', async () => {
			await installGitHooks(env.dir, { silent: true });
			expect(await isGitHookInstalled(env.dir)).toBe(true);
		});

		it('no hooks → false', async () => {
			expect(await isGitHookInstalled(env.dir)).toBe(false);
		});

		it('missing one hook → false', async () => {
			await installGitHooks(env.dir, { silent: true });
			const hooksDir = path.join(env.dir, '.git', 'hooks');
			await fs.unlink(path.join(hooksDir, 'pre-push'));
			expect(await isGitHookInstalled(env.dir)).toBe(false);
		});

		it('hook exists but no marker → false', async () => {
			const hooksDir = path.join(env.dir, '.git', 'hooks');
			await fs.mkdir(hooksDir, { recursive: true });
			for (const name of MANAGED_GIT_HOOK_NAMES) {
				await fs.writeFile(path.join(hooksDir, name), '#!/bin/sh\necho custom\n', {
					mode: 0o755,
				});
			}
			expect(await isGitHookInstalled(env.dir)).toBe(false);
		});
	});
});
