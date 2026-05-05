/**
 * Phase 9.6 completion script template unit tests.
 *
 * Go: `cmd/entire/cli/root.go: CompletionOptions` (cobra auto-generates;
 * TS hand-writes to the same user-visible surface).
 */

import { describe, expect, it } from 'vitest';
import {
	BASH_TEMPLATE,
	FISH_TEMPLATE,
	renderCompletionScript,
	SUPPORTED_SHELLS,
	ZSH_TEMPLATE,
} from '@/commands/completion-templates';
import { SilentError } from '@/errors';

describe('commands/completion-templates', () => {
	it('SUPPORTED_SHELLS is ["bash","zsh","fish"]', () => {
		expect([...SUPPORTED_SHELLS]).toEqual(['bash', 'zsh', 'fish']);
	});

	it('BASH_TEMPLATE registers the _story_completions function', () => {
		expect(BASH_TEMPLATE.length).toBeGreaterThan(100);
		expect(BASH_TEMPLATE).toContain('_story_completions');
		expect(BASH_TEMPLATE).toContain('complete -F _story_completions story');
	});

	it('ZSH_TEMPLATE starts with the #compdef story header', () => {
		expect(ZSH_TEMPLATE).toMatch(/^#compdef story/);
		expect(ZSH_TEMPLATE).toContain('_story');
		expect(ZSH_TEMPLATE).toContain('compdef _story story');
	});

	it('FISH_TEMPLATE uses `complete -c story` statements', () => {
		expect(FISH_TEMPLATE).toContain('complete -c story');
		expect(FISH_TEMPLATE).toContain('__fish_use_subcommand');
	});

	it('renderCompletionScript("bash") === BASH_TEMPLATE', () => {
		expect(renderCompletionScript('bash')).toBe(BASH_TEMPLATE);
	});

	it('renderCompletionScript("zsh") === ZSH_TEMPLATE', () => {
		expect(renderCompletionScript('zsh')).toBe(ZSH_TEMPLATE);
	});

	it('renderCompletionScript("fish") === FISH_TEMPLATE', () => {
		expect(renderCompletionScript('fish')).toBe(FISH_TEMPLATE);
	});

	it('renderCompletionScript("powershell") throws SilentError', () => {
		try {
			renderCompletionScript('powershell');
			throw new Error('expected SilentError');
		} catch (err) {
			expect(err).toBeInstanceOf(SilentError);
			expect((err as Error).message).toMatch(/Unsupported shell/);
			expect((err as Error).message).toMatch(/powershell/);
		}
	});

	it('renderCompletionScript("") throws SilentError', () => {
		expect(() => renderCompletionScript('')).toThrow(SilentError);
	});

	// Phase 9.6 naming red-line: scripts must never embed `entire` brand
	// literals, and must never reference first-release-deferred commands.
	it('scripts contain no "entire" / "_entire_" / ".entire/" literals', () => {
		for (const tpl of [BASH_TEMPLATE, ZSH_TEMPLATE, FISH_TEMPLATE]) {
			expect(tpl).not.toMatch(/\bentire\b/);
			expect(tpl).not.toMatch(/_entire_/);
			expect(tpl).not.toMatch(/\.entire\//);
		}
	});

	it('scripts do NOT reference first-release-deferred commands (trail/search/login/logout/reset)', () => {
		for (const tpl of [BASH_TEMPLATE, ZSH_TEMPLATE, FISH_TEMPLATE]) {
			expect(tpl).not.toMatch(/\btrail\b/);
			expect(tpl).not.toMatch(/\bsearch\b/);
			expect(tpl).not.toMatch(/\blogin\b/);
			expect(tpl).not.toMatch(/\blogout\b/);
			// "reset" is a deprecated Go command — its surface is owned by `clean`.
			expect(tpl).not.toMatch(/'reset'|"reset"| reset /);
		}
	});
});
