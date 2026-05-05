/**
 * Centralized path / branch / file-name constants for the checkpoint subsystem.
 *
 * Single source of truth so the values are not duplicated across `temporary.ts`,
 * `committed.ts`, `v2-committed.ts`, and the future Phase 4.4 ref-rotation code.
 *
 * Naming rules (see [`docs/ts-rewrite/impl/references/story-vs-entire.md`](../../docs/ts-rewrite/impl/references/story-vs-entire.md)):
 *
 * - Refs / branches / dot-directories use the `story/` and `.story/` prefixes
 *   (Story rebrand of Go's `entire/` and `.entire/`).
 * - File names inside checkpoint trees match Go byte-for-byte so v1/v2 tree
 *   bytes can round-trip through both implementations.
 *
 * Go reference:
 *
 * - `entire-cli/cmd/entire/cli/paths/paths.go` (path constants)
 * - `entire-cli/cmd/entire/cli/agent/chunking.go` (`MaxChunkSize` / `ChunkSuffix`)
 */

/** Repo-relative `.story/` configuration directory. Mirror of Go `entire/`. */
export const STORY_DIR = '.story';

/** Repo-relative `.story/tmp/` directory used for ephemeral working files. */
export const STORY_TMP_DIR = '.story/tmp';

/** Repo-relative metadata directory used inside checkpoint git trees. */
export const STORY_METADATA_DIR = '.story/metadata';

/** v1 metadata branch (orphan, accumulating tree of all checkpoints). */
export const METADATA_BRANCH_NAME = 'story/checkpoints/v1';

/** v2 ref namespace head — Phase 4.4 will activate the rotation logic. */
export const V2_MAIN_REF_NAME = 'refs/story/checkpoints/v2/main';

/** v2 current-generation pointer (Phase 4.4). */
export const V2_FULL_CURRENT_REF_NAME = 'refs/story/checkpoints/v2/full/current';

/** v2 archived-generation prefix (Phase 4.4). */
export const V2_FULL_REF_PREFIX = 'refs/story/checkpoints/v2/full/';

/** v2 generation pointer file (Phase 4.4). */
export const GENERATION_FILE_NAME = 'generation.json';

/** Trail branch (Phase 9.5; constant declared early to avoid duplication). */
export const TRAILS_BRANCH_NAME = 'story/trails/v1';

/** Per-prompt artifact filename inside a session subdirectory. */
export const PROMPT_FILE_NAME = 'prompt.txt';

/** Primary transcript filename (chunk 0 / single-file). */
export const TRANSCRIPT_FILE_NAME = 'full.jsonl';

/** Legacy transcript filename retained for backwards compatibility. */
export const TRANSCRIPT_FILE_NAME_LEGACY = 'full.log';

/** Compact transcript filename (Phase 5.3 condensation output). */
export const COMPACT_TRANSCRIPT_FILE_NAME = 'transcript.jsonl';

/** Companion hash file for the compact transcript. */
export const COMPACT_TRANSCRIPT_HASH_FILE_NAME = 'transcript_hash.txt';

/** v2 raw transcript filename (Phase 4.4). */
export const V2_RAW_TRANSCRIPT_FILE_NAME = 'raw_transcript';

/** Companion hash file for the v2 raw transcript (Phase 4.4). */
export const V2_RAW_TRANSCRIPT_HASH_FILE_NAME = 'raw_transcript_hash.txt';

/** Per-session metadata filename inside a checkpoint subdirectory. */
export const METADATA_FILE_NAME = 'metadata.json';

/** Task-checkpoint summary filename (subagent invocations). */
export const CHECKPOINT_FILE_NAME = 'checkpoint.json';

/** Sha256 fingerprint companion file for the transcript blob. */
export const CONTENT_HASH_FILE_NAME = 'content_hash.txt';

/** Per-repo settings file inside `.story/`. */
export const SETTINGS_FILE_NAME = 'settings.json';

/**
 * Maximum size of a single transcript chunk file (50 MiB). Sized to stay
 * well under GitHub's 100 MB blob ceiling.
 *
 * Go: `entire-cli/cmd/entire/cli/agent/chunking.go: MaxChunkSize`.
 */
export const MAX_CHUNK_SIZE = 50 * 1024 * 1024;

/**
 * Printf-style suffix template for chunk filenames (chunk 1+). Chunk 0 uses
 * the bare base filename; chunk N for N ≥ 1 appends `.NNN` (zero-padded to
 * three digits). Kept as a literal so test parity with Go is byte-exact.
 *
 * Go: `entire-cli/cmd/entire/cli/agent/chunking.go: ChunkSuffix`.
 */
export const CHUNK_SUFFIX = '.%03d';
