/**
 * Vogon — deterministic E2E canary agent binary.
 *
 * Parses simple prompt instructions ("create <file> ...", "modify <file>
 * ...", "delete <file>", "commit"), performs file operations, fires Story
 * hooks via `story hooks vogon <verb>`, and writes a minimal JSONL
 * transcript. **No API calls.**
 *
 * Named after the Vogons from The Hitchhiker's Guide to the Galaxy —
 * bureaucratic, procedural, and deterministic to a fault.
 *
 * Usage:
 *
 * ```
 * vogon -p <prompt>   # Headless (single-turn) mode
 * vogon               # Interactive (multi-turn) mode (stdin)
 * ```
 *
 * Requires `STORY_BIN` env var = absolute path to built Story CLI binary
 * (so that `story hooks vogon ...` resolves without PATH pollution). Falls
 * back to PATH lookup of `story` for developer convenience.
 *
 * Go reference: `entire-cli/e2e/vogon/main.go` (545 lines). Regex literals
 * are copied byte-for-byte from Go so prompt parsing matches Go bit-for-bit.
 * The `.vogon/` session directory name is preserved (not a Story/Entire
 * brand — it's Vogon's own namespace).
 *
 * @packageDocumentation
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { type ExecaError, execa } from 'execa';

/**
 * One parsed intent from the prompt string. Mirrors Go
 * `e2e/vogon/main.go:109-113 action` struct.
 */
export interface VogonAction {
	kind: 'create' | 'modify' | 'delete' | 'commit';
	path: string;
	content: string;
}

/** Hook payload passed to `story hooks vogon <verb>`. */
export type VogonHookPayload = Record<string, unknown>;

/** Valid Story hook verbs fired by Vogon. */
export type VogonHookName = 'session-start' | 'session-end' | 'stop' | 'user-prompt-submit';

const MODEL = 'vogon-llm-42';

// ---------------------------------------------------------------------------
// Regex literals — copied byte-for-byte from Go e2e/vogon/main.go:116-156.
// DO NOT refactor / simplify these. They are the ground truth that guarantees
// TS parses prompts identically to Go.
// ---------------------------------------------------------------------------

const FILE_EXT = 'go|md|txt|js|ts|py|rb|rs|toml|yaml|json';

// Go: e2e/vogon/main.go:120 — "create a [...] file [exactly at|at|called] <path>"
const createFileRe = new RegExp(
	`create\\s+(?:a\\s+)?(?:\\w+\\s+)*?(?:markdown\\s+|text\\s+)?file\\s+(?:exactly\\s+at\\s+|at\\s+|called\\s+)?([^\\s,]+\\.(?:${FILE_EXT}))`,
	'i',
);
// Go: e2e/vogon/main.go:122 — "create N files: <path> about <topic>, ..."
const createMultiRe =
	/create\s+(?:\w+\s+)*?(?:four|three|two|\d+)\s+(?:\w+\s+)*?(?:markdown\s+)?files?:?\s+(.+)/i;
// Go: e2e/vogon/main.go:124 — "modify <path>"
const modifyFileRe = new RegExp(
	`modify\\s+(?:the\\s+)?(?:file\\s+)?(?:at\\s+)?([^\\s,]+\\.(?:${FILE_EXT}))`,
	'i',
);
// Go: e2e/vogon/main.go:126 — "modify [these] N [existing] files[:]"
const modifyMultiRe =
	/modify\s+(?:these\s+)?(?:three|four|two|\d+)\s+(?:\w+\s+)*?files?[.:]\s*(.+)/i;
// Go: e2e/vogon/main.go:128 — "add ... to <path>"
const addToFileRe = new RegExp(
	`add\\s+(?:another\\s+|a\\s+|some\\s+)?\\w+\\s+to\\s+([^\\s,]+\\.(?:${FILE_EXT}))`,
	'i',
);
// Go: e2e/vogon/main.go:130 — "delete <path>"
const deleteFileRe = new RegExp(
	`delete\\s+(?:the\\s+)?(?:file\\s+)?(?:at\\s+)?([^\\s,]+\\.(?:${FILE_EXT}))`,
	'i',
);
// Go: e2e/vogon/main.go:132 — "commit" anywhere (but not "do not commit")
const commitRe = /(?:then\s+|now\s+)?(?:git\s+)?commit\b/i;
// Go: e2e/vogon/main.go:136 — "do not commit" / "don't commit" at sentence boundary
// (use /s flag equivalent: $ matches end-of-string here; no multi-line input)
const noCommitRe = /(?:do\s+not|don'?t)\s+commit(?:\s+(?:it|them|the\s+\w+))?(?:\.|,|$)/i;
// Go: e2e/vogon/main.go:138 — "commit each file separately"
const commitSeparatelyRe = /commit\s+each\s+file\s+separately/i;
// Go: e2e/vogon/main.go:141 — individual file in multi-create
const multiFileItemRe = new RegExp(
	`([^\\s,]+\\.(?:${FILE_EXT}))\\s+(?:about\\s+|with\\s+|containing\\s+)?(.+?)(?:,\\s*|\\s+and\\s+|\\.\\s+[A-Z]|\\.\\s*$)`,
	'g',
);
// Go: e2e/vogon/main.go:143 — individual file in multi-modify
const modifyItemRe = new RegExp(`([^\\s,]+\\.(?:${FILE_EXT}))\\s+should\\s+(.+?)(?:,|$)`, 'g');
// Go: e2e/vogon/main.go:145 — "In <path>" fallback for multi-modify
const inFileRe = new RegExp(`[Ii]n\\s+([^\\s,]+\\.(?:${FILE_EXT}))`, 'g');
// Go: e2e/vogon/main.go:147 — inline content: "with content '...'"
const inlineContentRe = /with\s+content\s+['"]([^'"]+)['"]/i;
// Go: e2e/vogon/main.go:149 — numbered steps: "(1) ... (2) ..."
const numberedStepRe = /\(\d+\)\s+/g;
// Go: e2e/vogon/main.go:151 — explicit git command in a numbered step
const explicitGitRe = /run:?\s+git\s+add\s+.+(?:&&\s*git\s+commit|;\s*git\s+commit)/i;
// Go: e2e/vogon/main.go:153 — "about <topic>" → "<topic>"
const topicRe = /about\s+(.+?)(?:\.|,|\s+Do\s|\s+do\s|\s+then\s|$)/i;
// Go: e2e/vogon/main.go:155 — fallback: any file path
const anyFileRe = new RegExp(`([^\\s,]+\\.(?:${FILE_EXT}))`, 'g');

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

/**
 * Vogon binary entry. Parses argv, sets up transcript, fires session-start,
 * runs prompt(s), fires session-end, returns exit code.
 *
 * Go: e2e/vogon/main.go:30-82 `main()`.
 *
 * @returns process exit code (0 on success; non-zero on fatal error)
 */
export async function runVogon(argv: readonly string[]): Promise<number> {
	// Go: e2e/vogon/main.go:31-37 — parse `-p <prompt>` from argv
	let prompt = '';
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '-p' && i + 1 < argv.length) {
			prompt = argv[i + 1] ?? '';
			i++;
		}
	}

	// Go: e2e/vogon/main.go:39-42 — getwd
	const dir = process.cwd();

	// Go: e2e/vogon/main.go:44-45 — UUID + transcript setup
	const sessionId = randomUUID();
	const transcriptPath = await setupTranscript(sessionId);

	// Go: e2e/vogon/main.go:47-51 — session-start
	await fireHook(dir, 'session-start', {
		session_id: sessionId,
		transcript_path: transcriptPath,
		model: MODEL,
	});

	if (prompt !== '') {
		// Go: e2e/vogon/main.go:53-56 — headless single turn
		await runTurn(dir, sessionId, transcriptPath, prompt);
	} else {
		// Go: e2e/vogon/main.go:57-75 — interactive stdin loop
		process.stdout.write('> ');
		const rl = readline.createInterface({ input: process.stdin, terminal: false });
		for await (const raw of rl) {
			const line = raw.trim();
			if (line === '' || line === 'exit' || line === 'quit') {
				break;
			}
			// Go: main.go:66-70 — 700ms sleep so tmux Send() can capture echo state
			// before output appears. Keeps interactive capture race benign.
			await new Promise<void>((resolve) => {
				setTimeout(resolve, 700);
			});
			process.stdout.write('Working...\n');
			await runTurn(dir, sessionId, transcriptPath, line);
			process.stdout.write('> ');
		}
	}

	// Go: e2e/vogon/main.go:77-81 — session-end
	await fireHook(dir, 'session-end', {
		session_id: sessionId,
		transcript_path: transcriptPath,
		model: MODEL,
	});

	return 0;
}

/**
 * Execute one turn of the agent: fire user-prompt-submit, append transcript
 * user entry, parse + execute actions, append assistant entry, print
 * summary, fire stop. Mirrors Go `e2e/vogon/main.go:84-105 runTurn`.
 */
async function runTurn(
	dir: string,
	sessionId: string,
	transcriptPath: string,
	prompt: string,
): Promise<void> {
	// Go: main.go:85-90
	await fireHook(dir, 'user-prompt-submit', {
		session_id: sessionId,
		transcript_path: transcriptPath,
		prompt,
		model: MODEL,
	});

	await appendTranscript(transcriptPath, 'user', prompt);

	const actions = parsePrompt(prompt);
	await executeActions(dir, actions);

	const summary = `Done. Executed ${actions.length} actions.`;
	await appendTranscript(transcriptPath, 'assistant', summary);
	process.stdout.write(`${summary}\n`);

	// Go: main.go:100-104
	await fireHook(dir, 'stop', {
		session_id: sessionId,
		transcript_path: transcriptPath,
		model: MODEL,
	});
}

// ---------------------------------------------------------------------------
// Prompt parsing
// ---------------------------------------------------------------------------

/**
 * Deterministic prompt parser. Mirrors Go `e2e/vogon/main.go:158-268
 * parsePrompt`. Recognizes ~12 regex-driven patterns and returns a
 * flattened action list preserving execution order.
 *
 * @example
 * parsePrompt('create docs/red.md about red, then commit');
 * // [
 * //   { kind: 'create', path: 'docs/red.md', content: '# the colour red\n\nA paragraph about the colour red.\n' },
 * //   { kind: 'commit', path: '', content: '' },
 * // ]
 */
export function parsePrompt(prompt: string): VogonAction[] {
	// Go: main.go:161-163 — numbered-step dispatch FIRST so ordering is preserved
	if (matchesOnce(numberedStepRe, prompt)) {
		return parseNumberedSteps(prompt);
	}

	const actions: VogonAction[] = [];

	// Go: main.go:168-198 — multi-file modify ("these three files")
	const multiModifyMatch = modifyMultiRe.exec(prompt);
	if (multiModifyMatch && multiModifyMatch[1] !== undefined) {
		const body = multiModifyMatch[1];

		// Try "X should ..." pattern first
		for (const item of matchAllGlobal(modifyItemRe, body)) {
			const filePath = item[1];
			const desc = item[2];
			if (filePath === undefined || desc === undefined) {
				continue;
			}
			actions.push({
				kind: 'modify',
				path: filePath,
				content: `// ${desc.trim()}\n`,
			});
		}

		// Fallback: "In <path>, add ..."
		if (actions.length === 0) {
			for (const item of matchAllGlobal(inFileRe, body)) {
				const filePath = item[1];
				if (filePath === undefined) {
					continue;
				}
				actions.push({
					kind: 'modify',
					path: filePath,
					content: '// Modified by vogon agent\n',
				});
			}
		}

		// Last resort: any file path
		if (actions.length === 0) {
			for (const item of matchAllGlobal(anyFileRe, body)) {
				const filePath = item[1];
				if (filePath === undefined) {
					continue;
				}
				actions.push({
					kind: 'modify',
					path: filePath,
					content: '// Modified by vogon agent\n',
				});
			}
		}
	}

	// Go: main.go:201-212 — multi-file create ("create four markdown files: ...")
	if (actions.length === 0 || hasModifyOnly(actions)) {
		const m = createMultiRe.exec(prompt);
		if (m && m[1] !== undefined) {
			for (const item of matchAllGlobal(multiFileItemRe, m[1])) {
				const filePath = item[1];
				const topic = item[2];
				if (filePath === undefined || topic === undefined) {
					continue;
				}
				const t = topic.trim();
				actions.push({
					kind: 'create',
					path: filePath,
					content: `# ${t}\n\nA paragraph about ${t}.\n`,
				});
			}
		}
	}

	// Go: main.go:215-228 — single-file create (also runs when we have only modifies)
	if (!hasCreate(actions)) {
		const m = createFileRe.exec(prompt);
		if (m && m[1] !== undefined) {
			const topic = extractTopic(prompt);
			let content = `# ${topic}\n\nA paragraph about ${topic}.\n`;
			const ic = inlineContentRe.exec(prompt);
			if (ic && ic[1] !== undefined) {
				content = `${ic[1]}\n`;
			}
			actions.push({
				kind: 'create',
				path: m[1],
				content,
			});
		}
	}

	// Go: main.go:231-239 — single-file modify
	if (!hasModify(actions)) {
		const m = modifyFileRe.exec(prompt);
		if (m && m[1] !== undefined) {
			actions.push({
				kind: 'modify',
				path: m[1],
				content: '// Modified by vogon agent\n',
			});
		}
	}

	// Go: main.go:242-250 — "add ... to <path>" as modify
	if (!hasModify(actions)) {
		const m = addToFileRe.exec(prompt);
		if (m && m[1] !== undefined) {
			actions.push({
				kind: 'modify',
				path: m[1],
				content: '// Modified by vogon agent\n',
			});
		}
	}

	// Go: main.go:253-255 — delete
	const delMatch = deleteFileRe.exec(prompt);
	if (delMatch && delMatch[1] !== undefined) {
		actions.push({ kind: 'delete', path: delMatch[1], content: '' });
	}

	// Go: main.go:258-266 — commit decision
	if (!noCommitRe.test(prompt)) {
		if (commitSeparatelyRe.test(prompt)) {
			return interleaveCommits(actions);
		}
		if (commitRe.test(prompt)) {
			actions.push({ kind: 'commit', path: '', content: '' });
		}
	}

	return actions;
}

/**
 * Split `(1) ... (2) ... (3) ...` prompts into independent steps, parsing
 * each one. Preserves ordering — e.g. "Create A. Commit. Create B." emits
 * create-A, commit, create-B. Mirrors Go `e2e/vogon/main.go:273-358
 * parseNumberedSteps`.
 */
function parseNumberedSteps(prompt: string): VogonAction[] {
	const indices: Array<[number, number]> = [];
	// Collect match boundaries for `\(\d+\)\s+` (Go uses FindAllStringIndex).
	for (const m of prompt.matchAll(numberedStepRe)) {
		if (m.index !== undefined) {
			indices.push([m.index, m.index + m[0].length]);
		}
	}
	if (indices.length === 0) {
		return [];
	}

	const steps: string[] = [];
	for (let i = 0; i < indices.length; i++) {
		const start = (indices[i] as [number, number])[1];
		const end = i + 1 < indices.length ? (indices[i + 1] as [number, number])[0] : prompt.length;
		const step = prompt.slice(start, end).trim();
		if (step !== '') {
			steps.push(step);
		}
	}

	const actions: VogonAction[] = [];
	for (const step of steps) {
		const hasExplicitGit = explicitGitRe.test(step);

		// Create with optional inline content — try full regex first
		const full = createFileRe.exec(step);
		if (full && full[1] !== undefined) {
			let content = `# ${full[1]}\n\nGenerated content.\n`;
			const ic = inlineContentRe.exec(step);
			if (ic && ic[1] !== undefined) {
				content = `${ic[1]}\n`;
			}
			actions.push({ kind: 'create', path: full[1], content });
			if (hasExplicitGit) {
				actions.push({ kind: 'commit', path: '', content: '' });
			}
			continue;
		}

		// Fallback: "Create <path>" (any file path after verb).
		// Reset lastIndex first — `anyFileRe` has the `g` flag for use by
		// `parsePrompt`'s multi-modify fallback, and exec() on a global
		// regex advances that lastIndex across calls. Without the reset
		// the 2nd+ numbered step's exec() can start mid-string and return
		// null / the wrong match (observed: "Create docs/green.md ... Run:
		// git add docs/green.md ..." skipping `docs/green.md` and landing
		// on a later path).
		if (step.trim().toLowerCase().startsWith('create')) {
			anyFileRe.lastIndex = 0;
			const m = anyFileRe.exec(step);
			if (m && m[1] !== undefined) {
				const topic = extractTopic(step);
				let content = `# ${topic}\n\nA paragraph about ${topic}.\n`;
				const ic = inlineContentRe.exec(step);
				if (ic && ic[1] !== undefined) {
					content = `${ic[1]}\n`;
				}
				actions.push({ kind: 'create', path: m[1], content });
				if (hasExplicitGit) {
					actions.push({ kind: 'commit', path: '', content: '' });
				}
				continue;
			}
		}

		// Modify
		const mod = modifyFileRe.exec(step);
		if (mod && mod[1] !== undefined) {
			actions.push({
				kind: 'modify',
				path: mod[1],
				content: '// Modified by vogon agent\n',
			});
			if (hasExplicitGit) {
				actions.push({ kind: 'commit', path: '', content: '' });
			}
			continue;
		}

		// Delete
		const del = deleteFileRe.exec(step);
		if (del && del[1] !== undefined) {
			actions.push({ kind: 'delete', path: del[1], content: '' });
			if (hasExplicitGit) {
				actions.push({ kind: 'commit', path: '', content: '' });
			}
			continue;
		}

		// Explicit git command with no file op in this step
		if (hasExplicitGit) {
			actions.push({ kind: 'commit', path: '', content: '' });
			continue;
		}

		// Bare commit instruction (respects negation)
		if (commitRe.test(step) && !noCommitRe.test(step)) {
			actions.push({ kind: 'commit', path: '', content: '' });
		}
	}
	return actions;
}

/** Any-kind `create` present in the action list? */
function hasCreate(actions: readonly VogonAction[]): boolean {
	return actions.some((a) => a.kind === 'create');
}

/** Any-kind `modify` present in the action list? */
function hasModify(actions: readonly VogonAction[]): boolean {
	return actions.some((a) => a.kind === 'modify');
}

/** True iff the list is non-empty and every entry is `modify`. */
function hasModifyOnly(actions: readonly VogonAction[]): boolean {
	if (actions.length === 0) {
		return false;
	}
	return actions.every((a) => a.kind === 'modify');
}

/**
 * Insert a `commit` action after every `create` / `modify`. Mirrors Go
 * `e2e/vogon/main.go:391-400 interleaveCommits`.
 */
function interleaveCommits(actions: readonly VogonAction[]): VogonAction[] {
	const out: VogonAction[] = [];
	for (const a of actions) {
		out.push(a);
		if (a.kind === 'create' || a.kind === 'modify') {
			out.push({ kind: 'commit', path: '', content: '' });
		}
	}
	return out;
}

/**
 * Extract the first "about <topic>" noun phrase from the prompt, or
 * `"the topic"` when no match. Mirrors Go `e2e/vogon/main.go:402-407 extractTopic`.
 */
function extractTopic(prompt: string): string {
	const m = topicRe.exec(prompt);
	if (m && m[1] !== undefined) {
		return m[1].trim();
	}
	return 'the topic';
}

// ---------------------------------------------------------------------------
// Action execution
// ---------------------------------------------------------------------------

/**
 * Execute parsed actions in order. Mirrors Go `e2e/vogon/main.go:409-427
 * executeActions`. `create` / `modify` / `delete` mutate the working tree
 * via `fs/promises`; `commit` runs `git add <pending> && git commit -m
 * 'Vogon agent commit'` with `GIT_TERMINAL_PROMPT=0`.
 *
 * @example
 * await executeActions('/tmp/repo', [
 *   { kind: 'create', path: 'docs/red.md', content: '# Red\n' },
 *   { kind: 'commit', path: '', content: '' },
 * ]);
 * // Side effects in /tmp/repo:
 * //   docs/red.md                     ← written (mode 0o644)
 * //   docs/                            ← created if missing (mode 0o755)
 * //   index / HEAD                     ← advanced by `git add` + `git commit`
 * // Unchanged: anything outside /tmp/repo.
 */
export async function executeActions(dir: string, actions: readonly VogonAction[]): Promise<void> {
	const pending: string[] = [];
	for (const a of actions) {
		switch (a.kind) {
			case 'create':
				await createFile(dir, a.path, a.content);
				pending.push(a.path);
				break;
			case 'modify':
				await modifyFile(dir, a.path, a.content);
				pending.push(a.path);
				break;
			case 'delete':
				await deleteFile(dir, a.path);
				pending.push(a.path);
				break;
			case 'commit':
				await gitCommit(dir, pending.slice());
				pending.length = 0;
				break;
			default: {
				// Exhaustive check — compile error if a new kind is added without a branch.
				const _exhaustive: never = a.kind;
				void _exhaustive;
			}
		}
	}
}

/** Go: main.go:429-438 `createFile`. */
async function createFile(dir: string, rel: string, content: string): Promise<void> {
	const abs = path.join(dir, rel);
	try {
		await fs.mkdir(path.dirname(abs), { recursive: true, mode: 0o755 });
	} catch (e) {
		process.stderr.write(`mkdir ${path.dirname(abs)}: ${errMsg(e)}\n`);
		return;
	}
	try {
		await fs.writeFile(abs, content, { mode: 0o644 });
	} catch (e) {
		process.stderr.write(`write ${abs}: ${errMsg(e)}\n`);
	}
}

/** Go: main.go:440-447 `modifyFile`. Appends content after an extra `\n`. */
async function modifyFile(dir: string, rel: string, appendContent: string): Promise<void> {
	const abs = path.join(dir, rel);
	let existing = '';
	try {
		existing = await fs.readFile(abs, 'utf-8');
	} catch {
		// Go uses _ to ignore — create from scratch when missing
	}
	const content = `${existing}\n${appendContent}`;
	try {
		await fs.writeFile(abs, content, { mode: 0o644 });
	} catch (e) {
		process.stderr.write(`write ${abs}: ${errMsg(e)}\n`);
	}
}

/** Go: main.go:449-454 `deleteFile`. */
async function deleteFile(dir: string, rel: string): Promise<void> {
	const abs = path.join(dir, rel);
	try {
		await fs.unlink(abs);
	} catch (e) {
		process.stderr.write(`remove ${abs}: ${errMsg(e)}\n`);
	}
}

/**
 * Go: main.go:456-463 `gitCommit`. When `files` is empty, falls back to
 * `git add .` so deletions staged earlier via `delete` still make it in.
 */
async function gitCommit(dir: string, files: readonly string[]): Promise<void> {
	if (files.length === 0) {
		await gitRun(dir, ['add', '.']);
	} else {
		await gitRun(dir, ['add', '--', ...files]);
	}
	await gitRun(dir, ['commit', '-m', 'Vogon agent commit']);
}

/**
 * Go: main.go:465-477 `gitRun`. Runs git with stdio inherited to current
 * process so progress is visible. `GIT_TERMINAL_PROMPT=0` suppresses
 * credential / editor prompts (a non-interactive agent has no TTY to
 * answer them).
 */
async function gitRun(dir: string, args: readonly string[]): Promise<void> {
	try {
		await execa('git', [...args], {
			cwd: dir,
			env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
			stdio: 'inherit',
		});
	} catch (e) {
		process.stderr.write(`git ${args.join(' ')}: ${errMsg(e)}\n`);
	}
}

// ---------------------------------------------------------------------------
// Hook firing
// ---------------------------------------------------------------------------

/**
 * Fire a Story hook via `<STORY_BIN> hooks vogon <hookName>` with JSON
 * payload on stdin. Swallows stdout/stderr; logs to stderr only if the
 * hook exits non-zero. Mirrors Go `e2e/vogon/main.go:481-497 fireHook`.
 *
 * `STORY_BIN` env var wins — test harness sets it to the absolute path of
 * the built `dist/cli.js`. Falls back to `story` via PATH for developer
 * one-offs.
 *
 * @example
 * await fireHook('/tmp/repo', 'session-start', {
 *   session_id: 'abc-def',
 *   transcript_path: '/home/u/.vogon/sessions/abc-def.jsonl',
 *   model: 'vogon-llm-42',
 * });
 * // Side effects:
 * //   exec `<STORY_BIN> hooks vogon session-start` (payload on stdin)
 * //   .story/logs/story.log ← hook invocation recorded
 * //   .git/story-sessions/* ← session lifecycle advanced
 * // Unchanged: working tree, .git/refs, index (hook only touches state).
 */
export async function fireHook(
	dir: string,
	hookName: VogonHookName,
	payload: VogonHookPayload,
): Promise<void> {
	const data = JSON.stringify(payload);
	const storyBin = process.env.STORY_BIN ?? 'story';
	try {
		await execa(storyBin, ['hooks', 'vogon', hookName], {
			cwd: dir,
			env: { ...process.env, ENTIRE_TEST_TTY: '0' },
			input: data,
			all: true,
			// Swallow output on success (matches Go CombinedOutput).
			stdout: 'pipe',
			stderr: 'pipe',
		});
	} catch (e) {
		// Go prints `hook <name> failed: <err>\n<output>\n` and continues.
		const err = e as ExecaError;
		const combined = err.all ?? err.stderr ?? err.stdout ?? '';
		process.stderr.write(`hook ${hookName} failed: ${errMsg(e)}\n${String(combined)}\n`);
	}
}

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

interface TranscriptEntry {
	type: string;
	timestamp: string;
	message: string;
}

/**
 * Create (if needed) `~/.vogon/sessions/` and touch the transcript file.
 * Mirrors Go `e2e/vogon/main.go:501-516 setupTranscript`.
 *
 * The `.vogon/` directory name is Vogon's own namespace (not a Story /
 * Entire brand), preserved across both Go and TS for Vogon binary self-
 * identity.
 */
async function setupTranscript(sessionId: string): Promise<string> {
	const home = os.homedir();
	const transcriptDir = path.join(home, '.vogon', 'sessions');
	await fs.mkdir(transcriptDir, { recursive: true, mode: 0o755 });
	const p = path.join(transcriptDir, `${sessionId}.jsonl`);
	await fs.writeFile(p, '', { mode: 0o644 });
	return p;
}

/**
 * Append a JSONL transcript entry. Mirrors Go `e2e/vogon/main.go:524-539
 * appendTranscript`. Format: `{"type":"user"|"assistant","timestamp":"<RFC3339>","message":"..."}\n`.
 */
async function appendTranscript(
	filePath: string,
	role: 'user' | 'assistant',
	content: string,
): Promise<void> {
	const entry: TranscriptEntry = {
		type: role,
		timestamp: new Date().toISOString(),
		message: content,
	};
	const line = `${JSON.stringify(entry)}\n`;
	try {
		await fs.appendFile(filePath, line, { mode: 0o644 });
	} catch {
		// Go silently returns on error (matches append transcriptEntry path)
	}
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * True when `re` matches `input` at least once. Convenience for regexes
 * that have the `g` flag (which otherwise share state across `.test`
 * calls). Always resets `re.lastIndex` to 0 before testing.
 */
function matchesOnce(re: RegExp, input: string): boolean {
	re.lastIndex = 0;
	const m = re.exec(input);
	re.lastIndex = 0;
	return m !== null;
}

/**
 * `matchAll`-style iteration for a `g`-flagged regex. Resets `lastIndex`
 * to 0 both before and after so subsequent callers see a pristine regex.
 */
function matchAllGlobal(re: RegExp, input: string): RegExpExecArray[] {
	re.lastIndex = 0;
	const out: RegExpExecArray[] = [];
	let m: RegExpExecArray | null = re.exec(input);
	while (m !== null) {
		out.push(m);
		if (m.index === re.lastIndex) {
			re.lastIndex++;
		}
		m = re.exec(input);
	}
	re.lastIndex = 0;
	return out;
}

/** Common error-to-string helper used by stderr logging. */
function errMsg(e: unknown): string {
	if (e instanceof Error) {
		return e.message;
	}
	return String(e);
}

// ---------------------------------------------------------------------------
// Entry detection — works with both Bun (`import.meta.main`) and Node
// (compare `import.meta.url` to `file://${process.argv[1]}`).
// ---------------------------------------------------------------------------

const isBunMain =
	typeof (import.meta as { main?: boolean }).main === 'boolean'
		? (import.meta as { main?: boolean }).main === true
		: false;
const isNodeMain =
	typeof process !== 'undefined' &&
	Array.isArray(process.argv) &&
	process.argv.length > 1 &&
	import.meta.url === `file://${process.argv[1]}`;
if (isBunMain || isNodeMain) {
	runVogon(process.argv.slice(2))
		.then((code) => process.exit(code))
		.catch((err: unknown) => {
			// Keep error format parallel to Go `fatal()` in main.go.
			process.stderr.write(`vogon: ${errMsg(err)}\n`);
			process.exit(1);
		});
}
