import {
	type ParsedUploadNegotiateRequest,
	type ParsedUploadPathMetadata,
	type ParsedUploadPathNegotiation,
	type ParsedUploadPrepareRequest,
	type UploadDecision,
	type UploadNegotiateResponse,
	type UploadPrepareResponse,
	type UploadStatusResponse
} from '@cupboard/protocol/upload';
import { and, eq } from 'drizzle-orm';

import * as schema from '../db/schema.ts';
import {
	ReusableUploadNotPreparableError,
	UploadCacheMismatchError,
	UploadExpiredError,
	UploadNotFoundError
} from '../errors.ts';
import { narObjectKey, stagingObjectKey } from '../http/http.ts';

import {
	commitMetadataFromPathAndBlob,
	parseStoredUploadPathMetadata,
	type ServerContext,
	uploadHeadersFor
} from './context.ts';
import { type DeletionQueueService } from './deletion-queue-service.ts';
import { type NarInfoObjectsService } from './narinfo-objects-service.ts';
import { type UploadStateService } from './upload-state-service.ts';

type PendingVerdict = (typeof schema.pendingUploads.$inferSelect)['verdict'];

// Maps a polled upload's durable verdict to the status a `push --wait` client reads.
// An absent row is `absent`; a terminal verdict maps straight across; any in-flight
// or not-yet-committed verdict (null, `pending`, `committing`) is `pending`.
function uploadStatusOf(
	pending: { readonly verdict: PendingVerdict } | undefined
): UploadStatusResponse['status'] {
	if (pending === undefined) {
		return 'absent';
	}

	switch (pending.verdict) {
		case 'servable': {
			return 'servable';
		}
		case 'mismatch': {
			return 'mismatch';
		}
		case 'over-quota': {
			return 'over-quota';
		}
		default: {
			return 'pending';
		}
	}
}

export class UploadsService {
	constructor(
		private readonly context: ServerContext,
		private readonly uploadState: UploadStateService,
		private readonly narInfoObjects: NarInfoObjectsService,
		private readonly deletionQueue: DeletionQueueService
	) {}

	// The status of a deferred upload, polled on the uploadId the client holds.
	// Derived from the durable per-upload verdict: a row that is gone is
	// `absent`; otherwise the terminal `servable`/`mismatch`/`over-quota`, or `pending`
	// while it still verifies (a null or in-flight verdict).
	uploadStatus(uploadId: string): UploadStatusResponse {
		const pending = this.context.db
			.select({ verdict: schema.pendingUploads.verdict })
			.from(schema.pendingUploads)
			.where(eq(schema.pendingUploads.id, uploadId))
			.get();

		return { status: uploadStatusOf(pending) };
	}

	async negotiate(
		cache: string,
		body: ParsedUploadNegotiateRequest,
		origin: string
	): Promise<UploadNegotiateResponse> {
		const uploads: UploadDecision[] = [];

		for (const metadata of body.paths) {
			const existingNarInfo = this.context.db
				.select()
				.from(schema.narInfos)
				.where(
					and(
						eq(schema.narInfos.cache, cache),
						eq(schema.narInfos.storePathHash, metadata.storePathHash)
					)
				)
				.get();

			if (existingNarInfo !== undefined) {
				const object = await this.context.env.BLOBS.head(
					narObjectKey(existingNarInfo.narHash)
				);
				const committed = await this.narInfoObjects.hasCommittedReference(
					cache,
					existingNarInfo
				);

				if (object !== null && committed) {
					await this.narInfoObjects.ensureNarInfoObject(
						cache,
						existingNarInfo.storePathHash
					);
					uploads.push({
						action: 'skip',
						storePathHash: metadata.storePathHash,
						narHash: existingNarInfo.narHash
					});
					continue;
				}

				if (committed) {
					await this.deletionQueue.removeStaleNarInfo(existingNarInfo, origin);
				}
			}

			const existingBlob = await this.uploadState.findReusableBlob(
				metadata.narHash
			);
			const uploadId = crypto.randomUUID();
			const now = new Date();
			const expiresAt = new Date(now.getTime() + 15 * 60 * 1000);
			const pendingMetadata:
				| ParsedUploadPathNegotiation
				| ParsedUploadPathMetadata =
				existingBlob === undefined
					? metadata
					: {
							...commitMetadataFromPathAndBlob(metadata, existingBlob),
							// Sign the blob's verified narSize, never the client's declared
							// one: a reuse skips re-verification, so an unchecked size must
							// not reach the signed narinfo.
							narSize: existingBlob.narSize
						};
			// A fresh upload stages its bytes under a private, per-upload key; a reuse
			// commits against the canonical blob it already found. Keeping uploads off
			// the shared key means no client write can ever race or overwrite it.
			const r2Key =
				existingBlob === undefined
					? stagingObjectKey(uploadId)
					: narObjectKey(metadata.narHash);

			this.context.db
				.insert(schema.pendingUploads)
				.values({
					id: uploadId,
					// Bind the upload to its cache so a prepare or commit cannot
					// redirect it to a different one.
					cache,
					narHash: metadata.narHash,
					r2Key,
					expectedSize: existingBlob?.fileSize ?? 0,
					metadataJson: JSON.stringify(pendingMetadata),
					createdAt: now.toISOString(),
					expiresAt: expiresAt.toISOString()
				})
				.run();

			if (existingBlob !== undefined) {
				uploads.push({
					action: 'commit',
					storePathHash: metadata.storePathHash,
					narHash: metadata.narHash,
					uploadId
				});
				continue;
			}

			uploads.push({
				action: 'upload',
				storePathHash: metadata.storePathHash,
				narHash: metadata.narHash,
				uploadId,
				r2Key,
				expiresAt: expiresAt.toISOString()
			});
		}

		return { uploads };
	}

	async prepareUpload(
		cache: string,
		uploadId: string,
		blobMetadata: ParsedUploadPrepareRequest
	): Promise<UploadPrepareResponse> {
		const pending = this.context.db
			.select()
			.from(schema.pendingUploads)
			.where(eq(schema.pendingUploads.id, uploadId))
			.get();

		if (pending === undefined) {
			throw new UploadNotFoundError(uploadId);
		}

		if (pending.cache !== cache) {
			throw new UploadCacheMismatchError(uploadId, pending.cache, cache);
		}

		if (pending.expiresAt < new Date().toISOString()) {
			await this.uploadState.clearPendingUploadAndStaging(
				uploadId,
				pending.r2Key,
				pending.narHash
			);

			throw new UploadExpiredError(uploadId);
		}

		// A reuse upload's r2Key is the shared canonical key. It needs no upload, so
		// it is never prepared; reject it explicitly rather than presign a write
		// straight onto the shared CAS object (which the reuse commit would not
		// re-verify). The client should commit a reuse decision directly.
		if (pending.r2Key === narObjectKey(pending.narHash)) {
			throw new ReusableUploadNotPreparableError(uploadId);
		}

		const pathMetadata = parseStoredUploadPathMetadata(
			uploadId,
			pending.metadataJson
		);
		const metadata = commitMetadataFromPathAndBlob(pathMetadata, blobMetadata);
		const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

		this.context.db
			.update(schema.pendingUploads)
			.set({
				expectedSize: metadata.fileSize,
				metadataJson: JSON.stringify(metadata),
				expiresAt: expiresAt.toISOString()
			})
			.where(eq(schema.pendingUploads.id, uploadId))
			.run();

		return {
			uploadUrl: await this.uploadState.presignedPutUrl(
				pending.r2Key,
				metadata.fileHash,
				expiresAt
			),
			uploadHeaders: uploadHeadersFor(metadata),
			expiresAt: expiresAt.toISOString()
		};
	}
}
