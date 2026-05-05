/**
 * Built-in agent registration. Single source of truth for which agents
 * the production Story CLI ships with.
 *
 * Module-level side-effects are forbidden — see [`AGENTS.md`
 * §异步/模块边界](../../AGENTS.md). Each agent module exports a factory
 * only; this module wires factories into the registry. Called by
 * `src/cli.ts: run()` at startup and by tests in `beforeAll(...)`.
 */

import { claudeCodeAgent } from './claude-code';
import { codexAgent } from './codex';
import { cursorAgent } from './cursor';
import { opencodeAgent } from './opencode';
import { register } from './registry';
import {
	AGENT_NAME_CLAUDE_CODE,
	AGENT_NAME_CODEX,
	AGENT_NAME_CURSOR,
	AGENT_NAME_OPENCODE,
} from './types';
import { AGENT_NAME_VOGON, vogonAgent } from './vogon';

/**
 * Register all built-in agents into the framework registry. Idempotent
 * (last-write-wins, matches Go `agent.Register`).
 */
export function registerBuiltinAgents(): void {
	register(AGENT_NAME_VOGON, vogonAgent);
	register(AGENT_NAME_CLAUDE_CODE, claudeCodeAgent);
	register(AGENT_NAME_CURSOR, cursorAgent);
	register(AGENT_NAME_CODEX, codexAgent);
	register(AGENT_NAME_OPENCODE, opencodeAgent);
}
