/**
 * Five diagnostic checks used by `story doctor`. Each returns a
 * {@link CheckResult} with a boolean pass flag + an array of
 * {@link Problem}s; command-layer code ([`src/commands/doctor.ts`](
 * ../commands/doctor.ts)) threads them together and decides which
 * ones to confirm/fix.
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/doctor.go`:
 *   - `checkDisconnectedMetadata`  (doctor.go:367)
 *   - `checkDisconnectedV2Main`    (doctor.go:423)
 *   - `checkV2RefExistence`        (doctor.go:631)
 *   - `checkV2CheckpointCounts`    (doctor.go:585)
 *   - (stuck sessions are a Story add-on; Go inlines inside
 *     `runSessionsFix` at doctor.go:79)
 *
 * Reconcile logic itself lives in Phase 5.6
 * [`metadata-reconcile.ts`](./metadata-reconcile.ts); the doctor
 * checks here only detect + propose — fixes are closures that delegate
 * to those 5.6 exports.
 *
 * @packageDocumentation
 */

import fsCallback from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import git from 'isomorphic-git';
import {
	METADATA_BRANCH_NAME,
	V2_FULL_CURRENT_REF_NAME,
	V2_MAIN_REF_NAME,
} from '@/checkpoint/constants';
import { V2GitStore } from '@/checkpoint/v2-store';
import { execGit } from '@/git';
import {
	isGitHookInstalled as _isAllGitHooksInstalled,
	MANAGED_GIT_HOOK_NAMES,
	STORY_HOOK_MARKER,
} from '@/hooks/install';
import * as log from '@/log';
import { SESSION_STATE_DIR_NAME } from '@/paths';
import { Event, NoOpActionHandler } from '@/session/phase';
import { isStuckActive, StateStore } from '@/session/state-store';
import {
	reconcileDisconnectedMetadataBranch,
	reconcileDisconnectedV2Ref,
} from './metadata-reconcile';
import { getGitCommonDir } from './repo';
import { transitionAndLog } from './session-state';

// Keep the barrel export alive so future callers can locate `isAllGitHooksInstalled`
// without needing to know the Phase 8 module path.
void _isAllGitHooksInstalled;

/**
 * One actionable finding from a check.
 *
 * - `summary` — short 1-line label printed next to `■`.
 * - `detail`  — optional dim-print second line (reason / ref path / …).
 * - `fix`     — closure invoked after user confirms; `undefined` when the
 *               problem has no automated remediation.
 */
export interface Problem {
	summary: string;
	detail?: string;
	fix?: () => Promise<void>;
}

/** Outcome of one check. `name` is uniquely identifying (used in UI). */
export interface CheckResult {
	name: string;
	passed: boolean;
	counters?: string;
	problems: Problem[];
}

/** Context carried by every check — narrow on purpose so tests can inject. */
export interface DoctorCtx {
	repoRoot: string;
}

/**
 * True when `hooksDir/<name>` exists AND contains the
 * {@link STORY_HOOK_MARKER} line (so we don't mistake a Husky / manual
 * hook for a Story-installed one). Missing file / read error → `false`
 * without throwing, so callers can report "missing" uniformly.
 *
 * @internal
 */
async function checkSingleHookInstalled(hooksDir: string, name: string): Promise<boolean> {
	try {
		const data = await fs.readFile(path.join(hooksDir, name), 'utf-8');
		return data.includes(STORY_HOOK_MARKER);
	} catch {
		return false;
	}
}

/**
 * Verify each of the 5 Story-managed git hooks is installed with the
 * `# Story CLI hooks` marker line. Failing hooks surface as individual
 * {@link Problem}s whose `fix` closure runs `installGitHooks` (scoped to
 * the single hook only — Phase 8 `installGitHooks` is idempotent so we
 * call it in full and let it re-write whatever is missing).
 *
 * Mirrors the Story doctor-surface refinement of Go's inline hook probe
 * inside `doctor.go: runSessionsFix`.
 *
 * @example
 * await checkHookInstallation({ repoRoot: '/repo' });
 * // returns: { name: 'git hooks installed', passed: false, counters: '4/5', problems: [{ summary: 'pre-push hook missing', fix: async () => { ... } }] }
 *
 * // Side effects: read-only — up to 5 `fs.readFile` calls on `.git/hooks/`.
 */
export async function checkHookInstallation(ctx: DoctorCtx): Promise<CheckResult> {
	const hooksDir = path.join(ctx.repoRoot, '.git', 'hooks');
	const problems: Problem[] = [];
	let installed = 0;
	for (const name of MANAGED_GIT_HOOK_NAMES) {
		if (await checkSingleHookInstalled(hooksDir, name)) {
			installed++;
			continue;
		}
		problems.push({
			summary: `${name} hook missing`,
			detail: `.git/hooks/${name} not found or lacks the Story marker`,
			fix: async () => {
				const { installGitHooks } = await import('@/hooks/install');
				await installGitHooks(ctx.repoRoot);
			},
		});
	}
	return {
		name: 'git hooks installed',
		passed: installed === MANAGED_GIT_HOOK_NAMES.length,
		counters: `${installed}/${MANAGED_GIT_HOOK_NAMES.length}`,
		problems,
	};
}

/**
 * Confirm the v1 metadata branch (`story/checkpoints/v1`) either does
 * not exist yet or resolves to a readable commit object.
 *
 * Mirrors Go `doctor.go:367 checkDisconnectedMetadata`. Story reduces
 * the surface to a single "readable?" probe — the full disconnect
 * detection + cherry-pick recovery lives in
 * [`metadata-reconcile.ts`](./metadata-reconcile.ts) (shipped by Phase
 * 5.6) and is wired through `Problem.fix`.
 *
 * @example
 * await checkMetadataReachable({ repoRoot: '/repo' });
 * // fresh repo: { name: 'story/checkpoints/v1 reachable', passed: true, problems: [] }
 * // dangling ref: { name: '…', passed: false, problems: [{ summary: 'story/checkpoints/v1 unreachable', fix: async () => { await reconcileDisconnectedMetadataBranch(...) } }] }
 *
 * // Side effects: read-only — `git rev-parse` + `git.readCommit`.
 */
export async function checkMetadataReachable(ctx: DoctorCtx): Promise<CheckResult> {
	const name = `${METADATA_BRANCH_NAME} reachable`;
	let hash: string;
	try {
		hash = (
			await execGit(['rev-parse', '--verify', '--quiet', `refs/heads/${METADATA_BRANCH_NAME}`], {
				cwd: ctx.repoRoot,
			})
		).trim();
	} catch {
		// Ref absent → "fresh repo" interpretation: passes.
		return { name, passed: true, problems: [] };
	}

	try {
		await git.readCommit({ fs: fsCallback, dir: ctx.repoRoot, oid: hash });
		return { name, passed: true, problems: [] };
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		return {
			name,
			passed: false,
			problems: [
				{
					summary: `${METADATA_BRANCH_NAME} unreachable`,
					detail,
					fix: async () => {
						// Phase 5.6 reconcile — empty remote means no fetch target,
						// but the fix surfaces the helper for future wiring.
						await reconcileDisconnectedMetadataBranch(
							ctx.repoRoot,
							`refs/remotes/origin/${METADATA_BRANCH_NAME}`,
							process.stderr,
						);
					},
				},
			],
		};
	}
}

/**
 * Probe `git rev-parse --verify --quiet <ref>`. `true` when the ref
 * resolves; `false` for any failure (missing ref, corrupt repo, dangling
 * loose ref, etc.) — we deliberately collapse these because each check
 * decides independently how to interpret "not present" vs "broken".
 *
 * @internal
 */
async function refExists(repoRoot: string, ref: string): Promise<boolean> {
	try {
		await execGit(['rev-parse', '--verify', '--quiet', ref], { cwd: repoRoot });
		return true;
	} catch {
		return false;
	}
}

/**
 * Confirm the v2 ref pair `refs/story/checkpoints/v2/main` +
 * `refs/story/checkpoints/v2/full/current` are either both present (a
 * written repo) or both absent (a fresh one). Exactly one missing is
 * the partial-init failure mode.
 *
 * Mirrors Go `doctor.go:631 checkV2RefExistence`.
 *
 * @example
 * await checkV2RefExistence({ repoRoot: '/repo' });
 * // returns: { name: 'v2 refs', passed: true, problems: [] }   (both present)
 * //       or { name: '…', passed: false, problems: [{ summary: '…', fix: … }] }
 */
export async function checkV2RefExistence(ctx: DoctorCtx): Promise<CheckResult> {
	const name = 'v2 refs';
	const hasMain = await refExists(ctx.repoRoot, V2_MAIN_REF_NAME);
	const hasFull = await refExists(ctx.repoRoot, V2_FULL_CURRENT_REF_NAME);

	if (hasMain === hasFull) {
		return { name, passed: true, problems: [] };
	}

	const missingRef = hasMain ? V2_FULL_CURRENT_REF_NAME : V2_MAIN_REF_NAME;
	const presentRef = hasMain ? V2_MAIN_REF_NAME : V2_FULL_CURRENT_REF_NAME;
	return {
		name,
		passed: false,
		problems: [
			{
				summary: `${presentRef} exists but ${missingRef} is missing`,
				fix: async () => {
					await reconcileDisconnectedV2Ref(ctx.repoRoot, 'origin', process.stderr);
				},
			},
		],
	};
}

/**
 * Compare the number of checkpoints reachable from `refs/story/checkpoints/v2/main`
 * versus `refs/story/checkpoints/v2/full/current`. `/main` is the
 * permanent accumulator so its count must be ≥ `/full/current`'s.
 *
 * Mirrors Go `doctor.go:585 checkV2CheckpointCounts`. Short-circuits
 * (passes silently) when either ref is missing — that's
 * {@link checkV2RefExistence}'s job.
 *
 * @example
 * await checkV2CheckpointCounts({ repoRoot: '/repo' });
 * // returns: { name: 'v2 checkpoint counts', passed: true, counters: 'main: 12, full: 12', problems: [] }
 * //       or { name: '…', passed: false, problems: [{ summary: '…', fix: … }] }
 */
export async function checkV2CheckpointCounts(ctx: DoctorCtx): Promise<CheckResult> {
	const name = 'v2 checkpoint counts';
	const hasMain = await refExists(ctx.repoRoot, V2_MAIN_REF_NAME);
	const hasFull = await refExists(ctx.repoRoot, V2_FULL_CURRENT_REF_NAME);
	if (!hasMain || !hasFull) {
		return { name, passed: true, problems: [] };
	}

	const store = new V2GitStore(ctx.repoRoot, 'origin');
	try {
		const mainState = await store.getRefState(V2_MAIN_REF_NAME);
		const fullState = await store.getRefState(V2_FULL_CURRENT_REF_NAME);
		const mainCount = await store.countCheckpointsInTree(mainState.treeHash);
		const fullCount = await store.countCheckpointsInTree(fullState.treeHash);

		if (fullCount > mainCount) {
			return {
				name,
				passed: false,
				counters: `main: ${mainCount}, full: ${fullCount}`,
				problems: [
					{
						summary: `/full/current has ${fullCount} checkpoints but /main has only ${mainCount}`,
						detail: 'Possible partial dual-write failure',
						fix: async () => {
							await reconcileDisconnectedV2Ref(ctx.repoRoot, 'origin', process.stderr);
						},
					},
				],
			};
		}
		return {
			name,
			passed: true,
			counters: `main: ${mainCount}, full: ${fullCount}`,
			problems: [],
		};
	} catch (err) {
		log.debug(
			{ component: 'doctor-checks' },
			'checkV2CheckpointCounts failed; passing (best-effort)',
			{ error: err instanceof Error ? err.message : String(err) },
		);
		return { name, passed: true, problems: [] };
	}
}

/**
 * Scan session state files for ACTIVE-phase sessions that haven't
 * interacted for longer than {@link isStuckActive}'s threshold
 * (1 hour by default — see
 * [`session/state-store.ts: STUCK_ACTIVE_THRESHOLD_MS`](../session/state-store.ts)).
 *
 * Each stuck session becomes a {@link Problem} whose `fix` closure
 * transitions the phase to `ended` via the Phase 3 state machine +
 * stamps `endedAt`, matching what `story sessions stop <id>` does.
 *
 * @example
 * await checkStuckSessions({ repoRoot: '/repo' });
 * // returns: { name: 'stuck sessions', passed: false, counters: '1 stuck', problems: [{ summary: 'sess-abc123 — idle 2h', fix: async () => … }] }
 *
 * // Side effects from `Problem.fix()`:
 * //   <repo>/.git/story-sessions/<id>.json ← phase='ended', endedAt=now
 */
export async function checkStuckSessions(ctx: DoctorCtx): Promise<CheckResult> {
	const name = 'stuck sessions';
	const commonDir = await getGitCommonDir(ctx.repoRoot);
	const store = new StateStore(path.join(commonDir, SESSION_STATE_DIR_NAME));
	const states = await store.list();

	const stuck = states.filter(isStuckActive);
	if (stuck.length === 0) {
		return { name, passed: true, problems: [] };
	}

	const problems: Problem[] = stuck.map((state) => ({
		summary: `${state.sessionId} stuck in ACTIVE phase`,
		detail: `last interaction at ${state.lastInteractionTime ?? state.startedAt}`,
		fix: async () => {
			await transitionAndLog(
				state,
				Event.SessionStop,
				{ hasFilesTouched: false, isRebaseInProgress: false },
				new NoOpActionHandler(),
			);
			state.endedAt = new Date().toISOString();
			await store.save(state);
		},
	}));

	return {
		name,
		passed: false,
		counters: `${stuck.length} stuck`,
		problems,
	};
}
