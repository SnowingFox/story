/**
 * Barrel for the `src/ui/` subsystem. Downstream modules should
 * import from `@/ui` rather than reaching into individual files,
 * so we can later reshape the internal layout without churn.
 *
 * ```ts
 * import { header, step, stepDone, banner, confirm } from '@/ui';
 * ```
 *
 * `theme.ts` is not re-exported wholesale — `S` and `color` are
 * available via explicit re-export below, but
 * `setColorOverride` / `resetColorOverrideForTesting` intentionally
 * stay behind `@/ui/theme` to keep flag-driven state plumbing
 * centralized.
 */

export { BANNER_LINES, banner, GRADIENT, rgb } from './banner';
export {
	barEmpty,
	barLine,
	errorLine,
	footer,
	header,
	info,
	note,
	step,
	stepDone,
	stepError,
	warn,
} from './logger';
export {
	type ConfirmOptions,
	confirm,
	type MultiSelectOptions,
	multiselect,
	type PasswordOptions,
	password,
	type SelectOption,
	type SelectOptions,
	select,
	type TextOptions,
	text,
} from './prompts';
export { type SpinnerHandle, spinner, withSpinner } from './spinner';
export { color, S } from './theme';
