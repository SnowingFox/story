/**
 * Tests for `src/agent/external/discovery.ts` — stripExeExt and
 * BINARY_PREFIX constant.
 *
 * Full discovery integration tests (PATH scanning + binary execution)
 * are better suited for e2e testing. Unit tests here cover the pure
 * helper functions.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { wrap } from '@/agent/external/capabilities';
import {
	BINARY_PREFIX,
	discoverAndRegister,
	discoverAndRegisterAlways,
	stripExeExt,
} from '@/agent/external/discovery';
import { ExternalAgent } from '@/agent/external/index';
import * as registry from '@/agent/registry';
import { get, list, register, withTestRegistry } from '@/agent/registry';
import type { AgentName } from '@/agent/types';
import { load } from '@/settings/settings';

vi.mock('@/settings/settings', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@/settings/settings')>();
	return {
		...actual,
		load: vi.fn(),
	};
});

const fixtureBinDir = path.join(
	fileURLToPath(new URL('.', import.meta.url)),
	'../../../fixtures/external/bin',
);
const STUB_GOOD = path.join(fixtureBinDir, 'story-agent-stub');
const STUB_MJS = path.join(fixtureBinDir, 'story-agent-stub.mjs');
const STUB_INFO_FAIL = path.join(fixtureBinDir, 'story-agent-info-fail');

function installStubExecutable(targetDir: string, wrapperName = 'story-agent-stub'): void {
	fs.copyFileSync(STUB_GOOD, path.join(targetDir, wrapperName));
	fs.copyFileSync(STUB_MJS, path.join(targetDir, 'story-agent-stub.mjs'));
	fs.chmodSync(path.join(targetDir, wrapperName), 0o755);
}

/** PATH that prefers `binDir` but keeps the rest of the environment PATH (needed for `#!/usr/bin/env bash` shebangs). */
function pathPreferringBin(binDir: string, fallbackPath: string | undefined): string {
	const rest = fallbackPath ?? '';
	return rest === '' ? binDir : `${binDir}${path.delimiter}${rest}`;
}

describe('BINARY_PREFIX', () => {
	// Go: discovery.go:18-20 binaryPrefix (Go: entire-agent-; Story TS uses story-agent-)
	it('is story-agent-', () => {
		expect(BINARY_PREFIX).toBe('story-agent-');
	});
});

describe('stripExeExt', () => {
	// Go: discovery.go:134-143 stripExeExt
	it('strips .exe extension', () => {
		expect(stripExeExt('story-agent-foo.exe')).toBe('story-agent-foo');
	});

	it('strips .bat extension', () => {
		expect(stripExeExt('story-agent-foo.bat')).toBe('story-agent-foo');
	});

	it('strips .cmd extension', () => {
		expect(stripExeExt('story-agent-foo.cmd')).toBe('story-agent-foo');
	});

	it('strips .EXE extension (case-insensitive)', () => {
		expect(stripExeExt('story-agent-foo.EXE')).toBe('story-agent-foo');
	});

	it('preserves name without extension (Unix)', () => {
		expect(stripExeExt('story-agent-foo')).toBe('story-agent-foo');
	});

	it('preserves non-exe extensions', () => {
		expect(stripExeExt('story-agent-foo.sh')).toBe('story-agent-foo.sh');
	});

	it('preserves dotfiles', () => {
		expect(stripExeExt('.story-agent-hidden')).toBe('.story-agent-hidden');
	});

	it('handles empty string', () => {
		expect(stripExeExt('')).toBe('');
	});

	it('derives agent name from prefix + exe stripping', () => {
		const name = 'story-agent-my-cool-agent.exe';
		const clean = stripExeExt(name);
		const agentName = clean.slice(BINARY_PREFIX.length);
		expect(agentName).toBe('my-cool-agent');
	});

	it('strips .BAT extension (case-insensitive)', () => {
		expect(stripExeExt('story-agent-foo.BAT')).toBe('story-agent-foo');
	});

	it('strips .CMD extension (case-insensitive)', () => {
		expect(stripExeExt('story-agent-foo.CMD')).toBe('story-agent-foo');
	});

	it('strips mixed-case .Exe / .Bat / .CmD extensions', () => {
		expect(stripExeExt('story-agent-foo.Exe')).toBe('story-agent-foo');
		expect(stripExeExt('story-agent-foo.Bat')).toBe('story-agent-foo');
		expect(stripExeExt('story-agent-foo.CmD')).toBe('story-agent-foo');
	});

	it('preserves trailing dot (not a recognized extension)', () => {
		expect(stripExeExt('story-agent-foo.')).toBe('story-agent-foo.');
	});

	it('preserves name with substring "exe" that is not the extension', () => {
		expect(stripExeExt('story-agent-executor')).toBe('story-agent-executor');
		expect(stripExeExt('story-agent-foo.executable')).toBe('story-agent-foo.executable');
	});

	it('strips only the final extension when multiple dots are present', () => {
		expect(stripExeExt('story-agent-foo.tar.exe')).toBe('story-agent-foo.tar');
		expect(stripExeExt('story-agent-foo.v1.2.bat')).toBe('story-agent-foo.v1.2');
	});

	it('preserves name when .exe sits before a non-exe extension', () => {
		expect(stripExeExt('story-agent-foo.exe.sh')).toBe('story-agent-foo.exe.sh');
	});

	it('preserves unrelated extensions (.sh, .py, .txt)', () => {
		expect(stripExeExt('story-agent-foo.sh')).toBe('story-agent-foo.sh');
		expect(stripExeExt('story-agent-foo.py')).toBe('story-agent-foo.py');
		expect(stripExeExt('story-agent-foo.txt')).toBe('story-agent-foo.txt');
	});

	it('strips only the extension when prefix itself ends with a dot', () => {
		// Contrived: BINARY_PREFIX + literal ".exe" → strips cleanly to prefix.
		expect(stripExeExt('story-agent-.exe')).toBe('story-agent-');
	});

	it('preserves a single dot', () => {
		expect(stripExeExt('.')).toBe('.');
	});

	it('preserves double dot', () => {
		expect(stripExeExt('..')).toBe('..');
	});

	it('does not strip .com (Windows command files are not supported)', () => {
		// Go switch only covers .exe/.bat/.cmd. `.com` is a legacy Windows
		// executable extension but neither stripExeExt mirrors it.
		expect(stripExeExt('story-agent-foo.com')).toBe('story-agent-foo.com');
	});
});

describe('discoverAndRegister integration (mocked settings + worktree)', () => {
	// Go: discovery.go:31-44 DiscoverAndRegister + DiscoverAndRegisterAlways entrypoints
	// Go: discovery.go:47-132 discoverAndRegister scan/register loop
	let prevPath: string | undefined;
	let tmpRepo: string;

	beforeEach(() => {
		prevPath = process.env.PATH;
		vi.mocked(load).mockResolvedValue({ enabled: true, external_agents: true });
		tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'story-ext-disc-'));
		fs.chmodSync(STUB_GOOD, 0o755);
		fs.chmodSync(STUB_INFO_FAIL, 0o755);
	});

	afterEach(() => {
		process.env.PATH = prevPath;
		fs.rmSync(tmpRepo, { recursive: true, force: true });
		vi.clearAllMocks();
	});

	it('discoverAndRegister is a no-op when external_agents is not true', async () => {
		vi.mocked(load).mockResolvedValue({ enabled: true, external_agents: false });
		const binDir = fs.mkdtempSync(path.join(tmpRepo, 'bin-'));
		installStubExecutable(binDir);
		process.env.PATH = pathPreferringBin(binDir, prevPath);
		await withTestRegistry(async () => {
			await discoverAndRegister();
			expect(get('stub' as AgentName)).toBeNull();
		});
	});

	it('returns immediately when PATH is empty (no throw)', async () => {
		process.env.PATH = '';
		await withTestRegistry(async () => {
			await expect(discoverAndRegister()).resolves.toBeUndefined();
		});
	});

	it('skips a story-agent-* binary when info (ExternalAgent.create) fails', async () => {
		const binDir = fs.mkdtempSync(path.join(tmpRepo, 'bin-'));
		fs.copyFileSync(STUB_INFO_FAIL, path.join(binDir, 'story-agent-failinfo'));
		fs.chmodSync(path.join(binDir, 'story-agent-failinfo'), 0o755);
		process.env.PATH = pathPreferringBin(binDir, prevPath);
		await withTestRegistry(async () => {
			await discoverAndRegister();
			expect(get('failinfo' as AgentName)).toBeNull();
		});
	});

	it('registers the same agent name once when duplicate PATH entries contain the same filename', async () => {
		const a = fs.mkdtempSync(path.join(tmpRepo, 'p1-'));
		const b = fs.mkdtempSync(path.join(tmpRepo, 'p2-'));
		installStubExecutable(a);
		installStubExecutable(b);
		process.env.PATH = `${a}${path.delimiter}${b}${path.delimiter}${prevPath ?? ''}`;
		await withTestRegistry(async () => {
			await discoverAndRegister();
			expect(get('stub' as AgentName)).not.toBeNull();
		});
	});

	it('respects caller AbortSignal (aborted before work → no registration)', async () => {
		const binDir = fs.mkdtempSync(path.join(tmpRepo, 'bin-'));
		installStubExecutable(binDir, 'story-agent-abort');
		process.env.PATH = pathPreferringBin(binDir, prevPath);
		await withTestRegistry(async () => {
			const ac = new AbortController();
			ac.abort();
			await discoverAndRegister(ac.signal);
			expect(get('abort' as AgentName)).toBeNull();
		});
	});

	it('discoverAndRegisterAlways still scans when external_agents is false', async () => {
		vi.mocked(load).mockResolvedValue({ enabled: true, external_agents: false });
		const binDir = fs.mkdtempSync(path.join(tmpRepo, 'bin-'));
		installStubExecutable(binDir);
		process.env.PATH = pathPreferringBin(binDir, prevPath);
		await withTestRegistry(async () => {
			await discoverAndRegister();
			expect(get('stub' as AgentName)).toBeNull();
			await discoverAndRegisterAlways();
			expect(get('stub' as AgentName)).not.toBeNull();
		});
	});

	it('manual ExternalAgent.create + wrap + register (fixture sanity)', async () => {
		const binDir = fs.mkdtempSync(path.join(tmpRepo, 'bin-manual-'));
		installStubExecutable(binDir);
		const ea = await ExternalAgent.create(path.join(binDir, 'story-agent-stub'));
		expect(ea.name()).toBe('stub-agent');
		await withTestRegistry(async () => {
			register('stub' as AgentName, () => wrap(ea));
			expect(get('stub' as AgentName)).not.toBeNull();
		});
	});

	it('ExternalAgent.create accepts the same discovery timeout signal as discoverAndRegisterInternal', async () => {
		const binDir = fs.mkdtempSync(path.join(tmpRepo, 'bin-sig-'));
		installStubExecutable(binDir);
		const sig = AbortSignal.timeout(10_000);
		const ea = await ExternalAgent.create(path.join(binDir, 'story-agent-stub'), sig);
		expect(ea.name()).toBe('stub-agent');
	});

	it('discoverAndRegisterAlways alone registers stub (sanity: spawn + wrap path)', async () => {
		const binDir = fs.mkdtempSync(path.join(tmpRepo, 'bin-solo-'));
		installStubExecutable(binDir);
		const wantedPath = pathPreferringBin(binDir, prevPath);
		process.env.PATH = wantedPath;
		await withTestRegistry(async () => {
			expect(list(), 'registry must start empty inside withTestRegistry').toEqual([]);
			expect(process.env.PATH).toBe(wantedPath);
			expect(fs.readdirSync(binDir)).toContain('story-agent-stub');
			const spy = vi.spyOn(registry, 'register');
			await discoverAndRegisterAlways();
			expect(spy).toHaveBeenCalled();
			expect(get('stub' as AgentName)).not.toBeNull();
		});
	});

	it('on Unix, skips story-agent-* files that are not executable', async () => {
		if (process.platform === 'win32') {
			return;
		}
		const binDir = fs.mkdtempSync(path.join(tmpRepo, 'bin-'));
		fs.copyFileSync(STUB_GOOD, path.join(binDir, 'story-agent-noexec'));
		fs.copyFileSync(STUB_MJS, path.join(binDir, 'story-agent-stub.mjs'));
		fs.chmodSync(path.join(binDir, 'story-agent-noexec'), 0o644);
		process.env.PATH = pathPreferringBin(binDir, prevPath);
		await withTestRegistry(async () => {
			await discoverAndRegister();
			expect(get('noexec' as AgentName)).toBeNull();
		});
	});
});
