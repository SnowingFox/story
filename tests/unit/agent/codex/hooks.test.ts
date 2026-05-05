/**
 * Tests for `src/agent/codex/hooks.ts` — Mirrors Go
 * `entire-cli/cmd/entire/cli/agent/codex/hooks.go` + `hooks_test.go`.
 *
 * Covers:
 * - InstallHooks: fresh / idempotent / localDev / force / preserveExistingHooks /
 *   preserveUnknownTypes / preservesUserConfig / parse failure (8 case)
 * - UninstallHooks: full round-trip / no settings file no-op /
 *   preservesUserHookContainingEntireSubstring / parse failure (4 case)
 * - AreHooksInstalled: noFile / withHooks / partialHooks (3 case)
 * - EnsureProjectFeatureEnabled: noOp / appendNew / appendToExisting / noConfig (4 case)
 * - Story-rebrand command-prefix assertion (1 case)
 *
 * Failure-path total: ~7 (parse failure × 2, ENOENT no-op, partial hooks → false, etc.)
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { areHooksInstalled, installHooks, uninstallHooks } from '@/agent/codex/hooks';
import {
	CONFIG_FILE_NAME,
	FEATURE_LINE,
	HOOKS_FILE_NAME,
	type HooksFile,
} from '@/agent/codex/types';
import {
	WARNING_FORMAT_SINGLE_LINE,
	wrapProductionJSONWarningHookCommand,
	wrapProductionSilentHookCommand,
} from '@/agent/hook-command';

async function readHooks(repoRoot: string): Promise<HooksFile> {
	const data = await fs.readFile(path.join(repoRoot, '.codex', HOOKS_FILE_NAME), 'utf-8');
	return JSON.parse(data) as HooksFile;
}

async function readConfig(repoRoot: string): Promise<string> {
	return await fs.readFile(path.join(repoRoot, '.codex', CONFIG_FILE_NAME), 'utf-8');
}

describe('agent/codex/hooks — Go: codex/hooks.go + hooks_test.go', () => {
	let tmpDir: string;
	let originalCwd: string;
	let originalCodexHome: string | undefined;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-hooks-'));
		// Init minimal git repo so worktreeRoot finds something.
		await fs.mkdir(path.join(tmpDir, '.git'), { recursive: true });
		await fs.writeFile(path.join(tmpDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
		originalCwd = process.cwd();
		process.chdir(tmpDir);
		// Set CODEX_HOME so user-config tests use a tmp location (Go t.Setenv equivalent)
		originalCodexHome = process.env.CODEX_HOME;
		process.env.CODEX_HOME = path.join(tmpDir, '.codex-home');
	});
	afterEach(async () => {
		process.chdir(originalCwd);
		if (originalCodexHome === undefined) {
			delete process.env.CODEX_HOME;
		} else {
			process.env.CODEX_HOME = originalCodexHome;
		}
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	// Go: hooks_test.go:25-50 TestInstallHooks_CreatesConfig
	it('fresh install → count=3, hooks.json contains 3 entries + config.toml has codex_hooks=true', async () => {
		const count = await installHooks({ localDev: false, force: false });
		expect(count).toBe(3);
		const file = await readHooks(tmpDir);
		expect(file.hooks.SessionStart?.length).toBe(1);
		expect(file.hooks.UserPromptSubmit?.length).toBe(1);
		expect(file.hooks.Stop?.length).toBe(1);
		const config = await readConfig(tmpDir);
		expect(config).toContain('[features]');
		expect(config).toContain(FEATURE_LINE);
	});

	// Go: hooks_test.go:25-50 — production command literals (Story rebrand assertion)
	it('Story rebrand: production commands use "story hooks codex <verb>" + JSON wrap for session-start', async () => {
		await installHooks({ localDev: false, force: false });
		const file = await readHooks(tmpDir);
		expect(file.hooks.SessionStart?.[0]?.hooks?.[0]?.command).toBe(
			wrapProductionJSONWarningHookCommand(
				'story hooks codex session-start',
				WARNING_FORMAT_SINGLE_LINE,
			),
		);
		expect(file.hooks.UserPromptSubmit?.[0]?.hooks?.[0]?.command).toBe(
			wrapProductionSilentHookCommand('story hooks codex user-prompt-submit'),
		);
		expect(file.hooks.Stop?.[0]?.hooks?.[0]?.command).toBe(
			wrapProductionSilentHookCommand('story hooks codex stop'),
		);
	});

	// Go: hooks_test.go:52-65 TestInstallHooks_Idempotent
	it('idempotent → second install returns 0 + config.toml still ensured', async () => {
		const first = await installHooks({ localDev: false, force: false });
		expect(first).toBe(3);
		const second = await installHooks({ localDev: false, force: false });
		expect(second).toBe(0);
		const file = await readHooks(tmpDir);
		expect(file.hooks.Stop?.[0]?.hooks?.length).toBe(1);
		const config = await readConfig(tmpDir);
		expect(config).toContain(FEATURE_LINE);
	});

	// Go: hooks_test.go:67-80 TestInstallHooks_LocalDev
	it('localDev → bun run command literal (Story rebrand of go run main.go)', async () => {
		const count = await installHooks({ localDev: true, force: false });
		expect(count).toBe(3);
		const data = await fs.readFile(path.join(tmpDir, '.codex', HOOKS_FILE_NAME), 'utf-8');
		expect(data).toContain('bun run');
		// JSON-escaped: literal " becomes \" inside the JSON string
		expect(data).toContain(
			'\\"$(git rev-parse --show-toplevel)\\"/src/cli.ts hooks codex session-start',
		);
	});

	// Go: hooks_test.go:82-94 TestInstallHooks_Force
	it('force → re-installs after stripping existing Story hooks', async () => {
		await installHooks({ localDev: false, force: false });
		const count = await installHooks({ localDev: false, force: true });
		expect(count).toBe(3); // stripped + re-added
		const file = await readHooks(tmpDir);
		expect(file.hooks.SessionStart?.[0]?.hooks?.length).toBe(1); // not duplicated
	});

	// Go: hooks_test.go:96-105 TestUninstallHooks
	it('uninstallHooks → full install then uninstall clears Story footprint', async () => {
		await installHooks({ localDev: false, force: false });
		expect(await areHooksInstalled()).toBe(true);
		await uninstallHooks();
		expect(await areHooksInstalled()).toBe(false);
	});

	// Go: hooks_test.go:107-141 TestUninstallHooks_PreservesUserHookContainingEntireSubstring
	// IMPORTANT: user hook with command containing "entire" as substring (NOT prefix)
	// must NOT be stripped. Story version uses "story" but same defense applies.
	it('uninstallHooks preserves user hook whose command merely contains story-substring', async () => {
		const codexDir = path.join(tmpDir, '.codex');
		await fs.mkdir(codexDir, { recursive: true, mode: 0o750 });
		const existingConfig = JSON.stringify({
			hooks: {
				Stop: [
					{
						matcher: null,
						hooks: [
							// substring "story" but not a prefix-match hook command
							{ type: 'command', command: 'echo "the story workflow finished"' },
						],
					},
				],
			},
		});
		await fs.writeFile(path.join(codexDir, HOOKS_FILE_NAME), existingConfig, { mode: 0o600 });

		await installHooks({ localDev: false, force: false });
		await uninstallHooks();

		const data = await fs.readFile(path.join(codexDir, HOOKS_FILE_NAME), 'utf-8');
		expect(data).toContain('echo \\"the story workflow finished\\"');
		expect(data).not.toContain('story hooks codex stop');
	});

	// Go: hooks_test.go:143-149 TestAreHooksInstalled_NoFile
	it('areHooksInstalled → false when hooks.json missing', async () => {
		expect(await areHooksInstalled()).toBe(false);
	});

	// Go: hooks_test.go:151-159 TestAreHooksInstalled_WithHooks
	it('areHooksInstalled → true after install', async () => {
		await installHooks({ localDev: false, force: false });
		expect(await areHooksInstalled()).toBe(true);
	});

	// Go: hooks_test.go:161-180 TestAreHooksInstalled_PartialHooks
	// Only Stop hook installed (no SessionStart / UserPromptSubmit) → returns false
	// (Codex requires ALL THREE managed buckets to contain Story hook)
	it('areHooksInstalled → false when only partial hooks present', async () => {
		const codexDir = path.join(tmpDir, '.codex');
		await fs.mkdir(codexDir, { recursive: true, mode: 0o750 });
		await fs.writeFile(
			path.join(codexDir, HOOKS_FILE_NAME),
			JSON.stringify({
				hooks: {
					Stop: [
						{
							matcher: null,
							hooks: [{ type: 'command', command: 'story hooks codex stop', timeout: 30 }],
						},
					],
				},
			}),
			{ mode: 0o600 },
		);
		expect(await areHooksInstalled()).toBe(false);
	});

	// Go: hooks_test.go:182-209 TestInstallHooks_PreservesExistingHooksJSON
	it('installHooks preserves user-managed entries in unknown PreToolUse hook bucket', async () => {
		const codexDir = path.join(tmpDir, '.codex');
		await fs.mkdir(codexDir, { recursive: true, mode: 0o750 });
		const existingConfig = JSON.stringify({
			hooks: {
				PreToolUse: [
					{ matcher: '^Bash$', hooks: [{ type: 'command', command: 'my-custom-hook' }] },
				],
			},
		});
		await fs.writeFile(path.join(codexDir, HOOKS_FILE_NAME), existingConfig, { mode: 0o600 });

		await installHooks({ localDev: false, force: false });

		const data = await fs.readFile(path.join(codexDir, HOOKS_FILE_NAME), 'utf-8');
		expect(data).toContain('my-custom-hook');
		expect(data).toContain('story hooks codex stop');
	});

	// Go: hooks_test.go:211-242 TestInstallHooks_ErrorsOnMalformedManagedHook
	it('installHooks throws when SessionStart is not an array (parse failure)', async () => {
		const codexDir = path.join(tmpDir, '.codex');
		await fs.mkdir(codexDir, { recursive: true, mode: 0o750 });
		const malformedConfig = JSON.stringify({
			hooks: {
				SessionStart: { not: 'an array' },
			},
		});
		const hooksPath = path.join(codexDir, HOOKS_FILE_NAME);
		await fs.writeFile(hooksPath, malformedConfig, { mode: 0o600 });

		await expect(installHooks({ localDev: false, force: false })).rejects.toThrow(
			/parse SessionStart hooks/,
		);

		const data = await fs.readFile(hooksPath, 'utf-8');
		expect(JSON.parse(data)).toEqual(JSON.parse(malformedConfig));
	});

	// Go: hooks_test.go:244-269 TestUninstallHooks_ErrorsOnMalformedManagedHook
	it('uninstallHooks throws when Stop is not an array', async () => {
		const codexDir = path.join(tmpDir, '.codex');
		await fs.mkdir(codexDir, { recursive: true, mode: 0o750 });
		await fs.writeFile(
			path.join(codexDir, HOOKS_FILE_NAME),
			JSON.stringify({ hooks: { Stop: { not: 'an array' } } }),
			{ mode: 0o600 },
		);
		await expect(uninstallHooks()).rejects.toThrow(/parse Stop hooks/);
	});

	// Failure path: uninstall when hooks.json missing → no-op (no throw)
	it('uninstallHooks → no-op success when hooks.json missing', async () => {
		await expect(uninstallHooks()).resolves.toBeUndefined();
		// File still doesn't exist
		await expect(fs.access(path.join(tmpDir, '.codex', HOOKS_FILE_NAME))).rejects.toThrow();
	});

	// Go: hooks_test.go:271-289 TestInstallHooks_DoesNotModifyUserConfig
	// User has model = "gpt-5" in CODEX_HOME/config.toml; install must not touch it
	// (Story uses per-repo config under <repoRoot>/.codex/config.toml, not CODEX_HOME)
	it('installHooks does NOT modify user CODEX_HOME/config.toml', async () => {
		const codexHome = process.env.CODEX_HOME!;
		await fs.mkdir(codexHome, { recursive: true, mode: 0o750 });
		const existingConfig = 'model = "gpt-4.1"\n';
		await fs.writeFile(path.join(codexHome, CONFIG_FILE_NAME), existingConfig, { mode: 0o600 });

		await installHooks({ localDev: false, force: false });

		// User's CODEX_HOME config unchanged
		const userConfig = await fs.readFile(path.join(codexHome, CONFIG_FILE_NAME), 'utf-8');
		expect(userConfig).toBe(existingConfig);
		// But repo-local config got the feature line
		const repoConfig = await readConfig(tmpDir);
		expect(repoConfig).toContain(FEATURE_LINE);
	});

	// Story 补充: parseHookType / hooks shape defensive validation
	// Go: hooks.go:248-254 — json.Unmarshal to []MatcherGroup wraps all type
	// errors as `failed to parse <hookType> hooks: <msg>`.  TS validation is
	// stricter (field-level checks) but error prefix must match Go.
	describe('parseHookType defensive validation (Story 補充 — coverage)', () => {
		// Go: hooks.go:45-48 — hooks field non-object triggers unmarshal error
		it('throws when hooks field is not an object (e.g. array)', async () => {
			const codexDir = path.join(tmpDir, '.codex');
			await fs.mkdir(codexDir, { recursive: true, mode: 0o750 });
			await fs.writeFile(
				path.join(codexDir, HOOKS_FILE_NAME),
				JSON.stringify({ hooks: ['weird', 'array'] }),
				{ mode: 0o600 },
			);
			await expect(installHooks({ localDev: false, force: false })).rejects.toThrow(
				/failed to parse hooks in hooks\.json/,
			);
		});

		// Go: hooks.go:248-254 — malformed group element
		it('throws when group is not an object (Go unmarshal equivalent)', async () => {
			const codexDir = path.join(tmpDir, '.codex');
			await fs.mkdir(codexDir, { recursive: true, mode: 0o750 });
			await fs.writeFile(
				path.join(codexDir, HOOKS_FILE_NAME),
				JSON.stringify({ hooks: { Stop: ['not an object'] } }),
				{ mode: 0o600 },
			);
			await expect(installHooks({ localDev: false, force: false })).rejects.toThrow(
				/failed to parse Stop hooks/,
			);
		});

		// Go: hooks.go:248-254 — hooks sub-field type mismatch
		it('throws when group.hooks is not an array (Go unmarshal equivalent)', async () => {
			const codexDir = path.join(tmpDir, '.codex');
			await fs.mkdir(codexDir, { recursive: true, mode: 0o750 });
			await fs.writeFile(
				path.join(codexDir, HOOKS_FILE_NAME),
				JSON.stringify({
					hooks: { Stop: [{ matcher: null, hooks: 'not-an-array' }] },
				}),
				{ mode: 0o600 },
			);
			await expect(installHooks({ localDev: false, force: false })).rejects.toThrow(
				/failed to parse Stop hooks/,
			);
		});

		// Go: hooks.go:248-254 — hook entry type mismatch
		it('throws when hook entry is not an object (Go unmarshal equivalent)', async () => {
			const codexDir = path.join(tmpDir, '.codex');
			await fs.mkdir(codexDir, { recursive: true, mode: 0o750 });
			await fs.writeFile(
				path.join(codexDir, HOOKS_FILE_NAME),
				JSON.stringify({
					hooks: { Stop: [{ matcher: null, hooks: ['not an object'] }] },
				}),
				{ mode: 0o600 },
			);
			await expect(installHooks({ localDev: false, force: false })).rejects.toThrow(
				/failed to parse Stop hooks/,
			);
		});

		// TS-stricter: hook entry type must be "command" (Go stores any string)
		it('throws when hook entry type is not "command"', async () => {
			const codexDir = path.join(tmpDir, '.codex');
			await fs.mkdir(codexDir, { recursive: true, mode: 0o750 });
			await fs.writeFile(
				path.join(codexDir, HOOKS_FILE_NAME),
				JSON.stringify({
					hooks: {
						Stop: [
							{
								matcher: null,
								hooks: [{ type: 'unknown', command: 'foo' }],
							},
						],
					},
				}),
				{ mode: 0o600 },
			);
			await expect(installHooks({ localDev: false, force: false })).rejects.toThrow(
				/failed to parse Stop hooks/,
			);
		});

		// TS-stricter: hook entry command must be string (Go stores any)
		it('throws when hook entry command is not a string', async () => {
			const codexDir = path.join(tmpDir, '.codex');
			await fs.mkdir(codexDir, { recursive: true, mode: 0o750 });
			await fs.writeFile(
				path.join(codexDir, HOOKS_FILE_NAME),
				JSON.stringify({
					hooks: {
						Stop: [
							{
								matcher: null,
								hooks: [{ type: 'command', command: 123 }],
							},
						],
					},
				}),
				{ mode: 0o600 },
			);
			await expect(installHooks({ localDev: false, force: false })).rejects.toThrow(
				/failed to parse Stop hooks/,
			);
		});

		// addHook: matcher === null group exists with prior entries → append into it
		it('addHook appends into existing matcher: null group (covers line 161 branch)', async () => {
			const codexDir = path.join(tmpDir, '.codex');
			await fs.mkdir(codexDir, { recursive: true, mode: 0o750 });
			// Pre-existing user hook in matcher: null group; install must append into same group
			await fs.writeFile(
				path.join(codexDir, HOOKS_FILE_NAME),
				JSON.stringify({
					hooks: {
						SessionStart: [
							{ matcher: null, hooks: [{ type: 'command', command: 'pre-existing-user-hook' }] },
						],
					},
				}),
				{ mode: 0o600 },
			);
			await installHooks({ localDev: false, force: false });
			const file = await readHooks(tmpDir);
			// User hook + Story hook both in the matcher: null group
			expect(file.hooks.SessionStart?.[0]?.matcher).toBeNull();
			const cmds = (file.hooks.SessionStart?.[0]?.hooks ?? []).map((h) => h.command);
			expect(cmds).toContain('pre-existing-user-hook');
			expect(cmds.some((c) => c.includes('story hooks codex session-start'))).toBe(true);
		});

		// uninstallHooks: rawHooks is array (not object) → fast return (covers line 348)
		it('uninstallHooks early-return when topLevel.hooks is an array (not object)', async () => {
			const codexDir = path.join(tmpDir, '.codex');
			await fs.mkdir(codexDir, { recursive: true, mode: 0o750 });
			await fs.writeFile(
				path.join(codexDir, HOOKS_FILE_NAME),
				JSON.stringify({ hooks: ['weird', 'array'] }),
				{ mode: 0o600 },
			);
			// No throw, just returns; file unchanged at the structural level
			await expect(uninstallHooks()).resolves.toBeUndefined();
		});

		// uninstallHooks: topLevel.hooks undefined → fast return
		it('uninstallHooks early-return when topLevel has no hooks key', async () => {
			const codexDir = path.join(tmpDir, '.codex');
			await fs.mkdir(codexDir, { recursive: true, mode: 0o750 });
			await fs.writeFile(
				path.join(codexDir, HOOKS_FILE_NAME),
				JSON.stringify({ otherKey: 'value' }),
				{ mode: 0o600 },
			);
			await expect(uninstallHooks()).resolves.toBeUndefined();
		});

		// Go: hooks.go:45-48 — topLevel.hooks non-object → parse error
		it('installHooks throws when topLevel.hooks is not an object (Go unmarshal equivalent)', async () => {
			const codexDir = path.join(tmpDir, '.codex');
			await fs.mkdir(codexDir, { recursive: true, mode: 0o750 });
			await fs.writeFile(
				path.join(codexDir, HOOKS_FILE_NAME),
				JSON.stringify({ hooks: 'not-an-object' }),
				{ mode: 0o600 },
			);
			await expect(installHooks({ localDev: false, force: false })).rejects.toThrow(
				/failed to parse hooks in hooks\.json/,
			);
		});

		// installHooks: top-level not an object (e.g. array) → parse error throws
		it('installHooks throws when top-level is an array', async () => {
			const codexDir = path.join(tmpDir, '.codex');
			await fs.mkdir(codexDir, { recursive: true, mode: 0o750 });
			await fs.writeFile(path.join(codexDir, HOOKS_FILE_NAME), JSON.stringify(['x', 'y']), {
				mode: 0o600,
			});
			await expect(installHooks({ localDev: false, force: false })).rejects.toThrow(
				/top-level not an object/,
			);
		});
	});

	describe('ensureProjectFeatureEnabled (via installHooks)', () => {
		// Go: hooks_test.go covers via installHooks; we exercise 3 explicit branches.
		it('noOp → existing config.toml with feature line is unchanged', async () => {
			const codexDir = path.join(tmpDir, '.codex');
			await fs.mkdir(codexDir, { recursive: true, mode: 0o750 });
			const existingConfig = '[features]\ncodex_hooks = true\n';
			await fs.writeFile(path.join(codexDir, CONFIG_FILE_NAME), existingConfig, {
				mode: 0o600,
			});
			await installHooks({ localDev: false, force: false });
			const config = await readConfig(tmpDir);
			expect(config).toBe(existingConfig);
		});

		it('appendToExisting → adds codex_hooks under existing [features]', async () => {
			const codexDir = path.join(tmpDir, '.codex');
			await fs.mkdir(codexDir, { recursive: true, mode: 0o750 });
			await fs.writeFile(path.join(codexDir, CONFIG_FILE_NAME), '[features]\nother = true\n', {
				mode: 0o600,
			});
			await installHooks({ localDev: false, force: false });
			const config = await readConfig(tmpDir);
			expect(config).toBe('[features]\ncodex_hooks = true\nother = true\n');
		});

		it('appendNew → creates [features] section when missing', async () => {
			const codexDir = path.join(tmpDir, '.codex');
			await fs.mkdir(codexDir, { recursive: true, mode: 0o750 });
			await fs.writeFile(
				path.join(codexDir, CONFIG_FILE_NAME),
				'# Codex config\nmodel = "gpt-5"\n',
				{ mode: 0o600 },
			);
			await installHooks({ localDev: false, force: false });
			const config = await readConfig(tmpDir);
			expect(config).toContain('# Codex config\nmodel = "gpt-5"\n');
			expect(config).toContain('\n[features]\ncodex_hooks = true\n');
		});

		it('createConfig → creates config.toml when ENOENT', async () => {
			await installHooks({ localDev: false, force: false });
			const config = await readConfig(tmpDir);
			expect(config).toContain('[features]');
			expect(config).toContain(FEATURE_LINE);
		});
	});
});
