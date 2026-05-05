/**
 * `story status` — repo snapshot: enabled/not, settings source, git hooks,
 * metadata branch, and any active sessions.
 *
 * Mirrors Go `cmd/entire/cli/status.go: newStatusCmd`. The Go upstream
 * packs everything into a `lipgloss`-rendered report block; Story reuses
 * the Phase 9.0 bar-block primitives so the visual shape matches
 * `enable` / `configure`.
 *
 * @packageDocumentation
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { CAC } from 'cac';
import { METADATA_BRANCH_NAME } from '@/checkpoint/constants';
import { applyGlobalFlags, getGlobalFlags } from '@/cli/flags';
import type { EnrichedSession } from '@/commands/_shared/session-list';
import { findActiveSessions } from '@/commands/_shared/session-list';
import { installedAgentDisplayNames } from '@/commands/setup-helpers';
import { SilentError } from '@/errors';
import { execGit } from '@/git';
import { getHooksDir, MANAGED_GIT_HOOK_NAMES, STORY_HOOK_MARKER } from '@/hooks/install';
import { getStoryFilePath, worktreeRoot } from '@/paths';
import {
	isEnabled,
	isSetUpAny,
	LOCAL_SETTINGS_FILE,
	load,
	loadFromFile,
	SETTINGS_FILE,
	type StorySettings,
} from '@/settings/settings';
import { getMetadataBranchTree } from '@/strategy/metadata-branch';
import { barEmpty, barLine, footer, header, step, stepDone, warn } from '@/ui';
import { color } from '@/ui/theme';

const DEFAULT_SESSION_LIMIT = 5;
const STATUS_RULE_WIDTH = 60;

/**
 * Register `story status` on a cac instance. Call once from
 * {@link ../commands/index::registerCoreCommands}.
 *
 * Go: `cmd/entire/cli/status.go: newStatusCmd`. Flag shape:
 *  - `--detailed` — append Settings-layer JSON block (effective/project/local)
 *  - `--json` (global) — single-line machine-readable output, no banner
 *
 * @example
 * registerStatusCommand(cli);
 * // Now resolvable:
 * //   story status
 * //   story status --detailed
 * //   story status --json
 */
export function registerStatusCommand(cli: CAC): void {
	cli
		.command('status', 'Show Story repo snapshot (enabled, hooks, sessions)')
		.option('--detailed', 'Include effective/project/local settings JSON')
		.option('--limit <n>', `Maximum active sessions to show (default: ${DEFAULT_SESSION_LIMIT})`)
		.option('--offset <n>', 'Number of active sessions to skip before rendering')
		.option('--all', 'Show all active sessions')
		.action(async (rawFlags: Record<string, unknown>) => {
			applyGlobalFlags(rawFlags);
			const detailed = rawFlags.detailed === true;
			const pagination = parsePaginationFlags(rawFlags);
			const flags = getGlobalFlags();
			const jsonOut = flags.json;

			const repoRoot = await requireGitRepo();

			const setupAny = await isSetUpAny(repoRoot);
			if (!setupAny && !(await anyHooksInstalled(repoRoot))) {
				if (jsonOut) {
					emitJson({
						enabled: false,
						repoRoot,
						reason: 'no settings and no hooks',
					});
					return;
				}
				await renderNotEnabled(repoRoot);
				return;
			}

			const [enabled, settings, hooks, activeSessions, metadataHash, branch] = await Promise.all([
				isEnabled(repoRoot),
				setupAny ? load(repoRoot) : Promise.resolve<StorySettings>({ enabled: false }),
				getHookInstallStatus(repoRoot),
				findActiveSessions(repoRoot),
				getMetadataBranchTree(repoRoot).catch(() => null),
				currentBranchName(repoRoot),
			]);

			const settingsSource = await detectSettingsSource(repoRoot);
			const agents = await resolveAgentDisplayNames(activeSessions);
			const activePage = paginateSessions(activeSessions, pagination);

			if (jsonOut) {
				const payload: Record<string, unknown> = {
					enabled,
					repoRoot,
					branch,
					settingsSource,
					agents,
					gitHooks: { installed: hooks.installed.length, total: hooks.total },
					metadataBranch: metadataHash !== null ? METADATA_BRANCH_NAME : null,
					activeSessions: activePage.items.map((s) => ({
						id: s.id,
						agent: s.agentType,
						model: s.model,
						startedAt: s.startedAt,
						lastPrompt: s.lastPrompt,
						lastInteractionTime: s.lastInteractionTime,
						isStuckActive: s.isStuckActive,
						tokens: { in: s.tokens.input, out: s.tokens.output },
						turn: s.tokens.turns,
						filesChanged: s.filesChanged,
						lastCheckpoint: s.lastCheckpointId,
					})),
					pagination: activePage.pagination,
				};
				if (detailed) {
					payload.settingsLayers = await readSettingsLayers(repoRoot);
				}
				emitJson(payload);
				return;
			}

			await renderBarBlock({
				repoRoot,
				branch,
				enabled,
				settings,
				settingsSource,
				agents,
				hooks,
				activeSessions: activePage,
				metadataHash,
				detailed,
			});
		});
}

interface PaginationFlags {
	readonly all: boolean;
	readonly limit: number;
	readonly offset: number;
}

interface SessionPage {
	readonly items: readonly EnrichedSession[];
	readonly pagination: {
		readonly total: number;
		readonly limit: number | null;
		readonly offset: number;
		readonly nextOffset: number | null;
	};
}

interface HookStatus {
	readonly installed: string[];
	readonly missing: string[];
	readonly total: number;
}

async function getHookInstallStatus(repoRoot: string): Promise<HookStatus> {
	let hooksDir: string;
	try {
		hooksDir = await getHooksDir(repoRoot);
	} catch {
		return {
			installed: [],
			missing: [...MANAGED_GIT_HOOK_NAMES],
			total: MANAGED_GIT_HOOK_NAMES.length,
		};
	}
	const installed: string[] = [];
	const missing: string[] = [];
	for (const name of MANAGED_GIT_HOOK_NAMES) {
		if (await hookContainsMarker(hooksDir, name)) {
			installed.push(name);
		} else {
			missing.push(name);
		}
	}
	return { installed, missing, total: MANAGED_GIT_HOOK_NAMES.length };
}

async function hookContainsMarker(hooksDir: string, name: string): Promise<boolean> {
	try {
		const data = await fs.readFile(path.join(hooksDir, name), 'utf-8');
		return data.includes(STORY_HOOK_MARKER);
	} catch {
		return false;
	}
}

async function anyHooksInstalled(repoRoot: string): Promise<boolean> {
	const { installed } = await getHookInstallStatus(repoRoot);
	return installed.length > 0;
}

function parsePaginationFlags(rawFlags: Record<string, unknown>): PaginationFlags {
	const all = rawFlags.all === true;
	const limit = readIntegerFlag(rawFlags.limit, '--limit', DEFAULT_SESSION_LIMIT);
	const offset = readIntegerFlag(rawFlags.offset, '--offset', 0);
	if (limit < 1) {
		throw new SilentError(new Error('--limit must be a positive integer'));
	}
	if (offset < 0) {
		throw new SilentError(new Error('--offset must be a non-negative integer'));
	}
	return { all, limit, offset };
}

function readIntegerFlag(value: unknown, name: string, fallback: number): number {
	if (value === undefined || value === null || value === false) {
		return fallback;
	}
	if (typeof value !== 'string' && typeof value !== 'number') {
		throw new SilentError(new Error(`${name} must be an integer`));
	}
	const raw = String(value).trim();
	if (!/^\d+$/.test(raw)) {
		throw new SilentError(new Error(`${name} must be an integer`));
	}
	return Number.parseInt(raw, 10);
}

function paginateSessions(
	sessions: readonly EnrichedSession[],
	flags: PaginationFlags,
): SessionPage {
	if (flags.all) {
		return {
			items: sessions,
			pagination: {
				total: sessions.length,
				limit: null,
				offset: 0,
				nextOffset: null,
			},
		};
	}

	const items = sessions.slice(flags.offset, flags.offset + flags.limit);
	const nextOffset = flags.offset + flags.limit < sessions.length ? flags.offset + flags.limit : null;
	return {
		items,
		pagination: {
			total: sessions.length,
			limit: flags.limit,
			offset: flags.offset,
			nextOffset,
		},
	};
}

/**
 * Decide which file is the **primary** settings source for display:
 * 'local' when `.story/settings.local.json` exists (because it wins on
 * merge), otherwise 'project' when `.story/settings.json` exists, else
 * 'none'.
 */
async function detectSettingsSource(repoRoot: string): Promise<'local' | 'project' | 'none'> {
	if (await fileExists(getStoryFilePath(repoRoot, LOCAL_SETTINGS_FILE))) {
		return 'local';
	}
	if (await fileExists(getStoryFilePath(repoRoot, SETTINGS_FILE))) {
		return 'project';
	}
	return 'none';
}

async function fileExists(p: string): Promise<boolean> {
	try {
		await fs.stat(p);
		return true;
	} catch {
		return false;
	}
}

async function resolveAgentDisplayNames(activeSessions: readonly EnrichedSession[]): Promise<string[]> {
	const installed = await installedAgentDisplayNames().catch(() => []);
	if (installed.length > 0) {
		return installed;
	}
	const fromSessions = new Set<string>();
	for (const session of activeSessions) {
		if (session.agentType !== '') {
			fromSessions.add(session.agentType);
		}
	}
	return [...fromSessions].sort();
}

async function readSettingsLayers(repoRoot: string): Promise<{
	effective: StorySettings;
	project: StorySettings | null;
	local: StorySettings | null;
}> {
	const projectPath = getStoryFilePath(repoRoot, SETTINGS_FILE);
	const localPath = getStoryFilePath(repoRoot, LOCAL_SETTINGS_FILE);
	const [project, local, effective] = await Promise.all([
		readLayerOrNull(projectPath),
		readLayerOrNull(localPath),
		load(repoRoot),
	]);
	return { effective, project, local };
}

async function readLayerOrNull(filePath: string): Promise<StorySettings | null> {
	if (!(await fileExists(filePath))) {
		return null;
	}
	return loadFromFile(filePath);
}

async function currentBranchName(repoRoot: string): Promise<string | undefined> {
	try {
		const raw = await execGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot });
		const trimmed = raw.trim();
		return trimmed === '' || trimmed === 'HEAD' ? undefined : trimmed;
	} catch {
		return undefined;
	}
}

async function requireGitRepo(): Promise<string> {
	try {
		return await worktreeRoot(process.cwd());
	} catch {
		throw new SilentError(
			new Error("Not a git repository. Please run 'story status' from within a git repository."),
		);
	}
}

function emitJson(payload: Record<string, unknown>): void {
	process.stdout.write(`${JSON.stringify(payload)}\n`);
}

async function renderNotEnabled(repoRoot: string): Promise<void> {
	header('story status');
	barEmpty();
	step('Repository');
	barLine(color.dim(repoRoot));
	barEmpty();
	step(color.dim('○ Story is not enabled in this repository'));
	barLine('No .story/settings*.json found and no Story git hooks installed.');
	barEmpty();
	footer(color.dim("Run 'story enable' to set it up."));
}

async function renderBarBlock(ctx: {
	repoRoot: string;
	branch: string | undefined;
	enabled: boolean;
	settings: StorySettings;
	settingsSource: 'local' | 'project' | 'none';
	agents: readonly string[];
	hooks: HookStatus;
	activeSessions: SessionPage;
	metadataHash: string | null;
	detailed: boolean;
}): Promise<void> {
	if (!ctx.detailed) {
		renderCompactStatus(ctx);
		return;
	}

	header('story status');
	barEmpty();

	step('Repository');
	barLine(color.dim(ctx.repoRoot));
	if (ctx.branch !== undefined) {
		barLine(`${color.dim('Branch:')} ${ctx.branch}`);
	}
	barEmpty();

	step('Enabled');
	if (ctx.enabled) {
		barLine(`${color.green('●')} Story is enabled`);
	} else {
		barLine(`${color.yellow('▲')} Settings present but 'enabled: false'`);
	}
	const srcLabel = settingsSourceLabel(ctx.settingsSource);
	if (srcLabel !== '') {
		barLine(`${color.green('●')} Settings source: ${srcLabel}`);
	}

	const hookGlyph = ctx.hooks.missing.length === 0 ? color.green('●') : color.yellow('▲');
	const hookSummary = `${ctx.hooks.installed.length}/${ctx.hooks.total} installed`;
	const missingSuffix =
		ctx.hooks.missing.length > 0 ? ` (missing: ${ctx.hooks.missing.join(', ')})` : '';
	barLine(`${hookGlyph} Git hooks: ${hookSummary}${missingSuffix}`);

	const metadataLine =
		ctx.metadataHash !== null
			? `${color.green('●')} Metadata branch: ${METADATA_BRANCH_NAME}`
			: `${color.dim('○')} Metadata branch: (not initialized)`;
	barLine(metadataLine);
	barEmpty();

	if (ctx.hooks.missing.length > 0) {
		warn(`Some Story git hooks are missing: ${ctx.hooks.missing.join(', ')}`);
		warn("Run 'story configure --force' to reinstall.");
		barEmpty();
	}

	await renderDetailedLayers(ctx.repoRoot);

	step(`Active sessions (${ctx.activeSessions.pagination.total})`);
	if (ctx.activeSessions.pagination.total === 0) {
		barLine(`${color.dim('○')} No active sessions on this branch.`);
	} else {
		renderSessionList(ctx.activeSessions.items, (line) => barLine(line));
		barLine(paginationSummary(ctx.activeSessions, 'bar'));
	}
	barEmpty();
	stepDone(ctx.hooks.missing.length === 0 ? 'OK' : 'OK (with warnings)');
	barEmpty();
	if (ctx.activeSessions.pagination.total > 0) {
		const first = ctx.activeSessions.items[0];
		if (first !== undefined) {
			footer(color.dim(`Run 'story sessions info ${first.id}' for more.`));
		} else {
			footer(color.dim('Adjust --offset to inspect active sessions on another page.'));
		}
	} else {
		footer(color.dim("Run 'story sessions list' to see ended sessions."));
	}
}

function renderCompactStatus(ctx: {
	branch: string | undefined;
	enabled: boolean;
	agents: readonly string[];
	hooks: HookStatus;
	activeSessions: SessionPage;
}): void {
	const lines: string[] = [];
	const statusGlyph = ctx.enabled ? color.green('●') : color.red('○');
	const statusLabel = ctx.enabled ? color.bold('Enabled') : color.bold('Disabled');
	const parts = [`${statusGlyph} ${statusLabel}`, 'manual-commit'];
	if (ctx.branch !== undefined) {
		parts.push(`branch ${color.cyan(ctx.branch)}`);
	}
	lines.push(parts.join(color.dim(' · ')));

	if (ctx.agents.length > 0) {
		lines.push(`${color.dim('  Agents · ')}${ctx.agents.map((a) => color.cyan(a)).join(', ')}`);
	}

	if (ctx.hooks.missing.length > 0) {
		lines.push(
			`${color.yellow('▲')} Git hooks: ${ctx.hooks.installed.length}/${
				ctx.hooks.total
			} installed ${color.dim(`(missing: ${ctx.hooks.missing.join(', ')}; run 'story configure --force')`)}`,
		);
	}

	lines.push('');
	lines.push(sectionRule('Active Sessions'));
	if (ctx.activeSessions.pagination.total === 0) {
		lines.push(`${color.dim('○')} No active sessions on this branch.`);
		lines.push('');
		lines.push(color.dim("Run 'story sessions list' to see ended sessions."));
	} else {
		renderSessionList(ctx.activeSessions.items, (line) => lines.push(line));
		lines.push(horizontalRule());
		lines.push(paginationSummary(ctx.activeSessions, 'compact'));
		const first = ctx.activeSessions.items[0];
		if (first !== undefined) {
			lines.push(color.dim(`Run 'story sessions info ${first.id}' for more.`));
		}
	}

	process.stdout.write(`${lines.join('\n')}\n`);
}

function renderSessionList(
	sessions: readonly EnrichedSession[],
	writeLine: (line: string) => void,
): void {
	for (const s of sessions) {
		const agent = s.agentType === '' ? '(unknown)' : s.agentType;
		const model = s.model !== undefined && s.model !== '' ? ` ${color.dim(`(${s.model})`)}` : '';
		writeLine(`${color.bold(color.cyan(agent))}${model} ${color.dim('·')} ${s.id}`);
		if (s.lastPrompt !== undefined && s.lastPrompt !== '') {
			writeLine(`${color.dim('>')} "${truncateRunes(s.lastPrompt, 60, '...')}"`);
		}
		writeLine(renderSessionStats(s));
		writeLine('');
	}
}

function renderSessionStats(s: EnrichedSession): string {
	const stats = [`started ${formatRelativeIso(s.startedAt)}`];
	const active = activeTimeDisplay(s);
	if (active !== '') {
		stats.push(active);
	}
	stats.push(`tokens ${formatCount(s.tokens.input + s.tokens.output)}`);
	stats.push(`files ${s.filesChanged}`);
	let line = color.dim(stats.join(' · '));
	if (s.isStuckActive) {
		line += ` ${color.dim('·')} ${color.yellow("stale (run 'story doctor')")}`;
	}
	return line;
}

function activeTimeDisplay(s: EnrichedSession): string {
	if (s.lastInteractionTime === undefined) {
		return '';
	}
	const started = new Date(s.startedAt);
	const last = new Date(s.lastInteractionTime);
	if (Number.isNaN(started.getTime()) || Number.isNaN(last.getTime())) {
		return '';
	}
	if (last.getTime() - started.getTime() <= 60_000) {
		return 'active now';
	}
	return `active ${formatRelative(last)}`;
}

function paginationSummary(page: SessionPage, mode: 'bar' | 'compact'): string {
	const { total, limit, offset, nextOffset } = page.pagination;
	if (limit === null) {
		return color.dim(`showing all ${total} ${pluralizeSession(total)}`);
	}
	const shown = page.items.length;
	const parts = [`showing ${shown} of ${total} ${pluralizeSession(total)}`, `offset ${offset}`];
	if (nextOffset !== null) {
		const command =
			limit === DEFAULT_SESSION_LIMIT
				? `story status --offset ${nextOffset}`
				: `story status --limit ${limit} --offset ${nextOffset}`;
		parts.push(`next: ${command}`);
	}
	const summary = parts.join(' · ');
	return mode === 'compact' ? color.dim(summary) : summary;
}

function pluralizeSession(count: number): string {
	return count === 1 ? 'session' : 'sessions';
}

function horizontalRule(width = STATUS_RULE_WIDTH): string {
	return color.dim('─'.repeat(width));
}

function sectionRule(label: string, width = STATUS_RULE_WIDTH): string {
	const prefix = '── ';
	const content = `${label} `;
	const trailing = Math.max(1, width - Array.from(prefix + content).length);
	return `${color.dim(prefix)}${color.dim(label)} ${color.dim('─'.repeat(trailing))}`;
}

function settingsSourceLabel(source: 'local' | 'project' | 'none'): string {
	if (source === 'local') {
		return `.story/${LOCAL_SETTINGS_FILE} (local)`;
	}
	if (source === 'project') {
		return `.story/${SETTINGS_FILE} (project)`;
	}
	return '';
}

async function renderDetailedLayers(repoRoot: string): Promise<void> {
	const layers = await readSettingsLayers(repoRoot);
	step('Settings layers');
	barEmpty();
	barLine(`${color.green('●')} effective (merged)`);
	renderJsonBlock(layers.effective);
	barEmpty();
	barLine(`${color.green('●')} project (.story/${SETTINGS_FILE})`);
	if (layers.project === null) {
		barLine(`  ${color.dim('(not set)')}`);
	} else {
		renderJsonBlock(layers.project);
	}
	barEmpty();
	barLine(`${color.green('●')} local (.story/${LOCAL_SETTINGS_FILE})`);
	if (layers.local === null) {
		barLine(`  ${color.dim('(not set)')}`);
	} else {
		renderJsonBlock(layers.local);
	}
	barEmpty();
}

function renderJsonBlock(obj: unknown): void {
	const pretty = JSON.stringify(obj, null, 2);
	for (const line of pretty.split('\n')) {
		barLine(`  ${color.dim(line)}`);
	}
}

function formatRelativeIso(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) {
		return iso;
	}
	return formatRelative(d);
}

/**
 * Humanized relative time ("24m ago" / "2h ago" / "2d ago"), matching
 * the phrasing in the visual spec ([phase-9.0-setup/commands/9.2-0-status.md]).
 */
export function formatRelative(d: Date): string {
	const diffMs = Date.now() - d.getTime();
	if (diffMs < 0) {
		return 'in the future';
	}
	const minutes = Math.floor(diffMs / 60_000);
	if (minutes < 1) {
		return 'just now';
	}
	if (minutes < 60) {
		return `${minutes}m ago`;
	}
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		return `${hours}h ago`;
	}
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}

function formatCount(n: number): string {
	if (n < 1000) {
		return String(n);
	}
	if (n < 1_000_000) {
		return `${(n / 1000).toFixed(1)}k`;
	}
	return `${(n / 1_000_000).toFixed(1)}M`;
}

function truncateRunes(value: string, maxRunes: number, suffix: string): string {
	const runes = Array.from(value);
	if (runes.length <= maxRunes) {
		return value;
	}
	const keep = Math.max(0, maxRunes - Array.from(suffix).length);
	return `${runes.slice(0, keep).join('')}${suffix}`;
}
