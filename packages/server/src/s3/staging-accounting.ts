import type { StoredCache, TenantId } from '@cupboard/nix-store/scalars';
import { type IsoTimestamp, isoTimestamp } from '@cupboard/protocol/scalars';
import { type UploadId, uploadIdSchema } from '@cupboard/protocol/upload';
import {
	InvalidPartError,
	MultipartUploadAlreadyCompletingError,
	NoSuchUploadError,
	StagedObjectBeingDeletedError
} from '@cupboard/s3/errors';
import type { UploadedPart } from '@cupboard/s3/ports';
import {
	and,
	asc,
	eq,
	gt,
	inArray,
	isNull,
	lte,
	or,
	type SQL,
	sql
} from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';

import * as d1Schema from '../db/d1-schema.ts';
import { QuotaExceededError } from '../errors.ts';

import type { BlobStore } from './blob-store.ts';

export const maxExpiredS3ObjectsPerRun = 100;
export const multipartCompletionLeaseMs = 5 * 60 * 1000;
const maxStagedReleaseKeysPerBatch = 90;
export interface S3StagingCleanupOutcome {
	readonly multipartReleased: number;
	readonly stagedReleased: number;
	readonly failures: readonly unknown[];
}

export interface MultipartPartReservation {
	readonly r2Key: string;
	readonly uploadId: UploadId;
	readonly partNumber: number;
	readonly size: number;
	readonly token: string;
}

export interface MultipartCompletionPreparation {
	readonly kind: 'started' | 'recovering';
	readonly size: number;
	readonly token: string;
}

export class MultipartUploadNotTrackedError extends NoSuchUploadError {
	constructor() {
		super();
		this.name = new.target.name;
	}
}

export class MultipartPartNotTrackedError extends InvalidPartError {
	constructor() {
		super();
		this.name = new.target.name;
	}
}

export class MultipartPartReservationSupersededError extends Error {
	constructor(partNumber: number) {
		super(`Multipart part ${String(partNumber)} was replaced concurrently.`);
		this.name = new.target.name;
	}
}

export class S3StagingAccounting {
	constructor(
		private readonly d1: DrizzleD1Database<typeof d1Schema>,
		private readonly tenant: TenantId,
		private readonly now: () => Date,
		private readonly newToken: () => string
	) {}

	private async usage(): Promise<
		typeof d1Schema.tenantUsage.$inferSelect | undefined
	> {
		return this.d1
			.select()
			.from(d1Schema.tenantUsage)
			.where(eq(d1Schema.tenantUsage.tenant, this.tenant))
			.get();
	}

	private totalCharged(
		usage: typeof d1Schema.tenantUsage.$inferSelect
	): number {
		return (
			usage.bytes + usage.casBytes + usage.stagedBytes + usage.multipartBytes
		);
	}

	private async throwQuotaOrCause(
		additionalBytes: number,
		cause: unknown
	): Promise<never> {
		const usage = await this.usage();
		if (
			usage?.quotaBytes !== null &&
			usage?.quotaBytes !== undefined &&
			this.totalCharged(usage) + additionalBytes > usage.quotaBytes
		) {
			throw new QuotaExceededError(this.tenant);
		}

		throw cause;
	}

	private uploadScope(r2Key: string, uploadId: UploadId) {
		return and(
			eq(d1Schema.s3MultipartUpload.tenant, this.tenant),
			eq(d1Schema.s3MultipartUpload.uploadId, uploadId),
			eq(d1Schema.s3MultipartUpload.r2Key, r2Key)
		);
	}

	private async multipartCompletionSize(
		uploadId: UploadId,
		parts: readonly UploadedPart[]
	): Promise<number> {
		const storedParts = await this.d1
			.select()
			.from(d1Schema.s3MultipartPart)
			.where(
				and(
					eq(d1Schema.s3MultipartPart.tenant, this.tenant),
					eq(d1Schema.s3MultipartPart.uploadId, uploadId)
				)
			);
		const partByNumber = new Map(
			storedParts.map((part) => [part.partNumber, part])
		);
		let completedSize = 0;

		for (const part of parts) {
			const stored = partByNumber.get(part.partNumber);
			if (stored?.etag !== part.etag) {
				throw new MultipartPartNotTrackedError();
			}
			completedSize += stored.size;
		}

		return completedSize;
	}

	private async cleanupRows(
		blobStore: BlobStore,
		multipart: readonly (typeof d1Schema.s3MultipartUpload.$inferSelect)[],
		staged: readonly (typeof d1Schema.s3StagedObject.$inferSelect)[],
		stagedEligibility: (
			object: typeof d1Schema.s3StagedObject.$inferSelect
		) => SQL | undefined
	): Promise<S3StagingCleanupOutcome> {
		const failures: unknown[] = [];
		let multipartReleased = 0;
		let stagedReleased = 0;

		for (const upload of multipart) {
			try {
				const canAbort = await this.markMultipartAborting(
					upload.r2Key,
					upload.uploadId
				);
				if (!canAbort) {
					continue;
				}
				try {
					await blobStore.abortMultipartUpload(upload.r2Key, upload.uploadId);
				} catch (error) {
					if (!(error instanceof NoSuchUploadError)) {
						throw error;
					}
				}

				const completed = await blobStore.head(upload.r2Key);
				const completedClaim =
					completed === undefined
						? undefined
						: await this.claimUnchargedCompletedObject(upload);
				if (completedClaim !== undefined) {
					await blobStore.delete(upload.r2Key);
					await this.releaseClaimedStagedObject(completedClaim);
				}
				await this.releaseMultipart(upload.r2Key, upload.uploadId);
				multipartReleased += 1;
			} catch (error) {
				failures.push(error);
			}
		}

		for (const object of staged) {
			try {
				const isClaimed = await this.claimStagedObject(
					object,
					stagedEligibility(object)
				);
				if (!isClaimed) {
					continue;
				}

				await blobStore.delete(object.r2Key);
				if (await this.releaseClaimedStagedObject(object)) {
					stagedReleased += 1;
				}
			} catch (error) {
				failures.push(error);
			}
		}

		return { multipartReleased, stagedReleased, failures };
	}

	private async claimUnchargedCompletedObject(
		upload: typeof d1Schema.s3MultipartUpload.$inferSelect
	): Promise<typeof d1Schema.s3StagedObject.$inferSelect | undefined> {
		const [claimed] = await this.d1
			.insert(d1Schema.s3StagedObject)
			.values({
				tenant: this.tenant,
				cache: upload.cache,
				r2Key: upload.r2Key,
				size: 0,
				expiresAt: upload.expiresAt,
				deleting: true
			})
			.onConflictDoNothing()
			.returning();

		return claimed;
	}

	private async claimStagedObject(
		object: typeof d1Schema.s3StagedObject.$inferSelect,
		eligibility: SQL | undefined
	): Promise<boolean> {
		// A previous pass can delete the R2 object and then fail to release the D1
		// row. Cleanup selects claimed rows again so it can finish that release.
		// The conditional release is idempotent when two retrying passes overlap.
		if (object.deleting) {
			return true;
		}
		const nowIso = isoTimestamp(this.now());
		const noActiveCompletion = sql`not exists (
			select 1 from ${d1Schema.s3MultipartUpload}
			where ${d1Schema.s3MultipartUpload.tenant} = ${this.tenant}
				and ${d1Schema.s3MultipartUpload.r2Key} = ${object.r2Key}
				and ${inArray(d1Schema.s3MultipartUpload.state, ['completing', 'recovering'])}
				and ${gt(d1Schema.s3MultipartUpload.completionLeaseExpiresAt, nowIso)}
		)`;

		const claimed = await this.d1
			.update(d1Schema.s3StagedObject)
			.set({ deleting: true })
			.where(
				and(
					eq(d1Schema.s3StagedObject.tenant, this.tenant),
					eq(d1Schema.s3StagedObject.r2Key, object.r2Key),
					eq(d1Schema.s3StagedObject.deleting, false),
					eligibility,
					noActiveCompletion
				)
			)
			.returning({ r2Key: d1Schema.s3StagedObject.r2Key });

		return claimed.length > 0;
	}

	private async releaseClaimedStagedObject(
		object: typeof d1Schema.s3StagedObject.$inferSelect
	): Promise<boolean> {
		const scope = and(
			eq(d1Schema.s3StagedObject.tenant, this.tenant),
			eq(d1Schema.s3StagedObject.r2Key, object.r2Key),
			eq(d1Schema.s3StagedObject.deleting, true)
		);
		const updatedAt = isoTimestamp(this.now());

		const [, deleted] = await this.d1.batch([
			this.d1
				.update(d1Schema.tenantUsage)
				.set({
					stagedBytes: sql`${d1Schema.tenantUsage.stagedBytes} - coalesce((select ${d1Schema.s3StagedObject.size} from ${d1Schema.s3StagedObject} where ${scope}), 0)`,
					updatedAt
				})
				.where(eq(d1Schema.tenantUsage.tenant, this.tenant)),
			this.d1
				.delete(d1Schema.s3StagedObject)
				.where(scope)
				.returning({ r2Key: d1Schema.s3StagedObject.r2Key })
		]);

		return deleted.length > 0;
	}

	async reserveStagedObject(
		cache: StoredCache,
		r2Key: string,
		size: number,
		expiresAt: IsoTimestamp
	): Promise<void> {
		const scope = and(
			eq(d1Schema.s3StagedObject.tenant, this.tenant),
			eq(d1Schema.s3StagedObject.r2Key, r2Key)
		);
		const existing = await this.d1
			.select({
				size: d1Schema.s3StagedObject.size,
				deleting: d1Schema.s3StagedObject.deleting
			})
			.from(d1Schema.s3StagedObject)
			.where(scope)
			.get();
		if (existing?.deleting === true) {
			throw new Error('The staged object is being deleted.');
		}
		const additionalBytes = Math.max(0, size - (existing?.size ?? 0));
		const updatedAt = isoTimestamp(this.now());
		const reservationAvailableCondition = sql`not exists (select 1 from ${d1Schema.s3StagedObject} where ${scope} and ${d1Schema.s3StagedObject.deleting} = true)`;
		const tenantUsageScope = eq(d1Schema.tenantUsage.tenant, this.tenant);

		try {
			await this.d1.batch([
				this.d1
					.update(d1Schema.tenantUsage)
					.set({
						stagedBytes: sql`${d1Schema.tenantUsage.stagedBytes} + max(0, ${size} - coalesce((select ${d1Schema.s3StagedObject.size} from ${d1Schema.s3StagedObject} where ${scope}), 0))`,
						updatedAt
					})
					.where(and(tenantUsageScope, reservationAvailableCondition)),
				this.d1
					.insert(d1Schema.s3StagedObject)
					.select((qb) =>
						qb
							.select({
								tenant: d1Schema.tenantUsage.tenant,
								r2Key: sql<string>`${r2Key}`.as('r2_key'),
								cache: sql<StoredCache>`${cache}`.as('cache'),
								size: sql<number>`${size}`.as('size'),
								expiresAt: sql<IsoTimestamp>`${expiresAt}`.as('expires_at'),
								deleting: sql<boolean>`false`.as('deleting')
							})
							.from(d1Schema.tenantUsage)
							.where(and(tenantUsageScope, reservationAvailableCondition))
					)
					.onConflictDoUpdate({
						target: [
							d1Schema.s3StagedObject.tenant,
							d1Schema.s3StagedObject.r2Key
						],
						set: {
							cache,
							size: sql`max(${d1Schema.s3StagedObject.size}, ${size})`,
							expiresAt
						},
						setWhere: eq(d1Schema.s3StagedObject.deleting, false)
					})
			]);
		} catch (error) {
			await this.throwQuotaOrCause(additionalBytes, error);
		}

		const reserved = await this.d1
			.select({
				r2Key: d1Schema.s3StagedObject.r2Key,
				deleting: d1Schema.s3StagedObject.deleting
			})
			.from(d1Schema.s3StagedObject)
			.where(scope)
			.get();
		if (reserved === undefined) {
			throw new Error('Tenant usage is not available for S3 staging.');
		}
		if (reserved.deleting) {
			throw new Error('The staged object is being deleted.');
		}
	}

	async protectStagedObject(
		r2Key: string,
		expiresAt: IsoTimestamp
	): Promise<boolean> {
		const protectedRows = await this.d1
			.update(d1Schema.s3StagedObject)
			.set({
				expiresAt: sql`max(${d1Schema.s3StagedObject.expiresAt}, ${expiresAt})`
			})
			.where(
				and(
					eq(d1Schema.s3StagedObject.tenant, this.tenant),
					eq(d1Schema.s3StagedObject.r2Key, r2Key),
					eq(d1Schema.s3StagedObject.deleting, false)
				)
			)
			.returning({ r2Key: d1Schema.s3StagedObject.r2Key });

		return protectedRows.length > 0;
	}

	async settleStagedObject(
		r2Key: string,
		size: number,
		expiresAt: IsoTimestamp
	): Promise<void> {
		const scope = and(
			eq(d1Schema.s3StagedObject.tenant, this.tenant),
			eq(d1Schema.s3StagedObject.r2Key, r2Key)
		);
		const settleScope = and(scope, eq(d1Schema.s3StagedObject.deleting, false));
		const tenantUsageScope = eq(d1Schema.tenantUsage.tenant, this.tenant);
		const settleRowCondition = sql`exists (select 1 from ${d1Schema.s3StagedObject} where ${settleScope})`;
		const updatedAt = isoTimestamp(this.now());

		const [, settled] = await this.d1.batch([
			this.d1
				.update(d1Schema.tenantUsage)
				.set({
					stagedBytes: sql`${d1Schema.tenantUsage.stagedBytes} + ${size} - coalesce((select ${d1Schema.s3StagedObject.size} from ${d1Schema.s3StagedObject} where ${settleScope}), ${size})`,
					updatedAt
				})
				.where(and(tenantUsageScope, settleRowCondition)),
			this.d1
				.update(d1Schema.s3StagedObject)
				.set({ size, expiresAt })
				.where(settleScope)
				.returning({ r2Key: d1Schema.s3StagedObject.r2Key })
		]);

		if (settled.length === 0) {
			throw new Error('The staged object is being deleted.');
		}
	}

	async releaseStagedObject(r2Key: string): Promise<void> {
		await this.releaseStagedObjects([r2Key]);
	}

	async releaseStagedObjects(r2Keys: readonly string[]): Promise<void> {
		const unique = [...new Set(r2Keys)];

		for (
			let offset = 0;
			offset < unique.length;
			offset += maxStagedReleaseKeysPerBatch
		) {
			const keys = unique.slice(offset, offset + maxStagedReleaseKeysPerBatch);
			const scope = and(
				eq(d1Schema.s3StagedObject.tenant, this.tenant),
				inArray(d1Schema.s3StagedObject.r2Key, keys)
			);
			const updatedAt = isoTimestamp(this.now());

			await this.d1.batch([
				this.d1
					.update(d1Schema.tenantUsage)
					.set({
						stagedBytes: sql`${d1Schema.tenantUsage.stagedBytes} - coalesce((select sum(${d1Schema.s3StagedObject.size}) from ${d1Schema.s3StagedObject} where ${scope}), 0)`,
						updatedAt
					})
					.where(eq(d1Schema.tenantUsage.tenant, this.tenant)),
				this.d1.delete(d1Schema.s3StagedObject).where(scope)
			]);
		}
	}

	async beginMultipart(
		cache: StoredCache,
		r2Key: string,
		uploadIdValue: string,
		expiresAt: IsoTimestamp
	): Promise<void> {
		const uploadId = uploadIdSchema.parse(uploadIdValue);
		const inserted = await this.d1
			.insert(d1Schema.s3MultipartUpload)
			.select((qb) =>
				qb
					.select({
						tenant: d1Schema.tenantUsage.tenant,
						uploadId: sql<UploadId>`${uploadId}`.as('upload_id'),
						cache: sql<StoredCache>`${cache}`.as('cache'),
						r2Key: sql<string>`${r2Key}`.as('r2_key'),
						state: sql<'open'>`'open'`.as('state'),
						completionToken: sql<string | null>`null`.as('completion_token'),
						completionLeaseExpiresAt: sql<IsoTimestamp | null>`null`.as(
							'completion_lease_expires_at'
						),
						createdAt: sql<IsoTimestamp>`${isoTimestamp(this.now())}`.as(
							'created_at'
						),
						expiresAt: sql<IsoTimestamp>`${expiresAt}`.as('expires_at')
					})
					.from(d1Schema.tenantUsage)
					.where(eq(d1Schema.tenantUsage.tenant, this.tenant))
			)
			.returning({ uploadId: d1Schema.s3MultipartUpload.uploadId });
		if (inserted.length === 0) {
			throw new Error('Tenant usage is not available for multipart staging.');
		}
	}

	async reserveMultipartPart(
		r2Key: string,
		uploadIdValue: string,
		partNumber: number,
		size: number
	): Promise<MultipartPartReservation> {
		const uploadId = uploadIdSchema.parse(uploadIdValue);
		const uploadScope = this.uploadScope(r2Key, uploadId);
		const openUpload = and(
			uploadScope,
			eq(d1Schema.s3MultipartUpload.state, 'open')
		);
		const openUploadExists = sql`exists (select 1 from ${d1Schema.s3MultipartUpload} where ${openUpload})`;
		const upload = await this.d1
			.select({ state: d1Schema.s3MultipartUpload.state })
			.from(d1Schema.s3MultipartUpload)
			.where(uploadScope)
			.get();
		if (upload?.state !== 'open') {
			throw new MultipartUploadNotTrackedError();
		}

		const partScope = and(
			eq(d1Schema.s3MultipartPart.tenant, this.tenant),
			eq(d1Schema.s3MultipartPart.uploadId, uploadId),
			eq(d1Schema.s3MultipartPart.partNumber, partNumber)
		);
		const previous = await this.d1
			.select({ reservedSize: d1Schema.s3MultipartPart.reservedSize })
			.from(d1Schema.s3MultipartPart)
			.where(partScope)
			.get();
		const additionalBytes = Math.max(0, size - (previous?.reservedSize ?? 0));
		const token = this.newToken();
		const updatedAt = isoTimestamp(this.now());
		const usageScope = and(
			eq(d1Schema.tenantUsage.tenant, this.tenant),
			openUploadExists
		);

		try {
			await this.d1.batch([
				this.d1
					.update(d1Schema.tenantUsage)
					.set({
						multipartBytes: sql`${d1Schema.tenantUsage.multipartBytes} + max(0, ${size} - coalesce((select ${d1Schema.s3MultipartPart.reservedSize} from ${d1Schema.s3MultipartPart} where ${partScope}), 0))`,
						updatedAt
					})
					.where(usageScope),
				this.d1
					.insert(d1Schema.s3MultipartPart)
					.select((qb) =>
						qb
							.select({
								tenant: d1Schema.s3MultipartUpload.tenant,
								uploadId: d1Schema.s3MultipartUpload.uploadId,
								partNumber: sql<number>`${partNumber}`.as('part_number'),
								size: sql<number>`0`.as('size'),
								reservedSize: sql<number>`${size}`.as('reserved_size'),
								etag: sql<string | null>`null`.as('etag'),
								reservationToken: sql<string>`${token}`.as('reservation_token')
							})
							.from(d1Schema.s3MultipartUpload)
							.innerJoin(
								d1Schema.tenantUsage,
								eq(
									d1Schema.tenantUsage.tenant,
									d1Schema.s3MultipartUpload.tenant
								)
							)
							.where(openUpload)
					)
					.onConflictDoUpdate({
						target: [
							d1Schema.s3MultipartPart.tenant,
							d1Schema.s3MultipartPart.uploadId,
							d1Schema.s3MultipartPart.partNumber
						],
						set: {
							reservedSize: sql`max(${d1Schema.s3MultipartPart.reservedSize}, ${size})`,
							reservationToken: token
						}
					})
			]);
		} catch (error) {
			await this.throwQuotaOrCause(additionalBytes, error);
		}

		const current = await this.d1
			.select({ token: d1Schema.s3MultipartPart.reservationToken })
			.from(d1Schema.s3MultipartPart)
			.where(partScope)
			.get();
		if (current?.token !== token) {
			throw new MultipartUploadNotTrackedError();
		}

		return { r2Key, uploadId, partNumber, size, token };
	}

	async recordMultipartPart(
		reservation: MultipartPartReservation,
		part: UploadedPart
	): Promise<void> {
		const scope = and(
			eq(d1Schema.s3MultipartPart.tenant, this.tenant),
			eq(d1Schema.s3MultipartPart.uploadId, reservation.uploadId),
			eq(d1Schema.s3MultipartPart.partNumber, reservation.partNumber),
			eq(d1Schema.s3MultipartPart.reservationToken, reservation.token)
		);
		const openUpload = and(
			this.uploadScope(reservation.r2Key, reservation.uploadId),
			eq(d1Schema.s3MultipartUpload.state, 'open')
		);
		const openUploadExists = sql`exists (select 1 from ${d1Schema.s3MultipartUpload} where ${openUpload})`;
		const updatedAt = isoTimestamp(this.now());
		const usageFilter = and(
			eq(d1Schema.tenantUsage.tenant, this.tenant),
			sql`exists (select 1 from ${d1Schema.s3MultipartPart} where ${scope})`,
			openUploadExists
		);

		const [, recorded] = await this.d1.batch([
			this.d1
				.update(d1Schema.tenantUsage)
				.set({
					multipartBytes: sql`${d1Schema.tenantUsage.multipartBytes} + ${reservation.size} - coalesce((select ${d1Schema.s3MultipartPart.reservedSize} from ${d1Schema.s3MultipartPart} where ${scope}), ${reservation.size})`,
					updatedAt
				})
				.where(usageFilter),
			this.d1
				.update(d1Schema.s3MultipartPart)
				.set({
					size: reservation.size,
					reservedSize: reservation.size,
					etag: part.etag
				})
				.where(and(scope, openUploadExists))
				.returning({ token: d1Schema.s3MultipartPart.reservationToken })
		]);

		if (recorded.length === 0) {
			const upload = await this.d1
				.select({ state: d1Schema.s3MultipartUpload.state })
				.from(d1Schema.s3MultipartUpload)
				.where(this.uploadScope(reservation.r2Key, reservation.uploadId))
				.get();
			if (upload?.state === 'completing' || upload?.state === 'recovering') {
				throw new MultipartUploadAlreadyCompletingError();
			}
			if (upload?.state !== 'open') {
				throw new MultipartUploadNotTrackedError();
			}

			throw new MultipartPartReservationSupersededError(reservation.partNumber);
		}
	}

	async prepareMultipartCompletion(
		r2Key: string,
		uploadIdValue: string,
		parts: readonly UploadedPart[]
	): Promise<MultipartCompletionPreparation> {
		const uploadId = uploadIdSchema.parse(uploadIdValue);
		const uploadScope = this.uploadScope(r2Key, uploadId);
		const upload = await this.d1
			.select({ state: d1Schema.s3MultipartUpload.state })
			.from(d1Schema.s3MultipartUpload)
			.where(uploadScope)
			.get();
		if (upload === undefined || upload.state === 'aborting') {
			throw new MultipartUploadNotTrackedError();
		}

		const size = await this.multipartCompletionSize(uploadId, parts);
		const token = this.newToken();
		const now = this.now();
		const nowIso = isoTimestamp(now);
		const leaseExpiresAt = isoTimestamp(
			new Date(now.getTime() + multipartCompletionLeaseMs)
		);
		const completionState = inArray(d1Schema.s3MultipartUpload.state, [
			'completing',
			'recovering'
		]);
		const expiredLease = or(
			isNull(d1Schema.s3MultipartUpload.completionLeaseExpiresAt),
			lte(d1Schema.s3MultipartUpload.completionLeaseExpiresAt, nowIso)
		);
		const stagedScope = and(
			eq(d1Schema.s3StagedObject.tenant, this.tenant),
			eq(d1Schema.s3StagedObject.r2Key, r2Key)
		);
		const stagedAvailable = sql`not exists (select 1 from ${d1Schema.s3StagedObject} where ${stagedScope} and ${d1Schema.s3StagedObject.deleting} = true)`;
		const partsScope = and(
			eq(d1Schema.s3MultipartPart.tenant, this.tenant),
			eq(d1Schema.s3MultipartPart.uploadId, uploadId)
		);
		const startedOwnership = and(
			uploadScope,
			eq(d1Schema.s3MultipartUpload.state, 'completing'),
			eq(d1Schema.s3MultipartUpload.completionToken, token)
		);
		const recoveredOwnership = and(
			uploadScope,
			eq(d1Schema.s3MultipartUpload.state, 'recovering'),
			eq(d1Schema.s3MultipartUpload.completionToken, token)
		);
		const startableUpload = and(
			uploadScope,
			eq(d1Schema.s3MultipartUpload.state, 'open'),
			stagedAvailable
		);

		const [started] = await this.d1.batch([
			this.d1
				.update(d1Schema.s3MultipartUpload)
				.set({
					state: 'completing',
					completionToken: token,
					completionLeaseExpiresAt: leaseExpiresAt
				})
				.where(startableUpload)
				.returning({ uploadId: d1Schema.s3MultipartUpload.uploadId }),
			this.d1
				.update(d1Schema.s3MultipartPart)
				.set({ reservationToken: token })
				.where(
					and(
						partsScope,
						sql`exists (select 1 from ${d1Schema.s3MultipartUpload} where ${startedOwnership})`
					)
				)
		]);
		if (started.length > 0) {
			return { kind: 'started', size, token };
		}

		const [recovered] = await this.d1.batch([
			this.d1
				.update(d1Schema.s3MultipartUpload)
				.set({
					state: 'recovering',
					completionToken: token,
					completionLeaseExpiresAt: leaseExpiresAt
				})
				.where(and(uploadScope, completionState, expiredLease, stagedAvailable))
				.returning({ uploadId: d1Schema.s3MultipartUpload.uploadId }),
			this.d1
				.update(d1Schema.s3MultipartPart)
				.set({ reservationToken: token })
				.where(
					and(
						partsScope,
						sql`exists (select 1 from ${d1Schema.s3MultipartUpload} where ${recoveredOwnership})`
					)
				)
		]);
		if (recovered.length > 0) {
			return { kind: 'recovering', size, token };
		}

		const [currentRows, stagedRows] = await this.d1.batch([
			this.d1
				.select({ state: d1Schema.s3MultipartUpload.state })
				.from(d1Schema.s3MultipartUpload)
				.where(uploadScope),
			this.d1
				.select({ deleting: d1Schema.s3StagedObject.deleting })
				.from(d1Schema.s3StagedObject)
				.where(stagedScope)
		]);
		const current = currentRows[0];
		const staged = stagedRows[0];
		if (staged?.deleting === true) {
			throw new StagedObjectBeingDeletedError();
		}
		if (current?.state === 'completing' || current?.state === 'recovering') {
			throw new MultipartUploadAlreadyCompletingError();
		}

		throw new MultipartUploadNotTrackedError();
	}

	async renewMultipartCompletion(
		r2Key: string,
		uploadIdValue: string,
		token: string
	): Promise<void> {
		const uploadId = uploadIdSchema.parse(uploadIdValue);
		const now = this.now();
		const leaseExpiresAt = isoTimestamp(
			new Date(now.getTime() + multipartCompletionLeaseMs)
		);
		const stagedScope = and(
			eq(d1Schema.s3StagedObject.tenant, this.tenant),
			eq(d1Schema.s3StagedObject.r2Key, r2Key)
		);
		const stagedAvailable = sql`not exists (select 1 from ${d1Schema.s3StagedObject} where ${stagedScope} and ${d1Schema.s3StagedObject.deleting} = true)`;
		const renewed = await this.d1
			.update(d1Schema.s3MultipartUpload)
			.set({ completionLeaseExpiresAt: leaseExpiresAt })
			.where(
				and(
					this.uploadScope(r2Key, uploadId),
					inArray(d1Schema.s3MultipartUpload.state, [
						'completing',
						'recovering'
					]),
					eq(d1Schema.s3MultipartUpload.completionToken, token),
					stagedAvailable
				)
			)
			.returning({ uploadId: d1Schema.s3MultipartUpload.uploadId });
		if (renewed.length > 0) {
			return;
		}

		const staged = await this.d1
			.select({ deleting: d1Schema.s3StagedObject.deleting })
			.from(d1Schema.s3StagedObject)
			.where(stagedScope)
			.get();
		if (staged?.deleting === true) {
			throw new StagedObjectBeingDeletedError();
		}

		throw new MultipartUploadAlreadyCompletingError();
	}

	async reopenMultipart(
		r2Key: string,
		uploadIdValue: string,
		token: string
	): Promise<void> {
		const uploadId = uploadIdSchema.parse(uploadIdValue);
		const reopened = await this.d1
			.update(d1Schema.s3MultipartUpload)
			.set({
				state: 'open',
				completionToken: sql`null`,
				completionLeaseExpiresAt: sql`null`
			})
			.where(
				and(
					this.uploadScope(r2Key, uploadId),
					eq(d1Schema.s3MultipartUpload.state, 'completing'),
					eq(d1Schema.s3MultipartUpload.completionToken, token)
				)
			)
			.returning({ uploadId: d1Schema.s3MultipartUpload.uploadId });
		if (reopened.length === 0) {
			throw new MultipartUploadAlreadyCompletingError();
		}
	}

	async markMultipartRecovering(
		r2Key: string,
		uploadIdValue: string,
		token: string
	): Promise<void> {
		const uploadId = uploadIdSchema.parse(uploadIdValue);
		await this.d1
			.update(d1Schema.s3MultipartUpload)
			.set({
				state: 'recovering',
				completionToken: sql`null`,
				completionLeaseExpiresAt: isoTimestamp(this.now())
			})
			.where(
				and(
					this.uploadScope(r2Key, uploadId),
					inArray(d1Schema.s3MultipartUpload.state, [
						'completing',
						'recovering'
					]),
					eq(d1Schema.s3MultipartUpload.completionToken, token)
				)
			)
			.run();
	}

	async markMultipartAborting(
		r2Key: string,
		uploadIdValue: string
	): Promise<boolean> {
		const uploadId = uploadIdSchema.parse(uploadIdValue);
		const nowIso = isoTimestamp(this.now());
		const completionState = inArray(d1Schema.s3MultipartUpload.state, [
			'completing',
			'recovering'
		]);
		const expiredLease = or(
			isNull(d1Schema.s3MultipartUpload.completionLeaseExpiresAt),
			lte(d1Schema.s3MultipartUpload.completionLeaseExpiresAt, nowIso)
		);
		const abortableState = or(
			inArray(d1Schema.s3MultipartUpload.state, ['open', 'aborting']),
			and(completionState, expiredLease)
		);
		const abortableUpload = and(
			this.uploadScope(r2Key, uploadId),
			abortableState
		);
		const marked = await this.d1
			.update(d1Schema.s3MultipartUpload)
			.set({
				state: 'aborting',
				completionToken: sql`null`,
				completionLeaseExpiresAt: sql`null`
			})
			.where(abortableUpload)
			.returning({ uploadId: d1Schema.s3MultipartUpload.uploadId });

		return marked.length > 0;
	}

	async completeMultipart(
		r2Key: string,
		uploadIdValue: string,
		token: string,
		parts: readonly UploadedPart[],
		expiresAt: IsoTimestamp
	): Promise<void> {
		const uploadId = uploadIdSchema.parse(uploadIdValue);
		const uploadScope = this.uploadScope(r2Key, uploadId);
		const ownership = and(
			uploadScope,
			inArray(d1Schema.s3MultipartUpload.state, ['completing', 'recovering']),
			eq(d1Schema.s3MultipartUpload.completionToken, token)
		);
		const upload = await this.d1
			.select()
			.from(d1Schema.s3MultipartUpload)
			.where(ownership)
			.get();
		if (upload === undefined) {
			throw new MultipartUploadNotTrackedError();
		}

		const partsScope = and(
			eq(d1Schema.s3MultipartPart.tenant, this.tenant),
			eq(d1Schema.s3MultipartPart.uploadId, uploadId)
		);
		const completedSize = await this.multipartCompletionSize(uploadId, parts);
		const stagedScope = and(
			eq(d1Schema.s3StagedObject.tenant, this.tenant),
			eq(d1Schema.s3StagedObject.r2Key, r2Key)
		);
		const stagedAvailable = sql`not exists (select 1 from ${d1Schema.s3StagedObject} where ${stagedScope} and ${d1Schema.s3StagedObject.deleting} = true)`;
		const ownershipExists = sql`exists (select 1 from ${d1Schema.s3MultipartUpload} where ${ownership})`;
		const usageExists = sql`exists (select 1 from ${d1Schema.tenantUsage} where ${eq(d1Schema.tenantUsage.tenant, this.tenant)})`;
		const finalisationConditions = and(
			ownershipExists,
			usageExists,
			stagedAvailable
		);
		const finalStagedScope = and(
			stagedScope,
			eq(d1Schema.s3StagedObject.deleting, false),
			eq(d1Schema.s3StagedObject.cache, upload.cache),
			eq(d1Schema.s3StagedObject.size, completedSize),
			eq(d1Schema.s3StagedObject.expiresAt, expiresAt)
		);
		const finalised = and(
			ownership,
			sql`exists (select 1 from ${d1Schema.s3StagedObject} where ${finalStagedScope})`
		);
		const updatedAt = isoTimestamp(this.now());
		const tenantUsageScope = eq(d1Schema.tenantUsage.tenant, this.tenant);
		const finalisableUsage = and(tenantUsageScope, finalisationConditions);

		const [, staged, , completedUpload, stagedState] = await this.d1.batch([
			this.d1
				.update(d1Schema.tenantUsage)
				.set({
					multipartBytes: sql`${d1Schema.tenantUsage.multipartBytes} - coalesce((select sum(${d1Schema.s3MultipartPart.reservedSize}) from ${d1Schema.s3MultipartPart} where ${partsScope}), 0)`,
					stagedBytes: sql`${d1Schema.tenantUsage.stagedBytes} + ${completedSize} - coalesce((select ${d1Schema.s3StagedObject.size} from ${d1Schema.s3StagedObject} where ${stagedScope}), 0)`,
					updatedAt
				})
				.where(finalisableUsage),
			this.d1
				.insert(d1Schema.s3StagedObject)
				.select((qb) =>
					qb
						.select({
							tenant: d1Schema.s3MultipartUpload.tenant,
							r2Key: d1Schema.s3MultipartUpload.r2Key,
							cache: d1Schema.s3MultipartUpload.cache,
							size: sql<number>`${completedSize}`.as('size'),
							expiresAt: sql<IsoTimestamp>`${expiresAt}`.as('expires_at'),
							deleting: sql<boolean>`false`.as('deleting')
						})
						.from(d1Schema.s3MultipartUpload)
						.where(and(ownership, usageExists, stagedAvailable))
				)
				.onConflictDoUpdate({
					target: [
						d1Schema.s3StagedObject.tenant,
						d1Schema.s3StagedObject.r2Key
					],
					set: { cache: upload.cache, size: completedSize, expiresAt },
					setWhere: eq(d1Schema.s3StagedObject.deleting, false)
				})
				.returning({ r2Key: d1Schema.s3StagedObject.r2Key }),
			this.d1
				.delete(d1Schema.s3MultipartPart)
				.where(
					and(
						partsScope,
						sql`exists (select 1 from ${d1Schema.s3MultipartUpload} where ${finalised})`
					)
				),
			this.d1
				.delete(d1Schema.s3MultipartUpload)
				.where(finalised)
				.returning({ uploadId: d1Schema.s3MultipartUpload.uploadId }),
			this.d1
				.select({ deleting: d1Schema.s3StagedObject.deleting })
				.from(d1Schema.s3StagedObject)
				.where(stagedScope)
		]);

		if (staged.length === 0 || completedUpload.length === 0) {
			if (stagedState[0]?.deleting === true) {
				throw new StagedObjectBeingDeletedError();
			}

			throw new MultipartUploadAlreadyCompletingError();
		}
	}

	async releaseMultipart(r2Key: string, uploadIdValue: string): Promise<void> {
		const uploadId = uploadIdSchema.parse(uploadIdValue);
		const uploadScope = this.uploadScope(r2Key, uploadId);
		const partsScope = and(
			eq(d1Schema.s3MultipartPart.tenant, this.tenant),
			eq(d1Schema.s3MultipartPart.uploadId, uploadId)
		);
		const updatedAt = isoTimestamp(this.now());

		await this.d1.batch([
			this.d1
				.update(d1Schema.tenantUsage)
				.set({
					multipartBytes: sql`${d1Schema.tenantUsage.multipartBytes} - coalesce((select sum(${d1Schema.s3MultipartPart.reservedSize}) from ${d1Schema.s3MultipartPart} where ${partsScope}), 0)`,
					updatedAt
				})
				.where(eq(d1Schema.tenantUsage.tenant, this.tenant)),
			this.d1.delete(d1Schema.s3MultipartPart).where(partsScope),
			this.d1.delete(d1Schema.s3MultipartUpload).where(uploadScope)
		]);
	}

	async cleanupCache(
		blobStore: BlobStore,
		cache: StoredCache
	): Promise<S3StagingCleanupOutcome> {
		const cacheScope = and(
			eq(d1Schema.s3MultipartUpload.tenant, this.tenant),
			eq(d1Schema.s3MultipartUpload.cache, cache)
		);
		const stagedScope = and(
			eq(d1Schema.s3StagedObject.tenant, this.tenant),
			eq(d1Schema.s3StagedObject.cache, cache)
		);
		const [multipart, staged] = await this.d1.batch([
			this.d1.select().from(d1Schema.s3MultipartUpload).where(cacheScope),
			this.d1.select().from(d1Schema.s3StagedObject).where(stagedScope)
		]);

		return this.cleanupRows(blobStore, multipart, staged, () =>
			and(
				eq(d1Schema.s3StagedObject.tenant, this.tenant),
				eq(d1Schema.s3StagedObject.cache, cache)
			)
		);
	}

	async cleanupExpired(
		blobStore: BlobStore,
		now: Date,
		limit: number = maxExpiredS3ObjectsPerRun
	): Promise<S3StagingCleanupOutcome> {
		const nowIso = isoTimestamp(now);
		const multipartExpiry = and(
			eq(d1Schema.s3MultipartUpload.tenant, this.tenant),
			lte(d1Schema.s3MultipartUpload.expiresAt, nowIso)
		);
		const stagedExpiry = and(
			eq(d1Schema.s3StagedObject.tenant, this.tenant),
			lte(d1Schema.s3StagedObject.expiresAt, nowIso)
		);
		const [multipart, staged] = await this.d1.batch([
			this.d1
				.select()
				.from(d1Schema.s3MultipartUpload)
				.where(multipartExpiry)
				.orderBy(asc(d1Schema.s3MultipartUpload.expiresAt))
				.limit(limit),
			this.d1
				.select()
				.from(d1Schema.s3StagedObject)
				.where(stagedExpiry)
				.orderBy(asc(d1Schema.s3StagedObject.expiresAt))
				.limit(limit)
		]);
		return this.cleanupRows(blobStore, multipart, staged, () =>
			and(
				eq(d1Schema.s3StagedObject.tenant, this.tenant),
				lte(d1Schema.s3StagedObject.expiresAt, nowIso)
			)
		);
	}

	async cleanupForOffboarding(
		blobStore: BlobStore,
		limit: number = maxExpiredS3ObjectsPerRun
	): Promise<S3StagingCleanupOutcome> {
		const tenantScope = eq(d1Schema.s3MultipartUpload.tenant, this.tenant);
		const stagedScope = eq(d1Schema.s3StagedObject.tenant, this.tenant);
		const [multipart, staged] = await this.d1.batch([
			this.d1
				.select()
				.from(d1Schema.s3MultipartUpload)
				.where(tenantScope)
				.orderBy(asc(d1Schema.s3MultipartUpload.createdAt))
				.limit(limit),
			this.d1
				.select()
				.from(d1Schema.s3StagedObject)
				.where(stagedScope)
				.orderBy(asc(d1Schema.s3StagedObject.expiresAt))
				.limit(limit)
		]);

		return this.cleanupRows(blobStore, multipart, staged, () =>
			eq(d1Schema.s3StagedObject.tenant, this.tenant)
		);
	}
}
