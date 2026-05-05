/** Collapse all whitespace sequences to a single space and trim. */
export function collapseWhitespace(s: string): string {
	return s.replace(/\s+/g, ' ').trim();
}

/** Truncate a string to `maxRunes` characters, appending `suffix` if truncated. */
export function truncateRunes(s: string, maxRunes: number, suffix: string): string {
	const runes = [...s];
	if (runes.length <= maxRunes) {
		return s;
	}
	const suffixRunes = [...suffix];
	let truncateAt = maxRunes - suffixRunes.length;
	if (truncateAt < 0) {
		truncateAt = 0;
	}
	return runes.slice(0, truncateAt).join('') + suffix;
}

/** Capitalize the first Unicode character of a string. */
export function capitalizeFirst(s: string): string {
	if (s === '') {
		return s;
	}
	const first = s.codePointAt(0);
	if (first === undefined) {
		return s;
	}
	const char = String.fromCodePoint(first);
	const upper = char.toUpperCase();
	if (upper === char) {
		return s;
	}
	return upper + s.slice(char.length);
}
