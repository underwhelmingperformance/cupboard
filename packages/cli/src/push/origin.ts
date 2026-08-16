import type { NixValidPathInfo } from '@cupboard/nix';
import type { StorePathString } from '@cupboard/nix-store/scalars';
import { byCodeUnit } from '@cupboard/nix-store/store-path';
import type { BuildSubjectV3, NixStoreUri } from '@cupboard/protocol/build';

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

export interface PublishedSubjectsOptions {
	/** The subjects the run attributed to its own build, keyed by store path. */
	readonly built: ReadonlyMap<string, BuildSubjectV3>;
	/** Store metadata for the paths the push read from the build store. */
	readonly infos: readonly NixValidPathInfo[];
	/** The paths the destination ends up serving because of this run. */
	readonly servable: ReadonlySet<string>;
	readonly buildStore: string;
	/**
	 * The stores a supervised build watched each path being copied from. Empty
	 * for a run with no activity log to read.
	 */
	readonly copiedFrom: ReadonlyMap<StorePathString, readonly NixStoreUri[]>;
}

/**
 * One subject per published path the push read from the build store, sorted by
 * store path. A path the run built keeps the subject its attribution produced;
 * every other path is described from its store metadata, so each path the push
 * read from the store reaches the receipt with an origin.
 */
export function publishedSubjects(
	options: PublishedSubjectsOptions
): readonly BuildSubjectV3[] {
	return options.infos
		.flatMap((info): BuildSubjectV3[] => {
			if (!options.servable.has(info.storePath)) {
				return [];
			}

			return [
				options.built.get(info.storePath) ??
					unbuiltSubject(
						info,
						options.buildStore,
						options.copiedFrom.get(info.storePath)
					)
			];
		})
		.toSorted((left, right) => byCodeUnit(left.storePath, right.storePath));
}
