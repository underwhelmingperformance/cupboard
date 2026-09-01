import {
	type CacheAccessMode,
	type CacheGeneration,
	type CacheReadRevision,
	type CacheScope,
	type NixSha256HashString,
	type StorePathHash,
	type TenantId
} from '@cupboard/nix-store/scalars';
import { type ReuseViewSelector } from '@cupboard/protocol/reuse-views';
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
	cacheIdentityCondition,
	cacheSelectorsCondition
} from '../db/cache.ts';
import {
	authorisedByCacheGeneration,
	referencedCacheLifecycle
} from '../db/cache-generation.ts';
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
	legacyNarInfoObjectKey,
	narCacheControl,
	narInfoCacheControl,
	narInfoObjectKey,
	narObjectKey,
	type NarObjectName,
	notFoundResponse,
	type R2ObjectKey,
	uncachedNotFoundResponse
} from '../http/http.ts';

import {
	isReadAuthorised,
	type ReadVerifier,
	unauthorisedResponse
} from './read-auth.ts';

interface ReadEnv {
	readonly BLOBS: R2Bucket;
	readonly CUPBOARD_DB: D1Database;
	readonly CUPBOARD_DO: DurableObjectNamespace;
}

/**
 * The cache selected by a read request.
 */
export interface ReadScope {
	readonly scope: CacheScope;
	readonly access: CacheAccessMode;
	readonly generation: CacheGeneration;
	readonly readRevision: CacheReadRevision;
}

/**
 * Authenticates a read, or returns the refusal to send instead.
 *
 * Admission reads every verifier from the authoritative D1 rows on each
 * request, so a rotated or deleted verifier takes effect immediately.
 *
 * A private cache must authenticate. `cacheVerifier` is the cache-specific
 * verifier, when present. Otherwise the guard uses the tenant verifier. If
 * neither verifier exists, the guard refuses the request. Authenticated reads
 * stay on the control Worker and never enter the cache-owning tenant Worker.
 */
export async function guardScopedRead(
	request: Request,
	entry: TenantEntry,
	scope: ReadScope,
	cacheVerifier?: ReadVerifier
): Promise<Response | undefined> {
	if (scope.access === 'public') {
		return undefined;
	}

	return authenticateRead(request, cacheVerifier ?? entry.readVerifier);
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
	verifier: ReadVerifier | undefined
): Promise<Response | undefined> {
	return authenticateRead(request, verifier);
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
 * A direct cache read counts only reference rows for that cache. A reuse-view
 * NAR read counts rows from caches selected by that exact view. Both forms also
 * require the cache's current access to match the route that admitted the read.
 */
export type NarAuthority =
	| {
			readonly kind: 'cache';
			readonly scope: CacheScope;
			readonly access: CacheAccessMode;
	  }
	| {
			readonly kind: 'view';
			readonly selectors: readonly ReuseViewSelector[];
			readonly access: CacheAccessMode;
	  };

export function narAuthorityForScope(scope: ReadScope): NarAuthority {
	return { kind: 'cache', scope: scope.scope, access: scope.access };
}

export function narAuthorityForView(
	access: CacheAccessMode,
	selectors: readonly ReuseViewSelector[]
): NarAuthority {
	return { kind: 'view', access, selectors };
}

// An unreferenced NAR and an absent object both return 404, so the response does
// not reveal whether the hash exists outside the caches that authorise this
// read.
export async function serveNar(
	request: Request,
	env: ReadEnv,
	tenant: TenantId,
	nar: NarObjectName,
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
		(object) =>
			narHeaders(
				object,
				tenant,
				nar.narHash,
				!isPrivate && authority.kind === 'cache' ? authority.scope : undefined
			),
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
 * synchronously to revoke read authority. Every live cache has a lifecycle row;
 * the inner join also rejects references whose catalogue entry is absent.
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
		.innerJoin(d1Schema.cacheLifecycle, referencedCacheLifecycle())
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
		return and(
			cacheIdentityCondition(
				d1Schema.blobReference.cacheKind,
				d1Schema.blobReference.cacheName,
				authority.scope
			),
			eq(d1Schema.cacheLifecycle.access, authority.access)
		);
	}

	return and(
		cacheSelectorsCondition(
			d1Schema.blobReference.cacheKind,
			d1Schema.blobReference.cacheName,
			authority.selectors
		),
		eq(d1Schema.cacheLifecycle.access, authority.access)
	);
}

/**
 * Builds the reference-edge lookup that authorises narinfo reads.
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
	cache: CacheScope,
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
				cacheIdentityCondition(
					d1Schema.blobReference.cacheKind,
					d1Schema.blobReference.cacheName,
					cache
				),
				inArray(d1Schema.blobReference.storePathHash, storePathHashes),
				authorisedByCacheGeneration()
			)
		);
}

/**
 * Returns the current commit of each requested path in this cache,
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
	cache: CacheScope,
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
// A read serves the object only when an authorised reference edge
// matches the path and the object's recorded generation and NAR hash match that
// edge. Without the second check, a reader of a recreated cache could receive
// the object published by the previous cache with that name.
export async function serveNarInfo(
	request: Request,
	env: ReadEnv,
	tenant: TenantId,
	cache: ReadScope,
	storePathHash: StorePathHash,
	isPrivate: boolean
): Promise<Response> {
	const key = narInfoObjectKey(
		tenant,
		storePathHash,
		cache.scope,
		cache.generation
	);
	const headersFor = (object: R2Object): Headers =>
		narInfoHeaders(object, tenant, cache.scope, storePathHash);
	const legacyKey = legacyNarInfoObjectKey(tenant, storePathHash, cache.scope);

	const versions = await authorisedNarInfoVersions(env, tenant, cache.scope, [
		storePathHash
	]);
	const current = versions.get(storePathHash);

	if (current === undefined) {
		return uncachedNotFoundResponse();
	}

	return serveR2(
		request,
		env,
		key,
		headersFor,
		!isPrivate,
		(object) => isNarInfoObjectOfCommit(object, current),
		legacyKey
	);
}

/**
 * Which of the requested paths the cache cannot serve.
 */
export async function missingStorePathHashes(
	env: Env,
	tenant: TenantId,
	cache: ReadScope,
	storePathHashes: readonly StorePathHash[]
): Promise<StorePathHash[]> {
	const unique = [...new Set(storePathHashes)];
	// Resolve the current commit for every path before checking R2. Public and
	// private reads use the same generation fence, so recreation cannot make a
	// stale object satisfy availability.
	const versions = await authorisedNarInfoVersions(
		env,
		tenant,
		cache.scope,
		unique
	);
	const missing = await mapWithConcurrency(
		unique,
		maxOutgoingConnections,
		async (storePathHash) => {
			const current = versions.get(storePathHash);

			if (current === undefined) {
				return storePathHash;
			}

			const key = narInfoObjectKey(
				tenant,
				storePathHash,
				cache.scope,
				cache.generation
			);
			const object =
				(await env.BLOBS.head(key)) ??
				(await env.BLOBS.head(
					legacyNarInfoObjectKey(tenant, storePathHash, cache.scope)
				));
			const isServable =
				object !== null && isNarInfoObjectOfCommit(object, current);

			return isServable ? undefined : storePathHash;
		}
	);

	return missing.filter(
		(storePathHash): storePathHash is StorePathHash =>
			storePathHash !== undefined
	);
}

// Public origin requests reach the cache-owning tenant Worker only after
// control admission; private requests stay on the uncached control Worker.
//
// `isServable` validates an object after R2 returns it. Narinfo reads use the
// predicate to refuse an object from a previous cache with the same stored name.
async function serveR2(
	request: Request,
	env: ReadEnv,
	key: R2ObjectKey,
	headersFor: (object: R2Object) => Headers,
	isPublicCache: boolean,
	isServable?: (object: R2Object) => boolean,
	fallbackKey?: R2ObjectKey
): Promise<Response> {
	if (!isPublicCache && request.method === 'HEAD') {
		const primary = await env.BLOBS.head(key);
		const object =
			primary === null && fallbackKey !== undefined
				? await env.BLOBS.head(fallbackKey)
				: primary;

		return r2Response(request, object, headersFor, isPublicCache, isServable);
	}

	const primary = await env.BLOBS.get(key);
	const object =
		primary === null && fallbackKey !== undefined
			? await env.BLOBS.get(fallbackKey)
			: primary;

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

// The tag lets a deletion invalidate a public cache's NAR response once that
// cache stops referencing the hash. Private and reuse-view reads are no-store
// and therefore need no tag.
function narHeaders(
	object: R2Object,
	tenant: TenantId,
	narHash: NixSha256HashString,
	cache: CacheScope | undefined
): Headers {
	const headers = new Headers({
		'cache-control': narCacheControl,
		'content-type': 'application/zstd',
		etag: object.httpEtag,
		'last-modified': object.uploaded.toUTCString()
	});

	if (cache !== undefined) {
		headers.set('cache-tag', narCacheTag(tenant, cache, narHash));
	}

	headers.set('content-length', String(object.size));

	return headers;
}

function narInfoHeaders(
	object: R2Object,
	tenant: TenantId,
	cache: CacheScope,
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
