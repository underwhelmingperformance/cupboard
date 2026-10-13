import { type TenantId } from '@cupboard/nix-store/scalars';
import {
	type ArtifactGeneration,
	type ArtifactId,
	type ArtifactKind
} from '@cupboard/protocol/artifacts';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { and, eq, exists, inArray, isNull, notExists, sql } from 'drizzle-orm';

import { registeredLiveObjectIncarnation } from '../blob/object-incarnation.ts';
import {
	cacheIdentityColumns,
	cacheIdentityCondition,
	type ResolvedCache
} from '../db/cache.ts';
import { readCasReferenceSet } from '../db/cas-reference-set.ts';
import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import {
	ArtifactReferenceConflictError,
	ArtifactStorageMigrationPendingError,
	TenantUsageMissingError,
	TenantWritesStoppedError
} from '../errors.ts';
import { casObjectKey } from '../http/http.ts';

import { CasQuotaService } from './cas-quota-service.ts';
import type { ServerContext } from './context.ts';
import { PathReadAuthorityService } from './path-read-authority-service.ts';

type Artifact = typeof schema.artifacts.$inferSelect;
export type ArtifactReferenceOutcome =
	'referenced' | 'already-present' | 'unavailable' | 'over-quota';

/**
Cache-scoped logical reservations for existing immutable CAS bytes.
*/
export class ArtifactCasService {
	constructor(private readonly context: ServerContext) {}

	private keyFilter(artifact: Artifact) {
		return and(
			eq(d1Schema.artifactReference.tenant, this.context.requireTenant()),
			eq(d1Schema.artifactReference.artifactId, artifact.id),
			eq(d1Schema.artifactReference.artifactGeneration, artifact.generation)
		);
	}

	private matchingFilter(artifact: Artifact, cache: ResolvedCache) {
		return and(
			eq(d1Schema.artifactReference.digest, artifact.digest),
			eq(d1Schema.artifactReference.kind, artifact.kind),
			eq(d1Schema.artifactReference.cacheGeneration, cache.generation),
			cacheIdentityCondition(
				d1Schema.artifactReference.cacheKind,
				d1Schema.artifactReference.cacheName,
				cache.scope
			)
		);
	}

	private sourceFence(artifact: Artifact, cache: ResolvedCache, size: number) {
		const physicalFilter = and(
			eq(d1Schema.casObject.digest, artifact.digest),
			eq(d1Schema.casObject.incarnation, artifact.publicationIncarnation),
			eq(d1Schema.casObject.size, size),
			registeredLiveObjectIncarnation(
				this.context.d1,
				'cas',
				artifact.digest,
				artifact.publicationIncarnation
			)
		);
		const cacheFilter = and(
			eq(d1Schema.cacheLifecycle.tenant, this.context.requireTenant()),
			cacheIdentityCondition(
				d1Schema.cacheLifecycle.cacheKind,
				d1Schema.cacheLifecycle.cacheName,
				cache.scope
			),
			eq(d1Schema.cacheLifecycle.generation, cache.generation),
			isNull(d1Schema.cacheLifecycle.deletedAt)
		);
		const conflictFilter = and(
			this.keyFilter(artifact),
			sql`not (${this.matchingFilter(artifact, cache)})`
		);
		const storageFilter = and(
			eq(d1Schema.deploymentTransition.id, 'native-artifact-storage'),
			inArray(d1Schema.deploymentTransition.state, ['expanded', 'complete'])
		);
		const physical = exists(
			this.context.d1
				.select({ one: sql`1` })
				.from(d1Schema.casObject)
				.where(physicalFilter)
		);
		const liveCache = exists(
			this.context.d1
				.select({ one: sql`1` })
				.from(d1Schema.cacheLifecycle)
				.where(cacheFilter)
		);
		const compatible = notExists(
			this.context.d1
				.select({ one: sql`1` })
				.from(d1Schema.artifactReference)
				.where(conflictFilter)
		);
		const storageReady = exists(
			this.context.d1
				.select({ one: sql`1` })
				.from(d1Schema.deploymentTransition)
				.where(storageFilter)
		);
		return sql`${physical} and ${liveCache} and ${compatible} and ${storageReady}`;
	}

	private referenceInsert(
		artifact: Artifact,
		cache: ResolvedCache,
		charge: ReturnType<CasQuotaService['chargeStatements']>
	) {
		const identity = cacheIdentityColumns(cache.scope);
		const tenant = this.context.requireTenant();
		const now = isoTimestamp(new Date());
		return this.context.d1
			.insert(d1Schema.artifactReference)
			.select((qb) =>
				qb
					.select({
						tenant: sql<TenantId>`${tenant}`.as('tenant'),
						artifactId: sql<ArtifactId>`${artifact.id}`.as('artifact_id'),
						artifactGeneration:
							sql<ArtifactGeneration>`${artifact.generation}`.as(
								'artifact_generation'
							),
						cacheKind: sql<typeof identity.cacheKind>`${identity.cacheKind}`.as(
							'cache_kind'
						),
						cacheName: sql`${identity.cacheName}`.as('cache_name'),
						cacheGeneration: sql<
							typeof cache.generation
						>`${cache.generation}`.as('cache_generation'),
						kind: sql<ArtifactKind>`${artifact.kind}`.as('kind'),
						digest: sql<typeof artifact.digest>`${artifact.digest}`.as(
							'digest'
						),
						createdAt: sql<typeof now>`${now}`.as('created_at')
					})
					.from(d1Schema.tenant)
					.where(charge.tenantCondition)
			)
			.onConflictDoNothing();
	}

	/**
	 * The caller must keep the tenant critical section open through this method.
	 * Local artifact and cache identity reads are authoritative only while that
	 * section prevents their retirement or replacement.
	 */
	async reserveInSection(
		id: ArtifactId,
		generation: ArtifactGeneration
	): Promise<ArtifactReferenceOutcome> {
		await new PathReadAuthorityService(this.context).requireWritable();
		const references = await readCasReferenceSet(this.context.d1);
		if (references.kinds !== 'all') {
			throw new ArtifactStorageMigrationPendingError();
		}
		const artifact = this.context.db
			.select()
			.from(schema.artifacts)
			.where(
				and(
					eq(schema.artifacts.id, id),
					eq(schema.artifacts.generation, generation)
				)
			)
			.get();
		if (
			artifact === undefined ||
			artifact.state === 'retired' ||
			(artifact.expiresAt !== null &&
				artifact.expiresAt <= isoTimestamp(new Date()))
		) {
			return 'unavailable';
		}
		const historical = this.context.cacheRepository.resolvedForId(
			artifact.cacheId
		);
		const cache = this.context.cacheRepository.resolve(historical.scope);
		if (cache?.id !== artifact.cacheId) {
			return 'unavailable';
		}
		const existing = await this.context.d1
			.select({
				matches: sql<number>`case when ${this.matchingFilter(artifact, cache)} then 1 else 0 end`
			})
			.from(d1Schema.artifactReference)
			.where(this.keyFilter(artifact))
			.get();
		if (existing?.matches === 0) {
			throw new ArtifactReferenceConflictError();
		}

		const object = await this.context.d1
			.select()
			.from(d1Schema.casObject)
			.where(
				and(
					eq(d1Schema.casObject.digest, artifact.digest),
					eq(d1Schema.casObject.incarnation, artifact.publicationIncarnation)
				)
			)
			.get();
		if (object === undefined) {
			return 'unavailable';
		}
		const head = await this.context.env.BLOBS.head(
			casObjectKey(artifact.digest, artifact.publicationIncarnation)
		);
		if (
			head?.size !== object.size ||
			(artifact.expiresAt !== null &&
				artifact.expiresAt <= isoTimestamp(new Date()))
		) {
			return 'unavailable';
		}
		const quota = new CasQuotaService(this.context);
		if (await quota.overQuota(artifact.digest, object.size)) {
			return 'over-quota';
		}
		const fence = this.sourceFence(artifact, cache, object.size);
		const charge = quota.chargeStatements(artifact.digest, object.size, fence);
		const [tenantRows, sourceRows] = await this.context.d1.batch([
			charge.tenantGate,
			this.context.d1
				.select({ allowed: sql<number>`case when ${fence} then 1 else 0 end` })
				.from(sql`(select 1) source_gate`),
			charge.charge,
			this.referenceInsert(artifact, cache, charge),
			charge.presenceInsert,
			charge.graceClear
		]);
		const tenant = this.context.requireTenant();
		const gate = tenantRows[0];
		if (gate?.status !== 'active') {
			throw new TenantWritesStoppedError(tenant, gate?.status);
		}
		if (gate.usageTenant === null) {
			throw new TenantUsageMissingError(tenant);
		}
		if (sourceRows[0]?.allowed !== 1) {
			return 'unavailable';
		}
		return existing === undefined ? 'referenced' : 'already-present';
	}
}
