/**
 * Story CLI binary entry. This file is the explicit executable startup
 * boundary, so the bottom-level `run()` call is intentional. Reusable modules
 * stay side-effect free; CLI registration / parsing is centralized here.
 *
 * See [`AGENTS.md` §异步/模块边界](../AGENTS.md) for why module-level
 * side effects are forbidden outside the bin entry.
 */
import cac from 'cac';
import { registerBuiltinAgents } from '@/agent/bootstrap';
import { discoverAndRegister } from '@/agent/external/discovery';
import * as registry from '@/agent/registry';
import { applyGlobalFlags, registerGlobalFlags } from '@/cli/flags';
import { setupHelpOverride } from '@/cli/help';
import { runCli } from '@/cli/runtime';
import { registerCoreCommands } from '@/commands';
import { handleAgentHookCommand } from '@/commands/hooks-agent';
import { handleGitHookCommand } from '@/commands/hooks-git';
import { setAgentSessionFileResolver } from '@/strategy/resolve-transcript';

// `registry` is kept as a live import because `buildCli`'s
// `setAgentSessionFileResolver` closes over `registry.getByAgentType` to
// resolve an agent by its stored metadata type string — see the resolver
// wiring below.

/**
 * Build the Story CLI: register built-in agents, wire the agent-aware
 * session file resolver, install the custom help renderer + global
 * flags, and register core commands (`version` + `help`).
 *
 * Hook dispatch (`story hooks git <name>` + `story hooks <agent>
 * <verb>`) is registered as a single catch-all `hooks [...args]` cac
 * command because cac has no native multi-word command tree. The
 * action routes on `args[0] === 'git'` to
 * {@link handleGitHookCommand} or falls through to
 * {@link handleAgentHookCommand} for everything else.
 */
export function buildCli() {
	registerBuiltinAgents();
	setAgentSessionFileResolver((agentType, sessionDir, agentSessionId) => {
		const ag = registry.getByAgentType(agentType);
		if (ag === null) {
			return null;
		}
		return ag.resolveSessionFile(sessionDir, agentSessionId);
	});

	const cli = cac('story');
	setupHelpOverride(cli);
	registerGlobalFlags(cli);
	registerCoreCommands(cli);

	// Default command: `story` (no args) renders the custom help page
	// rather than cac's empty default. Use cac's "[...args]" default
	// syntax to match when no subcommand is given.
	cli.command('', 'Show help').action(() => {
		cli.outputHelp();
	});

	// `story hooks [...args]` — internal dispatch for git + agent hooks.
	// Hidden from `--help` (no description); git shell shims and agent
	// hook configs invoke this path directly.
	cli
		.command('hooks [...args]', '', { allowUnknownOptions: true })
		.action(async (args: string[], rawFlags: Record<string, unknown>) => {
			// Apply global flags so `--log-level debug` / `--verbose` actually
			// flip `log.setLevel(...)` on the hook path. `runtime.ts` skips
			// its own `applyGlobalFlags` call for the hook bypass branch, so
			// without this the flags are parsed but never committed.
			applyGlobalFlags(rawFlags);
			if (args.length === 0) {
				return;
			}
			if (args[0] === 'git') {
				await handleGitHookCommand(args.slice(1));
				return;
			}
			await handleAgentHookCommand(args);
		});

	return cli;
}

/**
 * Bin entry — build CLI, discover external agents, delegate to
 * {@link runCli} for banner / global-flag / top-level-catch
 * orchestration.
 */
export async function run(argv?: string[]): Promise<void> {
	const cli = buildCli();
	await discoverAndRegister();
	await runCli(cli, argv);
}

run();
