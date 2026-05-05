/**
 * CLI process entry point. `src/cli.ts`'s `run()` delegates here
 * after `buildCli()` wires up commands; all stateful concerns
 * (global flag application, banner decision, SIGINT handling, and
 * top-level error catching) live in this module.
 *
 * The four responsibilities:
 *   1. **Hook bypass**: when `argv[0] === 'hooks'` the subprocess
 *      path runs `cli.parse` immediately — no banner, no SIGINT
 *      handler, no UI flag application. Matches the Phase 8
 *      contract (hooks are driven by git / agent CLIs and must
 *      never pollute their stdout with framing).
 *   2. **Global flags**: `applyGlobalFlags(cli.options)` once at
 *      entry (for flags consumed before any subcommand action, e.g.
 *      banner decision), and each command action calls it again on
 *      its own options since cac's flag parsing happens inside
 *      `cli.parse`.
 *   3. **Banner**: printed only when the resolved command is
 *      user-facing + stdout is a TTY + `--json` is off + the
 *      command isn't `version` (machine-readable contract).
 *   4. **Top-level catch**: `SilentError` → single red line; other
 *      `Error` → stack; non-Error throw → `[story] unexpected`.
 *      Exit code via `process.exitCode` so stdout/stderr drain
 *      cleanly; SIGINT on second press is the only hard `exit()`.
 */

import type { CAC } from 'cac';
import { applyGlobalFlags, getGlobalFlags } from '@/cli/flags';
import { SilentError } from '@/errors';
import { banner } from '@/ui/banner';
import { errorLine, footer, stepError } from '@/ui/logger';
import { color, S } from '@/ui/theme';

/**
 * Commands that stay machine-readable by contract — no banner ever,
 * even on an interactive TTY. Mirrors the decision table in
 * module.md.
 *
 * `completion` is in here because stdout must be a source-able shell
 * script — any banner / ANSI noise would render the script unusable.
 * See Phase 9.6 [`commands/9.6-2-completion.md`](
 * ../../docs/ts-rewrite/impl/phase-9-commands/phase-9.0-setup/commands/9.6-2-completion.md).
 *
 * Go: `root.go: CompletionOptions` (cobra auto-registers `completion`
 * with `HiddenDefaultCmd`; Story TS flags it here instead).
 */
const MACHINE_COMMANDS = new Set(['version', 'completion']);

/** Per-process abort controller; every @clack prompt inherits its signal. */
let rootController: AbortController = new AbortController();

/** Return the signal currently backing `runCli`; used by `src/ui/prompts.ts`. */
export function getRootSignal(): AbortSignal {
	return rootController.signal;
}

/**
 * Entrypoint from `src/cli.ts::run()`.
 *
 * @example
 * // src/cli.ts
 * export async function run(argv?: string[]) {
 *   const cli = buildCli();
 *   await discoverAndRegister();
 *   await runCli(cli, argv);
 * }
 *
 * // Side effects on the interactive happy path:
 * //   process.stdout  ← banner + bar block (if user-facing + TTY)
 * //   process.stderr  ← nothing on success
 * // Side effects on failure:
 * //   process.exitCode set to 1 (never process.exit, except SIGINT×2)
 */
export async function runCli(cli: CAC, argv?: string[]): Promise<void> {
	const effectiveArgv = argv ?? process.argv;
	const positional = effectiveArgv.slice(2);

	// Hook subprocess bypass: skip all UI + signal setup.
	if (positional[0] === 'hooks') {
		try {
			cli.parse(effectiveArgv);
			// cac's action may return a Promise; flush the microtask queue.
			await Promise.resolve();
		} catch (err) {
			// Hooks swallow errors (log was done inside hooks-git.ts /
			// hooks-agent.ts). Set exitCode so commit-msg failures still
			// propagate through git.
			if (err instanceof Error) {
				process.exitCode = 1;
			}
		}
		return;
	}

	rootController = new AbortController();
	const sigintHandler = installSigintHandler();

	try {
		// Apply defaults before parse so banner() sees the right --json flag
		// when the user passed it. cac hasn't parsed yet, so this is a no-op
		// unless callers have pre-applied flags; each action still calls
		// applyGlobalFlags on its own resolved options.
		applyGlobalFlags(cli.options);

		if (shouldEmitBanner(positional)) {
			banner(process.stdout, false);
		}

		cli.parse(effectiveArgv, { run: false });
		// Await the matched command's action so async `SilentError` / `Error`
		// throws propagate to our top-level catch (rather than surfacing as
		// `unhandledRejection` and printing a raw stack on stderr).
		const matchResult = cli.runMatchedCommand();
		if (matchResult && typeof (matchResult as Promise<unknown>).then === 'function') {
			await matchResult;
		}
	} catch (err) {
		handleTopLevelError(err);
	} finally {
		process.off('SIGINT', sigintHandler);
	}
}

function shouldEmitBanner(positional: string[]): boolean {
	if (getGlobalFlags().json) {
		return false;
	}
	const cmdName = positional[0];
	if (cmdName !== undefined && MACHINE_COMMANDS.has(cmdName)) {
		return false;
	}
	// Hidden helper `story enable git-hook` — automation-only, minimal output.
	if (cmdName === 'enable' && positional[1] === 'git-hook') {
		return false;
	}
	return true;
}

/**
 * Translate a thrown value into a user-facing diagnostic + exit code.
 * Never rethrows; the top-level `await runCli(...)` returns cleanly.
 */
function handleTopLevelError(err: unknown): void {
	if (err instanceof SilentError) {
		errorLine(err.message);
		process.exitCode = 1;
		return;
	}
	if (err instanceof Error) {
		process.stderr.write(`${err.stack ?? err.message}\n`);
		process.exitCode = 1;
		return;
	}
	process.stderr.write(`${color.red('[story] unexpected throw:')} ${String(err)}\n`);
	process.exitCode = 1;
}

let lastSigintAt = 0;
const SIGINT_DOUBLE_MS = 500;

function installSigintHandler(): () => void {
	const handler = () => {
		const now = Date.now();
		if (now - lastSigintAt < SIGINT_DOUBLE_MS) {
			process.stderr.write(`${color.gray(S.stepCancel)}  ${color.red('force exit')}\n`);
			// Hard exit on double press — user wants out NOW.
			process.exit(130);
		}
		lastSigintAt = now;
		rootController.abort();
		process.stdout.write(`${color.gray(S.stepCancel)}  ${color.dim('Cancelled')}\n`);
		// Close any half-rendered block.
		footer();
		void stepError; // keep import live for tree-shakers; used by actions
		process.exitCode = 130;
	};
	process.on('SIGINT', handler);
	return handler;
}
