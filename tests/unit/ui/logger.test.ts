import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyGlobalFlags, resetGlobalFlagsForTesting } from '@/cli/flags';
import { resetColorOverrideForTesting, setColorOverride } from '@/ui/theme';

/**
 * Replace process.stdout / process.stderr with PassThrough streams so
 * logger tests can inspect output without interleaving with vitest's
 * own reporter.
 */
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const stripAnsi = (s: string) => s.replace(ANSI_RE, '');

function captureStreams() {
	const out = new PassThrough();
	const err = new PassThrough();
	const outChunks: Buffer[] = [];
	const errChunks: Buffer[] = [];
	out.on('data', (c) => outChunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))));
	err.on('data', (c) => errChunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))));
	const origOutWrite = process.stdout.write.bind(process.stdout);
	const origErrWrite = process.stderr.write.bind(process.stderr);
	process.stdout.write = ((chunk: string | Uint8Array) => {
		out.write(chunk);
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk: string | Uint8Array) => {
		err.write(chunk);
		return true;
	}) as typeof process.stderr.write;
	return {
		outText: () => stripAnsi(Buffer.concat(outChunks).toString('utf8')),
		errText: () => stripAnsi(Buffer.concat(errChunks).toString('utf8')),
		outTextRaw: () => Buffer.concat(outChunks).toString('utf8'),
		errTextRaw: () => Buffer.concat(errChunks).toString('utf8'),
		restore: () => {
			process.stdout.write = origOutWrite;
			process.stderr.write = origErrWrite;
		},
	};
}

describe('ui/logger :: bar-line renderers (color on)', () => {
	let cap: ReturnType<typeof captureStreams>;

	beforeEach(() => {
		resetGlobalFlagsForTesting();
		resetColorOverrideForTesting();
		setColorOverride(true);
		cap = captureStreams();
	});

	afterEach(() => {
		cap.restore();
		resetGlobalFlagsForTesting();
		resetColorOverrideForTesting();
	});

	it('header(label) prints `┌   <cyan-bold-label>` on stdout', async () => {
		const { header } = await import('@/ui/logger');
		header('enable');
		const text = cap.outText();
		expect(text).toContain('┌');
		expect(text).toContain('enable');
	});

	it('footer(msg) prints `└  <msg>` on stdout', async () => {
		const { footer } = await import('@/ui/logger');
		footer('Done.');
		const text = cap.outText();
		expect(text).toContain('└');
		expect(text).toContain('Done.');
	});

	it('footer() without msg prints just `└` on stdout', async () => {
		const { footer } = await import('@/ui/logger');
		footer();
		const text = cap.outText();
		expect(text).toContain('└');
	});

	it('barLine(content) prints `│  <content>` on stdout', async () => {
		const { barLine } = await import('@/ui/logger');
		barLine('reading settings');
		expect(cap.outText()).toMatch(/│\s+reading settings/);
	});

	it('barEmpty() prints just `│` on stdout', async () => {
		const { barEmpty } = await import('@/ui/logger');
		barEmpty();
		expect(cap.outText()).toMatch(/│\s*\n/);
	});

	it('step prints `◇  <content>` on stdout', async () => {
		const { step } = await import('@/ui/logger');
		step('Repository detected');
		expect(cap.outText()).toMatch(/◇\s+Repository detected/);
	});

	it('stepDone prints `●  <content>` on stdout', async () => {
		const { stepDone } = await import('@/ui/logger');
		stepDone('Installed 5 git hooks');
		expect(cap.outText()).toMatch(/●\s+Installed 5 git hooks/);
	});

	it('stepError prints `■  <content>` on stdout', async () => {
		const { stepError } = await import('@/ui/logger');
		stepError('Not a git repository');
		expect(cap.outText()).toMatch(/■\s+Not a git repository/);
	});

	it('warn prints `▲  <msg>` on stderr', async () => {
		const { warn } = await import('@/ui/logger');
		warn('stale session detected');
		expect(cap.errText()).toMatch(/▲\s+stale session detected/);
		expect(cap.outText()).toBe('');
	});

	it('info prints `ℹ  <msg>` on stderr', async () => {
		const { info } = await import('@/ui/logger');
		info('ran in 42ms');
		expect(cap.errText()).toMatch(/ℹ\s+ran in 42ms/);
	});

	it('note(title, body) prints a boxed title + indented body lines', async () => {
		const { note } = await import('@/ui/logger');
		note('Next steps', ['Run story status', 'See .story/logs/']);
		const text = cap.outText();
		expect(text).toContain('Next steps');
		expect(text).toContain('Run story status');
		expect(text).toContain('See .story/logs/');
		// Box characters: expect both top and bottom borders.
		expect(text).toContain('┌');
		expect(text).toContain('└');
	});

	it('note(title) without body still prints a single-line box', async () => {
		const { note } = await import('@/ui/logger');
		note('Hello');
		const text = cap.outText();
		expect(text).toContain('Hello');
		expect(text).toContain('┌');
		expect(text).toContain('└');
	});

	it('errorLine(msg) prints `[story] <msg>` in red on stderr', async () => {
		const { errorLine } = await import('@/ui/logger');
		errorLine('something broke');
		const text = cap.errText();
		expect(text).toContain('[story]');
		expect(text).toContain('something broke');
		expect(cap.outText()).toBe('');
	});
});

describe('ui/logger :: --json mode', () => {
	let cap: ReturnType<typeof captureStreams>;

	beforeEach(() => {
		resetGlobalFlagsForTesting();
		resetColorOverrideForTesting();
		applyGlobalFlags({ json: true });
		cap = captureStreams();
	});

	afterEach(() => {
		cap.restore();
		resetGlobalFlagsForTesting();
		resetColorOverrideForTesting();
	});

	it('step / stepDone / stepError / header / footer / barLine / barEmpty are all no-ops', async () => {
		const L = await import('@/ui/logger');
		L.step('x');
		L.stepDone('y');
		L.stepError('z');
		L.header('enable');
		L.footer('ok');
		L.barLine('hi');
		L.barEmpty();
		L.note('Title', ['body']);
		expect(cap.outText()).toBe('');
	});

	it('warn emits a single JSON line on stderr', async () => {
		const { warn } = await import('@/ui/logger');
		warn('stale');
		const text = cap.errText().trim();
		expect(() => JSON.parse(text)).not.toThrow();
		expect(JSON.parse(text)).toMatchObject({ level: 'warn', message: 'stale' });
	});

	it('info emits a single JSON line on stderr', async () => {
		const { info } = await import('@/ui/logger');
		info('ok');
		const payload = JSON.parse(cap.errText().trim());
		expect(payload).toMatchObject({ level: 'info', message: 'ok' });
	});

	it('errorLine emits `{"error":"<msg>"}` on stderr', async () => {
		const { errorLine } = await import('@/ui/logger');
		errorLine('boom');
		const payload = JSON.parse(cap.errText().trim());
		expect(payload).toMatchObject({ error: 'boom' });
	});
});

// vi is referenced for spying; explicit void silences lint.
void vi;
