/**
 * `src/git/fetch.ts` — 8 fetch helpers used by `story resume` (foundation
 * backlog item #21) + future Phase 9.x consumers.
 *
 * Go: `cmd/entire/cli/git_operations.go:348-615` (8 functions).
 *
 * Testing strategy (Phase 9.4 review fix B1-B7):
 *   - Mock `execa` (used by `runFetchCommand` for fetch + timeout path).
 *   - Mock `@/git::execGit` for the checkout step + ancestry probes from
 *     `ref-promote`.
 *   - Mock `@/strategy/ref-promote::promoteTmpRefSafely` + `safelyAdvanceLocalRef`
 *     so we can assert they were called without standing up real refs.
 *   - Mock `@/strategy/checkpoint-token::checkpointGitCommand` /
 *     `resolveFetchTarget` / `appendFetchFilterArgs` to control the
 *     token/URL/filter layer deterministically per test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SilentError } from '@/errors';
import * as validation from '@/validation';
import { TestEnv } from '../../helpers/test-env';

// Hoisted mocks

const execaMock = vi.hoisted(() =>
	vi.fn<
		(
			...args: unknown[]
		) => Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }>
	>(),
);
const execGitMock = vi.hoisted(() =>
	vi.fn<(args: string[], opts?: { cwd?: string }) => Promise<string>>(),
);
const promoteTmpRefSafelyMock = vi.hoisted(() =>
	vi.fn<(repo: string, tmp: string, dest: string, label: string) => Promise<void>>(),
);
const safelyAdvanceLocalRefMock = vi.hoisted(() =>
	vi.fn<(repo: string, localRef: string, target: string) => Promise<void>>(),
);
const checkpointGitCommandMock = vi.hoisted(() =>
	vi.fn<
		(
			target: string,
			args: string[],
		) => Promise<{ args: string[]; env: NodeJS.ProcessEnv | undefined }>
	>(),
);
const resolveFetchTargetMock = vi.hoisted(() =>
	vi.fn<(target: string, opts: { cwd: string }) => Promise<string>>(),
);
const appendFetchFilterArgsMock = vi.hoisted(() =>
	vi.fn<(args: string[], opts: { cwd: string }) => Promise<string[]>>(),
);
const isoGitResolveRefMock = vi.hoisted(() => vi.fn<(opts: { ref: string }) => Promise<string>>());

vi.mock('execa', () => ({ execa: execaMock }));

vi.mock('@/git', async (orig) => {
	const mod = (await orig()) as Record<string, unknown>;
	return { ...mod, execGit: execGitMock };
});

vi.mock('@/strategy/ref-promote', async (orig) => {
	const mod = (await orig()) as Record<string, unknown>;
	return {
		...mod,
		promoteTmpRefSafely: promoteTmpRefSafelyMock,
		safelyAdvanceLocalRef: safelyAdvanceLocalRefMock,
	};
});

vi.mock('@/strategy/checkpoint-token', async (orig) => {
	const mod = (await orig()) as Record<string, unknown>;
	return {
		...mod,
		checkpointGitCommand: checkpointGitCommandMock,
		resolveFetchTarget: resolveFetchTargetMock,
		appendFetchFilterArgs: appendFetchFilterArgsMock,
	};
});

vi.mock('isomorphic-git', async (orig) => {
	const mod = (await orig()) as Record<string, unknown>;
	return {
		...mod,
		default: {
			...((mod as { default?: Record<string, unknown> }).default ?? mod),
			resolveRef: isoGitResolveRefMock,
		},
	};
});

import {
	fetchAndCheckoutRemoteBranch,
	fetchBlobsByHash,
	fetchMetadataBranch,
	fetchMetadataFromCheckpointRemote,
	fetchMetadataTreeOnly,
	fetchV2MainRef,
	fetchV2MainTreeOnly,
	fetchV2MetadataFromCheckpointRemote,
} from '@/git/fetch';

function resetMocks(): void {
	execaMock.mockReset().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '', timedOut: false });
	execGitMock.mockReset().mockResolvedValue('');
	promoteTmpRefSafelyMock.mockReset().mockResolvedValue(undefined);
	safelyAdvanceLocalRefMock.mockReset().mockResolvedValue(undefined);
	// Default pass-through: no token injection, no env swap.
	checkpointGitCommandMock.mockReset().mockImplementation(async (_target, args) => ({
		args,
		env: undefined,
	}));
	// Default: resolve remote name as itself.
	resolveFetchTargetMock.mockReset().mockImplementation(async (target) => target);
	// Default: filter disabled.
	appendFetchFilterArgsMock.mockReset().mockImplementation(async (args) => args);
	// Default: resolve a stable commit hash so safelyAdvance doesn't blow up.
	isoGitResolveRefMock.mockReset().mockResolvedValue('a'.repeat(40));
}

describe('git/fetch — Go: git_operations.go:348-615', () => {
	beforeEach(() => {
		resetMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('fetchAndCheckoutRemoteBranch', () => {
		// Go: git_operations.go:362 fetch refspec construction.
		it('happy: runs fetch then checkout for a valid branch', async () => {
			await fetchAndCheckoutRemoteBranch('/repo', 'origin', 'main');
			// fetch: execa was called with correct refspec
			const execaCall = execaMock.mock.calls[0]!;
			const fetchArgs = execaCall[1] as string[];
			expect(fetchArgs.join(' ')).toContain(
				'fetch origin +refs/heads/main:refs/remotes/origin/main',
			);
			// checkout: execGit called with `checkout main`
			const checkoutCalls = execGitMock.mock.calls.map((c) => (c[0] as string[]).join(' '));
			expect(checkoutCalls).toContain('checkout main');
		});

		// Go: git_operations.go:354 ValidateBranchName callsite.
		it('calls validateBranchName with the branch arg (foundation #22 entry point)', async () => {
			const spy = vi.spyOn(validation, 'validateBranchName');
			await fetchAndCheckoutRemoteBranch('/repo', 'origin', 'feat/dark-mode');
			expect(spy).toHaveBeenCalledWith('feat/dark-mode', '/repo');
		});

		it('invalid branch name → SilentError before any fetch', async () => {
			vi.spyOn(validation, 'validateBranchName').mockResolvedValue(
				new Error('invalid branch name "bad..ref"'),
			);
			await expect(fetchAndCheckoutRemoteBranch('/repo', 'origin', 'bad..ref')).rejects.toThrow(
				SilentError,
			);
			expect(execaMock).not.toHaveBeenCalled();
		});

		it('fetch failure → wrapped Error', async () => {
			execaMock.mockResolvedValue({
				exitCode: 128,
				stdout: '',
				stderr: 'fatal: could not read Username',
				timedOut: false,
			});
			await expect(fetchAndCheckoutRemoteBranch('/repo', 'origin', 'main')).rejects.toThrow(
				/fetch|read Username/i,
			);
		});
	});

	describe('fetchMetadataBranch (origin, non-shallow) — Go: git_operations.go:398', () => {
		it('happy: runs fetch + safelyAdvanceLocalRef with metadata refspec', async () => {
			isoGitResolveRefMock.mockResolvedValue(`deadbeef${'0'.repeat(32)}`);
			await fetchMetadataBranch('/repo', 'origin');
			const fetchArgs = execaMock.mock.calls[0]![1] as string[];
			expect(fetchArgs.join(' ')).toContain(
				'fetch --no-tags origin +refs/heads/story/checkpoints/v1:refs/remotes/origin/story/checkpoints/v1',
			);
			// Non-shallow: no --depth=1.
			expect(fetchArgs).not.toContain('--depth=1');
			// Go-parity tail: advances local ref.
			expect(safelyAdvanceLocalRefMock).toHaveBeenCalledWith(
				'/repo',
				'refs/heads/story/checkpoints/v1',
				`deadbeef${'0'.repeat(32)}`,
			);
		});

		it('fetch failure → Error propagates, safelyAdvance NOT called', async () => {
			execaMock.mockResolvedValue({
				exitCode: 128,
				stdout: '',
				stderr: 'fatal: Authentication failed',
				timedOut: false,
			});
			await expect(fetchMetadataBranch('/repo', 'origin')).rejects.toThrow(
				/fetch|auth|story\/checkpoints/i,
			);
			expect(safelyAdvanceLocalRefMock).not.toHaveBeenCalled();
		});

		it('non-default remote name is passed through to git fetch', async () => {
			await fetchMetadataBranch('/repo', 'upstream');
			const fetchArgs = execaMock.mock.calls[0]![1] as string[];
			expect(fetchArgs).toContain('upstream');
		});
	});

	describe('fetchMetadataTreeOnly (shallow) — Go: git_operations.go:407', () => {
		it('happy: runs fetch with --depth=1', async () => {
			await fetchMetadataTreeOnly('/repo', 'origin');
			const fetchArgs = execaMock.mock.calls[0]![1] as string[];
			expect(fetchArgs).toContain('--depth=1');
			expect(fetchArgs.join(' ')).toContain('story/checkpoints/v1');
		});

		it('partial-clone not supported → fetch error propagates', async () => {
			execaMock.mockResolvedValue({
				exitCode: 128,
				stdout: '',
				stderr: "fatal: remote doesn't support filter",
				timedOut: false,
			});
			await expect(fetchMetadataTreeOnly('/repo', 'origin')).rejects.toThrow(/fetch|filter/i);
		});
	});

	describe('fetchV2MainTreeOnly / fetchV2MainRef (tmpRef + promote) — Go: git_operations.go:461,469', () => {
		it('happy shallow: fetches into tmp ref then promotes to V2_MAIN_REF_NAME', async () => {
			await fetchV2MainTreeOnly('/repo', 'origin');
			const fetchArgs = execaMock.mock.calls[0]![1] as string[];
			// refspec points at refs/story-fetch-tmp/v2-main, not the dest ref
			expect(fetchArgs.join(' ')).toContain('refs/story-fetch-tmp/v2-main');
			expect(fetchArgs.join(' ')).toContain('refs/story/checkpoints/v2/main');
			expect(fetchArgs).toContain('--depth=1');
			// Promote was called with correct tmp / dest / label
			expect(promoteTmpRefSafelyMock).toHaveBeenCalledWith(
				'/repo',
				'refs/story-fetch-tmp/v2-main',
				'refs/story/checkpoints/v2/main',
				'v2 /main',
			);
		});

		it('happy non-shallow: no --depth=1, still tmp-ref + promote', async () => {
			await fetchV2MainRef('/repo', 'origin');
			const fetchArgs = execaMock.mock.calls[0]![1] as string[];
			expect(fetchArgs).not.toContain('--depth=1');
			expect(promoteTmpRefSafelyMock).toHaveBeenCalled();
		});

		it('fetch failure → Error propagates, promote NOT called', async () => {
			execaMock.mockResolvedValue({
				exitCode: 128,
				stdout: '',
				stderr: "fatal: couldn't find remote ref",
				timedOut: false,
			});
			await expect(fetchV2MainTreeOnly('/repo', 'origin')).rejects.toThrow(/fetch/i);
			expect(promoteTmpRefSafelyMock).not.toHaveBeenCalled();
		});

		it('non-default remote name propagates', async () => {
			await fetchV2MainRef('/repo', 'mirror');
			const fetchArgs = execaMock.mock.calls[0]![1] as string[];
			expect(fetchArgs).toContain('mirror');
		});
	});

	describe('fetchV2MetadataFromCheckpointRemote (URL-based)', () => {
		it('happy: fetches v2 /main from URL and promotes tmp ref', async () => {
			await fetchV2MetadataFromCheckpointRemote('/repo', 'https://github.com/o/r.git');
			const fetchArgs = execaMock.mock.calls[0]![1] as string[];
			expect(fetchArgs).toContain('https://github.com/o/r.git');
			expect(fetchArgs.join(' ')).toContain('refs/story/checkpoints/v2/main');
			expect(promoteTmpRefSafelyMock).toHaveBeenCalled();
		});

		it('empty URL → SilentError (no fetch attempted)', async () => {
			await expect(fetchV2MetadataFromCheckpointRemote('/repo', '')).rejects.toThrow(SilentError);
			expect(execaMock).not.toHaveBeenCalled();
		});

		it('fetch failure propagates', async () => {
			execaMock.mockResolvedValue({
				exitCode: 128,
				stdout: '',
				stderr: '404',
				timedOut: false,
			});
			await expect(
				fetchV2MetadataFromCheckpointRemote('/repo', 'https://host/dne.git'),
			).rejects.toThrow();
		});
	});

	describe('fetchMetadataFromCheckpointRemote (URL-based v1)', () => {
		it('happy: fetches v1 metadata from URL', async () => {
			await fetchMetadataFromCheckpointRemote('/repo', 'https://github.com/o/r.git');
			const fetchArgs = execaMock.mock.calls[0]![1] as string[];
			expect(fetchArgs).toContain('https://github.com/o/r.git');
			expect(fetchArgs.join(' ')).toContain('story/checkpoints/v1');
		});

		it('empty URL → SilentError', async () => {
			await expect(fetchMetadataFromCheckpointRemote('/repo', '')).rejects.toThrow(SilentError);
		});

		it('auth failure propagates', async () => {
			execaMock.mockResolvedValue({
				exitCode: 128,
				stdout: '',
				stderr: 'fatal: Authentication failed',
				timedOut: false,
			});
			await expect(
				fetchMetadataFromCheckpointRemote('/repo', 'https://host/r.git'),
			).rejects.toThrow(/auth|fetch/i);
		});
	});

	describe('fetchBlobsByHash — Go: git_operations.go:566', () => {
		it('happy: fetches multiple hashes in one invocation', async () => {
			await fetchBlobsByHash('/repo', 'origin', ['aaaaaaa', 'bbbbbbb']);
			const fetchArgs = execaMock.mock.calls[0]![1] as string[];
			expect(fetchArgs).toContain('aaaaaaa');
			expect(fetchArgs).toContain('bbbbbbb');
			expect(fetchArgs).toContain('--no-write-fetch-head');
		});

		it('empty hash array → no-op (no fetch attempted)', async () => {
			await fetchBlobsByHash('/repo', 'origin', []);
			expect(execaMock).not.toHaveBeenCalled();
		});

		it('fetch failure → falls back to full metadata branch fetch', async () => {
			// First call fails, subsequent fallback succeeds.
			execaMock
				.mockResolvedValueOnce({
					exitCode: 128,
					stdout: '',
					stderr: 'fatal: fetch-by-hash unsupported',
					timedOut: false,
				})
				.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '', timedOut: false });
			await fetchBlobsByHash('/repo', 'origin', ['deadbeef']);
			expect(execaMock.mock.calls.length).toBeGreaterThanOrEqual(2);
		});

		it('with checkpointUrl: failure → tries URL fetch first, then origin fallback', async () => {
			// Call 1: blob fetch (origin) → fails
			// Call 2: checkpoint-remote URL fetch → fails
			// Call 3: metadata-branch fetch (origin) → succeeds
			execaMock
				.mockResolvedValueOnce({ exitCode: 128, stdout: '', stderr: 'fail1', timedOut: false })
				.mockResolvedValueOnce({ exitCode: 128, stdout: '', stderr: 'fail2', timedOut: false })
				.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '', timedOut: false });
			await fetchBlobsByHash('/repo', 'origin', ['deadbeef'], 'https://host/checkpoint.git');
			const urls = execaMock.mock.calls.map((c) =>
				(c[1] as string[]).find((a) => a.startsWith('http')),
			);
			expect(urls).toContain('https://host/checkpoint.git');
		});

		it('with checkpointUrl: URL fetch succeeds → skips origin fallback', async () => {
			execaMock
				.mockResolvedValueOnce({ exitCode: 128, stdout: '', stderr: 'fail', timedOut: false })
				.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '', timedOut: false });
			await fetchBlobsByHash('/repo', 'origin', ['deadbeef'], 'https://host/checkpoint.git');
			// 2 calls: blob-by-hash (failed) + checkpoint-remote (succeeded).
			// No 3rd origin fallback call.
			expect(execaMock.mock.calls.length).toBe(2);
		});
	});

	// Phase 9.4 review B1 — timeout wiring
	describe('runFetchCommand timeout + env + filter integration', () => {
		it('passes timeout: 2 * 60 * 1000 to execa', async () => {
			await fetchMetadataBranch('/repo', 'origin');
			const execaCall = execaMock.mock.calls[0]!;
			const opts = execaCall[2] as { timeout?: number };
			expect(opts.timeout).toBe(2 * 60 * 1000);
		});

		it('timedOut result → specific timeout error', async () => {
			execaMock.mockResolvedValue({
				exitCode: null as unknown as number,
				stdout: '',
				stderr: '',
				timedOut: true,
			});
			await expect(fetchMetadataBranch('/repo', 'origin')).rejects.toThrow(/timed out/i);
		});

		it('passes token env from checkpointGitCommand through to execa', async () => {
			const tokenEnv: NodeJS.ProcessEnv = {
				GIT_CONFIG_COUNT: '1',
				GIT_CONFIG_KEY_0: 'http.extraHeader',
				GIT_CONFIG_VALUE_0: 'Authorization: Basic <b64>',
			};
			checkpointGitCommandMock.mockImplementation(async (_target, args) => ({
				args,
				env: tokenEnv,
			}));
			await fetchMetadataBranch('/repo', 'origin');
			const opts = execaMock.mock.calls[0]![2] as { env?: NodeJS.ProcessEnv };
			expect(opts.env).toEqual(tokenEnv);
		});

		it('appendFetchFilterArgs called for every fetch (Go parity: filter works on non-shallow too)', async () => {
			await fetchMetadataBranch('/repo', 'origin');
			expect(appendFetchFilterArgsMock).toHaveBeenCalled();
		});

		it('resolveFetchTarget resolves remote name (may → URL under filtered_fetches)', async () => {
			resolveFetchTargetMock.mockResolvedValue('https://github.com/o/r.git');
			await fetchMetadataBranch('/repo', 'origin');
			const fetchArgs = execaMock.mock.calls[0]![1] as string[];
			expect(fetchArgs).toContain('https://github.com/o/r.git');
		});
	});

	// Integration-leaning: real validateBranchName callsite (foundation #22)
	describe('foundation #22 — validateBranchName callsite', () => {
		let env: TestEnv;
		beforeEach(async () => {
			env = await TestEnv.create({ initialCommit: true });
			execaMock.mockClear();
			execGitMock.mockClear();
		});
		afterEach(async () => {
			await env.cleanup();
		});

		it('rejects names with embedded refspec chars (validateBranchName path)', async () => {
			vi.spyOn(validation, 'validateBranchName').mockResolvedValue(
				new Error('invalid branch name "..nope"'),
			);
			await expect(fetchAndCheckoutRemoteBranch(env.dir, 'origin', '..nope')).rejects.toThrow(
				SilentError,
			);
			expect(execaMock).not.toHaveBeenCalled();
		});
	});
});
