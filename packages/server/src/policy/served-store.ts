import { servedStoreDirectory } from '@cupboard/nix-store/cache-info';
import { type StorePathString } from '@cupboard/nix-store/scalars';
import { storeDirectoryOf } from '@cupboard/nix-store/store-path';

import { StorePathNotServedError } from '../errors.ts';

/**
 * Refuses any submitted path that is not in the store directory this cache
 * serves. `storePathSchema` validates the shape of a store path, and that
 * shape is the same for every store. Which store a cache accepts is a property
 * of the cache, so that check runs here, where the request arrives.
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
