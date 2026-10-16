import {
	cacheGenerationSchema,
	cacheScopeSchema,
	narInfoGenerationSchema,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import {
	artifactGenerationSchema,
	artifactIdSchema,
	narListingFactSchema
} from '@cupboard/protocol/artifacts';
import { z } from 'zod';

const narListingAdoptionRequestSchema = z.strictObject({
	identity: narListingFactSchema.pick({
		narHash: true,
		generatorRevision: true
	}),
	cache: cacheScopeSchema,
	cacheGeneration: cacheGenerationSchema,
	storePathHash: storePathHashSchema,
	generation: narInfoGenerationSchema
});
export type NarListingAdoptionRequest = z.output<
	typeof narListingAdoptionRequestSchema
>;
const listingPublicationOutcomeSchema = z.discriminatedUnion('kind', [
	z.strictObject({
		kind: z.enum(['published', 'already-present']),
		artifact: z.strictObject({
			id: artifactIdSchema,
			generation: artifactGenerationSchema
		})
	}),
	z.strictObject({
		kind: z.enum(['fact-missing', 'bytes-missing', 'unavailable', 'over-quota'])
	})
]);
export type ListingPublicationOutcome = z.output<
	typeof listingPublicationOutcomeSchema
>;
const listingAdoptionOutcomeSchema = z.union([
	listingPublicationOutcomeSchema,
	z.strictObject({ kind: z.enum(['conflict', 'capacity']) })
]);
export type ListingAdoptionOutcome = z.output<
	typeof listingAdoptionOutcomeSchema
>;

export const narListingAdoptionBatchSchema = z
	.array(narListingAdoptionRequestSchema)
	.min(1)
	.max(8);
export const listingAdoptionOutcomesSchema = z
	.array(listingAdoptionOutcomeSchema)
	.min(1)
	.max(8);
