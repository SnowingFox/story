/**
 * Phase 9.5 versioninfo module — VERSION + COMMIT constants
 *
 * Go: cmd/entire/cli/versioninfo/versioninfo.go
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Resolve and re-import `@/versioninfo` after manipulating process.env /
 * vi.doMock so each test sees a fresh module-level evaluation.
 */
async function freshImport() {
	vi.resetModules();
	return await import('@/versioninfo');
}

describe('versioninfo', () => {
	beforeEach(() => {
		vi.resetModules();
		vi.unstubAllEnvs();
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.doUnmock('node:fs');
		vi.resetModules();
	});

	// Go: versioninfo/versioninfo.go — `Version` resolved from package.json
	it('VERSION matches package.json.version', async () => {
		const here = path.dirname(fileURLToPath(import.meta.url));
		const pkgPath = path.resolve(here, '..', '..', 'package.json');
		const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
		const mod = await freshImport();
		expect(mod.VERSION).toBe(pkg.version);
	});

	it('COMMIT falls back to "dev" when STORY_COMMIT env is absent', async () => {
		vi.stubEnv('STORY_COMMIT', '');
		const mod = await freshImport();
		expect(mod.COMMIT).toBe('dev');
	});

	it('COMMIT reads STORY_COMMIT env var when set (simulates --define injection)', async () => {
		vi.stubEnv('STORY_COMMIT', 'a1b2c3d4');
		const mod = await freshImport();
		expect(mod.COMMIT).toBe('a1b2c3d4');
	});

	it('commands/version exposes COMMIT through the --json payload', async () => {
		vi.stubEnv('STORY_COMMIT', 'deadbeef');
		vi.resetModules();
		const flagsMod = await import('@/cli/flags');
		const verMod = await import('@/commands/version');
		const cac = (await import('cac')).default;
		flagsMod.resetGlobalFlagsForTesting();
		flagsMod.applyGlobalFlags({ json: true });
		const chunks: string[] = [];
		const orig = process.stdout.write.bind(process.stdout);
		process.stdout.write = ((c: string | Uint8Array) => {
			chunks.push(typeof c === 'string' ? c : Buffer.from(c).toString('utf8'));
			return true;
		}) as typeof process.stdout.write;
		try {
			const cli = cac('story');
			flagsMod.registerGlobalFlags(cli);
			verMod.registerVersionCommand(cli);
			cli.parse(['node', 'story', 'version']);
			const payload = JSON.parse(chunks.join('').trim()) as { commit: string };
			expect(payload.commit).toBe('deadbeef');
		} finally {
			process.stdout.write = orig;
			flagsMod.resetGlobalFlagsForTesting();
		}
	});

	// Go: manual_commit_condensation.go:1504 — CLIVersion consumes versioninfo.Version
	it('strategy/condensation.ts imports VERSION (grep assertion)', async () => {
		const here = path.dirname(fileURLToPath(import.meta.url));
		const src = readFileSync(
			path.resolve(here, '..', '..', 'src', 'strategy', 'condensation.ts'),
			'utf8',
		);
		expect(src).toMatch(/from ['"]@\/versioninfo['"]/);
		// Hard-coded stub must be gone.
		expect(src).not.toContain('0.0.0-impl-1');
		expect(src).not.toContain('TODO(phase-9-versioninfo)');
	});

	// Go: manual_commit_session.go:316 — state.CLIVersion = versioninfo.Version
	it('strategy/hooks-initialize-session.ts imports VERSION (grep assertion)', async () => {
		const here = path.dirname(fileURLToPath(import.meta.url));
		const src = readFileSync(
			path.resolve(here, '..', '..', 'src', 'strategy', 'hooks-initialize-session.ts'),
			'utf8',
		);
		expect(src).toMatch(/from ['"]@\/versioninfo['"]/);
		expect(src).not.toContain('TODO(phase-9-versioninfo)');
	});

	it('VERSION falls back to "0.0.0" when package.json cannot be located', async () => {
		vi.resetModules();
		vi.doMock('node:fs', async () => {
			const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
			return {
				...actual,
				readFileSync: (file: string, enc?: unknown) => {
					if (typeof file === 'string' && file.endsWith('package.json')) {
						throw new Error('ENOENT');
					}
					return actual.readFileSync(file, enc as BufferEncoding);
				},
			};
		});
		const mod = await freshImport();
		expect(mod.VERSION).toBe('0.0.0');
	});

	it('VERSION falls back to "0.0.0" when package.json is missing the version field', async () => {
		vi.resetModules();
		vi.doMock('node:fs', async () => {
			const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
			return {
				...actual,
				readFileSync: (file: string, enc?: unknown) => {
					if (typeof file === 'string' && file.endsWith('package.json')) {
						return '{"name":"story"}';
					}
					return actual.readFileSync(file, enc as BufferEncoding);
				},
			};
		});
		const mod = await freshImport();
		expect(mod.VERSION).toBe('0.0.0');
	});
});
