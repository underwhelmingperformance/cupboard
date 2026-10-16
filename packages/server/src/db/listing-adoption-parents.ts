import { type TenantId } from '@cupboard/nix-store/scalars';
import {
	and,
	asc,
	eq,
	exists,
	inArray,
	ne,
	notExists,
	or,
	type SQL,
	sql
} from 'drizzle-orm';
import { type DrizzleD1Database } from 'drizzle-orm/d1';

import {
	type ListingAdoptionParent,
	type ListingAdoptionParentRefresh,
	type ListingAdoptionParentRefreshResult,
	listingAdoptionParentRefreshSchema,
	listingAdoptionParentSchema
} from '../blob/listing-adoption-parents.ts';
import { jsonValueList } from '../do/json-list.ts';
import { SharedFactsUnavailableError } from '../errors.ts';
import { narInfoReferenceQuery } from '../read/read.ts';

import { cacheIdentityCondition } from './cache.ts';
import * as schema from './d1-schema.ts';

type StoredParent = typeof schema.listingAdoptionParent.$inferSelect;

/**
Indexes current shared publication candidates without granting cache authority
or retaining object bytes. The tenant DO validates each eventual adoption.
*/
export class ListingAdoptionParentStore {
	constructor(private readonly database: DrizzleD1Database<typeof schema>) {}

	private storageQuery() {
		return this.database
			.select({ id: schema.deploymentTransition.id })
			.from(schema.deploymentTransition)
			.where(eq(schema.deploymentTransition.id, 'listing-adoption-parents'));
	}

	private captureReadyQuery() {
		return this.database
			.select({ one: sql`1` })
			.from(schema.listingAdoptionCaptureState)
			.where(
				and(
					eq(schema.listingAdoptionCaptureState.id, 1),
					eq(schema.listingAdoptionCaptureState.isReady, true)
				)
			);
	}

	private readyQuery() {
		return this.database
			.select({ id: schema.deploymentTransition.id })
			.from(schema.deploymentTransition)
			.where(
				and(
					eq(schema.deploymentTransition.id, 'listing-adoption-parents'),
					eq(schema.deploymentTransition.state, 'complete')
				)
			);
	}

	private eligibleTenant(tenant: TenantId) {
		const eligibleStatus = or(
			eq(schema.tenant.status, 'active'),
			eq(schema.tenant.status, 'suspended')
		);
		return this.database
			.select({ id: schema.tenant.id })
			.from(schema.tenant)
			.where(and(eq(schema.tenant.id, tenant), eligibleStatus));
	}

	private identity(input: ListingAdoptionParentRefresh) {
		const table = schema.listingAdoptionParent;
		return and(
			eq(table.tenant, input.tenant),
			cacheIdentityCondition(table.cacheKind, table.cacheName, input.cache),
			inArray(table.storePathHash, jsonValueList(input.storePathHashes))
		);
	}

	private toParent(row: StoredParent): ListingAdoptionParent {
		return listingAdoptionParentSchema.parse({
			id: row.id,
			tenant: row.tenant,
			cache:
				row.cacheKind === 'default'
					? { kind: 'default' }
					: { kind: 'named', name: row.cacheName },
			cacheGeneration: row.cacheGeneration,
			storePathHash: row.storePathHash,
			generation: row.generation,
			narHash: row.narHash,
			updatedAt: row.updatedAt
		});
	}

	private queries(input: ListingAdoptionParentRefresh) {
		const current = narInfoReferenceQuery(
			this.database,
			input.tenant,
			input.cache,
			jsonValueList(input.storePathHashes)
		).as('adoption_parent');
		const name =
			input.cache.kind === 'named' ? sql`${input.cache.name}` : sql`NULL`;
		const ready = and(
			exists(this.readyQuery()),
			exists(this.captureReadyQuery())
		);
		const eligible = exists(this.eligibleTenant(input.tenant));
		const table = schema.listingAdoptionParent;
		const source = this.database
			.select({
				id: sql`lower(hex(randomblob(16)))`.as('id'),
				tenant: sql`${input.tenant}`.as('tenant'),
				cacheKind: sql`${input.cache.kind}`.as('cache_kind'),
				cacheName: name.as('cache_name'),
				cacheGeneration: current.cacheGeneration,
				storePathHash: current.storePathHash,
				generation: current.generation,
				narHash: current.narHash,
				updatedAt: sql`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`.as('updated_at')
			})
			.from(current)
			.where(and(ready, eligible));
		const projected = this.database
			.insert(table)
			.select(source)
			.onConflictDoUpdate({
				target:
					input.cache.kind === 'default'
						? [table.tenant, table.storePathHash]
						: [table.tenant, table.cacheName, table.storePathHash],
				targetWhere:
					input.cache.kind === 'default'
						? sql`${table.cacheKind} = 'default'`
						: sql`${table.cacheKind} = 'named'`,
				set: {
					id: sql`excluded.id`,
					cacheGeneration: sql`excluded.cache_generation`,
					generation: sql`excluded.generation`,
					narHash: sql`excluded.nar_hash`,
					updatedAt: sql`excluded.updated_at`
				},
				setWhere: or(
					ne(table.cacheGeneration, sql`excluded.cache_generation`),
					ne(table.generation, sql`excluded.generation`),
					ne(table.narHash, sql`excluded.nar_hash`)
				)
			});
		const authorised = this.database
			.select({ one: sql`1` })
			.from(current)
			.where(and(eligible, eq(current.storePathHash, table.storePathHash)));
		const removed = this.database
			.delete(table)
			.where(and(this.identity(input), ready, notExists(authorised)));
		const result = this.database
			.select({ parent: table })
			.from(this.readyQuery().as('adoption_ready'))
			.leftJoin(table, this.identity(input))
			.where(exists(this.captureReadyQuery()))
			.orderBy(asc(table.storePathHash));
		return [projected, removed, result] as const;
	}

	async refresh(
		input: ListingAdoptionParentRefresh
	): Promise<ListingAdoptionParentRefreshResult> {
		const checked = listingAdoptionParentRefreshSchema.parse(input);
		const request = {
			...checked,
			storePathHashes: [...new Set(checked.storePathHashes)]
		};
		try {
			const ready = await this.readyQuery().get();
			if (ready === undefined) {
				return { kind: 'unavailable' };
			}
			const refreshed = await this.database.batch(this.queries(request));
			const rows = refreshed[2];
			if (rows.length === 0) {
				return { kind: 'unavailable' };
			}
			return {
				kind: 'ready',
				parents: rows.flatMap(({ parent }) =>
					parent === null ? [] : [this.toParent(parent)]
				)
			};
		} catch (error) {
			throw new SharedFactsUnavailableError(error);
		}
	}

	async tenantAbsence(tenant: TenantId): Promise<SQL> {
		try {
			const installed = await this.storageQuery().get();
			if (installed === undefined) {
				return notExists(this.storageQuery());
			}
			const stored = this.database
				.select({ one: sql`1` })
				.from(schema.listingAdoptionParent)
				.where(eq(schema.listingAdoptionParent.tenant, tenant));
			return notExists(stored);
		} catch (error) {
			throw new SharedFactsUnavailableError(error);
		}
	}

	async retireTenant(tenant: TenantId, limit: number): Promise<number> {
		if (!Number.isSafeInteger(limit) || limit < 1) {
			throw new RangeError(
				'A parent retirement page requires a positive safe integer limit'
			);
		}
		try {
			const installed = await this.storageQuery().get();
			if (installed === undefined) {
				return 0;
			}
			const table = schema.listingAdoptionParent;
			const selected = this.database
				.select({ id: table.id })
				.from(table)
				.where(eq(table.tenant, tenant))
				.orderBy(asc(table.id))
				.limit(limit);
			const retirementCondition = notExists(this.eligibleTenant(tenant));
			const removed = await this.database
				.delete(table)
				.where(
					and(
						eq(table.tenant, tenant),
						inArray(table.id, selected),
						retirementCondition
					)
				)
				.returning({ id: table.id });
			return removed.length;
		} catch (error) {
			throw new SharedFactsUnavailableError(error);
		}
	}
}
