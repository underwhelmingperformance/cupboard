import type { NixValidPathInfo } from '@cupboard/nix';
import { NixSha256Hash } from '@cupboard/nix-store/hash';
import type { StorePathString } from '@cupboard/nix-store/scalars';
import { byCodeUnit, StorePath } from '@cupboard/nix-store/store-path';
import type { BuildSubjectV3, NixStoreUri } from '@cupboard/protocol/build';

import type { ReferenceMetadata } from './reference.ts';

/**
 * `ultimate` distinguishes work produced by the selected store from a path that
 * arrived through substitution or `nix copy`. For copied paths, retain the
 * signatures and content address from the store metadata.
 *
 * Store metadata contains neither the copy time nor its source. A supervised
 * build can supplement it with copy sources observed in the activity log.
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
 * A reference publication does not query a Nix store for the path, so the
 * source narinfo is its only provenance evidence.
 *
 * The run transfers no NAR bytes. Record the source URL and the narinfo's
 * provenance fields, but do not infer where the destination obtained its copy.
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
	readonly described: ReadonlyMap<string, BuildSubjectV3>;
	readonly infos: readonly NixValidPathInfo[];
	readonly servable: ReadonlySet<string>;
	readonly buildStore: string;
	readonly copiedFrom: ReadonlyMap<StorePathString, readonly NixStoreUri[]>;
}

/**
 * A subject already established by the caller takes precedence. Remaining
 * servable paths use selected-store metadata, so later store state cannot
 * replace current-run attribution.
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
