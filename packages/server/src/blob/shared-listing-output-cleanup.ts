import { nixSha256HashSchema } from '@cupboard/nix-store/scalars';
import { artifactTaskOwnerSchema } from '@cupboard/protocol/artifact-jobs';
import { listingGeneratorRevisionSchema } from '@cupboard/protocol/artifacts';
import { isoTimestampSchema } from '@cupboard/protocol/scalars';
import { z } from 'zod';

export const sharedListingOutputCleanupCursorSchema = z.strictObject({
	at: z.iso.datetime({ precision: 3 }).pipe(isoTimestampSchema),
	narHash: nixSha256HashSchema
});
export type SharedListingOutputCleanupCursor = z.output<
	typeof sharedListingOutputCleanupCursorSchema
>;

export const sharedListingOutputCleanupClaimSchema = z.strictObject({
	narHash: nixSha256HashSchema,
	epoch: z.string().regex(/^[0-9a-f]{32}$/),
	cursor: listingGeneratorRevisionSchema.optional(),
	owner: artifactTaskOwnerSchema,
	leaseExpiresAt: isoTimestampSchema
});
export type SharedListingOutputCleanupClaim = z.output<
	typeof sharedListingOutputCleanupClaimSchema
>;
export type SharedListingOutputCleanupClaimResult =
	| {
			readonly kind: 'claimed';
			readonly claim: SharedListingOutputCleanupClaim;
	  }
	| {
			readonly kind: 'deferred';
			readonly retryAt: z.output<typeof isoTimestampSchema>;
	  }
	| { readonly kind: 'absent' };
export type SharedListingOutputDrainResult =
	| {
			readonly kind: 'drained';
			readonly removed: number;
			readonly hasMore: boolean;
	  }
	| { readonly kind: 'unavailable' };
