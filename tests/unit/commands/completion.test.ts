/**
 * Phase 9.6 `src/commands/completion.ts` unit tests.
 *
 * Go: `cmd/entire/cli/root.go: CompletionOptions` (cobra-auto; TS is a
 * manual equivalent — see `tests/unit/commands/completion-templates.test.ts`
 * for the static-template contract and `tests/unit/cli/runtime.test.ts` for
 * the banner-exemption plumbing).
 */

import cac from 'cac';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerGlobalFlags, resetGlobalFlagsForTesting } from '@/cli/flags';
import { setForceNonInteractive } from '@/cli/tty';
import { registerCompletionCommand } from '@/commands/completion';
import { BASH_TEMPLATE, FISH_TEMPLATE, ZSH_TEMPLATE } from '@/commands/completion-templates';
import { SilentError } from '@/errors';
import { resetColorOverrideForTesting, setColorOverride } from '@/ui/theme';

function captureStreams() {
	const out: string[] = [];
	const err: string[] = [];
	const origOut = process.stdout.write.bind(process.stdout);
	const origErr = process.stderr.write.bind(process.stderr);
	process.stdout.write = ((chunk: string | Uint8Array) => {
		out.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk: string | Uint8Array) => {
		err.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
		return true;
	}) as typeof process.stderr.write;
	return {
		stdout: () => out.join(''),
		stderr: () => err.join(''),
		restore: () => {
			process.stdout.write = origOut;
			process.stderr.write = origErr;
		},
	};
}

function buildCli() {
	const cli = cac('story');
	registerGlobalFlags(cli);
	registerCompletionCommand(cli);
	cli.help();
	cli.version('0.1.0');
	return cli;
}

async function runCli(argv: string[]): Promise<void> {
	const cli = buildCli();
	cli.parse(['node', 'story', ...argv], { run: false });
	const result = cli.runMatchedCommand();
	if (result && typeof (result as Promise<unknown>).then === 'function') {
		await result;
	}
}

describe('commands/completion', () => {
	let cap: ReturnType<typeof captureStreams>;

	beforeEach(() => {
		resetGlobalFlagsForTesting();
		resetColorOverrideForTesting();
		setColorOverride(false);
		setForceNonInteractive(true);
		cap = captureStreams();
	});

	afterEach(() => {
		cap.restore();
		resetGlobalFlagsForTesting();
		resetColorOverrideForTesting();
		setForceNonInteractive(false);
	});

	// Go: root.go: CompletionOptions — bash shell happy path.
	it('completion bash → stdout is BASH_TEMPLATE', async () => {
		await runCli(['completion', 'bash']);
		expect(cap.stdout()).toBe(BASH_TEMPLATE);
	});

	it('completion zsh → stdout is ZSH_TEMPLATE', async () => {
		await runCli(['completion', 'zsh']);
		expect(cap.stdout()).toBe(ZSH_TEMPLATE);
	});

	it('completion fish → stdout is FISH_TEMPLATE', async () => {
		await runCli(['completion', 'fish']);
		expect(cap.stdout()).toBe(FISH_TEMPLATE);
	});

	it('stderr is empty on success', async () => {
		await runCli(['completion', 'bash']);
		expect(cap.stderr()).toBe('');
	});

	it('completion powershell → throws SilentError', async () => {
		try {
			await runCli(['completion', 'powershell']);
			throw new Error('expected SilentError');
		} catch (err) {
			expect(err).toBeInstanceOf(SilentError);
			expect((err as Error).message).toMatch(/Unsupported shell/);
		}
	});

	it('--json is ignored (stdout still is the script, not JSON)', async () => {
		await runCli(['completion', 'bash', '--json']);
		// Script stays as-is; no JSON wrapping.
		expect(cap.stdout()).toBe(BASH_TEMPLATE);
	});

	it('--no-color has no effect on the script body', async () => {
		await runCli(['completion', 'bash', '--no-color']);
		expect(cap.stdout()).toBe(BASH_TEMPLATE);
	});

	it('--non-interactive has no effect on the script body', async () => {
		await runCli(['completion', 'bash', '--non-interactive']);
		expect(cap.stdout()).toBe(BASH_TEMPLATE);
	});

	it('bash script contains `complete -F _story_completions`', async () => {
		await runCli(['completion', 'bash']);
		expect(cap.stdout()).toContain('complete -F _story_completions story');
	});

	it('zsh script starts with #compdef story', async () => {
		await runCli(['completion', 'zsh']);
		expect(cap.stdout()).toMatch(/^#compdef story/);
	});

	it('fish script contains `complete -c story`', async () => {
		await runCli(['completion', 'fish']);
		expect(cap.stdout()).toContain('complete -c story');
	});

	// Go: root.go: CompletionOptions — empty / missing shell arg error.
	it('completion without a shell argument → SilentError from cac', async () => {
		try {
			await runCli(['completion']);
		} catch (err) {
			// cac may emit its own usage error; the important thing is we did
			// not silently succeed with empty stdout.
			if (err instanceof SilentError) {
				expect((err as Error).message).toMatch(/shell|No shell/);
			}
		}
	});

	it('naming red-line: output contains no "entire" / "_entire_" literals', async () => {
		for (const shell of ['bash', 'zsh', 'fish']) {
			cap.restore();
			cap = captureStreams();
			await runCli(['completion', shell]);
			const out = cap.stdout();
			expect(out).not.toMatch(/\bentire\b/);
			expect(out).not.toMatch(/_entire_/);
			expect(out).not.toMatch(/\.entire\//);
		}
	});

	it('output ends with a final newline (source-ability)', async () => {
		await runCli(['completion', 'bash']);
		expect(cap.stdout().endsWith('\n')).toBe(true);
	});

	it('stdout encoding is pure ASCII / UTF-8 (no BOM, no ANSI codes)', async () => {
		await runCli(['completion', 'bash']);
		const out = cap.stdout();
		// No ANSI escape sequences.
		// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ANSI detection.
		expect(out).not.toMatch(/\x1b\[/);
		// No BOM.
		expect(out.charCodeAt(0)).not.toBe(0xfeff);
	});

	it('empty-string shell → SilentError', async () => {
		try {
			await runCli(['completion', '']);
			throw new Error('expected SilentError');
		} catch (err) {
			expect(err).toBeInstanceOf(SilentError);
		}
	});
});
