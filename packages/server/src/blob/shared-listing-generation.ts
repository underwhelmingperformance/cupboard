import {
	type IsoTimestamp,
	isoTimestampSchema
} from '@cupboard/protocol/scalars';
import { z } from 'zod';

import { sharedListingTaskClaimSchema } from './shared-listing-tasks.ts';

export const sharedListingGenerationClaimSchema = z.strictObject({
	task: sharedListingTaskClaimSchema,
	generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
	leaseExpiresAt: isoTimestampSchema
});
export type SharedListingGenerationClaim = z.output<
	typeof sharedListingGenerationClaimSchema
>;
export type SharedListingGenerationClaimResult =
	| { readonly kind: 'claimed'; readonly claim: SharedListingGenerationClaim }
	| {
			readonly kind: 'busy';
			readonly retryAt: IsoTimestamp;
	  }
	| { readonly kind: 'unavailable' };
