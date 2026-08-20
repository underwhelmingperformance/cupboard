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

	// The `blob_state` rows for the hashes this tenant already owns a
	// `tenant_blob` presence edge for. One join per chunk keeps a closure of any
	// size to a bounded number of D1 reads, and joining on the tenant's own edge
	// keeps reuse existence-oracle-safe: a hash the tenant has not itself
	// uploaded never appears, even when another tenant holds identical bytes.
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

	// Un-arms the reaper grace timer for hashes a negotiate is about to offer
	// for reuse: reusing is a fresh reference, and the clear must land before
	// the response commits the client to the plan.
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

	// The NAR hashes among `narHashes` that still hold a `blob_state` row. A row
	// exists exactly while the canonical `nar/<narHash>.nar.zst` object does (the
	// reaper drops the row before the object), so a present hash confirms the NAR
	// without an R2 head: the skip decision turns on this pure-D1 read.
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

	// Clears an abandoned pending upload's record, deleting its private staging
	// object first so the durable handle to that object is never dropped before the
	// object itself. A reuse upload's r2Key is the shared canonical key, which must
	// survive; only a per-upload staging key is removed. It awaits R2 I/O, so it is
	// called outside any critical section.
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

	// Marking is a (re-)drive: any verify lease on the row belongs to a pass
	// that no longer speaks for it, and the pass this drive requests must not
	// wait that lease out.
	markUploadPending(uploadId: UploadId): void {
		this.context.db
			.update(schema.pendingUploads)
			.set({ verdict: 'pending', claimedAt: sql`null` })
			.where(eq(schema.pendingUploads.id, uploadId))
			.run();
	}

	// Records the commit session waiting on an upload, so the verify pass can
	// route its verdict to that connection. A no-op for a row that is gone (a bad
	// id, or one already settled and cleared).
	attachSession(uploadId: UploadId, sessionId: SessionId): void {
		this.context.db
			.update(schema.pendingUploads)
			.set({ sessionId })
			.where(eq(schema.pendingUploads.id, uploadId))
			.run();
	}

	// The commit sessions holding at least one upload that still awaits its
	// verdict. Such a session has already been answered for that upload and is
	// waiting for the verify pass, which may take longer than the idle period,
	// so it is parked rather than stale. The verdict index covers the filter, so
	// this reads the in-flight rows rather than the whole table.
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

	// Marks an inline commit in progress before it reserves the narinfo row, so a
	// crash mid-commit leaves a durable saga marker the verify pass re-drives rather
	// than a null-verdict upload indistinguishable from one still awaiting its bytes.
	markUploadCommitting(uploadId: UploadId): void {
		this.context.db
			.update(schema.pendingUploads)
			.set({ verdict: 'committing', claimedAt: sql`null` })
			.where(eq(schema.pendingUploads.id, uploadId))
			.run();
	}

	// Records a deferred upload's terminal verdict and deletes its staging bytes,
	// keeping the upload row so a later status reader (`push --wait` or a status
	// endpoint) can observe the outcome. `servable` once the background pass commits it,
	// `mismatch` for a failed NAR-hash check, `over-quota` for a quota rejection;
	// distinguished so a quota rejection is not misreported as bad content. Synchronous
	// inline outcomes return at commit and need no retained verdict.
	async markUploadTerminal(
		uploadId: UploadId,
		r2Key: R2ObjectKey,
		narHash: NixSha256HashString,
		verdict: 'servable' | 'mismatch' | 'over-quota'
	): Promise<void> {
		if (r2Key !== narObjectKey(narHash)) {
			await this.context.env.BLOBS.delete(r2Key);
		}

		// Refresh the observation window so the terminal verdict reliably outlives
		// the verify pass that recorded it (the pass may run at or past the original
		// upload TTL); GC reaps it once this window passes.
		const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

		this.context.db
			.update(schema.pendingUploads)
			.set({ verdict, expiresAt: isoTimestamp(expiresAt) })
			.where(eq(schema.pendingUploads.id, uploadId))
			.run();
	}

	// The reusable shared blobs among `narHashes`, keyed by hash, read but not
	// claimed. Pure D1: a `blob_state` row exists exactly while the canonical
	// object does, so its presence confirms reuse without an R2 head, and a
	// closure of any size costs a bounded number of D1 queries. Drift (a row
	// outliving a reaped object) is healed off the hot path by the negotiated
	// reconcile, which probes R2 and removes any narinfo whose NAR is gone.
	//
	// Existence-oracle-safe: reuse only hashes this tenant already holds its own
	// presence edge for, never the global `blob_state`. A tenant that has not
	// itself uploaded a hash is always told to upload, even when another tenant's
	// identical verified bytes exist; the promote then dedups at rest. So a
	// caller built on this never reveals whether another tenant has a blob.
	// {@link findReusableBlobs} is the claiming twin a negotiate commits to.
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

	// {@link peekReusableBlobs}'s claiming twin: the same reusable read, but
	// followed by cancelling any reaper grace timer the returned rows armed,
	// since a caller reaching this method is about to bind a fresh reference to
	// each hash it returns. Only a caller that will actually decide those paths
	// as reuse commits (negotiate) may call this; a caller that only reports
	// what it would do (preview) must use {@link peekReusableBlobs} instead, so
	// it never un-arms a timer over bytes nothing has committed to reusing.
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

	// Promotes verified staging bytes into the shared CAS; see
	// {@link promoteVerifiedBlob} for the write-once and crash-recovery
	// contract.
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
