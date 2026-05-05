/**
 * Tests for `src/agent/cursor/hooks.ts` — Mirrors Go
 * `entire-cli/cmd/entire/cli/agent/cursor/hooks.go` + `hooks_test.go`.
 *
 * Covers:
 * - InstallHooks: fresh / idempotent / forceReinstall / preservesExistingHooks /
 *   localDev / preservesUnknownFields / parseFailure (7 case)
 * - AreHooksInstalled: notInstalled / afterInstall (2 case)
 * - UninstallHooks: success / noHooksFile / preservesUnknownFields (3 case)
 * - Story-rebrand command-prefix assertion (1 case)
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CursorAgent } from '@/agent/cursor';
import { areHooksInstalled, installHooks, uninstallHooks } from '@/agent/cursor/hooks';
import { CURSOR_HOOKS_FILE_NAME, type CursorHooksFile } from '@/agent/cursor/types';
import { wrapProductionSilentHookCommand } from '@/agent/hook-command';

async function readHooks(repoRoot: string): Promise<CursorHooksFile> {
	const data = await fs.readFile(path.join(repoRoot, '.cursor', CURSOR_HOOKS_FILE_NAME), 'utf-8');
	return JSON.parse(data) as CursorHooksFile;
}

function entryWithCommand(entries: Array<{ command: string }> | undefined, cmd: string): boolean {
	return Array.isArray(entries) && entries.some((e) => e.command === cmd);
}

describe('agent/cursor/hooks — Go: cursor/hooks.go + hooks_test.go', () => {
	let tmpDir: string;
	let originalCwd: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cursor-hooks-'));
		// Init minimal git repo so worktreeRoot finds something.
		await fs.mkdir(path.join(tmpDir, '.git'), { recursive: true });
		await fs.writeFile(path.join(tmpDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
		originalCwd = process.cwd();
		process.chdir(tmpDir);
	});
	afterEach(async () => {
		process.chdir(originalCwd);
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	// Go: hooks_test.go:13-64 TestInstallHooks_FreshInstall
	it('fresh install → count=7, hooks.json contains 7 entries + version=1', async () => {
		const count = await installHooks({ localDev: false, force: false });
		expect(count).toBe(7);
		const file = await readHooks(tmpDir);
		expect(file.version).toBe(1);
		expect(file.hooks?.sessionStart?.length).toBe(1);
		expect(file.hooks?.sessionEnd?.length).toBe(1);
		expect(file.hooks?.beforeSubmitPrompt?.length).toBe(1);
		expect(file.hooks?.stop?.length).toBe(1);
		expect(file.hooks?.preCompact?.length).toBe(1);
		expect(file.hooks?.subagentStart?.length).toBe(1);
		expect(file.hooks?.subagentStop?.length).toBe(1);
	});

	// Go: hooks_test.go:13-64 — production command literals (Story rebrand)
	it('Story rebrand: production commands use "story hooks cursor <verb>"', async () => {
		await installHooks({ localDev: false, force: false });
		const file = await readHooks(tmpDir);
		expect(
			entryWithCommand(
				file.hooks?.stop,
				wrapProductionSilentHookCommand('story hooks cursor stop'),
			),
		).toBe(true);
		expect(
			entryWithCommand(
				file.hooks?.preCompact,
				wrapProductionSilentHookCommand('story hooks cursor pre-compact'),
			),
		).toBe(true);
	});

	// Go: hooks_test.go:66-95 TestInstallHooks_Idempotent
	it('idempotent → second install returns 0 + no duplicates', async () => {
		const first = await installHooks({ localDev: false, force: false });
		expect(first).toBe(7);
		const second = await installHooks({ localDev: false, force: false });
		expect(second).toBe(0);
		const file = await readHooks(tmpDir);
		expect(file.hooks?.stop?.length).toBe(1);
	});

	// Go: hooks_test.go:162-188 TestInstallHooks_ForceReinstall
	it('force reinstall → count=7, no duplicates', async () => {
		await installHooks({ localDev: false, force: false });
		const count = await installHooks({ localDev: false, force: true });
		expect(count).toBe(7);
		const file = await readHooks(tmpDir);
		expect(file.hooks?.stop?.length).toBe(1);
	});

	// Go: hooks_test.go:190-228 TestInstallHooks_PreservesExistingHooks
	it('preserves user "echo user hook" + matcher field on subagentStop', async () => {
		// Pre-populate hooks.json with user content.
		const cursorDir = path.join(tmpDir, '.cursor');
		await fs.mkdir(cursorDir, { recursive: true });
		await fs.writeFile(
			path.join(cursorDir, CURSOR_HOOKS_FILE_NAME),
			`${JSON.stringify(
				{
					version: 1,
					hooks: {
						stop: [{ command: 'echo user hook' }],
						subagentStop: [{ command: 'echo file written', matcher: 'Write' }],
					},
				},
				null,
				2,
			)}\n`,
		);
		await installHooks({ localDev: false, force: false });
		const file = await readHooks(tmpDir);
		expect(file.hooks?.stop?.length).toBe(2);
		expect(entryWithCommand(file.hooks?.stop, 'echo user hook')).toBe(true);
		expect(
			entryWithCommand(
				file.hooks?.stop,
				wrapProductionSilentHookCommand('story hooks cursor stop'),
			),
		).toBe(true);
		const subagentStopWrite = (file.hooks?.subagentStop ?? []).find((e) => e.matcher === 'Write');
		expect(subagentStopWrite?.command).toBe('echo file written');
	});

	// Go: hooks_test.go:230-242 TestInstallHooks_LocalDev (Story rebrand)
	it('localDev=true → command uses "bun run ... src/cli.ts hooks cursor <verb>"', async () => {
		await installHooks({ localDev: true, force: false });
		const file = await readHooks(tmpDir);
		expect(
			entryWithCommand(
				file.hooks?.stop,
				'bun run "$(git rev-parse --show-toplevel)"/src/cli.ts hooks cursor stop',
			),
		).toBe(true);
	});

	// Go: hooks_test.go:244-314 TestInstallHooks_PreservesUnknownFields
	it('preserves unknown top-level (cursorSettings) + unknown hook types (onNotification, customHook)', async () => {
		const cursorDir = path.join(tmpDir, '.cursor');
		await fs.mkdir(cursorDir, { recursive: true });
		await fs.writeFile(
			path.join(cursorDir, CURSOR_HOOKS_FILE_NAME),
			`{
  "version": 1,
  "cursorSettings": {"theme": "dark"},
  "hooks": {
    "stop": [{"command": "echo user stop"}],
    "onNotification": [{"command": "echo notify", "filter": "error"}],
    "customHook": [{"command": "echo custom"}]
  }
}
`,
		);
		const count = await installHooks({ localDev: false, force: false });
		expect(count).toBe(7);
		const raw = await fs.readFile(path.join(cursorDir, CURSOR_HOOKS_FILE_NAME), 'utf-8');
		const obj = JSON.parse(raw) as Record<string, unknown>;
		expect((obj as { cursorSettings?: unknown }).cursorSettings).toBeDefined();
		const hooks = obj.hooks as Record<string, unknown>;
		expect(hooks.onNotification).toBeDefined();
		expect(hooks.customHook).toBeDefined();
		// User stop hook preserved alongside ours.
		const stopArr = hooks.stop as Array<{ command: string }>;
		expect(stopArr.length).toBe(2);
		expect(stopArr.some((e) => e.command === 'echo user stop')).toBe(true);
	});

	// Story addition: malformed JSON → throw
	it('install fails on malformed existing hooks.json', async () => {
		const cursorDir = path.join(tmpDir, '.cursor');
		await fs.mkdir(cursorDir, { recursive: true });
		await fs.writeFile(path.join(cursorDir, CURSOR_HOOKS_FILE_NAME), '{not valid json');
		await expect(installHooks({ localDev: false, force: false })).rejects.toThrow(
			/failed to parse existing hooks\.json/,
		);
	});

	// Go: hooks_test.go:97-105 TestAreHooksInstalled_NotInstalled
	it('areHooksInstalled NotInstalled → false', async () => {
		expect(await areHooksInstalled()).toBe(false);
	});

	// Go: hooks_test.go:107-121 TestAreHooksInstalled_AfterInstall
	it('areHooksInstalled AfterInstall → true', async () => {
		await installHooks({ localDev: false, force: false });
		expect(await areHooksInstalled()).toBe(true);
	});

	// Go: hooks_test.go:123-147 TestUninstallHooks
	it('uninstallHooks success → AreHooksInstalled returns false', async () => {
		await installHooks({ localDev: false, force: false });
		expect(await areHooksInstalled()).toBe(true);
		await uninstallHooks();
		expect(await areHooksInstalled()).toBe(false);
	});

	// Go: hooks_test.go:149-160 TestUninstallHooks_NoHooksFile
	it('uninstallHooks no hooks file → no error', async () => {
		await expect(uninstallHooks()).resolves.toBeUndefined();
	});

	// Go: hooks_test.go:316-390 TestUninstallHooks_PreservesUnknownFields
	it('uninstall preserves cursorSettings + onNotification + drops empty hooks key', async () => {
		await installHooks({ localDev: false, force: false });
		const cursorDir = path.join(tmpDir, '.cursor');
		const hooksPath = path.join(cursorDir, CURSOR_HOOKS_FILE_NAME);
		const raw = await fs.readFile(hooksPath, 'utf-8');
		const obj = JSON.parse(raw) as Record<string, unknown>;
		obj.cursorSettings = { theme: 'dark' };
		const hooks = obj.hooks as Record<string, unknown>;
		hooks.onNotification = [{ command: 'echo notify' }];
		await fs.writeFile(hooksPath, `${JSON.stringify(obj, null, 2)}\n`);

		await uninstallHooks();

		const after = JSON.parse(await fs.readFile(hooksPath, 'utf-8')) as Record<string, unknown>;
		expect(after.cursorSettings).toEqual({ theme: 'dark' });
		const afterHooks = after.hooks as Record<string, unknown>;
		expect(afterHooks.onNotification).toBeDefined();
		// Story hooks removed.
		expect(await areHooksInstalled()).toBe(false);
	});

	// Validate that CursorAgent's HookSupport methods work end-to-end via the class.
	it('CursorAgent HookSupport class methods round-trip correctly', async () => {
		const a = new CursorAgent();
		expect(a.hookNames().length).toBe(7);
		expect(await a.areHooksInstalled()).toBe(false);
		const count = await a.installHooks({ localDev: false, force: false });
		expect(count).toBe(7);
		expect(await a.areHooksInstalled()).toBe(true);
		await a.uninstallHooks();
		expect(await a.areHooksInstalled()).toBe(false);
	});
});
