import {
	narInfoGenerationSchema,
	storePathHashSchema,
	type TenantId
} from '@cupboard/nix-store/scalars';
import {
	and,
	asc,
	eq,
	exists,
	inArray,
	isNotNull,
	isNull,
	lte,
	notExists,
	or,
	sql
} from 'drizzle-orm';
import { z } from 'zod';

import { type AttestationListRevision } from '../db/attestation-list-revision.ts';
import {
	type CacheId,
	cacheScopeFromRow,
	type ResolvedCache
} from '../db/cache.ts';
import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import { narInfoReferenceQuery } from '../read/read.ts';

import { AttestationListRefreshService } from './attestation-list-refresh-service.ts';
import { attestationListRefreshCursorKey } from './attestation-list-refresh-state.ts';
import { type ServerContext } from './context.ts';
import { jsonValueList } from './json-list.ts';
import { hasSubrequestsFor } from './subrequest-slice.ts';

const retirementChecksSchema = z.array(
	z.object({ needsRetirement: z.number().int().min(0).max(1) })
);
const cacheCursorSchema = z.object({
	storePathHash: storePathHashSchema,
	generation: narInfoGenerationSchema
});
type CacheCursor = z.infer<typeof cacheCursorSchema>;

export type CacheListTeardownProgress =
	| { readonly status: 'drained' }
	| { readonly status: 'pending'; readonly nextWorkAt: number };

export class AttestationListTeardownService {
	constructor(
		private readonly context: ServerContext,
		private readonly tenant: TenantId
	) {}

	private async revisionPage(
		limit: number
	): Promise<AttestationListRevision[]> {
		const revisions = d1Schema.attestationListRevision;
		const defaults = await this.context.d1
			.select()
			.from(revisions)
			.where(
				and(
					eq(revisions.tenant, this.tenant),
					sql`${revisions.cacheKind} = 'default'`
				)
			)
			.orderBy(revisions.storePathHash, revisions.generation)
			.limit(limit);
		if (defaults.length > 0) {
			return defaults;
		}
		return this.context.d1
			.select()
			.from(revisions)
			.where(
				and(
					eq(revisions.tenant, this.tenant),
					sql`${revisions.cacheKind} = 'named'`
				)
			)
			.orderBy(
				revisions.cacheName,
				revisions.storePathHash,
				revisions.generation
			)
			.limit(limit);
	}

	private captureKey(row: AttestationListRevision, cacheId?: CacheId): void {
		if (
			row.publishedKey === null ||
			row.publishedCacheGeneration === null ||
			row.publishedNarHash === null
		) {
			return;
		}
		this.context.db
			.insert(schema.attestationListRefreshJobs)
			.values({
				...(cacheId !== undefined && { cacheId }),
				id: `retired-revision-${String(row.id)}-${String(row.revision)}`,
				source: {
					captured: { id: row.id, revision: row.revision },
					identity: {
						cache: cacheScopeFromRow({
							kind: row.cacheKind,
							name: row.cacheName
						}),
						storePathHash: row.storePathHash,
						generation: row.generation
					},
					parent: {
						cacheGeneration: row.publishedCacheGeneration,
						narHash: row.publishedNarHash
					}
				},
				key: row.publishedKey,
				phase: 'cleanup',
				cleanupAt: Date.now()
			})
			.onConflictDoNothing()
			.run();
	}

	private retireActiveJobs(): void {
		this.context.db.delete(schema.attestationListRefreshLease).run();
		const active = this.context.db
			.select({ id: schema.attestationListRefreshJobs.id })
			.from(schema.attestationListRefreshJobs)
			.where(isNull(schema.attestationListRefreshJobs.cleanupAt))
			.limit(1)
			.get();
		if (active === undefined) {
			return;
		}
		this.context.db
			.update(schema.attestationListRefreshJobs)
			.set({
				phase: 'cleanup',
				cleanupAt: sql`max(${Date.now()}, ${schema.attestationListRefreshJobs.cleanupNotBefore})`
			})
			.where(eq(schema.attestationListRefreshJobs.id, active.id))
			.run();
	}

	private drainStaging(limit: number): void {
		for (const table of [
			schema.attestationListRefreshChunks,
			schema.attestationListRefreshParts
		]) {
			const selected = this.context.db
				.select({ rowid: sql<number>`rowid` })
				.from(table)
				.orderBy(
					table.jobId,
					'sequence' in table ? table.sequence : table.partNumber
				)
				.limit(limit);
			this.context.db
				.delete(table)
				.where(inArray(sql`rowid`, selected))
				.run();
		}
		const retries = this.context.db
			.select({ id: schema.attestationListRefreshRetries.revisionId })
			.from(schema.attestationListRefreshRetries)
			.orderBy(asc(schema.attestationListRefreshRetries.revisionId))
			.limit(limit);
		this.context.db
			.delete(schema.attestationListRefreshRetries)
			.where(inArray(schema.attestationListRefreshRetries.revisionId, retries))
			.run();
		this.context.db.delete(schema.attestationListRefreshWake).run();
	}

	private hasLocalResidue(): boolean {
		for (const table of [
			schema.attestationListRefreshJobs,
			schema.attestationListRefreshChunks,
			schema.attestationListRefreshParts,
			schema.attestationListRefreshRetries
		]) {
			const row = this.context.db
				.select({ one: sql`1` })
				.from(table)
				.limit(1)
				.get();
			if (row !== undefined) {
				return true;
			}
		}
		return false;
	}

	private cacheCursorKey(cache: ResolvedCache): string {
		return `attestation-list:cache-teardown:${String(cache.id)}`;
	}

	private async cachePage(
		cache: ResolvedCache,
		after: CacheCursor | undefined,
		limit: number
	): Promise<AttestationListRevision[]> {
		const revisions = d1Schema.attestationListRevision;
		const scope =
			cache.scope.kind === 'default'
				? sql`${revisions.cacheKind} = 'default'`
				: and(
						sql`${revisions.cacheKind} = 'named'`,
						eq(revisions.cacheName, cache.scope.name)
					);
		return this.context.d1
			.select()
			.from(revisions)
			.where(
				and(
					eq(revisions.tenant, this.tenant),
					scope,
					after === undefined
						? undefined
						: sql`(${revisions.storePathHash}, ${revisions.generation}) > (${after.storePathHash}, ${after.generation})`
				)
			)
			.orderBy(revisions.storePathHash, revisions.generation)
			.limit(limit);
	}

	private retireCacheJobs(cache: ResolvedCache): void {
		const jobs = this.context.db
			.select({ id: schema.attestationListRefreshJobs.id })
			.from(schema.attestationListRefreshJobs)
			.where(eq(schema.attestationListRefreshJobs.cacheId, cache.id))
			.orderBy(schema.attestationListRefreshJobs.id)
			.limit(16);
		this.context.db
			.update(schema.attestationListRefreshJobs)
			.set({
				phase: 'cleanup',
				cleanupAt: sql`max(coalesce(${schema.attestationListRefreshJobs.cleanupAt}, ${Date.now()}), ${schema.attestationListRefreshJobs.cleanupNotBefore})`
			})
			.where(inArray(schema.attestationListRefreshJobs.id, jobs))
			.run();
		const retries = this.context.db
			.select({ id: schema.attestationListRefreshRetries.revisionId })
			.from(schema.attestationListRefreshRetries)
			.where(eq(schema.attestationListRefreshRetries.cacheId, cache.id))
			.orderBy(schema.attestationListRefreshRetries.revisionId)
			.limit(16);
		this.context.db
			.delete(schema.attestationListRefreshRetries)
			.where(inArray(schema.attestationListRefreshRetries.revisionId, retries))
			.run();
	}

	private hasCacheResidue(cache: ResolvedCache): boolean {
		for (const table of [
			schema.attestationListRefreshJobs,
			schema.attestationListRefreshRetries
		]) {
			if (
				this.context.db
					.select({ one: sql`1` })
					.from(table)
					.where(eq(table.cacheId, cache.id))
					.limit(1)
					.get() !== undefined
			) {
				return true;
			}
		}
		return false;
	}

	private async retireCacheRows(
		cache: ResolvedCache,
		rows: readonly AttestationListRevision[]
	): Promise<boolean> {
		const table = d1Schema.attestationListRevision;
		const statements = rows.flatMap((row) => {
			if (
				row.publishedCacheGeneration !== null &&
				row.publishedCacheGeneration > cache.generation
			) {
				return [];
			}
			this.captureKey(row, cache.id);
			const parent = narInfoReferenceQuery(
				this.context.d1,
				this.tenant,
				cache.scope,
				jsonValueList([row.storePathHash])
			).as('retained_list_parent');
			const liveParent = this.context.d1
				.select({ one: sql`1` })
				.from(parent)
				.where(
					sql`retained_list_parent.generation = ${row.generation} AND retained_list_parent.cache_generation > ${cache.generation}`
				);
			const captured = and(
				eq(table.tenant, this.tenant),
				eq(table.id, row.id),
				eq(table.revision, row.revision),
				row.publishedKey === null
					? isNull(table.publishedKey)
					: eq(table.publishedKey, row.publishedKey),
				or(
					isNull(table.publishedCacheGeneration),
					lte(table.publishedCacheGeneration, cache.generation)
				)
			);
			const needsRetirement = and(
				or(
					isNull(table.publishedCacheGeneration),
					lte(table.publishedCacheGeneration, cache.generation)
				),
				or(isNotNull(table.publishedKey), notExists(liveParent))
			);
			return [
				this.context.d1
					.delete(table)
					.where(and(captured, notExists(liveParent))),
				this.context.d1
					.update(table)
					.set({
						publishedRevision: sql`null`,
						publishedCacheGeneration: sql`null`,
						publishedNarHash: sql`null`,
						publishedKey: sql`null`
					})
					.where(and(captured, exists(liveParent))),
				this.context.d1
					.select({
						needsRetirement: sql<number>`case when ${needsRetirement} then 1 else 0 end`
					})
					.from(table)
					.where(and(eq(table.tenant, this.tenant), eq(table.id, row.id)))
			];
		});
		const [first, ...rest] = statements;
		if (first === undefined) {
			return true;
		}
		const results = await this.context.d1.batch([first, ...rest]);
		for (let index = 2; index < results.length; index += 3) {
			const checked = retirementChecksSchema.parse(results[index]);
			if (checked.some((row) => row.needsRetirement === 1)) {
				return false;
			}
		}
		return true;
	}

	private nextCleanupAt(now: number, cache?: ResolvedCache): number {
		const jobs = schema.attestationListRefreshJobs;
		return (
			this.context.db
				.select({ at: jobs.cleanupAt })
				.from(jobs)
				.where(cache === undefined ? undefined : eq(jobs.cacheId, cache.id))
				.orderBy(jobs.cleanupAt)
				.limit(1)
				.get()?.at ?? now
		);
	}

	private pendingCacheWork(
		cache: ResolvedCache,
		now: number
	): CacheListTeardownProgress {
		const retry = this.context.db
			.select({ id: schema.attestationListRefreshRetries.revisionId })
			.from(schema.attestationListRefreshRetries)
			.where(eq(schema.attestationListRefreshRetries.cacheId, cache.id))
			.limit(1)
			.get();
		return {
			status: 'pending',
			nextWorkAt:
				retry === undefined
					? Math.max(now, this.nextCleanupAt(now, cache))
					: now
		};
	}

	async advanceCache(
		cache: ResolvedCache,
		limit: number
	): Promise<CacheListTeardownProgress> {
		if (!hasSubrequestsFor(8)) {
			return { status: 'pending', nextWorkAt: Date.now() };
		}
		const now = Date.now();
		const cursorKey = this.cacheCursorKey(cache);
		const stored: unknown = await this.context.ctx.storage.get(cursorKey);
		const parsed = cacheCursorSchema.safeParse(stored);
		const after = parsed.success ? parsed.data : undefined;
		const pageSize = Math.max(1, Math.min(16, limit));
		const jobs = this.context.db
			.select({ id: schema.attestationListRefreshJobs.id })
			.from(schema.attestationListRefreshJobs)
			.limit(16)
			.all();
		const capacity = Math.min(pageSize, 16 - jobs.length);
		const rows = await this.cachePage(cache, after, Math.max(1, capacity));
		if (rows.length === 0 && !this.hasCacheResidue(cache)) {
			await this.context.ctx.storage.delete(cursorKey);
			return { status: 'drained' };
		}
		if (capacity === 0) {
			this.retireCacheJobs(cache);
			await new AttestationListRefreshService(
				this.context
			).cleanupRetiredInSection(this.tenant);
			const remainingJobs = this.context.db
				.select({ id: schema.attestationListRefreshJobs.id })
				.from(schema.attestationListRefreshJobs)
				.limit(16)
				.all();
			return {
				status: 'pending',
				nextWorkAt:
					remainingJobs.length < 16
						? now
						: Math.max(now, this.nextCleanupAt(now))
			};
		}
		this.retireCacheJobs(cache);
		const areRowsRetired = await this.retireCacheRows(cache, rows);
		const last = rows.at(-1);
		const next =
			last === undefined || !areRowsRetired
				? after
				: { storePathHash: last.storePathHash, generation: last.generation };
		if (next !== undefined) {
			await this.context.ctx.storage.put(cursorKey, next);
		}
		await new AttestationListRefreshService(
			this.context
		).cleanupRetiredInSection(this.tenant);
		const remaining = await this.cachePage(cache, next, 1);
		if (remaining.length > 0) {
			return { status: 'pending', nextWorkAt: now };
		}
		if (this.hasCacheResidue(cache)) {
			return this.pendingCacheWork(cache, now);
		}
		await this.context.ctx.storage.delete(cursorKey);
		return { status: 'drained' };
	}

	async advance(limit: number): Promise<boolean> {
		const registry = await this.context.d1
			.select({ status: d1Schema.tenant.status })
			.from(d1Schema.tenant)
			.where(eq(d1Schema.tenant.id, this.tenant))
			.get();
		if (
			registry?.status !== 'offboarding' &&
			registry?.status !== 'offboarded'
		) {
			return false;
		}
		const pageSize = Math.max(1, Math.min(16, limit));
		this.retireActiveJobs();
		this.drainStaging(pageSize);
		await this.context.ctx.storage.delete(attestationListRefreshCursorKey);
		const jobs = this.context.db
			.select({ id: schema.attestationListRefreshJobs.id })
			.from(schema.attestationListRefreshJobs)
			.limit(16)
			.all();
		const available = Math.min(pageSize, 16 - jobs.length);
		const rows = available === 0 ? [] : await this.revisionPage(available);

		for (const row of rows) {
			this.captureKey(row);
		}
		if (rows.length > 0) {
			const ids = jsonValueList(rows.map((row) => row.id));
			await this.context.d1
				.delete(d1Schema.attestationListRevision)
				.where(
					and(
						eq(d1Schema.attestationListRevision.tenant, this.tenant),
						inArray(d1Schema.attestationListRevision.id, ids)
					)
				);
		}
		await new AttestationListRefreshService(
			this.context
		).cleanupRetiredInSection(this.tenant);
		const remaining = await this.revisionPage(1);
		return remaining.length === 0 && !this.hasLocalResidue();
	}
}
