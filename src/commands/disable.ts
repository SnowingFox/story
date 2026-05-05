/**
 * `story disable` — turn Story off in the current repo or (with
 * `--uninstall`) wipe it entirely. Dispatches into `runDisable` /
 * `runUninstall` in {@link ./setup-flow}.
 *
 * Mirrors Go `cmd/entire/cli/setup.go: newDisableCmd`.
 *
 * @packageDocumentation
 */

import type { CAC } from 'cac';
import { applyGlobalFlags } from '@/cli/flags';
import { SilentError } from '@/errors';
import { worktreeRoot } from '@/paths';
import type { DisableOptions } from './setup-flow';
import { runDisable, runUninstall } from './setup-flow';

/**
 * Register `story disable` on a cac instance. Call exactly once from
 * `src/commands/index.ts::registerCoreCommands`.
 *
 * @example
 * registerDisableCommand(cli);
 * // Now resolvable:
 * //   story disable
 * //   story disable --project
 * //   story disable --uninstall --force
 */
export function registerDisableCommand(cli: CAC): void {
	cli
		.command('disable', 'Disable Story CLI')
		.option('--project', 'Update .story/settings.json instead of settings.local.json')
		.option('--uninstall', 'Completely remove Story from this repository')
		.option('--force', 'Skip confirmation prompt (use with --uninstall)')
		.action(async (rawFlags: Record<string, unknown>) => {
			applyGlobalFlags(rawFlags);

			const repoRoot = await requireGitRepo();

			const opts: DisableOptions = {
				repoRoot,
				uninstall: rawFlags.uninstall === true,
				force: rawFlags.force === true,
				useProjectSettings: rawFlags.project === true,
			};

			if (opts.uninstall) {
				await runUninstall(opts);
				return;
			}
			await runDisable(opts);
		});
}

async function requireGitRepo(): Promise<string> {
	try {
		return await worktreeRoot(process.cwd());
	} catch {
		throw new SilentError(
			new Error("Not a git repository. Please run 'story disable' from within a git repository."),
		);
	}
}
