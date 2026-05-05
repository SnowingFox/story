/**
 * Phase 5.1 prompts.ts unit tests — ported 1:1 from Go
 * `entire-cli/cmd/entire/cli/strategy/common_test.go` (ReadLatestSessionPromptFromCommittedTree
 * + ReadAgentTypeFromTree_* sections).
 *
 * Each `it()` is annotated with `// Go: <file>:<line> <TestName>` for traceability.
 *
 * Known impl-gap previews (will fail under current TS impl):
 * - `extractFirstPrompt` — TS reads JSONL, Go reads `prompt.txt` text format
 *   with `\n\n---\n\n` separators (this is THE most fundamental impl bug)
 * - `readAgentTypeFromTree` — TS only reads `metadata.json`; Go also detects
 *   `.claude/.codex/.cursor/.opencode` config marker directories (Gemini /
 *   Factory AI Droid dropped from roadmap — see references/dropped-agents.md)
 * - `readLatestSessionPromptFromCommittedTree` — Go scans backward from
 *   `sessionCount-1`; TS uses `highestSessionIndex` (different semantics for
 *   sparse / missing-prompt sessions)
 *
 * Tree fixture helper mirrors Go `buildCommittedTree` (common_test.go:1309-1350).
 */

import git from 'isomorphic-git';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MODE_DIR, MODE_FILE } from '@/checkpoint/tree-ops';
import type { CheckpointID } from '@/id';
import {
	extractFirstPrompt,
	isOnlySeparators,
	readAgentTypeFromTree,
	readAllSessionPromptsFromTree,
	readLatestSessionPromptFromCommittedTree,
	readSessionPromptFromTree,
} from '@/strategy/prompts';
import { type FixtureTreeEntry, TestEnv } from '../../helpers/test-env';

/**
 * Build a tree containing a map of `path -> content`. Mirrors Go
 * `buildCommittedTree(t, files map[string]string)` from common_test.go:1309-1350.
 */
async function buildTreeFromFiles(env: TestEnv, files: Record<string, string>): Promise<string> {
	type Node = { children: Map<string, Node>; blobOid?: string };
	const root: Node = { children: new Map() };

	// Insert each file path into the trie
	for (const [filePath, content] of Object.entries(files)) {
		const parts = filePath.split('/').filter((s) => s.length > 0);
		let cur = root;
		for (let i = 0; i < parts.length - 1; i++) {
			const seg = parts[i];
			if (seg === undefined) {
				continue;
			}
			let next = cur.children.get(seg);
			if (!next) {
				next = { children: new Map() };
				cur.children.set(seg, next);
			}
			cur = next;
		}
		const blob = await env.writeBlob(content);
		const leafName = parts[parts.length - 1];
		if (leafName === undefined) {
			continue;
		}
		cur.children.set(leafName, { children: new Map(), blobOid: blob });
	}

	// Recursively build trees bottom-up
	async function buildNode(node: Node): Promise<string> {
		const entries: FixtureTreeEntry[] = [];
		for (const [name, child] of node.children) {
			if (child.blobOid !== undefined) {
				entries.push({ mode: MODE_FILE, path: name, oid: child.blobOid, type: 'blob' });
			} else {
				const childOid = await buildNode(child);
				entries.push({ mode: MODE_DIR, path: name, oid: childOid, type: 'tree' });
			}
		}
		return env.writeTree(entries);
	}

	return buildNode(root);
}

describe('strategy/prompts — ported from common_test.go', () => {
	let env: TestEnv;

	beforeEach(async () => {
		env = await TestEnv.create();
	});

	afterEach(async () => {
		await env.cleanup();
	});

	describe('TestReadLatestSessionPromptFromCommittedTree — Go: common_test.go:1352-1504 TestReadLatestSessionPromptFromCommittedTree', () => {
		// Go: cpID = id.MustCheckpointID("a3b2c4d5e6f7") → path "a3/b2c4d5e6f7"
		const cpId = 'a3b2c4d5e6f7' as CheckpointID;

		// Go: common_test.go:1358-1368 TestReadLatestSessionPromptFromCommittedTree (single subtest)
		it('single session reads from 0/prompt.txt (Go: common_test.go:1358-1368)', async () => {
			const tree = await buildTreeFromFiles(env, {
				'a3/b2c4d5e6f7/0/prompt.txt': 'Implement login feature',
			});
			const got = await readLatestSessionPromptFromCommittedTree(env.dir, tree, cpId, 1);
			expect(got).toBe('Implement login feature');
		});

		// Go: common_test.go:1370-1382 "multi session reads from latest session"
		it('multi session reads from latest session (Go: common_test.go:1370-1382)', async () => {
			const tree = await buildTreeFromFiles(env, {
				'a3/b2c4d5e6f7/0/prompt.txt': 'First session prompt',
				'a3/b2c4d5e6f7/1/prompt.txt': 'Second session prompt',
				'a3/b2c4d5e6f7/2/prompt.txt': 'Third session prompt',
			});
			const got = await readLatestSessionPromptFromCommittedTree(env.dir, tree, cpId, 3);
			expect(got).toBe('Third session prompt');
		});

		// Go: common_test.go:1384-1395 "falls back to session 0 when computed index missing"
		it('falls back to session 0 when computed index missing (Go: common_test.go:1384-1395)', async () => {
			const tree = await buildTreeFromFiles(env, {
				'a3/b2c4d5e6f7/0/prompt.txt': 'Fallback prompt',
			});
			// Go: sessionCount=3 but only session 0 exists → backward scan finds it at 0
			const got = await readLatestSessionPromptFromCommittedTree(env.dir, tree, cpId, 3);
			expect(got).toBe('Fallback prompt');
		});

		// Go: common_test.go:1397-1408 "returns empty for missing prompt.txt"
		it('returns empty for missing prompt.txt (Go: common_test.go:1397-1408)', async () => {
			const tree = await buildTreeFromFiles(env, {
				'a3/b2c4d5e6f7/0/metadata.json': '{"session_id":"test"}',
			});
			const got = await readLatestSessionPromptFromCommittedTree(env.dir, tree, cpId, 1);
			expect(got).toBe('');
		});

		// Go: common_test.go:1410-1421 "returns empty for missing checkpoint path"
		it('returns empty for missing checkpoint path (Go: common_test.go:1410-1421)', async () => {
			const tree = await buildTreeFromFiles(env, {
				'ff/aabbccddee/0/prompt.txt': 'Wrong checkpoint',
			});
			const got = await readLatestSessionPromptFromCommittedTree(env.dir, tree, cpId, 1);
			expect(got).toBe('');
		});

		// Go: common_test.go:1423-1434 "returns empty for zero session count"
		// Go: latestIndex = max(sessionCount-1, 0) — sessionCount=0 still reads session 0
		it('returns empty for zero session count (Go: common_test.go:1423-1434)', async () => {
			const tree = await buildTreeFromFiles(env, {
				'a3/b2c4d5e6f7/0/prompt.txt': 'Some prompt',
			});
			const got = await readLatestSessionPromptFromCommittedTree(env.dir, tree, cpId, 0);
			expect(got).toBe('Some prompt');
		});

		// Go: common_test.go:1436-1449 "falls back to earlier session when latest has no prompt"
		it('falls back to earlier session when latest has no prompt (Go: common_test.go:1436-1449)', async () => {
			const tree = await buildTreeFromFiles(env, {
				'a3/b2c4d5e6f7/0/prompt.txt': 'Real session prompt',
				'a3/b2c4d5e6f7/1/metadata.json': '{"session_id":"test"}',
			});
			const got = await readLatestSessionPromptFromCommittedTree(env.dir, tree, cpId, 2);
			expect(got).toBe('Real session prompt');
		});

		// Go: common_test.go:1451-1464 "falls back through multiple empty sessions"
		it('falls back through multiple empty sessions (Go: common_test.go:1451-1464)', async () => {
			const tree = await buildTreeFromFiles(env, {
				'a3/b2c4d5e6f7/0/prompt.txt': 'Original prompt',
				'a3/b2c4d5e6f7/1/metadata.json': '{"session_id":"s1"}',
				'a3/b2c4d5e6f7/2/metadata.json': '{"session_id":"s2"}',
			});
			const got = await readLatestSessionPromptFromCommittedTree(env.dir, tree, cpId, 3);
			expect(got).toBe('Original prompt');
		});

		// Go: common_test.go:1466-1477 "returns empty when no session has a prompt"
		it('returns empty when no session has a prompt (Go: common_test.go:1466-1477)', async () => {
			const tree = await buildTreeFromFiles(env, {
				'a3/b2c4d5e6f7/0/metadata.json': '{"session_id":"s0"}',
				'a3/b2c4d5e6f7/1/metadata.json': '{"session_id":"s1"}',
			});
			const got = await readLatestSessionPromptFromCommittedTree(env.dir, tree, cpId, 2);
			expect(got).toBe('');
		});

		// Go: common_test.go:1479-1491 "falls back when latest has empty prompt.txt"
		it('falls back when latest has empty prompt.txt (Go: common_test.go:1479-1491)', async () => {
			const tree = await buildTreeFromFiles(env, {
				'a3/b2c4d5e6f7/0/prompt.txt': 'Real prompt',
				'a3/b2c4d5e6f7/1/prompt.txt': '',
			});
			const got = await readLatestSessionPromptFromCommittedTree(env.dir, tree, cpId, 2);
			expect(got).toBe('Real prompt');
		});

		// Go: common_test.go:1493-1503 "extracts first prompt from multi-prompt content"
		it('extracts first prompt from multi-prompt content (Go: common_test.go:1493-1503)', async () => {
			const tree = await buildTreeFromFiles(env, {
				'a3/b2c4d5e6f7/0/prompt.txt': 'First prompt\n\n---\n\nSecond prompt',
			});
			const got = await readLatestSessionPromptFromCommittedTree(env.dir, tree, cpId, 1);
			expect(got).toBe('First prompt');
		});

		// ─── audit-3 Fix G (2026-04-18): cpPath early-return performance ──────
		// Go: common.go:773-778 — `cpTree, err := tree.Tree(cpPath); if err != nil
		// { return "" }`. A single tree lookup at the checkpoint dir; if absent,
		// return immediately. Pre-fix TS looped sessionCount times via
		// readBlobInTree, each call doing its own root-tree lookup → O(N) wasted
		// readTree calls for missing checkpoints. With Fix G, missing cpPath
		// triggers ONE bounded `treeExistsInTree` walk (≤ depth(cpPath) reads).
		it('Fix G: missing checkpoint path returns "" with O(1) tree reads, not O(sessionCount)', async () => {
			// Tree contains a *different* cpId path; queried path 'a3/b2c4d5e6f7'
			// doesn't exist anywhere in the tree.
			const tree = await buildTreeFromFiles(env, {
				'ff/aabbccddee/0/prompt.txt': 'Wrong checkpoint',
			});
			const readTreeSpy = vi.spyOn(git, 'readTree');
			try {
				// Large sessionCount: pre-fix TS would do N lookups, each calling
				// readTree at least once before returning null.
				const got = await readLatestSessionPromptFromCommittedTree(env.dir, tree, cpId, 10);
				expect(got).toBe('');

				// cpPath = 'a3/b2c4d5e6f7' has 2 segments → treeExistsInTree
				// reads at most 2 trees (root, then 'a3'). Either of them missing
				// returns false → no per-session lookups. Total readTree calls
				// must NOT scale with sessionCount=10.
				// cpPath = 'a3/b2c4d5e6f7' (depth 2). treeExistsInTree reads at
				// most 2 trees (root, then 'a3'). Pre-fix TS made 10 readTree
				// calls for sessionCount=10; post-fix is bounded by cpPath depth.
				expect(readTreeSpy.mock.calls.length).toBeLessThanOrEqual(2);
			} finally {
				readTreeSpy.mockRestore();
			}
		});
	});

	describe('TestReadAgentTypeFromTree_* — Go: common_test.go:1566-1696', () => {
		// Go: common_test.go:1566-1578 TestReadAgentTypeFromTree_OnlyClaude
		it('OnlyClaude returns AgentTypeClaudeCode (Go: common_test.go:1566-1578)', async () => {
			const tree = await buildTreeFromFiles(env, {
				'.claude/settings.json': '{}',
			});
			const result = await readAgentTypeFromTree(env.dir, tree, 'nonexistent-path');
			// Go expects: agent.AgentTypeClaudeCode (== "Claude Code")
			expect(result).toBe('Claude Code');
		});

		// `OnlyGemini` test removed: Gemini CLI dropped from the roadmap. Without
		// the `.gemini/settings.json` detection branch in prompts.ts, a tree
		// containing only `.gemini/...` returns `'Unknown'`. See
		// references/dropped-agents.md.

		// Go: common_test.go:1594-1606 TestReadAgentTypeFromTree_OnlyCodex
		it('OnlyCodex returns AgentTypeCodex (Go: common_test.go:1594-1606)', async () => {
			const tree = await buildTreeFromFiles(env, {
				'.codex/config.json': '{}',
			});
			const result = await readAgentTypeFromTree(env.dir, tree, 'nonexistent-path');
			// Go expects: agent.AgentTypeCodex (== "Codex")
			expect(result).toBe('Codex');
		});

		// Go: common_test.go:1608-1620 TestReadAgentTypeFromTree_OnlyCursor
		it('OnlyCursor returns AgentTypeCursor (Go: common_test.go:1608-1620)', async () => {
			const tree = await buildTreeFromFiles(env, {
				'.cursor/settings.json': '{}',
			});
			const result = await readAgentTypeFromTree(env.dir, tree, 'nonexistent-path');
			// Go expects: agent.AgentTypeCursor (== "Cursor")
			expect(result).toBe('Cursor');
		});

		// Go: common_test.go:1622-1634 TestReadAgentTypeFromTree_OnlyFactory —
		// Factory AI Droid dropped from the TS roadmap (see
		// references/dropped-agents.md). `.factory/` no longer contributes to
		// the detected-agent set, so a tree with ONLY that marker falls
		// through to `Unknown`.
		it('OnlyFactory returns Unknown (Droid dropped — diverges from Go common_test.go:1622-1634)', async () => {
			const tree = await buildTreeFromFiles(env, {
				'.factory/settings.json': '{}',
			});
			const result = await readAgentTypeFromTree(env.dir, tree, 'nonexistent-path');
			expect(result).toBe('Unknown');
		});

		// TS-only: Go's marker scan also includes OpenCode (.opencode tree
		// OR opencode.json file), but common_test.go has no explicit
		// `TestReadAgentTypeFromTree_OnlyOpenCode` test. Phase 6.x is expected
		// to add the Go test; until then the two it()s below cover the marker
		// branches in production (`common.go:719-728` two-form fallback).
		it('OnlyOpenCode (.opencode dir) returns AgentTypeOpenCode — TS-only: Go production at common.go:719-728', async () => {
			const tree = await buildTreeFromFiles(env, {
				'.opencode/settings.json': '{}',
			});
			const result = await readAgentTypeFromTree(env.dir, tree, 'nonexistent-path');
			expect(result).toBe('OpenCode');
		});

		it('OnlyOpenCode (opencode.json file) returns AgentTypeOpenCode — TS-only: Go production at common.go:725-728', async () => {
			const tree = await buildTreeFromFiles(env, { 'opencode.json': '{}' });
			const result = await readAgentTypeFromTree(env.dir, tree, 'nonexistent-path');
			expect(result).toBe('OpenCode');
		});

		// Go: common_test.go:1636-1650 TestReadAgentTypeFromTree_ClaudeAndCodex_ReturnsUnknown
		it('ClaudeAndCodex returns Unknown (Go: common_test.go:1636-1650)', async () => {
			const tree = await buildTreeFromFiles(env, {
				'.claude/settings.json': '{}',
				'.codex/config.json': '{}',
			});
			const result = await readAgentTypeFromTree(env.dir, tree, 'nonexistent-path');
			// Go expects: agent.AgentTypeUnknown (== "Unknown")
			expect(result).toBe('Unknown');
		});

		// `ClaudeAndGemini returns Unknown` test removed: Gemini CLI dropped from
		// the roadmap, so `.gemini/` is no longer a detection marker. The
		// "ambiguous → Unknown" semantics is still covered by other multi-marker
		// tests below. See references/dropped-agents.md.

		// Go: common_test.go:1668-1680 TestReadAgentTypeFromTree_NoAgentDirs_ReturnsUnknown
		it('NoAgentDirs returns Unknown (Go: common_test.go:1668-1680)', async () => {
			const tree = await buildTreeFromFiles(env, {
				'f.txt': 'init',
			});
			const result = await readAgentTypeFromTree(env.dir, tree, 'nonexistent-path');
			expect(result).toBe('Unknown');
		});

		// Go: common_test.go:1682-1696 TestReadAgentTypeFromTree_MetadataJSON_OverridesDir
		it('MetadataJSON overrides dir detection (Go: common_test.go:1682-1696)', async () => {
			const tree = await buildTreeFromFiles(env, {
				'.claude/settings.json': '{}',
				'cp/metadata.json': '{"agent":"Cursor"}',
			});
			const result = await readAgentTypeFromTree(env.dir, tree, 'cp');
			// metadata.json wins over .claude/ directory marker
			expect(result).toBe('Cursor');
		});
	});
});

/**
 * extractFirstPrompt — TS-only: Go production lives at `common.go:652-679`
 * (`ExtractFirstPrompt`). No dedicated Go `Test*` exists; Go covers it
 * transitively via `TestReadLatestSessionPromptFromCommittedTree`. The TS
 * tests below pin the `prompt.txt` text + `---` separator + 60-rune truncation
 * + Uint8Array/string dual-input contract.
 */
describe('extractFirstPrompt — Go: common.go:652-679 (production; no dedicated Go Test*)', () => {
	const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

	it('reads first prompt from prompt.txt-style content (text + --- separators)', () => {
		const input = 'First prompt content\n\n---\n\nSecond prompt content';
		expect(extractFirstPrompt(enc(input))).toBe('First prompt content');
	});

	it('truncates first prompt to MAX_DESCRIPTION_LENGTH (60 runes) — Go parity', () => {
		// Go ExtractFirstPrompt calls TruncateDescription(prompt, MaxDescriptionLength=60)
		const long = 'a'.repeat(100);
		const result = extractFirstPrompt(enc(long));
		// 57 chars + "..." = 60 total
		expect([...result]).toHaveLength(60);
		expect(result.endsWith('...')).toBe(true);
	});

	it('returns empty string for empty content', () => {
		expect(extractFirstPrompt(enc(''))).toBe('');
	});

	it('skips separator-only entries', () => {
		// Go: `isOnlySeparators` skips entries that are only -, space, \n, \r, \t
		const input = '---\n\n---\n\nReal prompt content';
		expect(extractFirstPrompt(enc(input))).toBe('Real prompt content');
	});

	it('accepts string input directly (Go-aligned API)', () => {
		expect(extractFirstPrompt('Plain string input')).toBe('Plain string input');
	});
});

/**
 * `isOnlySeparators` was promoted from file-private to `export` in Phase 5.4
 * so `extractLastPrompt` (Go: `manual_commit_hooks.go: extractLastPrompt`) can
 * reuse the same separator predicate. Mirrors Go `common.go: isOnlySeparators`.
 */
describe('isOnlySeparators (promoted to export in Phase 5.4)', () => {
	it('returns true for triple-dash only', () => {
		// Go: common.go isOnlySeparators returns true for "---" (only - chars)
		expect(isOnlySeparators('---')).toBe(true);
	});

	it('returns true for whitespace + dash mix', () => {
		// Go: common.go isOnlySeparators returns true for " \n  --- \t"
		expect(isOnlySeparators(' \n  --- \t')).toBe(true);
	});

	it('returns false for empty string (regex requires at least one char)', () => {
		// SEPARATOR_CHARS_RE = /^[-\s]+$/ — `+` means ≥ 1 char.
		// Mirrors Go: separator-class regex with at-least-one anchor.
		expect(isOnlySeparators('')).toBe(false);
	});

	it('returns false when content has non-separator chars', () => {
		// Go: common.go isOnlySeparators returns false for "hello"
		expect(isOnlySeparators('hello')).toBe(false);
	});

	it('returns false for prose containing dashes', () => {
		// Go: common.go isOnlySeparators returns false for "well-known"
		expect(isOnlySeparators('well-known')).toBe(false);
	});
});

/**
 * TS-only: `readSessionPromptFromTree` / `readAllSessionPromptsFromTree`
 * have no dedicated Go `Test*` — they're folded into the larger
 * `TestReadLatestSessionPromptFromCommittedTree` suite (Go: common_test.go:1352-1504).
 * The TS tests below pin the function-level contracts (single-session vs
 * multi-session path branching).
 */
describe('strategy/prompts — readSessionPromptFromTree / readAllSessionPromptsFromTree (TS-only: folded into Go TestReadLatestSessionPromptFromCommittedTree)', () => {
	let env: TestEnv;
	beforeEach(async () => {
		env = await TestEnv.create();
	});
	afterEach(async () => {
		await env.cleanup();
	});

	it('readSessionPromptFromTree reads prompt.txt from session subtree', async () => {
		const tree = await buildTreeFromFiles(env, {
			'a3/b2c4d5e6f7/0/prompt.txt': 'hello world',
		});
		expect(await readSessionPromptFromTree(env.dir, tree, 'a3/b2c4d5e6f7/0')).toBe('hello world');
	});

	// Multi-session: 0..N-2 in archived subdirs + root for newest (Go: common.go:822-838)
	it('readAllSessionPromptsFromTree multi-session: archived 0..N-2 in subdirs + newest at root', async () => {
		// Root = newest session (Go convention); archived sessions in subdirs 0, 1, ...
		const tree = await buildTreeFromFiles(env, {
			'a3/b2c4d5e6f7/0/prompt.txt': 'oldest',
			'a3/b2c4d5e6f7/1/prompt.txt': 'middle',
			'a3/b2c4d5e6f7/prompt.txt': 'newest', // root level = newest
		});
		const result = await readAllSessionPromptsFromTree(env.dir, tree, 'a3/b2c4d5e6f7', 3, [
			's-old',
			's-mid',
			's-new',
		]);
		expect(result).toEqual(['oldest', 'middle', 'newest']);
	});

	// Single-session: read root prompt only (Go: common.go:813-820)
	it('readAllSessionPromptsFromTree single-session: reads root prompt only', async () => {
		const tree = await buildTreeFromFiles(env, {
			'a3/b2c4d5e6f7/prompt.txt': 'only one',
		});
		const result = await readAllSessionPromptsFromTree(env.dir, tree, 'a3/b2c4d5e6f7', 1, [
			'only-session',
		]);
		expect(result).toEqual(['only one']);
	});
});
