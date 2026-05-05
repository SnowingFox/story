/**
 * PTY-driven Story CLI runs via `expect(1)` (no `node-pty` native dep).
 *
 * Used for interactive `select` / `confirm` paths that plain `execa` with
 * `stdio: 'ignore'` cannot drive. Requires `expect` on PATH — see
 * `tests/e2e/setup.ts` (`STORY_E2E_EXPECT_OK`) and {@link isExpectAvailableFromSetup}.
 *
 * @packageDocumentation
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { isolatedSpawnEnv } from './env';
import { getStoryBin } from './story';

/** Same union as `src/cli/tty.ts::detectCI` — cleared under PTY so `isInteractive()` is TTY-driven. */
const CI_ENV_KEYS_FOR_PTY: readonly string[] = [
	'CI',
	'VITEST',
	'GITHUB_ACTIONS',
	'BUILDKITE',
	'CIRCLECI',
	'GITLAB_CI',
	'TF_BUILD',
	'JENKINS_URL',
	'TEAMCITY_VERSION',
	'DRONE',
	'APPVEYOR',
	'BITBUCKET_BUILD_NUMBER',
];

/**
 * Wait until stdout has accumulated `waitFor`, then send `input`.
 * By default a CR is appended after `input` (clack submit); set
 * {@link PtyAnswer.appendCr} to `false` for escape-only payloads (e.g. arrow keys).
 * Use {@link PtyAnswer.waitOnly} to synchronize on output without sending keys.
 */
export interface PtyAnswer {
	readonly waitFor: string;
	readonly input: string;
	/** When `false`, send `input` bytes only (no trailing CR). Default `true`. */
	readonly appendCr?: boolean;
	/** When `true`, match `waitFor` then continue (no `send`). Default `false`. */
	readonly waitOnly?: boolean;
}

export interface PtyResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number | null;
	readonly matched: PtyAnswer[];
	readonly timedOutAt?: PtyAnswer;
}

/**
 * Tcl brace-quoting for literal strings (disables `$[]` substitution).
 */
function tclBrace(s: string): string {
	return `{${String(s).replace(/\\/g, '/').replace(/}/g, '\\}')}}`;
}

/**
 * Escape a user substring for Tcl `expect -re` (ERE-ish) matching.
 */
function tclRegexEscape(s: string): string {
	return String(s).replace(/[[\]()*+?.^$|{}\\]/g, '\\$&');
}

/**
 * Tcl braced literal for `send --` payloads (no `"` / `[` substitution).
 * Only `}` must be escaped — mirrors the close-brace rule from {@link tclBrace}
 * without rewriting backslashes (needed for ESC sequences like `\x1b[B`).
 */
function tclBracedSendPayload(s: string): string {
	return `{${String(s).replace(/}/g, '\\}')}}`;
}

/**
 * Run `story <args>` under a pseudo-tty, feeding scripted answers in order.
 *
 * @example
 * ```ts
 * const r = await runStoryInteractive('/tmp/repo', ['explain'], [
 *   { waitFor: 'Select a checkpoint to explain', input: '' },
 * ]);
 * ```
 *
 * Writes a temp Tcl script under the OS tmpdir, runs `expect -f` against it,
 * then deletes the temp dir. On timeout, stderr contains
 * `STORY_PTY_TIMEOUT idx=N` where `N` is the zero-based answer index.
 */
export async function runStoryInteractive(
	dir: string,
	args: readonly string[],
	answers: readonly PtyAnswer[],
	opts?: { timeoutMs?: number; env?: Record<string, string> },
): Promise<PtyResult> {
	const timeoutMs = opts?.timeoutMs ?? 180_000;
	const timeoutSec = Math.max(1, Math.ceil(timeoutMs / 1000));
	const node = process.execPath;
	const bin = getStoryBin();

	const matched: PtyAnswer[] = [];
	let timedOutAt: PtyAnswer | undefined;

	const lines: string[] = [
		`set timeout ${timeoutSec}`,
		`cd ${tclBrace(dir)}`,
		'log_user 1',
		'catch { fconfigure stdout -encoding utf-8 }',
		// Widen the pseudo-tty so clack renders prompts on one line (narrow PTYs
		// emit one glyph per row and `expect -re` cannot match phrases).
		'set stty_init {rows 48 cols 200}',
		`spawn ${tclBrace(node)} ${tclBrace(bin)} ${args.map((a) => tclBrace(a)).join(' ')}`,
		// Brief settle after spawn so clack `select` is ready before the first `send`.
		'sleep 0.25',
	];

	for (let i = 0; i < answers.length; i++) {
		const a = answers[i]!;
		lines.push(`expect {`);
		lines.push(`  timeout { puts stderr "STORY_PTY_TIMEOUT idx=${i}"; exit 3 }`);
		lines.push(`  -re ${tclBrace(tclRegexEscape(a.waitFor))} {}`);
		lines.push(`}`);
		if (a.waitOnly === true) {
			continue;
		}
		// Let clack finish redrawing after a match before keys hit stdin.
		lines.push('sleep 0.12');
		const sendPayload = a.appendCr === false ? a.input : `${a.input}\r`;
		lines.push(`send -- ${tclBracedSendPayload(sendPayload)}`);
	}

	lines.push('expect eof');
	lines.push('set w [wait]');
	lines.push('exit [lindex $w 3]');

	const script = `${lines.join('\n')}\n`;
	const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'story-pty-'));
	const scriptPath = path.join(tmpDir, 'drive.exp');
	try {
		await writeFile(scriptPath, script, 'utf8');
		const env: Record<string, string> = {
			...isolatedSpawnEnv(),
			// Clack uses Unicode bullets (●/○); expect + regexp need a UTF-8 locale or
			// `waitFor` patterns never match the spawned output.
			LANG: 'en_US.UTF-8',
			LC_ALL: 'en_US.UTF-8',
			// `isolatedSpawnEnv` sets `ENTIRE_TEST_TTY=0`, which forces `hasTTY()` false
			// before the `/dev/tty` probe — interactive `story` under expect(1) needs
			// the override so `select` / `confirm` render on the PTY.
			STORY_TEST_TTY: '1',
			// Default pty width is very narrow; clack wraps one glyph per line so
			// `expect -re` cannot match phrases like "Amend HEAD now?". Force a wide
			// terminal for stable substring prompts.
			COLUMNS: '200',
			LINES: '48',
			// `story explain --full` can invoke a pager; a PTY + `less` stalls `expect eof`.
			GIT_PAGER: 'cat',
			PAGER: 'cat',
			...opts?.env,
		};
		for (const k of CI_ENV_KEYS_FOR_PTY) {
			env[k] = '';
		}
		try {
			const res = await execa('expect', ['-f', scriptPath], {
				cwd: dir,
				env,
				encoding: 'utf8',
				reject: false,
				timeout: timeoutMs + 15_000,
			});
			const out = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;
			const timeoutIdx = /STORY_PTY_TIMEOUT idx=(\d+)/.exec(out);
			if (timeoutIdx !== null) {
				const idx = Number(timeoutIdx[1]);
				timedOutAt = answers[idx] ?? answers[0];
			} else if (out.includes('STORY_PTY_TIMEOUT')) {
				timedOutAt = answers[0];
			} else if (res.exitCode === 0) {
				for (const a of answers) {
					matched.push(a);
				}
			}
			return {
				stdout: res.stdout ?? '',
				stderr: res.stderr ?? '',
				exitCode: res.exitCode ?? null,
				matched,
				timedOutAt,
			};
		} catch (e) {
			const err = e as { stdout?: string; stderr?: string; exitCode?: number };
			return {
				stdout: err.stdout?.toString() ?? '',
				stderr: err.stderr?.toString() ?? '',
				exitCode: err.exitCode ?? null,
				matched,
				timedOutAt,
			};
		}
	} finally {
		await rm(tmpDir, { recursive: true, force: true });
	}
}
