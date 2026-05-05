import { describe, expect, it } from 'vitest';
import { capitalizeFirst, collapseWhitespace, truncateRunes } from '@/stringutil';

describe('collapseWhitespace', () => {
	it.each([
		['hello world', 'hello world'],
		['hello  world', 'hello world'],
		['  hello  world  ', 'hello world'],
		['hello\n\nworld', 'hello world'],
		['hello\t\tworld', 'hello world'],
		['', ''],
		['   ', ''],
		['hello', 'hello'],
		['\n\thello\n\t', 'hello'],
		['a  b  c  d', 'a b c d'],
		['hello\nworld', 'hello world'],
		['hello\n\n\nworld', 'hello world'],
		['hello\tworld', 'hello world'],
		['hello\n\t  world', 'hello world'],
		['  hello world  ', 'hello world'],
		['Fix the bug\nin the login\npage', 'Fix the bug in the login page'],
		['  \n\t  ', ''],
		['hello\r\nworld', 'hello world'],
	])('collapseWhitespace(%j) => %j', (input, expected) => {
		expect(collapseWhitespace(input)).toBe(expected);
	});
});

describe('truncateRunes', () => {
	it.each([
		[['hello', 10, '...'], 'hello'],
		[['hello', 5, '...'], 'hello'],
		[['hello world', 5, '...'], 'he...'],
		[['hello world', 8, '...'], 'hello...'],
		[['', 5, '...'], ''],
		[['hello', 0, '...'], '...'],
		[['hello', 3, ''], 'hel'],
		[['日本語テスト', 4, '…'], '日本語…'],
		[['日本語', 3, '…'], '日本語'],
		[['日本語テスト', 3, '…'], '日本…'],
		[['hello', 2, '...'], '...'],
		[['a', 1, '...'], 'a'],
		[['hello 🎉', 10, '...'], 'hello 🎉'],
		[['hello 🎉 world', 10, '...'], 'hello 🎉...'],
		[['你好世界', 3, '...'], '...'],
		[['你好世界再见', 5, '...'], '你好...'],
		[['hello 世界 🎉 more', 10, '...'], 'hello 世...'],
		[['hello world', 5, ''], 'hello'],
	] as const)('truncateRunes(%j) => %j', ([s, max, suffix], expected) => {
		expect(truncateRunes(s as string, max as number, suffix as string)).toBe(expected);
	});
});

describe('capitalizeFirst', () => {
	it.each([
		['hello', 'Hello'],
		['Hello', 'Hello'],
		['', ''],
		['a', 'A'],
		['A', 'A'],
		['hello world', 'Hello world'],
		['日本語', '日本語'],
		[' hello', ' hello'],
		['über', 'Über'],
		['🎉party', '🎉party'],
		['αβγ', 'Αβγ'],
	])('capitalizeFirst(%j) => %j', (input, expected) => {
		expect(capitalizeFirst(input)).toBe(expected);
	});
});
