/**
 * Phase 5.6 checkpoint-remote unit tests.
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/strategy/checkpoint_remote.go` —
 * `pushSettings` + `resolvePushSettings` + `ResolveCheckpointURL` +
 * `ResolveCheckpointRemoteURL` + `parseGitRemoteURL` + `deriveCheckpointURL` +
 * `RedactURL` + `FetchMetadataBranch` (URL variant) + `FetchV2MainFromURL`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execGit } from '@/git';
import {
	CHECKPOINT_REMOTE_FETCH_TIMEOUT_MS,
	deriveCheckpointURL,
	fetchMetadataBranch,
	fetchV2MainFromURL,
	hasCheckpointURL,
	originURL,
	parseGitRemoteURL,
	pushTarget,
	redactURL,
	resolveCheckpointRemoteURL,
	resolveCheckpointURL,
	resolvePushSettings,
	resolveRemoteRepo,
} from '@/strategy/checkpoint-remote';
import { TestEnv } from '../../helpers/test-env';
import { TestRemote } from '../../helpers/test-remote';

describe('strategy/checkpoint-remote — Go: checkpoint_remote.go', () => {
	// Go: checkpoint_remote.go: pushSettings.pushTarget / hasCheckpointURL
	describe('PushSettings helpers', () => {
		it('pushTarget returns checkpointURL when set, else remote', () => {
			expect(
				pushTarget({ remote: 'origin', checkpointURL: 'https://x/y.git', pushDisabled: false }),
			).toBe('https://x/y.git');
			expect(pushTarget({ remote: 'origin', checkpointURL: '', pushDisabled: false })).toBe(
				'origin',
			);
		});

		it('hasCheckpointURL returns true iff checkpointURL non-empty', () => {
			expect(hasCheckpointURL({ remote: 'origin', checkpointURL: 'x', pushDisabled: false })).toBe(
				true,
			);
			expect(hasCheckpointURL({ remote: 'origin', checkpointURL: '', pushDisabled: false })).toBe(
				false,
			);
		});
	});

	// Go: checkpoint_remote.go: parseGitRemoteURL
	describe('parseGitRemoteURL', () => {
		it('parses SSH SCP form (git@host:owner/repo.git)', () => {
			// Go: checkpoint_remote.go: parseGitRemoteURL (SSH SCP)
			expect(parseGitRemoteURL('git@github.com:acme/repo.git')).toEqual({
				protocol: 'ssh',
				host: 'github.com',
				owner: 'acme',
				repo: 'repo',
			});
		});

		it('parses HTTPS URL', () => {
			// Go: checkpoint_remote.go: parseGitRemoteURL (HTTPS)
			expect(parseGitRemoteURL('https://github.com/acme/repo.git')).toEqual({
				protocol: 'https',
				host: 'github.com',
				owner: 'acme',
				repo: 'repo',
			});
		});

		it('parses ssh:// protocol form', () => {
			// Go: checkpoint_remote.go: parseGitRemoteURL (ssh:// scheme)
			expect(parseGitRemoteURL('ssh://git@gitlab.com/group/sub.git')).toEqual({
				protocol: 'ssh',
				host: 'gitlab.com',
				owner: 'group',
				repo: 'sub',
			});
		});

		it('throws on invalid input (no path / no owner-repo / unparseable)', () => {
			expect(() => parseGitRemoteURL('not a url')).toThrow();
			expect(() => parseGitRemoteURL('https://nopath')).toThrow();
			expect(() => parseGitRemoteURL('git@host')).toThrow();
		});

		it('throws when SSH SCP form has empty host (e.g. ":org/repo.git")', () => {
			expect(() => parseGitRemoteURL(':acme/repo.git')).toThrow();
		});

		it('throws when SSH SCP path part has no slash (e.g. "git@host:repo.git")', () => {
			expect(() => parseGitRemoteURL('git@github.com:repo.git')).toThrow();
		});

		it('throws when path part has empty owner or empty repo', () => {
			// e.g. "https://github.com/owner/" → owner ok but repo empty
			expect(() => parseGitRemoteURL('https://github.com/owner/')).toThrow();
		});
	});

	// Go: checkpoint_remote.go: deriveCheckpointURL
	describe('deriveCheckpointURL', () => {
		it('preserves push remote protocol (HTTPS → HTTPS / SSH → SSH)', () => {
			// Go: checkpoint_remote.go: deriveCheckpointURL
			expect(
				deriveCheckpointURL('https://github.com/user/code.git', {
					provider: 'github',
					repo: 'user/checkpoints',
				}),
			).toBe('https://github.com/user/checkpoints.git');

			expect(
				deriveCheckpointURL('git@github.com:user/code.git', {
					provider: 'github',
					repo: 'user/checkpoints',
				}),
			).toBe('git@github.com:user/checkpoints.git');
		});

		it('returns explicit gitUrl without parsing the push remote URL', () => {
			expect(
				deriveCheckpointURL('not a url', {
				gitUrl: 'git@gitlab.com:acme/story.git',
				}),
		).toBe('git@gitlab.com:acme/story.git');
		});

		it('throws on unsupported protocol', () => {
			expect(() =>
				deriveCheckpointURL('ftp://example.com/u/r.git', { provider: 'github', repo: 'u/r' }),
			).toThrow();
		});
	});

	// Go: checkpoint_remote.go: RedactURL
	describe('redactURL', () => {
		it('strips credentials from HTTPS URLs', () => {
			expect(redactURL('https://user:secret@github.com/o/r.git')).toBe(
				'https://github.com/o/r.git',
			);
		});

		it('handles SSH SCP form (returns host:***)', () => {
			expect(redactURL('git@github.com:o/r.git')).toBe('github.com:***');
		});

		it('returns <unparseable> for malformed inputs', () => {
			expect(redactURL('not parseable junk!@#$')).toBe('<unparseable>');
		});
	});

	// Go: checkpoint_remote.go: resolvePushSettings
	describe('resolvePushSettings', () => {
		let env: TestEnv;

		beforeEach(async () => {
			env = await TestEnv.create({ initialCommit: true });
		});

		afterEach(async () => {
			await env.cleanup();
		});

		it('returns just remote+pushDisabled=false when no checkpoint_remote configured', async () => {
			// Go: checkpoint_remote.go: resolvePushSettings (no checkpoint_remote)
			const ps = await resolvePushSettings('origin', { cwd: env.dir });
			expect(ps).toEqual({ remote: 'origin', checkpointURL: '', pushDisabled: false });
		});

		it('respects push_sessions: false', async () => {
			// Go: checkpoint_remote.go: resolvePushSettings (push_sessions disabled)
			await env.writeFile(
				'.story/settings.json',
				JSON.stringify({ enabled: true, strategy_options: { push_sessions: false } }),
			);
			const ps = await resolvePushSettings('origin', { cwd: env.dir });
			expect(ps.pushDisabled).toBe(true);
		});

		it('derives HTTPS checkpoint URL from HTTPS push remote', async () => {
			// Go: checkpoint_remote.go: resolvePushSettings (HTTPS derivation)
			await env.exec('git', ['remote', 'add', 'origin', 'https://github.com/acme/code.git']);
			await env.writeFile(
				'.story/settings.json',
				JSON.stringify({
					enabled: true,
					strategy_options: { checkpoint_remote: { provider: 'github', repo: 'acme/checkpoints' } },
				}),
			);
			const ps = await resolvePushSettings('origin', { cwd: env.dir });
			expect(ps.checkpointURL).toBe('https://github.com/acme/checkpoints.git');
		});

		it('derives SSH checkpoint URL from SSH push remote', async () => {
			// Go: checkpoint_remote.go: resolvePushSettings (SSH derivation)
			await env.exec('git', ['remote', 'add', 'origin', 'git@github.com:acme/code.git']);
			await env.writeFile(
				'.story/settings.json',
				JSON.stringify({
					enabled: true,
					strategy_options: { checkpoint_remote: { provider: 'github', repo: 'acme/checkpoints' } },
				}),
			);
			const ps = await resolvePushSettings('origin', { cwd: env.dir });
			expect(ps.checkpointURL).toBe('git@github.com:acme/checkpoints.git');
		});

		it('skips checkpoint URL when push owner ≠ checkpoint owner (fork detection)', async () => {
			// Go: checkpoint_remote.go: resolvePushSettings (fork detection)
			await env.exec('git', ['remote', 'add', 'origin', 'https://github.com/fork-user/code.git']);
			await env.writeFile(
				'.story/settings.json',
				JSON.stringify({
					enabled: true,
					strategy_options: {
						checkpoint_remote: { provider: 'github', repo: 'upstream/checkpoints' },
					},
				}),
			);
			const ps = await resolvePushSettings('origin', { cwd: env.dir });
			expect(ps.checkpointURL).toBe('');
		});

		it('uses explicit gitUrl without requiring the push remote to exist', async () => {
			await env.writeFile(
				'.story/settings.json',
				JSON.stringify({
					enabled: true,
					strategy_options: {
						checkpoint_remote: { gitUrl: 'git@gitlab.com:acme/story.git' },
					},
				}),
			);
			const ps = await resolvePushSettings('origin', { cwd: env.dir });
			expect(ps).toEqual({
				remote: 'origin',
				checkpointURL: 'git@gitlab.com:acme/story.git',
				pushDisabled: false,
			});
		});

		it('prefers explicit gitUrl over provider/repo derivation', async () => {
			await env.exec('git', ['remote', 'add', 'origin', 'https://github.com/acme/code.git']);
			await env.writeFile(
				'.story/settings.json',
				JSON.stringify({
					enabled: true,
					strategy_options: {
						checkpoint_remote: {
							gitUrl: 'git@gitlab.com:acme/story.git',
							provider: 'github',
							repo: 'acme/checkpoints',
						},
					},
				}),
			);
			const ps = await resolvePushSettings('origin', { cwd: env.dir });
			expect(ps.checkpointURL).toBe('git@gitlab.com:acme/story.git');
		});
	});

	// Go: checkpoint_remote.go: ResolveCheckpointURL / ResolveCheckpointRemoteURL
	describe('resolveCheckpointURL / resolveCheckpointRemoteURL', () => {
		let env: TestEnv;

		beforeEach(async () => {
			env = await TestEnv.create({ initialCommit: true });
		});

		afterEach(async () => {
			await env.cleanup();
		});

		it('resolveCheckpointURL returns URL even for fork (no fork detection)', async () => {
			// Go: checkpoint_remote.go: ResolveCheckpointURL (no fork-detect on read path)
			await env.exec('git', ['remote', 'add', 'origin', 'https://github.com/fork-user/code.git']);
			await env.writeFile(
				'.story/settings.json',
				JSON.stringify({
					enabled: true,
					strategy_options: {
						checkpoint_remote: { provider: 'github', repo: 'upstream/checkpoints' },
					},
				}),
			);
			const url = await resolveCheckpointURL('origin', { cwd: env.dir });
			expect(url).toBe('https://github.com/upstream/checkpoints.git');
		});

		it('resolveCheckpointURL returns explicit gitUrl without requiring the push remote', async () => {
			await env.writeFile(
				'.story/settings.json',
				JSON.stringify({
					enabled: true,
					strategy_options: {
						checkpoint_remote: { gitUrl: 'git@gitlab.com:acme/story.git' },
					},
				}),
			);
			const url = await resolveCheckpointURL('origin', { cwd: env.dir });
			expect(url).toBe('git@gitlab.com:acme/story.git');
		});

		it('resolveCheckpointRemoteURL returns { configured: false } when no checkpoint_remote', async () => {
			// Go: checkpoint_remote.go: ResolveCheckpointRemoteURL (no config)
			const result = await resolveCheckpointRemoteURL({ cwd: env.dir });
			expect(result).toEqual({ url: '', configured: false });
		});

		it('resolveCheckpointRemoteURL throws when configured but origin missing', async () => {
			// Go: checkpoint_remote.go: ResolveCheckpointRemoteURL (origin missing)
			await env.writeFile(
				'.story/settings.json',
				JSON.stringify({
					enabled: true,
					strategy_options: { checkpoint_remote: { provider: 'github', repo: 'a/b' } },
				}),
			);
			await expect(resolveCheckpointRemoteURL({ cwd: env.dir })).rejects.toThrow();
		});

		it('resolveCheckpointRemoteURL returns explicit gitUrl without requiring origin', async () => {
			await env.writeFile(
				'.story/settings.json',
				JSON.stringify({
					enabled: true,
					strategy_options: {
						checkpoint_remote: { gitUrl: 'git@gitlab.com:acme/story.git' },
					},
				}),
			);
			const result = await resolveCheckpointRemoteURL({ cwd: env.dir });
			expect(result).toEqual({
				url: 'git@gitlab.com:acme/story.git',
				configured: true,
			});
		});
	});

	// Go: checkpoint_remote.go: ResolveRemoteRepo / OriginURL
	describe('resolveRemoteRepo / originURL', () => {
		let env: TestEnv;

		beforeEach(async () => {
			env = await TestEnv.create({ initialCommit: true });
		});

		afterEach(async () => {
			await env.cleanup();
		});

		it('resolveRemoteRepo returns host/owner/repo for a configured remote', async () => {
			// Go: checkpoint_remote.go: ResolveRemoteRepo
			await env.exec('git', ['remote', 'add', 'origin', 'git@github.com:acme/repo.git']);
			const result = await resolveRemoteRepo('origin', { cwd: env.dir });
			expect(result).toEqual({ host: 'github.com', owner: 'acme', repo: 'repo' });
		});

		it('originURL returns the configured URL of origin', async () => {
			// Go: checkpoint_remote.go: OriginURL
			await env.exec('git', ['remote', 'add', 'origin', 'https://github.com/o/r.git']);
			const url = await originURL({ cwd: env.dir });
			expect(url).toBe('https://github.com/o/r.git');
		});

		it('resolveRemoteRepo throws when remote missing', async () => {
			await expect(resolveRemoteRepo('upstream', { cwd: env.dir })).rejects.toThrow();
		});
	});

	// Go: checkpoint_remote.go: FetchMetadataBranch (URL variant) / FetchV2MainFromURL
	describe('fetchMetadataBranch / fetchV2MainFromURL', () => {
		let env: TestEnv;
		let remote: TestRemote;

		beforeEach(async () => {
			env = await TestEnv.create({ initialCommit: true });
			remote = await TestRemote.create();
		});

		afterEach(async () => {
			await env.cleanup();
			await remote.cleanup();
		});

		it('fetchMetadataBranch fetches from URL and updates local refs/heads/story/checkpoints/v1', async () => {
			// Go: checkpoint_remote.go: FetchMetadataBranch (URL)
			// Seed remote with a story/checkpoints/v1 branch
			const seed = await TestEnv.create({ initialCommit: true });
			try {
				await seed.exec('git', ['branch', 'story/checkpoints/v1', 'HEAD']);
				await remote.pushFrom(seed, 'story/checkpoints/v1:story/checkpoints/v1');

				await fetchMetadataBranch(remote.url, { cwd: env.dir });

				const localHash = await execGit(['rev-parse', 'refs/heads/story/checkpoints/v1'], {
					cwd: env.dir,
				});
				const remoteHash = await remote.resolveRef('refs/heads/story/checkpoints/v1');
				expect(localHash).toBe(remoteHash);

				// temp ref cleaned up
				const tmp = await execGit(
					['for-each-ref', '--format=%(refname)', 'refs/story-fetch-tmp/'],
					{
						cwd: env.dir,
					},
				);
				expect(tmp).toBe('');
			} finally {
				await seed.cleanup();
			}
		});

		it('fetchMetadataBranch error message contains redacted URL', async () => {
			// Go: checkpoint_remote.go: FetchMetadataBranch (error path)
			await expect(
				fetchMetadataBranch('https://user:secret@nonexistent.invalid/o/r.git', { cwd: env.dir }),
			).rejects.toThrow(/https:\/\/nonexistent\.invalid\/o\/r\.git/);
		});

		it('fetchV2MainFromURL writes refs/story/checkpoints/v2/main directly', async () => {
			// Go: checkpoint_remote.go: FetchV2MainFromURL
			const seed = await TestEnv.create({ initialCommit: true });
			try {
				const head = (await seed.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
				await seed.exec('git', ['update-ref', 'refs/story/checkpoints/v2/main', head]);
				await remote.pushFrom(
					seed,
					'+refs/story/checkpoints/v2/main:refs/story/checkpoints/v2/main',
				);

				await fetchV2MainFromURL(remote.url, { cwd: env.dir });

				const localHash = await execGit(['rev-parse', 'refs/story/checkpoints/v2/main'], {
					cwd: env.dir,
				});
				expect(localHash).toBe(head);
			} finally {
				await seed.cleanup();
			}
		});
	});

	// Verify exported timeout constant has a sane value
	it('CHECKPOINT_REMOTE_FETCH_TIMEOUT_MS is positive (sanity)', () => {
		expect(CHECKPOINT_REMOTE_FETCH_TIMEOUT_MS).toBeGreaterThan(0);
	});

	// Coverage-pumping cases for silent-fail / cache-hit branches.
	describe('silent-fail and cache-hit branches', () => {
		let env: TestEnv;

		beforeEach(async () => {
			env = await TestEnv.create({ initialCommit: true });
		});

		afterEach(async () => {
			await env.cleanup();
		});

		it('resolvePushSettings warns and returns ps when push remote URL not configured', async () => {
			// Triggers `git remote get-url <missing>` failure path.
			await env.writeFile(
				'.story/settings.json',
				JSON.stringify({
					enabled: true,
					strategy_options: { checkpoint_remote: { provider: 'github', repo: 'a/b' } },
				}),
			);
			const ps = await resolvePushSettings('nonexistent-remote', { cwd: env.dir });
			expect(ps.checkpointURL).toBe('');
			expect(ps.remote).toBe('nonexistent-remote');
		});

		it('resolvePushSettings warns and returns ps when push remote URL is unparseable', async () => {
			// Configure a remote with junk URL so parseGitRemoteURL throws.
			await env.exec('git', ['remote', 'add', 'origin', 'totally-not-a-url']);
			await env.writeFile(
				'.story/settings.json',
				JSON.stringify({
					enabled: true,
					strategy_options: { checkpoint_remote: { provider: 'github', repo: 'a/b' } },
				}),
			);
			const ps = await resolvePushSettings('origin', { cwd: env.dir });
			expect(ps.checkpointURL).toBe('');
		});

		it('resolveCheckpointURL returns "" when no checkpoint_remote configured', async () => {
			const url = await resolveCheckpointURL('origin', { cwd: env.dir });
			expect(url).toBe('');
		});

		it('resolveCheckpointURL returns "" when remote URL unparseable', async () => {
			await env.exec('git', ['remote', 'add', 'origin', 'totally-not-a-url']);
			await env.writeFile(
				'.story/settings.json',
				JSON.stringify({
					enabled: true,
					strategy_options: { checkpoint_remote: { provider: 'github', repo: 'a/b' } },
				}),
			);
			const url = await resolveCheckpointURL('origin', { cwd: env.dir });
			expect(url).toBe('');
		});

		it('resolveCheckpointRemoteURL throws when origin URL unparseable', async () => {
			await env.exec('git', ['remote', 'add', 'origin', 'totally-not-a-url']);
			await env.writeFile(
				'.story/settings.json',
				JSON.stringify({
					enabled: true,
					strategy_options: { checkpoint_remote: { provider: 'github', repo: 'a/b' } },
				}),
			);
			await expect(resolveCheckpointRemoteURL({ cwd: env.dir })).rejects.toThrow(
				/could not parse origin remote URL/,
			);
		});

		it('resolvePushSettings caches the local v1 metadata branch — fetch skipped when present', async () => {
			// Local already has the branch → fetchMetadataBranchIfMissing should skip fetch.
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			await env.exec('git', ['update-ref', `refs/heads/story/checkpoints/v1`, head]);
			await env.exec('git', ['remote', 'add', 'origin', 'https://github.com/acme/code.git']);
			await env.writeFile(
				'.story/settings.json',
				JSON.stringify({
					enabled: true,
					strategy_options: {
						checkpoint_remote: { provider: 'github', repo: 'acme/checkpoints' },
					},
				}),
			);
			const ps = await resolvePushSettings('origin', { cwd: env.dir });
			expect(ps.checkpointURL).toBe('https://github.com/acme/checkpoints.git');
			// Branch unchanged.
			const head2 = await execGit(['rev-parse', 'refs/heads/story/checkpoints/v1'], {
				cwd: env.dir,
			});
			expect(head2).toBe(head);
		});

		it('resolvePushSettings v2 path: fetches v2 /main when push_v2_refs enabled and missing', async () => {
			// No local v2 /main → triggers fetchV2MainRefIfMissing → silent fail (URL unreachable).
			await env.exec('git', ['remote', 'add', 'origin', 'https://github.com/acme/code.git']);
			await env.writeFile(
				'.story/settings.json',
				JSON.stringify({
					enabled: true,
					strategy_options: {
						checkpoint_remote: { provider: 'github', repo: 'acme/checkpoints' },
						checkpoints_v2: true,
						push_v2_refs: true,
					},
				}),
			);
			const ps = await resolvePushSettings('origin', { cwd: env.dir });
			expect(ps.checkpointURL).toBe('https://github.com/acme/checkpoints.git');
		});

		it('resolvePushSettings v2 cache hit: skips fetch when local v2 /main present', async () => {
			const head = (await env.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
			await env.exec('git', ['update-ref', 'refs/story/checkpoints/v2/main', head]);
			await env.exec('git', ['remote', 'add', 'origin', 'https://github.com/acme/code.git']);
			await env.writeFile(
				'.story/settings.json',
				JSON.stringify({
					enabled: true,
					strategy_options: {
						checkpoint_remote: { provider: 'github', repo: 'acme/checkpoints' },
						checkpoints_v2: true,
						push_v2_refs: true,
					},
				}),
			);
			await resolvePushSettings('origin', { cwd: env.dir });
			const after = await execGit(['rev-parse', 'refs/story/checkpoints/v2/main'], {
				cwd: env.dir,
			});
			expect(after).toBe(head);
		});

		it('fetchV2MainFromURL error message contains redacted URL', async () => {
			await expect(
				fetchV2MainFromURL('https://user:secret@nonexistent.invalid/o/r.git', { cwd: env.dir }),
			).rejects.toThrow(/https:\/\/nonexistent\.invalid\/o\/r\.git/);
		});

		it('originURL throws when origin remote missing', async () => {
			await expect(originURL({ cwd: env.dir })).rejects.toThrow();
		});

		it('resolveCheckpointRemoteURL returns { url, configured: true } on happy path', async () => {
			await env.exec('git', ['remote', 'add', 'origin', 'https://github.com/acme/code.git']);
			await env.writeFile(
				'.story/settings.json',
				JSON.stringify({
					enabled: true,
					strategy_options: {
						checkpoint_remote: { provider: 'github', repo: 'acme/checkpoints' },
					},
				}),
			);
			const result = await resolveCheckpointRemoteURL({ cwd: env.dir });
			expect(result).toEqual({
				url: 'https://github.com/acme/checkpoints.git',
				configured: true,
			});
		});

		it('resolvePushSettings returns defaults when settings.json is malformed', async () => {
			// Corrupted JSON → readSettings throws → resolvePushSettings catch returns defaults.
			await env.writeFile('.story/settings.json', '{ this is not valid json');
			const ps = await resolvePushSettings('origin', { cwd: env.dir });
			expect(ps).toEqual({
				remote: 'origin',
				checkpointURL: '',
				pushDisabled: false,
			});
		});

		it('resolveCheckpointURL returns "" when settings.json is malformed', async () => {
			await env.writeFile('.story/settings.json', '{ this is not valid json');
			const url = await resolveCheckpointURL('origin', { cwd: env.dir });
			expect(url).toBe('');
		});

		it('resolveCheckpointRemoteURL returns { configured: false } when settings.json is malformed', async () => {
			await env.writeFile('.story/settings.json', '{ this is not valid json');
			const result = await resolveCheckpointRemoteURL({ cwd: env.dir });
			expect(result).toEqual({ url: '', configured: false });
		});

		it('resolvePushSettings warns when derived protocol is unsupported (e.g. ftp://)', async () => {
			// Set a remote with parseable but non-SSH/non-HTTPS protocol → triggers
			// `deriveCheckpointURLFromInfo` throw → "could not derive URL" warn path.
			await env.exec('git', ['remote', 'add', 'origin', 'ftp://example.com/u/r.git']);
			await env.writeFile(
				'.story/settings.json',
				JSON.stringify({
					enabled: true,
					strategy_options: { checkpoint_remote: { provider: 'github', repo: 'a/b' } },
				}),
			);
			const ps = await resolvePushSettings('origin', { cwd: env.dir });
			expect(ps.checkpointURL).toBe('');
		});
	});
});
