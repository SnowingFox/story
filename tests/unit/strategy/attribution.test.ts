import fsCallback from 'node:fs';
import git from 'isomorphic-git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	type AccumulatedEdits,
	type AttributionParams,
	accumulatePromptEdits,
	calculateAttributionWithAccumulated,
	calculatePromptAttribution,
	classifyAccumulatedEdits,
	classifyBaselineEdits,
	computeAgentDeletions,
	countLinesStr,
	diffAgentTouchedFiles,
	diffLines,
	estimateUserSelfModifications,
	getAllChangedFiles,
	getFileContent,
	isAgentOrMetadataFile,
} from '@/strategy/attribution';
import type { PromptAttribution } from '@/strategy/types';
import { TestEnv } from '../../helpers/test-env';

// ─── diffLines ────────────────────────────────────────────────────────
// Go: cmd/entire/cli/strategy/manual_commit_attribution.go diffLines
// Go: cmd/entire/cli/strategy/manual_commit_attribution_test.go (Test{NoChanges,AllAdded,AllRemoved,MixedChanges,WithoutTrailingNewline})
const THREE_LINES = 'line1\nline2\nline3\n';

describe('attribution.diffLines', () => {
	// Go: TestDiffLines_NoChanges
	it('returns 3 unchanged for identical content', () => {
		expect(diffLines(THREE_LINES, THREE_LINES)).toEqual({
			unchanged: 3,
			added: 0,
			removed: 0,
		});
	});

	// Go: TestDiffLines_AllAdded
	it('returns all-added when checkpoint empty', () => {
		expect(diffLines('', THREE_LINES)).toEqual({ unchanged: 0, added: 3, removed: 0 });
	});

	// Go: TestDiffLines_AllRemoved
	it('returns all-removed when committed empty', () => {
		expect(diffLines(THREE_LINES, '')).toEqual({ unchanged: 0, added: 0, removed: 3 });
	});

	// Go: TestDiffLines_MixedChanges
	it('counts mixed insertions and deletions', () => {
		const checkpoint = THREE_LINES;
		const committed = 'line1\nmodified\nline3\nnew line\n';
		// line1 + line3 unchanged (2); line2 removed (1); modified + 'new line' added (2)
		expect(diffLines(checkpoint, committed)).toEqual({
			unchanged: 2,
			added: 2,
			removed: 1,
		});
	});

	// Go: TestDiffLines_WithoutTrailingNewline
	it('handles content without trailing newline', () => {
		expect(diffLines('line1\nline2', 'line1\nline2')).toEqual({
			unchanged: 2,
			added: 0,
			removed: 0,
		});
	});
});

// ─── countLinesStr ────────────────────────────────────────────────────
// Go: cmd/entire/cli/strategy/manual_commit_attribution.go countLinesStr
// Go: cmd/entire/cli/strategy/manual_commit_attribution_test.go TestCountLinesStr (table)
describe('attribution.countLinesStr', () => {
	const cases: Array<[string, string, number]> = [
		['empty', '', 0],
		['single line no newline', 'hello', 1],
		['single line with newline', 'hello\n', 1],
		['two lines', 'hello\nworld\n', 2],
		['two lines no trailing newline', 'hello\nworld', 2],
		['three lines', 'a\nb\nc\n', 3],
	];
	it.each(cases)('countLinesStr %s', (_name, content, expected) => {
		expect(countLinesStr(content)).toBe(expected);
	});
});

// ─── getFileContent ───────────────────────────────────────────────────
// Go: cmd/entire/cli/strategy/manual_commit_attribution.go getFileContent
describe('attribution.getFileContent', () => {
	let env: TestEnv;

	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
	});

	afterEach(async () => {
		await env.cleanup();
	});

	async function buildTreeWithFile(name: string, content: string | Uint8Array): Promise<string> {
		const blob =
			typeof content === 'string'
				? await git.writeBlob({
						fs: fsCallback,
						dir: env.dir,
						blob: new TextEncoder().encode(content),
					})
				: await git.writeBlob({ fs: fsCallback, dir: env.dir, blob: content });
		return git.writeTree({
			fs: fsCallback,
			dir: env.dir,
			tree: [{ mode: '100644', path: name, oid: blob, type: 'blob' }],
		});
	}

	it('returns empty string when treeOid is null', async () => {
		expect(await getFileContent(env.dir, null, 'any.txt')).toBe('');
	});

	it('returns empty string when file not in tree', async () => {
		const treeOid = await buildTreeWithFile('only.txt', 'hello');
		expect(await getFileContent(env.dir, treeOid, 'missing.txt')).toBe('');
	});

	it('returns text content for text file', async () => {
		const treeOid = await buildTreeWithFile('greet.txt', 'hello world\n');
		expect(await getFileContent(env.dir, treeOid, 'greet.txt')).toBe('hello world\n');
	});

	it('returns empty string for binary file (NULL byte detected)', async () => {
		const bin = new Uint8Array([0x66, 0x6f, 0x6f, 0x00, 0x62, 0x61, 0x72]); // "foo\0bar"
		const treeOid = await buildTreeWithFile('blob.bin', bin);
		expect(await getFileContent(env.dir, treeOid, 'blob.bin')).toBe('');
	});

	it('returns empty string when tree resolution fails', async () => {
		expect(await getFileContent(env.dir, '0000000000000000000000000000000000000000', 'x')).toBe('');
	});
});

// ─── accumulatePromptEdits ────────────────────────────────────────────
// Go: cmd/entire/cli/strategy/manual_commit_attribution.go accumulatePromptEdits
describe('attribution.accumulatePromptEdits', () => {
	function pa(
		cn: number,
		userAdded: number,
		userRemoved: number,
		opts: {
			added?: Record<string, number>;
			removed?: Record<string, number>;
		} = {},
	): PromptAttribution {
		return {
			checkpointNumber: cn,
			userLinesAdded: userAdded,
			userLinesRemoved: userRemoved,
			agentLinesAdded: 0,
			agentLinesRemoved: 0,
			userAddedPerFile: opts.added,
			userRemovedPerFile: opts.removed,
		};
	}

	it('sums userAdded and userRemoved across all PAs', () => {
		const out = accumulatePromptEdits([pa(1, 5, 2), pa(2, 3, 1), pa(3, 2, 0)]);
		expect(out.userAdded).toBe(10);
		expect(out.userRemoved).toBe(3);
	});

	it('accumulates per-file additions and removals', () => {
		const out = accumulatePromptEdits([
			pa(1, 5, 2, { added: { file1: 5 }, removed: { file2: 2 } }),
			pa(2, 3, 1, { added: { file1: 3 }, removed: { file3: 1 } }),
		]);
		expect(out.addedPerFile).toEqual({ file1: 8 });
		expect(out.removedPerFile).toEqual({ file2: 2, file3: 1 });
	});

	it('tracks PA1 (checkpointNumber<=1) as baseline separately', () => {
		const out = accumulatePromptEdits([
			pa(1, 5, 2, { added: { file1: 5 } }),
			pa(2, 3, 0, { added: { file1: 3 } }),
		]);
		expect(out.baselineUserRemoved).toBe(2);
		expect(out.baselineUserAddedPerFile).toEqual({ file1: 5 });
		// Non-baseline tracked together.
		expect(out.addedPerFile).toEqual({ file1: 8 });
	});

	it('handles PA without per-file maps (legacy state)', () => {
		const out = accumulatePromptEdits([pa(1, 5, 2)]);
		expect(out.addedPerFile).toEqual({});
		expect(out.removedPerFile).toEqual({});
		expect(out.baselineUserAddedPerFile).toEqual({});
		expect(out.baselineUserRemoved).toBe(2);
	});
});

// ─── diffAgentTouchedFiles ────────────────────────────────────────────
// Go: cmd/entire/cli/strategy/manual_commit_attribution.go diffAgentTouchedFiles
describe('attribution.diffAgentTouchedFiles', () => {
	let env: TestEnv;

	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
	});

	afterEach(async () => {
		await env.cleanup();
	});

	async function writeFileBlob(name: string, content: string): Promise<string> {
		const blob = await git.writeBlob({
			fs: fsCallback,
			dir: env.dir,
			blob: new TextEncoder().encode(content),
		});
		return git.writeTree({
			fs: fsCallback,
			dir: env.dir,
			tree: [{ mode: '100644', path: name, oid: blob, type: 'blob' }],
		});
	}

	it('computes base→shadow and shadow→head per file', async () => {
		// base: empty file. shadow: agent added 1 line ("agent"). head: user added 1 more line.
		const baseOid = await writeFileBlob('app.ts', '');
		const shadowOid = await writeFileBlob('app.ts', 'agent\n');
		const headOid = await writeFileBlob('app.ts', 'agent\nuser\n');

		const out = await diffAgentTouchedFiles(env.dir, baseOid, shadowOid, headOid, ['app.ts']);
		expect(out.totalAgentAndUserWorkAdded).toBe(1); // base→shadow added 1
		expect(out.postCheckpointUserAdded).toBe(1); // shadow→head added 1
		expect(out.postCheckpointUserRemoved).toBe(0);
	});

	it('tracks postCheckpointUserRemovedPerFile', async () => {
		const baseOid = await writeFileBlob('x.ts', '');
		const shadowOid = await writeFileBlob('x.ts', 'a\nb\nc\n');
		const headOid = await writeFileBlob('x.ts', 'a\nb\n');
		const out = await diffAgentTouchedFiles(env.dir, baseOid, shadowOid, headOid, ['x.ts']);
		expect(out.postCheckpointUserRemovedPerFile).toEqual({ 'x.ts': 1 });
	});

	it('handles empty filesTouched', async () => {
		const oid = await writeFileBlob('x.ts', 'content\n');
		const out = await diffAgentTouchedFiles(env.dir, oid, oid, oid, []);
		expect(out).toEqual({
			totalAgentAndUserWorkAdded: 0,
			postCheckpointUserAdded: 0,
			postCheckpointUserRemoved: 0,
			postCheckpointUserRemovedPerFile: {},
		});
	});
});

// ─── classifyAccumulatedEdits + classifyBaselineEdits ─────────────────
// Go: cmd/entire/cli/strategy/manual_commit_attribution.go classifyAccumulatedEdits / classifyBaselineEdits
describe('attribution.classifyAccumulatedEdits', () => {
	it('routes user edits to agent vs non-agent buckets', () => {
		const accum: AccumulatedEdits = {
			userAdded: 0,
			userRemoved: 0,
			addedPerFile: { agentFile: 5, nonAgentFile: 3, untouchedFile: 2 },
			removedPerFile: {},
			baselineUserRemoved: 0,
			baselineUserAddedPerFile: {},
		};
		const out = classifyAccumulatedEdits(accum, ['agentFile'], new Set(['nonAgentFile']));
		expect(out.toAgentFiles).toBe(5);
		expect(out.toCommittedNonAgentFiles).toBe(3);
		expect(out.removedFromAgentFiles).toBe(0);
		expect(out.removedFromCommittedNonAgent).toBe(0);
	});

	it('routes per-file removals symmetrically', () => {
		const accum: AccumulatedEdits = {
			userAdded: 0,
			userRemoved: 0,
			addedPerFile: {},
			removedPerFile: { agentFile: 4, nonAgentFile: 2, untouchedFile: 1 },
			baselineUserRemoved: 0,
			baselineUserAddedPerFile: {},
		};
		const out = classifyAccumulatedEdits(accum, ['agentFile'], new Set(['nonAgentFile']));
		expect(out.removedFromAgentFiles).toBe(4);
		expect(out.removedFromCommittedNonAgent).toBe(2);
	});
});

describe('attribution.classifyBaselineEdits', () => {
	it('filters PA1 additions only (no removals tracked)', () => {
		const out = classifyBaselineEdits({ agentFile: 4 }, ['agentFile'], new Set());
		expect(out.toAgentFiles).toBe(4);
		expect(out.removedFromAgentFiles).toBe(0);
	});

	it('ignores files not in filesTouched or committedNonAgentSet', () => {
		const out = classifyBaselineEdits({ orphan: 10 }, [], new Set());
		expect(out.toAgentFiles).toBe(0);
		expect(out.toCommittedNonAgentFiles).toBe(0);
	});
});

// ─── computeAgentDeletions + estimateUserSelfModifications ───────────
// Go: cmd/entire/cli/strategy/manual_commit_attribution.go computeAgentDeletions / estimateUserSelfModifications
describe('attribution.computeAgentDeletions', () => {
	let env: TestEnv;
	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
	});
	afterEach(async () => {
		await env.cleanup();
	});

	async function tree(name: string, content: string): Promise<string> {
		const blob = await git.writeBlob({
			fs: fsCallback,
			dir: env.dir,
			blob: new TextEncoder().encode(content),
		});
		return git.writeTree({
			fs: fsCallback,
			dir: env.dir,
			tree: [{ mode: '100644', path: name, oid: blob, type: 'blob' }],
		});
	}

	it('returns 0 when user re-adds lines the agent deleted (min of base→shadow vs base→head)', async () => {
		// base: 10 lines. shadow: agent removed last 5 (→ 5 lines).
		// head: user re-added the 5 → back to 10 lines (matches base).
		const baseOid = await tree('x.ts', 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n');
		const shadowOid = await tree('x.ts', 'a\nb\nc\nd\ne\n');
		const headOid = await tree('x.ts', 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n');
		const out = await computeAgentDeletions(env.dir, baseOid, shadowOid, headOid, ['x.ts'], 0);
		// base→shadow removed 5; base→head removed 0; min = 0.
		expect(out).toBe(0);
	});

	it('caps at max(0, deletions - accumRemoved) when accumulated removals exceed agent deletions', async () => {
		const baseOid = await tree('x.ts', 'a\nb\nc\n');
		const shadowOid = await tree('x.ts', 'a\nb\nc\n');
		const headOid = await tree('x.ts', 'a\nb\nc\n');
		// per-file deletion sum = 0. accumRemoved=15 → max(0, -15) = 0.
		const out = await computeAgentDeletions(env.dir, baseOid, shadowOid, headOid, ['x.ts'], 15);
		expect(out).toBe(0);
	});
});

describe('attribution.estimateUserSelfModifications', () => {
	it('uses LIFO assumption: user removed lines = own additions first', () => {
		const accumulatedAdded = { 'x.ts': 5 };
		const postRemoved = { 'x.ts': 8 };
		// min(8, 5) = 5
		expect(estimateUserSelfModifications(accumulatedAdded, postRemoved)).toBe(5);
	});

	it('returns 0 when no overlap in files', () => {
		expect(estimateUserSelfModifications({ 'a.ts': 10 }, { 'b.ts': 5 })).toBe(0);
	});
});

// ─── isAgentOrMetadataFile ────────────────────────────────────────────
// Go: cmd/entire/cli/strategy/manual_commit_attribution.go isAgentOrMetadataFile
describe('attribution.isAgentOrMetadataFile', () => {
	it('returns true for paths in filesTouched', () => {
		expect(isAgentOrMetadataFile('src/app.ts', ['src/app.ts'], null)).toBe(true);
	});

	it('returns true for paths in allAgentFiles', () => {
		expect(isAgentOrMetadataFile('src/other.ts', [], new Set(['src/other.ts']))).toBe(true);
	});

	it('returns true for .story/ and .entire/ prefixes', () => {
		expect(isAgentOrMetadataFile('.story/state.json', [], null)).toBe(true);
		expect(isAgentOrMetadataFile('.entire/log', [], null)).toBe(true);
	});

	it('returns false for unrelated paths', () => {
		expect(isAgentOrMetadataFile('README.md', ['src/app.ts'], new Set())).toBe(false);
	});
});

// ─── getAllChangedFiles ───────────────────────────────────────────────
// Go: cmd/entire/cli/strategy/manual_commit_attribution.go getAllChangedFiles + getAllChangedFilesBetweenTreesSlow
describe('attribution.getAllChangedFiles', () => {
	let env: TestEnv;
	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
	});
	afterEach(async () => {
		await env.cleanup();
	});

	it('uses git diff-tree CLI when both commit hashes present', async () => {
		// Make 2 commits and diff between them via the fast path.
		await env.writeFile('a.txt', 'one');
		await env.gitAdd('a.txt');
		const c1 = await env.gitCommit('add a');
		await env.writeFile('b.txt', 'two');
		await env.gitAdd('b.txt');
		const c2 = await env.gitCommit('add b');

		const files = await getAllChangedFiles(env.dir, null, null, env.dir, c1, c2);
		expect(files.sort()).toContain('b.txt');
	});

	it('falls back to slow tree walk when both commit hashes are empty', async () => {
		// Build two divergent trees and diff via the slow path.
		const blob1 = await git.writeBlob({
			fs: fsCallback,
			dir: env.dir,
			blob: new TextEncoder().encode('x'),
		});
		const blob2 = await git.writeBlob({
			fs: fsCallback,
			dir: env.dir,
			blob: new TextEncoder().encode('y'),
		});
		const tree1 = await git.writeTree({
			fs: fsCallback,
			dir: env.dir,
			tree: [{ mode: '100644', path: 'shared.txt', oid: blob1, type: 'blob' }],
		});
		const tree2 = await git.writeTree({
			fs: fsCallback,
			dir: env.dir,
			tree: [
				{ mode: '100644', path: 'shared.txt', oid: blob2, type: 'blob' },
				{ mode: '100644', path: 'extra.txt', oid: blob1, type: 'blob' },
			],
		});
		const files = await getAllChangedFiles(env.dir, tree1, tree2, env.dir, '', '');
		expect(new Set(files)).toEqual(new Set(['shared.txt', 'extra.txt']));
	});

	it('returns [] when both trees are null', async () => {
		expect(await getAllChangedFiles(env.dir, null, null, env.dir, '', '')).toEqual([]);
	});
});

// ─── calculateAttributionWithAccumulated (integration) ───────────────
// Go: cmd/entire/cli/strategy/manual_commit_attribution.go CalculateAttributionWithAccumulated
describe('attribution.calculateAttributionWithAccumulated', () => {
	it('returns null when filesTouched is empty', async () => {
		const out = await calculateAttributionWithAccumulated({
			repoDir: '/tmp/no-such-dir',
			baseTreeOid: null,
			shadowTreeOid: null,
			headTreeOid: '0000000000000000000000000000000000000000',
			parentTreeOid: null,
			filesTouched: [],
			promptAttributions: [],
			parentCommitHash: '',
			attributionBaseCommit: '',
			headCommitHash: '',
			allAgentFiles: null,
		});
		expect(out).toBeNull();
	});

	it('returns InitialAttribution with metricVersion=2', async () => {
		const env = await TestEnv.create({ initialCommit: true });
		try {
			async function tree(name: string, content: string): Promise<string> {
				const blob = await git.writeBlob({
					fs: fsCallback,
					dir: env.dir,
					blob: new TextEncoder().encode(content),
				});
				return git.writeTree({
					fs: fsCallback,
					dir: env.dir,
					tree: [{ mode: '100644', path: name, oid: blob, type: 'blob' }],
				});
			}
			// Simple agent work: base empty, shadow has 5 agent lines, head matches shadow.
			const baseOid = await tree('app.ts', '');
			const shadowOid = await tree('app.ts', 'a1\na2\na3\na4\na5\n');
			const headOid = shadowOid;
			const params: AttributionParams = {
				repoDir: env.dir,
				baseTreeOid: baseOid,
				shadowTreeOid: shadowOid,
				headTreeOid: headOid,
				parentTreeOid: baseOid,
				filesTouched: ['app.ts'],
				promptAttributions: [],
				parentCommitHash: '',
				attributionBaseCommit: '',
				headCommitHash: '',
				allAgentFiles: null,
			};
			const out = await calculateAttributionWithAccumulated(params);
			expect(out).not.toBeNull();
			expect(out?.metricVersion).toBe(2);
			expect(out?.agentLines).toBe(5);
			expect(out?.humanAdded).toBe(0);
			expect(out?.agentPercentage).toBeCloseTo(100, 0);
		} finally {
			await env.cleanup();
		}
	});

	it('returns null when diffNonAgentFiles fails (slow path with bogus tree oids)', async () => {
		const env = await TestEnv.create({ initialCommit: true });
		try {
			const params: AttributionParams = {
				repoDir: env.dir,
				baseTreeOid: '1111111111111111111111111111111111111111',
				shadowTreeOid: null,
				headTreeOid: '2222222222222222222222222222222222222222',
				parentTreeOid: null,
				filesTouched: ['app.ts'],
				promptAttributions: [],
				parentCommitHash: '',
				attributionBaseCommit: '',
				headCommitHash: '',
				allAgentFiles: null,
			};
			const out = await calculateAttributionWithAccumulated(params);
			// Slow tree walk against a bogus tree oid → diffNonAgentFiles propagates → null.
			expect(out).toBeNull();
		} finally {
			await env.cleanup();
		}
	});

	it('agentPercentage = 0 when totalLinesChanged = 0', async () => {
		const env = await TestEnv.create({ initialCommit: true });
		try {
			// Same content across all three trees → no diff anywhere.
			const blob = await git.writeBlob({
				fs: fsCallback,
				dir: env.dir,
				blob: new TextEncoder().encode('static\n'),
			});
			const oid = await git.writeTree({
				fs: fsCallback,
				dir: env.dir,
				tree: [{ mode: '100644', path: 'app.ts', oid: blob, type: 'blob' }],
			});
			const params: AttributionParams = {
				repoDir: env.dir,
				baseTreeOid: oid,
				shadowTreeOid: oid,
				headTreeOid: oid,
				parentTreeOid: oid,
				filesTouched: ['app.ts'],
				promptAttributions: [],
				parentCommitHash: '',
				attributionBaseCommit: '',
				headCommitHash: '',
				allAgentFiles: null,
			};
			const out = await calculateAttributionWithAccumulated(params);
			expect(out?.agentPercentage).toBe(0);
			expect(out?.totalLinesChanged).toBe(0);
		} finally {
			await env.cleanup();
		}
	});
});

// ─── calculatePromptAttribution (Phase 5.4 export) ────────────────────
// Go: cmd/entire/cli/strategy/manual_commit_attribution.go CalculatePromptAttribution
describe('attribution.calculatePromptAttribution', () => {
	let env: TestEnv;
	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
	});
	afterEach(async () => {
		await env.cleanup();
	});

	it('returns checkpointNumber=1 with all-zero agent lines for first checkpoint', async () => {
		const blob = await git.writeBlob({
			fs: fsCallback,
			dir: env.dir,
			blob: new TextEncoder().encode('base\n'),
		});
		const baseOid = await git.writeTree({
			fs: fsCallback,
			dir: env.dir,
			tree: [{ mode: '100644', path: 'app.ts', oid: blob, type: 'blob' }],
		});
		const out = await calculatePromptAttribution(
			env.dir,
			baseOid,
			null,
			new Map([['app.ts', 'base\nmodified\n']]),
			1,
		);
		expect(out.checkpointNumber).toBe(1);
		expect(out.agentLinesAdded).toBe(0);
		expect(out.agentLinesRemoved).toBe(0);
		// User added 1 line ('modified') since base.
		expect(out.userLinesAdded).toBe(1);
	});
});

// ─────────────────────────────────────────────────────────────────────
// Go-aligned 18-scenario integration suite for CalculateAttributionWithAccumulated
// Each case is a 1:1 port of a Go test in
//   entire-cli/cmd/entire/cli/strategy/manual_commit_attribution_test.go
// using the same fixture content; expected values are the Go test's
// ground truth (NOT TS inference). Per testing-discipline.md §1.
// ─────────────────────────────────────────────────────────────────────

describe('attribution.calculateAttributionWithAccumulated — Go-aligned integration scenarios', () => {
	let env: TestEnv;
	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
	});
	afterEach(async () => {
		await env.cleanup();
	});

	// Mirrors Go buildTestTree — returns null when files map is empty.
	async function buildTree(files: Record<string, string>): Promise<string | null> {
		const entries: Array<{ mode: string; path: string; oid: string; type: 'blob' }> = [];
		for (const [name, content] of Object.entries(files)) {
			const oid = await git.writeBlob({
				fs: fsCallback,
				dir: env.dir,
				blob: new TextEncoder().encode(content),
			});
			entries.push({ mode: '100644', path: name, oid, type: 'blob' });
		}
		if (entries.length === 0) {
			return null;
		}
		// Sort by path (git tree format requirement)
		entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
		return git.writeTree({ fs: fsCallback, dir: env.dir, tree: entries });
	}

	function pa(opts: {
		checkpointNumber: number;
		userLinesAdded?: number;
		userLinesRemoved?: number;
		userAddedPerFile?: Record<string, number>;
		userRemovedPerFile?: Record<string, number>;
	}): PromptAttribution {
		return {
			checkpointNumber: opts.checkpointNumber,
			userLinesAdded: opts.userLinesAdded ?? 0,
			userLinesRemoved: opts.userLinesRemoved ?? 0,
			agentLinesAdded: 0,
			agentLinesRemoved: 0,
			userAddedPerFile: opts.userAddedPerFile,
			userRemovedPerFile: opts.userRemovedPerFile,
		};
	}

	async function runAttribution(p: {
		baseTreeOid: string | null;
		shadowTreeOid: string | null;
		headTreeOid: string | null;
		parentTreeOid?: string | null;
		filesTouched: string[];
		promptAttributions?: PromptAttribution[];
		allAgentFiles?: ReadonlySet<string> | null;
	}) {
		const params: AttributionParams = {
			repoDir: env.dir,
			baseTreeOid: p.baseTreeOid,
			shadowTreeOid: p.shadowTreeOid,
			headTreeOid: p.headTreeOid ?? '',
			parentTreeOid: p.parentTreeOid ?? null,
			filesTouched: p.filesTouched,
			promptAttributions: p.promptAttributions ?? [],
			parentCommitHash: '',
			attributionBaseCommit: '',
			headCommitHash: '',
			allAgentFiles: p.allAgentFiles ?? null,
		};
		return calculateAttributionWithAccumulated(params);
	}

	// Go: TestCalculateAttributionWithAccumulated_BasicCase
	// Agent adds 8 lines, user adds 2 more. Expected agent% = 80%.
	it('BasicCase: agent +8 / user +2 → agent=8 / human=2 / 80%', async () => {
		const baseTree = await buildTree({ 'main.go': '' });
		const shadowTree = await buildTree({
			'main.go': 'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\n',
		});
		const headTree = await buildTree({
			'main.go': 'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nuser1\nuser2\n',
		});
		const r = await runAttribution({
			baseTreeOid: baseTree,
			shadowTreeOid: shadowTree,
			headTreeOid: headTree,
			filesTouched: ['main.go'],
		});
		expect(r).not.toBeNull();
		expect(r?.agentLines).toBe(8);
		expect(r?.humanAdded).toBe(2);
		expect(r?.humanModified).toBe(0);
		expect(r?.humanRemoved).toBe(0);
		expect(r?.totalCommitted).toBe(10);
		expect(r?.agentPercentage).toBeCloseTo(80, 1);
		expect(r?.metricVersion).toBe(2);
	});

	// Go: TestCalculateAttributionWithAccumulated_BugScenario
	// Agent +10, user removes 5 + adds 2. min(2,5)=2 modifications. Agent=5.
	it('BugScenario: agent +10 / user -5 +2 → agent=5 / mod=2 / removed=3 / 50%', async () => {
		const baseTree = await buildTree({ 'main.go': '' });
		const shadowTree = await buildTree({
			'main.go':
				'agent1\nagent2\nagent3\nagent4\nagent5\nagent6\nagent7\nagent8\nagent9\nagent10\n',
		});
		const headTree = await buildTree({
			'main.go': 'agent1\nagent2\nagent3\nagent4\nagent5\nuser1\nuser2\n',
		});
		const r = await runAttribution({
			baseTreeOid: baseTree,
			shadowTreeOid: shadowTree,
			headTreeOid: headTree,
			filesTouched: ['main.go'],
		});
		expect(r).not.toBeNull();
		expect(r?.agentLines).toBe(5);
		expect(r?.humanAdded).toBe(0);
		expect(r?.humanModified).toBe(2);
		expect(r?.humanRemoved).toBe(3);
		expect(r?.totalCommitted).toBe(7);
		expect(r?.totalLinesChanged).toBe(10);
		expect(r?.agentPercentage).toBeCloseTo(50, 1);
	});

	// Go: TestCalculateAttributionWithAccumulated_DeletionOnly
	// Agent -2, user -2. Total changed = 4. Agent% = 50%.
	it('DeletionOnly: agent -2 / user -2 → agentLines=0 / agentRemoved=2 / total=0 / 50%', async () => {
		const baseTree = await buildTree({ 'main.go': 'line1\nline2\nline3\nline4\nline5\n' });
		const shadowTree = await buildTree({ 'main.go': 'line1\nline2\nline3\n' });
		const headTree = await buildTree({ 'main.go': 'line1\n' });
		const r = await runAttribution({
			baseTreeOid: baseTree,
			shadowTreeOid: shadowTree,
			headTreeOid: headTree,
			filesTouched: ['main.go'],
		});
		expect(r).not.toBeNull();
		expect(r?.agentLines).toBe(0);
		expect(r?.agentRemoved).toBe(2);
		expect(r?.humanAdded).toBe(0);
		expect(r?.humanRemoved).toBe(2);
		expect(r?.totalCommitted).toBe(0);
		expect(r?.totalLinesChanged).toBe(4);
		expect(r?.agentPercentage).toBe(50);
	});

	// Go: TestCalculateAttributionWithAccumulated_AgentOnlyDeletionOnly
	// Agent -2, user 0. Total changed = 2. Agent% = 100%.
	it('AgentOnlyDeletionOnly: agent -2 / user 0 → agentRemoved=2 / total=0 / 100%', async () => {
		const baseTree = await buildTree({ 'main.go': 'line1\nline2\nline3\nline4\n' });
		const shadowTree = await buildTree({ 'main.go': 'line1\nline2\n' });
		const headTree = await buildTree({ 'main.go': 'line1\nline2\n' });
		const r = await runAttribution({
			baseTreeOid: baseTree,
			shadowTreeOid: shadowTree,
			headTreeOid: headTree,
			filesTouched: ['main.go'],
		});
		expect(r).not.toBeNull();
		expect(r?.agentLines).toBe(0);
		expect(r?.agentRemoved).toBe(2);
		expect(r?.humanAdded).toBe(0);
		expect(r?.humanRemoved).toBe(0);
		expect(r?.totalCommitted).toBe(0);
		expect(r?.totalLinesChanged).toBe(2);
		expect(r?.agentPercentage).toBe(100);
	});

	// Go: TestCalculateAttributionWithAccumulated_NoUserEdits
	// Pure agent work, no user edits.
	it('NoUserEdits: agent +5 / shadow==head → agent=5 / total=5 / 100%', async () => {
		const baseTree = await buildTree({ 'main.go': '' });
		const shadowTree = await buildTree({
			'main.go': 'agent1\nagent2\nagent3\nagent4\nagent5\n',
		});
		const headTree = shadowTree;
		const r = await runAttribution({
			baseTreeOid: baseTree,
			shadowTreeOid: shadowTree,
			headTreeOid: headTree,
			filesTouched: ['main.go'],
		});
		expect(r).not.toBeNull();
		expect(r?.agentLines).toBe(5);
		expect(r?.humanAdded).toBe(0);
		expect(r?.humanModified).toBe(0);
		expect(r?.humanRemoved).toBe(0);
		expect(r?.totalCommitted).toBe(5);
		expect(r?.agentPercentage).toBe(100);
	});

	// Go: TestCalculateAttributionWithAccumulated_NoAgentWork
	// base==shadow (no agent), user adds 2.
	it('NoAgentWork: base==shadow / user +2 → agent=0 / human=2 / 0%', async () => {
		const content = 'line1\nline2\nline3\n';
		const baseTree = await buildTree({ 'main.go': content });
		const shadowTree = await buildTree({ 'main.go': content });
		const headTree = await buildTree({ 'main.go': `${content}user1\nuser2\n` });
		const r = await runAttribution({
			baseTreeOid: baseTree,
			shadowTreeOid: shadowTree,
			headTreeOid: headTree,
			filesTouched: ['main.go'],
		});
		expect(r).not.toBeNull();
		expect(r?.agentLines).toBe(0);
		expect(r?.humanAdded).toBe(2);
		expect(r?.humanModified).toBe(0);
		expect(r?.humanRemoved).toBe(0);
		expect(r?.totalCommitted).toBe(2);
		expect(r?.agentPercentage).toBe(0);
	});

	// Go: TestCalculateAttributionWithAccumulated_UserRemovesAllAgentLines
	// Agent +5, user replaces with 3 own lines. min(3,5)=3 modifications.
	it('UserRemovesAllAgentLines: agent +5 / user replaces → agent=0 / mod=3 / removed=2 / 0%', async () => {
		const baseTree = await buildTree({ 'main.go': '' });
		const shadowTree = await buildTree({
			'main.go': 'agent1\nagent2\nagent3\nagent4\nagent5\n',
		});
		const headTree = await buildTree({ 'main.go': 'user1\nuser2\nuser3\n' });
		const r = await runAttribution({
			baseTreeOid: baseTree,
			shadowTreeOid: shadowTree,
			headTreeOid: headTree,
			filesTouched: ['main.go'],
		});
		expect(r).not.toBeNull();
		expect(r?.agentLines).toBe(0);
		expect(r?.humanAdded).toBe(0);
		expect(r?.humanModified).toBe(3);
		expect(r?.humanRemoved).toBe(2);
		expect(r?.totalCommitted).toBe(3);
		expect(r?.agentPercentage).toBe(0);
	});

	// Go: TestCalculateAttributionWithAccumulated_WithPromptAttributions
	// PA captures user lines added between checkpoints; algorithm subtracts them from agent count.
	it('WithPromptAttributions: agent +10 + 2 between + 1 after → agent=10 / human=3 / 76.9%', async () => {
		const baseTree = await buildTree({ 'main.go': '' });
		const shadowTree = await buildTree({
			'main.go':
				'agent1\nagent2\nuser_between1\nuser_between2\nagent3\nagent4\nagent5\nagent6\nagent7\nagent8\nagent9\nagent10\n',
		});
		const headTree = await buildTree({
			'main.go':
				'agent1\nagent2\nuser_between1\nuser_between2\nagent3\nagent4\nagent5\nagent6\nagent7\nagent8\nagent9\nagent10\nuser_after\n',
		});
		const r = await runAttribution({
			baseTreeOid: baseTree,
			shadowTreeOid: shadowTree,
			headTreeOid: headTree,
			filesTouched: ['main.go'],
			promptAttributions: [
				pa({ checkpointNumber: 2, userLinesAdded: 2, userAddedPerFile: { 'main.go': 2 } }),
			],
		});
		expect(r).not.toBeNull();
		expect(r?.agentLines).toBe(10);
		expect(r?.humanAdded).toBe(3);
		expect(r?.humanModified).toBe(0);
		expect(r?.humanRemoved).toBe(0);
		expect(r?.totalCommitted).toBe(13);
		expect(r?.agentPercentage).toBeCloseTo(76.9, 0);
	});

	// Go: TestCalculateAttributionWithAccumulated_UserEditsNonAgentFile
	// PA1 captures pre-session edits to non-agent file; user adds 2 MORE post-checkpoint.
	// Pre-session is baseline-subtracted, post-checkpoint counts.
	it('UserEditsNonAgentFile: agent file1 +3 / PA1 file2 +2 (baseline) / post +2 → agent=3 / human=2 / 60%', async () => {
		const baseTree = await buildTree({
			'file1.go': 'package main\n',
			'file2.go': 'package util\n',
		});
		const shadowTree = await buildTree({
			'file1.go': 'package main\n\nfunc agent1() {}\nfunc agent2() {}\n',
		});
		const headTree = await buildTree({
			'file1.go': 'package main\n\nfunc agent1() {}\nfunc agent2() {}\n',
			'file2.go': 'package util\n\n// User edit 1\n// User edit 2\n// User edit 3\n',
		});
		const r = await runAttribution({
			baseTreeOid: baseTree,
			shadowTreeOid: shadowTree,
			headTreeOid: headTree,
			filesTouched: ['file1.go'],
			promptAttributions: [
				pa({ checkpointNumber: 1, userLinesAdded: 2, userAddedPerFile: { 'file2.go': 2 } }),
			],
		});
		expect(r).not.toBeNull();
		expect(r?.agentLines).toBe(3);
		expect(r?.humanAdded).toBe(2);
		expect(r?.totalCommitted).toBe(5);
		expect(r?.agentPercentage).toBeCloseTo(60, 1);
	});

	// Go: TestCalculateAttributionWithAccumulated_UserSelfModification
	// User added 5 between, then removed 3 + added 3 (own self-mod via LIFO). Agent unchanged.
	it('UserSelfModification: agent +10 / user +5 / user -3 +3 (self-mod LIFO) → agent=10 / human=5 / mod=3 / 55.6%', async () => {
		const baseTree = await buildTree({ 'main.go': '' });
		const shadowTree = await buildTree({
			'main.go':
				'agent1\nagent2\nagent3\nagent4\nagent5\nagent6\nagent7\nagent8\nagent9\nagent10\nuser1\nuser2\nuser3\nuser4\nuser5\n',
		});
		const headTree = await buildTree({
			'main.go':
				'agent1\nagent2\nagent3\nagent4\nagent5\nagent6\nagent7\nagent8\nagent9\nagent10\nuser1\nuser2\nnew_user1\nnew_user2\nnew_user3\n',
		});
		const r = await runAttribution({
			baseTreeOid: baseTree,
			shadowTreeOid: shadowTree,
			headTreeOid: headTree,
			filesTouched: ['main.go'],
			promptAttributions: [
				pa({ checkpointNumber: 2, userLinesAdded: 5, userAddedPerFile: { 'main.go': 5 } }),
			],
		});
		expect(r).not.toBeNull();
		expect(r?.agentLines).toBe(10);
		expect(r?.humanAdded).toBe(5);
		expect(r?.humanModified).toBe(3);
		expect(r?.totalCommitted).toBe(15);
		expect(r?.totalLinesChanged).toBe(18);
		expect(r?.agentPercentage).toBeCloseTo(55.6, 0);
	});

	// Go: TestCalculateAttributionWithAccumulated_MixedModifications
	// User exhausts self-mod pool; remaining 2 modifications targets agent lines.
	it('MixedModifications: agent +10 / user +3 / user -5 +5 (3 self + 2 agent) → agent=8 / mod=5 / 50%', async () => {
		const baseTree = await buildTree({ 'main.go': '' });
		const shadowTree = await buildTree({
			'main.go':
				'agent1\nagent2\nagent3\nagent4\nagent5\nagent6\nagent7\nagent8\nagent9\nagent10\nuser1\nuser2\nuser3\n',
		});
		const headTree = await buildTree({
			'main.go':
				'agent1\nagent2\nagent3\nagent4\nagent5\nagent6\nagent7\nagent8\nnew1\nnew2\nnew3\nnew4\nnew5\n',
		});
		const r = await runAttribution({
			baseTreeOid: baseTree,
			shadowTreeOid: shadowTree,
			headTreeOid: headTree,
			filesTouched: ['main.go'],
			promptAttributions: [
				pa({ checkpointNumber: 2, userLinesAdded: 3, userAddedPerFile: { 'main.go': 3 } }),
			],
		});
		expect(r).not.toBeNull();
		expect(r?.agentLines).toBe(8);
		expect(r?.humanModified).toBe(5);
		expect(r?.totalCommitted).toBe(13);
		expect(r?.totalLinesChanged).toBe(16);
		expect(r?.agentPercentage).toBeCloseTo(50, 1);
	});

	// Go: TestCalculateAttributionWithAccumulated_UncommittedWorktreeFiles
	// PA captured pre-session .claude/settings.json (84 lines) but file NEVER committed.
	// Critical bug regression: should NOT inflate humanAdded.
	it('UncommittedWorktreeFiles: PA1 file not in head → not counted as humanAdded', async () => {
		const agentContent =
			'# Software Testing\n\nSoftware testing is a critical part of the development process.\n\n## Types of Testing\n\n- Unit testing\n- Integration testing\n- End-to-end testing\n\n## Best Practices\n\nWrite tests early.\nAutomate where possible.\nTest edge cases.\nReview test coverage.\n';
		const agentLines = countLinesStr(agentContent);
		const baseTree = await buildTree({});
		const shadowTree = await buildTree({ 'example.md': agentContent });
		const headTree = await buildTree({ 'example.md': agentContent });
		const r = await runAttribution({
			baseTreeOid: baseTree,
			shadowTreeOid: shadowTree,
			headTreeOid: headTree,
			filesTouched: ['example.md'],
			promptAttributions: [
				pa({
					checkpointNumber: 1,
					userLinesAdded: 84,
					userAddedPerFile: { '.claude/settings.json': 84 },
				}),
			],
		});
		expect(r).not.toBeNull();
		expect(r?.agentLines).toBe(agentLines);
		expect(r?.humanAdded).toBe(0);
		expect(r?.totalCommitted).toBe(agentLines);
		expect(r?.agentPercentage).toBe(100);
	});

	// Go: TestCalculateAttributionWithAccumulated_PreSessionDirtOnAgentFiles
	// PA1 captures 3 pre-session dirty lines on hooks.go; agent then adds 5 more.
	// Pre-session dirt subtracted from human, agent gets 5 (not 8).
	it('PreSessionDirtOnAgentFiles: PA1 hooks.go +3 (pre-session) / agent +5 → agent=5 / human=0 / 100%', async () => {
		const baseTree = await buildTree({
			'hooks.go': 'package strategy\n\nfunc warn() {}\n',
		});
		const shadowContent =
			'package strategy\n\n// pre1\n// pre2\n// pre3\nfunc agentA() {}\nfunc agentB() {}\nfunc agentC() {}\nfunc agentD() {}\nfunc agentE() {}\nfunc warn() {}\n';
		const shadowTree = await buildTree({ 'hooks.go': shadowContent });
		const headTree = shadowTree;
		const r = await runAttribution({
			baseTreeOid: baseTree,
			shadowTreeOid: shadowTree,
			headTreeOid: headTree,
			filesTouched: ['hooks.go'],
			promptAttributions: [
				pa({ checkpointNumber: 1, userLinesAdded: 3, userAddedPerFile: { 'hooks.go': 3 } }),
			],
		});
		expect(r).not.toBeNull();
		expect(r?.agentLines).toBe(5);
		expect(r?.humanAdded).toBe(0);
		expect(r?.totalCommitted).toBe(5);
		expect(r?.agentPercentage).toBeCloseTo(100, 1);
	});

	// Go: TestCalculateAttributionWithAccumulated_PreSessionConfigFiles
	// PA1 captures pre-session config.json (10 lines); agent creates hello.py (5 lines).
	// Config file is non-agent + pre-session → must NOT count as human.
	it('PreSessionConfigFiles: PA1 config.json +10 (pre-session) / agent hello.py +5 → agent=5 / human=0 / 100%', async () => {
		const baseTree = await buildTree({ empty: '' });
		const shadowTree = await buildTree({
			empty: '',
			'hello.py': 'line1\nline2\nline3\nline4\nline5\n',
			'config.json': 'k1\nk2\nk3\nk4\nk5\nk6\nk7\nk8\nk9\nk10\n',
		});
		const headTree = shadowTree;
		const r = await runAttribution({
			baseTreeOid: baseTree,
			shadowTreeOid: shadowTree,
			headTreeOid: headTree,
			filesTouched: ['hello.py'],
			promptAttributions: [
				pa({
					checkpointNumber: 1,
					userLinesAdded: 10,
					userAddedPerFile: { 'config.json': 10 },
				}),
			],
		});
		expect(r).not.toBeNull();
		expect(r?.agentLines).toBe(5);
		expect(r?.humanAdded).toBe(0);
		expect(r?.totalCommitted).toBe(5);
		expect(r?.agentPercentage).toBeCloseTo(100, 1);
	});

	// Go: TestCalculateAttributionWithAccumulated_DuringSessionHumanEdits
	// PA2 captures 2 user edits AFTER PA1 baseline. Those 2 still count as human.
	it('DuringSessionHumanEdits: PA1 clean / PA2 user +2 / total 12 lines → agent=10 / human=2 / 83.3%', async () => {
		const baseTree = await buildTree({ 'main.go': '' });
		const shadowTree = await buildTree({
			'main.go': 'a1\na2\na3\na4\na5\na6\na7\na8\nu1\nu2\na9\na10\n',
		});
		const headTree = shadowTree;
		const r = await runAttribution({
			baseTreeOid: baseTree,
			shadowTreeOid: shadowTree,
			headTreeOid: headTree,
			filesTouched: ['main.go'],
			promptAttributions: [
				pa({ checkpointNumber: 1, userLinesAdded: 0, userAddedPerFile: {} }),
				pa({ checkpointNumber: 2, userLinesAdded: 2, userAddedPerFile: { 'main.go': 2 } }),
			],
		});
		expect(r).not.toBeNull();
		expect(r?.agentLines).toBe(10);
		expect(r?.humanAdded).toBe(2);
		expect(r?.totalCommitted).toBe(12);
		expect(r?.agentPercentage).toBeCloseTo(83.3, 0);
	});

	// Go: TestCalculateAttributionWithAccumulated_EmptyPA
	// No prompt attributions at all (legacy session / edge case).
	it('EmptyPA: no PromptAttributions / agent +3 → agent=3 / human=0 / 100%', async () => {
		const baseTree = await buildTree({ 'main.go': '' });
		const shadowTree = await buildTree({ 'main.go': 'line1\nline2\nline3\n' });
		const headTree = shadowTree;
		const r = await runAttribution({
			baseTreeOid: baseTree,
			shadowTreeOid: shadowTree,
			headTreeOid: headTree,
			filesTouched: ['main.go'],
			promptAttributions: [],
		});
		expect(r).not.toBeNull();
		expect(r?.agentLines).toBe(3);
		expect(r?.humanAdded).toBe(0);
		expect(r?.agentPercentage).toBeCloseTo(100, 1);
	});

	// Go: TestCalculateAttributionWithAccumulated_ParentTreeForNonAgentLines
	// Multi-commit session: parentTree present should ONLY count THIS commit's edits.
	it('ParentTreeForNonAgentLines: WITH parentTree → only THIS commit human=3', async () => {
		const baseTree = await buildTree({
			'main.go': '',
			'readme.md': 'line1\nline2\n',
		});
		const parentTree = await buildTree({
			'main.go': '',
			'readme.md': 'line1\nline2\ninter1\ninter2\ninter3\ninter4\ninter5\n',
		});
		const shadowTree = await buildTree({
			'main.go': 'func a() {}\nfunc b() {}\nfunc c() {}\nfunc d() {}\n',
			'readme.md': 'line1\nline2\ninter1\ninter2\ninter3\ninter4\ninter5\n',
		});
		const headTree = await buildTree({
			'main.go': 'func a() {}\nfunc b() {}\nfunc c() {}\nfunc d() {}\n',
			'readme.md': 'line1\nline2\ninter1\ninter2\ninter3\ninter4\ninter5\nnew1\nnew2\nnew3\n',
		});

		const withParent = await runAttribution({
			baseTreeOid: baseTree,
			shadowTreeOid: shadowTree,
			headTreeOid: headTree,
			parentTreeOid: parentTree,
			filesTouched: ['main.go'],
		});
		expect(withParent).not.toBeNull();
		expect(withParent?.agentLines).toBe(4);
		expect(withParent?.humanAdded).toBe(3);
		expect(withParent?.totalCommitted).toBe(7);
		expect(withParent?.agentPercentage).toBeCloseTo(57.1, 0);

		// Without parentTree: falls back to baseTree → counts all 8 lines (the bug).
		const withoutParent = await runAttribution({
			baseTreeOid: baseTree,
			shadowTreeOid: shadowTree,
			headTreeOid: headTree,
			filesTouched: ['main.go'],
		});
		expect(withoutParent?.humanAdded).toBe(8);
	});

	// Go: TestCalculateAttributionWithAccumulated_MultiSessionCrossExclusion
	// Two-session scenario: red.md from session 1 must NOT count as human in session 0.
	it('MultiSessionCrossExclusion: WITH allAgentFiles → red.md excluded; without → bug counts as human', async () => {
		const baseTree = await buildTree({});
		const shadowTree = await buildTree({ 'blue.md': 'line1\nline2\nline3\n' });
		const headTree = await buildTree({
			'blue.md': 'line1\nline2\nline3\n',
			'red.md': 'line1\nline2\nline3\n',
		});

		const withExcl = await runAttribution({
			baseTreeOid: baseTree,
			shadowTreeOid: shadowTree,
			headTreeOid: headTree,
			filesTouched: ['blue.md'],
			promptAttributions: [pa({ checkpointNumber: 1 })],
			allAgentFiles: new Set(['blue.md', 'red.md']),
		});
		expect(withExcl).not.toBeNull();
		expect(withExcl?.agentLines).toBe(3);
		expect(withExcl?.humanAdded).toBe(0);
		expect(withExcl?.totalCommitted).toBe(3);
		expect(withExcl?.agentPercentage).toBeCloseTo(100, 1);

		// Without allAgentFiles: red.md incorrectly counted as human (the regression target).
		const withoutExcl = await runAttribution({
			baseTreeOid: baseTree,
			shadowTreeOid: shadowTree,
			headTreeOid: headTree,
			filesTouched: ['blue.md'],
			promptAttributions: [pa({ checkpointNumber: 1 })],
		});
		expect(withoutExcl?.humanAdded).toBe(3);
	});
});

// ─── Diff edge-case coverage from Go test suite ──────────────────────
// Go: TestDiffLines_PercentageCalculation + TestDiffLines_ModifiedEstimation
describe('attribution.diffLines — Go-aligned edge cases', () => {
	// Go: TestDiffLines_PercentageCalculation
	it('counts 8 unchanged + 2 added when 8-line content has 2 lines appended', () => {
		const checkpoint = 'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\n';
		const committed = `${checkpoint}new1\nnew2\n`;
		const r = diffLines(checkpoint, committed);
		expect(r.unchanged).toBe(8);
		expect(r.added).toBe(2);
		expect(r.removed).toBe(0);
		expect(countLinesStr(committed)).toBe(10);
	});

	// Go: TestDiffLines_ModifiedEstimation
	it('returns 1 unchanged + 3 added + 2 removed for mixed modifications', () => {
		const checkpoint = 'original1\noriginal2\noriginal3\n';
		const committed = 'modified1\nmodified2\noriginal3\nnew line\n';
		const r = diffLines(checkpoint, committed);
		expect(r.unchanged).toBe(1);
		expect(r.added).toBe(3);
		expect(r.removed).toBe(2);
		// LIFO modification estimate: min(added, removed) = 2 modifications,
		// pure added = 1, pure removed = 0
		const humanModified = Math.min(r.added, r.removed);
		expect(humanModified).toBe(2);
		expect(r.added - humanModified).toBe(1);
		expect(r.removed - humanModified).toBe(0);
	});
});

// ─── estimateUserSelfModifications Go table test ────────────────────
// Go: TestEstimateUserSelfModifications (6 sub-cases, table-driven)
describe('attribution.estimateUserSelfModifications — Go table', () => {
	const cases: Array<{
		name: string;
		accAdded: Record<string, number>;
		postRemoved: Record<string, number>;
		expected: number;
	}> = [
		{ name: 'no removals', accAdded: { 'file.go': 5 }, postRemoved: {}, expected: 0 },
		{
			name: 'removals less than user added',
			accAdded: { 'file.go': 5 },
			postRemoved: { 'file.go': 3 },
			expected: 3,
		},
		{
			name: 'removals equal to user added',
			accAdded: { 'file.go': 5 },
			postRemoved: { 'file.go': 5 },
			expected: 5,
		},
		{
			name: 'removals exceed user added',
			accAdded: { 'file.go': 3 },
			postRemoved: { 'file.go': 5 },
			expected: 3,
		},
		{
			name: 'no user additions to file',
			accAdded: {},
			postRemoved: { 'file.go': 5 },
			expected: 0,
		},
		{
			name: 'multiple files (capped per file)',
			accAdded: { 'a.go': 3, 'b.go': 2 },
			postRemoved: { 'a.go': 2, 'b.go': 4 },
			expected: 4,
		},
	];
	for (const c of cases) {
		it(`Go table: ${c.name}`, () => {
			expect(estimateUserSelfModifications(c.accAdded, c.postRemoved)).toBe(c.expected);
		});
	}
});

// ─── getAllChangedFiles slow path: Go subtests ──────────────────────
// Go: TestGetAllChangedFilesBetweenTreesSlow — 6 subtests
describe('attribution.getAllChangedFiles slow path — Go subtests', () => {
	let env: TestEnv;
	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
	});
	afterEach(async () => {
		await env.cleanup();
	});

	async function tree(files: Record<string, string>): Promise<string | null> {
		const entries: Array<{ mode: string; path: string; oid: string; type: 'blob' }> = [];
		for (const [name, content] of Object.entries(files)) {
			const oid = await git.writeBlob({
				fs: fsCallback,
				dir: env.dir,
				blob: new TextEncoder().encode(content),
			});
			entries.push({ mode: '100644', path: name, oid, type: 'blob' });
		}
		if (entries.length === 0) {
			return null;
		}
		entries.sort((a, b) => a.path.localeCompare(b.path));
		return git.writeTree({ fs: fsCallback, dir: env.dir, tree: entries });
	}

	// Go: "both trees nil"
	it('both trees null → []', async () => {
		expect(await getAllChangedFiles(env.dir, null, null, env.dir, '', '')).toEqual([]);
	});

	// Go: "tree1 nil (all files added)"
	it('tree1 null → all of tree2 reported as added', async () => {
		const t2 = await tree({ 'file1.go': 'content1', 'file2.go': 'content2' });
		const result = (await getAllChangedFiles(env.dir, null, t2, env.dir, '', '')).sort();
		expect(result).toEqual(['file1.go', 'file2.go']);
	});

	// Go: "tree2 nil (all files deleted)"
	it('tree2 null → all of tree1 reported as deleted', async () => {
		const t1 = await tree({ 'file1.go': 'content1' });
		expect(await getAllChangedFiles(env.dir, t1, null, env.dir, '', '')).toEqual(['file1.go']);
	});

	// Go: "identical trees (no changes)"
	it('identical content trees → []', async () => {
		const t1 = await tree({ 'file1.go': 'same', 'file2.go': 'also same' });
		const t2 = await tree({ 'file1.go': 'same', 'file2.go': 'also same' });
		expect(await getAllChangedFiles(env.dir, t1, t2, env.dir, '', '')).toEqual([]);
	});

	// Go: "one file modified"
	it('one file modified → only that file reported', async () => {
		const t1 = await tree({ 'file1.go': 'original', 'unchanged.go': 'stays same' });
		const t2 = await tree({ 'file1.go': 'modified', 'unchanged.go': 'stays same' });
		expect(await getAllChangedFiles(env.dir, t1, t2, env.dir, '', '')).toEqual(['file1.go']);
	});

	// Go: "file added and deleted"
	it('file added + file deleted → both reported', async () => {
		const t1 = await tree({ 'deleted.go': 'will be removed', 'stays.go': 'unchanged' });
		const t2 = await tree({ 'added.go': 'new file', 'stays.go': 'unchanged' });
		const result = (await getAllChangedFiles(env.dir, t1, t2, env.dir, '', '')).sort();
		expect(result).toEqual(['added.go', 'deleted.go']);
	});
});
