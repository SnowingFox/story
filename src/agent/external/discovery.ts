/**
 * External agent discovery — scans `$PATH` for `story-agent-*` executables,
 * calls their `info` subcommand, and registers them in the agent registry.
 *
 * Mirrors Go `cmd/entire/cli/agent/external/discovery.go`.
 *
 * **Story-side divergences**: binary prefix is `story-agent-` (Go:
 * `entire-agent-`); settings key is `external_agents` (same in both).
 *
 * @packageDocumentation
 */

import fs from 'node:fs';
import path from 'node:path';
import type { LogContext } from '@/log';
import * as log from '@/log';
import { worktreeRoot } from '@/paths';
import { load as loadSettings } from '@/settings/settings';
import { list, register } from '../registry';
import type { AgentName } from '../types';
import { wrap } from './capabilities';
import { ExternalAgent } from './index';

export const BINARY_PREFIX = 'story-agent-';

const DISCOVERY_TIMEOUT_MS = 10_000;

/**
 * Discover and register external agents from `$PATH`. Respects the
 * `external_agents` setting — skips discovery when disabled.
 *
 * Mirrors Go `external.DiscoverAndRegister`.
 */
export async function discoverAndRegister(ctx?: AbortSignal): Promise<void> {
	if (!(await isExternalAgentsEnabled())) {
		return;
	}
	await discoverAndRegisterInternal(ctx);
}

/**
 * Like {@link discoverAndRegister} but bypasses the settings check. Used in
 * interactive setup flows where the user explicitly chooses agents.
 *
 * Mirrors Go `external.DiscoverAndRegisterAlways`.
 */
export async function discoverAndRegisterAlways(ctx?: AbortSignal): Promise<void> {
	await discoverAndRegisterInternal(ctx);
}

async function isExternalAgentsEnabled(): Promise<boolean> {
	try {
		const root = await worktreeRoot();
		const settings = await loadSettings(root);
		return settings.external_agents === true;
	} catch {
		return false;
	}
}

async function discoverAndRegisterInternal(ctx?: AbortSignal): Promise<void> {
	// Always apply the 10s cap — `AbortSignal.any` ensures the timeout fires
	// even when the caller supplied their own (non-deadlined) signal. Mirrors
	// Go `discovery.go`: `ctx, cancel := context.WithTimeout(ctx, 10s)` always.
	const timeoutSignal = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS);
	const signal = ctx !== undefined ? AbortSignal.any([ctx, timeoutSignal]) : timeoutSignal;

	const pathEnv = process.env.PATH ?? '';
	if (pathEnv === '') {
		return;
	}

	const registered = new Set<string>(list() as string[]);
	const seen = new Set<string>();

	for (const dir of pathEnv.split(path.delimiter)) {
		if (signal.aborted) {
			return;
		}

		let entries: string[];
		try {
			entries = fs.readdirSync(dir);
		} catch {
			continue;
		}

		for (const name of entries) {
			if (signal.aborted) {
				return;
			}
			if (!name.startsWith(BINARY_PREFIX)) {
				continue;
			}
			if (seen.has(name)) {
				continue;
			}
			seen.add(name);

			const cleanName = stripExeExt(name);
			const agentName = cleanName.slice(BINARY_PREFIX.length) as AgentName;
			if (registered.has(agentName as string)) {
				continue;
			}

			const binPath = path.join(dir, name);
			let finfo: fs.Stats;
			try {
				finfo = fs.statSync(binPath);
			} catch {
				continue;
			}
			if (finfo.isDirectory()) {
				continue;
			}
			if (process.platform !== 'win32' && (finfo.mode & 0o111) === 0) {
				continue;
			}

			let ea: ExternalAgent;
			try {
				ea = await ExternalAgent.create(binPath, signal);
			} catch (e) {
				const logCtx: LogContext = {};
				log.debug(
					logCtx,
					`skipping external agent (info failed): ${binPath}: ${(e as Error).message}`,
				);
				continue;
			}

			let wrapped: ReturnType<typeof wrap>;
			try {
				wrapped = wrap(ea);
			} catch (e) {
				const logCtx: LogContext = {};
				log.debug(
					logCtx,
					`skipping external agent (wrap failed): ${binPath}: ${(e as Error).message}`,
				);
				continue;
			}

			register(agentName, () => wrapped);
			registered.add(agentName as string);
		}
	}
}

/**
 * Strip Windows executable extensions (.exe, .bat, .cmd) from a file name.
 * On Unix this is effectively a no-op.
 *
 * Mirrors Go `external.stripExeExt`.
 */
export function stripExeExt(name: string): string {
	const ext = path.extname(name).toLowerCase();
	if (ext === '.exe' || ext === '.bat' || ext === '.cmd') {
		return name.slice(0, -ext.length);
	}
	return name;
}
