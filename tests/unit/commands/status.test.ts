/**
 * Phase 9.2 `src/commands/status.ts` unit tests.
 *
 * Go: status.go: newStatusCmd (status snapshot command).
 *
 * Mock strategy: real TestEnv fs + settings files, mocked `findActiveSessions`
 * (so we don't need to wire a full session-state suite here) + mocked
 * `getByAgentType` for registry.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import cac from 'cac';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerGlobalFlags, resetGlobalFlagsForTesting } from '@/cli/flags';
import { setForceNonInteractive } from '@/cli/tty';
import { registerStatusCommand } from '@/commands/status';
import { SilentError } from '@/errors';
import { resetColorOverrideForTesting, setColorOverride } from '@/ui/theme';
import { assertCwdIsNotStoryRepo, TestEnv } from '../../helpers/test-env';

vi.mock('@/commands/_shared/session-list', () => ({
	findActiveSessions: vi.fn().mockResolvedValue([]),
}));
vi.mock('@/strategy/metadata-branch', () => ({
	getMetadataBranchTree: vi.fn().mockResolvedValue(null),
}));

function silenceStdio(): {
	stdout: string[];
	stderr: string[];
	restore: () => void;
} {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const origStdout = process.stdout.write.bind(process.stdout);
	const origStderr = process.stderr.write.bind(process.stderr);
	process.stdout.write = ((chunk: string | Uint8Array): boolean => {
		stdout.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk: string | Uint8Array): boolean => {
		stderr.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
		return true;
	}) as typeof process.stderr.write;
	return {
		stdout,
		stderr,
		restore: () => {
			process.stdout.write = origStdout;
			process.stderr.write = origStderr;
		},
	};
}

function buildCli(): ReturnType<typeof cac> {
	const cli = cac('story');
	registerGlobalFlags(cli);
	registerStatusCommand(cli);
	return cli;
}

async function runCli(cli: ReturnType<typeof cac>, argv: string[]): Promise<void> {
	cli.parse(['node', 'story', ...argv], { run: false });
	const result = cli.runMatchedCommand();
	if (result && typeof (result as Promise<unknown>).then === 'function') {
		await result;
	}
}

async function setActive(
	ids: Array<{
		id: string;
		agentType?: string;
		model?: string;
		lastPrompt?: string;
		lastInteractionTime?: string;
		isStuckActive?: boolean;
		tokens?: { input: number; output: number; turns: number };
		filesChanged?: number;
		lastCheckpointId?: string;
		lastCheckpointAt?: string;
	}>,
): Promise<void> {
	const mod = await import('@/commands/_shared/session-list');
	(mod.findActiveSessions as ReturnType<typeof vi.fn>).mockResolvedValue(
		ids.map((x) => ({
			id: x.id,
			agentType: x.agentType ?? 'Claude Code',
			agentDescription: '',
			agentIsPreview: false,
			model: x.model,
			status: 'active' as const,
			startedAt: new Date().toISOString(),
			endedAt: undefined,
			lastPrompt: x.lastPrompt,
			lastInteractionTime: x.lastInteractionTime,
			isStuckActive: x.isStuckActive ?? false,
			worktree: '',
			branch: undefined,
			tokens: x.tokens ?? { input: 0, output: 0, turns: 0 },
			checkpointCount: 0,
			filesChanged: x.filesChanged ?? 0,
			lastCheckpointId: x.lastCheckpointId,
			lastCheckpointAt: x.lastCheckpointAt,
		})),
	);
}

async function setMetadataBranchHash(value: string | null): Promise<void> {
	const mod = await import('@/strategy/metadata-branch');
	(mod.getMetadataBranchTree as ReturnType<typeof vi.fn>).mockResolvedValue(value);
}

describe('commands/status', () => {
	let env: TestEnv;
	let origCwd: string;

	beforeEach(async () => {
		resetGlobalFlagsForTesting();
		resetColorOverrideForTesting();
		setColorOverride(false);
		setForceNonInteractive(true);

		const sessionList = await import('@/commands/_shared/session-list');
		(sessionList.findActiveSessions as ReturnType<typeof vi.fn>).mockReset().mockResolvedValue([]);
		const metaBranch = await import('@/strategy/metadata-branch');
		(metaBranch.getMetadataBranchTree as ReturnType<typeof vi.fn>)
			.mockReset()
			.mockResolvedValue(null);

		const { clearWorktreeRootCache } = await import('@/paths');
		clearWorktreeRootCache();
		env = await TestEnv.create({ initialCommit: true });
		origCwd = process.cwd();
		process.chdir(env.dir);
		clearWorktreeRootCache();
		assertCwdIsNotStoryRepo();
	});

	afterEach(async () => {
		process.chdir(origCwd);
		await env.cleanup();
		resetGlobalFlagsForTesting();
		resetColorOverrideForTesting();
		setForceNonInteractive(false);
	});

	// Go: status.go: newStatusCmd — basic wiring check
	it('registers `status` with `--detailed` flag', () => {
		const cli = buildCli();
		const status = cli.commands.find((c) => c.name === 'status');
		expect(status).toBeDefined();
		const flagNames = status!.options.map((o) => o.name);
		expect(flagNames).toContain('detailed');
		expect(flagNames).toContain('limit');
		expect(flagNames).toContain('offset');
		expect(flagNames).toContain('all');
	});

	// Go: status.go — exit with "not a git repository" when outside a git repo.
	it('outside a git repo → SilentError("Not a git repository")', async () => {
		const os = await import('node:os');
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'story-notgit-'));
		try {
			process.chdir(tmp);
			const { clearWorktreeRootCache } = await import('@/paths');
			clearWorktreeRootCache();
			const cli = buildCli();
			const sink = silenceStdio();
			try {
				await expect(runCli(cli, ['status'])).rejects.toThrow(SilentError);
			} finally {
				sink.restore();
			}
		} finally {
			process.chdir(env.dir);
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	// Enabled + no active sessions → renders compact status + empty active-session state.
	it('enabled + 0 active sessions → prints compact enabled state and no active sessions', async () => {
		await env.writeFile('.story/settings.json', '{"enabled": true}');
		// Install all 5 hook shims to pass the "5/5 installed" check.
		await writeStoryHooks(env);

		const cli = buildCli();
		const sink = silenceStdio();
		try {
			await runCli(cli, ['status']);
		} finally {
			sink.restore();
		}
		const all = sink.stdout.join('');
		expect(all).toMatch(/● Enabled/);
		expect(all).toMatch(/No active sessions/);
		expect(all).not.toMatch(/Git hooks: 5\/5 installed/);
	});

	// Enabled + 1 active session — renders session card summary
	it('enabled + 1 active session → renders summary line containing agent + id', async () => {
		await env.writeFile('.story/settings.json', '{"enabled": true}');
		await writeStoryHooks(env);
		await setActive([
			{
				id: 'sess-abc123',
				agentType: 'Claude Code',
				model: 'claude-sonnet-4-5',
				lastPrompt: 'Implement login flow',
				tokens: { input: 18400, output: 3200, turns: 7 },
				filesChanged: 4,
				lastCheckpointId: 'cp_9f3a1d2b',
			},
		]);

		const cli = buildCli();
		const sink = silenceStdio();
		try {
			await runCli(cli, ['status']);
		} finally {
			sink.restore();
		}
		const all = sink.stdout.join('');
		expect(all).toMatch(/sess-abc123/);
		expect(all).toMatch(/Claude Code/);
		expect(all).toMatch(/> "Implement login flow"/);
		expect(all).toMatch(/Active Sessions/);
	});

	it('stuck active session → renders stale doctor hint', async () => {
		await env.writeFile('.story/settings.json', '{"enabled": true}');
		await writeStoryHooks(env);
		await setActive([
			{
				id: 'sess-stuck',
				agentType: 'Cursor',
				isStuckActive: true,
			},
		]);

		const cli = buildCli();
		const sink = silenceStdio();
		try {
			await runCli(cli, ['status']);
		} finally {
			sink.restore();
		}
		const all = sink.stdout.join('');
		expect(all).toMatch(/stale/);
		expect(all).toMatch(/story doctor/);
	});

	it('enabled + 6 active sessions → defaults to first 5 with next offset hint', async () => {
		await env.writeFile('.story/settings.json', '{"enabled": true}');
		await writeStoryHooks(env);
		await setActive(
			Array.from({ length: 6 }, (_, i) => ({
				id: `sess-${i + 1}`,
				agentType: 'Cursor',
				lastPrompt: `prompt ${i + 1}`,
			})),
		);

		const cli = buildCli();
		const sink = silenceStdio();
		try {
			await runCli(cli, ['status']);
		} finally {
			sink.restore();
		}
		const all = sink.stdout.join('');
		expect(all).toMatch(/sess-1/);
		expect(all).toMatch(/sess-5/);
		expect(all).not.toMatch(/sess-6/);
		expect(all).toMatch(/showing 5 of 6 sessions/i);
		expect(all).toMatch(/story status --offset 5/);
	});

	it('--limit and --offset page active sessions', async () => {
		await env.writeFile('.story/settings.json', '{"enabled": true}');
		await writeStoryHooks(env);
		await setActive(
			Array.from({ length: 6 }, (_, i) => ({
				id: `sess-${i + 1}`,
				agentType: 'Cursor',
			})),
		);

		const cli = buildCli();
		const sink = silenceStdio();
		try {
			await runCli(cli, ['status', '--limit', '2', '--offset', '2']);
		} finally {
			sink.restore();
		}
		const all = sink.stdout.join('');
		expect(all).not.toMatch(/sess-1/);
		expect(all).toMatch(/sess-3/);
		expect(all).toMatch(/sess-4/);
		expect(all).not.toMatch(/sess-5/);
		expect(all).toMatch(/showing 2 of 6 sessions/i);
		expect(all).toMatch(/story status --limit 2 --offset 4/);
	});

	it('--all renders all active sessions without next-page hint', async () => {
		await env.writeFile('.story/settings.json', '{"enabled": true}');
		await writeStoryHooks(env);
		await setActive(
			Array.from({ length: 6 }, (_, i) => ({
				id: `sess-${i + 1}`,
				agentType: 'Cursor',
			})),
		);

		const cli = buildCli();
		const sink = silenceStdio();
		try {
			await runCli(cli, ['status', '--all']);
		} finally {
			sink.restore();
		}
		const all = sink.stdout.join('');
		expect(all).toMatch(/sess-6/);
		expect(all).toMatch(/showing all 6 sessions/i);
		expect(all).not.toMatch(/next:/i);
	});

	it('invalid --limit → SilentError', async () => {
		await env.writeFile('.story/settings.json', '{"enabled": true}');
		await writeStoryHooks(env);

		const cli = buildCli();
		const sink = silenceStdio();
		try {
			await expect(runCli(cli, ['status', '--limit', '0'])).rejects.toThrow(SilentError);
			await expect(runCli(cli, ['status', '--limit', '0'])).rejects.toThrow(/--limit/);
		} finally {
			sink.restore();
		}
	});

	// Not enabled (no settings, no hooks) → friendly "not enabled" state + hint
	it('no settings + no hooks → friendly "Story is not enabled" state', async () => {
		const cli = buildCli();
		const sink = silenceStdio();
		try {
			await runCli(cli, ['status']);
		} finally {
			sink.restore();
		}
		const all = sink.stdout.join('');
		expect(all).toMatch(/Story is not enabled/);
		expect(all).toMatch(/story enable/);
	});

	// All 5 hooks installed → "5/5 installed" line in detailed diagnostics
	it('--detailed + 5/5 hooks installed → "Git hooks: 5/5 installed" line', async () => {
		await env.writeFile('.story/settings.json', '{"enabled": true}');
		await writeStoryHooks(env);

		const cli = buildCli();
		const sink = silenceStdio();
		try {
			await runCli(cli, ['status', '--detailed']);
		} finally {
			sink.restore();
		}
		expect(sink.stdout.join('')).toMatch(/5\/5 installed/);
	});

	// Partial hooks (3/5) → warning + missing hook names listed
	it('3/5 hooks installed → warning with list of missing hook names', async () => {
		await env.writeFile('.story/settings.json', '{"enabled": true}');
		await writeStoryHooks(env, ['prepare-commit-msg', 'commit-msg', 'post-commit']);

		const cli = buildCli();
		const sink = silenceStdio();
		try {
			await runCli(cli, ['status']);
		} finally {
			sink.restore();
		}
		const all = `${sink.stdout.join('')}${sink.stderr.join('')}`;
		expect(all).toMatch(/3\/5 installed/);
		expect(all).toMatch(/post-rewrite/);
		expect(all).toMatch(/pre-push/);
	});

	// Settings source: 'local' when only settings.local.json exists
	it('--detailed settings source "local" when only .story/settings.local.json exists', async () => {
		await env.writeFile('.story/settings.local.json', '{"enabled": true}');
		await writeStoryHooks(env);

		const cli = buildCli();
		const sink = silenceStdio();
		try {
			await runCli(cli, ['status', '--detailed']);
		} finally {
			sink.restore();
		}
		expect(sink.stdout.join('')).toMatch(/settings\.local\.json.*local/);
	});

	// Settings source: 'project' when only settings.json exists
	it('--detailed settings source "project" when only .story/settings.json exists', async () => {
		await env.writeFile('.story/settings.json', '{"enabled": true}');
		await writeStoryHooks(env);

		const cli = buildCli();
		const sink = silenceStdio();
		try {
			await runCli(cli, ['status', '--detailed']);
		} finally {
			sink.restore();
		}
		expect(sink.stdout.join('')).toMatch(/settings\.json.*project/);
	});

	// Metadata branch: present → show the branch name in detailed diagnostics
	it('--detailed metadata branch exists → "Metadata branch: story/checkpoints/v1"', async () => {
		await env.writeFile('.story/settings.json', '{"enabled": true}');
		await writeStoryHooks(env);
		await setMetadataBranchHash('abc1234abc1234abc1234abc1234abc1234abcd');

		const cli = buildCli();
		const sink = silenceStdio();
		try {
			await runCli(cli, ['status', '--detailed']);
		} finally {
			sink.restore();
		}
		expect(sink.stdout.join('')).toMatch(/story\/checkpoints\/v1/);
	});

	// Metadata branch absent → "(not initialized)" phrase in detailed diagnostics
	it('--detailed metadata branch missing → "(not initialized)"', async () => {
		await env.writeFile('.story/settings.json', '{"enabled": true}');
		await writeStoryHooks(env);
		await setMetadataBranchHash(null);

		const cli = buildCli();
		const sink = silenceStdio();
		try {
			await runCli(cli, ['status', '--detailed']);
		} finally {
			sink.restore();
		}
		expect(sink.stdout.join('')).toMatch(/not initialized/);
	});

	// `--detailed` prints 3 JSON layers (effective / project / local)
	it('--detailed → shows Settings layers section with effective / project / local', async () => {
		await env.writeFile('.story/settings.json', '{"enabled": true}');
		await env.writeFile('.story/settings.local.json', '{"enabled": true, "telemetry": false}');
		await writeStoryHooks(env);

		const cli = buildCli();
		const sink = silenceStdio();
		try {
			await runCli(cli, ['status', '--detailed']);
		} finally {
			sink.restore();
		}
		const all = sink.stdout.join('');
		expect(all).toMatch(/Settings layers/);
		expect(all).toMatch(/effective/);
		expect(all).toMatch(/project/);
		expect(all).toMatch(/local/);
	});

	// `--detailed` + missing local file → "(not set)" marker
	it('--detailed + no settings.local.json → local shown as "(not set)"', async () => {
		await env.writeFile('.story/settings.json', '{"enabled": true}');
		await writeStoryHooks(env);

		const cli = buildCli();
		const sink = silenceStdio();
		try {
			await runCli(cli, ['status', '--detailed']);
		} finally {
			sink.restore();
		}
		expect(sink.stdout.join('')).toMatch(/not set/);
	});

	// `--json` → single-line JSON + no banner/bar
	it('--json → emits single-line JSON to stdout with top-level fields', async () => {
		await env.writeFile('.story/settings.json', '{"enabled": true}');
		await writeStoryHooks(env);

		const cli = buildCli();
		const sink = silenceStdio();
		try {
			await runCli(cli, ['status', '--json']);
		} finally {
			sink.restore();
		}
		// Last non-empty stdout chunk should be parseable JSON.
		const lines = sink.stdout.join('').split('\n').filter(Boolean);
		const parsed = JSON.parse(lines[lines.length - 1]!);
		expect(parsed).toMatchObject({
			enabled: true,
			repoRoot: env.dir,
			gitHooks: { installed: 5, total: 5 },
		});
	});

	// `--json --detailed` → settingsLayers field present
	it('--json --detailed → JSON contains `settingsLayers`', async () => {
		await env.writeFile('.story/settings.json', '{"enabled": true}');
		await writeStoryHooks(env);

		const cli = buildCli();
		const sink = silenceStdio();
		try {
			await runCli(cli, ['status', '--json', '--detailed']);
		} finally {
			sink.restore();
		}
		const lines = sink.stdout.join('').split('\n').filter(Boolean);
		const parsed = JSON.parse(lines[lines.length - 1]!);
		expect(parsed.settingsLayers).toBeDefined();
		expect(parsed.settingsLayers.effective).toBeDefined();
	});

	// `--json` + not enabled → flat "enabled: false" + reason
	it('--json + not enabled → `{"enabled":false, "reason":"..."}`', async () => {
		const cli = buildCli();
		const sink = silenceStdio();
		try {
			await runCli(cli, ['status', '--json']);
		} finally {
			sink.restore();
		}
		const lines = sink.stdout.join('').split('\n').filter(Boolean);
		const parsed = JSON.parse(lines[lines.length - 1]!);
		expect(parsed).toMatchObject({
			enabled: false,
			reason: expect.any(String),
		});
	});

	// Footer hint: active sessions → refers to `sessions info <id>`
	it('footer contains `sessions info <id>` when ≥ 1 active session', async () => {
		await env.writeFile('.story/settings.json', '{"enabled": true}');
		await writeStoryHooks(env);
		await setActive([{ id: 'sess-xyz789' }]);

		const cli = buildCli();
		const sink = silenceStdio();
		try {
			await runCli(cli, ['status']);
		} finally {
			sink.restore();
		}
		expect(sink.stdout.join('')).toMatch(/sessions info sess-xyz789/);
	});

	// Footer hint: zero active sessions → refers to `sessions list`
	it('footer contains `sessions list` when 0 active sessions', async () => {
		await env.writeFile('.story/settings.json', '{"enabled": true}');
		await writeStoryHooks(env);
		await setActive([]);

		const cli = buildCli();
		const sink = silenceStdio();
		try {
			await runCli(cli, ['status']);
		} finally {
			sink.restore();
		}
		expect(sink.stdout.join('')).toMatch(/sessions list/);
	});

	// Branch surfacing — `git rev-parse --abbrev-ref HEAD` result.
	it('prints current branch name under Repository header', async () => {
		await env.writeFile('.story/settings.json', '{"enabled": true}');
		await writeStoryHooks(env);
		await env.exec('git', ['checkout', '-b', 'feat/status-test']);

		const cli = buildCli();
		const sink = silenceStdio();
		try {
			await runCli(cli, ['status']);
		} finally {
			sink.restore();
		}
		expect(sink.stdout.join('')).toMatch(/feat\/status-test/);
	});

	// --json output always surfaces the active-session list under `activeSessions`.
	it('--json contains activeSessions array (possibly empty)', async () => {
		await env.writeFile('.story/settings.json', '{"enabled": true}');
		await writeStoryHooks(env);
		await setActive([
			{
				id: 'sess-1',
				agentType: 'Claude Code',
				tokens: { input: 1000, output: 500, turns: 2 },
				filesChanged: 1,
			},
		]);

		const cli = buildCli();
		const sink = silenceStdio();
		try {
			await runCli(cli, ['status', '--json']);
		} finally {
			sink.restore();
		}
		const lines = sink.stdout.join('').split('\n').filter(Boolean);
		const parsed = JSON.parse(lines[lines.length - 1]!);
		expect(parsed.activeSessions).toHaveLength(1);
		expect(parsed.activeSessions[0].id).toBe('sess-1');
	});

	it('--json includes paginated activeSessions and pagination metadata', async () => {
		await env.writeFile('.story/settings.json', '{"enabled": true}');
		await writeStoryHooks(env);
		await setActive(
			Array.from({ length: 6 }, (_, i) => ({
				id: `sess-${i + 1}`,
				agentType: 'Cursor',
				lastPrompt: `prompt ${i + 1}`,
			})),
		);

		const cli = buildCli();
		const sink = silenceStdio();
		try {
			await runCli(cli, ['status', '--json', '--limit', '2', '--offset', '2']);
		} finally {
			sink.restore();
		}
		const lines = sink.stdout.join('').split('\n').filter(Boolean);
		const parsed = JSON.parse(lines[lines.length - 1]!);
		expect(parsed.activeSessions.map((s: { id: string }) => s.id)).toEqual(['sess-3', 'sess-4']);
		expect(parsed.activeSessions[0].lastPrompt).toBe('prompt 3');
		expect(parsed.pagination).toEqual({
			total: 6,
			limit: 2,
			offset: 2,
			nextOffset: 4,
		});
	});
});

/**
 * Install the Story git hook shims (marker-containing) into the test env.
 * Optionally restrict to a subset to simulate partial installation.
 */
async function writeStoryHooks(
	env: TestEnv,
	names: ReadonlyArray<string> = [
		'prepare-commit-msg',
		'commit-msg',
		'post-commit',
		'post-rewrite',
		'pre-push',
	],
): Promise<void> {
	const hooksDir = path.join(env.gitDir, 'hooks');
	await fs.mkdir(hooksDir, { recursive: true });
	for (const name of names) {
		const content = `#!/bin/sh\n# Story CLI hooks\necho hello\n`;
		await fs.writeFile(path.join(hooksDir, name), content, { mode: 0o755 });
	}
}
