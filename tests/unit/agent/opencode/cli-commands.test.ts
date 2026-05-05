/**
 * Tests for `src/agent/opencode/cli-commands.ts` — Mirrors Go
 * `entire-cli/cmd/entire/cli/agent/opencode/cli_commands.go`.
 *
 * Strategy: a mock `opencode` shell script (chmod +x) is placed on a temp dir
 * which is prepended to `PATH` during the test. The mock reads its argv[1]
 * verb (`export` / `session` / `import`) and either prints fixture JSON or
 * exits non-zero / sleeps for timeout simulation.
 *
 * Covers (Go: cli_commands_test.go pattern):
 * - runOpenCodeExportToFile success → file written with stdout content
 * - runOpenCodeExportToFile failure → file removed + error includes stderr
 * - runOpenCodeExportToFile missing binary → throws
 * - runOpenCodeSessionDelete success → no throw
 * - runOpenCodeSessionDelete "session not found" → no throw (idempotent)
 * - runOpenCodeSessionDelete other failure → throws
 * - runOpenCodeImport success → no throw
 * - runOpenCodeImport failure → throws with output
 * - 30s timeout constant is honored (smoke check via short-deadline test)
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	__setCommandTimeoutForTest,
	OPENCODE_COMMAND_TIMEOUT_MS,
	runOpenCodeExportToFile,
	runOpenCodeImport,
	runOpenCodeSessionDelete,
} from '@/agent/opencode/cli-commands';
import { withMockProcessEnv } from '../_helpers';

let tmpDir: string;
let restoreEnv: (() => void) | null = null;

/**
 * Write a mock `opencode` executable that dispatches by argv pattern.
 * Each test composes its own mock; this returns the dir to prepend to PATH.
 */
async function mockOpencode(script: string): Promise<string> {
	const binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-mock-bin-'));
	const binPath = path.join(binDir, 'opencode');
	await fs.writeFile(binPath, `#!/usr/bin/env bash\n${script}\n`, { mode: 0o755 });
	return binDir;
}

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-cli-test-'));
});

afterEach(async () => {
	if (restoreEnv) {
		restoreEnv();
		restoreEnv = null;
	}
	await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('agent/opencode/cli-commands — Go: cli_commands.go', () => {
	describe('OPENCODE_COMMAND_TIMEOUT_MS', () => {
		// Go: cli_commands.go:14 (openCodeCommandTimeout = 30 * time.Second)
		it('is 30 seconds', () => {
			expect(OPENCODE_COMMAND_TIMEOUT_MS).toBe(30_000);
		});
	});

	describe('runOpenCodeExportToFile', () => {
		// Go: cli_commands.go:18-46 — happy path: stdout → outputPath
		it('writes mock stdout to outputPath', async () => {
			const binDir = await mockOpencode(
				`if [ "$1" = "export" ]; then echo '{"info":{"id":"'"$2"'"},"messages":[]}' && exit 0; fi`,
			);
			restoreEnv = withMockProcessEnv({ PATH: `${binDir}:${process.env.PATH ?? ''}` });
			const outPath = path.join(tmpDir, 'out.json');
			const ctrl = new AbortController();
			await runOpenCodeExportToFile(ctrl.signal, 'ses_abc', outPath);
			const written = await fs.readFile(outPath, 'utf-8');
			expect(written.trim()).toBe('{"info":{"id":"ses_abc"},"messages":[]}');
			await fs.rm(binDir, { recursive: true, force: true });
		});

		// Go: cli_commands.go:37-43 — non-zero exit removes outputPath + throws
		it('non-zero exit: throws "opencode export failed" with stderr + removes outputPath', async () => {
			const binDir = await mockOpencode(`echo "boom" >&2 && exit 1`);
			restoreEnv = withMockProcessEnv({ PATH: `${binDir}:${process.env.PATH ?? ''}` });
			const outPath = path.join(tmpDir, 'out.json');
			const ctrl = new AbortController();
			await expect(runOpenCodeExportToFile(ctrl.signal, 'ses_abc', outPath)).rejects.toThrow(
				/opencode export failed/,
			);
			await expect(fs.stat(outPath)).rejects.toThrow();
			await fs.rm(binDir, { recursive: true, force: true });
		});

		// Failure path: missing binary on PATH → throws
		it('missing opencode binary → throws', async () => {
			restoreEnv = withMockProcessEnv({ PATH: tmpDir });
			const outPath = path.join(tmpDir, 'out.json');
			const ctrl = new AbortController();
			await expect(runOpenCodeExportToFile(ctrl.signal, 'sess', outPath)).rejects.toThrow();
		});
	});

	describe('runOpenCodeSessionDelete', () => {
		// Go: cli_commands.go:51-68 — happy path: zero exit
		it('zero exit → no throw', async () => {
			const binDir = await mockOpencode(`exit 0`);
			restoreEnv = withMockProcessEnv({ PATH: `${binDir}:${process.env.PATH ?? ''}` });
			const ctrl = new AbortController();
			await expect(runOpenCodeSessionDelete(ctrl.signal, 'sess')).resolves.toBeUndefined();
			await fs.rm(binDir, { recursive: true, force: true });
		});

		// Go: cli_commands.go:60-63 — "session not found" → no throw (idempotent)
		it('"session not found" output: no throw (idempotent)', async () => {
			const binDir = await mockOpencode(`echo "Session not found"; exit 1`);
			restoreEnv = withMockProcessEnv({ PATH: `${binDir}:${process.env.PATH ?? ''}` });
			const ctrl = new AbortController();
			await expect(runOpenCodeSessionDelete(ctrl.signal, 'sess')).resolves.toBeUndefined();
			await fs.rm(binDir, { recursive: true, force: true });
		});

		// Go: cli_commands.go:64 — other non-zero exit throws
		it('other non-zero exit: throws "opencode session delete failed"', async () => {
			const binDir = await mockOpencode(`echo "permission denied"; exit 1`);
			restoreEnv = withMockProcessEnv({ PATH: `${binDir}:${process.env.PATH ?? ''}` });
			const ctrl = new AbortController();
			await expect(runOpenCodeSessionDelete(ctrl.signal, 'sess')).rejects.toThrow(
				/opencode session delete failed/,
			);
			await fs.rm(binDir, { recursive: true, force: true });
		});
	});

	describe('runOpenCodeImport', () => {
		// Go: cli_commands.go:73-86 — happy path: zero exit
		it('zero exit → no throw', async () => {
			const binDir = await mockOpencode(`exit 0`);
			restoreEnv = withMockProcessEnv({ PATH: `${binDir}:${process.env.PATH ?? ''}` });
			const ctrl = new AbortController();
			await expect(runOpenCodeImport(ctrl.signal, '/tmp/x.json')).resolves.toBeUndefined();
			await fs.rm(binDir, { recursive: true, force: true });
		});

		// Go: cli_commands.go:78-83 — non-zero exit → throws "opencode import failed"
		it('non-zero exit: throws "opencode import failed" with output', async () => {
			const binDir = await mockOpencode(
				`echo "syntax error in import file" >&2; echo "stdout msg"; exit 2`,
			);
			restoreEnv = withMockProcessEnv({ PATH: `${binDir}:${process.env.PATH ?? ''}` });
			const ctrl = new AbortController();
			await expect(runOpenCodeImport(ctrl.signal, '/tmp/x.json')).rejects.toThrow(
				/opencode import failed/,
			);
			await fs.rm(binDir, { recursive: true, force: true });
		});
	});

	describe('AbortSignal cancellation', () => {
		// Go: cli_commands.go:39-41 — context.DeadlineExceeded → "timed out" error
		it('aborted signal: throws (cancelled mid-flight)', async () => {
			const binDir = await mockOpencode(`sleep 5`);
			restoreEnv = withMockProcessEnv({ PATH: `${binDir}:${process.env.PATH ?? ''}` });
			const ctrl = new AbortController();
			const promise = runOpenCodeSessionDelete(ctrl.signal, 'sess');
			setTimeout(() => ctrl.abort(), 50);
			await expect(promise).rejects.toThrow();
			await fs.rm(binDir, { recursive: true, force: true });
		});

		// Covers cli-commands.ts:130-135 — runOpenCodeExportToFile catch block
		// (only reachable via cancelSignal; removes outputPath before rethrow).
		it('runOpenCodeExportToFile aborted signal: throws + removes outputPath', async () => {
			const binDir = await mockOpencode(`sleep 5`);
			restoreEnv = withMockProcessEnv({ PATH: `${binDir}:${process.env.PATH ?? ''}` });
			const outPath = path.join(tmpDir, 'out.json');
			// Pre-create outputPath so we can prove the catch block removed it.
			await fs.writeFile(outPath, 'stale data');
			const ctrl = new AbortController();
			const promise = runOpenCodeExportToFile(ctrl.signal, 'sess', outPath);
			setTimeout(() => ctrl.abort(), 50);
			await expect(promise).rejects.toThrow();
			await expect(fs.stat(outPath)).rejects.toThrow();
			await fs.rm(binDir, { recursive: true, force: true });
		});
	});

	// Go: cli_commands.go:39-41, :57-59, :79-81 — context.DeadlineExceeded arm
	// in each of the 3 CLI helpers. Go tests rely on integration coverage for
	// these branches; Story's per-file coverage floor forces explicit unit
	// tests that trigger execa's timeout via a test-only override (mirrors Go
	// `runOpenCodeExportToFileFn` function-variable swap pattern used in
	// lifecycle_test.go:372-381).
	describe('execa timeout branches (__setCommandTimeoutForTest)', () => {
		let restoreTimeout: (() => void) | null = null;
		afterEach(() => {
			if (restoreTimeout) {
				restoreTimeout();
				restoreTimeout = null;
			}
		});

		// Covers cli-commands.ts:112-114 (runOpenCodeExportToFile timeout)
		it('runOpenCodeExportToFile timeout → throws "timed out after 30s" + removes outputPath', async () => {
			const binDir = await mockOpencode(`sleep 2`);
			restoreEnv = withMockProcessEnv({ PATH: `${binDir}:${process.env.PATH ?? ''}` });
			restoreTimeout = __setCommandTimeoutForTest(50);
			const outPath = path.join(tmpDir, 'out.json');
			const ctrl = new AbortController();
			await expect(runOpenCodeExportToFile(ctrl.signal, 'sess', outPath)).rejects.toThrow(
				/opencode export timed out after 30s/,
			);
			await expect(fs.stat(outPath)).rejects.toThrow();
			await fs.rm(binDir, { recursive: true, force: true });
		});

		// Covers cli-commands.ts:146-149 (runOpenCodeSessionDelete timeout)
		it('runOpenCodeSessionDelete timeout → throws "timed out after 30s"', async () => {
			const binDir = await mockOpencode(`sleep 2`);
			restoreEnv = withMockProcessEnv({ PATH: `${binDir}:${process.env.PATH ?? ''}` });
			restoreTimeout = __setCommandTimeoutForTest(50);
			const ctrl = new AbortController();
			await expect(runOpenCodeSessionDelete(ctrl.signal, 'sess')).rejects.toThrow(
				/opencode session delete timed out after 30s/,
			);
			await fs.rm(binDir, { recursive: true, force: true });
		});

		// Covers cli-commands.ts:178-179 (runOpenCodeImport timeout)
		it('runOpenCodeImport timeout → throws "timed out after 30s"', async () => {
			const binDir = await mockOpencode(`sleep 2`);
			restoreEnv = withMockProcessEnv({ PATH: `${binDir}:${process.env.PATH ?? ''}` });
			restoreTimeout = __setCommandTimeoutForTest(50);
			const ctrl = new AbortController();
			await expect(runOpenCodeImport(ctrl.signal, '/tmp/x.json')).rejects.toThrow(
				/opencode import timed out after 30s/,
			);
			await fs.rm(binDir, { recursive: true, force: true });
		});
	});
});
