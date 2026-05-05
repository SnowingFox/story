import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	validateAgentID,
	validateAgentSessionID,
	validateBranchName,
	validateSessionId,
	validateToolUseID,
} from '@/validation';
import { TestEnv } from '../helpers/test-env';

describe('validateSessionId', () => {
	it('accepts valid session IDs', () => {
		expect(validateSessionId('2024-01-15-abc123')).toBeNull();
		expect(validateSessionId('a1b2c3d4-e5f6-7890-abcd-ef1234567890')).toBeNull();
		expect(validateSessionId('session_with_underscores')).toBeNull();
		expect(validateSessionId('session-with-hyphens')).toBeNull();
	});

	it('rejects empty or whitespace-only IDs', () => {
		expect(validateSessionId('')).toBeInstanceOf(Error);
		expect(validateSessionId('   ')).toBeInstanceOf(Error);
		expect(validateSessionId('\t')).toBeInstanceOf(Error);
	});

	it('rejects IDs with path separators', () => {
		expect(validateSessionId('path/traversal')).toBeInstanceOf(Error);
		expect(validateSessionId('path\\traversal')).toBeInstanceOf(Error);
		expect(validateSessionId('../escape')).toBeInstanceOf(Error);
	});
});

describe('validateBranchName', () => {
	let env: TestEnv;

	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
	});

	afterEach(async () => {
		await env.cleanup();
	});

	it('accepts valid branch names', async () => {
		expect(await validateBranchName('main', env.dir)).toBeNull();
		expect(await validateBranchName('feature/foo', env.dir)).toBeNull();
		expect(await validateBranchName('fix-123', env.dir)).toBeNull();
	});

	it('rejects invalid branch names', async () => {
		expect(await validateBranchName('', env.dir)).toBeInstanceOf(Error);
		expect(await validateBranchName('..', env.dir)).toBeInstanceOf(Error);
		expect(await validateBranchName('bad..name', env.dir)).toBeInstanceOf(Error);
	});
});

describe('validateToolUseID', () => {
	it('accepts empty (optional field)', () => {
		expect(validateToolUseID('')).toBeNull();
	});

	it('accepts valid tool use IDs', () => {
		expect(validateToolUseID('abc-123')).toBeNull();
		expect(validateToolUseID('tool_use_1')).toBeNull();
		expect(validateToolUseID('toolu_abc123')).toBeNull();
	});

	it('rejects IDs with special chars', () => {
		expect(validateToolUseID('path/sep')).toBeInstanceOf(Error);
		expect(validateToolUseID('has space')).toBeInstanceOf(Error);
		expect(validateToolUseID('../escape')).toBeInstanceOf(Error);
	});

	it('rejects IDs with dot', () => {
		expect(validateToolUseID('foo.bar')).toBeInstanceOf(Error);
	});

	it('rejects IDs with null byte', () => {
		expect(validateToolUseID('foo\x00bar')).toBeInstanceOf(Error);
	});
});

describe('validateAgentID', () => {
	it('accepts empty (optional field)', () => {
		expect(validateAgentID('')).toBeNull();
	});

	it('accepts valid agent IDs', () => {
		expect(validateAgentID('claude-code')).toBeNull();
		expect(validateAgentID('cursor')).toBeNull();
		expect(validateAgentID('gemini_cli')).toBeNull();
	});

	it('rejects IDs with special chars', () => {
		expect(validateAgentID('agent/name')).toBeInstanceOf(Error);
		expect(validateAgentID('has space')).toBeInstanceOf(Error);
	});

	it('rejects IDs with dot', () => {
		expect(validateAgentID('claude.code')).toBeInstanceOf(Error);
	});
});

describe('validateAgentSessionID', () => {
	it('rejects empty (required field)', () => {
		expect(validateAgentSessionID('')).toBeInstanceOf(Error);
	});

	it('accepts valid agent session IDs', () => {
		expect(validateAgentSessionID('session-abc_123')).toBeNull();
		expect(validateAgentSessionID('abc123')).toBeNull();
	});

	it('rejects IDs with special chars', () => {
		expect(validateAgentSessionID('path/sep')).toBeInstanceOf(Error);
		expect(validateAgentSessionID('has space')).toBeInstanceOf(Error);
	});
});
