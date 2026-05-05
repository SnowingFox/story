/**
 * `story trace` — show recent hook performance traces.
 *
 * Reads `.story/logs/story.log`, parses `msg: "perf"` entries via
 * [`./trace-render.ts`](./trace-render.ts), and renders them as a
 * bar-block tree.
 *
 * Mirrors Go `cmd/entire/cli/trace_cmd.go: newTraceCmd`.
 *
 * @packageDocumentation
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { CAC } from 'cac';
import { applyGlobalFlags } from '@/cli/flags';
import { collectTraceEntries, renderTraceEntries } from '@/commands/trace-render';
import { SilentError } from '@/errors';
import { getStoryFilePath, worktreeRoot } from '@/paths';
import { isSetUpAny } from '@/settings/settings';

/**
 * Register `story trace` on a cac instance. Call once from
 * {@link ./index::registerCoreCommands}.
 *
 * Go: `trace_cmd.go: newTraceCmd`.
 *
 * @example
 * registerTraceCommand(cli);
 * // Now resolvable:
 * //   story trace
 * //   story trace --last 5
 * //   story trace --hook post-commit
 */
export function registerTraceCommand(cli: CAC): void {
	cli
		.command('trace', 'Show hook performance traces')
		.option('--last <N>', 'Show the last N hook invocations', { default: 1 })
		.option('--hook <name>', 'Filter by hook name (e.g. post-commit)')
		.action(async (rawFlags: Record<string, unknown>) => {
			applyGlobalFlags(rawFlags);

			const last = Number(rawFlags.last ?? 1);
			const hookFilter = typeof rawFlags.hook === 'string' ? (rawFlags.hook as string).trim() : '';

			if (!Number.isFinite(last) || last < 1) {
				throw new SilentError(new Error(`--last must be at least 1, got ${rawFlags.last}`));
			}

			let repoRoot: string;
			try {
				repoRoot = await worktreeRoot(process.cwd());
			} catch {
				throw new SilentError(new Error('Not a git repository'));
			}

			if (!(await isSetUpAny(repoRoot))) {
				throw new SilentError(
					new Error(
						"Story is not enabled in this repository | No .story/ directory found. Run 'story enable' first, then try again.",
					),
				);
			}

			const logFile = path.join(getStoryFilePath(repoRoot, 'logs'), 'story.log');

			try {
				await fs.stat(logFile);
			} catch {
				throw new SilentError(
					new Error(
						"No .story/logs/story.log found | Run 'story enable --log-level debug' and trigger a hook (e.g. git commit --allow-empty -m probe) first.",
					),
				);
			}

			const entries = await collectTraceEntries(
				logFile,
				last,
				hookFilter !== '' ? hookFilter : undefined,
			);

			if (entries.length === 0) {
				throw new SilentError(
					new Error(
						hookFilter !== ''
							? `No hook traces found for --hook ${hookFilter} | Traces require DEBUG log level. Run 'story enable --log-level debug' and trigger a ${hookFilter} hook first.`
							: "No hook traces found | Traces require DEBUG log level. Run 'story enable --log-level debug' and trigger a hook first (e.g. git commit --allow-empty -m probe).",
					),
				);
			}

			renderTraceEntries(process.stdout, entries);
		});
}
