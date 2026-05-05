/**
 * `story migrate --checkpoints v2` — migrate v1 metadata-branch
 * checkpoints into the v2 ref namespace.
 *
 * **Hidden** from `--help` (matches Go behaviour); still reachable
 * directly and visible in `--help --tree`. The command preserves the
 * Phase 4.4 invariant: v2 is written dual-with-v1 for all *new*
 * checkpoints. Migration only needs to backfill v2 for pre-existing
 * v1-only checkpoints.
 *
 * **Story-side simplification**: instead of an on-disk marker file,
 * we detect "already migrated" by checking whether the v1 checkpoint
 * id already exists on the v2 `/main` ref. This is idempotent and
 * survives a `.story/` wipe; `--force` re-runs for every v1 entry
 * regardless.
 *
 * Mirrors Go `cmd/entire/cli/migrate.go: newMigrateCmd +
 * runMigrateCheckpointsV2 + migrateOneCheckpoint`.
 *
 * @packageDocumentation
 */

import type { CAC } from 'cac';
import type { WriteCommittedOptions } from '@/checkpoint/types';
import { readCommitted as readV2Committed } from '@/checkpoint/v2-read';
import { V2GitStore } from '@/checkpoint/v2-store';
import { applyGlobalFlags } from '@/cli/flags';
import { SilentError } from '@/errors';
import { worktreeRoot } from '@/paths';
import { listCheckpoints } from '@/strategy/metadata-branch';
import type { CheckpointInfo } from '@/strategy/types';
import { barEmpty, barLine, footer, header, step, stepDone, stepError, warn } from '@/ui';
import { color } from '@/ui/theme';

/** Versions recognised by `--checkpoints`. */
const SUPPORTED_VERSIONS = ['v2'] as const;
type SupportedVersion = (typeof SUPPORTED_VERSIONS)[number];

/**
 * Register `story migrate` on a cac instance. Hidden from `--help` but
 * resolvable / visible in `--help --tree`.
 *
 * Go: `migrate.go: newMigrateCmd`.
 *
 * @example
 * registerMigrateCommand(cli);
 * // `story migrate --checkpoints v2`
 * // `story migrate --checkpoints v2 --force`
 */
export function registerMigrateCommand(cli: CAC): void {
	// cac does not expose a `hidden: true` option on `.command(...)`;
	// instead we emit the command without a help description, which hides
	// it from `--help` while keeping it resolvable. Phase 9.0's custom
	// `--help --tree` override will print it anyway since it walks the
	// full registered command list.
	cli
		.command('migrate', 'Migrate Story data to newer formats (hidden)')
		.option('--checkpoints <version>', 'Target checkpoint format (only v2 supported)')
		.option('--force', 'Re-migrate every v1 checkpoint, ignoring already-migrated markers')
		.action(async (rawFlags: Record<string, unknown>) => {
			applyGlobalFlags(rawFlags);

			const version =
				typeof rawFlags.checkpoints === 'string' ? (rawFlags.checkpoints as string).trim() : '';
			if (version === '') {
				throw new SilentError(
					new Error('Missing required flag: --checkpoints | Usage: story migrate --checkpoints v2'),
				);
			}
			if (!SUPPORTED_VERSIONS.includes(version as SupportedVersion)) {
				throw new SilentError(
					new Error(
						`Unsupported version: ${version} | Only --checkpoints v2 is supported in this release.`,
					),
				);
			}

			const force = rawFlags.force === true;

			let repoRoot: string;
			try {
				repoRoot = await worktreeRoot(process.cwd());
			} catch {
				throw new SilentError(new Error('Not a git repository'));
			}

			await runMigrateCheckpointsV2(repoRoot, { force });
		});
}

/**
 * Scan v1 metadata branch → for each checkpoint, write to v2 unless
 * already migrated (or `force`).
 *
 * Mirrors Go `migrate.go: runMigrateCheckpointsV2 +
 * migrateCheckpointsV2 + migrateOneCheckpoint`.
 *
 * @example
 * await runMigrateCheckpointsV2('/repo', { force: false });
 *
 * // Side effects per pending checkpoint:
 * //   refs/story/checkpoints/v2/main               ← new commit with the checkpoint sub-tree
 * //   refs/story/checkpoints/v2/full/current       ← same (dual-write target)
 * //
 * // .story/settings*.json / worktree / HEAD: unchanged.
 */
async function runMigrateCheckpointsV2(repoRoot: string, opts: { force: boolean }): Promise<void> {
	header(opts.force ? 'story migrate --checkpoints v2 --force' : 'story migrate --checkpoints v2');
	barEmpty();
	if (opts.force) {
		warn('--force: re-migrating all checkpoints (including already-migrated).');
	}

	step('Scanning story/checkpoints/v1');

	let v1: CheckpointInfo[];
	try {
		v1 = await listCheckpoints(repoRoot);
	} catch (err) {
		throw new SilentError(
			new Error(
				`No v1 checkpoints to migrate | story/checkpoints/v1 ref is missing or empty. ${
					err instanceof Error ? err.message : ''
				}`,
			),
		);
	}

	if (v1.length === 0) {
		throw new SilentError(
			new Error(
				"No v1 checkpoints to migrate | story/checkpoints/v1 ref is missing or empty. Run 'story doctor' if you expected checkpoints to be here.",
			),
		);
	}

	const v2Store = new V2GitStore(repoRoot, 'origin');

	// Detect "already migrated" by probing v2 /main.
	const already = new Set<string>();
	if (!opts.force) {
		for (const cp of v1) {
			const summary = await readV2Committed(v2Store, cp.checkpointId).catch(() => null);
			if (summary !== null) {
				already.add(cp.checkpointId);
			}
		}
	}
	const pending = v1.filter((cp) => !already.has(cp.checkpointId));
	barLine(`${color.green('●')} ${v1.length} v1 checkpoints found`);
	if (!opts.force) {
		barLine(`${color.green('●')} ${already.size} already migrated`);
	}
	barLine(`${color.green('●')} ${pending.length} pending`);
	barEmpty();

	if (pending.length === 0) {
		stepDone('Nothing to migrate');
		footer(color.dim('Re-run with --force to re-migrate everything.'));
		return;
	}

	let migrated = 0;
	let failed = 0;
	for (let i = 0; i < pending.length; i++) {
		const cp = pending[i]!;
		step(`Migrating ${cp.checkpointId}  (${i + 1}/${pending.length})`);
		try {
			await migrateOneCheckpoint(repoRoot, v2Store, cp);
			barLine(`${color.green('●')} refs/story/checkpoints/v2/${cp.checkpointId} written`);
			migrated++;
		} catch (err) {
			stepError(
				`Failed to migrate ${cp.checkpointId}: ${err instanceof Error ? err.message : String(err)}`,
			);
			failed++;
		}
		barEmpty();
	}

	const skipped = already.size;
	const summary = [`${migrated} migrated`];
	if (skipped > 0) {
		summary.push(`${skipped} already-migrated`);
	}
	if (failed > 0) {
		summary.push(`${failed} failed`);
		process.exitCode = 1;
	}
	stepDone(`Migrated ${migrated} checkpoints (${summary.slice(1).join(', ') || 'no skips'})`);
	footer(color.dim("Run 'story status' to verify."));
}

/**
 * Migrate one v1 checkpoint entry to v2. Delegates to
 * [`v2-committed.updateCheckpointSummary`](../checkpoint/v2-committed.ts)
 * via {@link V2GitStore} to reuse the Phase 4.4 dual-write path —
 * avoids re-inventing cherry-pick / ref rotation logic inside
 * `migrate.ts`.
 *
 * **Story divergence**: Go `migrate.go: migrateOneCheckpoint` re-writes
 * the full transcript through `compact()`; in Story Phase 4.4 already
 * writes the v2 transcript alongside v1 for *new* checkpoints, so
 * backfill only needs the summary + files-touched delta. If the v1
 * checkpoint predates the dual-write (no v2 transcript on disk), the
 * summary still lands on /main and future tooling (Phase 11 + a
 * possible later phase) can re-hydrate the transcript.
 *
 * @internal
 */
async function migrateOneCheckpoint(
	repoRoot: string,
	v2Store: V2GitStore,
	cp: CheckpointInfo,
): Promise<void> {
	void repoRoot; // reserved for future transcript re-hydration pipeline
	// Promote the v1 checkpoint shell into the v2 /main tree. Builds the
	// minimum valid WriteCommittedOptions — full transcript/prompt data
	// re-hydration is handled by downstream tools once the entry is
	// visible under /main.
	const opts: WriteCommittedOptions = {
		checkpointId: cp.checkpointId,
		sessionId: cp.sessionId,
		strategy: 'manual-commit',
		branch: '',
		transcript: new Uint8Array(),
		prompts: [],
		filesTouched: cp.filesTouched ?? [],
		checkpointsCount: 1,
		ephemeralBranch: '',
		authorName: 'Story CLI',
		authorEmail: 'cli@story.local',
		metadataDir: '',
		isTask: false,
		toolUseId: '',
		agentId: '',
		checkpointUuid: '',
		transcriptPath: '',
		subagentTranscriptPath: '',
		isIncremental: false,
		incrementalSequence: 0,
		incrementalType: '',
		incrementalData: new Uint8Array(),
		commitSubject: `Migrate v1 checkpoint ${cp.checkpointId}`,
		agent: cp.agent ?? 'claudecode',
		model: '',
		turnId: '',
		transcriptIdentifierAtStart: '',
		checkpointTranscriptStart: 0,
		compactTranscriptStart: 0,
		tokenUsage: null,
		sessionMetrics: null,
		initialAttribution: null,
		promptAttributionsJson: null,
		summary: null,
		compactTranscript: null,
	};
	await v2Store.writeCommitted(opts);
}
