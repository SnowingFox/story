/**
 * Phase 9.1 top-level `src/cli.ts` regression tests.
 *
 * Covers two closure concerns from Phase 9.1:
 *   1. The Phase 9.0-era placeholder `console.log(registry.list())` inside
 *      `cli.ts` MUST be gone — we read the source to confirm (grep-style
 *      audit mirror).
 *   2. `buildCli()` must register the 3 new user-facing commands alongside
 *      the pre-existing version / help core.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCli } from '@/cli';
import { resetGlobalFlagsForTesting } from '@/cli/flags';
import { setForceNonInteractive } from '@/cli/tty';
import { resetColorOverrideForTesting, setColorOverride } from '@/ui/theme';

describe('src/cli.ts (Phase 9.1)', () => {
	beforeEach(() => {
		resetGlobalFlagsForTesting();
		resetColorOverrideForTesting();
		setColorOverride(false);
		setForceNonInteractive(true);
	});

	afterEach(() => {
		resetGlobalFlagsForTesting();
		resetColorOverrideForTesting();
		setForceNonInteractive(false);
	});

	// Phase 9.1 legacy.md §1: Phase 9.0 placeholder must be gone.
	it('cli.ts no longer contains the Phase 9.0 `console.log(registry.list())` placeholder', () => {
		const here = path.dirname(fileURLToPath(import.meta.url));
		// tests/unit → tests → repo root → src/cli.ts
		const cliPath = path.resolve(here, '..', '..', 'src', 'cli.ts');
		const src = readFileSync(cliPath, 'utf-8');
		expect(src).not.toMatch(/console\.log\(registry\.list\(\)\)/);
	});

	// Go: setup.go: newEnableCmd / newDisableCmd / newSetupCmd —
	// `registerCoreCommands` must expose all three as first-class commands.
	it('buildCli() registers enable / disable / configure commands', () => {
		const cli = buildCli();
		const names = cli.commands.map((c) => c.name);
		expect(names).toContain('enable');
		expect(names).toContain('disable');
		expect(names).toContain('configure');
	});
});
