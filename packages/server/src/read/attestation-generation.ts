import {
	type NarInfoGeneration,
	narInfoGenerationSchema
} from '@cupboard/nix-store/scalars';

export const listGenerationMetadataKey = 'narinfo-generation';

export function recordedListGeneration(
	object: R2Object
): NarInfoGeneration | undefined {
	const recorded = object.customMetadata?.[listGenerationMetadataKey];

	if (recorded === undefined) {
		return undefined;
	}

	const parsed = narInfoGenerationSchema.safeParse(Number(recorded));

	return parsed.success ? parsed.data : undefined;
}

/**
 * Whether the list describes the currently committed narinfo generation.
 *
 * A path keeps one list object across all of its commits. A commit without an
 * attestation leaves the object from the previous generation in place. The
 * generation in the object metadata identifies which commit produced the list,
 * including after another cache reuses the stored name.
 *
 * Generation metadata was introduced after public-cache list objects. A
 * private cache therefore cannot accept an object without it.
 */
export function isListOfCommittedGeneration(
	object: R2Object,
	cache: { readonly access: 'public' | 'private' },
	committed: NarInfoGeneration
): boolean {
	const recorded = recordedListGeneration(object);

	if (recorded === undefined) {
		return cache.access === 'public';
	}

	return recorded === committed;
}
