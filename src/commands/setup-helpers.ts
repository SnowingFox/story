/**
 * Pure, side-effect-light helpers used by `story enable` / `disable` /
 * `configure` command actions. Split from `setup-flow.ts` so tests can hit
 * these without mocking the full agent registry or filesystem.
 *
 * Mirrors Go `cmd/entire/cli/setup.go` helpers: `validateSetupFlags`,
 * `parseCheckpointRemoteFlag`, `applyStrategyOptions`, `settingsTargetFile`,
 * `determineSettingsTarget`, `printMissingAgentError`, `printWrongAgentError`,
 * plus `config.go: GetAgentsWithHooksInstalled` /
 * `InstalledAgentDisplayNames`.
 *
 * @packageDocumentation
 */

import fs from 'node:fs/promises';
import { asHookSupport } from '@/agent/capabilities';
import * as registry from '@/agent/registry';
import type { AgentName } from '@/agent/types';
import { SilentError } from '@/errors';
import { getStoryFilePath } from '@/paths';
import {
	type CheckpointRemoteConfig,
	LOCAL_SETTINGS_FILE,
	SETTINGS_FILE,
	type StorySettings,
	saveEnabledState,
} from '@/settings/settings';
import type { SelectOption } from '@/ui';
import { barEmpty, barLine, footer, S, stepError } from '@/ui';
import { color } from '@/ui/theme';

/** Scope target for settings file writes. */
export type SettingsScope = 'local' | 'project';

/** Flag bundle shared between `enable` / `configure` actions. */
export interface SetupFlags {
	agent?: string;
	local?: boolean;
	project?: boolean;
	force?: boolean;
	skipPushSessions?: boolean;
	checkpointRemote?: string;
	telemetry?: boolean;
	absoluteGitHookPath?: boolean;
	ignoreUntracked?: boolean;
	localDev?: boolean;
}

/**
 * Build the `select` / `multiselect` options for Story's agent picker. Iterates
 * {@link registry.stringList} (which already excludes `TestOnly` agents) and
 * decorates each entry with the agent's description as a hint.
 *
 * Mirrors Go `setup.go: detectOrSelectAgent` option-building loop.
 *
 * @example
 * buildAgentListForPrompt();
 * // returns: [
 * //   { value: 'claude-code', label: 'claude-code', hint: 'Anthropic Claude Code' },
 * //   { value: 'cursor',      label: 'cursor',      hint: 'Cursor Editor' },
 * //   ...
 * // ]   (Vogon canary filtered out because isTestOnly() returns true)
 */
export function buildAgentListForPrompt(): SelectOption<string>[] {
	const names = registry.stringList();
	const options: SelectOption<string>[] = [];
	for (const name of names) {
		const ag = registry.get(name as AgentName);
		if (ag === null) {
			continue;
		}
		// Only offer agents that can actually install hooks.
		const [, ok] = asHookSupport(ag);
		if (!ok) {
			continue;
		}
		options.push({
			value: name,
			label: name,
			hint: ag.description(),
		});
	}
	return options;
}

/**
 * Assert that `--local` and `--project` are not both specified. Throws the
 * exact Go error text so future string-compare CLI migrations stay aligned.
 *
 * Mirrors Go `setup.go: validateSetupFlags`.
 *
 * @example
 * validateMutuallyExclusiveFlags({ local: true, project: true });
 * // throws: SilentError('cannot specify both --project and --local')
 *
 * validateMutuallyExclusiveFlags({ local: true });  // no-op
 * validateMutuallyExclusiveFlags({});               // no-op
 */
export function validateMutuallyExclusiveFlags(flags: {
	local?: boolean;
	project?: boolean;
}): void {
	if (flags.local === true && flags.project === true) {
		throw new SilentError(new Error('cannot specify both --project and --local'));
	}
}

/** Canonical list of supported checkpoint-remote providers. */
const SUPPORTED_CHECKPOINT_PROVIDERS = ['github'] as const;

/**
 * Parse `provider:owner/repo` into its structured form.
 *
 * Mirrors Go `setup.go: parseCheckpointRemoteFlag`. Error strings match Go
 * byte-for-byte (minus the Go `%q` → JS quote difference; we keep double
 * quotes) so operators searching their terminal history find the hint.
 *
 * @example
 * parseCheckpointRemote('github:acme/checkpoints');
 * // returns: { provider: 'github', repo: 'acme/checkpoints' }
 *
 * parseCheckpointRemote('github');        // throws SilentError
 * parseCheckpointRemote('github:acme');   // throws SilentError (no `/`)
 * parseCheckpointRemote('gitlab:x/y');    // throws SilentError (unsupported)
 */
export function parseCheckpointRemote(raw: string): CheckpointRemoteConfig {
	const colonIdx = raw.indexOf(':');
	if (colonIdx <= 0 || colonIdx === raw.length - 1) {
		throw new SilentError(
			new Error(
				`expected format provider:owner/repo (e.g., github:org/checkpoints-repo), got "${raw}"`,
			),
		);
	}
	const provider = raw.slice(0, colonIdx);
	const repo = raw.slice(colonIdx + 1);

	if (!SUPPORTED_CHECKPOINT_PROVIDERS.includes(provider as 'github')) {
		throw new SilentError(
			new Error(
				`unsupported provider "${provider}" (supported: ${SUPPORTED_CHECKPOINT_PROVIDERS.join(', ')})`,
			),
		);
	}

	const slashIdx = repo.indexOf('/');
	if (slashIdx <= 0 || slashIdx === repo.length - 1) {
		throw new SilentError(new Error(`repo must be in owner/name format, got "${repo}"`));
	}

	return { provider, repo };
}

/**
 * Apply strategy-style CLI flags (`--skip-push-sessions`, `--checkpoint-remote`)
 * to a settings object in-place. Invalid `--checkpoint-remote` emits a stderr
 * warning but **does not** abort (matches Go's "validate-then-apply" semantic
 * — callers that want hard-fail validation should call
 * {@link parseCheckpointRemote} directly first).
 *
 * Mirrors Go `setup.go: (*EnableOptions).applyStrategyOptions`.
 *
 * @example
 * const s: StorySettings = { enabled: true };
 * applyStrategyOptions(s, { skipPushSessions: true, checkpointRemote: 'github:a/b' });
 * // returns: void
 * // s.strategy_options === { push_sessions: false, checkpoint_remote: { provider: 'github', repo: 'a/b' } }
 *
 * // Side effects on failure:
 * //   process.stderr ← '[story] Warning: invalid --checkpoint-remote ...'
 * //   s.strategy_options.checkpoint_remote: unchanged
 */
export function applyStrategyOptions(
	s: StorySettings,
	flags: { skipPushSessions?: boolean; checkpointRemote?: string },
): void {
	if (flags.skipPushSessions === true) {
		s.strategy_options = { ...(s.strategy_options ?? {}), push_sessions: false };
	}
	if (flags.checkpointRemote !== undefined && flags.checkpointRemote !== '') {
		try {
			const parsed = parseCheckpointRemote(flags.checkpointRemote);
			s.strategy_options = {
				...(s.strategy_options ?? {}),
				checkpoint_remote: { provider: parsed.provider, repo: parsed.repo },
			};
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			process.stderr.write(`[story] Warning: invalid --checkpoint-remote format: ${msg}\n`);
		}
	}
}

/**
 * Pick the settings file to write to based on flags + which file currently
 * exists. Returns `'local'` / `'project'` directly (TS simplification — Go
 * returns a tuple `(path, displayName)` because it formats the display in the
 * caller; Story's UI renders it via the shared bar block so we only need the
 * scope).
 *
 * Mirrors Go `setup.go: settingsTargetFile`.
 *
 * @example
 * await settingsTargetFile('/repo', true, false);   // => 'local'   (--local wins)
 * await settingsTargetFile('/repo', false, true);   // => 'project' (--project wins)
 *
 * // Auto-mode (no flags): prefers whichever file exists; default to project.
 * await settingsTargetFile('/repo', false, false);  // => 'project' (only settings.json exists)
 * await settingsTargetFile('/repo', false, false);  // => 'local'   (only settings.local.json exists)
 * await settingsTargetFile('/repo', false, false);  // => 'project' (neither file exists)
 *
 * // Side effects: up to 2 fs.stat calls. No writes.
 */
export async function settingsTargetFile(
	repoRoot: string,
	useLocal: boolean,
	useProject: boolean,
): Promise<SettingsScope> {
	if (useLocal) {
		return 'local';
	}
	if (useProject) {
		return 'project';
	}
	// Auto — prefer project if it exists, else local; default project.
	if (await fileExists(getStoryFilePath(repoRoot, SETTINGS_FILE))) {
		return 'project';
	}
	if (await fileExists(getStoryFilePath(repoRoot, LOCAL_SETTINGS_FILE))) {
		return 'local';
	}
	return 'project';
}

/**
 * Decide whether `runInteractiveEnable` should write to the local settings
 * file and whether to surface a "redirecting to local" notification. Differs
 * from {@link settingsTargetFile} — the notification is only meaningful
 * when the project file already exists and neither flag is passed (auto
 * mode picks local to avoid clobbering committed config).
 *
 * Mirrors Go `setup.go: determineSettingsTarget`.
 *
 * @example
 * // Explicit flags: no notification.
 * await determineSettingsTarget('/repo', true,  false); // => [true,  false]
 * await determineSettingsTarget('/repo', false, true ); // => [false, false]
 *
 * // Auto mode, project exists → redirect to local + notify user.
 * await determineSettingsTarget('/repo', false, false); // => [true,  true ]
 * // Auto mode, project does not exist → create project, no redirect.
 * await determineSettingsTarget('/repo', false, false); // => [false, false]
 *
 * // Side effects: 1 fs.stat call. No writes.
 */
export async function determineSettingsTarget(
	repoRoot: string,
	useLocal: boolean,
	useProject: boolean,
): Promise<[boolean, boolean]> {
	if (useLocal) {
		return [true, false];
	}
	if (useProject) {
		return [false, false];
	}
	if (await fileExists(getStoryFilePath(repoRoot, SETTINGS_FILE))) {
		return [true, true];
	}
	return [false, false];
}

/**
 * Thin wrapper around {@link saveEnabledState} that takes a string scope
 * instead of the Go-style boolean. Keeps command actions free of the
 * `useProjectSettings === 'project'` conversion.
 *
 * @example
 * await writeSettingsScoped('/repo', { enabled: true }, 'local');
 * // Side effects:
 * //   <repoRoot>/.story/settings.local.json ← rewritten atomically.
 * //   <repoRoot>/.story/settings.json       ← unchanged.
 */
export async function writeSettingsScoped(
	repoRoot: string,
	s: StorySettings,
	scope: SettingsScope,
): Promise<void> {
	await saveEnabledState(repoRoot, s, scope === 'project');
}

/**
 * Return the registered agents whose `HookSupport` capability reports
 * `areHooksInstalled() === true`. The result order follows
 * {@link registry.list} (lexical).
 *
 * Mirrors Go `config.go: GetAgentsWithHooksInstalled`.
 */
export async function getAgentsWithHooksInstalled(): Promise<AgentName[]> {
	const installed: AgentName[] = [];
	for (const name of registry.list()) {
		const ag = registry.get(name);
		if (ag === null) {
			continue;
		}
		const [hs, ok] = asHookSupport(ag);
		if (!ok) {
			continue;
		}
		try {
			if (await hs.areHooksInstalled()) {
				installed.push(name);
			}
		} catch {
			// Agent check failed — treat as "not installed" rather than aborting
			// the full list (parity with Go: Go errors there propagate, but Story
			// would fail status / configure for a single broken agent otherwise).
		}
	}
	return installed;
}

/**
 * Return the user-facing `agent.type()` strings for agents with hooks
 * installed. Paired with {@link getAgentsWithHooksInstalled} — used by the
 * `Active agents: ...` header in `disable --uninstall` / `configure`.
 *
 * Mirrors Go `config.go: InstalledAgentDisplayNames`.
 */
export async function installedAgentDisplayNames(): Promise<string[]> {
	const names = await getAgentsWithHooksInstalled();
	const display: string[] = [];
	for (const name of names) {
		const ag = registry.get(name);
		if (ag === null) {
			continue;
		}
		display.push(ag.type());
	}
	return display;
}

/**
 * Render the shared "agent name is required" error block — header line,
 * available-agents hint, and closing bar. Mirrors the visual spec in
 * `commands/9.1-0-enable.md` error section.
 *
 * Mirrors Go `setup.go: printMissingAgentError`.
 *
 * @example
 * printMissingAgentError();
 * // stderr:
 * //   ■  Missing agent name.
 * //   │  Available: claude-code, cursor, ...
 * //   │  Usage: story enable --agent <agent-name>
 * //   └
 */
export function printMissingAgentError(): void {
	renderAgentError('Missing agent name.');
}

/**
 * Render the shared "unknown agent" error block. Same visual as
 * {@link printMissingAgentError} but with the bad name echoed back.
 *
 * Mirrors Go `setup.go: printWrongAgentError`.
 */
export function printWrongAgentError(name: string): void {
	renderAgentError(`Unknown agent "${name}".`);
}

function renderAgentError(headline: string): void {
	stepError(headline);
	const agents = registry.stringList();
	if (agents.length > 0) {
		barLine(`${color.dim('Available:')} ${agents.join(', ')}`);
	}
	barLine(`${color.dim('Usage:')} story enable --agent <agent-name>`);
	barEmpty();
	footer();
	// Keep `S` live so tree-shakers don't strip it when this module is
	// imported only for its bar renderers.
	void S;
}

async function fileExists(p: string): Promise<boolean> {
	try {
		await fs.stat(p);
		return true;
	} catch {
		return false;
	}
}
