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
	ne,
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
import { lateWriteTombstoneHorizonMs } from '../blob/object-incarnation.ts';
import {
	type SharedListingGenerationClaim,
	sharedListingGenerationClaimSchema
} from '../blob/shared-listing-generation.ts';
import {
	type SharedListingStageCleanupClaim,
	sharedListingStageCleanupClaimSchema,
	type SharedListingStageCleanupCursor,
	SharedListingStageConflictError,
	sharedListingStageKey,
	type SharedListingStageLease,
	sharedListingStageLeaseSchema,
	type SharedListingStageReservation
} from '../blob/shared-listing-staging.ts';
import {
	ArtifactTooLargeError,
	SharedFactsUnavailableError
} from '../errors.ts';

import * as schema from './d1-schema.ts';
import { SharedListingGenerationStore } from './shared-listing-generation.ts';

const producerWindowMs = 15 * 60 * 1000;
const cleanupLeaseMs = 30_000;
const cleanupPageSize = 8;
type Stage = typeof schema.sharedListingStage.$inferSelect;

/**
 * Records provisional resources without cache authority. The caller must verify
 * completed R2 bytes before recording their sealed measurement. Physical cleanup
 * must finish before acknowledgement.
 */
export class SharedListingStageStore {
	constructor(private readonly database: DrizzleD1Database<typeof schema>) {}

	private async execute<T>(operation: () => Promise<T>): Promise<T> {
		try {
			return await operation();
		} catch (error) {
			if (
				error instanceof SharedFactsUnavailableError ||
				error instanceof SharedListingStageConflictError ||
				error instanceof ArtifactTooLargeError
			) {
				throw error;
			}
			throw new SharedFactsUnavailableError(error);
		}
	}

	private identity(claim: SharedListingGenerationClaim) {
		return and(
			eq(schema.sharedListingStage.narHash, claim.task.narHash),
			eq(
				schema.sharedListingStage.generatorRevision,
				claim.task.generatorRevision
			)
		);
	}
	private computation(claim: SharedListingGenerationClaim, now: IsoTimestamp) {
		return this.database
			.select({ one: sql`1` })
			.from(schema.sharedListingGeneration)
			.where(new SharedListingGenerationStore(this.database).owns(claim, now));
	}
	private computationDeadline(claim: SharedListingGenerationClaim) {
		return this.database
			.select({ at: schema.sharedListingGeneration.leaseExpiresAt })
			.from(schema.sharedListingGeneration)
			.where(
				and(
					eq(schema.sharedListingGeneration.narHash, claim.task.narHash),
					eq(
						schema.sharedListingGeneration.generatorRevision,
						claim.task.generatorRevision
					),
					eq(schema.sharedListingGeneration.generation, claim.generation)
				)
			);
	}

	private ownStage(claim: SharedListingGenerationClaim) {
		return and(
			this.identity(claim),
			eq(schema.sharedListingStage.computationGeneration, claim.generation)
		);
	}
	private captured(lease: SharedListingStageLease) {
		return and(
			this.ownStage(lease.claim),
			eq(schema.sharedListingStage.id, lease.id),
			eq(schema.sharedListingStage.r2Key, lease.key),
			eq(
				schema.sharedListingStage.sourceIncarnation,
				lease.claim.task.sourceIncarnation
			)
		);
	}
	private current(lease: SharedListingStageLease, now: IsoTimestamp) {
		return and(
			this.captured(lease),
			ne(schema.sharedListingStage.state, 'retired'),
			gt(schema.sharedListingStage.expiresAt, now),
			gt(schema.sharedListingStage.writeUntil, now),
			exists(this.computation(lease.claim, now))
		);
	}
	private reservation(
		row: Stage,
		claim: SharedListingGenerationClaim
	): SharedListingStageReservation {
		const lease = sharedListingStageLeaseSchema.parse({
			id: row.id,
			key: row.r2Key,
			claim,
			maximumBytes: row.maximumBytes,
			expiresAt: row.expiresAt,
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
			eq(schema.sharedListingStage.id, claim.id),
			eq(schema.sharedListingStage.r2Key, claim.key),
			eq(schema.sharedListingStage.state, 'retired'),
			eq(schema.sharedListingStage.cleanupGeneration, claim.generation),
			eq(schema.sharedListingStage.cleanupOwner, claim.owner)
		);
	}
	private cleanupCurrent(
		claim: SharedListingStageCleanupClaim,
		now: IsoTimestamp
	) {
		return and(
			this.cleanupIdentity(claim),
			gt(schema.sharedListingStage.cleanupLeaseExpiresAt, now)
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

	private async prepare(
		input: SharedListingGenerationClaim,
		now: IsoTimestamp,
		canCreate: boolean
	): Promise<SharedListingStageReservation> {
		const claim = sharedListingGenerationClaimSchema.parse(input);
		const id = artifactStageIdSchema.parse(crypto.randomUUID());
		const key = sharedListingStageKey(id);
		const writeUntil = isoTimestamp(
			new Date(Date.parse(now) + producerWindowMs)
		);
		const cleanupAfter = isoTimestamp(
			new Date(Date.parse(now) + lateWriteTombstoneHorizonMs)
		);
		return this.execute(async () => {
			const source = this.computation(claim, now);
			const deadline = this.computationDeadline(claim);
			const own = this.database
				.select({ one: sql`1` })
				.from(schema.sharedListingStage)
				.where(this.ownStage(claim));
			const reusable = this.database
				.select({ id: schema.sharedListingStage.id })
				.from(schema.sharedListingStage)
				.where(
					and(
						this.identity(claim),
						eq(schema.sharedListingStage.state, 'ready'),
						gt(schema.sharedListingStage.cleanupAfter, now)
					)
				)
				.orderBy(
					asc(schema.sharedListingStage.cleanupAfter),
					asc(schema.sharedListingStage.id)
				)
				.limit(1);
			const recovery = and(
				eq(schema.sharedListingStage.id, sql`(${reusable})`),
				lt(schema.sharedListingStage.computationGeneration, claim.generation),
				notExists(own),
				exists(source)
			);
			const adopt = this.database
				.update(schema.sharedListingStage)
				.set({
					sourceIncarnation: claim.task.sourceIncarnation,
					computationGeneration: claim.generation,
					expiresAt: sql`(${deadline})`,
					writeUntil,
					cleanupAfter: sql`max(${schema.sharedListingStage.cleanupAfter}, ${cleanupAfter})`,
					nextCleanupAt: sql`max(${schema.sharedListingStage.cleanupAfter}, ${cleanupAfter})`
				})
				.where(recovery);
			const selected = this.database
				.select({
					id: sql<ArtifactStageId>`${id}`.as('id'),
					narHash: schema.sharedListingGeneration.narHash,
					generatorRevision: schema.sharedListingGeneration.generatorRevision,
					sourceIncarnation: schema.sharedListingGeneration.sourceIncarnation,
					computationGeneration: schema.sharedListingGeneration.generation,
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
					expiresAt:
						sql<IsoTimestamp>`${schema.sharedListingGeneration.leaseExpiresAt}`.as(
							'expires_at'
						),
					writeUntil: sql<IsoTimestamp>`${writeUntil}`.as('write_until'),
					cleanupAfter: sql<IsoTimestamp>`${cleanupAfter}`.as('cleanup_after'),
					nextCleanupAt:
						sql<IsoTimestamp>`${schema.sharedListingGeneration.leaseExpiresAt}`.as(
							'next_cleanup_at'
						),
					cleanupGeneration: sql<number>`0`.as('cleanup_generation'),
					cleanupOwner: sql<ArtifactTaskOwner | null>`null`.as('cleanup_owner'),
					cleanupLeaseExpiresAt: sql<IsoTimestamp | null>`null`.as(
						'cleanup_lease_expires_at'
					)
				})
				.from(schema.sharedListingGeneration)
				.where(
					and(
						new SharedListingGenerationStore(this.database).owns(claim, now),
						notExists(own)
					)
				);
			const insert = this.database
				.insert(schema.sharedListingStage)
				.select(selected)
				.onConflictDoNothing({
					target: [
						schema.sharedListingStage.narHash,
						schema.sharedListingStage.generatorRevision,
						schema.sharedListingStage.computationGeneration
					]
				});
			await (canCreate
				? this.database.batch([adopt, insert])
				: this.database.batch([adopt]));
			const row = await this.database
				.select()
				.from(schema.sharedListingStage)
				.where(
					and(
						this.ownStage(claim),
						canCreate
							? ne(schema.sharedListingStage.state, 'retired')
							: eq(schema.sharedListingStage.state, 'ready'),
						gt(schema.sharedListingStage.expiresAt, now),
						gt(schema.sharedListingStage.writeUntil, now),
						exists(source)
					)
				)
				.get();
			return row === undefined
				? { kind: 'unavailable' }
				: this.reservation(row, claim);
		});
	}

	async recover(
		input: SharedListingGenerationClaim,
		now: IsoTimestamp
	): Promise<SharedListingStageReservation> {
		return this.prepare(input, now, false);
	}

	async reserve(
		input: SharedListingGenerationClaim,
		now: IsoTimestamp
	): Promise<SharedListingStageReservation> {
		return this.prepare(input, now, true);
	}

	async registerMultipart(
		lease: SharedListingStageLease,
		input: string,
		now: IsoTimestamp
	): Promise<boolean> {
		const id = artifactMultipartIdSchema.parse(input);
		return this.execute(async () => {
			const available = and(
				this.captured(lease),
				eq(schema.sharedListingStage.writesSealed, false),
				eq(schema.sharedListingStage.cleanupGeneration, 0),
				or(
					isNull(schema.sharedListingStage.multipartId),
					eq(schema.sharedListingStage.multipartId, id)
				)
			);
			await this.database
				.update(schema.sharedListingStage)
				.set({ multipartId: id })
				.where(available);
			const row = await this.database
				.select({ id: schema.sharedListingStage.id })
				.from(schema.sharedListingStage)
				.where(
					and(
						this.current(lease, now),
						eq(schema.sharedListingStage.writesSealed, false),
						eq(schema.sharedListingStage.multipartId, id)
					)
				)
				.get();
			return row !== undefined;
		});
	}

	async recordSeal(
		lease: SharedListingStageLease,
		multipartId: string,
		input: ArtifactStageMeasurement,
		now: IsoTimestamp
	): Promise<boolean> {
		const measurement = artifactStageMeasurementSchema.parse(input);
		return this.execute(async () => {
			const row = await this.database
				.select()
				.from(schema.sharedListingStage)
				.where(
					and(
						this.captured(lease),
						eq(schema.sharedListingStage.multipartId, multipartId)
					)
				)
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
				throw new SharedListingStageConflictError();
			}
			const unsealed = and(
				this.captured(lease),
				eq(schema.sharedListingStage.multipartId, multipartId),
				eq(schema.sharedListingStage.writesSealed, false),
				eq(schema.sharedListingStage.cleanupGeneration, 0)
			);
			const active = this.current(lease, now);
			const seal = this.database
				.update(schema.sharedListingStage)
				.set({
					writesSealed: true,
					...measurement,
					state: 'ready',
					nextCleanupAt: schema.sharedListingStage.cleanupAfter
				})
				.where(and(unsealed, active));
			const late = this.database
				.update(schema.sharedListingStage)
				.set({
					writesSealed: true,
					...measurement,
					state: 'retired',
					cleanupAfter: now,
					nextCleanupAt: now
				})
				.where(unsealed);
			await this.database.batch([seal, late]);
			const observed = await this.database
				.select({
					digest: schema.sharedListingStage.digest,
					size: schema.sharedListingStage.size,
					writesSealed: schema.sharedListingStage.writesSealed,
					state: schema.sharedListingStage.state,
					isCurrent: sql<boolean>`(${active})`.mapWith(Boolean)
				})
				.from(schema.sharedListingStage)
				.where(
					and(
						this.captured(lease),
						eq(schema.sharedListingStage.multipartId, multipartId)
					)
				)
				.get();
			if (
				observed?.writesSealed &&
				(observed.digest !== measurement.digest ||
					observed.size !== measurement.size)
			) {
				throw new SharedListingStageConflictError();
			}
			return observed?.isCurrent === true && observed.state === 'ready';
		});
	}

	async renew(
		lease: SharedListingStageLease,
		now: IsoTimestamp
	): Promise<IsoTimestamp | undefined> {
		return this.execute(async () => {
			const deadline = this.computationDeadline(lease.claim);
			const expiry = sql<IsoTimestamp>`max(${schema.sharedListingStage.expiresAt}, min((${deadline}), ${schema.sharedListingStage.writeUntil}))`;
			const rows = await this.database
				.update(schema.sharedListingStage)
				.set({
					expiresAt: expiry,
					nextCleanupAt: sql`CASE WHEN ${schema.sharedListingStage.state} = 'pending' THEN ${expiry} ELSE ${schema.sharedListingStage.nextCleanupAt} END`
				})
				.where(this.current(lease, now))
				.returning({ at: schema.sharedListingStage.expiresAt });
			return rows[0]?.at;
		});
	}

	async ready(
		lease: SharedListingStageLease,
		now: IsoTimestamp
	): Promise<ArtifactStageMeasurement | undefined> {
		return this.execute(async () => {
			const row = await this.database
				.select({
					digest: schema.sharedListingStage.digest,
					size: schema.sharedListingStage.size
				})
				.from(schema.sharedListingStage)
				.where(
					and(
						this.current(lease, now),
						eq(schema.sharedListingStage.state, 'ready')
					)
				)
				.get();
			return row === undefined
				? undefined
				: artifactStageMeasurementSchema.parse(row);
		});
	}

	async retire(
		lease: SharedListingStageLease,
		now: IsoTimestamp
	): Promise<boolean> {
		return this.execute(async () => {
			const cleanup = sql<IsoTimestamp>`CASE WHEN ${schema.sharedListingStage.state} = 'retired' THEN ${schema.sharedListingStage.cleanupAfter}
				WHEN ${schema.sharedListingStage.writesSealed} = 1 THEN ${now} ELSE max(${schema.sharedListingStage.cleanupAfter}, ${now}) END`;
			const computation = this.computation(lease.claim, now);
			const rows = await this.database
				.update(schema.sharedListingStage)
				.set({
					state: 'retired',
					cleanupAfter: cleanup,
					nextCleanupAt: sql`CASE WHEN ${schema.sharedListingStage.state} = 'retired' THEN ${schema.sharedListingStage.nextCleanupAt} ELSE ${cleanup} END`
				})
				.where(and(this.captured(lease), exists(computation)))
				.returning({ id: schema.sharedListingStage.id });
			return rows.length === 1;
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
			const beyondCursor =
				after === undefined
					? undefined
					: sql`(${schema.sharedListingStage.nextCleanupAt}, ${schema.sharedListingStage.id}) > (${after.at}, ${after.id})`;
			const eligible = and(
				lte(schema.sharedListingStage.nextCleanupAt, now),
				beyondCursor
			);
			const [rows] = await this.database.batch([
				this.database
					.select({
						id: schema.sharedListingStage.id,
						at: schema.sharedListingStage.nextCleanupAt
					})
					.from(schema.sharedListingStage)
					.where(eligible)
					.orderBy(
						asc(schema.sharedListingStage.nextCleanupAt),
						asc(schema.sharedListingStage.id)
					)
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
				and(
					eq(schema.sharedListingStage.state, 'pending'),
					lte(schema.sharedListingStage.expiresAt, now)
				),
				and(
					eq(schema.sharedListingStage.state, 'ready'),
					lte(schema.sharedListingStage.cleanupAfter, now)
				)
			);
			const cleanup = sql<IsoTimestamp>`CASE WHEN ${schema.sharedListingStage.writesSealed} = 1 THEN ${now} ELSE ${schema.sharedListingStage.cleanupAfter} END`;
			const retire = this.database
				.update(schema.sharedListingStage)
				.set({
					state: 'retired',
					cleanupAfter: cleanup,
					nextCleanupAt: cleanup
				})
				.where(and(eq(schema.sharedListingStage.id, id), expired));
			const available = and(
				eq(schema.sharedListingStage.id, id),
				eq(schema.sharedListingStage.state, 'retired'),
				lte(schema.sharedListingStage.cleanupAfter, now),
				lte(schema.sharedListingStage.nextCleanupAt, now),
				lt(
					schema.sharedListingStage.cleanupGeneration,
					Number.MAX_SAFE_INTEGER
				),
				or(
					isNull(schema.sharedListingStage.cleanupLeaseExpiresAt),
					lte(schema.sharedListingStage.cleanupLeaseExpiresAt, now)
				)
			);
			const claim = this.database
				.update(schema.sharedListingStage)
				.set({
					cleanupGeneration: sql`${schema.sharedListingStage.cleanupGeneration} + 1`,
					cleanupOwner: owner,
					cleanupLeaseExpiresAt: deadline,
					nextCleanupAt: deadline
				})
				.where(available)
				.returning();
			const [, claimed] = await this.database.batch([retire, claim]);
			if (claimed[0] !== undefined) {
				return this.cleanupClaim(claimed[0]);
			}
			const row = await this.database
				.select()
				.from(schema.sharedListingStage)
				.where(
					and(
						eq(schema.sharedListingStage.id, id),
						eq(schema.sharedListingStage.state, 'retired'),
						eq(schema.sharedListingStage.cleanupOwner, owner),
						gt(schema.sharedListingStage.cleanupLeaseExpiresAt, now)
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
			const captured = this.cleanupCurrent(claim, now);
			const stage = await this.database
				.select({
					narHash: schema.sharedListingStage.narHash,
					generatorRevision: schema.sharedListingStage.generatorRevision,
					computationGeneration: schema.sharedListingStage.computationGeneration
				})
				.from(schema.sharedListingStage)
				.where(captured)
				.get();
			if (stage === undefined) {
				return false;
			}
			const recorded = this.database
				.select({ one: sql`1` })
				.from(schema.sharedListingStage)
				.where(captured);
			const identity = and(
				eq(schema.sharedListingGeneration.narHash, stage.narHash),
				eq(
					schema.sharedListingGeneration.generatorRevision,
					stage.generatorRevision
				),
				eq(
					schema.sharedListingGeneration.generation,
					stage.computationGeneration
				),
				exists(recorded)
			);
			const release = this.database
				.update(schema.sharedListingGeneration)
				.set({
					owner: sql`null`,
					leaseExpiresAt: sql`null`,
					updatedAt: sql`max(${schema.sharedListingGeneration.updatedAt}, ${now})`
				})
				.where(identity);
			const remove = this.database
				.delete(schema.sharedListingStage)
				.where(captured)
				.returning({ id: schema.sharedListingStage.id });
			const [, rows] = await this.database.batch([release, remove]);
			return rows.length === 1;
		});
	}

	async deferCleanup(
		claim: SharedListingStageCleanupClaim,
		now: IsoTimestamp
	): Promise<IsoTimestamp | undefined> {
		const retryAt = isoTimestamp(new Date(Date.parse(now) + cleanupLeaseMs));
		return this.execute(async () => {
			const rows = await this.database
				.update(schema.sharedListingStage)
				.set({ cleanupLeaseExpiresAt: sql`null`, nextCleanupAt: retryAt })
				.where(this.cleanupCurrent(claim, now))
				.returning({ at: schema.sharedListingStage.nextCleanupAt });
			if (rows[0] !== undefined) {
				return rows[0].at;
			}
			const row = await this.database
				.select({ at: schema.sharedListingStage.nextCleanupAt })
				.from(schema.sharedListingStage)
				.where(
					and(
						this.cleanupIdentity(claim),
						isNull(schema.sharedListingStage.cleanupLeaseExpiresAt)
					)
				)
				.get();
			return row?.at;
		});
	}
}
