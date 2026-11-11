/**
Whether `value` contains a C0 control character, DEL or a C1 control
character: the code points U+0000 to U+001F and U+007F to U+009F.
*/
export function hasControlCharacter(value: string): boolean {
	for (const character of value) {
		const codePoint = character.codePointAt(0);
		if (
			codePoint !== undefined &&
			(codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
		) {
			return true;
		}
	}

	return false;
}

/**
Returns `value` with its trailing slashes removed. A string that contains only
slashes becomes empty.
*/
export function trimTrailingSlashes(value: string): string {
	let end = value.length;
	while (end > 0 && value[end - 1] === '/') {
		end -= 1;
	}

	return value.slice(0, end);
}

/**
Returns `value` with its leading and trailing slashes removed. Interior slashes
remain, and a string that contains only slashes becomes empty.
*/
export function trimSlashes(value: string): string {
	const trimmed = trimTrailingSlashes(value);
	let start = 0;
	while (start < trimmed.length && trimmed[start] === '/') {
		start += 1;
	}

	return trimmed.slice(start);
}
