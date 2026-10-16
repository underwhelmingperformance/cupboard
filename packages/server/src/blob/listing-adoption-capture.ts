import {
	cacheGenerationSchema,
	cacheScopeSchema,
	narInfoGenerationSchema,
	nixSha256HashSchema,
	sha256HexDigestSchema,
	storePathHashSchema,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import { narListingFactSchema } from '@cupboard/protocol/artifacts';
import { z } from 'zod';

export const listingAdoptionCaptureSequenceSchema = z
	.number()
	.int()
	.nonnegative()
	.max(Number.MAX_SAFE_INTEGER)
	.brand('ListingAdoptionCaptureSequence');
export type ListingAdoptionCaptureSequence = z.output<
	typeof listingAdoptionCaptureSequenceSchema
>;

export const listingAdoptionCaptureSourceSchema = z.discriminatedUnion('kind', [
	z.strictObject({
		kind: z.literal('parent'),
		narHash: nixSha256HashSchema,
		tenant: tenantIdSchema,
		cache: cacheScopeSchema,
		cacheGeneration: cacheGenerationSchema,
		storePathHash: storePathHashSchema,
		generation: narInfoGenerationSchema
	}),
	z.strictObject({
		kind: z.literal('listing'),
		identity: narListingFactSchema.pick({
			narHash: true,
			generatorRevision: true
		})
	}),
	z.strictObject({
		kind: z.literal('cas'),
		digest: sha256HexDigestSchema,
		incarnation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
	})
]);
export type ListingAdoptionCaptureSource = z.output<
	typeof listingAdoptionCaptureSourceSchema
>;
