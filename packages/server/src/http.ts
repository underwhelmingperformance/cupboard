export function narObjectKey(narHash: string): string {
	return `nar/${narHash}.nar.zst`;
}

export function parseNarName(name: string): string | undefined {
	const prefix = 'sha256:';
	const suffix = '.nar.zst';

	if (!name.startsWith(prefix) || !name.endsWith(suffix)) {
		return undefined;
	}

	const hash = name.slice(0, -suffix.length);

	if (!/^sha256:[0-9a-df-np-sv-z]{52}$/.test(hash)) {
		return undefined;
	}

	return hash;
}

export function isNotModified(request: Request, headers: Headers): boolean {
	const etag = headers.get('etag');

	if (etag !== null && request.headers.get('if-none-match') === etag) {
		return true;
	}

	const lastModified = headers.get('last-modified');
	const ifModifiedSince = request.headers.get('if-modified-since');

	if (lastModified === null || ifModifiedSince === null) {
		return false;
	}

	return Date.parse(ifModifiedSince) >= Date.parse(lastModified);
}
