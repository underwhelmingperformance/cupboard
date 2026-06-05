import { NixSha256Hash } from '@cupboard/nix/hash';
import { type UploadPathMetadataFields } from '@cupboard/protocol/upload';
import { eq, sql } from 'drizzle-orm';

import { R2Presigner } from '../blob/presign.ts';
import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import { UploadedObjectNotFoundError } from '../errors.ts';
import { narObjectKey } from '../http/http.ts';

import {
	type CanonicalBlob,
	canonicalBlobOf,
	type ServerContext
} from './context.ts';

export class UploadStateService {
	constructor(private readonly context: ServerContext) {}

	clearPendingUpload(uploadId: string): void {
		this.context.db
			.delete(schema.pendingUploads)
			.where(eq(schema.pendingUploads.id, uploadId))
			.run();
	}

	// Clears an abandoned pending upload's record, deleting its private staging
	// object first so the durable handle to that object is never dropped before the
	// object itself. A reuse upload's r2Key is the shared canonical key, which must
	// survive; only a per-upload staging key is removed. It awaits R2 I/O, so it is
	// called outside any critical section.
	async clearPendingUploadAndStaging(
		uploadId: string,
		r2Key: string,
		narHash: string
	): Promise<void> {
		if (r2Key !== narObjectKey(narHash)) {
			await this.context.env.BLOBS.delete(r2Key);
		}

		this.clearPendingUpload(uploadId);
	}

	markUploadPending(uploadId: string): void {
		this.context.db
			.update(schema.pendingUploads)
			.set({ verdict: 'pending' })
			.where(eq(schema.pendingUploads.id, uploadId))
			.run();
	}

	// Marks an inline commit in progress before it reserves the narinfo row, so a
	// crash mid-commit leaves a durable saga marker the verify pass re-drives rather
	// than a null-verdict upload indistinguishable from one still awaiting its bytes.
	markUploadCommitting(uploadId: string): void {
		this.context.db
			.update(schema.pendingUploads)
			.set({ verdict: 'committing' })
			.where(eq(schema.pendingUploads.id, uploadId))
			.run();
	}

	// Records a durable `mismatch` verdict for a background verification failure and
	// deletes the bad staging bytes, keeping the upload row so a later status reader
	// (`push --wait` or a status endpoint) can observe why the path never became
	// servable. Synchronous inline failures reject immediately and need no verdict.
	async markUploadFailed(
		uploadId: string,
		r2Key: string,
		narHash: string
	): Promise<void> {
		if (r2Key !== narObjectKey(narHash)) {
			await this.context.env.BLOBS.delete(r2Key);
		}

		// Refresh the observation window so the terminal verdict reliably outlives
		// the verify pass that recorded it (the pass may run at or past the original
		// upload TTL); GC reaps it once this window passes.
		this.context.db
			.update(schema.pendingUploads)
			.set({
				verdict: 'mismatch',
				expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString()
			})
			.where(eq(schema.pendingUploads.id, uploadId))
			.run();
	}

	async findReusableBlob(
		narHash: string
	): Promise<typeof d1Schema.blobState.$inferSelect | undefined> {
		const existingBlob = await this.context.d1
			.select()
			.from(d1Schema.blobState)
			.where(eq(d1Schema.blobState.narHash, narHash))
			.get();

		if (existingBlob === undefined) {
			return undefined;
		}

		const object = await this.context.env.BLOBS.head(narObjectKey(narHash));

		// The object is gone: do not reuse, and leave the stale `blob_state` row for
		// the reaper to collect. A correct re-upload of the hash heals it.
		if (object === null) {
			return undefined;
		}

		// Reusing is a fresh reference, so cancel any reaper grace timer before the
		// commit binds a new edge to the hash.
		if (existingBlob.deleteAfter !== null) {
			await this.context.d1
				.update(d1Schema.blobState)
				.set({ deleteAfter: sql`null` })
				.where(eq(d1Schema.blobState.narHash, narHash))
				.run();
		}

		return existingBlob;
	}

	// Promotes verified staging bytes into the shared, content-addressed CAS and
	// returns the canonical object's compressed metadata. The canonical key is
	// write-once: a conditional put means the first promotion of a hash fixes the
	// stored encoding, and any later or concurrent upload of the same hash adopts
	// that encoding instead of overwriting it — so every narinfo for the hash
	// advertises the one object that is actually served, even when tenants upload
	// different zstd encodings of the same NAR. The staging object is left in place;
	// its caller deletes it only once the commit is durable, so a crash between
	// promotion and commit recovers from the surviving staging copy.
	async promoteStagingBlob(
		stagingKey: string,
		metadata: UploadPathMetadataFields
	): Promise<CanonicalBlob> {
		const canonical = await this.ensureCanonicalObject(stagingKey, metadata);

		// Record the shared fact together with the object, so `blob_state` exists
		// exactly when the canonical R2 object does. The first writer for a hash
		// fixes the metadata; a concurrent or repeated promotion keeps it, but clears
		// any reaper grace timer, since promoting is a fresh reference to the hash.
		await this.context.d1
			.insert(d1Schema.blobState)
			.values({
				narHash: metadata.narHash,
				fileHash: canonical.fileHash,
				fileSize: canonical.fileSize,
				compression: metadata.compression,
				narSize: metadata.narSize,
				verifiedAt: new Date().toISOString()
			})
			.onConflictDoUpdate({
				target: d1Schema.blobState.narHash,
				set: { deleteAfter: sql`null` }
			})
			.run();

		return canonical;
	}

	private async ensureCanonicalObject(
		stagingKey: string,
		metadata: UploadPathMetadataFields
	): Promise<CanonicalBlob> {
		const canonicalKey = narObjectKey(metadata.narHash);
		const existing = await this.context.env.BLOBS.head(canonicalKey);

		if (existing !== null) {
			return canonicalBlobOf(canonicalKey, existing);
		}

		const staged = await this.context.env.BLOBS.get(stagingKey);

		if (staged === null) {
			throw new UploadedObjectNotFoundError(stagingKey);
		}

		const written = await this.context.env.BLOBS.put(
			canonicalKey,
			staged.body,
			{
				sha256: NixSha256Hash.parse(metadata.fileHash).digestBytes(),
				onlyIf: { etagDoesNotMatch: '*' }
			}
		);

		if (written !== null) {
			return { fileHash: metadata.fileHash, fileSize: metadata.fileSize };
		}

		// A concurrent promotion won between the head and the conditional put: adopt
		// the stored encoding so this narinfo matches the object that is served.
		const winner = await this.context.env.BLOBS.head(canonicalKey);

		if (winner === null) {
			throw new UploadedObjectNotFoundError(canonicalKey);
		}

		return canonicalBlobOf(canonicalKey, winner);
	}

	async presignedPutUrl(
		key: string,
		fileHash: string,
		expiresAt: Date
	): Promise<string> {
		return this.r2Presigner().presignPutUrl({
			key,
			checksumSha256: NixSha256Hash.parse(fileHash).digestBase64(),
			expiresSeconds: Math.max(
				1,
				Math.floor((expiresAt.getTime() - Date.now()) / 1000)
			)
		});
	}

	private r2Presigner(): R2Presigner {
		return this.context.r2Presigner();
	}
}
