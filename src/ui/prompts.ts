/**
 * Thin wrappers over `@clack/prompts`. Each wrapper:
 *   1. Honors `--yes` / `--non-interactive` / `--json` before calling
 *      into clack. With `--yes` + default → return default; with
 *      `--non-interactive` (or no default on `--yes`) → throw
 *      `SilentError` with a helpful hint.
 *   2. Forwards to the underlying clack function when interactive.
 *   3. Translates clack's cancel symbol to a thrown
 *      `SilentError('cancelled')` so command actions don't have to
 *      re-check.
 *
 * Story-side divergence — Go's `charmbracelet/huh` ≠ @clack; the
 * wrapper names and signatures match the Go mental model (text,
 * confirm, select, multiselect, password) rather than clack's raw
 * API.
 */

import * as clack from '@clack/prompts';
import { getGlobalFlags } from '@/cli/flags';
import { requireInteractive } from '@/cli/tty';
import { SilentError } from '@/errors';

export interface TextOptions {
	message: string;
	placeholder?: string;
	defaultValue?: string;
	validate?: (value: string) => string | Error | undefined;
	signal?: AbortSignal;
}

export interface PasswordOptions {
	message: string;
	mask?: string;
	validate?: (value: string) => string | Error | undefined;
	signal?: AbortSignal;
}

export interface SelectOption<T> {
	value: T;
	label: string;
	hint?: string;
}

export interface SelectOptions<T> {
	message: string;
	options: SelectOption<T>[];
	initialValue?: T;
	signal?: AbortSignal;
}

export interface MultiSelectOptions<T> {
	message: string;
	options: SelectOption<T>[];
	initialValues?: T[];
	required?: boolean;
	signal?: AbortSignal;
}

export interface ConfirmOptions {
	message: string;
	initialValue?: boolean;
	/**
	 * Value returned under `--yes` without prompting. Defaults to
	 * `true` (the typical "proceed" default); pass `false` for
	 * destructive confirms so `--yes` keeps the safe answer.
	 */
	yesDefault?: boolean;
	signal?: AbortSignal;
}

/**
 * Prompt for free-form text. Supports `--yes` via `defaultValue`
 * fallback; throws `SilentError` with the message text under
 * `--non-interactive` without a default.
 */
export async function text(opts: TextOptions): Promise<string> {
	const flags = getGlobalFlags();
	if (flags.yes) {
		if (opts.defaultValue !== undefined) {
			return opts.defaultValue;
		}
		throw new SilentError(new Error(`"${opts.message}" requires a value in non-interactive mode`));
	}
	if (flags.nonInteractive) {
		requireInteractive(`provide a value for "${opts.message}" via CLI flags`);
	}
	const result = await clack.text(opts);
	return unwrapStringResult(result);
}

/** Prompt for a secret (no echo). Same --yes / --non-interactive rules. */
export async function password(opts: PasswordOptions): Promise<string> {
	const flags = getGlobalFlags();
	if (flags.nonInteractive || flags.yes) {
		requireInteractive(`"${opts.message}" cannot be answered non-interactively`);
	}
	const result = await clack.password(opts);
	return unwrapStringResult(result);
}

/**
 * Prompt for one choice from a list. Under `--yes` + `initialValue`
 * the initial is returned; without `initialValue`, throws.
 */
export async function select<T>(opts: SelectOptions<T>): Promise<T> {
	const flags = getGlobalFlags();
	if (flags.yes) {
		if (opts.initialValue !== undefined) {
			return opts.initialValue;
		}
		throw new SilentError(
			new Error(`"${opts.message}" requires an initial value in non-interactive mode`),
		);
	}
	if (flags.nonInteractive) {
		requireInteractive(`pick a value for "${opts.message}" via CLI flags`);
	}
	const result = await clack.select({
		message: opts.message,
		// clack's Option<T> is a conditional type branching on
		// `T extends Primitive`; both branches accept `label: string`, so
		// cast through unknown to bridge the distributive-conditional gap.
		options: opts.options.map(toClackOption) as unknown as Parameters<
			typeof clack.select<T>
		>[0]['options'],
		initialValue: opts.initialValue,
	});
	return unwrapValueResult<T>(result);
}

/**
 * Prompt for multiple choices. Under `--yes` + `initialValues`
 * returns the initial array; otherwise throws.
 */
export async function multiselect<T>(opts: MultiSelectOptions<T>): Promise<T[]> {
	const flags = getGlobalFlags();
	if (flags.yes) {
		if (opts.initialValues !== undefined) {
			return opts.initialValues;
		}
		throw new SilentError(
			new Error(`"${opts.message}" requires initial values in non-interactive mode`),
		);
	}
	if (flags.nonInteractive) {
		requireInteractive(`pick values for "${opts.message}" via CLI flags`);
	}
	const result = await clack.multiselect({
		message: opts.message,
		options: opts.options.map(toClackOption) as unknown as Parameters<
			typeof clack.multiselect<T>
		>[0]['options'],
		initialValues: opts.initialValues,
		required: opts.required,
	});
	return unwrapArrayResult<T>(result);
}

/**
 * Prompt for yes/no. Under `--yes`, returns `yesDefault ?? true`
 * without prompting; under `--non-interactive` without `--yes`,
 * throws so the caller provides an explicit flag.
 *
 * @example
 * await confirm({ message: 'Proceed?' });
 * // Interactive: prompts, returns user choice.
 * // --yes:        returns true (default yesDefault).
 * // --yes, yesDefault: false: returns false (destructive default).
 * // --non-interactive without --yes: throws SilentError.
 */
export async function confirm(opts: ConfirmOptions): Promise<boolean> {
	const flags = getGlobalFlags();
	if (flags.yes) {
		return opts.yesDefault ?? true;
	}
	if (flags.nonInteractive) {
		requireInteractive(`pass --yes to accept "${opts.message}" non-interactively`);
	}
	const initialValue =
		opts.initialValue !== undefined
			? opts.initialValue
			: opts.yesDefault !== undefined
				? opts.yesDefault
				: true;
	const result = await clack.confirm({
		message: opts.message,
		initialValue,
	});
	if (clack.isCancel(result)) {
		throw new SilentError(new Error('cancelled'));
	}
	return result as boolean;
}

function toClackOption<T>(o: SelectOption<T>): { value: T; label: string; hint?: string } {
	if (o.hint !== undefined) {
		return { value: o.value, label: o.label, hint: o.hint };
	}
	return { value: o.value, label: o.label };
}

function unwrapStringResult(result: unknown): string {
	if (clack.isCancel(result)) {
		throw new SilentError(new Error('cancelled'));
	}
	return result as string;
}

function unwrapValueResult<T>(result: unknown): T {
	if (clack.isCancel(result)) {
		throw new SilentError(new Error('cancelled'));
	}
	return result as T;
}

function unwrapArrayResult<T>(result: unknown): T[] {
	if (clack.isCancel(result)) {
		throw new SilentError(new Error('cancelled'));
	}
	return result as T[];
}
