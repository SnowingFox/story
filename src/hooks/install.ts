/**
 * Git hook installation / removal for the Story CLI.
 *
 * Manages 5 shell shim scripts in `.git/hooks/` that delegate to
 * `story hooks git <name>` CLI commands. Handles backup of existing
 * user hooks, chain-execution of pre-existing hooks after Story's own
 * hook body, idempotent install / uninstall, and the post-rewrite
 * stdin-replay dance.
 *
 * Mirrors Go `cmd/entire/cli/strategy/hooks.go`. Story-side literals
 * ({@link STORY_HOOK_MARKER} / {@link BACKUP_SUFFIX} / `story hooks git`
 * command prefix / `[story]` stderr brand / `_story_stdin` variable /
 * `story-post-rewrite.XXXXXX` tmpfile pattern) diverge from Go's Entire
 * equivalents — see
 * [docs/ts-rewrite/impl/phase-8-hooks/module.md](../../docs/ts-rewrite/impl/phase-8-hooks/module.md).
 *
 * @packageDocumentation
 */

import { realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execGit } from '@/git';
import { readSettings } from '@/settings/settings';

/**
 * Marker string embedded in every Story-managed hook file. Install +
 * remove identify Story's hooks by this literal.
 *
 * Story-side divergence from Go `entireHookMarker = "Entire CLI hooks"`.
 */
export const STORY_HOOK_MARKER = 'Story CLI hooks';

/**
 * Suffix used when backing up a pre-existing user hook before
 * installing Story's hook (e.g. `prepare-commit-msg.pre-story`).
 *
 * Story-side divergence from Go `backupSuffix = ".pre-entire"`.
 */
export const BACKUP_SUFFIX = '.pre-story';

/**
 * Shell comment marking the chain-call section appended to a hook
 * script when a backup exists. Used as a content fingerprint for chain
 * detection.
 */
export const CHAIN_COMMENT = '# Chain: run pre-existing hook';

/**
 * Names of the 5 git hooks managed by the Story CLI. Ordering matters
 * — `installGitHooks` / `removeGitHooks` iterate in this order and the
 * first "install" stdout message lists these hooks explicitly.
 */
export const MANAGED_GIT_HOOK_NAMES = [
	'prepare-commit-msg',
	'commit-msg',
	'post-commit',
	'post-rewrite',
	'pre-push',
] as const;

/** One git hook's name + its generated shell script content. */
export interface HookSpec {
	name: string;
	content: string;
}

// Cache — keyed by the `repoDir` argument rather than `process.cwd()`
// (Go uses cwd). Using the argument makes the cache deterministic across
// concurrent test workers and cleanly scoped to the caller.
const hooksDirCache = new Map<string, string>();

/**
 * Reset the `getHooksDir` cache. Required for test isolation when a
 * test changes a repo's `core.hooksPath` config after an earlier
 * resolution cached the old path.
 *
 * Mirrors Go `ClearHooksDirCache`.
 */
export function clearHooksDirCache(): void {
	hooksDirCache.clear();
}

/**
 * Return the active hooks directory for a repository. Respects
 * `core.hooksPath` and correctly resolves to the common hooks directory
 * in linked worktrees — both scenarios require delegating to
 * `git rev-parse --git-path hooks`, which is why we cannot hardcode
 * `<repoDir>/.git/hooks`.
 *
 * Result is cached per `repoDir` (module-scoped `Map`). Call
 * {@link clearHooksDirCache} in tests when a repo's hook config changes.
 *
 * Mirrors Go `GetHooksDir` + `getHooksDirInPath`.
 *
 * @example
 * await getHooksDir('/repo');
 * // returns: '/repo/.git/hooks'
 *
 * // With core.hooksPath = '.githooks':
 * // returns: '/repo/.githooks'
 *
 * // In a linked worktree:
 * // returns: '/path/to/main-repo/.git/hooks'  (common dir)
 *
 * // Side effects: spawns `git rev-parse --git-path hooks`
 * // (once per `repoDir`, subsequent calls hit the cache).
 */
export async function getHooksDir(repoDir: string): Promise<string> {
	const cached = hooksDirCache.get(repoDir);
	if (cached !== undefined) {
		return cached;
	}

	let raw: string;
	try {
		raw = await execGit(['rev-parse', '--git-path', 'hooks'], { cwd: repoDir });
	} catch (_err) {
		throw new Error('not a git repository');
	}

	const trimmed = raw.trim();
	const resolved = path.isAbsolute(trimmed) ? trimmed : path.join(repoDir, trimmed);
	const clean = path.normalize(resolved);
	hooksDirCache.set(repoDir, clean);
	return clean;
}

/**
 * True iff all 5 managed hooks exist in `repoDir` and contain the Story
 * marker. Used by `story enable` / `story doctor` / tests.
 *
 * Mirrors Go `IsGitHookInstalled`.
 *
 * @example
 * await isGitHookInstalled('/repo');
 * // returns: true   (all 5 hooks contain STORY_HOOK_MARKER)
 * // returns: false  (any hook missing, unreadable, or lacks marker)
 *
 * // Side effects: spawns `git rev-parse --git-path hooks` (cached per
 * // repoDir via getHooksDir) + up to 5 fs.readFile calls on the
 * // resolved hooks directory. Returns early with `false` on any read
 * // error (ENOENT / EACCES).
 * // Worktree / index / HEAD / hook files: unchanged (pure read).
 */
export async function isGitHookInstalled(repoDir: string): Promise<boolean> {
	let hooksDir: string;
	try {
		hooksDir = await getHooksDir(repoDir);
	} catch {
		return false;
	}
	return isGitHookInstalledInDir(hooksDir);
}

/**
 * Same as {@link isGitHookInstalled} but takes the hooks directory
 * directly (useful for tests that want to avoid the
 * `git rev-parse` round-trip). Mirrors Go
 * `isGitHookInstalledInHooksDir`.
 *
 * @example
 * await isGitHookInstalledInDir('/repo/.git/hooks');
 * // returns: true | false (same semantics as isGitHookInstalled)
 *
 * // Side effects: up to 5 fs.readFile calls; short-circuits on the
 * // first missing file / unreadable file / marker-less file.
 * // Worktree / index / HEAD / hook files: unchanged (pure read).
 */
export async function isGitHookInstalledInDir(hooksDir: string): Promise<boolean> {
	for (const name of MANAGED_GIT_HOOK_NAMES) {
		const hookPath = path.join(hooksDir, name);
		try {
			const data = await fs.readFile(hookPath, 'utf-8');
			if (!data.includes(STORY_HOOK_MARKER)) {
				return false;
			}
		} catch {
			return false;
		}
	}
	return true;
}

/**
 * Generate the 5 hook specs with the given command prefix.
 *
 * Each spec is a `#!/bin/sh` script that:
 * 1. Embeds the {@link STORY_HOOK_MARKER} comment (for detection)
 * 2. Calls `<cmdPrefix> hooks git <name>` with the git-hook args
 * 3. Uses `|| exit 1` for `commit-msg` (only hook that propagates
 *    errors — empty-commit abort) and `|| true` for the rest.
 *
 * Mirrors Go `buildHookSpecs`.
 *
 * @example
 * const specs = buildHookSpecs('story');
 * // returns: [
 * //   { name: 'prepare-commit-msg', content: '#!/bin/sh\n# Story CLI hooks\nstory hooks git prepare-commit-msg "$1" "$2" 2>/dev/null || true\n' },
 * //   ... 4 more
 * // ]
 */
export function buildHookSpecs(cmdPrefix: string): HookSpec[] {
	return [
		{
			name: 'prepare-commit-msg',
			content: `#!/bin/sh
# ${STORY_HOOK_MARKER}
${cmdPrefix} hooks git prepare-commit-msg "$1" "$2" 2>/dev/null || true
`,
		},
		{
			name: 'commit-msg',
			content: `#!/bin/sh
# ${STORY_HOOK_MARKER}
# Commit-msg hook: strip trailer if no user content (allows aborting empty commits)
${cmdPrefix} hooks git commit-msg "$1" || exit 1
`,
		},
		{
			name: 'post-commit',
			content: `#!/bin/sh
# ${STORY_HOOK_MARKER}
# Post-commit hook: condense session data if commit has Story-Checkpoint trailer
${cmdPrefix} hooks git post-commit 2>/dev/null || true
`,
		},
		{
			name: 'post-rewrite',
			content: `#!/bin/sh
# ${STORY_HOOK_MARKER}
# Post-rewrite hook: remap session linkage after amend/rebase rewrites
${cmdPrefix} hooks git post-rewrite "$1" 2>/dev/null || true
`,
		},
		{
			name: 'pre-push',
			content: `#!/bin/sh
# ${STORY_HOOK_MARKER}
# Pre-push hook: push session logs alongside user's push
# $1 is the remote name (e.g., "origin")
${cmdPrefix} hooks git pre-push "$1" || true
`,
		},
	];
}

/**
 * Install all 5 Story git hooks into the active hooks directory.
 *
 * Per-hook decision tree (matching Go `InstallGitHook`):
 *
 * 1. Existing hook contains {@link STORY_HOOK_MARKER} → skip (idempotent)
 * 2. Existing hook is NOT Story's:
 *    - `.pre-story` backup does not exist → rename original to backup
 *    - `.pre-story` backup already exists → `[story] Warning: ...`
 *      to stderr, do not overwrite the backup
 * 3. If a `.pre-story` backup now exists → produce chained content
 *    (`generateChainedContent` — `post-rewrite` uses stdin-replay)
 * 4. Write final hook file with mode `0o755`
 *
 * Returns the number of hook files actually written (0 when everything
 * is already up-to-date). Throws on unexpected fs errors.
 *
 * Mirrors Go `InstallGitHook`.
 *
 * @example
 * const count = await installGitHooks('/repo');
 * // returns: 5 (first install)
 *
 * // Side effects:
 * //   - Creates/updates <hooksDir>/{prepare-commit-msg,commit-msg,post-commit,post-rewrite,pre-push}
 * //   - May create <hooksDir>/<name>.pre-story backups for pre-existing user hooks
 * //   - stderr: '[story] Backed up existing <name> to <name>.pre-story' (per backup)
 * //   - stdout (when !silent): "\u2713 Installed git hooks ..."
 * //   - Worktree / index / HEAD: unchanged.
 *
 * await installGitHooks('/repo');
 * // returns: 0  (already installed — every file matches expected content)
 */
export async function installGitHooks(
	repoDir: string,
	opts?: { silent?: boolean; localDev?: boolean; absolutePath?: boolean },
): Promise<number> {
	const silent = opts?.silent ?? false;
	const localDev = opts?.localDev ?? false;
	const absolutePath = opts?.absolutePath ?? false;

	const hooksDir = await getHooksDir(repoDir);
	await fs.mkdir(hooksDir, { mode: 0o755, recursive: true });

	const cmdPrefix = hookCmdPrefix(localDev, absolutePath);
	const specs = buildHookSpecs(cmdPrefix);
	let installedCount = 0;

	for (const spec of specs) {
		const hookPath = path.join(hooksDir, spec.name);
		const backupPath = hookPath + BACKUP_SUFFIX;
		let backupExists = await fileExists(backupPath);

		// Phase 1: back up any pre-existing non-Story hook
		const existingContent = await readFileOrNull(hookPath);
		if (existingContent !== null && !existingContent.includes(STORY_HOOK_MARKER)) {
			if (!backupExists) {
				await fs.rename(hookPath, backupPath);
				process.stderr.write(
					`[story] Backed up existing ${spec.name} to ${spec.name}${BACKUP_SUFFIX}\n`,
				);
			} else {
				process.stderr.write(
					`[story] Warning: replacing ${spec.name} (backup ${spec.name}${BACKUP_SUFFIX} already exists from a previous install)\n`,
				);
			}
			backupExists = true;
		}

		// Phase 2: produce content with chain if a backup exists
		const content = backupExists ? generateChainedContent(spec.content, spec.name) : spec.content;

		const written = await writeHookFile(hookPath, content);
		if (written) {
			installedCount++;
		}
	}

	if (!silent) {
		// Story-side divergence from Go `hooks.go:271-272` which omits
		// `post-rewrite` from the banner (same-source bug). We list all
		// 5 managed hooks for doc-reality consistency; actual installed
		// files are driven by MANAGED_GIT_HOOK_NAMES regardless.
		process.stdout.write(
			'\u2713 Installed git hooks (prepare-commit-msg, commit-msg, post-commit, post-rewrite, pre-push)\n',
		);
		process.stdout.write('  Hooks delegate to the current strategy at runtime\n');
	}

	return installedCount;
}

/**
 * Remove all Story hooks and restore `.pre-story` backups where safe.
 *
 * Per-hook decision tree (matching Go `RemoveGitHook`):
 *
 * 1. Read hook. If it contains {@link STORY_HOOK_MARKER} → delete.
 * 2. If `.pre-story` backup exists:
 *    - Hook was Story's (just deleted) OR hook never existed → rename
 *      backup back to `<name>` (restore)
 *    - Hook exists but is NOT Story's (user or third-party replaced
 *      Story's hook after install) → leave backup in place, emit
 *      `[story] Warning:` to stderr
 *
 * Returns the number of hooks actually removed. Errors are collected
 * rather than short-circuited — matches Go's
 * `strings.Join(removeErrors, "; ")` aggregation. Throws with the
 * aggregated message when any error occurred; the count reflects how
 * many hooks were deleted before that.
 *
 * Mirrors Go `RemoveGitHook`.
 *
 * @example
 * const removed = await removeGitHooks('/repo');
 * // returns: 5 (all Story hooks deleted, backups restored where safe)
 *
 * // Side effects:
 * //   - Deletes <hooksDir>/<name> for each hook containing STORY_HOOK_MARKER
 * //   - Restores <hooksDir>/<name> from <hooksDir>/<name>.pre-story where safe
 * //   - stderr: '[story] Warning: <name> was modified since install; backup ... left in place'
 * //   - Worktree / index / HEAD: unchanged.
 */
export async function removeGitHooks(repoDir: string): Promise<number> {
	const hooksDir = await getHooksDir(repoDir);
	let removed = 0;
	const errors: string[] = [];

	for (const name of MANAGED_GIT_HOOK_NAMES) {
		const hookPath = path.join(hooksDir, name);
		const backupPath = hookPath + BACKUP_SUFFIX;

		const data = await readFileOrNull(hookPath);
		const hookExists = data !== null;
		const hookIsOurs = hookExists && data.includes(STORY_HOOK_MARKER);

		if (hookIsOurs) {
			try {
				await fs.unlink(hookPath);
				removed++;
			} catch (err) {
				errors.push(`${name}: ${(err as Error).message}`);
				continue;
			}
		}

		if (await fileExists(backupPath)) {
			if (hookExists && !hookIsOurs) {
				process.stderr.write(
					`[story] Warning: ${name} was modified since install; backup ${name}${BACKUP_SUFFIX} left in place\n`,
				);
			} else {
				try {
					await fs.rename(backupPath, hookPath);
				} catch (err) {
					errors.push(`restore ${name}${BACKUP_SUFFIX}: ${(err as Error).message}`);
				}
			}
		}
	}

	if (errors.length > 0) {
		throw new Error(`failed to remove hooks: ${errors.join('; ')}`);
	}
	return removed;
}

/**
 * Determine the command prefix embedded in each generated hook script.
 *
 * - `localDev: true`  → `'bun run src/cli.ts'` (Story-side rebrand of
 *   Go's `'go run ./cmd/entire/main.go'`). Intended for dogfooding with
 *   cwd at the `story-cli` package root (the directory that contains
 *   `src/cli.ts`, e.g. this repository root) — not the temporary
 *   repo under test.
 * - `absolutePath: true` → shell-quoted absolute path of the current
 *   binary (`process.execPath` after `realpath`). Needed for GUI git
 *   clients (Xcode, Tower) that don't source shell profiles.
 * - default → `'story'` (assumes the binary is on `PATH`).
 *
 * Mirrors Go `hookCmdPrefix`.
 *
 * @example
 * hookCmdPrefix(false, false);
 * // returns: 'story'
 *
 * hookCmdPrefix(true, false);
 * // returns: 'bun run src/cli.ts'
 *
 * hookCmdPrefix(false, true);
 * // returns: "'/usr/bin/node' '/opt/story/dist/cli.js'" when the running
 * // process is `node …/cli.js …` (E2E / CI); or a single quoted native
 * // binary path when `argv[1]` is not a JS entry.
 */
export function hookCmdPrefix(localDev: boolean, absolutePath: boolean): string {
	if (localDev) {
		return 'bun run src/cli.ts';
	}
	if (absolutePath) {
		const runtime = realpathSync(process.execPath);
		const storyBinEnv = process.env.STORY_BIN;
		if (storyBinEnv !== undefined && storyBinEnv !== '' && /\.(m?js|cjs|ts)$/i.test(storyBinEnv)) {
			const absScript = realpathSync(path.resolve(storyBinEnv));
			return `${shellQuote(runtime)} ${shellQuote(absScript)}`;
		}
		const scriptArg = process.argv[1];
		const looksLikeJsEntry =
			typeof scriptArg === 'string' &&
			scriptArg !== '' &&
			!scriptArg.startsWith('-') &&
			/\.(m?js|cjs|ts)$/i.test(scriptArg);
		if (looksLikeJsEntry) {
			const absScript = path.isAbsolute(scriptArg)
				? scriptArg
				: path.resolve(process.cwd(), scriptArg);
			return `${shellQuote(runtime)} ${shellQuote(realpathSync(absScript))}`;
		}
		return shellQuote(runtime);
	}
	return 'story';
}

/**
 * Wrap a string in single quotes for safe use in `#!/bin/sh` scripts.
 * Handles paths containing apostrophes (e.g.
 * `/Users/John O'Brien/bin/story`) via the classic
 * `'…'\''…'` escape dance.
 *
 * Mirrors Go `shellQuote`.
 *
 * @example
 * shellQuote('/usr/local/bin/story');
 * // returns: "'/usr/local/bin/story'"
 *
 * shellQuote("/Users/John O'Brien/bin/story");
 * // returns: "'/Users/John O'\\''Brien/bin/story'"
 */
export function shellQuote(s: string): string {
	return `'${s.replaceAll("'", "'\\''")}'`;
}

/**
 * Load hook-related settings from `.story/settings.json`. Returns
 * `{ localDev, absoluteHookPath }`. Any read / parse / validation error
 * collapses to both flags `false` — hook install should never fail
 * because of missing or malformed settings.
 *
 * Mirrors Go `hookSettingsFromConfig`.
 *
 * @example
 * await hookSettingsFromConfig('/repo');
 * // returns: { localDev: false, absoluteHookPath: false }  (no settings file or default)
 *
 * // Side effects: reads <repoDir>/.story/settings.json (one fs read).
 */
export async function hookSettingsFromConfig(
	repoDir: string,
): Promise<{ localDev: boolean; absoluteHookPath: boolean }> {
	try {
		const s = await readSettings(repoDir);
		return {
			localDev: s.local_dev ?? false,
			absoluteHookPath: s.absolute_git_hook_path ?? false,
		};
	} catch {
		return { localDev: false, absoluteHookPath: false };
	}
}

/**
 * Write the given hook file. Skips the write if the file already exists
 * with identical content — this is what makes `installGitHooks`
 * idempotent. Returns `true` if the file was written, `false` if
 * skipped.
 *
 * Mirrors Go `writeHookFile`. Permission `0o755` is mandatory (git
 * requires executable hooks).
 */
async function writeHookFile(hookPath: string, content: string): Promise<boolean> {
	const existing = await readFileOrNull(hookPath);
	if (existing === content) {
		return false;
	}
	await fs.writeFile(hookPath, content, { mode: 0o755 });
	// Ensure execute bit is set even when the file pre-existed (fs.writeFile
	// preserves existing permissions on some platforms).
	await fs.chmod(hookPath, 0o755);
	return true;
}

/**
 * Append the chain-call section to a hook script body. For every hook
 * except `post-rewrite`, the appended block resolves the hook
 * directory from `$0` and runs the `.pre-story` backup with the same
 * args. `post-rewrite` requires stdin replay — see
 * {@link generatePostRewriteChainedContent}.
 *
 * Mirrors Go `generateChainedContent`.
 */
function generateChainedContent(baseContent: string, hookName: string): string {
	if (hookName === 'post-rewrite') {
		return generatePostRewriteChainedContent(baseContent);
	}
	return `${baseContent}${CHAIN_COMMENT}
_story_hook_dir="$(dirname "$0")"
if [ -x "$_story_hook_dir/${hookName}${BACKUP_SUFFIX}" ]; then
    "$_story_hook_dir/${hookName}${BACKUP_SUFFIX}" "$@"
fi
`;
}

/**
 * Specialization of chain-call generation for `post-rewrite`, which
 * receives `<oldSha> <newSha>\n` rows on stdin. Because a pipe can be
 * read only once, Story's handler and the backup hook must each read
 * from a temp file that captures stdin up-front.
 *
 * Mirrors Go `generatePostRewriteChainedContent`.
 */
function generatePostRewriteChainedContent(baseContent: string): string {
	const original = `story hooks git post-rewrite "$1" 2>/dev/null || true`;
	const replacement = `story hooks git post-rewrite "$1" < "$_story_stdin" 2>/dev/null || true`;

	const replayPrefix =
		`_story_stdin="$(mktemp "\${TMPDIR:-/tmp}/story-post-rewrite.XXXXXX")"\ncat > "$_story_stdin"\ntrap 'rm -f "$_story_stdin"' EXIT\n` +
		replacement;

	return (
		baseContent.replace(original, replayPrefix) +
		`
${CHAIN_COMMENT}
_story_hook_dir="$(dirname "$0")"
if [ -x "$_story_hook_dir/post-rewrite${BACKUP_SUFFIX}" ]; then
    "$_story_hook_dir/post-rewrite${BACKUP_SUFFIX}" "$@" < "$_story_stdin"
fi
`
	);
}

/**
 * Async `fs.stat` wrapper. `ENOENT` collapses to `false`; any other
 * error is rethrown.
 */
async function fileExists(p: string): Promise<boolean> {
	try {
		await fs.stat(p);
		return true;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			return false;
		}
		throw err;
	}
}

/**
 * Read a UTF-8 file or return `null` when it doesn't exist. Any other
 * fs error is rethrown.
 */
async function readFileOrNull(p: string): Promise<string | null> {
	try {
		return await fs.readFile(p, 'utf-8');
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			return null;
		}
		throw err;
	}
}
