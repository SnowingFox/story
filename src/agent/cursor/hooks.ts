/**
 * Install / uninstall / detect Cursor hooks in `<repoRoot>/.cursor/hooks.json`.
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/agent/cursor/hooks.go`.
 *
 * **Critical contract — hooks.json round-trip MUST preserve user-managed
 * fields**:
 * - Unknown top-level fields (e.g. `cursorSettings`)
 * - Unknown hook types (e.g. `onNotification`, `customHook`)
 * - User commands within known hook types (kept unless `isStoryHook` matches)
 *
 * **Strategy**: parse top-level into `Record<string, unknown>` then surgically
 * edit only the 7 known hook types. Marshal back via
 * `JSON.stringify(2-space indent) + '\n'` (matches Go
 * `jsonutil.MarshalIndentWithNewline` byte-for-byte for canonical input).
 *
 * @packageDocumentation
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { isManagedHookCommand, wrapProductionSilentHookCommand } from '@/agent/hook-command';
import { worktreeRoot } from '@/paths';
import {
	CURSOR_HOOKS_FILE_NAME,
	type CursorHookEntry,
	HOOK_NAME_BEFORE_SUBMIT_PROMPT,
	HOOK_NAME_PRE_COMPACT,
	HOOK_NAME_SESSION_END,
	HOOK_NAME_SESSION_START,
	HOOK_NAME_STOP,
	HOOK_NAME_SUBAGENT_START,
	HOOK_NAME_SUBAGENT_STOP,
	STORY_HOOK_PREFIXES,
} from './types';

const MANAGED_HOOK_TYPES = [
	'sessionStart',
	'sessionEnd',
	'beforeSubmitPrompt',
	'stop',
	'preCompact',
	'subagentStart',
	'subagentStop',
] as const;

type ManagedHookType = (typeof MANAGED_HOOK_TYPES)[number];

/**
 * The 7 hook verbs Cursor supports. Order matches Go `cursor/hooks.go: HookNames`.
 */
export function hookNames(): string[] {
	return [
		HOOK_NAME_SESSION_START,
		HOOK_NAME_SESSION_END,
		HOOK_NAME_BEFORE_SUBMIT_PROMPT,
		HOOK_NAME_STOP,
		HOOK_NAME_PRE_COMPACT,
		HOOK_NAME_SUBAGENT_START,
		HOOK_NAME_SUBAGENT_STOP,
	];
}

async function resolveRepoRoot(): Promise<string> {
	try {
		return await worktreeRoot();
	} catch {
		return '.';
	}
}

/** Parse `rawHooks[hookType]` into a working `CursorHookEntry[]`. Silently
 *  returns `[]` on shape mismatch (matches Go `parseCursorHookType` which
 *  ignores unmarshal errors). */
function parseCursorHookType(
	rawHooks: Record<string, unknown>,
	hookType: ManagedHookType,
): CursorHookEntry[] {
	const data = rawHooks[hookType];
	if (!Array.isArray(data)) {
		return [];
	}
	const out: CursorHookEntry[] = [];
	for (const e of data) {
		if (typeof e !== 'object' || e === null) {
			continue;
		}
		const command = (e as { command?: unknown }).command;
		if (typeof command !== 'string') {
			continue;
		}
		const matcher = (e as { matcher?: unknown }).matcher;
		const entry: CursorHookEntry = { command };
		if (typeof matcher === 'string' && matcher !== '') {
			entry.matcher = matcher;
		}
		out.push(entry);
	}
	return out;
}

/** Write a hook array back to `rawHooks`. If empty, delete the key (matches Go
 *  `marshalCursorHookType`). */
function marshalCursorHookType(
	rawHooks: Record<string, unknown>,
	hookType: ManagedHookType,
	entries: CursorHookEntry[],
): void {
	if (entries.length === 0) {
		delete rawHooks[hookType];
		return;
	}
	rawHooks[hookType] = entries;
}

/**
 * True if `entries` already contains a hook with this exact command.
 */
function hookCommandExists(entries: CursorHookEntry[], command: string): boolean {
	for (const e of entries) {
		if (e.command === command) {
			return true;
		}
	}
	return false;
}

/**
 * True if `command` is a Story-managed hook (direct prefix or production wrapper).
 */
function isStoryHook(command: string): boolean {
	return isManagedHookCommand(command, [...STORY_HOOK_PREFIXES]);
}

/**
 * True if any entry contains a Story-managed command.
 */
function hasStoryHook(entries: CursorHookEntry[] | undefined): boolean {
	if (!Array.isArray(entries)) {
		return false;
	}
	for (const e of entries) {
		if (
			typeof e === 'object' &&
			e !== null &&
			typeof e.command === 'string' &&
			isStoryHook(e.command)
		) {
			return true;
		}
	}
	return false;
}

/**
 * Strip Story-managed entries from `entries`, returning a new array.
 */
function removeStoryHooks(entries: CursorHookEntry[]): CursorHookEntry[] {
	return entries.filter((e) => !isStoryHook(e.command));
}

/**
 * Install Cursor hooks in `<repoRoot>/.cursor/hooks.json`. Returns the number
 * of hooks **newly added** (idempotent: re-installing identical commands
 * counts as 0 and writes nothing).
 *
 * Mirrors Go `cursor/hooks.go: InstallHooks`. 7-hook payload covering all
 * Cursor lifecycle verbs.
 *
 * @param opts.localDev - Use `bun run "$(git rev-parse --show-toplevel)"/src/cli.ts ...`
 *   (Story rebrand of Go's `go run "..."/cmd/entire/main.go ...`) instead of
 *   the production `story hooks cursor ...` binary.
 * @param opts.force - Strip existing Story hooks first, then re-install.
 *
 * @example
 * await installHooks({ localDev: false, force: false });
 * // returns: 7   (fresh install: all 7 hooks added)
 *
 * await installHooks({ localDev: false, force: false });
 * // returns: 0   (idempotent — file NOT rewritten when count === 0)
 *
 * await installHooks({ localDev: false, force: true });
 * // returns: 7   (existing Story hooks stripped + re-added)
 *
 * // Side effects (only when count > 0):
 * //   <repoRoot>/.cursor/                ← created if missing (mode 0o750)
 * //   <repoRoot>/.cursor/hooks.json      ← rewritten with 2-space indent + trailing newline (mode 0o600)
 * //                                        - 7 hook types updated
 * //                                        - all unknown top-level keys, hook types, version preserved
 * //   Worktree / index / HEAD: unchanged
 *
 * @throws Error when hooks.json exists but is not valid JSON (Go:
 *   `failed to parse existing hooks.json`).
 */
export async function installHooks(opts: { localDev: boolean; force: boolean }): Promise<number> {
	const repoRoot = await resolveRepoRoot();
	const hooksPath = path.join(repoRoot, '.cursor', CURSOR_HOOKS_FILE_NAME);

	let rawFile: Record<string, unknown>;
	let raw: string | null = null;
	try {
		raw = await fs.readFile(hooksPath, 'utf-8');
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
			throw err;
		}
	}
	if (raw === null) {
		rawFile = { version: 1 };
	} else {
		try {
			const parsed: unknown = JSON.parse(raw);
			if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
				throw new Error('top-level not an object');
			}
			rawFile = parsed as Record<string, unknown>;
		} catch (err) {
			throw new Error(
				`failed to parse existing ${CURSOR_HOOKS_FILE_NAME}: ${(err as Error).message}`,
				{ cause: err as Error },
			);
		}
		if (!('version' in rawFile)) {
			rawFile.version = 1;
		}
	}

	let rawHooks: Record<string, unknown>;
	const hooksRaw = rawFile.hooks;
	if (hooksRaw === undefined) {
		rawHooks = {};
	} else if (typeof hooksRaw === 'object' && hooksRaw !== null && !Array.isArray(hooksRaw)) {
		rawHooks = hooksRaw as Record<string, unknown>;
	} else {
		rawHooks = {};
	}

	let sessionStart = parseCursorHookType(rawHooks, 'sessionStart');
	let sessionEnd = parseCursorHookType(rawHooks, 'sessionEnd');
	let beforeSubmitPrompt = parseCursorHookType(rawHooks, 'beforeSubmitPrompt');
	let stop = parseCursorHookType(rawHooks, 'stop');
	let preCompact = parseCursorHookType(rawHooks, 'preCompact');
	let subagentStart = parseCursorHookType(rawHooks, 'subagentStart');
	let subagentStop = parseCursorHookType(rawHooks, 'subagentStop');

	if (opts.force) {
		sessionStart = removeStoryHooks(sessionStart);
		sessionEnd = removeStoryHooks(sessionEnd);
		beforeSubmitPrompt = removeStoryHooks(beforeSubmitPrompt);
		stop = removeStoryHooks(stop);
		preCompact = removeStoryHooks(preCompact);
		subagentStart = removeStoryHooks(subagentStart);
		subagentStop = removeStoryHooks(subagentStop);
	}

	const cmdPrefix = opts.localDev
		? 'bun run "$(git rev-parse --show-toplevel)"/src/cli.ts hooks cursor '
		: 'story hooks cursor ';
	const wrap = (verb: string): string => {
		const cmd = cmdPrefix + verb;
		return opts.localDev ? cmd : wrapProductionSilentHookCommand(cmd);
	};

	const sessionStartCmd = wrap(HOOK_NAME_SESSION_START);
	const sessionEndCmd = wrap(HOOK_NAME_SESSION_END);
	const beforeSubmitPromptCmd = wrap(HOOK_NAME_BEFORE_SUBMIT_PROMPT);
	const stopCmd = wrap(HOOK_NAME_STOP);
	const preCompactCmd = wrap(HOOK_NAME_PRE_COMPACT);
	const subagentStartCmd = wrap(HOOK_NAME_SUBAGENT_START);
	const subagentStopCmd = wrap(HOOK_NAME_SUBAGENT_STOP);

	let count = 0;
	if (!hookCommandExists(sessionStart, sessionStartCmd)) {
		sessionStart.push({ command: sessionStartCmd });
		count++;
	}
	if (!hookCommandExists(sessionEnd, sessionEndCmd)) {
		sessionEnd.push({ command: sessionEndCmd });
		count++;
	}
	if (!hookCommandExists(beforeSubmitPrompt, beforeSubmitPromptCmd)) {
		beforeSubmitPrompt.push({ command: beforeSubmitPromptCmd });
		count++;
	}
	if (!hookCommandExists(stop, stopCmd)) {
		stop.push({ command: stopCmd });
		count++;
	}
	if (!hookCommandExists(preCompact, preCompactCmd)) {
		preCompact.push({ command: preCompactCmd });
		count++;
	}
	if (!hookCommandExists(subagentStart, subagentStartCmd)) {
		subagentStart.push({ command: subagentStartCmd });
		count++;
	}
	if (!hookCommandExists(subagentStop, subagentStopCmd)) {
		subagentStop.push({ command: subagentStopCmd });
		count++;
	}

	if (count === 0) {
		return 0;
	}

	marshalCursorHookType(rawHooks, 'sessionStart', sessionStart);
	marshalCursorHookType(rawHooks, 'sessionEnd', sessionEnd);
	marshalCursorHookType(rawHooks, 'beforeSubmitPrompt', beforeSubmitPrompt);
	marshalCursorHookType(rawHooks, 'stop', stop);
	marshalCursorHookType(rawHooks, 'preCompact', preCompact);
	marshalCursorHookType(rawHooks, 'subagentStart', subagentStart);
	marshalCursorHookType(rawHooks, 'subagentStop', subagentStop);

	rawFile.hooks = rawHooks;

	await fs.mkdir(path.dirname(hooksPath), { recursive: true, mode: 0o750 });
	const output = `${JSON.stringify(rawFile, null, 2)}\n`;
	await fs.writeFile(hooksPath, output, { mode: 0o600 });
	return count;
}

/**
 * Uninstall Story-managed Cursor hooks. Silent no-op when hooks.json doesn't
 * exist (Go: `return nil` on read error).
 *
 * Mirrors Go `cursor/hooks.go: UninstallHooks`. After stripping, if `rawHooks`
 * is empty, the entire `hooks` key is dropped from the file (so leaving e.g.
 * `cursorSettings` standalone) — matches Go `delete(rawFile, "hooks")`.
 *
 * @example
 * await uninstallHooks();
 *
 * // Side effects:
 * //   - .cursor/hooks.json: Story hooks stripped from 7 hook types
 * //   - hooks key dropped if rawHooks becomes empty after stripping
 * //   - Unknown hook types / user commands / unknown top-level fields preserved
 * //
 * // Failure modes:
 * //   - hooks.json missing       → silent no-op (no throw)
 * //   - hooks.json malformed JSON → Error('failed to parse hooks.json: ...')
 * //   - write failure             → propagates fs error
 */
export async function uninstallHooks(): Promise<void> {
	const repoRoot = await resolveRepoRoot();
	const hooksPath = path.join(repoRoot, '.cursor', CURSOR_HOOKS_FILE_NAME);

	let raw: string;
	try {
		raw = await fs.readFile(hooksPath, 'utf-8');
	} catch {
		return;
	}

	let rawFile: Record<string, unknown>;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
			throw new Error('top-level not an object');
		}
		rawFile = parsed as Record<string, unknown>;
	} catch (err) {
		throw new Error(`failed to parse ${CURSOR_HOOKS_FILE_NAME}: ${(err as Error).message}`, {
			cause: err as Error,
		});
	}

	let rawHooks: Record<string, unknown>;
	const hooksRaw = rawFile.hooks;
	if (hooksRaw === undefined) {
		rawHooks = {};
	} else if (typeof hooksRaw === 'object' && hooksRaw !== null && !Array.isArray(hooksRaw)) {
		rawHooks = hooksRaw as Record<string, unknown>;
	} else {
		rawHooks = {};
	}

	const sessionStart = removeStoryHooks(parseCursorHookType(rawHooks, 'sessionStart'));
	const sessionEnd = removeStoryHooks(parseCursorHookType(rawHooks, 'sessionEnd'));
	const beforeSubmitPrompt = removeStoryHooks(parseCursorHookType(rawHooks, 'beforeSubmitPrompt'));
	const stop = removeStoryHooks(parseCursorHookType(rawHooks, 'stop'));
	const preCompact = removeStoryHooks(parseCursorHookType(rawHooks, 'preCompact'));
	const subagentStart = removeStoryHooks(parseCursorHookType(rawHooks, 'subagentStart'));
	const subagentStop = removeStoryHooks(parseCursorHookType(rawHooks, 'subagentStop'));

	marshalCursorHookType(rawHooks, 'sessionStart', sessionStart);
	marshalCursorHookType(rawHooks, 'sessionEnd', sessionEnd);
	marshalCursorHookType(rawHooks, 'beforeSubmitPrompt', beforeSubmitPrompt);
	marshalCursorHookType(rawHooks, 'stop', stop);
	marshalCursorHookType(rawHooks, 'preCompact', preCompact);
	marshalCursorHookType(rawHooks, 'subagentStart', subagentStart);
	marshalCursorHookType(rawHooks, 'subagentStop', subagentStop);

	if (Object.keys(rawHooks).length > 0) {
		rawFile.hooks = rawHooks;
	} else {
		delete rawFile.hooks;
	}

	const output = `${JSON.stringify(rawFile, null, 2)}\n`;
	await fs.writeFile(hooksPath, output, { mode: 0o600 });
}

/**
 * Whether Story hooks are currently installed.
 *
 * Mirrors Go `cursor/hooks.go: AreHooksInstalled` — checks every known hook
 * bucket (not just `Stop` like Claude's optimization). Returns `false` on
 * missing file or parse error (no throw).
 */
export async function areHooksInstalled(): Promise<boolean> {
	const repoRoot = await resolveRepoRoot();
	const hooksPath = path.join(repoRoot, '.cursor', CURSOR_HOOKS_FILE_NAME);
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
	if (typeof hooks !== 'object' || hooks === null) {
		return false;
	}
	const h = hooks as Record<string, unknown>;
	for (const hookType of MANAGED_HOOK_TYPES) {
		const entries = parseCursorHookType(h, hookType);
		if (hasStoryHook(entries)) {
			return true;
		}
	}
	return false;
}
