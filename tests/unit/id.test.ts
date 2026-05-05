import { describe, expect, it } from 'vitest';
import {
	CHECKPOINT_ID_PATTERN,
	deserialize,
	EMPTY_CHECKPOINT_ID,
	generate,
	isEmpty,
	serialize,
	toPath,
	validate,
} from '@/id';

describe('CheckpointID', () => {
	describe('generate', () => {
		it('generates 12 char hex string', () => {
			const id = generate();
			expect(id).toHaveLength(12);
			expect(id).toMatch(CHECKPOINT_ID_PATTERN);
		});

		it('generates unique IDs', () => {
			const ids = new Set<string>();
			for (let i = 0; i < 100; i++) {
				ids.add(generate());
			}
			expect(ids.size).toBe(100);
		});
	});

	describe('validate', () => {
		it('validates correct ID', () => {
			expect(validate('a3b2c4d5e6f7')).toBeNull();
		});

		it('rejects uppercase', () => {
			expect(validate('A3B2C4D5E6F7')).toBeInstanceOf(Error);
		});

		it('rejects wrong length', () => {
			expect(validate('a3b2c4')).toBeInstanceOf(Error);
		});

		it('rejects non-hex', () => {
			expect(validate('a3b2c4d5e6gz')).toBeInstanceOf(Error);
		});

		it('rejects too long ID', () => {
			expect(validate('a'.repeat(13))).toBeInstanceOf(Error);
		});

		it('empty string is valid empty ID', () => {
			// EMPTY_CHECKPOINT_ID is "" — it does not pass validate (which enforces 12-hex),
			// but it is a valid semantic value meaning "unset".
			expect(EMPTY_CHECKPOINT_ID).toBe('');
			expect(validate('')).toBeInstanceOf(Error);
		});
	});

	describe('toPath', () => {
		it('shards correctly', () => {
			expect(toPath('a3b2c4d5e6f7')).toBe('a3/b2c4d5e6f7');
			expect(toPath('abcdef123456')).toBe('ab/cdef123456');
		});

		it('handles short ID', () => {
			expect(toPath('')).toBe('');
			expect(toPath('a')).toBe('a');
			expect(toPath('ab')).toBe('ab');
			expect(toPath('abc')).toBe('ab/c');
		});
	});

	describe('serialize / deserialize', () => {
		it('serialize returns the underlying string', () => {
			expect(serialize('a3b2c4d5e6f7')).toBe('a3b2c4d5e6f7');
			expect(serialize(EMPTY_CHECKPOINT_ID)).toBe('');
		});

		it('deserialize accepts empty string as EMPTY_CHECKPOINT_ID', () => {
			expect(deserialize('')).toBe(EMPTY_CHECKPOINT_ID);
		});

		it('deserialize accepts valid 12-hex string', () => {
			expect(deserialize('a3b2c4d5e6f7')).toBe('a3b2c4d5e6f7');
		});

		it('deserialize throws on invalid format', () => {
			expect(() => deserialize('A3B2C4D5E6F7')).toThrow(Error);
			expect(() => deserialize('not-hex')).toThrow(Error);
			expect(() => deserialize('a3b2c4')).toThrow(Error);
		});

		it('serialize / deserialize roundtrip', () => {
			const id = generate();
			expect(deserialize(serialize(id))).toBe(id);
		});
	});

	describe('isEmpty (foundation-backlog #13)', () => {
		it('returns true for EMPTY_CHECKPOINT_ID', () => {
			expect(isEmpty(EMPTY_CHECKPOINT_ID)).toBe(true);
		});

		it('returns true for empty string', () => {
			expect(isEmpty('')).toBe(true);
		});

		it('returns false for valid 12-hex id', () => {
			expect(isEmpty('a3b2c4d5e6f7')).toBe(false);
		});

		it('returns false for arbitrary non-empty string', () => {
			// isEmpty is a sentinel check — only `''` is "empty". Other invalid strings
			// are not empty (they fail validate() but isEmpty() still returns false).
			expect(isEmpty('not-an-id')).toBe(false);
		});
	});
});
