/**
 * Core orchestration for the `story enable` / `disable` / `configure` user
 * flows. Everything command actions need lives here — UI + registry wiring
 * + settings I/O + hook install/uninstall plumbing. Command modules
 * (`enable.ts` / `disable.ts` / `configure.ts`) are thin cac wrappers that
 * validate flags and dispatch into these functions.
 *
 * Mirrors Go `cmd/entire/cli/setup.go` — specifically `runSetupFlow`,
 * `runEnableInteractive`, `runManageAgents`, `applyAgentChanges`,
 * `uninstallDeselectedAgentHooks`, `setupAgentHooks`,
 * `setupAgentHooksNonInteractive`, `runDisable`, `runUninstall`,
 * `runRemoveAgent`, `detectOrSelectAgent`.
 *
 * @packageDocumentation
 */

import fs from 'node:fs/promises';
import { asHookSupport } from '@/agent/capabilities';
import { isExternal as isExternalAgent } from '@/agent/external/capabilities';
import type { Agent, HookSupport } from '@/agent/interfaces';
import * as registry from '@/agent/registry';
import type { AgentName } from '@/agent/types';
import { getGlobalFlags } from '@/cli/flags';
import { getRootSignal } from '@/cli/runtime';
import { isInteractive } from '@/cli/tty';
import { SilentError } from '@/errors';
import { getGitCommonDir } from '@/git';
import { removeGitHooks } from '@/hooks/install';
import { sessionStateDir, storyDir } from '@/paths';
import { StateStore } from '@/session/state-store';
import { isEnabled, isSetUpAny, load, type StorySettings } from '@/settings/settings';
import { ensureSetup } from '@/strategy/setup';
import { deleteShadowBranches, listShadowBranches } from '@/strategy/shadow-branches';
import {
	barEmpty,
	barLine,
	confirm,
	footer,
	header,
	multiselect,
	step,
	stepDone,
	warn,
} from '@/ui';
import { color } from '@/ui/theme';
import {
	applyStrategyOptions,
	buildAgentListForPrompt,
	getAgentsWithHooksInstalled,
	installedAgentDisplayNames,
	type SettingsScope,
	writeSettingsScoped,
} from './setup-helpers';

/** Shared option bundle for the interactive / non-interactive enable paths. */
export interface EnableOptions {
	repoRoot: string;
	agentName?: string;
	scope: SettingsScope;
	force: boolean;
	skipPushSessions: boolean;
	checkpointRemote?: string;
	telemetry: boolean;
	absoluteGitHookPath: boolean;
	localDev: boolean;
}

/** Option bundle for `story disable`. */
export interface DisableOptions {
	repoRoot: string;
	uninstall: boolean;
	force: boolean;
	useProjectSettings: boolean;
}

/** Option bundle for `story configure`. */
export interface ConfigureOptions {
	repoRoot: string;
	agentName?: string;
	removeAgentName?: string;
	scope: SettingsScope;
	force: boolean;
	skipPushSessions: boolean;
	checkpointRemote?: string;
	telemetry: boolean;
	absoluteGitHookPath: boolean;
	localDev: boolean;
}

/**
 * Resolve which agents to set up — auto-detect, honor `--agent`, or prompt
 * the user with a multi-select. Returns the final agent list in the order
 * they should be installed.
 *
 * Non-interactive rules (mirrors Go `detectOrSelectAgent`'s non-TTY path):
 *   - Hooks already installed → keep that set.
 *   - Single detected agent → use it.
 *   - Multiple detected agents → `SilentError("cannot prompt ... pass --agent")`.
 *   - No detected agents + default available → use default.
 *
 * Interactive: always multiselect, pre-selecting installed (re-run) or
 * detected built-in agents (first run).
 *
 * Mirrors Go `setup.go: detectOrSelectAgent`.
 */
export async function detectOrSelectAgent(opts: { signal?: AbortSignal }): Promise<Agent[]> {
	const installedAgentNames = await getAgentsWithHooksInstalled();
	const hasInstalled = installedAgentNames.length > 0;
	const detected = await registry.detectAll();

	const signal = opts.signal ?? getRootSignal();

	if (!isInteractive()) {
		if (hasInstalled) {
			const agents: Agent[] = [];
			for (const name of installedAgentNames) {
				const ag = registry.get(name);
				if (ag !== null) {
					agents.push(ag);
				}
			}
			return agents;
		}
		if (detected.length === 1) {
			const only = detected[0];
			if (only !== undefined) {
				return [only];
			}
		}
		if (detected.length > 1) {
			throw new SilentError(
				new Error('cannot prompt in non-interactive mode — pass --agent <name>'),
			);
		}
		const def = registry.defaultAgent();
		if (def === null) {
			throw new SilentError(new Error('no default agent available'));
		}
		return [def];
	}

	// Interactive — build option list + pre-selection set.
	const options = buildAgentListForPrompt();
	if (options.length === 0) {
		throw new SilentError(new Error('no agents with hook support available'));
	}

	const preSelected = new Set<string>();
	if (hasInstalled) {
		for (const name of installedAgentNames) {
			preSelected.add(name);
		}
	} else {
		for (const ag of detected) {
			if (!isExternalAgent(ag)) {
				preSelected.add(ag.name());
			}
		}
	}

	const selected = await multiselect<string>({
		message: 'Which agents are you using?',
		options,
		initialValues: Array.from(preSelected),
		required: true,
		signal,
	});

	if (selected.length === 0) {
		throw new SilentError(new Error('please select at least one agent'));
	}

	const agents: Agent[] = [];
	for (const name of selected) {
		const ag = registry.get(name as AgentName);
		if (ag === null) {
			throw new SilentError(new Error(`failed to get selected agent ${name}`));
		}
		agents.push(ag);
	}
	return agents;
}

/** Return `[HookSupport, agent]` pair or throw a `SilentError`. */
function requireHookSupport(ag: Agent): HookSupport {
	const [hs, ok] = asHookSupport(ag);
	if (!ok) {
		throw new SilentError(new Error(`agent ${ag.name()} does not support hooks`));
	}
	return hs;
}

/**
 * Install one agent's lifecycle hooks. Renders a `◇  Installing <name> hooks`
 * step + completion line on success; errors propagate (caller decides
 * whether to batch-join them via AggregateError).
 *
 * Mirrors Go `setup.go: setupAgentHooks`. Story drops Go's embedded
 * `scaffoldSearchSubagent` — that logic belongs to Phase 6.x agents
 * themselves and the framework doesn't own it.
 */
export async function setupAgentHooks(
	ag: Agent,
	opts: { localDev: boolean; force: boolean },
): Promise<number> {
	const hs = requireHookSupport(ag);
	step(`Installing ${ag.type()} hooks`);
	const count = await hs.installHooks({ localDev: opts.localDev, force: opts.force });
	if (count > 0) {
		barLine(color.dim(`${count} hook${count === 1 ? '' : 's'} written`));
	} else {
		barLine(color.dim('already installed'));
	}
	return count;
}

/**
 * Uninstall one agent's lifecycle hooks. Renders a `◇  Removing <name> hooks`
 * step on success; errors propagate.
 */
export async function uninstallOneAgentHooks(ag: Agent): Promise<void> {
	const hs = requireHookSupport(ag);
	step(`Removing ${ag.type()} hooks`);
	await hs.uninstallHooks();
	barLine(color.dim(`${ag.type()} hooks removed`));
}

/**
 * Scan the registry for agents with hooks installed BUT not in the given
 * "selected" set, and uninstall each. Used during re-runs of `enable` so
 * deselecting an agent in the multiselect actually removes its hooks.
 *
 * Best-effort: individual failures are collected + re-thrown as a single
 * `AggregateError` at the tail so one broken uninstall can't swallow the
 * rest.
 *
 * Mirrors Go `setup.go: uninstallDeselectedAgentHooks`.
 */
export async function uninstallDeselectedAgentHooks(selected: Agent[]): Promise<void> {
	const installedNames = await getAgentsWithHooksInstalled();
	if (installedNames.length === 0) {
		return;
	}
	const selectedSet = new Set(selected.map((ag) => ag.name()));
	const errs: Error[] = [];
	for (const name of installedNames) {
		if (selectedSet.has(name)) {
			continue;
		}
		const ag = registry.get(name);
		if (ag === null) {
			continue;
		}
		const [hs, ok] = asHookSupport(ag);
		if (!ok) {
			continue;
		}
		try {
			await hs.uninstallHooks();
			stepDone(`Removed ${ag.type()} hooks`);
		} catch (err) {
			errs.push(err instanceof Error ? err : new Error(String(err)));
		}
	}
	if (errs.length > 0) {
		throw new AggregateError(errs, 'failed to uninstall some deselected agent hooks');
	}
}

/**
 * Core interactive enable flow — agent select → scope decide → ensureSetup
 * → per-agent installs → settings write → closing summary.
 *
 * Banner is printed by `runtime.ts`; this function only handles the
 * bar-block body.
 */
export async function runInteractiveEnable(opts: EnableOptions): Promise<void> {
	header('enable');

	step('Repository detected');
	barLine(color.dim(opts.repoRoot));
	barEmpty();

	const agents =
		opts.agentName !== undefined
			? [getAgentOrFail(opts.agentName)]
			: await detectOrSelectAgent({ signal: getRootSignal() });

	// Uninstall deselected first (matches Go ordering so stale hooks don't
	// linger into the new session).
	await uninstallDeselectedAgentHooks(agents);

	// Core strategy setup — gitignore, redaction, metadata branch, git hooks.
	step('Preparing .story/ and git hooks');
	await ensureSetup(opts.repoRoot);
	stepDone('Git hooks installed');
	barEmpty();

	// Agent hooks + settings mutation.
	const settings = await loadOrDefault(opts.repoRoot);
	settings.enabled = true;
	if (opts.localDev) {
		settings.local_dev = true;
	}
	if (opts.absoluteGitHookPath) {
		settings.absolute_git_hook_path = true;
	}
	applyStrategyOptions(settings, {
		skipPushSessions: opts.skipPushSessions,
		checkpointRemote: opts.checkpointRemote,
	});

	// Auto-enable external_agents if any selected agent is external.
	for (const ag of agents) {
		if (isExternalAgent(ag)) {
			settings.external_agents = true;
			break;
		}
	}
	if (opts.telemetry === false) {
		settings.telemetry = false;
	}

	const errs: Error[] = [];
	for (const ag of agents) {
		try {
			await setupAgentHooks(ag, { localDev: opts.localDev, force: opts.force });
		} catch (err) {
			errs.push(err instanceof Error ? err : new Error(String(err)));
		}
	}

	await writeSettingsScoped(opts.repoRoot, settings, opts.scope);
	barEmpty();

	if (errs.length > 0) {
		throw new AggregateError(errs, 'some agents failed to install hooks');
	}

	const summary = agents.map((ag) => ag.type()).join(', ');
	stepDone(`Story enabled for ${summary}`);
	footer(`${color.dim('Run')} 'story status' ${color.dim('to verify.')}`);
}

/**
 * Non-interactive enable — `--agent <name>` path. Strict: `agentName` must
 * resolve to a registered HookSupport agent.
 *
 * Mirrors Go `setup.go: setupAgentHooksNonInteractive`.
 */
export async function runNonInteractiveEnable(opts: EnableOptions): Promise<void> {
	if (opts.agentName === undefined || opts.agentName === '') {
		throw new SilentError(new Error('missing agent name'));
	}
	const ag = getAgentOrFail(opts.agentName);

	header('enable');
	step('Repository detected');
	barLine(color.dim(opts.repoRoot));
	barEmpty();
	step(`Agent: ${ag.type()}`);
	barLine(color.dim(`(from --agent; scope: ${opts.scope})`));
	barEmpty();

	// Install agent hooks first (they don't depend on settings).
	await setupAgentHooks(ag, { localDev: opts.localDev, force: opts.force });
	barEmpty();

	// Strategy setup (.story + gitignore + metadata branch + 5 git hooks).
	step('Preparing .story/ and git hooks');
	await ensureSetup(opts.repoRoot);
	stepDone('Git hooks installed');
	barEmpty();

	// Settings write.
	const settings = await loadOrDefault(opts.repoRoot);
	settings.enabled = true;
	if (opts.localDev) {
		settings.local_dev = true;
	}
	if (opts.absoluteGitHookPath) {
		settings.absolute_git_hook_path = true;
	}
	if (isExternalAgent(ag)) {
		settings.external_agents = true;
	}
	applyStrategyOptions(settings, {
		skipPushSessions: opts.skipPushSessions,
		checkpointRemote: opts.checkpointRemote,
	});
	if (opts.telemetry === false) {
		settings.telemetry = false;
	}

	await writeSettingsScoped(opts.repoRoot, settings, opts.scope);

	stepDone(`Story enabled for ${ag.type()}`);
	footer(`${color.dim('Run')} 'story status' ${color.dim('to verify.')}`);
}

/**
 * Lightweight state toggle — flip `enabled: false` and keep hooks + `.story/`
 * in place. `disable --uninstall` uses {@link runUninstall} instead.
 *
 * Mirrors Go `setup.go: runDisable`.
 */
export async function runDisable(opts: DisableOptions): Promise<void> {
	header('disable');
	step('Repository detected');
	barLine(color.dim(opts.repoRoot));
	barEmpty();

	if (!(await isSetUpAny(opts.repoRoot))) {
		throw new SilentError(
			new Error('Not a Story repository — run `story enable` to set it up first.'),
		);
	}

	if (!(await isEnabled(opts.repoRoot))) {
		throw new SilentError(
			new Error(
				'Story is already disabled in this repository. To fully remove Story, run `story disable --uninstall`.',
			),
		);
	}

	// Require confirm unless --yes / --force (destructive-ish: changes repo state).
	const flags = getGlobalFlags();
	if (isInteractive() && !flags.yes && !opts.force) {
		const okay = await confirm({
			message: 'Disable Story in this repository?',
			yesDefault: true,
			signal: getRootSignal(),
		});
		if (!okay) {
			stepDone('Disable cancelled.');
			footer();
			return;
		}
	}

	const settings = await loadOrDefault(opts.repoRoot);
	settings.enabled = false;

	step('Marking disabled in settings');
	const { useProjectSettings } = opts;
	await writeSettingsScoped(opts.repoRoot, settings, useProjectSettings ? 'project' : 'local');
	barLine(
		color.dim(
			useProjectSettings
				? '.story/settings.json  enabled: false'
				: '.story/settings.local.json  enabled: false',
		),
	);

	if (useProjectSettings) {
		warn('.story/settings.json is git-tracked — commit this change so collaborators pick it up.');
	}
	barEmpty();
	stepDone('Story disabled for this repository');
	footer(`${color.dim('Run')} 'story enable' ${color.dim('to re-enable.')}`);
}

/**
 * Completely remove Story from the repository — the destructive path.
 * Confirm defaults to **No**; `--force` / `--yes` skip the prompt.
 *
 * 6-step pipeline (ordering matches Go `setup.go: runUninstall`):
 *
 * 1. Remove each agent's lifecycle hooks (lowest risk).
 * 2. Remove the 5 git hooks (`.git/hooks/*`).
 * 3. Remove all session state files (`.git/story-sessions/`).
 * 4. Remove the `.story/` directory (settings + logs + tmp).
 * 5. Remove all shadow branches (`story/<hash>-<worktree>`).
 * 6. Leave metadata / v2 refs intact (Phase 9.5 `clean` owns those).
 *
 * Individual step failures warn but do not abort — matches Go's best-effort
 * semantics so one broken uninstall doesn't leave the repo half-cleaned.
 */
export async function runUninstall(opts: DisableOptions): Promise<void> {
	header('disable --uninstall');
	step('Repository detected');
	barLine(color.dim(opts.repoRoot));
	barEmpty();

	const agentNames = await getAgentsWithHooksInstalled();
	const shadowBranches = await listShadowBranches({ repoRoot: opts.repoRoot });
	const commonDir = await tryGetGitCommonDir(opts.repoRoot);
	const states: number =
		commonDir === null ? 0 : await safeListSessionStates(commonDir, opts.repoRoot);
	const storyDirExists = await dirExists(storyDir(opts.repoRoot));

	const nothingToDo =
		agentNames.length === 0 && shadowBranches.length === 0 && states === 0 && !storyDirExists;

	if (nothingToDo) {
		stepDone('Story is not installed in this repository.');
		footer();
		return;
	}

	// Confirmation — destructive default No; --force / --yes skip.
	const flags = getGlobalFlags();
	if (!opts.force && !flags.yes) {
		if (!isInteractive()) {
			throw new SilentError(new Error('pass --force to confirm uninstall in non-interactive mode'));
		}
		renderUninstallTargets({
			agentCount: agentNames.length,
			shadowCount: shadowBranches.length,
			stateCount: states,
			storyDirExists,
		});
		const okay = await confirm({
			message: 'Permanently uninstall Story from this repository?',
			initialValue: false,
			yesDefault: false,
			signal: getRootSignal(),
		});
		if (!okay) {
			stepDone('Uninstall cancelled.');
			footer();
			return;
		}
	}
	barEmpty();

	// 1. Agent hooks.
	if (agentNames.length > 0) {
		step('Removing agent hooks');
		for (const name of agentNames) {
			const ag = registry.get(name);
			if (ag === null) {
				continue;
			}
			const [hs, ok] = asHookSupport(ag);
			if (!ok) {
				continue;
			}
			try {
				await hs.uninstallHooks();
				barLine(color.dim(`${ag.type()} hooks removed`));
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				warn(`failed to remove ${ag.type()} hooks: ${msg}`);
			}
		}
		barEmpty();
	}

	// 2. Git hooks.
	step('Removing git hooks');
	try {
		const removed = await removeGitHooks(opts.repoRoot);
		barLine(color.dim(`${removed} git hook${removed === 1 ? '' : 's'} removed`));
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		warn(`failed to remove git hooks: ${msg}`);
	}
	barEmpty();

	// 3. Session states.
	if (commonDir !== null && states > 0) {
		step('Removing Story session states');
		try {
			await new StateStore(sessionStateDir(commonDir)).removeAll();
			barLine(color.dim(`${states} state file${states === 1 ? '' : 's'} removed`));
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			warn(`failed to remove session states: ${msg}`);
		}
		barEmpty();
	}

	// 4. .story/ directory.
	if (storyDirExists) {
		step('Removing .story/ directory');
		try {
			await fs.rm(storyDir(opts.repoRoot), { recursive: true, force: true });
			barLine(color.dim('.story/ removed'));
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			warn(`failed to remove .story/: ${msg}`);
		}
		barEmpty();
	}

	// 5. Shadow branches.
	if (shadowBranches.length > 0) {
		step('Removing shadow branches');
		const { deleted, failed } = await deleteShadowBranches(
			{ repoRoot: opts.repoRoot },
			shadowBranches,
		);
		barLine(
			color.dim(`${deleted.length} shadow branch${deleted.length === 1 ? '' : 'es'} removed`),
		);
		if (failed.length > 0) {
			warn(`${failed.length} shadow branch${failed.length === 1 ? '' : 'es'} failed to delete`);
		}
		barEmpty();
	}

	stepDone('Story uninstalled from this repository');
	footer(`${color.dim('Run')} 'story enable' ${color.dim('to set up again.')}`);
}

/**
 * Interactive configure (add / remove agent) — shown when no explicit flag
 * picks a path. Presents a multi-select of available agents pre-populated
 * with currently-installed ones; diffing picks up adds and removes.
 *
 * Mirrors Go `setup.go: runManageAgents` + `applyAgentChanges`.
 */
export async function runInteractiveConfigure(opts: ConfigureOptions): Promise<void> {
	header('configure');
	step('Repository detected');
	barLine(color.dim(opts.repoRoot));

	if (!(await isEnabled(opts.repoRoot))) {
		barEmpty();
		throw new SilentError(
			new Error('Story is not enabled in this repository. Run `story enable` to set it up.'),
		);
	}

	const installedNames = await getAgentsWithHooksInstalled();
	if (installedNames.length > 0) {
		const display = await installedAgentDisplayNames();
		barLine(`${color.dim('Active agents:')} ${display.join(', ')}`);
	}
	barEmpty();

	if (!isInteractive()) {
		throw new SilentError(
			new Error(
				'Cannot prompt in non-interactive mode — pass --agent / --remove / ' +
					'--skip-push-sessions / --checkpoint-remote / --force.',
			),
		);
	}

	const options = buildAgentListForPrompt();
	const installedSet = new Set<string>(installedNames as string[]);
	const selected = await multiselect<string>({
		message: 'Which agents do you want active?',
		options,
		initialValues: Array.from(installedSet),
		required: false,
		signal: getRootSignal(),
	});

	const selectedSet = new Set(selected);
	const toAdd = selected.filter((n) => !installedSet.has(n));
	const toRemove = Array.from(installedSet).filter((n) => !selectedSet.has(n));

	if (toAdd.length === 0 && toRemove.length === 0 && !opts.force) {
		stepDone('No changes made.');
		footer();
		return;
	}

	const errs: Error[] = [];
	const addedAgents: Agent[] = [];
	for (const name of toAdd) {
		const ag = registry.get(name as AgentName);
		if (ag === null) {
			errs.push(new Error(`failed to get agent ${name}`));
			continue;
		}
		try {
			await setupAgentHooks(ag, { localDev: opts.localDev, force: opts.force });
			addedAgents.push(ag);
		} catch (err) {
			errs.push(err instanceof Error ? err : new Error(String(err)));
		}
	}

	if (opts.force) {
		// Reinstall currently-selected existing agents.
		for (const name of selected.filter((n) => installedSet.has(n))) {
			const ag = registry.get(name as AgentName);
			if (ag === null) {
				continue;
			}
			try {
				await setupAgentHooks(ag, { localDev: opts.localDev, force: true });
			} catch (err) {
				errs.push(err instanceof Error ? err : new Error(String(err)));
			}
		}
	}

	const removedAgents: Agent[] = [];
	for (const name of toRemove) {
		const ag = registry.get(name as AgentName);
		if (ag === null) {
			continue;
		}
		try {
			await uninstallOneAgentHooks(ag);
			removedAgents.push(ag);
		} catch (err) {
			errs.push(err instanceof Error ? err : new Error(String(err)));
		}
	}

	// Auto-enable external_agents if a newly-added agent is external.
	if (addedAgents.some((ag) => isExternalAgent(ag))) {
		const settings = await loadOrDefault(opts.repoRoot);
		settings.external_agents = true;
		await writeSettingsScoped(opts.repoRoot, settings, opts.scope);
	}

	barEmpty();
	if (errs.length > 0) {
		throw new AggregateError(errs, 'some agent changes failed');
	}
	if (addedAgents.length > 0) {
		stepDone(`Added ${addedAgents.map((a) => a.type()).join(', ')}`);
	}
	if (removedAgents.length > 0) {
		stepDone(`Removed ${removedAgents.map((a) => a.type()).join(', ')}`);
	}
	if (addedAgents.length === 0 && removedAgents.length === 0) {
		stepDone('Settings updated.');
	}
	footer(`${color.dim('Run')} 'story status' ${color.dim('to verify.')}`);
}

/**
 * Non-interactive configure — `--agent <name>` adds / reinstalls a single
 * agent. Settings' `enabled: true` is preserved; only the per-agent hooks
 * + settings.external_agents are touched.
 */
export async function runNonInteractiveConfigureAdd(opts: ConfigureOptions): Promise<void> {
	if (opts.agentName === undefined || opts.agentName === '') {
		throw new SilentError(new Error('missing agent name'));
	}
	if (!(await isEnabled(opts.repoRoot))) {
		throw new SilentError(
			new Error('Story is not enabled in this repository. Run `story enable` to set it up.'),
		);
	}
	const ag = getAgentOrFail(opts.agentName);

	header('configure');
	step('Repository detected');
	barLine(color.dim(opts.repoRoot));
	barEmpty();

	await setupAgentHooks(ag, { localDev: opts.localDev, force: opts.force });

	const settings = await loadOrDefault(opts.repoRoot);
	if (isExternalAgent(ag)) {
		settings.external_agents = true;
	}
	applyStrategyOptions(settings, {
		skipPushSessions: opts.skipPushSessions,
		checkpointRemote: opts.checkpointRemote,
	});
	if (opts.telemetry === false) {
		settings.telemetry = false;
	}
	await writeSettingsScoped(opts.repoRoot, settings, opts.scope);

	barEmpty();
	stepDone(`Added ${ag.type()}`);
	footer(`${color.dim('Run')} 'story status' ${color.dim('to verify.')}`);
}

/**
 * Non-interactive configure — `--remove <name>`. Validates the agent name +
 * uninstalls its hooks; bails with a friendly message if hooks were never
 * installed.
 *
 * Mirrors Go `setup.go: runRemoveAgent`.
 */
export async function uninstallAgentHooks(repoRoot: string, agentName: string): Promise<void> {
	if (agentName === '') {
		throw new SilentError(new Error('missing agent name'));
	}
	if (!(await isEnabled(repoRoot))) {
		throw new SilentError(
			new Error('Story is not enabled in this repository. Run `story enable` to set it up.'),
		);
	}
	const ag = getAgentOrFail(agentName);
	const hs = requireHookSupport(ag);

	header('configure --remove');
	step('Repository detected');
	barLine(color.dim(repoRoot));
	barEmpty();

	if (!(await hs.areHooksInstalled())) {
		stepDone(`${ag.type()} hooks are not installed.`);
		footer();
		return;
	}

	await uninstallOneAgentHooks(ag);
	barEmpty();
	stepDone(`Removed ${ag.type()} from this repository`);
	footer(`${color.dim('Run')} 'story status' ${color.dim('to verify.')}`);
}

/**
 * Apply only strategy flags to settings (`--skip-push-sessions` /
 * `--checkpoint-remote` / etc.) without running through agent selection.
 * Used by `configure --skip-push-sessions` and friends when the repo is
 * already enabled.
 *
 * Mirrors Go `setup.go: updateStrategyOptions`.
 */
export async function runUpdateStrategyOptions(opts: ConfigureOptions): Promise<void> {
	header('configure');
	step('Repository detected');
	barLine(color.dim(opts.repoRoot));
	barEmpty();

	// Validate checkpoint-remote up-front — bail before touching disk so we
	// don't print "Settings updated" on invalid input.
	if (opts.checkpointRemote !== undefined && opts.checkpointRemote !== '') {
		// parseCheckpointRemote throws SilentError on invalid input.
		const { parseCheckpointRemote } = await import('./setup-helpers');
		parseCheckpointRemote(opts.checkpointRemote);
	}

	const settings = await loadOrDefault(opts.repoRoot);
	applyStrategyOptions(settings, {
		skipPushSessions: opts.skipPushSessions,
		checkpointRemote: opts.checkpointRemote,
	});
	if (opts.telemetry === false) {
		settings.telemetry = false;
	}
	await writeSettingsScoped(opts.repoRoot, settings, opts.scope);

	stepDone(
		`Settings updated (${opts.scope === 'project' ? '.story/settings.json' : '.story/settings.local.json'})`,
	);
	footer(`${color.dim('Run')} 'story status' ${color.dim('to verify.')}`);
}

// ——————————————————————— internal helpers ———————————————————————

function getAgentOrFail(agentName: string): Agent {
	const ag = registry.get(agentName as AgentName);
	if (ag === null) {
		throw new SilentError(new Error(`unknown agent "${agentName}"`));
	}
	// Ensure the agent actually supports hook installation — otherwise the
	// whole flow is pointless and we'd surface a confusing "does not support
	// hooks" message buried deep in the pipeline.
	requireHookSupport(ag);
	return ag;
}

async function loadOrDefault(repoRoot: string): Promise<StorySettings> {
	try {
		return await load(repoRoot);
	} catch {
		return { enabled: true };
	}
}

async function tryGetGitCommonDir(repoRoot: string): Promise<string | null> {
	try {
		return await getGitCommonDir(repoRoot);
	} catch {
		return null;
	}
}

async function safeListSessionStates(commonDir: string, _repoRoot: string): Promise<number> {
	try {
		const store = new StateStore(sessionStateDir(commonDir));
		return (await store.list()).length;
	} catch {
		return 0;
	}
}

async function dirExists(p: string): Promise<boolean> {
	try {
		const stat = await fs.stat(p);
		return stat.isDirectory();
	} catch {
		return false;
	}
}

function renderUninstallTargets(counts: {
	agentCount: number;
	shadowCount: number;
	stateCount: number;
	storyDirExists: boolean;
}): void {
	warn('--uninstall is destructive.');
	warn('This will remove:');
	if (counts.storyDirExists) {
		warn('  ● .story/ directory (settings + logs + tmp)');
	}
	warn('  ● 5 git hooks (.git/hooks/*)');
	if (counts.agentCount > 0) {
		warn(`  ● agent hooks (${counts.agentCount} agent${counts.agentCount === 1 ? '' : 's'})`);
	}
	if (counts.stateCount > 0) {
		warn(`  ● session state files (${counts.stateCount})`);
	}
	if (counts.shadowCount > 0) {
		warn(`  ● shadow branches (${counts.shadowCount})`);
	}
	barEmpty();
}
