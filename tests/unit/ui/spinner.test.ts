import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyGlobalFlags, resetGlobalFlagsForTesting } from '@/cli/flags';
import { resetColorOverrideForTesting } from '@/ui/theme';

const clackSpinnerHandle = {
	start: vi.fn(),
	stop: vi.fn(),
	message: vi.fn(),
};

vi.mock('@clack/prompts', async () => {
	return {
		spinner: () => clackSpinnerHandle,
		isCancel: () => false,
	};
});

describe('ui/spinner', () => {
	beforeEach(() => {
		process.env.STORY_TEST_TTY = '1';
		resetGlobalFlagsForTesting();
		resetColorOverrideForTesting();
		clackSpinnerHandle.start.mockReset();
		clackSpinnerHandle.stop.mockReset();
		clackSpinnerHandle.message.mockReset();
	});

	afterEach(() => {
		resetGlobalFlagsForTesting();
		resetColorOverrideForTesting();
	});

	describe('spinner(label)', () => {
		it('returns a handle with message / stop (TTY path → uses @clack spinner)', async () => {
			const { spinner } = await import('@/ui/spinner');
			const handle = spinner('working...');
			expect(clackSpinnerHandle.start).toHaveBeenCalledWith('working...');
			handle.message('tick');
			expect(clackSpinnerHandle.message).toHaveBeenCalledWith('tick');
			handle.stop('done');
			expect(clackSpinnerHandle.stop).toHaveBeenCalledWith('done', undefined);
		});

		it('under --json degrades: never calls clack spinner', async () => {
			applyGlobalFlags({ json: true });
			const { spinner } = await import('@/ui/spinner');
			const handle = spinner('working...');
			handle.message('tick');
			handle.stop('done');
			expect(clackSpinnerHandle.start).not.toHaveBeenCalled();
			expect(clackSpinnerHandle.message).not.toHaveBeenCalled();
			expect(clackSpinnerHandle.stop).not.toHaveBeenCalled();
		});

		it('under --verbose degrades: does not call clack spinner', async () => {
			applyGlobalFlags({ verbose: true });
			const { spinner } = await import('@/ui/spinner');
			const handle = spinner('working...');
			handle.stop('done');
			expect(clackSpinnerHandle.start).not.toHaveBeenCalled();
		});

		it('non-TTY degrades: does not call clack spinner', async () => {
			process.env.STORY_TEST_TTY = '0';
			const { spinner } = await import('@/ui/spinner');
			const handle = spinner('working...');
			handle.stop('done');
			expect(clackSpinnerHandle.start).not.toHaveBeenCalled();
		});

		it('degraded stop(msg, code>0) routes the final line through log.warn', async () => {
			applyGlobalFlags({ verbose: true });
			const logMod = await import('@/log');
			const warnSpy = vi.spyOn(logMod, 'warn');
			const infoSpy = vi.spyOn(logMod, 'info');
			try {
				const { spinner } = await import('@/ui/spinner');
				const handle = spinner('fetching');
				handle.stop('network down', 1);
				expect(warnSpy).toHaveBeenCalledWith(
					expect.objectContaining({ component: 'spinner' }),
					'network down',
				);
			} finally {
				warnSpy.mockRestore();
				infoSpy.mockRestore();
			}
		});

		it('degraded stop() without finalText falls back to the original label', async () => {
			applyGlobalFlags({ json: true });
			const logMod = await import('@/log');
			const infoSpy = vi.spyOn(logMod, 'info');
			try {
				const { spinner } = await import('@/ui/spinner');
				const handle = spinner('bootstrapping');
				handle.stop();
				// The "stop" call must have emitted the label as-is.
				expect(infoSpy).toHaveBeenCalledWith(
					expect.objectContaining({ component: 'spinner' }),
					'bootstrapping',
				);
			} finally {
				infoSpy.mockRestore();
			}
		});

		it('degraded .message(text) emits through log.info', async () => {
			applyGlobalFlags({ json: true });
			const logMod = await import('@/log');
			const infoSpy = vi.spyOn(logMod, 'info');
			try {
				const { spinner } = await import('@/ui/spinner');
				const handle = spinner('starting');
				handle.message('progress: 50%');
				expect(infoSpy).toHaveBeenCalledWith(
					expect.objectContaining({ component: 'spinner' }),
					'progress: 50%',
				);
			} finally {
				infoSpy.mockRestore();
			}
		});
	});

	describe('withSpinner(label, fn)', () => {
		it('resolves with fn result on success', async () => {
			const { withSpinner } = await import('@/ui/spinner');
			const result = await withSpinner('loading', async () => 42, { success: 'ok' });
			expect(result).toBe(42);
			expect(clackSpinnerHandle.stop).toHaveBeenCalledWith('ok', 0);
		});

		it('rethrows and stops with code=1 on rejection', async () => {
			const { withSpinner } = await import('@/ui/spinner');
			await expect(
				withSpinner('loading', async () => {
					throw new Error('boom');
				}),
			).rejects.toThrow('boom');
			expect(clackSpinnerHandle.stop).toHaveBeenCalledWith('loading', 1);
		});

		it('uses label as the success message when `success` option missing', async () => {
			const { withSpinner } = await import('@/ui/spinner');
			await withSpinner('downloading', async () => undefined);
			expect(clackSpinnerHandle.stop).toHaveBeenCalledWith('downloading', 0);
		});

		it('under --json: still resolves, never touches clack spinner', async () => {
			applyGlobalFlags({ json: true });
			const { withSpinner } = await import('@/ui/spinner');
			const result = await withSpinner('loading', async () => 'hi');
			expect(result).toBe('hi');
			expect(clackSpinnerHandle.start).not.toHaveBeenCalled();
		});
	});
});
