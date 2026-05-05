#!/usr/bin/env node
const cmd = process.argv[2] ?? '';
if (cmd === 'info') {
	process.stdout.write(
		`${JSON.stringify({
			protocol_version: 999,
			name: 'x',
			type: 'X',
			description: 'x',
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
		})}\n`,
	);
	process.exit(0);
}
process.exit(1);
