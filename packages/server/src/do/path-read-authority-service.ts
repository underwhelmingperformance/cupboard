import {
	type CacheScope,
	type NarInfoGeneration,
	type StorePathHash,
	type TenantId
} from '@cupboard/nix-store/scalars';
import { and, eq, notExists, sql } from 'drizzle-orm';
import { type DrizzleD1Database } from 'drizzle-orm/d1';

import {
	cacheIdentityColumns,
	cacheIdentityCondition,
	type ResolvedCache
} from '../db/cache.ts';
import * as schema from '../db/d1-schema.ts';
import { PathReadAuthorityMigrationPendingError } from '../errors.ts';

import { armAlarmNoLaterThan, type MaintenanceProgress } from './alarm.ts';
import { batchNonEmpty, chunk } from './bulk.ts';
import { type ServerContext } from './context.ts';
import { type JsonRowList, jsonRowList } from './json-list.ts';

export const pathReadDemotionPendingKey = 'read-authority:demotion-pending';
export const pathReadDemotionPageSize = 100;

export class PathReadAuthorityService {
	constructor(private readonly context: ServerContext) {}

	async requireWritable(): Promise<void> {
		if (this.context.referenceStorageContracted) {
			return;
		}
		await this.context.transitions.refresh();
		if (
			!(await this.context.transitions.hasReached(
				'blob-reference-read-authority',
				'complete'
			))
		) {
			throw new PathReadAuthorityMigrationPendingError();
		}
		this.context.referenceStorageContracted = true;
	}

	async revoke(
		cache: ResolvedCache,
		paths: readonly {
			readonly storePathHash: StorePathHash;
			readonly generation: NarInfoGeneration;
		}[]
	): Promise<void> {
		if (paths.length === 0) {
			return;
		}
		await this.context.ctx.storage.put(pathReadDemotionPendingKey, true);
		const fence = schema.pathReadRevocation;
		for (const page of chunk(paths, pathReadDemotionPageSize)) {
			await batchNonEmpty(
				this.context.d1,
				page.map((entry) =>
					this.context.d1
						.insert(fence)
						.values({
							tenant: this.context.requireTenant(),
							...cacheIdentityColumns(cache.scope),
							storePathHash: entry.storePathHash,
							cacheGeneration: cache.generation,
							generation: entry.generation,
							isPending: true
						})
						.onConflictDoUpdate({
							target:
								cache.scope.kind === 'default'
									? [fence.tenant, fence.storePathHash]
									: [fence.tenant, fence.cacheName, fence.storePathHash],
							targetWhere:
								cache.scope.kind === 'default'
									? sql`${fence.cacheKind} = 'default'`
									: sql`${fence.cacheKind} = 'named'`,
							set: {
								cacheGeneration: cache.generation,
								generation: sql`case when ${fence.cacheGeneration} < ${cache.generation} then excluded.generation else max(${fence.generation}, excluded.generation) end`,
								isPending: true
							},
							setWhere: sql`${fence.cacheGeneration} <= ${cache.generation}`
						})
				)
			);
		}
		await armAlarmNoLaterThan(this.context.ctx.storage, Date.now());
	}

	async hasPending(): Promise<boolean> {
		return (
			(await this.context.ctx.storage.get<boolean>(
				pathReadDemotionPendingKey
			)) === true
		);
	}

	/**
	Call under the tenant critical section so clearing the wake marker cannot race a new fence.
	*/
	async drain(): Promise<MaintenanceProgress> {
		await this.requireWritable();
		const fence = schema.pathReadRevocation;
		const pendingFilter = and(
			eq(fence.tenant, this.context.requireTenant()),
			eq(fence.isPending, true)
		);
		const [pending] = await this.context.d1
			.select()
			.from(fence)
			.where(pendingFilter)
			.orderBy(fence.cacheKind, fence.cacheName, fence.storePathHash)
			.limit(1)
			.all();
		if (pending === undefined) {
			await this.context.ctx.storage.delete(pathReadDemotionPendingKey);
			return 'progressed';
		}
		let cache: CacheScope;
		if (pending.cacheKind === 'default') {
			cache = { kind: 'default' };
		} else {
			if (pending.cacheName === null) {
				throw new Error('The read revocation fence has no cache name.');
			}
			cache = { kind: 'named', name: pending.cacheName };
		}
		const blob = schema.blobReference;
		const reference = schema.attestationReference;
		const identity = and(
			eq(fence.tenant, pending.tenant),
			cacheIdentityCondition(fence.cacheKind, fence.cacheName, cache),
			eq(fence.storePathHash, pending.storePathHash),
			eq(fence.cacheGeneration, pending.cacheGeneration),
			eq(fence.generation, pending.generation)
		);
		const blobFilter = and(
			eq(blob.tenant, pending.tenant),
			cacheIdentityCondition(blob.cacheKind, blob.cacheName, cache),
			eq(blob.storePathHash, pending.storePathHash),
			eq(blob.cacheGeneration, pending.cacheGeneration),
			sql`${blob.generation} <= ${pending.generation}`,
			eq(blob.readable, true)
		);
		const referenceFilter = and(
			eq(reference.tenant, pending.tenant),
			cacheIdentityCondition(reference.cacheKind, reference.cacheName, cache),
			eq(reference.storePathHash, pending.storePathHash),
			sql`${reference.generation} <= ${pending.generation}`,
			eq(reference.readable, true)
		);
		const [blobs, references] = await this.context.d1.batch([
			this.context.d1
				.select({ generation: blob.generation })
				.from(blob)
				.where(blobFilter)
				.orderBy(blob.generation)
				.limit(pathReadDemotionPageSize + 1),
			this.context.d1
				.select({
					generation: reference.generation,
					predicateType: reference.predicateType,
					digest: reference.digest
				})
				.from(reference)
				.where(referenceFilter)
				.orderBy(
					reference.generation,
					reference.predicateType,
					reference.digest
				)
				.limit(pathReadDemotionPageSize + 1)
		]);
		const selectedBlobs = blobs.slice(0, pathReadDemotionPageSize);
		const selectedReferences = references.slice(0, pathReadDemotionPageSize);
		const hasMore =
			blobs.length > pathReadDemotionPageSize ||
			references.length > pathReadDemotionPageSize;

		const selectedBlobFilter = and(
			blobFilter,
			jsonRowList(selectedBlobs).matches({ generation: blob.generation })
		);
		const selectedReferenceFilter = and(
			referenceFilter,
			jsonRowList(selectedReferences).matches({
				generation: reference.generation,
				predicateType: reference.predicateType,
				digest: reference.digest
			})
		);
		const blobDemotion =
			selectedBlobs.length === 0
				? []
				: [
						this.context.d1
							.update(blob)
							.set({ readable: false })
							.where(selectedBlobFilter)
					];
		const referenceDemotion =
			selectedReferences.length === 0
				? []
				: [
						this.context.d1
							.update(reference)
							.set({ readable: false })
							.where(selectedReferenceFilter)
					];
		await batchNonEmpty(this.context.d1, [
			...blobDemotion,
			...referenceDemotion,
			this.context.d1.update(fence).set({ isPending: hasMore }).where(identity)
		]);

		return 'progressed';
	}
}

export function reclaimPathReadFence(
	database: DrizzleD1Database<typeof schema>,
	tenant: TenantId,
	cache: CacheScope,
	paths: JsonRowList<{ readonly storePathHash: StorePathHash }>
) {
	const fence = schema.pathReadRevocation;
	const blob = schema.blobReference;
	const reference = schema.attestationReference;
	const blobRemains = database
		.select({ generation: blob.generation })
		.from(blob)
		.where(
			and(
				eq(blob.tenant, fence.tenant),
				cacheIdentityCondition(blob.cacheKind, blob.cacheName, cache),
				eq(blob.storePathHash, fence.storePathHash),
				eq(blob.cacheGeneration, fence.cacheGeneration),
				sql`${blob.generation} <= ${fence.generation}`
			)
		)
		.limit(1);
	const referenceRemains = database
		.select({ generation: reference.generation })
		.from(reference)
		.where(
			and(
				eq(reference.tenant, fence.tenant),
				cacheIdentityCondition(reference.cacheKind, reference.cacheName, cache),
				eq(reference.storePathHash, fence.storePathHash),
				sql`${reference.generation} <= ${fence.generation}`
			)
		)
		.limit(1);
	return database
		.delete(fence)
		.where(
			and(
				eq(fence.tenant, tenant),
				cacheIdentityCondition(fence.cacheKind, fence.cacheName, cache),
				paths.matches({ storePathHash: fence.storePathHash }),
				notExists(blobRemains),
				notExists(referenceRemains)
			)
		);
}
