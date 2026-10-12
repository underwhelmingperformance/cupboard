import type {
	CacheScope,
	StorePathHash,
	TenantId
} from '@cupboard/nix-store/scalars';
import { and, asc, eq, inArray, isNull, lt, lte, sql } from 'drizzle-orm';

import { lateWriteTombstoneHorizonMs } from '../blob/object-incarnation.ts';
import {
	type AttestationListPublication,
	type AttestationListRevision,
	AttestationListRevisionRepository
} from '../db/attestation-list-revision.ts';
import { cacheScopeFromRow } from '../db/cache.ts';
import * as schema from '../db/schema.ts';
import {
	AttestationListRefreshLeaseLostError,
	AttestationListSourceUnavailableError,
	AttestationListStagingInvalidError,
	causedBy,
	SubrequestTimeoutError
} from '../errors.ts';
import { r2ObjectKeySchema } from '../http/http.ts';
import {
	isObjectOfListPublication,
	isSameListPublication,
	listGenerationMetadataKey
} from '../read/attestation-generation.ts';
import { authorisedNarInfoVersions } from '../read/read.ts';

import {
	armAlarmNoLaterThan,
	type MaintenanceProgress,
	noProgressRetryMs
} from './alarm.ts';
import {
	attestationListRefreshCursorKey,
	type AttestationListRefreshFailure,
	type AttestationListRefreshSource
} from './attestation-list-refresh-state.ts';
import type { ServerContext } from './context.ts';
import {
	criticalSectionBudgetMs,
	currentDeadlineSignal,
	withDeadlineBudget
} from './deadline.ts';
import { jsonValueList } from './json-list.ts';
import { hasSubrequestsFor } from './subrequest-slice.ts';

const partBytes = 5 * 1024 * 1024;
const maximumParts = 10_000;
const maximumJobs = 16;
const concurrentRefreshes = new Set<string>();
const utf8 = new TextEncoder();
type Job = typeof schema.attestationListRefreshJobs.$inferSelect;
interface PartCursor {
	readonly sequence: number;
	readonly offset: number;
}

class ClaimedAttestationListRefresh {
	private readonly repository: AttestationListRevisionRepository;

	constructor(
		private readonly context: ServerContext,
		private readonly owner: string,
		private readonly scope: {
			readonly tenant: TenantId;
			readonly cleanupOnly: boolean;
		} = { tenant: context.requireTenant(), cleanupOnly: false }
	) {
		this.repository = new AttestationListRevisionRepository(
			context.d1,
			this.scope.tenant
		);
	}

	private checkLease(): void {
		if (this.context.offboarding && !this.scope.cleanupOnly) {
			throw new AttestationListRefreshLeaseLostError();
		}
		if (currentDeadlineSignal()?.aborted === true) {
			throw new SubrequestTimeoutError('attestation-list.refresh');
		}
		const lease = this.context.db
			.select()
			.from(schema.attestationListRefreshLease)
			.where(eq(schema.attestationListRefreshLease.id, 1))
			.get();
		if (lease?.owner !== this.owner || lease.expiresAt <= Date.now()) {
			throw new AttestationListRefreshLeaseLostError();
		}
	}

	private async sourceIsCurrent(job: Job): Promise<boolean> {
		const current = await this.repository.get(job.source.identity);
		if (
			current?.id !== job.source.captured.id ||
			current.revision !== job.source.captured.revision
		) {
			return false;
		}
		const parents = await authorisedNarInfoVersions(
			this.context.d1,
			this.context.requireTenant(),
			job.source.identity.cache,
			[job.source.identity.storePathHash]
		);
		const parent = parents.get(job.source.identity.storePathHash);
		return (
			parent?.generation === job.source.identity.generation &&
			parent.cacheGeneration === job.source.parent.cacheGeneration &&
			parent.narHash === job.source.parent.narHash
		);
	}

	private async startPending(): Promise<MaintenanceProgress> {
		this.checkLease();
		const jobs = this.context.db
			.select({ id: schema.attestationListRefreshJobs.id })
			.from(schema.attestationListRefreshJobs)
			.limit(maximumJobs)
			.all();
		if (jobs.length >= maximumJobs) {
			return 'stalled';
		}
		const wake = this.context.db
			.select()
			.from(schema.attestationListRefreshWake)
			.where(eq(schema.attestationListRefreshWake.id, 1))
			.get();
		const after = await this.context.ctx.storage.get<number>(
			attestationListRefreshCursorKey
		);
		let rows = await this.repository.pendingPage(after, 8);
		if (after !== undefined && rows.length === 0) {
			rows = await this.repository.pendingPage(undefined, 8);
		}
		if (rows.length === 0) {
			this.checkLease();
			if (wake !== undefined) {
				this.context.db
					.delete(schema.attestationListRefreshWake)
					.where(
						and(
							eq(schema.attestationListRefreshWake.id, 1),
							eq(schema.attestationListRefreshWake.token, wake.token)
						)
					)
					.run();
			}
			return 'progressed';
		}

		for (const row of rows) {
			this.checkLease();
			await this.context.ctx.storage.put(
				attestationListRefreshCursorKey,
				row.id
			);
			this.checkLease();
			const retry = this.context.db
				.select()
				.from(schema.attestationListRefreshRetries)
				.where(eq(schema.attestationListRefreshRetries.revisionId, row.id))
				.get();
			if (retry?.revision === row.revision && retry.notBefore > Date.now()) {
				continue;
			}
			this.context.db
				.delete(schema.attestationListRefreshRetries)
				.where(eq(schema.attestationListRefreshRetries.revisionId, row.id))
				.run();
			const cache = cacheScopeFromRow({
				kind: row.cacheKind,
				name: row.cacheName
			});
			const identity = {
				cache,
				storePathHash: row.storePathHash,
				generation: row.generation
			};
			const parents = await authorisedNarInfoVersions(
				this.context.d1,
				this.context.requireTenant(),
				cache,
				[row.storePathHash]
			);
			const parent = parents.get(row.storePathHash);
			if (parent?.generation !== row.generation) {
				return this.retireObsolete(row, identity);
			}
			this.checkLease();
			const resolved = this.context.cacheRepository.require(cache);
			const id = crypto.randomUUID();
			const source: AttestationListRefreshSource = {
				captured: { id: row.id, revision: row.revision },
				identity,
				parent: {
					cacheGeneration: parent.cacheGeneration,
					narHash: parent.narHash
				},
				cacheId: resolved.id,
				precedingKey: row.publishedKey ?? undefined
			};
			this.context.db
				.insert(schema.attestationListRefreshJobs)
				.values({
					id,
					cacheId: resolved.id,
					source,
					key: r2ObjectKeySchema.parse(
						`t/${this.context.requireTenant()}/attestation-index/${id}`
					)
				})
				.run();
			return 'progressed';
		}
		return 'stalled';
	}

	private async retireObsolete(
		row: AttestationListRevision,
		identity: AttestationListRefreshSource['identity']
	): Promise<MaintenanceProgress> {
		this.checkLease();
		if (
			row.publishedKey !== null &&
			row.publishedCacheGeneration !== null &&
			row.publishedNarHash !== null
		) {
			const source: AttestationListRefreshSource = {
				captured: { id: row.id, revision: row.revision },
				identity,
				parent: {
					cacheGeneration: row.publishedCacheGeneration,
					narHash: row.publishedNarHash
				}
			};
			this.context.db
				.insert(schema.attestationListRefreshJobs)
				.values({
					id: crypto.randomUUID(),
					source,
					key: row.publishedKey,
					phase: 'cleanup',
					cleanupAt: Date.now()
				})
				.run();
		}
		return (await this.repository.retire(row, identity))
			? 'progressed'
			: 'stalled';
	}

	private retireJob(job: Job): void {
		this.checkLease();
		this.context.db
			.update(schema.attestationListRefreshJobs)
			.set({
				phase: 'cleanup',
				cleanupAt: sql`max(${Date.now()}, ${schema.attestationListRefreshJobs.cleanupNotBefore})`
			})
			.where(eq(schema.attestationListRefreshJobs.id, job.id))
			.run();
	}

	private async collect(job: Job): Promise<MaintenanceProgress> {
		this.checkLease();
		const page = await this.repository.descriptorPage(
			job.source.identity,
			job.after ?? undefined
		);
		const descriptors = page.entries.map((entry) => {
			if (entry.size === undefined) {
				throw new AttestationListSourceUnavailableError(entry.digest);
			}
			return {
				digest: entry.digest,
				predicateType: entry.predicateType,
				size: entry.size
			};
		});
		const prefix = job.hasEntries
			? descriptors.length === 0
				? ''
				: ','
			: '{"attestations":[';
		const body =
			prefix +
			descriptors.map((entry) => JSON.stringify(entry)).join(',') +
			(page.hasMore ? '' : ']}\n');
		const bytes = utf8.encode(body).byteLength;
		if (bytes > 1024 * 1024) {
			throw new AttestationListStagingInvalidError(job.id, 'chunk-too-large');
		}
		const bufferedBytes = job.bufferedBytes + bytes;
		const isFinal = !page.hasMore;
		const hasEntries = job.hasEntries || descriptors.length > 0;
		this.checkLease();
		this.context.db.transaction((tx) => {
			tx.insert(schema.attestationListRefreshChunks)
				.values({ jobId: job.id, sequence: job.nextSequence, body, bytes })
				.run();
			tx.update(schema.attestationListRefreshJobs)
				.set({
					after: page.after ?? sql`NULL`,
					nextSequence: job.nextSequence + 1,
					bufferedBytes,
					isFinal,
					hasEntries,
					phase:
						isFinal && !hasEntries
							? 'publishing'
							: isFinal || bufferedBytes >= partBytes
								? 'uploading'
								: 'collecting'
				})
				.where(eq(schema.attestationListRefreshJobs.id, job.id))
				.run();
		});
		return 'progressed';
	}

	private async produce(
		job: Job,
		writer: WritableStreamDefaultWriter<ArrayBuffer | ArrayBufferView>,
		length: number
	): Promise<PartCursor> {
		let remaining = length;
		let sequence = job.readSequence;
		let offset = job.readOffset;
		while (remaining > 0) {
			this.checkLease();
			const chunk = this.context.db
				.select()
				.from(schema.attestationListRefreshChunks)
				.where(
					and(
						eq(schema.attestationListRefreshChunks.jobId, job.id),
						eq(schema.attestationListRefreshChunks.sequence, sequence)
					)
				)
				.get();
			if (chunk === undefined) {
				throw new AttestationListStagingInvalidError(job.id, 'missing-chunk');
			}
			const bytes = utf8.encode(chunk.body);
			if (chunk.bytes !== bytes.byteLength || offset >= bytes.byteLength) {
				throw new AttestationListStagingInvalidError(job.id, 'invalid-chunk');
			}
			const end = Math.min(bytes.byteLength, offset + remaining);
			await writer.write(bytes.subarray(offset, end));
			remaining -= end - offset;
			offset = end;
			if (offset !== bytes.byteLength) {
				continue;
			}

			sequence += 1;
			offset = 0;
		}
		await writer.close();
		return { sequence, offset };
	}

	private metadata(job: Job): Record<string, string> {
		return {
			[listGenerationMetadataKey]: String(job.source.identity.generation),
			'cache-generation': String(job.source.parent.cacheGeneration),
			'list-revision': String(job.source.captured.revision),
			'nar-hash': job.source.parent.narHash,
			'job-id': job.id
		};
	}

	private verifyCompleted(job: Job, object: R2Object): void {
		if (object.size !== job.completedBytes) {
			throw new AttestationListStagingInvalidError(job.id, 'completed-size');
		}
		const metadata = this.metadata(job);
		if (
			Object.entries(metadata).some(
				([key, value]) => object.customMetadata?.[key] !== value
			)
		) {
			throw new AttestationListStagingInvalidError(
				job.id,
				'completed-metadata'
			);
		}
	}

	private async upload(job: Job): Promise<MaintenanceProgress> {
		this.checkLease();
		if (job.uploadId === null) {
			const upload = await this.context.objectWrites.write([job.key], () =>
				this.context.env.BLOBS.createMultipartUpload(job.key, {
					httpMetadata: {
						contentType: 'application/json; charset=utf-8',
						cacheControl: 'no-store'
					},
					customMetadata: this.metadata(job)
				})
			);
			this.checkLease();
			this.context.db
				.update(schema.attestationListRefreshJobs)
				.set({ uploadId: upload.uploadId })
				.where(eq(schema.attestationListRefreshJobs.id, job.id))
				.run();
			return 'progressed';
		}
		if (job.nextPart > maximumParts) {
			throw new AttestationListStagingInvalidError(job.id, 'part-limit');
		}
		const length = Math.min(partBytes, job.bufferedBytes);
		if (length === 0 || (!job.isFinal && length < partBytes)) {
			throw new AttestationListStagingInvalidError(job.id, 'short-buffer');
		}
		const stream = new FixedLengthStream(length);
		const writer = stream.writable.getWriter();
		const produced = this.produce(job, writer, length);

		let uploaded: R2UploadedPart;
		let cursor: PartCursor;
		try {
			[uploaded, cursor] = await Promise.all([
				this.context.objectWrites.write([job.key], () =>
					this.context.env.BLOBS.resumeMultipartUpload(
						job.key,
						job.uploadId ?? ''
					).uploadPart(job.nextPart, stream.readable)
				),
				produced
			]);
		} catch (error: unknown) {
			await Promise.allSettled([writer.abort(error), produced]);
			throw error;
		}
		this.checkLease();
		this.context.db.transaction((tx) => {
			tx.insert(schema.attestationListRefreshParts)
				.values({
					jobId: job.id,
					partNumber: uploaded.partNumber,
					etag: uploaded.etag
				})
				.run();
			tx.delete(schema.attestationListRefreshChunks)
				.where(
					and(
						eq(schema.attestationListRefreshChunks.jobId, job.id),
						lt(schema.attestationListRefreshChunks.sequence, cursor.sequence)
					)
				)
				.run();
			tx.update(schema.attestationListRefreshJobs)
				.set({
					readSequence: cursor.sequence,
					readOffset: cursor.offset,
					nextPart: job.nextPart + 1,
					bufferedBytes: job.bufferedBytes - length,
					completedBytes: job.completedBytes + length,
					phase:
						job.isFinal && job.bufferedBytes === length
							? 'completing'
							: job.bufferedBytes - length >= partBytes || job.isFinal
								? 'uploading'
								: 'collecting'
				})
				.where(eq(schema.attestationListRefreshJobs.id, job.id))
				.run();
		});
		return 'progressed';
	}

	private async complete(job: Job): Promise<MaintenanceProgress> {
		this.checkLease();
		const existing = await this.context.env.BLOBS.head(job.key);
		this.checkLease();
		if (existing !== null) {
			this.verifyCompleted(job, existing);
		}
		if (existing === null) {
			if (job.uploadId === null) {
				throw new AttestationListStagingInvalidError(job.id, 'missing-chunk');
			}
			const parts = this.context.db
				.select({
					partNumber: schema.attestationListRefreshParts.partNumber,
					etag: schema.attestationListRefreshParts.etag
				})
				.from(schema.attestationListRefreshParts)
				.where(eq(schema.attestationListRefreshParts.jobId, job.id))
				.orderBy(asc(schema.attestationListRefreshParts.partNumber))
				.limit(maximumParts)
				.all();
			this.context.db
				.update(schema.attestationListRefreshJobs)
				.set({ cleanupNotBefore: Date.now() + lateWriteTombstoneHorizonMs })
				.where(eq(schema.attestationListRefreshJobs.id, job.id))
				.run();
			const completed = await this.context.objectWrites.write([job.key], () =>
				this.context.env.BLOBS.resumeMultipartUpload(
					job.key,
					job.uploadId ?? ''
				).complete(parts)
			);
			this.verifyCompleted(job, completed);
		}
		this.checkLease();
		this.context.db
			.update(schema.attestationListRefreshJobs)
			.set({
				phase: 'publishing',
				...(existing === null && { cleanupNotBefore: 0 })
			})
			.where(eq(schema.attestationListRefreshJobs.id, job.id))
			.run();
		return 'progressed';
	}

	private async publish(job: Job): Promise<MaintenanceProgress> {
		this.checkLease();
		await this.repository.publish(
			job.source.captured,
			job.source.identity,
			job.source.parent,
			job.hasEntries ? job.key : undefined
		);
		this.retireJob(job);
		return 'progressed';
	}

	private async cleanup(job: Job): Promise<MaintenanceProgress> {
		this.checkLease();
		const chunks = this.context.db
			.select({ sequence: schema.attestationListRefreshChunks.sequence })
			.from(schema.attestationListRefreshChunks)
			.where(eq(schema.attestationListRefreshChunks.jobId, job.id))
			.limit(64)
			.all();
		if (chunks.length > 0) {
			const sequences = jsonValueList(chunks.map((chunk) => chunk.sequence));
			this.context.db
				.delete(schema.attestationListRefreshChunks)
				.where(
					and(
						eq(schema.attestationListRefreshChunks.jobId, job.id),
						inArray(schema.attestationListRefreshChunks.sequence, sequences)
					)
				)
				.run();
			return 'progressed';
		}
		const parts = this.context.db
			.select({ partNumber: schema.attestationListRefreshParts.partNumber })
			.from(schema.attestationListRefreshParts)
			.where(eq(schema.attestationListRefreshParts.jobId, job.id))
			.limit(64)
			.all();
		if (parts.length > 0) {
			const partNumbers = jsonValueList(parts.map((part) => part.partNumber));
			this.context.db
				.delete(schema.attestationListRefreshParts)
				.where(
					and(
						eq(schema.attestationListRefreshParts.jobId, job.id),
						inArray(schema.attestationListRefreshParts.partNumber, partNumbers)
					)
				)
				.run();
			return 'progressed';
		}
		const current = await this.repository.readState(
			job.source.identity,
			job.source.parent
		);
		const publishedKey = current.status === 'ready' ? current.key : undefined;
		const deletingKeys = [job.key, job.source.precedingKey]
			.filter((key) => key !== undefined)
			.filter((key) => key !== publishedKey);
		const pendingCompletion = this.context.db
			.select({
				after: sql<number>`coalesce(max(${schema.attestationListRefreshJobs.cleanupNotBefore}), 0)`
			})
			.from(schema.attestationListRefreshJobs)
			.where(
				inArray(
					schema.attestationListRefreshJobs.key,
					jsonValueList(deletingKeys)
				)
			)
			.get();
		if (
			pendingCompletion !== undefined &&
			pendingCompletion.after > Date.now()
		) {
			this.context.db
				.update(schema.attestationListRefreshJobs)
				.set({ cleanupAt: pendingCompletion.after })
				.where(eq(schema.attestationListRefreshJobs.id, job.id))
				.run();
			return 'progressed';
		}
		if (publishedKey !== job.key) {
			await this.context.objectWrites.write([job.key], async () => {
				if (job.uploadId !== null) {
					await this.context.env.BLOBS.resumeMultipartUpload(
						job.key,
						job.uploadId
					).abort();
				}
				await this.context.env.BLOBS.delete(job.key);
			});
		}
		if (
			job.source.precedingKey !== undefined &&
			job.source.precedingKey !== publishedKey
		) {
			await this.context.objectWrites.write([job.source.precedingKey], () =>
				this.context.env.BLOBS.delete(job.source.precedingKey ?? job.key)
			);
		}
		this.checkLease();
		this.context.db
			.delete(schema.attestationListRefreshJobs)
			.where(eq(schema.attestationListRefreshJobs.id, job.id))
			.run();
		return 'progressed';
	}
	private async advanceJob(job: Job): Promise<MaintenanceProgress> {
		switch (job.phase) {
			case 'collecting': {
				return this.collect(job);
			}
			case 'uploading': {
				return this.upload(job);
			}
			case 'completing': {
				return this.complete(job);
			}
			case 'publishing': {
				return this.publish(job);
			}
			case 'cleanup': {
				return 'stalled';
			}
		}
	}

	private retryJob(job: Job, failure: AttestationListRefreshFailure): void {
		this.checkLease();
		this.context.db.transaction((tx) => {
			tx.insert(schema.attestationListRefreshRetries)
				.values({
					revisionId: job.source.captured.id,
					revision: job.source.captured.revision,
					cacheId: job.cacheId,
					notBefore: Date.now() + noProgressRetryMs,
					failure
				})
				.onConflictDoUpdate({
					target: schema.attestationListRefreshRetries.revisionId,
					set: {
						revision: job.source.captured.revision,
						cacheId: job.cacheId,
						notBefore: Date.now() + noProgressRetryMs,
						failure
					}
				})
				.run();
			tx.update(schema.attestationListRefreshJobs)
				.set({
					phase: 'cleanup',
					cleanupAt: sql`max(${Date.now()}, ${schema.attestationListRefreshJobs.cleanupNotBefore})`
				})
				.where(eq(schema.attestationListRefreshJobs.id, job.id))
				.run();
		});
	}

	async advanceOne(): Promise<MaintenanceProgress> {
		const cleanup = this.context.db
			.select()
			.from(schema.attestationListRefreshJobs)
			.where(lte(schema.attestationListRefreshJobs.cleanupAt, Date.now()))
			.orderBy(
				asc(schema.attestationListRefreshJobs.cleanupAt),
				asc(schema.attestationListRefreshJobs.id)
			)
			.limit(1)
			.get();
		if (cleanup !== undefined) {
			return this.cleanup(cleanup);
		}
		if (this.scope.cleanupOnly) {
			return 'stalled';
		}

		const job = this.context.db
			.select()
			.from(schema.attestationListRefreshJobs)
			.where(isNull(schema.attestationListRefreshJobs.cleanupAt))
			.limit(1)
			.get();
		if (job === undefined) {
			return this.startPending();
		}
		if (!(await this.sourceIsCurrent(job))) {
			this.retireJob(job);
			return 'progressed';
		}
		try {
			return await this.advanceJob(job);
		} catch (error: unknown) {
			if (error instanceof AttestationListSourceUnavailableError) {
				this.retryJob(job, {
					reason: 'source-unavailable',
					digest: error.digest
				});
				return 'progressed';
			}
			if (error instanceof AttestationListStagingInvalidError) {
				this.retryJob(job, { reason: 'staging-invalid', detail: error.reason });
				return 'progressed';
			}
			throw error;
		}
	}
}

export class AttestationListRefreshService {
	constructor(private readonly context: ServerContext) {}

	private claim(owner: string): boolean {
		const lease = this.context.db
			.select()
			.from(schema.attestationListRefreshLease)
			.where(eq(schema.attestationListRefreshLease.id, 1))
			.get();
		if (lease !== undefined && lease.expiresAt > Date.now()) {
			return false;
		}
		this.context.db
			.insert(schema.attestationListRefreshLease)
			.values({
				id: 1,
				owner,
				expiresAt: Date.now() + criticalSectionBudgetMs + 5000
			})
			.onConflictDoUpdate({
				target: schema.attestationListRefreshLease.id,
				set: { owner, expiresAt: Date.now() + criticalSectionBudgetMs + 5000 }
			})
			.run();
		return true;
	}

	private async releaseAfter(
		operation: Promise<void>,
		token: string
	): Promise<void> {
		try {
			await operation;
		} finally {
			concurrentRefreshes.delete(token);
		}
	}

	async cleanupRetiredInSection(
		tenant: TenantId
	): Promise<MaintenanceProgress> {
		const owner = crypto.randomUUID();
		if (!this.claim(owner)) {
			return 'stalled';
		}
		try {
			return await new ClaimedAttestationListRefresh(this.context, owner, {
				tenant,
				cleanupOnly: true
			}).advanceOne();
		} finally {
			this.context.db
				.delete(schema.attestationListRefreshLease)
				.where(eq(schema.attestationListRefreshLease.owner, owner))
				.run();
		}
	}

	async requestWake(): Promise<void> {
		const token = crypto.randomUUID();
		this.context.db
			.insert(schema.attestationListRefreshWake)
			.values({ id: 1, token })
			.onConflictDoUpdate({
				target: schema.attestationListRefreshWake.id,
				set: { token }
			})
			.run();
		await armAlarmNoLaterThan(this.context.ctx.storage, Date.now());
	}

	nextWorkAt(now: number): number | undefined {
		const wake = this.context.db
			.select({ id: schema.attestationListRefreshWake.id })
			.from(schema.attestationListRefreshWake)
			.limit(1)
			.get();
		if (wake !== undefined) {
			return now;
		}
		const active = this.context.db
			.select({ id: schema.attestationListRefreshJobs.id })
			.from(schema.attestationListRefreshJobs)
			.where(isNull(schema.attestationListRefreshJobs.cleanupAt))
			.limit(1)
			.get();
		if (active !== undefined) {
			return now;
		}
		return (
			this.context.db
				.select({ at: schema.attestationListRefreshJobs.cleanupAt })
				.from(schema.attestationListRefreshJobs)
				.orderBy(asc(schema.attestationListRefreshJobs.cleanupAt))
				.limit(1)
				.get()?.at ?? undefined
		);
	}

	async repairObserved(
		cache: CacheScope,
		hash: StorePathHash,
		observed: AttestationListPublication
	): Promise<MaintenanceProgress> {
		if (
			this.context.offboarding ||
			observed.state.status !== 'ready' ||
			observed.state.key === undefined
		) {
			return 'stalled';
		}
		const key = observed.state.key;
		return this.context.criticalSection(async () => {
			const repository = new AttestationListRevisionRepository(
				this.context.d1,
				this.context.requireTenant()
			);
			const current = await repository.publicationsFor(cache, [hash]);
			if (!isSameListPublication(observed, current.get(hash))) {
				return 'stalled';
			}
			const object = await this.context.env.BLOBS.head(key);
			if (
				object !== null &&
				isObjectOfListPublication(object, { access: 'private' }, observed)
			) {
				return 'stalled';
			}
			if (!(await repository.invalidatePublication(cache, hash, observed))) {
				return 'stalled';
			}
			await this.requestWake();
			return 'progressed';
		});
	}

	async advance(): Promise<MaintenanceProgress> {
		if (
			this.context.offboarding ||
			!hasSubrequestsFor(7) ||
			concurrentRefreshes.size >= 4
		) {
			return 'stalled';
		}
		const repository = new AttestationListRevisionRepository(
			this.context.d1,
			this.context.requireTenant()
		);
		if (!(await repository.canRefresh())) {
			return 'stalled';
		}

		const token = crypto.randomUUID();
		const isClaimed = await this.context.criticalSection(() =>
			Promise.resolve(this.claim(token))
		);
		if (!isClaimed) {
			return 'stalled';
		}
		concurrentRefreshes.add(token);
		let shouldRelease = true;
		try {
			return await withDeadlineBudget(criticalSectionBudgetMs, () =>
				new ClaimedAttestationListRefresh(this.context, token).advanceOne()
			);
		} catch (error: unknown) {
			const timeout = causedBy(error, SubrequestTimeoutError);
			if (timeout?.abandoned !== undefined) {
				shouldRelease = false;
				this.context.ctx.waitUntil(this.releaseAfter(timeout.abandoned, token));
			}
			throw error;
		} finally {
			this.context.db
				.delete(schema.attestationListRefreshLease)
				.where(
					and(
						eq(schema.attestationListRefreshLease.id, 1),
						eq(schema.attestationListRefreshLease.owner, token)
					)
				)
				.run();
			if (shouldRelease) {
				concurrentRefreshes.delete(token);
			}
		}
	}
}
