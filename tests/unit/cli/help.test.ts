// Go: help.go: NewHelpCmd — cobra's help rendering (`--help` output).
// Go: help.go: --tree flag — `renderTree` command-tree helper.
//
// Story's cac-based renderer lives in `src/cli/help.ts` and uses the
// same user-visible layout (Usage / Commands / per-command detail);
// tests below pin the contract so doctor/clean additions stay visible.

import cac from 'cac';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerGlobalFlags, resetGlobalFlagsForTesting } from '@/cli/flags';
import { resetColorOverrideForTesting, setColorOverride } from '@/ui/theme';

const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const stripAnsi = (s: string) => s.replace(ANSI_RE, '');

function buildCli(): ReturnType<typeof cac> {
	const cli = cac('story');
	registerGlobalFlags(cli);
	// Register a canonical subset mirroring what src/cli.ts would register.
	cli.command('version', 'Show build information').action(() => {});
	cli.command('help [cmd]', 'Show help for a command').action(() => {});
	cli.command('enable', 'Enable Story CLI in this repository').action(() => {});
	cli.command('disable', 'Disable Story CLI').action(() => {});
	cli.command('status', 'Show Story enablement + active sessions').action(() => {});
	// `hooks [...args]` is hidden (empty description) — should NOT appear in help.
	cli.command('hooks [...args]', '', { allowUnknownOptions: true }).action(() => {});
	return cli;
}

describe('cli/help :: renderHelp', () => {
	beforeEach(() => {
		resetGlobalFlagsForTesting();
		resetColorOverrideForTesting();
	});

	afterEach(() => {
		resetGlobalFlagsForTesting();
		resetColorOverrideForTesting();
	});

	it('renders top-level help with header, usage, and visible commands', async () => {
		setColorOverride(false);
		const { renderHelp } = await import('@/cli/help');
		const cli = buildCli();
		const output = stripAnsi(renderHelp(cli));
		expect(output).toContain('Story CLI');
		expect(output).toContain('Every commit tells a story.');
		expect(output).toContain('Usage:');
		expect(output).toContain('story <command>');
		expect(output).toContain('Commands:');
		expect(output).toContain('version');
		expect(output).toContain('help');
		expect(output).toContain('enable');
		expect(output).toContain('status');
	});

	it('omits hidden commands (empty description) from top-level help', async () => {
		setColorOverride(false);
		const { renderHelp } = await import('@/cli/help');
		const cli = buildCli();
		const output = stripAnsi(renderHelp(cli));
		expect(output).not.toContain('hooks');
	});

	it('renders per-command detail when given a command name', async () => {
		setColorOverride(false);
		const { renderHelp } = await import('@/cli/help');
		const cli = buildCli();
		const output = stripAnsi(renderHelp(cli, 'enable'));
		expect(output).toContain('enable');
		expect(output).toContain('Enable Story CLI in this repository');
	});

	it('renders per-command detail with Flags + Usage when command has both', async () => {
		setColorOverride(false);
		const { renderHelp } = await import('@/cli/help');
		const cli = cac('story');
		registerGlobalFlags(cli);
		cli
			.command('enable', 'Enable Story CLI in this repository')
			.option('--force, -f', 'Force reinstall hooks')
			.usage('enable [--force]')
			.action(() => {});
		const output = stripAnsi(renderHelp(cli, 'enable'));
		expect(output).toContain('Flags:');
		expect(output).toContain('--force');
		expect(output).toContain('Usage:');
		expect(output).toContain('enable [--force]');
	});

	it('falls back to top-level help for unknown command names', async () => {
		setColorOverride(false);
		const { renderHelp } = await import('@/cli/help');
		const cli = buildCli();
		const output = stripAnsi(renderHelp(cli, 'bogus-cmd'));
		expect(output).toContain('Usage:');
		expect(output).toContain('Commands:');
	});

	it('includes global flag hint block', async () => {
		setColorOverride(false);
		const { renderHelp } = await import('@/cli/help');
		const cli = buildCli();
		const output = stripAnsi(renderHelp(cli));
		expect(output).toMatch(/--(verbose|json|yes|no-color|non-interactive|log-level)/);
	});
});

describe('cli/help :: renderTree', () => {
	beforeEach(() => {
		resetGlobalFlagsForTesting();
		resetColorOverrideForTesting();
	});

	afterEach(() => {
		resetGlobalFlagsForTesting();
		resetColorOverrideForTesting();
	});

	it('renders visible commands in tree form with the story root node', async () => {
		setColorOverride(false);
		const { renderTree } = await import('@/cli/help');
		const cli = buildCli();
		const output = stripAnsi(renderTree(cli));
		expect(output).toContain('story');
		expect(output).toContain('enable');
		expect(output).toContain('status');
		expect(output).toContain('version');
	});

	it('excludes hidden commands', async () => {
		setColorOverride(false);
		const { renderTree } = await import('@/cli/help');
		const cli = buildCli();
		const output = stripAnsi(renderTree(cli));
		expect(output).not.toContain('hooks');
	});
});

describe('cli/help :: setupHelpOverride', () => {
	beforeEach(() => {
		resetGlobalFlagsForTesting();
		resetColorOverrideForTesting();
	});

	afterEach(() => {
		resetGlobalFlagsForTesting();
		resetColorOverrideForTesting();
	});

	it('does not throw and registers --tree option on the root', async () => {
		const { setupHelpOverride } = await import('@/cli/help');
		const cli = buildCli();
		expect(() => setupHelpOverride(cli)).not.toThrow();
		const optionNames = cli.globalCommand.options.map((o) => o.name);
		expect(optionNames).toContain('tree');
	});

	// Go: cmd/entire/cli/help.go: newHelpCmd — the `-h`/`--help` path
	// routes through cobra's customized help callback. Story's cac
	// equivalent is `cli.help(cb)`; this test asserts the cb we
	// registered in setupHelpOverride is actually what cac runs. cac
	// calls the help callback through `console.log` so we spy that.
	it('outputHelp() invokes the custom callback and emits Story help', async () => {
		setColorOverride(false);
		const { setupHelpOverride } = await import('@/cli/help');
		const messages: string[] = [];
		const origLog = console.log;
		console.log = ((...args: unknown[]) => {
			messages.push(args.map((a) => String(a)).join(' '));
		}) as typeof console.log;
		try {
			const cli = cac('story');
			registerGlobalFlags(cli);
			setupHelpOverride(cli);
			cli.command('enable', 'Enable Story CLI').action(() => {});
			cli.outputHelp();
		} finally {
			console.log = origLog;
		}
		const out = stripAnsi(messages.join('\n'));
		expect(out).toContain('Story CLI');
		expect(out).toContain('Commands:');
		expect(out).toContain('Global flags:');
		// cac's default help header ("story\nUsage:...") must NOT bleed
		// through — our callback returns a single Section.
		expect(out).not.toMatch(/^\s*story\n\s*Usage:/);
	});

	// Go: cmd/entire/cli/help.go — hidden `--tree` flag routes to the
	// tree renderer.
	it('outputHelp() with cli.options.tree=true runs renderTree via the callback', async () => {
		setColorOverride(false);
		const { setupHelpOverride } = await import('@/cli/help');
		const messages: string[] = [];
		const origLog = console.log;
		console.log = ((...args: unknown[]) => {
			messages.push(args.map((a) => String(a)).join(' '));
		}) as typeof console.log;
		try {
			const cli = cac('story');
			registerGlobalFlags(cli);
			setupHelpOverride(cli);
			cli.command('enable', 'Enable Story CLI').action(() => {});
			(cli.options as Record<string, unknown>).tree = true;
			cli.outputHelp();
		} finally {
			console.log = origLog;
		}
		const out = stripAnsi(messages.join('\n'));
		expect(out).toContain('story');
		expect(out).toContain('enable');
		// Tree output does not include the "Global flags:" section.
		expect(out).not.toContain('Global flags:');
	});
});
