import { NixSha256Hash } from '@cupboard/nix-store/hash';
import { type NixSha256HashString } from '@cupboard/nix-store/scalars';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { and, eq, sql } from 'drizzle-orm';
import { type BatchItem } from 'drizzle-orm/batch';
import { type DrizzleD1Database } from 'drizzle-orm/d1';

import * as d1Schema from '../db/d1-schema.ts';
import { type CanonicalBlob, canonicalBlobOf } from '../do/upload-metadata.ts';
import { UploadedObjectNotFoundError } from '../errors.ts';
import { narObjectKey, type R2ObjectKey } from '../http/http.ts';

import {
	activateObjectIncarnation,
	isObjectIncarnationLive,
	promotableStateIncarnation,
	queueObjectDeletion,
	registeredLiveObjectIncarnation,
	reserveObjectIncarnation
} from './object-incarnation.ts';

/**
 * The verified NAR metadata used to promote staged bytes.
 */
export interface PromotionTarget {
	readonly narHash: NixSha256HashString;
	readonly narSize: number;
}

async function ensureCanonicalObject(
	blobs: R2Bucket,
	stagingKey: R2ObjectKey,
	narHash: NixSha256HashString,
	narSize: number,
	incarnation: number,
	canCreate: boolean,
	// Fresh verification supplies metadata derived from staged bytes. Reuse
	// derives authoritative metadata from an existing canonical object.
	blob: CanonicalBlob | undefined,
	isStillOwned?: () => boolean,
	queueObjectDeletionAfterWrite?: () => Promise<void>
): Promise<CanonicalBlob | undefined> {
	const canonicalKey = narObjectKey(narHash, incarnation);
	const existing = await blobs.head(canonicalKey);

	if (isStillOwned?.() === false) {
		return undefined;
	}

	if (existing !== null) {
		return canonicalBlobOf(canonicalKey, existing);
	}

	if (!canCreate || blob === undefined) {
		throw new UploadedObjectNotFoundError(canonicalKey);
	}

	const staged = await blobs.get(stagingKey);

	if (isStillOwned?.() === false) {
		return undefined;
	}

	if (staged === null) {
		throw new UploadedObjectNotFoundError(stagingKey);
	}

	const written = await blobs.put(canonicalKey, staged.body, {
		// Verification computed this hash from the staging bytes. Ask R2 to check
		// the bytes again while it writes the canonical object.
		sha256: NixSha256Hash.parse(blob.fileHash).digestBytes(),
		customMetadata: { narSize: String(narSize) },
		onlyIf: { etagDoesNotMatch: '*' }
	});

	if (isStillOwned?.() === false) {
		await queueObjectDeletionAfterWrite?.();
		return undefined;
	}

	if (written !== null) {
		return blob;
	}

	// A concurrent promotion won between the head and the conditional put: adopt
	// the stored encoding so this narinfo matches the object that is served.
	const winner = await blobs.head(canonicalKey);

	if (isStillOwned?.() === false) {
		return undefined;
	}

	if (winner === null) {
		throw new UploadedObjectNotFoundError(canonicalKey);
	}

	return canonicalBlobOf(canonicalKey, winner);
}

/**
 * Promotes verified staging bytes to a versioned shared R2 object and returns
 * its compressed metadata. A conditional put makes each physical object
 * version write-once, so concurrent uploads adopt one encoding. The staging
 * object remains until the commit is durable so a retry can recover after a
 * crash.
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
	const staged = await stagePromotedBlob(d1, blobs, stagingKey, target, blob);

	const committed = await commitStagedBlobPromotion(d1, staged);

	if (committed === 'retired') {
		throw new UploadedObjectNotFoundError(
			narObjectKey(staged.narHash, staged.incarnation)
		);
	}

	return staged.canonical;
}

/**
 * A promotion whose R2 work is complete but whose `blob_state` row is not yet
 * written. A caller can apply the upsert directly or include it in one D1 batch
 * with other promotions.
 */
export interface StagedBlobPromotion {
	readonly canonical: CanonicalBlob;
	readonly upsert: BlobStateUpsert;
	readonly narHash: NixSha256HashString;
	readonly incarnation: number;
	readonly reservationOwner?: string;
	readonly requiresActivation: boolean;
}

export type BlobStateUpsert = BatchItem<'sqlite'> & {
	run: () => Promise<unknown>;
};

/**
 * Performs the R2 promotion and returns the `blob_state` upsert. The caller must
 * execute the upsert directly or include it in a D1 batch.
 */
export function stagePromotedBlob(
	d1: DrizzleD1Database<typeof d1Schema>,
	blobs: R2Bucket,
	stagingKey: R2ObjectKey,
	target: PromotionTarget,
	blob: CanonicalBlob | undefined
): Promise<StagedBlobPromotion>;
export function stagePromotedBlob(
	d1: DrizzleD1Database<typeof d1Schema>,
	blobs: R2Bucket,
	stagingKey: R2ObjectKey,
	target: PromotionTarget,
	blob: CanonicalBlob | undefined,
	reservationOwner: string,
	isStillOwned: () => boolean
): Promise<StagedBlobPromotion | undefined>;
export async function stagePromotedBlob(
	d1: DrizzleD1Database<typeof d1Schema>,
	blobs: R2Bucket,
	stagingKey: R2ObjectKey,
	target: PromotionTarget,
	blob: CanonicalBlob | undefined,
	reservationOwner?: string,
	isStillOwned?: () => boolean
): Promise<StagedBlobPromotion | undefined> {
	const [claimed] = await d1
		.select({ incarnation: d1Schema.blobState.incarnation })
		.from(d1Schema.blobState)
		.where(
			and(
				eq(d1Schema.blobState.narHash, target.narHash),
				registeredLiveObjectIncarnation(
					d1,
					'nar',
					target.narHash,
					d1Schema.blobState.incarnation
				)
			)
		)
		.limit(1);
	const reserved =
		claimed ??
		(await reserveObjectIncarnation(
			d1,
			'nar',
			target.narHash,
			reservationOwner
		));

	if (isStillOwned?.() === false) {
		return undefined;
	}

	const canonical = await ensureCanonicalObject(
		blobs,
		stagingKey,
		target.narHash,
		target.narSize,
		reserved.incarnation,
		claimed === undefined,
		blob,
		isStillOwned,
		() => queueObjectDeletion(d1, 'nar', target.narHash, reserved.incarnation)
	);

	if (canonical === undefined) {
		return undefined;
	}

	return {
		canonical,
		upsert: blobStateUpsert(d1, target, canonical, reserved.incarnation),
		narHash: target.narHash,
		incarnation: reserved.incarnation,
		reservationOwner,
		requiresActivation: claimed === undefined
	};
}

/**
 * Activates a prepared R2 object and writes its `blob_state` row. This function
 * performs no R2 request, so a caller can keep its local ownership check active
 * for the complete operation.
 */
export async function commitStagedBlobPromotion(
	d1: DrizzleD1Database<typeof d1Schema>,
	staged: StagedBlobPromotion,
	isStillOwned: () => boolean = () => true
): Promise<'live' | 'retired'> {
	if (!isStillOwned()) {
		return 'retired';
	}

	if (staged.requiresActivation) {
		const activation = await activateObjectIncarnation(
			d1,
			'nar',
			staged.narHash,
			staged.incarnation,
			staged.reservationOwner
		);

		if (activation === 'retired') {
			return 'retired';
		}
	}

	if (!isStillOwned()) {
		return 'retired';
	}

	await staged.upsert.run();

	if (!isStillOwned()) {
		return 'retired';
	}

	const isLive = await isObjectIncarnationLive(
		d1,
		'nar',
		staged.narHash,
		staged.incarnation
	);

	if (!isLive) {
		await queueObjectDeletion(d1, 'nar', staged.narHash, staged.incarnation);

		return 'retired';
	}

	return 'live';
}

// The first writer for an object version fixes its compressed metadata. A later
// promotion of that version retains the metadata and clears its reaper
// deadline. Verified frames use zstd, the only encoding stored here.
function blobStateUpsert(
	d1: DrizzleD1Database<typeof d1Schema>,
	target: PromotionTarget,
	canonical: CanonicalBlob,
	incarnation: number
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
			incarnation,
			verifiedAt
		})
		.onConflictDoUpdate({
			target: d1Schema.blobState.narHash,
			set: {
				fileHash: canonical.fileHash,
				fileSize: canonical.fileSize,
				compression: 'zstd',
				narSize: target.narSize,
				incarnation,
				deleteAfter: sql`null`,
				verifiedAt
			},
			setWhere: and(
				promotableStateIncarnation(d1Schema.blobState.incarnation, incarnation),
				eq(d1Schema.blobState.narHash, target.narHash)
			)
		});
}
