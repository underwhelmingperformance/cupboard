import {
	PRIVATE_STORED_RANGE_END,
	PRIVATE_STORED_RANGE_START
} from '@cupboard/nix-store/scalars';
import { and, type Column, gte, lt, or, type SQL, sql } from 'drizzle-orm';

/**
 * Matches the half-open range occupied by private stored cache names. A single
 * index can answer both comparisons. The public cache named `private` sorts
 * below the start bound.
 */
export function withinPrivateCaches(cache: Column): SQL | undefined {
	return and(
		gte(cache, sql`${PRIVATE_STORED_RANGE_START}`),
		lt(cache, sql`${PRIVATE_STORED_RANGE_END}`)
	);
}

/**
 * Matches the default cache and every named public cache.
 */
export function outsidePrivateCaches(cache: Column): SQL | undefined {
	return or(
		lt(cache, sql`${PRIVATE_STORED_RANGE_START}`),
		gte(cache, sql`${PRIVATE_STORED_RANGE_END}`)
	);
}
