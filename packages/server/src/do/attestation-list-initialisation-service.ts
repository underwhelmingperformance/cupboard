import {
	type CacheScope,
	type StorePathHash,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import { and, asc, gt, gte, isNull, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';

import { AttestationListRevisionRepository } from '../db/attestation-list-revision.ts';
import { cacheIdSchema } from '../db/cache.ts';
import { currentCacheGeneration } from '../db/cache-generation.ts';
import * as schema from '../db/schema.ts';

import type { ServerContext } from './context.ts';

const progressKey = 'attestation-list:initialisation';
const pathsPerPage = 32;
const cursorSchema = z.union([
	z.literal('complete'),
	z.strictObject({
		cacheId: cacheIdSchema,
		after: storePathHashSchema.optional()
	})
]);

export interface AttestationListInitialisationProgress {
	readonly status: 'pending' | 'complete';
	readonly visited: number;
	readonly created: number;
}

export class AttestationListInitialisationService {
	constructor(private readonly context: ServerContext) {}

	private nextPath(cache: CacheScope, after: SQL): SQL {
		const name = cache.kind === 'named' ? cache.name : sql`NULL`;
		return sql`(SELECT store_path_hash FROM blob_ref_storage INDEXED BY blob_ref_readable_cache_generation_idx
   WHERE tenant = ${this.context.requireTenant()} AND cache_kind = ${cache.kind} AND cache_name IS ${name}
    AND cache_generation = (${currentCacheGeneration(this.context.requireTenant(), cache)}) AND readable = true AND store_path_hash > ${after}
   ORDER BY store_path_hash LIMIT 1)`;
	}

	async advance(): Promise<AttestationListInitialisationProgress> {
		const stored: unknown = await this.context.ctx.storage.get(progressKey);
		const cursor =
			stored === undefined ? undefined : cursorSchema.parse(stored);
		if (cursor === 'complete') {
			return { status: 'complete', visited: 0, created: 0 };
		}
		const identities = schema.cacheIdentities;
		const position =
			cursor === undefined
				? undefined
				: cursor.after === undefined
					? gt(identities.id, cursor.cacheId)
					: gte(identities.id, cursor.cacheId);
		const identity = this.context.db
			.select({ id: identities.id })
			.from(identities)
			.where(and(isNull(identities.deletedAt), position))
			.orderBy(asc(identities.id))
			.limit(1)
			.get();
		if (identity === undefined) {
			await this.context.ctx.storage.put(progressKey, 'complete');
			return { status: 'complete', visited: 0, created: 0 };
		}
		const cache = this.context.cacheRepository.resolvedForId(identity.id);
		const start = identity.id === cursor?.cacheId ? (cursor.after ?? '') : '';
		const first = this.nextPath(cache.scope, sql`${start}`);
		const next = this.nextPath(cache.scope, sql`cache_paths.path`);
		const rows = await this.context.d1.all<{
			path: StorePathHash;
		}>(sql`WITH RECURSIVE cache_paths(position, path) AS (
   SELECT 1, ${first}
   UNION ALL SELECT position + 1, ${next} FROM cache_paths WHERE path IS NOT NULL AND position < ${pathsPerPage + 1}
  ) SELECT path FROM cache_paths WHERE path IS NOT NULL`);
		const paths = rows.slice(0, pathsPerPage).map((row) => row.path);
		const created = await new AttestationListRevisionRepository(
			this.context.d1,
			this.context.requireTenant()
		).ensurePublications(cache.scope, paths);
		const last = paths.at(-1);
		await this.context.ctx.storage.put(progressKey, {
			cacheId: cache.id,
			...(rows.length > pathsPerPage && last !== undefined && { after: last })
		});
		return { status: 'pending', visited: paths.length, created };
	}
}
