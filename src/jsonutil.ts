/**
 * camelCase ↔ snake_case JSON serialization helpers for Go-compatible
 * on-disk metadata.
 *
 * # Background
 *
 * Story CLI shares its on-disk checkpoint format with Entire CLI (Go).
 * Go uses struct tags like `json:"session_id"` so its `json.Marshal`
 * output is snake_case; Go's `json.Unmarshal` reads snake_case into
 * snake_case-tagged fields and silently drops anything else.
 *
 * TypeScript's idiomatic naming convention is camelCase, and our
 * `CommittedMetadata` / `CheckpointSummary` / `Summary` types use
 * camelCase fields throughout. If we just `JSON.stringify` those structs
 * directly, the on-disk JSON has camelCase keys (`"sessionId"`), which
 * Go can't read — and vice versa. The two CLIs then can't share
 * checkpoints, violating the project's "TS rewrite preserves Go on-disk
 * compatibility" promise (AGENTS.md "JSON 字段用 snake_case (与 Go 兼容)，
 * 不做 camelCase 转换" rule).
 *
 * Phase 4.3 v1 + Phase 4.4 v2 both shipped with raw `JSON.stringify`,
 * carrying the bug. `tests/unit/checkpoint-*.test.ts` couldn't catch it
 * because TS-only round-trip works (TS writes camel, TS reads camel).
 * Cross-CLI failure was tracked as
 * [foundation-backlog #25](../docs/ts-rewrite/impl/foundation-backlog.md).
 *
 * # Design
 *
 * Generic deep key conversion was chosen over per-type field maps:
 *
 * - **Less code**: 7 metadata types × ~10 fields each = 70 lines of
 *   per-type maps; a single recursive converter is ~20 lines and
 *   handles all of them plus future additions.
 * - **No drift**: a per-type map can fall out of sync when a new field
 *   gets added; deep conversion stays correct as long as the keys are
 *   plain camelCase.
 * - **Values pass through verbatim**: only object keys are touched, so
 *   string values (file paths, hashes, IDs that contain underscores)
 *   are never mangled. Arrays and nested objects recurse naturally.
 *
 * # Backward compatibility (legacy camelCase data on disk)
 *
 * `snakeToCamel` is a no-op for keys that don't contain `_`. So:
 *
 * - On a fresh checkpoint written by post-fix TS → on-disk JSON has
 *   snake_case keys → `parseMetadataJSON` converts back to camelCase TS.
 * - On a legacy checkpoint written by pre-fix TS → on-disk JSON has
 *   camelCase keys → `parseMetadataJSON` leaves them alone (no `_` to
 *   convert) → callers see camelCase TS as before.
 * - On a Go-written checkpoint → snake_case → `parseMetadataJSON`
 *   converts to camelCase TS.
 *
 * No reader-side migration / schema-version branch needed.
 *
 * # Public API
 *
 * - {@link camelToSnake} / {@link snakeToCamel} — single-key string
 *   transforms (exported for tests + the rare per-key call site)
 * - {@link camelToSnakeKeys} / {@link snakeToCamelKeys} — recursive
 *   deep-conversion of object keys (objects + arrays); values
 *   pass-through
 * - {@link serializeMetadataJSON} — `camelToSnakeKeys + JSON.stringify
 *   (2-space indent) + trailing newline`. Use at every metadata write
 *   site so on-disk format matches Go.
 * - {@link parseMetadataJSON} — `JSON.parse + snakeToCamelKeys`. Use at
 *   every metadata read site so callers see camelCase TS objects.
 *
 * # Out of scope
 *
 * - Generic Go interop for arbitrary JSON: this module is opinionated
 *   for our metadata schema. If you need bidirectional conversion of
 *   user-supplied JSON with reserved keys (e.g. `__proto__`), add
 *   guards then.
 * - JSON Schema / zod validation: callers cast to their TS type after
 *   parsing. Schema validation is the type system's job upstream of
 *   this helper.
 */

const SNAKE_KEY_BOUNDARY = /[A-Z]/g;
const SNAKE_TO_CAMEL_BOUNDARY = /_([a-z0-9])/g;

/**
 * Convert a single camelCase identifier to snake_case.
 *
 * @example
 * ```ts
 * camelToSnake('sessionId')     // 'session_id'
 * camelToSnake('cliVersion')    // 'cli_version'
 * camelToSnake('apiCallCount')  // 'api_call_count'
 * camelToSnake('endLine')       // 'end_line'
 * camelToSnake('already_snake') // 'already_snake'  (no-op)
 * camelToSnake('lower')         // 'lower'          (no-op)
 * ```
 */
export function camelToSnake(key: string): string {
	return key.replace(SNAKE_KEY_BOUNDARY, (m, idx: number) =>
		idx === 0 ? m.toLowerCase() : `_${m.toLowerCase()}`,
	);
}

/**
 * Convert a single snake_case identifier to camelCase.
 *
 * Idempotent for already-camelCase input — used as the read-side
 * pass-through for legacy data still on disk.
 *
 * @example
 * ```ts
 * snakeToCamel('session_id')     // 'sessionId'
 * snakeToCamel('cli_version')    // 'cliVersion'
 * snakeToCamel('api_call_count') // 'apiCallCount'
 * snakeToCamel('sessionId')      // 'sessionId'    (no-op, legacy camel)
 * snakeToCamel('plain')          // 'plain'        (no-op)
 * ```
 */
export function snakeToCamel(key: string): string {
	return key.replace(SNAKE_TO_CAMEL_BOUNDARY, (_, c: string) => c.toUpperCase());
}

/**
 * Recursively convert every object-key in `value` from camelCase to
 * snake_case. Arrays are walked element-wise. Primitives, `null`, and
 * `Date`-likes are returned by reference (never mutated).
 *
 * `value` is **not** mutated; a new object/array is produced at every
 * level that contains keys to convert.
 *
 * @example
 * ```ts
 * camelToSnakeKeys({ sessionId: 's1', tokenUsage: { inputTokens: 10 } })
 * // { session_id: 's1', token_usage: { input_tokens: 10 } }
 *
 * camelToSnakeKeys({ sessions: [{ contentHash: 'h' }] })
 * // { sessions: [{ content_hash: 'h' }] }
 *
 * camelToSnakeKeys('plain string')  // 'plain string'  (passthrough)
 * camelToSnakeKeys(null)            // null            (passthrough)
 * ```
 */
export function camelToSnakeKeys<T>(value: T): T {
	return convertKeys(value, camelToSnake) as T;
}

/**
 * Inverse of {@link camelToSnakeKeys}. Recursively convert every
 * object-key in `value` from snake_case to camelCase. Idempotent for
 * already-camelCase keys (legacy data passes through).
 *
 * @example
 * ```ts
 * snakeToCamelKeys({ session_id: 's1', token_usage: { input_tokens: 10 } })
 * // { sessionId: 's1', tokenUsage: { inputTokens: 10 } }
 *
 * snakeToCamelKeys({ sessionId: 's1', tokenUsage: { inputTokens: 10 } })
 * // { sessionId: 's1', tokenUsage: { inputTokens: 10 } }   (legacy passthrough)
 * ```
 */
export function snakeToCamelKeys<T>(value: T): T {
	return convertKeys(value, snakeToCamel) as T;
}

/**
 * Serialize `value` for on-disk storage in a format Go's `json.Unmarshal`
 * can read: deep-converts camelCase TS keys to snake_case, pretty-prints
 * with 2-space indent, and appends a trailing newline (Go convention).
 *
 * @example
 * ```ts
 * await fs.writeFile('metadata.json',
 *   serializeMetadataJSON({ sessionId: 's1', createdAt: '2026-01-01' }),
 * );
 * // metadata.json contents:
 * // {
 * //   "session_id": "s1",
 * //   "created_at": "2026-01-01"
 * // }
 * // (trailing newline)
 * ```
 */
export function serializeMetadataJSON<T>(value: T): string {
	return `${JSON.stringify(camelToSnakeKeys(value), null, 2)}\n`;
}

/**
 * Parse on-disk JSON written by either Story CLI (snake_case post-fix
 * or legacy camelCase pre-fix) or Entire CLI (snake_case), returning a
 * camelCase TS object.
 *
 * The caller is responsible for the `T` type cast (matches the prior
 * `JSON.parse(text) as T` ergonomics — schema validation is upstream).
 *
 * @example
 * ```ts
 * const meta = parseMetadataJSON<CommittedMetadata>(
 *   '{"session_id": "s1", "created_at": "2026-01-01"}'
 * );
 * // { sessionId: 's1', createdAt: '2026-01-01' }
 *
 * // Legacy camelCase data still readable:
 * parseMetadataJSON<CommittedMetadata>('{"sessionId": "s1"}');
 * // { sessionId: 's1' }
 * ```
 */
export function parseMetadataJSON<T>(text: string): T {
	const parsed: unknown = JSON.parse(text);
	return snakeToCamelKeys(parsed) as T;
}

/**
 * Internal: deep-walk `value` applying `keyFn` to every object key.
 *
 * Behaviour:
 *
 * - `null` / `undefined` / non-object primitives → returned as-is
 * - `Array` → new array with each element converted
 * - plain object (`Object.prototype` constructor) → new object with
 *   every key converted via `keyFn` and every value recursed
 * - non-plain object (Date, Map, Set, Buffer, Uint8Array, class
 *   instances) → returned as-is so we don't accidentally clobber
 *   built-ins. Our metadata types only contain plain objects + arrays
 *   + primitives + ISO date strings, so this branch is just defence in
 *   depth.
 */
function convertKeys(value: unknown, keyFn: (key: string) => string): unknown {
	if (value === null || value === undefined) {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map((v) => convertKeys(v, keyFn));
	}
	if (typeof value !== 'object') {
		return value;
	}
	if (!isPlainObject(value)) {
		return value;
	}
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
		out[keyFn(k)] = convertKeys(v, keyFn);
	}
	return out;
}

/**
 * True when `value` was created by `{}` / `Object.create(null)` /
 * `JSON.parse(...)` — i.e. its prototype is `Object.prototype` or
 * `null`. False for class instances, `Date`, `Map`, `Set`, etc.
 */
function isPlainObject(value: object): boolean {
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}
