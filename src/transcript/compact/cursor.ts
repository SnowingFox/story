/**
 * Cursor compactor — currently a thin alias to {@link compactJSONL}.
 *
 * Cursor transcripts use `role:'user'` / `role:'assistant'` instead of
 * `type:'user'` / `type:'assistant'`, but `compactJSONL`'s `normalizeKind`
 * helper handles that via the `userAliases` set. So Cursor flows through
 * `compactJSONL` unchanged today — Go has **no** `cursor.go` file in the
 * package; the same algorithm covers Claude Code, Cursor, and Unknown.
 *
 * **Future-divergence interface**: this file exists as a stable export so
 * Phase 6.3+ can replace the alias with a Cursor-specific implementation if
 * Cursor's transcript format diverges from Claude. The change would be:
 *
 *   1. Replace `compactCursor = compactJSONL` here with the real impl.
 *   2. Add `if (isCursorFormat(content)) return compactCursor(content, opts);`
 *      to `compact()` dispatch in `index.ts`.
 *   3. No caller changes needed (interface is stable).
 *
 * @packageDocumentation
 */

import { compactJSONL } from './jsonl';

/**
 * Cursor compactor — currently identical to {@link compactJSONL} (alias).
 * See file-level documentation for the future-divergence rationale.
 */
export const compactCursor = compactJSONL;
