import { type ArtifactTaskOwner } from '@cupboard/protocol/artifact-jobs';
import { maxArtifactBytes } from '@cupboard/protocol/artifacts';
import { type IsoTimestamp, isoTimestamp } from '@cupboard/protocol/scalars';
import {
	and,
	asc,
	eq,
	exists,
	gt,
	isNull,
	lt,
	lte,
	notExists,
	or,
	sql
} from 'drizzle-orm';
import { type DrizzleD1Database } from 'drizzle-orm/d1';

import {
	artifactMultipartIdSchema,
	type ArtifactStageId,
	artifactStageIdSchema,
	type ArtifactStageMeasurement,
	artifactStageMeasurementSchema
} from '../blob/artifact-staging.ts';
import {
	type ForwardListingSource,
	forwardListingSourceSchema,
	ForwardListingStageConflictError,
	type ForwardListingStageLease,
	forwardListingStageLeaseSchema,
	type ForwardListingStageReservation
} from '../blob/forward-listing-staging.ts';
import { lateWriteTombstoneHorizonMs } from '../blob/object-incarnation.ts';
import {
	type SharedListingGenerationClaim,
	sharedListingGenerationClaimSchema
} from '../blob/shared-listing-generation.ts';
import {
	type SharedListingStageCleanupClaim,
	sharedListingStageCleanupClaimSchema,
	type SharedListingStageCleanupCursor,
	sharedListingStageKey,
	sharedListingStageLeaseSchema,
	type SharedListingStageReservation
} from '../blob/shared-listing-staging.ts';
import {
	ArtifactTooLargeError,
	SharedFactsUnavailableError
} from '../errors.ts';

import * as schema from './d1-schema.ts';
import { SharedListingGenerationStore } from './shared-listing-generation.ts';

const table = schema.forwardListingStage;
const writeWindowMs = 15 * 60_000;
const cleanupLeaseMs = 30_000;
const cleanupPageSize = 8;
type Stage = typeof table.$inferSelect;

export class ForwardListingStageStore {
	constructor(private readonly database: DrizzleD1Database<typeof schema>) {}
	private async execute<T>(operation: () => Promise<T>): Promise<T> {
		try {
			return await operation();
		} catch (error) {
			if (
				error instanceof SharedFactsUnavailableError ||
				error instanceof ForwardListingStageConflictError ||
				error instanceof ArtifactTooLargeError
			) {
				throw error;
			}
			throw new SharedFactsUnavailableError(error);
		}
	}
	private readyQuery() {
		return this.database
			.select({ one: sql`1` })
			.from(schema.deploymentTransition)
			.where(
				and(
					eq(schema.deploymentTransition.id, 'forward-listing-staging'),
					eq(schema.deploymentTransition.state, 'complete')
				)
			);
	}
	private sourceIdentity(source: ForwardListingSource) {
		return and(
			eq(table.tenant, source.tenant),
			eq(table.uploadId, source.uploadId),
			eq(table.owner, source.owner),
			eq(table.narHash, source.narHash),
			eq(table.generatorRevision, source.generatorRevision)
		);
	}
	private inputIdentity(
		source: Pick<ForwardListingSource, 'narHash' | 'generatorRevision'>
	) {
		return and(
			eq(table.narHash, source.narHash),
			eq(table.generatorRevision, source.generatorRevision)
		);
	}
	// Keep this literal predicate in input queries so SQLite can use the partial index.
	private active() {
		return sql`${table.state} <> 'retired'`;
	}
	private captured(lease: ForwardListingStageLease) {
		return and(
			eq(table.id, lease.id),
			eq(table.r2Key, lease.key),
			eq(table.writeUntil, lease.writeUntil),
			this.sourceIdentity(lease.source)
		);
	}
	private current(lease: ForwardListingStageLease, now: IsoTimestamp) {
		return and(
			this.captured(lease),
			this.active(),
			gt(table.writeUntil, now),
			eq(table.cleanupGeneration, 0),
			exists(this.readyQuery())
		);
	}
	private reservation(row: Stage): ForwardListingStageReservation {
		if (row.state === 'retired') {
			return { kind: 'unavailable' };
		}
		const lease = forwardListingStageLeaseSchema.parse({
			id: row.id,
			key: row.r2Key,
			source: {
				tenant: row.tenant,
				uploadId: row.uploadId,
				owner: row.owner,
				narHash: row.narHash,
				generatorRevision: row.generatorRevision
			},
			maximumBytes: row.maximumBytes,
			writeUntil: row.writeUntil,
			cleanupAfter: row.cleanupAfter
		});
		if (
			row.state === 'ready' &&
			row.multipartId !== null &&
			row.digest !== null &&
			row.size !== null
		) {
			return {
				kind: 'ready',
				lease,
				multipartId: row.multipartId,
				measurement: artifactStageMeasurementSchema.parse({
					digest: row.digest,
					size: row.size
				})
			};
		}
		return {
			kind: 'writing',
			lease,
			...(row.multipartId !== null && { multipartId: row.multipartId })
		};
	}
	private cleanupIdentity(claim: SharedListingStageCleanupClaim) {
		return and(
			eq(table.id, claim.id),
			eq(table.r2Key, claim.key),
			eq(table.state, 'retired'),
			eq(table.cleanupGeneration, claim.generation),
			eq(table.cleanupOwner, claim.owner)
		);
	}
	private cleanupCurrent(
		claim: SharedListingStageCleanupClaim,
		now: IsoTimestamp
	) {
		return and(
			this.cleanupIdentity(claim),
			gt(table.cleanupLeaseExpiresAt, now)
		);
	}
	private cleanupClaim(row: Stage): SharedListingStageCleanupClaim {
		return sharedListingStageCleanupClaimSchema.parse({
			id: row.id,
			key: row.r2Key,
			generation: row.cleanupGeneration,
			owner: row.cleanupOwner,
			leaseExpiresAt: row.cleanupLeaseExpiresAt,
			...(!row.writesSealed &&
				row.multipartId !== null && { multipartId: row.multipartId })
		});
	}
	async reserve(
		input: ForwardListingSource,
		now: IsoTimestamp
	): Promise<ForwardListingStageReservation> {
		const source = forwardListingSourceSchema.parse(input);
		return this.execute(async () => {
			if ((await this.readyQuery().get()) === undefined) {
				return { kind: 'unavailable' };
			}
			const id = artifactStageIdSchema.parse(crypto.randomUUID());
			const key = sharedListingStageKey(id);
			const writeUntil = isoTimestamp(
				new Date(Date.parse(now) + writeWindowMs)
			);
			const cleanupAfter = isoTimestamp(
				new Date(Date.parse(now) + lateWriteTombstoneHorizonMs)
			);
			const expired = or(
				and(eq(table.state, 'pending'), lte(table.writeUntil, now)),
				and(eq(table.state, 'ready'), lte(table.cleanupAfter, now))
			);
			const retiredCleanup = sql<IsoTimestamp>`CASE WHEN ${table.writesSealed}=1 THEN ${now} ELSE max(${table.cleanupAfter},${now}) END`;
			const retire = this.database
				.update(table)
				.set({
					state: 'retired',
					cleanupAfter: retiredCleanup,
					nextCleanupAt: retiredCleanup
				})
				.where(and(this.inputIdentity(source), this.active(), expired));
			const active = this.database
				.select({ id: table.id })
				.from(table)
				.where(and(this.inputIdentity(source), this.active()));
			const mayReserve = and(exists(this.readyQuery()), notExists(active));
			const selected = this.database
				.select({
					id: sql<ArtifactStageId>`${id}`.as('id'),
					tenant: sql<typeof source.tenant>`${source.tenant}`.as('tenant'),
					uploadId: sql<typeof source.uploadId>`${source.uploadId}`.as(
						'upload_id'
					),
					owner: sql<string>`${source.owner}`.as('owner'),
					narHash: sql<typeof source.narHash>`${source.narHash}`.as('nar_hash'),
					generatorRevision: sql<
						typeof source.generatorRevision
					>`${source.generatorRevision}`.as('generator_revision'),
					r2Key: sql<typeof key>`${key}`.as('r2_key'),
					maximumBytes: sql<number>`${maxArtifactBytes.listing}`.as(
						'maximum_bytes'
					),
					state: sql<Stage['state']>`'pending'`.as('state'),
					multipartId: sql<string | null>`null`.as('multipart_id'),
					writesSealed: sql<boolean>`0`.as('writes_sealed'),
					digest: sql<Stage['digest']>`null`.as('digest'),
					size: sql<number | null>`null`.as('size'),
					createdAt: sql<IsoTimestamp>`${now}`.as('created_at'),
					writeUntil: sql<IsoTimestamp>`${writeUntil}`.as('write_until'),
					cleanupAfter: sql<IsoTimestamp>`${cleanupAfter}`.as('cleanup_after'),
					nextCleanupAt: sql<IsoTimestamp>`${writeUntil}`.as('next_cleanup_at'),
					cleanupGeneration: sql<number>`0`.as('cleanup_generation'),
					cleanupOwner: sql<ArtifactTaskOwner | null>`null`.as('cleanup_owner'),
					cleanupLeaseExpiresAt: sql<IsoTimestamp | null>`null`.as(
						'cleanup_lease_expires_at'
					)
				})
				.from(sql`(SELECT 1) AS singleton`)
				.where(mayReserve);
			const insert = this.database
				.insert(table)
				.select(selected)
				.onConflictDoNothing();
			await this.database.batch([retire, insert]);
			const own = await this.database
				.select()
				.from(table)
				.where(this.sourceIdentity(source))
				.get();
			if (own !== undefined) {
				return this.reservation(own);
			}
			const competing = await this.database
				.select({
					state: table.state,
					writeUntil: table.writeUntil,
					cleanupAfter: table.cleanupAfter
				})
				.from(table)
				.where(and(this.inputIdentity(source), this.active()))
				.get();
			return competing === undefined
				? { kind: 'unavailable' }
				: {
						kind: 'busy',
						retryAt:
							competing.state === 'ready'
								? competing.cleanupAfter
								: competing.writeUntil
					};
		});
	}
	async find(
		input: ForwardListingSource
	): Promise<ForwardListingStageReservation> {
		const source = forwardListingSourceSchema.parse(input);
		return this.execute(async () => {
			const row = await this.database
				.select()
				.from(table)
				.where(this.sourceIdentity(source))
				.get();
			return row === undefined
				? { kind: 'unavailable' }
				: this.reservation(row);
		});
	}
	async canWrite(
		input: ForwardListingStageLease,
		now: IsoTimestamp
	): Promise<boolean> {
		const lease = forwardListingStageLeaseSchema.parse(input);
		return this.execute(async () => {
			const row = await this.database
				.select({ id: table.id })
				.from(table)
				.where(and(this.current(lease, now), eq(table.writesSealed, false)))
				.get();
			return row !== undefined;
		});
	}

	async registerMultipart(
		input: ForwardListingStageLease,
		inputId: string,
		now: IsoTimestamp
	): Promise<boolean> {
		const lease = forwardListingStageLeaseSchema.parse(input);
		const id = artifactMultipartIdSchema.parse(inputId);
		return this.execute(async () => {
			const available = and(
				this.captured(lease),
				eq(table.writesSealed, false),
				eq(table.cleanupGeneration, 0),
				or(isNull(table.multipartId), eq(table.multipartId, id))
			);
			await this.database
				.update(table)
				.set({ multipartId: id })
				.where(available);
			const row = await this.database
				.select({ id: table.id })
				.from(table)
				.where(
					and(
						this.current(lease, now),
						eq(table.writesSealed, false),
						eq(table.multipartId, id)
					)
				)
				.get();
			return row !== undefined;
		});
	}
	async recordSeal(
		input: ForwardListingStageLease,
		inputId: string,
		inputMeasurement: ArtifactStageMeasurement,
		now: IsoTimestamp
	): Promise<boolean> {
		const lease = forwardListingStageLeaseSchema.parse(input);
		const id = artifactMultipartIdSchema.parse(inputId);
		const measurement = artifactStageMeasurementSchema.parse(inputMeasurement);
		return this.execute(async () => {
			const captured = and(this.captured(lease), eq(table.multipartId, id));
			const row = await this.database
				.select()
				.from(table)
				.where(captured)
				.get();
			if (row === undefined) {
				return false;
			}
			if (measurement.size > row.maximumBytes) {
				throw new ArtifactTooLargeError(
					'listing',
					measurement.size,
					row.maximumBytes
				);
			}
			if (
				row.writesSealed &&
				(row.digest !== measurement.digest || row.size !== measurement.size)
			) {
				throw new ForwardListingStageConflictError();
			}
			const unsealed = and(
				captured,
				eq(table.writesSealed, false),
				eq(table.cleanupGeneration, 0)
			);
			const seal = this.database
				.update(table)
				.set({
					...measurement,
					writesSealed: true,
					state: 'ready',
					nextCleanupAt: table.cleanupAfter
				})
				.where(and(unsealed, this.current(lease, now)));
			const late = this.database
				.update(table)
				.set({
					...measurement,
					writesSealed: true,
					state: 'retired',
					cleanupAfter: now,
					nextCleanupAt: now
				})
				.where(unsealed);
			await this.database.batch([seal, late]);
			const observed = await this.database
				.select({
					state: table.state,
					writesSealed: table.writesSealed,
					digest: table.digest,
					size: table.size,
					isCurrent: sql<boolean>`(${this.current(lease, now)})`.mapWith(
						Boolean
					)
				})
				.from(table)
				.where(captured)
				.get();
			if (
				observed?.writesSealed &&
				(observed.digest !== measurement.digest ||
					observed.size !== measurement.size)
			) {
				throw new ForwardListingStageConflictError();
			}
			return observed?.state === 'ready' && observed.isCurrent;
		});
	}
	async retire(
		input: ForwardListingStageLease,
		now: IsoTimestamp,
		inputMultipartId: string | undefined
	): Promise<boolean> {
		const lease = forwardListingStageLeaseSchema.parse(input);
		const multipartId = artifactMultipartIdSchema
			.optional()
			.parse(inputMultipartId);
		return this.execute(async () => {
			const cleanup = sql<IsoTimestamp>`CASE WHEN ${table.state}='retired' THEN ${table.cleanupAfter} WHEN ${table.writesSealed}=1 THEN ${now} ELSE max(${table.cleanupAfter},${now}) END`;
			const rows = await this.database
				.update(table)
				.set({
					state: 'retired',
					cleanupAfter: cleanup,
					nextCleanupAt: sql`CASE WHEN ${table.state}='retired' THEN ${table.nextCleanupAt} ELSE ${cleanup} END`
				})
				.where(
					and(
						this.captured(lease),
						eq(table.cleanupGeneration, 0),
						multipartId === undefined
							? isNull(table.multipartId)
							: eq(table.multipartId, multipartId)
					)
				)
				.returning({ id: table.id });
			return rows.length === 1;
		});
	}
	async adopt(
		input: SharedListingGenerationClaim,
		now: IsoTimestamp
	): Promise<SharedListingStageReservation> {
		const claim = sharedListingGenerationClaimSchema.parse(input);
		return this.execute(async () => {
			if ((await this.readyQuery().get()) === undefined) {
				return { kind: 'unavailable' };
			}
			const target = schema.sharedListingStage;
			const generation = schema.sharedListingGeneration;
			const owns = new SharedListingGenerationStore(this.database).owns(
				claim,
				now
			);
			const computation = this.database
				.select({ one: sql`1` })
				.from(generation)
				.where(owns);
			const deadline = this.database
				.select({ at: generation.leaseExpiresAt })
				.from(generation)
				.where(owns);
			const targetIdentity = and(
				eq(target.narHash, claim.task.narHash),
				eq(target.generatorRevision, claim.task.generatorRevision),
				eq(target.sourceIncarnation, claim.task.sourceIncarnation),
				eq(target.computationGeneration, claim.generation)
			);
			const occupied = this.database
				.select({ id: target.id })
				.from(target)
				.where(targetIdentity);
			const eligible = and(
				this.inputIdentity(claim.task),
				this.active(),
				eq(table.state, 'ready'),
				eq(table.cleanupGeneration, 0),
				gt(table.cleanupAfter, now),
				exists(this.readyQuery()),
				exists(computation),
				notExists(occupied)
			);
			const writeUntil = isoTimestamp(
				new Date(Date.parse(now) + writeWindowMs)
			);
			const horizon = isoTimestamp(
				new Date(Date.parse(now) + lateWriteTombstoneHorizonMs)
			);
			const selected = this.database
				.select({
					id: table.id,
					narHash: table.narHash,
					generatorRevision: table.generatorRevision,
					sourceIncarnation: sql<number>`${claim.task.sourceIncarnation}`.as(
						'source_incarnation'
					),
					computationGeneration: sql<number>`${claim.generation}`.as(
						'computation_generation'
					),
					r2Key: table.r2Key,
					maximumBytes: table.maximumBytes,
					state: sql<'ready'>`'ready'`.as('state'),
					multipartId: table.multipartId,
					writesSealed: table.writesSealed,
					digest: table.digest,
					size: table.size,
					createdAt: table.createdAt,
					expiresAt: sql<IsoTimestamp>`(${deadline})`.as('expires_at'),
					writeUntil: sql<IsoTimestamp>`${writeUntil}`.as('write_until'),
					cleanupAfter:
						sql<IsoTimestamp>`max(${table.cleanupAfter},${horizon})`.as(
							'cleanup_after'
						),
					nextCleanupAt:
						sql<IsoTimestamp>`max(${table.cleanupAfter},${horizon})`.as(
							'next_cleanup_at'
						),
					cleanupGeneration: sql<number>`0`.as('cleanup_generation'),
					cleanupOwner: sql<ArtifactTaskOwner | null>`null`.as('cleanup_owner'),
					cleanupLeaseExpiresAt: sql<IsoTimestamp | null>`null`.as(
						'cleanup_lease_expires_at'
					)
				})
				.from(table)
				.where(eligible);
			const insert = this.database
				.insert(target)
				.select(selected)
				.onConflictDoNothing();
			const transferred = this.database
				.select({ id: target.id })
				.from(target)
				.where(
					and(
						targetIdentity,
						eq(target.id, table.id),
						eq(target.r2Key, table.r2Key),
						eq(target.multipartId, table.multipartId),
						eq(target.digest, table.digest),
						eq(target.size, table.size),
						eq(target.state, 'ready')
					)
				);
			const remove = this.database
				.delete(table)
				.where(
					and(
						this.inputIdentity(claim.task),
						this.active(),
						eq(table.state, 'ready'),
						eq(table.cleanupGeneration, 0),
						exists(transferred),
						exists(computation)
					)
				);
			await this.database.batch([insert, remove]);
			const row = await this.database
				.select()
				.from(target)
				.where(
					and(
						targetIdentity,
						eq(target.state, 'ready'),
						gt(target.expiresAt, now),
						gt(target.writeUntil, now),
						exists(computation)
					)
				)
				.get();
			if (row === undefined) {
				return { kind: 'unavailable' };
			}
			return {
				kind: 'ready',
				lease: sharedListingStageLeaseSchema.parse({
					id: row.id,
					key: row.r2Key,
					claim,
					maximumBytes: row.maximumBytes,
					expiresAt: row.expiresAt,
					writeUntil: row.writeUntil,
					cleanupAfter: row.cleanupAfter
				}),
				multipartId: artifactMultipartIdSchema.parse(row.multipartId),
				measurement: artifactStageMeasurementSchema.parse({
					digest: row.digest,
					size: row.size
				})
			};
		});
	}
	async due(
		now: IsoTimestamp,
		after?: SharedListingStageCleanupCursor
	): Promise<{
		readonly stages: readonly ArtifactStageId[];
		readonly hasMore: boolean;
		readonly next?: SharedListingStageCleanupCursor;
	}> {
		return this.execute(async () => {
			const beyond =
				after === undefined
					? undefined
					: sql`(${table.nextCleanupAt},${table.id})>(${after.at},${after.id})`;
			const eligible = and(lte(table.nextCleanupAt, now), beyond);
			const [rows] = await this.database.batch([
				this.database
					.select({ id: table.id, at: table.nextCleanupAt })
					.from(table)
					.where(eligible)
					.orderBy(asc(table.nextCleanupAt), asc(table.id))
					.limit(cleanupPageSize + 1)
			]);
			const hasMore = rows.length > cleanupPageSize;
			const last = rows[cleanupPageSize - 1];
			return {
				stages: rows.slice(0, cleanupPageSize).map((row) => row.id),
				hasMore,
				...(hasMore && last !== undefined && { next: last })
			};
		});
	}
	async claimCleanup(
		id: ArtifactStageId,
		owner: ArtifactTaskOwner,
		now: IsoTimestamp
	): Promise<SharedListingStageCleanupClaim | undefined> {
		const deadline = isoTimestamp(new Date(Date.parse(now) + cleanupLeaseMs));
		return this.execute(async () => {
			const expired = or(
				and(eq(table.state, 'pending'), lte(table.writeUntil, now)),
				and(eq(table.state, 'ready'), lte(table.cleanupAfter, now))
			);
			const cleanup = sql<IsoTimestamp>`CASE WHEN ${table.writesSealed}=1 THEN ${now} ELSE ${table.cleanupAfter} END`;
			const retire = this.database
				.update(table)
				.set({
					state: 'retired',
					cleanupAfter: cleanup,
					nextCleanupAt: cleanup
				})
				.where(and(eq(table.id, id), expired));
			const available = and(
				eq(table.id, id),
				eq(table.state, 'retired'),
				lte(table.cleanupAfter, now),
				lte(table.nextCleanupAt, now),
				lt(table.cleanupGeneration, Number.MAX_SAFE_INTEGER),
				or(
					isNull(table.cleanupLeaseExpiresAt),
					lte(table.cleanupLeaseExpiresAt, now)
				)
			);
			const claim = this.database
				.update(table)
				.set({
					cleanupGeneration: sql`${table.cleanupGeneration}+1`,
					cleanupOwner: owner,
					cleanupLeaseExpiresAt: deadline,
					nextCleanupAt: deadline
				})
				.where(available)
				.returning();
			const [, rows] = await this.database.batch([retire, claim]);
			if (rows[0] !== undefined) {
				return this.cleanupClaim(rows[0]);
			}
			const row = await this.database
				.select()
				.from(table)
				.where(
					and(
						eq(table.id, id),
						eq(table.state, 'retired'),
						eq(table.cleanupOwner, owner),
						gt(table.cleanupLeaseExpiresAt, now)
					)
				)
				.get();
			return row === undefined ? undefined : this.cleanupClaim(row);
		});
	}
	async acknowledgeCleanup(
		claim: SharedListingStageCleanupClaim,
		now: IsoTimestamp
	): Promise<boolean> {
		return this.execute(async () => {
			const rows = await this.database
				.delete(table)
				.where(this.cleanupCurrent(claim, now))
				.returning({ id: table.id });
			return rows.length === 1;
		});
	}
	async deferCleanup(
		claim: SharedListingStageCleanupClaim,
		now: IsoTimestamp
	): Promise<IsoTimestamp | undefined> {
		return this.execute(async () => {
			const retryAt = isoTimestamp(new Date(Date.parse(now) + cleanupLeaseMs));
			const rows = await this.database
				.update(table)
				.set({ cleanupLeaseExpiresAt: sql`null`, nextCleanupAt: retryAt })
				.where(this.cleanupCurrent(claim, now))
				.returning({ at: table.nextCleanupAt });
			if (rows[0] !== undefined) {
				return rows[0].at;
			}
			const row = await this.database
				.select({ at: table.nextCleanupAt })
				.from(table)
				.where(
					and(this.cleanupIdentity(claim), isNull(table.cleanupLeaseExpiresAt))
				)
				.get();
			return row?.at;
		});
	}
}
