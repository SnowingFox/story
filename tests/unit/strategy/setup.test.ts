/**
 * Phase 5.1 strategy/setup.ts unit tests.
 *
 * **TS-only**: Go's `EnsureSetup` / `EnsureEntireGitignore` /
 * `EnsureRedactionConfigured` (`common.go:61-84, 275-303, 957-1009`) have no
 * dedicated `Test*` in `strategy/*_test.go` — they're covered by integration
 * tests in `cmd/entire/cli/integration_test/`. The TS tests below pin the
 * gitignore content + idempotency + DEFER(phase-8) marker contract.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearHooksDirCache, MANAGED_GIT_HOOK_NAMES } from '@/hooks/install';
import { _resetPIIConfigForTests } from '@/redact';
import { ensureRedactionConfigured, ensureSetup, ensureStoryGitignore } from '@/strategy/setup';
import { TestEnv } from '../../helpers/test-env';

// TS-only: Go production lives in common.go:61-1009; no dedicated `Test*`
// in strategy/*_test.go (covered transitively by integration tests).
describe('strategy/setup — Go: common.go:61-1009 (production; integration-only Go coverage)', () => {
	let env: TestEnv;

	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		_resetPIIConfigForTests();
		clearHooksDirCache();
	});

	afterEach(async () => {
		await env.cleanup();
		_resetPIIConfigForTests();
		clearHooksDirCache();
	});

	describe('ensureStoryGitignore', () => {
		it('creates .story/.gitignore when missing', async () => {
			await ensureStoryGitignore(env.dir);
			const content = await fs.readFile(path.join(env.dir, '.story/.gitignore'), 'utf-8');
			expect(content).toContain('logs/');
			expect(content).toContain('tmp/');
		});

		// Go: common.go:957-1009 EnsureEntireGitignore writes 4 entries:
		//   tmp/, settings.local.json, metadata/, logs/
		// IMPL GAP: current TS impl only writes 2 (logs/, tmp/) — missing
		// settings.local.json and metadata/. This test will fail until impl is
		// updated to match Go's 4-entry list.
		it('writes Go-aligned 4 entries (logs/, tmp/, settings.local.json, metadata/) — Go: common.go:957-1009', async () => {
			await ensureStoryGitignore(env.dir);
			const content = await fs.readFile(path.join(env.dir, '.story/.gitignore'), 'utf-8');
			expect(content).toContain('logs/');
			expect(content).toContain('tmp/');
			expect(content).toContain('settings.local.json');
			expect(content).toContain('metadata/');
		});

		it('is idempotent (no duplicate entries on re-run)', async () => {
			await ensureStoryGitignore(env.dir);
			const first = await fs.readFile(path.join(env.dir, '.story/.gitignore'), 'utf-8');
			await ensureStoryGitignore(env.dir);
			const second = await fs.readFile(path.join(env.dir, '.story/.gitignore'), 'utf-8');
			expect(second).toBe(first);
		});

		it('appends missing entries to an existing .gitignore', async () => {
			const dotStory = path.join(env.dir, '.story');
			await fs.mkdir(dotStory, { recursive: true });
			await fs.writeFile(path.join(dotStory, '.gitignore'), '# user comment\nlogs/\n', 'utf-8');

			await ensureStoryGitignore(env.dir);

			const content = await fs.readFile(path.join(dotStory, '.gitignore'), 'utf-8');
			expect(content).toContain('# user comment');
			expect(content).toContain('logs/');
			expect(content).toContain('tmp/');
		});

		it('handles existing gitignore without trailing newline', async () => {
			const dotStory = path.join(env.dir, '.story');
			await fs.mkdir(dotStory, { recursive: true });
			await fs.writeFile(path.join(dotStory, '.gitignore'), 'logs/', 'utf-8'); // no \n

			await ensureStoryGitignore(env.dir);

			const content = await fs.readFile(path.join(dotStory, '.gitignore'), 'utf-8');
			// previously-missing entry added with proper newline separator
			expect(content).toMatch(/logs\/\ntmp\/\n/);
		});
	});

	describe('ensureRedactionConfigured', () => {
		it('does not throw and leaves redaction off (Phase 5.1 default)', async () => {
			await expect(ensureRedactionConfigured(env.dir)).resolves.toBeUndefined();
		});
	});

	describe('ensureSetup', () => {
		it('runs all 3 steps successfully (gitignore + redaction + metadata branch)', async () => {
			await ensureSetup(env.dir);

			// 1. .story/.gitignore created
			const content = await fs.readFile(path.join(env.dir, '.story/.gitignore'), 'utf-8');
			expect(content).toContain('logs/');

			// 2. metadata branch created
			const { stdout } = await env.exec('git', ['branch', '--list', 'story/checkpoints/v1']);
			expect(stdout).toContain('story/checkpoints/v1');
		});

		it('is idempotent', async () => {
			await ensureSetup(env.dir);
			await ensureSetup(env.dir);
			// no exception = success
		});

		// Phase 8 — hook installation consumed the DEFER(phase-8) marker.
		it('// DEFER(phase-8): marker has been removed from setup.ts', async () => {
			const src = await fs.readFile(
				path.join(__dirname, '../../../src/strategy/setup.ts'),
				'utf-8',
			);
			expect(src).not.toContain('// DEFER(phase-8):');
		});

		// Phase 8 — ensureSetup installs the 5 git hooks.
		it('installs 5 git hooks into .git/hooks/ with correct marker', async () => {
			await ensureSetup(env.dir);
			const hooksDir = path.join(env.dir, '.git', 'hooks');
			for (const name of MANAGED_GIT_HOOK_NAMES) {
				const content = await fs.readFile(path.join(hooksDir, name), 'utf-8');
				expect(content).toContain('Story CLI hooks');
				expect(content).toContain(`story hooks git ${name}`);
			}
		});

		it('installed hook files are executable (0o755)', async () => {
			await ensureSetup(env.dir);
			const hooksDir = path.join(env.dir, '.git', 'hooks');
			for (const name of MANAGED_GIT_HOOK_NAMES) {
				const st = await fs.stat(path.join(hooksDir, name));
				expect(st.mode & 0o100).toBe(0o100);
			}
		});

		it('hook installation is idempotent — second ensureSetup does not error', async () => {
			await ensureSetup(env.dir);
			await ensureSetup(env.dir);
			// no throw = success; content still correct
			const hooksDir = path.join(env.dir, '.git', 'hooks');
			const content = await fs.readFile(path.join(hooksDir, 'post-commit'), 'utf-8');
			expect(content).toContain('Story CLI hooks');
		});

		it('Husky present → ensureSetup emits hook-manager warning on stderr', async () => {
			await fs.mkdir(path.join(env.dir, '.husky', '_'), { recursive: true });
			const chunks: string[] = [];
			const origWrite = process.stderr.write.bind(process.stderr);
			process.stderr.write = ((c: string | Uint8Array, ...rest: unknown[]) => {
				chunks.push(typeof c === 'string' ? c : Buffer.from(c).toString('utf-8'));
				return origWrite(c as string, ...(rest as []));
			}) as typeof process.stderr.write;

			try {
				await ensureSetup(env.dir);
			} finally {
				process.stderr.write = origWrite;
			}

			const stderr = chunks.join('');
			expect(stderr).toContain('Warning: Husky detected');
		});
	});
});
