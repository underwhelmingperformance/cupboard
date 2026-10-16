import { rootLogger } from '@cupboard/logger';
import { type ArtifactTaskOwner } from '@cupboard/protocol/artifact-jobs';
import { type IsoTimestamp, isoTimestamp } from '@cupboard/protocol/scalars';

import { boundedBlobs } from '../do/bounded-io.ts';
import { withSpan } from '../observability/span.ts';

import { type ArtifactStageId } from './artifact-staging.ts';
import { r2ErrorCode } from './r2-errors.ts';
import { type SharedListingStageCleanupClaim } from './shared-listing-staging.ts';

interface ListingStageCleanupStore {
	claimCleanup(
		id: ArtifactStageId,
		owner: ArtifactTaskOwner,
		now: IsoTimestamp
	): Promise<SharedListingStageCleanupClaim | undefined>;
	acknowledgeCleanup(
		claim: SharedListingStageCleanupClaim,
		now: IsoTimestamp
	): Promise<boolean>;
	deferCleanup(
		claim: SharedListingStageCleanupClaim,
		now: IsoTimestamp
	): Promise<IsoTimestamp | undefined>;
}
/**
Pass a raw blob binding; the collector applies deadlines and subrequest accounting.
*/
interface ListingStageCollectorDependencies {
	readonly store: ListingStageCleanupStore;
	readonly blobs: R2Bucket;
	readonly scope: 'shared' | 'forward';
	readonly now?: () => IsoTimestamp;
}
export type ListingStageCleanupResult =
	| { readonly kind: 'removed' | 'unavailable' }
	| { readonly kind: 'deferred'; readonly retryAt: IsoTimestamp };

const logger = rootLogger().with({ component: 'listing-stage-cleanup' });

export class ListingStageCollector {
	private readonly blobs: R2Bucket;
	private readonly now: () => IsoTimestamp;
	constructor(
		private readonly dependencies: ListingStageCollectorDependencies
	) {
		this.blobs = boundedBlobs(dependencies.blobs);
		this.now = dependencies.now ?? (() => isoTimestamp(new Date()));
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
	async collect(
		id: ArtifactStageId,
		owner: ArtifactTaskOwner
	): Promise<ListingStageCleanupResult> {
		const { store, scope } = this.dependencies;
		return withSpan(
			`artifact.stage.${scope}.cleanup`,
			{ stageId: id },
			async () => {
				const claim = await store.claimCleanup(id, owner, this.now());
				if (claim === undefined) {
					return { kind: 'unavailable' };
				}
				try {
					if (claim.multipartId !== undefined) {
						await this.abort(
							this.blobs.resumeMultipartUpload(claim.key, claim.multipartId)
						);
					}
					await this.blobs.delete(claim.key);
					return {
						kind: (await store.acknowledgeCleanup(claim, this.now()))
							? 'removed'
							: 'unavailable'
					};
				} catch (error) {
					logger.warn('listing staging cleanup failed; retry scheduled', {
						stageId: id,
						scope,
						cleanupGeneration: claim.generation,
						error
					});
					const retryAt = await store.deferCleanup(claim, this.now());
					return retryAt === undefined
						? { kind: 'unavailable' }
						: { kind: 'deferred', retryAt };
				}
			}
		);
	}
}
