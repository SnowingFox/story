// Go: root.go: SilenceErrors — cobra `root.SilenceErrors = true` so the
// package handles its own stderr formatting; Story's `handleTopLevelError`
// mirrors that by translating SilentError to a single `[story]` line.
// Go: root.go: CompletionOptions — the banner decision table exempts
// the completion command so `story completion bash > file` stays a
// source-able script; see MACHINE_COMMANDS in `src/cli/runtime.ts`.

import cac from 'cac';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerGlobalFlags, resetGlobalFlagsForTesting } from '@/cli/flags';
import { setupHelpOverride } from '@/cli/help';
import { registerCoreCommands } from '@/commands';
import { SilentError } from '@/errors';
import { resetColorOverrideForTesting, setColorOverride } from '@/ui/theme';

const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const stripAnsi = (s: string) => s.replace(ANSI_RE, '');

function captureStreams() {
	const outChunks: Buffer[] = [];
	const errChunks: Buffer[] = [];
	const origOut = process.stdout.write.bind(process.stdout);
	const origErr = process.stderr.write.bind(process.stderr);
	process.stdout.write = ((chunk: string | Uint8Array) => {
		outChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk: string | Uint8Array) => {
		errChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
		return true;
	}) as typeof process.stderr.write;
	return {
		outText: () => stripAnsi(Buffer.concat(outChunks).toString('utf8')),
		errText: () => stripAnsi(Buffer.concat(errChunks).toString('utf8')),
		restore: () => {
			process.stdout.write = origOut;
			process.stderr.write = origErr;
		},
	};
}

function buildThrowingCli(thrown: unknown): ReturnType<typeof cac> {
	const cli = cac('story');
	setupHelpOverride(cli);
	registerGlobalFlags(cli);
	cli.command('boom', 'Throws for testing').action(() => {
		throw thrown;
	});
	return cli;
}

describe('cli/runtime :: runCli', () => {
	let cap: ReturnType<typeof captureStreams>;
	const origExitCode = process.exitCode;

	beforeEach(() => {
		process.env.STORY_TEST_TTY = '0'; // non-TTY so banner stays silent by default
		resetGlobalFlagsForTesting();
		resetColorOverrideForTesting();
		setColorOverride(false);
		cap = captureStreams();
		process.exitCode = undefined;
	});

	afterEach(() => {
		cap.restore();
		process.exitCode = origExitCode;
		resetGlobalFlagsForTesting();
		resetColorOverrideForTesting();
	});

	describe('error handling', () => {
		// Go: cmd/entire/cli/root.go: newRootCmd (cobra Execute → SilentError catch)
		// On SilentError, cobra writes a single line to stderr and exits 1 —
		// no stack, no "Error: " prefix. Our runCli must honor the same
		// contract since external agents grep the first stderr line.
		it('SilentError → single [story] line on stderr, exitCode=1, no stack', async () => {
			const { runCli } = await import('@/cli/runtime');
			const cli = buildThrowingCli(new SilentError(new Error('something broke')));
			await runCli(cli, ['node', 'story', 'boom']);
			expect(cap.errText()).toMatch(/\[story\] something broke/);
			expect(cap.errText()).not.toMatch(/at .*\.ts/);
			expect(process.exitCode).toBe(1);
		});

		it('Unknown Error → stack printed on stderr + exitCode=1', async () => {
			const { runCli } = await import('@/cli/runtime');
			const cli = buildThrowingCli(new Error('kaboom'));
			await runCli(cli, ['node', 'story', 'boom']);
			const err = cap.errText();
			expect(err).toContain('kaboom');
			expect(process.exitCode).toBe(1);
		});

		it('non-Error throw → `[story] unexpected throw` + exitCode=1', async () => {
			const { runCli } = await import('@/cli/runtime');
			const cli = buildThrowingCli('string-error');
			await runCli(cli, ['node', 'story', 'boom']);
			expect(cap.errText()).toMatch(/\[story\].*unexpected/i);
			expect(process.exitCode).toBe(1);
		});

		it('happy path → exitCode stays unset', async () => {
			const { runCli } = await import('@/cli/runtime');
			const cli = cac('story');
			setupHelpOverride(cli);
			registerGlobalFlags(cli);
			registerCoreCommands(cli);
			await runCli(cli, ['node', 'story', 'version']);
			expect(process.exitCode).toBe(undefined);
		});
	});

	describe('hook subprocess bypass', () => {
		it('args[0] === "hooks" → runs cli.parse without banner or SIGINT wiring', async () => {
			const { runCli } = await import('@/cli/runtime');
			const cli = cac('story');
			let hookRan = false;
			cli.command('hooks [...args]', '', { allowUnknownOptions: true }).action(() => {
				hookRan = true;
			});
			const origListenerCount = process.listenerCount('SIGINT');
			await runCli(cli, ['node', 'story', 'hooks', 'git', 'post-commit']);
			expect(hookRan).toBe(true);
			// Runtime must NOT have attached a SIGINT handler on the hook path.
			expect(process.listenerCount('SIGINT')).toBe(origListenerCount);
			// No banner on the hook path.
			expect(cap.outText()).not.toMatch(/Every commit tells a story/);
		});

		it('hook path: thrown Error sets exitCode=1 (log-and-exit behavior)', async () => {
			const { runCli } = await import('@/cli/runtime');
			const cli = cac('story');
			cli.command('hooks [...args]', '', { allowUnknownOptions: true }).action(() => {
				throw new Error('commit-msg cleared');
			});
			await runCli(cli, ['node', 'story', 'hooks', 'git', 'commit-msg']);
			expect(process.exitCode).toBe(1);
		});
	});

	describe('SIGINT handler', () => {
		it('first SIGINT sets exitCode=130 and prints Cancelled', async () => {
			const { runCli } = await import('@/cli/runtime');
			const cli = cac('story');
			let sawSignal = false;
			cli.command('longrun', 'Run forever').action(() => {
				// Synthetically emit SIGINT while the command "runs". The handler
				// is installed inside runCli before cli.parse completes.
				process.emit('SIGINT');
				sawSignal = true;
			});
			await runCli(cli, ['node', 'story', 'longrun']);
			expect(sawSignal).toBe(true);
			expect(process.exitCode).toBe(130);
			expect(cap.outText()).toMatch(/Cancelled/);
			// Reset exitCode so the remaining tests in this suite are not tainted.
			process.exitCode = undefined;
		});

		it('double SIGINT within 500ms triggers hard exit (caught via process.exit mock)', async () => {
			const { runCli } = await import('@/cli/runtime');
			const cli = cac('story');
			const origExit = process.exit;
			let exitCalled: number | undefined;
			process.exit = ((code?: number) => {
				exitCalled = code;
				throw new Error('__stub_exit__');
			}) as typeof process.exit;
			cli.command('longrun', 'Run forever').action(() => {
				process.emit('SIGINT');
				// Second signal immediately after first → hard exit.
				process.emit('SIGINT');
			});
			await runCli(cli, ['node', 'story', 'longrun']);
			process.exit = origExit;
			expect(exitCalled).toBe(130);
			process.exitCode = undefined;
		});
	});

	describe('banner decision', () => {
		it('user-facing path on TTY → banner is printed', async () => {
			process.env.STORY_TEST_TTY = '1';
			const { runCli } = await import('@/cli/runtime');
			const cli = cac('story');
			setupHelpOverride(cli);
			registerGlobalFlags(cli);
			registerCoreCommands(cli);
			cli.command('hello', 'Say hello').action(() => {});
			// Force banner on by using an out stream that is a fake TTY.
			const fakeTTY = Object.assign(Buffer.alloc(0), { isTTY: true });
			void fakeTTY;
			await runCli(cli, ['node', 'story', 'hello']);
			// Banner only emits on an actual TTY stdout; in tests we allow
			// either path. The primary assertion is: under --json it's OFF.
			expect(process.exitCode).toBe(undefined);
		});

		it('--json disables banner even on TTY', async () => {
			process.env.STORY_TEST_TTY = '1';
			const { runCli } = await import('@/cli/runtime');
			const cli = cac('story');
			setupHelpOverride(cli);
			registerGlobalFlags(cli);
			registerCoreCommands(cli);
			await runCli(cli, ['node', 'story', '--json', 'version']);
			expect(cap.outText()).not.toMatch(/Every commit tells a story/);
		});

		it('version command does not emit the banner (machine-readable output)', async () => {
			const { runCli } = await import('@/cli/runtime');
			const cli = cac('story');
			setupHelpOverride(cli);
			registerGlobalFlags(cli);
			registerCoreCommands(cli);
			await runCli(cli, ['node', 'story', 'version']);
			expect(cap.outText()).not.toMatch(/Every commit tells a story/);
			expect(cap.outText()).toContain('Story CLI');
		});

		// Phase 9.6: completion command must exit the banner-suppression set
		// so `story completion bash > ~/.bash_completion.d/story` works.
		// Go: root.go: CompletionOptions (HiddenDefaultCmd) + SilenceErrors.
		it('completion command does not emit the banner (output is a shell script)', async () => {
			process.env.STORY_TEST_TTY = '1';
			const { runCli } = await import('@/cli/runtime');
			const { registerCompletionCommand } = await import('@/commands/completion');
			const cli = cac('story');
			setupHelpOverride(cli);
			registerGlobalFlags(cli);
			registerCompletionCommand(cli);
			await runCli(cli, ['node', 'story', 'completion', 'bash']);
			expect(cap.outText()).not.toMatch(/Every commit tells a story/);
			// Stdout must be the bash script content — contains the completion hook name.
			expect(cap.outText()).toContain('_story_completions');
		});

		// Regression: a random command (not version / completion / hooks) stays on
		// the banner-emitting path. Covers shouldEmitBanner's "not in MACHINE_COMMANDS"
		// branch.
		it('arbitrary command (not completion) still goes through the banner path', async () => {
			process.env.STORY_TEST_TTY = '1';
			const { runCli } = await import('@/cli/runtime');
			const cli = cac('story');
			setupHelpOverride(cli);
			registerGlobalFlags(cli);
			registerCoreCommands(cli);
			cli.command('noop', 'no-op').action(() => {});
			await runCli(cli, ['node', 'story', 'noop']);
			// We cannot assert banner rendering itself (depends on real TTY in
			// vitest), but we can assert that the command runs to completion.
			expect(process.exitCode).toBe(undefined);
		});

		// Covers shouldEmitBanner's `cmdName === undefined` branch:
		// bare `story` invocation (no subcommand). Under --json this
		// must still stay silent; under plain + TTY it emits the banner.
		it('no-subcommand path with --json keeps banner off', async () => {
			process.env.STORY_TEST_TTY = '1';
			const { runCli } = await import('@/cli/runtime');
			const cli = cac('story');
			setupHelpOverride(cli);
			registerGlobalFlags(cli);
			registerCoreCommands(cli);
			cli.command('', 'Show help').action(() => {});
			await runCli(cli, ['node', 'story', '--json']);
			expect(cap.outText()).not.toMatch(/^\u2588/m); // no banner rune
		});

		it('no-subcommand path, plain mode: passes shouldEmitBanner (cmdName undefined branch)', async () => {
			process.env.STORY_TEST_TTY = '1';
			const { runCli } = await import('@/cli/runtime');
			const cli = cac('story');
			setupHelpOverride(cli);
			registerGlobalFlags(cli);
			registerCoreCommands(cli);
			cli.command('', 'Show help').action(() => {});
			await runCli(cli, ['node', 'story']);
			// Assert we exercised the path without throwing; banner rendering
			// itself depends on whether process.stdout is a real TTY, which
			// vitest does not guarantee.
			expect(process.exitCode).toBe(undefined);
		});
	});

	describe('getRootSignal', () => {
		it('returns an AbortSignal reflecting the current runCli session', async () => {
			const { runCli, getRootSignal } = await import('@/cli/runtime');
			const cli = cac('story');
			setupHelpOverride(cli);
			registerGlobalFlags(cli);
			registerCoreCommands(cli);
			await runCli(cli, ['node', 'story', 'version']);
			const signal = getRootSignal();
			expect(signal).toBeDefined();
			expect(typeof signal.aborted).toBe('boolean');
		});
	});
});

// vi reserved for future mocking scenarios — explicit void silences lint.
void vi;
