import { rootLogger } from '@cupboard/logger';
import { type ArtifactTaskOwner } from '@cupboard/protocol/artifact-jobs';
import { type IsoTimestamp, isoTimestamp } from '@cupboard/protocol/scalars';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/d1-schema.ts';
import { SharedListingStageStore } from '../db/shared-listing-staging.ts';
import { boundedBlobs, boundedD1 } from '../do/bounded-io.ts';
import { ArtifactTooLargeError } from '../errors.ts';
import { withSpan } from '../observability/span.ts';

import {
	type ArtifactStageId,
	type ArtifactStageMeasurement,
	artifactStageMeasurementSchema
} from './artifact-staging.ts';
import {
	type ListingStageCleanupResult,
	ListingStageCollector
} from './listing-stage-collector.ts';
import { r2ErrorCode } from './r2-errors.ts';
import {
	sharedListingStageKey,
	type SharedListingStageLease,
	sharedListingStageLeaseSchema
} from './shared-listing-staging.ts';

/**
Pass raw bindings; the service applies deadlines and subrequest accounting.
*/
export interface SharedListingStagingDependencies {
	readonly database: D1Database;
	readonly blobs: R2Bucket;
	readonly now?: () => IsoTimestamp;
}
const logger = rootLogger().with({ component: 'shared-listing-staging' });

export class SharedListingStagingService {
	private readonly store: SharedListingStageStore;
	private readonly blobs: R2Bucket;
	private readonly now: () => IsoTimestamp;
	private readonly collector: ListingStageCollector;

	constructor(dependencies: SharedListingStagingDependencies) {
		this.store = new SharedListingStageStore(
			drizzle(boundedD1(dependencies.database), { schema })
		);
		this.blobs = boundedBlobs(dependencies.blobs);
		this.now = dependencies.now ?? (() => isoTimestamp(new Date()));
		this.collector = new ListingStageCollector({
			store: this.store,
			blobs: dependencies.blobs,
			scope: 'shared',
			now: this.now
		});
	}

	private async abort(upload: R2MultipartUpload): Promise<void> {
		try {
			await upload.abort();
		} catch (error) {
			if (r2ErrorCode(error) === 10_024) {
				return;
			}
			throw error;
		}
	}

	async create(
		input: SharedListingStageLease
	): Promise<R2MultipartUpload | undefined> {
		const lease = sharedListingStageLeaseSchema.parse(input);
		return withSpan(
			'artifact.stage.shared.create',
			{
				jobId: lease.claim.task.job.id,
				taskId: lease.claim.task.id,
				stageId: lease.id,
				generation: lease.claim.generation
			},
			async () => {
				if ((await this.store.renew(lease, this.now())) === undefined) {
					return;
				}
				const upload = await this.blobs.createMultipartUpload(lease.key);
				try {
					if (
						await this.store.registerMultipart(
							lease,
							upload.uploadId,
							this.now()
						)
					) {
						return upload;
					}
				} catch (error) {
					const [cleanup] = await Promise.allSettled([this.abort(upload)]);
					if (cleanup.status === 'rejected') {
						logger.warn('unregistered shared staging upload abort failed', {
							stageId: lease.id,
							error: cleanup.reason
						});
					}
					throw error;
				}
				await this.abort(upload);
			}
		);
	}

	async seal(
		input: SharedListingStageLease,
		multipartId: string,
		inputMeasurement: ArtifactStageMeasurement
	): Promise<boolean> {
		const lease = sharedListingStageLeaseSchema.parse(input);
		const measurement = artifactStageMeasurementSchema.parse(inputMeasurement);
		if (measurement.size > lease.maximumBytes) {
			throw new ArtifactTooLargeError(
				'listing',
				measurement.size,
				lease.maximumBytes
			);
		}
		if (lease.key !== sharedListingStageKey(lease.id)) {
			return false;
		}
		return withSpan(
			'artifact.stage.shared.seal',
			{
				jobId: lease.claim.task.job.id,
				taskId: lease.claim.task.id,
				stageId: lease.id,
				generation: lease.claim.generation
			},
			async () => {
				const head = await this.blobs.head(lease.key);
				if (head?.size !== measurement.size) {
					return false;
				}
				return this.store.recordSeal(
					lease,
					multipartId,
					measurement,
					this.now()
				);
			}
		);
	}

	collect(
		id: ArtifactStageId,
		owner: ArtifactTaskOwner
	): Promise<ListingStageCleanupResult> {
		return this.collector.collect(id, owner);
	}
}
