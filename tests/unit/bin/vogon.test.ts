/**
 * Vogon binary unit tests. Covers:
 *
 *  - `parsePrompt` (pure) — 15 cases across Go regex grammar branches
 *    (single/multi create, modify, delete, commit, negation, numbered
 *    steps, inline content, "add ... to <path>" modify, interleave)
 *  - `executeActions` (side-effectful) — 3 cases: create+modify, commit
 *    with pending files, commit with empty pending (falls back to `add .`)
 *  - `fireHook` — 2 cases: happy exec, failure swallowed with stderr log
 *
 * Ground truth = Go `entire-cli/e2e/vogon/main.go` prompt-parse semantics.
 * Every regex-level expectation below traces to a specific line in that
 * file so future Go drift can be mirrored here by searching `// Go:`.
 */

import * as fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeActions, fireHook, parsePrompt, type VogonAction } from '../../../src/bin/vogon';

// execa is mocked by vitest — we never really spawn git or story in unit tests.
vi.mock('execa', () => ({
	execa: vi.fn(),
}));

// fs/promises operations we need to observe for executeActions cases.
// Return ONLY the methods Vogon uses + a synthetic `default` so both
// `import fs from ...` and `import * as fs from ...` resolve to the same
// mocked namespace. Spreading `...actual` here would inject real fs
// functions that cannot be replaced afterwards.
vi.mock('node:fs/promises', () => {
	const mkdir = vi.fn().mockResolvedValue(undefined);
	const writeFile = vi.fn().mockResolvedValue(undefined);
	const readFile = vi
		.fn()
		.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
	const unlink = vi.fn().mockResolvedValue(undefined);
	const appendFile = vi.fn().mockResolvedValue(undefined);
	const api = { mkdir, writeFile, readFile, unlink, appendFile };
	return { ...api, default: api };
});

describe('Vogon — parsePrompt — Go: e2e/vogon/main.go:158-268', () => {
	// -----------------------------------------------------------------
	// Single create variants
	// -----------------------------------------------------------------

	// Go: main.go:215-228 — single-file create with "about <topic>" suffix.
	it('"create a markdown file at docs/red.md with a paragraph about the colour red" → create docs/red.md, body "# the colour red\\n\\nA paragraph about the colour red.\\n"', () => {
		const actions = parsePrompt(
			'create a markdown file at docs/red.md with a paragraph about the colour red',
		);
		expect(actions).toEqual<VogonAction[]>([
			{
				kind: 'create',
				path: 'docs/red.md',
				content: '# the colour red\n\nA paragraph about the colour red.\n',
			},
		]);
	});

	// Go: main.go:219-221 — inline content literal beats "about <topic>".
	it('"create a file called foo.go with content \'package main; func Foo() {}\'" → inline content becomes body', () => {
		const actions = parsePrompt(
			`create a file called foo.go with content 'package main; func Foo() {}'`,
		);
		expect(actions).toEqual<VogonAction[]>([
			{ kind: 'create', path: 'foo.go', content: 'package main; func Foo() {}\n' },
		]);
	});

	// Go: main.go:215-228 — default topic fallback when no "about" phrase
	it('create without "about" phrase defaults topic to "the topic"', () => {
		const actions = parsePrompt('create a markdown file at foo.md');
		expect(actions[0]?.content).toBe('# the topic\n\nA paragraph about the topic.\n');
	});

	// -----------------------------------------------------------------
	// Multi-create + interleave
	// -----------------------------------------------------------------

	// Go: main.go:201-212 — multi-file create with "N files:" marker
	it('"create four markdown files: a.md about apples, b.md about bananas, ..." → 4 create actions', () => {
		const actions = parsePrompt(
			'create four markdown files: docs/a.md about apples, docs/b.md about bananas, docs/c.md about cherries, docs/d.md about dates.',
		);
		expect(actions).toHaveLength(4);
		expect(actions.map((a) => a.path)).toEqual([
			'docs/a.md',
			'docs/b.md',
			'docs/c.md',
			'docs/d.md',
		]);
		expect(actions[0]?.content).toBe('# apples\n\nA paragraph about apples.\n');
	});

	// Go: main.go:257-264 — "commit each file separately" → interleaved commits
	it('"create three markdown files: a.md about apples, b.md about bananas, c.md about cherries. Commit each file separately." → create/commit pairs', () => {
		const actions = parsePrompt(
			'create three markdown files: a.md about apples, b.md about bananas, c.md about cherries. Commit each file separately.',
		);
		expect(actions.map((a) => a.kind)).toEqual([
			'create',
			'commit',
			'create',
			'commit',
			'create',
			'commit',
		]);
	});

	// -----------------------------------------------------------------
	// Modify variants
	// -----------------------------------------------------------------

	// Go: main.go:231-239 — "modify <path>"
	it('"modify src/config.go to add GetPort()" → single modify with "// Modified by vogon agent" body', () => {
		const actions = parsePrompt('modify src/config.go to add GetPort() int that returns 8080');
		expect(actions).toEqual<VogonAction[]>([
			{ kind: 'modify', path: 'src/config.go', content: '// Modified by vogon agent\n' },
		]);
	});

	// Go: main.go:166-177 — multi-modify "should" pattern
	it('"modify these three files: src/a.go should define X, src/b.go should define Y, src/c.go should define Z" → 3 modify with comment content', () => {
		const actions = parsePrompt(
			'modify these three files: src/a.go should define X, src/b.go should define Y, src/c.go should define Z',
		);
		expect(actions).toHaveLength(3);
		expect(actions[0]).toEqual({
			kind: 'modify',
			path: 'src/a.go',
			content: '// define X\n',
		});
	});

	// Go: main.go:242-250 — "add ... to <path>" → modify (used by TestInteractiveAttributionMultiCommitSameSession)
	it('"add another stanza to poem.txt about debugging" → modify poem.txt', () => {
		const actions = parsePrompt('add another stanza to poem.txt about debugging');
		expect(actions).toEqual<VogonAction[]>([
			{ kind: 'modify', path: 'poem.txt', content: '// Modified by vogon agent\n' },
		]);
	});

	// -----------------------------------------------------------------
	// Delete
	// -----------------------------------------------------------------

	// Go: main.go:253-255 — "delete <path>" (used by TestDeletedFilesCommitDeletion)
	it('"delete the file to_delete.go" → single delete action', () => {
		const actions = parsePrompt('delete the file to_delete.go');
		expect(actions).toEqual<VogonAction[]>([{ kind: 'delete', path: 'to_delete.go', content: '' }]);
	});

	// -----------------------------------------------------------------
	// Commit / negation
	// -----------------------------------------------------------------

	// Go: main.go:262-264 — "commit" anywhere triggers commit action
	it('"create a file at foo.md, then commit" → create + commit', () => {
		const actions = parsePrompt('create a file at foo.md, then commit');
		expect(actions.map((a) => a.kind)).toEqual(['create', 'commit']);
	});

	// Go: main.go:136 noCommitRe — "Do not commit" suppresses commit action
	it('"create a file at foo.md. Do not commit." → create only, no commit', () => {
		const actions = parsePrompt('create a file at foo.md. Do not commit.');
		expect(actions.map((a) => a.kind)).toEqual(['create']);
	});

	// Go: main.go:136 noCommitRe — "don't commit" variant
	it(`"create a file at foo.md. Don't commit it." → create only`, () => {
		const actions = parsePrompt(`create a file at foo.md. Don't commit it.`);
		expect(actions.map((a) => a.kind)).toEqual(['create']);
	});

	// Go: main.go:131-136 — "commit any other files" is NOT "do not commit" suppression
	it('"create a file at foo.md. Do not commit any other files." → create + commit (negation only suppresses "commit" with simple object)', () => {
		const actions = parsePrompt('create a file at foo.md. Do not commit any other files.');
		// noCommitRe: (?:do\s+not|don'?t)\s+commit(?:\s+(?:it|them|the\s+\w+))?(?:\.|,|$)
		// "do not commit any other files" → `any` not in (it|them|the X) set → no negation match
		// commitRe: `commit\b` still matches → commit fires
		expect(actions.map((a) => a.kind)).toEqual(['create', 'commit']);
	});

	// -----------------------------------------------------------------
	// Numbered steps
	// -----------------------------------------------------------------

	// Go: main.go:273-358 — numbered-step dispatch preserves ordering.
	// Reproduces TestRapidSequentialCommits prompt.
	it('"(1) Create a.md. Run: git add && git commit. (2) Create b.md. Run: git add && git commit." → create, commit, create, commit', () => {
		const actions = parsePrompt(
			"(1) Create docs/red.md with a paragraph about the colour red. Run: git add docs/red.md && git commit -m 'Add red.md'. (2) Create docs/blue.md with a paragraph about the colour blue. Run: git add docs/blue.md && git commit -m 'Add blue.md'.",
		);
		expect(actions.map((a) => a.kind)).toEqual(['create', 'commit', 'create', 'commit']);
		expect(actions.map((a) => a.path)).toEqual(['docs/red.md', '', 'docs/blue.md', '']);
	});

	// Regression (Phase 10 E2E bug): `anyFileRe` is declared with the
	// global (`g`) flag for use in `parsePrompt`'s multi-modify fallback,
	// and `.exec()` on a global regex mutates `lastIndex`. Earlier
	// iterations through `parseNumberedSteps` leaked that state to the
	// next step's `anyFileRe.exec(step)` call, so a 3-step prompt would
	// mis-parse step 2 or 3 and drop / reorder the expected action list.
	// Guard: asserting that 3 numbered steps (each with embedded
	// `Run: git add ... && git commit`) produce exactly 6 actions with
	// paths in the correct order. Without `anyFileRe.lastIndex = 0` in
	// `parseNumberedSteps`, the third `docs/green.md` create silently
	// skipped or pointed at the `Run: git add docs/green.md` match.
	it('regression: parseNumberedSteps handles 3 steps without anyFileRe lastIndex leak', () => {
		const actions = parsePrompt(
			"(1) Create docs/red.md with a paragraph about the colour red. Run: git add docs/red.md && git commit -m 'Add red.md'. " +
				"(2) Create docs/blue.md with a paragraph about the colour blue. Run: git add docs/blue.md && git commit -m 'Add blue.md'. " +
				"(3) Create docs/green.md with a paragraph about the colour green. Run: git add docs/green.md && git commit -m 'Add green.md'.",
		);
		expect(actions.map((a) => a.kind)).toEqual([
			'create',
			'commit',
			'create',
			'commit',
			'create',
			'commit',
		]);
		expect(actions.filter((a) => a.kind === 'create').map((a) => a.path)).toEqual([
			'docs/red.md',
			'docs/blue.md',
			'docs/green.md',
		]);
	});

	// -----------------------------------------------------------------
	// Edge cases — Go-parity semantics
	// -----------------------------------------------------------------

	// Parsing completely benign text returns empty list (no actions).
	it('prompt with no actionable keywords → empty action list', () => {
		expect(parsePrompt('just some random text with no keywords')).toEqual([]);
	});

	// Empty prompt → empty action list (defensive).
	it('empty prompt → []', () => {
		expect(parsePrompt('')).toEqual([]);
	});

	// Non-ASCII file path from multi-file create.
	// (AGENTS.md testing discipline: at least 1 non-ASCII fixture.)
	it('non-ASCII path in multi-file create is preserved byte-for-byte', () => {
		const actions = parsePrompt(
			'create two markdown files: docs/红色.md about red, docs/蓝色.md about blue.',
		);
		expect(actions.map((a) => a.path)).toEqual(['docs/红色.md', 'docs/蓝色.md']);
	});
});

describe('Vogon — executeActions', () => {
	let mkdirMock: ReturnType<typeof vi.fn>;
	let writeFileMock: ReturnType<typeof vi.fn>;
	let readFileMock: ReturnType<typeof vi.fn>;
	let unlinkMock: ReturnType<typeof vi.fn>;
	let execaMock: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		mkdirMock = vi.mocked(fs.mkdir) as unknown as ReturnType<typeof vi.fn>;
		writeFileMock = vi.mocked(fs.writeFile) as unknown as ReturnType<typeof vi.fn>;
		readFileMock = vi.mocked(fs.readFile) as unknown as ReturnType<typeof vi.fn>;
		unlinkMock = vi.mocked(fs.unlink) as unknown as ReturnType<typeof vi.fn>;
		const execaModule = await import('execa');
		execaMock = vi.mocked(execaModule.execa) as unknown as ReturnType<typeof vi.fn>;
		execaMock.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0, all: '' } as never);
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	// Go: main.go:413-416 — create action mkdir (recursive) + writeFile (mode 0o644)
	it('create action writes file with 0o644 mode + mkdir recursive', async () => {
		await executeActions('/tmp/repo', [
			{ kind: 'create', path: 'docs/red.md', content: '# red\n' },
		]);
		expect(mkdirMock).toHaveBeenCalledWith(expect.stringMatching(/\/tmp\/repo\/docs$/), {
			recursive: true,
			mode: 0o755,
		});
		expect(writeFileMock).toHaveBeenCalledWith(
			expect.stringMatching(/\/tmp\/repo\/docs\/red\.md$/),
			'# red\n',
			{ mode: 0o644 },
		);
	});

	// Go: main.go:422-425 — commit with pending files → `git add -- <files>` + `git commit`
	it('commit with pending files → git add -- <files> then git commit', async () => {
		await executeActions('/tmp/repo', [
			{ kind: 'create', path: 'a.md', content: '' },
			{ kind: 'create', path: 'b.md', content: '' },
			{ kind: 'commit', path: '', content: '' },
		]);
		const gitCalls = execaMock.mock.calls.filter((c) => c[0] === 'git');
		expect(gitCalls).toHaveLength(2);
		expect(gitCalls[0]?.[1]).toEqual(['add', '--', 'a.md', 'b.md']);
		expect(gitCalls[1]?.[1]).toEqual(['commit', '-m', 'Vogon agent commit']);
	});

	// Go: main.go:457-459 — commit with NO pending (only delete or fresh) → fallback `git add .`
	it('commit with no pending files → git add . (fallback)', async () => {
		await executeActions('/tmp/repo', [{ kind: 'commit', path: '', content: '' }]);
		const gitCalls = execaMock.mock.calls.filter((c) => c[0] === 'git');
		expect(gitCalls[0]?.[1]).toEqual(['add', '.']);
	});

	// Go: main.go:449-453 — delete action
	it('delete action invokes fs.unlink', async () => {
		await executeActions('/tmp/repo', [{ kind: 'delete', path: 'to_delete.go', content: '' }]);
		expect(unlinkMock).toHaveBeenCalledWith(expect.stringMatching(/\/tmp\/repo\/to_delete\.go$/));
	});

	// Go: main.go:440-447 — modify reads existing (may ENOENT) + appends
	it('modify action reads existing then writes concatenated content', async () => {
		readFileMock.mockResolvedValueOnce('existing content');
		await executeActions('/tmp/repo', [{ kind: 'modify', path: 'main.go', content: '// new\n' }]);
		expect(writeFileMock).toHaveBeenCalledWith(
			expect.stringMatching(/\/tmp\/repo\/main\.go$/),
			'existing content\n// new\n',
			{ mode: 0o644 },
		);
	});
});

describe('Vogon — fireHook', () => {
	let execaMock: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		const execaModule = await import('execa');
		execaMock = vi.mocked(execaModule.execa) as unknown as ReturnType<typeof vi.fn>;
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	// Go: main.go:488-490 — STORY_BIN env override, args `['hooks', 'vogon', <verb>]`,
	// payload JSON on stdin, ENTIRE_TEST_TTY=0.
	it('fireHook spawns $STORY_BIN with ["hooks","vogon",<verb>] and stdin JSON', async () => {
		execaMock.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, all: '' } as never);
		vi.stubEnv('STORY_BIN', '/abs/story');

		await fireHook('/tmp/repo', 'session-start', { session_id: 'xyz' });

		expect(execaMock).toHaveBeenCalledWith(
			'/abs/story',
			['hooks', 'vogon', 'session-start'],
			expect.objectContaining({
				cwd: '/tmp/repo',
				input: '{"session_id":"xyz"}',
				env: expect.objectContaining({ ENTIRE_TEST_TTY: '0' }),
			}),
		);
		vi.unstubAllEnvs();
	});

	// Go: main.go:493-495 — hook failure is swallowed, stderr gets diagnostic line,
	// never throws back to the caller (fireHook always resolves).
	it('fireHook swallows errors and writes "hook <name> failed: ..." to stderr', async () => {
		const writeSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

		execaMock.mockRejectedValueOnce(
			Object.assign(new Error('exit 1'), { all: 'oh no', stdout: '', stderr: 'oh no' }),
		);

		// Should NOT throw.
		await expect(fireHook('/tmp/repo', 'stop', { session_id: 'xyz' })).resolves.toBeUndefined();

		expect(writeSpy.mock.calls.some((c) => String(c[0]).includes('hook stop failed:'))).toBe(true);
		writeSpy.mockRestore();
	});
});
