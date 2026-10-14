import { z } from 'zod';

export const artifactIdSchema = z.uuid().brand('ArtifactId');
export type ArtifactId = z.output<typeof artifactIdSchema>;

export const artifactGenerationSchema = z
	.number()
	.int()
	.positive()
	.max(Number.MAX_SAFE_INTEGER)
	.brand('ArtifactGeneration');
export type ArtifactGeneration = z.output<typeof artifactGenerationSchema>;

export const artifactKinds = [
	'listing',
	'build-log',
	'build-trace',
	'listing-proof'
] as const;
export type ArtifactKind = (typeof artifactKinds)[number];

export const maxArtifactBytes = {
	listing: 64 * 1024 * 1024,
	'build-log': 16 * 1024 * 1024,
	'build-trace': 8 * 1024 * 1024,
	'listing-proof': 1024 * 1024
} as const satisfies Readonly<Record<ArtifactKind, number>>;

export const listingGeneratorRevisionSchema = z
	.string()
	.min(1)
	.max(128)
	.regex(/^[A-Za-z0-9._+-]+$/)
	.brand('ListingGeneratorRevision');
export type ListingGeneratorRevision = z.output<
	typeof listingGeneratorRevisionSchema
>;

export const currentListingGeneratorRevision =
	listingGeneratorRevisionSchema.parse('nix-v1-r1');
