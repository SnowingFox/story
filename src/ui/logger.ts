/**
 * Bar-line output renderer — the visual glue between banner
 * ({@link ./banner}), prompts ({@link ./prompts}), and command
 * actions. Every "user sees this" line flows through here.
 *
 * stdout: bar-block structure (header / step / footer / note)
 * stderr: warn / info / errorLine — matches Node + cobra conventions
 *         and keeps `--json` output cleanly separable from diagnostics.
 *
 * Under `--json`:
 *   - Bar / step / note renderers become **no-ops** (machine-readable
 *     command output owns stdout)
 *   - `warn` / `info` / `errorLine` degrade to single-line JSON on
 *     stderr, so agents can still consume diagnostics without parsing
 *     the human tree.
 */

import { getGlobalFlags } from '@/cli/flags';
import { color, S } from '@/ui/theme';

/** JSON payload emitted by warn / info / errorLine under `--json`. */
interface JsonDiag {
	level?: 'info' | 'warn';
	message?: string;
	error?: string;
}

/**
 * Print the opening bar + cyan-bold command label. First line of
 * every interactive command block.
 *
 * @example
 * header('enable');
 * // stdout (color on):
 * //   ┌  enable   ← barStart + bold-cyan label
 */
export function header(label: string): void {
	if (getGlobalFlags().json) {
		return;
	}
	process.stdout.write(`${color.gray(S.barStart)}  ${color.cyan(color.bold(label))}\n`);
}

/**
 * Print the closing bar + optional trailing message. Final line of
 * every interactive command block.
 *
 * @example
 * footer('Done.');
 * // stdout: └  Done.
 * footer();
 * // stdout: └
 */
export function footer(message?: string): void {
	if (getGlobalFlags().json) {
		return;
	}
	const gray = color.gray(S.barEnd);
	if (message === undefined) {
		process.stdout.write(`${gray}\n`);
		return;
	}
	process.stdout.write(`${gray}  ${message}\n`);
}

/**
 * Print a content line inside the bar block (`│  <content>`). Used
 * for multi-line messages or freeform output that still belongs to
 * the current block.
 */
export function barLine(content = ''): void {
	if (getGlobalFlags().json) {
		return;
	}
	const bar = color.gray(S.bar);
	if (content === '') {
		process.stdout.write(`${bar}\n`);
		return;
	}
	process.stdout.write(`${bar}  ${content}\n`);
}

/** Print a bar-only line for vertical spacing inside a block. */
export function barEmpty(): void {
	barLine('');
}

/** Print a regular step (`◇  <content>`) in cyan. */
export function step(content: string): void {
	if (getGlobalFlags().json) {
		return;
	}
	process.stdout.write(`${color.cyan(S.step)}  ${content}\n`);
}

/** Print a completed step (`●  <content>`) in green. */
export function stepDone(content: string): void {
	if (getGlobalFlags().json) {
		return;
	}
	process.stdout.write(`${color.green(S.stepDone)}  ${content}\n`);
}

/** Print an error step (`■  <content>`) in red. */
export function stepError(content: string): void {
	if (getGlobalFlags().json) {
		return;
	}
	process.stdout.write(`${color.red(S.stepError)}  ${content}\n`);
}

/**
 * Print a warning to stderr (`▲  <msg>` in yellow).
 *
 * Under `--json`: emit `{"level":"warn","message":"..."}` instead.
 */
export function warn(message: string): void {
	if (getGlobalFlags().json) {
		writeDiagJson({ level: 'warn', message });
		return;
	}
	process.stderr.write(`${color.yellow(S.warning)}  ${color.yellow(message)}\n`);
}

/**
 * Print an info line to stderr (`ℹ  <msg>` in blue).
 *
 * Under `--json`: emit `{"level":"info","message":"..."}` instead.
 */
export function info(message: string): void {
	if (getGlobalFlags().json) {
		writeDiagJson({ level: 'info', message });
		return;
	}
	process.stderr.write(`${color.blue(S.info)}  ${color.blue(message)}\n`);
}

/**
 * Print a boxed note with an optional list of body lines. Used
 * sparingly for multi-line guidance (e.g. "Next steps" after
 * `story enable`).
 *
 * @example
 * note('Next steps', ['Run `story status`', 'See .story/logs/']);
 * // ┌─ Next steps ─────────────
 * // │  Run `story status`
 * // │  See .story/logs/
 * // └──────────────────────────
 */
export function note(title: string, body?: string[]): void {
	if (getGlobalFlags().json) {
		return;
	}
	const lines = body ?? [];
	const contentWidth = Math.max(title.length, ...lines.map((l) => l.length), 20);
	const horiz = '─'.repeat(contentWidth + 2);
	process.stdout.write(
		`${color.gray(`┌─ ${color.cyan(title)} ${'─'.repeat(Math.max(0, contentWidth - title.length))}─`)}\n`,
	);
	for (const line of lines) {
		process.stdout.write(`${color.gray('│')}  ${line}\n`);
	}
	process.stdout.write(`${color.gray(`└${horiz}─`)}\n`);
}

/**
 * Emit a single terminal error line to stderr — called by the
 * top-level `SilentError` catch in {@link ../cli/runtime::runCli}.
 *
 * Plain mode: `[story] <message>` in red.
 * `--json`:   `{"error":"<message>"}` on a single line.
 *
 * @example
 * errorLine('not a git repository');
 * // stderr: [story] not a git repository   (red)
 * // Unchanged: stdout, process state
 */
export function errorLine(message: string): void {
	if (getGlobalFlags().json) {
		writeDiagJson({ error: message });
		return;
	}
	process.stderr.write(`${color.red(`[story] ${message}`)}\n`);
}

function writeDiagJson(payload: JsonDiag): void {
	process.stderr.write(`${JSON.stringify(payload)}\n`);
}
