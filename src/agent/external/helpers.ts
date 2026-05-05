/**
 * Pure helpers for the external agent protocol — stream limiting and hook
 * payload marshalling. Extracted from {@link ./index.ts} for focused unit tests.
 *
 * @packageDocumentation
 */

import type { Readable } from 'node:stream';
import type { HookInput } from '../session';
import type { HookInputJSON } from './types';

/**
 * Read up to `limit` bytes from a Node {@link Readable} stream. Continues
 * draining after the limit to avoid back-pressuring the child process, but
 * discards bytes past `limit`. Returns a Uint8Array.
 */
export async function readLimited(stream: Readable | null, limit: number): Promise<Uint8Array> {
	if (stream === null) {
		return new Uint8Array();
	}
	const chunks: Uint8Array[] = [];
	let total = 0;
	for await (const arr of stream as AsyncIterable<Uint8Array>) {
		if (total >= limit) {
			continue;
		}
		const remaining = limit - total;
		if (arr.length <= remaining) {
			chunks.push(arr);
			total += arr.length;
		} else {
			chunks.push(arr.subarray(0, remaining));
			total += remaining;
		}
	}
	const result = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.length;
	}
	return result;
}

/** Marshals {@link HookInput} to JSON wire shape (snake_case). */
export function marshalHookInput(input: HookInput): HookInputJSON {
	return {
		hook_type: input.hookType,
		session_id: input.sessionId,
		session_ref: input.sessionRef,
		timestamp: input.timestamp.toISOString(),
		user_prompt: input.userPrompt || undefined,
		tool_name: input.toolName || undefined,
		tool_use_id: input.toolUseId || undefined,
		tool_input:
			input.toolInput !== null ? JSON.parse(new TextDecoder().decode(input.toolInput)) : undefined,
		raw_data: Object.keys(input.rawData).length > 0 ? input.rawData : undefined,
	};
}
