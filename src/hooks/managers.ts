/**
 * Detection and warning for third-party git hook managers.
 *
 * Scans a repo root for the config files / directories of known hook
 * managers (Husky, Lefthook, pre-commit, Overcommit, hk) and emits a
 * copy-paste-friendly warning so users can keep Story's hooks working
 * alongside the third-party tool. Detection is pure `fs.stat` — we
 * never read file contents.
 *
 * Mirrors Go `cmd/entire/cli/strategy/hook_managers.go`. The Story
 * brand (`'story enable'`, `Story` in warning text) replaces the Go
 * `'entire enable'` / `Entire` literals — see
 * [docs/ts-rewrite/impl/phase-8-hooks/module.md](../../docs/ts-rewrite/impl/phase-8-hooks/module.md).
 *
 * @packageDocumentation
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { buildHookSpecs, hookCmdPrefix } from './install';

/**
 * A detected third-party hook manager.
 */
export interface HookManager {
	/** Display name (e.g. "Husky", "Lefthook"). */
	name: string;
	/** Relative path that triggered detection (e.g. `.husky/`). */
	configPath: string;
	/**
	 * `true` when the tool overwrites git hooks on reinstall (e.g. Husky
	 * rewrites `.git/hooks/` on `npm install`). Drives the two warning
	 * tiers: Category A (detailed copy-paste) vs Category B
	 * (run `story enable` reminder).
	 */
	overwritesHooks: boolean;
}

/**
 * Scan the repository root for known hook manager config files.
 *
 * Detection is filesystem-only — we never read file contents, only
 * test existence. Duplicate detections per manager (e.g. both
 * `lefthook.yml` and `.lefthook.yml` present) are deduped by name.
 *
 * Mirrors Go `detectHookManagers`.
 *
 * @example
 * await detectHookManagers('/repo');
 * // returns: [{ name: 'Husky', configPath: '.husky/', overwritesHooks: true }]
 *
 * // No manager found:
 * // returns: []
 *
 * // Side effects: up to ~20 fs.stat calls rooted at repoRoot. No reads, no writes.
 */
export async function detectHookManagers(repoRoot: string): Promise<HookManager[]> {
	const checks: HookManager[] = [
		{ name: 'Husky', configPath: '.husky/', overwritesHooks: true },
		{ name: 'pre-commit', configPath: '.pre-commit-config.yaml', overwritesHooks: false },
		{ name: 'Overcommit', configPath: '.overcommit.yml', overwritesHooks: false },
	];

	// Lefthook: {.,}lefthook{,-local}.{yml,yaml,json,toml}
	for (const prefix of ['', '.']) {
		for (const variant of ['', '-local']) {
			for (const ext of ['yml', 'yaml', 'json', 'toml']) {
				checks.push({
					name: 'Lefthook',
					configPath: `${prefix}lefthook${variant}.${ext}`,
					overwritesHooks: false,
				});
			}
		}
	}

	// hk: {.config/,}hk{,.local}.pkl
	for (const dir of ['', '.config/']) {
		for (const variant of ['', '.local']) {
			checks.push({
				name: 'hk',
				configPath: `${dir}hk${variant}.pkl`,
				overwritesHooks: false,
			});
		}
	}

	const managers: HookManager[] = [];
	const seen = new Set<string>();
	for (const check of checks) {
		const abs = path.join(repoRoot, check.configPath);
		try {
			await fs.stat(abs);
		} catch {
			continue;
		}
		if (seen.has(check.name)) {
			continue;
		}
		seen.add(check.name);
		managers.push(check);
	}
	return managers;
}

/**
 * Build the multi-section warning string for detected managers.
 *
 * Two output tiers driven by `overwritesHooks`:
 * - **Category A** (`overwritesHooks: true`, e.g. Husky) — a
 *   `Warning: <name> detected (<path>)` block followed by per-hook
 *   copy-paste lines that the user can add to the manager's own hook
 *   files. Command lines come from {@link buildHookSpecs} via
 *   {@link extractCommandLine}.
 * - **Category B** (`overwritesHooks: false`, e.g. Lefthook) — a short
 *   `Note: <name> detected (<path>)` block suggesting the user re-run
 *   `story enable` if the manager reinstalls hooks.
 *
 * Mirrors Go `hookManagerWarning`.
 *
 * @example
 * hookManagerWarning([
 *   { name: 'Husky', configPath: '.husky/', overwritesHooks: true },
 * ], 'story');
 * // returns: 'Warning: Husky detected (.husky/)\n\n  Husky may overwrite hooks ...'
 *
 * hookManagerWarning([], 'story');
 * // returns: ''
 */
export function hookManagerWarning(managers: HookManager[], cmdPrefix: string): string {
	if (managers.length === 0) {
		return '';
	}

	const parts: string[] = [];
	const specs = buildHookSpecs(cmdPrefix);

	for (const m of managers) {
		if (m.overwritesHooks) {
			parts.push(`Warning: ${m.name} detected (${m.configPath})\n`);
			parts.push(`\n`);
			parts.push(`  ${m.name} may overwrite hooks installed by Story on npm install.\n`);
			parts.push(
				`  To make Story hooks permanent, add these lines to your ${m.name} hook files:\n`,
			);
			parts.push(`\n`);

			// Config path serves as the hook directory prefix. For Husky this
			// is typically '.husky/' where user-owned hook scripts live.
			const hookDir = m.configPath;
			for (const spec of specs) {
				const cmdLine = extractCommandLine(spec.content);
				if (cmdLine === '') {
					continue;
				}
				parts.push(`    ${hookDir}${spec.name}:\n`);
				parts.push(`      ${cmdLine}\n`);
				parts.push(`\n`);
			}
		} else {
			parts.push(`Note: ${m.name} detected (${m.configPath})\n`);
			parts.push(`\n`);
			parts.push(`  If ${m.name} reinstalls hooks, run 'story enable' to restore Story's hooks.\n`);
			parts.push(`\n`);
		}
	}

	return parts.join('');
}

/**
 * Return the first non-shebang, non-comment, non-empty line from a
 * generated hook script. Used to copy just the command invocation into
 * warning text.
 *
 * Mirrors Go `extractCommandLine`.
 *
 * @example
 * extractCommandLine('#!/bin/sh\n# Story CLI hooks\nstory hooks git commit-msg "$1" || exit 1\n');
 * // returns: 'story hooks git commit-msg "$1" || exit 1'
 *
 * extractCommandLine('#!/bin/sh\n# only comments\n');
 * // returns: ''
 */
export function extractCommandLine(hookContent: string): string {
	for (const line of hookContent.split('\n')) {
		const trimmed = line.trim();
		if (trimmed === '' || trimmed.startsWith('#')) {
			continue;
		}
		return trimmed;
	}
	return '';
}

/**
 * Detect third-party hook managers at `repoRoot` and write a warning
 * to `w` iff any are found. Resolves to `void` regardless of success —
 * hook manager warnings are advisory and never fail the caller.
 *
 * Mirrors Go `CheckAndWarnHookManagers`.
 *
 * @example
 * await checkAndWarnHookManagers('/repo', process.stderr, false, false);
 * // Side effects:
 * //   - Up to ~20 fs.stat calls rooted at repoRoot
 * //   - When managers detected: writes warning block (leading \n + warning text) to `w`
 * //   - When no managers: no write at all
 * //   - Worktree / index / HEAD / any hook file: unchanged.
 */
export async function checkAndWarnHookManagers(
	repoRoot: string,
	w: NodeJS.WritableStream,
	localDev: boolean,
	absolutePath: boolean,
): Promise<void> {
	const managers = await detectHookManagers(repoRoot);
	if (managers.length === 0) {
		return;
	}
	// Best-effort: hook manager warnings are advisory, so skip on
	// resolution failure (e.g. `process.execPath` → `realpathSync`
	// throws when `absolutePath: true` and the binary path is
	// unreadable). Matches Go `hook_managers.go:136-140` which also
	// returns silently when `hookCmdPrefix` errors.
	let cmdPrefix: string;
	try {
		cmdPrefix = hookCmdPrefix(localDev, absolutePath);
	} catch {
		return;
	}
	const warning = hookManagerWarning(managers, cmdPrefix);
	if (warning !== '') {
		w.write('\n');
		w.write(warning);
	}
}
