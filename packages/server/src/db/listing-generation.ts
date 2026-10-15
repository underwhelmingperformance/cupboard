import { type TenantId } from '@cupboard/nix-store/scalars';
import { type ArtifactTaskOwner } from '@cupboard/protocol/artifact-jobs';
import {
	type ListingGeneratorRevision,
	type NarListingFact,
	narListingFactSchema,
	type NarListingIdentity
} from '@cupboard/protocol/artifacts';
import { type IsoTimestamp, isoTimestamp } from '@cupboard/protocol/scalars';
import {
	and,
	eq,
	exists,
	gt,
	isNotNull,
	isNull,
	lte,
	ne,
	or,
	sql
} from 'drizzle-orm';
import { type DrizzleD1Database } from 'drizzle-orm/d1';

import {
	type ListingGenerationClaim,
	type ListingGenerationClaimResult,
	listingGenerationClaimSchema,
	type ListingGenerationRequest,
	listingGenerationRequestSchema
} from '../blob/listing-generation.ts';
import { registeredLiveObjectIncarnation } from '../blob/object-incarnation.ts';
import {
	ListingFactConflictError,
	SharedFactsUnavailableError
} from '../errors.ts';

import * as schema from './d1-schema.ts';
import { ListingFactStore } from './listing-facts.ts';

const leaseDurationMs = 60_000;
type Row = typeof schema.listingGeneration.$inferSelect;

/**
 * Coalesces computation across tenants. Claims do not retain bytes or grant
 * publication authority; publishers still need cache-scoped references.
 */
export class ListingGenerationStore {
	constructor(private readonly database: DrizzleD1Database<typeof schema>) {}

	private async execute<T>(operation: () => Promise<T>): Promise<T> {
		try {
			return await operation();
		} catch (error) {
			if (
				error instanceof ListingFactConflictError ||
				error instanceof SharedFactsUnavailableError
			) {
				throw error;
			}
			throw new SharedFactsUnavailableError(error);
		}
	}

	private identity(input: NarListingIdentity) {
		return and(
			eq(schema.listingGeneration.narHash, input.narHash),
			eq(schema.listingGeneration.generatorRevision, input.generatorRevision)
		);
	}

	private sourceAvailable(input: ListingGenerationRequest) {
		const sourceIdentity = and(
			eq(schema.blobState.narHash, input.narHash),
			eq(schema.blobState.incarnation, input.sourceIncarnation),
			registeredLiveObjectIncarnation(
				this.database,
				'nar',
				input.narHash,
				input.sourceIncarnation
			)
		);
		const tenantIdentity = and(
			eq(schema.tenant.id, input.tenant),
			eq(schema.tenant.status, 'active')
		);
		const source = this.database
			.select({ one: sql`1` })
			.from(schema.blobState)
			.where(sourceIdentity);
		const tenant = this.database
			.select({ one: sql`1` })
			.from(schema.tenant)
			.where(tenantIdentity);
		return and(exists(source), exists(tenant));
	}

	private captured(claim: ListingGenerationClaim) {
		return and(
			this.identity(claim),
			eq(schema.listingGeneration.sourceIncarnation, claim.sourceIncarnation),
			eq(schema.listingGeneration.generation, claim.generation),
			eq(schema.listingGeneration.tenant, claim.tenant),
			eq(schema.listingGeneration.owner, claim.owner)
		);
	}

	private current(claim: ListingGenerationClaim, now: IsoTimestamp) {
		return and(
			this.captured(claim),
			gt(schema.listingGeneration.leaseExpiresAt, now),
			this.sourceAvailable(claim)
		);
	}

	private decoded(row: Row): ListingGenerationClaim {
		return listingGenerationClaimSchema.parse({
			narHash: row.narHash,
			generatorRevision: row.generatorRevision,
			sourceIncarnation: row.sourceIncarnation,
			generation: row.generation,
			tenant: row.tenant,
			owner: row.owner,
			leaseExpiresAt: row.leaseExpiresAt
		});
	}

	private storedFact(fact: NarListingFact) {
		const identity = and(
			eq(schema.casObject.digest, fact.digest),
			eq(schema.casObject.size, fact.size),
			registeredLiveObjectIncarnation(
				this.database,
				'cas',
				fact.digest,
				schema.casObject.incarnation
			)
		);
		const stored = this.database
			.select({ one: sql`1` })
			.from(schema.casObject)
			.where(identity);
		return exists(stored);
	}

	private matchingFact(fact: NarListingFact) {
		const identity = and(
			eq(schema.listingFact.narHash, fact.narHash),
			eq(schema.listingFact.generatorRevision, fact.generatorRevision),
			eq(schema.listingFact.digest, fact.digest),
			eq(schema.listingFact.size, fact.size)
		);
		const stored = this.database
			.select({ one: sql`1` })
			.from(schema.listingFact)
			.where(identity);
		return exists(stored);
	}

	async find(
		identity: NarListingIdentity
	): Promise<ListingGenerationClaim | undefined> {
		return this.execute(async () => {
			const row = await this.database
				.select()
				.from(schema.listingGeneration)
				.where(
					and(
						this.identity(identity),
						isNotNull(schema.listingGeneration.owner)
					)
				)
				.get();
			if (row === undefined) {
				return;
			}
			return this.decoded(row);
		});
	}

	async claim(
		input: ListingGenerationRequest,
		now: IsoTimestamp
	): Promise<ListingGenerationClaimResult> {
		const request = listingGenerationRequestSchema.parse(input);
		const leaseExpiresAt = isoTimestamp(
			new Date(Date.parse(now) + leaseDurationMs)
		);
		return this.execute(async () => {
			const source = and(
				eq(schema.blobState.narHash, request.narHash),
				this.sourceAvailable(request)
			);
			const inserted = await this.database
				.insert(schema.listingGeneration)
				.select(
					this.database
						.select({
							narHash: schema.blobState.narHash,
							generatorRevision:
								sql<ListingGeneratorRevision>`${request.generatorRevision}`.as(
									'generator_revision'
								),
							sourceIncarnation: schema.blobState.incarnation,
							generation: sql<number>`1`.as('generation'),
							tenant: sql<TenantId>`${request.tenant}`.as('tenant'),
							owner: sql<ArtifactTaskOwner>`${request.owner}`.as('owner'),
							leaseExpiresAt: sql<IsoTimestamp>`${leaseExpiresAt}`.as(
								'lease_expires_at'
							),
							updatedAt: sql<IsoTimestamp>`${now}`.as('updated_at')
						})
						.from(schema.blobState)
						.where(source)
				)
				.onConflictDoUpdate({
					target: [
						schema.listingGeneration.narHash,
						schema.listingGeneration.generatorRevision
					],
					set: {
						sourceIncarnation: request.sourceIncarnation,
						generation: sql`${schema.listingGeneration.generation} + 1`,
						tenant: request.tenant,
						owner: request.owner,
						leaseExpiresAt,
						updatedAt: now
					},
					setWhere: or(
						isNull(schema.listingGeneration.owner),
						lte(schema.listingGeneration.leaseExpiresAt, now),
						ne(
							schema.listingGeneration.sourceIncarnation,
							request.sourceIncarnation
						)
					)
				})
				.returning();
			const reserved = inserted[0];
			if (reserved !== undefined) {
				return { kind: 'claimed', claim: this.decoded(reserved) };
			}
			const current = await this.database
				.select()
				.from(schema.listingGeneration)
				.where(and(this.identity(request), this.sourceAvailable(request)))
				.get();
			const expanded = await this.database
				.select({ state: schema.deploymentTransition.state })
				.from(schema.deploymentTransition)
				.where(eq(schema.deploymentTransition.id, 'global-listing-generation'))
				.get();
			if (expanded !== undefined) {
				const global = await this.database
					.select({ at: schema.sharedListingGeneration.leaseExpiresAt })
					.from(schema.sharedListingGeneration)
					.where(
						and(
							eq(schema.sharedListingGeneration.narHash, request.narHash),
							eq(
								schema.sharedListingGeneration.generatorRevision,
								request.generatorRevision
							),
							eq(
								schema.sharedListingGeneration.sourceIncarnation,
								request.sourceIncarnation
							),
							gt(schema.sharedListingGeneration.leaseExpiresAt, now),
							this.sourceAvailable(request)
						)
					)
					.get();
				if (global?.at !== undefined && global.at !== null) {
					return { kind: 'busy', retryAt: global.at };
				}
			}
			if (current === undefined) {
				return { kind: 'unavailable' };
			}
			if (current.owner === null || current.leaseExpiresAt === null) {
				return { kind: 'unavailable' };
			}
			if (
				current.tenant === request.tenant &&
				current.owner === request.owner &&
				current.sourceIncarnation === request.sourceIncarnation &&
				current.leaseExpiresAt > now
			) {
				return { kind: 'claimed', claim: this.decoded(current) };
			}
			return { kind: 'busy', retryAt: current.leaseExpiresAt };
		});
	}

	async renew(
		claim: ListingGenerationClaim,
		now: IsoTimestamp
	): Promise<IsoTimestamp | undefined> {
		return this.execute(async () => {
			const deadline = isoTimestamp(
				new Date(Date.parse(now) + leaseDurationMs)
			);
			const rows = await this.database
				.update(schema.listingGeneration)
				.set({
					leaseExpiresAt: sql`max(${schema.listingGeneration.leaseExpiresAt}, ${deadline})`,
					updatedAt: sql`max(${schema.listingGeneration.updatedAt}, ${now})`
				})
				.where(this.current(claim, now))
				.returning({ at: schema.listingGeneration.leaseExpiresAt });
			return rows[0]?.at ?? undefined;
		});
	}

	async release(
		claim: ListingGenerationClaim,
		now: IsoTimestamp
	): Promise<boolean> {
		return this.execute(async () => {
			const rows = await this.database
				.update(schema.listingGeneration)
				.set({
					tenant: sql`null`,
					owner: sql`null`,
					leaseExpiresAt: sql`null`,
					updatedAt: now
				})
				.where(this.captured(claim))
				.returning({ generation: schema.listingGeneration.generation });
			return rows.length === 1;
		});
	}

	async complete(
		claim: ListingGenerationClaim,
		input: NarListingFact,
		now: IsoTimestamp
	): Promise<boolean> {
		const fact = narListingFactSchema.parse(input);
		if (
			claim.narHash !== fact.narHash ||
			claim.generatorRevision !== fact.generatorRevision
		) {
			return false;
		}
		return this.execute(async () => {
			const current = and(this.current(claim, now), this.storedFact(fact));
			const insert = this.database
				.insert(schema.listingFact)
				.select(
					this.database
						.select({
							narHash: schema.listingGeneration.narHash,
							generatorRevision: schema.listingGeneration.generatorRevision,
							format: sql<1>`1`.as('format'),
							digest: sql<typeof fact.digest>`${fact.digest}`.as('digest'),
							size: sql<number>`${fact.size}`.as('size'),
							createdAt: sql<IsoTimestamp>`${now}`.as('created_at')
						})
						.from(schema.listingGeneration)
						.where(current)
				)
				.onConflictDoNothing({
					target: [
						schema.listingFact.narHash,
						schema.listingFact.generatorRevision
					]
				})
				.returning({ digest: schema.listingFact.digest });
			const release = this.database
				.update(schema.listingGeneration)
				.set({
					tenant: sql`null`,
					owner: sql`null`,
					leaseExpiresAt: sql`null`,
					updatedAt: now
				})
				.where(and(current, this.matchingFact(fact)))
				.returning({ generation: schema.listingGeneration.generation });
			const [, released] = await this.database.batch([insert, release]);
			if (released.length === 1) {
				return true;
			}
			const owned = await this.database
				.select({ one: sql`1` })
				.from(schema.listingGeneration)
				.where(current)
				.get();
			if (owned === undefined) {
				return false;
			}
			const existing = await new ListingFactStore(this.database).find(fact);
			if (
				existing !== undefined &&
				(existing.digest !== fact.digest || existing.size !== fact.size)
			) {
				throw new ListingFactConflictError();
			}
			return false;
		});
	}
}
