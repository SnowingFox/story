import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	type CheckpointRemoteConfig,
	getCheckpointRemote,
	getCheckpointRemoteOwner,
	getCommitLinking,
	isCheckpointsV2Enabled,
	isEnabled,
	isFilteredFetchesEnabled,
	isPushSessionsDisabled,
	isPushV2RefsEnabled,
	isSetUp,
	isSetUpAndEnabled,
	isSetUpAny,
	isSummarizeEnabled,
	load,
	loadEnabledSettings,
	loadFromBytes,
	loadFromFile,
	mergeJSON,
	readSettings,
	type StorySettings,
	save,
	saveEnabledState,
	saveLocal,
} from '@/settings/settings';
import { TestEnv } from '../helpers/test-env';

let env: TestEnv;

beforeEach(async () => {
	env = await TestEnv.create();
});

afterEach(async () => {
	await env.cleanup();
});

// ── helpers ──
async function writeSettings(content: string): Promise<void> {
	await env.writeFile('.story/settings.json', content);
}
async function writeLocalSettings(content: string): Promise<void> {
	await env.writeFile('.story/settings.local.json', content);
}

// ─────────────────────────────────────────────────────────────────────
// settings_test.go #1-7: Load + LoadFromFile + 基本校验
// ─────────────────────────────────────────────────────────────────────
describe('Load + 基本校验', () => {
	it('#1 rejects unknown JSON keys', async () => {
		await writeSettings(JSON.stringify({ enabled: true, unknown_key: 'oops' }));
		await expect(load(env.dir)).rejects.toThrow();
	});

	it('#2 accepts all valid keys', async () => {
		const all = {
			enabled: true,
			local_dev: false,
			log_level: 'info',
			strategy_options: { push_sessions: true, checkpoints_v2: false },
			absolute_git_hook_path: false,
			telemetry: true,
			redaction: { pii: { enabled: true } },
			commit_linking: 'prompt',
			external_agents: false,
		};
		await writeSettings(JSON.stringify(all));
		const s = await load(env.dir);
		expect(s.enabled).toBe(true);
		expect(s.log_level).toBe('info');
		expect(s.strategy_options?.push_sessions).toBe(true);
		expect(s.external_agents).toBe(false);
		expect(s.commit_linking).toBe('prompt');
	});

	it('#3 local settings also reject unknown keys', async () => {
		await writeSettings(JSON.stringify({ enabled: true }));
		await writeLocalSettings(JSON.stringify({ bad_key: 'nope' }));
		await expect(load(env.dir)).rejects.toThrow();
	});

	it('#4 missing redaction stays unset after load', async () => {
		await writeSettings(JSON.stringify({ enabled: true }));
		const s = await load(env.dir);
		expect(s.redaction).toBeUndefined();
	});

	// Go parity: settings.go: mergeRedaction + mergePIISettings (lines 268-372)
	// — only sub-fields present in the override are applied; missing fields
	// preserve the base value. Earlier TS version did `base.redaction = raw.redaction`
	// which silently dropped inherited PII patterns when local override only set
	// part of the tree → privacy regression. Fixed in B1.
	it('#5 local overrides redaction.pii.enabled but preserves base custom_patterns', async () => {
		await writeSettings(
			JSON.stringify({
				enabled: true,
				redaction: {
					pii: {
						enabled: true,
						email: true,
						custom_patterns: { creditcard: '\\d{16}', ssn: '\\d{3}-\\d{2}-\\d{4}' },
					},
				},
			}),
		);
		await writeLocalSettings(
			JSON.stringify({
				redaction: { pii: { enabled: false } },
			}),
		);
		const s = await load(env.dir);
		const pii = (s.redaction as { pii: Record<string, unknown> }).pii;
		// Local override applied
		expect(pii.enabled).toBe(false);
		// Base values preserved
		expect(pii.email).toBe(true);
		expect(pii.custom_patterns).toEqual({
			creditcard: '\\d{16}',
			ssn: '\\d{3}-\\d{2}-\\d{4}',
		});
	});

	it('#6 local merges custom_patterns key-by-key (not replace)', async () => {
		await writeSettings(
			JSON.stringify({
				enabled: true,
				redaction: {
					pii: {
						enabled: true,
						custom_patterns: { creditcard: '\\d{16}', ssn: '\\d{3}-\\d{2}-\\d{4}' },
					},
				},
			}),
		);
		await writeLocalSettings(
			JSON.stringify({
				redaction: {
					pii: {
						// override existing key + add new one; ssn should be preserved
						custom_patterns: { creditcard: '\\d{19}', new_pattern: 'foo' },
					},
				},
			}),
		);
		const s = await load(env.dir);
		const pii = (s.redaction as { pii: Record<string, unknown> }).pii;
		expect(pii.custom_patterns).toEqual({
			creditcard: '\\d{19}', // overridden
			ssn: '\\d{3}-\\d{2}-\\d{4}', // preserved from base
			new_pattern: 'foo', // added
		});
	});

	it('#6b rejects local redaction with wrong field types (Go parity)', async () => {
		await writeSettings(JSON.stringify({ enabled: true }));
		await writeLocalSettings(JSON.stringify({ redaction: { pii: { enabled: 'not a bool' } } }));
		await expect(load(env.dir)).rejects.toThrow(/parsing pii\.enabled/);
	});

	it('#7 accepts deprecated strategy field', async () => {
		await writeSettings(JSON.stringify({ enabled: true, strategy: 'auto-commit' }));
		const s = await load(env.dir);
		expect(s.strategy).toBe('auto-commit');
		expect(s.enabled).toBe(true);
	});

	// D.1: telemetry is *bool in Go — local override unmarshals into bool
	// (rejects null). Earlier TS allowed null on local; aligning with Go now.
	//
	// Go reference: settings.go:259-266 telemetry unmarshal into bool.
	it('#7a mergeJSON rejects telemetry: null in local override (Go parity)', async () => {
		await writeSettings(JSON.stringify({ enabled: true, telemetry: true }));
		await writeLocalSettings(JSON.stringify({ telemetry: null }));
		await expect(load(env.dir)).rejects.toThrow(/telemetry/);
	});

	// D.2: deprecated `strategy` field — Go's mergeJSON has NO branch for it,
	// so local override of strategy is ignored. Earlier TS applied it; aligning.
	//
	// Go reference: settings.go:206-301 (no `strategy` switch case in mergeJSON).
	it('#7b local override of deprecated strategy is ignored (Go parity)', async () => {
		await writeSettings(JSON.stringify({ enabled: true, strategy: 'auto-commit' }));
		await writeLocalSettings(JSON.stringify({ strategy: 'manual-commit' }));
		const s = await load(env.dir);
		// Local override of `strategy` is ignored; base value preserved.
		expect(s.strategy).toBe('auto-commit');
	});

	// D.3: per-field type validation. Earlier TS used `as boolean` cast which
	// silently coerced wrong types (e.g. `{ enabled: 1 }` → enabled=1 in
	// runtime state); Go json.Unmarshal rejects with parse error. Aligning.
	//
	// Go reference: settings.go:207-213 enabled unmarshal into bool.
	it('#7c mergeJSON rejects wrong-type values in local override', async () => {
		await writeSettings(JSON.stringify({ enabled: true }));
		// Number for boolean field
		await writeLocalSettings(JSON.stringify({ enabled: 1 }));
		await expect(load(env.dir)).rejects.toThrow(/enabled.*must be a boolean/);
	});

	it('#7d mergeJSON rejects wrong-type strategy_options', async () => {
		await writeSettings(JSON.stringify({ enabled: true }));
		// String where object is required
		await writeLocalSettings(JSON.stringify({ strategy_options: 'not an object' }));
		await expect(load(env.dir)).rejects.toThrow(/strategy_options.*must be an object/);
	});
});

// ─────────────────────────────────────────────────────────────────────
// #8-11: commitLinking
// ─────────────────────────────────────────────────────────────────────
describe('commitLinking', () => {
	it('#8 getCommitLinking defaults to "prompt"', () => {
		const s: StorySettings = { enabled: true };
		expect(getCommitLinking(s)).toBe('prompt');
	});

	it('#9 getCommitLinking returns explicit value', () => {
		expect(getCommitLinking({ enabled: true, commit_linking: 'always' })).toBe('always');
		expect(getCommitLinking({ enabled: true, commit_linking: 'prompt' })).toBe('prompt');
	});

	it('#10 loads commit_linking from file', async () => {
		await writeSettings(JSON.stringify({ enabled: true, commit_linking: 'always' }));
		const s = await load(env.dir);
		expect(s.commit_linking).toBe('always');
	});

	it('#11 local overrides commit_linking', async () => {
		await writeSettings(JSON.stringify({ enabled: true }));
		await writeLocalSettings(JSON.stringify({ commit_linking: 'always' }));
		const s = await load(env.dir);
		expect(s.commit_linking).toBe('always');
	});
});

// ─────────────────────────────────────────────────────────────────────
// #12-14: externalAgents
// ─────────────────────────────────────────────────────────────────────
describe('externalAgents', () => {
	it('#12 externalAgents defaults to false (or undefined)', async () => {
		await writeSettings(JSON.stringify({ enabled: true }));
		const s = await load(env.dir);
		expect(s.external_agents ?? false).toBe(false);
	});

	it('#13 loads external_agents from file', async () => {
		await writeSettings(JSON.stringify({ enabled: true, external_agents: true }));
		const s = await load(env.dir);
		expect(s.external_agents).toBe(true);
	});

	it('#14 local overrides external_agents', async () => {
		await writeSettings(JSON.stringify({ enabled: true }));
		await writeLocalSettings(JSON.stringify({ external_agents: true }));
		const s = await load(env.dir);
		expect(s.external_agents).toBe(true);
	});
});

// ─────────────────────────────────────────────────────────────────────
// #15-21: isCheckpointsV2Enabled
// ─────────────────────────────────────────────────────────────────────
describe('isCheckpointsV2Enabled', () => {
	it('#15 defaults false (no strategy_options)', () => {
		expect(isCheckpointsV2Enabled({ enabled: true })).toBe(false);
	});

	it('#16 false with empty strategy_options', () => {
		expect(isCheckpointsV2Enabled({ enabled: true, strategy_options: {} })).toBe(false);
	});

	it('#17 true', () => {
		expect(
			isCheckpointsV2Enabled({ enabled: true, strategy_options: { checkpoints_v2: true } }),
		).toBe(true);
	});

	it('#18 explicitly false', () => {
		expect(
			isCheckpointsV2Enabled({ enabled: true, strategy_options: { checkpoints_v2: false } }),
		).toBe(false);
	});

	it('#19 rejects non-bool value "yes"', () => {
		expect(
			isCheckpointsV2Enabled({ enabled: true, strategy_options: { checkpoints_v2: 'yes' } }),
		).toBe(false);
	});

	it('#20 loads from file', async () => {
		await writeSettings(
			JSON.stringify({ enabled: true, strategy_options: { checkpoints_v2: true } }),
		);
		const s = await load(env.dir);
		expect(isCheckpointsV2Enabled(s)).toBe(true);
	});

	it('#21 local override (deep merge into strategy_options)', async () => {
		await writeSettings(
			JSON.stringify({ enabled: true, strategy_options: { push_sessions: true } }),
		);
		await writeLocalSettings(JSON.stringify({ strategy_options: { checkpoints_v2: true } }));
		const s = await load(env.dir);
		expect(isCheckpointsV2Enabled(s)).toBe(true);
		// 验证深合并：原 push_sessions 仍在
		expect(s.strategy_options?.push_sessions).toBe(true);
	});
});

// ─────────────────────────────────────────────────────────────────────
// #22-26: isPushV2RefsEnabled / isFilteredFetchesEnabled
// ─────────────────────────────────────────────────────────────────────
describe('isPushV2RefsEnabled', () => {
	it('#22 defaults false', () => {
		expect(isPushV2RefsEnabled({ enabled: true })).toBe(false);
	});

	it.each([
		{ name: 'both true', opts: { checkpoints_v2: true, push_v2_refs: true }, expected: true },
		{ name: 'only checkpoints_v2', opts: { checkpoints_v2: true }, expected: false },
		{ name: 'only push_v2_refs', opts: { push_v2_refs: true }, expected: false },
		{
			name: 'both false',
			opts: { checkpoints_v2: false, push_v2_refs: false },
			expected: false,
		},
		{
			name: 'checkpoints_v2 false + push_v2_refs true',
			opts: { checkpoints_v2: false, push_v2_refs: true },
			expected: false,
		},
		{
			name: 'checkpoints_v2 true + push_v2_refs false',
			opts: { checkpoints_v2: true, push_v2_refs: false },
			expected: false,
		},
	])('#23 requires both flags: $name → $expected', ({ opts, expected }) => {
		expect(isPushV2RefsEnabled({ enabled: true, strategy_options: opts })).toBe(expected);
	});
});

describe('isFilteredFetchesEnabled', () => {
	it('#24 defaults false', () => {
		expect(isFilteredFetchesEnabled({ enabled: true })).toBe(false);
	});

	it('#25 true', () => {
		expect(
			isFilteredFetchesEnabled({ enabled: true, strategy_options: { filtered_fetches: true } }),
		).toBe(true);
	});

	it('#26 rejects non-bool', () => {
		expect(
			isFilteredFetchesEnabled({ enabled: true, strategy_options: { filtered_fetches: 'yes' } }),
		).toBe(false);
	});
});

// ─────────────────────────────────────────────────────────────────────
// settings_checkpoint_remote_test.go #1-11
// ─────────────────────────────────────────────────────────────────────
describe('getCheckpointRemote', () => {
	it('#1 returns null when not configured', () => {
		expect(getCheckpointRemote({ enabled: true })).toBeNull();
	});

	it('#2 null with empty strategy_options', () => {
		expect(getCheckpointRemote({ enabled: true, strategy_options: {} })).toBeNull();
	});

	it('#3 parses structured github config', () => {
		const result = getCheckpointRemote({
			enabled: true,
			strategy_options: {
				checkpoint_remote: { provider: 'github', repo: 'org/checkpoints' },
			},
		});
		expect(result).toEqual({ provider: 'github', repo: 'org/checkpoints' });
	});

	it('parses explicit gitUrl config without provider/repo', () => {
		const result = getCheckpointRemote({
			enabled: true,
			strategy_options: {
				checkpoint_remote: { gitUrl: 'git@gitlab.com:acme/story.git' },
			},
		});
		expect(result).toEqual({ gitUrl: 'git@gitlab.com:acme/story.git' });
	});

	it('preserves gitUrl alongside provider/repo when both are configured', () => {
		const result = getCheckpointRemote({
			enabled: true,
			strategy_options: {
				checkpoint_remote: {
					gitUrl: 'git@gitlab.com:acme/story.git',
					provider: 'github',
					repo: 'org/checkpoints',
				},
			},
		});
		expect(result).toEqual({
			gitUrl: 'git@gitlab.com:acme/story.git',
			provider: 'github',
			repo: 'org/checkpoints',
		});
	});

	it('#4 null for missing provider', () => {
		expect(
			getCheckpointRemote({
				enabled: true,
				strategy_options: { checkpoint_remote: { repo: 'org/checkpoints' } },
			}),
		).toBeNull();
	});

	it('#5 null for missing repo', () => {
		expect(
			getCheckpointRemote({
				enabled: true,
				strategy_options: { checkpoint_remote: { provider: 'github' } },
			}),
		).toBeNull();
	});

	it('#6 null for repo without slash', () => {
		expect(
			getCheckpointRemote({
				enabled: true,
				strategy_options: {
					checkpoint_remote: { provider: 'github', repo: 'just-a-name' },
				},
			}),
		).toBeNull();
	});

	it('returns null for empty gitUrl without valid provider/repo fallback', () => {
		expect(
			getCheckpointRemote({
				enabled: true,
				strategy_options: { checkpoint_remote: { gitUrl: '' } },
			}),
		).toBeNull();
	});

	it('returns null for non-string gitUrl without valid provider/repo fallback', () => {
		expect(
			getCheckpointRemote({
				enabled: true,
				strategy_options: { checkpoint_remote: { gitUrl: 42 } },
			}),
		).toBeNull();
	});

	it('#7 ignores legacy string format', () => {
		expect(
			getCheckpointRemote({
				enabled: true,
				strategy_options: { checkpoint_remote: 'git@github.com:org/repo.git' },
			}),
		).toBeNull();
	});

	it('#8 null for wrong type (number)', () => {
		expect(
			getCheckpointRemote({ enabled: true, strategy_options: { checkpoint_remote: 42 } }),
		).toBeNull();
	});

	it('#9 survives JSON roundtrip', async () => {
		const settings: StorySettings = {
			enabled: true,
			strategy_options: {
				checkpoint_remote: { provider: 'github', repo: 'org/checkpoints' },
			},
		};
		await save(env.dir, settings);
		const loaded = await load(env.dir);
		expect(getCheckpointRemote(loaded)).toEqual({
			provider: 'github',
			repo: 'org/checkpoints',
		});
	});

	it('survives JSON roundtrip with gitUrl', async () => {
		const settings: StorySettings = {
			enabled: true,
			strategy_options: {
				checkpoint_remote: { gitUrl: 'git@gitlab.com:acme/story.git' },
			},
		};
		await save(env.dir, settings);
		const loaded = await load(env.dir);
		expect(getCheckpointRemote(loaded)).toEqual({
			gitUrl: 'git@gitlab.com:acme/story.git',
		});
	});

	it('#10 coexists with push_sessions', () => {
		const s: StorySettings = {
			enabled: true,
			strategy_options: {
				push_sessions: true,
				checkpoint_remote: { provider: 'github', repo: 'org/repo' },
			},
		};
		expect(getCheckpointRemote(s)).toEqual({ provider: 'github', repo: 'org/repo' });
		expect(isPushSessionsDisabled(s)).toBe(false);
	});

	it.each([
		{ repo: 'org/repo', expected: 'org' },
		{ repo: 'org/sub/repo', expected: 'org' },
		{ repo: 'no-slash', expected: '' },
	])('#11 owner() extracts owner: $repo → "$expected"', ({ repo, expected }) => {
		const config: CheckpointRemoteConfig = { provider: 'github', repo };
		expect(getCheckpointRemoteOwner(config)).toBe(expected);
	});
});

// ─────────────────────────────────────────────────────────────────────
// TS 扩展场景 #27-35
// ─────────────────────────────────────────────────────────────────────
describe('readSettings (TS 扩展)', () => {
	it('#27 entry-point smoke: equivalent to load()', async () => {
		await writeSettings(JSON.stringify({ enabled: true, log_level: 'debug' }));
		const a = await readSettings(env.dir);
		const b = await load(env.dir);
		expect(a).toEqual(b);
	});
});

describe('isSetUp / isSetUpAny / isSetUpAndEnabled (TS 扩展)', () => {
	it('#28 isSetUp: true when settings.json exists, false otherwise', async () => {
		expect(await isSetUp(env.dir)).toBe(false);
		await writeSettings('{"enabled": true}');
		expect(await isSetUp(env.dir)).toBe(true);
	});

	it('#29 isSetUpAny detects local-only setup', async () => {
		expect(await isSetUpAny(env.dir)).toBe(false);
		await writeLocalSettings('{"enabled": true}');
		expect(await isSetUpAny(env.dir)).toBe(true);
		expect(await isSetUp(env.dir)).toBe(false); // 仅 local，main 没设
	});

	it('#30 isSetUpAndEnabled: false when disabled, true when enabled, false on load failure', async () => {
		expect(await isSetUpAndEnabled(env.dir)).toBe(false); // not set up
		await writeSettings(JSON.stringify({ enabled: false }));
		expect(await isSetUpAndEnabled(env.dir)).toBe(false);
		await writeSettings(JSON.stringify({ enabled: true }));
		expect(await isSetUpAndEnabled(env.dir)).toBe(true);
		// 加载失败 → false
		await writeSettings('{ malformed json');
		expect(await isSetUpAndEnabled(env.dir)).toBe(false);
	});

	// Decision: `isSetUpAndEnabled` + `loadEnabledSettings` are intentionally
	// kept as two separate exports.
	//
	// - `isSetUpAndEnabled(repoRoot) → boolean` — cheap boolean gate for
	//   callers that only need yes/no (doctor, docs, CLI flag gates).
	// - `loadEnabledSettings(repoRoot) → StorySettings | null` — combined
	//   gate+loader for hook entry points that need the parsed settings
	//   (e.g. to feed `log_level` into `log.init`). Avoids reading
	//   `settings.json` twice (see `settings.ts:462-471`).
	//
	// `isSetUpAndEnabled` is implemented as a thin wrapper over
	// `loadEnabledSettings` so the two never drift; the cases below
	// mirror the `isSetUpAndEnabled` matrix (#30) plus the "returns the
	// actual settings" happy-path assertion that the boolean wrapper
	// cannot express.
	it('#30a loadEnabledSettings: null when not set up, null when disabled, settings object when enabled, null on load failure', async () => {
		expect(await loadEnabledSettings(env.dir)).toBeNull(); // not set up

		await writeSettings(JSON.stringify({ enabled: false }));
		expect(await loadEnabledSettings(env.dir)).toBeNull();

		await writeSettings(JSON.stringify({ enabled: true, log_level: 'debug' }));
		const s = await loadEnabledSettings(env.dir);
		expect(s).not.toBeNull();
		expect(s?.enabled).toBe(true);
		expect(s?.log_level).toBe('debug'); // proves caller can read parsed fields

		// 加载失败 (malformed JSON) → null, same fail-closed semantics as
		// `isSetUpAndEnabled` (see TS-divergence note in `hook-registry.ts:192-213`).
		await writeSettings('{ malformed json');
		expect(await loadEnabledSettings(env.dir)).toBeNull();
	});

	it('#30b isSetUpAndEnabled ↔ loadEnabledSettings parity (wrapper never drifts)', async () => {
		// not set up
		expect(await isSetUpAndEnabled(env.dir)).toBe((await loadEnabledSettings(env.dir)) !== null);

		// disabled
		await writeSettings(JSON.stringify({ enabled: false }));
		expect(await isSetUpAndEnabled(env.dir)).toBe((await loadEnabledSettings(env.dir)) !== null);

		// enabled
		await writeSettings(JSON.stringify({ enabled: true }));
		expect(await isSetUpAndEnabled(env.dir)).toBe((await loadEnabledSettings(env.dir)) !== null);

		// malformed
		await writeSettings('{ malformed');
		expect(await isSetUpAndEnabled(env.dir)).toBe((await loadEnabledSettings(env.dir)) !== null);
	});
});

describe('isPushSessionsDisabled (TS 扩展)', () => {
	it('#31 distinguishes "missing" from "false"', () => {
		// 无 strategy_options
		expect(isPushSessionsDisabled({ enabled: true })).toBe(false);
		// strategy_options 没 push_sessions
		expect(isPushSessionsDisabled({ enabled: true, strategy_options: {} })).toBe(false);
		// push_sessions: true
		expect(
			isPushSessionsDisabled({ enabled: true, strategy_options: { push_sessions: true } }),
		).toBe(false);
		// push_sessions: false → disabled
		expect(
			isPushSessionsDisabled({ enabled: true, strategy_options: { push_sessions: false } }),
		).toBe(true);
		// "yes" 字符串 → 非 bool → false
		expect(
			isPushSessionsDisabled({ enabled: true, strategy_options: { push_sessions: 'yes' } }),
		).toBe(false);
	});
});

describe('mergeJSON edge cases (TS 扩展)', () => {
	it('#32 enabled=false in local overrides true in base', () => {
		const base: StorySettings = { enabled: true };
		mergeJSON(base, JSON.stringify({ enabled: false }));
		expect(base.enabled).toBe(false);
	});

	it('#33 log_level empty string does not override', () => {
		const base: StorySettings = { enabled: true, log_level: 'info' };
		mergeJSON(base, JSON.stringify({ log_level: '' }));
		expect(base.log_level).toBe('info'); // 不被覆盖
	});
});

describe('save() (TS 扩展)', () => {
	it('#34 creates .story dir if missing', async () => {
		// env.dir 是新建的 temp dir，没有 .story 目录
		await save(env.dir, { enabled: true });
		const dirStat = await stat(path.join(env.dir, '.story'));
		expect(dirStat.isDirectory()).toBe(true);
	});

	it('#35 writes 2-space indent + trailing newline', async () => {
		await save(env.dir, { enabled: true, log_level: 'debug' });
		const raw = await readFile(path.join(env.dir, '.story', 'settings.json'), 'utf-8');
		// 必须有尾换行
		expect(raw.endsWith('\n')).toBe(true);
		// 必须是 2 空格缩进
		expect(raw).toContain('\n  ');
		// 字节级验证：与手动 stringify 一致
		expect(raw).toBe(`${JSON.stringify({ enabled: true, log_level: 'debug' }, null, 2)}\n`);
	});
});

// ─────────────────────────────────────────────────────────────────────
// 单元覆盖：loadFromBytes / loadFromFile / saveLocal / isSummarizeEnabled
// (这些是 impl 函数，被上面的测试间接覆盖；这里加薄壳测试拉满 coverage)
// ─────────────────────────────────────────────────────────────────────
describe('loadFromBytes / loadFromFile / saveLocal / isSummarizeEnabled (覆盖率)', () => {
	it('loadFromBytes parses valid JSON', () => {
		const s = loadFromBytes('{"enabled": true, "log_level": "warn"}');
		expect(s.enabled).toBe(true);
		expect(s.log_level).toBe('warn');
	});

	it('loadFromBytes rejects unknown keys', () => {
		expect(() => loadFromBytes('{"enabled": true, "nope": 1}')).toThrow();
	});

	it('loadFromFile returns defaults when file missing', async () => {
		const missingPath = path.join(env.dir, '.story', 'does-not-exist.json');
		const s = await loadFromFile(missingPath);
		expect(s.enabled).toBe(true);
	});

	it('saveLocal writes settings.local.json', async () => {
		await saveLocal(env.dir, { enabled: true, log_level: 'debug' });
		const raw = await readFile(path.join(env.dir, '.story', 'settings.local.json'), 'utf-8');
		expect(raw).toContain('"log_level": "debug"');
	});

	it('isSummarizeEnabled false by default', () => {
		expect(isSummarizeEnabled({ enabled: true })).toBe(false);
		expect(isSummarizeEnabled({ enabled: true, strategy_options: {} })).toBe(false);
		expect(isSummarizeEnabled({ enabled: true, strategy_options: { summarize: 'oops' } })).toBe(
			false,
		);
	});

	it('isSummarizeEnabled true when explicitly set', () => {
		expect(
			isSummarizeEnabled({
				enabled: true,
				strategy_options: { summarize: { enabled: true } },
			}),
		).toBe(true);
	});

	it('isSummarizeEnabled false when nested enabled is not strict true', () => {
		expect(
			isSummarizeEnabled({
				enabled: true,
				strategy_options: { summarize: { enabled: 'yes' } },
			}),
		).toBe(false);
	});

	it('getCheckpointRemote: empty provider returns null', () => {
		expect(
			getCheckpointRemote({
				enabled: true,
				strategy_options: {
					checkpoint_remote: { provider: '', repo: 'org/repo' },
				},
			}),
		).toBeNull();
	});

	it('getCheckpointRemote: empty repo returns null', () => {
		expect(
			getCheckpointRemote({
				enabled: true,
				strategy_options: {
					checkpoint_remote: { provider: 'github', repo: '' },
				},
			}),
		).toBeNull();
	});

	it('isSetUpAny: returns true via main settings.json (short-circuit)', async () => {
		// 走 isSetUp → true 短路分支（覆盖 L300-301）
		await writeSettings('{"enabled": true}');
		expect(await isSetUpAny(env.dir)).toBe(true);
	});

	it('loadFromFile rethrows non-ENOENT errors', async () => {
		// 传一个目录路径给 readFile → 抛 EISDIR 而不是 ENOENT，应该 rethrow
		// 覆盖 src/settings/settings.ts readFileOrNull 的 throw 分支
		await expect(loadFromFile(env.dir)).rejects.toThrow();
	});
});

// ─────────────────────────────────────────────────────────────────────
// Phase 9.1: isEnabled + saveEnabledState
// Go: setup.go: IsEnabled + saveEnabledState
// ─────────────────────────────────────────────────────────────────────
describe('isEnabled + saveEnabledState (Phase 9.1)', () => {
	// Go: config.go: IsEnabled
	it('isEnabled returns true when settings.json has enabled:true', async () => {
		await writeSettings(JSON.stringify({ enabled: true }));
		expect(await isEnabled(env.dir)).toBe(true);
	});

	// Go: config.go: IsEnabled (TS divergence: default false on load failure;
	// Go defaults true. See settings.ts JSDoc for rationale.)
	it('isEnabled returns false when not set up (no settings file)', async () => {
		// No settings files at all — Story returns false (Go returns true).
		expect(await isEnabled(env.dir)).toBe(false);
	});

	// Go: setup.go: saveEnabledState — project + local sync path
	it('saveEnabledState with useProjectSettings=true rewrites both files when local exists', async () => {
		// Seed both files with "enabled: true"
		await writeSettings(JSON.stringify({ enabled: true }));
		await writeLocalSettings(JSON.stringify({ enabled: true }));

		// Flip to disabled via project scope — both files must pick it up
		await saveEnabledState(env.dir, { enabled: false }, true);

		const projectRaw = await readFile(path.join(env.dir, '.story', 'settings.json'), 'utf-8');
		const localRaw = await readFile(path.join(env.dir, '.story', 'settings.local.json'), 'utf-8');
		expect(JSON.parse(projectRaw).enabled).toBe(false);
		expect(JSON.parse(localRaw).enabled).toBe(false);
	});

	it('saveEnabledState with useProjectSettings=false only writes local', async () => {
		await writeSettings(JSON.stringify({ enabled: true }));
		// No local yet
		await saveEnabledState(env.dir, { enabled: false }, false);

		const projectRaw = await readFile(path.join(env.dir, '.story', 'settings.json'), 'utf-8');
		const localRaw = await readFile(path.join(env.dir, '.story', 'settings.local.json'), 'utf-8');
		// Project untouched, local has new state
		expect(JSON.parse(projectRaw).enabled).toBe(true);
		expect(JSON.parse(localRaw).enabled).toBe(false);
	});
});
