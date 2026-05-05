/**
 * Phase 9.1 `src/commands/setup-flow.ts` unit tests.
 *
 * Most orchestration functions ultimately touch the filesystem (ensureSetup +
 * git hook install + settings writes) — these tests mock only the parts that
 * matter for the branch under test (agent registry + asHookSupport + ensure
 * setup + hook install / uninstall). Filesystem + git state uses TestEnv so
 * the 5 git hooks really land inside a throwaway `.git/hooks/` and get
 * cleaned up after the test.
 *
 * Go references are set-up.go functions — see the `// Go:` annotations.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { register, withTestRegistry } from '@/agent/registry';
import type { AgentName, AgentType } from '@/agent/types';
import { resetGlobalFlagsForTesting } from '@/cli/flags';
import { setForceNonInteractive } from '@/cli/tty';
import {
	detectOrSelectAgent,
	runDisable,
	runInteractiveEnable,
	runNonInteractiveConfigureAdd,
	runNonInteractiveEnable,
	runUninstall,
	runUpdateStrategyOptions,
	setupAgentHooks,
	uninstallAgentHooks,
	uninstallDeselectedAgentHooks,
} from '@/commands/setup-flow';
import { SilentError } from '@/errors';
import { resetColorOverrideForTesting, setColorOverride } from '@/ui/theme';
import { TestEnv } from '../../helpers/test-env';
import { mockHookSupport } from '../agent/_helpers';

// Mock ensureSetup so the full flow tests don't spin up git hook
// installation / metadata branch creation — that path is already covered
// by the integration e2e and by `ensureSetup`'s own tests.
//
// Prompt mocks let us drive runInteractive* without a real TTY. Tests
// that want a specific multiselect answer should call `multiselect.mockResolvedValueOnce(...)`
// before the runInteractive call.
const { ensureSetup, multiselectMock, confirmMock } = vi.hoisted(() => ({
	ensureSetup: vi.fn().mockResolvedValue(undefined),
	multiselectMock: vi.fn().mockResolvedValue([]),
	confirmMock: vi.fn().mockResolvedValue(true),
}));
vi.mock('@/strategy/setup', () => ({ ensureSetup }));
vi.mock('@/ui', async () => {
	const actual = await vi.importActual<typeof import('@/ui')>('@/ui');
	return {
		...actual,
		multiselect: multiselectMock,
		confirm: confirmMock,
	};
});

function silenceStdio() {
	const origStdout = process.stdout.write.bind(process.stdout);
	const origStderr = process.stderr.write.bind(process.stderr);
	process.stdout.write = (() => true) as typeof process.stdout.write;
	process.stderr.write = (() => true) as typeof process.stderr.write;
	return () => {
		process.stdout.write = origStdout;
		process.stderr.write = origStderr;
	};
}

describe('commands/setup-flow', () => {
	beforeEach(() => {
		resetGlobalFlagsForTesting();
		resetColorOverrideForTesting();
		setColorOverride(false);
		setForceNonInteractive(true); // default: tests run as non-interactive
	});

	afterEach(() => {
		resetGlobalFlagsForTesting();
		resetColorOverrideForTesting();
		setForceNonInteractive(false);
		vi.restoreAllMocks();
	});

	// Go: setup.go: detectOrSelectAgent — single detected built-in short-circuit
	describe('detectOrSelectAgent (non-interactive paths)', () => {
		it('single detected agent → returns it without prompting', async () => {
			await withTestRegistry(async () => {
				const ag = mockHookSupport({
					name: () => 'claude-code' as AgentName,
					type: () => 'Claude Code' as AgentType,
					detectPresence: async () => true,
				});
				register('claude-code' as AgentName, () => ag);

				const restore = silenceStdio();
				try {
					const result = await detectOrSelectAgent({});
					expect(result.map((a) => a.name())).toEqual(['claude-code']);
				} finally {
					restore();
				}
			});
		});

		it('multiple detected + no hooks installed → SilentError (pass --agent)', async () => {
			await withTestRegistry(async () => {
				register('claude-code' as AgentName, () =>
					mockHookSupport({
						name: () => 'claude-code' as AgentName,
						type: () => 'Claude Code' as AgentType,
						detectPresence: async () => true,
					}),
				);
				register('cursor' as AgentName, () =>
					mockHookSupport({
						name: () => 'cursor' as AgentName,
						type: () => 'Cursor' as AgentType,
						detectPresence: async () => true,
					}),
				);

				await expect(detectOrSelectAgent({})).rejects.toThrow(SilentError);
			});
		});

		it('previously-installed agent → re-run non-TTY keeps that set', async () => {
			await withTestRegistry(async () => {
				const claude = mockHookSupport({
					name: () => 'claude-code' as AgentName,
					type: () => 'Claude Code' as AgentType,
					detectPresence: async () => false,
					areHooksInstalled: async () => true,
				});
				register('claude-code' as AgentName, () => claude);

				const result = await detectOrSelectAgent({});
				expect(result.map((a) => a.name())).toEqual(['claude-code']);
			});
		});

		it('no detected agents + no default → SilentError("no default agent available")', async () => {
			await withTestRegistry(async () => {
				// Empty registry on purpose.
				await expect(detectOrSelectAgent({})).rejects.toThrow(/no default agent available/);
			});
		});
	});

	// Go: setup.go: setupAgentHooks — success + capability gating
	describe('setupAgentHooks', () => {
		it('calls asHookSupport(agent).installHooks and returns the count', async () => {
			await withTestRegistry(async () => {
				const installHooks = vi.fn().mockResolvedValue(3);
				const ag = mockHookSupport({
					name: () => 'claude-code' as AgentName,
					type: () => 'Claude Code' as AgentType,
					installHooks,
				});

				const restore = silenceStdio();
				try {
					const n = await setupAgentHooks(ag, { localDev: false, force: false });
					expect(n).toBe(3);
					expect(installHooks).toHaveBeenCalledWith({ localDev: false, force: false });
				} finally {
					restore();
				}
			});
		});

		it('agent without HookSupport → SilentError', async () => {
			const noHooks = { ...mockHookSupport() };
			// @ts-expect-error — simulate a non-HookSupport agent by stripping the method
			delete noHooks.installHooks;

			await expect(setupAgentHooks(noHooks, { localDev: false, force: false })).rejects.toThrow(
				SilentError,
			);
		});

		it('installHooks throwing propagates (not swallowed)', async () => {
			const ag = mockHookSupport({
				installHooks: async () => {
					throw new Error('hook install failed');
				},
			});
			const restore = silenceStdio();
			try {
				await expect(setupAgentHooks(ag, { localDev: false, force: false })).rejects.toThrow(
					/hook install failed/,
				);
			} finally {
				restore();
			}
		});
	});

	// Go: setup.go: uninstallDeselectedAgentHooks — diff + best-effort
	describe('uninstallDeselectedAgentHooks', () => {
		it('uninstalls each currently-installed agent that is NOT in the selected set', async () => {
			await withTestRegistry(async () => {
				const claudeUninstall = vi.fn().mockResolvedValue(undefined);
				const cursorUninstall = vi.fn().mockResolvedValue(undefined);
				const claude = mockHookSupport({
					name: () => 'claude-code' as AgentName,
					type: () => 'Claude Code' as AgentType,
					areHooksInstalled: async () => true,
					uninstallHooks: claudeUninstall,
				});
				const cursor = mockHookSupport({
					name: () => 'cursor' as AgentName,
					type: () => 'Cursor' as AgentType,
					areHooksInstalled: async () => true,
					uninstallHooks: cursorUninstall,
				});
				register('claude-code' as AgentName, () => claude);
				register('cursor' as AgentName, () => cursor);

				const restore = silenceStdio();
				try {
					// Selected: only cursor. Claude should be uninstalled.
					await uninstallDeselectedAgentHooks([cursor]);
					expect(claudeUninstall).toHaveBeenCalledTimes(1);
					expect(cursorUninstall).not.toHaveBeenCalled();
				} finally {
					restore();
				}
			});
		});

		it('collects individual uninstall failures into an AggregateError', async () => {
			await withTestRegistry(async () => {
				const claude = mockHookSupport({
					name: () => 'claude-code' as AgentName,
					type: () => 'Claude Code' as AgentType,
					areHooksInstalled: async () => true,
					uninstallHooks: async () => {
						throw new Error('boom');
					},
				});
				const cursor = mockHookSupport({
					name: () => 'cursor' as AgentName,
					type: () => 'Cursor' as AgentType,
					areHooksInstalled: async () => true,
					uninstallHooks: async () => undefined,
				});
				register('claude-code' as AgentName, () => claude);
				register('cursor' as AgentName, () => cursor);

				const restore = silenceStdio();
				try {
					// Selecting nobody → both get uninstalled; claude fails.
					await expect(uninstallDeselectedAgentHooks([])).rejects.toThrow(AggregateError);
				} finally {
					restore();
				}
			});
		});
	});

	// Go: setup.go: runDisable — state-toggle path
	describe('runDisable', () => {
		let env: TestEnv;
		beforeEach(async () => {
			env = await TestEnv.create();
		});
		afterEach(async () => {
			await env.cleanup();
		});

		it('flips enabled: true → false in settings.local.json with --yes', async () => {
			resetGlobalFlagsForTesting();
			const { applyGlobalFlags } = await import('@/cli/flags');
			applyGlobalFlags({ yes: true });
			await env.writeFile('.story/settings.json', '{"enabled": true}');

			const restore = silenceStdio();
			try {
				await runDisable({
					repoRoot: env.dir,
					uninstall: false,
					force: true,
					useProjectSettings: false,
				});
			} finally {
				restore();
			}

			const raw = await env.readFile('.story/settings.local.json');
			expect(JSON.parse(raw).enabled).toBe(false);
		});

		it('not a Story repo → SilentError', async () => {
			const restore = silenceStdio();
			try {
				await expect(
					runDisable({
						repoRoot: env.dir,
						uninstall: false,
						force: true,
						useProjectSettings: false,
					}),
				).rejects.toThrow(/Not a Story repository/);
			} finally {
				restore();
			}
		});

		it('already disabled → SilentError', async () => {
			await env.writeFile('.story/settings.json', '{"enabled": false}');
			const restore = silenceStdio();
			try {
				await expect(
					runDisable({
						repoRoot: env.dir,
						uninstall: false,
						force: true,
						useProjectSettings: false,
					}),
				).rejects.toThrow(/already disabled/);
			} finally {
				restore();
			}
		});
	});

	// Go: setup.go: runUninstall — nothing-to-do short-circuit
	describe('runUninstall', () => {
		let env: TestEnv;
		beforeEach(async () => {
			env = await TestEnv.create({ initialCommit: true });
		});
		afterEach(async () => {
			await env.cleanup();
		});

		it('nothing to uninstall + empty repo → prints "not installed" note and exits', async () => {
			await withTestRegistry(async () => {
				const restore = silenceStdio();
				try {
					await expect(
						runUninstall({
							repoRoot: env.dir,
							uninstall: true,
							force: true,
							useProjectSettings: false,
						}),
					).resolves.toBeUndefined();
				} finally {
					restore();
				}
			});
		});

		it('non-TTY without --force → SilentError demanding --force', async () => {
			await withTestRegistry(async () => {
				// Seed a .story/ so nothingToDo is false.
				await env.writeFile('.story/settings.json', '{"enabled": true}');

				const restore = silenceStdio();
				try {
					await expect(
						runUninstall({
							repoRoot: env.dir,
							uninstall: true,
							force: false,
							useProjectSettings: false,
						}),
					).rejects.toThrow(/pass --force/);
				} finally {
					restore();
				}
			});
		});
	});

	// Go: setup.go: runRemoveAgent — matches happy + 3 guards
	describe('uninstallAgentHooks (configure --remove <name>)', () => {
		let env: TestEnv;
		beforeEach(async () => {
			env = await TestEnv.create();
		});
		afterEach(async () => {
			await env.cleanup();
		});

		it('unknown agent → SilentError', async () => {
			await env.writeFile('.story/settings.json', '{"enabled": true}');
			const restore = silenceStdio();
			try {
				await expect(uninstallAgentHooks(env.dir, 'missing')).rejects.toThrow(
					/unknown agent "missing"/,
				);
			} finally {
				restore();
			}
		});

		it('hooks not installed → stepDone message, no uninstallHooks call', async () => {
			await env.writeFile('.story/settings.json', '{"enabled": true}');
			await withTestRegistry(async () => {
				const uninstallSpy = vi.fn();
				const claude = mockHookSupport({
					name: () => 'claude-code' as AgentName,
					type: () => 'Claude Code' as AgentType,
					areHooksInstalled: async () => false,
					uninstallHooks: uninstallSpy,
				});
				register('claude-code' as AgentName, () => claude);

				const restore = silenceStdio();
				try {
					await uninstallAgentHooks(env.dir, 'claude-code');
					expect(uninstallSpy).not.toHaveBeenCalled();
				} finally {
					restore();
				}
			});
		});

		it('hooks installed → uninstallHooks called', async () => {
			await env.writeFile('.story/settings.json', '{"enabled": true}');
			await withTestRegistry(async () => {
				const uninstallSpy = vi.fn();
				const claude = mockHookSupport({
					name: () => 'claude-code' as AgentName,
					type: () => 'Claude Code' as AgentType,
					areHooksInstalled: async () => true,
					uninstallHooks: uninstallSpy,
				});
				register('claude-code' as AgentName, () => claude);

				const restore = silenceStdio();
				try {
					await uninstallAgentHooks(env.dir, 'claude-code');
					expect(uninstallSpy).toHaveBeenCalledTimes(1);
				} finally {
					restore();
				}
			});
		});
	});

	// Full pipeline tests — `ensureSetup` is mocked so the git-hook + metadata
	// branch work doesn't run. Settings I/O + agent install/uninstall runs for real.
	describe('runNonInteractiveEnable', () => {
		let env: TestEnv;
		beforeEach(async () => {
			env = await TestEnv.create({ initialCommit: true });
			ensureSetup.mockClear();
		});
		afterEach(async () => {
			await env.cleanup();
		});

		// Go: setup.go: setupAgentHooksNonInteractive — full pipeline
		it('happy path: installs agent hooks + writes settings + calls ensureSetup', async () => {
			await withTestRegistry(async () => {
				const installHooks = vi.fn().mockResolvedValue(3);
				const ag = mockHookSupport({
					name: () => 'claude-code' as AgentName,
					type: () => 'Claude Code' as AgentType,
					installHooks,
				});
				register('claude-code' as AgentName, () => ag);

				const restore = silenceStdio();
				try {
					await runNonInteractiveEnable({
						repoRoot: env.dir,
						agentName: 'claude-code',
						scope: 'local',
						force: false,
						skipPushSessions: false,
						telemetry: true,
						absoluteGitHookPath: false,
						localDev: false,
					});
				} finally {
					restore();
				}

				expect(installHooks).toHaveBeenCalledTimes(1);
				expect(ensureSetup).toHaveBeenCalledWith(env.dir);
				const raw = await env.readFile('.story/settings.local.json');
				expect(JSON.parse(raw).enabled).toBe(true);
			});
		});

		it('missing agentName → SilentError', async () => {
			const restore = silenceStdio();
			try {
				await expect(
					runNonInteractiveEnable({
						repoRoot: env.dir,
						scope: 'local',
						force: false,
						skipPushSessions: false,
						telemetry: true,
						absoluteGitHookPath: false,
						localDev: false,
					}),
				).rejects.toThrow(SilentError);
			} finally {
				restore();
			}
		});

		it('--skip-push-sessions writes strategy_options.push_sessions=false', async () => {
			await withTestRegistry(async () => {
				const ag = mockHookSupport({
					name: () => 'claude-code' as AgentName,
					type: () => 'Claude Code' as AgentType,
				});
				register('claude-code' as AgentName, () => ag);

				const restore = silenceStdio();
				try {
					await runNonInteractiveEnable({
						repoRoot: env.dir,
						agentName: 'claude-code',
						scope: 'local',
						force: false,
						skipPushSessions: true,
						telemetry: false,
						absoluteGitHookPath: true,
						localDev: true,
					});
				} finally {
					restore();
				}

				const raw = await env.readFile('.story/settings.local.json');
				const parsed = JSON.parse(raw);
				expect(parsed.enabled).toBe(true);
				expect(parsed.local_dev).toBe(true);
				expect(parsed.absolute_git_hook_path).toBe(true);
				expect(parsed.telemetry).toBe(false);
				expect(parsed.strategy_options?.push_sessions).toBe(false);
			});
		});
	});

	describe('runNonInteractiveConfigureAdd', () => {
		let env: TestEnv;
		beforeEach(async () => {
			env = await TestEnv.create({ initialCommit: true });
		});
		afterEach(async () => {
			await env.cleanup();
		});

		it('not enabled → SilentError', async () => {
			const restore = silenceStdio();
			try {
				await expect(
					runNonInteractiveConfigureAdd({
						repoRoot: env.dir,
						agentName: 'claude-code',
						scope: 'local',
						force: false,
						skipPushSessions: false,
						telemetry: true,
						absoluteGitHookPath: false,
						localDev: false,
					}),
				).rejects.toThrow(/not enabled/);
			} finally {
				restore();
			}
		});

		it('missing agentName → SilentError', async () => {
			await env.writeFile('.story/settings.json', '{"enabled": true}');
			const restore = silenceStdio();
			try {
				await expect(
					runNonInteractiveConfigureAdd({
						repoRoot: env.dir,
						scope: 'local',
						force: false,
						skipPushSessions: false,
						telemetry: true,
						absoluteGitHookPath: false,
						localDev: false,
					}),
				).rejects.toThrow(SilentError);
			} finally {
				restore();
			}
		});

		it('runNonInteractiveEnable absolute-git-hook-path flag propagates to settings', async () => {
			await withTestRegistry(async () => {
				const ag = mockHookSupport({
					name: () => 'claude-code' as AgentName,
					type: () => 'Claude Code' as AgentType,
				});
				register('claude-code' as AgentName, () => ag);

				const restore = silenceStdio();
				try {
					await runNonInteractiveEnable({
						repoRoot: env.dir,
						agentName: 'claude-code',
						scope: 'local',
						force: false,
						skipPushSessions: false,
						telemetry: true,
						absoluteGitHookPath: true,
						localDev: false,
					});
				} finally {
					restore();
				}
				const raw = await env.readFile('.story/settings.local.json');
				expect(JSON.parse(raw).absolute_git_hook_path).toBe(true);
			});
		});

		it('happy path: installs agent hooks + updates settings', async () => {
			await env.writeFile('.story/settings.json', '{"enabled": true}');
			await withTestRegistry(async () => {
				const installHooks = vi.fn().mockResolvedValue(1);
				const ag = mockHookSupport({
					name: () => 'cursor' as AgentName,
					type: () => 'Cursor' as AgentType,
					installHooks,
				});
				register('cursor' as AgentName, () => ag);

				const restore = silenceStdio();
				try {
					await runNonInteractiveConfigureAdd({
						repoRoot: env.dir,
						agentName: 'cursor',
						scope: 'project',
						force: false,
						skipPushSessions: false,
						telemetry: true,
						absoluteGitHookPath: false,
						localDev: false,
					});
				} finally {
					restore();
				}

				expect(installHooks).toHaveBeenCalledTimes(1);
			});
		});
	});

	describe('runUpdateStrategyOptions', () => {
		let env: TestEnv;
		beforeEach(async () => {
			env = await TestEnv.create({ initialCommit: true });
		});
		afterEach(async () => {
			await env.cleanup();
		});

		// Go: setup.go: updateStrategyOptions — validates before writing
		it('invalid --checkpoint-remote → SilentError (no settings written)', async () => {
			await env.writeFile('.story/settings.json', '{"enabled": true}');
			const restore = silenceStdio();
			try {
				await expect(
					runUpdateStrategyOptions({
						repoRoot: env.dir,
						scope: 'local',
						force: false,
						skipPushSessions: false,
						checkpointRemote: 'oops-no-colon',
						telemetry: true,
						absoluteGitHookPath: false,
						localDev: false,
					}),
				).rejects.toThrow(SilentError);
			} finally {
				restore();
			}
		});

		it('valid --skip-push-sessions writes through to settings.local.json', async () => {
			await env.writeFile('.story/settings.json', '{"enabled": true}');
			const restore = silenceStdio();
			try {
				await runUpdateStrategyOptions({
					repoRoot: env.dir,
					scope: 'local',
					force: false,
					skipPushSessions: true,
					telemetry: true,
					absoluteGitHookPath: false,
					localDev: false,
				});
			} finally {
				restore();
			}

			const raw = await env.readFile('.story/settings.local.json');
			expect(JSON.parse(raw).strategy_options?.push_sessions).toBe(false);
		});
	});

	describe('runUninstall (full pipeline)', () => {
		let env: TestEnv;
		beforeEach(async () => {
			env = await TestEnv.create({ initialCommit: true });
		});
		afterEach(async () => {
			await env.cleanup();
		});

		it('--force path: removes agent hooks, .story/, git hooks, shadow branches', async () => {
			// Seed the repo with every kind of artifact the uninstaller should clean.
			await env.writeFile('.story/settings.json', '{"enabled": true}');
			// Fake shadow branch at HEAD.
			const { execGit } = await import('@/git');
			const head = await execGit(['rev-parse', 'HEAD'], { cwd: env.dir });
			await execGit(['branch', 'story/abc1234-e3b0c4', head], { cwd: env.dir });

			await withTestRegistry(async () => {
				const uninstallHooks = vi.fn().mockResolvedValue(undefined);
				const ag = mockHookSupport({
					name: () => 'claude-code' as AgentName,
					type: () => 'Claude Code' as AgentType,
					areHooksInstalled: async () => true,
					uninstallHooks,
				});
				register('claude-code' as AgentName, () => ag);

				const restore = silenceStdio();
				try {
					await runUninstall({
						repoRoot: env.dir,
						uninstall: true,
						force: true,
						useProjectSettings: false,
					});
				} finally {
					restore();
				}

				// Agent uninstall called.
				expect(uninstallHooks).toHaveBeenCalledTimes(1);
				// .story/ gone.
				const { default: fs } = await import('node:fs/promises');
				const { default: path } = await import('node:path');
				await expect(fs.stat(path.join(env.dir, '.story'))).rejects.toHaveProperty(
					'code',
					'ENOENT',
				);
				// Shadow branch removed.
				const { listShadowBranches } = await import('@/strategy/shadow-branches');
				expect(await listShadowBranches({ repoRoot: env.dir })).toEqual([]);
			});
		});

		it('interactive + confirm No → early stepDone "Uninstall cancelled." and abort', async () => {
			// Have something to uninstall so we hit the confirm path.
			await env.writeFile('.story/settings.json', '{"enabled": true}');
			setForceNonInteractive(false);
			process.env.STORY_TEST_TTY = '1';
			confirmMock.mockResolvedValueOnce(false);
			try {
				const { runUninstall } = await import('@/commands/setup-flow');
				const restore = silenceStdio();
				try {
					await runUninstall({
						repoRoot: env.dir,
						uninstall: true,
						force: false,
						useProjectSettings: false,
					});
				} finally {
					restore();
				}
				// .story/ must still be present (no cleanup).
				const { default: fs } = await import('node:fs/promises');
				const { default: path } = await import('node:path');
				await expect(fs.stat(path.join(env.dir, '.story'))).resolves.toBeDefined();
			} finally {
				setForceNonInteractive(true);
				delete process.env.STORY_TEST_TTY;
			}
		});

		it('agent uninstall failure warns but continues the pipeline', async () => {
			await env.writeFile('.story/settings.json', '{"enabled": true}');
			await withTestRegistry(async () => {
				const ag = mockHookSupport({
					name: () => 'claude-code' as AgentName,
					type: () => 'Claude Code' as AgentType,
					areHooksInstalled: async () => true,
					uninstallHooks: async () => {
						throw new Error('permission denied');
					},
				});
				register('claude-code' as AgentName, () => ag);

				const restore = silenceStdio();
				try {
					await runUninstall({
						repoRoot: env.dir,
						uninstall: true,
						force: true,
						useProjectSettings: false,
					});
				} finally {
					restore();
				}
				// .story/ still gets removed despite the warn above.
				const { default: fs } = await import('node:fs/promises');
				const { default: path } = await import('node:path');
				await expect(fs.stat(path.join(env.dir, '.story'))).rejects.toHaveProperty(
					'code',
					'ENOENT',
				);
			});
		});

		it('shadow branch deletion failures produce a warn but do not abort', async () => {
			// No real shadow branches, but monkey-patch listShadowBranches to
			// return a bogus name so delete fails.
			await env.writeFile('.story/settings.json', '{"enabled": true}');
			const shadowMod = await import('@/strategy/shadow-branches');
			const origList = shadowMod.listShadowBranches;
			const origDelete = shadowMod.deleteShadowBranches;
			vi.spyOn(shadowMod, 'listShadowBranches').mockResolvedValue(['story/nonexistent-aaaaaa']);
			vi.spyOn(shadowMod, 'deleteShadowBranches').mockResolvedValue({
				deleted: [],
				failed: ['story/nonexistent-aaaaaa'],
			});

			try {
				const restore = silenceStdio();
				try {
					await runUninstall({
						repoRoot: env.dir,
						uninstall: true,
						force: true,
						useProjectSettings: false,
					});
				} finally {
					restore();
				}
			} finally {
				vi.mocked(shadowMod.listShadowBranches).mockImplementation(origList);
				vi.mocked(shadowMod.deleteShadowBranches).mockImplementation(origDelete);
			}
		});
	});

	describe('detectOrSelectAgent (interactive TTY with mocked multiselect)', () => {
		beforeEach(() => {
			setForceNonInteractive(false);
			process.env.STORY_TEST_TTY = '1';
		});
		afterEach(() => {
			setForceNonInteractive(true);
			delete process.env.STORY_TEST_TTY;
		});

		it('interactive path: multiselect result → resolved agents', async () => {
			await withTestRegistry(async () => {
				register('claude-code' as AgentName, () =>
					mockHookSupport({
						name: () => 'claude-code' as AgentName,
						type: () => 'Claude Code' as AgentType,
					}),
				);
				register('cursor' as AgentName, () =>
					mockHookSupport({
						name: () => 'cursor' as AgentName,
						type: () => 'Cursor' as AgentType,
					}),
				);
				multiselectMock.mockResolvedValueOnce(['claude-code']);

				const restore = silenceStdio();
				try {
					const result = await detectOrSelectAgent({});
					expect(result.map((a) => a.name())).toEqual(['claude-code']);
				} finally {
					restore();
				}
			});
		});

		it('empty registry / no hook-supporting agents → SilentError', async () => {
			await withTestRegistry(async () => {
				await expect(detectOrSelectAgent({})).rejects.toThrow(
					/no agents with hook support available/,
				);
			});
		});

		it('multiselect returns empty → SilentError', async () => {
			await withTestRegistry(async () => {
				register('claude-code' as AgentName, () =>
					mockHookSupport({
						name: () => 'claude-code' as AgentName,
						type: () => 'Claude Code' as AgentType,
					}),
				);
				multiselectMock.mockResolvedValueOnce([]);

				const restore = silenceStdio();
				try {
					await expect(detectOrSelectAgent({})).rejects.toThrow(/please select at least one agent/);
				} finally {
					restore();
				}
			});
		});
	});

	describe('runInteractiveConfigure (with mocked multiselect)', () => {
		let env: TestEnv;
		beforeEach(async () => {
			env = await TestEnv.create({ initialCommit: true });
			setForceNonInteractive(false);
			process.env.STORY_TEST_TTY = '1';
		});
		afterEach(async () => {
			await env.cleanup();
			setForceNonInteractive(true);
			delete process.env.STORY_TEST_TTY;
		});

		it('not enabled → SilentError', async () => {
			const { runInteractiveConfigure } = await import('@/commands/setup-flow');
			const restore = silenceStdio();
			try {
				await expect(
					runInteractiveConfigure({
						repoRoot: env.dir,
						scope: 'local',
						force: false,
						skipPushSessions: false,
						telemetry: true,
						absoluteGitHookPath: false,
						localDev: false,
					}),
				).rejects.toThrow(/not enabled/);
			} finally {
				restore();
			}
		});

		it('happy path: adds cursor when multiselect returns [cursor]', async () => {
			await env.writeFile('.story/settings.json', '{"enabled": true}');
			await withTestRegistry(async () => {
				const installHooks = vi.fn().mockResolvedValue(3);
				const cursor = mockHookSupport({
					name: () => 'cursor' as AgentName,
					type: () => 'Cursor' as AgentType,
					installHooks,
					areHooksInstalled: async () => false,
				});
				register('cursor' as AgentName, () => cursor);
				multiselectMock.mockResolvedValueOnce(['cursor']);

				const { runInteractiveConfigure } = await import('@/commands/setup-flow');
				const restore = silenceStdio();
				try {
					await runInteractiveConfigure({
						repoRoot: env.dir,
						scope: 'local',
						force: false,
						skipPushSessions: false,
						telemetry: true,
						absoluteGitHookPath: false,
						localDev: false,
					});
				} finally {
					restore();
				}
				expect(installHooks).toHaveBeenCalledTimes(1);
			});
		});

		it('empty selection + no force + nothing installed → "No changes made."', async () => {
			await env.writeFile('.story/settings.json', '{"enabled": true}');
			await withTestRegistry(async () => {
				const cursor = mockHookSupport({
					name: () => 'cursor' as AgentName,
					type: () => 'Cursor' as AgentType,
					areHooksInstalled: async () => false,
				});
				register('cursor' as AgentName, () => cursor);
				multiselectMock.mockResolvedValueOnce([]);

				const { runInteractiveConfigure } = await import('@/commands/setup-flow');
				const restore = silenceStdio();
				try {
					await runInteractiveConfigure({
						repoRoot: env.dir,
						scope: 'local',
						force: false,
						skipPushSessions: false,
						telemetry: true,
						absoluteGitHookPath: false,
						localDev: false,
					});
				} finally {
					restore();
				}
				// No install/uninstall should fire — pure no-op.
			});
		});

		it('force flag reinstalls existing selected agent', async () => {
			await env.writeFile('.story/settings.json', '{"enabled": true}');
			await withTestRegistry(async () => {
				const installHooks = vi.fn().mockResolvedValue(5);
				const cursor = mockHookSupport({
					name: () => 'cursor' as AgentName,
					type: () => 'Cursor' as AgentType,
					areHooksInstalled: async () => true,
					installHooks,
				});
				register('cursor' as AgentName, () => cursor);
				multiselectMock.mockResolvedValueOnce(['cursor']);

				const { runInteractiveConfigure } = await import('@/commands/setup-flow');
				const restore = silenceStdio();
				try {
					await runInteractiveConfigure({
						repoRoot: env.dir,
						scope: 'local',
						force: true,
						skipPushSessions: false,
						telemetry: true,
						absoluteGitHookPath: false,
						localDev: false,
					});
				} finally {
					restore();
				}
				// Cursor was already installed + selected → --force should reinstall it once.
				expect(installHooks).toHaveBeenCalledWith(expect.objectContaining({ force: true }));
			});
		});

		it('agent install failure during configure → propagates AggregateError', async () => {
			await env.writeFile('.story/settings.json', '{"enabled": true}');
			await withTestRegistry(async () => {
				const ag = mockHookSupport({
					name: () => 'cursor' as AgentName,
					type: () => 'Cursor' as AgentType,
					areHooksInstalled: async () => false,
					installHooks: async () => {
						throw new Error('boom');
					},
				});
				register('cursor' as AgentName, () => ag);
				multiselectMock.mockResolvedValueOnce(['cursor']);

				const { runInteractiveConfigure } = await import('@/commands/setup-flow');
				const restore = silenceStdio();
				try {
					await expect(
						runInteractiveConfigure({
							repoRoot: env.dir,
							scope: 'local',
							force: false,
							skipPushSessions: false,
							telemetry: true,
							absoluteGitHookPath: false,
							localDev: false,
						}),
					).rejects.toThrow(AggregateError);
				} finally {
					restore();
				}
			});
		});

		it('selecting nothing while agent is installed → uninstalls it', async () => {
			await env.writeFile('.story/settings.json', '{"enabled": true}');
			await withTestRegistry(async () => {
				const uninstallHooks = vi.fn().mockResolvedValue(undefined);
				const cursor = mockHookSupport({
					name: () => 'cursor' as AgentName,
					type: () => 'Cursor' as AgentType,
					areHooksInstalled: async () => true,
					uninstallHooks,
				});
				register('cursor' as AgentName, () => cursor);
				multiselectMock.mockResolvedValueOnce([]);

				const { runInteractiveConfigure } = await import('@/commands/setup-flow');
				const restore = silenceStdio();
				try {
					await runInteractiveConfigure({
						repoRoot: env.dir,
						scope: 'local',
						force: false,
						skipPushSessions: false,
						telemetry: true,
						absoluteGitHookPath: false,
						localDev: false,
					});
				} finally {
					restore();
				}
				expect(uninstallHooks).toHaveBeenCalledTimes(1);
			});
		});
	});

	describe('runDisable interactive (confirm)', () => {
		let env: TestEnv;
		beforeEach(async () => {
			env = await TestEnv.create();
			setForceNonInteractive(false);
			process.env.STORY_TEST_TTY = '1';
		});
		afterEach(async () => {
			await env.cleanup();
			setForceNonInteractive(true);
			delete process.env.STORY_TEST_TTY;
		});

		it('confirm=false → early return without changing settings', async () => {
			await env.writeFile('.story/settings.json', '{"enabled": true}');
			confirmMock.mockResolvedValueOnce(false);

			const { runDisable } = await import('@/commands/setup-flow');
			const restore = silenceStdio();
			try {
				await runDisable({
					repoRoot: env.dir,
					uninstall: false,
					force: false,
					useProjectSettings: false,
				});
			} finally {
				restore();
			}

			// Settings.local.json must NOT exist yet (no flip happened).
			const { default: fs } = await import('node:fs/promises');
			const { default: path } = await import('node:path');
			await expect(
				fs.stat(path.join(env.dir, '.story', 'settings.local.json')),
			).rejects.toHaveProperty('code', 'ENOENT');
		});

		it('confirm=true + --project → settings.json flipped + warn about git commit', async () => {
			await env.writeFile('.story/settings.json', '{"enabled": true}');
			confirmMock.mockResolvedValueOnce(true);

			const { runDisable } = await import('@/commands/setup-flow');
			const restore = silenceStdio();
			try {
				await runDisable({
					repoRoot: env.dir,
					uninstall: false,
					force: false,
					useProjectSettings: true,
				});
			} finally {
				restore();
			}

			const raw = await env.readFile('.story/settings.json');
			expect(JSON.parse(raw).enabled).toBe(false);
		});
	});

	describe('runInteractiveEnable (non-TTY agent short-circuit)', () => {
		let env: TestEnv;
		beforeEach(async () => {
			env = await TestEnv.create({ initialCommit: true });
		});
		afterEach(async () => {
			await env.cleanup();
		});

		it('with explicit agentName → uses that agent without multiselect', async () => {
			await withTestRegistry(async () => {
				const installHooks = vi.fn().mockResolvedValue(0);
				const ag = mockHookSupport({
					name: () => 'claude-code' as AgentName,
					type: () => 'Claude Code' as AgentType,
					installHooks,
				});
				register('claude-code' as AgentName, () => ag);

				const restore = silenceStdio();
				try {
					await runInteractiveEnable({
						repoRoot: env.dir,
						agentName: 'claude-code',
						scope: 'local',
						force: false,
						skipPushSessions: false,
						telemetry: true,
						absoluteGitHookPath: false,
						localDev: false,
					});
				} finally {
					restore();
				}

				expect(installHooks).toHaveBeenCalledTimes(1);
				const raw = await env.readFile('.story/settings.local.json');
				expect(JSON.parse(raw).enabled).toBe(true);
			});
		});

		it('propagates aggregated agent install failures', async () => {
			await withTestRegistry(async () => {
				const ag = mockHookSupport({
					name: () => 'claude-code' as AgentName,
					type: () => 'Claude Code' as AgentType,
					installHooks: async () => {
						throw new Error('boom');
					},
				});
				register('claude-code' as AgentName, () => ag);

				const restore = silenceStdio();
				try {
					await expect(
						runInteractiveEnable({
							repoRoot: env.dir,
							agentName: 'claude-code',
							scope: 'local',
							force: false,
							skipPushSessions: false,
							telemetry: true,
							absoluteGitHookPath: false,
							localDev: false,
						}),
					).rejects.toThrow(AggregateError);
				} finally {
					restore();
				}
			});
		});
	});
});
