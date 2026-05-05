/**
 * `story completion <shell>` — print a source-able shell completion
 * script to stdout.
 *
 * Special UI rules (see [`commands/9.6-2-completion.md`](
 * ../../docs/ts-rewrite/impl/phase-9-commands/phase-9.0-setup/commands/9.6-2-completion.md)):
 *   - stdout is **pure script** (no banner, no colors, no bar blocks)
 *   - `--json` is ignored (scripts can't be JSON)
 *   - errors go to stderr + exit 1 via SilentError
 *
 * Banner suppression is handled inside
 * [`src/cli/runtime.ts`](../cli/runtime.ts) — the
 * `shouldEmitBanner(positional)` predicate adds `'completion'` to the
 * exempt set (same tier as `version` / `hooks`).
 *
 * Mirrors Go `cmd/entire/cli/root.go: CompletionOptions` (manual
 * replacement for cobra's auto-generated subcommand).
 *
 * @packageDocumentation
 */

import type { CAC } from 'cac';
import { renderCompletionScript } from '@/commands/completion-templates';
import { SilentError } from '@/errors';

/**
 * Register `story completion <shell>` on a cac instance. Call once
 * from {@link ./index::registerCoreCommands}.
 *
 * @example
 * registerCompletionCommand(cli);
 * // `story completion bash` → stdout is the bash script (no banner)
 * // `story completion powershell` → stderr + exit 1
 */
export function registerCompletionCommand(cli: CAC): void {
	cli.command('completion <shell>', 'Generate shell completion script').action((shell: string) => {
		// Synchronous action body — no I/O, no awaits. Keeping this off
		// `async` avoids the ceremonial-async footgun flagged in
		// `AGENTS.md` and lets the synchronous `SilentError` throw
		// propagate straight to `runCli`'s top-level catch.
		if (typeof shell !== 'string' || shell.trim() === '') {
			throw new SilentError(
				new Error(
					'No shell specified | Pass one of: bash, zsh, fish. | Example: story completion bash > ~/.bash_completion.d/story',
				),
			);
		}
		const script = renderCompletionScript(shell);
		process.stdout.write(script);
	});
}
