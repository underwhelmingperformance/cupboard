import { type Column, eq, type SQL } from 'drizzle-orm';

/**
 * Matches caches with cache-specific private access.
 */
export function withinPrivateCaches(access: Column): SQL {
	return eq(access, 'private');
}

export function withinPublicCaches(access: Column): SQL {
	return eq(access, 'public');
}
