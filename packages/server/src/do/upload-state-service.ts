import { type Logger } from '@cupboard/logger';
import {
	type NixSha256HashString,
	type TenantId
} from '@cupboard/nix-store/scalars';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import {
	type SessionId,
	type UploadId,
	uploadIdSchema,
	type UploadPathNegotiation
} from '@cupboard/protocol/upload';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';
import { and, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';

import {
	abandonWrittenBlob,
	type CanonicalIncarnation,
	commitStagedBlobPromotion,
	reserveCanonicalIncarnation,
	type StagedBlobPromotion,
	stagePromotedBlob,
	stageWrittenBlob
} from '../blob/promote-blob.ts';
import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import { narObjectKey, type R2ObjectKey } from '../http/http.ts';

import { armAlarmNoLaterThan } from './alarm.ts';
import { chunk, maxOutgoingConnections, presentNarObjects } from './bulk.ts';
import { type ServerContext } from './context.ts';
import { jsonValueLists } from './json-list.ts';
import {
	concludePromotion,
	parsePromotionRecord,
	type PromotionRecord,
	type UploadConclusion
} from './promotion-record.ts';
import { requireSubrequestsFor } from './subrequest-slice.ts';
import { type CanonicalBlob } from './upload-metadata.ts';
import { WorkSequenceService } from './work-sequence-service.ts';

type BlobStateRow = typeof d1Schema.blobState.$inferSelect;

// Negotiation offers a reuse commit from D1 rows, which cannot show that the
// canonical object is gone. A key under this prefix records a NAR hash whose
// object a reuse commit found missing, so that negotiation plans an upload for
// it instead. The value is the time until which the record applies. After an
// hour, negotiation offers reuse again, and a commit that finds the object
// still missing records the hash again.
const missingCanonicalNarPrefix = 'uploads:missing-canonical-nar:';
const pendingNarRefreshPrefix = 'uploads:pending-nar-refresh:';
const pendingNarRefreshMigrationCursorKey =
	'uploads:pending-nar-refresh-migration-cursor';
const missingCanonicalNarTtlMs = 60 * 60 * 1000;
// Durable Object storage reads at most this many keys in one call.
const maxStorageKeysPerGet = 128;

function missingCanonicalNarKey(narHash: NixSha256HashString): string {
	return `${missingCanonicalNarPrefix}${narHash}`;
}

export class UploadStateService {
	constructor(private readonly context: ServerContext) {}

	private setPendingNarRefresh(uploadId: UploadId): boolean {
		const rows = this.context.db
			.update(schema.pendingUploads)
			.set({ narRefreshPending: true })
			.where(eq(schema.pendingUploads.id, uploadId))
			.returning({ id: schema.pendingUploads.id })
			.all();
		return rows.length === 1;
	}

	// Reuse visibility is tenant-scoped. Joining through `tenant_blob` exposes a
	// canonical blob only after this tenant has established its own presence edge,
	// so another tenant's identical bytes cannot become an existence oracle.
	private async ownedBlobStates(
		tenant: TenantId,
		narHashes: readonly NixSha256HashString[]
	): Promise<Map<NixSha256HashString, BlobStateRow>> {
		const batches = await mapWithConcurrency(
			jsonValueLists(narHashes),
			maxOutgoingConnections,
			(list) => {
				const filter = and(
					eq(d1Schema.tenantBlob.tenant, tenant),
					inArray(d1Schema.tenantBlob.narHash, list)
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
			jsonValueLists(narHashes),
			maxOutgoingConnections,
			(list) =>
				this.context.d1
					.select()
					.from(d1Schema.blobState)
					.where(inArray(d1Schema.blobState.narHash, list))
					.all()
		);

		return new Map(batches.flat().map((row) => [row.narHash, row]));
	}

	// Negotiation deletes an expired record only for a NAR hash that it
	// considers again. Each new record therefore also deletes up to one page of
	// expired records, so records for NARs that are never negotiated again do not
	// stay in storage.
	private async deleteExpiredMissingRecords(now: number): Promise<void> {
		const records = await this.context.ctx.storage.list({
			prefix: missingCanonicalNarPrefix,
			limit: maxStorageKeysPerGet
		});
		const expired = records
			.entries()
			.filter(([, until]) => {
				const parsed = z.number().safeParse(until);

				return !parsed.success || parsed.data <= now;
			})
			.map(([key]) => key)
			.toArray();

		if (expired.length > 0) {
			await this.context.ctx.storage.delete(expired);
		}
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
			jsonValueLists(narHashes),
			maxOutgoingConnections,
			(list) =>
				this.context.d1
					.update(d1Schema.blobState)
					.set({ deleteAfter: sql`null` })
					.where(inArray(d1Schema.blobState.narHash, list))
					.run()
		);
	}

	/**
	 * Records that the canonical object of a live blob is missing, so that
	 * negotiation plans an upload for the NAR instead of a reuse commit.
	 */
	async markCanonicalNarMissing(narHash: NixSha256HashString): Promise<void> {
		const now = Date.now();

		await this.context.ctx.storage.put(
			missingCanonicalNarKey(narHash),
			now + missingCanonicalNarTtlMs
		);
		await this.deleteExpiredMissingRecords(now);
	}

	/**
	 * Removes the record for a NAR hash once an upload has promoted its bytes to
	 * a live object.
	 */
	async clearCanonicalNarMissing(narHash: NixSha256HashString): Promise<void> {
		await this.context.ctx.storage.delete(missingCanonicalNarKey(narHash));
	}

	async markPendingNarRefresh(uploadId: UploadId): Promise<void> {
		if (!this.setPendingNarRefresh(uploadId)) {
			return;
		}
		// Older builds read this key after canonical activation.
		await this.context.ctx.storage.put(
			`${pendingNarRefreshPrefix}${uploadId}`,
			true
		);
	}

	hasPendingNarRefresh(uploadId: UploadId): boolean {
		return (
			this.context.db
				.select({ pending: schema.pendingUploads.narRefreshPending })
				.from(schema.pendingUploads)
				.where(eq(schema.pendingUploads.id, uploadId))
				.get()?.pending ?? false
		);
	}

	clearPendingNarRefresh(uploadId: UploadId): void {
		this.context.db
			.update(schema.pendingUploads)
			.set({ narRefreshPending: false })
			.where(eq(schema.pendingUploads.id, uploadId))
			.run();
	}

	async clearDeliveredNarRefresh(uploadId: UploadId): Promise<void> {
		await this.context.ctx.storage.delete(
			`${pendingNarRefreshPrefix}${uploadId}`
		);
		this.clearPendingNarRefresh(uploadId);
	}

	async migratePendingNarRefreshMarkers(uploadId?: UploadId): Promise<void> {
		const key = `${pendingNarRefreshPrefix}${uploadId ?? ''}`;
		const cursor =
			uploadId === undefined
				? await this.context.ctx.storage.get<string>(
						pendingNarRefreshMigrationCursorKey
					)
				: undefined;
		const records =
			uploadId === undefined
				? await this.context.ctx.storage.list({
						prefix: pendingNarRefreshPrefix,
						limit: maxStorageKeysPerGet,
						...(cursor !== undefined && { startAfter: cursor })
					})
				: await this.context.ctx.storage.get([key]);
		const obsolete: string[] = [];
		for (const [key, pending] of records) {
			const parsedUploadId = uploadIdSchema.safeParse(
				key.slice(pendingNarRefreshPrefix.length)
			);
			if (
				pending === true &&
				parsedUploadId.success &&
				this.setPendingNarRefresh(parsedUploadId.data)
			) {
				continue;
			}
			obsolete.push(key);
		}
		if (obsolete.length > 0) {
			await this.context.ctx.storage.delete(obsolete);
		}
		if (uploadId !== undefined) {
			return;
		}
		const last = records.keys().toArray().at(-1);
		if (last !== undefined && records.size === maxStorageKeysPerGet) {
			await this.context.ctx.storage.put(
				pendingNarRefreshMigrationCursorKey,
				last
			);
			await armAlarmNoLaterThan(this.context.ctx.storage, Date.now());
			return;
		}
		await this.context.ctx.storage.delete(pendingNarRefreshMigrationCursorKey);
	}

	/**
	 * The reusable blobs, without those whose canonical object a reuse commit
	 * recently found missing. Expired records are deleted.
	 */
	async withoutMissingCanonicalNars<T>(
		reusable: ReadonlyMap<NixSha256HashString, T>
	): Promise<ReadonlyMap<NixSha256HashString, T>> {
		const now = Date.now();
		const missing = new Set<NixSha256HashString>();
		const expired: string[] = [];

		for (const narHashes of chunk(
			reusable.keys().toArray(),
			maxStorageKeysPerGet
		)) {
			const records = await this.context.ctx.storage.get(
				narHashes.map((narHash) => missingCanonicalNarKey(narHash))
			);

			for (const narHash of narHashes) {
				const until = z
					.number()
					.safeParse(records.get(missingCanonicalNarKey(narHash)));

				if (!until.success) {
					continue;
				}

				if (until.data > now) {
					missing.add(narHash);
				} else {
					expired.push(missingCanonicalNarKey(narHash));
				}
			}
		}

		if (expired.length > 0) {
			await this.context.ctx.storage.delete(expired);
		}

		if (missing.size === 0) {
			return reusable;
		}

		return new Map(
			reusable.entries().filter(([narHash]) => !missing.has(narHash))
		);
	}

	// Promotion writes the canonical object before `blob_state` and the reaper
	// deletes `blob_state` before the object, so a row means the object was
	// created and has not yet been deliberately removed. It does not mean the
	// object is present: the reaper's `demoteMissingBlobs` pass finds rows whose
	// object has gone. A caller that answers `skip` from this set must also check
	// the canonical object in R2.
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

	async presentCanonicalNars(
		narHashes: readonly NixSha256HashString[]
	): Promise<ReadonlySet<NixSha256HashString>> {
		const unique = [...new Set(narHashes)];

		if (unique.length === 0) {
			return new Set();
		}

		requireSubrequestsFor(
			unique.length + jsonValueLists(unique).length,
			'upload negotiation'
		);
		const states = await this.blobStatesByNarHash(unique);

		return presentNarObjects(this.context.env.BLOBS, states.values().toArray());
	}

	/**
	 * Removes the upload row while `owner` owns its claim, or while nobody does
	 * when `owner` is absent. When the row was still in verification, this
	 * concludes the upload's promotion with `conclusion`.
	 */
	async clearPendingUpload(
		uploadId: UploadId,
		conclusion: UploadConclusion,
		owner?: string
	): Promise<boolean> {
		const [deleted] = this.context.db
			.delete(schema.pendingUploads)
			.where(
				and(
					eq(schema.pendingUploads.id, uploadId),
					owner === undefined
						? isNull(schema.pendingUploads.claimOwner)
						: eq(schema.pendingUploads.claimOwner, owner)
				)
			)
			.returning()
			.all();

		if (deleted === undefined) {
			return false;
		}

		// A terminal row concluded its promotion when it became terminal.
		if (deleted.verdict === 'pending' || deleted.verdict === 'committing') {
			await concludePromotion(this.context.d1, deleted, conclusion);
		}

		return true;
	}

	/**
	 * Replaces the upload's promotion record while `owner` owns its claim.
	 * Returns whether the record was replaced.
	 */
	recordPromotion(
		uploadId: UploadId,
		owner: string,
		update: (current: PromotionRecord | undefined) => PromotionRecord
	): boolean {
		const owned = and(
			eq(schema.pendingUploads.id, uploadId),
			eq(schema.pendingUploads.claimOwner, owner)
		);
		const row = this.context.db
			.select({ promotionJson: schema.pendingUploads.promotionJson })
			.from(schema.pendingUploads)
			.where(owned)
			.get();

		if (row === undefined) {
			return false;
		}

		const next = update(parsePromotionRecord(row.promotionJson));
		this.context.db
			.update(schema.pendingUploads)
			.set({ promotionJson: JSON.stringify(next) })
			.where(owned)
			.run();

		return true;
	}

	// Remove an abandoned upload row only while the caller owns its claim, then
	// delete its private staging object. The orphan collector retries a failed R2
	// deletion. Reuse uploads refer to a shared canonical object, which this method
	// must not delete.
	async clearPendingUploadAndStaging(
		uploadId: UploadId,
		r2Key: R2ObjectKey,
		narHash: NixSha256HashString,
		conclusion: UploadConclusion,
		owner?: string
	): Promise<boolean> {
		if (!(await this.clearPendingUpload(uploadId, conclusion, owner))) {
			return false;
		}

		await this.context.ctx.storage.delete(
			`${pendingNarRefreshPrefix}${uploadId}`
		);

		if (r2Key !== narObjectKey(narHash)) {
			await this.context.env.BLOBS.delete(r2Key);
		}

		return true;
	}

	// A new verification drive supersedes the claim lease. The retry deadline
	// and failure budget remain unchanged.
	markUploadPending(uploadId: UploadId): void {
		this.context.db
			.update(schema.pendingUploads)
			.set({
				verdict: 'pending',
				claimedAt: sql`null`,
				claimOwner: sql`null`
			})
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
		const liveVerdict = or(
			eq(schema.pendingUploads.verdict, 'pending'),
			eq(schema.pendingUploads.verdict, 'committing')
		);
		const rows = this.context.db
			.selectDistinct({ sessionId: schema.pendingUploads.sessionId })
			.from(schema.pendingUploads)
			.where(and(isNotNull(schema.pendingUploads.sessionId), liveVerdict))
			.all();

		return new Set(
			rows.flatMap((row) => (row.sessionId === null ? [] : [row.sessionId]))
		);
	}

	// Set this marker before reservation or promotion. After a crash, verification
	// re-drives `committing`; a null verdict still means that commit work has not
	// begun.
	markUploadCommitting(uploadId: UploadId): void {
		this.context.db.transaction((tx) => {
			tx.update(schema.pendingUploads)
				.set({
					verdict: 'committing',
					commitStartedSequence: sql`coalesce(${schema.pendingUploads.commitStartedSequence}, ${new WorkSequenceService(tx).allocate()})`,
					committedAt: sql`coalesce(${schema.pendingUploads.committedAt}, ${isoTimestamp(new Date())})`,
					claimedAt: sql`null`,
					claimOwner: sql`null`
				})
				.where(eq(schema.pendingUploads.id, uploadId))
				.run();
		});
	}

	// Keep a deferred upload's terminal verdict so `push --wait` and the status
	// endpoint can report it. The distinct mismatch and over-quota values prevent
	// a quota refusal from being reported as invalid content.
	async markUploadTerminal(
		uploadId: UploadId,
		verdict: 'servable' | 'mismatch' | 'over-quota',
		logger: Logger,
		owner?: string
	): Promise<boolean> {
		// Start a new observation window because verification can finish after the
		// upload's original expiry. GC removes the row after this window.
		const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
		const awaitingFilter = or(
			eq(schema.pendingUploads.verdict, 'pending'),
			eq(schema.pendingUploads.verdict, 'committing')
		);
		const ownerFilter =
			owner === undefined
				? isNull(schema.pendingUploads.claimOwner)
				: eq(schema.pendingUploads.claimOwner, owner);

		const updated = this.context.db
			.update(schema.pendingUploads)
			.set({
				verdict,
				acceptedExpiresAt: sql`coalesce(${schema.pendingUploads.acceptedExpiresAt}, ${schema.pendingUploads.expiresAt})`,
				expiresAt: isoTimestamp(expiresAt)
			})
			.where(
				and(eq(schema.pendingUploads.id, uploadId), awaitingFilter, ownerFilter)
			)
			.returning()
			.all();
		const [settled] = updated;

		if (settled === undefined) {
			return false;
		}

		await concludePromotion(this.context.d1, settled, {
			logger,
			outcome: verdict
		});

		return true;
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

	// Write verified bytes to a physical R2 object. The caller commits the returned
	// promotion only while it still owns the upload claim.
	stageStagingBlob(
		stagingKey: R2ObjectKey,
		metadata: UploadPathNegotiation,
		blob: CanonicalBlob | undefined,
		reservationOwner: string,
		isStillOwned: () => boolean
	): Promise<StagedBlobPromotion | undefined> {
		return stagePromotedBlob(
			this.context.d1,
			this.context.env.BLOBS,
			stagingKey,
			{ narHash: metadata.narHash, narSize: metadata.narSize },
			blob,
			reservationOwner,
			isStillOwned
		);
	}

	reserveCanonicalWrite(
		narHash: NixSha256HashString,
		reservationOwner: string
	): Promise<CanonicalIncarnation> {
		return reserveCanonicalIncarnation(
			this.context.d1,
			narHash,
			reservationOwner
		);
	}

	// Prepare the promotion of an object that verification wrote at a reserved
	// incarnation. The caller commits it only while it still owns the claim.
	stageWrittenBlob(
		metadata: UploadPathNegotiation,
		incarnation: number,
		reservationOwner: string,
		isStillOwned: () => boolean
	): Promise<StagedBlobPromotion | undefined> {
		return stageWrittenBlob(
			this.context.d1,
			this.context.env.BLOBS,
			{ narHash: metadata.narHash, narSize: metadata.narSize },
			incarnation,
			reservationOwner,
			isStillOwned
		);
	}

	abandonWrittenBlob(
		narHash: NixSha256HashString,
		incarnation: number,
		reservationOwner: string
	): Promise<void> {
		return abandonWrittenBlob(
			this.context.d1,
			narHash,
			incarnation,
			reservationOwner
		);
	}

	commitStagingBlob(
		staged: StagedBlobPromotion,
		isStillOwned: () => boolean = () => true
	): Promise<'live' | 'retired'> {
		return commitStagedBlobPromotion(this.context.d1, staged, isStillOwned);
	}
}
