/**
 * Install / uninstall / detect Claude Code hooks in `<repoRoot>/.claude/settings.json`.
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/agent/claudecode/hooks.go`.
 *
 * Implements `HookSupport.installHooks` / `uninstallHooks` /
 * `areHooksInstalled` for {@link import('./index').ClaudeCodeAgent}.
 *
 * **Critical contract — settings.json round-trip MUST preserve user-managed
 * fields**:
 * - Unknown hook types (e.g. `Notification`, `SubagentStop`) — kept as their
 *   parsed JSON values inside `rawHooks` and re-emitted untouched
 * - User commands within known hook types (e.g. user's own `Stop` hook) —
 *   filtered out only if `isStoryHook(command)` matches a managed prefix
 * - `permissions.allow` / `ask` and any custom permission keys — kept inside
 *   `rawPermissions` and re-emitted untouched
 *
 * **Strategy**: parse top-level into `Record<string, unknown>` then surgically
 * edit only the 6 known hook types + the single `permissions.deny` rule.
 * Marshal back via `JSON.stringify(2-space indent) + '\n'` (matches Go
 * `jsonutil.MarshalIndentWithNewline`).
 *
 * @packageDocumentation
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import {
	isManagedHookCommand,
	WARNING_FORMAT_MULTI_LINE,
	wrapProductionJSONWarningHookCommand,
	wrapProductionSilentHookCommand,
} from '@/agent/hook-command';
import { worktreeRoot } from '@/paths';
import {
	CLAUDE_SETTINGS_FILE_NAME,
	type ClaudeHookEntry,
	type ClaudeHookMatcher,
	METADATA_DENY_RULE,
	STORY_HOOK_PREFIXES,
} from './types';

const HOOK_TYPES_WE_MANAGE = [
	'SessionStart',
	'SessionEnd',
	'Stop',
	'UserPromptSubmit',
	'PreToolUse',
	'PostToolUse',
] as const;

type ManagedHookType = (typeof HOOK_TYPES_WE_MANAGE)[number];

interface HookCommands {
	sessionStart: string;
	sessionEnd: string;
	stop: string;
	userPromptSubmit: string;
	preTask: string;
	postTask: string;
	postTodo: string;
}

/**
 * Build the 7 hook command strings, choosing localDev (`bun run ...`) or
 * production (`sh -c 'command -v story ...'`) wrapping.
 *
 * **Story-side rebrand**: Go uses `entire hooks ...` and `go run ...cmd/entire/main.go ...`;
 * Story uses `story hooks ...` and `bun run ...src/cli.ts ...`.
 */
function buildCommands(localDev: boolean): HookCommands {
	if (localDev) {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: ${CLAUDE_PROJECT_DIR} is a literal Claude shell variable, not a JS template.
		const prefix = 'bun run ${CLAUDE_PROJECT_DIR}/src/cli.ts hooks claude-code';
		return {
			sessionStart: `${prefix} session-start`,
			sessionEnd: `${prefix} session-end`,
			stop: `${prefix} stop`,
			userPromptSubmit: `${prefix} user-prompt-submit`,
			preTask: `${prefix} pre-task`,
			postTask: `${prefix} post-task`,
			postTodo: `${prefix} post-todo`,
		};
	}
	const wrapSilent = (cmd: string) => wrapProductionSilentHookCommand(cmd);
	return {
		// session-start emits a JSON warning (Claude renders systemMessage in chat).
		sessionStart: wrapProductionJSONWarningHookCommand(
			'story hooks claude-code session-start',
			WARNING_FORMAT_MULTI_LINE,
		),
		sessionEnd: wrapSilent('story hooks claude-code session-end'),
		stop: wrapSilent('story hooks claude-code stop'),
		userPromptSubmit: wrapSilent('story hooks claude-code user-prompt-submit'),
		preTask: wrapSilent('story hooks claude-code pre-task'),
		postTask: wrapSilent('story hooks claude-code post-task'),
		postTodo: wrapSilent('story hooks claude-code post-todo'),
	};
}

/**
 * Resolve the repo root for `installHooks`. Falls back to `process.cwd()`
 * when not in a git repo (matches Go `os.Getwd()` fallback in `hooks.go:51`).
 */
async function resolveRepoRootForInstall(): Promise<string> {
	try {
		return await worktreeRoot();
	} catch {
		return process.cwd();
	}
}

/**
 * Resolve the repo root for `uninstallHooks` / `areHooksInstalled`. Falls
 * back to `'.'` when not in a git repo (matches Go `repoRoot = "."` fallback
 * in `hooks.go:255` / `:374`).
 */
async function resolveRepoRootForUninstallOrCheck(): Promise<string> {
	try {
		return await worktreeRoot();
	} catch {
		return '.';
	}
}

/** Parse a `Record<string, unknown>['hookType']` into `ClaudeHookMatcher[]`,
 *  silently returning `[]` on shape mismatch (matches Go `parseHookType` which
 *  ignores unmarshal errors). */
function parseHookType(
	rawHooks: Record<string, unknown>,
	hookType: ManagedHookType,
): ClaudeHookMatcher[] {
	const data = rawHooks[hookType];
	if (!Array.isArray(data)) {
		return [];
	}
	const out: ClaudeHookMatcher[] = [];
	for (const m of data) {
		if (typeof m !== 'object' || m === null) {
			continue;
		}
		const matcher = (m as { matcher?: unknown }).matcher;
		const hooks = (m as { hooks?: unknown }).hooks;
		if (typeof matcher !== 'string' || !Array.isArray(hooks)) {
			continue;
		}
		const entries: ClaudeHookEntry[] = [];
		for (const h of hooks) {
			if (typeof h !== 'object' || h === null) {
				continue;
			}
			const command = (h as { command?: unknown }).command;
			const type = (h as { type?: unknown }).type;
			if (typeof command !== 'string' || type !== 'command') {
				continue;
			}
			entries.push({ type: 'command', command });
		}
		out.push({ matcher, hooks: entries });
	}
	return out;
}

/** Write a hook array back to `rawHooks`. If empty, delete the key (matches Go
 *  `marshalHookType: if len(matchers) == 0 { delete... }`). */
function marshalHookType(
	rawHooks: Record<string, unknown>,
	hookType: ManagedHookType,
	matchers: ClaudeHookMatcher[],
): void {
	if (matchers.length === 0) {
		delete rawHooks[hookType];
		return;
	}
	rawHooks[hookType] = matchers;
}

/**
 * True if any matcher contains a hook command exactly equal to `command`.
 * Mirrors Go `hookCommandExists`.
 */
export function hookCommandExists(matchers: ClaudeHookMatcher[], command: string): boolean {
	for (const m of matchers) {
		for (const h of m.hooks) {
			if (h.command === command) {
				return true;
			}
		}
	}
	return false;
}

/**
 * True if any matcher with `matcher === matcherName` contains a command
 * equal to `command`. Mirrors Go `hookCommandExistsWithMatcher`.
 */
export function hookCommandExistsWithMatcher(
	matchers: ClaudeHookMatcher[],
	matcherName: string,
	command: string,
): boolean {
	for (const m of matchers) {
		if (m.matcher !== matcherName) {
			continue;
		}
		for (const h of m.hooks) {
			if (h.command === command) {
				return true;
			}
		}
	}
	return false;
}

/**
 * True if any matcher contains a Story-managed command (matched via
 * {@link STORY_HOOK_PREFIXES}). Mirrors Go `hasEntireHook` (rebranded).
 */
export function hasStoryHook(matchers: ClaudeHookMatcher[]): boolean {
	for (const m of matchers) {
		for (const h of m.hooks) {
			if (isStoryHook(h.command)) {
				return true;
			}
		}
	}
	return false;
}

/** True if `command` is a Story-managed hook (direct prefix or production wrapper). */
export function isStoryHook(command: string): boolean {
	return isManagedHookCommand(command, [...STORY_HOOK_PREFIXES]);
}

/**
 * Add `command` to a matcher with `matcherName`. If `matcherName` is empty,
 * prefer the existing empty-matcher; else append a new matcher with
 * `matcher: ''`. If `matcherName` is non-empty, find or append a matcher
 * with that name. Mirrors Go `addHookToMatcher` exactly.
 */
export function addHookToMatcher(
	matchers: ClaudeHookMatcher[],
	matcherName: string,
	command: string,
): ClaudeHookMatcher[] {
	const entry: ClaudeHookEntry = { type: 'command', command };
	if (matcherName === '') {
		for (const m of matchers) {
			if (m.matcher === '') {
				m.hooks.push(entry);
				return matchers;
			}
		}
		matchers.push({ matcher: '', hooks: [entry] });
		return matchers;
	}
	for (const m of matchers) {
		if (m.matcher === matcherName) {
			m.hooks.push(entry);
			return matchers;
		}
	}
	matchers.push({ matcher: matcherName, hooks: [entry] });
	return matchers;
}

/** Strip Story-managed entries from each matcher; drop matchers that become
 *  empty. Mirrors Go `removeEntireHooks` (rebranded). */
export function removeStoryHooks(matchers: ClaudeHookMatcher[]): ClaudeHookMatcher[] {
	const result: ClaudeHookMatcher[] = [];
	for (const m of matchers) {
		const filtered = m.hooks.filter((h) => !isStoryHook(h.command));
		if (filtered.length > 0) {
			result.push({ matcher: m.matcher, hooks: filtered });
		}
	}
	return result;
}

/**
 * Install Claude Code hooks in `<repoRoot>/.claude/settings.json`. Returns
 * the number of hooks **newly added** (idempotent: existing identical
 * commands are not double-counted).
 *
 * @param opts.localDev - Use `bun run ${CLAUDE_PROJECT_DIR}/src/cli.ts ...`
 *   command form (for local Story dev) instead of
 *   `story hooks claude-code ...` (production binary).
 * @param opts.force - Strip existing Story hooks first, then re-install.
 *
 * @example
 * await installHooks({ localDev: false, force: false });
 * // returns: 7 (fresh install: 7 hooks added)
 *
 * await installHooks({ localDev: false, force: false });
 * // returns: 0 (idempotent re-install: nothing changed; file NOT rewritten)
 *
 * await installHooks({ localDev: false, force: true });
 * // returns: 7 (force-reinstall: existing Story hooks stripped + re-added)
 *
 * // Side effects (only when count > 0 OR permissions changed):
 * //   <repoRoot>/.claude/                ← created if missing (mode 0o750)
 * //   <repoRoot>/.claude/settings.json   ← rewritten with 2-space indent + trailing newline (mode 0o600)
 * //                                        - 6 hook types updated
 * //                                        - permissions.deny augmented with METADATA_DENY_RULE
 * //                                        - all unknown top-level keys, hook types, permission keys preserved
 * //   Worktree / index / HEAD: unchanged
 * //
 * // Optimization: when count == 0 AND permissions unchanged → no file write at all.
 *
 * @throws Error when settings.json exists but is not valid JSON / its
 *   `hooks` / `permissions` / `permissions.deny` fields have unexpected
 *   shapes (mirrors Go `failed to parse existing settings.json`).
 */
export async function installHooks(opts: { localDev: boolean; force: boolean }): Promise<number> {
	const repoRoot = await resolveRepoRootForInstall();
	const settingsPath = path.join(repoRoot, '.claude', CLAUDE_SETTINGS_FILE_NAME);

	// Read + parse (or initialize empty if missing).
	let rawSettings: Record<string, unknown>;
	let raw: string | null = null;
	try {
		raw = await fs.readFile(settingsPath, 'utf-8');
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
			throw err;
		}
	}
	if (raw === null) {
		rawSettings = {};
	} else {
		try {
			const parsed: unknown = JSON.parse(raw);
			if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
				throw new Error('top-level not an object');
			}
			rawSettings = parsed as Record<string, unknown>;
		} catch (err) {
			throw new Error(`failed to parse existing settings.json: ${(err as Error).message}`, {
				cause: err as Error,
			});
		}
	}

	// Pull out hooks + permissions sub-objects (preserving unknown sub-keys).
	let rawHooks: Record<string, unknown>;
	const hooksRaw = rawSettings.hooks;
	if (hooksRaw === undefined) {
		rawHooks = {};
	} else if (typeof hooksRaw === 'object' && hooksRaw !== null && !Array.isArray(hooksRaw)) {
		rawHooks = hooksRaw as Record<string, unknown>;
	} else {
		throw new Error('failed to parse hooks in settings.json: not an object');
	}

	let rawPermissions: Record<string, unknown>;
	const permRaw = rawSettings.permissions;
	if (permRaw === undefined) {
		rawPermissions = {};
	} else if (typeof permRaw === 'object' && permRaw !== null && !Array.isArray(permRaw)) {
		rawPermissions = permRaw as Record<string, unknown>;
	} else {
		throw new Error('failed to parse permissions in settings.json: not an object');
	}

	// Parse the 6 known hook types.
	let sessionStart = parseHookType(rawHooks, 'SessionStart');
	let sessionEnd = parseHookType(rawHooks, 'SessionEnd');
	let stop = parseHookType(rawHooks, 'Stop');
	let userPromptSubmit = parseHookType(rawHooks, 'UserPromptSubmit');
	let preToolUse = parseHookType(rawHooks, 'PreToolUse');
	let postToolUse = parseHookType(rawHooks, 'PostToolUse');

	if (opts.force) {
		sessionStart = removeStoryHooks(sessionStart);
		sessionEnd = removeStoryHooks(sessionEnd);
		stop = removeStoryHooks(stop);
		userPromptSubmit = removeStoryHooks(userPromptSubmit);
		preToolUse = removeStoryHooks(preToolUse);
		postToolUse = removeStoryHooks(postToolUse);
	}

	const cmd = buildCommands(opts.localDev);

	let count = 0;
	if (!hookCommandExists(sessionStart, cmd.sessionStart)) {
		sessionStart = addHookToMatcher(sessionStart, '', cmd.sessionStart);
		count++;
	}
	if (!hookCommandExists(sessionEnd, cmd.sessionEnd)) {
		sessionEnd = addHookToMatcher(sessionEnd, '', cmd.sessionEnd);
		count++;
	}
	if (!hookCommandExists(stop, cmd.stop)) {
		stop = addHookToMatcher(stop, '', cmd.stop);
		count++;
	}
	if (!hookCommandExists(userPromptSubmit, cmd.userPromptSubmit)) {
		userPromptSubmit = addHookToMatcher(userPromptSubmit, '', cmd.userPromptSubmit);
		count++;
	}
	if (!hookCommandExistsWithMatcher(preToolUse, 'Task', cmd.preTask)) {
		preToolUse = addHookToMatcher(preToolUse, 'Task', cmd.preTask);
		count++;
	}
	if (!hookCommandExistsWithMatcher(postToolUse, 'Task', cmd.postTask)) {
		postToolUse = addHookToMatcher(postToolUse, 'Task', cmd.postTask);
		count++;
	}
	if (!hookCommandExistsWithMatcher(postToolUse, 'TodoWrite', cmd.postTodo)) {
		postToolUse = addHookToMatcher(postToolUse, 'TodoWrite', cmd.postTodo);
		count++;
	}

	// Permissions.deny — append METADATA_DENY_RULE if missing.
	let permissionsChanged = false;
	let denyRules: string[] = [];
	const denyRaw = rawPermissions.deny;
	if (denyRaw !== undefined) {
		if (!Array.isArray(denyRaw)) {
			throw new Error('failed to parse permissions.deny in settings.json: not an array');
		}
		denyRules = denyRaw.filter((r): r is string => typeof r === 'string');
		// If the deny array contained non-string items, throw rather than silently dropping
		if (denyRules.length !== denyRaw.length) {
			throw new Error('failed to parse permissions.deny in settings.json: non-string entries');
		}
	}
	if (!denyRules.includes(METADATA_DENY_RULE)) {
		denyRules.push(METADATA_DENY_RULE);
		rawPermissions.deny = denyRules;
		permissionsChanged = true;
	}

	if (count === 0 && !permissionsChanged) {
		return 0;
	}

	marshalHookType(rawHooks, 'SessionStart', sessionStart);
	marshalHookType(rawHooks, 'SessionEnd', sessionEnd);
	marshalHookType(rawHooks, 'Stop', stop);
	marshalHookType(rawHooks, 'UserPromptSubmit', userPromptSubmit);
	marshalHookType(rawHooks, 'PreToolUse', preToolUse);
	marshalHookType(rawHooks, 'PostToolUse', postToolUse);

	rawSettings.hooks = rawHooks;
	rawSettings.permissions = rawPermissions;

	// Ensure .claude/ directory exists.
	await fs.mkdir(path.dirname(settingsPath), { recursive: true, mode: 0o750 });
	const output = `${JSON.stringify(rawSettings, null, 2)}\n`;
	await fs.writeFile(settingsPath, output, { mode: 0o600 });
	return count;
}

/**
 * Uninstall all Story-managed Claude hooks + remove the metadata deny rule.
 *
 * Mirrors Go `UninstallHooks`. Silent no-op when settings.json doesn't
 * exist (Go: `return nil` on read error).
 *
 * @example
 * await uninstallHooks();
 *
 * // Side effects:
 * //   - .claude/settings.json: Story hooks stripped from 6 hook types
 * //   - permissions.deny: METADATA_DENY_RULE removed (if deny becomes empty,
 * //     delete the deny key; if permissions becomes empty, delete the entire
 * //     permissions key)
 * //   - hooks key deleted entirely if empty after stripping
 * //   - Unknown hook types / user commands / other permission keys preserved
 * //
 * // Failure modes:
 * //   - settings.json missing → silent no-op (no throw)
 * //   - settings.json malformed → Error('failed to parse settings.json: ...')
 * //   - write failure → propagates fs error
 */
export async function uninstallHooks(): Promise<void> {
	const repoRoot = await resolveRepoRootForUninstallOrCheck();
	const settingsPath = path.join(repoRoot, '.claude', CLAUDE_SETTINGS_FILE_NAME);

	let raw: string;
	try {
		raw = await fs.readFile(settingsPath, 'utf-8');
	} catch {
		return;
	}

	let rawSettings: Record<string, unknown>;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
			throw new Error('top-level not an object');
		}
		rawSettings = parsed as Record<string, unknown>;
	} catch (err) {
		throw new Error(`failed to parse settings.json: ${(err as Error).message}`, {
			cause: err as Error,
		});
	}

	let rawHooks: Record<string, unknown>;
	const hooksRaw = rawSettings.hooks;
	if (hooksRaw === undefined) {
		rawHooks = {};
	} else if (typeof hooksRaw === 'object' && hooksRaw !== null && !Array.isArray(hooksRaw)) {
		rawHooks = hooksRaw as Record<string, unknown>;
	} else {
		throw new Error('failed to parse hooks: not an object');
	}

	const sessionStart = removeStoryHooks(parseHookType(rawHooks, 'SessionStart'));
	const sessionEnd = removeStoryHooks(parseHookType(rawHooks, 'SessionEnd'));
	const stop = removeStoryHooks(parseHookType(rawHooks, 'Stop'));
	const userPromptSubmit = removeStoryHooks(parseHookType(rawHooks, 'UserPromptSubmit'));
	const preToolUse = removeStoryHooks(parseHookType(rawHooks, 'PreToolUse'));
	const postToolUse = removeStoryHooks(parseHookType(rawHooks, 'PostToolUse'));

	marshalHookType(rawHooks, 'SessionStart', sessionStart);
	marshalHookType(rawHooks, 'SessionEnd', sessionEnd);
	marshalHookType(rawHooks, 'Stop', stop);
	marshalHookType(rawHooks, 'UserPromptSubmit', userPromptSubmit);
	marshalHookType(rawHooks, 'PreToolUse', preToolUse);
	marshalHookType(rawHooks, 'PostToolUse', postToolUse);

	// Permissions cleanup: strip the deny rule; if deny becomes empty, delete
	// the deny key; if permissions becomes empty, delete the entire key.
	const permRaw = rawSettings.permissions;
	if (typeof permRaw === 'object' && permRaw !== null && !Array.isArray(permRaw)) {
		const rawPermissions = permRaw as Record<string, unknown>;
		const denyRaw = rawPermissions.deny;
		if (Array.isArray(denyRaw)) {
			const filtered = denyRaw
				.filter((r): r is string => typeof r === 'string')
				.filter((r) => r !== METADATA_DENY_RULE);
			if (filtered.length > 0) {
				rawPermissions.deny = filtered;
			} else {
				delete rawPermissions.deny;
			}
		}
		if (Object.keys(rawPermissions).length > 0) {
			rawSettings.permissions = rawPermissions;
		} else {
			delete rawSettings.permissions;
		}
	}

	if (Object.keys(rawHooks).length > 0) {
		rawSettings.hooks = rawHooks;
	} else {
		delete rawSettings.hooks;
	}

	const output = `${JSON.stringify(rawSettings, null, 2)}\n`;
	await fs.writeFile(settingsPath, output, { mode: 0o600 });
}

/**
 * Whether Story hooks are currently installed.
 *
 * **Conservative check** (matches Go `AreHooksInstalled` exactly): inspects
 * only the `Stop` hook bucket. If any command there matches a managed prefix
 * (`STORY_HOOK_PREFIXES`), returns `true`.
 *
 * Returns `false` on missing settings.json or parse error (no throw).
 */
export async function areHooksInstalled(): Promise<boolean> {
	const repoRoot = await resolveRepoRootForUninstallOrCheck();
	const settingsPath = path.join(repoRoot, '.claude', CLAUDE_SETTINGS_FILE_NAME);
	let raw: string;
	try {
		raw = await fs.readFile(settingsPath, 'utf-8');
	} catch {
		return false;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return false;
	}
	if (typeof parsed !== 'object' || parsed === null) {
		return false;
	}
	const hooks = (parsed as { hooks?: unknown }).hooks;
	if (typeof hooks !== 'object' || hooks === null) {
		return false;
	}
	const stop = (hooks as { Stop?: unknown }).Stop;
	if (!Array.isArray(stop)) {
		return false;
	}
	const matchers = parseHookType({ Stop: stop } as Record<string, unknown>, 'Stop');
	return hasStoryHook(matchers);
}
