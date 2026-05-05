/**
 * ASCII banner for Story CLI — a 6-row block-art "STORY" with a
 * sky-cyan gradient. The tagline lives in {@link ../cli/help::renderRootHelp}
 * under "Story CLI" so help views are not redundant with the logo block.
 *
 * Story-side UX extension — Go has no banner output. Silent on the
 * four paths module.md requires:
 *
 *   1. stdout is not a TTY (piped / redirected)
 *   2. `--json` global flag is active
 *   3. Any hook subprocess path (caller decides via `force=false`
 *      and the non-TTY detection above)
 *   4. `--no-color` keeps the art but drops all ANSI — the Unicode
 *      block chars still render fine on any modern terminal
 */

import { getGlobalFlags } from '@/cli/flags';
import { isColorEnabled } from '@/ui/theme';

/**
 * Block-art rendering of "STORY" (6 rows × ~50 columns). Chosen font
 * matches the `plugins` example in `npx-plugins.js` for consistent
 * Story-brand aesthetics.
 */
export const BANNER_LINES: readonly string[] = Object.freeze([
	' ██████╗████████╗ ██████╗ ██████╗ ██╗   ██╗',
	'██╔════╝╚══██╔══╝██╔═══██╗██╔══██╗╚██╗ ██╔╝',
	'╚█████╗    ██║   ██║   ██║██████╔╝ ╚████╔╝ ',
	' ╚═══██╗   ██║   ██║   ██║██╔══██╗  ╚██╔╝  ',
	'██████╔╝   ██║   ╚██████╔╝██║  ██║   ██║   ',
	'╚═════╝    ╚═╝    ╚═════╝ ╚═╝  ╚═╝   ╚═╝   ',
]);

/**
 * Row-by-row RGB gradient (6 entries, one per row). Soft sky-cyan
 * ramp — mid-dark at top, bright highlight mid-way, settling back
 * to mid-bright. Designed to read cleanly on both dark and light
 * terminal themes without stepping into neon territory.
 */
export const GRADIENT: readonly (readonly [number, number, number])[] = Object.freeze([
	[84, 167, 205],
	[96, 191, 224],
	[116, 211, 242],
	[148, 223, 248],
	[116, 211, 242],
	[96, 191, 224],
] as const);

const RESET = '\x1B[0m';

/**
 * Return the ANSI 24-bit color prefix `\x1B[38;2;R;G;Bm` when colors
 * are enabled; otherwise return the empty string so the caller can
 * concatenate unconditionally.
 *
 * @example
 * rgb(120, 220, 250);
 * // isColorEnabled() = true  → '\x1B[38;2;120;220;250m'
 * // isColorEnabled() = false → ''
 */
export function rgb(r: number, g: number, b: number): string {
	if (!isColorEnabled()) {
		return '';
	}
	return `\x1B[38;2;${r};${g};${b}m`;
}

/**
 * Print the Story banner to `out` (defaults to `process.stdout`).
 *
 * Decision:
 * - `getGlobalFlags().json === true` → never print (machine output)
 * - `force === true` → print unconditionally (help / version intent)
 * - `force === false` and `out` is a TTY → print
 * - `force === false` and `out` is piped → skip (no visual pollution)
 *
 * @example
 * banner();
 * // Side effects:
 * //   writes 6 art lines + one trailing blank line to process.stdout
 * // Unchanged: stderr, git refs, disk, session state
 *
 * banner(process.stdout, false);  // pipe-safe
 * // If `story` is invoked as `story --help | less`, this is a no-op.
 */
export function banner(out: NodeJS.WritableStream = process.stdout, force = false): void {
	if (getGlobalFlags().json) {
		return;
	}
	if (!force && !isWritableTTY(out)) {
		return;
	}

	for (let i = 0; i < BANNER_LINES.length; i++) {
		const line = BANNER_LINES[i];
		const tint = GRADIENT[i];
		if (line === undefined || tint === undefined) {
			continue;
		}
		const [r, g, b] = tint;
		const prefix = rgb(r, g, b);
		const suffix = prefix === '' ? '' : RESET;
		out.write(`${prefix}${line}${suffix}\n`);
	}
	out.write('\n');
}

function isWritableTTY(out: NodeJS.WritableStream): boolean {
	return (out as unknown as { isTTY?: boolean }).isTTY === true;
}
