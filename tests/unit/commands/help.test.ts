// Go: help.go: NewHelpCmd — the `story help [cmd]` command routes
// through cobra's help renderer; Story's TS `commands/help.ts`
// delegates to `renderHelp` / `renderTree` via `registerHelpCommand`.
// Cases below assert the delegation surface (no-arg → root,
// cmd-name → per-command, --tree → tree).

import cac from 'cac';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerGlobalFlags, resetGlobalFlagsForTesting } from '@/cli/flags';
import { setupHelpOverride } from '@/cli/help';
import { registerHelpCommand } from '@/commands/help';
import { resetColorOverrideForTesting, setColorOverride } from '@/ui/theme';

const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const stripAnsi = (s: string) => s.replace(ANSI_RE, '');

function captureStdout() {
	const chunks: Buffer[] = [];
	const orig = process.stdout.write.bind(process.stdout);
	process.stdout.write = ((chunk: string | Uint8Array) => {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
		return true;
	}) as typeof process.stdout.write;
	return {
		text: () => stripAnsi(Buffer.concat(chunks).toString('utf8')),
		restore: () => {
			process.stdout.write = orig;
		},
	};
}

function buildCli(): ReturnType<typeof cac> {
	const cli = cac('story');
	setupHelpOverride(cli);
	registerGlobalFlags(cli);
	registerHelpCommand(cli);
	cli.command('enable', 'Enable Story CLI').action(() => {});
	cli.command('status', 'Show status').action(() => {});
	cli.command('hooks [...args]', '', { allowUnknownOptions: true }).action(() => {});
	return cli;
}

// Go: cmd/entire/cli/help.go: newHelpCmd — the `story help [cmd]` command
// routes through cobra's help renderer; our TS version delegates to
// renderHelp / renderTree via registerHelpCommand. These cases assert the
// delegation surface (no-arg → root, cmd-name → per-command, --tree → tree).
describe('commands/help', () => {
	let cap: ReturnType<typeof captureStdout>;

	beforeEach(() => {
		resetGlobalFlagsForTesting();
		resetColorOverrideForTesting();
		setColorOverride(false);
		cap = captureStdout();
	});

	afterEach(() => {
		cap.restore();
		resetGlobalFlagsForTesting();
		resetColorOverrideForTesting();
	});

	it('no arg → prints top-level help', () => {
		const cli = buildCli();
		cli.parse(['node', 'story', 'help']);
		const text = cap.text();
		expect(text).toContain('Story CLI');
		expect(text).toContain('Usage:');
		expect(text).toContain('enable');
		expect(text).toContain('status');
	});

	it('with command name → prints command detail', () => {
		const cli = buildCli();
		cli.parse(['node', 'story', 'help', 'enable']);
		const text = cap.text();
		expect(text).toContain('story enable');
		expect(text).toContain('Enable Story CLI');
	});

	it('--tree → prints the command tree', () => {
		const cli = buildCli();
		cli.parse(['node', 'story', 'help', '--tree']);
		const text = cap.text();
		expect(text).toContain('story');
		expect(text).toContain('enable');
		expect(text).toContain('status');
		// Hidden commands excluded.
		expect(text).not.toContain('hooks');
	});
});
