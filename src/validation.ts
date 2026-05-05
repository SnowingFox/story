import { execGit } from './git';

/** Validate that a session ID is non-empty and doesn't contain path separators. */
export function validateSessionId(id: string): Error | null {
	if (id.trim() === '') {
		return new Error('session ID cannot be empty');
	}
	if (id.includes('/') || id.includes('\\')) {
		return new Error(`invalid session ID "${id}": contains path separators`);
	}
	return null;
}

/** Validate a branch name using `git check-ref-format`. */
export async function validateBranchName(name: string, cwd?: string): Promise<Error | null> {
	if (!name) {
		return new Error(`invalid branch name ""`);
	}
	try {
		await execGit(['check-ref-format', '--branch', name], { cwd });
		return null;
	} catch {
		return new Error(`invalid branch name "${name}"`);
	}
}

const pathSafeRegex = /^[a-zA-Z0-9_-]+$/;

/** Validate a tool use ID. Empty is allowed (optional field). */
export function validateToolUseID(id: string): Error | null {
	if (id === '') {
		return null;
	}
	if (!pathSafeRegex.test(id)) {
		return new Error(
			`invalid tool use ID "${id}": must be alphanumeric with underscores/hyphens only`,
		);
	}
	return null;
}

/** Validate an agent ID. Empty is allowed (optional field). */
export function validateAgentID(id: string): Error | null {
	if (id === '') {
		return null;
	}
	if (!pathSafeRegex.test(id)) {
		return new Error(
			`invalid agent ID "${id}": must be alphanumeric with underscores/hyphens only`,
		);
	}
	return null;
}

/** Validate an agent session ID. Empty is NOT allowed (required field). */
export function validateAgentSessionID(id: string): Error | null {
	if (id === '') {
		return new Error('agent session ID cannot be empty');
	}
	if (!pathSafeRegex.test(id)) {
		return new Error(
			`invalid agent session ID "${id}": must be alphanumeric with underscores/hyphens only`,
		);
	}
	return null;
}
