/**
 * Spinner + long-task wrapper over `@clack/prompts`. Downgrades to
 * static log lines under `--json`, `--verbose`, or when stdout is
 * not a TTY — an animated spinner is pure noise in those contexts
 * and can eat into subprocess buffers.
 *
 * Story-side UX extension — Go has no spinner usage; here we wrap
 * clack's spinner so command actions can do
 * `await withSpinner('Fetching', fetchFn)` uniformly.
 */

import * as clack from '@clack/prompts';
import { getGlobalFlags } from '@/cli/flags';
import { detectTTY } from '@/cli/tty';
import * as log from '@/log';

/** Handle returned by {@link spinner}. */
export interface SpinnerHandle {
	/** Update the displayed message. */
	message(text: string): void;
	/**
	 * Stop the spinner. `code=0` = success, any other value = error.
	 * Optional `finalText` replaces the final line.
	 */
	stop(finalText?: string, code?: number): void;
}

/**
 * Decide whether to actually animate. Spinners are only safe when
 * we're in a human-interactive TTY, not emitting JSON, and not in
 * verbose mode (verbose wants every line on a stable stream so
 * agents / ops can tail logs).
 */
function spinnerActive(): boolean {
	const flags = getGlobalFlags();
	if (flags.json || flags.verbose) {
		return false;
	}
	return detectTTY();
}

/**
 * Start a spinner with `label`. Returns a handle — the caller is
 * responsible for calling `.stop()` exactly once. When degraded
 * (json / verbose / non-TTY), the handle becomes a passive logger:
 *   - `start` → `log.info('[spinner] <label>')`
 *   - `message(text)` → `log.info('[spinner] <text>')`
 *   - `stop(final, code)` → `log.info('[spinner] <final>')` on 0,
 *     `log.warn('[spinner] <final>')` on non-zero
 *
 * @example
 * const sp = spinner('Fetching refs');
 * try {
 *   const result = await doFetch();
 *   sp.stop('Fetched');
 *   return result;
 * } catch (err) {
 *   sp.stop('Failed', 1);
 *   throw err;
 * }
 */
export function spinner(label: string): SpinnerHandle {
	if (!spinnerActive()) {
		log.info({ component: 'spinner' }, label);
		return {
			message(text: string) {
				log.info({ component: 'spinner' }, text);
			},
			stop(finalText?: string, code?: number) {
				const msg = finalText ?? label;
				if (code !== undefined && code !== 0) {
					log.warn({ component: 'spinner' }, msg);
					return;
				}
				log.info({ component: 'spinner' }, msg);
			},
		};
	}
	const handle = clack.spinner();
	handle.start(label);
	return {
		message(text: string) {
			handle.message(text);
		},
		stop(finalText?: string, code?: number) {
			handle.stop(finalText, code);
		},
	};
}

/**
 * Run `fn` while displaying a spinner labeled `label`. Resolves
 * with `fn`'s return value; rethrows any rejection after marking
 * the spinner as failed.
 *
 * @example
 * const repo = await withSpinner(
 *   'Cloning repository',
 *   (sp) => { sp.message('Resolving refs'); return clone(); },
 *   { success: 'Cloned' },
 * );
 */
export async function withSpinner<T>(
	label: string,
	fn: (sp: SpinnerHandle) => Promise<T>,
	opts?: { success?: string },
): Promise<T> {
	const sp = spinner(label);
	try {
		const result = await fn(sp);
		sp.stop(opts?.success ?? label, 0);
		return result;
	} catch (err) {
		sp.stop(label, 1);
		throw err;
	}
}
