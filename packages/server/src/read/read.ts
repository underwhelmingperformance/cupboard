import { CacheInfo } from '@cupboard/nix/cache-info';
import { cacheNameSchema, DEFAULT_CACHE } from '@cupboard/nix/scalars';
import { StatusCodes } from 'http-status-codes';

import { type ManifestEntry } from '../control/tenant-manifest.ts';
import {
	isNotModified,
	narInfoCachePath,
	narInfoObjectKey,
	narObjectKey,
	parseAttestationDigestName,
	parseNarInfoName,
	parseNarName,
	TextBody,
	textResponse
} from '../http/http.ts';
import { tenantServer } from '../routing/durable-object.ts';

import {
	authoriseRead,
	type ReadVerifier,
	unauthorisedResponse
} from './read-auth.ts';

const narPrefix = '/nar/';

const cacheInfoBody = new TextBody(CacheInfo.default.render());

export async function handleRead(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
	tenant: string,
	entry: ManifestEntry
): Promise<Response | undefined> {
	if (request.method !== 'GET' && request.method !== 'HEAD') {
		return undefined;
	}

	// Suspension and offboarding stop reads, bounded by the manifest TTL: once the
	// republished manifest marks the tenant non-active, the read path serves nothing
	// for it. Writes stop at once through the authoritative D1 status read; reads stop
	// as the manifest entry propagates, the eventual half of the lifecycle contract.
	if (entry.status !== 'active') {
		return notFound();
	}

	const { pathname } = new URL(request.url);

	// A private cache turns narinfo, NAR and nix-cache-info into Basic-auth reads
	// that never touch the shared edge cache. The verifier comes from the admission
	// manifest, so the read path consults no D1 row or Durable Object.
	const isPrivate = entry.readMode === 'private';
	const verifier = entry.readVerifier;

	// OAuth discovery (RFC 8414) and the auth public keys both proxy to the tenant's
	// Durable Object, so an admitted but unconfigured tenant returns 503 here rather
	// than advertising or serving an identity it has not been assigned. The object
	// builds the metadata from its own request, so the issuer stays the tenant's
	// path-based URL.
	if (
		pathname === '/.well-known/oauth-authorization-server' ||
		pathname === '/.well-known/jwks.json'
	) {
		return tenantServer(env, tenant).fetch(request);
	}

	// A read may carry a `/cache/<name>/` prefix selecting a named cache; the
	// bare root is the default cache. An unrecognised prefix is a 404.
	const scope = cacheScope(pathname);

	if (scope === undefined) {
		return notFound();
	}

	const { cache, rest } = scope;

	if (isAttestationListPath(rest) || isAttestationBundlePath(rest)) {
		const denied = await guardRead(request, isPrivate, verifier);

		return denied ?? tenantServer(env, tenant).fetch(request);
	}

	if (rest.startsWith(narPrefix)) {
		const narName = safeDecode(rest.slice(narPrefix.length));
		const narHash = narName === undefined ? undefined : parseNarName(narName);

		if (narHash === undefined) {
			return notFound();
		}

		const denied = await guardRead(request, isPrivate, verifier);

		// NAR blobs are content-addressed and shared across all tenants, so the edge
		// cache key stays global: identical bytes, safely shared.
		return (
			denied ??
			serveR2(
				request,
				env,
				ctx,
				narObjectKey(narHash),
				narCacheKey(narHash),
				narHeaders,
				!isPrivate
			)
		);
	}

	if (rest.endsWith('.narinfo')) {
		const storePathHash = parseNarInfoName(rest.slice(1));

		if (storePathHash === undefined) {
			return notFound();
		}

		const denied = await guardRead(request, isPrivate, verifier);
		const { origin } = new URL(request.url);

		// The narinfo edge-cache key carries the tenant prefix, matching the deletion
		// purge path, so two tenants sharing a host never collide on a store-path hash.
		return (
			denied ??
			serveR2(
				request,
				env,
				ctx,
				narInfoObjectKey(tenant, storePathHash, cache),
				`${origin}${narInfoCachePath(tenant, storePathHash, cache)}`,
				narInfoHeaders,
				!isPrivate
			)
		);
	}

	if (rest === '/nix-cache-info') {
		const denied = await guardRead(request, isPrivate, verifier);

		return denied ?? cacheInfoResponse(request, env, tenant, cache, isPrivate);
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

function narCacheKey(narHash: string): string {
	return new URL(
		narObjectKey(narHash),
		'https://cupboard-nar-cache.invalid/'
	).toString();
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

function isAttestationListPath(rest: string): boolean {
	const prefix = '/attestations/';

	if (!rest.startsWith(prefix)) {
		return false;
	}

	const hash = safeDecode(rest.slice(prefix.length));

	return (
		hash !== undefined && parseNarInfoName(`${hash}.narinfo`) !== undefined
	);
}

function isAttestationBundlePath(rest: string): boolean {
	const prefix = '/attestation-bundles/';

	if (!rest.startsWith(prefix)) {
		return false;
	}

	const digest = safeDecode(rest.slice(prefix.length));

	return (
		digest !== undefined && parseAttestationDigestName(digest) !== undefined
	);
}

async function cacheInfoResponse(
	request: Request,
	env: Env,
	tenant: string,
	cache: string,
	isPrivate: boolean
): Promise<Response> {
	// The default cache's info is rendered at the edge; a named cache's priority
	// lives in the registry, so the DO renders its info.
	const response =
		cache === DEFAULT_CACHE
			? await textResponse(request, cacheInfoBody, {
					'content-type': 'text/x-nix-cache-info; charset=utf-8'
				})
			: await tenantServer(env, tenant).fetch(request);

	if (!isPrivate) {
		return response;
	}

	// Private mode: an authorised nix-cache-info must not be cached anywhere,
	// including a named cache's DO-rendered response.
	const headers = new Headers(response.headers);
	headers.set('cache-control', 'no-store');

	return new Response(response.body, { status: response.status, headers });
}

// Returns a 401 when the cache is private and the request is unauthorised, or
// `undefined` to let the read proceed (public, or authorised). A private cache with
// no verifier fails closed: every read is rejected until a credential is set.
async function guardRead(
	request: Request,
	isPrivate: boolean,
	verifier: ReadVerifier | undefined
): Promise<Response | undefined> {
	if (!isPrivate) {
		return undefined;
	}

	if (verifier !== undefined && (await authoriseRead(request, verifier))) {
		return undefined;
	}

	return unauthorisedResponse();
}

async function serveR2(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
	key: string,
	cacheKey: string,
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
		const cached = await cache.match(cacheKey);

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
		ctx.waitUntil(cache.put(cacheKey, response.clone()));
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
