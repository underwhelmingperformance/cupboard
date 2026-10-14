import { type ArtifactTaskClaim } from '@cupboard/protocol/artifact-jobs';
import {
	currentListingGeneratorRevision,
	type ListingGeneratorRevision,
	type NarListingFact,
	narListingFactSchema,
	type NarListingIdentity
} from '@cupboard/protocol/artifacts';
import { type IsoTimestamp } from '@cupboard/protocol/scalars';
import { and, eq } from 'drizzle-orm';

import { type ExpectedNar } from '../blob/nar-verify.ts';
import { registeredLiveObjectIncarnation } from '../blob/object-incarnation.ts';
import * as d1Schema from '../db/d1-schema.ts';
import { ListingFactStore } from '../db/listing-facts.ts';
import * as schema from '../db/schema.ts';
import { casObjectKey, narObjectKey, type R2ObjectKey } from '../http/http.ts';
import { authorisedNarInfoVersions } from '../read/read.ts';

import { ArtifactJobService } from './artifact-job-service.ts';
import { type ArtifactPublicationParent } from './artifact-retention-service.ts';
import {
	type ArtifactStageLease,
	ArtifactStagingService
} from './artifact-staging-service.ts';
import { type ServerContext } from './context.ts';
import { NarListingPublicationService } from './nar-listing-publication-service.ts';

interface ListingTaskContext {
	readonly parent: ArtifactPublicationParent;
	readonly identity: NarListingIdentity;
}
export interface ListingTaskSource {
	readonly key: R2ObjectKey;
	readonly expected: ExpectedNar;
}
export type ListingTaskPreparation =
	| {
			readonly kind: 'promote';
			readonly lease: ArtifactStageLease;
			readonly fact: NarListingFact;
	  }
	| {
			readonly kind: 'generate';
			readonly lease: ArtifactStageLease;
			readonly source: ListingTaskSource;
			readonly generatorRevision: ListingGeneratorRevision;
	  }
	| { readonly kind: 'capacity'; readonly retryAt: IsoTimestamp }
	| {
			readonly kind: 'reused' | 'unavailable' | 'bytes-missing' | 'over-quota';
	  };
export interface ListingTaskCompletion {
	readonly kind: 'completed' | 'unavailable' | 'bytes-missing' | 'over-quota';
}

export class ListingGeneratorUnavailableError extends Error {
	constructor(revision: ListingGeneratorRevision) {
		super(
			`No listing generator is available for revision ${revision}; use ${currentListingGeneratorRevision}`
		);
		this.name = 'ListingGeneratorUnavailableError';
	}
}

export class ListingTaskService {
	constructor(private readonly context: ServerContext) {}

	private async capture(
		claim: ArtifactTaskClaim
	): Promise<ListingTaskContext | undefined> {
		const jobs = new ArtifactJobService(this.context);
		const job = jobs.summaryInSection(claim.jobId);
		if (
			this.context.offboarding ||
			jobs.claimDeadlineInSection(claim) === undefined ||
			job?.definition.kind !== 'listing' ||
			claim.source.kind !== 'nar'
		) {
			return;
		}
		const cache = this.context.cacheRepository.resolve(job.cache);
		if (cache?.generation !== claim.cacheGeneration) {
			return;
		}
		const tenant = await this.context.d1
			.select({ status: d1Schema.tenant.status })
			.from(d1Schema.tenant)
			.where(eq(d1Schema.tenant.id, this.context.requireTenant()))
			.get();
		if (tenant?.status !== 'active') {
			return;
		}
		const deletion = this.context.db
			.select({ hash: schema.narInfoDeletions.storePathHash })
			.from(schema.narInfoDeletions)
			.where(
				and(
					eq(schema.narInfoDeletions.cacheId, cache.id),
					eq(schema.narInfoDeletions.storePathHash, claim.source.storePathHash),
					eq(schema.narInfoDeletions.generation, claim.source.generation)
				)
			)
			.get();
		if (deletion !== undefined) {
			return;
		}
		const versions = await authorisedNarInfoVersions(
			this.context.d1,
			this.context.requireTenant(),
			cache.scope,
			[claim.source.storePathHash]
		);
		const version = versions.get(claim.source.storePathHash);
		if (
			version?.generation !== claim.source.generation ||
			version.narHash !== claim.source.narHash ||
			version.cacheGeneration !== cache.generation ||
			jobs.claimDeadlineInSection(claim) === undefined
		) {
			return;
		}
		return {
			parent: {
				cache,
				storePathHash: claim.source.storePathHash,
				generation: claim.source.generation
			},
			identity: {
				narHash: claim.source.narHash,
				generatorRevision: job.definition.generatorRevision
			}
		};
	}

	private async generationSource(
		task: ListingTaskContext
	): Promise<ListingTaskSource | undefined> {
		const local = this.context.db
			.select({ narSize: schema.narInfos.narSize })
			.from(schema.narInfos)
			.where(
				and(
					eq(schema.narInfos.cacheId, task.parent.cache.id),
					eq(schema.narInfos.storePathHash, task.parent.storePathHash),
					eq(schema.narInfos.generation, task.parent.generation),
					eq(schema.narInfos.narHash, task.identity.narHash)
				)
			)
			.get();
		if (local === undefined) {
			return;
		}
		const object = await this.context.d1
			.select({
				incarnation: d1Schema.blobState.incarnation,
				fileSize: d1Schema.blobState.fileSize
			})
			.from(d1Schema.blobState)
			.where(
				and(
					eq(d1Schema.blobState.narHash, task.identity.narHash),
					eq(d1Schema.blobState.narSize, local.narSize),
					registeredLiveObjectIncarnation(
						this.context.d1,
						'nar',
						task.identity.narHash,
						d1Schema.blobState.incarnation
					)
				)
			)
			.get();
		if (object === undefined) {
			return;
		}
		const key = narObjectKey(task.identity.narHash, object.incarnation);
		const head = await this.context.env.BLOBS.head(key);
		if (head?.size !== object.fileSize) {
			return;
		}
		return {
			key,
			expected: { narHash: task.identity.narHash, narSize: local.narSize }
		};
	}

	/**
	 * Run under the tenant critical section. The returned source and lease are
	 * for a Worker to decode and upload outside the Durable Object.
	 */
	async prepareInSection(
		claim: ArtifactTaskClaim
	): Promise<ListingTaskPreparation> {
		const task = await this.capture(claim);
		if (task === undefined) {
			return { kind: 'unavailable' };
		}
		const jobs = new ArtifactJobService(this.context);
		const isCurrent = () => jobs.claimDeadlineInSection(claim) !== undefined;
		const reused = await new NarListingPublicationService(
			this.context
		).reuseInSection(task.identity, task.parent, isCurrent);
		if (reused.kind === 'published' || reused.kind === 'already-present') {
			return {
				kind: jobs.finishInSection(claim, 'completed')
					? 'reused'
					: 'unavailable'
			};
		}
		if (reused.kind === 'unavailable' || reused.kind === 'over-quota') {
			return { kind: reused.kind };
		}
		const staging = new ArtifactStagingService(this.context);
		const existing = staging.findInSection(claim);
		const ready =
			existing === undefined ? undefined : staging.readyInSection(existing);
		if (existing !== undefined && ready !== undefined) {
			return {
				kind: 'promote',
				lease: existing,
				fact: narListingFactSchema.parse({
					...task.identity,
					format: 1,
					digest: ready.digest,
					size: ready.size
				})
			};
		}
		if (task.identity.generatorRevision !== currentListingGeneratorRevision) {
			throw new ListingGeneratorUnavailableError(
				task.identity.generatorRevision
			);
		}
		const source = await this.generationSource(task);
		if (source === undefined) {
			return { kind: 'bytes-missing' };
		}
		const stage = await staging.reserveInSection(claim);
		if (stage.kind !== 'reserved') {
			return stage;
		}
		return {
			kind: 'generate',
			lease: stage.lease,
			source,
			generatorRevision: task.identity.generatorRevision
		};
	}

	async renewInSection(
		lease: ArtifactStageLease
	): Promise<IsoTimestamp | undefined> {
		const staging = new ArtifactStagingService(this.context);
		if (
			staging.deadlineInSection(lease) === undefined ||
			(await this.capture(lease.claim)) === undefined
		) {
			return;
		}
		const jobs = new ArtifactJobService(this.context);
		if (jobs.renewInSection(lease.claim) === undefined) {
			return;
		}
		return staging.renewInSection(lease);
	}

	/**
	 * The Worker must first verify the NAR, seal staging and promote its measured
	 * bytes with R2's digest check. Completion validates that physical publication
	 * before recording shared facts, task progress or cache read authority.
	 */
	async completeInSection(
		lease: ArtifactStageLease,
		input: NarListingFact
	): Promise<ListingTaskCompletion> {
		const task = await this.capture(lease.claim);
		const staging = new ArtifactStagingService(this.context);
		const measured = staging.readyInSection(lease);
		const fact = narListingFactSchema.parse(input);
		if (
			task === undefined ||
			measured === undefined ||
			lease.kind !== 'listing' ||
			fact.narHash !== task.identity.narHash ||
			fact.generatorRevision !== task.identity.generatorRevision ||
			measured.digest !== fact.digest ||
			measured.size !== fact.size
		) {
			return { kind: 'unavailable' };
		}
		const physical = await this.context.d1
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
		if (physical === undefined) {
			return { kind: 'bytes-missing' };
		}
		const head = await this.context.env.BLOBS.head(
			casObjectKey(fact.digest, physical.incarnation)
		);
		if (head?.size !== fact.size) {
			return { kind: 'bytes-missing' };
		}
		const jobs = new ArtifactJobService(this.context);
		const isCurrent = () =>
			jobs.claimDeadlineInSection(lease.claim) !== undefined &&
			staging.readyInSection(lease) !== undefined;
		if (!isCurrent()) {
			return { kind: 'unavailable' };
		}
		await new ListingFactStore(this.context.d1).record(fact);
		const published = await new NarListingPublicationService(
			this.context
		).reuseInSection(task.identity, task.parent, isCurrent);
		if (
			published.kind !== 'published' &&
			published.kind !== 'already-present'
		) {
			return {
				kind: published.kind === 'fact-missing' ? 'unavailable' : published.kind
			};
		}
		if (!jobs.finishInSection(lease.claim, 'completed')) {
			return { kind: 'unavailable' };
		}
		staging.retireInSection(lease);
		return { kind: 'completed' };
	}
}
