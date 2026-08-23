import {
	type NixSha256HashString,
	type TenantId
} from '@cupboard/nix-store/scalars';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import {
	type ParsedUploadPathNegotiation,
	type SessionId,
	type UploadId
} from '@cupboard/protocol/upload';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';

import { promoteVerifiedBlob } from '../blob/promote-blob.ts';
import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import { narObjectKey, type R2ObjectKey } from '../http/http.ts';

import { chunk, maxInClauseValues, maxOutgoingConnections } from './bulk.ts';
import { type ServerContext } from './context.ts';
import { type CanonicalBlob } from './upload-metadata.ts';

type BlobStateRow = typeof d1Schema.blobState.$inferSelect;

export class UploadStateService {
	constructor(private readonly context: ServerContext) {}

	// Reuse visibility is tenant-scoped. Joining through `tenant_blob` exposes a
	// canonical blob only after this tenant has established its own presence edge,
	// so another tenant's identical bytes cannot become an existence oracle. The
	// chunked reads also keep large closures within D1's parameter and subrequest
	// limits.
	private async ownedBlobStates(
		tenant: TenantId,
		narHashes: readonly NixSha256HashString[]
	): Promise<Map<NixSha256HashString, BlobStateRow>> {
		const chunks = chunk(narHashes, maxInClauseValues);

		const batches = await mapWithConcurrency(
			chunks,
			maxOutgoingConnections,
			(narHashBatch) => {
				const filter = and(
					eq(d1Schema.tenantBlob.tenant, tenant),
					inArray(d1Schema.tenantBlob.narHash, narHashBatch)
				);

				const joinOn = eq(
					d1Schema.blobState.narHash,
					d1Schema.tenantBlob.narHash
				);

				return this.context.d1
					.select()
					.from(d1Schema.tenantBlob)
					.innerJoin(d1Schema.blobState, joinOn)
					.where(filter)
					.all();
			}
		);

		const rows = batches.flat().map((row) => row.blob_state);

		return new Map(rows.map((row) => [row.narHash, row]));
	}

	private async blobStatesByNarHash(
		narHashes: readonly NixSha256HashString[]
	): Promise<Map<NixSha256HashString, BlobStateRow>> {
		const batches = await mapWithConcurrency(
			chunk(narHashes, maxInClauseValues),
			maxOutgoingConnections,
			(narHashBatch) =>
				this.context.d1
					.select()
					.from(d1Schema.blobState)
					.where(inArray(d1Schema.blobState.narHash, narHashBatch))
					.all()
		);

		return new Map(batches.flat().map((row) => [row.narHash, row]));
	}

	// After negotiate returns a commit decision, the client can use the canonical
	// bytes until commit binds the new reference. Clear armed timers before
	// returning the decision so the reaper cannot remove the blob in that interval.
	async clearReaperTimers(
		narHashes: readonly NixSha256HashString[]
	): Promise<void> {
		if (narHashes.length === 0) {
			return;
		}

		await mapWithConcurrency(
			chunk(narHashes, maxInClauseValues),
			maxOutgoingConnections,
			(narHashBatch) =>
				this.context.d1
					.update(d1Schema.blobState)
					.set({ deleteAfter: sql`null` })
					.where(inArray(d1Schema.blobState.narHash, narHashBatch))
					.run()
		);
	}

	// Promotion creates the canonical object before `blob_state`; the reaper
	// removes `blob_state` before the object. The row is therefore positive
	// evidence that the object is available, so classification needs no R2 head.
	// Negotiated reconciliation repairs storage drift outside those transitions.
	async presentNarHashes(
		narHashes: readonly NixSha256HashString[]
	): Promise<Set<NixSha256HashString>> {
		const unique = [...new Set(narHashes)];

		if (unique.length === 0) {
			return new Set();
		}

		const states = await this.blobStatesByNarHash(unique);

		return new Set(states.keys());
	}

	clearPendingUpload(uploadId: UploadId): void {
		this.context.db
			.delete(schema.pendingUploads)
			.where(eq(schema.pendingUploads.id, uploadId))
			.run();
	}

	// A pending row is the durable handle for private staging bytes. Delete those
	// bytes before clearing the handle so a failed R2 operation remains retriable.
	// A canonical key belongs to the shared reaper and must never be deleted here.
	// Callers await the R2 operation outside critical sections.
	async clearPendingUploadAndStaging(
		uploadId: UploadId,
		r2Key: R2ObjectKey,
		narHash: NixSha256HashString
	): Promise<void> {
		if (r2Key !== narObjectKey(narHash)) {
			await this.context.env.BLOBS.delete(r2Key);
		}

		this.clearPendingUpload(uploadId);
	}

	// A new verification drive supersedes any existing claim lease. Clearing
	// `claimedAt` makes the row immediately eligible for the next pass.
	markUploadPending(uploadId: UploadId): void {
		this.context.db
			.update(schema.pendingUploads)
			.set({ verdict: 'pending', claimedAt: sql`null` })
			.where(eq(schema.pendingUploads.id, uploadId))
			.run();
	}

	// A reconnect replaces the session associated with this upload. Verification
	// re-reads this value and sends the verdict to the latest connection. If the
	// upload row is already gone, the update is a no-op.
	attachSession(uploadId: UploadId, sessionId: SessionId): void {
		this.context.db
			.update(schema.pendingUploads)
			.set({ sessionId })
			.where(eq(schema.pendingUploads.id, uploadId))
			.run();
	}

	// Deferred uploads have returned their entry credit, but verification can
	// exceed the socket idle interval. The idle-close pass uses this set to keep
	// their current sessions open. The verdict index limits the read to `pending`
	// and `committing` rows.
	sessionsAwaitingVerdict(): ReadonlySet<SessionId> {
		const rows = this.context.db
			.selectDistinct({ sessionId: schema.pendingUploads.sessionId })
			.from(schema.pendingUploads)
			.where(
				and(
					isNotNull(schema.pendingUploads.sessionId),
					inArray(schema.pendingUploads.verdict, ['pending', 'committing'])
				)
			)
			.all();

		return new Set(
			rows.flatMap((row) => (row.sessionId === null ? [] : [row.sessionId]))
		);
	}

	// Set this marker before reservation or promotion. After a crash, verification
	// re-drives `committing`; a null verdict still means that commit work has not
	// begun.
	markUploadCommitting(uploadId: UploadId): void {
		this.context.db
			.update(schema.pendingUploads)
			.set({ verdict: 'committing', claimedAt: sql`null` })
			.where(eq(schema.pendingUploads.id, uploadId))
			.run();
	}

	// Delete private staging bytes before recording a terminal verdict. If R2
	// fails, the pending row remains available for another drive. Canonical reuse
	// bytes remain under the shared reaper.
	async markUploadTerminal(
		uploadId: UploadId,
		r2Key: R2ObjectKey,
		narHash: NixSha256HashString,
		verdict: 'servable' | 'mismatch' | 'over-quota'
	): Promise<void> {
		if (r2Key !== narObjectKey(narHash)) {
			await this.context.env.BLOBS.delete(r2Key);
		}

		// Start a fresh observation window at the terminal transition. Verification
		// can finish after the negotiation TTL, and polling still needs time to read
		// the outcome before GC removes the row.
		const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

		this.context.db
			.update(schema.pendingUploads)
			.set({ verdict, expiresAt: isoTimestamp(expiresAt) })
			.where(eq(schema.pendingUploads.id, uploadId))
			.run();
	}

	// Preview must not change a reaper timer merely by reporting possible reuse, so
	// it reads tenant-visible canonical blobs without claiming them.
	async peekReusableBlobs(
		narHashes: readonly NixSha256HashString[]
	): Promise<Map<NixSha256HashString, BlobStateRow>> {
		const unique = [...new Set(narHashes)];

		if (unique.length === 0) {
			return new Map();
		}

		const tenant = this.context.requireTenant();

		return this.ownedBlobStates(tenant, unique);
	}

	// Negotiate can direct the client to commit against each returned canonical
	// object. Cancel any armed reaper timer before returning so the object survives
	// until commit binds the new reference. Read-only callers must use
	// {@link peekReusableBlobs}.
	async findReusableBlobs(
		narHashes: readonly NixSha256HashString[]
	): Promise<Map<NixSha256HashString, BlobStateRow>> {
		const blobStates = await this.peekReusableBlobs(narHashes);

		if (blobStates.size === 0) {
			return blobStates;
		}

		const fence = blobStates
			.values()
			.filter((state) => state.deleteAfter !== null)
			.map((state) => state.narHash)
			.toArray();

		await this.clearReaperTimers(fence);

		return blobStates;
	}

	promoteStagingBlob(
		stagingKey: R2ObjectKey,
		metadata: ParsedUploadPathNegotiation,
		blob: CanonicalBlob | undefined
	): Promise<CanonicalBlob> {
		return promoteVerifiedBlob(
			this.context.d1,
			this.context.env.BLOBS,
			stagingKey,
			{ narHash: metadata.narHash, narSize: metadata.narSize },
			blob
		);
	}
}
