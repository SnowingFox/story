#!/usr/bin/env node
const cmd = process.argv[2] ?? '';
if (cmd === 'info') {
	process.stdout.write('NOT_JSON\n');
	process.exit(0);
}
process.exit(1);
