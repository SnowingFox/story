/**
 * Setup helpers for the strategy package — called by `story enable` and
 * implicitly on first checkpoint write.
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/strategy/common.go:61-84`
 * (`EnsureSetup`), `:275-303` (`EnsureRedactionConfigured`), and `:957-1009`
 * (`EnsureEntireGitignore` → renamed to `ensureStoryGitignore` for the Story
 * rebrand).
 *
 * **Phase 8 consumed the hook-installation deferral** originally placed at
 * the end of {@link ensureSetup}. `ensureSetup` now wires all 4 steps —
 * gitignore, redaction, metadata branch, and the 5 git-hook shims +
 * third-party hook-manager warnings.
 *
 * @packageDocumentation
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { checkAndWarnHookManagers } from '@/hooks/managers';
import { hookSettingsFromConfig, installGitHooks } from '../hooks/install';
import { configurePII, type PIIConfig } from '../redact';
import { ensureMetadataBranch } from './metadata-branch';

/**
 * One-shot setup for the strategy package. Performs 4 steps in order:
 *
 * 1. `.story/.gitignore` populated with the 4 canonical exclusion entries
 * 2. PII redaction configured (off by default until settings opt-in)
 * 3. `story/checkpoints/v1` metadata branch initialized (orphan, empty tree)
 * 4. 5 git-hook shell shims installed in `.git/hooks/` + stderr
 *    advisory if a third-party hook manager is detected
 *
 * Phase 8 closed the final DEFER by wiring {@link installGitHooks} and
 * {@link checkAndWarnHookManagers} — no placeholder comment remains.
 *
 * @example
 * await ensureSetup(repoRoot);
 * // Side effects:
 * //   - <repoRoot>/.story/.gitignore                     ← created/updated with tmp/, settings.local.json, metadata/, logs/ entries
 * //   - PII redaction global state                       ← configured (off by default until settings opt-in)
 * //   - story/checkpoints/v1 branch                      ← created (orphan, empty tree) if missing
 * //   - .git/hooks/{prepare-commit-msg,commit-msg,
 * //                 post-commit,post-rewrite,pre-push}   ← 5 shell shim scripts (mode 0o755) installed
 * //   - stderr                                           ← hook-manager warning block if Husky/Lefthook/… detected
 */
export async function ensureSetup(repoDir: string): Promise<void> {
	await ensureStoryGitignore(repoDir);
	await ensureRedactionConfigured(repoDir);
	await ensureMetadataBranch(repoDir);

	const { localDev, absoluteHookPath } = await hookSettingsFromConfig(repoDir);
	await installGitHooks(repoDir, {
		silent: true,
		localDev,
		absolutePath: absoluteHookPath,
	});
	await checkAndWarnHookManagers(repoDir, process.stderr, localDev, absoluteHookPath);
}

/**
 * Ensure `<repoDir>/.story/.gitignore` exists and contains the Story-managed
 * exclusion entries (`logs/`, `tmp/`). Idempotent — safe to call repeatedly.
 *
 * Renamed from Go's `ensureEntireGitignore` for the Story rebrand. Mirrors
 * `common.go:957-1009`.
 *
 * @example
 * await ensureStoryGitignore(repoRoot);
 * // Side effects:
 * //   - <repoRoot>/.story/                ← created (mode 0o755) if missing
 * //   - <repoRoot>/.story/.gitignore      ← created with "logs/\ntmp/\n" if missing
 * //   - <repoRoot>/.story/.gitignore      ← appended-to with missing entries if file exists
 */
export async function ensureStoryGitignore(repoDir: string): Promise<void> {
	const storyDir = path.join(repoDir, '.story');
	await fs.mkdir(storyDir, { recursive: true });

	const gitignorePath = path.join(storyDir, '.gitignore');
	// Mirrors Go common.go:973-978 verbatim (order preserved):
	//   tmp/, settings.local.json, metadata/, logs/
	const requiredEntries = ['tmp/', 'settings.local.json', 'metadata/', 'logs/'];

	let existing = '';
	try {
		existing = await fs.readFile(gitignorePath, 'utf-8');
	} catch (err) {
		if ((err as { code?: string }).code !== 'ENOENT') {
			throw err;
		}
	}

	const existingLines = new Set(
		existing
			.split('\n')
			.map((l) => l.trim())
			.filter((l) => l.length > 0),
	);
	const missing = requiredEntries.filter((e) => !existingLines.has(e));
	if (missing.length === 0) {
		return;
	}

	const needsTrailingNewline = existing.length > 0 && !existing.endsWith('\n');
	const additions = `${(needsTrailingNewline ? '\n' : '') + missing.join('\n')}\n`;
	await fs.writeFile(gitignorePath, existing + additions, 'utf-8');
}

/**
 * Initialize PII redaction based on Story settings. Currently a thin
 * placeholder that wires the off-by-default config; Phase 5.3 condensation
 * will read settings and pass a populated {@link PIIConfig} here.
 *
 * Mirrors Go `common.go:275-303` (`EnsureRedactionConfigured`).
 *
 * @example
 * await ensureRedactionConfigured(repoRoot);
 * // Side effects:
 * //   - global redaction config ← null (off) by default in Phase 5.1
 * //   - Phase 5.3 will replace this with a settings-driven configurePII({ enabled: true, categories: {...} })
 */
export async function ensureRedactionConfigured(_repoDir: string): Promise<void> {
	// Phase 5.1 default: redaction off. Phase 5.3 condensation will load the
	// `.story/settings.json` `redaction` block (if any) and call configurePII
	// with the actual config. Go reference: `common.go:275-303` calls
	// `settings.Load()` then `redact.Configure(...)`.
	const offConfig: PIIConfig | null = null;
	configurePII(offConfig);
}
