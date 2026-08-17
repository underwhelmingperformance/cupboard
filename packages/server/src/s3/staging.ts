import {
	type NixSha256HashString,
	selectorForCache,
	type StoredCache,
	type TenantId
} from '@cupboard/nix-store/scalars';

import {
	type R2ObjectKey,
	r2ObjectKeySchema,
	stagingPrefix
} from '../http/http.ts';

/**
 * The prefix under which S3 ingestion stages NAR bytes, keyed by their
 * compressed file hash, until the narinfo PUT that registers their
 * pending-upload row arrives. It uses the shared staging prefix so the existing
 * orphan reclaim also finds abandoned S3 uploads.
 */
export const s3StagingPrefix = `${stagingPrefix}s3/`;

/**
The S3 staging prefix private to one tenant.
*/
export function s3TenantStagingPrefix(tenant: TenantId): string {
	return `${s3StagingPrefix}${tenant}/`;
}

/**
 * How long a staged NAR can remain without a narinfo before garbage collection
 * treats it as abandoned. The writer records the same lifetime on the
 * pending-upload row, so the reaper and the writer share this one value: a
 * shorter reaper TTL would delete bytes whose narinfo PUT is still permitted.
 */
export const s3StagingTtlMs = 15 * 60 * 1000;

/**
 * The staging key an S3 NAR upload is written to before its narinfo PUT.
 */
export function s3NarStagingKey(
	tenant: TenantId,
	cache: StoredCache,
	fileHash: NixSha256HashString
): R2ObjectKey {
	return r2ObjectKeySchema.parse(
		`${s3TenantStagingPrefix(tenant)}${selectorForCache(cache)}/${fileHash}.nar.zst`
	);
}
