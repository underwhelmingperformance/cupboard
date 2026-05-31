import { StatusCodes } from 'http-status-codes';

import { sha256HexBytes } from './crypto.ts';

const textHeaders = {
	'cache-control': 'public, max-age=3600',
	'x-content-type-options': 'nosniff'
};

// The origin the scheduled (cron) handler uses to reach the Durable Object. It
// is internal, so GC triggered through it cannot know the public URL clients
// cached under and must not attempt to purge the edge cache.
export const internalOrigin = 'https://cupboard.local';

export const narInfoCacheTtlSeconds = 3600;

export const narInfoCacheControl = `public, max-age=${String(narInfoCacheTtlSeconds)}`;

// A deleted narinfo can still be served from a warm edge for up to its TTL, so a
// NAR it points at must outlive any such cached copy. The grace adds a margin
// over the TTL for edge propagation and clock skew.
export const orphanBlobDeletionGraceMs = (narInfoCacheTtlSeconds + 600) * 1000;

export function narObjectKey(narHash: string): string {
	return `nar/${narHash}.nar.zst`;
}

export function narInfoObjectKey(storePathHash: string): string {
	return `narinfo/${storePathHash}`;
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

export function parseNarInfoName(name: string): string | undefined {
	const suffix = '.narinfo';

	if (!name.endsWith(suffix)) {
		return undefined;
	}

	const storePathHash = name.slice(0, -suffix.length);

	if (!/^[0-9a-df-np-sv-z]{32}$/.test(storePathHash)) {
		return undefined;
	}

	return storePathHash;
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

export async function textResponse(
	request: Request,
	body: string | TextBody,
	headers: Record<string, string>
): Promise<Response> {
	const responseHeaders = new Headers({ ...textHeaders, ...headers });
	const metadata =
		typeof body === 'string'
			? await textBodyMetadata(body)
			: await body.metadata();
	const text = typeof body === 'string' ? body : body.value;
	responseHeaders.set('etag', metadata.etag);
	responseHeaders.set('content-length', metadata.contentLength);

	if (isNotModified(request, responseHeaders)) {
		return new Response(undefined, {
			status: StatusCodes.NOT_MODIFIED,
			headers: responseHeaders
		});
	}

	return new Response(request.method === 'HEAD' ? undefined : text, {
		headers: responseHeaders
	});
}

interface TextBodyMetadata {
	readonly etag: string;
	readonly contentLength: string;
}

async function textBodyMetadata(body: string): Promise<TextBodyMetadata> {
	const bytes = new TextEncoder().encode(body);

	return {
		etag: `"sha256:${await sha256HexBytes(bytes)}"`,
		contentLength: String(bytes.byteLength)
	};
}

export class TextBody {
	private metadataPromise: Promise<TextBodyMetadata> | undefined;

	constructor(public readonly value: string) {}

	metadata(): Promise<TextBodyMetadata> {
		this.metadataPromise ??= textBodyMetadata(this.value);

		return this.metadataPromise;
	}
}
