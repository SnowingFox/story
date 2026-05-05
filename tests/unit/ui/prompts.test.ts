import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyGlobalFlags, resetGlobalFlagsForTesting } from '@/cli/flags';
import { SilentError } from '@/errors';
import { resetColorOverrideForTesting } from '@/ui/theme';

/** Clack's internal cancel symbol (shared via @clack/core's updateSettings). */
const cancelSymbol = Symbol('clack:cancel');

vi.mock('@clack/prompts', async () => {
	return {
		text: vi.fn(),
		password: vi.fn(),
		select: vi.fn(),
		multiselect: vi.fn(),
		confirm: vi.fn(),
		isCancel: (v: unknown) => v === cancelSymbol,
	};
});

describe('ui/prompts', () => {
	beforeEach(async () => {
		process.env.STORY_TEST_TTY = '1';
		resetGlobalFlagsForTesting();
		resetColorOverrideForTesting();
		vi.clearAllMocks();
	});

	afterEach(() => {
		resetGlobalFlagsForTesting();
		resetColorOverrideForTesting();
	});

	describe('text', () => {
		it('forwards opts to @clack/prompts.text and returns the value', async () => {
			const clack = await import('@clack/prompts');
			(clack.text as unknown as ReturnType<typeof vi.fn>).mockResolvedValue('alice');
			const { text } = await import('@/ui/prompts');
			const result = await text({ message: 'Name?' });
			expect(result).toBe('alice');
			expect(clack.text).toHaveBeenCalled();
		});

		it('throws SilentError("cancelled") when clack returns cancel symbol', async () => {
			const clack = await import('@clack/prompts');
			(clack.text as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(cancelSymbol);
			const { text } = await import('@/ui/prompts');
			await expect(text({ message: 'Name?' })).rejects.toBeInstanceOf(SilentError);
			await expect(text({ message: 'Name?' })).rejects.toMatchObject({ message: 'cancelled' });
		});

		it('under --yes with defaultValue → returns default without prompting', async () => {
			applyGlobalFlags({ yes: true });
			const clack = await import('@clack/prompts');
			const { text } = await import('@/ui/prompts');
			const result = await text({ message: 'Name?', defaultValue: 'bob' });
			expect(result).toBe('bob');
			expect(clack.text).not.toHaveBeenCalled();
		});

		it('under --yes without defaultValue → throws SilentError', async () => {
			applyGlobalFlags({ yes: true });
			const { text } = await import('@/ui/prompts');
			await expect(text({ message: 'Name?' })).rejects.toBeInstanceOf(SilentError);
		});

		it('under --non-interactive → throws SilentError', async () => {
			applyGlobalFlags({ 'non-interactive': true });
			const { text } = await import('@/ui/prompts');
			await expect(text({ message: 'Name?' })).rejects.toBeInstanceOf(SilentError);
		});
	});

	describe('confirm', () => {
		it('returns clack boolean when accepted', async () => {
			const clack = await import('@clack/prompts');
			(clack.confirm as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(true);
			const { confirm } = await import('@/ui/prompts');
			await expect(confirm({ message: 'Proceed?' })).resolves.toBe(true);
		});

		it('cancel symbol → SilentError', async () => {
			const clack = await import('@clack/prompts');
			(clack.confirm as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(cancelSymbol);
			const { confirm } = await import('@/ui/prompts');
			await expect(confirm({ message: 'Proceed?' })).rejects.toBeInstanceOf(SilentError);
		});

		it('under --yes → returns yesDefault (default true) without prompting', async () => {
			applyGlobalFlags({ yes: true });
			const clack = await import('@clack/prompts');
			const { confirm } = await import('@/ui/prompts');
			await expect(confirm({ message: 'Proceed?' })).resolves.toBe(true);
			expect(clack.confirm).not.toHaveBeenCalled();
		});

		it('under --yes with yesDefault=false → returns false', async () => {
			applyGlobalFlags({ yes: true });
			const { confirm } = await import('@/ui/prompts');
			await expect(confirm({ message: 'Destroy?', yesDefault: false })).resolves.toBe(false);
		});

		it('under --non-interactive without --yes → SilentError', async () => {
			applyGlobalFlags({ 'non-interactive': true });
			const { confirm } = await import('@/ui/prompts');
			await expect(confirm({ message: 'Proceed?' })).rejects.toBeInstanceOf(SilentError);
		});

		it('forwards initialValue: false from yesDefault to clack.confirm', async () => {
			const clack = await import('@clack/prompts');
			(clack.confirm as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(true);
			const { confirm } = await import('@/ui/prompts');
			await confirm({ message: 'Destroy?', yesDefault: false });
			expect(clack.confirm).toHaveBeenCalledWith(
				expect.objectContaining({ initialValue: false, message: 'Destroy?' }),
			);
		});
	});

	describe('select<T>', () => {
		it('returns clack value when accepted', async () => {
			const clack = await import('@clack/prompts');
			(clack.select as unknown as ReturnType<typeof vi.fn>).mockResolvedValue('a');
			const { select } = await import('@/ui/prompts');
			const result = await select({
				message: 'Pick',
				options: [
					{ value: 'a', label: 'A' },
					{ value: 'b', label: 'B' },
				],
			});
			expect(result).toBe('a');
		});

		it('cancel → SilentError', async () => {
			const clack = await import('@clack/prompts');
			(clack.select as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(cancelSymbol);
			const { select } = await import('@/ui/prompts');
			await expect(
				select({
					message: 'Pick',
					options: [{ value: 'a', label: 'A' }],
				}),
			).rejects.toBeInstanceOf(SilentError);
		});

		it('under --yes with initialValue → returns initial without prompting', async () => {
			applyGlobalFlags({ yes: true });
			const clack = await import('@clack/prompts');
			const { select } = await import('@/ui/prompts');
			const result = await select({
				message: 'Pick',
				initialValue: 'b',
				options: [
					{ value: 'a', label: 'A' },
					{ value: 'b', label: 'B' },
				],
			});
			expect(result).toBe('b');
			expect(clack.select).not.toHaveBeenCalled();
		});

		it('under --yes without initialValue → SilentError', async () => {
			applyGlobalFlags({ yes: true });
			const { select } = await import('@/ui/prompts');
			await expect(
				select({
					message: 'Pick',
					options: [
						{ value: 'a', label: 'A' },
						{ value: 'b', label: 'B' },
					],
				}),
			).rejects.toBeInstanceOf(SilentError);
		});
	});

	describe('multiselect<T>', () => {
		it('returns array on success', async () => {
			const clack = await import('@clack/prompts');
			(clack.multiselect as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(['a', 'b']);
			const { multiselect } = await import('@/ui/prompts');
			const result = await multiselect({
				message: 'Pick many',
				options: [
					{ value: 'a', label: 'A' },
					{ value: 'b', label: 'B' },
				],
			});
			expect(result).toEqual(['a', 'b']);
		});

		it('cancel → SilentError', async () => {
			const clack = await import('@clack/prompts');
			(clack.multiselect as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(cancelSymbol);
			const { multiselect } = await import('@/ui/prompts');
			await expect(
				multiselect({
					message: 'Pick',
					options: [{ value: 'a', label: 'A' }],
				}),
			).rejects.toBeInstanceOf(SilentError);
		});

		it('under --yes with initialValues → returns initial', async () => {
			applyGlobalFlags({ yes: true });
			const { multiselect } = await import('@/ui/prompts');
			const result = await multiselect({
				message: 'Pick',
				initialValues: ['a'],
				options: [
					{ value: 'a', label: 'A' },
					{ value: 'b', label: 'B' },
				],
			});
			expect(result).toEqual(['a']);
		});

		it('under --yes without initialValues → SilentError', async () => {
			applyGlobalFlags({ yes: true });
			const { multiselect } = await import('@/ui/prompts');
			await expect(
				multiselect({
					message: 'Pick',
					options: [
						{ value: 'a', label: 'A' },
						{ value: 'b', label: 'B' },
					],
				}),
			).rejects.toBeInstanceOf(SilentError);
		});

		it('under --non-interactive → SilentError', async () => {
			applyGlobalFlags({ 'non-interactive': true });
			const { multiselect } = await import('@/ui/prompts');
			await expect(
				multiselect({
					message: 'Pick',
					options: [{ value: 'a', label: 'A' }],
				}),
			).rejects.toBeInstanceOf(SilentError);
		});

		it('forwards options with hint when provided (SelectOption.hint branch)', async () => {
			const clack = await import('@clack/prompts');
			(clack.multiselect as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(['a']);
			const { multiselect } = await import('@/ui/prompts');
			await multiselect({
				message: 'Pick',
				options: [
					{ value: 'a', label: 'A', hint: 'first' },
					{ value: 'b', label: 'B' },
				],
			});
			const firstCall = (clack.multiselect as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
			if (firstCall === undefined) {
				throw new Error('expected clack.multiselect to have been called once');
			}
			const arg = firstCall[0] as { options: Array<Record<string, unknown>> };
			expect(arg.options[0]).toEqual({ value: 'a', label: 'A', hint: 'first' });
			expect(arg.options[1]).toEqual({ value: 'b', label: 'B' });
			expect(arg.options[1]).not.toHaveProperty('hint');
		});
	});

	describe('password', () => {
		it('returns clack value on success', async () => {
			const clack = await import('@clack/prompts');
			(clack.password as unknown as ReturnType<typeof vi.fn>).mockResolvedValue('secret');
			const { password } = await import('@/ui/prompts');
			const result = await password({ message: 'Token?' });
			expect(result).toBe('secret');
		});

		it('cancel → SilentError', async () => {
			const clack = await import('@clack/prompts');
			(clack.password as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(cancelSymbol);
			const { password } = await import('@/ui/prompts');
			await expect(password({ message: 'Token?' })).rejects.toBeInstanceOf(SilentError);
		});

		it('under --non-interactive → SilentError', async () => {
			applyGlobalFlags({ 'non-interactive': true });
			const { password } = await import('@/ui/prompts');
			await expect(password({ message: 'Token?' })).rejects.toBeInstanceOf(SilentError);
		});
	});
});
