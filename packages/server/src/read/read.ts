import {
	type CacheAccessMode,
	type CacheGeneration,
	type CacheScope,
	type NixSha256HashString,
	type StorePathHash,
	type TenantId
} from '@cupboard/nix-store/scalars';
import { type ReuseViewSelector } from '@cupboard/protocol/reuse-views';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';
import { and, eq, type SQL, sql } from 'drizzle-orm';
import { drizzle as drizzleD1, type DrizzleD1Database } from 'drizzle-orm/d1';
import { alias } from 'drizzle-orm/sqlite-core';
import { StatusCodes } from 'http-status-codes';

import {
	isNarInfoObjectOfCommit,
	type NarInfoReferenceVersion,
	recordedNarInfoMetadata
} from '../blob/narinfo-object-metadata.ts';
import { type TenantEntry } from '../control/tenant-membership.ts';
import {
	cacheIdentityCondition,
	cacheSelectorsCondition
} from '../db/cache.ts';
import {
	authorisedByPathGeneration,
	currentCacheGeneration,
	currentCacheGenerationReference,
	referencedCacheLifecycle
} from '../db/cache-generation.ts';
import * as d1Schema from '../db/d1-schema.ts';
import { readWithOneRetry } from '../db/transient.ts';
import { batchNonEmpty, maxOutgoingConnections } from '../do/bulk.ts';
import { type JsonValueList, jsonValueLists } from '../do/json-list.ts';
import { requireSubrequestsFor } from '../do/subrequest-slice.ts';
import { SharedFactsUnavailableError } from '../errors.ts';
import { narCacheTag, narInfoCacheTag } from '../http/cache-tags.ts';
import {
	isNotModified,
	narCacheControl,
	narInfoCacheControl,
	narInfoObjectKey,
	narObjectKey,
	type NarObjectName,
	notFoundResponse,
	type R2ObjectKey,
	r2ObjectKeySchema,
	uncachedNotFoundResponse
} from '../http/http.ts';

import {
	isReadAuthorised,
	readAccessToken,
	type ReadVerifier,
	unauthorisedResponse
} from './read-auth.ts';

interface CacheNarInfoVersion extends NarInfoReferenceVersion {
	readonly cacheGeneration: CacheGeneration;
}

export interface ReadEnv {
	readonly BLOBS: R2Bucket;
	readonly CUPBOARD_DB: D1Database;
	readonly CUPBOARD_DO: DurableObjectNamespace;
}

/**
 * The cache selected by a read request: which cache, which incarnation of its
 * name, and who may read it. Admission resolves all three from the cache's
 * lifecycle row.
 */
export interface ReadScope {
	readonly scope: CacheScope;
	readonly access: CacheAccessMode;
	readonly generation: CacheGeneration;
}

export interface CacheReadAuthentication {
	readonly cacheVerifier?: ReadVerifier;
	readonly isTokenAuthorised: (
		token: string,
		cache: CacheScope
	) => Promise<boolean>;
}

export interface ViewReadAuthentication {
	readonly verifier: ReadVerifier | undefined;
	readonly isTokenAuthorised: (token: string) => Promise<boolean>;
}

/**
 * Authenticates a read, or returns the refusal to send instead.
 *
 * Admission reads every verifier from the authoritative D1 rows on each
 * request, so a rotated or deleted verifier takes effect immediately.
 *
 * A private cache must authenticate. A content-read token can authorise the
 * cache directly. For a static credential, the cache-specific verifier takes
 * precedence over the tenant verifier. The control Worker streams private
 * content; token verification calls the tenant Worker once per request.
 */
export async function guardScopedRead(
	request: Request,
	entry: TenantEntry,
	scope: ReadScope,
	authentication: CacheReadAuthentication
): Promise<Response | undefined> {
	if (scope.access === 'public') {
		return undefined;
	}

	return authenticateRead(
		request,
		authentication.cacheVerifier ?? entry.readVerifier,
		(token) => authentication.isTokenAuthorised(token, scope.scope)
	);
}

/**
 * Authenticates a read of a private reuse view, or returns the refusal to send
 * instead.
 *
 * A view can select several caches. An exact view content-read token or the
 * tenant's static credential can authorise it; a cache-specific credential
 * grants access only to that cache.
 */
export function guardPrivateViewRead(
	request: Request,
	authentication: ViewReadAuthentication
): Promise<Response | undefined> {
	return authenticateRead(
		request,
		authentication.verifier,
		authentication.isTokenAuthorised
	);
}

async function authenticateRead(
	request: Request,
	verifier: ReadVerifier | undefined,
	isTokenAuthorised: (token: string) => Promise<boolean>
): Promise<Response | undefined> {
	const token = readAccessToken(request);

	if (token !== undefined) {
		return (await isTokenAuthorised(token))
			? undefined
			: unauthorisedResponse();
	}

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
 * Selects at most 65 readable references for one NAR. Cache selectors, access
 * policy and cache lifecycle generation filter the candidates before the
 * limit. Each candidate reports whether its path revocation fence permits
 * the read. A full page without authority requires a retry while maintenance
 * demotes revoked references.
 */
export function narReferenceQuery(
	database: DrizzleD1Database<typeof d1Schema>,
	tenant: TenantId,
	narHash: NixSha256HashString,
	authority: NarAuthority
) {
	return database
		.select({
			narHash: d1Schema.blobState.narHash,
			available: authorisedByPathGeneration().mapWith(Boolean).as('available')
		})
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
				currentCacheGenerationReference(),
				eq(d1Schema.blobReference.readable, true)
			)
		)
		.limit(65);
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
			narReferenceQuery(database, tenant, narHash, authority).all()
		);

		if (referenced.some((candidate) => candidate.available)) {
			return true;
		}
		if (referenced.length > 64) {
			throw new Error(
				'Path read authority demotion is pending. Retry the read.'
			);
		}
		return false;
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
 * Finds the newest readable reference above each requested path's revocation
 * fence in the current cache lifecycle generation. The query returns the
 * narinfo generation and NAR hash so the read can reject an object from
 * another publication.
 */
export function narInfoReferenceQuery(
	database: DrizzleD1Database<typeof d1Schema>,
	tenant: TenantId,
	cache: CacheScope,
	storePathHashes: JsonValueList<StorePathHash>
) {
	const edge = d1Schema.blobReference;
	const candidate = alias(edge, 'requested_path_reference');
	const fence = d1Schema.pathReadRevocation;
	const path = sql`requested_paths.value`;
	const lifecycleGeneration = currentCacheGeneration(tenant, cache);
	const cutoff = database
		.select({ generation: fence.generation })
		.from(fence)
		.where(
			and(
				eq(fence.tenant, tenant),
				cacheIdentityCondition(fence.cacheKind, fence.cacheName, cache),
				eq(fence.storePathHash, path),
				eq(fence.cacheGeneration, lifecycleGeneration)
			)
		)
		.limit(1);
	const latest = database
		.select({ generation: candidate.generation })
		.from(candidate)
		.where(
			and(
				eq(candidate.tenant, tenant),
				cacheIdentityCondition(candidate.cacheKind, candidate.cacheName, cache),
				eq(candidate.storePathHash, path),
				eq(candidate.cacheGeneration, lifecycleGeneration),
				eq(candidate.readable, true),
				sql`${candidate.generation} > coalesce((${cutoff}), -1)`
			)
		)
		.orderBy(sql`${candidate.generation} desc`)
		.limit(1);

	// Keep requested paths first: an INNER JOIN can choose blob_ref as the outer scan.
	return database
		.select({
			storePathHash: sql<StorePathHash>`${edge.storePathHash}`.as(
				'store_path_hash'
			),
			generation: sql<
				NarInfoReferenceVersion['generation']
			>`${edge.generation}`.as('generation'),
			narHash: sql<NixSha256HashString>`${edge.narHash}`.as('nar_hash'),
			cacheGeneration: sql<CacheGeneration>`${edge.cacheGeneration}`.as(
				'cache_generation'
			)
		})
		.from(sql`(${storePathHashes.getSQL()}) requested_paths cross join ${edge}`)
		.where(
			and(
				eq(edge.tenant, tenant),
				cacheIdentityCondition(edge.cacheKind, edge.cacheName, cache),
				eq(edge.storePathHash, path),
				eq(edge.generation, sql`(${latest})`)
			)
		);
}

// One D1 read, however many hashes: the list is bound as one parameter. The
// read is retried once after a transient failure, so it can make two calls.
export const cacheProbeD1CallsPerChunk = 2;

// Each hash costs a head of its narinfo object and a head of the NAR at the URL
// that the narinfo records.
export const cacheProbeHeadsPerHash = 2;

/**
 * Returns the current commit of each requested path in this cache, taken from
 * the reference edges the cache generation authorises.
 *
 * A recommit can leave an earlier edge in place until the teardown drain
 * removes it, so D1 can contain several authorised edges for one path. Narinfo
 * generations increase and are never reused for one cache and path.
 * The greatest generation therefore belongs to the current commit. A path with
 * no authorised edge is absent from the result.
 *
 * Retry the D1 query once, as the NAR read does: a persistent failure becomes a
 * retryable refusal instead of a 404 reporting the path as absent.
 */
export async function authorisedNarInfoVersions(
	database: DrizzleD1Database<typeof d1Schema>,
	tenant: TenantId,
	cache: CacheScope,
	storePathHashes: readonly StorePathHash[]
): Promise<ReadonlyMap<StorePathHash, CacheNarInfoVersion>> {
	try {
		const pages = await readWithOneRetry(() =>
			batchNonEmpty(
				database,
				jsonValueLists([...new Set(storePathHashes)]).map((list) =>
					narInfoReferenceQuery(database, tenant, cache, list)
				)
			)
		);
		const current = new Map<StorePathHash, CacheNarInfoVersion>();

		for (const edge of pages.flat()) {
			const known = current.get(edge.storePathHash);

			if (known === undefined || known.generation < edge.generation) {
				current.set(edge.storePathHash, {
					generation: edge.generation,
					narHash: edge.narHash,
					cacheGeneration: edge.cacheGeneration
				});
			}
		}

		return current;
	} catch (error) {
		throw new SharedFactsUnavailableError(error);
	}
}

// The reference generation fences every narinfo read, including public objects
// retained during destination inheritance. Object metadata must match the edge.
export async function serveNarInfo(
	request: Request,
	env: ReadEnv,
	tenant: TenantId,
	cache: ReadScope,
	storePathHash: StorePathHash,
	isAuthenticatedRead: boolean
): Promise<Response> {
	const key = narInfoObjectKey(
		tenant,
		storePathHash,
		cache.scope,
		cache.generation
	);
	const headersFor = (object: R2Object): Headers =>
		narInfoHeaders(object, tenant, cache.scope, storePathHash);

	const versions = await authorisedNarInfoVersions(
		drizzleD1(env.CUPBOARD_DB, { schema: d1Schema }),
		tenant,
		cache.scope,
		[storePathHash]
	);
	const current = versions.get(storePathHash);

	if (current === undefined) {
		return isAuthenticatedRead
			? uncachedNotFoundResponse()
			: notFoundResponse();
	}

	return serveR2(
		request,
		env,
		key,
		headersFor,
		!isAuthenticatedRead,
		(object) => isNarInfoObjectOfCommit(object, current)
	);
}

async function isPublishedNarAvailable(
	blobs: R2Bucket,
	object: R2Object
): Promise<boolean> {
	const narUrl = recordedNarInfoMetadata(object)?.narUrl;

	if (narUrl === undefined) {
		return false;
	}

	return (await blobs.head(r2ObjectKeySchema.parse(narUrl))) !== null;
}

/**
 * Which of the requested paths the cache cannot serve. Runs in the tenant
 * Durable Object, one chunk of a page per request: each hash costs a narinfo
 * head and a head of the NAR at the URL that the narinfo records. The Worker
 * sizes a chunk so the heads fit one invocation's subrequest slice
 * (`chunked-availability.ts`). A chunk that does not fit is refused, because
 * the sizing is derived from the same limits.
 */
export async function missingStorePathHashes(
	blobs: R2Bucket,
	database: DrizzleD1Database<typeof d1Schema>,
	tenant: TenantId,
	cache: CacheScope,
	storePathHashes: readonly StorePathHash[]
): Promise<StorePathHash[]> {
	const unique = [...new Set(storePathHashes)];
	// Resolve the current commit for each path before checking R2. Report the
	// path as missing if the object belongs to another commit, so the push does
	// not skip a path whose current publication is unavailable.
	const versions = await authorisedNarInfoVersions(
		database,
		tenant,
		cache,
		unique
	);
	requireSubrequestsFor(
		unique.length * cacheProbeHeadsPerHash,
		'cache availability probe'
	);
	const missing = await mapWithConcurrency(
		unique,
		maxOutgoingConnections,
		async (storePathHash) => {
			const current = versions.get(storePathHash);

			if (current === undefined) {
				return storePathHash;
			}

			const object = await blobs.head(
				narInfoObjectKey(tenant, storePathHash, cache, current.cacheGeneration)
			);

			if (object === null || !isNarInfoObjectOfCommit(object, current)) {
				return storePathHash;
			}

			if (!(await isPublishedNarAvailable(blobs, object))) {
				return storePathHash;
			}

			return;
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
// `isServable` validates an object after R2 returns it. An authenticated
// narinfo read uses the predicate to refuse an object whose recorded narinfo
// generation or NAR hash belongs to a superseded commit.
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
