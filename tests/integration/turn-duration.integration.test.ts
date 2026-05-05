import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestEnv } from '../helpers/test-env';
import { CLI_PATH, runStoryCli } from './_helpers';

interface RunHookResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

async function runHook(cwd: string, verb: string, payload: unknown): Promise<RunHookResult> {
	return new Promise((resolve, reject) => {
		const child = spawn('bun', ['run', CLI_PATH, 'hooks', 'vogon', verb], {
			cwd,
			env: { ...process.env, CI: '1', NO_COLOR: '1' },
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		const out: string[] = [];
		const err: string[] = [];
		child.stdout?.on('data', (c) => out.push(String(c)));
		child.stderr?.on('data', (c) => err.push(String(c)));
		child.on('error', reject);
		child.on('close', (code) => {
			resolve({ code, stdout: out.join(''), stderr: err.join('') });
		});
		child.stdin.end(`${JSON.stringify(payload)}\n`);
	});
}

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

describe('integration: turn duration metrics', () => {
	let env: TestEnv;

	beforeEach(async () => {
		env = await TestEnv.create({ initialCommit: true });
	});

	afterEach(async () => {
		await env.cleanup();
	});

	it('persists wall-clock and active turn durations into committed metadata', async () => {
		const enable = await runStoryCli(env.dir, ['enable', '--agent', 'vogon', '--telemetry=false']);
		expect(enable.code).toBe(0);

		const settingsPath = path.join(env.dir, '.story', 'settings.json');
		const settings = JSON.parse(await fs.readFile(settingsPath, 'utf-8')) as Record<
			string,
			unknown
		>;
		await fs.writeFile(
			settingsPath,
			`${JSON.stringify(
				{
					...settings,
					absolute_git_hook_path: true,
					commit_linking: 'always',
					log_level: 'debug',
				},
				null,
				2,
			)}\n`,
		);
		const hooks = await runStoryCli(env.dir, ['enable', 'git-hook']);
		expect(hooks.code).toBe(0);

		const sessionId = 'duration-session';
		const transcriptPath = path.join(env.dir, '.story', 'tmp', `${sessionId}.jsonl`);
		await fs.mkdir(path.dirname(transcriptPath), { recursive: true });

		const turnStart = await runHook(env.dir, 'user-prompt-submit', {
			session_id: sessionId,
			transcript_path: transcriptPath,
			prompt: 'create duration file',
			model: 'vogon-test',
		});
		expect(turnStart.code).toBe(0);

		await sleep(1100);
		await env.writeFile('duration.txt', 'tracked duration\n');
		await fs.writeFile(
			transcriptPath,
			[
				JSON.stringify({
					type: 'user',
					timestamp: '2026-04-27T10:00:00.000Z',
					message: 'create duration file',
				}),
				JSON.stringify({
					type: 'assistant',
					timestamp: '2026-04-27T10:00:01.000Z',
					message: 'created duration.txt',
				}),
				'',
			].join('\n'),
		);

		const turnEnd = await runHook(env.dir, 'stop', {
			session_id: sessionId,
			transcript_path: transcriptPath,
			model: 'vogon-test',
		});
		expect(turnEnd.code).toBe(0);

		await env.gitAdd('duration.txt');
		await env.gitCommit('Add duration file');

		const { stdout: commitMessage } = await env.exec('git', ['log', '-1', '--format=%B']);
		const checkpointId = commitMessage.match(/^Story-Checkpoint:\s+([0-9a-f]{12})/m)?.[1];
		expect(checkpointId).toBeTruthy();

		const metadataPath = `${checkpointId!.slice(0, 2)}/${checkpointId!.slice(2)}/0/metadata.json`;
		const { stdout: rawMetadata } = await env.exec('git', [
			'show',
			`story/checkpoints/v1:${metadataPath}`,
		]);
		const metadata = JSON.parse(rawMetadata) as {
			session_metrics?: {
				duration_ms?: number;
				active_duration_ms?: number;
				turn_metrics?: Array<{ duration_ms?: number; started_at?: string; ended_at?: string }>;
			};
		};
		expect(metadata.session_metrics?.duration_ms).toBeGreaterThan(0);
		expect(metadata.session_metrics?.active_duration_ms).toBeGreaterThanOrEqual(1000);
		expect(metadata.session_metrics?.turn_metrics).toHaveLength(1);
		expect(metadata.session_metrics?.turn_metrics?.[0]?.duration_ms).toBeGreaterThanOrEqual(1000);
		expect(metadata.session_metrics?.turn_metrics?.[0]?.started_at).toMatch(/T/);
		expect(metadata.session_metrics?.turn_metrics?.[0]?.ended_at).toMatch(/T/);
	});
});
