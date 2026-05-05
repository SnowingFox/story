import { describe, expect, it } from 'vitest';
import {
	isManagedHookCommand,
	missingStoryWarning,
	WARNING_FORMAT_MULTI_LINE,
	WARNING_FORMAT_SINGLE_LINE,
	type WarningFormat,
	wrapProductionJSONWarningHookCommand,
	wrapProductionPlainTextWarningHookCommand,
	wrapProductionSilentHookCommand,
} from '@/agent/hook-command';

// Go: hook_command.go (WarningFormat + MissingEntireWarning + 3 Wrap funcs +
//                      IsManagedHookCommand)
// Go: hook_command_test.go (5 test functions)

const ENTIRE_BRAND_RED_LINE = /\bentire\b|Entire CLI|Powered by Entire|docs\.entire\.io/i;

describe('agent/hook-command — Go: hook_command.go', () => {
	describe('missingStoryWarning (Story-rebrand of MissingEntireWarning)', () => {
		// Go: hook_command_test.go TestMissingEntireWarning_Single + Multi
		it('SINGLE_LINE: single line, contains "Powered by Story"', () => {
			const out = missingStoryWarning(WARNING_FORMAT_SINGLE_LINE);
			expect(out).not.toContain('\n');
			expect(out).toContain('Powered by Story');
			expect(out).toContain('Story CLI is not installed');
		});

		it('MULTI_LINE: multi-line, contains "Powered by Story"', () => {
			const out = missingStoryWarning(WARNING_FORMAT_MULTI_LINE);
			expect(out).toContain('\n');
			expect(out).toContain('Powered by Story');
		});

		it('Story brand red-line: never contains "Powered by Entire" / "docs.entire.io"', () => {
			// Story rebrand red-line guard — fails fast if implementer used wrong literal.
			expect(missingStoryWarning(WARNING_FORMAT_SINGLE_LINE)).not.toMatch(ENTIRE_BRAND_RED_LINE);
			expect(missingStoryWarning(WARNING_FORMAT_MULTI_LINE)).not.toMatch(ENTIRE_BRAND_RED_LINE);
		});

		it('unknown format → falls back to single-line', () => {
			// Go: hook_command.go:23-25 — default branch returns SingleLine.
			expect(missingStoryWarning(999 as WarningFormat)).toBe(
				missingStoryWarning(WARNING_FORMAT_SINGLE_LINE),
			);
		});
	});

	describe('wrapProductionSilentHookCommand', () => {
		// Go: hook_command.go:28-35 (WrapProductionSilentHookCommand)
		it('wraps with sh -c, command -v story, exit 0, exec', () => {
			const out = wrapProductionSilentHookCommand('story hooks claude-code stop');
			expect(out).toContain('sh -c');
			expect(out).toContain('command -v story');
			expect(out).toContain('exit 0');
			expect(out).toContain('exec story hooks claude-code stop');
			expect(out).not.toMatch(ENTIRE_BRAND_RED_LINE);
		});
	});

	describe('wrapProductionJSONWarningHookCommand', () => {
		// Go: hook_command_test.go TestWrapProductionJSONWarningHookCommand
		it('wraps with sh -c, contains systemMessage JSON, exec target', () => {
			const out = wrapProductionJSONWarningHookCommand(
				'story hooks cursor stop',
				WARNING_FORMAT_SINGLE_LINE,
			);
			expect(out).toContain('systemMessage');
			expect(out).toContain('Powered by Story');
			expect(out).toContain('exec story hooks cursor stop');
			expect(out).toContain('command -v story');
			expect(out).not.toMatch(ENTIRE_BRAND_RED_LINE);
		});
	});

	describe('wrapProductionPlainTextWarningHookCommand', () => {
		// Go: hook_command_test.go TestWrapProductionPlainTextWarningHookCommand
		// (payload text is arbitrary — just exercises the sh -c wrapper shape).
		it('wraps with sh -c, plain text warning, exec target', () => {
			const out = wrapProductionPlainTextWarningHookCommand(
				'story hooks vogon stop',
				WARNING_FORMAT_MULTI_LINE,
			);
			expect(out).toContain('Powered by Story');
			expect(out).toContain('exec story hooks vogon stop');
			expect(out).toContain('command -v story');
			// Plain-text wrapper doesn't carry JSON/systemMessage marker.
			expect(out).not.toContain('systemMessage');
			expect(out).not.toMatch(ENTIRE_BRAND_RED_LINE);
		});
	});

	describe('isManagedHookCommand', () => {
		// Go: hook_command_test.go TestIsManagedHookCommand_DirectPrefix +
		//     TestIsManagedHookCommand_WrappedPrefix + TestIsManagedHookCommand_DoesNotMatchSubstring
		it('direct "story " prefix matches', () => {
			expect(isManagedHookCommand('story hooks codex stop', ['story '])).toBe(true);
		});

		it('wrapped silent command unwraps + matches inner exec', () => {
			const wrapped = wrapProductionSilentHookCommand('story hooks codex stop');
			expect(isManagedHookCommand(wrapped, ['story '])).toBe(true);
		});

		it('wrapped JSON warning command unwraps + matches', () => {
			const wrapped = wrapProductionJSONWarningHookCommand(
				'story hooks claude-code stop',
				WARNING_FORMAT_SINGLE_LINE,
			);
			expect(isManagedHookCommand(wrapped, ['story '])).toBe(true);
		});

		it('substring is NOT enough (must be prefix)', () => {
			expect(isManagedHookCommand('echo "the story workflow finished"', ['story '])).toBe(false);
		});

		it('wrapper but exec target is non-story → false', () => {
			const wrapped = wrapProductionSilentHookCommand('echo unrelated');
			expect(isManagedHookCommand(wrapped, ['story '])).toBe(false);
		});
	});
});
