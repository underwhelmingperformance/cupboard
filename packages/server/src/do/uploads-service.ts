import { type StorePathHash } from '@cupboard/nix-store/scalars';
import {
	type ParsedUploadNegotiateRequest,
	type ParsedUploadPathMetadata,
	type ParsedUploadPathNegotiation,
	type ParsedUploadPrepareItemRequest,
	type ParsedUploadPrepareRequest,
	type UploadDecision,
	type UploadNegotiateResponse,
	type UploadPrepareBatchResponse,
	type UploadPrepareItemResult,
	type UploadPrepareResponse,
	type UploadStatusResponse
} from '@cupboard/protocol/upload';
import { and, eq, inArray } from 'drizzle-orm';

import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import {
	ReusableUploadNotPreparableError,
	UploadCacheMismatchError,
	UploadExpiredError,
	UploadNotFoundError
} from '../errors.ts';
import { narObjectKey, stagingObjectKey } from '../http/http.ts';

import { chunk, maxInClauseValues } from './bulk.ts';
import { type ServerContext } from './context.ts';
import { type DeletionQueueService } from './deletion-queue-service.ts';
import { type NarInfoObjectsService } from './narinfo-objects-service.ts';
import {
	commitMetadataFromPathAndBlob,
	parseStoredUploadPathMetadata,
	uploadHeadersFor
} from './upload-metadata.ts';
import { type UploadStateService } from './upload-state-service.ts';

type NarInfoRow = typeof schema.narInfos.$inferSelect;
type BlobStateRow = typeof d1Schema.blobState.$inferSelect;

// A pending upload, and a reuse upload's reclaim window, both live for fifteen
// minutes from when they are negotiated or prepared.
const uploadTtlMs = 15 * 60 * 1000;

type PendingVerdict = (typeof schema.pendingUploads.$inferSelect)['verdict'];

// Maps a polled upload's durable verdict to the status a `push --wait` client reads.
// An absent row is `absent`; a terminal verdict maps straight across; any in-flight
// or not-yet-committed verdict (null, `pending`, `committing`) is `pending`.
export function uploadStatusOf(
	pending: undefined | { readonly verdict: PendingVerdict }
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

	// The committed narinfo rows for a closure, read in cache-scoped chunks that
	// stay under D1's bound-parameter cap. The DO's own SQLite backs this table,
	// so the reads are local, but chunking keeps every batched lookup uniform.
	private existingNarInfos(
		cache: string,
		storePathHashes: readonly StorePathHash[]
	): Map<StorePathHash, NarInfoRow> {
		const rows = chunk(storePathHashes, maxInClauseValues).flatMap(
			(storePathHashBatch) =>
				this.context.db
					.select()
					.from(schema.narInfos)
					.where(
						and(
							eq(schema.narInfos.cache, cache),
							inArray(schema.narInfos.storePathHash, storePathHashBatch)
						)
					)
					.all()
		);

		return new Map(rows.map((row) => [row.storePathHash, row]));
	}

	// Re-materialises the tenant narinfo objects that a skippable path needs but
	// that R2 no longer holds. The bulk head already told us which are present, so
	// only the absent few open a critical section to heal.
	private async healMissingNarInfoObjects(
		cache: string,
		rows: readonly NarInfoRow[]
	): Promise<void> {
		const presentNarInfoObjects =
			await this.narInfoObjects.existingNarInfoObjects(
				cache,
				rows.map((row) => row.storePathHash)
			);

		for (const row of rows) {
			if (presentNarInfoObjects.has(row.storePathHash)) {
				continue;
			}

			await this.narInfoObjects.ensureNarInfoObject(cache, row.storePathHash);
		}
	}

	// Records a pending upload for one path and returns its decision: a reuse of an
	// existing shared blob commits against the canonical object, while a fresh
	// upload stages its bytes under a private, per-upload key so no client write
	// can race or overwrite the shared one.
	private planUpload(
		cache: string,
		metadata: ParsedUploadPathNegotiation,
		existingBlob: BlobStateRow | undefined
	): UploadDecision {
		const uploadId = crypto.randomUUID();
		const now = new Date();
		const expiresAt = new Date(now.getTime() + uploadTtlMs);
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
			return {
				action: 'commit',
				storePathHash: metadata.storePathHash,
				narHash: metadata.narHash,
				uploadId
			};
		}

		return {
			action: 'upload',
			storePathHash: metadata.storePathHash,
			narHash: metadata.narHash,
			uploadId,
			r2Key,
			expiresAt: expiresAt.toISOString()
		};
	}

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

	// Plans the per-path uploads for a whole closure. Every fact the decision
	// turns on is read in bulk first, so a closure of any size costs a bounded
	// number of D1 queries and R2 heads, not one of each per path: a large
	// negotiate used to walk thousands of serial round trips and time out.
	async negotiate(
		cache: string,
		body: ParsedUploadNegotiateRequest,
		origin: string
	): Promise<UploadNegotiateResponse> {
		if (body.paths.length === 0) {
			return { uploads: [] };
		}

		const existingByStorePathHash = this.existingNarInfos(
			cache,
			body.paths.map((path) => path.storePathHash)
		);
		const existingRows = existingByStorePathHash.values().toArray();
		const committed = await this.narInfoObjects.committedReferences(
			cache,
			existingRows
		);

		// A committed path is skippable only while its canonical NAR object
		// survives. Gather those, then self-heal just the skippable paths whose
		// tenant narinfo object is missing, so the common case enters no critical
		// section at all.
		const committedRows = existingRows.filter((row) =>
			committed.has(row.storePathHash)
		);
		const presentNarObjects = await this.narInfoObjects.existingNarObjects(
			committedRows.map((row) => row.narHash)
		);
		const skippableRows = committedRows.filter((row) =>
			presentNarObjects.has(row.narHash)
		);
		await this.healMissingNarInfoObjects(cache, skippableRows);
		const skippable = new Set(skippableRows.map((row) => row.storePathHash));

		// Only a path that will actually plan an upload needs a reusable blob, so a
		// fully cached re-push (every path a skip) heads no shared objects at all.
		const reusableByNarHash = await this.uploadState.findReusableBlobs(
			body.paths
				.filter((path) => !skippable.has(path.storePathHash))
				.map((path) => path.narHash)
		);

		const uploads: UploadDecision[] = [];

		for (const metadata of body.paths) {
			const existing = existingByStorePathHash.get(metadata.storePathHash);

			if (existing !== undefined && skippable.has(metadata.storePathHash)) {
				uploads.push({
					action: 'skip',
					storePathHash: metadata.storePathHash,
					narHash: existing.narHash
				});
				continue;
			}

			// Committed, but its NAR object is gone: reconcile the stale narinfo so a
			// re-upload at the requested hash heals it, then plan that upload.
			if (existing !== undefined && committed.has(metadata.storePathHash)) {
				await this.deletionQueue.removeStaleNarInfo(existing, origin);
			}

			uploads.push(
				this.planUpload(
					cache,
					metadata,
					reusableByNarHash.get(metadata.narHash)
				)
			);
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

		const now = new Date();

		if (pending.expiresAt < now.toISOString()) {
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
		const expiresAt = new Date(Date.now() + uploadTtlMs);

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

	// Presigns a chunk of uploads in one call by running the single-path prepare
	// per item. An item whose slot expired or turned out reusable yields a failed
	// result the client re-negotiates on its own, so one such item leaves the rest
	// of the chunk presigned.
	async prepareUploads(
		cache: string,
		items: readonly ParsedUploadPrepareItemRequest[]
	): Promise<UploadPrepareBatchResponse> {
		const results: UploadPrepareItemResult[] = [];

		for (const item of items) {
			try {
				const prepared = await this.prepareUpload(cache, item.id, {
					fileHash: item.fileHash,
					fileSize: item.fileSize,
					compression: item.compression
				});

				results.push({ ok: true, id: item.id, ...prepared });
			} catch (error) {
				results.push({
					ok: false,
					id: item.id,
					error: error instanceof Error ? error.message : String(error)
				});
			}
		}

		return { items: results };
	}
}
