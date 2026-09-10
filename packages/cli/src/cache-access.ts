import {
	type CacheAccessMode,
	cacheAccessModeSchema
} from '@cupboard/nix-store/scalars';

import { InvalidCacheAccessModeError } from './errors.ts';

/**
 * Parses a cache's read access mode. No cache takes its access by omission:
 * `cache create` and `tenant create` both require the operator to name the
 * mode, and `cupboard init` asks for it when its own flag is absent. Giving
 * either required flag a default would put that decision back in the tool's
 * hands.
 */
export function parseCacheAccess(value: string): CacheAccessMode {
	const access = cacheAccessModeSchema.safeParse(value);

	if (!access.success) {
		throw new InvalidCacheAccessModeError(value);
	}

	return access.data;
}
