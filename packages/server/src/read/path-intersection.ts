import {
	type CacheGeneration,
	type CacheScope,
	type StorePathHash,
	type TenantId
} from '@cupboard/nix-store/scalars';
import { and, eq, sql } from 'drizzle-orm';
import { type DrizzleD1Database } from 'drizzle-orm/d1';

import { cacheIdentityCondition } from '../db/cache.ts';
import * as d1Schema from '../db/d1-schema.ts';
import { readWithOneRetry } from '../db/transient.ts';
import { SharedFactsUnavailableError } from '../errors.ts';

import { authorisedNarInfoVersions } from './read.ts';

const cacheScanThreshold = 256;
const cacheScanMaxRows = 4096;

interface AdmittedCache {
	readonly scope: CacheScope;
	readonly generation: CacheGeneration;
}

export interface CachePathIntersection {
	readonly matchingHashes: readonly StorePathHash[];
	readonly strategy: 'candidate' | 'cache' | 'candidate-fallback';
	readonly scannedRows: number;
	readonly candidateHashes: number;
}

/**
 * Selects a bounded raw reference range in the admitted cache incarnation.
 */
export function readableCachePathRange(
	database: DrizzleD1Database<typeof d1Schema>,
	tenant: TenantId,
	cache: AdmittedCache,
	maximumRows: number
) {
	const edge = d1Schema.blobReference;
	return database
		.select({ storePathHash: edge.storePathHash })
		.from(edge)
		.where(
			and(
				eq(edge.tenant, tenant),
				cacheIdentityCondition(edge.cacheKind, edge.cacheName, cache.scope),
				eq(edge.cacheGeneration, cache.generation),
				sql`${edge.readable} = true`
			)
		)
		.limit(maximumRows);
}

/**
 * Returns possible matches after checking publication revocation fences.
 * The exhausted raw range is a conservative superset at the scan's snapshot;
 * canonical metadata must still validate each returned path.
 */
export async function intersectCachePaths(
	database: DrizzleD1Database<typeof d1Schema>,
	tenant: TenantId,
	cache: AdmittedCache,
	requested: readonly StorePathHash[],
	signal?: AbortSignal
): Promise<CachePathIntersection> {
	signal?.throwIfAborted();
	const hashes = [...new Set(requested)];
	let candidates = hashes;
	let strategy: CachePathIntersection['strategy'] = 'candidate';
	let scannedRows = 0;
	if (hashes.length >= cacheScanThreshold) {
		const budget = Math.min(hashes.length, cacheScanMaxRows);
		let rows;
		try {
			rows = await readWithOneRetry(() =>
				readableCachePathRange(database, tenant, cache, budget + 1).all()
			);
		} catch (error) {
			throw new SharedFactsUnavailableError(error);
		}
		signal?.throwIfAborted();
		scannedRows = rows.length;
		if (rows.length > budget) {
			strategy = 'candidate-fallback';
		} else {
			strategy = 'cache';
			const available = new Set(rows.map((row) => row.storePathHash));
			candidates = hashes.filter((hash) => available.has(hash));
		}
	}
	signal?.throwIfAborted();
	const versions = await authorisedNarInfoVersions(
		database,
		tenant,
		cache.scope,
		candidates
	);
	signal?.throwIfAborted();
	return {
		matchingHashes: candidates.filter(
			(hash) => versions.get(hash)?.cacheGeneration === cache.generation
		),
		strategy,
		scannedRows,
		candidateHashes: candidates.length
	};
}
