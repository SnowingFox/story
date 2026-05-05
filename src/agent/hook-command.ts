/**
 * Hook command wrappers + missing-CLI warning. Builds shell snippets that
 * gracefully handle the case where the Story CLI is missing from PATH.
 *
 * **Story-side rebrand**: warning text says "Story" not "Entire"; binary
 * detection is `command -v story`. The wrap output strings are passed
 * directly to agent hook configurations (Phase 8) so the brand must match
 * what the user installs.
 *
 * Mirrors Go `cmd/entire/cli/agent/hook_command.go` (rebranded).
 *
 * @packageDocumentation
 */

const STORY_DOCS_INSTALL_URL = 'https://docs.story.io/cli/installation#installation-methods';
// NOTE: Story docs domain is a product-owned decision; keep `STORY_DOCS_INSTALL_URL`
// + its 3 referencing tests (`tests/unit/agent/hook-command.test.ts`) in sync if
// the domain ever changes pre- / post-GA. Phase 9.1 audit reviewed the current
// value — no change required.

/** Single-line warning. Mirrors Go `agent.WarningFormatSingleLine = iota+1 = 1`. */
export const WARNING_FORMAT_SINGLE_LINE = 1 as const;
/** Multi-line warning. Mirrors Go `agent.WarningFormatMultiLine = 2`. */
export const WARNING_FORMAT_MULTI_LINE = 2 as const;

export type WarningFormat = typeof WARNING_FORMAT_SINGLE_LINE | typeof WARNING_FORMAT_MULTI_LINE;

/**
 * Warning text shown when the Story CLI is missing from PATH but tracking
 * is enabled. Mirrors Go `agent.MissingEntireWarning` with brand changed
 * `Entire` → `Story`. Unknown formats fall back to single-line (matches
 * Go default branch).
 *
 * @example
 * missingStoryWarning(WARNING_FORMAT_SINGLE_LINE);
 * // returns: 'Powered by Story: Tracking is enabled, but the Story CLI is not installed or not on PATH. Installation guide: https://docs.story.io/cli/installation#installation-methods'
 *
 * missingStoryWarning(WARNING_FORMAT_MULTI_LINE);
 * // returns: '\n\nPowered by Story:\n  Tracking is enabled, but the Story CLI is not installed or not on PATH.\n  Installation guide: ...'
 *
 * // Side effects: none — pure function.
 */
export function missingStoryWarning(format: WarningFormat): string {
	if (format === WARNING_FORMAT_MULTI_LINE) {
		return (
			`\n\nPowered by Story:\n` +
			`  Tracking is enabled, but the Story CLI is not installed or not on PATH.\n` +
			`  Installation guide: ${STORY_DOCS_INSTALL_URL}`
		);
	}
	// Default to single-line (matches Go default branch).
	return (
		`Powered by Story: Tracking is enabled, but the Story CLI is not installed or not on PATH. ` +
		`Installation guide: ${STORY_DOCS_INSTALL_URL}`
	);
}

/**
 * Wrap an agent hook command so it exits silently (exit 0) when the Story
 * CLI is missing from PATH. Used for hooks where output to stdout/stderr
 * would interfere with the agent's protocol.
 *
 * Mirrors Go `agent.WrapProductionSilentHookCommand`.
 *
 * @example
 * wrapProductionSilentHookCommand('story hooks claude-code stop');
 * // returns: `sh -c 'if ! command -v story >/dev/null 2>&1; then exit 0; fi; exec story hooks claude-code stop'`
 */
export function wrapProductionSilentHookCommand(command: string): string {
	return `sh -c 'if ! command -v story >/dev/null 2>&1; then exit 0; fi; exec ${command}'`;
}

/**
 * Wrap a hook command so it emits a JSON `{ "systemMessage": "..." }`
 * payload to stdout when the Story CLI is missing. Used for agents that
 * support structured hook responses (Claude Code).
 *
 * Mirrors Go `agent.WrapProductionJSONWarningHookCommand`. The `shellQuote`
 * helper produces a Go `%q`-equivalent double-quoted string with `\"` and
 * `\\` escapes — matches Go `hook_command.go:51` which uses `%q` to embed
 * the JSON payload inside the outer `sh -c '...'`.
 */
export function wrapProductionJSONWarningHookCommand(
	command: string,
	format: WarningFormat,
): string {
	const payload = JSON.stringify({ systemMessage: missingStoryWarning(format) });
	return (
		`sh -c 'if ! command -v story >/dev/null 2>&1; then ` +
		`printf "%s\\n" ${shellQuote(payload)}; exit 0; fi; exec ${command}'`
	);
}

/**
 * Wrap a hook command so it emits a plain-text warning to stdout when the
 * Story CLI is missing. Used for agents without structured hook responses
 * (Cursor, external plugins that return plain text, etc.).
 *
 * Mirrors Go `agent.WrapProductionPlainTextWarningHookCommand`.
 */
export function wrapProductionPlainTextWarningHookCommand(
	command: string,
	format: WarningFormat,
): string {
	return (
		`sh -c 'if ! command -v story >/dev/null 2>&1; then ` +
		`printf "%s\\n" ${shellQuote(missingStoryWarning(format))}; exit 0; fi; exec ${command}'`
	);
}

const PRODUCTION_HOOK_WRAPPER_PREFIX = `sh -c 'if ! command -v story >/dev/null 2>&1; then `;
const WRAPPER_EXEC_SENTINEL = '; fi; exec ';

/**
 * Whether `command` is a Story-managed hook command — either a direct
 * `story ...` invocation (matches one of `prefixes`) OR one of the
 * production wrappers that exec a `story ...` command.
 *
 * Used by Phase 8 hook installer to detect / replace pre-existing Story
 * hooks (vs untouched user-defined hooks).
 *
 * Mirrors Go `agent.IsManagedHookCommand`.
 *
 * @example
 * isManagedHookCommand('story hooks claude-code stop', ['story ']);
 * // returns: true
 *
 * isManagedHookCommand(
 *   wrapProductionSilentHookCommand('story hooks cursor stop'),
 *   ['story '],
 * );
 * // returns: true   (production wrapper containing 'exec story ...')
 *
 * isManagedHookCommand('echo "the story workflow finished"', ['story ']);
 * // returns: false   (substring is not a prefix match)
 */
export function isManagedHookCommand(command: string, prefixes: string[]): boolean {
	if (hasManagedHookPrefix(command, prefixes)) {
		return true;
	}
	if (!command.startsWith(PRODUCTION_HOOK_WRAPPER_PREFIX)) {
		return false;
	}

	const idx = command.indexOf(WRAPPER_EXEC_SENTINEL);
	if (idx === -1) {
		return false;
	}
	const wrapped = command.slice(idx + WRAPPER_EXEC_SENTINEL.length);
	// The exec tail in our wrappers ends with a trailing single-quote (the
	// closing quote of the outer `sh -c '...'`); strip it before prefix-matching.
	const cleaned = wrapped.endsWith("'") ? wrapped.slice(0, -1) : wrapped;
	return hasManagedHookPrefix(cleaned, prefixes);
}

function hasManagedHookPrefix(command: string, prefixes: string[]): boolean {
	return prefixes.some((p) => command.startsWith(p));
}

/**
 * Go `%q`-style double-quoted escape — emits `"..."` with `\"` and `\\`
 * escapes. Used to embed a JSON / ASCII payload as a single shell argument
 * inside the outer `sh -c '...'` wrapper (Go upstream uses `fmt.Sprintf("%q", ...)`
 * for the same purpose; see `hook_command.go:51 / 61`).
 *
 * NOT a generic POSIX single-quote shell escape — payloads here are
 * Story-controlled and known to lack control characters / unicode quotes,
 * so the simpler double-quote form matches Go output byte-for-byte.
 */
function shellQuote(s: string): string {
	return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
