import path from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * Three-project layout shipped by Phase 10:
 *
 *  - `unit` — default `bun run test`, ~2500 pure unit cases; fast (~10-20s)
 *  - `integration` — `bun run test:integration`, spawns `bun run src/cli.ts`
 *    in a TestEnv temp repo; no Vogon binary, ~30s total
 *  - `e2e` — `bun run test:e2e`, spawns CLI + Vogon binary + real git hooks;
 *    requires `tests/e2e/setup.ts::beforeAll` to pre-build binaries; ~3-5 min
 *
 * Coverage (`bun run test:coverage`) only runs the `unit` project so that
 * coverage numbers reflect pure logic, not integration/e2e bootstrapping code.
 * `src/bin/vogon.ts` is excluded from coverage — it's a test-only binary.
 */
const sharedResolve = {
	alias: {
		'@': path.resolve(__dirname, 'src'),
	},
};

export default defineConfig({
	resolve: sharedResolve,
	test: {
		projects: [
			{
				resolve: sharedResolve,
				test: {
					name: 'unit',
					// E2E helpers (tests/e2e/helpers/*.test.ts) are plain unit tests
					// that exercise the helper modules themselves — they never spawn
					// the CLI or Vogon. The scenario files (*.e2e.test.ts) are the
					// ones excluded; see the `e2e` project below.
					include: ['tests/unit/**/*.test.ts', 'tests/e2e/helpers/**/*.test.ts'],
					exclude: ['tests/integration/**', 'tests/e2e/**/*.e2e.test.ts'],
					// Many unit tests are git-CLI integration-style tests that create
					// temporary repos. Under the full suite, worker concurrency can make
					// git init/add/commit hooks exceed Vitest's 10s default on loaded
					// machines even though the same file passes quickly in isolation.
					testTimeout: 30_000,
					maxConcurrency: 8,
				},
			},
			{
				resolve: sharedResolve,
				test: {
					name: 'integration',
					include: ['tests/integration/**/*.test.ts'],
					testTimeout: 60_000,
					maxConcurrency: 2,
				},
			},
			{
				resolve: sharedResolve,
				test: {
					name: 'e2e',
					include: ['tests/e2e/**/*.e2e.test.ts'],
					// PTY-driven cases (expect + Vogon + hooks) can exceed 3m sequentially.
					testTimeout: 300_000,
					maxConcurrency: 2,
					globalSetup: ['./tests/e2e/setup.ts'],
				},
			},
		],
		coverage: {
			provider: 'v8',
			include: ['src/**/*.ts'],
			exclude: ['src/cli.ts', 'src/bin/vogon.ts'],
			reporter: ['text', 'lcov'],
		},
	},
});
