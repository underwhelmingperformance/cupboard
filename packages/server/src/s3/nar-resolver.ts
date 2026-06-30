import {
	type NixSha256HashString,
	type TenantId
} from '@cupboard/nix-store/scalars';
import { and, eq } from 'drizzle-orm';
import { type DrizzleD1Database } from 'drizzle-orm/d1';

import * as d1Schema from '../db/d1-schema.ts';

type D1 = DrizzleD1Database<typeof d1Schema>;

/**
 * Resolves the hash in a `nar/<hash>` key to the canonical NAR hash of a blob
 * this tenant may read, or `undefined` when the blob is absent or the tenant
 * does not reference it. The hash may be the NAR hash directly, or the
 * compressed file hash a client uploaded under, which is mapped through
 * `blob_state`. NAR blobs are content-addressed and shared across tenants, so
 * this ownership check stops one tenant reading another's blob by hash.
 */
export async function resolveServableNar(
	d1: D1,
	tenant: TenantId,
	hash: NixSha256HashString
): Promise<NixSha256HashString | undefined> {
	if (await tenantOwns(d1, tenant, hash)) {
		return hash;
	}

	const blob = await d1
		.select({ narHash: d1Schema.blobState.narHash })
		.from(d1Schema.blobState)
		.where(eq(d1Schema.blobState.fileHash, hash))
		.get();

	if (blob === undefined) {
		return undefined;
	}

	return (await tenantOwns(d1, tenant, blob.narHash))
		? blob.narHash
		: undefined;
}

async function tenantOwns(
	d1: D1,
	tenant: TenantId,
	narHash: NixSha256HashString
): Promise<boolean> {
	const owned = await d1
		.select({ narHash: d1Schema.tenantBlob.narHash })
		.from(d1Schema.tenantBlob)
		.where(
			and(
				eq(d1Schema.tenantBlob.tenant, tenant),
				eq(d1Schema.tenantBlob.narHash, narHash)
			)
		)
		.get();

	return owned !== undefined;
}
