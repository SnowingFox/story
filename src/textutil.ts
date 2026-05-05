const ideContextTagRe = /<ide_[^>]*>[\s\S]*?<\/ide_[^>]*>/g;

const systemTagRegexes = [
	/<local-command-caveat[^>]*>[\s\S]*?<\/local-command-caveat>/g,
	/<system-reminder[^>]*>[\s\S]*?<\/system-reminder>/g,
	/<command-name[^>]*>[\s\S]*?<\/command-name>/g,
	/<command-message[^>]*>[\s\S]*?<\/command-message>/g,
	/<command-args[^>]*>[\s\S]*?<\/command-args>/g,
	/<local-command-stdout[^>]*>[\s\S]*?<\/local-command-stdout>/g,
	/<\/?user_query>/g,
];

/** Remove IDE-injected context tags and system tags from prompt text. */
export function stripIDEContextTags(text: string): string {
	let result = text.replace(ideContextTagRe, '');
	for (const re of systemTagRegexes) {
		result = result.replace(re, '');
	}
	return result.trim();
}
