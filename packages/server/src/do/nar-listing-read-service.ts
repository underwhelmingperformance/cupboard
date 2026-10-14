import {
	type CacheAccessMode,
	type CacheGeneration,
	type CacheReadRevision,
	type CacheScope,
	type NarInfoGeneration,
	type NixSha256HashString,
	type Sha256HexDigest,
	type StorePathHash
} from '@cupboard/nix-store/scalars';
import {
	type ArtifactGeneration,
	type ArtifactId,
	currentListingGeneratorRevision,
	maxArtifactBytes
} from '@cupboard/protocol/artifacts';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { bestEffort } from '@cupboard/shared/cleanup';
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { StatusCodes } from 'http-status-codes';

import { registeredLiveObjectIncarnation } from '../blob/object-incarnation.ts';
import { type CacheId, cacheIdentityCondition } from '../db/cache.ts';
import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import { readWithOneRetry } from '../db/transient.ts';
import {
	ArtifactReadChangedError,
	SharedFactsUnavailableError
} from '../errors.ts';
import {
	casObjectKey,
	isNotModified,
	uncachedNotFoundResponse
} from '../http/http.ts';
import { narInfoReferenceQuery } from '../read/read.ts';

import type { ServerContext } from './context.ts';
import { jsonValueList } from './json-list.ts';

interface ListingPublication {
	readonly id: ArtifactId;
	readonly generation: ArtifactGeneration;
	readonly digest: Sha256HexDigest;
	readonly incarnation: number;
	readonly cacheId: CacheId;
	readonly cacheAccess: CacheAccessMode;
	readonly cacheGeneration: CacheGeneration;
	readonly narHash: NixSha256HashString;
	readonly parentGeneration: NarInfoGeneration;
}
interface ListingSource extends ListingPublication {
	readonly size: number;
	readonly readRevision: CacheReadRevision;
}

// Drizzle does not qualify selection aliases in joins.
const parentColumns = {
	narHash: sql<NixSha256HashString>`"listing_parent"."nar_hash"`,
	generation: sql<NarInfoGeneration>`"listing_parent"."generation"`,
	cacheGeneration: sql<CacheGeneration>`"listing_parent"."cache_generation"`
};

export class NarListingReadService {
	constructor(private readonly context: ServerContext) {}

	private samePublication(
		left: ListingPublication,
		right: ListingPublication
	): boolean {
		return (
			left.id === right.id &&
			left.generation === right.generation &&
			left.digest === right.digest &&
			left.incarnation === right.incarnation &&
			left.cacheId === right.cacheId &&
			left.cacheAccess === right.cacheAccess &&
			left.cacheGeneration === right.cacheGeneration &&
			left.narHash === right.narHash &&
			left.parentGeneration === right.parentGeneration
		);
	}
	private localPublication(
		scope: CacheScope,
		hash: StorePathHash
	): ListingPublication | undefined {
		const cache = this.context.cacheRepository.resolve(scope);
		if (cache === undefined) {
			return;
		}
		const nar = this.context.db
			.select()
			.from(schema.narInfos)
			.where(
				and(
					eq(schema.narInfos.cacheId, cache.id),
					eq(schema.narInfos.storePathHash, hash)
				)
			)
			.get();
		if (nar === undefined) {
			return;
		}
		const { artifacts, narListings, artifactParents } = schema;
		const now = isoTimestamp(new Date());
		const unexpired = or(
			isNull(artifacts.expiresAt),
			gt(artifacts.expiresAt, now)
		);
		const artifact = this.context.db
			.select({
				id: artifacts.id,
				generation: artifacts.generation,
				digest: artifacts.digest,
				incarnation: artifacts.publicationIncarnation
			})
			.from(narListings)
			.innerJoin(artifacts, eq(artifacts.id, narListings.artifactId))
			.innerJoin(
				artifactParents,
				and(
					eq(artifactParents.artifactId, artifacts.id),
					eq(artifactParents.artifactGeneration, artifacts.generation)
				)
			)
			.where(
				and(
					eq(narListings.cacheId, cache.id),
					eq(narListings.narHash, nar.narHash),
					eq(narListings.generatorRevision, currentListingGeneratorRevision),
					eq(narListings.format, 1),
					eq(artifacts.cacheId, cache.id),
					eq(artifacts.kind, 'listing'),
					eq(artifacts.state, 'live'),
					unexpired,
					eq(artifactParents.cacheId, cache.id),
					eq(artifactParents.storePathHash, hash),
					eq(artifactParents.publicationGeneration, nar.generation)
				)
			)
			.limit(1)
			.get();
		if (artifact === undefined) {
			return;
		}
		return {
			...artifact,
			cacheId: cache.id,
			cacheAccess: cache.access,
			cacheGeneration: cache.generation,
			narHash: nar.narHash,
			parentGeneration: nar.generation
		};
	}
	private async capture(
		scope: CacheScope,
		hash: StorePathHash
	): Promise<ListingSource | undefined> {
		const publication = this.localPublication(scope, hash);
		if (publication === undefined) {
			return;
		}
		const {
			artifactReference: reference,
			casObject: physical,
			cacheLifecycle: lifecycle
		} = d1Schema;
		const parent = narInfoReferenceQuery(
			this.context.d1,
			this.context.requireTenant(),
			scope,
			jsonValueList([hash])
		).as('listing_parent');
		const tenant = this.context.requireTenant();
		const query = this.context.d1
			.select({ size: physical.size, readRevision: lifecycle.readRevision })
			.from(reference)
			.innerJoin(physical, eq(physical.digest, reference.digest))
			.innerJoin(
				parent,
				and(
					eq(parentColumns.narHash, publication.narHash),
					eq(parentColumns.generation, publication.parentGeneration),
					eq(parentColumns.cacheGeneration, publication.cacheGeneration)
				)
			)
			.innerJoin(
				lifecycle,
				and(
					eq(lifecycle.tenant, reference.tenant),
					cacheIdentityCondition(
						lifecycle.cacheKind,
						lifecycle.cacheName,
						scope
					)
				)
			)
			.where(
				and(
					eq(reference.tenant, tenant),
					eq(reference.artifactId, publication.id),
					eq(reference.artifactGeneration, publication.generation),
					eq(reference.kind, 'listing'),
					eq(reference.digest, publication.digest),
					cacheIdentityCondition(
						reference.cacheKind,
						reference.cacheName,
						scope
					),
					eq(reference.cacheGeneration, publication.cacheGeneration),
					eq(lifecycle.generation, publication.cacheGeneration),
					eq(lifecycle.access, publication.cacheAccess),
					isNull(lifecycle.deletedAt),
					eq(physical.incarnation, publication.incarnation),
					registeredLiveObjectIncarnation(
						this.context.d1,
						'cas',
						publication.digest,
						publication.incarnation
					)
				)
			);
		let object:
			| { readonly size: number; readonly readRevision: CacheReadRevision }
			| undefined;
		try {
			object = await readWithOneRetry(() => query.get());
		} catch (error) {
			throw new SharedFactsUnavailableError(error);
		}
		const latest = this.localPublication(scope, hash);
		const byteSize = object?.size;
		if (
			object === undefined ||
			byteSize === undefined ||
			latest === undefined ||
			byteSize < 1 ||
			byteSize > maxArtifactBytes.listing ||
			!this.samePublication(publication, latest)
		) {
			return;
		}
		return {
			...publication,
			size: byteSize,
			readRevision: object.readRevision
		};
	}
	private async revalidate(
		scope: CacheScope,
		hash: StorePathHash,
		source: ListingSource,
		isCurrent: () => boolean
	): Promise<void> {
		const latest = await this.capture(scope, hash);
		if (
			latest === undefined ||
			!isCurrent() ||
			!this.samePublication(latest, source) ||
			latest.size !== source.size ||
			latest.readRevision !== source.readRevision
		) {
			throw new ArtifactReadChangedError();
		}
	}
	async serve(
		request: Request,
		scope: CacheScope,
		hash: StorePathHash,
		isCurrent: () => boolean = () => true
	): Promise<Response> {
		const captured = await this.capture(scope, hash);
		if (!isCurrent()) {
			throw new ArtifactReadChangedError();
		}
		if (captured === undefined) {
			return uncachedNotFoundResponse();
		}
		const key = casObjectKey(captured.digest, captured.incarnation);
		const head = await this.context.env.BLOBS.head(key);
		await this.revalidate(scope, hash, captured, isCurrent);
		if (head === null) {
			return uncachedNotFoundResponse();
		}
		if (head.size !== captured.size) {
			throw new ArtifactReadChangedError();
		}
		const headers = new Headers({
			'content-type': 'application/json',
			'cache-control': 'no-store',
			'content-length': String(captured.size),
			etag: `"${captured.digest}"`
		});
		if (isNotModified(request, headers)) {
			return new Response(undefined, {
				status: StatusCodes.NOT_MODIFIED,
				headers
			});
		}
		if (request.method === 'HEAD') {
			return new Response(undefined, { headers });
		}
		const object = await this.context.env.BLOBS.get(key, {
			onlyIf: { etagMatches: head.etag }
		});
		if (object === null || !('body' in object)) {
			throw new ArtifactReadChangedError();
		}
		try {
			await this.revalidate(scope, hash, captured, isCurrent);
			if (object.size !== captured.size) {
				throw new ArtifactReadChangedError();
			}
		} catch (error) {
			await bestEffort(() => object.body.cancel());
			throw error;
		}
		return new Response(object.body, { headers });
	}
}
