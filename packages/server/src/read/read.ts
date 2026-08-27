import { CacheInfo } from '@cupboard/nix-store/cache-info';
import {
	DEFAULT_CACHE,
	isPrivateCache,
	type NixSha256HashString,
	type StoredCache,
	type StorePathHash,
	type TenantId
} from '@cupboard/nix-store/scalars';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';
import { and, eq, inArray, type SQL } from 'drizzle-orm';
import { drizzle as drizzleD1, type DrizzleD1Database } from 'drizzle-orm/d1';
import { StatusCodes } from 'http-status-codes';

import {
	isNarInfoObjectOfCommit,
	type NarInfoReferenceVersion
} from '../blob/narinfo-object-metadata.ts';
import { type TenantEntry } from '../control/tenant-membership.ts';
import {
	authorisedByCacheGeneration,
	referencedCacheLifecycle
} from '../db/cache-generation.ts';
import {
	outsidePrivateCaches,
	withinPrivateCaches
} from '../db/cache-range.ts';
import * as d1Schema from '../db/d1-schema.ts';
import { readWithOneRetry } from '../db/transient.ts';
import {
	batchNonEmpty,
	chunk,
	maxInClauseValues,
	maxOutgoingConnections
} from '../do/bulk.ts';
import { SharedFactsUnavailableError } from '../errors.ts';
import { narCacheTag, narInfoCacheTag } from '../http/cache-tags.ts';
import {
	isNotModified,
	narCacheControl,
	narInfoCacheControl,
	narInfoObjectKey,
	narObjectKey,
	notFoundResponse,
	type ParsedNarName,
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
 * The namespace and cache selected by a read request. The tenant's read mode
 * determines whether a public-cache read requires authentication. Every
 * private-cache read requires it.
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
 * cache-specific verifier, when present. Only a matching credential opens that
 * cache. Otherwise the guard uses the tenant verifier. If neither verifier
 * exists, the guard refuses the request.
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

/**
 * Authenticates a read of a private reuse view, or returns the refusal to send
 * instead.
 *
 * A view can select several caches, so only the tenant verifier authorises the
 * read. A cache-specific verifier grants access only to that cache, not to a
 * view over it. A tenant without a verifier therefore has no readable private
 * view.
 */
export function guardPrivateViewRead(
	request: Request,
	entry: TenantEntry
): Promise<Response | undefined> {
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

/**
 * Which reference rows may authorise a NAR read.
 *
 * R2 stores one NAR object for each hash. Every cache that has committed a
 * narinfo for that hash has a corresponding `blob_ref` row. The read surface
 * determines which reference rows can authorise the request.
 *
 * A read in the public namespace counts rows from the tenant's public caches.
 * These caches share one read rule. A public tenant requires no credential; a
 * private tenant requires the tenant credential. Public caches have no
 * cache-specific credentials. A reader authorised for one public cache can
 * address any other public cache, so the reference check uses the complete
 * public namespace.
 *
 * A read in the private namespace selects one cache, which can have its own
 * credential. Only reference rows for that cache authorise the NAR.
 *
 * A read through a private reuse view counts rows from all of the tenant's
 * private caches. Only the tenant credential opens a private view, and every
 * private view selects from this range, so the private cache range is the
 * reference boundary.
 */
export type NarAuthority =
	| { readonly kind: 'cache'; readonly cache: StoredCache }
	| { readonly kind: 'namespace'; readonly visibility: 'public' | 'private' };

export const publicNarAuthority: NarAuthority = {
	kind: 'namespace',
	visibility: 'public'
};

export const privateNamespaceNarAuthority: NarAuthority = {
	kind: 'namespace',
	visibility: 'private'
};

export function narAuthorityForScope(scope: ReadScope): NarAuthority {
	return scope.visibility === 'private'
		? { kind: 'cache', cache: scope.cache }
		: publicNarAuthority;
}

// An unreferenced NAR and an absent object both return 404, so the response does
// not reveal whether the hash exists outside the caches that authorise this
// read.
export async function serveNar(
	request: Request,
	env: ReadEnv,
	tenant: TenantId,
	nar: ParsedNarName,
	authority: NarAuthority,
	isPrivate: boolean
): Promise<Response> {
	const isReferenced = await isNarReferenced(
		env,
		tenant,
		nar.narHash,
		authority
	);

	if (!isReferenced) {
		return isPrivate ? uncachedNotFoundResponse() : notFoundResponse();
	}

	return serveR2(
		request,
		env,
		narObjectKey(nar.narHash, nar.incarnation),
		(object) => narHeaders(object, tenant, nar.narHash),
		!isPrivate
	);
}

/**
 * Builds the lookup that authorises one NAR read: one seek into `blob_ref` over
 * `(tenant, nar_hash, cache, cache_generation)`, joined to the blob's verified
 * state and to the lifecycle row of the referencing cache.
 *
 * Advancing the cache generation makes every edge from an earlier generation
 * stop authorising reads, so cache deletion does not need to retire those edges
 * synchronously to revoke read authority. The join is a left join because a
 * cache that has never been deleted has no lifecycle row.
 *
 * The index test builds this statement so that it inspects the query the read
 * path runs.
 */
export function narReferenceQuery(
	database: DrizzleD1Database<typeof d1Schema>,
	tenant: TenantId,
	narHash: NixSha256HashString,
	authority: NarAuthority
) {
	return database
		.select({ narHash: d1Schema.blobState.narHash })
		.from(d1Schema.blobReference)
		.innerJoin(
			d1Schema.blobState,
			eq(d1Schema.blobState.narHash, d1Schema.blobReference.narHash)
		)
		.leftJoin(d1Schema.cacheLifecycle, referencedCacheLifecycle())
		.where(
			and(
				eq(d1Schema.blobReference.tenant, tenant),
				eq(d1Schema.blobReference.narHash, narHash),
				referencingCaches(authority),
				authorisedByCacheGeneration()
			)
		);
}

// Retry the D1 reference query once. A persistent failure becomes a retryable
// refusal instead of a 404, which would report the NAR as absent.
async function isNarReferenced(
	env: Pick<ReadEnv, 'CUPBOARD_DB'>,
	tenant: TenantId,
	narHash: NixSha256HashString,
	authority: NarAuthority
): Promise<boolean> {
	const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });

	try {
		const referenced = await readWithOneRetry(() =>
			narReferenceQuery(database, tenant, narHash, authority).get()
		);

		return referenced !== undefined;
	} catch (error) {
		throw new SharedFactsUnavailableError(error);
	}
}

function referencingCaches(authority: NarAuthority): SQL | undefined {
	if (authority.kind === 'cache') {
		return eq(d1Schema.blobReference.cache, authority.cache);
	}

	return authority.visibility === 'private'
		? withinPrivateCaches(d1Schema.blobReference.cache)
		: outsidePrivateCaches(d1Schema.blobReference.cache);
}

/**
 * Builds the reference-edge lookup that authorises private narinfo reads.
 *
 * A single narinfo GET or HEAD supplies one store-path hash and seeks
 * `blob_ref` through its existing `(tenant, cache, store_path_hash,
 * generation)` primary key, joined to the cache lifecycle row. Availability
 * splits larger hash sets at D1's parameter limit and sends all resulting
 * lookups in one batch.
 *
 * A deleted cache keeps its path-keyed narinfo objects until the teardown drain
 * removes them. The same stored name can be registered again before that drain
 * finishes. Object presence therefore does not establish that the current
 * cache contains the path. The query requires an edge authorised by the current
 * cache generation. It also returns the narinfo generation and NAR hash so the
 * read can reject an object from another commit.
 *
 * The index test builds this statement so that it inspects the query the read
 * path runs.
 */
export function narInfoReferenceQuery(
	database: DrizzleD1Database<typeof d1Schema>,
	tenant: TenantId,
	cache: StoredCache,
	storePathHashes: readonly StorePathHash[]
) {
	return database
		.select({
			storePathHash: d1Schema.blobReference.storePathHash,
			generation: d1Schema.blobReference.generation,
			narHash: d1Schema.blobReference.narHash
		})
		.from(d1Schema.blobReference)
		.leftJoin(d1Schema.cacheLifecycle, referencedCacheLifecycle())
		.where(
			and(
				eq(d1Schema.blobReference.tenant, tenant),
				eq(d1Schema.blobReference.cache, cache),
				inArray(d1Schema.blobReference.storePathHash, storePathHashes),
				authorisedByCacheGeneration()
			)
		);
}

/**
 * Returns the current commit of each requested path in this private cache,
 * taken from the reference edges the cache generation authorises.
 *
 * A recommit can leave an earlier edge in place until the teardown drain
 * removes it, so D1 can contain several authorised edges for one path. Narinfo
 * generations increase and are never reused for a stored cache name and path.
 * The greatest generation therefore belongs to the current commit. A path with
 * no authorised edge is absent from the result.
 *
 * Retry the D1 query once, as the NAR read does: a persistent failure becomes a
 * retryable refusal instead of a 404 reporting the path as absent.
 */
async function authorisedNarInfoVersions(
	env: Pick<ReadEnv, 'CUPBOARD_DB'>,
	tenant: TenantId,
	cache: StoredCache,
	storePathHashes: readonly StorePathHash[]
): Promise<ReadonlyMap<StorePathHash, NarInfoReferenceVersion>> {
	const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });

	try {
		const pages = await readWithOneRetry(() =>
			batchNonEmpty(
				database,
				chunk([...new Set(storePathHashes)], maxInClauseValues).map((batch) =>
					narInfoReferenceQuery(database, tenant, cache, batch)
				)
			)
		);
		const current = new Map<StorePathHash, NarInfoReferenceVersion>();

		for (const edge of pages.flat()) {
			const known = current.get(edge.storePathHash);

			if (known === undefined || known.generation < edge.generation) {
				current.set(edge.storePathHash, {
					generation: edge.generation,
					narHash: edge.narHash
				});
			}
		}

		return current;
	} catch (error) {
		throw new SharedFactsUnavailableError(error);
	}
}

// The request URL isolates cached narinfos by tenant and cache. The response uses
// the same tenant, cache, and path identity in its cache tag so deletion and
// re-signing purge only this narinfo.
//
// A private read serves the object only when an authorised reference edge
// matches the path and the object's recorded generation and NAR hash match that
// edge. Without the second check, a reader of a recreated cache could receive
// the object published by the previous cache with that name. Public caches accept
// the eventual removal of a deleted cache's objects instead, which keeps the
// cacheable read path free of D1.
export async function serveNarInfo(
	request: Request,
	env: ReadEnv,
	tenant: TenantId,
	cache: StoredCache,
	storePathHash: StorePathHash,
	isPrivate: boolean
): Promise<Response> {
	const key = narInfoObjectKey(tenant, storePathHash, cache);
	const headersFor = (object: R2Object): Headers =>
		narInfoHeaders(object, tenant, cache, storePathHash);

	if (!isPrivateCache(cache)) {
		return serveR2(request, env, key, headersFor, !isPrivate);
	}

	const versions = await authorisedNarInfoVersions(env, tenant, cache, [
		storePathHash
	]);
	const current = versions.get(storePathHash);

	if (current === undefined) {
		return uncachedNotFoundResponse();
	}

	return serveR2(request, env, key, headersFor, !isPrivate, (object) =>
		isNarInfoObjectOfCommit(object, current)
	);
}

/**
 * Which of the requested paths the cache cannot serve.
 */
export async function missingStorePathHashes(
	env: Env,
	tenant: TenantId,
	cache: StoredCache,
	storePathHashes: readonly StorePathHash[]
): Promise<StorePathHash[]> {
	const unique = [...new Set(storePathHashes)];
	// For a private cache, resolve the current commit for each path before
	// checking R2. Report the path as missing if the object belongs to another
	// commit. A narinfo GET would refuse that object, so the push must not skip
	// the path.
	const versions = isPrivateCache(cache)
		? await authorisedNarInfoVersions(env, tenant, cache, unique)
		: undefined;
	const missing = await mapWithConcurrency(
		unique,
		maxOutgoingConnections,
		async (storePathHash) => {
			const current = versions?.get(storePathHash);

			if (versions !== undefined && current === undefined) {
				return storePathHash;
			}

			const object = await env.BLOBS.head(
				narInfoObjectKey(tenant, storePathHash, cache)
			);
			const isServable =
				object !== null &&
				(current === undefined || isNarInfoObjectOfCommit(object, current));

			return isServable ? undefined : storePathHash;
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

// Public origin requests reach the cache-owning tenant Worker only after
// control admission; private requests stay on the uncached control Worker.
//
// `isServable` validates an object after R2 returns it. A private narinfo read
// uses the predicate to refuse an object from a previous cache with the same
// stored name.
async function serveR2(
	request: Request,
	env: ReadEnv,
	key: R2ObjectKey,
	headersFor: (object: R2Object) => Headers,
	isPublicCache: boolean,
	isServable?: (object: R2Object) => boolean
): Promise<Response> {
	if (!isPublicCache && request.method === 'HEAD') {
		return r2Response(
			request,
			await env.BLOBS.head(key),
			headersFor,
			isPublicCache,
			isServable
		);
	}

	const object = await env.BLOBS.get(key);

	return r2Response(
		request,
		object,
		headersFor,
		isPublicCache,
		isServable,
		object?.body
	);
}

function r2Response(
	request: Request,
	object: R2Object | null,
	headersFor: (object: R2Object) => Headers,
	isPublicCache: boolean,
	isServable?: (object: R2Object) => boolean,
	body?: BodyInit
): Response {
	if (object === null) {
		return isPublicCache ? notFoundResponse() : uncachedNotFoundResponse();
	}

	if (isServable !== undefined && !isServable(object)) {
		return uncachedNotFoundResponse();
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

// The tag lets a deletion invalidate a cached NAR once the tenant's caches stop
// referencing its hash. Without it a stored response would keep answering
// readers for the whole of its long lifetime.
function narHeaders(
	object: R2Object,
	tenant: TenantId,
	narHash: NixSha256HashString
): Headers {
	const headers = new Headers({
		'cache-control': narCacheControl,
		'cache-tag': narCacheTag(tenant, narHash),
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
