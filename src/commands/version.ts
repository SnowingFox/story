/**
 * `story version` — print build information.
 *
 * Mirrors Go `cmd/entire/cli/root.go: versionInfo` output structure
 * with Story-side brand. Both `version` and `commit` fields are
 * sourced from [`@/versioninfo`](../versioninfo.ts) (VERSION read
 * from `package.json` at module load; COMMIT injected via
 * `STORY_COMMIT` env / bundler define, falling back to `'dev'`).
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CAC } from 'cac';
import { getGlobalFlags } from '@/cli/flags';
import { color } from '@/ui/theme';
import { COMMIT } from '@/versioninfo';

interface VersionPayload {
	name: 'story';
	version: string;
	runtime: string;
	platform: string;
	arch: string;
	commit: string;
}

/**
 * Read `version` from the repo's `package.json`. Works from both
 * source (bun run) and built output (dist/) because `import.meta.url`
 * points into `src/` or `dist/` respectively and we walk up once to
 * reach the package root in both cases.
 */
function readPackageVersion(): string {
	try {
		const here = path.dirname(fileURLToPath(import.meta.url));
		// src/commands → src → . (repo root). In dist, dist/... → repo root.
		const candidates = [
			path.resolve(here, '../../package.json'),
			path.resolve(here, '../package.json'),
			path.resolve(here, '../../../package.json'),
		];
		for (const candidate of candidates) {
			try {
				const raw = readFileSync(candidate, 'utf8');
				const parsed = JSON.parse(raw) as { name?: string; version?: string };
				if (parsed.version) {
					return parsed.version;
				}
			} catch {
				// try next candidate
			}
		}
	} catch {
		// fallthrough
	}
	return '0.0.0';
}

function resolveRuntime(): string {
	const bunVersion = (process.versions as Record<string, string | undefined>).bun;
	if (bunVersion !== undefined) {
		return `bun ${bunVersion}`;
	}
	return `node ${process.versions.node}`;
}

function buildPayload(): VersionPayload {
	return {
		name: 'story',
		version: readPackageVersion(),
		runtime: resolveRuntime(),
		platform: process.platform,
		arch: process.arch,
		commit: COMMIT,
	};
}

/**
 * Register `story version` on the given cac instance. Idempotent per
 * the usual cac contract — call once inside `buildCli()`.
 *
 * @example
 * registerVersionCommand(cli);
 * // `story version`         → plain multi-line output
 * // `story version --json`  → single JSON line
 */
export function registerVersionCommand(cli: CAC): void {
	cli.command('version', 'Show build information').action(() => {
		const payload = buildPayload();
		if (getGlobalFlags().json) {
			process.stdout.write(`${JSON.stringify(payload)}\n`);
			return;
		}
		process.stdout.write(`${color.cyan(color.bold('Story CLI'))}\n`);
		process.stdout.write(`  ${color.dim('version:')}   ${payload.version}\n`);
		process.stdout.write(`  ${color.dim('runtime:')}   ${payload.runtime}\n`);
		process.stdout.write(`  ${color.dim('platform:')}  ${payload.platform}\n`);
		process.stdout.write(`  ${color.dim('arch:')}      ${payload.arch}\n`);
		process.stdout.write(`  ${color.dim('commit:')}    ${payload.commit}\n`);
	});
}
