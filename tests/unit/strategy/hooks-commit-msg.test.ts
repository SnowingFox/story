/**
 * Phase 5.4 Part 1 unit tests for [src/strategy/hooks-commit-msg.ts](src/strategy/hooks-commit-msg.ts).
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/strategy/manual_commit_hooks.go`:
 *   - `CommitMsg` (commit-msg hook entry)
 *   - `hasUserContent`
 *   - `stripCheckpointTrailer`
 *
 * Each `it()` is annotated with `// Go: <go-file>:<line>` for the
 * audit-test-go-parity gate.
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commitMsgImpl, hasUserContent, stripCheckpointTrailer } from '@/strategy/hooks-commit-msg';
import { ManualCommitStrategy } from '@/strategy/manual-commit';
import { TestEnv } from '../../helpers/test-env';

describe('hasUserContent', () => {
	// Go: manual_commit_hooks.go: hasUserContent:323-340 — empty / only-comments / only-trailer / mixed matrix
	it('returns false for empty message', () => {
		expect(hasUserContent('')).toBe(false);
	});

	it('returns false for only-comment lines', () => {
		expect(hasUserContent('# please write a commit\n# more help\n')).toBe(false);
	});

	it('returns false for only the Story-Checkpoint trailer (with comments)', () => {
		expect(
			hasUserContent('# auto-generated\n\nStory-Checkpoint: 0188abcdef01\n# explanatory note'),
		).toBe(false);
	});

	it('returns true when user-typed content is present (mixed)', () => {
		expect(
			hasUserContent(
				'feat: real commit subject\n\n# git auto-comment\nStory-Checkpoint: 0188abcdef01',
			),
		).toBe(true);
	});

	it('returns true for whitespace-padded user content', () => {
		expect(hasUserContent('   real text   \n')).toBe(true);
	});
});

describe('stripCheckpointTrailer', () => {
	// Go: manual_commit_hooks.go: stripCheckpointTrailer:344-353 — removes only Story-Checkpoint lines
	it('removes only Story-Checkpoint trailer lines (preserves other trailers + comments)', () => {
		const input = [
			'feat: subject',
			'',
			'Story-Session: sess-abc',
			'Story-Checkpoint: 0188abcdef01',
			'# git auto-comment',
		].join('\n');
		const output = stripCheckpointTrailer(input);
		expect(output).toBe(
			['feat: subject', '', 'Story-Session: sess-abc', '# git auto-comment'].join('\n'),
		);
	});

	it('returns input unchanged when no Story-Checkpoint trailer', () => {
		const input = 'feat: subject\n\nStory-Session: sess-1\n';
		expect(stripCheckpointTrailer(input)).toBe(input);
	});
});

describe('commitMsgImpl', () => {
	let env: TestEnv;
	let strategy: ManualCommitStrategy;

	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		strategy = new ManualCommitStrategy(env.dir);
	});
	afterEach(async () => {
		await env.cleanup();
	});

	async function writeMsg(contents: string): Promise<string> {
		const file = path.join(env.dir, 'COMMIT_EDITMSG');
		await writeFile(file, contents, { mode: 0o600 });
		return file;
	}

	// Go: manual_commit_hooks.go: CommitMsg:215-219 — no trailer = no-op
	it('no-op when message has no Story-Checkpoint trailer', async () => {
		const file = await writeMsg('a real commit subject\n');
		await commitMsgImpl(strategy, file);
		expect(await readFile(file, 'utf8')).toBe('a real commit subject\n');
	});

	// Go: manual_commit_hooks.go: CommitMsg:222-228 — trailer + user content = keep trailer
	it('keeps trailer when user content is present', async () => {
		const original = 'feat: subject\n\nStory-Checkpoint: 0188abcdef01\n# auto-comment\n';
		const file = await writeMsg(original);
		await commitMsgImpl(strategy, file);
		expect(await readFile(file, 'utf8')).toBe(original);
	});

	// Go: manual_commit_hooks.go: CommitMsg:222-228 — trailer-only = strip so git aborts
	it('strips trailer when only trailer + comments present (so git aborts on empty msg)', async () => {
		const file = await writeMsg(
			'# editor comment\n\nStory-Checkpoint: 0188abcdef01\n# more comment\n',
		);
		await commitMsgImpl(strategy, file);
		const after = await readFile(file, 'utf8');
		expect(after).not.toContain('Story-Checkpoint:');
		// Comments should remain (git itself strips them; we only remove trailer).
		expect(after).toContain('# editor comment');
	});

	// Go: manual_commit_hooks.go: CommitMsg:208-211 — silent on file read error
	it('returns silently when file read fails (no such path)', async () => {
		await commitMsgImpl(strategy, path.join(env.dir, 'no-such-file'));
		// no exception
	});
});
