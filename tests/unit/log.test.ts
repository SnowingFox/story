import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as log from '@/log';
import { TestEnv } from '../helpers/test-env';

describe('log', () => {
	let env: TestEnv;

	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
		delete process.env.ENTIRE_LOG_LEVEL;
	});

	afterEach(async () => {
		log.close();
		await env.cleanup();
		delete process.env.ENTIRE_LOG_LEVEL;
	});

	it('init creates log directory', async () => {
		await log.init(env.dir);
		const stat = await fs.stat(path.join(env.dir, '.story', 'logs'));
		expect(stat.isDirectory()).toBe(true);
	});

	it('init creates log file', async () => {
		await log.init(env.dir);
		log.info({}, 'test message');
		log.close();
		const stat = await fs.stat(path.join(env.dir, '.story', 'logs', 'story.log'));
		expect(stat.isFile()).toBe(true);
	});

	it('writes JSON log lines', async () => {
		await log.init(env.dir);
		log.info({}, 'hello world');
		log.close();

		const content = await fs.readFile(path.join(env.dir, '.story', 'logs', 'story.log'), 'utf-8');
		const lines = content.trim().split('\n');
		expect(lines.length).toBeGreaterThanOrEqual(1);

		const parsed = JSON.parse(lines[lines.length - 1]!);
		expect(parsed.level).toBe('INFO');
		expect(parsed.msg).toBe('hello world');
		expect(parsed.time).toBeDefined();
	});

	it('respects log level filtering', async () => {
		await log.init(env.dir, { level: 'warn' });
		log.info({}, 'should be filtered');
		log.warn({}, 'should appear');
		log.close();

		const content = await fs.readFile(path.join(env.dir, '.story', 'logs', 'story.log'), 'utf-8');
		const lines = content.trim().split('\n').filter(Boolean);
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0]!).msg).toBe('should appear');
	});

	it('includes context fields', async () => {
		await log.init(env.dir);
		log.info({ sessionId: 'ses-123', component: 'hooks', agent: 'claude-code' }, 'ctx test');
		log.close();

		const content = await fs.readFile(path.join(env.dir, '.story', 'logs', 'story.log'), 'utf-8');
		const parsed = JSON.parse(content.trim().split('\n').pop()!);
		expect(parsed.session_id).toBe('ses-123');
		expect(parsed.component).toBe('hooks');
		expect(parsed.agent).toBe('claude-code');
	});

	it('includes additional attrs', async () => {
		await log.init(env.dir);
		log.info({}, 'with attrs', { duration_ms: 42, file_count: 3 });
		log.close();

		const content = await fs.readFile(path.join(env.dir, '.story', 'logs', 'story.log'), 'utf-8');
		const parsed = JSON.parse(content.trim().split('\n').pop()!);
		expect(parsed.duration_ms).toBe(42);
		expect(parsed.file_count).toBe(3);
	});

	it('does not throw when init fails (fallback to stderr)', async () => {
		await fs.writeFile(path.join(env.dir, '.story'), 'blocker');
		await expect(log.init(env.dir)).resolves.toBeUndefined();
		expect(() => log.info({}, 'fallback message')).not.toThrow();
	});

	it('close is idempotent', async () => {
		await log.init(env.dir);
		log.close();
		expect(() => log.close()).not.toThrow();
	});

	it('ENTIRE_LOG_LEVEL env overrides default level', async () => {
		process.env.ENTIRE_LOG_LEVEL = 'error';
		await log.init(env.dir);
		log.warn({}, 'filtered out');
		log.error({}, 'visible');
		log.close();

		const content = await fs.readFile(path.join(env.dir, '.story', 'logs', 'story.log'), 'utf-8');
		const lines = content.trim().split('\n').filter(Boolean);
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0]!).level).toBe('ERROR');
	});

	// E.1 Go parity: invalid sessionId throws (not silently used).
	// Go reference: logging/logger.go:81-86 ValidateSessionID + wrap as
	// "invalid session ID for logging".
	it('init rejects invalid sessionId (matches Go)', async () => {
		// validateSessionId rejects strings containing path separators.
		await expect(log.init(env.dir, { sessionId: 'sess/with/slash' })).rejects.toThrow(
			/invalid session ID for logging/,
		);
	});

	it('init accepts undefined / empty sessionId (per Go contract)', async () => {
		await expect(log.init(env.dir)).resolves.toBeUndefined();
		await expect(log.init(env.dir, { sessionId: '' })).resolves.toBeUndefined();
	});

	// E.1 Go parity: invalid LOG_LEVEL emits stderr warning (not silent fallback).
	// Go reference: logging/logger.go:108-111 invalid level warn + default to INFO.
	it('init warns to stderr on invalid ENTIRE_LOG_LEVEL', async () => {
		process.env.ENTIRE_LOG_LEVEL = 'debg'; // typo
		const writes: string[] = [];
		const original = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((chunk: string | Uint8Array): boolean => {
			writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
			return true;
		}) as typeof process.stderr.write;
		try {
			await log.init(env.dir);
		} finally {
			process.stderr.write = original;
		}
		expect(writes.some((s) => s.includes('invalid log level "debg"'))).toBe(true);
	});

	it('init does NOT warn for empty / unset LOG_LEVEL', async () => {
		// Already deleted in beforeEach
		const writes: string[] = [];
		const original = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((chunk: string | Uint8Array): boolean => {
			writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
			return true;
		}) as typeof process.stderr.write;
		try {
			await log.init(env.dir);
		} finally {
			process.stderr.write = original;
		}
		expect(writes.some((s) => s.includes('invalid log level'))).toBe(false);
	});
});

describe('parseLogLevel', () => {
	it('parses valid levels', () => {
		expect(log.parseLogLevel('debug')).toBe('debug');
		expect(log.parseLogLevel('info')).toBe('info');
		expect(log.parseLogLevel('warn')).toBe('warn');
		expect(log.parseLogLevel('error')).toBe('error');
	});

	it('is case-insensitive', () => {
		expect(log.parseLogLevel('DEBUG')).toBe('debug');
		expect(log.parseLogLevel('WARNING')).toBe('warn');
	});

	it('defaults to info for invalid/empty input', () => {
		expect(log.parseLogLevel('')).toBe('info');
		expect(log.parseLogLevel('invalid')).toBe('info');
	});
});
