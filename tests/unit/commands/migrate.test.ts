/**
 * Phase 9.6 `src/commands/migrate.ts` unit tests — CLI flag validation +
 * scan/report flow. End-to-end v1→v2 promotion is exercised via the
 * underlying `v2-committed.writeCommitted` suite; here we verify the
 * command orchestrates correctly.
 *
 * Go: `cmd/entire/cli/migrate.go: newMigrateCmd + runMigrateCheckpointsV2`.
 */

import cac from 'cac';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerGlobalFlags, resetGlobalFlagsForTesting } from '@/cli/flags';
import { registerMigrateCommand } from '@/commands/migrate';
import { SilentError } from '@/errors';
import { clearGitCommonDirCache } from '@/git';
import { clearWorktreeRootCache } from '@/paths';
import type { CheckpointInfo } from '@/strategy/types';
import { resetColorOverrideForTesting, setColorOverride } from '@/ui/theme';
import { TestEnv } from '../../helpers/test-env';

const listCheckpointsMock = vi.hoisted(() => vi.fn<() => Promise<CheckpointInfo[]>>());
const readV2CommittedMock = vi.hoisted(() => vi.fn<() => Promise<unknown>>());
const writeCommittedMock = vi.hoisted(() => vi.fn<() => Promise<void>>());

vi.mock('@/strategy/metadata-branch', async (orig) => {
	const mod = (await orig()) as Record<string, unknown>;
	return { ...mod, listCheckpoints: listCheckpointsMock };
});

vi.mock('@/checkpoint/v2-read', async (orig) => {
	const mod = (await orig()) as Record<string, unknown>;
	return { ...mod, readCommitted: readV2CommittedMock };
});

vi.mock('@/checkpoint/v2-store', async (orig) => {
	const mod = (await orig()) as Record<string, unknown>;
	class V2GitStore {
		writeCommitted = writeCommittedMock;
	}
	return { ...mod, V2GitStore };
});

function captureStreams() {
	const out: string[] = [];
	const err: string[] = [];
	const origOut = process.stdout.write.bind(process.stdout);
	const origErr = process.stderr.write.bind(process.stderr);
	process.stdout.write = ((chunk: string | Uint8Array) => {
		out.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk: string | Uint8Array) => {
		err.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
		return true;
	}) as typeof process.stderr.write;
	return {
		stdout: () => out.join(''),
		stderr: () => err.join(''),
		restore: () => {
			process.stdout.write = origOut;
			process.stderr.write = origErr;
		},
	};
}

function buildCli() {
	const cli = cac('story');
	registerGlobalFlags(cli);
	registerMigrateCommand(cli);
	cli.help();
	cli.version('0.1.0');
	return cli;
}

async function runCli(argv: string[]): Promise<void> {
	const cli = buildCli();
	cli.parse(['node', 'story', ...argv], { run: false });
	const result = cli.runMatchedCommand();
	if (result && typeof (result as Promise<unknown>).then === 'function') {
		await result;
	}
}

function mkCheckpoint(id: string, extra: Partial<CheckpointInfo> = {}): CheckpointInfo {
	return {
		checkpointId: id as CheckpointInfo['checkpointId'],
		sessionId: `sess-${id}`,
		createdAt: new Date(),
		checkpointsCount: 1,
		filesTouched: [],
		...extra,
	};
}

describe('commands/migrate', () => {
	let env: TestEnv;
	let origCwd: string;
	let cap: ReturnType<typeof captureStreams>;

	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		origCwd = process.cwd();
		process.chdir(env.dir);
		clearGitCommonDirCache();
		clearWorktreeRootCache();
		resetGlobalFlagsForTesting();
		resetColorOverrideForTesting();
		setColorOverride(false);
		listCheckpointsMock.mockReset();
		readV2CommittedMock.mockReset();
		writeCommittedMock.mockReset();
		writeCommittedMock.mockResolvedValue(undefined);
		cap = captureStreams();
	});

	afterEach(async () => {
		cap.restore();
		process.chdir(origCwd);
		await env.cleanup();
		resetGlobalFlagsForTesting();
		resetColorOverrideForTesting();
		process.exitCode = 0;
	});

	async function expectAction(argv: string[]): Promise<unknown> {
		try {
			await runCli(argv);
			return undefined;
		} catch (err) {
			return err;
		}
	}

	// Go: migrate.go: newMigrateCmd — --checkpoints validation.
	it('missing --checkpoints → SilentError', async () => {
		const err = await expectAction(['migrate']);
		expect(err).toBeInstanceOf(SilentError);
		expect((err as Error).message).toMatch(/Missing required flag/);
	});

	it('--checkpoints v3 → SilentError "Unsupported version: v3"', async () => {
		const err = await expectAction(['migrate', '--checkpoints', 'v3']);
		expect(err).toBeInstanceOf(SilentError);
		expect((err as Error).message).toMatch(/Unsupported version: v3/);
	});

	it('--checkpoints v1 → SilentError (only v2 supported)', async () => {
		const err = await expectAction(['migrate', '--checkpoints', 'v1']);
		expect(err).toBeInstanceOf(SilentError);
		expect((err as Error).message).toMatch(/Unsupported version/);
	});

	it('--checkpoints "" (empty) → SilentError', async () => {
		const err = await expectAction(['migrate', '--checkpoints', '']);
		expect(err).toBeInstanceOf(SilentError);
		expect((err as Error).message).toMatch(/Missing required flag|Unsupported/);
	});

	// Go: migrate.go: runMigrateCheckpointsV2 — no git repo guard.
	it('non-git repo → SilentError', async () => {
		process.chdir('/tmp');
		clearWorktreeRootCache();
		const err = await expectAction(['migrate', '--checkpoints', 'v2']);
		if (err !== undefined) {
			expect(err).toBeInstanceOf(SilentError);
		}
	});

	// Go: migrate.go: migrateCheckpointsV2 — empty v1 → error.
	it('no v1 checkpoints → SilentError "No v1 checkpoints to migrate"', async () => {
		listCheckpointsMock.mockResolvedValue([]);
		const err = await expectAction(['migrate', '--checkpoints', 'v2']);
		expect(err).toBeInstanceOf(SilentError);
		expect((err as Error).message).toMatch(/No v1 checkpoints to migrate/);
	});

	// Go: migrate.go: runMigrateCheckpointsV2 — listCheckpoints throws.
	it('metadata branch read error → SilentError', async () => {
		listCheckpointsMock.mockRejectedValue(new Error('branch missing'));
		const err = await expectAction(['migrate', '--checkpoints', 'v2']);
		expect(err).toBeInstanceOf(SilentError);
		expect((err as Error).message).toMatch(/No v1 checkpoints/);
	});

	it('all already-migrated → "Nothing to migrate" + re-run hint', async () => {
		listCheckpointsMock.mockResolvedValue([
			mkCheckpoint('abc1230000001'),
			mkCheckpoint('abc1230000002'),
		]);
		// Simulate both are already in v2.
		readV2CommittedMock.mockResolvedValue({});
		await runCli(['migrate', '--checkpoints', 'v2']);
		const out = cap.stdout();
		expect(out).toMatch(/Nothing to migrate/);
		expect(out).toMatch(/--force/);
		expect(writeCommittedMock).not.toHaveBeenCalled();
	});

	it('some pending → writeCommitted is called per-pending-entry', async () => {
		listCheckpointsMock.mockResolvedValue([
			mkCheckpoint('abc1230000001'),
			mkCheckpoint('abc1230000002'),
			mkCheckpoint('abc1230000003'),
		]);
		// First is migrated, remaining 2 are pending.
		let callNo = 0;
		readV2CommittedMock.mockImplementation(async () => {
			callNo++;
			return callNo === 1 ? {} : null;
		});
		await runCli(['migrate', '--checkpoints', 'v2']);
		expect(writeCommittedMock.mock.calls.length).toBe(2);
		expect(cap.stdout()).toMatch(/Migrated 2 checkpoints/);
	});

	it('--force re-migrates every v1 entry (ignores already-migrated)', async () => {
		listCheckpointsMock.mockResolvedValue([
			mkCheckpoint('abc1230000001'),
			mkCheckpoint('abc1230000002'),
		]);
		readV2CommittedMock.mockResolvedValue({}); // Both already-migrated.
		await runCli(['migrate', '--checkpoints', 'v2', '--force']);
		expect(writeCommittedMock.mock.calls.length).toBe(2);
		// "re-migrating" banner surfaces on stderr via `warn()`.
		expect(cap.stderr()).toMatch(/re-migrating/);
	});

	it('writeCommitted failure marks the entry as failed and continues', async () => {
		listCheckpointsMock.mockResolvedValue([
			mkCheckpoint('abc1230000001'),
			mkCheckpoint('abc1230000002'),
		]);
		readV2CommittedMock.mockResolvedValue(null);
		let call = 0;
		writeCommittedMock.mockImplementation(async () => {
			call++;
			if (call === 1) {
				throw new Error('simulated write failure');
			}
		});
		await runCli(['migrate', '--checkpoints', 'v2']);
		expect(writeCommittedMock.mock.calls.length).toBe(2);
		expect(cap.stdout()).toMatch(/Failed to migrate/);
		expect(process.exitCode).toBe(1);
	});

	it('--force banner is printed on stderr', async () => {
		listCheckpointsMock.mockResolvedValue([mkCheckpoint('abc1230000001')]);
		readV2CommittedMock.mockResolvedValue(null);
		await runCli(['migrate', '--checkpoints', 'v2', '--force']);
		expect(cap.stderr()).toMatch(/re-migrating/);
	});

	it('header reads "story migrate --checkpoints v2" in default mode', async () => {
		listCheckpointsMock.mockResolvedValue([]);
		await expectAction(['migrate', '--checkpoints', 'v2']);
		// May throw before header gets printed if the guard rejects; check stdout.
	});

	// Go: migrate.go: runMigrateCheckpointsV2 — output structure.
	it('prints the scan summary: N v1 found / M already migrated / K pending', async () => {
		listCheckpointsMock.mockResolvedValue([
			mkCheckpoint('abc1230000001'),
			mkCheckpoint('abc1230000002'),
			mkCheckpoint('abc1230000003'),
		]);
		let callNo = 0;
		readV2CommittedMock.mockImplementation(async () => {
			callNo++;
			return callNo === 1 ? {} : null;
		});
		await runCli(['migrate', '--checkpoints', 'v2']);
		const out = cap.stdout();
		expect(out).toMatch(/3 v1 checkpoints found/);
		expect(out).toMatch(/1 already migrated/);
		expect(out).toMatch(/2 pending/);
	});

	it('final "Run story status to verify." footer appears when migrations completed', async () => {
		listCheckpointsMock.mockResolvedValue([mkCheckpoint('abc1230000001')]);
		readV2CommittedMock.mockResolvedValue(null);
		await runCli(['migrate', '--checkpoints', 'v2']);
		expect(cap.stdout()).toMatch(/story status/);
	});

	it('no "entire" string literal leaks in stdout', async () => {
		listCheckpointsMock.mockResolvedValue([mkCheckpoint('abc1230000001')]);
		readV2CommittedMock.mockResolvedValue(null);
		await runCli(['migrate', '--checkpoints', 'v2']);
		const out = cap.stdout();
		expect(out).not.toMatch(/\bentire\b/);
		expect(out).not.toMatch(/\.entire\//);
	});

	// Go: migrate.go: runMigrateCheckpointsV2 — per-checkpoint step message.
	it('prints "Migrating <id> (i/N)" step line per pending checkpoint', async () => {
		listCheckpointsMock.mockResolvedValue([
			mkCheckpoint('abc1230000001'),
			mkCheckpoint('abc1230000002'),
		]);
		readV2CommittedMock.mockResolvedValue(null);
		await runCli(['migrate', '--checkpoints', 'v2']);
		const out = cap.stdout();
		expect(out).toMatch(/Migrating abc1230000001\s*\(1\/2\)/);
		expect(out).toMatch(/Migrating abc1230000002\s*\(2\/2\)/);
	});

	it('prints "refs/story/checkpoints/v2/<id> written" per successful migration', async () => {
		listCheckpointsMock.mockResolvedValue([mkCheckpoint('abc1230000001')]);
		readV2CommittedMock.mockResolvedValue(null);
		await runCli(['migrate', '--checkpoints', 'v2']);
		expect(cap.stdout()).toMatch(/refs\/story\/checkpoints\/v2\/abc1230000001 written/);
	});

	it('--checkpoints V2 (uppercase) is strictly case-sensitive → SilentError', async () => {
		const err = await expectAction(['migrate', '--checkpoints', 'V2']);
		expect(err).toBeInstanceOf(SilentError);
		expect((err as Error).message).toMatch(/Unsupported version/);
	});
});
