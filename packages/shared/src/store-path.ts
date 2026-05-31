// Pure store-path derivations, kept dependency-free so both the wire schemas
// and the `StorePath` value object share one implementation. These return
// `undefined` rather than throwing; callers that want a hard failure layer
// their own typed error on top.

export function storePathBasename(path: string): string | undefined {
	const basename = path.split('/').at(-1);

	return basename === undefined || basename === '' ? undefined : basename;
}

export function storePathHashOf(path: string): string | undefined {
	const basename = storePathBasename(path);

	if (basename === undefined) {
		return undefined;
	}

	const separator = basename.indexOf('-');

	return separator === -1 ? undefined : basename.slice(0, separator);
}
