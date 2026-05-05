/**
 * Phase 9.1 `src/commands/setup-helpers.ts` unit tests.
 *
 * Most helpers are pure; a few read the filesystem (via TestEnv) to exercise
 * the auto-scope fallback chain. Agent-registry-touching tests use
 * `withTestRegistry` to seed a fake registry, so the real built-in agents
 * never leak into these cases.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { register, withTestRegistry } from '@/agent/registry';
import type { AgentName, AgentType } from '@/agent/types';
import { resetGlobalFlagsForTesting } from '@/cli/flags';
import {
	applyStrategyOptions,
	buildAgentListForPrompt,
	determineSettingsTarget,
	getAgentsWithHooksInstalled,
	installedAgentDisplayNames,
	parseCheckpointRemote,
	printMissingAgentError,
	printWrongAgentError,
	settingsTargetFile,
	validateMutuallyExclusiveFlags,
	writeSettingsScoped,
} from '@/commands/setup-helpers';
import { SilentError } from '@/errors';
import type { StorySettings } from '@/settings/settings';
import { resetColorOverrideForTesting, setColorOverride } from '@/ui/theme';
import { TestEnv } from '../../helpers/test-env';
import { mockHookSupport } from '../agent/_helpers';

const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const stripAnsi = (s: string) => s.replace(ANSI_RE, '');

function captureStream(stream: 'stdout' | 'stderr') {
	const chunks: Buffer[] = [];
	const orig = process[stream].write.bind(process[stream]);
	process[stream].write = ((chunk: string | Uint8Array) => {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
		return true;
	}) as typeof process.stdout.write;
	return {
		text: () => stripAnsi(Buffer.concat(chunks).toString('utf8')),
		restore: () => {
			process[stream].write = orig;
		},
	};
}

describe('commands/setup-helpers', () => {
	beforeEach(() => {
		resetGlobalFlagsForTesting();
		resetColorOverrideForTesting();
		setColorOverride(false);
	});

	afterEach(() => {
		resetGlobalFlagsForTesting();
		resetColorOverrideForTesting();
	});

	// Go: setup.go: validateSetupFlags
	describe('validateMutuallyExclusiveFlags', () => {
		it('throws SilentError when both --local and --project are true', () => {
			expect(() => validateMutuallyExclusiveFlags({ local: true, project: true })).toThrow(
				SilentError,
			);
			try {
				validateMutuallyExclusiveFlags({ local: true, project: true });
			} catch (err) {
				expect((err as Error).message).toBe('cannot specify both --project and --local');
			}
		});

		it('is a no-op for the 3 other flag combinations', () => {
			expect(() => validateMutuallyExclusiveFlags({ local: true })).not.toThrow();
			expect(() => validateMutuallyExclusiveFlags({ project: true })).not.toThrow();
			expect(() => validateMutuallyExclusiveFlags({})).not.toThrow();
		});
	});

	// Go: setup.go: parseCheckpointRemoteFlag
	describe('parseCheckpointRemote', () => {
		it('parses github:owner/repo', () => {
			expect(parseCheckpointRemote('github:acme/checkpoints')).toEqual({
				provider: 'github',
				repo: 'acme/checkpoints',
			});
		});

		it('rejects missing colon', () => {
			expect(() => parseCheckpointRemote('github')).toThrow(/expected format provider:owner\/repo/);
		});

		it('rejects empty provider or empty repo', () => {
			expect(() => parseCheckpointRemote(':acme/foo')).toThrow(/expected format/);
			expect(() => parseCheckpointRemote('github:')).toThrow(/expected format/);
		});

		it('rejects unsupported provider', () => {
			expect(() => parseCheckpointRemote('gitlab:acme/foo')).toThrow(
				/unsupported provider "gitlab"/,
			);
		});

		it('rejects repo without `/` (no owner/name split)', () => {
			expect(() => parseCheckpointRemote('github:acme')).toThrow(/owner\/name format/);
		});
	});

	// Go: setup.go: (*EnableOptions).applyStrategyOptions
	describe('applyStrategyOptions', () => {
		it('sets strategy_options.push_sessions to false for --skip-push-sessions', () => {
			const s: StorySettings = { enabled: true };
			applyStrategyOptions(s, { skipPushSessions: true });
			expect(s.strategy_options?.push_sessions).toBe(false);
		});

		it('writes parsed checkpoint_remote into strategy_options', () => {
			const s: StorySettings = { enabled: true };
			applyStrategyOptions(s, { checkpointRemote: 'github:acme/cp' });
			expect(s.strategy_options?.checkpoint_remote).toEqual({
				provider: 'github',
				repo: 'acme/cp',
			});
		});

		it('invalid checkpoint_remote only warns on stderr and does NOT throw', () => {
			const cap = captureStream('stderr');
			const s: StorySettings = { enabled: true };
			try {
				applyStrategyOptions(s, { checkpointRemote: 'oops-no-colon' });
				expect(cap.text()).toMatch(/invalid --checkpoint-remote/);
				expect(s.strategy_options?.checkpoint_remote).toBeUndefined();
			} finally {
				cap.restore();
			}
		});
	});

	// Go: setup.go: settingsTargetFile
	describe('settingsTargetFile', () => {
		let env: TestEnv;
		beforeEach(async () => {
			env = await TestEnv.create();
		});
		afterEach(async () => {
			await env.cleanup();
		});

		it('--local wins → "local"', async () => {
			expect(await settingsTargetFile(env.dir, true, false)).toBe('local');
		});
		it('--project wins → "project"', async () => {
			expect(await settingsTargetFile(env.dir, false, true)).toBe('project');
		});
		it('auto: project file exists → "project"', async () => {
			await env.writeFile('.story/settings.json', '{"enabled":true}');
			expect(await settingsTargetFile(env.dir, false, false)).toBe('project');
		});
		it('auto: local-only → "local"', async () => {
			await env.writeFile('.story/settings.local.json', '{"enabled":true}');
			expect(await settingsTargetFile(env.dir, false, false)).toBe('local');
		});
		it('auto: no files → "project" (create on first run)', async () => {
			expect(await settingsTargetFile(env.dir, false, false)).toBe('project');
		});
	});

	// Go: setup.go: determineSettingsTarget
	describe('determineSettingsTarget', () => {
		let env: TestEnv;
		beforeEach(async () => {
			env = await TestEnv.create();
		});
		afterEach(async () => {
			await env.cleanup();
		});

		it('project file exists + auto mode → [true, true] (redirect notification)', async () => {
			await env.writeFile('.story/settings.json', '{"enabled":true}');
			expect(await determineSettingsTarget(env.dir, false, false)).toEqual([true, true]);
		});

		it('explicit --local returns [true, false] (no notification)', async () => {
			expect(await determineSettingsTarget(env.dir, true, false)).toEqual([true, false]);
		});

		it('explicit --project returns [false, false] (no notification)', async () => {
			expect(await determineSettingsTarget(env.dir, false, true)).toEqual([false, false]);
		});

		it('neither flag + no project file → [false, false]', async () => {
			expect(await determineSettingsTarget(env.dir, false, false)).toEqual([false, false]);
		});
	});

	// Thin scope wrapper — delegates to saveEnabledState.
	describe('writeSettingsScoped', () => {
		let env: TestEnv;
		beforeEach(async () => {
			env = await TestEnv.create();
		});
		afterEach(async () => {
			await env.cleanup();
		});

		it('local scope writes settings.local.json only', async () => {
			await writeSettingsScoped(env.dir, { enabled: true }, 'local');
			await expect(env.readFile('.story/settings.local.json')).resolves.toContain(
				'"enabled": true',
			);
		});

		it('project scope writes settings.json', async () => {
			await writeSettingsScoped(env.dir, { enabled: false }, 'project');
			await expect(env.readFile('.story/settings.json')).resolves.toContain('"enabled": false');
		});
	});

	// Go: setup.go: detectOrSelectAgent option-building loop
	describe('buildAgentListForPrompt', () => {
		it('returns [{value,label,hint}] from registered non-test agents with HookSupport', async () => {
			await withTestRegistry(async () => {
				const claude = mockHookSupport({
					name: () => 'claude-code' as AgentName,
					type: () => 'Claude Code' as AgentType,
					description: () => 'Anthropic Claude Code',
				});
				const vogon = mockHookSupport({
					name: () => 'vogon' as AgentName,
					type: () => 'Vogon' as AgentType,
					description: () => 'Canary',
					// TestOnly marker — filters out of stringList()
					isTestOnly: () => true,
				} as unknown as Record<string, unknown>);
				register('claude-code' as AgentName, () => claude);
				register('vogon' as AgentName, () => vogon);

				const opts = buildAgentListForPrompt();
				expect(opts.map((o) => o.value)).toEqual(['claude-code']);
				expect(opts[0]).toEqual({
					value: 'claude-code',
					label: 'claude-code',
					hint: 'Anthropic Claude Code',
				});
			});
		});
	});

	// Go: config.go: GetAgentsWithHooksInstalled / InstalledAgentDisplayNames
	describe('getAgentsWithHooksInstalled + installedAgentDisplayNames', () => {
		it('returns only agents whose areHooksInstalled() resolves true', async () => {
			await withTestRegistry(async () => {
				const claude = mockHookSupport({
					name: () => 'claude-code' as AgentName,
					type: () => 'Claude Code' as AgentType,
					areHooksInstalled: async () => true,
				});
				const cursor = mockHookSupport({
					name: () => 'cursor' as AgentName,
					type: () => 'Cursor' as AgentType,
					areHooksInstalled: async () => false,
				});
				register('claude-code' as AgentName, () => claude);
				register('cursor' as AgentName, () => cursor);

				expect(await getAgentsWithHooksInstalled()).toEqual(['claude-code']);
				expect(await installedAgentDisplayNames()).toEqual(['Claude Code']);
			});
		});

		it('treats areHooksInstalled() throws as not-installed (does not abort the list)', async () => {
			await withTestRegistry(async () => {
				const broken = mockHookSupport({
					name: () => 'vogon' as AgentName,
					type: () => 'Vogon' as AgentType,
					areHooksInstalled: async () => {
						throw new Error('fs corrupt');
					},
				});
				const ok = mockHookSupport({
					name: () => 'cursor' as AgentName,
					type: () => 'Cursor' as AgentType,
					areHooksInstalled: async () => true,
				});
				register('vogon' as AgentName, () => broken);
				register('cursor' as AgentName, () => ok);

				const installed = await getAgentsWithHooksInstalled();
				expect(installed).toEqual(['cursor']);
			});
		});
	});

	// Go: setup.go: printMissingAgentError / printWrongAgentError
	describe('printMissingAgentError / printWrongAgentError', () => {
		it('renders "Missing agent name." header + available-agent hint to stdout', async () => {
			await withTestRegistry(async () => {
				const claude = mockHookSupport({
					name: () => 'claude-code' as AgentName,
					type: () => 'Claude Code' as AgentType,
				});
				register('claude-code' as AgentName, () => claude);

				const cap = captureStream('stdout');
				try {
					printMissingAgentError();
					const out = cap.text();
					expect(out).toMatch(/Missing agent name\./);
					expect(out).toMatch(/Available:.*claude-code/);
					expect(out).toMatch(/Usage: story enable --agent/);
				} finally {
					cap.restore();
				}
			});
		});

		it('printWrongAgentError echoes the bad name in the headline', () => {
			const cap = captureStream('stdout');
			try {
				printWrongAgentError('typo-agent');
				expect(cap.text()).toMatch(/Unknown agent "typo-agent"\./);
			} finally {
				cap.restore();
			}
		});
	});
});
