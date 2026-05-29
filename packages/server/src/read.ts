import { StatusCodes } from 'http-status-codes';

import { isNotModified, narObjectKey, parseNarName } from './http.ts';

const narPrefix = '/nar/';

export async function handleRead(
	request: Request,
	env: Env,
	ctx: ExecutionContext
): Promise<Response | undefined> {
	if (request.method !== 'GET' && request.method !== 'HEAD') {
		return undefined;
	}

	const { pathname } = new URL(request.url);

	if (pathname.startsWith(narPrefix)) {
		const narName = safeDecode(pathname.slice(narPrefix.length));

		if (narName === undefined) {
			return notFound();
		}

		return narResponse(request, env, ctx, narName);
	}

	return undefined;
}

function safeDecode(value: string): string | undefined {
	try {
		return decodeURIComponent(value);
	} catch {
		return undefined;
	}
}

async function narResponse(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
	narName: string
): Promise<Response> {
	const narHash = parseNarName(narName);

	if (narHash === undefined) {
		return notFound();
	}

	const key = narObjectKey(narHash);

	if (request.method === 'HEAD') {
		const object = await env.BLOBS.head(key);

		return object === null ? notFound() : conditionalOrBody(request, object);
	}

	const cache = caches.default;
	const cached = await cache.match(request);

	if (cached !== undefined) {
		return isNotModified(request, cached.headers)
			? notModified(cached.headers)
			: cached;
	}

	const object = await env.BLOBS.get(key);

	if (object === null) {
		return notFound();
	}

	const headers = narHeaders(object);

	if (isNotModified(request, headers)) {
		return notModified(headers);
	}

	const response = new Response(object.body, { headers });
	ctx.waitUntil(cache.put(request, response.clone()));

	return response;
}

function conditionalOrBody(request: Request, object: R2Object): Response {
	const headers = narHeaders(object);

	if (isNotModified(request, headers)) {
		return notModified(headers);
	}

	return new Response(undefined, { headers });
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

function notModified(headers: Headers): Response {
	return new Response(undefined, {
		status: StatusCodes.NOT_MODIFIED,
		headers
	});
}

function notFound(): Response {
	return new Response('Not found\n', { status: StatusCodes.NOT_FOUND });
}
