import {
	type CacheScope,
	type StorePathHash
} from '@cupboard/nix-store/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { and, eq } from 'drizzle-orm';

import { type CacheId } from '../db/cache.ts';
import * as schema from '../db/schema.ts';
import { currentServer, defaultCache, resolvedCache } from '../test-support.ts';

/**
The build-input columns of a row without build inputs, as
{@link buildInputColumns} reads them.
*/
export const unrecorded = {
	buildInputsJson: undefined,
	buildInputsVersion: undefined
};

/**
The build-input columns of a path's row in a cache, with NULL read as
undefined. A cache that has been removed no longer resolves from its scope, so
the caller passes its ID instead.
*/
export async function buildInputColumns(
	storePathHash: StorePathHash,
	cache: CacheScope | CacheId = defaultCache()
) {
	const row = await runInDurableObject(currentServer(), (instance) => {
		const cacheId =
			typeof cache === 'number'
				? cache
				: resolvedCache(instance.context, cache).id;

		return instance.context.db
			.select({
				buildInputsJson: schema.narInfos.buildInputsJson,
				buildInputsVersion: schema.narInfos.buildInputsVersion
			})
			.from(schema.narInfos)
			.where(
				and(
					eq(schema.narInfos.cacheId, cacheId),
					eq(schema.narInfos.storePathHash, storePathHash)
				)
			)
			.get();
	});

	return row === undefined
		? undefined
		: {
				buildInputsJson: row.buildInputsJson ?? undefined,
				buildInputsVersion: row.buildInputsVersion ?? undefined
			};
}
