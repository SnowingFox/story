import { readFileSync, statSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execGit } from './git';

let worktreeRootCacheValue = '';
let worktreeRootCacheKey = '';

/** Clear the cached worktree root (call in test `beforeEach`). */
export function clearWorktreeRootCache(): void {
	worktreeRootCacheValue = '';
	worktreeRootCacheKey = '';
}

/**
 * Resolve the git worktree root via `git rev-parse --show-toplevel`. Cached by
 * cwd. Returns the path **as git reports it** (does NOT resolve symlinks).
 *
 * Go parity (`paths.go: WorktreeRoot` ~86-117) — Go does not call `realpath`
 * on the result; it caches whatever git printed. Earlier TS version called
 * `fs.realpath` which diverged: a user entering the repo via a symlink (e.g.
 * `~/proj` → `/Volumes/data/proj`) saw all subsequent path comparisons /
 * cache keys / `.story/` paths use the canonical target, while Go used the
 * symlink path. Cross-CLI agreement broke for any setup with symlinked repos
 * (common on macOS with externally-mounted disks).
 */
export async function worktreeRoot(cwd?: string): Promise<string> {
	const dir = cwd ?? process.cwd();
	if (worktreeRootCacheValue && worktreeRootCacheKey === dir) {
		return worktreeRootCacheValue;
	}

	const raw = await execGit(['rev-parse', '--show-toplevel'], { cwd: dir });

	worktreeRootCacheKey = dir;
	worktreeRootCacheValue = raw;
	return raw;
}

/**
 * Return the git worktree identifier for a path by reading the `.git` file.
 * Returns `null` for the main worktree (where `.git` is a directory).
 * Throws if `.git` doesn't exist or the file format is unexpected.
 */
export function getWorktreeID(worktreePath: string): string | null {
	const gitPath = path.join(worktreePath, '.git');

	let stat: ReturnType<typeof statSync>;
	try {
		stat = statSync(gitPath);
	} catch (err) {
		throw new Error(`failed to stat .git: ${err instanceof Error ? err.message : err}`);
	}

	if (stat.isDirectory()) {
		return null;
	}

	let content: string;
	try {
		content = readFileSync(gitPath, 'utf-8');
	} catch (err) {
		throw new Error(`failed to read .git file: ${err instanceof Error ? err.message : err}`);
	}

	const line = content.trim();
	if (!line.startsWith('gitdir: ')) {
		throw new Error(`invalid .git file format: ${line}`);
	}

	const gitdir = line.slice('gitdir: '.length);

	for (const marker of ['.git/worktrees/', '.bare/worktrees/']) {
		const idx = gitdir.indexOf(marker);
		if (idx !== -1) {
			let worktreeId = gitdir.slice(idx + marker.length);
			if (worktreeId.endsWith('/')) {
				worktreeId = worktreeId.slice(0, -1);
			}
			return worktreeId;
		}
	}

	throw new Error(`unexpected gitdir format (no worktrees): ${gitdir}`);
}

/**
 * Build the shadow branch name from a base commit hash and worktree fingerprint.
 *
 * @example
 * ```ts
 * shadowBranchName('abc1234567890', 'e3b0c4') // 'story/abc1234-e3b0c4'
 * ```
 */
export function shadowBranchName(baseCommit: string, worktreeId: string): string {
	return `story/${baseCommit.slice(0, 7)}-${worktreeId}`;
}

/**
 * Subdirectory inside `gitCommonDir` (`.git/`) that holds session state files.
 *
 * Defined in `paths.ts` as the single source of truth — same pattern as `.story/`
 * being defined in {@link storyDir}. Renamed from Go's `entire-sessions` to
 * follow the `Story-`/`.story/` rebrand convention (see AGENTS.md).
 */
export const SESSION_STATE_DIR_NAME = 'story-sessions';

/**
 * Path to the per-worktree session state directory inside `gitCommonDir`.
 * Resolves to `.git/story-sessions/` (or the equivalent under a linked worktree's
 * common dir, so all worktrees on the same repo share this directory).
 */
export function sessionStateDir(gitCommonDir: string): string {
	return path.join(gitCommonDir, SESSION_STATE_DIR_NAME);
}

/** Path to the `.story/` configuration directory inside a repo. */
export function storyDir(repoRoot: string): string {
	return path.join(repoRoot, '.story');
}

/** Resolve a file path inside the `.story/` directory. */
export function getStoryFilePath(repoRoot: string, filename: string): string {
	return path.join(storyDir(repoRoot), filename);
}

/**
 * Repo-relative path of the metadata directory used inside checkpoint git trees.
 *
 * This is a pure string constant (no path joining) — used as a tree-relative
 * key when building `TreeChange[]` entries for shadow / metadata branches.
 * Mirrors Go `paths.EntireMetadataDir`, rebranded to `.story/...` for Story.
 */
export const STORY_METADATA_DIR_NAME = '.story/metadata';

/**
 * Build the per-session metadata dir path used inside checkpoint git trees.
 *
 * @example
 * ```ts
 * storyMetadataDirForSession('abc-123') // '.story/metadata/abc-123'
 * ```
 */
export function storyMetadataDirForSession(sessionId: string): string {
	return `${STORY_METADATA_DIR_NAME}/${sessionId}`;
}

/** Test whether `child` is a sub-path of `parent` (or equal). */
export function isSubpath(parent: string, child: string): boolean {
	const rel = path.relative(parent, child);
	if (rel === '') {
		return true;
	}
	return rel !== '..' && !rel.startsWith(`..${path.sep}`);
}

/** Test whether a path is inside the `.story/` infrastructure directory. */
export function isInfrastructurePath(p: string): boolean {
	return isSubpath('.story', p);
}

/**
 * Convert an absolute path to a relative path from `cwd`.
 * Returns empty string if the result would escape `cwd` (contains `..`).
 */
export function toRelativePath(absPath: string, cwd: string): string {
	const normalizedAbs = normalizeMSYSPath(absPath);
	const normalizedCwd = normalizeMSYSPath(cwd);

	if (!path.isAbsolute(normalizedAbs)) {
		return normalizedAbs;
	}

	let relPath: string;
	try {
		relPath = path.relative(normalizedCwd, normalizedAbs);
	} catch {
		return '';
	}

	if (relPath.startsWith('..')) {
		return '';
	}

	return relPath;
}

/** Convert MSYS-style paths (`/c/Users/...`) to Windows format (`C:/Users/...`). No-op on non-Windows. */
export function normalizeMSYSPath(p: string): string {
	if (process.platform !== 'win32') {
		return p;
	}
	if (p.length >= 3 && p[0] === '/' && /^[a-zA-Z]$/.test(p[1]!) && p[2] === '/') {
		return `${p[1]!.toUpperCase()}:${p.slice(2)}`;
	}
	return p;
}

/**
 * Resolve a path to absolute form. Absolute paths pass through; relative paths
 * are joined to the current worktree root. Mirrors Go's `paths.AbsPath`.
 */
export async function absPath(relPath: string, cwd?: string): Promise<string> {
	if (path.isAbsolute(relPath)) {
		return relPath;
	}
	const root = await worktreeRoot(cwd);
	return path.join(root, relPath);
}

/**
 * Resolve a sub-path inside `root` and ensure it stays inside (after symlink resolution).
 * Throws if the resolved target escapes the root.
 *
 * Note: This is a userspace approximation of Go 1.24 `os.OpenRoot`'s kernel-level
 * `O_RESOLVE_BENEATH`. There is a small TOCTOU window between resolution and the
 * subsequent fs operation. Acceptable for our session-state use case (single-user
 * machine, no adversarial symlinks expected).
 */
async function resolveInRoot(root: string, relPath: string): Promise<string> {
	if (path.isAbsolute(relPath) || relPath.includes('\0')) {
		throw new Error(`invalid path inside root: ${relPath}`);
	}
	const resolvedRoot = await fs.realpath(root);
	const target = path.join(resolvedRoot, relPath);
	const normalized = path.normalize(target);
	if (!isSubpath(resolvedRoot, normalized)) {
		throw new Error(`path escapes root: ${relPath}`);
	}
	return normalized;
}

/** Read a file inside `root` with traversal protection. Wraps `fs.readFile`. */
export async function readFileInRoot(root: string, relPath: string): Promise<Buffer> {
	const target = await resolveInRoot(root, relPath);
	return fs.readFile(target);
}

/** Write a file inside `root` with traversal protection. Creates parent dirs as needed. */
export async function writeFileInRoot(
	root: string,
	relPath: string,
	data: string | Uint8Array,
	mode?: number,
): Promise<void> {
	const target = await resolveInRoot(root, relPath);
	await fs.mkdir(path.dirname(target), { recursive: true });
	await fs.writeFile(target, data, mode === undefined ? undefined : { mode });
}

/** Remove a file inside `root` with traversal protection. Missing files are ignored. */
export async function removeInRoot(root: string, relPath: string): Promise<void> {
	const target = await resolveInRoot(root, relPath);
	await fs.rm(target, { force: true });
}

/**
 * Read the last non-empty line from a JSONL file and extract its `timestamp`
 * field as a Date. Returns `null` (Go: zero `time.Time`) on:
 * - file doesn't exist / unreadable
 * - file is empty / has no non-empty lines
 * - last non-empty line isn't valid JSON
 * - JSON has no `timestamp` field
 * - timestamp string isn't parseable as a Date
 *
 * Mirrors Go `paths/transcript.go: GetLastTimestampFromFile`. Used by
 * Phase 5.5 `classifySessionsForRestore` to decide whether the local agent
 * session log has newer entries than the checkpoint version.
 *
 * @example
 * ```ts
 * await getLastTimestampFromFile('/Users/me/.claude/projects/repo/sess.jsonl');
 * // returns: Date(2026-04-15T10:30:00Z)   (last entry's timestamp)
 *
 * await getLastTimestampFromFile('/nonexistent.jsonl');
 * // returns: null
 *
 * // Side effects: read-only file access (single fs.readFile).
 * // Disk / git refs / HEAD: unchanged.
 * ```
 */
export async function getLastTimestampFromFile(filePath: string): Promise<Date | null> {
	let buf: Buffer;
	try {
		buf = await fs.readFile(filePath);
	} catch {
		return null;
	}
	return getLastTimestampFromBytes(new Uint8Array(buf));
}

/**
 * In-memory variant of {@link getLastTimestampFromFile} — extract the
 * timestamp of the last non-empty JSONL line from a buffer.
 *
 * Mirrors Go `paths/transcript.go: GetLastTimestampFromBytes`.
 *
 * @example
 * ```ts
 * getLastTimestampFromBytes(new TextEncoder().encode(
 *   '{"timestamp":"2026-04-15T10:30:00Z","msg":"hi"}\n'
 * ));
 * // returns: Date(2026-04-15T10:30:00Z)
 *
 * getLastTimestampFromBytes(new Uint8Array(0));
 * // returns: null
 *
 * // Side effects: none — pure parse.
 * ```
 */
export function getLastTimestampFromBytes(data: Uint8Array): Date | null {
	if (data.length === 0) {
		return null;
	}
	const text = new TextDecoder('utf-8').decode(data);
	let lastLine = '';
	for (const line of text.split('\n')) {
		if (line !== '') {
			lastLine = line;
		}
	}
	if (lastLine === '') {
		return null;
	}
	return parseTimestampFromJSONL(lastLine);
}

/**
 * Extract the `timestamp` field from a single JSONL line and parse as a
 * Date. Returns `null` on any parse failure (empty / non-JSON / missing
 * field / unparseable timestamp).
 *
 * Mirrors Go `paths/transcript.go: ParseTimestampFromJSONL`. Go uses
 * `time.RFC3339`; JS `new Date(...)` accepts the same syntax (plus a few
 * extras), which is fine — invalid strings still produce `Invalid Date`
 * (`getTime()` → NaN), which we normalize to `null`.
 *
 * @example
 * ```ts
 * parseTimestampFromJSONL('{"timestamp":"2026-04-15T10:30:00Z","msg":"hi"}');
 * // returns: Date(2026-04-15T10:30:00Z)
 *
 * parseTimestampFromJSONL('not json');                              // null
 * parseTimestampFromJSONL('{"msg":"no ts here"}');                  // null
 * parseTimestampFromJSONL('{"timestamp":"not a date"}');            // null
 * parseTimestampFromJSONL('');                                      // null
 * ```
 */
export function parseTimestampFromJSONL(line: string): Date | null {
	if (line === '') {
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return null;
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return null;
	}
	const ts = (parsed as { timestamp?: unknown }).timestamp;
	if (typeof ts !== 'string' || ts === '') {
		return null;
	}
	const date = new Date(ts);
	if (Number.isNaN(date.getTime())) {
		return null;
	}
	return date;
}
