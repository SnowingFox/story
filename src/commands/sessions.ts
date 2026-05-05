/**
 * `story sessions` — namespace + catch-all router. cac has no native
 * multi-word subcommand tree (unlike cobra), so `sessions list` /
 * `sessions info` / `sessions stop` are all dispatched from a single
 * `sessions [...args]` action that routes on `args[0]`.
 *
 * Go: `cmd/entire/cli/sessions.go: newSessionsCmd` (cobra parent with 3
 * child commands). TS adaptation mirrors the Phase 8 `hooks [...args]`
 * pattern already in {@link ../cli.ts}.
 *
 * @packageDocumentation
 */

import type { CAC } from 'cac';
import { applyGlobalFlags } from '@/cli/flags';
import { renderHelp } from '@/cli/help';
import { handleSessionsInfo } from '@/commands/sessions/info';
import { handleSessionsList } from '@/commands/sessions/list';
import { handleSessionsStop } from '@/commands/sessions/stop';
import { SilentError } from '@/errors';

/**
 * Register `story sessions [...args]` on a cac instance.
 *
 * Routing table:
 *  - `sessions`                 → renderHelp (no side effects)
 *  - `sessions list`            → handleSessionsList(args[1..])
 *  - `sessions info <id>`       → handleSessionsInfo(args[1..])
 *  - `sessions stop [id]`       → handleSessionsStop(args[1..], flags)
 *  - `sessions <unknown>`       → SilentError('Unknown subcommand')
 *
 * Go: `sessions.go: newSessionsCmd`.
 *
 * @example
 * registerSessionsCommand(cli);
 * // Now resolvable:
 * //   story sessions
 * //   story sessions list
 * //   story sessions info sess_abc123
 * //   story sessions stop --all
 */
export function registerSessionsCommand(cli: CAC): void {
	cli
		.command('sessions [...args]', 'Manage agent sessions (list / inspect / stop)', {
			allowUnknownOptions: true,
		})
		.option('--all', 'Stop all active sessions (sessions stop)')
		.option('-f, --force', 'Skip confirmation prompts (sessions stop)')
		.action(async (args: string[], rawFlags: Record<string, unknown>) => {
			applyGlobalFlags(rawFlags);

			if (args.length === 0) {
				process.stdout.write(renderHelp(cli, 'sessions'));
				return;
			}

			const [sub, ...rest] = args;
			if (sub === 'list') {
				await handleSessionsList(rest);
				return;
			}
			if (sub === 'info') {
				await handleSessionsInfo(rest);
				return;
			}
			if (sub === 'stop') {
				await handleSessionsStop(rest, rawFlags);
				return;
			}
			throw new SilentError(
				new Error(`Unknown subcommand: sessions ${sub} | Available: list, info, stop`),
			);
		});
}
