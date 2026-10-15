import {
	type NarListingFact,
	narListingFactSchema,
	type NarListingIdentity
} from '@cupboard/protocol/artifacts';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { and, asc, eq } from 'drizzle-orm';
import { type DrizzleD1Database } from 'drizzle-orm/d1';

import { registeredLiveObjectIncarnation } from '../blob/object-incarnation.ts';
import { jsonRowList } from '../do/json-list.ts';
import {
	ListingFactConflictError,
	SharedFactsUnavailableError
} from '../errors.ts';

import * as schema from './d1-schema.ts';
import { readWithOneRetry } from './transient.ts';

export interface StoredNarListingFact {
	readonly fact: NarListingFact;
	readonly incarnation: number;
}

/**
 * Facts do not retain CAS bytes or authorise reads. Publishers must separately
 * reserve a live CAS incarnation and attach cache-scoped parents.
 */
export class ListingFactStore {
	constructor(private readonly database: DrizzleD1Database<typeof schema>) {}

	private identityCondition(identity: NarListingIdentity) {
		return and(
			eq(schema.listingFact.narHash, identity.narHash),
			eq(schema.listingFact.generatorRevision, identity.generatorRevision)
		);
	}

	async find(
		identity: NarListingIdentity
	): Promise<NarListingFact | undefined> {
		const query = this.database
			.select({
				narHash: schema.listingFact.narHash,
				generatorRevision: schema.listingFact.generatorRevision,
				format: schema.listingFact.format,
				digest: schema.listingFact.digest,
				size: schema.listingFact.size
			})
			.from(schema.listingFact)
			.where(this.identityCondition(identity));
		try {
			const row = await readWithOneRetry(() => query.get());
			return row === undefined ? undefined : narListingFactSchema.parse(row);
		} catch (error) {
			throw new SharedFactsUnavailableError(error);
		}
	}

	async findStored(
		identities: readonly NarListingIdentity[]
	): Promise<readonly StoredNarListingFact[]> {
		if (identities.length === 0) {
			return [];
		}
		const unique = new Map(
			identities.map(
				(identity) =>
					[
						JSON.stringify([identity.narHash, identity.generatorRevision]),
						{
							narHash: identity.narHash,
							generatorRevision: identity.generatorRevision
						}
					] as const
			)
		)
			.values()
			.toArray();
		const list = jsonRowList(unique);
		const query = this.database
			.select({
				narHash: schema.listingFact.narHash,
				generatorRevision: schema.listingFact.generatorRevision,
				format: schema.listingFact.format,
				digest: schema.listingFact.digest,
				size: schema.listingFact.size,
				incarnation: schema.casObject.incarnation
			})
			.from(schema.listingFact)
			.innerJoin(
				schema.casObject,
				and(
					eq(schema.casObject.digest, schema.listingFact.digest),
					eq(schema.casObject.size, schema.listingFact.size)
				)
			)
			.where(
				and(
					list.matches({
						narHash: schema.listingFact.narHash,
						generatorRevision: schema.listingFact.generatorRevision
					}),
					registeredLiveObjectIncarnation(
						this.database,
						'cas',
						schema.casObject.digest,
						schema.casObject.incarnation
					)
				)
			)
			.orderBy(
				asc(schema.listingFact.narHash),
				asc(schema.listingFact.generatorRevision)
			);
		try {
			const rows = await readWithOneRetry(() => query.all());
			return rows.map(({ incarnation, ...fact }) => ({
				fact: narListingFactSchema.parse(fact),
				incarnation
			}));
		} catch (error) {
			throw new SharedFactsUnavailableError(error);
		}
	}

	async record(input: NarListingFact): Promise<'created' | 'already-present'> {
		const fact = narListingFactSchema.parse(input);
		try {
			const inserted = await this.database
				.insert(schema.listingFact)
				.values({
					...fact,
					createdAt: isoTimestamp(new Date())
				})
				.onConflictDoNothing({
					target: [
						schema.listingFact.narHash,
						schema.listingFact.generatorRevision
					]
				})
				.returning({ narHash: schema.listingFact.narHash })
				.all();
			if (inserted.length > 0) {
				return 'created';
			}
		} catch (error) {
			throw new SharedFactsUnavailableError(error);
		}
		const existing = await this.find(fact);
		if (existing === undefined) {
			throw new SharedFactsUnavailableError(
				new Error('The listing fact disappeared after its insert conflicted')
			);
		}
		if (existing.digest !== fact.digest || existing.size !== fact.size) {
			throw new ListingFactConflictError();
		}
		return 'already-present';
	}
}
