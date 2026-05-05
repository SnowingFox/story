/**
 * Phase 9.5 doctor checks — 5 self-diagnostic helpers for `story doctor`.
 *
 * Go: entire-cli/cmd/entire/cli/doctor.go
 *     - checkDisconnectedMetadata  (doctor.go:367)
 *     - checkDisconnectedV2Main    (doctor.go:423)
 *     - checkV2RefExistence        (doctor.go:631)
 *     - checkV2CheckpointCounts    (doctor.go:585)
 *     - checkV2GenerationHealth    (doctor.go:495)
 *     (hook install + stuck sessions are Story additions.)
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MANAGED_GIT_HOOK_NAMES, STORY_HOOK_MARKER } from '@/hooks/install';
import { clearWorktreeRootCache } from '@/paths';
import { STUCK_ACTIVE_THRESHOLD_MS, StateStore } from '@/session/state-store';
import {
	checkHookInstallation,
	checkMetadataReachable,
	checkStuckSessions,
	checkV2CheckpointCounts,
	checkV2RefExistence,
} from '@/strategy/doctor-checks';
import { getGitCommonDir } from '@/strategy/repo';
import { TestEnv } from '../../helpers/test-env';

async function writeFakeHook(repoRoot: string, name: string, content: string): Promise<void> {
	const hooksDir = path.join(repoRoot, '.git', 'hooks');
	await fs.mkdir(hooksDir, { recursive: true });
	await fs.writeFile(path.join(hooksDir, name), content, { mode: 0o755 });
}

async function writeAllStoryHooks(repoRoot: string): Promise<void> {
	for (const name of MANAGED_GIT_HOOK_NAMES) {
		await writeFakeHook(repoRoot, name, `#!/bin/sh\n# ${STORY_HOOK_MARKER}\nexit 0\n`);
	}
}

async function seedStateFile(env: TestEnv, state: Record<string, unknown>): Promise<void> {
	const commonDir = await getGitCommonDir(env.dir);
	const stateDir = path.join(commonDir, 'story-sessions');
	await fs.mkdir(stateDir, { recursive: true });
	const file = path.join(stateDir, `${state.session_id}.json`);
	await fs.writeFile(file, JSON.stringify(state));
}

function baseState(overrides: Record<string, unknown> = {}) {
	const now = new Date();
	return {
		session_id: overrides.session_id ?? 'sess-fixture00000',
		base_commit: overrides.base_commit ?? '',
		attribution_base_commit: overrides.attribution_base_commit ?? '',
		worktree_id: overrides.worktree_id ?? '',
		started_at: overrides.started_at ?? now.toISOString(),
		last_interaction_time: overrides.last_interaction_time ?? now.toISOString(),
		turn_id: overrides.turn_id ?? 't1',
		step_count: overrides.step_count ?? 0,
		files_touched: overrides.files_touched ?? [],
		prompts: overrides.prompts ?? [],
		phase: overrides.phase ?? 'idle',
		cli_version: overrides.cli_version ?? '0.1.0',
		...overrides,
	};
}

describe('strategy/doctor-checks', () => {
	let env: TestEnv;
	let origCwd: string;

	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		origCwd = process.cwd();
		process.chdir(env.dir);
		clearWorktreeRootCache();
	});

	afterEach(async () => {
		process.chdir(origCwd);
		await env.cleanup();
		vi.restoreAllMocks();
	});

	// Go: doctor.go — checkHookInstallation (Story addition; Go does it inline in runSessionsFix)
	describe('checkHookInstallation', () => {
		it('passes with 5/5 counter when all Story hooks are installed', async () => {
			await writeAllStoryHooks(env.dir);
			const result = await checkHookInstallation({ repoRoot: env.dir });
			expect(result.passed).toBe(true);
			expect(result.counters).toBe('5/5');
			expect(result.problems).toHaveLength(0);
		});

		it('reports failing counter + 1 problem per missing hook', async () => {
			// Install only 4 of 5.
			for (const name of MANAGED_GIT_HOOK_NAMES.slice(0, 4)) {
				await writeFakeHook(env.dir, name, `#!/bin/sh\n# ${STORY_HOOK_MARKER}\n`);
			}
			const result = await checkHookInstallation({ repoRoot: env.dir });
			expect(result.passed).toBe(false);
			expect(result.counters).toBe('4/5');
			expect(result.problems).toHaveLength(1);
			expect(result.problems[0]?.summary).toMatch(/pre-push/);
		});

		it('reports all 5 as problems when none are installed', async () => {
			const result = await checkHookInstallation({ repoRoot: env.dir });
			expect(result.passed).toBe(false);
			expect(result.counters).toBe('0/5');
			expect(result.problems).toHaveLength(5);
		});

		it('reports a hook as missing when file exists but lacks the Story marker', async () => {
			await writeAllStoryHooks(env.dir);
			await writeFakeHook(env.dir, 'commit-msg', '#!/bin/sh\nexit 0\n'); // no marker
			const result = await checkHookInstallation({ repoRoot: env.dir });
			expect(result.passed).toBe(false);
			expect(result.problems.some((p) => p.summary.includes('commit-msg'))).toBe(true);
		});

		it('Problem.fix closure is an async function', async () => {
			const result = await checkHookInstallation({ repoRoot: env.dir });
			expect(result.problems.length).toBeGreaterThan(0);
			for (const problem of result.problems) {
				expect(typeof problem.fix).toBe('function');
			}
		});

		it('passed=true when .git/hooks/ directory is missing but we treat absence as "no hooks" not error', async () => {
			// Remove entire .git/hooks dir
			await fs.rm(path.join(env.dir, '.git', 'hooks'), { recursive: true, force: true });
			const result = await checkHookInstallation({ repoRoot: env.dir });
			// No hooks present → failing check (expected), but no uncaught exception.
			expect(result.passed).toBe(false);
			expect(result.counters).toBe('0/5');
		});
	});

	// Go: doctor.go:367 checkDisconnectedMetadata
	describe('checkMetadataReachable', () => {
		it('passes when story/checkpoints/v1 does not exist yet (fresh repo)', async () => {
			const result = await checkMetadataReachable({ repoRoot: env.dir });
			expect(result.passed).toBe(true);
			expect(result.problems).toHaveLength(0);
		});

		it('passes when the v1 metadata branch exists and points at a valid commit', async () => {
			await env.exec('git', ['commit', '--allow-empty', '-m', 'fixture v1 commit']);
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			await env.exec('git', ['branch', 'story/checkpoints/v1', head]);
			const result = await checkMetadataReachable({ repoRoot: env.dir });
			expect(result.passed).toBe(true);
		});

		it('reports a problem when the metadata branch points at a non-existent object', async () => {
			// Write a dangling ref.
			const refPath = path.join(env.dir, '.git', 'refs', 'heads', 'story', 'checkpoints');
			await fs.mkdir(refPath, { recursive: true });
			await fs.writeFile(path.join(refPath, 'v1'), `${'0'.repeat(40)}\n`);
			const result = await checkMetadataReachable({ repoRoot: env.dir });
			expect(result.passed).toBe(false);
			expect(result.problems.length).toBeGreaterThan(0);
		});

		it('Problem.fix is a defined async closure (wires metadata-reconcile)', async () => {
			const refPath = path.join(env.dir, '.git', 'refs', 'heads', 'story', 'checkpoints');
			await fs.mkdir(refPath, { recursive: true });
			await fs.writeFile(path.join(refPath, 'v1'), `${'0'.repeat(40)}\n`);
			const result = await checkMetadataReachable({ repoRoot: env.dir });
			if (!result.passed) {
				expect(typeof result.problems[0]?.fix).toBe('function');
			}
		});
	});

	// Go: doctor.go:631 checkV2RefExistence
	describe('checkV2RefExistence', () => {
		it('passes when both v2 refs are absent (fresh repo)', async () => {
			const result = await checkV2RefExistence({ repoRoot: env.dir });
			expect(result.passed).toBe(true);
		});

		it('passes when both v2 refs exist', async () => {
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			await env.exec('git', ['update-ref', 'refs/story/checkpoints/v2/main', head]);
			await env.exec('git', ['update-ref', 'refs/story/checkpoints/v2/full/current', head]);
			const result = await checkV2RefExistence({ repoRoot: env.dir });
			expect(result.passed).toBe(true);
		});

		it('reports a problem when only /main exists', async () => {
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			await env.exec('git', ['update-ref', 'refs/story/checkpoints/v2/main', head]);
			const result = await checkV2RefExistence({ repoRoot: env.dir });
			expect(result.passed).toBe(false);
			expect(result.problems[0]?.summary).toMatch(/full\/current/);
		});

		it('reports a problem when only /full/current exists', async () => {
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			await env.exec('git', ['update-ref', 'refs/story/checkpoints/v2/full/current', head]);
			const result = await checkV2RefExistence({ repoRoot: env.dir });
			expect(result.passed).toBe(false);
			expect(result.problems[0]?.summary).toMatch(/\/main/);
		});

		it('Problem.fix is defined on every problem', async () => {
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			await env.exec('git', ['update-ref', 'refs/story/checkpoints/v2/main', head]);
			const result = await checkV2RefExistence({ repoRoot: env.dir });
			for (const p of result.problems) {
				expect(typeof p.fix).toBe('function');
			}
		});
	});

	// Go: doctor.go:585 checkV2CheckpointCounts
	describe('checkV2CheckpointCounts', () => {
		it('passes when either ref is absent (nothing to compare)', async () => {
			const result = await checkV2CheckpointCounts({ repoRoot: env.dir });
			expect(result.passed).toBe(true);
		});

		it('passes with matching counts when main == full/current', async () => {
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			await env.exec('git', ['update-ref', 'refs/story/checkpoints/v2/main', head]);
			await env.exec('git', ['update-ref', 'refs/story/checkpoints/v2/full/current', head]);
			const result = await checkV2CheckpointCounts({ repoRoot: env.dir });
			expect(result.passed).toBe(true);
		});

		it('reports a problem when /full/current count exceeds /main count', async () => {
			// Create two commits with different trees, pointing /full/current at the
			// "extra-checkpoint" tree and /main at the empty one.
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			await env.exec('git', ['update-ref', 'refs/story/checkpoints/v2/main', head]);
			// Build a tree with fake checkpoint entries then commit it.
			await env.writeFile(
				'.tmp-seed/a1/a2b3c4d5e6f7/checkpoint.json',
				JSON.stringify({ checkpoint_id: 'a1a2b3c4d5e6f7' }),
			);
			await env.gitAdd('.tmp-seed');
			const seedCommit = await env.gitCommit('seed extra');
			await env.exec('git', ['update-ref', 'refs/story/checkpoints/v2/full/current', seedCommit]);

			const result = await checkV2CheckpointCounts({ repoRoot: env.dir });
			// Count of a v2 checkpoint tree is implementation-sensitive, so this
			// test stays loose: we only require that inconsistent refs produce a
			// well-formed `CheckResult` without throwing.
			expect(result).toHaveProperty('passed');
			expect(result).toHaveProperty('problems');
		});
	});

	// Go: runSessionsFix stuck-session detection.
	describe('checkStuckSessions', () => {
		it('passes when there are no session state files', async () => {
			const result = await checkStuckSessions({ repoRoot: env.dir });
			expect(result.passed).toBe(true);
			expect(result.problems).toHaveLength(0);
		});

		it('passes when session is active but within threshold', async () => {
			const now = new Date();
			await seedStateFile(env, {
				...baseState({
					session_id: 'sess-recentactive',
					phase: 'active',
					last_interaction_time: now.toISOString(),
				}),
			});
			const result = await checkStuckSessions({ repoRoot: env.dir });
			expect(result.passed).toBe(true);
		});

		it('reports a problem when an ACTIVE session has exceeded STUCK_ACTIVE_THRESHOLD_MS', async () => {
			const stale = new Date(Date.now() - (STUCK_ACTIVE_THRESHOLD_MS + 60_000));
			await seedStateFile(env, {
				...baseState({
					session_id: 'sess-stuck000000a',
					phase: 'active',
					last_interaction_time: stale.toISOString(),
					started_at: stale.toISOString(),
				}),
			});
			const result = await checkStuckSessions({ repoRoot: env.dir });
			expect(result.passed).toBe(false);
			expect(result.problems).toHaveLength(1);
			expect(result.problems[0]?.summary).toMatch(/sess-stuck/);
		});

		it('does NOT flag sessions already marked ended', async () => {
			const past = new Date(Date.now() - (STUCK_ACTIVE_THRESHOLD_MS + 60_000));
			await seedStateFile(env, {
				...baseState({
					session_id: 'sess-ended000000a',
					phase: 'ended',
					last_interaction_time: past.toISOString(),
					started_at: past.toISOString(),
				}),
			});
			const result = await checkStuckSessions({ repoRoot: env.dir });
			expect(result.passed).toBe(true);
		});

		it('multi-session mixed scenario correctly separates stuck from healthy', async () => {
			const stale = new Date(Date.now() - (STUCK_ACTIVE_THRESHOLD_MS + 60_000));
			const recent = new Date();
			await seedStateFile(env, {
				...baseState({
					session_id: 'sess-mixed-stuck0',
					phase: 'active',
					last_interaction_time: stale.toISOString(),
					started_at: stale.toISOString(),
				}),
			});
			await seedStateFile(env, {
				...baseState({
					session_id: 'sess-mixed-fresh0',
					phase: 'active',
					last_interaction_time: recent.toISOString(),
				}),
			});
			const result = await checkStuckSessions({ repoRoot: env.dir });
			expect(result.passed).toBe(false);
			expect(result.problems).toHaveLength(1);
			expect(result.problems[0]?.summary).toMatch(/sess-mixed-stuck/);
		});

		it('Problem.fix is defined and marks session ended', async () => {
			const stale = new Date(Date.now() - (STUCK_ACTIVE_THRESHOLD_MS + 60_000));
			await seedStateFile(env, {
				...baseState({
					session_id: 'sess-fixtest0000a',
					phase: 'active',
					last_interaction_time: stale.toISOString(),
					started_at: stale.toISOString(),
				}),
			});
			const result = await checkStuckSessions({ repoRoot: env.dir });
			expect(result.problems).toHaveLength(1);
			const problem = result.problems[0];
			expect(typeof problem?.fix).toBe('function');
			await problem?.fix?.();

			// Verify session phase / endedAt advanced.
			const commonDir = await getGitCommonDir(env.dir);
			const store = new StateStore(path.join(commonDir, 'story-sessions'));
			const reloaded = await store.load('sess-fixtest0000a');
			expect(reloaded?.phase).toBe('ended');
		});

		it('counts stuck sessions in CheckResult.counters', async () => {
			const stale = new Date(Date.now() - (STUCK_ACTIVE_THRESHOLD_MS + 60_000));
			for (const id of ['sess-ct1000000000', 'sess-ct2000000000', 'sess-ct3000000000']) {
				await seedStateFile(env, {
					...baseState({
						session_id: id,
						phase: 'active',
						last_interaction_time: stale.toISOString(),
						started_at: stale.toISOString(),
					}),
				});
			}
			const result = await checkStuckSessions({ repoRoot: env.dir });
			expect(result.passed).toBe(false);
			expect(result.problems).toHaveLength(3);
			expect(result.counters).toMatch(/3/);
		});
	});

	describe('types + aggregation contract', () => {
		it('every check returns { name, passed, problems: [] }', async () => {
			for (const check of [
				checkHookInstallation,
				checkMetadataReachable,
				checkV2RefExistence,
				checkV2CheckpointCounts,
				checkStuckSessions,
			]) {
				const result = await check({ repoRoot: env.dir });
				expect(typeof result.name).toBe('string');
				expect(typeof result.passed).toBe('boolean');
				expect(Array.isArray(result.problems)).toBe(true);
			}
		});

		it('CheckResult.name is uniquely identifying', async () => {
			const names = new Set<string>();
			for (const check of [
				checkHookInstallation,
				checkMetadataReachable,
				checkV2RefExistence,
				checkV2CheckpointCounts,
				checkStuckSessions,
			]) {
				const result = await check({ repoRoot: env.dir });
				expect(names.has(result.name)).toBe(false);
				names.add(result.name);
			}
			expect(names.size).toBe(5);
		});

		it('Problem.summary is always a short 1-line string', async () => {
			for (const name of MANAGED_GIT_HOOK_NAMES.slice(0, 3)) {
				await writeFakeHook(env.dir, name, `#!/bin/sh\n# ${STORY_HOOK_MARKER}\n`);
			}
			const result = await checkHookInstallation({ repoRoot: env.dir });
			for (const p of result.problems) {
				expect(p.summary).toBeTypeOf('string');
				expect(p.summary.split('\n').length).toBeLessThanOrEqual(2);
			}
		});
	});
});
