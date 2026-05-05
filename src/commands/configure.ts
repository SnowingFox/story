/**
 * `story configure` (alias `story setup`) — change Story's config on an
 * already-enabled repo. Routes to:
 *   • `runUninstallAgentHooks` for `--remove <name>`
 *   • `runNonInteractiveConfigureAdd` for `--agent <name>`
 *   • `runUpdateStrategyOptions` for strategy-only flags (no agent change)
 *   • `runInteractiveConfigure` for bare `configure` on a TTY
 *
 * Mirrors Go `cmd/entire/cli/setup.go: newSetupCmd` (Go uses a single
 * `configure`-named command; TS registers an explicit `.alias('setup')`
 * so `story setup` is a recognised spelling).
 *
 * @packageDocumentation
 */

import type { CAC } from 'cac';
import { applyGlobalFlags } from '@/cli/flags';
import { SilentError } from '@/errors';
import { worktreeRoot } from '@/paths';
import type { ConfigureOptions } from './setup-flow';
import {
	runInteractiveConfigure,
	runNonInteractiveConfigureAdd,
	runUpdateStrategyOptions,
	uninstallAgentHooks,
} from './setup-flow';
import {
	printMissingAgentError,
	printWrongAgentError,
	settingsTargetFile,
	validateMutuallyExclusiveFlags,
} from './setup-helpers';

/**
 * Register `story configure` (with alias `story setup`) on a cac instance.
 * Call exactly once from `src/commands/index.ts::registerCoreCommands`.
 *
 * @example
 * registerConfigureCommand(cli);
 * // Now resolvable:
 * //   story configure
 * //   story configure --agent cursor
 * //   story configure --remove claude-code
 * //   story setup                        (alias)
 */
export function registerConfigureCommand(cli: CAC): void {
	cli
		.command('configure', 'Configure Story CLI (add/remove agents, tune strategy)')
		.alias('setup')
		.option('--agent <name>', 'Add (or reinstall) an agent')
		.option('--remove <name>', 'Remove an agent')
		.option('--local', 'Write to .story/settings.local.json')
		.option('--project', 'Write to .story/settings.json')
		.option('-f, --force', 'Force reinstall hooks for all enabled agents')
		.option('--skip-push-sessions', 'Disable automatic push of session logs')
		.option('--checkpoint-remote <spec>', 'Checkpoint remote (provider:owner/repo)')
		.option('--telemetry', 'Toggle anonymous usage telemetry')
		.option('--absolute-git-hook-path', 'Embed full binary path in git hooks')
		.option('--local-dev', '(hidden) use bun run src/cli.ts in hooks')
		.action(async (rawFlags: Record<string, unknown>) => {
			applyGlobalFlags(rawFlags);

			const repoRoot = await requireGitRepo();
			validateMutuallyExclusiveFlags({
				local: rawFlags.local === true,
				project: rawFlags.project === true,
			});

			const agentName = typeof rawFlags.agent === 'string' ? rawFlags.agent.trim() : '';
			const removeAgentName = typeof rawFlags.remove === 'string' ? rawFlags.remove.trim() : '';

			if ('agent' in rawFlags && agentName === '') {
				printMissingAgentError();
				throw new SilentError(new Error('missing agent name'));
			}
			if ('remove' in rawFlags && removeAgentName === '') {
				printMissingAgentError();
				throw new SilentError(new Error('missing agent name'));
			}

			if (agentName !== '' && removeAgentName !== '') {
				throw new SilentError(new Error('--agent and --remove cannot be used together'));
			}

			const scope = await settingsTargetFile(
				repoRoot,
				rawFlags.local === true,
				rawFlags.project === true,
			);

			// --remove path runs without needing the full option bundle.
			if (removeAgentName !== '') {
				try {
					await uninstallAgentHooks(repoRoot, removeAgentName);
				} catch (err) {
					if (err instanceof SilentError && /unknown agent "/.test(err.message)) {
						printWrongAgentError(removeAgentName);
						throw err;
					}
					throw err;
				}
				return;
			}

			const opts: ConfigureOptions = {
				repoRoot,
				agentName: agentName === '' ? undefined : agentName,
				scope,
				force: rawFlags.force === true,
				skipPushSessions: pickBool(rawFlags, 'skip-push-sessions', 'skipPushSessions'),
				checkpointRemote: pickString(rawFlags, 'checkpoint-remote', 'checkpointRemote'),
				telemetry: rawFlags.telemetry !== false,
				absoluteGitHookPath: pickBool(rawFlags, 'absolute-git-hook-path', 'absoluteGitHookPath'),
				localDev: pickBool(rawFlags, 'local-dev', 'localDev'),
			};

			// --agent path: add / reinstall.
			if (agentName !== '') {
				try {
					await runNonInteractiveConfigureAdd(opts);
				} catch (err) {
					if (err instanceof SilentError && /unknown agent "/.test(err.message)) {
						printWrongAgentError(agentName);
						throw err;
					}
					throw err;
				}
				return;
			}

			// Strategy-only flag mode (no agent change).
			if (opts.skipPushSessions || opts.checkpointRemote !== undefined) {
				await runUpdateStrategyOptions(opts);
				return;
			}

			// Fall through: interactive manage-agents menu.
			await runInteractiveConfigure(opts);
		});
}

async function requireGitRepo(): Promise<string> {
	try {
		return await worktreeRoot(process.cwd());
	} catch {
		throw new SilentError(
			new Error("Not a git repository. Please run 'story configure' from within a git repository."),
		);
	}
}

function pickBool(parsed: Record<string, unknown>, ...keys: string[]): boolean {
	for (const key of keys) {
		if (parsed[key] === true) {
			return true;
		}
	}
	return false;
}

function pickString(parsed: Record<string, unknown>, ...keys: string[]): string | undefined {
	for (const key of keys) {
		const v = parsed[key];
		if (typeof v === 'string' && v !== '') {
			return v;
		}
	}
	return undefined;
}
