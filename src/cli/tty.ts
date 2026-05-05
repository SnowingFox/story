/**
 * TTY + CI detection and the `requireInteractive` guard.
 *
 * Sits one layer above [`src/git.ts::hasTTY`](../git.ts) — the low-level
 * probe (which already handles agent env overrides + `/dev/tty` opening)
 * is reused verbatim; this module adds CI-env awareness and a
 * `--non-interactive` override that `src/cli/flags.ts` toggles.
 *
 * Mirrors the conceptual split in Go: `paths/tty.go: HasTTY` is the
 * bottom layer (shipped in Phase 1.3), and cobra dispatches use it
 * plus ad-hoc CI env reads for the "should we prompt?" decision. The
 * TS version centralizes those reads here so command actions call a
 * single `requireInteractive(hint)` helper.
 */

import { SilentError } from '@/errors';
import { hasTTY } from '@/git';

/**
 * CI environment variables we detect (union). The list matches
 * mainstream CI providers and `ci-info`'s popular-CI set. Each entry
 * only needs a non-empty value to count as "CI".
 */
const CI_ENV_KEYS = [
	'CI',
	'GITHUB_ACTIONS',
	'BUILDKITE',
	'CIRCLECI',
	'GITLAB_CI',
	'TF_BUILD',
	'JENKINS_URL',
	'TEAMCITY_VERSION',
	'DRONE',
	'APPVEYOR',
	'BITBUCKET_BUILD_NUMBER',
] as const;

/**
 * Override flag flipped on by `cli/flags.ts` when the user passes
 * `--non-interactive` / `--yes` / `--json` (the latter two imply
 * non-interactive). Kept as module state — not global — so tests can
 * flip it back without touching process.env.
 */
let forceNonInteractive = false;

/**
 * Flip the force-non-interactive override. Called by
 * {@link ../cli/flags::applyGlobalFlags}; tests call it directly to
 * simulate `--yes` / `--non-interactive`.
 */
export function setForceNonInteractive(value: boolean): void {
	forceNonInteractive = value;
}

/**
 * True when the current process has a terminal on all three of stdin,
 * stdout, stderr. Delegates to {@link ../git::hasTTY}, which also
 * honors `STORY_TEST_TTY` / agent env overrides and attempts a
 * `/dev/tty` open as the final signal.
 *
 * @example
 * detectTTY();
 * // returns: true  (interactive shell, TTY probe succeeded)
 * // Side effects: opens+closes /dev/tty once per call (via hasTTY)
 */
export function detectTTY(): boolean {
	return hasTTY();
}

/**
 * True when any known CI environment variable is set to a non-empty
 * value. Matches the union in {@link CI_ENV_KEYS} — covers GitHub
 * Actions, GitLab, CircleCI, Buildkite, Azure DevOps, Jenkins,
 * TeamCity, Drone, AppVeyor, Bitbucket Pipelines, plus the generic
 * `CI` variable.
 *
 * @example
 * detectCI();
 * // GITHUB_ACTIONS=true → true
 * // CI=""                → false  (empty string treated as not set)
 * // nothing set          → false
 */
export function detectCI(): boolean {
	for (const key of CI_ENV_KEYS) {
		const value = process.env[key];
		if (value !== undefined && value !== '') {
			return true;
		}
	}
	return false;
}

/**
 * True when the environment supports interactive prompts: we have a
 * TTY, we're not in CI, and the user did not explicitly opt out via
 * `--non-interactive` / `--yes` / `--json`.
 *
 * CI environments return false even with a TTY — CI runners often
 * allocate a pty but prompts still deadlock the pipeline. Users who
 * want to force-prompt in CI should `unset CI GITHUB_ACTIONS ...`.
 *
 * @example
 * isInteractive();
 * // TTY on, no CI, no --non-interactive → true
 * // TTY on, CI=true                     → false
 * // TTY off                             → false
 */
export function isInteractive(): boolean {
	if (forceNonInteractive) {
		return false;
	}
	if (!detectTTY()) {
		return false;
	}
	if (detectCI()) {
		return false;
	}
	return true;
}

/**
 * Guard: throws `SilentError` when the environment is not interactive.
 * Call before any `src/ui/prompts.ts` invocation that has no `--yes`
 * / default-value fallback.
 *
 * The thrown `SilentError.message` includes the caller-supplied
 * `hint` so the top-level catch in `src/cli/runtime.ts` can show a
 * single actionable line (e.g.
 * `"cannot prompt in non-interactive mode — pass --yes or --agent <name>"`).
 *
 * @example
 * requireInteractive('pass --yes or --agent <name>');
 * // Side effects: none on success (pure guard)
 * // On failure (CI / --json / --non-interactive / no TTY):
 * //   throws SilentError("cannot prompt in non-interactive mode — pass --yes or --agent <name>")
 */
export function requireInteractive(hint: string): void {
	if (isInteractive()) {
		return;
	}
	throw new SilentError(new Error(`cannot prompt in non-interactive mode — ${hint}`));
}
