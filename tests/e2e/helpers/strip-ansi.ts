/**
 * Strip ANSI SGR sequences from captured CLI / PTY output for stable assertions.
 *
 * Same pattern as `tests/unit/cli/help.test.ts` (ANSI_RE + replace).
 */

const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

/**
 * Remove ANSI color / style escape sequences from `s`.
 */
export function stripAnsi(s: string): string {
	return s.replace(ANSI_RE, '');
}
