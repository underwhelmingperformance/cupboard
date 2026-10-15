import {
	type NarListingFact,
	narListingFactSchema
} from '@cupboard/protocol/artifacts';
import { type IsoTimestamp } from '@cupboard/protocol/scalars';
import { and, eq, exists, lte, ne, notExists, or, sql } from 'drizzle-orm';
import { type DrizzleD1Database } from 'drizzle-orm/d1';

import { registeredLiveObjectIncarnation } from '../blob/object-incarnation.ts';
import {
	type SharedListingGenerationClaim,
	sharedListingGenerationClaimSchema
} from '../blob/shared-listing-generation.ts';
import {
	sharedListingOutputEpochSchema,
	type SharedListingOutputReference,
	sharedListingOutputReferenceSchema
} from '../blob/shared-listing-outputs.ts';
import {
	ListingFactConflictError,
	SharedFactsUnavailableError
} from '../errors.ts';

import * as schema from './d1-schema.ts';
import { SharedListingGenerationStore } from './shared-listing-generation.ts';

export class SharedListingOutputStore {
	constructor(private readonly database: DrizzleD1Database<typeof schema>) {}

	private identity(
		fact: Pick<NarListingFact, 'narHash' | 'generatorRevision'>
	) {
		return and(
			eq(schema.sharedListingOutputReference.narHash, fact.narHash),
			eq(
				schema.sharedListingOutputReference.generatorRevision,
				fact.generatorRevision
			)
		);
	}

	private captured(reference: SharedListingOutputReference) {
		return and(
			this.identity(reference),
			eq(schema.sharedListingOutputReference.epoch, reference.epoch),
			eq(
				schema.sharedListingOutputReference.sourceIncarnation,
				reference.sourceIncarnation
			),
			eq(
				schema.sharedListingOutputReference.computationGeneration,
				reference.computationGeneration
			),
			eq(schema.sharedListingOutputReference.digest, reference.digest),
			eq(schema.sharedListingOutputReference.size, reference.size)
		);
	}

	private parentAbsent(reference: SharedListingOutputReference) {
		return notExists(
			this.database
				.select({ one: sql`1` })
				.from(schema.blobReference)
				.where(eq(schema.blobReference.narHash, reference.narHash))
		);
	}

	private conflictingFact(fact: NarListingFact) {
		const differentMeasurement = or(
			ne(schema.listingFact.digest, fact.digest),
			ne(schema.listingFact.size, fact.size)
		);
		return this.database
			.select({ one: sql`1` })
			.from(schema.listingFact)
			.where(
				and(
					eq(schema.listingFact.narHash, fact.narHash),
					eq(schema.listingFact.generatorRevision, fact.generatorRevision),
					differentMeasurement
				)
			);
	}

	private async checkConflict(fact: NarListingFact) {
		const [reference, conflict] = await this.database.batch([
			this.database
				.select()
				.from(schema.sharedListingOutputReference)
				.where(this.identity(fact)),
			this.conflictingFact(fact)
		]);
		if (
			conflict.length > 0 ||
			reference.some(
				(row) => row.digest !== fact.digest || row.size !== fact.size
			)
		) {
			throw new ListingFactConflictError();
		}
	}

	async retain(
		input: SharedListingGenerationClaim,
		value: NarListingFact,
		incarnation: number,
		now: IsoTimestamp
	): Promise<SharedListingOutputReference | undefined> {
		const claim = sharedListingGenerationClaimSchema.parse(input);
		const fact = narListingFactSchema.parse(value);
		if (
			claim.task.narHash !== fact.narHash ||
			claim.task.generatorRevision !== fact.generatorRevision
		) {
			return undefined;
		}
		try {
			await this.checkConflict(fact);
			const owned = exists(
				this.database
					.select({ one: sql`1` })
					.from(schema.sharedListingGeneration)
					.where(
						new SharedListingGenerationStore(this.database).owns(claim, now)
					)
			);
			const live = registeredLiveObjectIncarnation(
				this.database,
				'cas',
				fact.digest,
				incarnation
			);
			const conflictingFact = this.conflictingFact(fact);
			const immutable = notExists(conflictingFact);
			const selected = this.database
				.select({
					narHash: sql<typeof fact.narHash>`${fact.narHash}`.as('nar_hash'),
					generatorRevision: sql<
						typeof fact.generatorRevision
					>`${fact.generatorRevision}`.as('generator_revision'),
					epoch: sql<
						SharedListingOutputReference['epoch']
					>`${sharedListingOutputEpochSchema.parse(crypto.randomUUID())}`.as(
						'epoch'
					),
					sourceIncarnation: sql<number>`${claim.task.sourceIncarnation}`.as(
						'source_incarnation'
					),
					computationGeneration: sql<number>`${claim.generation}`.as(
						'computation_generation'
					),
					digest: schema.casObject.digest,
					size: schema.casObject.size,
					createdAt: sql<IsoTimestamp>`${now}`.as('created_at')
				})
				.from(schema.casObject)
				.where(
					and(
						eq(schema.casObject.digest, fact.digest),
						eq(schema.casObject.incarnation, incarnation),
						eq(schema.casObject.size, fact.size),
						live,
						owned,
						immutable
					)
				);
			const insert = this.database
				.insert(schema.sharedListingOutputReference)
				.select(selected)
				.onConflictDoUpdate({
					target: [
						schema.sharedListingOutputReference.narHash,
						schema.sharedListingOutputReference.generatorRevision
					],
					set: {
						sourceIncarnation: claim.task.sourceIncarnation,
						computationGeneration: claim.generation
					},
					setWhere: and(
						eq(schema.sharedListingOutputReference.digest, fact.digest),
						eq(schema.sharedListingOutputReference.size, fact.size),
						lte(
							schema.sharedListingOutputReference.computationGeneration,
							claim.generation
						)
					)
				})
				.returning();
			const captured = and(
				this.identity(fact),
				eq(
					schema.sharedListingOutputReference.sourceIncarnation,
					claim.task.sourceIncarnation
				),
				eq(
					schema.sharedListingOutputReference.computationGeneration,
					claim.generation
				),
				eq(schema.sharedListingOutputReference.digest, fact.digest),
				eq(schema.sharedListingOutputReference.size, fact.size)
			);
			const matchingReference = this.database
				.select({ one: sql`1` })
				.from(schema.sharedListingOutputReference)
				.where(captured);
			const clearGrace = this.database
				.update(schema.casObject)
				.set({ deleteAfter: sql`null` })
				.where(
					and(
						eq(schema.casObject.digest, fact.digest),
						eq(schema.casObject.incarnation, incarnation),
						live,
						owned,
						exists(matchingReference)
					)
				);
			const [rows] = await this.database.batch([insert, clearGrace]);
			await this.checkConflict(fact);
			return rows[0] === undefined
				? undefined
				: sharedListingOutputReferenceSchema.parse(rows[0]);
		} catch (error) {
			if (error instanceof ListingFactConflictError) {
				throw error;
			}
			throw new SharedFactsUnavailableError(error);
		}
	}

	async releaseCaptured(input: SharedListingOutputReference): Promise<boolean> {
		const reference = sharedListingOutputReferenceSchema.parse(input);
		try {
			const eligible = and(
				this.captured(reference),
				this.parentAbsent(reference)
			);
			const matchingReference = this.database
				.select({ one: sql`1` })
				.from(schema.sharedListingOutputReference)
				.where(eligible);
			const clearGrace = this.database
				.update(schema.casObject)
				.set({ deleteAfter: sql`null` })
				.where(
					and(
						eq(schema.casObject.digest, reference.digest),
						exists(matchingReference)
					)
				);
			const remove = this.database
				.delete(schema.sharedListingOutputReference)
				.where(eligible)
				.returning({ epoch: schema.sharedListingOutputReference.epoch });
			const [, rows] = await this.database.batch([clearGrace, remove]);
			return rows.length === 1;
		} catch (error) {
			throw new SharedFactsUnavailableError(error);
		}
	}
}
