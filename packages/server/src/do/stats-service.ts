import {
	type StatsResponse,
	type UsageResponse
} from '@cupboard/protocol/upload';
import { and, count, eq, sql } from 'drizzle-orm';

import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';

import { type AuthKeysService } from './auth-keys-service.ts';
import { singleTenant, type ServerContext } from './context.ts';

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
					eq(d1Schema.blobReference.tenant, singleTenant),
					eq(d1Schema.blobReference.cache, cache)
				)
			)
			.all();
		const narSizes = uniqueSizes(
			narObjects.map((row) => ({ key: row.narHash, size: row.fileSize }))
		);
		const narFileSize = sum(narSizes);

		return {
			storePaths: storePaths?.count ?? 0,
			narBlobs: narSizes.length,
			narFileSize,
			casObjects: 0,
			casFileSize: 0,
			pendingUploads: pending?.count ?? 0,
			totalFileSize: narFileSize
		};
	}

	private async usage(): Promise<UsageResponse> {
		const blobs = await this.context.d1
			.select({
				count: count(),
				total: sql<number>`coalesce(sum(${d1Schema.blobState.fileSize}), 0)`
			})
			.from(d1Schema.blobState)
			.get();
		const narFileSize = blobs?.total ?? 0;

		return {
			narBlobs: blobs?.count ?? 0,
			narFileSize,
			casObjects: 0,
			casFileSize: 0,
			totalFileSize: narFileSize
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
