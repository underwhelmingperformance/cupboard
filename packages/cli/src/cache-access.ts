import {
	type CacheAccessMode,
	cacheAccessModeSchema
} from '@cupboard/nix-store/scalars';

import { InvalidCacheAccessModeError } from './errors.ts';

export function parseCacheAccess(value: string): CacheAccessMode {
	const access = cacheAccessModeSchema.safeParse(value);

	if (!access.success) {
		throw new InvalidCacheAccessModeError(value);
	}

	return access.data;
}
