import {
	type CacheAccessMode,
	cacheAccessModeSchema,
	type CacheName,
	type CacheScope,
	cacheScopeSchema,
	isSameCacheScope,
	nixSha256HashSchema,
	type NixSha256HashString,
	type TenantId
} from '@cupboard/nix-store/scalars';
import {
	type AuthorizationDetail,
	type AuthorizationDetails,
	isCoveredByToken
} from '@cupboard/protocol/grants';
import { type ReuseViewName } from '@cupboard/protocol/reuse-views';
import { and, eq, inArray } from 'drizzle-orm';
import { type DrizzleD1Database } from 'drizzle-orm/d1';
import { z } from 'zod';

import { cacheScopeFromRow } from '../db/cache.ts';
import {
	authorisedByPathGeneration,
	currentCacheGenerationReference,
	referencedCacheLifecycle
} from '../db/cache-generation.ts';
import * as d1Schema from '../db/d1-schema.ts';

import { type JsonValueList } from './json-list.ts';

/**
 * A readable reference from one cache in the tenant to a stored NAR, with the
 * cache's current access.
 */
export const reusableReferenceSchema = z.object({
	narHash: nixSha256HashSchema,
	cache: cacheScopeSchema,
	access: cacheAccessModeSchema
});
export type ReusableReference = z.infer<typeof reusableReferenceSchema>;

/**
 * The caches that one reuse view includes. A view includes only caches with
 * the same access as the view.
 */
export interface ReuseViewMembership {
	readonly view: ReuseViewName;
	readonly access: CacheAccessMode;
	readonly caches: readonly CacheScope[];
}

export interface ReuseAuthorityInput {
	readonly destination: CacheScope;
	/**
	 * The grants of the token that negotiates or commits the push.
	 */
	readonly grants: AuthorizationDetails;
	/**
	 * Reuse views and the caches that each one includes. A view permits reuse
	 * only when the grants also cover it for `view:content-read`.
	 */
	readonly views: readonly ReuseViewMembership[];
}

/**
 * A cache with a reference to a stored NAR, and the cache's access.
 */
export type ReferencingCache = Pick<ReusableReference, 'cache' | 'access'>;

/**
 * Decides whether a push may reuse a NAR that the tenant already stores
 * instead of uploading it. A reference permits the reuse only when the pusher
 * can already read the NAR through the referencing cache. That cache must be
 * the destination, a public cache, a cache that the grants cover for
 * `cache:content-read`, or a cache in a reuse view that the grants cover for
 * `view:content-read`.
 */
export class ReuseAuthority {
	constructor(private readonly input: ReuseAuthorityInput) {}

	private isReadableDirectly(reference: ReferencingCache): boolean {
		const { destination, grants } = this.input;

		return (
			isSameCacheScope(reference.cache, destination) ||
			reference.access === 'public' ||
			isCoveredByToken(grants, 'cache:content-read', { cache: reference.cache })
		);
	}

	private isReadableThroughView(reference: ReferencingCache): boolean {
		const { grants, views } = this.input;

		return views.some(
			(membership) =>
				membership.access === reference.access &&
				isCoveredByToken(grants, 'view:content-read', {
					view: membership.view
				}) &&
				membership.caches.some((cache) =>
					isSameCacheScope(cache, reference.cache)
				)
		);
	}

	permits(reference: ReferencingCache): boolean {
		return (
			this.isReadableDirectly(reference) ||
			this.isReadableThroughView(reference)
		);
	}

	permitsAny(references: readonly ReferencingCache[]): boolean {
		return references.some((reference) => this.permits(reference));
	}

	/**
	 * The NAR hashes that have at least one permitting reference.
	 */
	permittedNarHashes(
		references: readonly ReusableReference[]
	): ReadonlySet<NixSha256HashString> {
		return new Set(
			references
				.filter((reference) => this.permits(reference))
				.map((reference) => reference.narHash)
		);
	}
}

function isReuseGrant(grant: AuthorizationDetail): boolean {
	switch (grant.type) {
		case 'cupboard_wildcard':
		case 'cupboard_view': {
			return true;
		}
		case 'cupboard_cache': {
			return isCoveredByToken([grant], 'cache:content-read', {
				cache: grant.cache
			});
		}
		case 'cupboard_domain':
		case 'cupboard_tenant':
		case 'cupboard_control': {
			return false;
		}
	}
}

/**
 * The grants that {@link ReuseAuthority} consults. A commit session persists only
 * these in durable storage for reuse checks after hibernation.
 */
export function reuseGrants(
	grants: AuthorizationDetails
): AuthorizationDetails {
	return grants.filter((grant) => isReuseGrant(grant));
}

/**
 * Selects, for each listed NAR, every cache that has a readable reference to
 * it in the cache's current generation, with the cache's access. One row
 * covers all of a cache's references to the NAR. A reference counts only when
 * the tenant also owns the blob.
 */
export function readableReferenceSelect(
	database: DrizzleD1Database<typeof d1Schema>,
	tenant: TenantId,
	narHashes: JsonValueList<NixSha256HashString>
) {
	const reference = d1Schema.blobReference;
	const owned = and(
		eq(d1Schema.tenantBlob.tenant, reference.tenant),
		eq(d1Schema.tenantBlob.narHash, reference.narHash)
	);

	return database
		.select({
			narHash: reference.narHash,
			cacheKind: reference.cacheKind,
			cacheName: reference.cacheName,
			access: d1Schema.cacheLifecycle.access
		})
		.from(reference)
		.innerJoin(d1Schema.tenantBlob, owned)
		.innerJoin(d1Schema.cacheLifecycle, referencedCacheLifecycle())
		.where(
			and(
				eq(reference.tenant, tenant),
				inArray(reference.narHash, narHashes),
				eq(reference.readable, true),
				currentCacheGenerationReference(),
				authorisedByPathGeneration()
			)
		)
		.groupBy(
			reference.narHash,
			reference.cacheKind,
			reference.cacheName,
			d1Schema.cacheLifecycle.access
		);
}

export function reusableReference(row: {
	readonly narHash: NixSha256HashString;
	readonly cacheKind: CacheScope['kind'];
	readonly cacheName: CacheName | null;
	readonly access: CacheAccessMode;
}): ReusableReference {
	return {
		narHash: row.narHash,
		cache: cacheScopeFromRow({ kind: row.cacheKind, name: row.cacheName }),
		access: row.access
	};
}
