/**
 * `hooks-tty.ts` — TTY interaction + commit_linking persistence + stderr injection
 * for Phase 5.4 hook handlers.
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/strategy/manual_commit_hooks.go`:
 *   - `ttyResult` enum
 *   - `askConfirmTTY` (TTY confirmation prompt)
 *   - `saveCommitLinkingAlways` (raw JSON merge to `.story/settings.local.json`)
 *   - module-level `stderrWriter` injection point (Go uses package-level
 *     `var stderrWriter io.Writer = os.Stderr`)
 *
 * `hasTTY` is **already shipped** in [src/git.ts](../git.ts) (Phase 1.3) — this
 * file does not redefine it. Callers `import { hasTTY } from '@/git'`.
 *
 * **Why not `@/ui/prompts` (clack)**: `@clack/prompts` defaults to
 * `process.stdin` + `setRawMode`, neither of which is usable inside a
 * `prepare-commit-msg` git hook — git pipes stdin (so clack has nothing to
 * read) and the resulting stream is not a TTY (so `setRawMode` throws). We
 * deliberately keep a hand-rolled `/dev/tty` read here that mirrors Go's
 * `bufio.Reader.ReadString('\n')` byte-for-byte.
 *
 * @packageDocumentation
 */

import { closeSync, openSync, readFileSync, readSync, writeSync } from 'node:fs';
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { match } from 'ts-pattern';
import { getStoryFilePath } from '@/paths';
import { LOCAL_SETTINGS_FILE } from '@/settings/settings';

async function fileExists(p: string): Promise<boolean> {
	try {
		await access(p);
		return true;
	} catch {
		return false;
	}
}

/**
 * Blocking read-a-line from a file descriptor. Reads one byte at a time via
 * {@link readSync} until a `\n` byte is seen, EOF is hit (`n === 0`), or the
 * underlying syscall throws.
 *
 * Purpose-built for `/dev/tty`: the kernel tty driver already does line
 * buffering (ICANON), so each `read(fd, 1)` blocks until the user presses
 * Enter, after which all queued bytes become readable one at a time. No
 * need for raw mode / `readline` — mirrors Go's
 * `bufio.NewReader(tty).ReadString('\n')` byte-for-byte.
 *
 * CR (`\r`) bytes are silently dropped so a CRLF terminal still parses
 * `y\r\n` as `"y"`. The trailing `\n` is NOT included in the returned
 * string. Leading / other characters are included verbatim — callers
 * should `.trim().toLowerCase()` via {@link parseTTYResponse} /
 * {@link parseYesNoResponse}.
 *
 * Exposed (not `internal`) so unit tests can exercise it via a pipe fd
 * without a real TTY — that's the reason the old `createReadStream` +
 * `createInterface` approach was impossible to cover, and why Phase 5
 * ended up shipping a `/dev/tty` read path that was never actually
 * exercised in CI.
 *
 * @example
 * // User at terminal types "yes\n":
 * readLineBlocking(ttyFd) // returns: "yes"
 *
 * // CRLF line ending:
 * readLineBlocking(ttyFd) // for "y\r\n" returns: "y"
 *
 * // EOF before newline:
 * readLineBlocking(fd)    // returns whatever bytes arrived, no error
 *
 * // Side effects: blocks current thread inside readSync() waiting on the
 * // tty driver's line discipline; no writes; no fd close (caller owns the fd).
 */
export function readLineBlocking(fd: number): string {
	const buf = Buffer.alloc(1);
	let line = '';
	while (true) {
		let n: number;
		try {
			n = readSync(fd, buf, 0, 1, null);
		} catch {
			break;
		}
		if (n === 0) {
			break;
		}
		const ch = buf.toString('utf8', 0, n);
		if (ch === '\n') {
			break;
		}
		if (ch === '\r') {
			continue;
		}
		line += ch;
	}
	return line;
}

/**
 * Outcome of an interactive TTY confirmation. Mirrors Go `ttyResult`
 * (`manual_commit_hooks.go: ttyResult`).
 *
 * Numeric values match Go iota order: `Link=0`, `Skip=1`, `LinkAlways=2`.
 */
export enum TtyResult {
	/** Add the checkpoint trailer. */
	Link = 0,
	/** Don't add the trailer. */
	Skip = 1,
	/** Add trailer + persist `commit_linking="always"` preference. */
	LinkAlways = 2,
}

/**
 * Format the prompt text written to `/dev/tty` by {@link askConfirmTTY}.
 * Pure function — extracted from Go `askConfirmTTY:126-137` so tests can verify
 * the exact byte sequence without driving a real TTY.
 *
 * Mirrors Go `manual_commit_hooks.go: askConfirmTTY` write block.
 *
 * @example
 * formatTTYPromptText('Story: ...', ['Last prompt: x'], 'Link?', true)
 * // returns:
 * //   "\nStory: ...\n  Last prompt: x\n\nLink?\n  [Y]es / [n]o / [a]lways (remember my choice): "
 */
export function formatTTYPromptText(
	header: string,
	details: readonly string[],
	prompt: string,
	defaultYes: boolean,
): string {
	const parts: string[] = [`\n${header}\n`];
	for (const line of details) {
		parts.push(`  ${line}\n`);
	}
	parts.push(`\n${prompt}\n`);
	if (defaultYes) {
		parts.push('  [Y]es / [n]o / [a]lways (remember my choice): ');
	} else {
		parts.push('  [y]es / [N]o / [a]lways (remember my choice): ');
	}
	return parts.join('');
}

/**
 * Parse a single-line TTY response into a {@link TtyResult}.
 * Pure function — extracted from Go `askConfirmTTY:146-157` so tests can verify
 * each branch without spawning a TTY.
 *
 * Mirrors Go `manual_commit_hooks.go: askConfirmTTY` switch block.
 *
 * @example
 * parseTTYResponse('y',  true)   // TtyResult.Link
 * parseTTYResponse('n',  true)   // TtyResult.Skip
 * parseTTYResponse('a',  true)   // TtyResult.LinkAlways
 * parseTTYResponse('',   true)   // TtyResult.Link (default)
 * parseTTYResponse('',   false)  // TtyResult.Skip (default)
 * parseTTYResponse('huh',true)   // TtyResult.Link (default — unknown input)
 */
export function parseTTYResponse(response: string, defaultYes: boolean): TtyResult {
	const trimmed = response.trim().toLowerCase();
	return match(trimmed)
		.with('y', 'yes', () => TtyResult.Link)
		.with('n', 'no', () => TtyResult.Skip)
		.with('a', 'always', () => TtyResult.LinkAlways)
		.otherwise(() => (defaultYes ? TtyResult.Link : TtyResult.Skip));
}

/**
 * Prompt the user via `/dev/tty` whether to link a commit to session context.
 * Caller MUST check `hasTTY()` (from [src/git.ts](../git.ts)) first and handle
 * the no-TTY case (agent subprocess / CI). In test mode (`STORY_TEST_TTY` env
 * var set, or legacy `ENTIRE_TEST_TTY` for back-compat), returns
 * `defaultYes ? Link : Skip` without touching real `/dev/tty` — matching Go
 * behavior at `manual_commit_hooks.go: askConfirmTTY:112-114`.
 *
 * Mirrors Go `manual_commit_hooks.go: askConfirmTTY`.
 *
 * @example
 * const result = await askConfirmTTY(
 *   'Story: Active Claude Code session detected',
 *   ['Last prompt: rewrite the README'],
 *   'Link this commit to session context?',
 *   true,
 * );
 * // returns: TtyResult.Link | TtyResult.Skip | TtyResult.LinkAlways
 *
 * // Side effects:
 * //   /dev/tty   ← writes header + indented details + prompt; reads response line
 * //               (test mode skips both)
 * //
 * // Disk / git refs / HEAD: unchanged.
 */
export async function askConfirmTTY(
	header: string,
	details: readonly string[],
	prompt: string,
	defaultYes: boolean,
): Promise<TtyResult> {
	const defaultResult = defaultYes ? TtyResult.Link : TtyResult.Skip;

	// Test mode: don't try to interact with the real TTY — just use the default.
	// Mirrors Go `askConfirmTTY:112-114`. STORY_TEST_TTY is the Story-canonical
	// name; ENTIRE_TEST_TTY is the back-compat fallback (whitelisted env-var
	// exception in story-vs-entire.md so the shared Go e2e harness keeps working).
	const storyTestMode = process.env.STORY_TEST_TTY;
	if (storyTestMode !== undefined && storyTestMode !== '') {
		return defaultResult;
	}
	const entireTestMode = process.env.ENTIRE_TEST_TTY;
	if (entireTestMode !== undefined && entireTestMode !== '') {
		return defaultResult;
	}

	/* v8 ignore start */
	// /dev/tty I/O block — the open/write/close orchestration is untestable
	// in CI without a real TTY. The actual read loop lives in
	// {@link readLineBlocking} below which IS unit-tested via a pipe fd
	// (no real TTY required). The test-mode early-return above + those
	// unit tests cover all branches of the logic.

	// Open /dev/tty for both reading and writing. Works even when stdin/stderr
	// are redirected (e.g., human runs `git commit -m`).
	let fd: number;
	try {
		fd = openSync('/dev/tty', 'r+');
	} catch {
		return defaultResult;
	}

	try {
		// Write to /dev/tty directly, not stderr — git hooks may redirect stderr.
		const text = formatTTYPromptText(header, details, prompt, defaultYes);
		writeSync(fd, text);

		// Read one line via a blocking byte-by-byte syscall. Mirrors Go
		// `bufio.Reader.ReadString('\n')`. Earlier TS used
		// `createReadStream + createInterface` which never fires `'line'`
		// on Bun for character devices — the prompt would hang forever.
		const line = readLineBlocking(fd);
		return parseTTYResponse(line, defaultYes);
	} catch {
		return defaultResult;
	} finally {
		try {
			closeSync(fd);
		} catch {
			// best-effort; /dev/tty close rarely fails but never block the hook
		}
	}
	/* v8 ignore stop */
}

/**
 * Format a binary Yes/No TTY prompt — sibling of {@link formatTTYPromptText}
 * but without the `[a]lways (remember my choice)` option. Used by the
 * Phase 5.5 `restoreLogsOnly` overwrite-confirmation flow which mirrors
 * Go's `huh.NewConfirm()` (strict Y/n, no third "always" option).
 *
 * @example
 * formatYesNoPromptText('Overwrite local session logs?', false)
 * // returns:
 * //   "\nOverwrite local session logs?\n  [y]es / [N]o: "
 *
 * formatYesNoPromptText('Continue?', true)
 * // returns: "\nContinue?\n  [Y]es / [n]o: "
 */
export function formatYesNoPromptText(prompt: string, defaultYes: boolean): string {
	const choices = defaultYes ? '[Y]es / [n]o' : '[y]es / [N]o';
	return `\n${prompt}\n  ${choices}: `;
}

/**
 * Parse a single-line TTY response into a boolean for {@link askYesNoTTY}.
 * Sibling of {@link parseTTYResponse} but binary — `'a'` / `'always'` /
 * unknown inputs all fall through to `defaultYes` (no third state).
 *
 * Mirrors Go `huh.NewConfirm()` semantics (binary confirm, default value
 * decides empty / unknown input).
 *
 * @example
 * parseYesNoResponse('y',       false)  // true
 * parseYesNoResponse('yes',     false)  // true
 * parseYesNoResponse('n',       true)   // false
 * parseYesNoResponse('no',      true)   // false
 * parseYesNoResponse('',        false)  // false (default)
 * parseYesNoResponse('',        true)   // true  (default)
 * parseYesNoResponse('a',       false)  // false (no third state — falls to default)
 * parseYesNoResponse('always',  true)   // true  (same — no third state)
 * parseYesNoResponse('huh',     false)  // false (default — unknown input)
 */
export function parseYesNoResponse(response: string, defaultYes: boolean): boolean {
	const trimmed = response.trim().toLowerCase();
	return match(trimmed)
		.with('y', 'yes', () => true)
		.with('n', 'no', () => false)
		.otherwise(() => defaultYes);
}

/**
 * Strict Yes/No confirmation prompt sent to `/dev/tty`. Sibling of
 * {@link askConfirmTTY} but binary — no `[a]lways` option. Used by Phase
 * 5.5 `restoreLogsOnly` overwrite confirmation; matches Go
 * `huh.NewConfirm()` semantics so a user typing `a` doesn't get
 * surprising silent cancellation.
 *
 * Test mode (`STORY_TEST_TTY` / `ENTIRE_TEST_TTY` env var set) returns
 * `defaultYes` without touching `/dev/tty`. No-TTY environments (open
 * `/dev/tty` fails) also return `defaultYes`.
 *
 * @example
 * await askYesNoTTY('Overwrite local session logs with checkpoint versions?', false);
 * // returns: true  (user typed Y / yes)
 * //        | false (user typed N / no / pressed Enter / aborted / no-TTY default)
 *
 * // Side effects:
 * //   /dev/tty   ← writes prompt + reads response line
 * //               (test mode skips both)
 * //
 * // Disk / git refs / HEAD: unchanged.
 */
export async function askYesNoTTY(prompt: string, defaultYes: boolean): Promise<boolean> {
	const storyTestMode = process.env.STORY_TEST_TTY;
	if (storyTestMode !== undefined && storyTestMode !== '') {
		return defaultYes;
	}
	const entireTestMode = process.env.ENTIRE_TEST_TTY;
	if (entireTestMode !== undefined && entireTestMode !== '') {
		return defaultYes;
	}

	/* v8 ignore start */
	// /dev/tty I/O block — see {@link askConfirmTTY} comment. Actual read
	// logic delegated to {@link readLineBlocking} which is unit-tested.
	let fd: number;
	try {
		fd = openSync('/dev/tty', 'r+');
	} catch {
		return defaultYes;
	}

	try {
		const text = formatYesNoPromptText(prompt, defaultYes);
		writeSync(fd, text);

		const line = readLineBlocking(fd);
		return parseYesNoResponse(line, defaultYes);
	} catch {
		return defaultYes;
	} finally {
		try {
			closeSync(fd);
		} catch {
			// best-effort
		}
	}
	/* v8 ignore stop */
}

/**
 * Persist `commit_linking = "always"` to `.story/settings.local.json` via raw
 * JSON merge: read the file as a `Map<string, RawValue>`, set only the
 * `commit_linking` key, write back. Preserves all other keys verbatim — avoids
 * clobbering `enabled: true` etc. when local settings doesn't exist yet.
 *
 * Mirrors Go `manual_commit_hooks.go: saveCommitLinkingAlways`.
 *
 * @example
 * await saveCommitLinkingAlways('/repo');
 *
 * // Side effects:
 * //   /repo/.story/                              ← created if missing (mkdirp)
 * //   /repo/.story/settings.local.json           ← merged or created with commit_linking="always"
 * //                                                  other keys preserved verbatim
 * //
 * // Git refs / HEAD / worktree: unchanged.
 */
export async function saveCommitLinkingAlways(repoDir: string): Promise<void> {
	const localPath = getStoryFilePath(repoDir, LOCAL_SETTINGS_FILE);

	// Read existing file as raw JSON map to preserve all existing fields.
	// If the file doesn't exist, start with an empty map so we only write commit_linking.
	let raw: Record<string, unknown> = {};
	if (await fileExists(localPath)) {
		let data: string;
		try {
			data = readFileSync(localPath, 'utf8');
		} catch (err) {
			throw new Error(
				`reading local settings: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		try {
			const parsed = JSON.parse(data) as unknown;
			if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
				raw = parsed as Record<string, unknown>;
			}
		} catch (err) {
			throw new Error(
				`parsing local settings: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	raw.commit_linking = 'always';

	const out = `${JSON.stringify(raw, null, 2)}\n`;

	// mkdirp the parent directory (Story config dir resolved by getStoryFilePath).
	try {
		await mkdir(path.dirname(localPath), { recursive: true, mode: 0o750 });
	} catch (err) {
		throw new Error(
			`creating settings directory: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	try {
		await writeFile(localPath, out, { mode: 0o644 });
	} catch (err) {
		throw new Error(`writing local settings: ${err instanceof Error ? err.message : String(err)}`);
	}
}

/**
 * Module-level injection point for tests to capture warning output.
 * Default: `process.stderr`. Tests call `setStderrWriterForTesting(buf)` to
 * intercept; pass `null` to restore the default. Re-exported by
 * [`./hooks-post-commit-warn.ts`](./hooks-post-commit-warn.ts) (Phase 5.4 Part 2)
 * so both warning paths share one stderr injection point.
 *
 * Mirrors Go `var stderrWriter io.Writer = os.Stderr`.
 */
let stderrWriter: NodeJS.WritableStream = process.stderr;

/**
 * Replace the stderr writer used by hook warnings. Pass `null` to restore the
 * default (`process.stderr`).
 */
export function setStderrWriterForTesting(w: NodeJS.WritableStream | null): void {
	stderrWriter = w ?? process.stderr;
}

/** Returns the currently-installed stderr writer (default or test-injected). */
export function getStderrWriter(): NodeJS.WritableStream {
	return stderrWriter;
}
