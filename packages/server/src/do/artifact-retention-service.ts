import type {
	NarInfoGeneration,
	StorePathHash
} from '@cupboard/nix-store/scalars';
import type {
	ArtifactGeneration,
	ArtifactId
} from '@cupboard/protocol/artifacts';
import { type IsoTimestamp, isoTimestamp } from '@cupboard/protocol/scalars';
import { and, asc, eq, exists, gt, notExists, or, sql } from 'drizzle-orm';

import type { ResolvedCache } from '../db/cache.ts';
import * as schema from '../db/schema.ts';
import { authorisedNarInfoVersions } from '../read/read.ts';

import type { SchemaDatabase, ServerContext } from './context.ts';

type RetirementDatabase = Pick<SchemaDatabase, 'select' | 'update' | 'insert'>;
const parentRetirementPageSize = 16;

export interface ArtifactVersion {
	readonly id: ArtifactId;
	readonly generation: ArtifactGeneration;
}

export interface ArtifactPublicationParent {
	readonly cache: ResolvedCache;
	readonly storePathHash: StorePathHash;
	readonly generation: NarInfoGeneration;
}

export type ArtifactRetentionRoot =
	| { readonly kind: 'cache-lifetime' }
	| { readonly kind: 'expiry'; readonly expiresAt: IsoTimestamp };
export type ArtifactRetentionAttachment =
	'attached' | 'already-present' | 'unavailable';

export interface ArtifactParentRetirement {
	readonly edgesRemoved: number;
	readonly artifactsRetired: number;
	readonly pending: boolean;
}

/**
Directed publication parents and independent roots for tenant artifacts.
*/
export class ArtifactRetentionService {
	constructor(private readonly context: ServerContext) {}

	private artifactFilter(version: ArtifactVersion) {
		return and(
			eq(schema.artifacts.id, version.id),
			eq(schema.artifacts.generation, version.generation)
		);
	}

	private currentArtifact(version: ArtifactVersion) {
		const artifact = this.context.db
			.select()
			.from(schema.artifacts)
			.where(this.artifactFilter(version))
			.get();
		if (
			artifact === undefined ||
			artifact.state === 'retired' ||
			(artifact.expiresAt !== null &&
				artifact.expiresAt <= isoTimestamp(new Date()))
		) {
			return;
		}
		const cache = this.context.cacheRepository.resolvedForId(artifact.cacheId);
		if (
			this.context.cacheRepository.resolve(cache.scope)?.id !== artifact.cacheId
		) {
			return;
		}
		return artifact;
	}

	private retireWithin(
		database: RetirementDatabase,
		version: ArtifactVersion
	): boolean {
		const artifact = database
			.select()
			.from(schema.artifacts)
			.where(this.artifactFilter(version))
			.get();
		if (artifact?.state !== 'live' || this.retainedInSection(version)) {
			return false;
		}
		const filter = and(
			this.artifactFilter(version),
			eq(schema.artifacts.state, 'live')
		);
		const retired = database
			.update(schema.artifacts)
			.set({ state: 'retired' })
			.where(filter)
			.returning({ id: schema.artifacts.id })
			.all()
			.at(0);
		if (retired === undefined) {
			return false;
		}
		database
			.insert(schema.artifactReferenceDeletion)
			.values({
				artifactId: artifact.id,
				artifactGeneration: artifact.generation,
				cacheId: artifact.cacheId,
				digest: artifact.digest,
				createdAt: isoTimestamp(new Date())
			})
			.run();
		return true;
	}
	/**
	The caller keeps the tenant critical section open through the authority read and local insert.
	*/
	async attachParentInSection(
		version: ArtifactVersion,
		parent: ArtifactPublicationParent
	): Promise<ArtifactRetentionAttachment> {
		const artifact = this.currentArtifact(version);
		if (artifact?.cacheId !== parent.cache.id) {
			return 'unavailable';
		}
		const parentFilter = and(
			eq(schema.narInfos.cacheId, parent.cache.id),
			eq(schema.narInfos.storePathHash, parent.storePathHash),
			eq(schema.narInfos.generation, parent.generation)
		);
		const local = this.context.db
			.select()
			.from(schema.narInfos)
			.where(parentFilter)
			.get();
		const deletionFilter = and(
			eq(schema.narInfoDeletions.cacheId, parent.cache.id),
			eq(schema.narInfoDeletions.storePathHash, parent.storePathHash),
			eq(schema.narInfoDeletions.generation, parent.generation)
		);
		const deletion = this.context.db
			.select({ hash: schema.narInfoDeletions.storePathHash })
			.from(schema.narInfoDeletions)
			.where(deletionFilter)
			.get();
		if (local === undefined || deletion !== undefined) {
			return 'unavailable';
		}
		const versions = await authorisedNarInfoVersions(
			this.context.d1,
			this.context.requireTenant(),
			parent.cache.scope,
			[parent.storePathHash]
		);
		const authorised = versions.get(parent.storePathHash);
		if (
			authorised?.generation !== parent.generation ||
			authorised.cacheGeneration !== parent.cache.generation ||
			authorised.narHash !== local.narHash ||
			this.currentArtifact(version) === undefined
		) {
			return 'unavailable';
		}
		const inserted = this.context.db
			.insert(schema.artifactParents)
			.values({
				artifactId: version.id,
				artifactGeneration: version.generation,
				cacheId: parent.cache.id,
				storePathHash: parent.storePathHash,
				publicationGeneration: parent.generation
			})
			.onConflictDoNothing()
			.returning({ id: schema.artifactParents.artifactId })
			.all();
		return inserted.length === 0 ? 'already-present' : 'attached';
	}

	attachRootInSection(
		version: ArtifactVersion,
		root: ArtifactRetentionRoot
	): ArtifactRetentionAttachment {
		if (this.currentArtifact(version) === undefined) {
			return 'unavailable';
		}
		if (root.kind === 'expiry' && root.expiresAt <= isoTimestamp(new Date())) {
			return 'unavailable';
		}
		const inserted = this.context.db
			.insert(schema.artifactRoots)
			.values({
				artifactId: version.id,
				artifactGeneration: version.generation,
				kind: root.kind,
				expiresAt: root.kind === 'expiry' ? root.expiresAt : undefined
			})
			.onConflictDoNothing()
			.returning({ id: schema.artifactRoots.artifactId })
			.all();
		return inserted.length === 0 ? 'already-present' : 'attached';
	}

	removeRootInSection(
		version: ArtifactVersion,
		kind: ArtifactRetentionRoot['kind']
	): boolean {
		const filter = and(
			eq(schema.artifactRoots.artifactId, version.id),
			eq(schema.artifactRoots.artifactGeneration, version.generation),
			eq(schema.artifactRoots.kind, kind)
		);
		return (
			this.context.db
				.delete(schema.artifactRoots)
				.where(filter)
				.returning({ id: schema.artifactRoots.artifactId })
				.all().length > 0
		);
	}

	retainedInSection(version: ArtifactVersion): boolean {
		if (this.currentArtifact(version) === undefined) {
			return false;
		}
		const now = isoTimestamp(new Date());
		const parentIdentity = and(
			eq(schema.artifactParents.artifactId, version.id),
			eq(schema.artifactParents.artifactGeneration, version.generation)
		);
		const currentPublication = and(
			eq(schema.narInfos.cacheId, schema.artifactParents.cacheId),
			eq(schema.narInfos.storePathHash, schema.artifactParents.storePathHash),
			eq(
				schema.narInfos.generation,
				schema.artifactParents.publicationGeneration
			)
		);
		const queuedPublication = and(
			eq(schema.narInfoDeletions.cacheId, schema.artifactParents.cacheId),
			eq(
				schema.narInfoDeletions.storePathHash,
				schema.artifactParents.storePathHash
			),
			eq(
				schema.narInfoDeletions.generation,
				schema.artifactParents.publicationGeneration
			)
		);
		const deletion = this.context.db
			.select({ one: sql`1` })
			.from(schema.narInfoDeletions)
			.where(queuedPublication);
		const parentFilter = and(parentIdentity, notExists(deletion));
		const parent = exists(
			this.context.db
				.select({ one: sql`1` })
				.from(schema.artifactParents)
				.innerJoin(schema.narInfos, currentPublication)
				.where(parentFilter)
		);
		const rootFilter = and(
			eq(schema.artifactRoots.artifactId, version.id),
			eq(schema.artifactRoots.artifactGeneration, version.generation),
			or(
				eq(schema.artifactRoots.kind, 'cache-lifetime'),
				gt(schema.artifactRoots.expiresAt, now)
			)
		);
		const root = exists(
			this.context.db
				.select({ one: sql`1` })
				.from(schema.artifactRoots)
				.where(rootFilter)
		);
		const retained = this.context.db
			.select({ one: sql`1` })
			.from(schema.artifacts)
			.where(and(this.artifactFilter(version), or(parent, root)))
			.get();
		return retained !== undefined;
	}

	/**
	Local retirement and its reference-deletion record commit together.
	*/
	retireUnretainedInSection(version: ArtifactVersion): boolean {
		return this.context.db.transaction((transaction) =>
			this.retireWithin(transaction, version)
		);
	}

	/**
	Removes a bounded page from one captured publication and persists resulting retirement atomically.
	*/
	retirePublicationParentsInSection(
		parent: ArtifactPublicationParent
	): ArtifactParentRetirement {
		const publicationFilter = and(
			eq(schema.artifactParents.cacheId, parent.cache.id),
			eq(schema.artifactParents.storePathHash, parent.storePathHash),
			eq(schema.artifactParents.publicationGeneration, parent.generation)
		);
		const currentFilter = and(
			eq(schema.narInfos.cacheId, parent.cache.id),
			eq(schema.narInfos.storePathHash, parent.storePathHash),
			eq(schema.narInfos.generation, parent.generation)
		);
		const queuedFilter = and(
			eq(schema.narInfoDeletions.cacheId, parent.cache.id),
			eq(schema.narInfoDeletions.storePathHash, parent.storePathHash),
			eq(schema.narInfoDeletions.generation, parent.generation)
		);
		const current = this.context.db
			.select({ hash: schema.narInfos.storePathHash })
			.from(schema.narInfos)
			.where(currentFilter)
			.get();
		const queued = this.context.db
			.select({ hash: schema.narInfoDeletions.storePathHash })
			.from(schema.narInfoDeletions)
			.where(queuedFilter)
			.get();
		if (current !== undefined && queued === undefined) {
			return { edgesRemoved: 0, artifactsRetired: 0, pending: true };
		}
		const page = this.context.db
			.select()
			.from(schema.artifactParents)
			.where(publicationFilter)
			.orderBy(asc(schema.artifactParents.artifactId))
			.limit(parentRetirementPageSize)
			.all();
		const result = this.context.db.transaction((transaction) => {
			let edgesRemoved = 0;
			let artifactsRetired = 0;
			for (const edge of page) {
				const edgeFilter = and(
					publicationFilter,
					eq(schema.artifactParents.artifactId, edge.artifactId),
					eq(schema.artifactParents.artifactGeneration, edge.artifactGeneration)
				);
				const removed = transaction
					.delete(schema.artifactParents)
					.where(edgeFilter)
					.returning({ id: schema.artifactParents.artifactId })
					.all();
				edgesRemoved += removed.length;
				if (
					removed.length > 0 &&
					this.retireWithin(transaction, {
						id: edge.artifactId,
						generation: edge.artifactGeneration
					})
				) {
					artifactsRetired += 1;
				}
			}
			return { edgesRemoved, artifactsRetired };
		});
		const pending = this.context.db
			.select({ id: schema.artifactParents.artifactId })
			.from(schema.artifactParents)
			.where(publicationFilter)
			.limit(1)
			.get();
		return { ...result, pending: pending !== undefined };
	}
}
