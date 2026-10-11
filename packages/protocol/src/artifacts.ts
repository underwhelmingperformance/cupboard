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

export const listingGeneratorRevisionSchema = z
	.string()
	.min(1)
	.max(128)
	.regex(/^[A-Za-z0-9._+-]+$/)
	.brand('ListingGeneratorRevision');
export type ListingGeneratorRevision = z.output<
	typeof listingGeneratorRevisionSchema
>;
