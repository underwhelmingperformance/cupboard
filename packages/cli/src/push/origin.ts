import type { NixValidPathInfo } from '@cupboard/nix';
import { NixSha256Hash } from '@cupboard/nix-store/hash';
import type { StorePathString } from '@cupboard/nix-store/scalars';
import { byCodeUnit, StorePath } from '@cupboard/nix-store/store-path';
import type { BuildSubjectV3, NixStoreUri } from '@cupboard/protocol/build';

import type { ReferenceMetadata } from './reference.ts';

/**
 * The subject for a published path the run cannot claim to have built.
 *
 * Nix marks a path as ultimately trusted when the store built it itself, which
 * separates the store's own work from a path that arrived by substitution or
 * `nix copy`. The store records neither when it did that work nor which
 * substituter served a copy, so the subject reports what the store does record:
 * the store's name for its own work, and the signatures and content address for
 * a copied path, both of which a reader can check for itself.
 *
 * `copiedFrom` is separate evidence that only a supervised build has: the stores
 * it watched the path being copied from while the build ran.
 */
function unbuiltSubject(
	pathInfo: NixValidPathInfo,
	buildStore: string,
	copiedFrom: readonly NixStoreUri[] | undefined
): BuildSubjectV3 {
	const identity = {
		storePath: pathInfo.storePath,
		narHash: pathInfo.narHash.digestHex(),
		...(pathInfo.deriver !== undefined && { derivation: pathInfo.deriver })
	};

	if (pathInfo.ultimate) {
		return { origin: 'store-held', ...identity, buildStore };
	}

	return {
		origin: 'copied',
		...identity,
		signatures: [...pathInfo.signatures],
		...(pathInfo.ca !== undefined && { ca: pathInfo.ca }),
		...(copiedFrom !== undefined &&
			copiedFrom.length > 0 && { copiedFrom: [...copiedFrom] })
	};
}

/**
 * The subject for a path the run published by reference. No store the push can
 * query holds the path, so the run's only evidence is the narinfo it read from
 * `metadataSource`: the NAR hash the destination serves the path under, the
 * deriver and content address that cache reported, and the signatures it
 * published over the path.
 *
 * The run transferred no bytes, because the destination already held the path.
 * The subject therefore describes where the metadata came from, and says
 * nothing about where the destination's copy came from.
 */
export function republishedSubject(
	metadata: ReferenceMetadata,
	metadataSource: string
): BuildSubjectV3 {
	const { upload } = metadata;

	return {
		origin: 'republished',
		storePath: upload.storePath,
		narHash: NixSha256Hash.parse(upload.narHash).digestHex(),
		...(upload.deriver !== undefined && {
			derivation: `${new StorePath(upload.storePath).storeDirectory}/${upload.deriver}`
		}),
		signatures: [...metadata.signatures],
		...(upload.ca !== undefined && { ca: upload.ca }),
		metadataSource
	};
}

export interface PublishedSubjectsOptions {
	/**
	 * The subjects the caller has already established, keyed by store path: the
	 * paths the run attributed to its own build, and the paths it republished
	 * from another cache.
	 */
	readonly described: ReadonlyMap<string, BuildSubjectV3>;
	/**
	Store metadata for the paths the push read from the build store.
	*/
	readonly infos: readonly NixValidPathInfo[];
	/**
	The paths the destination ends up serving because of this run.
	*/
	readonly servable: ReadonlySet<string>;
	readonly buildStore: string;
	/**
	 * The stores a supervised build watched each path being copied from. Empty
	 * for a run with no activity log to read.
	 */
	readonly copiedFrom: ReadonlyMap<StorePathString, readonly NixStoreUri[]>;
}

/**
 * One subject per published path, sorted by store path. A path the caller
 * already described keeps that subject. Every other path the push read from the
 * build store is described from its store metadata, so each path the run
 * publishes reaches the receipt with an origin.
 */
export function publishedSubjects(
	options: PublishedSubjectsOptions
): readonly BuildSubjectV3[] {
	const subjects = new Map<string, BuildSubjectV3>();

	for (const [storePath, subject] of options.described) {
		if (options.servable.has(storePath)) {
			subjects.set(storePath, subject);
		}
	}

	for (const info of options.infos) {
		if (!options.servable.has(info.storePath) || subjects.has(info.storePath)) {
			continue;
		}

		subjects.set(
			info.storePath,
			unbuiltSubject(
				info,
				options.buildStore,
				options.copiedFrom.get(info.storePath)
			)
		);
	}

	return subjects
		.values()
		.toArray()
		.toSorted((left, right) => byCodeUnit(left.storePath, right.storePath));
}
