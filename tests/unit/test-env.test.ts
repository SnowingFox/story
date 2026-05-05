import fs from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { TestEnv } from '../helpers/test-env.js';

describe('TestEnv', () => {
	let env: TestEnv | undefined;
	let envs: TestEnv[] = [];

	afterEach(async () => {
		if (env) {
			await env.cleanup();
			env = undefined;
		}
		for (const e of envs) {
			await e.cleanup();
		}
		envs = [];
	});

	it('creates isolated git repo', async () => {
		env = await TestEnv.create();
		const stat = await fs.stat(`${env.dir}/.git`);
		expect(stat.isDirectory()).toBe(true);
	});

	it('writeFile + readFile roundtrip', async () => {
		env = await TestEnv.create();
		const content = 'hello world\n';
		await env.writeFile('test.txt', content);
		const result = await env.readFile('test.txt');
		expect(result).toBe(content);
	});

	it('gitAdd + gitCommit creates commit', async () => {
		env = await TestEnv.create();
		await env.writeFile('file.txt', 'content');
		await env.gitAdd('file.txt');
		await env.gitCommit('test commit');

		const messages = await env.gitLog(1);
		expect(messages).toEqual(['test commit']);
	});

	it('gitCommit returns commit hash', async () => {
		env = await TestEnv.create();
		await env.writeFile('file.txt', 'content');
		await env.gitAdd('file.txt');
		const hash = await env.gitCommit('test commit');

		expect(hash).toMatch(/^[0-9a-f]{40}$/);
	});

	it('separate envs are isolated', async () => {
		const env1 = await TestEnv.create();
		const env2 = await TestEnv.create();
		envs.push(env1, env2);

		await env1.writeFile('only-in-1.txt', 'env1');
		await env2.writeFile('only-in-2.txt', 'env2');

		await expect(env1.readFile('only-in-2.txt')).rejects.toThrow();
		await expect(env2.readFile('only-in-1.txt')).rejects.toThrow();
	});

	it('cleanup removes directory', async () => {
		const tempEnv = await TestEnv.create();
		const dir = tempEnv.dir;
		await tempEnv.cleanup();

		await expect(fs.access(dir)).rejects.toThrow();
	});

	it('resolves macOS symlinks', async () => {
		env = await TestEnv.create();
		// On macOS, os.tmpdir() returns /var/folders/... but the real path
		// is /private/var/folders/... — fs.realpath should resolve this.
		// The dir should never start with the unresolved /var/ prefix.
		if (process.platform === 'darwin') {
			expect(env.dir).toMatch(/^\/private\//);
		}
		const resolved = await fs.realpath(env.dir);
		expect(env.dir).toBe(resolved);
	});
});
