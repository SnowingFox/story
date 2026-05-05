/**
 * Tests for `src/agent/claude-code/hooks.ts` — Mirrors Go
 * `entire-cli/cmd/entire/cli/agent/claudecode/hooks_test.go` (14 test
 * functions) + 1 Story rebrand assertion (15 total).
 *
 * Strategy: use TestEnv so `worktreeRoot()` resolves to the test repo dir;
 * settings.json round-trip happens against `<env.dir>/.claude/settings.json`.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	addHookToMatcher,
	areHooksInstalled,
	hasStoryHook,
	hookCommandExists,
	hookCommandExistsWithMatcher,
	installHooks,
	isStoryHook,
	removeStoryHooks,
	uninstallHooks,
} from '@/agent/claude-code/hooks';
import { clearWorktreeRootCache } from '@/paths';
import { TestEnv } from '../../../helpers/test-env';

async function readSettings(env: TestEnv): Promise<Record<string, unknown>> {
	const raw = await fs.readFile(path.join(env.dir, '.claude', 'settings.json'), 'utf-8');
	return JSON.parse(raw) as Record<string, unknown>;
}

async function writeSettings(env: TestEnv, value: unknown): Promise<void> {
	const dir = path.join(env.dir, '.claude');
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(path.join(dir, 'settings.json'), JSON.stringify(value, null, 2));
}

/**
 * Run `fn` with `process.cwd()` set to `env.dir`. Resets the worktreeRoot
 * cache before AND after to avoid leakage across tests.
 */
async function inRepo<T>(env: TestEnv, fn: () => Promise<T>): Promise<T> {
	const orig = process.cwd();
	clearWorktreeRootCache();
	try {
		process.chdir(env.dir);
		return await fn();
	} finally {
		process.chdir(orig);
		clearWorktreeRootCache();
	}
}

describe('agent/claude-code/hooks — Go: hooks_test.go', () => {
	let env: TestEnv;
	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
	});
	afterEach(async () => {
		await env.cleanup();
	});

	// Go: hooks_test.go — TestInstallHooks_PermissionsDeny_FreshInstall
	describe('installHooks — fresh install (Go: TestInstallHooks_PermissionsDeny_FreshInstall)', () => {
		it('writes 7 hooks + Story deny rule + creates .claude/ dir', async () => {
			const count = await inRepo(env, () => installHooks({ localDev: false, force: false }));
			expect(count).toBe(7);
			const settings = await readSettings(env);
			const hooks = settings.hooks as Record<string, unknown>;
			// 4 unmatched hook types (matcher: '')
			expect((hooks.SessionStart as unknown[]).length).toBe(1);
			expect((hooks.SessionEnd as unknown[]).length).toBe(1);
			expect((hooks.Stop as unknown[]).length).toBe(1);
			expect((hooks.UserPromptSubmit as unknown[]).length).toBe(1);
			// 2 PreToolUse + 2 PostToolUse, but each has 1 matcher group (Task / TodoWrite)
			expect((hooks.PreToolUse as unknown[]).length).toBe(1);
			expect((hooks.PostToolUse as unknown[]).length).toBe(2);

			// Permissions.deny contains exactly the Story rule.
			const perms = settings.permissions as Record<string, unknown>;
			expect(perms.deny).toEqual(['Read(./.story/metadata/**)']);
		});
	});

	// Go: hooks_test.go — TestInstallHooks_PermissionsDeny_Idempotent
	describe('installHooks — idempotent (Go: TestInstallHooks_PermissionsDeny_Idempotent)', () => {
		it('second call adds 0 + no duplicate deny', async () => {
			await inRepo(env, () => installHooks({ localDev: false, force: false }));
			const count = await inRepo(env, () => installHooks({ localDev: false, force: false }));
			expect(count).toBe(0);
			const settings = await readSettings(env);
			const perms = settings.permissions as Record<string, unknown>;
			expect(perms.deny).toEqual(['Read(./.story/metadata/**)']);
		});
	});

	// Go: hooks_test.go — TestInstallHooks_PermissionsDeny_PreservesUserRules
	describe('installHooks preserves user deny rules', () => {
		it('keeps `Bash(rm -rf *)` plus appends Story rule', async () => {
			await writeSettings(env, { permissions: { deny: ['Bash(rm -rf *)'] } });
			await inRepo(env, () => installHooks({ localDev: false, force: false }));
			const settings = await readSettings(env);
			const perms = settings.permissions as Record<string, unknown>;
			expect(perms.deny).toEqual(['Bash(rm -rf *)', 'Read(./.story/metadata/**)']);
		});
	});

	// Go: hooks_test.go — TestInstallHooks_PermissionsDeny_PreservesAllowRules
	describe('installHooks does not touch permissions.allow', () => {
		it('preserves a 2-entry allow array unchanged', async () => {
			await writeSettings(env, {
				permissions: { allow: ['Bash(ls)', 'Bash(pwd)'] },
			});
			await inRepo(env, () => installHooks({ localDev: false, force: false }));
			const settings = await readSettings(env);
			const perms = settings.permissions as Record<string, unknown>;
			expect(perms.allow).toEqual(['Bash(ls)', 'Bash(pwd)']);
			expect(perms.deny).toEqual(['Read(./.story/metadata/**)']);
		});
	});

	// Go: hooks_test.go — TestInstallHooks_PermissionsDeny_SkipsExistingRule
	describe('installHooks does not duplicate Story deny rule when present', () => {
		it('exactly 1 Story rule in permissions.deny', async () => {
			await writeSettings(env, {
				permissions: { deny: ['Read(./.story/metadata/**)'] },
			});
			await inRepo(env, () => installHooks({ localDev: false, force: false }));
			const settings = await readSettings(env);
			const perms = settings.permissions as Record<string, unknown>;
			expect(perms.deny).toEqual(['Read(./.story/metadata/**)']);
		});
	});

	// Go: hooks_test.go — TestInstallHooks_PermissionsDeny_PreservesUnknownFields
	describe('installHooks preserves unknown permission keys', () => {
		// Go fixture (hooks_test.go:160) uses a nested object for `customField` to
		// verify arbitrary-JSON pass-through (not just a flat string). A regression
		// that stringifies / re-parses without preserving nested shape would only
		// be caught by this fixture.
		it('keeps ask + customField (nested object) + allow alongside Story deny', async () => {
			await writeSettings(env, {
				permissions: {
					allow: ['Bash(ls)'],
					ask: ['Read(./secrets/**)'],
					customField: { nested: 'value', count: 7, list: ['a', 'b'] },
				},
			});
			await inRepo(env, () => installHooks({ localDev: false, force: false }));
			const settings = await readSettings(env);
			const perms = settings.permissions as Record<string, unknown>;
			expect(perms.allow).toEqual(['Bash(ls)']);
			expect(perms.ask).toEqual(['Read(./secrets/**)']);
			// Deep-equal — nested object round-trips through parse/stringify untouched.
			expect(perms.customField).toEqual({ nested: 'value', count: 7, list: ['a', 'b'] });
			expect(perms.deny).toEqual(['Read(./.story/metadata/**)']);
		});
	});

	// Go: hooks_test.go — TestUninstallHooks
	describe('uninstallHooks — full cycle (Go: TestUninstallHooks)', () => {
		it('install then uninstall clears Story footprint', async () => {
			await inRepo(env, () => installHooks({ localDev: false, force: false }));
			expect(await inRepo(env, () => areHooksInstalled())).toBe(true);
			await inRepo(env, () => uninstallHooks());
			expect(await inRepo(env, () => areHooksInstalled())).toBe(false);
		});
	});

	// Go: hooks_test.go — TestUninstallHooks_NoSettingsFile
	describe('uninstallHooks — no settings file', () => {
		it('silent no-op when settings.json missing', async () => {
			await expect(inRepo(env, () => uninstallHooks())).resolves.toBeUndefined();
			await expect(fs.access(path.join(env.dir, '.claude', 'settings.json'))).rejects.toThrow();
		});
	});

	// Go: hooks_test.go — TestUninstallHooks_PreservesUserHooks
	describe('uninstallHooks preserves user-managed Stop hooks', () => {
		it('user echo hook stays; Story hook command removed', async () => {
			// Pre-install user hook + Story hook in same Stop bucket.
			await writeSettings(env, {
				hooks: {
					Stop: [
						{
							matcher: '',
							hooks: [
								{ type: 'command', command: 'echo "user-managed hook"' },
								{
									type: 'command',
									command:
										"sh -c 'if ! command -v story >/dev/null 2>&1; then exit 0; fi; exec story hooks claude-code stop'",
								},
							],
						},
					],
				},
			});
			await inRepo(env, () => uninstallHooks());
			const settings = await readSettings(env);
			const hooks = settings.hooks as Record<string, unknown>;
			const stopMatchers = hooks.Stop as Array<{ hooks: Array<{ command: string }> }>;
			expect(stopMatchers).toHaveLength(1);
			expect(stopMatchers[0]?.hooks).toHaveLength(1);
			expect(stopMatchers[0]?.hooks[0]?.command).toBe('echo "user-managed hook"');
		});
	});

	// Go: hooks_test.go — TestUninstallHooks_RemovesDenyRule
	describe('uninstallHooks removes Story deny rule', () => {
		it('install (with deny) → uninstall → deny array no longer contains Story rule', async () => {
			await inRepo(env, () => installHooks({ localDev: false, force: false }));
			await inRepo(env, () => uninstallHooks());
			const settings = await readSettings(env);
			// permissions key should be removed entirely (only had Story deny rule).
			expect(settings.permissions).toBeUndefined();
		});
	});

	// Go: hooks_test.go — TestUninstallHooks_PreservesUserDenyRules
	describe('uninstallHooks preserves user deny rules, only removes Story rule', () => {
		it('user rule remains after uninstall', async () => {
			await writeSettings(env, {
				permissions: { deny: ['Bash(rm -rf *)', 'Read(./.story/metadata/**)'] },
				hooks: {
					Stop: [
						{ matcher: '', hooks: [{ type: 'command', command: 'story hooks claude-code stop' }] },
					],
				},
			});
			await inRepo(env, () => uninstallHooks());
			const settings = await readSettings(env);
			const perms = settings.permissions as Record<string, unknown>;
			expect(perms.deny).toEqual(['Bash(rm -rf *)']);
		});
	});

	// Go: hooks_test.go — TestInstallHooks_PreservesUserHooksOnSameType
	describe('installHooks coexists with user hooks on Stop / SessionStart / PostToolUse', () => {
		it('user hook stays; Story hooks added (PostToolUse gets Task + TodoWrite matchers)', async () => {
			await writeSettings(env, {
				hooks: {
					Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'echo user-stop' }] }],
					SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: 'echo user-start' }] }],
					PostToolUse: [
						{
							matcher: 'Write',
							hooks: [{ type: 'command', command: 'echo user-postwrite' }],
						},
					],
				},
			});
			await inRepo(env, () => installHooks({ localDev: false, force: false }));
			const settings = await readSettings(env);
			const hooks = settings.hooks as Record<string, unknown>;
			// Stop should contain BOTH the user hook and the Story hook in the same matcher group.
			const stopMatchers = hooks.Stop as Array<{
				matcher: string;
				hooks: Array<{ command: string }>;
			}>;
			expect(stopMatchers[0]?.hooks.length).toBe(2);
			expect(stopMatchers[0]?.hooks[0]?.command).toBe('echo user-stop');
			// SessionStart same.
			const startMatchers = hooks.SessionStart as Array<{
				matcher: string;
				hooks: Array<{ command: string }>;
			}>;
			expect(startMatchers[0]?.hooks.length).toBe(2);
			// PostToolUse has Write (user) + Task + TodoWrite (Story) — 3 matcher groups total.
			const postMatchers = hooks.PostToolUse as Array<{ matcher: string }>;
			const matcherNames = postMatchers.map((m) => m.matcher).sort();
			expect(matcherNames).toEqual(['Task', 'TodoWrite', 'Write']);
		});
	});

	// Go: hooks_test.go — TestInstallHooks_PreservesUnknownHookTypes
	describe('installHooks preserves unknown hook types (Notification, SubagentStop)', () => {
		it('Notification + SubagentStop blocks survive install with full content + matcher', async () => {
			await writeSettings(env, {
				hooks: {
					Notification: [{ matcher: '', hooks: [{ type: 'command', command: 'echo notify' }] }],
					SubagentStop: [
						{ matcher: '.*', hooks: [{ type: 'command', command: 'echo subagent-stop' }] },
					],
				},
			});
			await inRepo(env, () => installHooks({ localDev: false, force: false }));
			const settings = await readSettings(env);
			const hooks = settings.hooks as Record<string, unknown>;
			// Deep assertions match Go hooks_test.go:564-595 (matcher + command preserved verbatim).
			const notif = hooks.Notification as Array<{
				matcher: string;
				hooks: Array<{ type: string; command: string }>;
			}>;
			expect(notif).toHaveLength(1);
			expect(notif[0]?.matcher).toBe('');
			expect(notif[0]?.hooks).toHaveLength(1);
			expect(notif[0]?.hooks[0]?.type).toBe('command');
			expect(notif[0]?.hooks[0]?.command).toBe('echo notify');

			const sub = hooks.SubagentStop as Array<{
				matcher: string;
				hooks: Array<{ type: string; command: string }>;
			}>;
			expect(sub).toHaveLength(1);
			expect(sub[0]?.matcher).toBe('.*');
			expect(sub[0]?.hooks[0]?.command).toBe('echo subagent-stop');

			expect(hooks.Stop).toBeDefined();
		});
	});

	// Go: hooks_test.go — TestUninstallHooks_PreservesUnknownHookTypes
	describe('uninstallHooks preserves unknown hook types', () => {
		it('Notification + SubagentStop survive uninstall with full content + matcher', async () => {
			await writeSettings(env, {
				hooks: {
					Notification: [{ matcher: '', hooks: [{ type: 'command', command: 'echo notify' }] }],
					SubagentStop: [
						{ matcher: '.*', hooks: [{ type: 'command', command: 'echo subagent-stop' }] },
					],
					Stop: [
						{
							matcher: '',
							hooks: [{ type: 'command', command: 'story hooks claude-code stop' }],
						},
					],
				},
			});
			await inRepo(env, () => uninstallHooks());
			const settings = await readSettings(env);
			const hooks = settings.hooks as Record<string, unknown>;
			// Deep assertions match Go hooks_test.go (uninstall preservation of unknown types).
			const notif = hooks.Notification as Array<{
				matcher: string;
				hooks: Array<{ type: string; command: string }>;
			}>;
			expect(notif).toHaveLength(1);
			expect(notif[0]?.matcher).toBe('');
			expect(notif[0]?.hooks[0]?.command).toBe('echo notify');

			const sub = hooks.SubagentStop as Array<{
				matcher: string;
				hooks: Array<{ type: string; command: string }>;
			}>;
			expect(sub).toHaveLength(1);
			expect(sub[0]?.matcher).toBe('.*');
			expect(sub[0]?.hooks[0]?.command).toBe('echo subagent-stop');

			expect(hooks.Stop).toBeUndefined(); // Stripped (only Story hook)
		});
	});

	// Story 补充 — Story-rebranded literals end-to-end (deny + hook command + localDev).
	describe('Story-side rebrand assertions', () => {
		it('install writes Story-rebranded literals (.story/ + story prefix + production wrapper)', async () => {
			await inRepo(env, () => installHooks({ localDev: false, force: false }));
			const raw = await fs.readFile(path.join(env.dir, '.claude', 'settings.json'), 'utf-8');
			expect(raw).toContain('Read(./.story/metadata/**)');
			expect(raw).not.toContain('.entire/metadata');
			// Production wrapper contains both `command -v story` and `exec story hooks claude-code`.
			expect(raw).toContain('command -v story');
			expect(raw).toContain('exec story hooks claude-code');
			// Negative: no Go-style literals.
			expect(raw).not.toContain('command -v entire');
			expect(raw).not.toContain('exec entire ');
		});

		it('localDev=true writes bun run + src/cli.ts (NOT go run + cmd/entire)', async () => {
			await inRepo(env, () => installHooks({ localDev: true, force: false }));
			const raw = await fs.readFile(path.join(env.dir, '.claude', 'settings.json'), 'utf-8');
			// biome-ignore lint/suspicious/noTemplateCurlyInString: literal Claude shell variable token, not a JS template
			expect(raw).toContain('bun run ${CLAUDE_PROJECT_DIR}/src/cli.ts hooks claude-code');
			// biome-ignore lint/suspicious/noTemplateCurlyInString: literal Go-style placeholder we explicitly assert is absent
			expect(raw).not.toContain('go run ${CLAUDE_PROJECT_DIR}/cmd/entire/main.go');
		});
	});

	// Internal helpers — separately exercised since they're exported.
	describe('internal helpers', () => {
		it('hookCommandExists / hookCommandExistsWithMatcher / hasStoryHook / isStoryHook', () => {
			const matchers = [
				{
					matcher: '',
					hooks: [
						{ type: 'command' as const, command: 'echo a' },
						{ type: 'command' as const, command: 'story hooks claude-code stop' },
					],
				},
				{
					matcher: 'TodoWrite',
					hooks: [{ type: 'command' as const, command: 'story hooks claude-code post-todo' }],
				},
			];
			expect(hookCommandExists(matchers, 'echo a')).toBe(true);
			expect(hookCommandExists(matchers, 'echo missing')).toBe(false);
			expect(
				hookCommandExistsWithMatcher(matchers, 'TodoWrite', 'story hooks claude-code post-todo'),
			).toBe(true);
			expect(
				hookCommandExistsWithMatcher(matchers, 'Task', 'story hooks claude-code post-todo'),
			).toBe(false);
			expect(hasStoryHook(matchers)).toBe(true);
			expect(
				hasStoryHook([{ matcher: '', hooks: [{ type: 'command', command: 'echo plain' }] }]),
			).toBe(false);
			expect(isStoryHook('story hooks claude-code stop')).toBe(true);
			expect(isStoryHook('echo not-a-story-hook')).toBe(false);
		});

		it('addHookToMatcher prefers existing empty matcher / appends new', () => {
			let matchers: Array<{ matcher: string; hooks: Array<{ type: 'command'; command: string }> }> =
				[];
			matchers = addHookToMatcher(matchers, '', 'cmd-a');
			expect(matchers).toHaveLength(1);
			expect(matchers[0]?.matcher).toBe('');
			matchers = addHookToMatcher(matchers, '', 'cmd-b');
			expect(matchers[0]?.hooks).toHaveLength(2);
			matchers = addHookToMatcher(matchers, 'Task', 'cmd-task');
			expect(matchers).toHaveLength(2);
		});

		it('removeStoryHooks drops empty matchers entirely', () => {
			const matchers = [
				{
					matcher: '',
					hooks: [{ type: 'command' as const, command: 'story hooks claude-code stop' }],
				},
				{
					matcher: 'Task',
					hooks: [
						{ type: 'command' as const, command: 'echo keep' },
						{ type: 'command' as const, command: 'story hooks claude-code pre-task' },
					],
				},
			];
			const out = removeStoryHooks(matchers);
			expect(out).toHaveLength(1);
			expect(out[0]?.matcher).toBe('Task');
			expect(out[0]?.hooks).toHaveLength(1);
			expect(out[0]?.hooks[0]?.command).toBe('echo keep');
		});
	});

	// Story 失败路径：bad settings.json shapes propagate.
	describe('failure paths (Story 补充)', () => {
		it('installHooks throws on malformed settings.json', async () => {
			await fs.mkdir(path.join(env.dir, '.claude'), { recursive: true });
			await fs.writeFile(path.join(env.dir, '.claude', 'settings.json'), 'not json');
			await expect(
				inRepo(env, () => installHooks({ localDev: false, force: false })),
			).rejects.toThrow(/failed to parse existing settings.json/);
		});

		it('installHooks throws on non-array permissions.deny', async () => {
			await writeSettings(env, { permissions: { deny: 'not-an-array' } });
			await expect(
				inRepo(env, () => installHooks({ localDev: false, force: false })),
			).rejects.toThrow(/failed to parse permissions.deny/);
		});

		it('uninstallHooks throws on malformed settings.json', async () => {
			await fs.mkdir(path.join(env.dir, '.claude'), { recursive: true });
			await fs.writeFile(path.join(env.dir, '.claude', 'settings.json'), 'garbage');
			await expect(inRepo(env, () => uninstallHooks())).rejects.toThrow(
				/failed to parse settings.json/,
			);
		});

		it('areHooksInstalled returns false on malformed settings.json (no throw)', async () => {
			await fs.mkdir(path.join(env.dir, '.claude'), { recursive: true });
			await fs.writeFile(path.join(env.dir, '.claude', 'settings.json'), 'garbage');
			expect(await inRepo(env, () => areHooksInstalled())).toBe(false);
		});
	});
});
