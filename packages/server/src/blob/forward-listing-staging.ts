import {
	nixSha256HashSchema,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import { maxArtifactBytes } from '@cupboard/protocol/artifacts';
import { listingGeneratorRevisionSchema } from '@cupboard/protocol/artifacts';
import {
	type IsoTimestamp,
	isoTimestampSchema
} from '@cupboard/protocol/scalars';
import { uploadIdSchema } from '@cupboard/protocol/upload';
import { z } from 'zod';

import { r2ObjectKeySchema } from '../http/http.ts';

import {
	artifactStageIdSchema,
	type ArtifactStageMeasurement
} from './artifact-staging.ts';
import { sharedListingStageKey } from './shared-listing-staging.ts';

export const forwardListingSourceSchema = z.strictObject({
	tenant: tenantIdSchema,
	uploadId: z.string().min(1).pipe(uploadIdSchema),
	owner: z.uuid(),
	narHash: nixSha256HashSchema,
	generatorRevision: listingGeneratorRevisionSchema
});
export type ForwardListingSource = z.output<typeof forwardListingSourceSchema>;
export const forwardListingStageLeaseSchema = z
	.strictObject({
		id: artifactStageIdSchema,
		key: r2ObjectKeySchema,
		source: forwardListingSourceSchema,
		maximumBytes: z.number().int().positive().max(maxArtifactBytes.listing),
		writeUntil: isoTimestampSchema,
		cleanupAfter: isoTimestampSchema
	})
	.refine(
		(lease) => lease.key === sharedListingStageKey(lease.id),
		'The provisional listing key differs from its stage identity'
	);
export type ForwardListingStageLease = z.output<
	typeof forwardListingStageLeaseSchema
>;
export type ForwardListingStageReservation =
	| {
			readonly kind: 'writing';
			readonly lease: ForwardListingStageLease;
			readonly multipartId?: string;
	  }
	| {
			readonly kind: 'ready';
			readonly lease: ForwardListingStageLease;
			readonly multipartId: string;
			readonly measurement: ArtifactStageMeasurement;
	  }
	| {
			readonly kind: 'busy';
			readonly retryAt: IsoTimestamp;
	  }
	| { readonly kind: 'unavailable' };
export class ForwardListingStageConflictError extends Error {
	constructor() {
		super('The provisional listing stage has a conflicting measurement');
		this.name = 'ForwardListingStageConflictError';
	}
}
