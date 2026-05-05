/**
 * Centralized UI theme: the `S` symbol table + the `color` palette.
 * Every other `src/ui/` / `src/cli/` / `src/commands/` module imports
 * colors and symbols from here — **never** from picocolors directly.
 *
 * Rationale: one place to apply `--no-color`, one place to audit
 * Story-side brand colors, one place to swap the palette if we ever
 * move off picocolors. `src/ui/banner.ts` is the one exception — it
 * emits raw RGB escape sequences for the gradient, which picocolors
 * doesn't expose.
 */

import pc from 'picocolors';

/**
 * A forced-on palette built at module load via `pc.createColors(true)`.
 * Lets us emit ANSI even in environments where `pc.isColorSupported`
 * is `false` (e.g. vitest under a piped stdout), so long as the user
 * / caller explicitly opts in via {@link setColorOverride}`(true)`.
 */
const pcOn = pc.createColors(true);

/**
 * Bar-line + step symbol table. Characters are byte-equal to
 * `@clack/prompts` defaults so that our custom `header`/`step`
 * output interleaves with @clack prompt renders without visual
 * seams. See module.md §UI 风格定稿 for the full table + color
 * bindings.
 */
export const S = Object.freeze({
	/** Block body: every line inside a bar block starts with this. */
	bar: '│',
	/** Block start: paired with the command label on the same line. */
	barStart: '┌',
	/** Block end: paired with the final message on the same line. */
	barEnd: '└',
	/** Regular step heading (e.g. "Repository detected"). */
	step: '◇',
	/** Active prompt heading (awaiting user input). */
	stepActive: '◆',
	/** Completed step (e.g. "Installed 5 git hooks"). */
	stepDone: '●',
	/** Error step (e.g. "Not a git repository"). */
	stepError: '■',
	/** Cancelled / inactive option. */
	stepCancel: '○',
	/** Warning line. */
	warning: '▲',
	/** Info line. */
	info: 'ℹ',
});

/**
 * Color override: `null` = fall through to `pc.isColorSupported`,
 * `true`/`false` = forced on/off. `src/cli/flags.ts` flips this
 * from {@link applyGlobalFlags} when the user passes `--no-color`;
 * tests use {@link setColorOverride} / {@link resetColorOverrideForTesting}.
 */
let colorOverride: boolean | null = null;

/**
 * Force color on or off. Called by {@link ../cli/flags::applyGlobalFlags}
 * so runtime `--no-color` disables picocolors even though the library
 * caches `isColorSupported` at module load time.
 *
 * @example
 * setColorOverride(false);  // --no-color path
 * color.cyan('x');          // returns 'x' (no ANSI)
 */
export function setColorOverride(value: boolean | null): void {
	colorOverride = value;
}

/** Test helper: clear the override so reads fall back to picocolors. */
export function resetColorOverrideForTesting(): void {
	colorOverride = null;
}

/**
 * True when ANSI colors should be emitted. Honors `--no-color` (via
 * {@link setColorOverride}), then falls back to `pc.isColorSupported`
 * (which itself respects `NO_COLOR` / `FORCE_COLOR` / TTY detection).
 */
export function isColorEnabled(): boolean {
	if (colorOverride !== null) {
		return colorOverride;
	}
	return pc.isColorSupported;
}

/**
 * Route a color function through {@link isColorEnabled}. When colors
 * are disabled (`--no-color` / non-TTY), return the payload unchanged.
 * When enabled, use the forced-on palette built from
 * `pc.createColors(true)` so ANSI is emitted even if picocolors'
 * cached `pc.isColorSupported` is `false`.
 */
type ColorFn = (s: string) => string;

function guarded(key: keyof typeof pcOn): ColorFn {
	const fn = pcOn[key] as ColorFn;
	return (s: string): string => (isColorEnabled() ? fn(s) : s);
}

/**
 * Story CLI color palette. Each function is a `picocolors` pass-through
 * guarded by {@link isColorEnabled}. Downstream modules use these
 * wrappers exclusively — never `pc.*` directly — so runtime flag
 * changes stay consistent.
 */
export const color = Object.freeze({
	/** Brand / command headers (the only bold+color combo). */
	cyan: guarded('cyan'),
	/** Bar / border. */
	gray: guarded('gray'),
	/** Secondary text / hints / paths. */
	dim: guarded('dim'),
	/** Success. */
	green: guarded('green'),
	/** Warning. */
	yellow: guarded('yellow'),
	/** Error / destructive. */
	red: guarded('red'),
	/** Info. */
	blue: guarded('blue'),
	/** Emphasis (usually combined with cyan for headers). */
	bold: guarded('bold'),
});
