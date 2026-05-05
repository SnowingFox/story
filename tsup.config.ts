import fs from 'node:fs/promises';
import path from 'node:path';
import { defineConfig } from 'tsup';

/**
 * Two build entries:
 *
 *  1. `src/cli.ts` → `dist/cli.js` (minified, production CLI; `npm link` target)
 *  2. `src/bin/vogon.ts` → `tests/e2e/bin/vogon.mjs` (unminified, E2E-only
 *     deterministic canary agent; chmod +x via `onSuccess` so the file is
 *     directly executable via shebang)
 *
 * The Vogon entry is kept `minify: false` + `clean: false` so E2E failure
 * stack traces remain readable, and so a parallel `tsup --entry src/cli.ts`
 * invocation doesn't wipe `tests/e2e/bin/`. `src/bin/vogon.ts` is excluded
 * from coverage (see `vitest.config.ts`) since it's a test-only binary.
 */
export default defineConfig([
	{
		name: 'cli',
		entry: ['./src/cli.ts'],
		outDir: 'dist',
		target: 'esnext',
		format: 'esm',
		/** Required for `npm link` / global `bin`: OS must exec via Node, not the shell. */
		banner: {
			js: '#!/usr/bin/env node\n',
		},
		minify: true,
		sourcemap: false,
		clean: true,
		splitting: false,
	},
	{
		name: 'vogon',
		entry: { vogon: './src/bin/vogon.ts' },
		outDir: 'tests/e2e/bin',
		outExtension: () => ({ js: '.mjs' }),
		target: 'esnext',
		format: 'esm',
		banner: {
			js: '#!/usr/bin/env node\n',
		},
		minify: false,
		sourcemap: false,
		clean: false,
		splitting: false,
		/** Make the generated Vogon binary directly executable via its shebang. */
		async onSuccess(): Promise<void> {
			const vogonPath = path.resolve('tests/e2e/bin/vogon.mjs');
			try {
				await fs.chmod(vogonPath, 0o755);
			} catch (e) {
				if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
					throw e;
				}
			}
		},
	},
]);
