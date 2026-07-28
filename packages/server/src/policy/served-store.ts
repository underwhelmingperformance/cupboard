import { servedStoreDirectory } from '@cupboard/nix-store/cache-info';
import { type StorePathString } from '@cupboard/nix-store/scalars';
import { storeDirectoryOf } from '@cupboard/nix-store/store-path';

import { StorePathNotServedError } from '../errors.ts';

/**
 * Refuses any submitted path that is not in the store directory this cache
 * serves. `storePathSchema` validates the shape of a store path, which is the
 * same shape whichever store it belongs to; which store a given cache accepts
 * is the cache's own fact, so it is checked here, where the request arrives.
 */
export function requireServedStorePaths(
	paths: readonly StorePathString[]
): void {
	for (const path of paths) {
		const storeDirectory = storeDirectoryOf(path);

		if (storeDirectory !== servedStoreDirectory) {
			throw new StorePathNotServedError(
				path,
				storeDirectory ?? '',
				servedStoreDirectory
			);
		}
	}
}
