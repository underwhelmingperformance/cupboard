import { CacheInfo } from '@cupboard/nix/cache-info';
import {
	cacheFromSelector,
	cacheSelectorSchema,
	DEFAULT_CACHE
} from '@cupboard/nix/scalars';
import { and, eq } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { StatusCodes } from 'http-status-codes';

import { type ManifestEntry } from '../control/tenant-manifest.ts';
import * as d1Schema from '../db/d1-schema.ts';
import {
	isNotModified,
	narInfoCachePath,
	narInfoObjectKey,
	narObjectKey,
	notFoundResponse,
	TextBody,
	textResponse
} from '../http/http.ts';
import { tenantServer } from '../routing/durable-object.ts';

import { authoriseRead, unauthorisedResponse } from './read-auth.ts';

const cacheInfoBody = new TextBody(CacheInfo.default.render());

/** The slice of the execution context the read path needs: deferred work. */
export interface ReadContext {
	waitUntil(promise: Promise<unknown>): void;
}

// Splits an optional `/cache/<name>/` prefix off a tenant-relative path.
// Returns the default cache and the unchanged path for a bare route, mapping
// the `_default` wire alias back to the default cache; `undefined` when the
// prefix is present but malformed or names an invalid cache.
export function cacheScope(
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

	const selector = cacheSelectorSchema.safeParse(remainder.slice(0, separator));

	if (!selector.success) {
		return undefined;
	}

	return {
		cache: cacheFromSelector(selector.data),
		rest: remainder.slice(separator)
	};
}

// Returns a 401 when the cache is private and the request is unauthorised, or
// `undefined` to let the read proceed (public, or authorised). A private cache
// turns reads into Basic-auth reads that never touch the shared edge cache;
// the verifier comes from the admission manifest, so the read path consults no
// D1 row or Durable Object. A private cache with no verifier fails closed:
// every read is rejected until a credential is set.
export async function guardRead(
	request: Request,
	entry: ManifestEntry
): Promise<Response | undefined> {
	if (entry.readMode !== 'private') {
		return undefined;
	}

	const verifier = entry.readVerifier;

	if (verifier !== undefined && (await authoriseRead(request, verifier))) {
		return undefined;
	}

	return unauthorisedResponse();
}

// NAR blobs are content-addressed and shared at rest across all tenants, but
// read access is per-tenant: the serve is gated on the requesting tenant holding
// its own presence edge for the hash, so one tenant's bytes are never readable
// through another's path. The R2 object stays global for dedupe; the edge cache
// key carries the tenant so a cached entry is only ever replayed to the tenant
// that was authorised to populate it. An unowned hash reads as a miss,
// indistinguishable from one that exists for no tenant, closing the existence
// oracle the negotiate path already guards.
export function serveNar(
	request: Request,
	env: Env,
	ctx: ReadContext,
	tenant: string,
	narHash: string,
	isPrivate: boolean
): Promise<Response> {
	return serveR2(
		request,
		env,
		ctx,
		narObjectKey(narHash),
		narCacheKey(tenant, narHash),
		narHeaders,
		!isPrivate,
		() => tenantReferencesNar(env, tenant, narHash)
	);
}

// Whether the tenant holds its own presence edge for the NAR hash. Mirrors the
// `tenant_blob` ownership check `findReusableBlob` uses on the negotiate path.
async function tenantReferencesNar(
	env: Env,
	tenant: string,
	narHash: string
): Promise<boolean> {
	const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });

	const owned = await database
		.select({ narHash: d1Schema.tenantBlob.narHash })
		.from(d1Schema.tenantBlob)
		.where(
			and(
				eq(d1Schema.tenantBlob.tenant, tenant),
				eq(d1Schema.tenantBlob.narHash, narHash)
			)
		)
		.get();

	return owned !== undefined;
}

// The narinfo edge-cache key carries the tenant prefix, matching the deletion
// purge path, so two tenants sharing a host never collide on a store-path
// hash.
export function serveNarInfo(
	request: Request,
	env: Env,
	ctx: ReadContext,
	tenant: string,
	cache: string,
	storePathHash: string,
	isPrivate: boolean
): Promise<Response> {
	const { origin } = new URL(request.url);

	return serveR2(
		request,
		env,
		ctx,
		narInfoObjectKey(tenant, storePathHash, cache),
		`${origin}${narInfoCachePath(tenant, storePathHash, cache)}`,
		narInfoHeaders,
		!isPrivate
	);
}

export async function cacheInfoResponse(
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

function narCacheKey(tenant: string, narHash: string): string {
	return new URL(
		`t/${tenant}/${narObjectKey(narHash)}`,
		'https://cupboard-nar-cache.invalid/'
	).toString();
}

// `authorize`, when provided, gates access to a shared object. It runs before
// any uncached read or existence probe, never on an edge-cache hit: a cached
// entry is keyed per tenant, so a hit already proves this tenant was authorised
// when it populated the cache. A false verdict reads as a 404.
async function serveR2(
	request: Request,
	env: Env,
	ctx: ReadContext,
	key: string,
	cacheKey: string,
	headersFor: (object: R2Object) => Headers,
	usePublicCache: boolean,
	authorize?: () => Promise<boolean>
): Promise<Response> {
	if (request.method === 'HEAD') {
		if (authorize !== undefined && !(await authorize())) {
			return notFoundResponse();
		}

		const object = await env.BLOBS.head(key);

		if (object === null) {
			return notFoundResponse();
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

	if (authorize !== undefined && !(await authorize())) {
		return notFoundResponse();
	}

	const object = await env.BLOBS.get(key);

	if (object === null) {
		return notFoundResponse();
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
