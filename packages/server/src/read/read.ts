import { CacheInfo } from '@cupboard/nix/cache-info';
import { cacheNameSchema, DEFAULT_CACHE } from '@cupboard/nix/scalars';
import { tokenExchangeGrantType } from '@cupboard/protocol/oidc';
import { defaultAuthIssuer } from '@cupboard/protocol/oidc-issuer';
import { StatusCodes } from 'http-status-codes';

import {
	isNotModified,
	narInfoObjectKey,
	narObjectKey,
	parseNarInfoName,
	parseNarName,
	TextBody,
	textResponse
} from '../http/http.ts';
import { tenantServer } from '../routing/durable-object.ts';

import {
	authoriseRead,
	type ReadCredential,
	readCredential,
	unauthorisedResponse
} from './read-auth.ts';

const narPrefix = '/nar/';

const cacheInfoBody = new TextBody(CacheInfo.default.render());

export async function handleRead(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
	tenant: string
): Promise<Response | undefined> {
	if (request.method !== 'GET' && request.method !== 'HEAD') {
		return undefined;
	}

	const { pathname } = new URL(request.url);

	// A configured read credential turns the cache private: narinfo, NAR and
	// nix-cache-info require Basic auth and never touch the shared edge cache.
	const credential = readCredential(env);

	// OAuth discovery (RFC 8414) for this tenant, built at the edge. The issuer and
	// endpoints carry the tenant prefix so a client sees one consistent identity.
	if (pathname === '/.well-known/oauth-authorization-server') {
		return authorizationServerMetadata(request, env, tenant);
	}

	// This tenant's auth public keys, served uncached from its Durable Object so a
	// rotation is visible immediately. The DO owns the key set, so the read proxies
	// to it.
	if (pathname === '/.well-known/jwks.json') {
		return tenantServer(env, tenant).fetch(request);
	}

	// A read may carry a `/cache/<name>/` prefix selecting a named cache; the
	// bare root is the default cache. An unrecognised prefix is a 404.
	const scope = cacheScope(pathname);

	if (scope === undefined) {
		return notFound();
	}

	const { cache, rest } = scope;

	if (rest.startsWith(narPrefix)) {
		const narName = safeDecode(rest.slice(narPrefix.length));
		const narHash = narName === undefined ? undefined : parseNarName(narName);

		if (narHash === undefined) {
			return notFound();
		}

		// NAR blobs are content-addressed and shared across caches.
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

	if (rest.endsWith('.narinfo')) {
		const storePathHash = parseNarInfoName(rest.slice(1));

		if (storePathHash === undefined) {
			return notFound();
		}

		return (
			guardRead(request, credential) ??
			serveR2(
				request,
				env,
				ctx,
				narInfoObjectKey(storePathHash, cache),
				narInfoHeaders,
				credential === undefined
			)
		);
	}

	if (rest === '/nix-cache-info') {
		return (
			guardRead(request, credential) ??
			cacheInfoResponse(request, env, tenant, cache, credential)
		);
	}

	if (rest === '/pubkey') {
		// This tenant's narinfo signing key set, served uncached from its Durable
		// Object so a rotation is visible immediately.
		const pubkeyUrl = new URL(request.url);
		pubkeyUrl.pathname = '/pubkey';

		return tenantServer(env, tenant).fetch(new Request(pubkeyUrl, request));
	}

	return undefined;
}

function authorizationServerMetadata(
	request: Request,
	env: Env,
	tenant: string
): Response {
	const { origin } = new URL(request.url);
	const base = `${origin}/t/${tenant}`;
	// Typegen narrows the binding to its configured literal; a deployment may
	// still set it empty, so widen to `string` and fall back to the same default
	// the Durable Object stamps into its tokens, keeping the advertised issuer and
	// the token `iss` identical.
	const configuredIssuer: string = env.CUPBOARD_AUTH_ISSUER;

	return Response.json({
		issuer: configuredIssuer || defaultAuthIssuer,
		token_endpoint: `${base}/token`,
		jwks_uri: `${base}/.well-known/jwks.json`,
		grant_types_supported: [tokenExchangeGrantType],
		scopes_supported: ['write', 'admin'],
		token_endpoint_auth_methods_supported: ['none']
	});
}

// Splits an optional `/cache/<name>/` prefix off the path. Returns the default
// cache and the unchanged path for a bare route; `undefined` when the prefix is
// present but malformed or names an invalid cache.
function cacheScope(
	pathname: string
): { cache: string; rest: string } | undefined {
	const prefix = '/cache/';

	if (!pathname.startsWith(prefix)) {
		return { cache: DEFAULT_CACHE, rest: pathname };
	}

	const remainder = pathname.slice(prefix.length);
	const separator = remainder.indexOf('/');

	if (separator <= 0) {
		return undefined;
	}

	const name = remainder.slice(0, separator);

	if (!cacheNameSchema.safeParse(name).success) {
		return undefined;
	}

	return { cache: name, rest: remainder.slice(separator) };
}

async function cacheInfoResponse(
	request: Request,
	env: Env,
	tenant: string,
	cache: string,
	credential: ReadCredential | undefined
): Promise<Response> {
	// The default cache's info is rendered at the edge; a named cache's priority
	// lives in the registry, so the DO renders its info.
	const response =
		cache === DEFAULT_CACHE
			? await textResponse(request, cacheInfoBody, {
					'content-type': 'text/x-nix-cache-info; charset=utf-8'
				})
			: await tenantServer(env, tenant).fetch(request);

	if (credential === undefined) {
		return response;
	}

	// Private mode: an authorised nix-cache-info must not be cached anywhere,
	// including a named cache's DO-rendered response.
	const headers = new Headers(response.headers);
	headers.set('cache-control', 'no-store');

	return new Response(response.body, { status: response.status, headers });
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

		const headers = privatise(headersFor(object), usePublicCache);

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

	const headers = privatise(headersFor(object), usePublicCache);

	if (isNotModified(request, headers)) {
		return notModified(headers);
	}

	const response = new Response(object.body, { headers });

	if (usePublicCache) {
		ctx.waitUntil(cache.put(request, response.clone()));
	}

	return response;
}

// In private mode the response body is served only after Basic auth, so it must
// not be retained by any shared or intermediary cache: force `no-store`,
// overriding the public read headers.
function privatise(headers: Headers, usePublicCache: boolean): Headers {
	if (!usePublicCache) {
		headers.set('cache-control', 'no-store');
	}

	return headers;
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
