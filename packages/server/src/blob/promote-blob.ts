import { NixSha256Hash } from '@cupboard/nix-store/hash';
import { type NixSha256HashString } from '@cupboard/nix-store/scalars';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { sql } from 'drizzle-orm';
import { type BatchItem } from 'drizzle-orm/batch';
import { type DrizzleD1Database } from 'drizzle-orm/d1';

import * as d1Schema from '../db/d1-schema.ts';
import { type CanonicalBlob, canonicalBlobOf } from '../do/upload-metadata.ts';
import { UploadedObjectNotFoundError } from '../errors.ts';
import { narObjectKey, type R2ObjectKey } from '../http/http.ts';

export interface PromotionTarget {
	readonly narHash: NixSha256HashString;
	readonly narSize: number;
}

async function ensureCanonicalObject(
	blobs: R2Bucket,
	stagingKey: R2ObjectKey,
	narHash: NixSha256HashString,
	// Fresh verification passes metadata derived from the staging bytes. Reuse
	// omits it and reads authoritative metadata from the canonical object.
	blob: CanonicalBlob | undefined
): Promise<CanonicalBlob> {
	const canonicalKey = narObjectKey(narHash);
	const existing = await blobs.head(canonicalKey);

	if (existing !== null) {
		return canonicalBlobOf(canonicalKey, existing);
	}

	if (blob === undefined) {
		throw new UploadedObjectNotFoundError(canonicalKey);
	}

	const staged = await blobs.get(stagingKey);

	if (staged === null) {
		throw new UploadedObjectNotFoundError(stagingKey);
	}

	const written = await blobs.put(canonicalKey, staged.body, {
		// Verification computed this hash from the staging bytes. Ask R2 to check
		// the bytes again while it writes the canonical object.
		sha256: NixSha256Hash.parse(blob.fileHash).digestBytes(),
		onlyIf: { etagDoesNotMatch: '*' }
	});

	if (written !== null) {
		return blob;
	}

	// A concurrent promotion won between the head and the conditional put: adopt
	// the stored encoding so this narinfo matches the object that is served.
	const winner = await blobs.head(canonicalKey);

	if (winner === null) {
		throw new UploadedObjectNotFoundError(canonicalKey);
	}

	return canonicalBlobOf(canonicalKey, winner);
}

/**
 * The first conditional write fixes the compressed encoding for the lifetime
 * of a canonical object. Concurrent and later promotions adopt its metadata so
 * every narinfo for the NAR refers to the object that R2 serves. After the
 * reaper removes that object, a fresh promotion can establish another encoding.
 *
 * R2 completes before the `blob_state` write. A crash between them can leave an
 * unrecorded canonical object; retrying adopts that object and writes the row.
 * Staging remains until the commit is durable so earlier crash points can also
 * be retried.
 */
export async function promoteVerifiedBlob(
	d1: DrizzleD1Database<typeof d1Schema>,
	blobs: R2Bucket,
	stagingKey: R2ObjectKey,
	target: PromotionTarget,
	blob: CanonicalBlob | undefined
): Promise<CanonicalBlob> {
	const { canonical, upsert } = await stagePromotedBlob(
		d1,
		blobs,
		stagingKey,
		target,
		blob
	);

	await upsert.run();

	return canonical;
}

interface StagedBlobPromotion {
	readonly canonical: CanonicalBlob;
	readonly upsert: BlobStateUpsert;
}

export type BlobStateUpsert = BatchItem<'sqlite'> & {
	run: () => Promise<unknown>;
};

/**
 * Performs the R2 promotion and returns the `blob_state` upsert. The caller must
 * execute the upsert directly or include it in a D1 batch.
 */
export async function stagePromotedBlob(
	d1: DrizzleD1Database<typeof d1Schema>,
	blobs: R2Bucket,
	stagingKey: R2ObjectKey,
	target: PromotionTarget,
	blob: CanonicalBlob | undefined
): Promise<StagedBlobPromotion> {
	const canonical = await ensureCanonicalObject(
		blobs,
		stagingKey,
		target.narHash,
		blob
	);

	return { canonical, upsert: blobStateUpsert(d1, target, canonical) };
}

// An existing row retains the canonical compressed metadata. Promotion clears
// its reaper deadline because a committed reference can follow. Verified NARs
// use zstd, the only encoding stored here.
function blobStateUpsert(
	d1: DrizzleD1Database<typeof d1Schema>,
	target: PromotionTarget,
	canonical: CanonicalBlob
): BlobStateUpsert {
	const verifiedAt = isoTimestamp(new Date());

	return d1
		.insert(d1Schema.blobState)
		.values({
			narHash: target.narHash,
			fileHash: canonical.fileHash,
			fileSize: canonical.fileSize,
			compression: 'zstd',
			narSize: target.narSize,
			verifiedAt
		})
		.onConflictDoUpdate({
			target: d1Schema.blobState.narHash,
			// The demotion pass compares `verified_at` with its earlier snapshot before
			// deleting. Refresh it on promotion so a later timestamp invalidates an
			// older snapshot.
			set: { deleteAfter: sql`null`, verifiedAt }
		});
}
