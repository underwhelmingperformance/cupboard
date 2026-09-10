import { CacheInfo } from '@cupboard/nix-store/cache-info';
import {
	type CacheAccessMode,
	type CachePriority,
	cachePrioritySchema,
	type CacheScope
} from '@cupboard/nix-store/scalars';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { and, eq, isNull } from 'drizzle-orm';

import type { SchemaDatabase } from '../do/context.ts';
import {
	CacheAlreadyExistsError,
	CacheIdentityMissingError,
	CacheNotFoundError
} from '../errors.ts';

import {
	cacheIdentityCondition,
	cacheScopeFromRow,
	type ResolvedCache
} from './cache.ts';
import * as schema from './schema.ts';

export class CacheRepository {
	constructor(private readonly database: SchemaDatabase) {}

	resolve(scope: CacheScope): ResolvedCache | undefined {
		const row = this.database
			.select({
				id: schema.caches.id,
				kind: schema.caches.kind,
				name: schema.caches.name,
				access: schema.caches.access
			})
			.from(schema.caches)
			.where(
				and(
					cacheIdentityCondition(schema.caches.kind, schema.caches.name, scope),
					isNull(schema.caches.deletedAt)
				)
			)
			.get();

		if (row === undefined) {
			return undefined;
		}

		return {
			id: row.id,
			scope: cacheScopeFromRow({ kind: row.kind, name: row.name }),
			access: row.access
		};
	}

	require(scope: CacheScope): ResolvedCache {
		const cache = this.resolve(scope);

		if (cache === undefined) {
			throw new CacheNotFoundError(scope);
		}

		return cache;
	}

	create(
		scope: CacheScope,
		access: CacheAccessMode,
		priority: CachePriority
	): ResolvedCache {
		const created = this.database
			.insert(schema.caches)
			.values({
				kind: scope.kind,
				name: scope.kind === 'named' ? scope.name : undefined,
				access,
				priority,
				createdAt: isoTimestamp(new Date())
			})
			.onConflictDoNothing()
			.returning({
				id: schema.caches.id,
				kind: schema.caches.kind,
				name: schema.caches.name,
				access: schema.caches.access
			})
			.all()
			.at(0);

		if (created === undefined) {
			throw new CacheAlreadyExistsError(scope);
		}

		return {
			id: created.id,
			scope: cacheScopeFromRow({ kind: created.kind, name: created.name }),
			access: created.access
		};
	}

	resolveOrCreate(scope: CacheScope, access: CacheAccessMode): ResolvedCache {
		const existing = this.resolve(scope);

		if (existing !== undefined) {
			return existing;
		}

		if (scope.kind === 'default') {
			throw new CacheIdentityMissingError(scope);
		}

		this.database
			.insert(schema.caches)
			.values({
				kind: 'named',
				name: scope.name,
				access,
				priority: cachePrioritySchema.parse(CacheInfo.default.priority),
				createdAt: isoTimestamp(new Date())
			})
			.onConflictDoNothing()
			.run();

		return this.require(scope);
	}

	setAccess(cache: ResolvedCache, access: CacheAccessMode): ResolvedCache {
		if (cache.access === access) {
			return cache;
		}

		this.database
			.update(schema.caches)
			.set({ access })
			.where(eq(schema.caches.id, cache.id))
			.run();

		return { ...cache, access };
	}

	scopeForId(id: ResolvedCache['id']): CacheScope {
		return this.resolvedForId(id).scope;
	}

	resolvedForId(id: ResolvedCache['id']): ResolvedCache {
		const row = this.database
			.select({
				id: schema.caches.id,
				kind: schema.caches.kind,
				name: schema.caches.name,
				access: schema.caches.access
			})
			.from(schema.caches)
			.where(eq(schema.caches.id, id))
			.get();

		if (row === undefined) {
			throw new CacheIdentityMissingError({ id });
		}

		return {
			id: row.id,
			scope: cacheScopeFromRow({ kind: row.kind, name: row.name }),
			access: row.access
		};
	}
}
