/**
 * `hooks-post-commit-attribution.ts` — Cross-session attribution merge for
 * Phase 5.4 PostCommit.
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/strategy/manual_commit_hooks.go`:
 *   - `updateCombinedAttributionForCheckpoint`
 *
 * Computes a single holistic `InitialAttribution` across all sessions on a
 * checkpoint by diffing parent→HEAD once and classifying each line as agent
 * or human based on the union of all sessions' `filesTouched`. Avoids the
 * inflation that would result from summing per-session numbers (each session
 * independently counts the full commit).
 *
 * **Story-side path filter divergence**: this helper filters
 * `.story/metadata/` (Story's own session dir) + `.claude/` (Claude Code
 * session dir — agent tooling, not user code) but **does NOT** filter
 * `.entire/` — Story never writes to that directory, so any `.entire/`
 * content is legitimate user-owned files. This matches the Story-side
 * decision in Part 1's `calculatePromptAttributionAtStart` and is documented
 * in [`references/story-vs-entire.md`](../../docs/ts-rewrite/impl/references/story-vs-entire.md).
 *
 * **Difference from `calculatePromptAttributionAtStart`**: that helper does
 * NOT filter `.claude/` (because session-start attribution wants every user
 * edit, including Claude config tweaks); cross-attribution DOES filter
 * `.claude/` (because the cross-session metric should not bill the agent for
 * its own scratch files).
 *
 * @packageDocumentation
 */

import type { InitialAttribution } from '@/checkpoint/types';
import type { CheckpointID } from '@/id';
import * as log from '@/log';
import { STORY_METADATA_DIR_NAME } from '@/paths';
import { diffLines, getAllChangedFiles, getFileContent } from './attribution';
import type { ManualCommitStrategy } from './manual-commit';

/**
 * Compute holistic attribution across all sessions on a single checkpoint
 * and persist it via `store.updateCheckpointSummary`. Best-effort: enumeration
 * failures are logged + return; only `updateCheckpointSummary` errors throw.
 *
 * Mirrors Go `manual_commit_hooks.go: updateCombinedAttributionForCheckpoint`.
 *
 * @example
 * await updateCombinedAttributionForCheckpoint(
 *   strategy, checkpointId, headTreeOid, parentTreeOid, repo.root,
 * );
 *
 * // Side effects (when summary has > 1 sessions AND any session has
 * //   checkpointsCount > 0 AND there are non-filtered changed files):
 * //   refs/heads/story/checkpoints/v1   ← bumped (updateCheckpointSummary writes new commit)
 * //   .git/objects/...                  ← new metadata.json with combinedAttribution
 * //
 * // HEAD / index / worktree: unchanged.
 */
export async function updateCombinedAttributionForCheckpoint(
	s: ManualCommitStrategy,
	checkpointId: CheckpointID,
	headTreeOid: string | null,
	parentTreeOid: string | null,
	repoDir: string,
): Promise<void> {
	const store = await s.getCheckpointStore();
	let summary: Awaited<ReturnType<typeof store.readCommitted>>;
	try {
		summary = await store.readCommitted(checkpointId.toString());
	} catch (err) {
		// Mirrors Go `fmt.Errorf("reading checkpoint summary: %w", err)` —
		// caller (postCommitImpl Step 9) catches + logs.
		throw new Error(
			`reading checkpoint summary: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	if (summary === null || summary.sessions.length <= 1) {
		return;
	}

	// Collect agentFiles from sessions with real checkpoints (skip commit-only
	// fallback rows — they used filesTouched fallback that includes ALL
	// committed files, which would falsely classify every change as agent).
	const agentFiles = new Set<string>();
	for (let i = 0; i < summary.sessions.length; i++) {
		let metadata: Awaited<ReturnType<typeof store.readSessionMetadata>>;
		try {
			metadata = await store.readSessionMetadata(checkpointId.toString(), i);
		} catch {
			continue;
		}
		if (metadata === null) {
			continue;
		}
		if (metadata.checkpointsCount === 0) {
			continue; // **CRITICAL** silent invariant — skip commit-only sessions
		}
		for (const f of metadata.filesTouched ?? []) {
			agentFiles.add(f);
		}
	}
	if (agentFiles.size === 0) {
		return;
	}

	// Get all changed files in parent → HEAD (tree-walk path, both hashes empty).
	let allChangedFiles: string[];
	try {
		allChangedFiles = await getAllChangedFiles(
			repoDir,
			parentTreeOid,
			headTreeOid,
			repoDir,
			'',
			'',
		);
	} catch (err) {
		log.warn(
			{ component: 'attribution' },
			'combined attribution: failed to enumerate changed files',
			{ error: err instanceof Error ? err.message : String(err) },
		);
		return;
	}

	let agentAdded = 0;
	let agentRemoved = 0;
	let humanAdded = 0;
	let humanRemoved = 0;
	const metadataPrefix = `${STORY_METADATA_DIR_NAME}/`;
	for (const filePath of allChangedFiles) {
		// **Story-side filter**: drop `.story/metadata/` (Story's own session
		// dir) + `.claude/` (Claude Code session dir — agent tooling, not user
		// code). Go also drops `.entire/`; Story keeps it because Story never
		// writes there — any `.entire/` content in a Story-managed repo is
		// legitimate user files (consistent with calculatePromptAttributionAtStart
		// in Part 1).
		// **Difference from calculatePromptAttributionAtStart**: that helper
		// does NOT filter `.claude/`; this one DOES (cross-session metric
		// should not bill agent for its own scratch files).
		if (filePath.startsWith(metadataPrefix) || filePath.startsWith('.claude/')) {
			continue;
		}

		const parentContent = await getFileContent(repoDir, parentTreeOid, filePath);
		const headContent = await getFileContent(repoDir, headTreeOid, filePath);
		const { added, removed } = diffLines(parentContent, headContent);
		if (agentFiles.has(filePath)) {
			agentAdded += added;
			agentRemoved += removed;
		} else {
			humanAdded += added;
			humanRemoved += removed;
		}
	}

	const totalLinesChanged = agentAdded + agentRemoved + humanAdded + humanRemoved;
	const totalCommitted = agentAdded + humanAdded;
	const agentPercentage =
		totalLinesChanged > 0 ? ((agentAdded + agentRemoved) / totalLinesChanged) * 100 : 0;

	const combined: InitialAttribution = {
		calculatedAt: new Date().toISOString(),
		agentLines: agentAdded,
		agentRemoved,
		humanAdded,
		humanModified: 0,
		humanRemoved,
		totalCommitted,
		totalLinesChanged,
		agentPercentage,
		metricVersion: 2,
	};

	log.info({ component: 'attribution' }, 'combined attribution calculated', {
		checkpointId: checkpointId.toString(),
		sessions: summary.sessions.length,
		agentFiles: agentFiles.size,
		agentLines: agentAdded,
		humanAdded,
		agentPercentage,
	});

	try {
		await store.updateCheckpointSummary(checkpointId.toString(), combined);
	} catch (err) {
		throw new Error(
			`persisting combined attribution: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}
