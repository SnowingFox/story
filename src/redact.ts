/**
 * Secret + PII redaction for transcript bytes and JSONL content.
 *
 * Mirrors Go `entire-cli/redact/redact.go` + `pii.go`. Redaction is **layered**
 * — every detector contributes regions; overlapping regions are merged before
 * replacement. Each layer catches different things:
 *
 * 1. **`@secretlint/core` (always on, broad)**: runs secretlint's
 *    `preset-recommend` ruleset (AWS, GCP, Azure, GitHub, OpenAI / Anthropic,
 *    Slack, Stripe, npm, sendgrid, shopify, basic auth, database connection
 *    strings, private keys, 1Password, …). Conservative thresholds — won't
 *    flag obvious placeholders like `AKIAIOSFODNN7EXAMPLE`, but catches
 *    structurally-real leaked credentials with very low false-positive rate.
 *    Updated upstream regularly so we get new rules without code changes.
 * 2. **Pattern rules (always on, focused)**: a curated set of well-known
 *    secret prefixes (AWS, GitHub, OpenAI, Slack, Stripe, Anthropic, Google,
 *    generic `api_key=…` assignments). Catches the loud cases secretlint
 *    intentionally skips because it can't tell a placeholder from a leak —
 *    transcript redaction is fail-closed (false positives are cheap, false
 *    negatives leak credentials), so we err on the side of redacting.
 * 3. **Entropy-based (always on, backstop)**: pulls
 *    `[A-Za-z0-9+_=-]{10,}` candidates out of the input, computes Shannon
 *    entropy per candidate, and redacts when entropy > 4.5. Catches generic
 *    high-entropy tokens that don't match a known prefix (custom JWTs,
 *    raw base64 secrets, random keys, etc.).
 * 4. **PII (opt-in via {@link configurePII})**: email / phone / address.
 *    Defaults to OFF — same as Go's `getPIIConfig() == nil` short-circuit.
 *
 * The replacement token is the bare string `REDACTED` for secrets (matches
 * Go's `RedactedPlaceholder`) and `[REDACTED_<LABEL>]` for PII categories.
 *
 * For JSONL content, redaction is field-aware: ID/path/cwd/dir-style fields
 * and `type: "image"`/`type: "base64"` objects are skipped to avoid
 * destroying structural identifiers and binary-ish content. Fallback for
 * non-JSON lines goes through `redactString` directly.
 *
 * **Async API**: secretlint's `lintSource` is async, so the whole public
 * surface returns `Promise`. All current callers are already async.
 *
 * Public API:
 *
 * - {@link redactBytes} — `Uint8Array → Promise<Uint8Array>` (Go: `Bytes`)
 * - {@link redactJSONLBytes} — `Uint8Array → Promise<{ bytes, replacements }>`
 *   (Go: `JSONLBytes`; the `replacements` counter is TS-side telemetry)
 * - {@link redactString} — `string → Promise<string>` (Go: `String`)
 *
 * Go reference: `entire-cli/redact/redact.go` + `entire-cli/redact/pii.go`.
 */

import { lintSource } from '@secretlint/core';
import { creator as secretlintRecommendPreset } from '@secretlint/secretlint-rule-preset-recommend';
import type { SecretLintCoreConfig } from '@secretlint/types';

const SECRET_CANDIDATE_RE = /[A-Za-z0-9+_=-]{10,}/g;
const ENTROPY_THRESHOLD = 4.5;
const REDACTED_PLACEHOLDER = 'REDACTED';

/**
 * Secretlint config — single preset, all defaults. Computed once and cached.
 */
const SECRETLINT_CONFIG: SecretLintCoreConfig = {
	rules: [
		{
			id: '@secretlint/secretlint-rule-preset-recommend',
			rule: secretlintRecommendPreset,
		},
	],
};

// Characters JSON / C-style string escapes use as the second byte of a `\X`
// pair. If our entropy match begins immediately after a literal `\` and the
// first character is one of these, we trim the leading character to avoid
// turning a valid `\n` (or `\t`, `\u…`, etc.) into `\REDACTED`.
const JSON_ESCAPE_LETTERS = new Set(['n', 't', 'r', 'b', 'f', 'u', '"', '\\', '/']);

interface Region {
	start: number;
	end: number;
	/** Empty for secret regions, non-empty for typed PII regions. */
	label: string;
}

/**
 * High-signal pattern rules. Each rule contributes regions for matches whose
 * first capture group is the secret (or the entire match when no group is
 * defined). Kept narrow on purpose — entropy detection covers the long tail.
 */
interface PatternRule {
	name: string;
	re: RegExp;
}

const PATTERN_RULES: PatternRule[] = [
	{ name: 'aws-access-key', re: /\b(AKIA[0-9A-Z]{16})\b/g },
	{ name: 'aws-temp-key', re: /\b(ASIA[0-9A-Z]{16})\b/g },
	{ name: 'github-token', re: /\b(ghp_[A-Za-z0-9]{30,})\b/g },
	{ name: 'github-oauth', re: /\b(gho_[A-Za-z0-9]{30,})\b/g },
	{ name: 'github-app', re: /\b(ghu_[A-Za-z0-9]{30,})\b/g },
	{ name: 'github-server', re: /\b(ghs_[A-Za-z0-9]{30,})\b/g },
	{ name: 'github-refresh', re: /\b(ghr_[A-Za-z0-9]{30,})\b/g },
	{ name: 'openai', re: /\b(sk-(?:proj-)?[A-Za-z0-9_-]{20,})\b/g },
	{ name: 'anthropic', re: /\b(sk-ant-[A-Za-z0-9_-]{20,})\b/g },
	{ name: 'slack-bot', re: /\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g },
	{ name: 'stripe-secret', re: /\b((?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,})\b/g },
	{ name: 'google-api', re: /\b(AIza[0-9A-Za-z_-]{35})\b/g },
	{
		name: 'jwt',
		re: /\b(eyJ[A-Za-z0-9_=-]{10,}\.eyJ[A-Za-z0-9_=-]{10,}\.[A-Za-z0-9_=-]{10,})\b/g,
	},
	// `api_key="…"` / `api_key=…` assignments — capture only the value.
	{
		name: 'generic-assignment',
		re: /(?:api[_-]?key|secret|token|password|passwd|pwd)\s*[:=]\s*["']?([A-Za-z0-9+/_=-]{8,})["']?/gi,
	},
];

/** Field names that should never be scanned for secrets in JSONL objects. */
const SKIP_JSONL_FIELDS_EXACT = new Set(['signature']);
const SKIP_JSONL_FIELDS_LITERAL = new Set([
	'filepath',
	'file_path',
	'cwd',
	'root',
	'directory',
	'dir',
	'path',
]);

/** PII detector configuration; off by default (matches Go's nil-guard). */
export interface PIIConfig {
	enabled: boolean;
	categories: Partial<Record<'email' | 'phone' | 'address', boolean>>;
	/** Custom `{label: regex-source}` patterns; produce `[REDACTED_<LABEL>]`. */
	customPatterns?: Record<string, string>;
}

let piiConfig: PIIConfig | null = null;

/**
 * Install (or replace) the global PII detector configuration.
 *
 * Off by default — call this once at startup if your deployment opts into
 * PII redaction. Mirrors Go `ConfigurePII`.
 */
export function configurePII(cfg: PIIConfig | null): void {
	piiConfig = cfg;
}

/** Test-only helper to clear the PII config between cases. */
export function _resetPIIConfigForTests(): void {
	piiConfig = null;
}

const EMAIL_RE = /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g;
const PHONE_RE =
	/(?:\+1[-.\s]?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}|(?:1[-\s])?\(\d{3}\)\s?\d{3}[-.\s]?\d{4}|(?:1[-\s])?\d{3}[-\s]\d{3}[-\s]\d{4})/g;
const ADDRESS_RE =
	/\d{1,5}\s+[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*\s+(?:St(?:reet)?|Ave(?:nue)?|Blvd|Boulevard|Dr(?:ive)?|Ln|Lane|Rd|Road|Ct|Court|Pl(?:ace)?|Way|Cir(?:cle)?|Ter(?:race)?|Pkwy|Parkway)\.?/g;

const EMAIL_ALLOW_PATTERNS = [
	'noreply@',
	'actions@',
	'@users.noreply.github.com',
	'@noreply.github.com',
];

function isAllowlistedEmail(email: string): boolean {
	const lower = email.toLowerCase();
	for (const pat of EMAIL_ALLOW_PATTERNS) {
		const lp = pat.toLowerCase();
		if (pat.startsWith('@')) {
			if (lower.endsWith(lp)) {
				return true;
			}
		} else if (pat.endsWith('@')) {
			if (lower.startsWith(lp)) {
				return true;
			}
		} else if (lower === lp) {
			return true;
		}
	}
	return false;
}

interface BuiltinPIIPattern {
	category: 'email' | 'phone' | 'address';
	label: string;
	re: RegExp;
}

const BUILTIN_PII_PATTERNS: BuiltinPIIPattern[] = [
	{ category: 'email', label: 'EMAIL', re: EMAIL_RE },
	{ category: 'phone', label: 'PHONE', re: PHONE_RE },
	{ category: 'address', label: 'ADDRESS', re: ADDRESS_RE },
];

function detectPIIRegions(s: string): Region[] {
	const cfg = piiConfig;
	if (cfg === null || !cfg.enabled) {
		return [];
	}
	const out: Region[] = [];
	for (const pat of BUILTIN_PII_PATTERNS) {
		if (cfg.categories[pat.category] !== true) {
			continue;
		}
		for (const m of s.matchAll(pat.re)) {
			const start = m.index ?? 0;
			const end = start + m[0].length;
			if (pat.label === 'EMAIL' && isAllowlistedEmail(s.slice(start, end))) {
				continue;
			}
			out.push({ start, end, label: pat.label });
		}
	}
	if (cfg.customPatterns !== undefined) {
		for (const [label, source] of Object.entries(cfg.customPatterns)) {
			let re: RegExp;
			try {
				re = new RegExp(source, 'g');
			} catch {
				continue;
			}
			for (const m of s.matchAll(re)) {
				const start = m.index ?? 0;
				const end = start + m[0].length;
				out.push({ start, end, label: label.toUpperCase() });
			}
		}
	}
	return out;
}

/**
 * Shannon entropy (base-2) of `s`, computed byte-wise. Identical contract to
 * Go's `shannonEntropy`: the input is treated as a UTF-8 byte sequence and
 * each byte is counted independently.
 */
export function shannonEntropy(s: string): number {
	if (s.length === 0) {
		return 0;
	}
	const bytes = new TextEncoder().encode(s);
	const freq = new Map<number, number>();
	for (const b of bytes) {
		freq.set(b, (freq.get(b) ?? 0) + 1);
	}
	const total = bytes.length;
	let entropy = 0;
	for (const count of freq.values()) {
		const p = count / total;
		entropy -= p * Math.log2(p);
	}
	return entropy;
}

function detectEntropyRegions(s: string): Region[] {
	const out: Region[] = [];
	for (const m of s.matchAll(SECRET_CANDIDATE_RE)) {
		let start = m.index ?? 0;
		const end = start + m[0].length;

		// Preserve JSON / C-style escape sequences (avoid producing `\REDACTED`
		// from a match that began at the byte after a literal backslash).
		if (start > 0 && s[start - 1] === '\\') {
			const ch = s[start];
			if (ch !== undefined && JSON_ESCAPE_LETTERS.has(ch)) {
				start += 1;
				if (end - start < 10) {
					continue;
				}
			}
		}

		if (shannonEntropy(s.slice(start, end)) > ENTROPY_THRESHOLD) {
			out.push({ start, end, label: '' });
		}
	}
	return out;
}

function detectPatternRegions(s: string): Region[] {
	const out: Region[] = [];
	for (const rule of PATTERN_RULES) {
		for (const m of s.matchAll(rule.re)) {
			// Prefer capture group 1 if present (so `api_key="value"` only
			// redacts `value`, not the whole assignment).
			const captured = m[1] ?? m[0];
			const matchStart = m.index ?? 0;
			const inMatchOffset = m[0].indexOf(captured);
			const start = matchStart + (inMatchOffset >= 0 ? inMatchOffset : 0);
			const end = start + captured.length;
			out.push({ start, end, label: '' });
		}
	}
	return out;
}

/**
 * Run secretlint over `s` and convert each finding's `range` into a Region.
 *
 * secretlint's `lintSource` operates on UTF-8 *strings* and returns ranges
 * as `[startIndex, endIndex)` over the original input. We treat every
 * message as a secret region (label = '') — secretlint itself decides
 * what's a secret vs a placeholder, and its rule set is conservative
 * enough that any positive is worth redacting.
 *
 * Skips the call when `s` is empty (saves the lintSource startup cost).
 */
async function detectSecretlintRegions(s: string): Promise<Region[]> {
	if (s.length === 0) {
		return [];
	}
	const result = await lintSource({
		source: {
			filePath: 'transcript.txt',
			content: s,
			contentType: 'text',
		},
		options: { config: SECRETLINT_CONFIG, noPhysicFilePath: true },
	});
	const regions: Region[] = [];
	for (const m of result.messages) {
		// `range` is `[start, end]`; secretlint guarantees non-empty range
		// for every reported secret.
		const start = m.range[0];
		const end = m.range[1];
		if (end > start) {
			regions.push({ start, end, label: '' });
		}
	}
	return regions;
}

function replacementToken(label: string): string {
	if (label === '') {
		return REDACTED_PLACEHOLDER;
	}
	return `[REDACTED_${label}]`;
}

/**
 * Apply `regions` to `s` by replacing each region with its replacement token.
 *
 * Regions are sorted by start ascending; on ties the wider region wins. Any
 * later region that overlaps the running tail is merged into it (label of
 * the earlier / wider region is preserved). Returns `s` unchanged when
 * there are no regions.
 */
function applyRegions(s: string, regions: Region[]): string {
	if (regions.length === 0) {
		return s;
	}
	const sorted = [...regions].sort((a, b) => {
		if (a.start !== b.start) {
			return a.start - b.start;
		}
		if (a.end !== b.end) {
			return b.end - a.end;
		}
		return a.label.localeCompare(b.label);
	});
	const merged: Region[] = [{ ...sorted[0]! }];
	for (let i = 1; i < sorted.length; i++) {
		const r = sorted[i]!;
		const last = merged[merged.length - 1]!;
		if (r.start <= last.end) {
			if (r.end > last.end) {
				last.end = r.end;
			}
			// Earlier / wider region keeps its label.
		} else {
			merged.push({ ...r });
		}
	}

	let out = '';
	let prev = 0;
	for (const r of merged) {
		out += s.slice(prev, r.start);
		out += replacementToken(r.label);
		prev = r.end;
	}
	out += s.slice(prev);
	return out;
}

/**
 * Replace secrets and PII in `s` using all enabled detectors. Returns the
 * input unchanged when no detector flagged anything.
 *
 * Async because secretlint's `lintSource` is async; the other detectors are
 * synchronous and run before the secretlint call so the cost when the input
 * is short / has no secrets is essentially `lintSource` startup only.
 *
 * @example
 * ```ts
 * await redactString('AWS key AKIAIOSFODNN7EXAMPLE in code')
 * // 'AWS key REDACTED in code'
 *
 * await redactString('plain prose with no secrets')
 * // 'plain prose with no secrets'  (returns input by reference)
 * ```
 */
export async function redactString(s: string): Promise<string> {
	const regions = [
		...detectEntropyRegions(s),
		...detectPatternRegions(s),
		...detectPIIRegions(s),
		...(await detectSecretlintRegions(s)),
	];
	return applyRegions(s, regions);
}

function bytesToString(b: Uint8Array): string {
	return new TextDecoder('utf-8', { fatal: false }).decode(b);
}

/**
 * Run secret + PII redaction over raw bytes. Returns the input array
 * reference when no replacements were made (Go parity for the same shape).
 *
 * @example
 * ```ts
 * const cleaned = await redactBytes(new TextEncoder().encode('OPENAI_API_KEY=sk-proj-abc...'))
 * // bytes contain `OPENAI_API_KEY=REDACTED`
 *
 * const same = await redactBytes(new TextEncoder().encode('hello world'))
 * // returns the same Uint8Array reference (no allocation)
 * ```
 */
export async function redactBytes(b: Uint8Array): Promise<Uint8Array> {
	if (b.length === 0) {
		return b;
	}
	const s = bytesToString(b);
	const redacted = await redactString(s);
	if (redacted === s) {
		return b;
	}
	return new TextEncoder().encode(redacted);
}

interface JSONLReplacementCollector {
	pairs: Map<string, string>;
}

function shouldSkipJSONLField(key: string): boolean {
	if (SKIP_JSONL_FIELDS_EXACT.has(key)) {
		return true;
	}
	const lower = key.toLowerCase();
	if (lower.endsWith('id') || lower.endsWith('ids')) {
		return true;
	}
	return SKIP_JSONL_FIELDS_LITERAL.has(lower);
}

function shouldSkipJSONLObject(obj: Record<string, unknown>): boolean {
	const t = obj.type;
	if (typeof t !== 'string') {
		return false;
	}
	return t.startsWith('image') || t === 'base64';
}

/**
 * Walk the parsed JSON value tree and gather every distinct string value
 * that's eligible for redaction (not under a skipped field, not inside an
 * `image`/`base64` payload). Sync — caller batches the redaction itself.
 */
function collectJSONLCandidates(value: unknown, out: Set<string>): void {
	if (value === null || value === undefined) {
		return;
	}
	if (Array.isArray(value)) {
		for (const child of value) {
			collectJSONLCandidates(child, out);
		}
		return;
	}
	if (typeof value === 'object') {
		const obj = value as Record<string, unknown>;
		if (shouldSkipJSONLObject(obj)) {
			return;
		}
		for (const [k, child] of Object.entries(obj)) {
			if (shouldSkipJSONLField(k)) {
				continue;
			}
			collectJSONLCandidates(child, out);
		}
		return;
	}
	if (typeof value === 'string') {
		out.add(value);
	}
}

/**
 * Run `redactString` on each unique candidate and return the
 * `(original, redacted)` pairs that actually changed. Pairs are inserted
 * into `acc.pairs` so caller-side de-duplication is preserved across
 * multiple JSONL lines.
 */
async function collectJSONLReplacementsForCandidates(
	candidates: Set<string>,
	acc: JSONLReplacementCollector,
): Promise<void> {
	for (const value of candidates) {
		if (acc.pairs.has(value)) {
			continue;
		}
		const redacted = await redactString(value);
		if (redacted !== value) {
			acc.pairs.set(value, redacted);
		}
	}
}

/**
 * Encode `s` as a JSON string literal (with surrounding quotes), matching
 * Go's `json.Encoder` with HTML escaping disabled. Used so we can replace
 * the encoded form of a sensitive value inside a raw JSON line without
 * re-serialising the entire object.
 */
function jsonEncodeString(s: string): string {
	// `JSON.stringify` does not HTML-escape `<`, `>`, `&` or U+2028/U+2029,
	// matching Go's `enc.SetEscapeHTML(false)` behaviour for our use.
	return JSON.stringify(s);
}

function applyJSONReplacements(line: string, pairs: Map<string, string>): string {
	if (pairs.size === 0) {
		return line;
	}
	let out = line;
	for (const [orig, redacted] of pairs) {
		const origJSON = jsonEncodeString(orig);
		const replJSON = jsonEncodeString(redacted);
		if (origJSON === replJSON) {
			continue;
		}
		out = out.split(origJSON).join(replJSON);
	}
	return out;
}

async function redactJSONLString(content: string): Promise<{ text: string; replacements: number }> {
	// Try parsing the entire content as a single JSON value first (for
	// pretty-printed multi-line JSON). Single-value mode preserves field-aware
	// skipping that would otherwise be lost when falling back to a per-line
	// text scan that can corrupt high-entropy IDs.
	const trimmed = content.trim();
	if (trimmed.length > 0) {
		try {
			const parsed = JSON.parse(trimmed);
			const candidates = new Set<string>();
			collectJSONLCandidates(parsed, candidates);
			const acc: JSONLReplacementCollector = { pairs: new Map() };
			await collectJSONLReplacementsForCandidates(candidates, acc);
			const out = applyJSONReplacements(content, acc.pairs);
			return { text: out, replacements: acc.pairs.size };
		} catch {
			// Not a single JSON value — fall through to JSONL line-by-line.
		}
	}

	const lines = content.split('\n');
	const outLines: string[] = [];
	let totalReplacements = 0;
	for (const line of lines) {
		const lineTrimmed = line.trim();
		if (lineTrimmed === '') {
			outLines.push(line);
			continue;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(lineTrimmed);
		} catch {
			const before = line;
			const after = await redactString(line);
			if (after !== before) {
				totalReplacements += 1;
			}
			outLines.push(after);
			continue;
		}
		const candidates = new Set<string>();
		collectJSONLCandidates(parsed, candidates);
		const acc: JSONLReplacementCollector = { pairs: new Map() };
		await collectJSONLReplacementsForCandidates(candidates, acc);
		outLines.push(applyJSONReplacements(line, acc.pairs));
		totalReplacements += acc.pairs.size;
	}
	return { text: outLines.join('\n'), replacements: totalReplacements };
}

/**
 * Redact secrets in JSONL bytes with field-aware scanning.
 *
 * Each line is parsed as JSON; ID-like / path-like fields and
 * `type: "image"|"base64"` objects are skipped to avoid mangling structural
 * identifiers and binary payloads. Lines that fail to parse fall back to
 * `redactString`.
 *
 * Returns `{ bytes, replacements }`. `bytes` is the input reference when no
 * replacements were made; `replacements` is the number of distinct
 * (original, redacted) string pairs applied (TS-side telemetry — not part
 * of the Go contract).
 *
 * @example
 * ```ts
 * const { bytes, replacements } = await redactJSONLBytes(transcriptBytes)
 * if (replacements > 0) console.log(`scrubbed ${replacements} secrets`)
 * ```
 */
export async function redactJSONLBytes(
	b: Uint8Array,
): Promise<{ bytes: Uint8Array; replacements: number }> {
	if (b.length === 0) {
		return { bytes: b, replacements: 0 };
	}
	const s = bytesToString(b);
	const { text, replacements } = await redactJSONLString(s);
	if (text === s) {
		return { bytes: b, replacements: 0 };
	}
	return { bytes: new TextEncoder().encode(text), replacements };
}
