/**
 * Global CLI flags — registration, parsing, and application.
 *
 * Story exposes 7 global flags (`--verbose`, `--no-color`, `--json`,
 * `--non-interactive`, `--yes`, `--pure`, `--log-level`). They live
 * on the root cac instance and apply uniformly to every subcommand
 * action via {@link applyGlobalFlags}.
 *
 * `--pure` is the AI-facing plain-text mode. Unlike `--json` it does
 * NOT imply `--non-interactive`; consumers (currently
 * `commands/explain.ts`) check `getGlobalFlags().pure` and decide
 * whether to swap their TUI renderer for plain text. Single-flag
 * `--pure` with no compatible companion flag is a no-op — by design,
 * AI tools must combine it with a density flag (`--full` /
 * `--page <n>` for `story explain`).
 *
 * Story-side extension — Go splits this logic across cobra
 * `PersistentFlags` + stray env reads; TS centralizes it here so UI
 * behavior stays coherent across the 18 Phase-9.1+ commands.
 */

import type { CAC } from 'cac';
import { detectCI, setForceNonInteractive } from '@/cli/tty';
import * as log from '@/log';
import { setColorOverride } from '@/ui/theme';

/** The seven global flags as they appear in `GlobalFlagsState`. */
export interface GlobalFlags {
	verbose: boolean;
	noColor: boolean;
	json: boolean;
	nonInteractive: boolean;
	yes: boolean;
	/**
	 * AI-facing plain-text output mode. Must be set explicitly; not
	 * implied by non-TTY / CI / `--json`. Consumers swap their TUI
	 * renderer for plain text when this is `true`.
	 */
	pure: boolean;
	logLevel: 'debug' | 'info' | 'warn' | 'error';
}

const DEFAULT_FLAGS: GlobalFlags = {
	verbose: false,
	noColor: false,
	json: false,
	nonInteractive: false,
	yes: false,
	pure: false,
	logLevel: 'info',
};

let state: GlobalFlags = { ...DEFAULT_FLAGS };

/**
 * Read the current global flag state. Commands call this to decide
 * whether to format for `--json`, pad with `--verbose`, etc.
 */
export function getGlobalFlags(): Readonly<GlobalFlags> {
	return state;
}

/**
 * Register the 6 global options on the root cac instance. Safe to
 * call once inside `buildCli()`. Calling twice is allowed (cac
 * appends), but not recommended.
 *
 * @example
 * const cli = cac('story');
 * registerGlobalFlags(cli);
 * // `story enable --verbose --json` now parses without error
 */
export function registerGlobalFlags(cli: CAC): void {
	cli.option('-v, --verbose', 'Increase log verbosity to debug');
	cli.option('--no-color', 'Disable ANSI color output');
	cli.option('--json', 'Emit structured JSON instead of human-readable output');
	cli.option('--non-interactive', 'Fail instead of prompting (implied by CI / --yes / --json)');
	cli.option('-y, --yes', 'Skip confirmations; destructive prompts default to safe/true');
	cli.option(
		'--pure',
		'AI-facing plain text output (no banner, no bar, no ANSI). Combine with command density / page flags.',
	);
	cli.option('--log-level <level>', 'One of: debug / info / warn / error (default: info)');
}

/**
 * Parse `cli.options` (cac populates this after `cli.parse()`) and
 * commit the derived state to all dependent modules:
 *
 *   - `log.setLevel()` — `--log-level` overrides `--verbose`
 *   - `src/ui/theme::setColorOverride(false)` on `--no-color`
 *   - `src/cli/tty::setForceNonInteractive(true)` on `--non-interactive`
 *     / `--yes` / `--json` / CI env
 *
 * Accepts both kebab-case (as cac parses CLI args) and camelCase
 * (consumer-friendly), so downstream tests can pass
 * `{ 'no-color': true }` or `{ noColor: true }` interchangeably.
 *
 * Idempotent — calling twice with the same input leaves state
 * unchanged.
 *
 * @example
 * applyGlobalFlags({ json: true, verbose: true });
 * // Side effects:
 * //   state.json=true, state.verbose=true, state.nonInteractive=true
 * //   log.setLevel('debug')       (from --verbose)
 * //   setForceNonInteractive(true) (from --json implying nonInteractive)
 * // No change to: theme color override (default unless --no-color)
 */
export function applyGlobalFlags(parsed: Record<string, unknown>): void {
	const verbose = pickBool(parsed, 'verbose');
	// cac normalizes `--no-color` to `{ color: false }`; also accept the
	// user-facing forms passed through command actions.
	const noColor = pickBool(parsed, 'no-color', 'noColor') || parsed.color === false;
	const json = pickBool(parsed, 'json');
	const nonInteractiveExplicit = pickBool(parsed, 'non-interactive', 'nonInteractive');
	const yes = pickBool(parsed, 'yes');
	// `--pure` is intentionally independent of `nonInteractive` — AI
	// scripts may want plain text + still keep prompts, e.g. for
	// confirm flows. Setting `--pure` does NOT auto-derive any other
	// flag.
	const pure = pickBool(parsed, 'pure');
	const logLevelRaw = pickString(parsed, 'log-level', 'logLevel');

	const logLevel = logLevelRaw ? log.parseLogLevel(logLevelRaw) : verbose ? 'debug' : 'info';
	const nonInteractive = nonInteractiveExplicit || json || yes || detectCI();

	state = { verbose, noColor, json, nonInteractive, yes, pure, logLevel };

	log.setLevel(logLevel);

	if (noColor) {
		setColorOverride(false);
	} else {
		setColorOverride(null);
	}

	setForceNonInteractive(nonInteractive);
}

/**
 * Test-only: reset flag state + clear all downstream module
 * overrides (theme color + tty nonInteractive). Every `beforeEach`
 * that touches flags should call this first.
 */
export function resetGlobalFlagsForTesting(): void {
	state = { ...DEFAULT_FLAGS };
	log.setLevel('info');
	setColorOverride(null);
	setForceNonInteractive(false);
}

function pickBool(parsed: Record<string, unknown>, ...keys: string[]): boolean {
	for (const key of keys) {
		const value = parsed[key];
		if (typeof value === 'boolean') {
			return value;
		}
	}
	return false;
}

function pickString(parsed: Record<string, unknown>, ...keys: string[]): string | null {
	for (const key of keys) {
		const value = parsed[key];
		if (typeof value === 'string' && value.length > 0) {
			return value;
		}
	}
	return null;
}
