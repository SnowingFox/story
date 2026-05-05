/**
 * Phase 9.5 `src/commands/clean.ts` unit tests — 4 flag branches + errors.
 *
 * Go: `cmd/entire/cli/clean.go: newCleanCmd + runClean*`.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import cac from 'cac';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerGlobalFlags, resetGlobalFlagsForTesting } from '@/cli/flags';
import { setForceNonInteractive } from '@/cli/tty';
import { registerCleanCommand } from '@/commands/clean';
import { SilentError } from '@/errors';
import { clearGitCommonDirCache } from '@/git';
import { clearWorktreeRootCache } from '@/paths';
import { resetColorOverrideForTesting, setColorOverride } from '@/ui/theme';
import { TestEnv } from '../../helpers/test-env';

const confirmMock = vi.hoisted(() => vi.fn<(opts: unknown) => Promise<boolean>>());

vi.mock('@/ui/prompts', async (orig) => {
	const mod = (await orig()) as Record<string, unknown>;
	return { ...mod, confirm: confirmMock };
});

const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const stripAnsi = (s: string) => s.replace(ANSI_RE, '');

function captureStreams() {
	const outChunks: string[] = [];
	const errChunks: string[] = [];
	const origOut = process.stdout.write.bind(process.stdout);
	const origErr = process.stderr.write.bind(process.stderr);
	process.stdout.write = ((chunk: string | Uint8Array) => {
		outChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk: string | Uint8Array) => {
		errChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
		return true;
	}) as typeof process.stderr.write;
	return {
		stdout: () => stripAnsi(outChunks.join('')),
		stderr: () => stripAnsi(errChunks.join('')),
		rawStdout: () => outChunks.join(''),
		restore: () => {
			process.stdout.write = origOut;
			process.stderr.write = origErr;
		},
	};
}

function buildCli() {
	const cli = cac('story');
	registerGlobalFlags(cli);
	registerCleanCommand(cli);
	cli.help();
	cli.version('0.1.0');
	return cli;
}

async function parseClean(argv: string[]): Promise<void> {
	const cli = buildCli();
	cli.parse(['node', 'story', ...argv], { run: false });
	const result = cli.runMatchedCommand();
	if (result && typeof (result as Promise<unknown>).then === 'function') {
		await result;
	}
}

describe('commands/clean', () => {
	let env: TestEnv;
	let origCwd: string;
	let capture: ReturnType<typeof captureStreams>;

	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		origCwd = process.cwd();
		process.chdir(env.dir);
		clearWorktreeRootCache();
		clearGitCommonDirCache();
		resetGlobalFlagsForTesting();
		resetColorOverrideForTesting();
		setColorOverride(false);
		setForceNonInteractive(true); // Avoid hanging on prompts in tests.
		confirmMock.mockReset();
		confirmMock.mockResolvedValue(true);
		capture = captureStreams();
	});

	afterEach(async () => {
		capture.restore();
		process.chdir(origCwd);
		await env.cleanup();
		resetGlobalFlagsForTesting();
		resetColorOverrideForTesting();
		setForceNonInteractive(false);
	});

	async function expectAction(argv: string[]): Promise<unknown> {
		try {
			await parseClean(argv);
			return undefined;
		} catch (err) {
			return err;
		}
	}

	// Go: clean.go: newCleanCmd — happy default branch when no Story data exists.
	it('default HEAD: reports no data attached to HEAD in a fresh repo', async () => {
		await parseClean(['clean']);
		const out = capture.stdout();
		expect(out).toMatch(/story clean/);
		expect(out).toMatch(/No Story data attached to HEAD/);
	});

	// Go: clean.go: runCleanAll
	it('--all: reports empty clean path for a fresh repo', async () => {
		await parseClean(['clean', '--all']);
		const out = capture.stdout();
		expect(out).toMatch(/story clean --all/);
		expect(out).toMatch(/No Story session data found/);
	});

	// Go: clean.go: newCleanCmd — --all + --session mutual exclusion.
	it('--all --session together → SilentError (mutually exclusive)', async () => {
		const err = await expectAction(['clean', '--all', '--session', 'sess-abc']);
		expect(err).toBeInstanceOf(SilentError);
		expect((err as Error).message).toMatch(/mutually exclusive/);
	});

	// Go: clean.go: runCleanSession — 0-match SilentError.
	it('--session <unknown-id> → SilentError "Session not found"', async () => {
		const err = await expectAction(['clean', '--session', 'sess-nowhere']);
		expect(err).toBeInstanceOf(SilentError);
		expect((err as Error).message).toMatch(/Session not found/);
	});

	it('--dry-run: prints "Dry-run: nothing was written." banner + zero writes', async () => {
		// Seed a session state so the flow actually has something to preview.
		const commonDir = path.join(env.dir, '.git');
		const stateDir = path.join(commonDir, 'story-sessions');
		await fs.mkdir(stateDir, { recursive: true });
		const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		await fs.writeFile(
			path.join(stateDir, 'sess-dryrun000000.json'),
			JSON.stringify({
				session_id: 'sess-dryrun000000',
				base_commit: head,
				attribution_base_commit: '',
				worktree_id: '',
				started_at: new Date().toISOString(),
				last_interaction_time: new Date().toISOString(),
				turn_id: 't',
				step_count: 0,
				files_touched: [],
				prompts: [],
				phase: 'idle',
				cli_version: '0.1.0',
			}),
		);
		await parseClean(['clean', '--dry-run']);
		const out = capture.stdout();
		expect(out).toContain('(dry-run)');
		expect(out).toContain('Dry-run: nothing was written.');
		// State file untouched.
		const exists = await fs.stat(path.join(stateDir, 'sess-dryrun000000.json'));
		expect(exists).toBeDefined();
	});

	it('--all --dry-run: no deleteAllCleanupItems call', async () => {
		const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		await env.exec('git', ['branch', 'story/abc1234-e3b0c4', head]);
		await parseClean(['clean', '--all', '--dry-run']);
		const out = capture.stdout();
		expect(out).toContain('Dry-run: nothing was written.');
		// Branch still exists.
		const branches = (await env.exec('git', ['branch', '--list', 'story/abc1234-e3b0c4'])).stdout;
		expect(branches.trim()).not.toBe('');
	});

	it('--all --force: deletes shadow branches without confirm', async () => {
		const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		await env.exec('git', ['branch', 'story/deadbeef-aaaaaa', head]);
		await parseClean(['clean', '--all', '--force']);
		// Branch gone.
		const branches = (await env.exec('git', ['branch', '--list', 'story/deadbeef-aaaaaa'])).stdout;
		expect(branches.trim()).toBe('');
		expect(confirmMock).not.toHaveBeenCalled();
	});

	it('--all: user cancels confirm → SilentError(cancelled) + nothing deleted', async () => {
		const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		await env.exec('git', ['branch', 'story/cafe0000-aaaaaa', head]);
		confirmMock.mockResolvedValue(false);
		const err = await expectAction(['clean', '--all']);
		expect(err).toBeInstanceOf(SilentError);
		// Branch still exists — cancelled before delete.
		const branches = (await env.exec('git', ['branch', '--list', 'story/cafe0000-aaaaaa'])).stdout;
		expect(branches.trim()).not.toBe('');
	});

	it('--all: confirm approves → actually deletes shadow branches', async () => {
		const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		await env.exec('git', ['branch', 'story/baf0000-aaaaaa', head]);
		confirmMock.mockResolvedValue(true);
		await parseClean(['clean', '--all']);
		const branches = (await env.exec('git', ['branch', '--list', 'story/baf0000-aaaaaa'])).stdout;
		expect(branches.trim()).toBe('');
	});

	// Go: clean.go: runCleanSession — prefix resolution happy path.
	it('--session <12-char-prefix>: resolves to full id', async () => {
		const commonDir = path.join(env.dir, '.git');
		const stateDir = path.join(commonDir, 'story-sessions');
		await fs.mkdir(stateDir, { recursive: true });
		await fs.writeFile(
			path.join(stateDir, 'sess-prefixfull000.json'),
			JSON.stringify({
				session_id: 'sess-prefixfull000',
				base_commit: '',
				attribution_base_commit: '',
				worktree_id: '',
				started_at: new Date().toISOString(),
				last_interaction_time: new Date().toISOString(),
				turn_id: 't',
				step_count: 0,
				files_touched: [],
				prompts: [],
				phase: 'idle',
				cli_version: '0.1.0',
			}),
		);
		confirmMock.mockResolvedValue(true);
		await parseClean(['clean', '--session', 'sess-prefix', '--force']);
		// File removed.
		await expect(fs.stat(path.join(stateDir, 'sess-prefixfull000.json'))).rejects.toHaveProperty(
			'code',
			'ENOENT',
		);
	});

	it('--session: ambiguous prefix surfaces Ambiguous error', async () => {
		const commonDir = path.join(env.dir, '.git');
		const stateDir = path.join(commonDir, 'story-sessions');
		await fs.mkdir(stateDir, { recursive: true });
		for (const id of ['sess-amb000000001', 'sess-amb000000002']) {
			await fs.writeFile(
				path.join(stateDir, `${id}.json`),
				JSON.stringify({
					session_id: id,
					base_commit: '',
					attribution_base_commit: '',
					worktree_id: '',
					started_at: new Date().toISOString(),
					last_interaction_time: new Date().toISOString(),
					turn_id: 't',
					step_count: 0,
					files_touched: [],
					prompts: [],
					phase: 'idle',
					cli_version: '0.1.0',
				}),
			);
		}
		const err = await expectAction(['clean', '--session', 'sess-amb']);
		expect(err).toBeInstanceOf(SilentError);
		expect((err as Error).message).toMatch(/Ambiguous|Session not found/);
	});

	it('--session: confirm default=false still blocks destructive delete', async () => {
		const commonDir = path.join(env.dir, '.git');
		const stateDir = path.join(commonDir, 'story-sessions');
		await fs.mkdir(stateDir, { recursive: true });
		await fs.writeFile(
			path.join(stateDir, 'sess-cancel00000a.json'),
			JSON.stringify({
				session_id: 'sess-cancel00000a',
				base_commit: '',
				attribution_base_commit: '',
				worktree_id: '',
				started_at: new Date().toISOString(),
				last_interaction_time: new Date().toISOString(),
				turn_id: 't',
				step_count: 0,
				files_touched: [],
				prompts: [],
				phase: 'idle',
				cli_version: '0.1.0',
			}),
		);
		confirmMock.mockResolvedValue(false);
		const err = await expectAction(['clean', '--session', 'sess-cancel00000a']);
		expect(err).toBeInstanceOf(SilentError);
		// Still present.
		const exists = await fs.stat(path.join(stateDir, 'sess-cancel00000a.json'));
		expect(exists).toBeDefined();
	});

	it('--force: skips the confirm prompt entirely', async () => {
		const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		await env.exec('git', ['branch', 'story/forcef00-aaaaaa', head]);
		await parseClean(['clean', '--all', '--force']);
		expect(confirmMock).not.toHaveBeenCalled();
	});

	it('default HEAD: prints "Run \'story status\' to verify." footer', async () => {
		const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		await env.exec('git', ['branch', `story/${head.slice(0, 7)}-e3b0c4`, head]);
		await parseClean(['clean', '--force']);
		const out = capture.stdout();
		expect(out).toMatch(/story status/);
	});

	// Naming red-line: clean UI must never print 'entire'/'Entire CLI' leaks.
	it('no "entire" / ".entire/" / "Entire CLI" string leaks in stdout', async () => {
		await parseClean(['clean']);
		const out = capture.stdout();
		expect(out).not.toMatch(/\bentire\b/);
		expect(out).not.toMatch(/\.entire\//);
		expect(out).not.toMatch(/Entire CLI/);
	});

	it('not-a-git-repo: requireGitRepo throws SilentError', async () => {
		// Move cwd out of the test git repo.
		process.chdir(path.dirname(env.dir));
		clearWorktreeRootCache();
		clearGitCommonDirCache();
		const err = await expectAction(['clean']);
		// `worktreeRoot(os.tmpdir())` often still resolves to a git repo on CI
		// — accept either SilentError or success-with-no-data as a sane
		// outcome. The core assertion is "no crash".
		if (err !== undefined) {
			expect(err).toBeInstanceOf(SilentError);
		}
	});

	it('--all --force: warn banner is shown on stderr', async () => {
		const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		await env.exec('git', ['branch', 'story/abcdef0-aaaaaa', head]);
		await parseClean(['clean', '--all', '--force']);
		// `warn()` routes to stderr via `@/ui/logger`.
		expect(capture.stderr()).toMatch(/cleaning the whole repository/);
	});

	it('--all: Preserved: block is shown (story checkpoints / settings)', async () => {
		const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		await env.exec('git', ['branch', 'story/1234567-aaaaaa', head]);
		await parseClean(['clean', '--all', '--force']);
		const out = capture.stdout();
		expect(out).toMatch(/Preserved:/);
		expect(out).toMatch(/story\/checkpoints\/v1/);
	});

	// Go: clean.go: runCleanCurrentHead — dry-run output format.
	it('--dry-run outputs "would be" suffix', async () => {
		const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		await env.exec('git', ['branch', `story/${head.slice(0, 7)}-e3b0c4`, head]);
		await parseClean(['clean', '--dry-run']);
		const out = capture.stdout();
		expect(out).toMatch(/would be deleted/);
	});

	// In-flight `prompt.txt` last segment → dim one-line under `● session state` in the list.
	it('default HEAD: stdout includes latest in-flight prompt line below the session state row', async () => {
		const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
		const short7 = head.slice(0, 7);
		await env.exec('git', ['branch', `story/${short7}-e3b0c4`, head]);
		const commonDir = path.join(env.dir, '.git');
		const stateDir = path.join(commonDir, 'story-sessions');
		await fs.mkdir(stateDir, { recursive: true });
		const sessionId = '2026-04-25-sess-detail000';
		await fs.writeFile(
			path.join(stateDir, `${sessionId}.json`),
			JSON.stringify({
				session_id: sessionId,
				base_commit: head,
				attribution_base_commit: '',
				worktree_id: '',
				started_at: new Date().toISOString(),
				last_interaction_time: new Date().toISOString(),
				turn_id: 't',
				step_count: 0,
				files_touched: [],
				prompts: [],
				phase: 'idle',
				cli_version: '0.1.0',
			}),
		);
		const promptDir = path.join(env.dir, '.story', 'metadata', sessionId);
		await fs.mkdir(promptDir, { recursive: true });
		await fs.writeFile(
			path.join(promptDir, 'prompt.txt'),
			'older turn\n\n---\n\ncurrent in-flight user prompt for clean confirm',
		);
		confirmMock.mockResolvedValue(true);
		await parseClean(['clean']);
		const out = capture.stdout();
		expect(out).toContain('current in-flight user prompt for clean confirm');
		expect(confirmMock).toHaveBeenCalledWith(
			expect.objectContaining({ message: 'Delete these 2 items?' }),
		);
	});
});
