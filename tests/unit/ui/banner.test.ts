import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetGlobalFlagsForTesting } from '@/cli/flags';
import { BANNER_LINES, banner, GRADIENT, rgb } from '@/ui/banner';
import { resetColorOverrideForTesting, setColorOverride } from '@/ui/theme';

function collect(out: PassThrough): () => string {
	const chunks: Buffer[] = [];
	out.on('data', (chunk: Buffer | string) => {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
	});
	return () => Buffer.concat(chunks).toString('utf8');
}

describe('ui/banner :: constants', () => {
	it('BANNER_LINES has exactly 6 rows (block-art height)', () => {
		expect(BANNER_LINES).toHaveLength(6);
	});

	it('BANNER_LINES contains only printable block / box chars + spaces', () => {
		for (const line of BANNER_LINES) {
			expect(line).toMatch(/^[\u2500-\u257F█╔╗╚╝═║ ]+$/);
		}
	});

	it('GRADIENT has exactly 6 RGB triples', () => {
		expect(GRADIENT).toHaveLength(6);
		for (const triple of GRADIENT) {
			expect(triple).toHaveLength(3);
			for (const component of triple) {
				expect(component).toBeGreaterThanOrEqual(0);
				expect(component).toBeLessThanOrEqual(255);
			}
		}
	});
});

describe('ui/banner :: rgb(r, g, b)', () => {
	afterEach(() => {
		resetColorOverrideForTesting();
	});

	it('returns ANSI 24-bit escape when color is enabled', () => {
		setColorOverride(true);
		expect(rgb(100, 200, 250)).toBe('\x1B[38;2;100;200;250m');
	});

	it('returns an empty string when color is disabled', () => {
		setColorOverride(false);
		expect(rgb(100, 200, 250)).toBe('');
	});
});

describe('ui/banner :: banner(out, force)', () => {
	beforeEach(() => {
		resetGlobalFlagsForTesting();
		resetColorOverrideForTesting();
	});

	afterEach(() => {
		resetGlobalFlagsForTesting();
		resetColorOverrideForTesting();
	});

	it('prints 6 art lines + one trailing blank line (no tagline; help owns it)', () => {
		setColorOverride(true);
		const out = new PassThrough();
		const read = collect(out);
		banner(out, true);
		out.end();
		const text = read();
		const lines = text.split('\n').filter((l) => l.length > 0);
		expect(lines).toHaveLength(6);
		expect(text).not.toMatch(/Every commit tells a story/i);
	});

	it('renders without ANSI codes when color override is off', () => {
		setColorOverride(false);
		const out = new PassThrough();
		const read = collect(out);
		banner(out, true);
		out.end();
		const text = read();
		expect(text).not.toMatch(new RegExp(`${String.fromCharCode(27)}\\[`));
		expect(text).toContain(BANNER_LINES[0]!);
		expect(text).not.toMatch(/Every commit tells a story/i);
	});

	it('is a no-op when force=false and stdout is not a TTY', () => {
		setColorOverride(true);
		const out = new PassThrough();
		const read = collect(out);
		// PassThrough is not a TTY — banner should refuse to render.
		banner(out, false);
		out.end();
		expect(read()).toBe('');
	});

	it('is a no-op under --json mode (even with force=true)', async () => {
		const { applyGlobalFlags } = await import('@/cli/flags');
		applyGlobalFlags({ json: true });
		const out = new PassThrough();
		const read = collect(out);
		banner(out, true);
		out.end();
		expect(read()).toBe('');
	});

	it('prints the art when force=true even on a non-TTY stream', () => {
		resetGlobalFlagsForTesting();
		const out = new PassThrough();
		const read = collect(out);
		banner(out, true);
		out.end();
		expect(read().length).toBeGreaterThan(0);
	});
});
