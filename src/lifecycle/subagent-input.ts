/**
 * Extract `subagent_type` + `description` from a Task tool_input JSON payload.
 *
 * Mirrors Go `hooks.go: ParseSubagentTypeAndDescription`.
 *
 * Returns `['', '']` on null / empty / non-JSON / non-object / missing fields
 * (no throw; callers need a best-effort extraction — the subagent-start /
 * subagent-end handlers fall back to generic labels when these are missing).
 *
 * @packageDocumentation
 */

/**
 * Parse `tool_input` and return the `[subagent_type, description]` tuple.
 *
 * Accepts `Uint8Array | string | null` to align with Go's `[]byte` input and
 * the framework's hook payload shape (raw bytes from stdin or an already-
 * decoded JSON string).
 *
 * Mirrors Go `hooks.go: ParseSubagentTypeAndDescription`.
 *
 * @example
 * parseSubagentTypeAndDescription(JSON.stringify({ subagent_type: 'coder', description: 'fix lint' }));
 * // → ['coder', 'fix lint']
 *
 * parseSubagentTypeAndDescription('');            // → ['', '']
 * parseSubagentTypeAndDescription(null);          // → ['', '']
 * parseSubagentTypeAndDescription('not json');    // → ['', '']
 * parseSubagentTypeAndDescription('{}');          // → ['', '']
 * parseSubagentTypeAndDescription('"bare"');      // → ['', '']  (non-object)
 */
export function parseSubagentTypeAndDescription(
	toolInput: Uint8Array | string | null,
): [string, string] {
	if (toolInput === null || toolInput === undefined) {
		return ['', ''];
	}
	const text = typeof toolInput === 'string' ? toolInput : new TextDecoder().decode(toolInput);
	if (text === '') {
		return ['', ''];
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return ['', ''];
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		return ['', ''];
	}
	const obj = parsed as { subagent_type?: unknown; description?: unknown };
	const subagentType = typeof obj.subagent_type === 'string' ? obj.subagent_type : '';
	const description = typeof obj.description === 'string' ? obj.description : '';
	return [subagentType, description];
}
