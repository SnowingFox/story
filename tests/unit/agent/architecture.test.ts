import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Go: architecture_test.go (TestAgentPackages_NoForbiddenImports +
//                           TestAgentPackages_SelfRegister)
// TS uses runtime file scanning here as a tighter alternative to ESLint
// `no-restricted-imports` (works in CI without lint config drift).

const REPO_ROOT = path.resolve(__dirname, '../../..');
const AGENT_DIR = path.join(REPO_ROOT, 'src', 'agent');

async function listAgentSrcFiles(): Promise<string[]> {
	const entries = await fs.readdir(AGENT_DIR, { withFileTypes: true });
	return entries
		.filter((e) => e.isFile() && e.name.endsWith('.ts'))
		.map((e) => path.join(AGENT_DIR, e.name));
}

describe('agent/architecture — Go: architecture_test.go (TS port)', () => {
	it('no src/agent/**.ts file imports @/strategy / @/checkpoint / @/cli / @/session (except state-store)', async () => {
		// Go: architecture_test.go TestAgentPackages_NoForbiddenImports
		// Story-side: src/agent/* must depend only on src/{transcript,log,...}
		// — nothing higher in the dep stack. The single sanctioned exception
		// is `@/session/state-store` (TokenUsage type re-export from session.ts).
		const files = await listAgentSrcFiles();
		const forbidden = [
			/\bfrom\s+['"]@\/strategy/,
			/\bfrom\s+['"]@\/checkpoint/,
			/\bfrom\s+['"]@\/cli/,
		];
		const allowedSessionImport = '@/session/state-store';
		// Match the entire import-source token (in single or double quotes).
		const sessionImportRe = /from\s+['"](@\/session[^'"]*)['"]/g;

		const violations: string[] = [];
		for (const file of files) {
			const content = await fs.readFile(file, 'utf8');
			for (const pat of forbidden) {
				if (pat.test(content)) {
					violations.push(
						`${path.relative(REPO_ROOT, file)} imports forbidden module (${pat.source})`,
					);
				}
			}
			// @/session is forbidden EXCEPT for the @/session/state-store TokenUsage re-export.
			sessionImportRe.lastIndex = 0;
			for (let m = sessionImportRe.exec(content); m !== null; m = sessionImportRe.exec(content)) {
				if (m[1] !== allowedSessionImport) {
					violations.push(
						`${path.relative(REPO_ROOT, file)} imports forbidden @/session subpath (${m[1]})`,
					);
				}
			}
		}
		expect(violations).toEqual([]);
	});

	it('no agent file calls register() at module top-level (Phase 6.3 polish — bootstrap centralizes it)', async () => {
		// Go: architecture_test.go TestAgentPackages_SelfRegister (inverted in
		// TS — we forbid module-level side effects per AGENTS.md §异步/模块边界).
		//
		// Old rule: every agent self-registered via top-level `register(...)`.
		// New rule (Phase 6.3 polish): ONLY `src/agent/bootstrap.ts` calls
		// `register(...)`. Agent files export factories; `bootstrap.ts` wires
		// them. Reasons: implicit-import side effects, test pollution, build
		// order, CLI/library entanglement (see AGENTS.md).
		const files = await listAgentSrcFiles();
		// `bootstrap.ts` is the ONE allowed callsite for register().
		const allowedRegisterCallers = new Set(['bootstrap.ts']);
		const violations: string[] = [];
		for (const file of files) {
			const basename = path.basename(file);
			if (allowedRegisterCallers.has(basename)) {
				continue;
			}
			const content = await fs.readFile(file, 'utf8');
			// Match top-level / non-comment `register(AGENT_NAME_...)` calls.
			// Strip JSDoc / line-comment regions so example code in
			// JSDoc doesn't false-positive.
			const stripped = content
				.replace(/\/\*[\s\S]*?\*\//g, '') // block comments
				.replace(/^\s*\/\/.*$/gm, ''); // line comments
			if (/\bregister\s*\(\s*AGENT_NAME_/.test(stripped)) {
				violations.push(
					`${path.relative(REPO_ROOT, file)} calls register(AGENT_NAME_*) outside bootstrap.ts`,
				);
			}
		}
		expect(violations).toEqual([]);
	});

	it('bootstrap.ts wires every built-in agent into the registry', async () => {
		// Companion check: ensure bootstrap.ts hasn't drifted out of sync with
		// the agent files. As Phase 6.4-6.6 add agents, each new factory must
		// be listed here.
		const bootstrapPath = path.join(AGENT_DIR, 'bootstrap.ts');
		const content = await fs.readFile(bootstrapPath, 'utf8');
		// Phase 6.1-6.3 built-ins: Vogon, Claude Code, Cursor.
		expect(content).toMatch(/\bregister\(\s*AGENT_NAME_VOGON\s*,\s*vogonAgent\s*\)/);
		expect(content).toMatch(/\bregister\(\s*AGENT_NAME_CLAUDE_CODE\s*,\s*claudeCodeAgent\s*\)/);
		expect(content).toMatch(/\bregister\(\s*AGENT_NAME_CURSOR\s*,\s*cursorAgent\s*\)/);
	});

	it('Story brand red-line: no Entire-flavored brand strings in src/agent/**.ts string literals', async () => {
		// Story-side guard. Allowed only inside JSDoc / // comments (the Go-anchor
		// references). Fails fast if implementer typed `entire` / `Entire CLI` /
		// `Powered by Entire` / `docs.entire.io` in user-facing strings.
		const files = await listAgentSrcFiles();
		const violations: string[] = [];
		for (const file of files) {
			const content = await fs.readFile(file, 'utf8');
			const lines = content.split('\n');
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i]!;
				// Skip comment lines (single-line // and JSDoc */ */ blocks).
				const stripped = line.replace(/\/\*[^*]*\*\//g, '').trim();
				if (
					stripped.startsWith('//') ||
					stripped.startsWith('*') ||
					stripped.startsWith('/*') ||
					stripped.startsWith('/**')
				) {
					continue;
				}
				if (
					/Powered by Entire|docs\.entire\.io|command -v entire|Entire CLI is not installed|Entire-(Checkpoint|Session)/i.test(
						line,
					)
				) {
					violations.push(`${path.relative(REPO_ROOT, file)}:${i + 1} ${line.trim()}`);
				}
			}
		}
		expect(violations).toEqual([]);
	});
});
