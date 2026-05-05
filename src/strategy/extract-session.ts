/**
 * Extract session ID from a commit message — Phase 5.1 wrapper for Go's two-step
 * fallback chain (`Story-Session:` trailer → `filepath.Base(Story-Metadata:)`).
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/strategy/common.go:1415-1431`
 * (`ExtractSessionIDFromCommit`).
 *
 * @packageDocumentation
 */

import path from 'node:path';
import { parseMetadata, parseSession } from '../trailers';

/**
 * Extract the session ID from a commit message body. Two-step Go-aligned
 * fallback:
 *
 * 1. **`Story-Session: <id>` trailer** — if found, return the trailer value
 *    verbatim (after trimming).
 * 2. **`Story-Metadata: <metadataDir>` trailer** — if found, return
 *    `path.basename(metadataDir)` (the session ID is encoded in the directory
 *    leaf, e.g. `.story/metadata/2025-12-01-abc-session-id`).
 * 3. **Neither present** — return `''`.
 *
 * Mirrors Go `common.go:1419-1431`.
 *
 * @example
 * extractSessionIdFromCommit('feat: add x\n\nStory-Session: abc-123')
 * // => 'abc-123'                                 (path 1)
 *
 * extractSessionIdFromCommit('feat: condense\n\nStory-Metadata: .story/metadata/2025-12-01-abc')
 * // => '2025-12-01-abc'                          (path 2 — basename fallback)
 *
 * extractSessionIdFromCommit('refactor: nothing')
 * // => ''                                        (path 3)
 */
export function extractSessionIdFromCommit(commitMsg: string): string {
	const sessionId = parseSession(commitMsg);
	if (sessionId !== null && sessionId !== '') {
		return sessionId;
	}
	const metadataDir = parseMetadata(commitMsg);
	if (metadataDir !== null && metadataDir !== '') {
		return path.basename(metadataDir);
	}
	return '';
}
