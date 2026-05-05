import { randomBytes } from 'node:crypto';

/** 12-character lowercase hex identifier linking commits to checkpoint metadata. */
export type CheckpointID = string;

export const EMPTY_CHECKPOINT_ID = '' as CheckpointID;
export const CHECKPOINT_ID_PATTERN = /^[0-9a-f]{12}$/;
export const SHORT_ID_LENGTH = 12;

/** Generate a new random checkpoint ID (48 bits of entropy). */
export function generate(): CheckpointID {
	return randomBytes(6).toString('hex') as CheckpointID;
}

/**
 * Returns true if `id` is the empty sentinel value ({@link EMPTY_CHECKPOINT_ID}).
 *
 * Mirrors Go `(CheckpointID).IsEmpty()` (`entire-cli/cmd/entire/cli/checkpoint/id/id.go:75-78`).
 * Centralizes the `=== ''` check that's scattered across strategy / checkpoint /
 * resume / explain / trail packages in Go (foundation-backlog #13, Phase 5.1).
 *
 * @example
 * isEmpty('' as CheckpointID)              // => true
 * isEmpty(EMPTY_CHECKPOINT_ID)             // => true
 * isEmpty('a3b2c4d5e6f7' as CheckpointID)  // => false
 */
export function isEmpty(id: CheckpointID): boolean {
	return id === EMPTY_CHECKPOINT_ID;
}

/** Return `null` if `s` is a valid checkpoint ID, or an `Error` describing why not. */
export function validate(s: string): Error | null {
	if (!CHECKPOINT_ID_PATTERN.test(s)) {
		return new Error(`invalid checkpoint ID "${s}": must be 12 lowercase hex characters`);
	}
	return null;
}

/**
 * Convert a checkpoint ID to a sharded path (first 2 chars as directory).
 *
 * @example
 * ```ts
 * toPath('a3b2c4d5e6f7') // 'a3/b2c4d5e6f7'
 * ```
 */
export function toPath(id: CheckpointID): string {
	if (id.length < 3) {
		return id;
	}

	return `${id.slice(0, 2)}/${id.slice(2)}`;
}

/**
 * Serialize a CheckpointID for JSON output. Empty IDs serialize as the empty string.
 * Symmetric with {@link deserialize}; matches Go's `MarshalJSON` semantics.
 */
export function serialize(id: CheckpointID): string {
	return id;
}

/**
 * Deserialize a CheckpointID from a JSON string value. Empty strings yield
 * {@link EMPTY_CHECKPOINT_ID} (semantically "unset"); non-empty values must pass
 * {@link validate} or this throws.
 *
 * Mirrors Go's `(*CheckpointID).UnmarshalJSON` behavior — we keep cross-language
 * compatibility for state files written by either implementation.
 */
export function deserialize(s: string): CheckpointID {
	if (s === '') {
		return EMPTY_CHECKPOINT_ID;
	}
	const err = validate(s);
	if (err) {
		throw err;
	}
	return s as CheckpointID;
}
