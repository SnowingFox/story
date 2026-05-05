/**
 * Install / uninstall / detect Codex hooks in `<repoRoot>/.codex/hooks.json`
 * + ensure `<repoRoot>/.codex/config.toml` enables `codex_hooks` feature.
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/agent/codex/hooks.go`.
 *
 * **Critical contract — hooks.json round-trip MUST preserve user fields**:
 * - Unknown top-level fields (e.g. `$schema`)
 * - Unknown hook types (e.g. `PreToolUse` user matchers)
 * - User commands within Story-managed hook types (kept unless `isStoryHook`
 *   matches via prefix)
 *
 * **Strategy**: parse top-level into `Record<string, unknown>` then surgically
 * edit only the 3 Story-managed hook types (`SessionStart` / `UserPromptSubmit`
 * / `Stop`). Marshal back via `JSON.stringify(2-space indent) + '\n'` (matches
 * Go `jsonutil.MarshalIndentWithNewline`).
 *
 * **Story-managed hook types: 3 (NOT 4)**. `PreToolUse` is listed in
 * {@link import('./lifecycle').hookNames} so Codex CLI registers the verb,
 * but `parseHookEvent` returns `null` (pass-through). Install/uninstall do
 * NOT touch the `PreToolUse` bucket — user-managed.
 *
 * @packageDocumentation
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import {
	isManagedHookCommand,
	WARNING_FORMAT_SINGLE_LINE,
	wrapProductionJSONWarningHookCommand,
	wrapProductionSilentHookCommand,
} from '@/agent/hook-command';
import { worktreeRoot } from '@/paths';
import {
	CONFIG_FILE_NAME,
	FEATURE_LINE,
	HOOKS_FILE_NAME,
	type HookEntry,
	type MatcherGroup,
	STORY_HOOK_PREFIXES,
} from './types';

/** The 3 Story-managed hook event types in Codex's PascalCase scheme. */
const MANAGED_HOOK_TYPES = ['SessionStart', 'UserPromptSubmit', 'Stop'] as const;

type ManagedHookType = (typeof MANAGED_HOOK_TYPES)[number];

async function resolveRepoRoot(): Promise<string> {
	try {
		return await worktreeRoot();
	} catch {
		return '.';
	}
}

/**
 * Parse `rawHooks[hookType]` into a `MatcherGroup[]`. **Throws** on shape
 * mismatch (matches Go `parseHookType` which propagates `json.Unmarshal`
 * errors with `failed to parse <hookType> hooks` prefix).
 */
function parseHookType(
	rawHooks: Record<string, unknown>,
	hookType: ManagedHookType,
): MatcherGroup[] {
	const data = rawHooks[hookType];
	if (data === undefined) {
		return [];
	}
	if (!Array.isArray(data)) {
		throw new Error(`failed to parse ${hookType} hooks: expected array`);
	}
	const out: MatcherGroup[] = [];
	for (const groupRaw of data) {
		if (!groupRaw || typeof groupRaw !== 'object') {
			throw new Error(`failed to parse ${hookType} hooks: group is not an object`);
		}
		const group = groupRaw as { matcher?: unknown; hooks?: unknown };
		const matcherVal = group.matcher;
		const matcher: string | null =
			typeof matcherVal === 'string' ? matcherVal : matcherVal === null ? null : null;
		if (group.hooks !== undefined && !Array.isArray(group.hooks)) {
			throw new Error(`failed to parse ${hookType} hooks: hooks is not an array`);
		}
		const hooks: HookEntry[] = [];
		for (const hookRaw of (group.hooks as unknown[]) ?? []) {
			if (!hookRaw || typeof hookRaw !== 'object') {
				throw new Error(`failed to parse ${hookType} hooks: hook entry is not an object`);
			}
			const h = hookRaw as { type?: unknown; command?: unknown; timeout?: unknown };
			if (h.type !== 'command') {
				throw new Error(`failed to parse ${hookType} hooks: hook entry type is not "command"`);
			}
			if (typeof h.command !== 'string') {
				throw new Error(`failed to parse ${hookType} hooks: hook entry command is not a string`);
			}
			const entry: HookEntry = { type: 'command', command: h.command };
			if (typeof h.timeout === 'number') {
				entry.timeout = h.timeout;
			}
			hooks.push(entry);
		}
		out.push({ matcher, hooks });
	}
	return out;
}

/** Write `groups` back to `rawHooks[hookType]`. Empty → delete the key
 *  (matches Go `marshalHookType`). */
function marshalHookType(
	rawHooks: Record<string, unknown>,
	hookType: ManagedHookType,
	groups: MatcherGroup[],
): void {
	if (groups.length === 0) {
		delete rawHooks[hookType];
		return;
	}
	rawHooks[hookType] = groups;
}

/** True when `groups` already contains a hook with this exact command. */
function hookCommandExists(groups: MatcherGroup[], command: string): boolean {
	for (const g of groups) {
		for (const h of g.hooks ?? []) {
			if (h.command === command) {
				return true;
			}
		}
	}
	return false;
}

/**
 * Add a hook entry to `groups`. If a `matcher === null` group exists, append
 * to it; else create a new `{matcher: null, hooks: [entry]}` group.
 * Returns the (possibly new) group list.
 */
function addHook(groups: MatcherGroup[], command: string): MatcherGroup[] {
	const entry: HookEntry = { type: 'command', command, timeout: 30 };
	for (const g of groups) {
		if (g.matcher === null) {
			g.hooks.push(entry);
			return groups;
		}
	}
	return [...groups, { matcher: null, hooks: [entry] }];
}

function isStoryHook(command: string): boolean {
	return isManagedHookCommand(command, [...STORY_HOOK_PREFIXES]);
}

function hasStoryHook(groups: MatcherGroup[]): boolean {
	for (const g of groups) {
		for (const h of g.hooks ?? []) {
			if (isStoryHook(h.command)) {
				return true;
			}
		}
	}
	return false;
}

/**
 * Strip Story-managed entries from `groups`. Returns a new array containing
 * only groups with at least one user-managed hook remaining (groups that
 * become empty after stripping are dropped entirely — matches Go
 * `removeEntireHooks`).
 */
function removeStoryHooks(groups: MatcherGroup[]): MatcherGroup[] {
	const out: MatcherGroup[] = [];
	for (const g of groups) {
		const filtered = (g.hooks ?? []).filter((h) => !isStoryHook(h.command));
		if (filtered.length > 0) {
			out.push({ matcher: g.matcher, hooks: filtered });
		}
	}
	return out;
}

/**
 * Install Codex hooks in `<repoRoot>/.codex/hooks.json` + ensure
 * `<repoRoot>/.codex/config.toml` has `[features] codex_hooks = true`.
 * Returns the number of hooks **newly added** (idempotent: re-installing
 * identical commands counts as 0 but still ensures feature flag).
 *
 * Mirrors Go `hooks.go: InstallHooks` — 3-hook payload (SessionStart /
 * UserPromptSubmit / Stop). PreToolUse is listed in `hookNames()` but never
 * installed (pass-through).
 *
 * @param opts.localDev - Use `bun run "$(git rev-parse --show-toplevel)"/src/cli.ts ...`
 *   (Story rebrand of Go's `go run "..."/cmd/entire/main.go ...`) instead of
 *   the production `story hooks codex ...` binary.
 * @param opts.force - Strip existing Story hooks first, then re-install.
 *
 * @example
 * await installHooks({ localDev: false, force: false });
 * // returns: 3   (fresh install: 3 hooks added)
 *
 * await installHooks({ localDev: false, force: false });
 * // returns: 0   (idempotent — file NOT rewritten when count===0; feature flag still ensured)
 *
 * // Side effects (when count > 0):
 * //   <repoRoot>/.codex/                ← created if missing (mode 0o750)
 * //   <repoRoot>/.codex/hooks.json      ← rewritten with 2-space indent + trailing newline (mode 0o600)
 * //                                        - 3 Story hook types updated
 * //                                        - all unknown top-level keys, hook types preserved
 * //   <repoRoot>/.codex/config.toml     ← ensured to contain [features] codex_hooks = true
 * //   Worktree / index / HEAD: unchanged
 *
 * @throws Error when hooks.json exists but is not valid JSON, or when any
 *   managed hook bucket has wrong shape (`failed to parse <bucket> hooks`).
 */
export async function installHooks(opts: { localDev: boolean; force: boolean }): Promise<number> {
	const repoRoot = await resolveRepoRoot();
	const hooksPath = path.join(repoRoot, '.codex', HOOKS_FILE_NAME);

	let topLevel: Record<string, unknown> = {};
	let raw: string | null = null;
	try {
		raw = await fs.readFile(hooksPath, 'utf-8');
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
			throw new Error(`failed to read existing hooks.json: ${(err as Error).message}`, {
				cause: err as Error,
			});
		}
	}
	if (raw !== null) {
		try {
			const parsed: unknown = JSON.parse(raw);
			if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
				throw new Error('top-level not an object');
			}
			topLevel = parsed as Record<string, unknown>;
		} catch (err) {
			throw new Error(`failed to parse existing hooks.json: ${(err as Error).message}`, {
				cause: err as Error,
			});
		}
	}

	let rawHooks: Record<string, unknown>;
	const hooksRaw = topLevel.hooks;
	if (hooksRaw === undefined) {
		rawHooks = {};
	} else if (typeof hooksRaw === 'object' && hooksRaw !== null && !Array.isArray(hooksRaw)) {
		rawHooks = hooksRaw as Record<string, unknown>;
	} else {
		throw new Error('failed to parse hooks in hooks.json: hooks is not an object');
	}

	let sessionStart = parseHookType(rawHooks, 'SessionStart');
	let userPromptSubmit = parseHookType(rawHooks, 'UserPromptSubmit');
	let stop = parseHookType(rawHooks, 'Stop');

	if (opts.force) {
		sessionStart = removeStoryHooks(sessionStart);
		userPromptSubmit = removeStoryHooks(userPromptSubmit);
		stop = removeStoryHooks(stop);
	}

	const cmdPrefix = opts.localDev
		? 'bun run "$(git rev-parse --show-toplevel)"/src/cli.ts hooks codex '
		: 'story hooks codex ';

	let sessionStartCmd = `${cmdPrefix}session-start`;
	let userPromptSubmitCmd = `${cmdPrefix}user-prompt-submit`;
	let stopCmd = `${cmdPrefix}stop`;
	if (!opts.localDev) {
		sessionStartCmd = wrapProductionJSONWarningHookCommand(
			sessionStartCmd,
			WARNING_FORMAT_SINGLE_LINE,
		);
		userPromptSubmitCmd = wrapProductionSilentHookCommand(userPromptSubmitCmd);
		stopCmd = wrapProductionSilentHookCommand(stopCmd);
	}

	let count = 0;
	if (!hookCommandExists(sessionStart, sessionStartCmd)) {
		sessionStart = addHook(sessionStart, sessionStartCmd);
		count++;
	}
	if (!hookCommandExists(userPromptSubmit, userPromptSubmitCmd)) {
		userPromptSubmit = addHook(userPromptSubmit, userPromptSubmitCmd);
		count++;
	}
	if (!hookCommandExists(stop, stopCmd)) {
		stop = addHook(stop, stopCmd);
		count++;
	}

	if (count === 0) {
		// Still ensure the feature flag is configured (matches Go behavior).
		await ensureProjectFeatureEnabled(repoRoot);
		return 0;
	}

	marshalHookType(rawHooks, 'SessionStart', sessionStart);
	marshalHookType(rawHooks, 'UserPromptSubmit', userPromptSubmit);
	marshalHookType(rawHooks, 'Stop', stop);
	topLevel.hooks = rawHooks;

	await fs.mkdir(path.dirname(hooksPath), { recursive: true, mode: 0o750 });
	const output = `${JSON.stringify(topLevel, null, 2)}\n`;
	await fs.writeFile(hooksPath, output, { mode: 0o600 });

	await ensureProjectFeatureEnabled(repoRoot);
	return count;
}

/**
 * Uninstall Story-managed Codex hooks. Silent no-op when hooks.json doesn't
 * exist (Go: `return nil` on read error).
 *
 * Mirrors Go `hooks.go: UninstallHooks`. After stripping, if `rawHooks` is
 * empty, the entire `hooks` key is dropped from the file.
 *
 * @example
 * await uninstallHooks();
 *
 * // Side effects:
 * //   - .codex/hooks.json: Story hooks stripped from 3 managed types
 * //   - hooks key dropped if rawHooks becomes empty
 * //   - User commands / unknown hook types / unknown top-level fields preserved
 * //
 * // Failure modes:
 * //   - hooks.json missing       → silent no-op (no throw)
 * //   - hooks.json malformed JSON → Error('failed to parse hooks.json: ...')
 * //   - any bucket malformed     → Error('failed to parse <bucket> hooks: ...')
 */
export async function uninstallHooks(): Promise<void> {
	const repoRoot = await resolveRepoRoot();
	const hooksPath = path.join(repoRoot, '.codex', HOOKS_FILE_NAME);

	let raw: string;
	try {
		raw = await fs.readFile(hooksPath, 'utf-8');
	} catch {
		return;
	}

	let topLevel: Record<string, unknown>;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
			throw new Error('top-level not an object');
		}
		topLevel = parsed as Record<string, unknown>;
	} catch (err) {
		throw new Error(`failed to parse hooks.json: ${(err as Error).message}`, {
			cause: err as Error,
		});
	}

	let rawHooks: Record<string, unknown>;
	const hooksRaw = topLevel.hooks;
	if (hooksRaw === undefined) {
		return;
	}
	if (typeof hooksRaw !== 'object' || hooksRaw === null || Array.isArray(hooksRaw)) {
		return;
	}
	rawHooks = hooksRaw as Record<string, unknown>;

	const sessionStart = removeStoryHooks(parseHookType(rawHooks, 'SessionStart'));
	const userPromptSubmit = removeStoryHooks(parseHookType(rawHooks, 'UserPromptSubmit'));
	const stop = removeStoryHooks(parseHookType(rawHooks, 'Stop'));

	marshalHookType(rawHooks, 'SessionStart', sessionStart);
	marshalHookType(rawHooks, 'UserPromptSubmit', userPromptSubmit);
	marshalHookType(rawHooks, 'Stop', stop);

	if (Object.keys(rawHooks).length > 0) {
		topLevel.hooks = rawHooks;
	} else {
		delete topLevel.hooks;
	}

	const output = `${JSON.stringify(topLevel, null, 2)}\n`;
	await fs.writeFile(hooksPath, output, { mode: 0o600 });
}

/**
 * Whether Story hooks are currently installed in **all 3** managed buckets
 * (SessionStart + UserPromptSubmit + Stop). Returns `false` on missing file
 * or parse error (no throw).
 *
 * Mirrors Go `hooks.go: AreHooksInstalled` — `&&` over 3 buckets (NOT `||`).
 * Partial install (only Stop) returns `false`.
 */
export async function areHooksInstalled(): Promise<boolean> {
	const repoRoot = await resolveRepoRoot();
	const hooksPath = path.join(repoRoot, '.codex', HOOKS_FILE_NAME);
	let raw: string;
	try {
		raw = await fs.readFile(hooksPath, 'utf-8');
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
	if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) {
		return false;
	}
	const h = hooks as Record<string, unknown>;
	for (const hookType of MANAGED_HOOK_TYPES) {
		let groups: MatcherGroup[];
		try {
			groups = parseHookType(h, hookType);
		} catch {
			return false;
		}
		if (!hasStoryHook(groups)) {
			return false;
		}
	}
	return true;
}

/**
 * Write `[features] codex_hooks = true` to `<repoRoot>/.codex/config.toml`
 * (per-repo feature flag, NOT global).
 *
 * Mirrors Go `hooks.go: ensureProjectFeatureEnabled`. 4 cases:
 *
 *   1. config.toml missing (ENOENT)        → create with `\n[features]\n<line>\n`
 *   2. content already contains feature line → no-op
 *   3. content contains `[features]` section → string replace insert under it
 *   4. content has no `[features]` section   → append `\n[features]\n<line>\n`
 */
async function ensureProjectFeatureEnabled(repoRoot: string): Promise<void> {
	const configPath = path.join(repoRoot, '.codex', CONFIG_FILE_NAME);
	let content = '';
	try {
		content = await fs.readFile(configPath, 'utf-8');
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
			throw new Error(`failed to read config.toml: ${(err as Error).message}`, {
				cause: err as Error,
			});
		}
	}
	if (content.includes(FEATURE_LINE)) {
		return;
	}
	let newContent: string;
	if (content.includes('[features]')) {
		newContent = content.replace('[features]', `[features]\n${FEATURE_LINE}`);
	} else {
		const trailer = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
		newContent = `${content}${trailer}\n[features]\n${FEATURE_LINE}\n`;
	}
	await fs.mkdir(path.dirname(configPath), { recursive: true, mode: 0o750 });
	await fs.writeFile(configPath, newContent, { mode: 0o600 });
}
