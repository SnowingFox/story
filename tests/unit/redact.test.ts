import { afterEach, describe, expect, it } from 'vitest';
import {
	_resetPIIConfigForTests,
	configurePII,
	redactBytes,
	redactJSONLBytes,
	redactString,
	shannonEntropy,
} from '@/redact';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

afterEach(() => {
	_resetPIIConfigForTests();
});

describe('shannonEntropy', () => {
	it('returns 0 for empty input', () => {
		// Go: shannonEntropy("") returns 0 (length-zero short-circuit).
		expect(shannonEntropy('')).toBe(0);
	});

	it('returns 0 for a single repeated byte', () => {
		// One distinct value → -1 * 1 * log2(1) = 0.
		expect(shannonEntropy('aaaaaaaa')).toBe(0);
	});

	it('returns log2(n) for n distinct equiprobable bytes', () => {
		// Two bytes, each with p=0.5 → -2 * 0.5 * log2(0.5) = 1.
		expect(shannonEntropy('ab')).toBeCloseTo(1, 10);
		// Four distinct bytes equally distributed → 2.
		expect(shannonEntropy('abcd')).toBeCloseTo(2, 10);
	});

	it('flags random base64-style strings above the 4.5 threshold', () => {
		// Real random tokens (full alphabet usage) clear 4.5 comfortably; the
		// shorter / repetitive AWS key shape only clears 3.7 and is caught by
		// the pattern detector instead.
		expect(shannonEntropy('aB7xQz92mK1nLp4vR8tY6cWeF3jH0sUgIdX')).toBeGreaterThan(4.5);
	});
});

describe('redactString — entropy detection', () => {
	it('replaces a high-entropy alphanumeric token with REDACTED', async () => {
		const out = await redactString('token=AKIAIOSFODNN7EXAMPLE done');
		expect(out).toContain('REDACTED');
		expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
	});

	it('leaves low-entropy prose unchanged', async () => {
		const s = 'this is a normal sentence with no secrets';
		expect(await redactString(s)).toBe(s);
	});

	it('preserves JSON escape sequences (does not corrupt \\n)', async () => {
		// Without the escape-letter guard, a match starting at "nXXXX" would
		// turn `\n` into `\REDACTED` — invalid JSON escape.
		const input = 'controller.go\\nABCdefGHI012jklmnop';
		const out = await redactString(input);
		expect(out).toContain('\\n');
		expect(out).not.toContain('\\R');
	});
});

describe('redactString — pattern detection', () => {
	it.each([
		['AWS access key', 'AKIAIOSFODNN7EXAMPLE'],
		['GitHub PAT', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
		['OpenAI key', 'sk-proj-abcDEFghiJKLmnoPQRstuVWXyz0123456789'],
		['Anthropic key', 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv'],
		['Slack bot token', 'xoxb-1234567890-abcdefghijklmno'],
		['Stripe secret', 'sk_live_abcdefghijklmnopqrstuvwx'],
	])('redacts %s', async (_label, secret) => {
		const out = await redactString(`prefix ${secret} suffix`);
		expect(out).not.toContain(secret);
		expect(out).toContain('REDACTED');
	});

	it('captures the value of an api_key= assignment, not the key name', async () => {
		const out = await redactString('api_key="abcDEFghi123JKLmno"');
		expect(out).toContain('api_key=');
		expect(out).not.toContain('abcDEFghi123JKLmno');
		expect(out).toContain('REDACTED');
	});
});

describe('redactString — secretlint integration (broad coverage)', () => {
	// secretlint catches things our hand-rolled patterns / entropy detector
	// don't have rules for. These tests confirm secretlint is actually
	// wired into the layer stack — replacing the upstream preset would be
	// caught here.

	it('redacts an inline RSA private key block via the secretlint rule', async () => {
		// secretlint's privatekey rule needs a realistically-shaped PEM body
		// (no `fake` strings or other non-base64 chars). The exact body is
		// from a discarded test key; never used in production.
		const pem = [
			'-----BEGIN RSA PRIVATE KEY-----',
			'MIIEpAIBAAKCAQEAt5Y0vC+TqoJgM6cVZTxK3qLdJ5fJzBcQwXZkQs8K7dBVFWqU',
			'vGaR5pBbJqJxLqQfnMzN9pYQLjkXlR6vBd/nQvCnT8NhMqW6ZLPhV2qVZ5HaJ4Bk',
			'-----END RSA PRIVATE KEY-----',
		].join('\n');
		const out = await redactString(pem);
		expect(out).toContain('REDACTED');
		expect(out).not.toContain('MIIEpAIBAAKCAQEAt5Y0vC');
	});

	it('redacts a real-format GitHub token (secretlint github rule)', async () => {
		// secretlint catches `ghp_` tokens with realistic char distribution
		// where our prefix-match would also catch them — confirms the
		// secretlint layer ALSO fires (overlap deduped via region merge).
		const tok = 'ghp_16C7e42F292c6912E7710c838347Ae178B4a';
		const out = await redactString(`PR review: see ${tok} for the details`);
		expect(out).toContain('REDACTED');
		expect(out).not.toContain(tok);
	});

	it('redacts a Slack webhook URL pattern (secretlint slack rule)', async () => {
		const url = 'https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX';
		const out = await redactString(url);
		expect(out).toContain('REDACTED');
		expect(out).not.toContain('XXXXXXXXXXXXXXXXXXXXXXXX');
	});
});

describe('redactString — PII detection (opt-in)', () => {
	it('does not redact email by default', async () => {
		expect(await redactString('contact alice@example.com')).toBe('contact alice@example.com');
	});

	it('redacts emails when category enabled', async () => {
		configurePII({ enabled: true, categories: { email: true } });
		const out = await redactString('contact alice@example.com today');
		expect(out).toContain('[REDACTED_EMAIL]');
		expect(out).not.toContain('alice@example.com');
	});

	it('keeps allowlisted noreply emails when email category enabled', async () => {
		configurePII({ enabled: true, categories: { email: true } });
		expect(await redactString('from noreply@example.com')).toContain('noreply@example.com');
		expect(await redactString('user 12345+bob@users.noreply.github.com')).toContain(
			'@users.noreply.github.com',
		);
	});

	it('redacts phone numbers when category enabled', async () => {
		configurePII({ enabled: true, categories: { phone: true } });
		const out = await redactString('call 415-555-1212 now');
		expect(out).toContain('[REDACTED_PHONE]');
		expect(out).not.toContain('415-555-1212');
	});

	it('does not flag IP addresses or version numbers as phone numbers', async () => {
		configurePII({ enabled: true, categories: { phone: true } });
		expect(await redactString('server 192.168.1.42')).toContain('192.168.1.42');
		expect(await redactString('v1.234.567.8901')).toContain('1.234.567.8901');
	});

	it('honours custom patterns with uppercased label', async () => {
		configurePII({
			enabled: true,
			categories: {},
			customPatterns: { employee_id: 'EMP-\\d{6}' },
		});
		const out = await redactString('hi EMP-123456');
		expect(out).toContain('[REDACTED_EMPLOYEE_ID]');
		expect(out).not.toContain('EMP-123456');
	});
});

describe('redactBytes', () => {
	it('returns the input reference when nothing changes', async () => {
		const input = enc('plain text');
		const out = await redactBytes(input);
		expect(out).toBe(input);
	});

	it('returns a new array with the secret removed', async () => {
		const out = await redactBytes(enc('AKIAIOSFODNN7EXAMPLE secret'));
		expect(dec(out)).toContain('REDACTED');
		expect(dec(out)).not.toContain('AKIAIOSFODNN7EXAMPLE');
	});

	it('handles empty input cleanly', async () => {
		const empty = new Uint8Array();
		expect(await redactBytes(empty)).toBe(empty);
	});
});

describe('redactJSONLBytes — field-aware', () => {
	it('redacts secret-shaped string values', async () => {
		const line = JSON.stringify({ env: 'API_KEY=AKIAIOSFODNN7EXAMPLE' });
		const { bytes, replacements } = await redactJSONLBytes(enc(line));
		expect(replacements).toBeGreaterThan(0);
		expect(dec(bytes)).toContain('REDACTED');
		expect(dec(bytes)).not.toContain('AKIAIOSFODNN7EXAMPLE');
	});

	it('skips ID fields even when they look high-entropy', async () => {
		// Long random-looking IDs would otherwise hit entropy detection — the
		// field-aware skip is what lets agent transcripts retain message_id /
		// session_id / tool_use_id values.
		const line = JSON.stringify({
			id: 'abcDEFghi123JKLmnoPQR',
			session_id: 'xyz9876543210MNOpqrST',
			data: 'AKIAIOSFODNN7EXAMPLE',
		});
		const { bytes } = await redactJSONLBytes(enc(line));
		const out = dec(bytes);
		expect(out).toContain('"abcDEFghi123JKLmnoPQR"');
		expect(out).toContain('"xyz9876543210MNOpqrST"');
		expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
	});

	it('skips path-style fields', async () => {
		const line = JSON.stringify({
			file_path: '/home/user/project/abcDEFghi123JKLmnoPQR',
			cwd: '/abc/DEFghi/123JKL/mnoPQR',
		});
		const { bytes, replacements } = await redactJSONLBytes(enc(line));
		expect(replacements).toBe(0);
		expect(dec(bytes)).toBe(line);
	});

	it('skips type:"image" objects entirely', async () => {
		const line = JSON.stringify({
			type: 'image',
			data: `AAAA${'BCDEFGHIJKLMNOP'.repeat(5)}`,
		});
		const { bytes, replacements } = await redactJSONLBytes(enc(line));
		expect(replacements).toBe(0);
		expect(dec(bytes)).toBe(line);
	});

	it('handles multi-line pretty-printed JSON as a single value', async () => {
		// When the whole content is a single (pretty) JSON value, the
		// single-pass branch keeps the formatting intact.
		const obj = { secret: 'AKIAIOSFODNN7EXAMPLE' };
		const pretty = JSON.stringify(obj, null, 2);
		const { bytes } = await redactJSONLBytes(enc(pretty));
		const out = dec(bytes);
		expect(out).toContain('REDACTED');
		expect(out).toMatchInlineSnapshot(`
			"{
			  "secret": "REDACTED"
			}"
		`);
		expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
		// Pretty indentation preserved.
		expect(out).toContain('\n  ');
	});

	it('falls back to redactString for non-JSON lines', async () => {
		const input = 'not json: AKIAIOSFODNN7EXAMPLE\nalso not json\n';
		const { bytes } = await redactJSONLBytes(enc(input));
		const out = dec(bytes);
		expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
		expect(out).toContain('REDACTED');
	});

	it('returns the input reference when nothing matched', async () => {
		const input = enc('{"safe":"hello"}\n{"also":"ok"}');
		const { bytes, replacements } = await redactJSONLBytes(input);
		expect(bytes).toBe(input);
		expect(replacements).toBe(0);
	});

	it('handles empty input cleanly', async () => {
		const empty = new Uint8Array();
		const { bytes, replacements } = await redactJSONLBytes(empty);
		expect(bytes).toBe(empty);
		expect(replacements).toBe(0);
	});
});
