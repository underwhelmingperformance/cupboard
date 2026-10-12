import {
	type NarInfoGeneration,
	narInfoGenerationSchema
} from '@cupboard/nix-store/scalars';

import type { AttestationListPublication } from '../db/attestation-list-revision.ts';

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

export function isSameListPublication(
	first: AttestationListPublication,
	second: AttestationListPublication | undefined
): boolean {
	if (
		first.parent.generation !== second?.parent.generation ||
		first.parent.cacheGeneration !== second.parent.cacheGeneration ||
		first.parent.narHash !== second.parent.narHash ||
		first.state.status !== second.state.status ||
		first.revision !== second.revision
	) {
		return false;
	}
	return (
		first.state.status !== 'ready' ||
		second.state.status !== 'ready' ||
		first.state.key === second.state.key
	);
}

export function isObjectOfListPublication(
	object: R2Object,
	cache: { readonly access: 'public' | 'private' },
	publication: AttestationListPublication
): boolean {
	if (publication.state.status === 'legacy') {
		return isListOfCommittedGeneration(
			object,
			cache,
			publication.parent.generation
		);
	}
	if (publication.state.status !== 'ready') {
		return false;
	}
	const metadata = object.customMetadata;
	return (
		recordedListGeneration(object) === publication.parent.generation &&
		metadata?.['cache-generation'] ===
			String(publication.parent.cacheGeneration) &&
		metadata['nar-hash'] === publication.parent.narHash &&
		metadata['list-revision'] === String(publication.revision)
	);
}
