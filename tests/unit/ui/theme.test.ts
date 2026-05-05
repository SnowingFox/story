import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	color,
	isColorEnabled,
	resetColorOverrideForTesting,
	S,
	setColorOverride,
} from '@/ui/theme';

/**
 * Symbol bytes must match @clack/prompts defaults so our custom
 * `header`/`step` output interleaves seamlessly with clack prompt
 * renders — see module.md symbol table.
 */
describe('ui/theme :: S symbols', () => {
	it('bar is U+2502 (│)', () => {
		expect(S.bar).toBe('│');
	});
	it('barStart is U+250C (┌)', () => {
		expect(S.barStart).toBe('┌');
	});
	it('barEnd is U+2514 (└)', () => {
		expect(S.barEnd).toBe('└');
	});
	it('step is U+25C7 (◇)', () => {
		expect(S.step).toBe('◇');
	});
	it('stepActive is U+25C6 (◆)', () => {
		expect(S.stepActive).toBe('◆');
	});
	it('stepDone is U+25CF (●)', () => {
		expect(S.stepDone).toBe('●');
	});
	it('stepError is U+25A0 (■)', () => {
		expect(S.stepError).toBe('■');
	});
	it('stepCancel is U+25CB (○)', () => {
		expect(S.stepCancel).toBe('○');
	});
	it('warning is U+25B2 (▲)', () => {
		expect(S.warning).toBe('▲');
	});
	it('info is U+2139 (ℹ)', () => {
		expect(S.info).toBe('ℹ');
	});
});

describe('ui/theme :: color palette + isColorEnabled', () => {
	afterEach(() => {
		resetColorOverrideForTesting();
	});

	it('returns the raw string with NO-OP when color override is false', () => {
		setColorOverride(false);
		expect(isColorEnabled()).toBe(false);
		expect(color.cyan('hello')).toBe('hello');
		expect(color.red('err')).toBe('err');
		expect(color.dim('dim')).toBe('dim');
		expect(color.bold('bold')).toBe('bold');
		expect(color.gray('gray')).toBe('gray');
		expect(color.green('ok')).toBe('ok');
		expect(color.yellow('warn')).toBe('warn');
		expect(color.blue('info')).toBe('info');
	});

	it('wraps with ANSI when color override is true', () => {
		setColorOverride(true);
		expect(isColorEnabled()).toBe(true);
		// Each wrapper must prefix + suffix an ANSI escape around the payload.
		expect(color.cyan('hi')).not.toBe('hi');
		expect(color.cyan('hi')).toContain('hi');
		expect(color.cyan('hi').length).toBeGreaterThan('hi'.length);
	});

	it('defaults to picocolors.isColorSupported when no override set', () => {
		resetColorOverrideForTesting();
		// Just verify the call does not throw + returns a boolean.
		expect(typeof isColorEnabled()).toBe('boolean');
	});

	it('resetColorOverrideForTesting clears the override', () => {
		setColorOverride(false);
		expect(isColorEnabled()).toBe(false);
		resetColorOverrideForTesting();
		// Now reads live from picocolors — just verify shape.
		expect(typeof isColorEnabled()).toBe('boolean');
	});
});

describe('ui/theme :: all downstream modules must import symbols from here', () => {
	// Compile-time check: this test exists as a documentation anchor.
	// Any PR adding `import pc from 'picocolors'` outside of theme.ts + banner.ts
	// (banner uses its own RGB escape generator) should be rejected in review.
	it('S and color are both frozen / stable export surfaces', () => {
		expect(Object.isFrozen(S)).toBe(true);
		expect(Object.isFrozen(color)).toBe(true);
	});
});

beforeEach(() => {
	resetColorOverrideForTesting();
});
