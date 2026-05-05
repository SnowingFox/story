/**
 * HTTP Basic token injection + partial-clone fetch helpers.
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/strategy/checkpoint_token.go` —
 * `CheckpointTokenEnvVar` / `CheckpointGitCommand` / `appendCheckpointTokenEnv` /
 * `isValidToken` / `resolveTargetProtocol` / `ResolveFetchTarget` /
 * `AppendFetchFilterArgs`.
 *
 * Story-side env var rename: `STORY_CHECKPOINT_TOKEN` (primary) +
 * `ENTIRE_CHECKPOINT_TOKEN` (back-compat read), same pattern as
 * `STORY_TEST_TTY` / `ENTIRE_TEST_TTY` (Phase 5.4 ship). See
 * `references/story-vs-entire.md` for the documented exception.
 */

import { execGit } from '@/git';
import { isFilteredFetchesEnabled, readSettings } from '@/settings/settings';
import { getStderrWriter } from './hooks-tty';
import { isURL } from './push-helpers';

/**
 * Environment variable name for the checkpoint access token. Story uses
 * `STORY_CHECKPOINT_TOKEN`. The token is sent as an HTTP Basic credential
 * with the value `x-access-token:<token>` (base64-encoded), compatible
 * with GitHub-style token auth for HTTPS git remotes. SSH remotes ignore
 * the token (with a one-time `[story] Warning` to stderr).
 */
export const STORY_CHECKPOINT_TOKEN = 'STORY_CHECKPOINT_TOKEN';

/**
 * Back-compat env var name (read only when {@link STORY_CHECKPOINT_TOKEN}
 * is unset). Whitelisted exception in `references/story-vs-entire.md` —
 * keeps shared dev environments and mixed Go/TS test harnesses working.
 */
export const STORY_CHECKPOINT_TOKEN_LEGACY = 'ENTIRE_CHECKPOINT_TOKEN';

const PROTOCOL_SSH = 'ssh';
const PROTOCOL_HTTPS = 'https';

let sshWarnedOnce = false;

/**
 * Test-only helper: reset the SSH warn-once gate for vitest isolation.
 * (The invalid-token warning is NOT once-gated — Go prints it on every
 * call so the user notices, e.g. a token that just rotated and now
 * contains an embedded newline.)
 */
export function resetTokenWarnOnceForTesting(): void {
	sshWarnedOnce = false;
}

/**
 * Build a git command's argv + environment with HTTP Basic auth injected
 * via `GIT_CONFIG_*` env vars when {@link STORY_CHECKPOINT_TOKEN} (or its
 * legacy fallback) is set and the target resolves to an HTTPS remote.
 *
 * The function does **not** spawn the child process — caller passes the
 * returned `args` and `env` to `execa('git', args, { env })` (or similar)
 * along with their own `cwd` / timeout / stdin handling. This mirrors the
 * Go API where `CheckpointGitCommand` returns an `*exec.Cmd` for the
 * caller to `.Run()` themselves.
 *
 * Behavior table:
 *
 * | Token state | Target protocol | Returned `env` | Side effects |
 * |---|---|---|---|
 * | unset / whitespace | any | `undefined` (caller uses `process.env`) | none |
 * | set + invalid (control chars) | any | `undefined` | one-time stderr warning |
 * | set + valid | HTTPS | filtered + `GIT_CONFIG_*` injected | none |
 * | set + valid | SSH | `undefined` | one-time stderr warning |
 * | set + valid | unknown / local path | `undefined` | none |
 *
 * The `target` parameter is used **only** for protocol detection (SSH vs
 * HTTPS vs local). It can be a URL or a remote name (resolved via
 * `git remote get-url`). The caller separately includes the actual remote
 * inside `args` if the git subcommand needs it.
 *
 * @example
 * ```ts
 * // No token set → returns args + env undefined (caller uses process.env)
 * await checkpointGitCommand('origin', ['push', '--porcelain', 'origin', 'main']);
 * // returns: { args: ['push', '--porcelain', 'origin', 'main'], env: undefined }
 *
 * // Token set + HTTPS remote → returns args + env with GIT_CONFIG_* injected
 * process.env.STORY_CHECKPOINT_TOKEN = 'ghp_xxx';
 * await checkpointGitCommand('https://github.com/o/r.git', ['fetch', '--no-tags']);
 * // returns: {
 * //   args: ['fetch', '--no-tags'],
 * //   env: {
 * //     ...filteredEnv,                     // pre-existing GIT_CONFIG_* keys removed
 * //     GIT_CONFIG_COUNT: '1',
 * //     GIT_CONFIG_KEY_0: 'http.extraHeader',
 * //     GIT_CONFIG_VALUE_0: 'Authorization: Basic eC1hY2Nlc3MtdG9rZW46Z2hwX3h4eA==',
 * //   }
 * // }
 *
 * // Token set + SSH remote → warn once, return env undefined
 * await checkpointGitCommand('git@github.com:o/r.git', ['push', 'origin', 'main']);
 * // returns: { args: [...], env: undefined }
 * // Side effect: stderr ← "[story] Warning: STORY_CHECKPOINT_TOKEN is set but remote uses SSH ..."
 *
 * // Side effects across all paths:
 * //   - May print one-time stderr warning (SSH path or invalid-token path)
 * //   - Does NOT spawn the child process (caller does that)
 * //   - process.env is read but not mutated
 * ```
 */
export async function checkpointGitCommand(
	target: string,
	args: string[],
): Promise<{ args: string[]; env: NodeJS.ProcessEnv | undefined }> {
	const token = readToken();
	if (token === null) {
		return { args, env: undefined };
	}

	if (!isValidToken(token)) {
		warnInvalidToken();
		return { args, env: undefined };
	}

	const protocol = await resolveTargetProtocol(target);
	if (protocol === PROTOCOL_SSH) {
		warnSshOnce();
		return { args, env: undefined };
	}
	if (protocol !== PROTOCOL_HTTPS) {
		// Unknown protocol (local path, resolution failed) — don't inject.
		return { args, env: undefined };
	}

	return { args, env: appendCheckpointTokenEnv(process.env, token) };
}

/**
 * Resolve a fetch target. When `strategy_options.filtered_fetches === true`
 * **and** `target` is a remote name (not already a URL), returns the
 * remote's URL so git does not persist `remote.<name>.partialclonefilter`
 * config onto the remote name.
 *
 * @example
 * ```ts
 * // Filter disabled OR target is already a URL → return target unchanged
 * await resolveFetchTarget('origin', { cwd });           // → 'origin'
 * await resolveFetchTarget('https://github.com/o/r.git', { cwd });
 * //                                                     // → 'https://github.com/o/r.git'
 *
 * // Filter enabled + remote name → resolve via `git remote get-url`
 * // (settings.strategy_options.filtered_fetches === true)
 * await resolveFetchTarget('origin', { cwd });
 * // → 'https://github.com/owner/repo.git'
 *
 * // Side effects: at most one git CLI call (`git remote get-url <name>`).
 * // Disk / refs / HEAD: unchanged.
 * ```
 */
export async function resolveFetchTarget(target: string, opts: { cwd: string }): Promise<string> {
	if (isURL(target)) {
		return target;
	}
	const settings = await readSettings(opts.cwd);
	if (!isFilteredFetchesEnabled(settings)) {
		return target;
	}
	return execGit(['remote', 'get-url', target], { cwd: opts.cwd });
}

/**
 * Conditionally append `--filter=blob:none` to a fetch args array based on
 * the `strategy_options.filtered_fetches` settings flag.
 *
 * @example
 * ```ts
 * // Filter disabled → unchanged
 * await appendFetchFilterArgs(['fetch', '--no-tags', 'origin', 'main'], { cwd });
 * // → ['fetch', '--no-tags', 'origin', 'main']
 *
 * // Filter enabled
 * await appendFetchFilterArgs(['fetch', '--no-tags', 'origin', 'main'], { cwd });
 * // → ['fetch', '--no-tags', 'origin', 'main', '--filter=blob:none']
 *
 * // Side effects: reads settings (single fs.readFile). Disk: unchanged.
 * ```
 */
export async function appendFetchFilterArgs(
	args: string[],
	opts: { cwd: string },
): Promise<string[]> {
	const settings = await readSettings(opts.cwd);
	if (!isFilteredFetchesEnabled(settings)) {
		return args;
	}
	return [...args, '--filter=blob:none'];
}

function readToken(): string | null {
	const story = process.env[STORY_CHECKPOINT_TOKEN];
	if (story !== undefined) {
		const trimmed = story.trim();
		if (trimmed.length > 0) {
			return trimmed;
		}
	}
	const legacy = process.env[STORY_CHECKPOINT_TOKEN_LEGACY];
	if (legacy !== undefined) {
		const trimmed = legacy.trim();
		if (trimmed.length > 0) {
			return trimmed;
		}
	}
	return null;
}

/**
 * Reject tokens containing control characters (bytes < 0x20 or 0x7F).
 * Prevents HTTP header injection via CR / LF / null / DEL embedded in the
 * token value. Mirrors Go `isValidToken` in `checkpoint_token.go`.
 */
function isValidToken(token: string): boolean {
	for (let i = 0; i < token.length; i++) {
		const code = token.charCodeAt(i);
		if (code < 0x20 || code === 0x7f) {
			return false;
		}
	}
	return true;
}

/**
 * Determine whether a push / fetch target uses SSH or HTTPS. Returns
 * `'ssh'` / `'https'` / `''` (unknown — local path, resolution failed,
 * or unsupported scheme).
 *
 * URLs are parsed directly. Remote names go through `git remote get-url`
 * to resolve the underlying URL first.
 */
async function resolveTargetProtocol(target: string): Promise<string> {
	let rawURL: string;
	if (isURL(target)) {
		rawURL = target;
	} else {
		try {
			rawURL = await execGit(['remote', 'get-url', target]);
		} catch {
			return '';
		}
	}

	return classifyURLProtocol(rawURL);
}

/**
 * Classify a raw git remote URL string as SSH or HTTPS. Lightweight
 * sibling of {@link parseGitRemoteURL} (in `checkpoint-remote.ts`) used
 * solely for protocol detection — no owner / repo extraction.
 *
 * Returns `''` for cleartext `http://`, local paths, and any other
 * unrecognized scheme. Token injection only fires for `'https'`, so
 * cleartext HTTP push will NOT leak the token (mirrors Go where
 * `parseGitRemoteURL` returns `protocol: "http"` and `CheckpointGitCommand`
 * only injects on `protocolHTTPS`).
 */
function classifyURLProtocol(rawURL: string): string {
	const trimmed = rawURL.trim();
	// SSH SCP form: `git@host:path/repo.git` (contains ':' but not '://').
	if (trimmed.includes(':') && !trimmed.includes('://') && trimmed.includes('@')) {
		return PROTOCOL_SSH;
	}
	if (trimmed.startsWith('https://')) {
		return PROTOCOL_HTTPS;
	}
	if (trimmed.startsWith('ssh://')) {
		return PROTOCOL_SSH;
	}
	// Cleartext `http://` deliberately falls through to `''` — Go does not
	// inject tokens over HTTP either; suppressing this protects the token
	// from being sent in cleartext.
	return '';
}

/**
 * Build a new env map with pre-existing `GIT_CONFIG_*` keys filtered out
 * + the 3 new keys appended that inject an `Authorization: Basic ...`
 * HTTP header. Mirrors Go `appendCheckpointTokenEnv`.
 */
function appendCheckpointTokenEnv(baseEnv: NodeJS.ProcessEnv, token: string): NodeJS.ProcessEnv {
	const filtered: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(baseEnv)) {
		// Match Go's `HasPrefix(line, "GIT_CONFIG_COUNT=")` exactly — i.e. the
		// `GIT_CONFIG_COUNT` key alone, NOT any key starting with that prefix
		// (e.g. a hypothetical `GIT_CONFIG_COUNTERS` would not be filtered).
		// `GIT_CONFIG_KEY_*` and `GIT_CONFIG_VALUE_*` are intentional prefix
		// matches (those keys are always indexed by N).
		if (
			key === 'GIT_CONFIG_COUNT' ||
			key.startsWith('GIT_CONFIG_KEY_') ||
			key.startsWith('GIT_CONFIG_VALUE_')
		) {
			continue;
		}
		if (value !== undefined) {
			filtered[key] = value;
		}
	}
	const encoded = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
	filtered.GIT_CONFIG_COUNT = '1';
	filtered.GIT_CONFIG_KEY_0 = 'http.extraHeader';
	filtered.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${encoded}`;
	return filtered;
}

function warnSshOnce(): void {
	if (sshWarnedOnce) {
		return;
	}
	sshWarnedOnce = true;
	getStderrWriter().write(
		`[story] Warning: ${STORY_CHECKPOINT_TOKEN} is set but remote uses SSH — token ignored for SSH remotes\n`,
	);
}

/**
 * Print the invalid-token warning. Mirrors Go `checkpoint_token.go:49-51`
 * which writes on **every** call (no `sync.Once`) so the user keeps
 * seeing it until they fix the token.
 */
function warnInvalidToken(): void {
	getStderrWriter().write(
		`[story] Warning: ${STORY_CHECKPOINT_TOKEN} contains invalid characters (CR, LF, or other control chars) — token ignored\n`,
	);
}
