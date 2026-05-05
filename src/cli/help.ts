/**
 * Custom help renderer. Replaces cac's built-in `cli.help()` so the
 * Story CLI help output matches the bar-line aesthetic used
 * everywhere else. Also hosts the hidden `--tree, -t` flag used by
 * {@link ./runtime::runCli} / `story help` to print the full command
 * tree (Go parity with `entire help --tree`).
 *
 * Mirrors Go `cmd/entire/cli/help.go: newHelpCmd` — Story-side
 * Unicode box characters and command grouping are our extension.
 */

import type { CAC, Command } from 'cac';
import { color } from '@/ui/theme';

const INDENT = '  ';
const TAGLINE = 'Every commit tells a story.';

/**
 * Disable cac's built-in help and register the hidden `--tree, -t`
 * root option. The concrete `--help` handler is wired by
 * `src/commands/help.ts` (registered via `registerCoreCommands`), so
 * this function stays side-effect-light.
 *
 * @example
 * const cli = cac('story');
 * setupHelpOverride(cli);
 * // cli.globalCommand now has a `--tree` option; cac's default
 * // `--help` renderer is still attached but gets pre-empted by
 * // src/commands/help.ts when the user passes `-h` / `--help`.
 */
export function setupHelpOverride(cli: CAC): void {
	cli.option('-t, --tree', 'Print the full command tree (hidden)');
	// cac invokes `helpCallback(sections)` inside `outputHelp()` and then
	// joins whatever sections we return. Replace them wholesale with our
	// bar-line renderer so `--help` / `-h` behave identically to the
	// `story help [cmd]` command.
	cli.help((_sections) => {
		const cmdName = cli.matchedCommandName ?? undefined;
		if (cli.options.tree === true) {
			return [{ body: renderTree(cli).trimEnd() }];
		}
		return [{ body: renderHelp(cli, cmdName).trimEnd() }];
	});
}

/**
 * Render the help view for the root CLI or a single subcommand.
 *
 * @example
 * renderHelp(cli);
 * // ┌  Story CLI
 * // │
 * // │  Every commit tells a story.
 * // │
 * // │  Usage:
 * // │    story <command> [...args]
 * // │
 * // │  Commands:
 * // │    enable     Enable Story CLI in this repository
 * // │    ...
 * // │
 * // │  Global flags:
 * // │    --verbose      Increase log verbosity
 * // │    ...
 * // └
 */
export function renderHelp(cli: CAC, cmd?: string): string {
	if (cmd !== undefined) {
		const match = cli.commands.find((c) => c.name === cmd || c.aliasNames.includes(cmd));
		if (match !== undefined) {
			return renderCommandHelp(match);
		}
	}
	return renderRootHelp(cli);
}

function renderRootHelp(cli: CAC): string {
	const visible = cli.commands.filter((c) => isVisible(c));
	const nameWidth = Math.max(8, ...visible.map((c) => c.name.length));
	const globalFlags = cli.globalCommand.options.filter((o) => !o.names.includes('tree'));
	const flagWidth = Math.max(18, ...globalFlags.map((o) => o.rawName.length));

	const lines: string[] = [];
	lines.push(`${color.gray('┌')}  ${color.cyan(color.bold('Story CLI'))}`);
	lines.push(`${color.gray('│')}`);
	lines.push(`${color.gray('│')}  ${color.dim(TAGLINE)}`);
	lines.push(`${color.gray('│')}`);
	lines.push(`${color.gray('│')}  ${color.bold('Usage:')}`);
	lines.push(`${color.gray('│')}  ${INDENT}${color.cyan('story')} <command> [...args]`);
	lines.push(`${color.gray('│')}`);
	lines.push(`${color.gray('│')}  ${color.bold('Commands:')}`);
	for (const c of visible) {
		const name = color.cyan(c.name.padEnd(nameWidth));
		lines.push(`${color.gray('│')}  ${INDENT}${name}  ${c.description}`);
	}
	if (globalFlags.length > 0) {
		lines.push(`${color.gray('│')}`);
		lines.push(`${color.gray('│')}  ${color.bold('Global flags:')}`);
		for (const opt of globalFlags) {
			const raw = opt.rawName.padEnd(flagWidth);
			lines.push(`${color.gray('│')}  ${INDENT}${color.dim(raw)}  ${opt.description}`);
		}
	}
	lines.push(`${color.gray('│')}`);
	lines.push(`${color.gray('│')}  ${color.dim("Run 'story help <command>' for details.")}`);
	lines.push(`${color.gray('└')}`);
	return `${lines.join('\n')}\n`;
}

function renderCommandHelp(cmd: Command): string {
	const lines: string[] = [];
	lines.push(`${color.gray('┌')}  ${color.cyan(color.bold(`story ${cmd.name}`))}`);
	lines.push(`${color.gray('│')}`);
	lines.push(`${color.gray('│')}  ${cmd.description}`);
	if (cmd.options.length > 0) {
		const optWidth = Math.max(18, ...cmd.options.map((o) => o.rawName.length));
		lines.push(`${color.gray('│')}`);
		lines.push(`${color.gray('│')}  ${color.bold('Flags:')}`);
		for (const opt of cmd.options) {
			const raw = opt.rawName.padEnd(optWidth);
			lines.push(`${color.gray('│')}  ${INDENT}${color.dim(raw)}  ${opt.description}`);
		}
	}
	if (cmd.usageText !== undefined && cmd.usageText !== '') {
		lines.push(`${color.gray('│')}`);
		lines.push(`${color.gray('│')}  ${color.bold('Usage:')}  ${cmd.usageText}`);
	}
	lines.push(`${color.gray('└')}`);
	return `${lines.join('\n')}\n`;
}

/**
 * Render the full command tree — exposed via `story help --tree` /
 * `story --help -t`. Hidden commands are skipped; sub-commands are
 * shown as ASCII branches.
 *
 * @example
 * renderTree(cli);
 * // ┌  story
 * // │
 * // │  ├── enable            Enable Story CLI
 * // │  ├── disable           Disable Story CLI
 * // │  ├── ...
 * // └
 */
export function renderTree(cli: CAC): string {
	const visible = cli.commands.filter((c) => isVisible(c));
	const lines: string[] = [];
	lines.push(`${color.gray('┌')}  ${color.cyan(color.bold('story'))}`);
	lines.push(`${color.gray('│')}`);
	for (let i = 0; i < visible.length; i++) {
		const cmd = visible[i];
		if (cmd === undefined) {
			continue;
		}
		const isLast = i === visible.length - 1;
		const branch = isLast ? '└──' : '├──';
		const padded = cmd.name.padEnd(16);
		lines.push(
			`${color.gray('│')}  ${color.gray(branch)} ${color.cyan(padded)} ${cmd.description}`,
		);
	}
	lines.push(`${color.gray('└')}`);
	return `${lines.join('\n')}\n`;
}

function isVisible(cmd: Command): boolean {
	// `hooks [...args]` uses empty description as the Phase-8 hidden marker.
	// The `''`-name default command exists to catch `story` (no args) and
	// render help; it should not appear in the visible listing.
	if (cmd.description === '' || cmd.name === '' || cmd.name === '@@global@@') {
		return false;
	}
	return true;
}
