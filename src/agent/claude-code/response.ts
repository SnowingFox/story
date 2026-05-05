/**
 * Parser for `claude --print --output-format json` stdout.
 *
 * Mirrors Go `entire-cli/cmd/entire/cli/agent/claudecode/response.go`.
 *
 * Two response shapes supported:
 * 1. **Legacy**: single object `{"result": "..."}`
 * 2. **New (streaming events)**: array of envelopes
 *    `[{"type":"system",...}, {"type":"result", "result":"..."}]` —
 *    streaming may emit multiple `result` envelopes; the LAST one is final
 *    so we scan backward.
 *
 * @packageDocumentation
 */

interface ResponseEnvelope {
	type?: string;
	/**
	 * Pointer-style discriminator: `null` / missing means "no result field"
	 * (different from `''` which means "empty string result"). Go uses
	 * `*string`; TS uses `string | null | undefined` — `typeof === 'string'`
	 * is the equivalent of Go's `Result != nil` check.
	 */
	result?: string | null;
}

/**
 * Parse `claude --print --output-format json` stdout into a single result string.
 *
 * Accepts `Uint8Array` (raw subprocess stdout) or `string` (already decoded).
 * Empty string `''` is a valid result (Claude returned an empty completion).
 *
 * Branch order — matches Go exactly:
 * 1. Try parse as a single object envelope. If `typeof result === 'string'`,
 *    return it. Falls through to branch 2 if parse fails OR result missing.
 * 2. Try parse as array of envelopes. Scan **backward** for the last
 *    `type === 'result'` envelope with `typeof result === 'string'`.
 * 3. Throw `'unsupported Claude CLI JSON response: missing result item'`
 *    if no array entry matches; throw `'unsupported Claude CLI JSON response: <inner>'`
 *    if the second parse failed too.
 *
 * @example
 * parseGenerateTextResponse('{"result":"hello"}');
 * // → 'hello'
 *
 * parseGenerateTextResponse('{"result":""}');
 * // → ''
 *
 * parseGenerateTextResponse('[{"type":"system"},{"type":"result","result":"hi"}]');
 * // → 'hi'
 *
 * parseGenerateTextResponse('[{"type":"system"},{"type":"info"}]');
 * // throws Error('unsupported Claude CLI JSON response: missing result item')
 *
 * parseGenerateTextResponse('not json');
 * // throws Error('unsupported Claude CLI JSON response: <parse error message>')
 */
export function parseGenerateTextResponse(stdout: Uint8Array | string): string {
	const text = typeof stdout === 'string' ? stdout : new TextDecoder().decode(stdout);

	// Branch 1: try single legacy object envelope.
	// Go: `json.Unmarshal(stdout, &response)` followed by `response.Result != nil`.
	// In TS, parsing a JSON array as `ResponseEnvelope` succeeds (it's typed
	// `unknown`-ish), so we must explicitly reject arrays here.
	try {
		const parsed = JSON.parse(text) as unknown;
		if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
			const single = parsed as ResponseEnvelope;
			if (typeof single.result === 'string') {
				return single.result;
			}
			// Result missing or wrong type → fall through to array branch
			// (matches Go: object parse succeeded but Result == nil → try array).
		}
	} catch {
		// Parse failed → fall through to array branch.
	}

	// Branch 2: array of envelopes — scan BACKWARD for last `type:'result'`
	// with non-null result. Go: `for i := len(responses) - 1; i >= 0; i--`.
	let arr: ResponseEnvelope[];
	try {
		const parsed = JSON.parse(text) as unknown;
		if (!Array.isArray(parsed)) {
			throw new Error('not an array');
		}
		arr = parsed as ResponseEnvelope[];
	} catch (err) {
		throw new Error(`unsupported Claude CLI JSON response: ${(err as Error).message}`, {
			cause: err as Error,
		});
	}

	for (let i = arr.length - 1; i >= 0; i--) {
		const env = arr[i];
		if (env?.type === 'result' && typeof env.result === 'string') {
			return env.result;
		}
	}

	throw new Error('unsupported Claude CLI JSON response: missing result item');
}
