import {
	nixSha256HashSchema,
	sha256HexDigestSchema
} from '@cupboard/nix-store/scalars';
import {
	listingGeneratorRevisionSchema,
	maxArtifactBytes
} from '@cupboard/protocol/artifacts';
import { isoTimestampSchema } from '@cupboard/protocol/scalars';
import { z } from 'zod';

export const sharedListingOutputEpochSchema = z
	.uuid()
	.brand<'SharedListingOutputEpoch'>();
export type SharedListingOutputEpoch = z.output<
	typeof sharedListingOutputEpochSchema
>;

export const sharedListingOutputReferenceSchema = z.strictObject({
	narHash: nixSha256HashSchema,
	generatorRevision: listingGeneratorRevisionSchema,
	epoch: sharedListingOutputEpochSchema,
	sourceIncarnation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
	computationGeneration: z
		.number()
		.int()
		.positive()
		.max(Number.MAX_SAFE_INTEGER),
	digest: sha256HexDigestSchema,
	size: z.number().int().positive().max(maxArtifactBytes.listing),
	createdAt: isoTimestampSchema
});
export type SharedListingOutputReference = z.output<
	typeof sharedListingOutputReferenceSchema
>;
