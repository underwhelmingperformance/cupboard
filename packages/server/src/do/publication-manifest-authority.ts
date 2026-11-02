import type {
	CacheGeneration,
	CacheScope,
	NarInfoGeneration,
	NixSha256HashString,
	StorePathString
} from '@cupboard/nix-store/scalars';
import { isSameCacheScope } from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import {
	type AuthorizationDetails,
	isCoveredByToken
} from '@cupboard/protocol/grants';
import type {
	PublicationResultIdentity,
	PublicationSourceSelector,
	RecordedPublication
} from '@cupboard/protocol/publication-manifests';
import { ORPCError } from '@orpc/server';
import { and, eq, isNull } from 'drizzle-orm';

import { cacheSelectorsCondition, type ResolvedCache } from '../db/cache.ts';
import * as schema from '../db/schema.ts';
import { requireServedStorePaths } from '../policy/served-store.ts';
import { authorisedNarInfoVersions } from '../read/read.ts';

import type { ServerContext } from './context.ts';
import { NarInfoObjectsService } from './narinfo-objects-service.ts';
import {
	type PublicationManifestAvailabilitySnapshot,
	PublicationManifestAvailabilityStore,
	type PublicationManifestAvailabilityVersion
} from './publication-manifest-availability-store.ts';
import { ReuseViewLookupService } from './reuse-view-lookup-service.ts';
import { reuseViewSelectorsFromRows } from './reuse-view-selectors.ts';

/**
A local, exact source snapshot. Revalidate under the final local gate.
*/
export interface PublicationManifestAuthoritySnapshot {
	readonly destinationScope: CacheScope;
	// First promotion may precede destination registration. Absence is fenced,
	// never replaced with the source cache's authority or identity.
	readonly destination: ResolvedCache | undefined;
	readonly cache: ResolvedCache;
	readonly result: PublicationResultIdentity;
	readonly availability: PublicationManifestAvailabilitySnapshot;
	readonly sourceSelector?: PublicationSourceSelector;
	readonly publication?: RecordedPublication;
}

export interface PublicationManifestTarget {
	readonly storePath: StorePathString;
	readonly narHash?: NixSha256HashString;
	readonly generation?: NarInfoGeneration;
}

/**
Source readability is additional to the route's destination commit grant.
*/
export class PublicationManifestAuthority {
	constructor(private readonly context: ServerContext) {}

	private currentCache(
		scope: CacheScope,
		expectedGeneration?: CacheGeneration
	): ResolvedCache {
		const cache = this.context.cacheRepository.resolve(scope);
		if (
			cache === undefined ||
			(expectedGeneration !== undefined &&
				cache.generation !== expectedGeneration)
		) {
			throw new ORPCError('PUBLICATION_GENERATION_CONFLICT');
		}
		return cache;
	}

	private requireView(
		cache: ResolvedCache,
		selector: PublicationSourceSelector,
		grants: AuthorizationDetails
	): void {
		const view = this.context.db
			.select()
			.from(schema.reuseViews)
			.where(eq(schema.reuseViews.name, selector.view))
			.get();
		if (
			view?.revision !== selector.expectedRevision ||
			view.access !== cache.access
		) {
			throw new ORPCError('PUBLICATION_SCOPE_CHANGED');
		}
		if (
			view.access === 'private' &&
			!isCoveredByToken(grants, 'view:content-read', { view: selector.view })
		) {
			throw new ORPCError('FORBIDDEN');
		}
		const selectors = reuseViewSelectorsFromRows(
			selector.view,
			this.context.db
				.select()
				.from(schema.nativeReuseViewSelectors)
				.where(eq(schema.nativeReuseViewSelectors.view, selector.view))
				.all()
		);
		const included = this.context.db
			.select({ id: schema.cacheIdentities.id })
			.from(schema.cacheIdentities)
			.where(
				and(
					eq(schema.cacheIdentities.id, cache.id),
					isNull(schema.cacheIdentities.deletedAt),
					cacheSelectorsCondition(
						schema.cacheIdentities.kind,
						schema.cacheIdentities.name,
						selectors
					)
				)
			)
			.get();
		if (included === undefined) {
			throw new ORPCError('PUBLICATION_SCOPE_CHANGED');
		}
	}

	private availabilityVersion(
		snapshot: PublicationManifestAuthoritySnapshot
	): PublicationManifestAvailabilityVersion {
		return {
			cacheId: snapshot.cache.id,
			cacheGeneration: snapshot.cache.generation,
			storePathHash: StorePath.hash(snapshot.result.storePath),
			generation: snapshot.result.generation,
			storePath: snapshot.result.storePath,
			narHash: snapshot.result.narHash
		};
	}

	private isAvailabilityCurrent(
		snapshot: PublicationManifestAuthoritySnapshot
	): boolean {
		return new PublicationManifestAvailabilityStore(this.context.db).isCurrent(
			this.availabilityVersion(snapshot),
			snapshot.availability
		);
	}

	/**
	Resolve a concrete source without requiring the caller to know its path version. Call under the local gate.
	*/
	findTarget(
		destination: CacheScope,
		grants: AuthorizationDetails,
		source: CacheScope,
		target: PublicationManifestTarget,
		expectedCacheGeneration?: CacheGeneration,
		sourceSelector?: PublicationSourceSelector
	): PublicationManifestAuthoritySnapshot | undefined {
		requireServedStorePaths([target.storePath]);
		const resolvedDestination =
			this.context.cacheRepository.resolve(destination);
		if (
			resolvedDestination === undefined &&
			expectedCacheGeneration === undefined &&
			sourceSelector === undefined &&
			target.narHash === undefined &&
			target.generation === undefined &&
			isSameCacheScope(source, destination) &&
			isCoveredByToken(grants, 'upload:commit', { cache: destination })
		) {
			return undefined;
		}

		const cache = this.currentCache(source, expectedCacheGeneration);
		if (sourceSelector !== undefined) {
			this.requireView(cache, sourceSelector, grants);
		}
		if (
			!new ReuseViewLookupService(this.context)
				.reuseAuthority(destination, grants)
				.permits({ cache: cache.scope, access: cache.access })
		) {
			throw new ORPCError('FORBIDDEN');
		}
		const hash = StorePath.hash(target.storePath);
		const row = this.context.db
			.select({
				storePath: schema.narInfos.storePath,
				narHash: schema.narInfos.narHash,
				generation: schema.narInfos.generation
			})
			.from(schema.narInfos)
			.where(
				and(
					eq(schema.narInfos.cacheId, cache.id),
					eq(schema.narInfos.storePathHash, hash)
				)
			)
			.get();
		if (
			row?.storePath !== target.storePath &&
			target.narHash === undefined &&
			target.generation === undefined
		) {
			return undefined;
		}
		if (
			row?.storePath !== target.storePath ||
			(target.narHash !== undefined && row.narHash !== target.narHash) ||
			(target.generation !== undefined && row.generation !== target.generation)
		) {
			throw new ORPCError('PUBLICATION_RESULT_CHANGED');
		}
		const availability = new PublicationManifestAvailabilityStore(
			this.context.db
		).snapshot({
			cacheId: cache.id,
			cacheGeneration: cache.generation,
			storePathHash: hash,
			...row
		});
		return {
			availability,
			destinationScope: destination,
			destination: resolvedDestination,
			cache,
			result: { ...row, cache: cache.scope, cacheGeneration: cache.generation },
			...(sourceSelector !== undefined && { sourceSelector })
		};
	}

	resolveTarget(
		destination: CacheScope,
		grants: AuthorizationDetails,
		source: CacheScope,
		target: PublicationManifestTarget,
		expectedCacheGeneration?: CacheGeneration,
		sourceSelector?: PublicationSourceSelector
	): PublicationManifestAuthoritySnapshot {
		const snapshot = this.findTarget(
			destination,
			grants,
			source,
			target,
			expectedCacheGeneration,
			sourceSelector
		);
		if (snapshot === undefined) {
			throw new ORPCError('PUBLICATION_RESULT_CHANGED');
		}
		return snapshot;
	}

	/**
	Resolve one recorded result in the actual destination's authority scope.
	*/
	resolveExact(
		destination: CacheScope,
		grants: AuthorizationDetails,
		result: PublicationResultIdentity,
		sourceSelector?: PublicationSourceSelector
	): PublicationManifestAuthoritySnapshot {
		return this.resolveTarget(
			destination,
			grants,
			result.cache,
			result,
			result.cacheGeneration,
			sourceSelector
		);
	}

	/**
	Resolve the exact immutable association as well as the accepted result.
	*/
	resolveRecorded(
		destination: CacheScope,
		grants: AuthorizationDetails,
		publication: RecordedPublication,
		sourceSelector?: PublicationSourceSelector
	): PublicationManifestAuthoritySnapshot {
		const snapshot = this.resolveExact(
			destination,
			grants,
			publication.result,
			sourceSelector
		);
		const association = schema.resultPublications;
		const manifest = schema.publicationManifests;
		const hash = StorePath.hash(publication.result.storePath);
		const recorded = this.context.db
			.select({
				digest: association.digest,
				origin: association.origin,
				memberCount: manifest.memberCount
			})
			.from(association)
			.innerJoin(manifest, eq(manifest.digest, association.digest))
			.where(
				and(
					eq(association.cacheId, snapshot.cache.id),
					eq(association.cacheGeneration, publication.result.cacheGeneration),
					eq(association.resultHash, hash),
					eq(association.resultGeneration, publication.result.generation),
					eq(association.resultPath, publication.result.storePath),
					eq(association.resultNarHash, publication.result.narHash)
				)
			)
			.get();
		if (
			recorded?.digest !== publication.digest ||
			recorded.memberCount !== publication.memberCount ||
			recorded.origin !== publication.origin
		) {
			throw new ORPCError('PUBLICATION_RESULT_CHANGED');
		}
		if (
			new PublicationManifestAvailabilityStore(this.context.db).hasPending({
				cacheId: snapshot.cache.id,
				cacheGeneration: snapshot.cache.generation
			})
		) {
			throw new ORPCError('SERVICE_UNAVAILABLE');
		}
		return { ...snapshot, publication };
	}

	/**
	All D1/R2 probes, including narinfo repair, run outside the caller's local gate.
	*/
	async isServable(
		snapshot: PublicationManifestAuthoritySnapshot
	): Promise<boolean> {
		if (snapshot.availability.unresolved) {
			return false;
		}
		const hash = StorePath.hash(snapshot.result.storePath);
		const served = await new NarInfoObjectsService(
			this.context
		).servableNarInfoVersions(snapshot.cache, [hash]);
		const readable = await authorisedNarInfoVersions(
			this.context.d1,
			this.context.requireTenant(),
			snapshot.cache.scope,
			[hash]
		);
		const object = served.get(hash);
		const edge = readable.get(hash);
		return (
			this.isAvailabilityCurrent(snapshot) &&
			object?.generation === snapshot.result.generation &&
			object.narHash === snapshot.result.narHash &&
			edge?.cacheGeneration === snapshot.cache.generation &&
			edge.generation === snapshot.result.generation &&
			edge.narHash === snapshot.result.narHash
		);
	}

	async requireServable(
		snapshot: PublicationManifestAuthoritySnapshot
	): Promise<void> {
		if (!(await this.isServable(snapshot))) {
			throw new ORPCError('SERVICE_UNAVAILABLE');
		}
	}

	requireCurrentAvailability(
		snapshot: PublicationManifestAuthoritySnapshot
	): void {
		if (!this.isAvailabilityCurrent(snapshot)) {
			throw new ORPCError('SERVICE_UNAVAILABLE');
		}
	}

	/**
	Synchronous reauthorisation and exact-version fencing; no remote I/O.
	*/
	revalidate(
		snapshot: PublicationManifestAuthoritySnapshot,
		grants: AuthorizationDetails
	): PublicationManifestAuthoritySnapshot {
		this.requireCurrentAvailability(snapshot);
		const current =
			snapshot.publication === undefined
				? this.resolveExact(
						snapshot.destinationScope,
						grants,
						snapshot.result,
						snapshot.sourceSelector
					)
				: this.resolveRecorded(
						snapshot.destinationScope,
						grants,
						snapshot.publication,
						snapshot.sourceSelector
					);
		if (
			current.destination?.id !== snapshot.destination?.id ||
			current.destination?.generation !== snapshot.destination?.generation ||
			current.destination?.access !== snapshot.destination?.access ||
			current.cache.id !== snapshot.cache.id ||
			current.cache.access !== snapshot.cache.access
		) {
			throw new ORPCError('PUBLICATION_SCOPE_CHANGED');
		}
		return { ...current, availability: snapshot.availability };
	}
}
