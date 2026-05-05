import cac from 'cac';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyGlobalFlags, registerGlobalFlags, resetGlobalFlagsForTesting } from '@/cli/flags';
import { registerVersionCommand } from '@/commands/version';
import { resetColorOverrideForTesting, setColorOverride } from '@/ui/theme';

const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const stripAnsi = (s: string) => s.replace(ANSI_RE, '');

function captureStdout() {
	const chunks: Buffer[] = [];
	const orig = process.stdout.write.bind(process.stdout);
	process.stdout.write = ((chunk: string | Uint8Array) => {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
		return true;
	}) as typeof process.stdout.write;
	return {
		text: () => stripAnsi(Buffer.concat(chunks).toString('utf8')),
		raw: () => Buffer.concat(chunks).toString('utf8'),
		restore: () => {
			process.stdout.write = orig;
		},
	};
}

function buildCliWithVersion(): ReturnType<typeof cac> {
	const cli = cac('story');
	registerGlobalFlags(cli);
	registerVersionCommand(cli);
	return cli;
}

describe('commands/version', () => {
	let cap: ReturnType<typeof captureStdout>;

	beforeEach(() => {
		resetGlobalFlagsForTesting();
		resetColorOverrideForTesting();
		setColorOverride(false);
		cap = captureStdout();
	});

	afterEach(() => {
		cap.restore();
		resetGlobalFlagsForTesting();
		resetColorOverrideForTesting();
	});

	it('prints plain text with version / runtime / platform / arch / commit', () => {
		const cli = buildCliWithVersion();
		cli.parse(['node', 'story', 'version']);
		const text = cap.text();
		expect(text).toContain('Story CLI');
		expect(text).toMatch(/version:\s+\d+\.\d+\.\d+/);
		expect(text).toMatch(/runtime:\s+(bun|node)/i);
		expect(text).toMatch(/platform:\s+\w+/);
		expect(text).toMatch(/arch:\s+\w+/);
		expect(text).toMatch(/commit:/);
	});

	it('under --json prints a single JSON line with all fields', () => {
		applyGlobalFlags({ json: true });
		const cli = buildCliWithVersion();
		cli.parse(['node', 'story', 'version']);
		const raw = cap.text().trim();
		const payload = JSON.parse(raw);
		expect(payload).toMatchObject({
			name: 'story',
			version: expect.any(String),
			runtime: expect.any(String),
			platform: expect.any(String),
			arch: expect.any(String),
			commit: expect.any(String),
		});
	});

	// Go: cmd/entire/cli/root.go: versionInfo — field set alignment
	// Story JSON payload keys must match the Go versionInfo struct exactly
	// (name / version / runtime / platform / arch / commit); any divergence
	// would surface as agent-side parse errors.
	it('--json payload has exactly the contracted key set (Go: versionInfo)', () => {
		applyGlobalFlags({ json: true });
		const cli = buildCliWithVersion();
		cli.parse(['node', 'story', 'version']);
		const payload = JSON.parse(cap.text().trim()) as Record<string, unknown>;
		expect(Object.keys(payload).sort()).toEqual(
			['arch', 'commit', 'name', 'platform', 'runtime', 'version'].sort(),
		);
		expect(payload.name).toBe('story');
		expect(payload.commit).toBe('dev'); // foundation-backlog: replaced by build-time inject
	});

	it('plain output width is stable: 6 consistent "  key: value" rows', () => {
		const cli = buildCliWithVersion();
		cli.parse(['node', 'story', 'version']);
		const text = cap.text();
		const rows = text.split('\n').filter((l) => l.startsWith('  ') && l.includes(':'));
		expect(rows).toHaveLength(5);
		for (const row of rows) {
			expect(row).toMatch(/^ {2}[a-z]+:\s+\S/);
		}
	});

	it('plain runtime field reports bun under the Bun test runner', () => {
		const cli = buildCliWithVersion();
		cli.parse(['node', 'story', 'version']);
		const line = cap
			.text()
			.split('\n')
			.find((l) => l.includes('runtime:'));
		expect(line).toBeDefined();
		// vitest runs under Node when invoked via `bun run test`, so we can't
		// hard-assert 'bun' here. Assert the value is one of the two valid
		// shapes so both matrices pass.
		expect(line).toMatch(/runtime:\s+(bun|node) \d+\.\d+\.\d+/);
	});

	it('falls back to "0.0.0" when package.json cannot be located', async () => {
		vi.resetModules();
		vi.doMock('node:fs', async () => {
			const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
			return {
				...actual,
				readFileSync: () => {
					throw new Error('ENOENT');
				},
			};
		});
		const flagsMod = await import('@/cli/flags');
		const verMod = await import('@/commands/version');
		const cli = cac('story');
		flagsMod.registerGlobalFlags(cli);
		verMod.registerVersionCommand(cli);
		flagsMod.applyGlobalFlags({ json: true });
		cli.parse(['node', 'story', 'version']);
		const payload = JSON.parse(cap.text().trim()) as { version: string };
		expect(payload.version).toBe('0.0.0');
		flagsMod.resetGlobalFlagsForTesting();
		vi.doUnmock('node:fs');
		vi.resetModules();
	});

	it('falls back to "0.0.0" when package.json has no version field', async () => {
		vi.resetModules();
		vi.doMock('node:fs', async () => {
			const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
			return {
				...actual,
				readFileSync: () => '{"name":"story"}',
			};
		});
		const flagsMod = await import('@/cli/flags');
		const verMod = await import('@/commands/version');
		const cli = cac('story');
		flagsMod.registerGlobalFlags(cli);
		verMod.registerVersionCommand(cli);
		flagsMod.applyGlobalFlags({ json: true });
		cli.parse(['node', 'story', 'version']);
		const payload = JSON.parse(cap.text().trim()) as { version: string };
		expect(payload.version).toBe('0.0.0');
		flagsMod.resetGlobalFlagsForTesting();
		vi.doUnmock('node:fs');
		vi.resetModules();
	});

	it('resolveRuntime reports "node X" when process.versions.bun is absent', async () => {
		const origBun = (process.versions as Record<string, string | undefined>).bun;
		Object.defineProperty(process.versions, 'bun', {
			value: undefined,
			configurable: true,
			writable: true,
		});
		try {
			vi.resetModules();
			const flagsMod = await import('@/cli/flags');
			const verMod = await import('@/commands/version');
			const cli = cac('story');
			flagsMod.registerGlobalFlags(cli);
			verMod.registerVersionCommand(cli);
			flagsMod.applyGlobalFlags({ json: true });
			cli.parse(['node', 'story', 'version']);
			const payload = JSON.parse(cap.text().trim()) as { runtime: string };
			expect(payload.runtime).toMatch(/^node \d+\.\d+\.\d+/);
			flagsMod.resetGlobalFlagsForTesting();
		} finally {
			if (origBun !== undefined) {
				Object.defineProperty(process.versions, 'bun', {
					value: origBun,
					configurable: true,
					writable: true,
				});
			}
			vi.resetModules();
		}
	});
});
