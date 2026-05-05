/**
 * Push settings resolution + checkpoint URL derivation + URL-based fetch.
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/strategy/checkpoint_remote.go`.
 *
 * Story-side text divergence: `.story/settings.json` references in
 * settings hints; `[story]` brand on stderr; `refs/story-fetch-tmp/`
 * temp ref namespace (Go uses `refs/entire-fetch-tmp/`).
 */

import fsCallback from 'node:fs';
import { execa } from 'execa';
import git from 'isomorphic-git';
import { METADATA_BRANCH_NAME, V2_MAIN_REF_NAME } from '@/checkpoint/constants';
import { execGit } from '@/git';
import { debug, warn } from '@/log';
import {
	type CheckpointRemoteConfig,
	getCheckpointRemote,
	getCheckpointRemoteOwner,
	isPushSessionsDisabled,
	isPushV2RefsEnabled,
	readSettings,
	type StorySettings,
} from '@/settings/settings';
import { appendFetchFilterArgs, checkpointGitCommand } from './checkpoint-token';

/** Timeout (milliseconds) for fetching branches from a checkpoint URL. */
export const CHECKPOINT_REMOTE_FETCH_TIMEOUT_MS = 30_000;

/** Git remote protocol identifier — SSH SCP / `ssh://` URLs. */
export const PROTOCOL_SSH = 'ssh';

/** Git remote protocol identifier — `https://` URLs. */
export const PROTOCOL_HTTPS = 'https';

/**
 * Resolved push configuration produced by a single settings load.
 *
 * Use {@link pushTarget} to pick the actual target for push commands.
 */
export interface PushSettings {
	/** Git remote name to push the user's code to (the user's push remote). */
	remote: string;
	/**
	 * Derived URL for pushing checkpoint branches. When non-empty,
	 * checkpoint branches are pushed to this URL instead of {@link remote}.
	 * Empty string means use the remote name.
	 */
	checkpointURL: string;
	/** True iff `push_sessions` is explicitly `false` (user opted out). */
	pushDisabled: boolean;
}

/** SSH/HTTPS/owner/repo for a parsed git remote URL. */
export interface GitRemoteInfo {
	protocol: string;
	host: string;
	owner: string;
	repo: string;
}

/**
 * Pick the effective push / fetch target from a {@link PushSettings}.
 * Returns `checkpointURL` when set, else `remote`.
 */
export function pushTarget(ps: PushSettings): string {
	if (ps.checkpointURL !== '') {
		return ps.checkpointURL;
	}
	return ps.remote;
}

/**
 * True iff `ps.checkpointURL` is non-empty (i.e. a dedicated checkpoint
 * URL has been derived from `strategy_options.checkpoint_remote`).
 */
export function hasCheckpointURL(ps: PushSettings): boolean {
	return ps.checkpointURL !== '';
}

/**
 * Load settings once and resolve push configuration. If `checkpoint_remote.gitUrl`
 * is configured, uses that URL directly and skips push remote lookup / fork
 * detection. Otherwise, if a structured `checkpoint_remote` is configured
 * (`{provider, repo}`):
 *   - Derives the checkpoint URL from the push remote's protocol (SSH vs HTTPS)
 *   - Skips if the push remote owner differs from the checkpoint repo owner
 *     (fork detection — push-only)
 *   - If a checkpoint branch doesn't exist locally, attempts to fetch it
 *     from the URL (silent on failure)
 *
 * The push itself handles failures gracefully (`doPushBranch` warns and
 * continues), so no reachability check is needed here.
 *
 * Mirrors Go `resolvePushSettings` in `checkpoint_remote.go`.
 *
 * @example
 * ```ts
 * // No checkpoint_remote configured → returns just remote
 * await resolvePushSettings('origin', { cwd });
 * // returns: { remote: 'origin', checkpointURL: '', pushDisabled: false }
 *
 * // checkpoint_remote configured + push owner matches → derives URL + fetches missing
 * // (settings.strategy_options.checkpoint_remote = { provider: 'github', repo: 'acme/checkpoints' })
 * await resolvePushSettings('origin', { cwd });
 * // returns: { remote: 'origin', checkpointURL: 'https://github.com/acme/checkpoints.git', pushDisabled: false }
 *
 * // checkpoint_remote.gitUrl configured → uses direct URL, no remote lookup / fork detection
 * await resolvePushSettings('origin', { cwd });
 * // returns: { remote: 'origin', checkpointURL: 'git@gitlab.com:acme/story.git', pushDisabled: false }
 *
 * // Side effects:
 * //   - May call `git remote get-url origin` only on provider/repo path
 * //   - May call `git fetch <checkpointURL>` if local v1 metadata branch missing
 * //   - May call `git fetch <checkpointURL>` for v2 /main if push_v2_refs enabled
 * //   - Writes `refs/heads/story/checkpoints/v1` if fetch succeeded
 * //   - All fetch failures are silently swallowed (return ps without checkpointURL only on derivation failure)
 *
 * // Fork detected (push owner ≠ checkpoint owner) → return without checkpointURL
 * await resolvePushSettings('origin', { cwd });
 * // returns: { remote: 'origin', checkpointURL: '', pushDisabled: false }
 * // Side effects: only the `git remote get-url` call; no fetch attempts.
 * ```
 */
export async function resolvePushSettings(
	pushRemoteName: string,
	opts: { cwd: string },
): Promise<PushSettings> {
	let settings: StorySettings;
	try {
		settings = await readSettings(opts.cwd);
	} catch {
		return { remote: pushRemoteName, checkpointURL: '', pushDisabled: false };
	}

	const ps: PushSettings = {
		remote: pushRemoteName,
		checkpointURL: '',
		pushDisabled: isPushSessionsDisabled(settings),
	};

	const config = getCheckpointRemote(settings);
	if (config === null) {
		return ps;
	}

	const explicitURL = checkpointRemoteGitURL(config);
	if (explicitURL !== '') {
		ps.checkpointURL = explicitURL;
		await fetchMetadataBranchIfMissing(explicitURL, { cwd: opts.cwd });
		if (isPushV2RefsEnabled(settings)) {
			await fetchV2MainRefIfMissing(explicitURL, { cwd: opts.cwd });
		}
		return ps;
	}

	let pushRemoteURL: string;
	try {
		pushRemoteURL = await execGit(['remote', 'get-url', pushRemoteName], { cwd: opts.cwd });
	} catch (err) {
		// Match Go log level: `logging.Debug(...)` — this is expected when
		// the user pushes to a remote not configured in this clone.
		debug(
			{ component: 'strategy/checkpoint-remote' },
			'checkpoint-remote: could not get push remote URL, skipping',
			{ remote: pushRemoteName, error: err instanceof Error ? err.message : String(err) },
		);
		return ps;
	}

	let pushInfo: GitRemoteInfo;
	try {
		pushInfo = parseGitRemoteURL(pushRemoteURL);
	} catch (err) {
		warn(
			{ component: 'strategy/checkpoint-remote' },
			'checkpoint-remote: could not parse push remote URL',
			{ remote: pushRemoteName, error: err instanceof Error ? err.message : String(err) },
		);
		return ps;
	}

	const checkpointOwner = getCheckpointRemoteOwner(config);
	if (
		pushInfo.owner !== '' &&
		checkpointOwner !== '' &&
		pushInfo.owner.toLowerCase() !== checkpointOwner.toLowerCase()
	) {
		// Fork detection — push-only; reading via resolveCheckpointURL skips
		// this check. Mirror Go's `logging.Debug(...)` so the skip is
		// observable when log_level is debug but doesn't spam at warn.
		debug(
			{ component: 'strategy/checkpoint-remote' },
			'checkpoint-remote: push remote owner differs from checkpoint remote owner, skipping (fork detected)',
			{ push_owner: pushInfo.owner, checkpoint_owner: checkpointOwner },
		);
		return ps;
	}

	let checkpointURL: string;
	try {
		checkpointURL = deriveCheckpointURLFromInfo(pushInfo, config);
	} catch (err) {
		warn(
			{ component: 'strategy/checkpoint-remote' },
			'checkpoint-remote: could not derive URL from push remote',
			{
				remote: pushRemoteName,
				repo: config.repo ?? '',
				error: err instanceof Error ? err.message : String(err),
			},
		);
		return ps;
	}

	ps.checkpointURL = checkpointURL;

	// Best-effort: if local v1 metadata branch missing, try to fetch it from the URL.
	// Failures here are not fatal — push will create it on the remote when it succeeds.
	await fetchMetadataBranchIfMissing(checkpointURL, { cwd: opts.cwd });

	if (isPushV2RefsEnabled(settings)) {
		await fetchV2MainRefIfMissing(checkpointURL, { cwd: opts.cwd });
	}

	return ps;
}

/**
 * Return the checkpoint remote URL if configured, or empty string if not
 * configured / derivation fails. Direct `gitUrl` configs are returned as-is;
 * provider/repo configs use the push remote's protocol for URL construction.
 * Skips fork detection (read-only callers can use any URL).
 *
 * Mirrors Go `ResolveCheckpointURL` in `checkpoint_remote.go`.
 *
 * @example
 * ```ts
 * // No checkpoint_remote configured → empty string
 * await resolveCheckpointURL('origin', { cwd });          // ''
 *
 * // Configured + push remote resolvable → derived URL
 * await resolveCheckpointURL('origin', { cwd });
 * // 'https://github.com/acme/checkpoints.git'
 *
 * // Direct gitUrl config → no push remote lookup
 * await resolveCheckpointURL('origin', { cwd });
 * // 'git@gitlab.com:acme/story.git'
 *
 * // Fork detection is intentionally SKIPPED here (read path):
 * // even if push remote owner ≠ checkpoint repo owner, the URL is returned.
 *
 * // Side effects:
 * //   - Reads .story/settings.json once
 * //   - May call `git remote get-url <pushRemoteName>` once on provider/repo path
 * //   - No fetch, no ref writes
 * //
 * // Disk / git refs / HEAD: unchanged.
 * ```
 */
export async function resolveCheckpointURL(
	pushRemoteName: string,
	opts: { cwd: string },
): Promise<string> {
	let settings: StorySettings;
	try {
		settings = await readSettings(opts.cwd);
	} catch {
		return '';
	}
	const config = getCheckpointRemote(settings);
	if (config === null) {
		return '';
	}
	const explicitURL = checkpointRemoteGitURL(config);
	if (explicitURL !== '') {
		return explicitURL;
	}
	let pushRemoteURL: string;
	try {
		pushRemoteURL = await execGit(['remote', 'get-url', pushRemoteName], { cwd: opts.cwd });
	} catch {
		return '';
	}
	try {
		return deriveCheckpointURL(pushRemoteURL, config);
	} catch {
		return '';
	}
}

/**
 * Resume / explain default-origin variant. Returns `{ url, configured }`.
 *
 * Throws **only** when `checkpoint_remote` is configured but resolution
 * fails (missing origin remote / unparseable URL). Skips fork detection
 * (read-only) and has no side effects (no fetching).
 *
 * Mirrors Go `ResolveCheckpointRemoteURL` in `checkpoint_remote.go`.
 *
 * @example
 * ```ts
 * // No checkpoint_remote → { url: '', configured: false } (no throw)
 * await resolveCheckpointRemoteURL({ cwd });
 *
 * // Configured + origin resolvable → { url, configured: true }
 * await resolveCheckpointRemoteURL({ cwd });
 * // { url: 'https://github.com/acme/checkpoints.git', configured: true }
 *
 * // Direct gitUrl config → no origin lookup
 * await resolveCheckpointRemoteURL({ cwd });
 * // { url: 'git@gitlab.com:acme/story.git', configured: true }
 *
 * // Configured but origin missing → throws
 * await resolveCheckpointRemoteURL({ cwd });
 * // throws Error('could not get origin remote URL: ...')
 *
 * // Side effects:
 * //   - Reads .story/settings.json once
 * //   - May call `git remote get-url origin` once on provider/repo path
 * //   - No fetch, no ref writes
 * //
 * // Disk / git refs / HEAD: unchanged.
 * ```
 */
export async function resolveCheckpointRemoteURL(opts: {
	cwd: string;
}): Promise<{ url: string; configured: boolean }> {
	let settings: StorySettings;
	try {
		settings = await readSettings(opts.cwd);
	} catch {
		// Settings load failure → treat as not configured (cannot determine config).
		return { url: '', configured: false };
	}
	const config = getCheckpointRemote(settings);
	if (config === null) {
		return { url: '', configured: false };
	}
	const explicitURL = checkpointRemoteGitURL(config);
	if (explicitURL !== '') {
		return { url: explicitURL, configured: true };
	}

	let remoteURL: string;
	try {
		remoteURL = await execGit(['remote', 'get-url', 'origin'], { cwd: opts.cwd });
	} catch (err) {
		throw new Error(
			`could not get origin remote URL: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	let info: GitRemoteInfo;
	try {
		info = parseGitRemoteURL(remoteURL);
	} catch (err) {
		throw new Error(
			`could not parse origin remote URL: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	const url = deriveCheckpointURLFromInfo(info, config);
	return { url, configured: true };
}

/**
 * Parse a `git remote get-url <name>` result and return host/owner/repo
 * structurally. Throws on malformed input.
 *
 * @example
 * ```ts
 * await resolveRemoteRepo('origin', { cwd });
 * // returns: { host: 'github.com', owner: 'org', repo: 'my-repo' }
 * ```
 */
export async function resolveRemoteRepo(
	remoteName: string,
	opts: { cwd: string },
): Promise<{ host: string; owner: string; repo: string }> {
	const url = await execGit(['remote', 'get-url', remoteName], { cwd: opts.cwd });
	const info = parseGitRemoteURL(url);
	return { host: info.host, owner: info.owner, repo: info.repo };
}

/**
 * Convenience wrapper around `git remote get-url origin`. Throws when the
 * `origin` remote is not configured (matching `git`'s native behavior).
 *
 * @example
 * ```ts
 * await originURL({ cwd });
 * // 'https://github.com/acme/repo.git'
 *
 * // No origin remote → throws (execGit's error)
 *
 * // Side effects:
 * //   - One git CLI call (`git remote get-url origin`)
 * //   - No fetch, no ref writes
 * ```
 */
export async function originURL(opts: { cwd: string }): Promise<string> {
	return execGit(['remote', 'get-url', 'origin'], { cwd: opts.cwd });
}

/**
 * Parse a git remote URL into structured components. Supports:
 *   - SSH SCP format: `git@github.com:org/repo.git`
 *   - HTTPS format: `https://github.com/org/repo.git`
 *   - SSH protocol format: `ssh://git@github.com/org/repo.git`
 *
 * Mirrors Go `parseGitRemoteURL` in `checkpoint_remote.go`.
 *
 * @example
 * ```ts
 * parseGitRemoteURL('git@github.com:acme/repo.git');
 * // returns: { protocol: 'ssh',   host: 'github.com', owner: 'acme', repo: 'repo' }
 *
 * parseGitRemoteURL('https://github.com/acme/repo.git');
 * // returns: { protocol: 'https', host: 'github.com', owner: 'acme', repo: 'repo' }
 *
 * parseGitRemoteURL('not a url');                 // throws
 * ```
 */
export function parseGitRemoteURL(rawURL: string): GitRemoteInfo {
	const trimmed = rawURL.trim();

	// SSH SCP format: git@github.com:org/repo.git (':' but no '://')
	if (trimmed.includes(':') && !trimmed.includes('://')) {
		const colonIdx = trimmed.indexOf(':');
		const hostPart = trimmed.slice(0, colonIdx);
		const pathPart = trimmed.slice(colonIdx + 1);

		let host = hostPart;
		const atIdx = host.indexOf('@');
		if (atIdx >= 0) {
			host = host.slice(atIdx + 1);
		}
		if (host === '') {
			throw new Error(`invalid SSH URL: ${redactURL(rawURL)}`);
		}

		const [owner, repo] = splitOwnerRepo(pathPart);
		return { protocol: PROTOCOL_SSH, host, owner, repo };
	}

	// URL format: https://... or ssh://...
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		throw new Error(`invalid URL: ${redactURL(rawURL)}`);
	}

	const protocol = parsed.protocol.replace(/:$/, '');
	if (protocol === '') {
		throw new Error(`no protocol in URL: ${redactURL(rawURL)}`);
	}
	const host = parsed.hostname;
	const pathPart = parsed.pathname.replace(/^\//, '');
	const [owner, repo] = splitOwnerRepo(pathPart);
	return { protocol, host, owner, repo };
}

/**
 * Construct a checkpoint remote URL using the same protocol as the push
 * remote. For example, if push remote uses SSH, the checkpoint URL also
 * uses SSH (preserving credential helpers / SSH key chain).
 *
 * @example
 * ```ts
 * deriveCheckpointURL('git@github.com:user/code.git', { provider: 'github', repo: 'user/checkpoints' });
 * // returns: 'git@github.com:user/checkpoints.git'
 *
 * deriveCheckpointURL('https://github.com/user/code.git', { provider: 'github', repo: 'user/checkpoints' });
 * // returns: 'https://github.com/user/checkpoints.git'
 *
 * deriveCheckpointURL('not used', { gitUrl: 'git@gitlab.com:acme/story.git' });
 * // returns: 'git@gitlab.com:acme/story.git'
 *
 * deriveCheckpointURL('ftp://example.com/u/r.git', { provider: 'github', repo: 'u/r' });
 * // throws Error('unsupported protocol ...')
 * ```
 */
export function deriveCheckpointURL(pushRemoteURL: string, config: CheckpointRemoteConfig): string {
	const explicitURL = checkpointRemoteGitURL(config);
	if (explicitURL !== '') {
		return explicitURL;
	}
	const info = parseGitRemoteURL(pushRemoteURL);
	return deriveCheckpointURLFromInfo(info, config);
}

function deriveCheckpointURLFromInfo(info: GitRemoteInfo, config: CheckpointRemoteConfig): string {
	if (config.repo === undefined || config.repo === '') {
		throw new Error('checkpoint remote repo is required');
	}
	if (info.protocol === PROTOCOL_SSH) {
		return `git@${info.host}:${config.repo}.git`;
	}
	if (info.protocol === PROTOCOL_HTTPS) {
		return `https://${info.host}/${config.repo}.git`;
	}
	throw new Error(`unsupported protocol "${info.protocol}" in push remote`);
}

/** Return the direct checkpoint git URL configured on `checkpoint_remote`, or `""`. */
function checkpointRemoteGitURL(config: CheckpointRemoteConfig): string {
	return config.gitUrl ?? '';
}

function splitOwnerRepo(pathPart: string): [string, string] {
	let p = pathPart;
	if (p.endsWith('.git')) {
		p = p.slice(0, -4);
	}
	const slashIdx = p.indexOf('/');
	if (slashIdx < 0) {
		throw new Error(`cannot parse owner/repo from path: ${pathPart}`);
	}
	const owner = p.slice(0, slashIdx);
	const repo = p.slice(slashIdx + 1);
	if (owner === '' || repo === '') {
		throw new Error(`cannot parse owner/repo from path: ${pathPart}`);
	}
	return [owner, repo];
}

/**
 * Strip credentials from a URL for safe logging. Handles HTTPS URLs with
 * embedded `user:pass@` and SSH `user@host:path` SCP form.
 *
 * @example
 * ```ts
 * redactURL('https://user:secret@github.com/o/r.git');  // 'https://github.com/o/r.git'
 * redactURL('git@github.com:o/r.git');                  // 'github.com:***'
 * redactURL('not parseable');                           // '<unparseable>'
 * ```
 */
export function redactURL(rawURL: string): string {
	try {
		const u = new URL(rawURL);
		// URL parse succeeded → strip user:pass + query
		u.username = '';
		u.password = '';
		u.search = '';
		const host = u.host;
		const path = u.pathname;
		const proto = u.protocol.replace(/:$/, '');
		return `${proto}://${host}${path}`;
	} catch {
		// Non-URL formats (SSH SCP) → return host:***
		const atIdx = rawURL.indexOf('@');
		if (atIdx >= 0) {
			const rest = rawURL.slice(atIdx + 1);
			const colonIdx = rest.indexOf(':');
			if (colonIdx >= 0) {
				return `${rest.slice(0, colonIdx)}:***`;
			}
		}
		return '<unparseable>';
	}
}

/**
 * Fetch the v1 metadata branch from a remote URL and update the local
 * branch ref. Always fetches (no skip-if-exists) — used by resume
 * scenarios where local may be stale.
 *
 * Mirrors Go `FetchMetadataBranch(ctx, remoteURL)` in `checkpoint_remote.go`
 * (the URL variant — *not* the no-arg origin variant in `git_operations.go`
 * which is Phase 9.4 / foundation-backlog #21).
 *
 * @example
 * ```ts
 * await fetchMetadataBranch('https://github.com/o/r.git', { cwd });
 * // returns: void
 *
 * // Side effects in `<cwd>/.git/`:
 * //   - Spawns: git fetch --no-tags [--filter=blob:none] <url>
 * //             +refs/heads/story/checkpoints/v1:refs/story-fetch-tmp/story/checkpoints/v1
 * //   - On success: refs/heads/story/checkpoints/v1 ← <fetched commit hash>
 * //   - Cleanup:    refs/story-fetch-tmp/story/checkpoints/v1 removed (best-effort)
 * //   - On failure: throws Error with redacted URL in message; refs unchanged
 * //
 * // Worktree / index / HEAD / settings: unchanged.
 * ```
 */
export async function fetchMetadataBranch(remoteURL: string, opts: { cwd: string }): Promise<void> {
	const branchName = METADATA_BRANCH_NAME;
	const tmpRef = `refs/story-fetch-tmp/${branchName}`;
	const refSpec = `+refs/heads/${branchName}:${tmpRef}`;

	const baseArgs = ['fetch', '--no-tags', remoteURL, refSpec];
	const fetchArgs = await appendFetchFilterArgs(baseArgs, { cwd: opts.cwd });
	const cmd = await checkpointGitCommand(remoteURL, fetchArgs);
	const env: NodeJS.ProcessEnv = { ...(cmd.env ?? process.env), GIT_TERMINAL_PROMPT: '0' };

	const result = await execa('git', cmd.args, {
		cwd: opts.cwd,
		env,
		timeout: CHECKPOINT_REMOTE_FETCH_TIMEOUT_MS,
		reject: false,
	});

	if (result.exitCode !== 0) {
		const redacted = redactURL(remoteURL);
		const combined = `${result.stdout}\n${result.stderr}`.trim();
		const safe = combined.split(remoteURL).join(redacted);
		const detail = safe ? `: ${safe}` : '';
		throw new Error(`fetch from ${redacted} failed${detail}`);
	}

	// Move temp ref → local branch ref, then drop temp ref.
	const fetchedHash = await git.resolveRef({ fs: fsCallback, dir: opts.cwd, ref: tmpRef });
	await git.writeRef({
		fs: fsCallback,
		dir: opts.cwd,
		ref: `refs/heads/${branchName}`,
		value: fetchedHash,
		force: true,
	});
	try {
		await git.deleteRef({ fs: fsCallback, dir: opts.cwd, ref: tmpRef });
	} catch {
		// best-effort cleanup
	}
}

/**
 * Fetch the v2 `/main` ref from a remote URL and update the local ref.
 * Uses an explicit refspec (v2 refs are under `refs/story/checkpoints/v2/`,
 * not `refs/heads/`).
 *
 * Mirrors Go `FetchV2MainFromURL` in `checkpoint_remote.go`.
 *
 * @example
 * ```ts
 * await fetchV2MainFromURL('https://github.com/o/r.git', { cwd });
 *
 * // Side effects:
 * //   - Spawns: git fetch --no-tags [--filter=blob:none] <url>
 * //             +refs/story/checkpoints/v2/main:refs/story/checkpoints/v2/main
 * //   - On success: refs/story/checkpoints/v2/main ← <fetched commit hash>
 * //   - On failure: throws Error with redacted URL in message
 * //
 * // Worktree / index / HEAD / .story/settings.json: unchanged.
 * ```
 */
export async function fetchV2MainFromURL(remoteURL: string, opts: { cwd: string }): Promise<void> {
	const refSpec = `+${V2_MAIN_REF_NAME}:${V2_MAIN_REF_NAME}`;
	const baseArgs = ['fetch', '--no-tags', remoteURL, refSpec];
	const fetchArgs = await appendFetchFilterArgs(baseArgs, { cwd: opts.cwd });
	const cmd = await checkpointGitCommand(remoteURL, fetchArgs);
	const env: NodeJS.ProcessEnv = { ...(cmd.env ?? process.env), GIT_TERMINAL_PROMPT: '0' };

	const result = await execa('git', cmd.args, {
		cwd: opts.cwd,
		env,
		timeout: CHECKPOINT_REMOTE_FETCH_TIMEOUT_MS,
		reject: false,
	});

	if (result.exitCode !== 0) {
		const redacted = redactURL(remoteURL);
		const combined = `${result.stdout}\n${result.stderr}`.trim();
		const safe = combined.split(remoteURL).join(redacted);
		const detail = safe ? `: ${safe}` : '';
		throw new Error(`fetch v2 /main from ${redacted} failed${detail}`);
	}
}

async function fetchMetadataBranchIfMissing(
	remoteURL: string,
	opts: { cwd: string },
): Promise<void> {
	try {
		await git.resolveRef({
			fs: fsCallback,
			dir: opts.cwd,
			ref: `refs/heads/${METADATA_BRANCH_NAME}`,
		});
		return; // already exists locally
	} catch {
		// fall through to fetch
	}
	try {
		await fetchMetadataBranch(remoteURL, opts);
	} catch {
		// fetch failure is expected when remote is unreachable / branch absent
	}
}

async function fetchV2MainRefIfMissing(remoteURL: string, opts: { cwd: string }): Promise<void> {
	try {
		await git.resolveRef({ fs: fsCallback, dir: opts.cwd, ref: V2_MAIN_REF_NAME });
		return;
	} catch {
		// fall through to fetch
	}
	try {
		await fetchV2MainFromURL(remoteURL, opts);
	} catch {
		// fetch failure is expected when remote unreachable / ref absent
	}
}
