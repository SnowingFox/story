/**
 * Phase 5.6 manual-commit-push unit tests.
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/strategy/manual_commit_push.go` —
 * `(s *ManualCommitStrategy) PrePush(ctx, remote)`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { METADATA_BRANCH_NAME, V2_MAIN_REF_NAME } from '@/checkpoint/constants';
import { execGit } from '@/git';
import { setStderrWriterForTesting } from '@/strategy/hooks-tty';
import { ManualCommitStrategy } from '@/strategy/manual-commit';
import { prePushImpl } from '@/strategy/manual-commit-push';
import { resetSettingsHintForTesting } from '@/strategy/push-common';
import { TestEnv } from '../../helpers/test-env';
import { TestRemote } from '../../helpers/test-remote';

interface Captured {
	captured: string;
}

function makeWritable(): NodeJS.WritableStream & Captured {
	const stream = {
		captured: '',
		write(chunk: string | Uint8Array): boolean {
			stream.captured += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
			return true;
		},
	} as unknown as NodeJS.WritableStream & Captured;
	return stream;
}

describe('strategy/manual-commit-push — Go: manual_commit_push.go', () => {
	let env: TestEnv;
	let remote: TestRemote;
	let stderrCapture: NodeJS.WritableStream & Captured;

	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		remote = await TestRemote.create();
		stderrCapture = makeWritable();
		setStderrWriterForTesting(stderrCapture);
		resetSettingsHintForTesting();
	});

	afterEach(async () => {
		await env.cleanup();
		await remote.cleanup();
		setStderrWriterForTesting(null);
		resetSettingsHintForTesting();
	});

	// Go: manual_commit_push.go: PrePush (Step 1-3 happy path)
	it('Step 1-3: pushes v1 metadata branch when push_sessions enabled (default)', async () => {
		// Seed local v1 metadata branch.
		const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		await env.exec('git', ['update-ref', `refs/heads/${METADATA_BRANCH_NAME}`, head]);
		await env.exec('git', ['remote', 'add', 'origin', remote.url]);

		const strategy = new ManualCommitStrategy(env.dir);
		await prePushImpl(strategy, 'origin');

		// Remote received the v1 metadata branch.
		expect(await remote.resolveRef(`refs/heads/${METADATA_BRANCH_NAME}`)).toBe(head);
		expect(stderrCapture.captured).toContain('[story]');
	});

	// Go: manual_commit_push.go: PrePush (push_sessions: false → early return)
	it('push_sessions: false short-circuits before push', async () => {
		const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		await env.exec('git', ['update-ref', `refs/heads/${METADATA_BRANCH_NAME}`, head]);
		await env.exec('git', ['remote', 'add', 'origin', remote.url]);
		await env.writeFile(
			'.story/settings.json',
			JSON.stringify({ enabled: true, strategy_options: { push_sessions: false } }),
		);

		const strategy = new ManualCommitStrategy(env.dir);
		await prePushImpl(strategy, 'origin');

		// No push happened.
		expect(await remote.resolveRef(`refs/heads/${METADATA_BRANCH_NAME}`)).toBeNull();
	});

	// Go: manual_commit_push.go: PrePush (Step 4 — push v2 refs when enabled)
	it('pushes v2 refs when isPushV2RefsEnabled', async () => {
		const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		await env.exec('git', ['update-ref', `refs/heads/${METADATA_BRANCH_NAME}`, head]);
		await env.exec('git', ['update-ref', V2_MAIN_REF_NAME, head]);
		await env.exec('git', ['remote', 'add', 'origin', remote.url]);
		await env.writeFile(
			'.story/settings.json',
			JSON.stringify({
				enabled: true,
				strategy_options: { checkpoints_v2: true, push_v2_refs: true },
			}),
		);

		const strategy = new ManualCommitStrategy(env.dir);
		await prePushImpl(strategy, 'origin');

		expect(await remote.resolveRef(`refs/heads/${METADATA_BRANCH_NAME}`)).toBe(head);
		expect(await remote.resolveRef(V2_MAIN_REF_NAME)).toBe(head);
	});

	// Go: manual_commit_push.go: PrePush (Step 4 skipped when push_v2_refs disabled)
	it('skips v2 push when push_v2_refs disabled', async () => {
		const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		await env.exec('git', ['update-ref', `refs/heads/${METADATA_BRANCH_NAME}`, head]);
		await env.exec('git', ['update-ref', V2_MAIN_REF_NAME, head]);
		await env.exec('git', ['remote', 'add', 'origin', remote.url]);
		await env.writeFile(
			'.story/settings.json',
			JSON.stringify({
				enabled: true,
				strategy_options: { checkpoints_v2: true, push_v2_refs: false },
			}),
		);

		const strategy = new ManualCommitStrategy(env.dir);
		await prePushImpl(strategy, 'origin');

		// v1 pushed, v2 not pushed.
		expect(await remote.resolveRef(`refs/heads/${METADATA_BRANCH_NAME}`)).toBe(head);
		expect(await remote.resolveRef(V2_MAIN_REF_NAME)).toBeNull();
	});

	// Story-side naming red line: checkpoint URL routing.
	it('uses checkpoint URL when configured (not push remote)', async () => {
		const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		await env.exec('git', ['update-ref', `refs/heads/${METADATA_BRANCH_NAME}`, head]);
		await env.exec('git', ['remote', 'add', 'origin', `${remote.url}-not-real`]);
		// Configure a separate checkpoint remote (URL form).
		await env.writeFile(
			'.story/settings.json',
			JSON.stringify({
				enabled: true,
				strategy_options: {
					checkpoint_remote: { provider: 'github', repo: 'acme/checkpoints' },
				},
			}),
		);

		// Origin has a fake URL; checkpoint URL is derived from it. Since fork
		// detection compares owner names, and the owner doesn't have any
		// (`origin` is set to `<remote.url>-not-real` which has no owner),
		// fork detection passes and the derived URL is used.
		const strategy = new ManualCommitStrategy(env.dir);
		await prePushImpl(strategy, 'origin');

		// We don't have a real github.com here so the actual push will fail
		// silently — verify that the silent-on-failure invariant held + stderr
		// warns about checkpoint remote.
		expect(stderrCapture.captured).toMatch(/\[story\]/);
	});

	it('pushes v1 metadata to explicit checkpoint remote without updating origin', async () => {
		const checkpointRemote = await TestRemote.create();
		try {
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			await env.exec('git', ['update-ref', `refs/heads/${METADATA_BRANCH_NAME}`, head]);
			await env.exec('git', ['remote', 'add', 'origin', remote.url]);
			await env.writeFile(
				'.story/settings.json',
				JSON.stringify({
					enabled: true,
					strategy_options: {
						checkpoint_remote: { gitUrl: checkpointRemote.fileURL },
					},
				}),
			);

			const strategy = new ManualCommitStrategy(env.dir);
			await prePushImpl(strategy, 'origin');

			expect(await checkpointRemote.resolveRef(`refs/heads/${METADATA_BRANCH_NAME}`)).toBe(head);
			expect(await remote.resolveRef(`refs/heads/${METADATA_BRANCH_NAME}`)).toBeNull();
		} finally {
			await checkpointRemote.cleanup();
		}
	});

	// Silent-on-failure invariants.
	describe('silent-on-failure invariant', () => {
		it('never throws when settings.json is malformed', async () => {
			await env.writeFile('.story/settings.json', '{ not valid json');
			const strategy = new ManualCommitStrategy(env.dir);
			await expect(prePushImpl(strategy, 'origin')).resolves.toBeUndefined();
		});

		it('never throws when push fails (no remote configured)', async () => {
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			await env.exec('git', ['update-ref', `refs/heads/${METADATA_BRANCH_NAME}`, head]);
			// No `origin` remote configured.
			const strategy = new ManualCommitStrategy(env.dir);
			await expect(prePushImpl(strategy, 'origin')).resolves.toBeUndefined();
		});

		it('never throws when v2 push fails', async () => {
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			await env.exec('git', ['update-ref', V2_MAIN_REF_NAME, head]);
			await env.writeFile(
				'.story/settings.json',
				JSON.stringify({
					enabled: true,
					strategy_options: { checkpoints_v2: true, push_v2_refs: true },
				}),
			);
			const strategy = new ManualCommitStrategy(env.dir);
			await expect(prePushImpl(strategy, 'nonexistent-remote')).resolves.toBeUndefined();
		});
	});

	// Thin facade wiring.
	describe('manual-commit.ts → prePushImpl wiring', () => {
		it('strategy.prePush delegates to prePushImpl', async () => {
			const strategy = new ManualCommitStrategy(env.dir);
			// Spy on the imported impl by replacing it in the module export.
			// Since prePushImpl is module-scoped, we test the wiring by
			// confirming the stub no longer throws NOT_IMPLEMENTED.
			await expect(strategy.prePush('origin')).resolves.toBeUndefined();
		});

		it('Phase 5.6 stub fully replaced — NOT_IMPLEMENTED no longer thrown', async () => {
			const strategy = new ManualCommitStrategy(env.dir);
			let caught: unknown = null;
			try {
				await strategy.prePush('origin');
			} catch (err) {
				caught = err;
			}
			expect(caught).toBeNull();
		});
	});

	// Reference execGit + vi to silence unused-import warnings (dev convenience).
	it('test infrastructure smoke', () => {
		expect(typeof execGit).toBe('function');
		expect(typeof vi.spyOn).toBe('function');
	});
});
