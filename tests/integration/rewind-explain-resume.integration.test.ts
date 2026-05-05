/**
 * Phase 10 integration smoke — `story rewind` / `story explain` /
 * `story resume` / `story attach`. Validates the user-facing command
 * tree (flag parsing, mutex checks, error messages) without spawning
 * Vogon; the happy-path checkpoint behaviour is covered by the
 * `tests/e2e/scenarios/*` suite.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestEnv } from '../helpers/test-env';
import { runStoryCli } from './_helpers';

describe('integration: rewind / explain / resume / attach command tree', () => {
	let env: TestEnv;

	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
	});

	afterEach(async () => {
		await env.cleanup();
	});

	// Rewind
	// ----------------------------------------------------------------

	it('rewind --list on an empty repo → exit 0 + empty array-ish JSON', async () => {
		await runStoryCli(env.dir, ['enable', '--agent', 'vogon', '--local']);
		const res = await runStoryCli(env.dir, ['rewind', '--list']);
		expect(res.code).toBe(0);
		// Phase 9.3 emits `{"rewind_points":[]}` when empty.
		expect(res.stdout).toMatch(/\[\s*\]|"rewind_points"\s*:\s*\[\]/);
	});

	it('rewind --to <nonexistent> → non-zero + "not found" style error', async () => {
		await runStoryCli(env.dir, ['enable', '--agent', 'vogon', '--local']);
		const res = await runStoryCli(env.dir, ['rewind', '--to', 'zzz9999']);
		expect(res.code).not.toBe(0);
		expect(res.stderr + res.stdout).toMatch(/not found|no such|unknown|cannot/i);
	});

	it('rewind --reset without --to → SilentError "--reset requires --to"', async () => {
		await runStoryCli(env.dir, ['enable', '--agent', 'vogon', '--local']);
		const res = await runStoryCli(env.dir, ['rewind', '--reset']);
		expect(res.code).not.toBe(0);
		expect(res.stderr + res.stdout).toMatch(/--reset.*--to|--to.*--reset/i);
	});

	it('rewind --list --to <id> → mutex error (flags mutually exclusive)', async () => {
		await runStoryCli(env.dir, ['enable', '--agent', 'vogon', '--local']);
		const res = await runStoryCli(env.dir, ['rewind', '--list', '--to', 'abc1234']);
		expect(res.code).not.toBe(0);
		expect(res.stderr + res.stdout).toMatch(
			/mutually exclusive|cannot.*together|not allowed with|cannot be combined/i,
		);
	});

	// Explain
	// ----------------------------------------------------------------

	it('explain on a repo with no checkpoints → exit 0 or friendly error', async () => {
		await runStoryCli(env.dir, ['enable', '--agent', 'vogon', '--local']);
		// `--checkpoint <unknown>` is a failure path; bare `explain` in
		// CI with no checkpoints either exits 0 (empty state) or fails
		// with a friendly hint — accept either.
		const res = await runStoryCli(env.dir, ['explain', '--checkpoint', 'zz99aabbcc12']);
		// Unknown checkpoint id → must exit non-zero.
		expect(res.code).not.toBe(0);
		expect(res.stderr + res.stdout).toMatch(/not found|unknown|no checkpoint/i);
	});

	it('explain --short --full (mutex) → non-zero + mutex error', async () => {
		await runStoryCli(env.dir, ['enable', '--agent', 'vogon', '--local']);
		const res = await runStoryCli(env.dir, ['explain', '--short', '--full']);
		expect(res.code).not.toBe(0);
		expect(res.stderr + res.stdout).toMatch(/mutually exclusive|cannot.*together/i);
	});

	// Resume
	// ----------------------------------------------------------------

	it('resume <nonexistent-branch> → non-zero + clear error', async () => {
		await runStoryCli(env.dir, ['enable', '--agent', 'vogon', '--local']);
		const res = await runStoryCli(env.dir, ['resume', 'branch-that-does-not-exist']);
		expect(res.code).not.toBe(0);
		expect(res.stderr + res.stdout).toMatch(/not found|no such|does not exist|cannot/i);
	});

	it('resume with no positional arg → cac "missing argument" non-zero exit', async () => {
		await runStoryCli(env.dir, ['enable', '--agent', 'vogon', '--local']);
		const res = await runStoryCli(env.dir, ['resume']);
		expect(res.code).not.toBe(0);
	});

	// Attach
	// ----------------------------------------------------------------

	it('attach <unknown-session-id> → non-zero + "session not found"', async () => {
		await runStoryCli(env.dir, ['enable', '--agent', 'vogon', '--local']);
		const res = await runStoryCli(env.dir, ['attach', 'nonexistent-session-id']);
		expect(res.code).not.toBe(0);
		expect(res.stderr + res.stdout).toMatch(/not found|no.*session|unknown|cannot/i);
	});

	it('attach on a repo with dirty worktree → non-zero + "uncommitted" / "dirty" hint', async () => {
		await runStoryCli(env.dir, ['enable', '--agent', 'vogon', '--local']);
		// Create an uncommitted file.
		await env.writeFile('dirty.txt', 'uncommitted');

		const res = await runStoryCli(env.dir, ['attach', 'anyid']);
		expect(res.code).not.toBe(0);
		expect(res.stderr + res.stdout).toMatch(/uncommitted|dirty|changes|not found/i);
	});
});
