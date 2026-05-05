import { describe, expect, it } from 'vitest';
import {
	BANNER_LINES,
	banner,
	barEmpty,
	barLine,
	color,
	confirm,
	errorLine,
	footer,
	GRADIENT,
	header,
	info,
	multiselect,
	note,
	password,
	rgb,
	S,
	select,
	spinner,
	step,
	stepDone,
	stepError,
	text,
	warn,
	withSpinner,
} from '@/ui';

describe('ui/index :: barrel surface', () => {
	it('re-exports banner family', () => {
		expect(typeof banner).toBe('function');
		expect(Array.isArray(BANNER_LINES)).toBe(true);
		expect(Array.isArray(GRADIENT)).toBe(true);
		expect(typeof rgb).toBe('function');
	});

	it('re-exports logger family', () => {
		expect(typeof header).toBe('function');
		expect(typeof footer).toBe('function');
		expect(typeof barLine).toBe('function');
		expect(typeof barEmpty).toBe('function');
		expect(typeof step).toBe('function');
		expect(typeof stepDone).toBe('function');
		expect(typeof stepError).toBe('function');
		expect(typeof warn).toBe('function');
		expect(typeof info).toBe('function');
		expect(typeof note).toBe('function');
		expect(typeof errorLine).toBe('function');
	});

	it('re-exports prompts family', () => {
		expect(typeof text).toBe('function');
		expect(typeof password).toBe('function');
		expect(typeof select).toBe('function');
		expect(typeof multiselect).toBe('function');
		expect(typeof confirm).toBe('function');
	});

	it('re-exports theme constants', () => {
		expect(typeof S).toBe('object');
		expect(typeof color).toBe('object');
		expect(S.bar).toBe('│');
	});

	it('re-exports spinner + withSpinner', () => {
		expect(typeof spinner).toBe('function');
		expect(typeof withSpinner).toBe('function');
	});
});
