/**
 * `story enable` + hidden `story enable git-hook` subcommand.
 *
 * Dispatches to either `runNonInteractiveEnable` (when `--agent` is given)
 * or `runInteractiveEnable` (everything else). The hidden `git-hook`
 * subcommand is a minimal-output entry point used by CI / automation /
 * smoke tests — it only installs the 5 shell shims into `.git/hooks/`.
 *
 * Mirrors Go `cmd/entire/cli/setup.go: newEnableCmd` +
 * `newSetupGitHookCmd`.
 *
 * @packageDocumentation
 */

import type { CAC } from 'cac';
import { applyGlobalFlags, getGlobalFlags } from '@/cli/flags';
import { SilentError } from '@/errors';
import { hookSettingsFromConfig, installGitHooks } from '@/hooks/install';
import { worktreeRoot } from '@/paths';
import { isSetUpAny } from '@/settings/settings';
import { stepDone } from '@/ui';
import type { EnableOptions } from './setup-flow';
import { runInteractiveEnable, runNonInteractiveEnable } from './setup-flow';
import {
	printMissingAgentError,
	printWrongAgentError,
	settingsTargetFile,
	validateMutuallyExclusiveFlags,
} from './setup-helpers';

/**
 * Register `story enable` + `story enable git-hook` on a cac instance.
 * Call exactly once from `src/commands/index.ts::registerCoreCommands`.
 *
 * @example
 * registerEnableCommand(cli);
 * // Now resolvable:
 * //   story enable
 * //   story enable --agent claude-code --local --force
 * //   story enable git-hook                   (hidden)
 */
export function registerEnableCommand(cli: CAC): void {
	cli
		.command('enable [subcommand]', 'Enable Story CLI')
		.option('--agent <name>', 'Agent to enable (e.g. claude-code, cursor)')
		.option('--local', 'Write to .story/settings.local.json')
		.option('--project', 'Write to .story/settings.json')
		.option('-f, --force', 'Force reinstall hooks')
		.option('--skip-push-sessions', 'Disable automatic push of session logs')
		.option('--checkpoint-remote <spec>', 'Checkpoint remote (provider:owner/repo)')
		.option('--telemetry', 'Enable anonymous usage telemetry (default true)')
		.option('--absolute-git-hook-path', 'Embed full binary path in git hooks')
		.option('--ignore-untracked', '(hidden) commit all new files')
		.option('--local-dev', '(hidden) use bun run src/cli.ts in hooks')
		.action(async (subcommand: string | undefined, rawFlags: Record<string, unknown>) => {
			applyGlobalFlags(rawFlags);

			// Hidden `story enable git-hook` dispatch — cac doesn't support true
			// multi-word subcommands, so we take the first positional as an
			// optional subcommand name. Only `git-hook` is recognized; anything
			// else falls through to the standard `enable` flow.
			if (subcommand === 'git-hook') {
				await runEnableGitHook();
				return;
			}

			const repoRoot = await requireGitRepo();
			validateMutuallyExclusiveFlags({
				local: rawFlags.local === true,
				project: rawFlags.project === true,
			});

			const agentName = typeof rawFlags.agent === 'string' ? rawFlags.agent.trim() : '';
			// User passed `--agent` with an empty value → Go `printMissingAgentError`.
			// Detect by presence of the agent key (cac populates it to '' when
			// `--agent=` is given with empty value).
			if ('agent' in rawFlags && agentName === '') {
				printMissingAgentError();
				throw new SilentError(new Error('missing agent name'));
			}

			const scope = await settingsTargetFile(
				repoRoot,
				rawFlags.local === true,
				rawFlags.project === true,
			);

			const baseOpts: EnableOptions = {
				repoRoot,
				scope,
				force: rawFlags.force === true,
				skipPushSessions: pickBool(rawFlags, 'skip-push-sessions', 'skipPushSessions'),
				checkpointRemote: pickString(rawFlags, 'checkpoint-remote', 'checkpointRemote'),
				telemetry: rawFlags.telemetry !== false,
				absoluteGitHookPath: pickBool(rawFlags, 'absolute-git-hook-path', 'absoluteGitHookPath'),
				localDev: pickBool(rawFlags, 'local-dev', 'localDev'),
			};

			if (agentName !== '') {
				const opts: EnableOptions = { ...baseOpts, agentName };
				try {
					await runNonInteractiveEnable(opts);
				} catch (err) {
					if (err instanceof SilentError && /unknown agent "/.test(err.message)) {
						printWrongAgentError(agentName);
						throw err;
					}
					throw err;
				}
				return;
			}

			// Already-setup path: bare `enable` without --force is a no-op that
			// prints a friendly summary; with --force / other mutating flags it
			// falls through to the interactive manage-agents path.
			if (await isSetUpAny(repoRoot)) {
				if (!baseOpts.force) {
					const flags = getGlobalFlags();
					if (flags.json) {
						process.stdout.write(`${JSON.stringify({ enabled: true, scope })}\n`);
						return;
					}
					stepDone('Story is already enabled in this repository.');
					return;
				}
			}

			await runInteractiveEnable(baseOpts);
		});
}

async function runEnableGitHook(): Promise<void> {
	const repoRoot = await requireGitRepo();
	const { localDev, absoluteHookPath } = await hookSettingsFromConfig(repoRoot);
	await installGitHooks(repoRoot, {
		silent: false,
		localDev,
		absolutePath: absoluteHookPath,
	});
}

async function requireGitRepo(): Promise<string> {
	try {
		return await worktreeRoot(process.cwd());
	} catch {
		throw new SilentError(
			new Error("Not a git repository. Please run 'story enable' from within a git repository."),
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
