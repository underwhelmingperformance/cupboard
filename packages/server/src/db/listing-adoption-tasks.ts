import { byCodeUnit } from '@cupboard/nix-store/store-path';
import { type ArtifactTaskOwner } from '@cupboard/protocol/artifact-jobs';
import { type TransitionId } from '@cupboard/protocol/deployment';
import {
	and,
	asc,
	desc,
	eq,
	exists,
	gt,
	inArray,
	isNotNull,
	isNull,
	lte,
	or,
	type SQL,
	sql
} from 'drizzle-orm';
import { type DrizzleD1Database } from 'drizzle-orm/d1';
import { z } from 'zod';

import {
	type ListingAdoptionExpansionPage,
	type ListingAdoptionExpansionWindow,
	listingAdoptionExpansionWindowSchema
} from '../blob/listing-adoption-expansion.ts';
import { type ListingAdoptionParent } from '../blob/listing-adoption-parents.ts';
import {
	type ListingAdoptionDelivery,
	type ListingAdoptionDeliveryOutcome,
	listingAdoptionDeliveryOutcomeSchema,
	type ListingAdoptionDeliveryResolution,
	listingAdoptionDeliveryResolutionSchema,
	type ListingAdoptionPreparedDeliveries,
	type ListingAdoptionReservation,
	listingAdoptionReservationSchema,
	type ListingAdoptionTaskAdvanceResult,
	type ListingAdoptionTaskClaim,
	type ListingAdoptionTaskClaimResult,
	listingAdoptionTaskClaimSchema,
	type ListingAdoptionTaskId,
	listingAdoptionTaskIdSchema,
	listingAdoptionTaskSourceSchema
} from '../blob/listing-adoption-tasks.ts';
import { registeredLiveObjectIncarnation } from '../blob/object-incarnation.ts';
import { jsonRowList, jsonValueList } from '../do/json-list.ts';
import { SharedFactsUnavailableError } from '../errors.ts';

import { cacheIdentityCondition } from './cache.ts';
import * as schema from './d1-schema.ts';
import { ListingAdoptionExpansionDiscovery } from './listing-adoption-expansion.ts';

type Task = typeof schema.listingAdoptionTask.$inferSelect;
const databaseNow = sql`strftime('%Y-%m-%dT%H:%M:%fZ','now')`;
const deadline = sql`strftime('%Y-%m-%dT%H:%M:%fZ','now','+60 seconds')`;
const pageSize = 32;

/**
Persists source expansion and independent target retries. These records grant
neither cache authority nor CAS retention; publication requires the tenant DO.
*/
export class ListingAdoptionTaskStore {
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
		const table = schema.deploymentTransition;
		return this.database
			.select({ id: table.id })
			.from(table)
			.where(and(eq(table.id, id), eq(table.state, 'complete')));
	}
	private async seedInstalled() {
		const table = schema.deploymentTransition;
		const required = or(
			eq(table.id, 'listing-adoption-tasks'),
			eq(table.id, 'listing-adoption-work'),
			eq(table.id, 'listing-adoption-capture')
		);
		const rows = await this.database
			.select({ id: table.id })
			.from(table)
			.where(and(required, eq(table.state, 'complete')));
		return rows.length === 3;
	}
	private ready() {
		const state = schema.listingAdoptionCaptureState;
		const eligibility = and(
			eq(state.id, 1),
			eq(state.isReady, true),
			exists(this.transition('listing-adoption-tasks')),
			exists(this.transition('listing-adoption-capture')),
			exists(this.transition('listing-adoption-work'))
		);
		return exists(
			this.database.select({ id: state.id }).from(state).where(eligibility)
		);
	}
	private unowned() {
		const table = schema.listingAdoptionTask;
		return or(isNull(table.owner), lte(table.leaseExpiresAt, databaseNow));
	}
	private owned(claim: ListingAdoptionTaskClaim) {
		const table = schema.listingAdoptionTask;
		return and(
			eq(table.id, claim.id),
			eq(table.epoch, claim.epoch),
			eq(table.owner, claim.owner),
			eq(table.generation, claim.generation),
			eq(table.leaseExpiresAt, claim.leaseExpiresAt),
			gt(table.leaseExpiresAt, databaseNow),
			isNull(table.completedAt),
			exists(this.transition('listing-adoption-tasks'))
		);
	}
	private parentCurrent(parent: ListingAdoptionParent) {
		const table = schema.listingAdoptionParent;
		const identity = and(
			eq(table.id, parent.id),
			eq(table.tenant, parent.tenant),
			cacheIdentityCondition(table.cacheKind, table.cacheName, parent.cache),
			eq(table.cacheGeneration, parent.cacheGeneration),
			eq(table.storePathHash, parent.storePathHash),
			eq(table.generation, parent.generation),
			eq(table.narHash, parent.narHash)
		);
		return exists(
			this.database.select({ id: table.id }).from(table).where(identity)
		);
	}
	private sourceCurrent(window: ListingAdoptionExpansionWindow): SQL {
		if (window.kind === 'parent') {
			return this.parentCurrent(window.parent);
		}
		if (window.kind === 'listing') {
			const fact = schema.listingFact;
			const identity = and(
				eq(fact.narHash, window.identity.narHash),
				eq(fact.generatorRevision, window.identity.generatorRevision)
			);
			return exists(
				this.database
					.select({ narHash: fact.narHash })
					.from(fact)
					.where(identity)
			);
		}
		const object = schema.casObject;
		const identity = and(
			eq(object.digest, window.digest),
			eq(object.incarnation, window.incarnation),
			registeredLiveObjectIncarnation(
				this.database,
				'cas',
				window.digest,
				window.incarnation
			)
		);
		return exists(
			this.database
				.select({ digest: object.digest })
				.from(object)
				.where(identity)
		);
	}
	private fence(
		claim: ListingAdoptionTaskClaim,
		row: Task,
		window?: ListingAdoptionExpansionWindow
	) {
		const table = schema.listingAdoptionTask;
		const source = listingAdoptionTaskSourceSchema.parse(row.source);
		const parents =
			source.kind === 'expand' && source.work.source.kind === 'cas'
				? sql`true`
				: exists(this.transition('listing-adoption-parents'));
		return and(
			this.owned(claim),
			eq(table.progressRevision, row.progressRevision),
			this.ready(),
			parents,
			window === undefined ? undefined : this.sourceCurrent(window)
		);
	}
	private current(
		claim: ListingAdoptionTaskClaim,
		row: Task,
		window?: ListingAdoptionExpansionWindow
	) {
		return exists(
			this.database
				.select({ id: schema.listingAdoptionTask.id })
				.from(schema.listingAdoptionTask)
				.where(this.fence(claim, row, window))
		);
	}
	private targetQuery(
		page: Exclude<ListingAdoptionExpansionPage, { kind: 'cas' }>
	) {
		const parent = schema.listingAdoptionParent;
		const fact = schema.listingFact;
		const candidates = JSON.stringify(page.targets);
		return sql`SELECT c.value AS target FROM json_each(${candidates}) AS c
 INNER JOIN ${parent} ON ${parent.id}=json_extract(c.value,'$.parent.id')
 AND ${parent.tenant}=json_extract(c.value,'$.parent.tenant')
 AND ${parent.cacheKind}=json_extract(c.value,'$.parent.cache.kind')
 AND ${parent.cacheName} IS json_extract(c.value,'$.parent.cache.name')
 AND ${parent.cacheGeneration}=json_extract(c.value,'$.parent.cacheGeneration')
 AND ${parent.storePathHash}=json_extract(c.value,'$.parent.storePathHash')
 AND ${parent.generation}=json_extract(c.value,'$.parent.generation')
 AND ${parent.narHash}=json_extract(c.value,'$.parent.narHash')
 INNER JOIN ${fact} ON ${fact.narHash}=${parent.narHash}
 AND ${fact.narHash}=json_extract(c.value,'$.identity.narHash')
 AND ${fact.generatorRevision}=json_extract(c.value,'$.identity.generatorRevision')`;
	}
	private taskSource(source: SQL) {
		return this.database
			.select({
				id: sql`lower(hex(randomblob(16)))`.as('id'),
				epoch: sql`lower(hex(randomblob(16)))`.as('epoch'),
				kind: sql`json_extract(payload,'$.kind')`.as('kind'),
				workId: sql`json_extract(payload,'$.work.id')`.as('work_id'),
				parentId: sql`json_extract(payload,'$.target.parent.id')`.as(
					'parent_id'
				),
				generatorRevision:
					sql`json_extract(payload,'$.target.identity.generatorRevision')`.as(
						'generator_revision'
					),
				source: sql`payload`.as('source'),
				availableAt: databaseNow.as('available_at'),
				retryAt: databaseNow.as('retry_at'),
				owner: sql`NULL`.as('owner'),
				generation: sql`0`.as('generation'),
				leaseExpiresAt: sql`NULL`.as('lease_expires_at'),
				progressRevision: sql`0`.as('progress_revision'),
				window: sql`NULL`.as('window'),
				scanned: sql`0`.as('scanned'),
				enrolled: sql`0`.as('enrolled'),
				outcome: sql`NULL`.as('outcome'),
				completedAt: sql`NULL`.as('completed_at'),
				createdAt: sql`created_at`.as('created_at'),
				updatedAt: databaseNow.as('updated_at')
			})
			.from(sql`(${source}) AS enrolment`)
			.where(sql`true`);
	}
	private enrolTargets(query: SQL, current: SQL) {
		const table = schema.listingAdoptionTask;
		const source = sql`SELECT json_object('kind','deliver','target',json(target)) AS payload,${databaseNow} AS created_at FROM (${query}) WHERE ${current}`;
		return this.database
			.insert(table)
			.select(this.taskSource(source))
			.onConflictDoUpdate({
				target: [table.parentId, table.generatorRevision],
				targetWhere: sql`${table.kind}='deliver'`,
				set: {
					epoch: sql`lower(hex(randomblob(16)))`,
					source: sql`excluded.source`,
					availableAt: databaseNow,
					retryAt: databaseNow,
					owner: sql`NULL`,
					generation: 0,
					leaseExpiresAt: sql`NULL`,
					progressRevision: 0,
					scanned: 0,
					enrolled: 0,
					outcome: sql`NULL`,
					completedAt: sql`NULL`,
					updatedAt: databaseNow
				},
				setWhere: isNotNull(table.completedAt)
			});
	}
	private casQuery(
		page: Extract<ListingAdoptionExpansionPage, { kind: 'cas' }>
	) {
		const fact = schema.listingFact;
		return sql`SELECT ${fact.narHash} AS nar_hash,${fact.generatorRevision} AS generator_revision FROM json_each(${JSON.stringify(page.identities)}) AS c
 INNER JOIN ${fact} ON ${fact.narHash}=json_extract(c.value,'$.narHash') AND ${fact.generatorRevision}=json_extract(c.value,'$.generatorRevision') AND ${fact.digest}=${page.window.digest}`;
	}
	private async checkpoint(
		claim: ListingAdoptionTaskClaim,
		row: Task,
		page: ListingAdoptionExpansionPage
	): Promise<ListingAdoptionTaskAdvanceResult> {
		const current = this.current(claim, row, page.window);
		const query =
			page.kind === 'cas' ? this.casQuery(page) : this.targetQuery(page);
		const enrol =
			page.kind === 'cas'
				? this.database.insert(schema.listingAdoptionCaptureEvent).select(
						this.database
							.select({
								id: sql`NULL`.as('id'),
								source:
									sql`json_object('kind','listing','identity',json_object('narHash',nar_hash,'generatorRevision',generator_revision))`.as(
										'source'
									),
								createdAt: databaseNow.as('created_at')
							})
							.from(sql`(${query}) AS identities`)
							.where(current)
					)
				: this.enrolTargets(query, current);
		const table = schema.listingAdoptionTask;
		const [, rows] = await this.database.batch([
			enrol,
			this.database
				.update(table)
				.set({
					window: page.window,
					progressRevision: sql`${table.progressRevision}+1`,
					scanned: sql`${table.scanned}+${page.scanned}`,
					enrolled: sql`${table.enrolled}+(SELECT count(*) FROM (${query}))`,
					owner: sql`NULL`,
					leaseExpiresAt: sql`NULL`,
					availableAt: databaseNow,
					completedAt: page.isComplete ? databaseNow : sql`NULL`,
					updatedAt: databaseNow
				})
				.where(this.fence(claim, row, page.window))
				.returning({ scanned: table.scanned, enrolled: table.enrolled })
		]);
		const saved = rows[0];
		if (saved === undefined) {
			return { kind: 'stale' };
		}
		return {
			kind: 'advanced',
			scanned: saved.scanned - row.scanned,
			enrolled: saved.enrolled - row.enrolled,
			isComplete: page.isComplete
		};
	}
	private async complete(
		claim: ListingAdoptionTaskClaim,
		row: Task
	): Promise<ListingAdoptionTaskAdvanceResult> {
		const table = schema.listingAdoptionTask;
		const rows = await this.database
			.update(table)
			.set({
				owner: sql`NULL`,
				leaseExpiresAt: sql`NULL`,
				completedAt: databaseNow,
				updatedAt: databaseNow,
				progressRevision: sql`${table.progressRevision}+1`
			})
			.where(this.fence(claim, row))
			.returning({ id: table.id });
		return { kind: rows.length === 0 ? 'stale' : 'complete' };
	}
	private async claimMany(
		ids: readonly ListingAdoptionTaskId[],
		owner: ArtifactTaskOwner,
		kind?: ListingAdoptionReservation['kind']
	) {
		z.array(listingAdoptionTaskIdSchema).min(1).max(8).parse(ids);
		return this.execute(async () => {
			if (!(await this.isInstalled())) {
				return { kind: 'unavailable' as const };
			}
			const table = schema.listingAdoptionTask;
			const same = and(
				eq(table.owner, owner),
				gt(table.leaseExpiresAt, databaseNow)
			);
			const eligibility = and(
				inArray(table.id, jsonValueList(ids)),
				kind === undefined ? undefined : eq(table.kind, kind),
				isNull(table.completedAt),
				lte(table.retryAt, databaseNow),
				or(this.unowned(), eq(table.owner, owner)),
				exists(this.transition('listing-adoption-tasks'))
			);
			const rows = await this.database
				.update(table)
				.set({
					owner,
					generation: sql`CASE WHEN ${same} THEN ${table.generation} ELSE ${table.generation}+1 END`,
					leaseExpiresAt: sql`CASE WHEN ${same} THEN ${table.leaseExpiresAt} ELSE ${deadline} END`,
					availableAt: sql`CASE WHEN ${same} THEN ${table.leaseExpiresAt} ELSE ${deadline} END`,
					updatedAt: databaseNow
				})
				.where(eligibility)
				.returning({
					id: table.id,
					epoch: table.epoch,
					owner: table.owner,
					generation: table.generation,
					leaseExpiresAt: table.leaseExpiresAt
				});
			return {
				kind: 'claimed' as const,
				claims: rows.map((row) => listingAdoptionTaskClaimSchema.parse(row))
			};
		});
	}
	private deliveryUpdate(resolution: ListingAdoptionDeliveryResolution) {
		const table = schema.listingAdoptionTask;
		const deferred =
			resolution.kind === 'deferred'
				? sql`strftime('%Y-%m-%dT%H:%M:%fZ','now',${`+${resolution.delaySeconds.toString()} seconds`})`
				: undefined;
		const fields =
			resolution.kind === 'finished'
				? { outcome: resolution.outcome, completedAt: databaseNow }
				: {
						availableAt: deferred,
						retryAt: deferred,
						outcome: resolution.outcome
					};
		return this.database
			.update(table)
			.set({
				...fields,
				owner: sql`NULL`,
				leaseExpiresAt: sql`NULL`,
				updatedAt: databaseNow
			})
			.where(and(this.owned(resolution.claim), eq(table.kind, 'deliver')))
			.returning({ id: table.id });
	}
	async isInstalled(): Promise<boolean> {
		return this.execute(
			async () =>
				(await this.transition('listing-adoption-tasks').get()) !== undefined
		);
	}
	async reserveWork(limit = 8): Promise<readonly ListingAdoptionReservation[]> {
		z.number().int().min(1).max(8).parse(limit);
		return this.execute(async () => {
			if (!(await this.isInstalled())) {
				return [];
			}
			const table = schema.listingAdoptionTask;
			const eligible = and(
				isNull(table.completedAt),
				this.unowned(),
				lte(table.availableAt, databaseNow),
				exists(this.transition('listing-adoption-tasks'))
			);
			const selected = this.database
				.select({ id: table.id })
				.from(table)
				.where(eligible)
				.orderBy(asc(table.availableAt), asc(table.id))
				.limit(limit);
			const rows = await this.database
				.update(table)
				.set({ availableAt: deadline })
				.where(and(eligible, inArray(table.id, selected)))
				.returning({ id: table.id, kind: table.kind });
			return rows
				.map((row) => listingAdoptionReservationSchema.parse(row))
				.toSorted((left, right) => byCodeUnit(left.id, right.id));
		});
	}
	async reserve(limit = 8): Promise<readonly ListingAdoptionTaskId[]> {
		const work = await this.reserveWork(limit);
		return work.map((item) => item.id);
	}
	async claim(
		id: ListingAdoptionTaskId,
		owner: ArtifactTaskOwner,
		kind?: ListingAdoptionReservation['kind']
	): Promise<ListingAdoptionTaskClaimResult> {
		const result = await this.claimMany([id], owner, kind);
		if (result.kind === 'unavailable') {
			return result;
		}
		const claim = result.claims[0];
		return claim === undefined ? { kind: 'idle' } : { kind: 'claimed', claim };
	}
	async claimDeliveries(
		ids: readonly ListingAdoptionTaskId[],
		owner: ArtifactTaskOwner
	) {
		return this.claimMany(ids, owner, 'deliver');
	}
	async prepareDeliveries(
		claims: readonly ListingAdoptionTaskClaim[]
	): Promise<ListingAdoptionPreparedDeliveries> {
		z.array(listingAdoptionTaskClaimSchema).min(1).max(8).parse(claims);
		return this.execute(async () => {
			if (
				!(await this.isInstalled()) ||
				(await this.transition('listing-adoption-parents').get()) === undefined
			) {
				return { kind: 'unavailable' };
			}
			const table = schema.listingAdoptionTask;
			const parent = schema.listingAdoptionParent;
			const selected = jsonRowList(claims).matches({
				id: table.id,
				epoch: table.epoch,
				owner: table.owner,
				generation: table.generation,
				leaseExpiresAt: table.leaseExpiresAt
			});
			const currentParent = sql<number>`EXISTS(SELECT 1 FROM ${parent} WHERE ${parent.id}=json_extract(${table.source},'$.target.parent.id') AND ${parent.tenant}=json_extract(${table.source},'$.target.parent.tenant') AND ${parent.cacheKind}=json_extract(${table.source},'$.target.parent.cache.kind') AND ${parent.cacheName} IS json_extract(${table.source},'$.target.parent.cache.name') AND ${parent.cacheGeneration}=json_extract(${table.source},'$.target.parent.cacheGeneration') AND ${parent.storePathHash}=json_extract(${table.source},'$.target.parent.storePathHash') AND ${parent.generation}=json_extract(${table.source},'$.target.parent.generation') AND ${parent.narHash}=json_extract(${table.source},'$.target.parent.narHash'))`;
			const eligibility = and(
				selected,
				eq(table.kind, 'deliver'),
				isNull(table.completedAt),
				gt(table.leaseExpiresAt, databaseNow),
				exists(this.transition('listing-adoption-tasks')),
				exists(this.transition('listing-adoption-parents'))
			);
			const rows = await this.database
				.select({
					claim: {
						id: table.id,
						epoch: table.epoch,
						owner: table.owner,
						generation: table.generation,
						leaseExpiresAt: table.leaseExpiresAt
					},
					source: table.source,
					outcome: table.outcome,
					currentParent
				})
				.from(table)
				.where(eligibility);
			const deliveries: ListingAdoptionDelivery[] = [];
			const obsolete: ListingAdoptionTaskClaim[] = [];
			for (const row of rows) {
				const claim = listingAdoptionTaskClaimSchema.parse(row.claim);
				const source = listingAdoptionTaskSourceSchema.parse(row.source);
				if (source.kind !== 'deliver') {
					throw new TypeError('A delivery task requires a captured parent');
				}
				if (z.number().int().min(0).max(1).parse(row.currentParent) === 0) {
					obsolete.push(claim);
					continue;
				}
				deliveries.push({
					claim,
					target: source.target,
					previousOutcome:
						row.outcome === null
							? undefined
							: listingAdoptionDeliveryOutcomeSchema.parse(row.outcome)
				});
			}
			return { kind: 'ready', deliveries, obsolete };
		});
	}
	async resolveDeliveries(
		resolutions: readonly ListingAdoptionDeliveryResolution[]
	): Promise<readonly ListingAdoptionTaskId[]> {
		const parsed = z
			.array(listingAdoptionDeliveryResolutionSchema)
			.min(1)
			.max(8)
			.parse(resolutions);
		return this.execute(async () => {
			if (!(await this.isInstalled())) {
				return [];
			}
			const updates = parsed.map((resolution) =>
				this.deliveryUpdate(resolution)
			);
			const first = updates[0];
			if (first === undefined) {
				return [];
			}
			const results = await this.database.batch([first, ...updates.slice(1)]);
			return results.flatMap((rows) =>
				rows.map((row) => listingAdoptionTaskIdSchema.parse(row.id))
			);
		});
	}
	async advance(
		claim: ListingAdoptionTaskClaim
	): Promise<ListingAdoptionTaskAdvanceResult> {
		return this.execute(async () => {
			if (!(await this.isInstalled())) {
				return { kind: 'unavailable' };
			}
			const row = await this.database
				.select()
				.from(schema.listingAdoptionTask)
				.where(this.owned(claim))
				.get();
			if (row === undefined) {
				return { kind: 'stale' };
			}
			const source = listingAdoptionTaskSourceSchema.parse(row.source);
			if (source.kind !== 'expand') {
				throw new TypeError('Only expansion tasks have discovery progress');
			}
			const discovery = new ListingAdoptionExpansionDiscovery(this.database);
			let window =
				row.window === null
					? undefined
					: listingAdoptionExpansionWindowSchema.parse(row.window);
			if (window === undefined) {
				const opened = await discovery.open(source.work.source);
				if (opened.kind !== 'window') {
					if (opened.kind === 'unavailable') {
						return { kind: 'unavailable' };
					}
					return this.complete(claim, row);
				}
				window = opened.window;
			}
			const result = await discovery.page(window);
			if (result.kind !== 'page') {
				if (result.kind === 'unavailable') {
					return { kind: 'unavailable' };
				}
				return this.complete(claim, row);
			}
			return this.checkpoint(claim, row, result.page);
		});
	}
	async defer(
		claim: ListingAdoptionTaskClaim,
		delay: number
	): Promise<boolean> {
		z.number().int().min(1).max(3600).parse(delay);
		return this.execute(async () => {
			if (!(await this.isInstalled())) {
				return false;
			}
			const table = schema.listingAdoptionTask;
			const rows = await this.database
				.update(table)
				.set({
					owner: sql`NULL`,
					leaseExpiresAt: sql`NULL`,
					availableAt: sql`strftime('%Y-%m-%dT%H:%M:%fZ','now',${`+${delay.toString()} seconds`})`,
					retryAt: sql`strftime('%Y-%m-%dT%H:%M:%fZ','now',${`+${delay.toString()} seconds`})`,
					updatedAt: databaseNow
				})
				.where(this.owned(claim))
				.returning({ id: table.id });
			return rows.length > 0;
		});
	}
	async finish(
		claim: ListingAdoptionTaskClaim,
		outcome: ListingAdoptionDeliveryOutcome
	): Promise<boolean> {
		const parsed = listingAdoptionDeliveryOutcomeSchema.parse(outcome);
		return this.execute(async () => {
			if (!(await this.isInstalled())) {
				return false;
			}
			const table = schema.listingAdoptionTask;
			const rows = await this.database
				.update(table)
				.set({
					outcome: parsed,
					owner: sql`NULL`,
					leaseExpiresAt: sql`NULL`,
					completedAt: databaseNow,
					updatedAt: databaseNow
				})
				.where(and(this.owned(claim), eq(table.kind, 'deliver')))
				.returning({ id: table.id });
			return rows.length > 0;
		});
	}
	async seed(): Promise<
		| {
				readonly kind: 'advanced';
				readonly scanned: number;
				readonly isComplete: boolean;
		  }
		| { readonly kind: 'complete' | 'stale' | 'unavailable' }
	> {
		return this.execute(async () => {
			if (!(await this.seedInstalled())) {
				return { kind: 'unavailable' };
			}
			const table = schema.listingAdoptionTaskSeed;
			const work = schema.listingAdoptionWork;
			const boundary = this.database
				.select({ id: work.id })
				.from(work)
				.orderBy(desc(work.id))
				.limit(1);
			await this.database.run(
				sql`INSERT INTO ${table} (id,through,is_complete) SELECT 1,(${boundary}),CASE WHEN (${boundary}) IS NULL THEN 1 ELSE 0 END WHERE ${this.ready()} ON CONFLICT (id) DO NOTHING`
			);
			const row = await this.database
				.select()
				.from(table)
				.where(eq(table.id, 1))
				.get();
			if (row === undefined) {
				return { kind: 'unavailable' };
			}
			if (row.isComplete) {
				return { kind: 'complete' };
			}
			if (row.through === null) {
				throw new TypeError(
					'An incomplete adoption seed requires an upper boundary'
				);
			}
			const selected = await this.database
				.select({ id: work.id })
				.from(work)
				.where(
					and(
						row.after === null ? undefined : gt(work.id, row.after),
						lte(work.id, row.through)
					)
				)
				.orderBy(asc(work.id))
				.limit(pageSize + 1);
			const ids = selected.slice(0, pageSize).map((item) => item.id);
			const isComplete = selected.length <= pageSize;
			const after = isComplete ? row.through : ids.at(-1);
			if (after === undefined) {
				throw new TypeError('A nonterminal seed page requires a cursor');
			}
			const fence = and(
				eq(table.id, 1),
				eq(table.epoch, row.epoch),
				row.after === null ? isNull(table.after) : eq(table.after, row.after),
				eq(table.through, row.through),
				eq(table.scanned, row.scanned),
				eq(table.isComplete, false),
				this.ready()
			);
			const current = exists(
				this.database.select({ id: table.id }).from(table).where(fence)
			);
			const source = this.database
				.select()
				.from(work)
				.where(inArray(work.id, jsonValueList(ids)));
			const [, saved] = await this.database.batch([
				this.database
					.insert(schema.listingAdoptionTask)
					.select(
						this.taskSource(
							sql`SELECT json_object('kind','expand','work',json_object('id',id,'consumerEpoch',consumer_epoch,'eventId',event_id,'source',json(source),'createdAt',created_at)) AS payload,created_at FROM (${source}) WHERE ${current}`
						)
					)
					.onConflictDoNothing({ target: schema.listingAdoptionTask.workId }),
				this.database
					.update(table)
					.set({
						after,
						isComplete,
						scanned: sql`${table.scanned}+(SELECT count(*) FROM (${source}))`
					})
					.where(fence)
					.returning({ scanned: table.scanned })
			]);
			const next = saved[0];
			return next === undefined
				? { kind: 'stale' }
				: { kind: 'advanced', scanned: next.scanned - row.scanned, isComplete };
		});
	}
}
