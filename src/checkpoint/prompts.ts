/**
 * Helpers for serializing and deserializing the `prompt.txt` file used inside
 * checkpoint trees. Multiple user prompts are concatenated with a canonical
 * separator so a single text file can hold them all.
 *
 * Go reference: `entire-cli/cmd/entire/cli/checkpoint/prompts.go`.
 */

/** Canonical separator used in `prompt.txt` between consecutive prompts. */
export const PROMPT_SEPARATOR = '\n\n---\n\n';

/**
 * Serialize prompts to `prompt.txt` format.
 *
 * @example
 * ```ts
 * joinPrompts(['hello', 'world'])
 *   // 'hello\n\n---\n\nworld'
 *
 * joinPrompts(['only one'])
 *   // 'only one'   (no separator if just one prompt)
 *
 * joinPrompts([])
 *   // ''           (empty input → empty string)
 * ```
 */
export function joinPrompts(prompts: string[]): string {
	return prompts.join(PROMPT_SEPARATOR);
}

/**
 * Deserialize `prompt.txt` content into individual prompts.
 *
 * Empty input returns an empty array. Trailing empty entries (caused by a
 * trailing separator) are stripped to mirror Go's behavior.
 *
 * @example
 * ```ts
 * splitPrompts('hello\n\n---\n\nworld')
 *   // ['hello', 'world']
 *
 * splitPrompts('')
 *   // []           (empty content → empty array)
 *
 * splitPrompts('a\n\n---\n\nb\n\n---\n\n')
 *   // ['a', 'b']   (trailing empty entry stripped)
 *
 * // Round-trip property
 * splitPrompts(joinPrompts(['x', 'y']))   // ['x', 'y']
 * ```
 */
export function splitPrompts(content: string): string[] {
	if (content === '') {
		return [];
	}

	const prompts = content.split(PROMPT_SEPARATOR);
	while (prompts.length > 0 && prompts[prompts.length - 1] === '') {
		prompts.pop();
	}
	return prompts;
}
