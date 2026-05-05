/**
 * Compile-time version constants shared by `story version`, the
 * transcript-compact `cli_version` field, and session-state
 * `cliVersion` bookkeeping.
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/versioninfo/versioninfo.go` —
 * Go uses `-ldflags "-X .../versioninfo.Version=..."` to override
 * `Version` / `Commit` at `go build` time; TS takes the same two
 * knobs through process env + a `globalThis.STORY_COMMIT` fallback
 * (which `tsup --define STORY_COMMIT='"<sha>"'` can populate at
 * bundle time).
 *
 * Consumers:
 *   - [`src/commands/version.ts`](./commands/version.ts) — plain /
 *     `--json` output
 *   - [`src/strategy/condensation.ts`](./strategy/condensation.ts) —
 *     transcript-compact `cli_version` metadata
 *   - [`src/strategy/hooks-initialize-session.ts`](./strategy/hooks-initialize-session.ts)
 *     — `SessionState.cliVersion`
 *
 * @packageDocumentation
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Read `version` from the repo's `package.json`. Walks a few likely
 * candidate paths to cover both source (`src/...`) and bundled
 * (`dist/...`) execution. Mirrors the Go behaviour of "whatever the
 * linker stamps in, or `dev` if nothing was stamped" — we default to
 * `0.0.0` so the string stays in semver shape for consumers that
 * parse it.
 *
 * `readFileSync` is referenced via the `node:fs` import (rather than
 * `fs.readFileSync`) so vitest `vi.doMock('node:fs', …)` can swap it
 * out in the fallback-path tests.
 */
function readPackageVersion(): string {
	try {
		const here = path.dirname(fileURLToPath(import.meta.url));
		// src/versioninfo.ts → repo root is one level up; dist/cli.js → two.
		const candidates = [
			path.resolve(here, '..', 'package.json'),
			path.resolve(here, '..', '..', 'package.json'),
			path.resolve(here, '..', '..', '..', 'package.json'),
		];
		for (const candidate of candidates) {
			try {
				const raw = readFileSync(candidate, 'utf8');
				const parsed = JSON.parse(raw) as { version?: string };
				if (typeof parsed.version === 'string' && parsed.version !== '') {
					return parsed.version;
				}
			} catch {
				// try next candidate
			}
		}
	} catch {
		// fallthrough to fallback below
	}
	return '0.0.0';
}

/**
 * Resolve the build-time commit SHA. Priority order:
 *
 *   1. `process.env.STORY_COMMIT` — set via `STORY_COMMIT=<sha>` at
 *      dev time; also testable via `vi.stubEnv`.
 *   2. `globalThis.STORY_COMMIT` — populated by
 *      `tsup --define STORY_COMMIT='"<sha>"'` at bundle time.
 *   3. `'dev'` — dev-mode fallback matching Go's `Version = "dev"`
 *      zero value.
 */
function readCommit(): string {
	const envCommit = process.env.STORY_COMMIT;
	if (typeof envCommit === 'string' && envCommit !== '') {
		return envCommit;
	}
	const injected = (globalThis as { STORY_COMMIT?: unknown }).STORY_COMMIT;
	if (typeof injected === 'string' && injected !== '') {
		return injected;
	}
	return 'dev';
}

/** Semantic version resolved from `package.json` at module load. */
export const VERSION: string = readPackageVersion();

/** Build-time commit SHA, or `'dev'` when neither env var nor bundler define is set. */
export const COMMIT: string = readCommit();
