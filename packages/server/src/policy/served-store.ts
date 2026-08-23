import { servedStoreDirectory } from '@cupboard/nix-store/cache-info';
import { type StorePathString } from '@cupboard/nix-store/scalars';
import { storeDirectoryOf } from '@cupboard/nix-store/store-path';

import { StorePathNotServedError } from '../errors.ts';

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
