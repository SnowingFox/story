import fsCallback from 'node:fs';
import fs from 'node:fs/promises';
import git from 'isomorphic-git';
import { redactBytes, redactJSONLBytes } from '../redact';
import { ZERO_HASH } from './tree-ops';

/**
 * Low-level git object writers shared between Phase 4.2 (shadow branch) and
 * Phase 4.3 (metadata branch). Wrap `isomorphic-git`'s plumbing into ergonomic
 * single-purpose functions.
 *
 * `tree-ops.ts` covers tree algorithms (sparse update, structural sharing);
 * this file covers individual blob / commit object creation. Split this way so
 * `tree-ops.ts` doesn't grow into a "everything-git" dumping ground.
 *
 * Go reference: `entire-cli/cmd/entire/cli/checkpoint/committed.go`
 * (CreateBlobFromContent / CreateCommit / createRedactedBlobFromFile).
 */

/**
 * Author / committer info for a git commit.
 */
export interface CommitAuthor {
	name: string;
	email: string;
}

/**
 * Persist raw bytes as a git blob object and return its SHA-1.
 *
 * @example
 * ```ts
 * const oid = await createBlobFromContent(repoDir, new TextEncoder().encode('hello'));
 * // → '...blob hash...'
 * ```
 */
export async function createBlobFromContent(repoDir: string, content: Uint8Array): Promise<string> {
	return git.writeBlob({ fs: fsCallback, dir: repoDir, blob: content });
}

/**
 * Create a git commit object pointing at `treeHash` with `parentHash` as its
 * single parent. Pass {@link ZERO_HASH} for `parentHash` to create an
 * orphan commit (no parents — used for the very first checkpoint on a
 * brand-new shadow branch).
 *
 * The commit's author and committer are set to the same identity (`name` /
 * `email`) and the same timestamp (current time, current timezone).
 *
 * @example
 * ```ts
 * const commitOid = await createCommit(
 *   repoDir,
 *   treeHash,
 *   parentHash,            // or ZERO_HASH for orphan
 *   'Checkpoint',
 *   'Story CLI',
 *   'story@local',
 * );
 * ```
 */
export async function createCommit(
	repoDir: string,
	treeHash: string,
	parentHash: string,
	message: string,
	authorName: string,
	authorEmail: string,
): Promise<string> {
	const now = new Date();
	const timestamp = Math.floor(now.getTime() / 1000);
	const timezoneOffset = now.getTimezoneOffset();

	const author = { name: authorName, email: authorEmail, timestamp, timezoneOffset };

	return git.writeCommit({
		fs: fsCallback,
		dir: repoDir,
		commit: {
			message,
			tree: treeHash,
			parent: parentHash === ZERO_HASH ? [] : [parentHash],
			author,
			committer: author,
		},
	});
}

/** Standard git file mode for a regular (non-executable) file. */
const MODE_REGULAR_FILE = '100644';
/** Standard git file mode for an executable file. */
const MODE_EXEC_FILE = '100755';

/**
 * Read a file from disk, apply secret + PII redaction, and persist the
 * result as a git blob.
 *
 * Phase 4.2 shipped this with an identity-stub redactor; Phase 4.3 ports
 * the real Go redactor (entropy + pattern + opt-in PII) and adds the
 * Go-style JSONL dispatch: files whose tree path ends in `.jsonl` go
 * through field-aware {@link redactJSONLBytes} (skipping ID / path fields
 * + `type:image` payloads); everything else uses {@link redactBytes}.
 *
 * Returns the blob hash + the git file mode (regular vs executable derived
 * from POSIX `0o111`). Skips symlinks at the caller level — symlinks should
 * be filtered out by the directory walker before reaching this function.
 *
 * @example
 * ```ts
 * const { hash, mode } = await createRedactedBlobFromFile(
 *   repoDir,
 *   '/abs/path/.story/metadata/sess-1/full.jsonl',
 *   '.story/metadata/sess-1/full.jsonl', // tree-relative path (drives JSONL dispatch)
 * );
 * // hash: blob SHA, mode: '100644' (regular) or '100755' (executable)
 * ```
 */
export async function createRedactedBlobFromFile(
	repoDir: string,
	filePath: string,
	treePath: string,
): Promise<{ hash: string; mode: string }> {
	const stat = await fs.stat(filePath);
	const mode = (stat.mode & 0o111) !== 0 ? MODE_EXEC_FILE : MODE_REGULAR_FILE;

	const raw = await fs.readFile(filePath);
	const rawBytes = new Uint8Array(raw);
	const cleaned = treePath.endsWith('.jsonl')
		? (await redactJSONLBytes(rawBytes)).bytes
		: await redactBytes(rawBytes);
	const hash = await createBlobFromContent(repoDir, cleaned);
	return { hash, mode };
}
