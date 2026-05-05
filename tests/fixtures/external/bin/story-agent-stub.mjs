#!/usr/bin/env node
/**
 * Test fixture: minimal `story-agent-*` protocol implementation for ExternalAgent tests.
 * Invoked as `node story-agent-stub.mjs <subcommand>`.
 */
import { writeSync } from 'node:fs';

const cmd = process.argv[2] ?? '';

const infoResponse = () => ({
	protocol_version: 1,
	name: 'stub-agent',
	type: 'Stub',
	description: 'test stub',
	is_preview: false,
	protected_dirs: [],
	hook_names: [],
	capabilities: {
		hooks: false,
		transcript_analyzer: false,
		transcript_preparer: false,
		token_calculator: false,
		text_generator: false,
		hook_response_writer: false,
		subagent_aware_extractor: false,
	},
});

async function drainStdin() {
	const chunks = [];
	for await (const c of process.stdin) {
		chunks.push(c);
	}
	return Buffer.concat(chunks).toString('utf8');
}

async function main() {
	if (cmd === 'info') {
		process.stdout.write(`${JSON.stringify(infoResponse())}\n`);
		process.exit(0);
	}
	if (cmd === 'info-bad-json') {
		process.stdout.write('NOT_JSON\n');
		process.exit(0);
	}
	if (cmd === 'info-wrong-proto') {
		process.stdout.write(`${JSON.stringify({ ...infoResponse(), protocol_version: 999 })}\n`);
		process.exit(0);
	}
	if (cmd === 'detect') {
		process.stdout.write(`${JSON.stringify({ present: true })}\n`);
		process.exit(0);
	}
	if (cmd === 'get-session-id') {
		await drainStdin();
		process.stdout.write(`${JSON.stringify({ session_id: 'stub-session-id' })}\n`);
		process.exit(0);
	}
	if (cmd === 'echo-stdin') {
		const body = await drainStdin();
		process.stdout.write(`${JSON.stringify({ got: body })}\n`);
		process.exit(0);
	}
	if (cmd === 'parse-hook') {
		await drainStdin();
		process.stdout.write('null\n');
		process.exit(0);
	}
	if (cmd === 'resolve-session-file') {
		process.stdout.write(`${JSON.stringify({ session_file: '/tmp/resolved.json' })}\n`);
		process.exit(0);
	}
	if (cmd === 'format-resume-command') {
		process.stdout.write(`${JSON.stringify({ command: 'stub resume cmd' })}\n`);
		process.exit(0);
	}
	if (cmd === 'fail-stderr') {
		process.stderr.write('expected failure on stderr\n');
		process.exit(1);
	}
	if (cmd === 'huge-stdout') {
		const chunk = Buffer.alloc(64 * 1024, 97);
		let remaining = 10 * 1024 * 1024 + 50;
		while (remaining > 0) {
			const n = Math.min(chunk.length, remaining);
			writeSync(1, chunk.subarray(0, n));
			remaining -= n;
		}
		process.exit(0);
	}
	if (cmd === 'hang') {
		await new Promise(() => {});
	}
	if (cmd === 'stderr-ok') {
		process.stderr.write('warn-line\n');
		process.stdout.write('ok-line\n');
		process.exit(0);
	}
	process.stderr.write(`unknown subcommand: ${cmd}\n`);
	process.exit(1);
}

await main();
