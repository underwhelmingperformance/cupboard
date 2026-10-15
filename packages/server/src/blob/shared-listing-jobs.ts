import { nixSha256HashSchema } from '@cupboard/nix-store/scalars';
import {
	artifactJobProgressSchema,
	artifactJobVersionSchema,
	artifactTaskOwnerSchema
} from '@cupboard/protocol/artifact-jobs';
import { listingGeneratorRevisionSchema } from '@cupboard/protocol/artifacts';
import {
	type IsoTimestamp,
	isoTimestampSchema
} from '@cupboard/protocol/scalars';
import { z } from 'zod';

import { narCaptureSequenceSchema } from './nar-source-capture.ts';

export const sharedListingJobSummarySchema = artifactJobVersionSchema.extend({
	generatorRevision: listingGeneratorRevisionSchema,
	state: z.enum(['running', 'cancelled', 'complete']),
	phase: z.enum(['historical', 'catchup', 'processing']),
	cursor: nixSha256HashSchema.optional(),
	eventCursor: narCaptureSequenceSchema,
	eventThrough: narCaptureSequenceSchema.optional(),
	progress: artifactJobProgressSchema,
	createdAt: isoTimestampSchema,
	updatedAt: isoTimestampSchema
});
export type SharedListingJobSummary = z.output<
	typeof sharedListingJobSummarySchema
>;

const discoveryClaimFields = z.strictObject({
	job: artifactJobVersionSchema,
	owner: artifactTaskOwnerSchema,
	generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
	leaseExpiresAt: isoTimestampSchema,
	cursor: nixSha256HashSchema.optional(),
	eventCursor: narCaptureSequenceSchema
});

export const sharedListingDiscoveryClaimSchema = z.discriminatedUnion('phase', [
	discoveryClaimFields.extend({
		phase: z.literal('historical'),
		eventThrough: z.undefined().optional()
	}),
	discoveryClaimFields
		.extend({
			phase: z.literal('catchup'),
			eventThrough: narCaptureSequenceSchema
		})
		.refine((claim) => claim.eventCursor <= claim.eventThrough)
]);
export type SharedListingDiscoveryClaim = z.output<
	typeof sharedListingDiscoveryClaimSchema
>;
export type SharedListingDiscoveryClaimResult =
	| { readonly kind: 'claimed'; readonly claim: SharedListingDiscoveryClaim }
	| {
			readonly kind: 'busy';
			readonly retryAt: IsoTimestamp;
	  }
	| { readonly kind: 'unavailable' };
