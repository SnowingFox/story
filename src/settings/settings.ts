import { lstat, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { getStoryFilePath, storyDir } from '@/paths';

export const SETTINGS_FILE = 'settings.json';
export const LOCAL_SETTINGS_FILE = 'settings.local.json';

export const commitLinkingSchema = z.enum(['always', 'prompt']);

export const storySettingsSchema = z
	.object({
		/** Whether Story is active. When false, hooks exit silently. */
		enabled: z.boolean().default(true),
		/** Development mode — use source instead of built binary. */
		local_dev: z.boolean().optional(),
		/** Log verbosity. Can be overridden by ENTIRE_LOG_LEVEL env var. */
		log_level: z.enum(['debug', 'info', 'warn', 'error']).optional(),
		/** Strategy-specific config (push_sessions, checkpoint_remote, checkpoints_v2, etc.) */
		strategy_options: z.record(z.string(), z.unknown()).optional(),
		/** Embed full binary path in git hooks. For GUI git clients (Xcode, Tower). */
		absolute_git_hook_path: z.boolean().optional(),
		/**
		 * Telemetry opt-in (3-state: undefined = not asked, true = opted in, false = opted out).
		 * [skip] Phase 1 does not implement telemetry business logic; field is preserved for forward compatibility.
		 */
		telemetry: z.boolean().nullable().optional(),
		/**
		 * PII redaction config; preserved as-is.
		 * [skip] Phase 1 does not implement redaction logic — see foundation-backlog.md item 12 (Phase 4.3).
		 */
		redaction: z.unknown().optional(),
		/** How commits are linked to sessions. "prompt" = ask, "always" = auto. */
		commit_linking: commitLinkingSchema.optional(),
		/** Enable discovery of external agent plugins (story-agent-* on $PATH). */
		external_agents: z.boolean().optional(),
		/** @deprecated Tolerated for old config files, ignored at runtime. */
		strategy: z.string().optional(),
	})
	.strict();

export type StorySettings = z.infer<typeof storySettingsSchema>;

export const checkpointRemoteSchema = z
	.object({
		provider: z.string().optional(),
		repo: z.string().optional(),
		gitUrl: z.string().optional(),
	})
	.refine(
		(v) =>
			(v.gitUrl !== undefined && v.gitUrl !== '') ||
			(v.provider !== undefined &&
				v.provider !== '' &&
				v.repo !== undefined &&
				v.repo !== '' &&
				v.repo.includes('/')),
		{ message: 'checkpoint_remote requires gitUrl or provider+repo' },
	);

export type CheckpointRemoteConfig = z.infer<typeof checkpointRemoteSchema>;

const KNOWN_KEYS = new Set([
	'enabled',
	'local_dev',
	'log_level',
	'strategy_options',
	'absolute_git_hook_path',
	'telemetry',
	'redaction',
	'commit_linking',
	'external_agents',
	'strategy',
]);

/** Load + merge `.story/settings.json` and `.story/settings.local.json`. Returns defaults if both missing. */
export async function load(repoRoot: string): Promise<StorySettings> {
	const settingsPath = getStoryFilePath(repoRoot, SETTINGS_FILE);
	const localPath = getStoryFilePath(repoRoot, LOCAL_SETTINGS_FILE);

	const base = await loadFromFile(settingsPath);
	const localData = await readFileOrNull(localPath);
	if (localData !== null) {
		mergeJSON(base, localData);
	}
	return base;
}

/** Recommended public entry-point; semantic alias of {@link load}. */
export async function readSettings(repoRoot: string): Promise<StorySettings> {
	return load(repoRoot);
}

/** Load and validate settings from a single file path. Returns defaults if the file does not exist. */
export async function loadFromFile(filePath: string): Promise<StorySettings> {
	const data = await readFileOrNull(filePath);
	if (data === null) {
		return { enabled: true };
	}
	return loadFromBytes(data);
}

/** Parse and validate a JSON string into settings (strict mode rejects unknown keys). */
export function loadFromBytes(data: string): StorySettings {
	const raw = JSON.parse(data) as unknown;
	return storySettingsSchema.parse(raw);
}

/**
 * Field-level deep merge of `redaction.pii.*` overrides — matches Go's
 * `mergeRedaction` + `mergePIISettings` (`settings.go:268-372`). An earlier
 * version of `mergeJSON` did `base.redaction = raw.redaction` (whole-subtree
 * replace), which would silently drop inherited PII patterns when the user's
 * `settings.local.json` only set `pii.enabled` — a privacy regression.
 *
 * Schema is intentionally `unknown` for now (Phase 4.3 owns the typed schema);
 * these helpers walk plain JSON objects with per-field type validation, throw
 * on wrong types (matching Go's per-field `json.Unmarshal` errors).
 */
function mergeRedaction(base: Record<string, unknown>, override: Record<string, unknown>): void {
	if ('pii' in override) {
		const piiOverride = override.pii;
		if (typeof piiOverride !== 'object' || piiOverride === null || Array.isArray(piiOverride)) {
			throw new Error('parsing redaction.pii: must be an object');
		}
		const existing = base.pii;
		if (typeof existing !== 'object' || existing === null || Array.isArray(existing)) {
			base.pii = {};
		}
		mergePIISettings(base.pii as Record<string, unknown>, piiOverride as Record<string, unknown>);
	}
}

function mergePIISettings(base: Record<string, unknown>, override: Record<string, unknown>): void {
	const boolField = (key: string): void => {
		if (key in override) {
			const v = override[key];
			if (typeof v !== 'boolean') {
				throw new Error(`parsing pii.${key}: must be a boolean`);
			}
			base[key] = v;
		}
	};
	boolField('enabled');
	boolField('email');
	boolField('phone');
	boolField('address');

	if ('custom_patterns' in override) {
		const cp = override.custom_patterns;
		if (typeof cp !== 'object' || cp === null || Array.isArray(cp)) {
			throw new Error('parsing pii.custom_patterns: must be an object');
		}
		const existing = base.custom_patterns;
		if (typeof existing !== 'object' || existing === null || Array.isArray(existing)) {
			base.custom_patterns = {};
		}
		const dst = base.custom_patterns as Record<string, unknown>;
		for (const [k, v] of Object.entries(cp as Record<string, unknown>)) {
			if (typeof v !== 'string') {
				throw new Error(`parsing pii.custom_patterns[${k}]: must be a string`);
			}
			dst[k] = v;
		}
	}
}

/**
 * Merge a JSON string of overrides into `base` in-place.
 *
 * Field-level semantics (matching Go `settings.go:191-304 mergeJSON`):
 * - `enabled` / `local_dev` / `absolute_git_hook_path` / `external_agents`: overwrite if present (even if `false`)
 * - `log_level`: overwrite only if non-empty string
 * - `strategy_options`: key-level merge into existing map (not wholesale replace)
 * - `telemetry`: overwrite if present
 * - `redaction`: **field-level deep merge** via {@link mergeRedaction}; only
 *   sub-fields present in the override are applied, others preserved from base
 * - `commit_linking`: validate and overwrite if non-empty
 * - Unknown top-level keys throw `Error`
 */
export function mergeJSON(base: StorySettings, localData: string): void {
	const raw = JSON.parse(localData) as Record<string, unknown>;

	// Strict-mode unknown-key rejection (matches Go DisallowUnknownFields).
	for (const key of Object.keys(raw)) {
		if (!KNOWN_KEYS.has(key)) {
			throw new Error(`unknown field "${key}" in settings`);
		}
	}

	// Per-field type validation matching Go's per-field json.Unmarshal — a
	// loose `as boolean` cast leaves bad runtime state (e.g. `{ enabled: 1 }`
	// would be silently coerced); Go errors out, TS now does too. (D.3)
	const requireBool = (key: string): boolean => {
		const v = raw[key];
		if (typeof v !== 'boolean') {
			throw new Error(`parsing ${key} field: must be a boolean (got ${typeof v})`);
		}
		return v;
	};
	const requireString = (key: string): string => {
		const v = raw[key];
		if (typeof v !== 'string') {
			throw new Error(`parsing ${key} field: must be a string (got ${typeof v})`);
		}
		return v;
	};

	if (Object.hasOwn(raw, 'enabled')) {
		base.enabled = requireBool('enabled');
	}
	if (Object.hasOwn(raw, 'local_dev')) {
		base.local_dev = requireBool('local_dev');
	}
	if (Object.hasOwn(raw, 'absolute_git_hook_path')) {
		base.absolute_git_hook_path = requireBool('absolute_git_hook_path');
	}
	if (Object.hasOwn(raw, 'log_level')) {
		const ll = requireString('log_level');
		if (ll !== '') {
			base.log_level = ll as StorySettings['log_level'];
		}
	}
	if (Object.hasOwn(raw, 'strategy_options')) {
		const opts = raw.strategy_options;
		if (typeof opts !== 'object' || opts === null || Array.isArray(opts)) {
			throw new Error('parsing strategy_options field: must be an object');
		}
		const optsObj = opts as Record<string, unknown>;
		if (base.strategy_options == null) {
			base.strategy_options = { ...optsObj };
		} else {
			for (const [k, v] of Object.entries(optsObj)) {
				base.strategy_options[k] = v;
			}
		}
	}
	// D.1: telemetry MUST be a boolean. Earlier TS allowed null (3-state); Go
	// json.Unmarshal into bool rejects null with a parse error. Aligning so
	// settings.local.json with `"telemetry": null` errors out the same way.
	if (Object.hasOwn(raw, 'telemetry')) {
		base.telemetry = requireBool('telemetry');
	}
	if (Object.hasOwn(raw, 'redaction')) {
		const redOverride = raw.redaction;
		if (typeof redOverride !== 'object' || redOverride === null || Array.isArray(redOverride)) {
			throw new Error('parsing redaction: must be an object');
		}
		const existing = base.redaction;
		if (typeof existing !== 'object' || existing === null || Array.isArray(existing)) {
			base.redaction = {};
		}
		mergeRedaction(
			base.redaction as Record<string, unknown>,
			redOverride as Record<string, unknown>,
		);
	}
	if (Object.hasOwn(raw, 'commit_linking')) {
		const cl = requireString('commit_linking');
		if (cl !== '') {
			if (cl !== 'always' && cl !== 'prompt') {
				throw new Error(`invalid commit_linking value "${cl}": must be "always" or "prompt"`);
			}
			base.commit_linking = cl;
		}
	}
	if (Object.hasOwn(raw, 'external_agents')) {
		base.external_agents = requireBool('external_agents');
	}
	// D.2: deprecated `strategy` field — Go's mergeJSON has NO branch for it
	// (intentionally ignored when present in settings.local.json). Earlier TS
	// applied it from local; this drift is harmless (deprecated) but breaks
	// cross-CLI merge equivalence. Drop the local override branch entirely.
	// `strategy` in the BASE file (loaded via loadFromBytes/.strict()) is still
	// preserved on the StorySettings object because the schema accepts it.
}

/** Save settings to `.story/settings.json`, creating `.story/` if needed. */
export async function save(repoRoot: string, settings: StorySettings): Promise<void> {
	await saveToFile(getStoryFilePath(repoRoot, SETTINGS_FILE), settings, repoRoot);
}

/** Save settings to `.story/settings.local.json` (local override file). */
export async function saveLocal(repoRoot: string, settings: StorySettings): Promise<void> {
	await saveToFile(getStoryFilePath(repoRoot, LOCAL_SETTINGS_FILE), settings, repoRoot);
}

async function saveToFile(
	filePath: string,
	settings: StorySettings,
	repoRoot: string,
): Promise<void> {
	await mkdir(storyDir(repoRoot), { recursive: true, mode: 0o750 });
	const data = `${JSON.stringify(settings, null, 2)}\n`;
	await writeFile(filePath, data, { mode: 0o644 });
}

/** Return the effective commit linking mode, defaulting to `"prompt"` when unset. */
export function getCommitLinking(s: StorySettings): string {
	return s.commit_linking ?? 'prompt';
}

/** True iff `strategy_options.summarize.enabled === true` (strict bool check). */
export function isSummarizeEnabled(s: StorySettings): boolean {
	if (s.strategy_options == null) {
		return false;
	}
	const opts = s.strategy_options.summarize;
	if (typeof opts !== 'object' || opts === null || Array.isArray(opts)) {
		return false;
	}
	return (opts as Record<string, unknown>).enabled === true;
}

/** True iff `strategy_options.checkpoints_v2 === true` (strict bool check; non-bool returns false). */
export function isCheckpointsV2Enabled(s: StorySettings): boolean {
	if (s.strategy_options == null) {
		return false;
	}
	return s.strategy_options.checkpoints_v2 === true;
}

/** True iff both `checkpoints_v2` and `push_v2_refs` are strictly `true`. */
export function isPushV2RefsEnabled(s: StorySettings): boolean {
	if (!isCheckpointsV2Enabled(s)) {
		return false;
	}
	return s.strategy_options?.push_v2_refs === true;
}

/**
 * True iff `push_sessions` is explicitly `false` (i.e. user opted out).
 * Missing or non-bool values return `false` (default = enabled).
 */
export function isPushSessionsDisabled(s: StorySettings): boolean {
	if (s.strategy_options == null) {
		return false;
	}
	const val = s.strategy_options.push_sessions;
	if (val === undefined) {
		return false;
	}
	if (typeof val === 'boolean') {
		return !val;
	}
	return false;
}

/** True iff `strategy_options.filtered_fetches === true` (strict bool check). */
export function isFilteredFetchesEnabled(s: StorySettings): boolean {
	if (s.strategy_options == null) {
		return false;
	}
	return s.strategy_options.filtered_fetches === true;
}

/**
 * Extract the structured checkpoint remote config, or `null` if not configured / invalid.
 *
 * Requires `strategy_options.checkpoint_remote` to be an object with either:
 *   - non-empty string `gitUrl`, or
 *   - non-empty string `provider` and `repo`, where `repo` contains `/`.
 */
export function getCheckpointRemote(s: StorySettings): CheckpointRemoteConfig | null {
	if (s.strategy_options == null) {
		return null;
	}
	const val = s.strategy_options.checkpoint_remote;
	if (typeof val !== 'object' || val === null || Array.isArray(val)) {
		return null;
	}
	const obj = val as Record<string, unknown>;
	const gitUrl = obj.gitUrl;
	const provider = obj.provider;
	const repo = obj.repo;

	if (typeof gitUrl === 'string' && gitUrl !== '') {
		const config: CheckpointRemoteConfig = { gitUrl };
		if (typeof provider === 'string' && provider !== '') {
			config.provider = provider;
		}
		if (typeof repo === 'string' && repo !== '' && repo.includes('/')) {
			config.repo = repo;
		}
		return config;
	}

	if (typeof provider !== 'string' || typeof repo !== 'string') {
		return null;
	}
	if (provider === '' || repo === '') {
		return null;
	}
	if (!repo.includes('/')) {
		return null;
	}
	return { provider, repo };
}

/** Return the owner segment of `repo` (text before the first `/`), or `""` if none. */
export function getCheckpointRemoteOwner(config: CheckpointRemoteConfig): string {
	if (config.repo === undefined) {
		return '';
	}
	const idx = config.repo.indexOf('/');
	return idx >= 0 ? config.repo.slice(0, idx) : '';
}

/** True iff `.story/settings.json` exists at `repoRoot`. */
export async function isSetUp(repoRoot: string): Promise<boolean> {
	return fileExists(getStoryFilePath(repoRoot, SETTINGS_FILE));
}

/**
 * Whether Story is currently enabled in this repo — `true` when at least one
 * settings file exists AND effective settings (project + local merge) report
 * `enabled: true`. "Not set up" and "load failure" both collapse to `false`:
 * the call site is almost always "should we act as if Story is on?" and a
 * missing / broken config means the honest answer is no.
 *
 * Mirrors Go `cmd/entire/cli/config.go: IsEnabled`, with one deliberate
 * divergence — Go defaults to `true` on load error AND treats absent files
 * as defaults (so `runEnable()` can detect "already enabled"); Story prefers
 * "absent = not enabled" so Phase 9.1 `configure` / Phase 9.2 `status` /
 * Phase 9.5 `doctor` stop misreporting a not-yet-set-up repo as "enabled".
 *
 * @example
 * await isEnabled('/repo');
 * // returns: true   (.story/ exists + effective settings.enabled === true)
 * // returns: false  (no .story/, or enabled: false, or malformed JSON)
 *
 * // Side effects: up to 3 fs reads (isSetUpAny stat + project + local). No writes.
 */
export async function isEnabled(repoRoot: string): Promise<boolean> {
	if (!(await isSetUpAny(repoRoot))) {
		return false;
	}
	try {
		const s = await load(repoRoot);
		return s.enabled;
	} catch {
		return false;
	}
}

/**
 * Persist a settings snapshot that flips `enabled` true/false while keeping
 * project and local files in sync on the `enabled` field. Routes writes by
 * scope and mirrors the Go "avoid local overriding project" dance: when
 * writing to project, the local file is **also** rewritten if it exists.
 *
 * Mirrors Go `cmd/entire/cli/setup.go: saveEnabledState`.
 *
 * @example
 * await saveEnabledState(repoRoot, { ...current, enabled: false }, false);
 * // returns: void
 *
 * // Side effects:
 * //   - <repoRoot>/.story/settings.local.json       ← atomically rewritten with full snapshot
 * //   - <repoRoot>/.story/settings.json             ← unchanged
 *
 * await saveEnabledState(repoRoot, { ...current, enabled: true }, true);
 * // Side effects (project + local both exist):
 * //   - <repoRoot>/.story/settings.json             ← rewritten (primary target)
 * //   - <repoRoot>/.story/settings.local.json       ← rewritten (kept in sync)
 * //
 * // .git/ / worktree / HEAD: unchanged.
 */
export async function saveEnabledState(
	repoRoot: string,
	s: StorySettings,
	useProjectSettings: boolean,
): Promise<void> {
	if (useProjectSettings) {
		await save(repoRoot, s);
		if (await fileExists(getStoryFilePath(repoRoot, LOCAL_SETTINGS_FILE))) {
			await saveLocal(repoRoot, s);
		}
		return;
	}
	await saveLocal(repoRoot, s);
}

/** True iff either `.story/settings.json` or `.story/settings.local.json` exists (uses lstat to detect symlinks). */
export async function isSetUpAny(repoRoot: string): Promise<boolean> {
	if (await isSetUp(repoRoot)) {
		return true;
	}
	return lstatExists(getStoryFilePath(repoRoot, LOCAL_SETTINGS_FILE));
}

/**
 * Load settings iff Story is set up AND `enabled: true`. Returns `null`
 * for "not set up", "disabled", or "load failed" (same fail-closed
 * semantics as {@link isSetUpAndEnabled}).
 *
 * Use this from hook entry points that need both the gate decision AND
 * the loaded settings (e.g. to route `log_level` into `log.init`). The
 * previous pattern — calling `isSetUpAndEnabled` then re-loading
 * settings — would read `settings.json` twice per hook invocation and
 * could race if the file changed between the two reads.
 */
export async function loadEnabledSettings(repoRoot: string): Promise<StorySettings | null> {
	if (!(await isSetUp(repoRoot))) {
		return null;
	}
	try {
		const s = await load(repoRoot);
		return s.enabled ? s : null;
	} catch {
		return null;
	}
}

/** True iff Story is set up AND loaded settings have `enabled: true`. Returns `false` on any load failure. */
export async function isSetUpAndEnabled(repoRoot: string): Promise<boolean> {
	return (await loadEnabledSettings(repoRoot)) !== null;
}

async function readFileOrNull(filePath: string): Promise<string | null> {
	try {
		return await readFile(filePath, 'utf-8');
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			return null;
		}
		throw err;
	}
}

async function fileExists(p: string): Promise<boolean> {
	try {
		await stat(p);
		return true;
	} catch {
		return false;
	}
}

async function lstatExists(p: string): Promise<boolean> {
	try {
		await lstat(p);
		return true;
	} catch {
		return false;
	}
}
