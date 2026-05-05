/**
 * Phase 10 integration smoke — `story status` / `story sessions`.
 * Covers basic happy-path output + `--json` contract + unknown-session
 * error. No Vogon dependency.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestEnv } from '../helpers/test-env';
import { runStoryCli } from './_helpers';

describe('integration: status / sessions', () => {
	let env: TestEnv;

	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
	});

	afterEach(async () => {
		await env.cleanup();
	});

	it('status on a fresh repo (not enabled) → exit 0 + friendly "Not set up"', async () => {
		const res = await runStoryCli(env.dir, ['status']);
		expect(res.code).toBe(0);
		expect(res.stdout).toMatch(/not set up|not enabled|disabled|○/i);
	});

	it('status on an enabled repo → shows compact enabled state', async () => {
		await runStoryCli(env.dir, ['enable', '--agent', 'vogon', '--local']);
		const res = await runStoryCli(env.dir, ['status']);
		expect(res.code).toBe(0);
		expect(res.stdout).toMatch(/enabled/i);
		expect(res.stdout).toMatch(/Active Sessions/);
	});

	it('status --json emits parseable JSON with enabled key', async () => {
		await runStoryCli(env.dir, ['enable', '--agent', 'vogon', '--local']);
		const res = await runStoryCli(env.dir, ['status', '--json']);
		expect(res.code).toBe(0);
		// `--json` mode should bypass banner/bar UI — stdout IS the JSON.
		const parsed = JSON.parse(res.stdout.trim()) as { enabled?: boolean };
		expect(parsed.enabled).toBeDefined();
	});

	it('status pagination flags are accepted and surfaced in --json metadata', async () => {
		await runStoryCli(env.dir, ['enable', '--agent', 'vogon', '--local']);
		const res = await runStoryCli(env.dir, ['status', '--json', '--limit', '2', '--offset', '0']);
		expect(res.code).toBe(0);
		const parsed = JSON.parse(res.stdout.trim()) as {
			pagination?: { total?: number; limit?: number; offset?: number; nextOffset?: number | null };
		};
		expect(parsed.pagination).toMatchObject({
			total: 0,
			limit: 2,
			offset: 0,
			nextOffset: null,
		});

		const allRes = await runStoryCli(env.dir, ['status', '--all']);
		expect(allRes.code).toBe(0);
		expect(allRes.stdout).toMatch(/Active Sessions/);
	});

	it('sessions list on empty repo → exit 0 + friendly empty-state message', async () => {
		await runStoryCli(env.dir, ['enable', '--agent', 'vogon', '--local']);
		const res = await runStoryCli(env.dir, ['sessions', 'list']);
		expect(res.code).toBe(0);
		expect(res.stdout).toMatch(/No active sessions|no sessions|empty/i);
	});

	it('sessions info <unknown-prefix> → non-zero + hints session-not-found', async () => {
		await runStoryCli(env.dir, ['enable', '--agent', 'vogon', '--local']);
		const res = await runStoryCli(env.dir, ['sessions', 'info', 'zz99nope']);
		expect(res.code).not.toBe(0);
		expect(res.stderr + res.stdout).toMatch(/no session|not found|unknown|does not exist/i);
	});

	it('sessions stop --all on empty repo → exit 0 (nothing to do)', async () => {
		await runStoryCli(env.dir, ['enable', '--agent', 'vogon', '--local']);
		const res = await runStoryCli(env.dir, ['sessions', 'stop', '--all', '--force']);
		expect(res.code).toBe(0);
	});
});
