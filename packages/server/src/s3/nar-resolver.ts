import {
	type NixSha256HashString,
	type StoredCache,
	type TenantId
} from '@cupboard/nix-store/scalars';
import { and, eq, isNotNull, or, sql } from 'drizzle-orm';
import { type DrizzleD1Database } from 'drizzle-orm/d1';

import * as d1Schema from '../db/d1-schema.ts';

type D1 = DrizzleD1Database<typeof d1Schema>;

/**
 * Resolves the hash in a `nar/<hash>` key to the canonical NAR hash when the
 * selected cache has a committed reference to the blob. Returns `undefined`
 * when no such reference exists. The supplied hash may be the NAR hash or the
 * compressed file hash a client uploaded under. `blob_state` maps the file hash
 * to the NAR hash. NAR blobs are shared across caches and tenants, so the exact
 * `blob_ref` scope prevents a credential from reading a blob through another
 * cache.
 *
 * A single query joins committed references to `blob_state`. The direct match
 * sorts first so it wins when the supplied value is both a NAR hash and another
 * blob's file hash.
 */
export async function resolveServableNar(
	d1: D1,
	tenant: TenantId,
	cache: StoredCache,
	hash: NixSha256HashString
): Promise<NixSha256HashString | undefined> {
	// A file hash maps to the NAR hash on the same committed reference.
	const mapsFileHash = and(
		eq(d1Schema.blobState.narHash, d1Schema.blobReference.narHash),
		eq(d1Schema.blobState.fileHash, hash)
	);

	const referencesMatchingNar = and(
		eq(d1Schema.blobReference.tenant, tenant),
		eq(d1Schema.blobReference.cache, cache),
		or(
			eq(d1Schema.blobReference.narHash, hash),
			isNotNull(d1Schema.blobState.narHash)
		)
	);

	const reference = await d1
		.select({ narHash: d1Schema.blobReference.narHash })
		.from(d1Schema.blobReference)
		.leftJoin(d1Schema.blobState, mapsFileHash)
		.where(referencesMatchingNar)
		.orderBy(
			sql`case when ${d1Schema.blobReference.narHash} = ${hash} then 0 else 1 end`
		)
		.limit(1)
		.get();

	return reference?.narHash;
}
