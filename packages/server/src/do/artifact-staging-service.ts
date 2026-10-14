import { rootLogger } from '@cupboard/logger';
import { byCodeUnit } from '@cupboard/nix-store/store-path';
import {
	type ArtifactTaskClaim,
	artifactTaskGenerationSchema,
	artifactTaskSourceSchema
} from '@cupboard/protocol/artifact-jobs';
import {
	type ArtifactKind,
	maxArtifactBytes
} from '@cupboard/protocol/artifacts';
import { type IsoTimestamp, isoTimestamp } from '@cupboard/protocol/scalars';
import { and, asc, eq } from 'drizzle-orm';

import {
	type ArtifactStageId,
	artifactStageIdSchema,
	type ArtifactStageMeasurement,
	artifactStageMeasurementSchema,
	artifactStageObjectKey
} from '../blob/artifact-staging.ts';
import { lateWriteTombstoneHorizonMs } from '../blob/object-incarnation.ts';
import * as schema from '../db/schema.ts';
import { ArtifactTooLargeError } from '../errors.ts';
import { type R2ObjectKey } from '../http/http.ts';

import { ArtifactJobService } from './artifact-job-service.ts';
import type { ServerContext } from './context.ts';
import { PathReadAuthorityService } from './path-read-authority-service.ts';

const maximumReservations = 8;
const maximumReservedBytes = 128 * 1024 * 1024;
const producerWindowMs = 15 * 60 * 1000;
const cleanupRetryMs = 30_000;
const logger = rootLogger().with({ component: 'artifact-staging' });
type Stage = typeof schema.artifactStages.$inferSelect;

export interface ArtifactStageLease {
	readonly id: ArtifactStageId;
	readonly key: R2ObjectKey;
	readonly claim: ArtifactTaskClaim;
	readonly expiresAt: IsoTimestamp;
	readonly writeUntil: IsoTimestamp;
	readonly kind: ArtifactKind;
	readonly maximumBytes: number;
	readonly cleanupAfter: IsoTimestamp;
}
export type ArtifactStageReservation =
	| { readonly kind: 'reserved'; readonly lease: ArtifactStageLease }
	| { readonly kind: 'capacity'; readonly retryAt: IsoTimestamp }
	| { readonly kind: 'unavailable' };
export interface MeasuredArtifactStage extends ArtifactStageMeasurement {
	readonly key: R2ObjectKey;
}
export interface ArtifactStageCollection {
	readonly removed: number;
	readonly pending: boolean;
	readonly nextWakeAt?: IsoTimestamp;
}

export class ArtifactStageMeasurementConflictError extends Error {
	constructor() {
		super('The artifact staging measurement conflicts with its sealed bytes');
		this.name = 'ArtifactStageMeasurementConflictError';
	}
}

export class ArtifactStagingService {
	constructor(private readonly context: ServerContext) {}
	private rows(): Stage[] {
		return this.context.db
			.select()
			.from(schema.artifactStages)
			.orderBy(
				asc(schema.artifactStages.createdAt),
				asc(schema.artifactStages.id)
			)
			.limit(maximumReservations + 1)
			.all();
	}
	private rowFor(lease: ArtifactStageLease): Stage | undefined {
		const row = this.context.db
			.select()
			.from(schema.artifactStages)
			.where(eq(schema.artifactStages.id, lease.id))
			.get();
		const claim = lease.claim;
		if (
			row?.r2Key !== lease.key ||
			row.jobId !== claim.jobId ||
			row.jobGeneration !== claim.jobGeneration ||
			row.taskId !== claim.id ||
			row.taskGeneration !== claim.generation ||
			row.owner !== claim.owner ||
			row.cacheGeneration !== claim.cacheGeneration ||
			row.sourceKey !==
				JSON.stringify(artifactTaskSourceSchema.parse(claim.source)) ||
			row.kind !== lease.kind ||
			row.maximumBytes !== lease.maximumBytes ||
			row.writeUntil !== lease.writeUntil
		) {
			return;
		}
		return row;
	}
	private taskDeadline(row: Stage): IsoTimestamp | undefined {
		const cache = this.context.db
			.select()
			.from(schema.cacheIdentities)
			.where(eq(schema.cacheIdentities.id, row.cacheId))
			.get();
		if (cache?.deletedAt !== null || cache.generation !== row.cacheGeneration) {
			return;
		}
		const task = this.context.db
			.select()
			.from(schema.artifactTasks)
			.where(eq(schema.artifactTasks.id, row.taskId))
			.get();
		if (task?.leaseExpiresAt === null || task?.leaseExpiresAt === undefined) {
			return;
		}
		return new ArtifactJobService(this.context).claimDeadlineInSection({
			id: row.taskId,
			generation: artifactTaskGenerationSchema.parse(row.taskGeneration),
			jobId: row.jobId,
			jobGeneration: row.jobGeneration,
			owner: row.owner,
			cacheGeneration: row.cacheGeneration,
			source: task.source,
			leaseExpiresAt: task.leaseExpiresAt
		});
	}
	private active(row: Stage): boolean {
		const now = isoTimestamp(new Date());
		return (
			row.state !== 'retired' &&
			row.expiresAt > now &&
			row.writeUntil > now &&
			this.taskDeadline(row) !== undefined
		);
	}
	private lease(row: Stage, claim: ArtifactTaskClaim): ArtifactStageLease {
		return {
			id: row.id,
			key: row.r2Key,
			claim,
			expiresAt: row.expiresAt,
			writeUntil: row.writeUntil,
			kind: row.kind,
			maximumBytes: row.maximumBytes,
			cleanupAfter: row.cleanupAfter
		};
	}
	private retire(row: Stage): void {
		if (row.state === 'retired') {
			return;
		}
		const cleanupAfter = row.writesSealed
			? isoTimestamp(new Date())
			: row.cleanupAfter;
		this.context.db
			.update(schema.artifactStages)
			.set({ state: 'retired', cleanupAfter, nextCleanupAt: cleanupAfter })
			.where(eq(schema.artifactStages.id, row.id))
			.run();
	}
	private cleanupPlanInSection(): Stage[] {
		for (const row of this.rows()) {
			if (row.state !== 'retired' && !this.active(row)) {
				this.retire(row);
			}
		}
		const now = isoTimestamp(new Date());
		return this.rows().filter(
			(row) => row.state === 'retired' && row.nextCleanupAt <= now
		);
	}
	private collectionInSection(removed: number): ArtifactStageCollection {
		const rows = this.rows();
		const nextWakeAt = rows
			.map((row) =>
				row.state === 'retired' ? row.nextCleanupAt : row.expiresAt
			)
			.toSorted(byCodeUnit)[0];
		return {
			removed,
			pending: rows.length > 0,
			...(nextWakeAt !== undefined && { nextWakeAt })
		};
	}
	private cleanupFilter(row: Stage) {
		return and(
			eq(schema.artifactStages.id, row.id),
			eq(schema.artifactStages.state, 'retired')
		);
	}
	private acknowledgeCleanupInSection(row: Stage): number {
		return this.context.db
			.delete(schema.artifactStages)
			.where(this.cleanupFilter(row))
			.returning({ id: schema.artifactStages.id })
			.all().length;
	}
	private deferCleanupInSection(row: Stage): void {
		const nextCleanupAt = isoTimestamp(new Date(Date.now() + cleanupRetryMs));
		this.context.db
			.update(schema.artifactStages)
			.set({ nextCleanupAt })
			.where(this.cleanupFilter(row))
			.run();
	}
	private taskStage(claim: ArtifactTaskClaim): Stage | undefined {
		return this.context.db
			.select()
			.from(schema.artifactStages)
			.where(
				and(
					eq(schema.artifactStages.taskId, claim.id),
					eq(schema.artifactStages.taskGeneration, claim.generation)
				)
			)
			.get();
	}
	findInSection(claim: ArtifactTaskClaim): ArtifactStageLease | undefined {
		if (
			new ArtifactJobService(this.context).claimDeadlineInSection(claim) ===
			undefined
		) {
			return;
		}
		const row = this.taskStage(claim);
		return row !== undefined && this.active(row)
			? this.lease(row, claim)
			: undefined;
	}
	async reserveInSection(
		claim: ArtifactTaskClaim
	): Promise<ArtifactStageReservation> {
		await new PathReadAuthorityService(this.context).requireWritable();
		const jobs = new ArtifactJobService(this.context);
		const expiresAt = jobs.claimDeadlineInSection(claim);
		const job = jobs.summaryInSection(claim.jobId);
		if (expiresAt === undefined || job === undefined) {
			return { kind: 'unavailable' };
		}
		const existing = this.taskStage(claim);
		if (existing !== undefined) {
			if (!this.active(existing)) {
				this.retire(existing);
				return { kind: 'unavailable' };
			}
			return { kind: 'reserved', lease: this.lease(existing, claim) };
		}
		const rows = this.rows();
		const maximumBytes = maxArtifactBytes[job.definition.kind];
		if (
			rows.length >= maximumReservations ||
			rows.reduce((total, row) => total + row.maximumBytes, 0) + maximumBytes >
				maximumReservedBytes
		) {
			const retryAt = rows
				.map((row) =>
					row.state === 'retired' ? row.nextCleanupAt : row.expiresAt
				)
				.toSorted(byCodeUnit)[0];
			if (retryAt === undefined) {
				throw new Error('The artifact staging capacity record is missing');
			}
			return { kind: 'capacity', retryAt };
		}
		const now = Date.now();
		const id = artifactStageIdSchema.parse(crypto.randomUUID());
		const cleanupAfter = isoTimestamp(
			new Date(now + lateWriteTombstoneHorizonMs)
		);
		const cache = this.context.cacheRepository.require(job.cache);
		const inserted = this.context.db
			.insert(schema.artifactStages)
			.values({
				id,
				r2Key: artifactStageObjectKey(this.context.requireTenant(), id),
				cacheId: cache.id,
				cacheGeneration: claim.cacheGeneration,
				jobId: claim.jobId,
				jobGeneration: claim.jobGeneration,
				taskId: claim.id,
				taskGeneration: claim.generation,
				sourceKey: JSON.stringify(artifactTaskSourceSchema.parse(claim.source)),
				owner: claim.owner,
				kind: job.definition.kind,
				maximumBytes,
				state: 'pending',
				createdAt: isoTimestamp(new Date(now)),
				expiresAt,
				writeUntil: isoTimestamp(new Date(now + producerWindowMs)),
				cleanupAfter,
				nextCleanupAt: cleanupAfter
			})
			.returning()
			.all()[0];
		if (inserted === undefined) {
			throw new Error('The artifact staging reservation was not created');
		}
		return { kind: 'reserved', lease: this.lease(inserted, claim) };
	}
	registerMultipartInSection(
		lease: ArtifactStageLease,
		multipartId: string
	): boolean {
		if (multipartId.length === 0) {
			throw new Error('The artifact multipart upload ID is empty');
		}
		const row = this.rowFor(lease);
		if (
			row === undefined ||
			row.writesSealed ||
			(row.multipartId !== null && row.multipartId !== multipartId)
		) {
			return false;
		}
		this.context.db
			.update(schema.artifactStages)
			.set({ multipartId })
			.where(eq(schema.artifactStages.id, row.id))
			.run();
		return this.active(row);
	}
	async sealInSection(
		lease: ArtifactStageLease,
		multipartId: string,
		input: ArtifactStageMeasurement
	): Promise<boolean> {
		const row = this.rowFor(lease);
		if (row?.multipartId !== multipartId) {
			return false;
		}
		const measurement = artifactStageMeasurementSchema.parse(input);
		if (measurement.size > row.maximumBytes) {
			throw new ArtifactTooLargeError(
				row.kind,
				measurement.size,
				row.maximumBytes
			);
		}
		if (row.writesSealed) {
			if (row.digest !== measurement.digest || row.size !== measurement.size) {
				throw new ArtifactStageMeasurementConflictError();
			}
			return this.active(row);
		}
		const head = await this.context.env.BLOBS.head(row.r2Key);
		if (head?.size !== measurement.size) {
			return false;
		}
		const isActive = this.active(row);
		const now = isoTimestamp(new Date());
		this.context.db
			.update(schema.artifactStages)
			.set({
				writesSealed: true,
				...measurement,
				state: isActive ? 'ready' : 'retired',
				...(!isActive && { cleanupAfter: now, nextCleanupAt: now })
			})
			.where(eq(schema.artifactStages.id, row.id))
			.run();
		return isActive;
	}
	readyInSection(lease: ArtifactStageLease): MeasuredArtifactStage | undefined {
		const row = this.rowFor(lease);
		if (
			row?.state !== 'ready' ||
			row.digest === null ||
			row.size === null ||
			!this.active(row)
		) {
			return;
		}
		return { key: row.r2Key, digest: row.digest, size: row.size };
	}

	deadlineInSection(lease: ArtifactStageLease): IsoTimestamp | undefined {
		const row = this.rowFor(lease);
		return row !== undefined && this.active(row) ? row.expiresAt : undefined;
	}
	renewInSection(lease: ArtifactStageLease): IsoTimestamp | undefined {
		const row = this.rowFor(lease);
		if (row === undefined || !this.active(row)) {
			return;
		}
		const deadline = this.taskDeadline(row);
		if (deadline === undefined) {
			return;
		}
		const deadlineMs = Date.parse(deadline);
		const writeUntilMs = Date.parse(row.writeUntil);
		const expiresAt = isoTimestamp(
			new Date(Math.min(deadlineMs, writeUntilMs))
		);
		this.context.db
			.update(schema.artifactStages)
			.set({ expiresAt })
			.where(eq(schema.artifactStages.id, row.id))
			.run();
		return expiresAt;
	}
	retireInSection(lease: ArtifactStageLease): boolean {
		const row = this.rowFor(lease);
		if (row === undefined) {
			return false;
		}
		this.retire(row);
		return true;
	}
	async collect(): Promise<ArtifactStageCollection> {
		const plan = await this.context.criticalSection(() =>
			Promise.resolve(this.cleanupPlanInSection())
		);
		let removed = 0;
		for (const row of plan) {
			try {
				if (!row.writesSealed && row.multipartId !== null) {
					await this.context.env.BLOBS.resumeMultipartUpload(
						row.r2Key,
						row.multipartId
					).abort();
				}
				await this.context.env.BLOBS.delete(row.r2Key);
				removed += await this.context.criticalSection(() =>
					Promise.resolve(this.acknowledgeCleanupInSection(row))
				);
			} catch (error) {
				logger.warn('artifact staging cleanup failed; retry scheduled', {
					stageId: row.id,
					error
				});
				await this.context.criticalSection(() => {
					this.deferCleanupInSection(row);
					return Promise.resolve();
				});
			}
		}
		return this.context.criticalSection(() =>
			Promise.resolve(this.collectionInSection(removed))
		);
	}
}
