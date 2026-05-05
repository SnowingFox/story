import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { storyDir } from './paths';
import { validateSessionId } from './validation';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogContext {
	sessionId?: string;
	component?: string;
	agent?: string;
}

export interface InitOptions {
	level?: LogLevel;
	sessionId?: string;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

let logFilePath: string | null = null;
let currentLevel: LogLevel = 'info';
let fallbackToStderr = false;
let globalSessionId: string | undefined;

/** Parse a log level string, defaulting to `'info'` for invalid/empty values. */
export function parseLogLevel(s: string): LogLevel {
	const normalized = s.trim().toLowerCase();
	if (normalized === 'warning') {
		return 'warn';
	}
	if (normalized in LEVEL_ORDER) {
		return normalized as LogLevel;
	}
	return 'info';
}

/** Returns true if `s` (case-insensitive, trimmed) is one of the canonical log levels. */
function isValidLogLevel(s: string): boolean {
	const normalized = s.trim().toLowerCase();
	return normalized === 'warning' || normalized in LEVEL_ORDER;
}

/**
 * Initialize the logger. Creates `.story/logs/` and opens the log file for appending.
 *
 * Behaviour matches Go `logging/logger.go: Init` (~80-141):
 *   - If `opts.sessionId` is non-empty, validate via `validateSessionId`; throw on bad input.
 *     (Empty / undefined is allowed — log lines just won't carry a session_id attribute.)
 *   - If `ENTIRE_LOG_LEVEL` is set but doesn't parse to a known level, write a one-line
 *     warning to stderr and fall back to `info` (same wording as Go: "[story] Warning: invalid
 *     log level %q, defaulting to INFO"). Earlier TS silently fell back, so the user never
 *     learned their `LOG_LEVEL=debg` typo had no effect.
 */
export async function init(repoRoot: string, opts?: InitOptions): Promise<void> {
	if (opts?.sessionId !== undefined && opts.sessionId !== '') {
		const err = validateSessionId(opts.sessionId);
		if (err !== null) {
			throw new Error(`invalid session ID for logging: ${err.message}`);
		}
	}

	const envLevel = process.env.ENTIRE_LOG_LEVEL;
	if (envLevel !== undefined && envLevel !== '' && !isValidLogLevel(envLevel)) {
		process.stderr.write(`[story] Warning: invalid log level "${envLevel}", defaulting to INFO\n`);
	}
	currentLevel = opts?.level ?? (envLevel ? parseLogLevel(envLevel) : 'info');
	globalSessionId = opts?.sessionId;
	fallbackToStderr = false;

	const logDir = path.join(storyDir(repoRoot), 'logs');
	try {
		mkdirSync(logDir, { recursive: true, mode: 0o750 });
		logFilePath = path.join(logDir, 'story.log');
		writeFileSync(logFilePath, '', { flag: 'a' });
	} catch {
		logFilePath = null;
		fallbackToStderr = true;
	}
}

/** Close the logger. Idempotent. */
export function close(): void {
	logFilePath = null;
	globalSessionId = undefined;
}

/**
 * Override the active log level. Normally set once by {@link init},
 * but the CLI's `--verbose` / `--log-level` flags need to flip it at
 * runtime after the logger has already been initialized.
 *
 * @example
 * setLevel('debug');   // --verbose path
 * setLevel('error');   // --log-level error
 */
export function setLevel(level: LogLevel): void {
	currentLevel = level;
}

/** Read the active log level — test / introspection helper. */
export function getLevel(): LogLevel {
	return currentLevel;
}

function writeLog(
	level: LogLevel,
	ctx: LogContext,
	msg: string,
	attrs?: Record<string, unknown>,
): void {
	if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel]) {
		return;
	}

	const entry: Record<string, unknown> = {
		time: new Date().toISOString(),
		level: level.toUpperCase(),
		msg,
	};

	if (globalSessionId) {
		entry.session_id = globalSessionId;
	}
	if (ctx.sessionId && !globalSessionId) {
		entry.session_id = ctx.sessionId;
	}
	if (ctx.component) {
		entry.component = ctx.component;
	}
	if (ctx.agent) {
		entry.agent = ctx.agent;
	}
	if (attrs) {
		for (const [k, v] of Object.entries(attrs)) {
			entry[k] = v;
		}
	}

	const line = `${JSON.stringify(entry)}\n`;

	if (logFilePath && !fallbackToStderr) {
		try {
			appendFileSync(logFilePath, line);
		} catch {
			process.stderr.write(line);
		}
	} else {
		process.stderr.write(line);
	}
}

export function debug(ctx: LogContext, msg: string, attrs?: Record<string, unknown>): void {
	writeLog('debug', ctx, msg, attrs);
}

export function info(ctx: LogContext, msg: string, attrs?: Record<string, unknown>): void {
	writeLog('info', ctx, msg, attrs);
}

export function warn(ctx: LogContext, msg: string, attrs?: Record<string, unknown>): void {
	writeLog('warn', ctx, msg, attrs);
}

export function error(ctx: LogContext, msg: string, attrs?: Record<string, unknown>): void {
	writeLog('error', ctx, msg, attrs);
}
