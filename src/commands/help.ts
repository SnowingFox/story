/**
 * `story help [cmd]` — thin wrapper over
 * {@link ../cli/help::renderHelp} and {@link ../cli/help::renderTree}.
 *
 * Mirrors Go `cmd/entire/cli/help.go: newHelpCmd`; the `-t` /
 * `--tree` branch is the Go hidden-flag equivalent routed through
 * the hidden root option registered in {@link setupHelpOverride}.
 */

import type { CAC } from 'cac';
import { renderHelp, renderTree } from '@/cli/help';

/**
 * Register `story help [cmd]` on the given cac instance.
 *
 * @example
 * registerHelpCommand(cli);
 * // `story help`               → root help view
 * // `story help enable`        → per-command detail
 * // `story help --tree`        → full command tree
 */
export function registerHelpCommand(cli: CAC): void {
	cli
		.command('help [cmd]', 'Show help for a command')
		.option('-t, --tree', 'Print the full command tree')
		.action((cmd: string | undefined, options: Record<string, unknown>) => {
			if (options.tree === true) {
				process.stdout.write(renderTree(cli));
				return;
			}
			process.stdout.write(renderHelp(cli, cmd));
		});
}
