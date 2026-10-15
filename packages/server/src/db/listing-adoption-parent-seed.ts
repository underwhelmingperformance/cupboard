import { type CacheScope } from '@cupboard/nix-store/scalars';
import { type TransitionId } from '@cupboard/protocol/deployment';
import { and, eq, exists, gt, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { type DrizzleD1Database } from 'drizzle-orm/d1';
import { z } from 'zod';

import {
	type ListingAdoptionParentIdentity,
	type ListingAdoptionParentPage,
	type ListingAdoptionParentWindow,
	listingAdoptionParentWindowSchema
} from '../blob/listing-adoption-parent-discovery.ts';
import { type ListingAdoptionParentSeedClaim } from '../blob/listing-adoption-seed-dispatch.ts';
import { jsonValueList } from '../do/json-list.ts';
import { SharedFactsUnavailableError } from '../errors.ts';
import { narInfoReferenceQuery } from '../read/read.ts';

import * as schema from './d1-schema.ts';
import { ListingAdoptionParentDiscovery } from './listing-adoption-parent-discovery.ts';
import { ListingAdoptionSeedDispatchStore } from './listing-adoption-seed-dispatch.ts';

type Checkpoint = typeof schema.listingAdoptionParentSeed.$inferSelect;
const progressSchema = z.array(
	z.strictObject({
		scanned: z.number().int().nonnegative(),
		captured: z.number().int().nonnegative(),
		isComplete: z.boolean()
	})
);

export type ListingAdoptionParentSeedResult =
	| {
			readonly kind: 'advanced';
			readonly scanned: number;
			readonly captured: number;
			readonly isComplete: boolean;
	  }
	| { readonly kind: 'complete' | 'stale' | 'unavailable' };

/**
Captures historical cache parents in independent bounded windows. Events grant
no cache authority; adoption refreshes the current parent before publication.
*/
export class ListingAdoptionParentSeedStore {
	private readonly dispatch: ListingAdoptionSeedDispatchStore;

	constructor(private readonly database: DrizzleD1Database<typeof schema>) {
		this.dispatch = new ListingAdoptionSeedDispatchStore(database);
	}

	private transitionQuery(id: TransitionId) {
		const table = schema.deploymentTransition;
		return this.database
			.select({ id: table.id })
			.from(table)
			.where(and(eq(table.id, id), eq(table.state, 'complete')));
	}

	private storageQuery() {
		const readiness = and(
			exists(this.transitionQuery('listing-adoption-capture')),
			exists(this.transitionQuery('listing-adoption-parent-seed')),
			exists(this.transitionQuery('listing-adoption-parents'))
		);
		return this.database
			.select({ one: sql`1`.as('one') })
			.from(sql`(SELECT 1) AS singleton`)
			.where(readiness);
	}

	private readyQuery() {
		const state = schema.listingAdoptionCaptureState;
		const readiness = and(
			eq(state.id, 1),
			eq(state.isReady, true),
			exists(this.storageQuery())
		);
		return this.database.select({ id: state.id }).from(state).where(readiness);
	}

	private stateQuery(kind: CacheScope['kind']) {
		return this.database
			.select()
			.from(schema.listingAdoptionParentSeed)
			.where(eq(schema.listingAdoptionParentSeed.cacheKind, kind));
	}

	private async checkpoint(
		kind: CacheScope['kind'],
		claim: ListingAdoptionParentSeedClaim
	): Promise<Checkpoint | undefined> {
		const stored = await this.stateQuery(kind).get();
		if (stored !== undefined) {
			return stored;
		}
		const window = await new ListingAdoptionParentDiscovery(this.database).open(
			kind
		);
		const throughTenant =
			window === undefined ? sql`NULL` : sql`${window.through.tenant}`;
		const throughName =
			window?.kind === 'named' ? sql`${window.through.cacheName}` : sql`NULL`;
		const throughPath =
			window === undefined ? sql`NULL` : sql`${window.through.storePathHash}`;
		const readiness = and(
			exists(this.readyQuery()),
			this.dispatch.condition(claim)
		);
		const source = this.database
			.select({
				cacheKind: sql`${kind}`.as('cache_kind'),
				epoch: sql`lower(hex(randomblob(16)))`.as('epoch'),
				afterTenant: sql`NULL`.as('after_tenant'),
				afterCacheName: sql`NULL`.as('after_cache_name'),
				afterStorePathHash: sql`NULL`.as('after_store_path_hash'),
				throughTenant: throughTenant.as('through_tenant'),
				throughCacheName: throughName.as('through_cache_name'),
				throughStorePathHash: throughPath.as('through_store_path_hash'),
				pageCaptureAfter: sql`NULL`.as('page_capture_after'),
				scanned: sql`0`.as('scanned'),
				captured: sql`0`.as('captured'),
				isComplete: sql`${window === undefined ? 1 : 0}`.as('is_complete'),
				updatedAt: sql`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`.as('updated_at')
			})
			.from(sql`(SELECT 1) AS singleton`)
			.where(readiness);
		await this.database
			.insert(schema.listingAdoptionParentSeed)
			.select(source)
			.onConflictDoNothing();
		return this.stateQuery(kind).get();
	}

	private window(row: Checkpoint): ListingAdoptionParentWindow {
		const through = {
			tenant: row.throughTenant,
			storePathHash: row.throughStorePathHash,
			...(row.cacheKind === 'named' && { cacheName: row.throughCacheName })
		};
		const after =
			row.afterTenant === null
				? undefined
				: {
						tenant: row.afterTenant,
						storePathHash: row.afterStorePathHash,
						...(row.cacheKind === 'named' && { cacheName: row.afterCacheName })
					};
		return listingAdoptionParentWindowSchema.parse({
			kind: row.cacheKind,
			through,
			after
		});
	}

	private fence(row: Checkpoint, claim: ListingAdoptionParentSeedClaim) {
		const table = schema.listingAdoptionParentSeed;
		return and(
			eq(table.cacheKind, row.cacheKind),
			eq(table.epoch, row.epoch),
			eq(table.isComplete, false),
			sql`${table.afterTenant} IS ${row.afterTenant}`,
			sql`${table.afterCacheName} IS ${row.afterCacheName}`,
			sql`${table.afterStorePathHash} IS ${row.afterStorePathHash}`,
			sql`${table.throughTenant} IS ${row.throughTenant}`,
			sql`${table.throughCacheName} IS ${row.throughCacheName}`,
			sql`${table.throughStorePathHash} IS ${row.throughStorePathHash}`,
			exists(this.readyQuery()),
			this.dispatch.condition(claim)
		);
	}

	private activePage(row: Checkpoint, claim: ListingAdoptionParentSeedClaim) {
		return this.database
			.select({ one: sql`1` })
			.from(schema.listingAdoptionParentSeed)
			.where(
				and(
					this.fence(row, claim),
					isNotNull(schema.listingAdoptionParentSeed.pageCaptureAfter)
				)
			);
	}

	private capture(
		row: Checkpoint,
		identity: ListingAdoptionParentIdentity,
		claim: ListingAdoptionParentSeedClaim
	) {
		const current = narInfoReferenceQuery(
			this.database,
			identity.tenant,
			identity.cache,
			jsonValueList([identity.storePathHash])
		).as('seed_parent');
		const eligibleStatus = or(
			eq(schema.tenant.status, 'active'),
			eq(schema.tenant.status, 'suspended')
		);
		const tenant = this.database
			.select({ id: schema.tenant.id })
			.from(schema.tenant)
			.where(and(eq(schema.tenant.id, identity.tenant), eligibleStatus));
		const cache =
			identity.cache.kind === 'default'
				? sql`json_object('kind','default')`
				: sql`json_object('kind','named','name',${identity.cache.name})`;
		const eligible = and(exists(this.activePage(row, claim)), exists(tenant));
		const source = this.database
			.select({
				id: sql`NULL`.as('id'),
				source:
					sql`json_object('kind','parent','tenant',${identity.tenant},'cache',${cache},'cacheGeneration',${current.cacheGeneration},'storePathHash',${current.storePathHash},'generation',${current.generation},'narHash',${current.narHash})`.as(
						'source'
					),
				createdAt: sql`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`.as('created_at')
			})
			.from(current)
			.where(eligible);
		return this.database
			.insert(schema.listingAdoptionCaptureEvent)
			.select(source);
	}

	private async enrol(
		row: Checkpoint,
		page: ListingAdoptionParentPage,
		claim: ListingAdoptionParentSeedClaim
	): Promise<ListingAdoptionParentSeedResult> {
		const next = page.window.after;
		if (next === undefined) {
			throw new Error(
				'The listing adoption parent seed page cursor is missing'
			);
		}
		const table = schema.listingAdoptionParentSeed;
		const captureClock = this.database
			.select({ latest: schema.listingAdoptionCaptureState.latest })
			.from(schema.listingAdoptionCaptureState)
			.where(eq(schema.listingAdoptionCaptureState.id, 1));
		const start = this.database
			.update(table)
			.set({ pageCaptureAfter: sql`(${captureClock})` })
			.where(and(this.fence(row, claim), isNull(table.pageCaptureAfter)));
		const captured = this.database
			.select({ count: sql<number>`count(*)` })
			.from(schema.listingAdoptionCaptureEvent)
			.where(gt(schema.listingAdoptionCaptureEvent.id, table.pageCaptureAfter));
		const completed = this.database
			.update(table)
			.set({
				afterTenant: next.tenant,
				afterCacheName: 'cacheName' in next ? next.cacheName : sql`NULL`,
				afterStorePathHash: next.storePathHash,
				pageCaptureAfter: sql`NULL`,
				scanned: sql`${table.scanned} + ${page.parents.length}`,
				captured: sql`${table.captured} + (${captured})`,
				isComplete: page.isComplete,
				updatedAt: sql`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
			})
			.where(and(this.fence(row, claim), isNotNull(table.pageCaptureAfter)))
			.returning({
				scanned: table.scanned,
				captured: table.captured,
				isComplete: table.isComplete
			});
		const result = await this.database.batch([
			start,
			...page.parents.map((identity) => this.capture(row, identity, claim)),
			completed
		]);
		const progress = progressSchema.parse(result.at(-1))[0];
		if (progress === undefined) {
			return { kind: 'stale' };
		}
		return {
			kind: 'advanced',
			scanned: progress.scanned - row.scanned,
			captured: progress.captured - row.captured,
			isComplete: progress.isComplete
		};
	}

	async advance(
		claim: ListingAdoptionParentSeedClaim
	): Promise<ListingAdoptionParentSeedResult> {
		try {
			if (!(await this.dispatch.isCurrent(claim))) {
				return { kind: 'stale' };
			}
			const storage = await this.storageQuery().get();
			if (storage === undefined) {
				return { kind: 'unavailable' };
			}
			const ready = await this.readyQuery().get();
			if (ready === undefined) {
				return { kind: 'unavailable' };
			}
			const kind = claim.scope === 'default-parents' ? 'default' : 'named';
			const row = await this.checkpoint(kind, claim);
			if (row === undefined) {
				return { kind: 'unavailable' };
			}
			if (row.isComplete) {
				return { kind: 'complete' };
			}
			const page = await new ListingAdoptionParentDiscovery(this.database).page(
				this.window(row)
			);
			return await this.enrol(row, page, claim);
		} catch (error) {
			if (error instanceof SharedFactsUnavailableError) {
				throw error;
			}
			throw new SharedFactsUnavailableError(error);
		}
	}
}
