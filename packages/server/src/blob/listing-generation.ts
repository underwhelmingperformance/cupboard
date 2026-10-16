import { type TenantId, tenantIdSchema } from '@cupboard/nix-store/scalars';
import {
	type ArtifactTaskOwner,
	artifactTaskOwnerSchema
} from '@cupboard/protocol/artifact-jobs';
import {
	narListingFactSchema,
	type NarListingIdentity
} from '@cupboard/protocol/artifacts';
import {
	type IsoTimestamp,
	isoTimestampSchema
} from '@cupboard/protocol/scalars';
import { z } from 'zod';

export const listingGenerationRequestSchema = narListingFactSchema
	.pick({ narHash: true, generatorRevision: true })
	.extend({
		sourceIncarnation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
		tenant: tenantIdSchema,
		owner: artifactTaskOwnerSchema
	});
export const listingGenerationClaimSchema =
	listingGenerationRequestSchema.extend({
		generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
		leaseExpiresAt: isoTimestampSchema
	});
export interface ListingGenerationRequest extends NarListingIdentity {
	readonly sourceIncarnation: number;
	readonly tenant: TenantId;
	readonly owner: ArtifactTaskOwner;
}

export interface ListingGenerationClaim extends ListingGenerationRequest {
	readonly generation: number;
	readonly leaseExpiresAt: IsoTimestamp;
}

export type ListingGenerationClaimResult =
	| { readonly kind: 'claimed'; readonly claim: ListingGenerationClaim }
	| { readonly kind: 'busy'; readonly retryAt: IsoTimestamp }
	| { readonly kind: 'unavailable' };
