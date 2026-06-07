import {
	type StatsResponse,
	type UsageResponse
} from '@cupboard/protocol/upload';
import { and, count, eq } from 'drizzle-orm';

import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';

import { type AuthKeysService } from './auth-keys-service.ts';
import { type ServerContext } from './context.ts';

export class StatsService {
	constructor(
		private readonly context: ServerContext,
		private readonly authKeys: AuthKeysService
	) {}

	async handleStats(request: Request, cache: string): Promise<Response> {
		await this.authKeys.requireScope(request, 'admin');

		return Response.json((await this.stats(cache)) satisfies StatsResponse);
	}

	async handleUsage(request: Request): Promise<Response> {
		await this.authKeys.requireScope(request, 'admin');

		return Response.json((await this.usage()) satisfies UsageResponse);
	}

	private async stats(cache: string): Promise<StatsResponse> {
		const tenant = this.context.requireTenant();
		const storePaths = this.context.db
			.select({ count: count() })
			.from(schema.narInfos)
			.where(eq(schema.narInfos.cache, cache))
			.get();
		const pending = this.context.db
			.select({ count: count() })
			.from(schema.pendingUploads)
			.where(eq(schema.pendingUploads.cache, cache))
			.get();

		const narObjects = await this.context.d1
			.select({
				narHash: d1Schema.blobReference.narHash,
				fileSize: d1Schema.blobState.fileSize
			})
			.from(d1Schema.blobReference)
			.innerJoin(
				d1Schema.blobState,
				eq(d1Schema.blobReference.narHash, d1Schema.blobState.narHash)
			)
			.where(
				and(
					eq(d1Schema.blobReference.tenant, tenant),
					eq(d1Schema.blobReference.cache, cache)
				)
			)
			.all();
		const casObjects = await this.context.d1
			.select({
				digest: d1Schema.attestationReference.digest,
				size: d1Schema.casObject.size
			})
			.from(d1Schema.attestationReference)
			.innerJoin(
				d1Schema.casObject,
				eq(d1Schema.attestationReference.digest, d1Schema.casObject.digest)
			)
			.where(
				and(
					eq(d1Schema.attestationReference.tenant, tenant),
					eq(d1Schema.attestationReference.cache, cache)
				)
			)
			.all();
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

	private async usage(): Promise<UsageResponse> {
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
	return [...new Map(rows.map((row) => [row.key, row.size])).values()];
}

function sum(values: readonly number[]): number {
	return values.reduce((total, value) => total + value, 0);
}
