import { artifactTaskOwnerSchema } from '@cupboard/protocol/artifact-jobs';
import { maxArtifactBytes } from '@cupboard/protocol/artifacts';
import { isoTimestampSchema } from '@cupboard/protocol/scalars';
import { z } from 'zod';

import { r2ObjectKeySchema } from '../http/http.ts';

import {
	type ArtifactStageId,
	artifactStageIdSchema,
	type ArtifactStageMeasurement
} from './artifact-staging.ts';
import { sharedListingGenerationClaimSchema } from './shared-listing-generation.ts';

export const sharedListingStageLeaseSchema = z.strictObject({
	id: artifactStageIdSchema,
	key: r2ObjectKeySchema,
	claim: sharedListingGenerationClaimSchema,
	maximumBytes: z.number().int().positive().max(maxArtifactBytes.listing),
	expiresAt: isoTimestampSchema,
	writeUntil: isoTimestampSchema,
	cleanupAfter: isoTimestampSchema
});
export type SharedListingStageLease = z.output<
	typeof sharedListingStageLeaseSchema
>;

export type SharedListingStageReservation =
	| {
			readonly kind: 'writing';
			readonly lease: SharedListingStageLease;
			readonly multipartId?: string;
	  }
	| {
			readonly kind: 'ready';
			readonly lease: SharedListingStageLease;
			readonly multipartId: string;
			readonly measurement: ArtifactStageMeasurement;
	  }
	| { readonly kind: 'unavailable' };

export const sharedListingStageCleanupCursorSchema = z.strictObject({
	at: z.iso.datetime({ precision: 3 }).pipe(isoTimestampSchema),
	id: artifactStageIdSchema
});
export type SharedListingStageCleanupCursor = z.output<
	typeof sharedListingStageCleanupCursorSchema
>;

export const sharedListingStageCleanupClaimSchema = z.strictObject({
	id: artifactStageIdSchema,
	key: r2ObjectKeySchema,
	generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
	owner: artifactTaskOwnerSchema,
	leaseExpiresAt: isoTimestampSchema,
	multipartId: z.string().min(1).optional()
});
export type SharedListingStageCleanupClaim = z.output<
	typeof sharedListingStageCleanupClaimSchema
>;

export function sharedListingStageKey(id: ArtifactStageId) {
	return r2ObjectKeySchema.parse(`shared-artifact-staging/${id}`);
}

export class SharedListingStageConflictError extends Error {
	constructor() {
		super('The sealed global listing stage has a conflicting measurement');
		this.name = 'SharedListingStageConflictError';
	}
}
