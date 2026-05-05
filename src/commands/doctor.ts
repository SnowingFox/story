/**
 * `story doctor` — sequential diagnostic checks + per-problem confirm/fix.
 *
 * Pipeline (Go `doctor.go: newDoctorCmd + runSessionsFix`):
 *   1. Require git repo + Story enabled.
 *   2. Determine v2 gate via `isCheckpointsV2Enabled(settings)`.
 *   3. Run checks sequentially: hook install → metadata reachable →
 *      (v2 only) v2 ref existence → (v2 only) v2 checkpoint counts →
 *      stuck sessions.
 *   4. For each `Problem`, confirm (yesDefault=true, `--force` skip)
 *      then run the closure.
 *   5. Summary line `● N problems fixed, M checks passed`.
 *
 * Algorithm-level work lives in
 * [`@/strategy/doctor-checks`](../strategy/doctor-checks.ts); this file
 * is pure CLI orchestration.
 *
 * @packageDocumentation
 */

import type { CAC } from 'cac';
import { applyGlobalFlags } from '@/cli/flags';
import { getRootSignal } from '@/cli/runtime';
import { SilentError } from '@/errors';
import { worktreeRoot } from '@/paths';
import { isCheckpointsV2Enabled, isEnabled, isSetUpAny, readSettings } from '@/settings/settings';
import {
	type CheckResult,
	checkHookInstallation,
	checkMetadataReachable,
	checkStuckSessions,
	checkV2CheckpointCounts,
	checkV2RefExistence,
	type Problem,
} from '@/strategy/doctor-checks';
import {
	barEmpty,
	barLine,
	confirm,
	errorLine,
	footer,
	header,
	step,
	stepDone,
	stepError,
	warn,
} from '@/ui';
import { color } from '@/ui/theme';

/**
 * Register `story doctor` on a cac instance. Call once from
 * {@link ./index::registerCoreCommands}.
 *
 * Go: `doctor.go: newDoctorCmd`.
 *
 * @example
 * registerDoctorCommand(cli);
 * // Now resolvable:
 * //   story doctor
 * //   story doctor --force
 */
export function registerDoctorCommand(cli: CAC): void {
	cli
		.command('doctor', 'Diagnose and fix Story state')
		.option('-f, --force', 'Auto-fix all detected problems without prompting')
		.action(async (rawFlags: Record<string, unknown>) => {
			applyGlobalFlags(rawFlags);
			const force = rawFlags.force === true;
			await runDoctor({ force });
		});
}

/**
 * Main doctor pipeline. Narrow enough that each test case can call it
 * directly via {@link registerDoctorCommand}.
 *
 * Mirrors Go `doctor.go: runSessionsFix`.
 *
 * @example
 * await runDoctor({ force: false });
 * // Side effects on the happy path:
 * //   stdout ← "┌  story doctor" + per-check summary + footer
 * //   `Problem.fix()` closures may write git refs / state files / hooks
 * //
 * // On missing .story/: throws SilentError before any output.
 */
async function runDoctor(opts: { force: boolean }): Promise<void> {
	let repoRoot: string;
	try {
		repoRoot = await worktreeRoot(process.cwd());
	} catch {
		throw new SilentError(new Error('Not a git repository'));
	}

	if (!(await isSetUpAny(repoRoot))) {
		throw new SilentError(
			new Error(
				"Story is not enabled in this repository | No .story/ directory or Story git hooks found here. Run 'story enable' first, then try again.",
			),
		);
	}
	if (!(await isEnabled(repoRoot))) {
		header('story doctor');
		barEmpty();
		barLine(`${color.dim('○')} Story is disabled in this repository.`);
		barEmpty();
		footer(color.dim("Run 'story enable' to turn it back on."));
		return;
	}

	header(opts.force ? 'story doctor --force' : 'story doctor');
	barEmpty();
	if (opts.force) {
		warn('--force: auto-fixing all problems without prompting.');
	}

	const settings = await readSettings(repoRoot);
	const v2 = isCheckpointsV2Enabled(settings);

	const checks: Array<(ctx: { repoRoot: string }) => Promise<CheckResult>> = [
		checkHookInstallation,
		checkMetadataReachable,
	];
	if (v2) {
		checks.push(checkV2RefExistence, checkV2CheckpointCounts);
	}
	checks.push(checkStuckSessions);

	step('Scanning Story state');
	const results: CheckResult[] = [];
	for (const check of checks) {
		try {
			const result = await check({ repoRoot });
			results.push(result);
			printCheckResult(result);
		} catch (err) {
			errorLine(`check failed: ${err instanceof Error ? err.message : String(err)}`);
			// Continue with remaining checks — Go also surfaces-then-continues.
		}
	}
	barEmpty();

	const allProblems = results.flatMap((r) => r.problems);
	if (allProblems.length === 0) {
		stepDone('All checks passed');
		footer();
		return;
	}

	let fixed = 0;
	let skipped = 0;
	let failed = 0;
	for (const problem of allProblems) {
		if (problem.fix === undefined) {
			barLine(`${color.dim('○')} No automatic fix available: ${problem.summary}`);
			skipped++;
			continue;
		}
		let proceed = opts.force;
		if (!opts.force) {
			proceed = await confirm({
				message: `Fix: ${problem.summary}?`,
				yesDefault: true,
				signal: getRootSignal(),
			}).catch((err) => {
				if (err instanceof SilentError) {
					// User cancelled → skip this problem.
					return false;
				}
				throw err;
			});
		}
		if (!proceed) {
			skipped++;
			continue;
		}
		try {
			await problem.fix();
			fixed++;
			stepDone(`Fixed: ${problem.summary}`);
		} catch (err) {
			stepError(`Failed to fix: ${problem.summary}`);
			errorLine(err instanceof Error ? err.message : String(err));
			failed++;
		}
	}

	const passed = results.filter((r) => r.passed).length;
	const summary = [`${fixed} problems fixed`, `${passed} checks passed`];
	if (skipped > 0) {
		summary.push(`${skipped} skipped`);
	}
	if (failed > 0) {
		summary.push(`${failed} failed`);
		process.exitCode = 1;
	}
	stepDone(summary.join(', '));
	footer(color.dim("Run 'story status' to verify."));
}

/**
 * Render one {@link CheckResult} as a `●` / `■` bar row. `counters`
 * (if present) shows as a right-aligned note.
 *
 * @internal
 */
function printCheckResult(result: CheckResult): void {
	const counters = result.counters ? `  (${result.counters})` : '';
	const bullet = result.passed ? color.green('●') : color.red('■');
	barLine(`${bullet} ${result.name}${counters}`);
	if (!result.passed) {
		for (const problem of result.problems) {
			printProblem(problem);
		}
	}
}

/**
 * Render a single {@link Problem} as a `■` summary + optional dim detail line.
 *
 * @internal
 */
function printProblem(problem: Problem): void {
	barLine(`  ${color.red('■')} ${problem.summary}`);
	if (problem.detail) {
		barLine(`    ${color.dim(problem.detail)}`);
	}
}
