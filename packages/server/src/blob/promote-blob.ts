import { NixSha256Hash } from '@cupboard/nix-store/hash';
import { type NixSha256HashString } from '@cupboard/nix-store/scalars';
import { sql } from 'drizzle-orm';
import { type DrizzleD1Database } from 'drizzle-orm/d1';

import * as d1Schema from '../db/d1-schema.ts';
import { type CanonicalBlob, canonicalBlobOf } from '../do/upload-metadata.ts';
import { UploadedObjectNotFoundError } from '../errors.ts';
import { narObjectKey } from '../http/http.ts';

/** The verified upload a promotion binds to its canonical object. */
export interface PromotionTarget {
	readonly narHash: NixSha256HashString;
	readonly narSize: number;
}

async function ensureCanonicalObject(
	blobs: R2Bucket,
	stagingKey: string,
	narHash: NixSha256HashString,
	// The blob facts verify derived for a fresh upload. A reuse promotes against
	// an already-canonical object and derives them from it, so it passes none.
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
		// The file hash was computed over these exact staging bytes during verify,
		// so R2 re-checking the copy against it confirms the promote moved them
		// intact, not that a client-asserted value matched.
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
 * Promotes verified staging bytes into the shared, content-addressed CAS and
 * returns the canonical object's compressed metadata. The canonical key is
 * write-once: a conditional put means the first promotion of a hash fixes the
 * stored encoding, and any later or concurrent upload of the same hash adopts
 * that encoding instead of overwriting it, so every narinfo for the hash
 * advertises the one object that is actually served, even when tenants upload
 * different zstd encodings of the same NAR. The staging object is left in
 * place; its caller deletes it only once the commit is durable, so a crash
 * between promotion and commit recovers from the surviving staging copy.
 *
 * Every step is idempotent and touches only the shared facts (the canonical R2
 * object and its `blob_state` row), so any actor holding the bindings may run
 * it: the tenant Durable Object or a Worker that has just verified the bytes.
 */
export async function promoteVerifiedBlob(
	d1: DrizzleD1Database<typeof d1Schema>,
	blobs: R2Bucket,
	stagingKey: string,
	target: PromotionTarget,
	blob: CanonicalBlob | undefined
): Promise<CanonicalBlob> {
	const canonical = await ensureCanonicalObject(
		blobs,
		stagingKey,
		target.narHash,
		blob
	);
	const now = new Date();
	const verifiedAt = now.toISOString();

	// Record the shared fact together with the object, so `blob_state` exists
	// exactly when the canonical R2 object does. The first writer for a hash
	// fixes the metadata; a concurrent or repeated promotion keeps it, but clears
	// any reaper grace timer, since promoting is a fresh reference to the hash.
	// A verified frame is always zstd, the only encoding the server stores.
	await d1
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
			// Advancing `verified_at` on a re-promote (which re-creates an object the
			// reaper may have collected) makes it the optimistic-concurrency token the
			// demote pass fences its delete on: a demote that scanned the old row will
			// not delete the freshly re-promoted one.
			set: { deleteAfter: sql`null`, verifiedAt }
		})
		.run();

	return canonical;
}
