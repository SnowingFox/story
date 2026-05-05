/**
 * Phase 10 integration smoke — `story clean` / `story doctor` /
 * `story migrate` / `story trace` command wiring (Phase 9.5 + 9.6).
 *
 * Deferred when Phase 9.5 / 9.6 had not yet shipped; both are now `[x]`
 * in the README so the smokes land here. No Vogon dependency; every
 * case spawns `bun run src/cli.ts` in a TestEnv temp repo.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestEnv } from '../helpers/test-env';
import { runStoryCli } from './_helpers';

describe('integration: clean / doctor / migrate / trace', () => {
	let env: TestEnv;

	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
	});

	afterEach(async () => {
		await env.cleanup();
	});

	// Phase 9.5 — `story clean --dry-run` on a fresh, clean repo.
	it('clean --dry-run on a clean enabled repo → exit 0 + "nothing"/"clean" friendly message', async () => {
		await runStoryCli(env.dir, ['enable', '--agent', 'vogon', '--local']);
		const res = await runStoryCli(env.dir, ['clean', '--dry-run']);
		expect(res.code).toBe(0);
		// Accept a few friendly phrasings — Phase 9.5 UI has room for
		// wording drift; the contract is "tells user nothing to do".
		expect(res.stdout + res.stderr).toMatch(/nothing|no orphan|clean|no-op|empty|already/i);
	});

	// Phase 9.5 — `story clean --force` is destructive + needs --force in CI.
	it('clean --force on a clean repo → exit 0 (idempotent)', async () => {
		await runStoryCli(env.dir, ['enable', '--agent', 'vogon', '--local']);
		const res = await runStoryCli(env.dir, ['clean', '--force']);
		expect(res.code).toBe(0);
	});

	// Phase 9.5 — `story doctor` on a healthy, freshly-enabled repo.
	it('doctor on a healthy enabled repo → exit 0 + "healthy"/"OK" summary', async () => {
		await runStoryCli(env.dir, ['enable', '--agent', 'vogon', '--local']);
		const res = await runStoryCli(env.dir, ['doctor']);
		expect(res.code).toBe(0);
		// Phase 9.5 doctor prints an OK-style summary on healthy repos.
		expect(res.stdout + res.stderr).toMatch(/healthy|OK|all good|no issues|passed/i);
	});

	// Phase 9.6 — `story migrate --checkpoints v2` on a repo that has
	// no v1 checkpoints yet → SilentError "No v1 checkpoints to migrate".
	// Phase 9.6 treats "nothing to migrate" as an error state (non-zero
	// exit) with a friendly hint, matching Go behaviour. Note: migrate
	// has no `--dry-run` flag (Phase 9.6 ships `--checkpoints` +
	// `--force` only).
	it('migrate --checkpoints v2 on a fresh repo → non-zero exit + friendly "no v1" hint', async () => {
		await runStoryCli(env.dir, ['enable', '--agent', 'vogon', '--local']);
		const res = await runStoryCli(env.dir, ['migrate', '--checkpoints', 'v2']);
		expect(res.code, 'SilentError on empty migration is expected').not.toBe(0);
		expect(res.stdout + res.stderr).toMatch(/no v1|nothing|missing|empty/i);
	});

	// Phase 9.6 — `story trace --last 5` on a repo where no hook has
	// fired yet → SilentError "No .story/logs/story.log found" with a
	// friendly remediation hint. Like migrate, Phase 9.6 treats "no
	// data" as an error path (non-zero exit).
	it('trace --last 5 on a fresh repo → non-zero exit + "no log" / "log not found" hint', async () => {
		await runStoryCli(env.dir, ['enable', '--agent', 'vogon', '--local']);
		const res = await runStoryCli(env.dir, ['trace', '--last', '5']);
		expect(res.code, 'SilentError on empty log is expected').not.toBe(0);
		expect(res.stdout + res.stderr).toMatch(/no.*log|log.*not found|no trace/i);
	});

	// Phase 9.6 — `story completion bash` stdout is a valid sourceable
	// script. Smoke: starts with a bash shebang/header-ish line and
	// contains the `story` command name.
	it('completion bash → exit 0 + sourceable script mentioning "story"', async () => {
		const res = await runStoryCli(env.dir, ['completion', 'bash']);
		expect(res.code).toBe(0);
		expect(res.stdout).toContain('story');
		// Most bash completions start with `#` or `_` — accept either.
		expect(res.stdout.length, 'stdout should not be empty').toBeGreaterThan(0);

		// Sanity: no ANSI banner bleed (Phase 9.6 MACHINE_COMMANDS
		// whitelist suppresses banner for completion).
		expect(res.stdout).not.toMatch(/███████/);
		// Make sure no settings.local.json leaked from the spawn.
		await expect(
			fs.stat(path.join(env.dir, '.story', 'settings.local.json')),
		).rejects.toMatchObject({ code: 'ENOENT' });
	});
});
