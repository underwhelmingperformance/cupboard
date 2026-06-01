import { CacheInfo } from '@cupboard/shared';
import { StatusCodes } from 'http-status-codes';

import { buildVersion } from './build-info.generated.ts';
import { cupboardServer } from './durable-object.ts';
import {
	isNotModified,
	narInfoObjectKey,
	narObjectKey,
	parseNarInfoName,
	parseNarName,
	TextBody,
	textResponse
} from './http.ts';
import {
	authoriseRead,
	type ReadCredential,
	readCredential,
	unauthorisedResponse
} from './read-auth.ts';

const narPrefix = '/nar/';

const cacheInfoBody = new TextBody(CacheInfo.default.render());
const healthBody = new TextBody('ok\n');
const versionBody = new TextBody(`${buildVersion}\n`);

export async function handleRead(
	request: Request,
	env: Env,
	ctx: ExecutionContext
): Promise<Response | undefined> {
	if (request.method !== 'GET' && request.method !== 'HEAD') {
		return undefined;
	}

	const { pathname } = new URL(request.url);

	// A configured read credential turns the cache private: narinfo, NAR and
	// nix-cache-info require Basic auth and never touch the shared edge cache.
	const credential = readCredential(env);

	if (pathname.startsWith(narPrefix)) {
		const narName = safeDecode(pathname.slice(narPrefix.length));
		const narHash = narName === undefined ? undefined : parseNarName(narName);

		if (narHash === undefined) {
			return notFound();
		}

		return (
			guardRead(request, credential) ??
			serveR2(
				request,
				env,
				ctx,
				narObjectKey(narHash),
				narHeaders,
				credential === undefined
			)
		);
	}

	if (pathname.endsWith('.narinfo')) {
		const storePathHash = parseNarInfoName(pathname.slice(1));

		if (storePathHash === undefined) {
			return notFound();
		}

		return (
			guardRead(request, credential) ??
			serveR2(
				request,
				env,
				ctx,
				narInfoObjectKey(storePathHash),
				narInfoHeaders,
				credential === undefined
			)
		);
	}

	if (pathname === '/nix-cache-info') {
		return (
			guardRead(request, credential) ??
			textResponse(request, cacheInfoBody, {
				'content-type': 'text/x-nix-cache-info; charset=utf-8',
				...(credential === undefined ? {} : { 'cache-control': 'no-store' })
			})
		);
	}

	if (pathname === '/_health') {
		return textResponse(request, healthBody, {
			'content-type': 'text/plain; charset=utf-8',
			'cache-control': 'no-store'
		});
	}

	if (pathname === '/_version') {
		return textResponse(request, versionBody, {
			'content-type': 'text/plain; charset=utf-8',
			'cache-control': 'no-store'
		});
	}

	if (pathname === '/pubkey') {
		// Forwarded to the DO uncached: it sets `no-cache` so a key rotation is
		// visible immediately rather than masked by a warm edge copy.
		return cupboardServer(env).fetch(request);
	}

	return undefined;
}

// Returns a 401 when private-read mode is on and the request is unauthorised,
// or `undefined` to let the read proceed (public, or authorised).
function guardRead(
	request: Request,
	credential: ReadCredential | undefined
): Response | undefined {
	if (credential === undefined) {
		return undefined;
	}

	if (authoriseRead(request, credential)) {
		return undefined;
	}

	return unauthorisedResponse();
}

async function serveR2(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
	key: string,
	headersFor: (object: R2Object) => Headers,
	usePublicCache: boolean
): Promise<Response> {
	if (request.method === 'HEAD') {
		const object = await env.BLOBS.head(key);

		if (object === null) {
			return notFound();
		}

		const headers = headersFor(object);

		return isNotModified(request, headers)
			? notModified(headers)
			: new Response(undefined, { headers });
	}

	const cache = caches.default;

	if (usePublicCache) {
		const cached = await cache.match(request);

		if (cached !== undefined) {
			return isNotModified(request, cached.headers)
				? notModified(cached.headers)
				: cached;
		}
	}

	const object = await env.BLOBS.get(key);

	if (object === null) {
		return notFound();
	}

	const headers = headersFor(object);

	if (isNotModified(request, headers)) {
		return notModified(headers);
	}

	const response = new Response(object.body, { headers });

	if (usePublicCache) {
		ctx.waitUntil(cache.put(request, response.clone()));
	}

	return response;
}

function narHeaders(object: R2Object): Headers {
	const headers = new Headers({
		'cache-control': 'public, max-age=31536000, immutable',
		'content-type': 'application/zstd',
		etag: object.httpEtag,
		'last-modified': object.uploaded.toUTCString()
	});
	headers.set('content-length', String(object.size));

	return headers;
}

function narInfoHeaders(object: R2Object): Headers {
	const headers = new Headers();
	object.writeHttpMetadata(headers);
	headers.set('etag', object.httpEtag);
	headers.set('last-modified', object.uploaded.toUTCString());
	headers.set('content-length', String(object.size));

	return headers;
}

function notModified(headers: Headers): Response {
	return new Response(undefined, {
		status: StatusCodes.NOT_MODIFIED,
		headers
	});
}

function notFound(): Response {
	return new Response('Not found\n', { status: StatusCodes.NOT_FOUND });
}

function safeDecode(value: string): string | undefined {
	try {
		return decodeURIComponent(value);
	} catch {
		return undefined;
	}
}
