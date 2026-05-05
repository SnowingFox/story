/**
 * Generate the commit subject line for a checkpoint from the user prompt.
 *
 * Reference: Go `cmd/entire/cli/commit_message.go`: `generateCommitMessage`
 * + `cleanPromptForCommit`. The Story TS implementation is **intentionally
 * divergent** from Go — see the TS-divergence block below.
 *
 * Behavior:
 *
 * - Iteratively strips 12 conversational prefixes (`Can you`, `Could you`,
 *   `Please`, `Help me`, `I want to`, ... — case-insensitive). Loop until no
 *   more prefixes match, so `"Can you please help me refactor X"` collapses
 *   to `"refactor X"` after 3 iterations.
 * - Strips leading / trailing whitespace on each iteration.
 * - Capitalizes the first character.
 * - Rune-safe truncate to 72 Unicode codepoints (NOT 72 bytes, NOT 72 UTF-16
 *   code units) via `[...s]`. Adds `...` suffix when truncated.
 * - Empty / whitespace-only input → fallback `[<agentType>] Task checkpoint`
 *   (agentType `''` → `'agent'`).
 *
 * **TS-divergence from Go `cmd/entire/cli/commit_message.go`** (intentional
 * Story-side UX choices; not a parity bug — see
 * `docs/ts-rewrite/impl/phase-7-lifecycle/impl-1.md` §commit-message):
 *
 * 1. **Prefix list** — TS ships 12 lowercase prefixes matched
 *    case-insensitive; Go ships 13 mixed-case prefixes matched
 *    case-sensitive (`"Can you "`, `"can you "` are two separate entries in
 *    Go). Story picks lowercase-once + case-insensitive-match for a simpler
 *    self-consistent prefix set.
 * 2. **Trailing `?`** — Story keeps the `?` (e.g. "Can you refactor X?" →
 *    "Refactor X?"); Go strips it (`strings.TrimSuffix(..., "?")`).
 * 3. **Truncation suffix** — Story appends `...` when the subject exceeds
 *    72 runes; Go truncates silently with no visual marker.
 * 4. **Empty fallback** — Story renders `[<agentType>] Task checkpoint`;
 *    Go renders `<agentType> session updates` (no brackets).
 *
 * Rationale: Story UX prefers more uniform prefix coverage + an explicit
 * visual truncation marker + bracketed agent tag for search/grep.
 *
 * **Unicode caveat**: `charAt(0).toUpperCase()` only uppercases the first
 * UTF-16 code unit, so astral-plane lead surrogates are left untouched. Go
 * `unicode.ToUpper` has the same limitation (operates on the first rune,
 * which for combining characters may differ from "the first letter"). Both
 * are acceptable for commit subjects — this is not a semantic identifier.
 *
 * @packageDocumentation
 */

import type { AgentType } from '@/agent/types';

/**
 * Maximum commit subject length in Unicode codepoints (not bytes, not UTF-16
 * code units). Mirrors Go `cmd/entire/cli/commit_message.go` which passes
 * the literal `72` to `stringutil.TruncateRunes`. Extracted as a named
 * constant here so the 72-rune rule is discoverable in one place.
 */
export const COMMIT_MESSAGE_MAX_LEN = 72 as const;

/**
 * 12 conversational prefixes matched case-insensitive. Order matters
 * because the first match wins within a single loop iteration; the outer
 * loop re-runs until nothing matches so stacked prefixes like
 * `"Could you please help me "` all peel off.
 */
const COMMIT_PREFIXES_TO_STRIP: readonly string[] = [
	'can you ',
	'could you ',
	'can we ',
	'could we ',
	'please ',
	'help me ',
	'help us ',
	'i want to ',
	'i need to ',
	'i would like to ',
	'let us ',
	"let's ",
] as const;

/**
 * Strip all leading conversational prefixes iteratively + normalize
 * whitespace. Returns `''` for all-whitespace or empty input.
 *
 * @example
 * cleanPromptForCommit('Can you please help me refactor the API');
 * // → 'refactor the API' (3 prefixes stripped)
 *
 * cleanPromptForCommit('   Fix the bug   ');
 * // → 'Fix the bug'
 *
 * cleanPromptForCommit('');
 * // → ''
 */
export function cleanPromptForCommit(prompt: string): string {
	let s = prompt.trim();
	if (s === '') {
		return '';
	}
	let changed = true;
	while (changed) {
		changed = false;
		const lower = s.toLowerCase();
		for (const prefix of COMMIT_PREFIXES_TO_STRIP) {
			if (lower.startsWith(prefix)) {
				s = s.slice(prefix.length).trimStart();
				changed = true;
				break;
			}
		}
	}
	return s;
}

/**
 * Compose the commit subject for a checkpoint commit.
 *
 * @example
 * generateCommitMessage('Can you refactor X', 'claude-code');
 * // → 'Refactor X'
 *
 * generateCommitMessage('', 'claude-code');
 * // → '[claude-code] Task checkpoint'
 *
 * generateCommitMessage('', '');
 * // → '[agent] Task checkpoint'
 *
 * generateCommitMessage('A'.repeat(120), 'cursor');
 * // → truncated to 72 Unicode codepoints + '...'
 */
export function generateCommitMessage(prompt: string, agentType: AgentType): string {
	const cleaned = cleanPromptForCommit(prompt);
	if (cleaned === '') {
		const type = agentType || 'agent';
		return `[${type}] Task checkpoint`;
	}
	const runes = [...cleaned];
	const first = runes[0] ?? '';
	const capitalized = first.toUpperCase() + runes.slice(1).join('');
	return truncateRunes(capitalized, COMMIT_MESSAGE_MAX_LEN);
}

/**
 * Truncate `s` to at most `n` Unicode codepoints. Returns `s` unchanged
 * when within the limit; otherwise returns `runes[0..n].join('') + '...'`.
 *
 * Uses `[...s]` to iterate by Unicode codepoint, so surrogate pairs (emoji,
 * astral plane chars) count as a single "character".
 */
function truncateRunes(s: string, n: number): string {
	const runes = [...s];
	if (runes.length <= n) {
		return s;
	}
	return `${runes.slice(0, n).join('')}...`;
}
