import { byCodeUnit } from '@cupboard/nix-store/store-path';
import { type ArtifactTaskOwner } from '@cupboard/protocol/artifact-jobs';
import { type TransitionId } from '@cupboard/protocol/deployment';
import {
	and,
	asc,
	eq,
	exists,
	gt,
	inArray,
	isNull,
	lte,
	notExists,
	or,
	type SQL,
	sql
} from 'drizzle-orm';
import { type DrizzleD1Database } from 'drizzle-orm/d1';

import {
	type ListingAdoptionSeedClaim,
	type ListingAdoptionSeedClaimResult,
	listingAdoptionSeedClaimSchema,
	type ListingAdoptionSeedScope,
	listingAdoptionSeedScopes
} from '../blob/listing-adoption-seed-dispatch.ts';
import { jsonValueList } from '../do/json-list.ts';
import { SharedFactsUnavailableError } from '../errors.ts';

import * as schema from './d1-schema.ts';
import { recordedTransitions } from './deployment-transitions.ts';

interface SeedSources {
	readonly facts: boolean;
	readonly parents: boolean;
}
const databaseNow = sql`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;
const leaseDeadline = sql`strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+60 seconds')`;

/**
Reserves recoverable delivery hints and independent execution leases for the
three historical adoption seeds. Seed checkpoints decide whether work remains.
*/
export class ListingAdoptionSeedDispatchStore {
	constructor(private readonly database: DrizzleD1Database<typeof schema>) {}

	private async execute<T>(operation: () => Promise<T>): Promise<T> {
		try {
			return await operation();
		} catch (error) {
			if (error instanceof SharedFactsUnavailableError) {
				throw error;
			}
			throw new SharedFactsUnavailableError(error);
		}
	}

	private transition(id: TransitionId) {
		return this.database
			.select({ id: schema.deploymentTransition.id })
			.from(schema.deploymentTransition)
			.where(
				and(
					eq(schema.deploymentTransition.id, id),
					eq(schema.deploymentTransition.state, 'complete')
				)
			);
	}

	private async sources(): Promise<SeedSources | undefined> {
		const rows = await this.database
			.select({
				id: schema.deploymentTransition.id,
				state: schema.deploymentTransition.state
			})
			.from(schema.deploymentTransition)
			.where(
				inArray(
					schema.deploymentTransition.id,
					jsonValueList<TransitionId>([
						'listing-adoption-seed-dispatch',
						'listing-adoption-capture',
						'listing-adoption-fact-seed',
						'listing-adoption-parents',
						'listing-adoption-parent-seed'
					])
				)
			);
		const states = recordedTransitions(rows);
		if (
			states.get('listing-adoption-seed-dispatch') !== 'complete' ||
			states.get('listing-adoption-capture') !== 'complete'
		) {
			return undefined;
		}
		return {
			facts: states.get('listing-adoption-fact-seed') === 'complete',
			parents:
				states.get('listing-adoption-parents') === 'complete' &&
				states.get('listing-adoption-parent-seed') === 'complete'
		};
	}

	private pending(scope: ListingAdoptionSeedScope, sources: SeedSources): SQL {
		if (scope === 'facts' ? !sources.facts : !sources.parents) {
			return sql`false`;
		}
		const capture = this.database
			.select({ id: schema.listingAdoptionCaptureState.id })
			.from(schema.listingAdoptionCaptureState)
			.where(
				and(
					eq(schema.listingAdoptionCaptureState.id, 1),
					eq(schema.listingAdoptionCaptureState.isReady, true)
				)
			);
		const parentReady =
			scope === 'facts'
				? sql`true`
				: exists(this.transition('listing-adoption-parents'));
		const storage =
			scope === 'facts'
				? 'listing-adoption-fact-seed'
				: 'listing-adoption-parent-seed';
		const ready = and(
			exists(this.transition('listing-adoption-seed-dispatch')),
			exists(this.transition('listing-adoption-capture')),
			exists(this.transition(storage)),
			exists(capture),
			parentReady
		);
		const completed =
			scope === 'facts'
				? this.database
						.select({ one: sql`1` })
						.from(schema.listingAdoptionFactSeed)
						.where(
							and(
								eq(schema.listingAdoptionFactSeed.id, 1),
								eq(schema.listingAdoptionFactSeed.isComplete, true)
							)
						)
				: this.database
						.select({ one: sql`1` })
						.from(schema.listingAdoptionParentSeed)
						.where(
							and(
								eq(
									schema.listingAdoptionParentSeed.cacheKind,
									scope === 'default-parents' ? 'default' : 'named'
								),
								eq(schema.listingAdoptionParentSeed.isComplete, true)
							)
						);
		return and(ready, notExists(completed)) ?? sql`false`;
	}

	private eligible(sources: SeedSources) {
		const table = schema.listingAdoptionSeedDispatch;
		return or(
			and(eq(table.scope, 'facts'), this.pending('facts', sources)),
			and(
				eq(table.scope, 'default-parents'),
				this.pending('default-parents', sources)
			),
			and(
				eq(table.scope, 'named-parents'),
				this.pending('named-parents', sources)
			)
		);
	}

	private enrol(scope: ListingAdoptionSeedScope, sources: SeedSources) {
		const source = this.database
			.select({
				scope: sql`${scope}`.as('scope'),
				epoch: sql`lower(hex(randomblob(16)))`.as('epoch'),
				availableAt: databaseNow.as('available_at'),
				owner: sql`NULL`.as('owner'),
				generation: sql`0`.as('generation'),
				leaseExpiresAt: sql`NULL`.as('lease_expires_at'),
				updatedAt: databaseNow.as('updated_at')
			})
			.from(sql`(SELECT 1) AS singleton`)
			.where(this.pending(scope, sources));
		return this.database
			.insert(schema.listingAdoptionSeedDispatch)
			.select(source)
			.onConflictDoNothing();
	}

	private unowned() {
		const table = schema.listingAdoptionSeedDispatch;
		return or(isNull(table.owner), lte(table.leaseExpiresAt, databaseNow));
	}

	private owned(claim: ListingAdoptionSeedClaim) {
		const table = schema.listingAdoptionSeedDispatch;
		return and(
			eq(table.scope, claim.scope),
			eq(table.epoch, claim.epoch),
			eq(table.owner, claim.owner),
			eq(table.generation, claim.generation),
			eq(table.leaseExpiresAt, claim.leaseExpiresAt),
			gt(table.leaseExpiresAt, databaseNow),
			exists(this.transition('listing-adoption-seed-dispatch'))
		);
	}

	async reserve(
		limit: number = listingAdoptionSeedScopes.length
	): Promise<readonly ListingAdoptionSeedScope[]> {
		if (
			!Number.isSafeInteger(limit) ||
			limit < 1 ||
			limit > listingAdoptionSeedScopes.length
		) {
			throw new RangeError(
				'A seed dispatch page requires between one and three scopes'
			);
		}
		return this.execute(async () => {
			const sources = await this.sources();
			if (sources === undefined) {
				return [];
			}
			await this.database.batch([
				this.enrol('facts', sources),
				this.enrol('default-parents', sources),
				this.enrol('named-parents', sources)
			]);
			const table = schema.listingAdoptionSeedDispatch;
			const eligible = and(
				this.eligible(sources),
				this.unowned(),
				lte(table.availableAt, databaseNow)
			);
			const selected = this.database
				.select({ scope: table.scope })
				.from(table)
				.where(eligible)
				.orderBy(asc(table.availableAt), asc(table.scope))
				.limit(limit);
			const rows = await this.database
				.update(table)
				.set({ availableAt: leaseDeadline, updatedAt: databaseNow })
				.where(and(inArray(table.scope, selected), eligible))
				.returning({ scope: table.scope });
			return rows.map(({ scope }) => scope).toSorted(byCodeUnit);
		});
	}

	async claim(
		scope: ListingAdoptionSeedScope,
		owner: ArtifactTaskOwner
	): Promise<ListingAdoptionSeedClaimResult> {
		return this.execute(async (): Promise<ListingAdoptionSeedClaimResult> => {
			const sources = await this.sources();
			if (sources === undefined) {
				return { kind: 'unavailable' };
			}
			const table = schema.listingAdoptionSeedDispatch;
			const sameOwner = and(
				eq(table.owner, owner),
				gt(table.leaseExpiresAt, databaseNow)
			);
			const eligibility = and(
				eq(table.scope, scope),
				this.pending(scope, sources),
				or(this.unowned(), eq(table.owner, owner))
			);
			const rows = await this.database
				.update(table)
				.set({
					owner,
					generation: sql`CASE WHEN ${sameOwner} THEN ${table.generation} ELSE ${table.generation}+1 END`,
					leaseExpiresAt: sql`CASE WHEN ${sameOwner} THEN ${table.leaseExpiresAt} ELSE ${leaseDeadline} END`,
					availableAt: sql`CASE WHEN ${sameOwner} THEN ${table.leaseExpiresAt} ELSE ${leaseDeadline} END`,
					updatedAt: databaseNow
				})
				.where(eligibility)
				.returning({
					scope: table.scope,
					epoch: table.epoch,
					owner: table.owner,
					generation: table.generation,
					leaseExpiresAt: table.leaseExpiresAt
				});
			const row = rows[0];
			if (row === undefined) {
				return { kind: 'idle' };
			}
			return {
				kind: 'claimed',
				claim: listingAdoptionSeedClaimSchema.parse(row)
			};
		});
	}

	/**
	Rechecks a captured execution lease inside a seed's write transaction.
	*/
	condition(claim: ListingAdoptionSeedClaim): SQL {
		const current = this.database
			.select({ one: sql`1` })
			.from(schema.listingAdoptionSeedDispatch)
			.where(this.owned(claim));
		return exists(current);
	}

	async isCurrent(claim: ListingAdoptionSeedClaim): Promise<boolean> {
		return this.execute(async () => {
			const installed = await this.transition(
				'listing-adoption-seed-dispatch'
			).get();
			if (installed === undefined) {
				return false;
			}
			const current = await this.database
				.select({ scope: schema.listingAdoptionSeedDispatch.scope })
				.from(schema.listingAdoptionSeedDispatch)
				.where(this.owned(claim))
				.get();
			return current !== undefined;
		});
	}

	async finish(claim: ListingAdoptionSeedClaim): Promise<boolean> {
		return this.execute(async () => {
			const installed = await this.transition(
				'listing-adoption-seed-dispatch'
			).get();
			if (installed === undefined) {
				return false;
			}
			const rows = await this.database
				.update(schema.listingAdoptionSeedDispatch)
				.set({
					owner: sql`NULL`,
					leaseExpiresAt: sql`NULL`,
					availableAt: databaseNow,
					updatedAt: databaseNow
				})
				.where(this.owned(claim))
				.returning({ scope: schema.listingAdoptionSeedDispatch.scope });
			return rows.length > 0;
		});
	}
}
