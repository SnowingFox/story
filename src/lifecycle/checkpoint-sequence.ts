/**
 * Allocate the next checkpoint sequence number for a subagent task's
 * incremental checkpoints.
 *
 * Go anchor: `entire-cli/cmd/entire/cli/state.go: GetNextCheckpointSequence`.
 *
 * TS-divergence: scans filenames matching `^(\d{3})-` and returns `max+1`
 * (gap-preserving — if only `003-*.json` exists, returns `4`). The Go
 * implementation at `state.go` counts `.json` files and returns
 * `count+1` (gap-collapsing — for the same input it returns `2`). Story's
 * approach is defensible when checkpoint files can be deleted / pruned
 * mid-session and we need monotonic sequence numbers; it does allocate a
 * different literal number than Go for the same directory state.
 *
 * The directory structure mirrors `src/strategy/constants.ts: taskMetadataDir`:
 * `.story/metadata/<sessionId>/tasks/<toolUseId>/checkpoints/`.
 *
 * @packageDocumentation
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { storyMetadataDirForSession, worktreeRoot } from '@/paths';
import { taskMetadataDir } from '@/strategy/constants';

const SEQUENCE_PATTERN = /^(\d{3})-/;

/**
 * Return the next checkpoint sequence number for the given subagent task.
 *
 * @example
 * await getNextCheckpointSequence('sid-1', 'toolu_abc');
 * // If checkpoints/ has 001-a.json, 002-b.json → 3
 * // If checkpoints/ is missing or empty → 1
 *
 * // Side effects: read-only fs.readdir on the checkpoints/ dir.
 */
export async function getNextCheckpointSequence(
	sessionID: string,
	taskToolUseID: string,
): Promise<number> {
	const root = await worktreeRoot().catch(() => process.cwd());
	const sessionDir = storyMetadataDirForSession(sessionID);
	const checkpointsDir = path.join(root, taskMetadataDir(sessionDir, taskToolUseID), 'checkpoints');
	let names: string[];
	try {
		names = await fs.readdir(checkpointsDir);
	} catch {
		return 1;
	}
	let max = 0;
	for (const name of names) {
		const m = SEQUENCE_PATTERN.exec(name);
		if (!m) {
			continue;
		}
		const n = Number.parseInt(m[1]!, 10);
		if (Number.isFinite(n) && n > max) {
			max = n;
		}
	}
	return max + 1;
}
