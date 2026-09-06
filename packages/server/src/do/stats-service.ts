import type { CacheScope } from '@cupboard/nix-store/scalars';
import {
	type StatsResponseInput,
	type UsageResponseInput
} from '@cupboard/protocol/upload';
import { and, count, eq } from 'drizzle-orm';

import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';

import { type ServerContext } from './context.ts';

export class StatsService {
	constructor(private readonly context: ServerContext) {}

	async stats(cacheScope: CacheScope): Promise<StatsResponseInput> {
		const cache = this.context.cacheRepository.resolve(cacheScope);

		if (cache === undefined) {
			return {
				storePaths: 0,
				narBlobs: 0,
				narFileSize: 0,
				casObjects: 0,
				casFileSize: 0,
				pendingUploads: 0,
				totalFileSize: 0
			};
		}

		const tenant = this.context.requireTenant();
		const storePaths = this.context.db
			.select({ count: count() })
			.from(schema.narInfos)
			.where(eq(schema.narInfos.cacheId, cache.id))
			.get();
		const pending = this.context.db
			.select({ count: count() })
			.from(schema.pendingUploads)
			.where(eq(schema.pendingUploads.cacheId, cache.id))
			.get();

		const narFilter = and(
			eq(d1Schema.blobReference.tenant, tenant),
			cache.scope.kind === 'default'
				? and(
						eq(d1Schema.blobReference.cacheKind, 'default'),
						eq(d1Schema.blobReference.tenant, tenant)
					)
				: and(
						eq(d1Schema.blobReference.cacheKind, 'named'),
						eq(d1Schema.blobReference.cacheName, cache.scope.name)
					)
		);
		const casFilter = and(
			eq(d1Schema.attestationReference.tenant, tenant),
			cache.scope.kind === 'default'
				? and(
						eq(d1Schema.attestationReference.cacheKind, 'default'),
						eq(d1Schema.attestationReference.tenant, tenant)
					)
				: and(
						eq(d1Schema.attestationReference.cacheKind, 'named'),
						eq(d1Schema.attestationReference.cacheName, cache.scope.name)
					)
		);

		const [narObjects, casObjects] = await this.context.d1.batch([
			this.context.d1
				.select({
					narHash: d1Schema.blobReference.narHash,
					fileSize: d1Schema.blobState.fileSize
				})
				.from(d1Schema.blobReference)
				.innerJoin(
					d1Schema.blobState,
					eq(d1Schema.blobReference.narHash, d1Schema.blobState.narHash)
				)
				.where(narFilter),
			this.context.d1
				.select({
					digest: d1Schema.attestationReference.digest,
					size: d1Schema.casObject.size
				})
				.from(d1Schema.attestationReference)
				.innerJoin(
					d1Schema.casObject,
					eq(d1Schema.attestationReference.digest, d1Schema.casObject.digest)
				)
				.where(casFilter)
		]);
		const narSizes = uniqueSizes(
			narObjects.map((row) => ({ key: row.narHash, size: row.fileSize }))
		);
		const casSizes = uniqueSizes(
			casObjects.map((row) => ({ key: row.digest, size: row.size }))
		);
		const narFileSize = sum(narSizes);
		const casFileSize = sum(casSizes);

		return {
			storePaths: storePaths?.count ?? 0,
			narBlobs: narSizes.length,
			narFileSize,
			casObjects: casSizes.length,
			casFileSize,
			pendingUploads: pending?.count ?? 0,
			totalFileSize: narFileSize + casFileSize
		};
	}

	async usage(): Promise<UsageResponseInput> {
		const tenant = this.context.requireTenant();
		const usage = await this.context.d1
			.select({
				blobs: d1Schema.tenantUsage.blobs,
				bytes: d1Schema.tenantUsage.bytes,
				casBlobs: d1Schema.tenantUsage.casBlobs,
				casBytes: d1Schema.tenantUsage.casBytes,
				quotaBytes: d1Schema.tenantUsage.quotaBytes
			})
			.from(d1Schema.tenantUsage)
			.where(eq(d1Schema.tenantUsage.tenant, tenant))
			.get();
		const narFileSize = usage?.bytes ?? 0;
		const casFileSize = usage?.casBytes ?? 0;
		const totalFileSize = narFileSize + casFileSize;
		const quotaBytes = usage?.quotaBytes ?? undefined;

		return {
			narBlobs: usage?.blobs ?? 0,
			narFileSize,
			casObjects: usage?.casBlobs ?? 0,
			casFileSize,
			totalFileSize,
			quotaBytes,
			remainingQuotaBytes:
				quotaBytes === undefined
					? undefined
					: Math.max(0, quotaBytes - totalFileSize)
		};
	}
}

function uniqueSizes(
	rows: readonly { readonly key: string; readonly size: number }[]
): number[] {
	const sizesByKey = new Map(rows.map((row) => [row.key, row.size]));

	return sizesByKey.values().toArray();
}

function sum(values: readonly number[]): number {
	return values.reduce((total, value) => total + value, 0);
}
