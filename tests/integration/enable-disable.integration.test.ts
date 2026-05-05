/**
 * Phase 10 integration smoke — `story enable` / `disable` / `configure`
 * command wiring. Complements the Phase 9.1-shipped cli.e2e.test.ts
 * (kept as-is) with coverage for flag combinations not exercised there.
 *
 * No Vogon dependency; every case spawns `bun run src/cli.ts` in a
 * TestEnv temp repo.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestEnv } from '../helpers/test-env';
import { runStoryCli } from './_helpers';

describe('integration: enable / disable / configure flag combos', () => {
	let env: TestEnv;

	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
	});

	afterEach(async () => {
		await env.cleanup();
	});

	// Phase 9.1 — `disable` without `--uninstall` keeps .story/logs/
	it('disable (no --uninstall) flips settings.enabled=false but keeps .story/', async () => {
		await runStoryCli(env.dir, ['enable', '--agent', 'vogon', '--local']);
		const res = await runStoryCli(env.dir, ['disable']);
		expect(res.code).toBe(0);

		// .story/ directory still present.
		const st = await fs.stat(path.join(env.dir, '.story'));
		expect(st.isDirectory()).toBe(true);

		// settings.local.json exists + enabled === false.
		const raw = await fs.readFile(path.join(env.dir, '.story', 'settings.local.json'), 'utf-8');
		expect(JSON.parse(raw).enabled).toBe(false);
	});

	// Phase 9.1 — `disable --uninstall` with no `--force` must refuse non-interactively.
	it('disable --uninstall without --force in CI → non-zero exit (destructive guard)', async () => {
		await runStoryCli(env.dir, ['enable', '--agent', 'vogon', '--local']);
		const res = await runStoryCli(env.dir, ['disable', '--uninstall']);
		expect(res.code, 'disable --uninstall needs --force in CI').not.toBe(0);
	});

	// Phase 9.1 — `configure --agent <unknown>` surfaces user-friendly error.
	it('configure --agent <unknown> → non-zero exit + actionable stderr/stdout', async () => {
		await runStoryCli(env.dir, ['enable', '--agent', 'vogon', '--local']);
		const res = await runStoryCli(env.dir, ['configure', '--agent', 'nope-not-real']);
		expect(res.code).not.toBe(0);
		// Accept either literal "unknown" or "not found" phrasing.
		expect(res.stderr + res.stdout).toMatch(/unknown|not found|no such agent/i);
	});

	// Phase 9.1 — `enable` on an already-enabled repo is idempotent.
	it('enable on an already-enabled repo → exit 0 (idempotent)', async () => {
		const first = await runStoryCli(env.dir, ['enable', '--agent', 'vogon', '--local']);
		expect(first.code).toBe(0);
		const second = await runStoryCli(env.dir, ['enable', '--agent', 'vogon', '--local']);
		expect(second.code, 'second enable should not fail').toBe(0);
	});

	// Phase 9.0 naming red line — installed hook scripts must contain `Story CLI hooks`.
	it('enable writes hook scripts tagged "Story CLI hooks" (naming red line)', async () => {
		await runStoryCli(env.dir, ['enable', '--agent', 'vogon', '--local']);
		for (const hook of [
			'prepare-commit-msg',
			'commit-msg',
			'post-commit',
			'post-rewrite',
			'pre-push',
		]) {
			const content = await fs.readFile(path.join(env.dir, '.git', 'hooks', hook), 'utf-8');
			expect(content, `${hook} should be tagged`).toContain('Story CLI hooks');
			// Negative: must NOT contain the Go-side brand.
			expect(content, `${hook} must not contain Entire CLI`).not.toContain('Entire CLI');
		}
	});

	// Phase 9.1 — `enable git-hook` is the minimal subcommand (no banner).
	it('enable git-hook installs hooks without banner', async () => {
		const res = await runStoryCli(env.dir, ['enable', 'git-hook']);
		expect(res.code).toBe(0);
		// 6-line STORY banner must NOT appear.
		expect(res.stdout).not.toMatch(/███████/);
		expect(res.stdout).toMatch(/Installed git hooks/);
	});
});
