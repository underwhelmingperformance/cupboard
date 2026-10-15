import { nixSha256HashSchema } from '@cupboard/nix-store/scalars';
import {
	artifactJobVersionSchema,
	artifactTaskGenerationSchema,
	artifactTaskIdSchema,
	artifactTaskOwnerSchema
} from '@cupboard/protocol/artifact-jobs';
import { listingGeneratorRevisionSchema } from '@cupboard/protocol/artifacts';
import {
	type IsoTimestamp,
	isoTimestampSchema
} from '@cupboard/protocol/scalars';
import { z } from 'zod';

export const sharedListingTaskStateSchema = z.enum([
	'pending',
	'running',
	'completed',
	'skipped',
	'failed'
]);
export type SharedListingTaskState = z.output<
	typeof sharedListingTaskStateSchema
>;

export const sharedListingTaskRequestSchema = z.strictObject({
	job: artifactJobVersionSchema,
	id: artifactTaskIdSchema,
	owner: artifactTaskOwnerSchema
});
export type SharedListingTaskRequest = z.output<
	typeof sharedListingTaskRequestSchema
>;

export const sharedListingTaskClaimSchema =
	sharedListingTaskRequestSchema.extend({
		generation: artifactTaskGenerationSchema,
		generatorRevision: listingGeneratorRevisionSchema,
		narHash: nixSha256HashSchema,
		sourceIncarnation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
		narSize: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
		fileSize: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
		leaseExpiresAt: isoTimestampSchema
	});
export type SharedListingTaskClaim = z.output<
	typeof sharedListingTaskClaimSchema
>;

export type SharedListingTaskClaimResult =
	| { readonly kind: 'claimed'; readonly claim: SharedListingTaskClaim }
	| { readonly kind: 'busy'; readonly retryAt: IsoTimestamp }
	| { readonly kind: 'unavailable' };
