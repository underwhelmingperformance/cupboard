import { rootLogger } from '@cupboard/logger';
import {
	artifactGenerationSchema,
	artifactIdSchema,
	type NarListingFact,
	type NarListingIdentity
} from '@cupboard/protocol/artifacts';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { and, eq, exists, sql } from 'drizzle-orm';

import { CasObjectStore } from '../blob/cas-object-store.ts';
import {
	type ListingAdoptionOutcome,
	type ListingPublicationOutcome,
	type NarListingAdoptionRequest
} from '../blob/nar-listing-adoption.ts';
import { registeredLiveObjectIncarnation } from '../blob/object-incarnation.ts';
import * as d1Schema from '../db/d1-schema.ts';
import { ListingFactStore } from '../db/listing-facts.ts';
import * as schema from '../db/schema.ts';
import { ListingFactConflictError } from '../errors.ts';
import { casObjectKey } from '../http/http.ts';
import { withSpan } from '../observability/span.ts';
import { authorisedNarInfoVersions } from '../read/read.ts';

import { ArtifactCasService } from './artifact-cas-service.ts';
import {
	type ArtifactPublicationParent,
	ArtifactRetentionService,
	type ArtifactVersion
} from './artifact-retention-service.ts';
import type { ServerContext } from './context.ts';
import { PathReadAuthorityService } from './path-read-authority-service.ts';

type Artifact = typeof schema.artifacts.$inferSelect;
const pendingPublicationLifetimeMs = 15 * 60 * 1000;
const logger = rootLogger().with({ component: 'listing-publication' });

export class NarListingPublicationService {
	constructor(private readonly context: ServerContext) {}

	private async canAdopt(): Promise<boolean> {
		if (this.context.offboarding) {
			return false;
		}
		const publication = this.context.d1
			.select({ one: sql`1` })
			.from(d1Schema.deploymentTransition)
			.where(
				and(
					eq(d1Schema.deploymentTransition.id, 'native-artifact-publication'),
					eq(d1Schema.deploymentTransition.state, 'complete')
				)
			);
		const tenantId = this.context.requireTenant();
		const tenant = await this.context.d1
			.select({ id: d1Schema.tenant.id })
			.from(d1Schema.tenant)
			.where(
				and(
					eq(d1Schema.tenant.id, tenantId),
					eq(d1Schema.tenant.status, 'active'),
					exists(publication)
				)
			)
			.get();
		return tenant !== undefined;
	}

	private identityFilter(
		identity: NarListingIdentity,
		parent: ArtifactPublicationParent
	) {
		return and(
			eq(schema.narListings.cacheId, parent.cache.id),
			eq(schema.narListings.narHash, identity.narHash),
			eq(schema.narListings.generatorRevision, identity.generatorRevision)
		);
	}

	private async currentParent(
		identity: NarListingIdentity,
		parent: ArtifactPublicationParent
	): Promise<boolean> {
		const cache = this.context.cacheRepository.resolve(parent.cache.scope);
		if (
			cache?.id !== parent.cache.id ||
			cache.generation !== parent.cache.generation
		) {
			return false;
		}
		const local = this.context.db
			.select()
			.from(schema.narInfos)
			.where(
				and(
					eq(schema.narInfos.cacheId, cache.id),
					eq(schema.narInfos.storePathHash, parent.storePathHash),
					eq(schema.narInfos.generation, parent.generation),
					eq(schema.narInfos.narHash, identity.narHash)
				)
			)
			.get();
		const deletion = this.context.db
			.select({ hash: schema.narInfoDeletions.storePathHash })
			.from(schema.narInfoDeletions)
			.where(
				and(
					eq(schema.narInfoDeletions.cacheId, cache.id),
					eq(schema.narInfoDeletions.storePathHash, parent.storePathHash),
					eq(schema.narInfoDeletions.generation, parent.generation)
				)
			)
			.get();
		if (local === undefined || deletion !== undefined) {
			return false;
		}
		const versions = await authorisedNarInfoVersions(
			this.context.d1,
			this.context.requireTenant(),
			cache.scope,
			[parent.storePathHash]
		);
		const authority = versions.get(parent.storePathHash);
		return (
			authority?.generation === parent.generation &&
			authority.cacheGeneration === cache.generation &&
			authority.narHash === identity.narHash
		);
	}

	private existingArtifact(
		identity: NarListingIdentity,
		parent: ArtifactPublicationParent
	): Artifact | undefined {
		return this.context.db
			.select({ artifact: schema.artifacts })
			.from(schema.narListings)
			.innerJoin(
				schema.artifacts,
				eq(schema.artifacts.id, schema.narListings.artifactId)
			)
			.where(this.identityFilter(identity, parent))
			.get()?.artifact;
	}

	private prepareArtifact(
		fact: NarListingFact,
		parent: ArtifactPublicationParent,
		incarnation: number,
		existing: Artifact | undefined
	): ArtifactVersion {
		const id = existing?.id ?? artifactIdSchema.parse(crypto.randomUUID());
		const generation =
			existing?.state === 'retired'
				? artifactGenerationSchema.parse(existing.generation + 1)
				: (existing?.generation ?? artifactGenerationSchema.parse(1));
		const isLive = existing?.state === 'live';
		const now = isoTimestamp(new Date());
		const deadline = isoTimestamp(
			new Date(Date.now() + pendingPublicationLifetimeMs)
		);
		const publication = {
			generation,
			publicationIncarnation: incarnation,
			state: isLive ? 'live' : 'pending',
			expiresAt: isLive
				? (existing.expiresAt ?? sql`null`)
				: existing?.state === 'pending'
					? (existing.expiresAt ?? deadline)
					: deadline,
			completedAt: isLive ? (existing.completedAt ?? sql`null`) : sql`null`
		} as const;
		this.context.db.transaction((transaction) => {
			transaction
				.insert(schema.artifacts)
				.values({
					...publication,
					id,
					cacheId: parent.cache.id,
					kind: 'listing',
					digest: fact.digest,
					createdAt: now
				})
				.onConflictDoUpdate({ target: schema.artifacts.id, set: publication })
				.run();
			transaction
				.insert(schema.narListings)
				.values({
					artifactId: id,
					cacheId: parent.cache.id,
					narHash: fact.narHash,
					generatorRevision: fact.generatorRevision,
					format: fact.format
				})
				.onConflictDoNothing()
				.run();
		});
		return { id, generation };
	}

	/**
	Publish sequentially because parents can share a cache-local listing identity.
	*/
	async adoptManyInSection(
		requests: readonly NarListingAdoptionRequest[]
	): Promise<readonly ListingAdoptionOutcome[]> {
		if (!(await this.canAdopt())) {
			return requests.map(() => ({ kind: 'unavailable' }));
		}
		const outcomes: ListingAdoptionOutcome[] = [];
		for (const request of requests) {
			const cache = this.context.cacheRepository.resolve(request.cache);
			if (cache?.generation !== request.cacheGeneration) {
				outcomes.push({ kind: 'unavailable' });
				continue;
			}
			const result = await withSpan(
				'artifact.listing.adopt',
				{
					narHash: request.identity.narHash,
					generatorRevision: request.identity.generatorRevision,
					storePathHash: request.storePathHash,
					publicationGeneration: request.generation,
					cacheGeneration: request.cacheGeneration,
					cacheKind: request.cache.kind,
					cacheName:
						request.cache.kind === 'named' ? request.cache.name : undefined
				},
				async (span): Promise<ListingAdoptionOutcome> => {
					try {
						const outcome = await this.reuseInSection(
							request.identity,
							{
								cache,
								storePathHash: request.storePathHash,
								generation: request.generation
							},
							() => !this.context.offboarding
						);
						span.setAttribute('completion', outcome.kind);
						return outcome;
					} catch (error) {
						if (!(error instanceof ListingFactConflictError)) {
							throw error;
						}
						logger.error('listing adoption conflicts with immutable fact', {
							narHash: request.identity.narHash,
							generatorRevision: request.identity.generatorRevision,
							cache: request.cache,
							cacheGeneration: request.cacheGeneration,
							storePathHash: request.storePathHash,
							publicationGeneration: request.generation
						});
						span.setAttribute('completion', 'conflict');
						return { kind: 'conflict' };
					}
				}
			);
			outcomes.push(result);
		}
		return outcomes;
	}

	/**
	 * The caller keeps the tenant critical section open through reference
	 * reservation and parent attachment. Facts alone do not authorise a listing.
	 */
	async reuseInSection(
		identity: NarListingIdentity,
		parent: ArtifactPublicationParent,
		isCurrent: () => boolean = () => true
	): Promise<ListingPublicationOutcome> {
		await new PathReadAuthorityService(this.context).requireWritable();
		if (!isCurrent() || !(await this.currentParent(identity, parent))) {
			return { kind: 'unavailable' };
		}
		const fact = await new ListingFactStore(this.context.d1).find(identity);
		if (fact === undefined) {
			return { kind: 'fact-missing' };
		}
		const existing = this.existingArtifact(identity, parent);
		if (
			existing !== undefined &&
			(existing.digest !== fact.digest || existing.kind !== 'listing')
		) {
			throw new ListingFactConflictError();
		}
		const object = await this.context.d1
			.select({ incarnation: d1Schema.casObject.incarnation })
			.from(d1Schema.casObject)
			.where(
				and(
					eq(d1Schema.casObject.digest, fact.digest),
					eq(d1Schema.casObject.size, fact.size),
					registeredLiveObjectIncarnation(
						this.context.d1,
						'cas',
						fact.digest,
						d1Schema.casObject.incarnation
					)
				)
			)
			.get();
		if (object === undefined) {
			return { kind: 'bytes-missing' };
		}
		const head = await this.context.env.BLOBS.head(
			casObjectKey(fact.digest, object.incarnation)
		);
		if (
			head?.size !== fact.size ||
			!(await new CasObjectStore(this.context.d1, this.context.env.BLOBS).reuse(
				fact.digest,
				object.incarnation
			))
		) {
			return { kind: 'bytes-missing' };
		}
		if (!isCurrent()) {
			return { kind: 'unavailable' };
		}
		const artifact = this.prepareArtifact(
			fact,
			parent,
			object.incarnation,
			existing
		);
		const retention = new ArtifactRetentionService(this.context);
		let isComplete = false;
		let isAttachedParent = false;
		try {
			const reference = await new ArtifactCasService(
				this.context
			).reserveInSection(artifact.id, artifact.generation);
			if (reference === 'over-quota' || reference === 'unavailable') {
				return { kind: reference };
			}
			if (!isCurrent()) {
				return { kind: 'unavailable' };
			}
			const attachment = await retention.attachParentInSection(
				artifact,
				parent
			);
			if (attachment === 'unavailable') {
				return { kind: 'unavailable' };
			}
			isAttachedParent = attachment === 'attached';
			if (!isCurrent()) {
				return { kind: 'unavailable' };
			}
			this.context.db
				.update(schema.artifacts)
				.set({
					state: 'live',
					expiresAt: sql`null`,
					completedAt:
						existing?.state === 'live'
							? existing.completedAt
							: isoTimestamp(new Date())
				})
				.where(
					and(
						eq(schema.artifacts.id, artifact.id),
						eq(schema.artifacts.generation, artifact.generation)
					)
				)
				.run();
			isComplete = true;
			const isUnchanged =
				existing?.state === 'live' &&
				existing.publicationIncarnation === object.incarnation &&
				reference === 'already-present' &&
				attachment === 'already-present';
			return { kind: isUnchanged ? 'already-present' : 'published', artifact };
		} finally {
			if (!isComplete) {
				if (isAttachedParent) {
					this.context.db
						.delete(schema.artifactParents)
						.where(
							and(
								eq(schema.artifactParents.artifactId, artifact.id),
								eq(
									schema.artifactParents.artifactGeneration,
									artifact.generation
								),
								eq(schema.artifactParents.cacheId, parent.cache.id),
								eq(schema.artifactParents.storePathHash, parent.storePathHash),
								eq(
									schema.artifactParents.publicationGeneration,
									parent.generation
								)
							)
						)
						.run();
				}
				retention.retirePendingInSection(artifact);
			}
		}
	}
}
