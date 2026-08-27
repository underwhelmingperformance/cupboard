import { CacheInfo } from '@cupboard/nix-store/cache-info';
import {
	DEFAULT_CACHE,
	type NixSha256HashString,
	type StoredCache,
	type StorePathHash,
	type TenantId
} from '@cupboard/nix-store/scalars';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';
import { and, eq } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { StatusCodes } from 'http-status-codes';

import { type TenantEntry } from '../control/tenant-membership.ts';
import * as d1Schema from '../db/d1-schema.ts';
import { readWithOneRetry } from '../db/transient.ts';
import { maxOutgoingConnections } from '../do/bulk.ts';
import { SharedFactsUnavailableError } from '../errors.ts';
import { narInfoCacheTag } from '../http/cache-tags.ts';
import {
	isNotModified,
	narInfoCacheControl,
	narInfoObjectKey,
	narObjectKey,
	notFoundResponse,
	type R2ObjectKey,
	TextBody,
	textResponse,
	uncachedNotFoundResponse
} from '../http/http.ts';
import { tenantServer } from '../routing/durable-object.ts';

import {
	isReadAuthorised,
	type ReadVerifier,
	unauthorisedResponse
} from './read-auth.ts';

const cacheInfoBody = new TextBody(CacheInfo.default.render());

interface ReadEnv {
	readonly BLOBS: R2Bucket;
	readonly CUPBOARD_DB: D1Database;
	readonly CUPBOARD_DO: DurableObjectNamespace;
}

/**
 * What a read request addresses: a cache in the public namespace, where the
 * tenant's read mode decides whether readers authenticate, or a cache in the
 * private namespace, where they always do.
 */
export interface ReadScope {
	readonly visibility: 'public' | 'private';
	readonly cache: StoredCache;
}

/**
 * Authenticates a read, or returns the refusal to send instead.
 *
 * Admission reads every verifier from the authoritative D1 rows on each
 * request, so a rotated or deleted verifier takes effect immediately.
 *
 * A request in the private namespace must authenticate. `cacheVerifier` is the
 * addressed cache's own verifier. If the cache has one, only a credential that
 * matches it opens the cache; otherwise the guard uses the tenant verifier. If
 * neither verifier exists the guard refuses the request, so a missing row
 * cannot open a private cache to anyone.
 *
 * A request in the public namespace authenticates only when the whole tenant is
 * private. Successful authenticated reads stay on the control Worker and never
 * enter the cache-owning tenant Worker.
 */
export async function guardScopedRead(
	request: Request,
	entry: TenantEntry,
	scope: ReadScope,
	cacheVerifier?: ReadVerifier
): Promise<Response | undefined> {
	if (scope.visibility === 'private') {
		return authenticateRead(request, cacheVerifier ?? entry.readVerifier);
	}

	if (entry.readMode !== 'private') {
		return undefined;
	}

	return authenticateRead(request, entry.readVerifier);
}

async function authenticateRead(
	request: Request,
	verifier: ReadVerifier | undefined
): Promise<Response | undefined> {
	if (verifier !== undefined && (await isReadAuthorised(request, verifier))) {
		return undefined;
	}

	return unauthorisedResponse();
}

// NAR objects are shared by hash in R2. Serve one only when `tenant_blob` links
// it to the requesting tenant, and include the tenant in the edge-cache key.
// Missing ownership and missing objects both return 404, so a tenant cannot use
// this route to discover another tenant's stored bytes.
export async function serveNar(
	request: Request,
	env: ReadEnv,
	tenant: TenantId,
	narHash: NixSha256HashString,
	isPrivate: boolean,
	incarnation = 1
): Promise<Response> {
	const isOwned = await isNarOwnedByTenant(env, tenant, narHash);

	if (!isOwned) {
		return isPrivate ? uncachedNotFoundResponse() : notFoundResponse();
	}

	return serveR2(
		request,
		env,
		narObjectKey(narHash, incarnation),
		narHeaders,
		!isPrivate
	);
}

// Retry the D1 ownership query once. A persistent failure becomes a retryable
// refusal instead of a 404, which would report the NAR as absent.
async function isNarOwnedByTenant(
	env: Pick<ReadEnv, 'CUPBOARD_DB'>,
	tenant: TenantId,
	narHash: NixSha256HashString
): Promise<boolean> {
	const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });

	try {
		const owned = await readWithOneRetry(() =>
			database
				.select({ narHash: d1Schema.blobState.narHash })
				.from(d1Schema.tenantBlob)
				.innerJoin(
					d1Schema.blobState,
					eq(d1Schema.blobState.narHash, d1Schema.tenantBlob.narHash)
				)
				.where(
					and(
						eq(d1Schema.tenantBlob.tenant, tenant),
						eq(d1Schema.tenantBlob.narHash, narHash)
					)
				)
				.get()
		);

		return owned !== undefined;
	} catch (error) {
		throw new SharedFactsUnavailableError(error);
	}
}

// The request URL isolates cached narinfos by tenant and cache. The response uses
// the same tenant, cache, and path identity in its cache tag so deletion and
// re-signing purge only this narinfo.
export function serveNarInfo(
	request: Request,
	env: ReadEnv,
	tenant: TenantId,
	cache: StoredCache,
	storePathHash: StorePathHash,
	isPrivate: boolean
): Promise<Response> {
	return serveR2(
		request,
		env,
		narInfoObjectKey(tenant, storePathHash, cache),
		(object) => narInfoHeaders(object, tenant, cache, storePathHash),
		!isPrivate
	);
}

export async function missingStorePathHashes(
	env: Env,
	tenant: TenantId,
	cache: StoredCache,
	storePathHashes: readonly StorePathHash[]
): Promise<StorePathHash[]> {
	const unique = [...new Set(storePathHashes)];
	const missing = await mapWithConcurrency(
		unique,
		maxOutgoingConnections,
		async (storePathHash) => {
			const object = await env.BLOBS.head(
				narInfoObjectKey(tenant, storePathHash, cache)
			);

			return object === null ? storePathHash : undefined;
		}
	);

	return missing.filter(
		(storePathHash): storePathHash is StorePathHash =>
			storePathHash !== undefined
	);
}

export async function cacheInfoResponse(
	request: Request,
	env: ReadEnv,
	tenant: TenantId,
	cache: StoredCache,
	isPrivate: boolean
): Promise<Response> {
	// Default-cache priority is fixed, so render it locally. A named cache's
	// priority comes from the Durable Object registry.
	const response =
		cache === DEFAULT_CACHE
			? await textResponse(request, cacheInfoBody, {
					'content-type': 'text/x-nix-cache-info; charset=utf-8'
				})
			: await tenantServer(env, tenant).fetch(request);

	if (!isPrivate) {
		return response;
	}

	// Override the Durable Object response too: authenticated cache metadata must
	// carry `no-store`.
	const headers = new Headers(response.headers);
	headers.set('cache-control', 'no-store');

	return new Response(response.body, { status: response.status, headers });
}

// Check the tenant's reference before reading R2. Public origin requests reach
// the cache-owning tenant Worker only after control admission; private requests
// stay on the uncached control Worker.
async function serveR2(
	request: Request,
	env: ReadEnv,
	key: R2ObjectKey,
	headersFor: (object: R2Object) => Headers,
	isPublicCache: boolean,
	isAuthorised?: () => Promise<boolean>
): Promise<Response> {
	if (isAuthorised !== undefined && !(await isAuthorised())) {
		return uncachedNotFoundResponse();
	}

	if (!isPublicCache && request.method === 'HEAD') {
		return r2Response(
			request,
			await env.BLOBS.head(key),
			headersFor,
			isPublicCache
		);
	}

	const object = await env.BLOBS.get(key);

	return r2Response(request, object, headersFor, isPublicCache, object?.body);
}

function r2Response(
	request: Request,
	object: R2Object | null,
	headersFor: (object: R2Object) => Headers,
	isPublicCache: boolean,
	body?: BodyInit
): Response {
	if (object === null) {
		return isPublicCache ? notFoundResponse() : uncachedNotFoundResponse();
	}

	const headers = privatise(headersFor(object), isPublicCache);

	if (isNotModified(request, headers)) {
		return notModified(headers);
	}

	return new Response(body, { headers });
}

// An authenticated body must not enter Workers Cache or an intermediary cache.
// Replace its public cache policy with `no-store`.
function privatise(headers: Headers, isPublicCache: boolean): Headers {
	if (!isPublicCache) {
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

function narInfoHeaders(
	object: R2Object,
	tenant: TenantId,
	cache: StoredCache,
	storePathHash: StorePathHash
): Headers {
	const headers = new Headers();
	object.writeHttpMetadata(headers);
	// Old R2 objects keep the response metadata from the version that wrote
	// them. Apply the current policy at the read boundary so an upgrade changes
	// the policy for existing narinfos too.
	headers.set('cache-control', narInfoCacheControl);
	headers.set('cache-tag', narInfoCacheTag(tenant, cache, storePathHash));
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
