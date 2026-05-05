/**
 * Phase 5.6 checkpoint-token unit tests.
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/strategy/checkpoint_token.go` —
 * `CheckpointTokenEnvVar` / `CheckpointGitCommand` / `appendCheckpointTokenEnv` /
 * `isValidToken` / `resolveTargetProtocol` / `ResolveFetchTarget` /
 * `AppendFetchFilterArgs`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execGit } from '@/git';
import {
	appendFetchFilterArgs,
	checkpointGitCommand,
	resetTokenWarnOnceForTesting,
	resolveFetchTarget,
	STORY_CHECKPOINT_TOKEN,
	STORY_CHECKPOINT_TOKEN_LEGACY,
} from '@/strategy/checkpoint-token';
import { setStderrWriterForTesting } from '@/strategy/hooks-tty';
import { TestEnv } from '../../helpers/test-env';

interface Captured {
	captured: string;
}

function makeWritable(): NodeJS.WritableStream & Captured {
	const stream = {
		captured: '',
		write(chunk: string | Uint8Array): boolean {
			stream.captured += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
			return true;
		},
	} as NodeJS.WritableStream & Captured;
	return stream;
}

function base64(s: string): string {
	return Buffer.from(s, 'utf8').toString('base64');
}

describe('strategy/checkpoint-token — Go: checkpoint_token.go', () => {
	beforeEach(() => {
		resetTokenWarnOnceForTesting();
	});

	afterEach(() => {
		resetTokenWarnOnceForTesting();
		setStderrWriterForTesting(null);
		delete process.env[STORY_CHECKPOINT_TOKEN];
		delete process.env[STORY_CHECKPOINT_TOKEN_LEGACY];
	});

	// Story-side naming red line.
	describe('STORY_CHECKPOINT_TOKEN constants', () => {
		it('STORY_CHECKPOINT_TOKEN equals "STORY_CHECKPOINT_TOKEN"', () => {
			expect(STORY_CHECKPOINT_TOKEN).toBe('STORY_CHECKPOINT_TOKEN');
		});

		it('STORY_CHECKPOINT_TOKEN_LEGACY equals "ENTIRE_CHECKPOINT_TOKEN" (back-compat)', () => {
			expect(STORY_CHECKPOINT_TOKEN_LEGACY).toBe('ENTIRE_CHECKPOINT_TOKEN');
		});
	});

	// Go: checkpoint_token.go: CheckpointGitCommand
	describe('checkpointGitCommand', () => {
		// Go: checkpoint_token.go: CheckpointGitCommand_NoToken
		it('returns args+env undefined when token unset', async () => {
			const result = await checkpointGitCommand('https://github.com/o/r.git', ['fetch', 'origin']);
			expect(result.args).toEqual(['fetch', 'origin']);
			expect(result.env).toBeUndefined();
		});

		// Go: checkpoint_token.go: CheckpointGitCommand_HTTPS_InjectsToken
		it('injects HTTP Basic token via GIT_CONFIG_* for HTTPS target', async () => {
			process.env[STORY_CHECKPOINT_TOKEN] = 'ghp_test123';
			const result = await checkpointGitCommand('https://github.com/o/r.git', ['fetch']);
			const env = result.env;
			expect(env).toBeDefined();
			expect(env?.GIT_CONFIG_COUNT).toBe('1');
			expect(env?.GIT_CONFIG_KEY_0).toBe('http.extraHeader');
			expect(env?.GIT_CONFIG_VALUE_0).toBe(
				`Authorization: Basic ${base64('x-access-token:ghp_test123')}`,
			);
		});

		// Go: checkpoint_token.go: CheckpointGitCommand_SSH_WarnsAndSkips
		it('SSH target prints one-time [story] warning and omits token', async () => {
			process.env[STORY_CHECKPOINT_TOKEN] = 'ghp_test123';
			const writer = makeWritable();
			setStderrWriterForTesting(writer);

			const result = await checkpointGitCommand('git@github.com:o/r.git', [
				'push',
				'origin',
				'main',
			]);
			expect(result.env).toBeUndefined();
			expect(writer.captured).toMatch(/\[story\]/);
			expect(writer.captured).toContain('STORY_CHECKPOINT_TOKEN');
			expect(writer.captured).toContain('SSH');
			expect(writer.captured).toContain('ignored');

			// Second call: warning suppressed (sync.Once).
			const before = writer.captured.length;
			await checkpointGitCommand('git@github.com:o/r.git', ['push', 'origin', 'main']);
			expect(writer.captured.length).toBe(before);
		});

		// Go: checkpoint_token.go: CheckpointGitCommand_ControlCharsInToken
		it('prints warning and skips token containing control characters (CR/LF/null/DEL)', async () => {
			process.env[STORY_CHECKPOINT_TOKEN] = 'token\r\nEvil: injected';
			const writer = makeWritable();
			setStderrWriterForTesting(writer);

			const result = await checkpointGitCommand('https://github.com/o/r.git', ['fetch']);
			expect(result.env).toBeUndefined();
			expect(writer.captured).toContain('[story]');
			expect(writer.captured).toContain('STORY_CHECKPOINT_TOKEN');
			expect(writer.captured).toContain('invalid characters');
		});

		// Regression for P1 #8 — Go's invalid-token warning prints on EVERY call
		// (no sync.Once); TS used to once-gate it. The user must keep seeing the
		// warning until they fix the token.
		it('invalid-token warning prints on every call (no sync.Once)', async () => {
			process.env[STORY_CHECKPOINT_TOKEN] = 'token\r\nEvil';
			const writer = makeWritable();
			setStderrWriterForTesting(writer);

			await checkpointGitCommand('https://github.com/o/r.git', ['fetch']);
			await checkpointGitCommand('https://github.com/o/r.git', ['fetch']);
			await checkpointGitCommand('https://github.com/o/r.git', ['fetch']);

			const matches = writer.captured.match(/invalid characters/g) ?? [];
			expect(matches.length).toBe(3);
		});

		// Go: checkpoint_token.go: CheckpointGitCommand_LocalPath_NoToken
		it('skips token injection for local-path / unknown-protocol targets', async () => {
			process.env[STORY_CHECKPOINT_TOKEN] = 'ghp_test123';
			const result = await checkpointGitCommand('/tmp/some-bare-repo', ['push']);
			expect(result.env).toBeUndefined();
		});

		// Regression for P0 #4 — cleartext http:// MUST NOT receive the token.
		// Go's parseGitRemoteURL returns protocol "http" and CheckpointGitCommand
		// only injects on protocolHTTPS. Sending the token over HTTP would leak
		// it in cleartext.
		it('does NOT inject token for cleartext http:// URLs (security: never leak token in cleartext)', async () => {
			process.env[STORY_CHECKPOINT_TOKEN] = 'ghp_secret';
			const result = await checkpointGitCommand('http://example.com/o/r.git', ['fetch']);
			expect(result.env).toBeUndefined();
		});
	});

	// Story-side back-compat: ENTIRE_CHECKPOINT_TOKEN read when STORY_* unset.
	describe('STORY_CHECKPOINT_TOKEN back-compat read', () => {
		it('reads ENTIRE_CHECKPOINT_TOKEN as fallback when STORY_CHECKPOINT_TOKEN unset', async () => {
			process.env[STORY_CHECKPOINT_TOKEN_LEGACY] = 'ghp_legacy';
			const result = await checkpointGitCommand('https://github.com/o/r.git', ['fetch']);
			expect(result.env?.GIT_CONFIG_VALUE_0).toBe(
				`Authorization: Basic ${base64('x-access-token:ghp_legacy')}`,
			);
		});

		it('STORY_CHECKPOINT_TOKEN takes precedence over ENTIRE_CHECKPOINT_TOKEN when both set', async () => {
			process.env[STORY_CHECKPOINT_TOKEN] = 'ghp_story';
			process.env[STORY_CHECKPOINT_TOKEN_LEGACY] = 'ghp_legacy';
			const result = await checkpointGitCommand('https://github.com/o/r.git', ['fetch']);
			expect(result.env?.GIT_CONFIG_VALUE_0).toBe(
				`Authorization: Basic ${base64('x-access-token:ghp_story')}`,
			);
		});

		it('whitespace-only token is treated as unset', async () => {
			// Go: checkpoint_token.go: CheckpointGitCommand_WhitespaceToken
			process.env[STORY_CHECKPOINT_TOKEN] = '   ';
			const result = await checkpointGitCommand('https://github.com/o/r.git', ['fetch']);
			expect(result.env).toBeUndefined();
		});
	});

	// Go: checkpoint_token.go: appendCheckpointTokenEnv (covered via integration above);
	// here we add a direct env-filter case via behavior of checkpointGitCommand.
	describe('GIT_CONFIG_* filtering behavior', () => {
		it('drops pre-existing GIT_CONFIG_* keys from env before injecting new ones', async () => {
			// Go: checkpoint_token.go: appendCheckpointTokenEnv (filter old)
			process.env[STORY_CHECKPOINT_TOKEN] = 'new-token';
			process.env.GIT_CONFIG_COUNT = '5';
			process.env.GIT_CONFIG_KEY_0 = 'some.key';
			process.env.GIT_CONFIG_VALUE_0 = 'some-value';
			try {
				const result = await checkpointGitCommand('https://github.com/o/r.git', ['fetch']);
				const env = result.env;
				expect(env?.GIT_CONFIG_COUNT).toBe('1');
				expect(env?.GIT_CONFIG_KEY_0).toBe('http.extraHeader');
				expect(env?.GIT_CONFIG_VALUE_0).toBe(
					`Authorization: Basic ${base64('x-access-token:new-token')}`,
				);
			} finally {
				delete process.env.GIT_CONFIG_COUNT;
				delete process.env.GIT_CONFIG_KEY_0;
				delete process.env.GIT_CONFIG_VALUE_0;
			}
		});

		// Regression for P1 #11 — Go filters on the EXACT key `GIT_CONFIG_COUNT`
		// (HasPrefix(line, "GIT_CONFIG_COUNT=")). A hypothetical `GIT_CONFIG_COUNTERS`
		// must NOT be stripped because it isn't a real GIT_CONFIG_COUNT entry.
		it('preserves keys that share a prefix but are not GIT_CONFIG_COUNT (e.g. GIT_CONFIG_COUNTERS)', async () => {
			process.env[STORY_CHECKPOINT_TOKEN] = 'new-token';
			process.env.GIT_CONFIG_COUNTERS = 'should-survive';
			try {
				const result = await checkpointGitCommand('https://github.com/o/r.git', ['fetch']);
				expect(result.env?.GIT_CONFIG_COUNTERS).toBe('should-survive');
				// The new keys are still injected normally.
				expect(result.env?.GIT_CONFIG_COUNT).toBe('1');
			} finally {
				delete process.env.GIT_CONFIG_COUNTERS;
			}
		});

		// Go: checkpoint_token.go: TestAppendCheckpointTokenEnv "preserves unrelated vars".
		it('preserves unrelated env vars (PATH, HOME, etc.)', async () => {
			process.env[STORY_CHECKPOINT_TOKEN] = 'new-token';
			process.env.STORY_TEST_FIXTURE_VAR = 'preserved-value';
			try {
				const result = await checkpointGitCommand('https://github.com/o/r.git', ['fetch']);
				expect(result.env?.STORY_TEST_FIXTURE_VAR).toBe('preserved-value');
				expect(result.env?.PATH).toBeDefined();
			} finally {
				delete process.env.STORY_TEST_FIXTURE_VAR;
			}
		});
	});

	// Go: checkpoint_token.go: ResolveFetchTarget
	describe('resolveFetchTarget', () => {
		let env: TestEnv;

		beforeEach(async () => {
			env = await TestEnv.create({ initialCommit: true });
			await env.exec('git', ['remote', 'add', 'origin', 'https://github.com/o/r.git']);
		});

		afterEach(async () => {
			await env.cleanup();
		});

		// Go: checkpoint_token.go: ResolveFetchTarget (disabled returns remote name)
		it('returns target unchanged when filter disabled', async () => {
			const result = await resolveFetchTarget('origin', { cwd: env.dir });
			expect(result).toBe('origin');
		});

		// Go: checkpoint_token.go: ResolveFetchTarget (URL stays unchanged)
		it('returns target unchanged when target is already a URL', async () => {
			await env.writeFile(
				'.story/settings.json',
				JSON.stringify({ enabled: true, strategy_options: { filtered_fetches: true } }),
			);
			const result = await resolveFetchTarget('https://github.com/x/y.git', { cwd: env.dir });
			expect(result).toBe('https://github.com/x/y.git');
		});

		// Go: checkpoint_token.go: ResolveFetchTarget (enabled resolves remote to URL)
		it('resolves remote name to URL when filter enabled', async () => {
			await env.writeFile(
				'.story/settings.json',
				JSON.stringify({ enabled: true, strategy_options: { filtered_fetches: true } }),
			);
			const result = await resolveFetchTarget('origin', { cwd: env.dir });
			expect(result).toBe('https://github.com/o/r.git');
		});
	});

	// Go: checkpoint_token.go: AppendFetchFilterArgs
	describe('appendFetchFilterArgs', () => {
		let env: TestEnv;

		beforeEach(async () => {
			env = await TestEnv.create({ initialCommit: true });
		});

		afterEach(async () => {
			await env.cleanup();
		});

		it('returns args unchanged when filter disabled', async () => {
			const args = ['fetch', '--no-tags', 'origin', 'main'];
			const result = await appendFetchFilterArgs(args, { cwd: env.dir });
			expect(result).toEqual(args);
		});

		it('appends --filter=blob:none when filter enabled', async () => {
			await env.writeFile(
				'.story/settings.json',
				JSON.stringify({ enabled: true, strategy_options: { filtered_fetches: true } }),
			);
			const result = await appendFetchFilterArgs(['fetch', '--no-tags', 'origin', 'main'], {
				cwd: env.dir,
			});
			expect(result).toEqual(['fetch', '--no-tags', 'origin', 'main', '--filter=blob:none']);
		});
	});

	// Verify the SSH-token coexistence semantic from the Go test
	// `TestCheckpointToken_GIT_TERMINAL_PROMPT_Coexistence` is supported by
	// the env-merge contract: caller can merge their own GIT_TERMINAL_PROMPT.
	it('returned env can be safely augmented with GIT_TERMINAL_PROMPT (no clash)', async () => {
		process.env[STORY_CHECKPOINT_TOKEN] = 'coexist-token';
		const result = await checkpointGitCommand('https://github.com/o/r.git', ['fetch']);
		const env: NodeJS.ProcessEnv = { ...result.env, GIT_TERMINAL_PROMPT: '0' };
		expect(env.GIT_CONFIG_COUNT).toBe('1');
		expect(env.GIT_CONFIG_VALUE_0).toBe(
			`Authorization: Basic ${base64('x-access-token:coexist-token')}`,
		);
		expect(env.GIT_TERMINAL_PROMPT).toBe('0');
	});

	// Reference execGit so the import isn't dead — silences linters and
	// documents that callers may chain checkpointGitCommand → execGit.
	it('execGit re-export is reachable from this test module (smoke)', () => {
		expect(typeof execGit).toBe('function');
	});
});
